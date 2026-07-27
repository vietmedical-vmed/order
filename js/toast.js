// 3.9: toast xếp chồng (tối đa 3) + phân loại màu + nút đóng.
// Trước đây chỉ có 1 thẻ #toast duy nhất nên message sau đè message trước trong 3.2s.
import { $, esc } from './utils.js';

const MAX_TOASTS = 3;
const LIFETIME_MS = 3200;

const KIND_CLS = {
  success: 'bg-primary-600',
  error: 'bg-danger-700',
  info: 'bg-slate-900',
};
const KIND_ICON = {
  success: '<path d="M20 6 9 17l-5-5"/>',
  error: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
};

function normalizeKind(kind) {
  if (kind === true) return 'error';          // tương thích cách gọi cũ toast(msg, isErr)
  if (kind === false || kind == null) return 'success';
  return KIND_CLS[kind] ? kind : 'info';
}

function removeToast(el) {
  if (!el || el.__closing) return;
  el.__closing = true;
  clearTimeout(el.__timer);
  el.classList.remove('toast-in');
  setTimeout(() => el.remove(), 200);
}

/**
 * Hiện 1 toast.
 * @param {string} msg  nội dung
 * @param {'success'|'error'|'info'|boolean} [kind]  boolean = cách gọi cũ (true là lỗi)
 */
export function toast(msg, kind) {
  const stack = $('#toastStack');
  if (!stack) return;
  const k = normalizeKind(kind);

  const el = document.createElement('div');
  el.className = `toast-item ${KIND_CLS[k]} text-white pl-3 pr-2 py-2.5 rounded-lg text-[13px] shadow-lg flex items-start gap-2 max-w-[min(92vw,26rem)]`;
  el.setAttribute('role', k === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round" class="mt-0.5 shrink-0">${KIND_ICON[k]}</svg>
    <span class="flex-1 leading-snug">${esc(msg)}</span>
    <button type="button" aria-label="Đóng thông báo"
            class="shrink-0 -mt-0.5 px-1 text-white/70 hover:text-white text-[16px] leading-none">×</button>`;
  el.querySelector('button').onclick = () => removeToast(el);

  stack.appendChild(el);
  // Toast cũ nhất rớt ra khi vượt trần — luôn thấy được message mới nhất.
  // (đếm theo mảng vì removeToast chỉ gỡ khỏi DOM sau 200ms hiệu ứng)
  const live = Array.from(stack.children).filter(c => !c.__closing);
  while (live.length > MAX_TOASTS) removeToast(live.shift());

  requestAnimationFrame(() => el.classList.add('toast-in'));
  el.__timer = setTimeout(() => removeToast(el), LIFETIME_MS);
}
