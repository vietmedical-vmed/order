// Edge Function: notify-sender
//  Bộ gửi thông báo DÙNG CHUNG. Quét shared.notifications (status='pending'), gửi theo
//  channel (hiện: email qua SMTP nội bộ), đánh dấu sent/failed + retry. Chạy theo lịch
//  (pg_cron + pg_net gọi URL function, kèm header x-cron-secret) hoặc gọi tay để test.
//  Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SMTP_HOST, SMTP_PORT, SMTP_USER,
//           SMTP_PASS, SMTP_FROM, CRON_SECRET (tuỳ chọn bảo vệ endpoint),
//           ZIMBRA_URL (tuỳ chọn: có thì gửi qua Zimbra SOAP/HTTPS thay SMTP).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.8";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const MAX_RETRIES = 5;
const BATCH = 20;

// Bỏ dấu tiếng Việt + ký tự Unicode -> ASCII (webmail nội bộ không decode QP/encoded-word).
function noDiacritics(s: string): string {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/[‐-―]/g, "-")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function smtpClient() {
  // 465 = TLS ngay từ đầu; cổng khác = kết nối thường rồi denomailer tự STARTTLS.
  // Lưu ý: Supabase Edge chặn outbound 25 và 587 -> chỉ dùng được 465 (hoặc 2525).
  const port = Number(Deno.env.get("SMTP_PORT") || "465");
  return new SMTPClient({
    connection: {
      hostname: Deno.env.get("SMTP_HOST") || "",
      port,
      tls: port === 465,
      auth: {
        username: Deno.env.get("SMTP_USER") || "",
        password: Deno.env.get("SMTP_PASS") || "",
      },
    },
  });
}

async function sendSmtp(to: string[], subject: string, body: string) {
  const client = smtpClient();
  try {
    await client.send({
      from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER") || "",
      to,
      subject,
      content: body,
    });
  } finally {
    // Kết nối hỏng thì close() cũng ném lỗi -> nuốt để giữ lỗi gốc của send().
    try { await client.close(); } catch { /* ignore */ }
  }
}

// Zimbra SOAP (JSON) qua HTTPS 443: dùng khi SMTP 465 bị chặn (Supabase chặn sẵn 25/587).
// Đăng nhập bằng chính SMTP_USER/SMTP_PASS, token dùng lại trong 1 lần chạy.
let zimbraToken: string | null = null;

async function zimbraCall(body: Record<string, unknown>, token?: string) {
  const url = (Deno.env.get("ZIMBRA_URL") || "").replace(/\/+$/, "") + "/service/soap";
  const context: Record<string, unknown> = { _jsns: "urn:zimbra", format: { type: "js" } };
  if (token) context.authToken = { _content: token };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Header: { context }, Body: body }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => null);
  const fault = json?.Body?.Fault;
  if (fault) throw new Error(`Zimbra: ${fault.Detail?.Error?.Code || ""} ${fault.Reason?.Text || ""}`.trim());
  if (!res.ok || !json) throw new Error(`Zimbra HTTP ${res.status}`);
  return json.Body;
}

async function sendZimbra(to: string[], subject: string, body: string) {
  if (!zimbraToken) {
    const auth = await zimbraCall({
      AuthRequest: {
        _jsns: "urn:zimbraAccount",
        account: { by: "name", _content: Deno.env.get("SMTP_USER") || "" },
        password: { _content: Deno.env.get("SMTP_PASS") || "" },
      },
    });
    zimbraToken = auth?.AuthResponse?.authToken?.[0]?._content || null;
    if (!zimbraToken) throw new Error("Zimbra: không lấy được authToken");
  }
  const from = Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER") || "";
  try {
    await zimbraCall({
      SendMsgRequest: {
        _jsns: "urn:zimbraMail",
        m: {
          e: [{ t: "f", a: from }, ...to.map((a) => ({ t: "t", a }))],
          su: { _content: subject },
          mp: [{ ct: "text/plain", content: { _content: body } }],
        },
      },
    }, zimbraToken);
  } catch (e) {
    zimbraToken = null; // token có thể hết hạn (worker sống lâu) -> lần sau đăng nhập lại
    throw e;
  }
}

async function sendEmail(to: string[], subject: string, body: string) {
  const send = Deno.env.get("ZIMBRA_URL") ? sendZimbra : sendSmtp;
  await send(to, noDiacritics(subject), noDiacritics(body));
}

Deno.serve(async (req) => {
  // Bảo vệ endpoint nếu đặt CRON_SECRET.
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  }
  if (!Deno.env.get("SMTP_HOST") && !Deno.env.get("ZIMBRA_URL")) {
    return new Response(JSON.stringify({ error: "SMTP chưa cấu hình" }), { status: 400 });
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data, error } = await supa.schema("shared").from("notifications")
    .select("*").eq("status", "pending").eq("channel", "email")
    .order("created_at", { ascending: true }).limit(BATCH);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let sent = 0, failed = 0;
  for (const n of (data || [])) {
    const to = Array.isArray(n.to_emails) ? n.to_emails.filter(Boolean) : [];
    try {
      if (!to.length) throw new Error("to_emails rỗng");
      await sendEmail(to, n.subject, n.body);
      await supa.schema("shared").from("notifications")
        .update({ status: "sent", sent_at: new Date().toISOString(), error: null })
        .eq("id", n.id);
      sent++;
    } catch (e) {
      const retries = Number(n.retries || 0) + 1;
      await supa.schema("shared").from("notifications").update({
        retries,
        status: retries >= MAX_RETRIES ? "failed" : "pending",
        error: String((e as Error)?.message || e),
      }).eq("id", n.id);
      failed++;
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: (data || []).length, sent, failed }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
