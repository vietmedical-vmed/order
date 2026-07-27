// ============ TIỆN ÍCH DÙNG CHUNG ============
export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

export const fmt = n => (n == null || n === '') ? '—' : Number(n).toLocaleString('vi-VN');
// Như fmt nhưng giá trị 0 cũng hiển thị "—" (dùng cho dải cột Tồn kho(DA) → Gợi ý).
export const dash0 = n => (n == null || n === '' || Number(n) === 0) ? '—' : Number(n).toLocaleString('vi-VN');

export const fmtDate = d => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? '—' : dt.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
};

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Ép số cho ô Excel (tránh chuỗi); rỗng khi không phải số.
export function num0(v) { const n = Number(v); return isFinite(n) ? n : (v == null ? '' : v); }

export function fmtVND(n) {
  if (!n) return '—';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + ' tỷ';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tr';
  return n.toLocaleString('vi-VN') + ' đ';
}

// So sánh chuỗi tiếng Việt (dùng để sắp nhóm hàng / phân loại theo ABC).
export const viCmp = (a, b) => String(a).localeCompare(String(b), 'vi', { numeric: true, sensitivity: 'base' });
