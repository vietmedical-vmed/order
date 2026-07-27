// Modal dùng chung + tiện ích a11y cho mọi modal của app (mục 3.5 & 4.3).
import { $, $$ } from './utils.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 4.3: gắn hành vi a11y cho 1 modal đang mở — Esc để đóng, Tab quẩn vòng trong modal
 * (focus trap), click nền để đóng, và trả focus về đúng phần tử đã mở modal khi đóng.
 * @param {HTMLElement} modal phần tử modal (lớp phủ toàn màn hình)
 * @param {() => void} onDismiss gọi khi user bấm Esc hoặc click ra nền
 * @returns {() => void} hàm release — gọi khi đóng modal để gỡ listener + trả focus
 */
export function trapModal(modal, onDismiss) {
  const prevFocus = document.activeElement;

  const onKeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onDismiss(); return; }
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, modal).filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey && (cur === first || !modal.contains(cur))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (cur === last || !modal.contains(cur))) { e.preventDefault(); first.focus(); }
  };
  const onBackdrop = (e) => { if (e.target === modal) onDismiss(); };

  document.addEventListener('keydown', onKeydown, true);
  modal.addEventListener('mousedown', onBackdrop);

  return function release() {
    document.removeEventListener('keydown', onKeydown, true);
    modal.removeEventListener('mousedown', onBackdrop);
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
  };
}

// Modal xác nhận dùng chung (thay window.confirm/prompt/alert) — trả Promise:
//  - infoOnly:      resolve() khi bấm OK/× (không có lựa chọn Huỷ)
//  - requireReason: resolve(chuỗi lý do đã trim) khi xác nhận, null khi Huỷ/Esc/×
//  - còn lại:       resolve(true) khi xác nhận, resolve(false) khi Huỷ/Esc/×
export function askConfirm(opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const modal = $('#modalConfirm');
    const wrap = $('#mcReasonWrap');
    const reasonInput = $('#mcReason');
    const okBtn = $('#mcOk');
    const cancelBtn = $('#mcCancel');
    const needReason = !!opts.requireReason;

    $('#mcTitle').textContent = opts.title || 'Xác nhận';
    $('#mcMessage').textContent = opts.message || '';
    $('#mcErr').textContent = '';
    wrap.classList.toggle('hidden', !needReason);
    if (needReason) {
      $('#mcReasonLabel').textContent = opts.reasonLabel || 'Lý do';
      reasonInput.value = '';
    }
    okBtn.textContent = opts.okLabel || (needReason ? 'Xác nhận' : (opts.infoOnly ? 'Đã hiểu' : 'Xác nhận'));
    okBtn.classList.toggle('bg-primary-600', !opts.danger);
    okBtn.classList.toggle('hover:bg-primary-700', !opts.danger);
    okBtn.classList.toggle('bg-danger-600', !!opts.danger);
    okBtn.classList.toggle('hover:bg-danger-700', !!opts.danger);
    cancelBtn.classList.toggle('hidden', !!opts.infoOnly);

    // trapModal phải chạy TRƯỚC khi đưa focus vào modal, nếu không nó sẽ nhớ nhầm
    // "phần tử trước đó" là chính nút trong modal và không trả focus về nút đã mở được.
    modal.classList.remove('hidden');
    const cancelValue = () => needReason ? null : false;
    const release = trapModal(modal, () => finish(cancelValue()));
    (needReason ? reasonInput : okBtn).focus();

    const finish = (value) => {
      modal.classList.add('hidden');
      $('#mcClose').onclick = null;
      cancelBtn.onclick = null;
      okBtn.onclick = null;
      release();
      resolve(value);
    };
    $('#mcClose').onclick = () => finish(cancelValue());
    cancelBtn.onclick = () => finish(cancelValue());
    okBtn.onclick = () => {
      if (needReason) {
        const val = reasonInput.value.trim();
        if (opts.reasonRequired !== false && !val) { $('#mcErr').textContent = 'Cần nhập lý do'; return; }
        finish(val);
      } else {
        finish(true);
      }
    };
  });
}
