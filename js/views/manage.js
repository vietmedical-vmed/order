// ============ MÀN QUẢN LÝ ĐẶT HÀNG (danh sách đợt) ============
import { $, $$, esc, fmt, fmtDate } from '../utils.js';
import { rpc } from '../api.js';
import { state, canApprove, isAM, isPurchasing } from '../state.js';
import { toast } from '../toast.js';
import { askConfirm, trapModal } from '../modal.js';
import { loadSessions } from '../session.js';
import { renderView } from '../router.js';
import { exportToExcel } from '../export-excel.js';

export async function initApprovalView() {
  if (!canApprove() && !isAM() && !isPurchasing()) {
    $('#main').innerHTML = '<div class="empty-state">Không có quyền</div>';
    return;
  }
  $('#mStatus').addEventListener('change', renderManageList);
  if (isAM()) {
    // AM chỉ xem miền của mình — khoá bộ chọn miền, backend cũng đã giới hạn theo miền AM.
    state.manageMien = state.user.mien;
    const seg = $('#mMienSeg'); if (seg) seg.style.display = 'none';
  } else {
    $$('.mmien-btn').forEach(b => {
      b.addEventListener('click', () => {
        $$('.mmien-btn').forEach(x => {
          x.classList.toggle('active', x === b);
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        state.manageMien = b.dataset.mmien;
        renderManageList();
      });
    });
    state.manageMien = state.manageMien || 'ALL';
  }
  // Mua hàng: mặc định lọc "Đã duyệt" cho gọn (backend cũng chỉ trả APPROVED/CLOSED).
  if (isPurchasing()) { const st = $('#mStatus'); if (st) st.value = 'APPROVED'; }
  $('#mRefresh').addEventListener('click', async () => { await loadSessions(); renderManageList(); });
  bindManageActions();
  await renderManageList();
}

const ST_LABEL = { DRAFT: 'AM đang nhập', SUBMITTED: 'PM chờ duyệt', PM_APPROVED: 'Manager chờ duyệt', APPROVED: 'Đã duyệt', CLOSED: 'Đã chốt', CANCELED: 'Đã hủy' };
const ST_CLS = { DRAFT: 'st-draft', SUBMITTED: 'st-sub', PM_APPROVED: 'pill-mid', APPROVED: 'st-app', CLOSED: 'st-close', CANCELED: 'pill-hot' };

async function renderManageList() {
  const host = $('#manageHost');
  host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 p-4" aria-busy="true">
    ${'<div class="skeleton-line"></div>'.repeat(5)}</div>`;
  try {
    const status = $('#mStatus').value;
    const mien = state.manageMien || 'ALL';
    const list = await rpc('listSessions', { mien: mien, status: status });
    if (!Array.isArray(list)) throw new Error(`Server trả về ${list === null ? 'null' : typeof list} thay vì danh sách đợt.`);
    if (!list.length) {
      host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state">Không có đợt nào</div>`;
      return;
    }
    const role = state.user.role;
    const canPM = (role === 'PM' || role === 'ADMIN');           // duyệt đợt SUBMITTED (PM không còn từ chối)
    const canMgr = (role === 'MANAGER' || role === 'ADMIN');     // duyệt/từ chối đợt PM_APPROVED
    const canPurchase = (role === 'PURCHASING' || role === 'ADMIN'); // đặt hàng (ghi DM/PO) đợt APPROVED
    const canExport = (role === 'MANAGER' || role === 'ADMIN' || role === 'PURCHASING');
    const canCancel = (role === 'AM' || role === 'ADMIN');            // AM hủy đợt khi PM chưa duyệt

    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 overflow-x-auto scroll-area">
      <table class="dt">
        <thead><tr>
          <th>Đợt</th>
          <th class="c">Miền</th>
          <th>Ngày mở</th>
          <th class="hidden lg:table-cell">Ngày yêu cầu</th>
          <th class="hidden lg:table-cell">Ngày PM duyệt</th>
          <th class="hidden lg:table-cell">Ngày Manager duyệt</th>
          <th class="hidden lg:table-cell">Ngày đóng</th>
          <th class="c">Trạng thái</th>
          <th class="r">SKU · SL đặt</th>
          <th class="r">SL duyệt</th>
          <th class="r">SL đặt hàng</th>
          <th class="c">Tác vụ</th>
        </tr></thead>
        <tbody>${list.map(s => {
          const st = s.trang_thai;
          // Đợt này người dùng có quyền phê duyệt không?
          const reviewable = (st === 'SUBMITTED' && canPM) || (st === 'PM_APPROVED' && canMgr);
          // Từ chối CHỈ còn ở bước Manager (PM_APPROVED). Đã bỏ luồng PM từ chối AM.
          const canReject = (st === 'PM_APPROVED' && canMgr);
          // Thứ tự nút: Xem/Sửa · Phê duyệt · Từ chối · Chốt đợt · Nhập thông tin (Đặt hàng) · Xuất Excel
          let action = `<button class="ctl-btn" data-act="open" data-id="${s.session_id}" data-mien="${s.mien}">${reviewable ? 'Xem / Sửa' : 'Xem'}</button>`;
          if (reviewable) action += ` <button class="ctl-btn ctl-btn-primary" data-act="approve" data-id="${s.session_id}">Phê duyệt</button>`;
          if (canReject) action += ` <button class="ctl-btn ctl-btn-warn" data-act="reject" data-id="${s.session_id}">Từ chối</button>`;
          // AM hủy đợt khi CHƯA được PM duyệt (DRAFT hoặc SUBMITTED) -> trạng thái Đã hủy.
          if (canCancel && (st === 'DRAFT' || st === 'SUBMITTED')) action += ` <button class="ctl-btn ctl-btn-warn" data-act="cancel" data-id="${s.session_id}">Hủy</button>`;
          if (role === 'ADMIN' && st === 'APPROVED') action += ` <button class="ctl-btn" data-act="close" data-id="${s.session_id}">Chốt đợt</button>`;
          if (canPurchase && (st === 'APPROVED' || st === 'CLOSED')) action += ` <button class="ctl-btn ctl-btn-primary" data-act="purchase" data-id="${s.session_id}">Đặt hàng</button>`;
          if (canExport && (st === 'APPROVED' || st === 'CLOSED')) action += ` <button class="ctl-btn ctl-btn-ok" data-act="export" data-id="${s.session_id}">Xuất Excel</button>`;

          const mienLabel = s.mien === 'MB' ? 'Miền Bắc' : s.mien === 'MN' ? 'Miền Nam' : s.mien;
          const rejectNote = (st === 'DRAFT' && s.ly_do_tu_choi)
            ? `<div class="text-[10.5px] text-danger-600 mt-1">↩ Bị từ chối${s.tu_choi_o_buoc ? ' (' + esc(s.tu_choi_o_buoc) + ')' : ''}: ${esc(s.ly_do_tu_choi)}</div>`
            : '';
          const purchaseNote = (s.de_nghi_mua_hang || s.po)
            ? `<div class="text-[10.5px] text-primary-700 mt-1">🛒 DM: ${esc(s.de_nghi_mua_hang || '—')} · PO: ${esc(s.po || '—')}</div>`
            : '';
          return `<tr>
            <td><div class="font-medium text-slate-800">${esc(s.ten_dot)}</div><div class="text-[11px] text-slate-500">tạo bởi ${esc(s.tao_boi || '—')}</div></td>
            <td class="c"><span class="pill ${s.mien === 'MB' ? 'pill-info' : 'pill-mid'}">${mienLabel}</span></td>
            <td class="text-slate-600">${fmtDate(s.ngay_mo)}</td>
            <td class="text-slate-600 hidden lg:table-cell">${fmtDate(s.ngay_yeu_cau)}</td>
            <td class="text-slate-600 hidden lg:table-cell">${fmtDate(s.ngay_pm_duyet)}</td>
            <td class="text-slate-600 hidden lg:table-cell">${fmtDate(s.ngay_manager_duyet)}</td>
            <td class="text-slate-600 hidden lg:table-cell">${fmtDate(s.ngay_dong)}</td>
            <td class="c"><span class="pill ${ST_CLS[st] || 'st-draft'}">${ST_LABEL[st] || st}</span>${rejectNote}${purchaseNote}</td>
            <td class="r num text-slate-700">${(s.stats && s.stats.sku) || 0} · ${fmt((s.stats && s.stats.sl_dat) || 0)}</td>
            <td class="r num text-primary-700">${(s.stats && s.stats.approved_sku) || 0} · ${fmt((s.stats && s.stats.sl_duyet) || 0)}</td>
            <td class="r num text-primary-800">${(s.stats && s.stats.ordered_sku) || 0} · ${fmt((s.stats && s.stats.sl_dat_hang) || 0)}</td>
            <td class="c whitespace-nowrap">${action}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
  } catch (e) {
    console.error('[renderManageList]', e);
    // 3.10: kèm nút Thử lại thay vì chỉ hiện text lỗi
    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state text-danger-600">
      <div class="mb-3">Lỗi: ${esc(e.message)}</div>
      <button id="manageRetry" class="ctl-btn" type="button">Thử lại</button>
    </div>`;
    const retry = $('#manageRetry');
    if (retry) retry.onclick = () => renderManageList();
  }
}

// 1 listener delegation trên host (thay vì gắn cho từng nút mỗi lần render danh sách đợt).
function bindManageActions() {
  $('#manageHost').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    const act = b.dataset.act;
    if (act === 'open') {
      // Switch sang tab Chi tiết với session này (PM/Manager: sửa cột của mình rồi "Xác nhận")
      state.mien = b.dataset.mien;
      state.pinnedSessionId = id;   // mở đúng đợt được chọn, không auto-pick
      state.currentSession = state.sessions.find(s => s.session_id === id) || null;
      $$('.nav-tab').forEach(x => x.classList.toggle('active', x.dataset.view === 'order'));
      state.view = 'order';
      renderView();
    } else if (act === 'approve') {
      if (!(await askConfirm({ title: 'Phê duyệt đợt', message: 'Phê duyệt nhanh đợt này? Số lượng giữ nguyên từ bước trước, đợt sẽ chuyển sang bước kế tiếp.' }))) return;
      b.disabled = true;
      try {
        const r = await rpc('approveSession', id);
        toast('Đã phê duyệt · trạng thái → ' + (r.newStatus || ''));
        await loadSessions();
        renderManageList();
      } catch (e) { toast('Lỗi: ' + e.message, 'error'); b.disabled = false; }
    } else if (act === 'reject') {
      const reason = await askConfirm({
        title: 'Từ chối đợt', message: 'Đợt sẽ trả về AM để chỉnh sửa lại.', requireReason: true,
        reasonLabel: 'Lý do từ chối (bắt buộc)', okLabel: 'Từ chối', danger: true,
      });
      if (reason === null) return;
      b.disabled = true;
      try {
        await rpc('rejectSession', id, reason);
        toast('Đã từ chối · trả đợt về AM');
        await loadSessions();
        renderManageList();
      } catch (e) { toast('Lỗi: ' + e.message, 'error'); b.disabled = false; }
    } else if (act === 'cancel') {
      if (!(await askConfirm({
        title: 'Hủy đợt đặt hàng', message: 'Hủy đợt này? Đợt sẽ chuyển sang trạng thái "Đã hủy" và không dùng lại được.',
        danger: true, okLabel: 'Hủy đợt',
      }))) return;
      b.disabled = true;
      try {
        await rpc('cancelSession', id);
        toast('Đã hủy đợt · trạng thái → Đã hủy');
        await loadSessions();
        renderManageList();
      } catch (e) { toast('Lỗi: ' + e.message, 'error'); b.disabled = false; }
    } else if (act === 'export') {
      const sess = state.sessions.find(s => s.session_id === id) || { session_id: id, ten_dot: 'dot', mien: '' };
      await exportToExcel(sess);
    } else if (act === 'purchase') {
      const sess = state.sessions.find(s => s.session_id === id) || { session_id: id, ten_dot: '' };
      openPurchaseModal(sess);
    } else if (act === 'close') {
      if (!(await askConfirm({ title: 'Chốt đợt', message: 'Chốt đợt này? Sẽ không sửa được nữa.', danger: true, okLabel: 'Chốt đợt' }))) return;
      try {
        await rpc('closeSession', id);
        toast('Đã chốt đợt');
        await loadSessions();
        renderManageList();
      } catch (e) { toast('Lỗi: ' + e.message, 'error'); }
    }
  });
}

// ============ MODAL ĐẶT HÀNG (MUA HÀNG: DM + PO) ============
function openPurchaseModal(sess) {
  const modal = $('#modalPurchase');
  if (!modal) return;
  modal.classList.remove('hidden');
  const full = state.sessions.find(s => s.session_id === sess.session_id) || sess;
  $('#pmDM').value = full.de_nghi_mua_hang || '';
  $('#pmPO').value = full.po || '';
  $('#pmErr').textContent = '';
  const noteEl = $('#pmNote');
  if (noteEl) {
    noteEl.innerHTML = `Ghi thông tin mua hàng cho đợt <strong>${esc(full.ten_dot || '')}</strong>`
      + (full.mien ? ` (miền <strong>${full.mien === 'MB' ? 'Bắc' : full.mien === 'MN' ? 'Nam' : full.mien}</strong>)` : '') + '.';
  }
  setTimeout(() => $('#pmDM').focus(), 50);

  const release = trapModal(modal, () => close());
  const close = () => { modal.classList.add('hidden'); release(); };
  $('#pmClose').onclick = close;
  $('#pmCancel').onclick = close;

  $('#pmSubmit').onclick = async () => {
    const dm = $('#pmDM').value.trim();
    const po = $('#pmPO').value.trim();
    if (!dm && !po) { $('#pmErr').textContent = 'Nhập ít nhất Đề nghị mua hàng hoặc số PO'; return; }
    const btn = $('#pmSubmit');
    btn.disabled = true; btn.textContent = 'Đang lưu…';
    try {
      await rpc('recordPurchase', sess.session_id, dm, po);
      toast('Đã ghi thông tin đặt hàng (DM/PO)');
      close();
      await loadSessions();
      renderManageList();
    } catch (e) {
      $('#pmErr').textContent = e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Xác nhận';
    }
  };
}
