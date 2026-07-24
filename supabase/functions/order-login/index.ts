// Edge Function: login
//  POST { username, password } -> { token, user }
//  - Verify password: SHA-256(salt + ":" + password) === password_hash  (giống Apps Script cũ)
//  - Token = base64url(payload).base64url(hmacSHA256(payload, TOKEN_SECRET))
//  - Payload chứa username, ho_ten, role, mien, exp (8h)
//  Secrets cần set: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_SECRET

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.110.8";

// Chỉ cho phép frontend thật (GitHub Pages) + localhost khi dev, thay vì "*".
const ALLOWED_ORIGINS = ["https://vietmedical-vmed.github.io"];
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || LOCALHOST_RE.test(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const TOKEN_TTL = 8 * 60 * 60; // giây
const enc = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlFromStr(str: string): string {
  // UTF-8 an toàn cho tiếng Việt
  return b64urlFromBytes(enc.encode(str));
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSaltHex(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- password_hash_v2: PBKDF2-HMAC-SHA256 (Web Crypto native, không thêm dependency
// ngoài). Lazy migration: KHÔNG đụng password_hash/salt cũ (app khác dùng chung bảng `users`
// vẫn chạy đúng); order-login tự nâng cấp cột password_hash_v2 khi verify qua scheme cũ thành
// công. Format lưu: pbkdf2$<iterations>$<saltB64url>$<hashB64url> (tự mô tả, đổi iterations
// sau này vẫn đọc được bản ghi cũ). ----------
const PBKDF2_ITERATIONS = 210000; // khuyến nghị OWASP 2023 cho PBKDF2-HMAC-SHA256

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key, 256,
  );
  return new Uint8Array(bits);
}
async function hashPasswordV2(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64urlFromBytes(salt)}$${b64urlFromBytes(hash)}`;
}
async function verifyPasswordV2(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array, expected: Uint8Array;
  try { salt = b64urlToBytes(parts[2]); expected = b64urlToBytes(parts[3]); } catch { return false; }
  const actual = await pbkdf2Bits(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0; // so sánh constant-time, tránh timing attack
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
// Xác thực mật khẩu: ưu tiên password_hash_v2 nếu đã có (không fallback về scheme cũ khi
// v2 verify sai — v2 là nguồn xác thực duy nhất một khi đã tồn tại). Chưa có v2 -> verify
// scheme cũ (SHA-256 [+salt]); trả viaLegacy=true để caller biết mà nâng cấp lên v2.
async function verifyPassword(user: any, password: string): Promise<{ ok: boolean; viaLegacy: boolean }> {
  if (user.password_hash_v2) {
    return { ok: await verifyPasswordV2(password, user.password_hash_v2), viaLegacy: false };
  }
  const toHash = user.salt ? (user.salt + ":" + password) : password;
  const ok = (await sha256Hex(toHash)) === user.password_hash;
  return { ok, viaLegacy: ok };
}

// ---------- 5.2: rate-limit đăng nhập sai theo username+IP ----------
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILS = 5;

function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
async function isRateLimited(supa: SupabaseClient, username: string, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count } = await supa.from("login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("username", username).eq("ip", ip).eq("success", false)
    .gte("created_at", since);
  return (count || 0) >= RATE_LIMIT_MAX_FAILS;
}
async function recordFailedLogin(supa: SupabaseClient, username: string, ip: string): Promise<void> {
  await supa.from("login_attempts").insert({ username, ip, success: false });
  await supa.from("audit_log").insert({ username, action: "LOGIN_FAILED", session_id: "", detail: "ip=" + ip });
}

async function hmacSign(payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return b64urlFromBytes(new Uint8Array(sig));
}

// Đổi mật khẩu (không cần đăng nhập): xác thực mật khẩu hiện tại giống login rồi ghi hash mới.
async function handleChangePassword(supa: SupabaseClient, body: any, cors: Record<string, string>): Promise<Response> {
  const { username, oldPassword, newPassword } = body;
  if (!username || !oldPassword || !newPassword) {
    return json({ error: "Thiếu tài khoản, mật khẩu hiện tại hoặc mật khẩu mới" }, 400, cors);
  }
  if (String(newPassword).length < 6) {
    return json({ error: "Mật khẩu mới tối thiểu 6 ký tự" }, 400, cors);
  }
  if (String(oldPassword) === String(newPassword)) {
    return json({ error: "Mật khẩu mới phải khác mật khẩu hiện tại" }, 400, cors);
  }
  const uname = String(username).trim().toLowerCase();

  const { data: user } = await supa
    .from("users").select("*").eq("username", uname).maybeSingle();
  if (!user || !user.password_hash || user.active === false) {
    await new Promise((r) => setTimeout(r, 400)); // chống dò
    return json({ error: "Tài khoản hoặc mật khẩu hiện tại không đúng" }, 401, cors);
  }
  const verify = await verifyPassword(user, oldPassword);
  if (!verify.ok) {
    await new Promise((r) => setTimeout(r, 400));
    return json({ error: "Tài khoản hoặc mật khẩu hiện tại không đúng" }, 401, cors);
  }

  // users là bảng DÙNG CHUNG nhiều app -> giữ nguyên scheme salt cũ (app khác vẫn đọc
  // password_hash/salt nên phải luôn cập nhật, dù order-login đã ưu tiên password_hash_v2):
  //  - đang có salt   -> sinh salt mới (app khác vẫn đọc salt từ bản ghi nên chạy đúng)
  //  - vốn không salt -> giữ không salt (tránh phá app chỉ hash SHA256(password))
  let salt = user.salt || "";
  if (salt) salt = randomSaltHex();
  const newHash = await sha256Hex(salt ? (salt + ":" + newPassword) : newPassword);
  // Ghi luôn password_hash_v2 cho mật khẩu mới -> app này dùng ngay scheme mạnh, không phải
  // chờ thêm 1 vòng lazy-upgrade ở lần login kế tiếp.
  const newHashV2 = await hashPasswordV2(newPassword);

  const { error } = await supa.from("users")
    .update({ password_hash: newHash, salt, password_hash_v2: newHashV2 }).eq("username", uname);
  if (error) return json({ error: error.message }, 500, cors);

  await supa.from("audit_log").insert({
    username: user.username, action: "CHANGE_PASSWORD", session_id: "", detail: "",
  });
  return json({ ok: true }, 200, cors);
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (String(body.action || "") === "changePassword") {
      return await handleChangePassword(supa, body, cors);
    }

    const { username, password } = body;
    if (!username || !password) {
      return json({ error: "Thiếu tài khoản hoặc mật khẩu" }, 400, cors);
    }
    const uname = String(username).trim().toLowerCase();
    const ip = getClientIp(req);

    if (await isRateLimited(supa, uname, ip)) {
      return json({ error: "Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút." }, 429, cors);
    }

    // users = bảng DÙNG CHUNG (identity + mật khẩu + role + mien)
    const { data: user } = await supa
      .from("users").select("*").eq("username", uname).maybeSingle();

    if (!user || !user.password_hash || user.active === false) {
      await recordFailedLogin(supa, uname, ip);
      await new Promise((r) => setTimeout(r, 400)); // chống dò
      return json({ error: "Tài khoản hoặc mật khẩu không đúng" }, 401, cors);
    }

    const verify = await verifyPassword(user, password);
    if (!verify.ok) {
      await recordFailedLogin(supa, uname, ip);
      await new Promise((r) => setTimeout(r, 400));
      return json({ error: "Tài khoản hoặc mật khẩu không đúng" }, 401, cors);
    }
    // Nâng cấp lazy lên PBKDF2 (password_hash_v2) — chỉ khi vừa verify qua scheme cũ thành
    // công; best-effort, không chặn đăng nhập nếu update lỗi. Không đổi password_hash/salt cũ.
    if (verify.viaLegacy) {
      const v2 = await hashPasswordV2(password);
      await supa.from("users").update({ password_hash_v2: v2 }).eq("username", uname);
    }

    // Map role của bảng chung -> role app đặt hàng
    const ROLE_MAP: Record<string, string> = {
      area_manager: "AM", product_manager: "PM", manager: "MANAGER", admin: "ADMIN", purchasing: "PURCHASING",
      AM: "AM", PM: "PM", MANAGER: "MANAGER", ADMIN: "ADMIN", PURCHASING: "PURCHASING",
    };
    const role = ROLE_MAP[String(user.role || "").toLowerCase()] || ROLE_MAP[String(user.role || "")] || "";
    if (!role) {
      return json({ error: "Tài khoản (role: " + user.role + ") chưa được cấp quyền cho app Đặt hàng CTCH" }, 403, cors);
    }
    const ho_ten = user.ho_va_ten || user.ho_ten || user.username;

    const secret = Deno.env.get("TOKEN_SECRET")!;
    const payload = {
      username: user.username,
      ho_ten,
      role: String(user.role || "").toLowerCase(), // role gốc chữ thường (chuẩn chung; order-api tự map)
      mien: user.mien || "MB",
      bu: user.bu || "",
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
    }, 200, cors);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500, corsHeadersFor(req));
  }
});

function json(obj: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}