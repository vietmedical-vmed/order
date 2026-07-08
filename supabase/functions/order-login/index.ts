// Edge Function: login
//  POST { username, password } -> { token, user }
//  - Verify password: SHA-256(salt + ":" + password) === password_hash  (giống Apps Script cũ)
//  - Token = base64url(payload).base64url(hmacSHA256(payload, TOKEN_SECRET))
//  - Payload chứa username, ho_ten, role, mien, exp (8h)
//  Secrets cần set: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TOKEN_TTL = 8 * 60 * 60; // giây
const enc = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromStr(str: string): string {
  // UTF-8 an toàn cho tiếng Việt
  return b64urlFromBytes(enc.encode(str));
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSign(payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return b64urlFromBytes(new Uint8Array(sig));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { username, password } = await req.json();
    if (!username || !password) {
      return json({ error: "Thiếu tài khoản hoặc mật khẩu" }, 400);
    }
    const uname = String(username).trim().toLowerCase();

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // users = bảng DÙNG CHUNG (identity + mật khẩu + role + mien)
    const { data: user } = await supa
      .from("users").select("*").eq("username", uname).maybeSingle();

    if (!user || !user.password_hash || user.active === false) {
      await new Promise((r) => setTimeout(r, 400)); // chống dò
      return json({ error: "Tài khoản hoặc mật khẩu không đúng" }, 401);
    }

    // Hash: có salt -> SHA256(salt:password); không có salt -> SHA256(password)
    const toHash = user.salt ? (user.salt + ":" + password) : password;
    const hash = await sha256Hex(toHash);
    if (hash !== user.password_hash) {
      await new Promise((r) => setTimeout(r, 400));
      return json({ error: "Tài khoản hoặc mật khẩu không đúng" }, 401);
    }

    // Map role của bảng chung -> role app đặt hàng
    const ROLE_MAP: Record<string, string> = {
      area_manager: "AM", product_manager: "PM", manager: "MANAGER", admin: "ADMIN", purchasing: "PURCHASING",
      AM: "AM", PM: "PM", MANAGER: "MANAGER", ADMIN: "ADMIN", PURCHASING: "PURCHASING",
    };
    const role = ROLE_MAP[String(user.role || "").toLowerCase()] || ROLE_MAP[String(user.role || "")] || "";
    if (!role) {
      return json({ error: "Tài khoản (role: " + user.role + ") chưa được cấp quyền cho app Đặt hàng CTCH" }, 403);
    }
    const ho_ten = user.ho_va_ten || user.ho_ten || user.username;

    const secret = Deno.env.get("TOKEN_SECRET")!;
    const payload = {
      username: user.username,
      ho_ten,
      role,
      mien: user.mien || "MB",
      scope: user.scope || "",
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
    };
    const payloadB64 = b64urlFromStr(JSON.stringify(payload));
    const sig = await hmacSign(payloadB64, secret);
    const token = payloadB64 + "." + sig;

    // audit LOGIN
    await supa.from("audit_log").insert({
      username: user.username, action: "LOGIN", session_id: "", detail: "",
    });

    const initials = String(ho_ten || "").split(" ").filter(Boolean)
      .map((s: string) => s[0]).slice(-2).join("").toUpperCase();

    return json({
      token,
      user: { username: user.username, ho_ten, role, mien: user.mien || "MB", initials },
    });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}