// ==== Cầu nối Supabase Edge Function (thay google.script.run của bản Apps Script cũ) ====
import { API_BASE, ANON_KEY, TOKEN_KEY } from './config.js';
import { state } from './state.js';

export { API_BASE };

// Khi token hết hạn giữa chừng, api không tự import màn login (tránh phụ thuộc vòng
// với app.js) — app.js đăng ký handler lúc khởi động.
let onAuthLost = () => {};
export function setAuthLostHandler(fn) { onAuthLost = fn; }

export function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (ANON_KEY) { h['Authorization'] = 'Bearer ' + ANON_KEY; h['apikey'] = ANON_KEY; }
  return h;
}

// Fetch có timeout — tránh nút bị kẹt "Đang xử lý…" vô thời hạn khi server chậm/treo
export function fetchWithTimeout(url, options, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...options, signal: ctrl.signal })
    .catch(e => {
      if (e.name === 'AbortError') throw new Error('Yêu cầu quá thời gian chờ (' + (timeoutMs / 1000) + 's). Kiểm tra kết nối hoặc thử lại.');
      throw e;
    })
    .finally(() => clearTimeout(timer));
}

export async function rpc(fn, ...args) {
  return rpcOpts({}, fn, ...args);
}

export async function rpcOpts(opts, fn, ...args) {
  const res = await fetchWithTimeout(API_BASE + '/order-api', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ action: fn, token: state.token, args })
  }, opts.timeoutMs);
  let body = {};
  try { body = await res.json(); } catch (e) {}
  if (!res.ok || body.error) {
    const msg = body.error || ('HTTP ' + res.status);
    if (String(msg).includes('AUTH_REQUIRED')) {
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
      onAuthLost();
      throw new Error('Phiên đăng nhập đã hết hạn');
    }
    throw new Error(msg);
  }
  return body.data;
}

// Các endpoint không cần token (đăng nhập / đổi mật khẩu) nằm ở function order-login.
export async function rpcRaw(fn, ...args) {
  if (fn === 'login') {
    const [username, password] = args;
    return postLogin({ username, password });
  }
  if (fn === 'changePassword') {
    const [username, oldPassword, newPassword] = args;
    return postLogin({ action: 'changePassword', username, oldPassword, newPassword });
  }
  return rpc(fn, ...args);
}

async function postLogin(payload) {
  const res = await fetchWithTimeout(API_BASE + '/order-login', {
    method: 'POST', headers: headers(), body: JSON.stringify(payload)
  });
  let body = {};
  try { body = await res.json(); } catch (e) {}
  if (!res.ok || body.error) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}
