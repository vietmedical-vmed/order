// Edge Function: notify-sender
//  Bộ gửi thông báo DÙNG CHUNG. Quét shared.notifications (status='pending'), gửi theo
//  channel (hiện: email qua SMTP nội bộ), đánh dấu sent/failed + retry. Chạy theo lịch
//  (pg_cron + pg_net gọi URL function, kèm header x-cron-secret) hoặc gọi tay để test.
//  Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SMTP_HOST, SMTP_PORT, SMTP_USER,
//           SMTP_PASS, SMTP_FROM, CRON_SECRET (tuỳ chọn bảo vệ endpoint).

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
  return new SMTPClient({
    connection: {
      hostname: Deno.env.get("SMTP_HOST") || "",
      port: Number(Deno.env.get("SMTP_PORT") || "465"),
      tls: true,
      auth: {
        username: Deno.env.get("SMTP_USER") || "",
        password: Deno.env.get("SMTP_PASS") || "",
      },
    },
  });
}

async function sendEmail(to: string[], subject: string, body: string) {
  const client = smtpClient();
  try {
    await client.send({
      from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER") || "",
      to,
      subject: noDiacritics(subject),
      content: noDiacritics(body),
    });
  } finally {
    await client.close();
  }
}

Deno.serve(async (req) => {
  // Bảo vệ endpoint nếu đặt CRON_SECRET.
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  }
  if (!Deno.env.get("SMTP_HOST")) {
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
