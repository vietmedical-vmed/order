// 3.3: cảnh báo token sắp hết hạn — decode payload (base64url + UTF-8, giống server) để đọc
// exp mà không cần gọi API. Đặt hẹn giờ hiện banner trước hạn 15 phút thay vì để user bị đá
// về login bất ngờ giữa lúc đang nhập liệu.
import { $ } from './utils.js';
import { state } from './state.js';

const WARN_BEFORE_MS = 15 * 60 * 1000;
let tokenExpiryTimer = null;

export function decodeTokenPayload(token) {
  try {
    const b64 = String(token || '').split('.')[0];
    if (!b64) return null;
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch { return null; }
}

export function scheduleTokenExpiryWarning() {
  clearTokenExpiryWarning();
  const payload = decodeTokenPayload(state.token);
  if (!payload || !payload.exp) return;
  const delay = payload.exp * 1000 - WARN_BEFORE_MS - Date.now();
  const showExpiryBanner = () => {
    const el = $('#banner');
    if (!el) return;
    el.textContent = 'Phiên đăng nhập sắp hết hạn — hãy lưu lại thay đổi rồi đăng nhập lại để không bị gián đoạn.';
    el.classList.remove('hidden');
  };
  if (delay <= 0) showExpiryBanner();
  else tokenExpiryTimer = setTimeout(showExpiryBanner, delay);
}

export function clearTokenExpiryWarning() {
  if (tokenExpiryTimer) { clearTimeout(tokenExpiryTimer); tokenExpiryTimer = null; }
}
