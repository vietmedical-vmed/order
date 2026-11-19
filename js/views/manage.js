// ============ MÀN QUẢN LÝ ĐẶT HÀNG (danh sách đợt) ============
import { $, $$, esc, fmt, fmtDate, splitGroups, viCmp } from '../utils.js';
import { rpc } from '../api.js';
import { state, canApprove, isAM, isPurchasing, userMiens } from '../state.js';
let _buListLoaded = false;
let _mGrpListLoaded = false;
let _mSelectedGroups = new Set();
import { toast } from '../toast.js';
import { askConfirm, trapModal } from '../modal.js';
import { loadSheetJS } from '../export-excel.js';
import { loadSessions } from '../session.js';
import { renderView } from '../router.js';


let _approvalFilterBound = false;
let _lastList = [];   // danh sách đợt vừa hiển thị (đã lọc) -> nguồn cho Xuất Excel

// Nhóm cột "Tiến trình" (ngày mở/duyệt + số lượng): mặc định ẩn, bấm tiêu đề để mở.
// Ghi nhớ lựa chọn theo trình duyệt (chỉ là tiện ích hiển thị).
const PROG_KEY = 'manage.progOpen';
const PROG_COLS = 8;
function progOpen() { try { return localStorage.getItem(PROG_KEY) === '1'; } catch (e) { return false; } }
function setProgOpen(v) { try { localStorage.setItem(PROG_KEY, v ? '1' : '0'); } catch (e) {} }
function applyProgState(table, open) {
  table.classList.toggle('prog-collapsed', !open);
  const th = table.querySelector('th.prog-head');
  if (!th) return;
  th.colSpan = open ? PROG_COLS : 1;
  th.rowSpan = open ? 1 : 2;
  th.setAttribute('aria-expanded', String(open));
  const chev = th.querySelector('.prog-chev');
  if (chev) chev.textContent = open ? '▾' : '▸';
  layoutManageTable();
}

// Bảng đợt: thanh cuộn ngang đặt ở ĐẦU bảng (đồng bộ với khung bảng) và khung bảng
// có chiều cao tối đa = phần còn lại của màn hình -> tiêu đề (sticky) luôn nằm trên khi cuộn dọc.
function bindManageScroll(host) {
  const top = host.querySelector('.m-tbl-top');
  const wrap = host.querySelector('.m-tbl-wrap');
  if (!top || !wrap) return;
  top.addEventListener('scroll', () => { if (wrap.scrollLeft !== top.scrollLeft) wrap.scrollLeft = top.scrollLeft; });
  wrap.addEventListener('scroll', () => { if (top.scrollLeft !== wrap.scrollLeft) top.scrollLeft = wrap.scrollLeft; });
}

function layoutManageTable() {
  const host = $('#manageHost');
  const wrap = host && host.querySelector('.m-tbl-wrap');
  const table = wrap && wrap.querySelector('table.dt');
  if (!table) return;
  // Chiều cao khung: tới sát đáy cửa sổ (tối thiểu 240px).
  const avail = window.innerHeight - wrap.getBoundingClientRect().top - 16;
  wrap.style.maxHeight = Math.max(240, Math.floor(avail)) + 'px';
  // Hàng tiêu đề thứ 2 (cột con của "Tiến trình") dính ngay dưới hàng 1.
  const rows = table.tHead ? table.tHead.rows : [];
  if (rows.length > 1) {
    const h = rows[0].getBoundingClientRect().height;
    [...rows[1].cells].forEach(c => { c.style.top = h + 'px'; });
  }
  // Thanh cuộn trên: rộng bằng bảng; ẩn khi bảng vừa khung.
  const top = host.querySelector('.m-tbl-top');
  top.querySelector('.m-tbl-top-spacer').style.width = table.scrollWidth + 'px';
  top.classList.toggle('hidden', table.scrollWidth <= wrap.clientWidth + 1);
  top.scrollLeft = wrap.scrollLeft;
}

// Nhóm đợt theo tháng của ngày mở. Mặc định chỉ tháng hiện tại xổ ra;
// lựa chọn mở/đóng giữ trong lúc ở tab (vẽ lại sau duyệt/từ chối không bị đóng lại).
const MANAGE_COLS = 18;   // 9 cột chính + ô thu gọn + 8 cột Tiến trình
const NO_MONTH = 'none';
let _openMonths = new Set();
function monthKeyOf(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return NO_MONTH;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function monthLabel(key) {
  if (key === NO_MONTH) return 'Không rõ ngày mở';
  const [y, m] = key.split('-');
  return `Tháng ${Number(m)}/${y}`;
}
function groupByMonth(list) {
  const map = new Map();
  list.forEach(s => {
    const k = monthKeyOf(s.ngay_mo);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  });
  // Tháng mới nhất lên đầu; "Không rõ ngày" xuống cuối.
  return [...map.entries()].sort((a, b) => a[0] === NO_MONTH ? 1 : b[0] === NO_MONTH ? -1 : b[0].localeCompare(a[0]));
}
function toggleMonth(row) {
  const key = row.dataset.month;
  const open = !_openMonths.has(key);
  if (open) _openMonths.add(key); else _openMonths.delete(key);
  row.setAttribute('aria-expanded', String(open));
  const chev = row.querySelector('.m-month-chev');
  if (chev) chev.textContent = open ? '▾' : '▸';
  $$(`tr[data-month-child="${CSS.escape(key)}"]`, row.closest('tbody')).forEach(tr => tr.classList.toggle('hidden', !open));
  layoutManageTable();
}

let _manageResizeBound = false;
function bindManageResizeOnce() {
  if (_manageResizeBound) return;
  _manageResizeBound = true;
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(layoutManageTable, 100); });
}

async function loadBUFilter() {
  if (_buListLoaded) return;
  _buListLoaded = true;
  const sel = $('#mBU');
  if (!sel) return;
  if (isAM() && state.user.bu) {
    sel.innerHTML = `<option value="${esc(state.user.bu)}">${esc(state.user.bu)}</option>`;
    sel.disabled = true;
    state.manageBU = state.user.bu;
    return;
  }
  try {
    const list = await rpc('listBU');
    if (Array.isArray(list) && list.length) {
      sel.innerHTML = '<option value="ALL">Tất cả BU</option>' + list.map(b => `<option value="${esc(b.bu_code || b.bu)}">${esc(b.ten_bu || b.bu)}</option>`).join('');
    }
  } catch (e) { console.warn('[loadBUFilter]', e); }
  sel.addEventListener('change', () => { state.manageBU = sel.value; renderManageList(); });
}

async function loadManageGroupFilter() {
  if (_mGrpListLoaded) return;
  _mGrpListLoaded = true;
  const btn = $('#mGrpBtn');
  const menu = $('#mGrpMenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', () => menu.classList.toggle('hidden'));
  document.addEventListener('click', e => {
    if (menu && !menu.classList.contains('hidden') && !e.target.closest('#mGrpWrap')) menu.classList.add('hidden');
  });
  try {
    const list = await rpc('listProductGroups');
    const groups = (list || []).sort(viCmp);
    menu.innerHTML = groups.map(g => {
      return `<label class="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded cursor-pointer text-[13px]">
        <input type="checkbox" class="m-grp-cb rounded" value="${esc(g)}"/>${esc(g)}</label>`;
    }).join('');
    $$('.m-grp-cb', menu).forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _mSelectedGroups.add(cb.value);
        else _mSelectedGroups.delete(cb.value);
        updateManageGroupLabel();
        renderManageList();
      });
    });
  } catch (e) { console.warn('[loadManageGroupFilter]', e); }
}

function updateManageGroupLabel() {
  const label = $('#mGrpLabel');
  if (_mSelectedGroups.size === 0) label.textContent = 'Tất cả nhóm SP';
  else if (_mSelectedGroups.size === 1) label.textContent = [..._mSelectedGroups][0];
  else label.textContent = _mSelectedGroups.size + ' nhóm SP';
}

function bindApprovalFilterOnce() {
  if (_approvalFilterBound) return;
  _approvalFilterBound = true;
  $('#mStatus').addEventListener('change', renderManageList);
  $('#mExport').addEventListener('click', exportManageList);
  const miens = userMiens();
  if (isAM() && miens.length === 1) {
    state.manageMien = miens[0];
    const seg = $('#mMienSeg'); if (seg) seg.style.display = 'none';
  } else {
    $$('.mmien-btn').forEach(b => {
      // AM nhiều miền: chỉ hiện "Tất cả" + các miền mình phụ trách.
      if (isAM() && b.dataset.mmien !== 'ALL' && !miens.includes(b.dataset.mmien)) { b.style.display = 'none'; return; }
      b.addEventListener('click', () => {
        $$('.mmien-btn').forEach(x => {
          x.classList.toggle('active', x === b);
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        state.manageMien = b.dataset.mmien;
        renderManageList();
      });
    });
  }
  if (isPurchasing()) { const st = $('#mStatus'); if (st) st.value = 'APPROVED'; }
}

export async function initApprovalView() {
  if (!canApprove() && !isAM() && !isPurchasing()) {
    $('#main').innerHTML = '<div class="empty-state">Không có quyền</div>';
    return;
  }
  state.manageMien = state.manageMien || 'ALL';
  state.manageBU = state.manageBU || 'ALL';
  bindApprovalFilterOnce();
  await loadBUFilter();
  await loadManageGroupFilter();
  _openMonths = new Set([monthKeyOf(new Date().toISOString())]);
  bindManageActions();
  bindManageResizeOnce();
  await renderManageList();
}

const ST_LABEL = { DRAFT: 'AM đang nhập', SUBMITTED: 'PM chờ duyệt', PM_APPROVED: 'Manager chờ duyệt', APPROVED: 'Đã duyệt', COMPLETED: 'Hoàn thành', CANCELED: 'Đã hủy' };
const ST_CLS = { DRAFT: 'st-draft', SUBMITTED: 'st-sub', PM_APPROVED: 'pill-mid', APPROVED: 'st-app', COMPLETED: 'st-done', CANCELED: 'pill-hot' };

async function renderManageList() {
  const host = $('#manageHost');
  host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 p-4" aria-busy="true">
    ${'<div class="skeleton-line"></div>'.repeat(5)}</div>`;
  try {
    const status = $('#mStatus').value;
    const mien = state.manageMien || 'ALL';
    const bu = state.manageBU || 'ALL';
    let list = await rpc('listSessions', { mien, status, bu });
    if (!Array.isArray(list)) throw new Error(`Server trả về ${list === null ? 'null' : typeof list} thay vì danh sách đợt.`);
    if (_mSelectedGroups.size > 0) {
      list = list.filter(s => {
        if (!s.nhom_san_pham) return false;
        const sessGroups = splitGroups(s.nhom_san_pham);
        return sessGroups.some(g => _mSelectedGroups.has(g));
      });
    }
    _lastList = list;
    if (!list.length) {
      host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state">Không có đợt nào</div>`;
      return;
    }
    const role = state.user.role;
    const canPM = (role === 'PM' || role === 'ADMIN');           // duyệt/từ chối đợt SUBMITTED
    const canMgr = (role === 'MANAGER' || role === 'ADMIN');     // duyệt/từ chối đợt PM_APPROVED
    const canPurchase = (role === 'PURCHASING' || role === 'ADMIN'); // thêm PO + hoàn thành đợt APPROVED; xem/sửa PO đợt COMPLETED
    const canCancel = (role === 'AM' || role === 'ADMIN');            // AM hủy đợt khi PM chưa duyệt

    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 overflow-hidden">
      <div class="m-tbl-top scroll-area" aria-hidden="true"><div class="m-tbl-top-spacer"></div></div>
      <div class="m-tbl-wrap scroll-area">
      <table class="dt">
        <thead><tr>
          <th rowspan="2">Đợt</th>
          <th rowspan="2">Tạo bởi</th>
          <th rowspan="2" class="c">BU</th>
          <th rowspan="2">Nhóm SP</th>
          <th rowspan="2" class="c">Miền</th>
          <th rowspan="2" class="c">Chủ sở hữu</th>
          <th rowspan="2" class="c">Trạng thái</th>
          <th rowspan="2">TT đặt hàng</th>
          <th rowspan="2">Tác vụ</th>
          <th class="prog-head" role="button" tabindex="0" title="Bấm để ẩn/hiện các cột tiến trình"><span class="prog-chev">▸</span> Tiến trình</th>
        </tr><tr class="prog-sub">
          <th class="prog-col">Ngày mở</th>
          <th class="prog-col">Ngày yêu cầu</th>
          <th class="prog-col">PM duyệt</th>
          <th class="prog-col">Manager duyệt</th>
          <th class="prog-col" title="Ngày điền PO đầu tiên">Đặt hàng</th>
          <th class="prog-col r">SKU · SL yêu cầu</th>
          <th class="prog-col r">SKU · SL duyệt</th>
          <th class="prog-col r">SKU · SL đặt hàng</th>
        </tr></thead>
        <tbody>${groupByMonth(list).map(([key, items]) => {
          const open = _openMonths.has(key);
          return `<tr class="m-month" data-month="${esc(key)}" role="button" tabindex="0" aria-expanded="${open}">
            <td colspan="${MANAGE_COLS}"><div class="m-month-label">
              <span class="m-month-chev">${open ? '▾' : '▸'}</span>
              <span>${esc(monthLabel(key))}</span>
              <span class="text-[11px] font-normal text-slate-500">${items.length} đợt</span>
            </div></td>
          </tr>` + items.map(s => rowHtml(s, key, open)).join('');
        }).join('')}</tbody>
      </table>
      </div>
    </div>`;
    applyProgState(host.querySelector('table.dt'), progOpen());
    bindManageScroll(host);
    layoutManageTable();

    function rowHtml(s, monthKey, open) {
          const st = s.trang_thai;
          // Đợt này người dùng có quyền phê duyệt không?
          const reviewable = (st === 'SUBMITTED' && (canPM || canMgr)) || (st === 'PM_APPROVED' && canMgr);
          // Từ chối: PM ở SUBMITTED, Manager ở PM_APPROVED (hoặc SUBMITTED nếu CTTM skip PM).
          const canReject = (st === 'SUBMITTED' && (canPM || canMgr)) || (st === 'PM_APPROVED' && canMgr);
          // Thứ tự nút: Xem · Phê duyệt · Từ chối · Hủy · Nhập PO / PO
          let action = `<button class="ctl-btn ctl-btn-xs" data-act="open" data-id="${s.session_id}" data-mien="${s.mien}">Xem</button>`;
          if (reviewable) action += ` <button class="ctl-btn ctl-btn-xs ctl-btn-primary" data-act="approve" data-id="${s.session_id}">Phê duyệt</button>`;
          if (canReject) action += ` <button class="ctl-btn ctl-btn-xs ctl-btn-warn" data-act="reject" data-id="${s.session_id}">Từ chối</button>`;
          // AM hủy đợt khi CHƯA được PM duyệt (DRAFT hoặc SUBMITTED) -> trạng thái Đã hủy.
          if (canCancel && (st === 'DRAFT' || st === 'SUBMITTED')) action += ` <button class="ctl-btn ctl-btn-xs ctl-btn-warn" data-act="cancel" data-id="${s.session_id}">Hủy</button>`;
          if (canPurchase && st === 'APPROVED') action += ` <button class="ctl-btn ctl-btn-xs ctl-btn-primary" data-act="purchase" data-id="${s.session_id}">Nhập PO</button>`;
          if (canPurchase && st === 'COMPLETED') action += ` <button class="ctl-btn ctl-btn-xs" data-act="purchase" data-id="${s.session_id}">PO</button>`;
          // Manager: chỉ sửa số PO / DM đã nhập (không thêm/xóa/hoàn thành) -> chỉ hiện khi đợt đã có PO.
          if (role === 'MANAGER' && (st === 'APPROVED' || st === 'COMPLETED') && s.po) action += ` <button class="ctl-btn ctl-btn-xs" data-act="purchase" data-id="${s.session_id}">PO</button>`;

          const mienLabel = s.mien === 'MB' ? 'Miền Bắc' : s.mien === 'MN' ? 'Miền Nam' : s.mien;
          const rejectNote = (st === 'DRAFT' && s.ly_do_tu_choi)
            ? `<div class="text-[10.5px] text-danger-600 mt-1">↩ Bị từ chối${s.tu_choi_o_buoc ? ' (' + esc(s.tu_choi_o_buoc) + ')' : ''}: ${esc(s.ly_do_tu_choi)}</div>`
            : '';
          // TT đặt hàng: thông tin từ bước Nhập PO (đề nghị mua hàng + số PO).
          const purchaseInfo = (s.de_nghi_mua_hang || s.po)
            ? `<div class="${st === 'COMPLETED' ? 'text-success-700' : 'text-primary-700'}">
                <div><span class="text-slate-500">DM:</span> ${esc(s.de_nghi_mua_hang || '—')}</div>
                <div><span class="text-slate-500">PO:</span> ${esc(s.po || '—')}</div></div>`
            : '<span class="text-slate-400">—</span>';
          return `<tr data-month-child="${esc(monthKey)}"${open ? '' : ' class="hidden"'}>
            <td class="font-medium text-slate-800" style="min-width:140px">${esc(s.ten_dot)}</td>
            <td class="text-slate-700 whitespace-nowrap" title="${esc(s.tao_boi || '')}">${esc(s.tao_boi_ten || s.tao_boi || '—')}</td>
            <td class="c text-slate-700 whitespace-nowrap">${esc(s.bu_label || s.bu || '—')}</td>
            <td class="text-slate-700 text-[12px]" style="min-width:140px;max-width:240px">${s.nhom_san_pham ? esc(splitGroups(s.nhom_san_pham).join(', ')) : '<span class="text-slate-400">—</span>'}</td>
            <td class="c whitespace-nowrap"><span class="pill ${s.mien === 'MB' ? 'pill-info' : 'pill-mid'}">${mienLabel}</span></td>
            <td class="c text-slate-700 whitespace-nowrap">${s.csh_dklh ? esc(s.csh_dklh) : '<span class="text-slate-400">—</span>'}</td>
            <td class="c"><span class="pill whitespace-nowrap ${ST_CLS[st] || 'st-draft'}">${ST_LABEL[st] || st}</span>${rejectNote}</td>
            <td class="text-[12px]" style="min-width:130px;max-width:220px">${purchaseInfo}</td>
            <td class="whitespace-nowrap">${action}</td>
            <td class="prog-stub"></td>
            <td class="prog-col text-slate-600">${fmtDate(s.ngay_mo)}</td>
            <td class="prog-col text-slate-600">${fmtDate(s.ngay_yeu_cau)}</td>
            <td class="prog-col text-slate-600">${fmtDate(s.ngay_pm_duyet)}</td>
            <td class="prog-col text-slate-600">${fmtDate(s.ngay_manager_duyet)}</td>
            <td class="prog-col text-slate-600">${fmtDate(s.ngay_dat_hang)}</td>
            <td class="prog-col r num text-slate-700">${(s.stats && s.stats.sku) || 0} · ${fmt((s.stats && s.stats.sl_dat) || 0)}</td>
            <td class="prog-col r num text-primary-700">${(s.stats && s.stats.approved_sku) || 0} · ${fmt((s.stats && s.stats.sl_duyet) || 0)}</td>
            <td class="prog-col r num text-primary-800">${(s.stats && s.stats.ordered_sku) || 0} · ${fmt((s.stats && s.stats.sl_dat_hang) || 0)}</td>
          </tr>`;
    }
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
  const host = $('#manageHost');
  const toggleProg = th => {
    const open = !progOpen();
    setProgOpen(open);
    applyProgState(th.closest('table'), open);
  };
  host.addEventListener('keydown', e => {
    const th = e.target.closest('th.prog-head');
    if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleProg(th); return; }
    const mr = e.target.closest('tr.m-month');
    if (mr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleMonth(mr); }
  });
  host.addEventListener('click', async (e) => {
    const th = e.target.closest('th.prog-head');
    if (th) { toggleProg(th); return; }
    const mr = e.target.closest('tr.m-month');
    if (mr) { toggleMonth(mr); return; }
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
    } else if (act === 'purchase') {
      const sess = state.sessions.find(s => s.session_id === id) || { session_id: id, ten_dot: '' };
      openPurchaseModal(sess);
    }
  });
}


// ============ XUẤT EXCEL DANH SÁCH ĐỢT (1 dòng / đợt, kèm cột PO) ============
async function exportManageList() {
  const list = _lastList || [];
  if (!list.length) { toast('Không có đợt nào để xuất', 'error'); return; }
  const btn = $('#mExport');
  btn.disabled = true;
  try {
    const XLSX = await loadSheetJS();
    const d = (v) => (v ? fmtDate(v) : '');
    const n = (v) => Number(v) || 0;
    const header = ['STT', 'Đợt', 'BU', 'Miền', 'Chủ sở hữu', 'Nhóm SP', 'Tạo bởi',
      'Ngày mở', 'Ngày yêu cầu', 'PM duyệt', 'Manager duyệt', 'Đặt hàng', 'Trạng thái',
      'Số SKU', 'SL yêu cầu', 'SL duyệt', 'SL đặt hàng',
      'Số PO', 'PO', 'DM', 'Người hoàn thành', 'Ngày hoàn thành'];
    const aoa = [header];
    list.forEach((s, i) => {
      const st = s.stats || {};
      const pos = String(s.po || '').split(';').map(x => x.trim()).filter(Boolean);
      aoa.push([
        i + 1, s.ten_dot, s.bu_label || s.bu || '', s.mien === 'MB' ? 'Miền Bắc' : s.mien === 'MN' ? 'Miền Nam' : s.mien,
        s.csh_dklh || '', splitGroups(s.nhom_san_pham).join(', '), s.tao_boi_ten || s.tao_boi || '',
        d(s.ngay_mo), d(s.ngay_yeu_cau), d(s.ngay_pm_duyet), d(s.ngay_manager_duyet), d(s.ngay_dat_hang), ST_LABEL[s.trang_thai] || s.trang_thai,
        n(st.sku), n(st.sl_dat), n(st.sl_duyet), n(st.sl_dat_hang),
        pos.length || '', pos.join('; '), s.de_nghi_mua_hang || '',
        s.trang_thai === 'COMPLETED' ? (s.nguoi_mua_hang || '') : '', s.trang_thai === 'COMPLETED' ? d(s.ngay_mua_hang) : '',
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 5 }, { wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 24 }, { wch: 14 },
      { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 13 }, { wch: 12 }, { wch: 16 },
      { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 11 },
      { wch: 7 }, { wch: 30 }, { wch: 22 }, { wch: 16 }, { wch: 13 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Danh sách đợt');
    XLSX.writeFile(wb, `danh-sach-dot_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast(`Đã xuất ${list.length} đợt ra Excel`);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============ MODAL PO CỦA ĐỢT (MUA HÀNG: nhiều PO → HOÀN THÀNH ĐỢT) ============
// Đợt APPROVED: thêm/xóa PO, bấm "Hoàn thành đợt" khi đủ (cần >= 1 PO).
// Đợt COMPLETED: vẫn thêm/xóa PO (phải còn >= 1), không có nút Hoàn thành.
// Sửa số PO / DM / ghi chú từng dòng: Mua hàng, Manager, Admin. Manager CHỈ sửa (không thêm/xóa/hoàn thành).
function openPurchaseModal(sess) {
  const modal = $('#modalPurchase');
  if (!modal) return;
  const full = state.sessions.find(s => s.session_id === sess.session_id) || sess;
  const sid = full.session_id;
  const role = state.user.role;
  const canManage = role === 'PURCHASING' || role === 'ADMIN';   // thêm/xóa PO + hoàn thành đợt
  let status = full.trang_thai;
  let pos = [];
  let editingId = null;  // po_id đang sửa trên bảng
  let changed = false;   // có thêm/sửa/xóa PO -> tải lại danh sách đợt khi đóng

  modal.classList.remove('hidden');
  $('#pmAddForm').classList.toggle('hidden', !canManage);
  $('#pmPO').value = '';
  $('#pmDM').value = '';
  $('#pmNoteInput').value = '';
  $('#pmErr').textContent = '';
  const where = `đợt <strong>${esc(full.ten_dot || '')}</strong>`
    + (full.mien ? ` (miền <strong>${full.mien === 'MB' ? 'Bắc' : full.mien === 'MN' ? 'Nam' : full.mien}</strong>)` : '');

  const renderHeader = () => {
    const done = status === 'COMPLETED';
    $('#modalPurchaseTitle').textContent = !canManage ? 'PO của đợt'
      : done ? 'PO của đợt · Hoàn thành' : 'Nhập PO · hoàn thành đợt';
    $('#pmNote').innerHTML = !canManage
      ? `PO của ${where}. Bấm <strong>Sửa</strong> trên từng dòng để sửa số PO / DM.`
      : done
        ? `PO của ${where}. Đợt đã <strong>Hoàn thành</strong>; vẫn thêm/sửa/xóa PO được (còn ít nhất 1 PO).`
        : `Nhập PO của ${where} rồi bấm <strong>Hoàn thành đợt</strong>. Đợt có nhiều PO: bấm <strong>+ Thêm PO</strong> để lưu PO đang nhập, rồi nhập PO tiếp theo.`;
    $('#pmSubmit').classList.toggle('hidden', done || !canManage);
    syncSubmit();
  };
  // "Hoàn thành đợt" bấm được khi đã có PO trong danh sách HOẶC đang nhập số PO (sẽ tự lưu PO đó trước).
  const syncSubmit = () => {
    const ok = pos.length > 0 || !!$('#pmPO').value.trim();
    const btn = $('#pmSubmit');
    btn.disabled = !ok;
    btn.title = ok ? '' : 'Nhập số PO trước';
  };
  $('#pmPO').oninput = syncSubmit;

  const renderList = () => {
    const host = $('#pmList');
    if (!pos.length) {
      host.innerHTML = '<div class="px-3 py-3 text-[12px] text-slate-500 text-center">Chưa có PO nào</div>';
    } else {
      host.innerHTML = `<table class="w-full text-[12.5px]">
        <thead class="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
          <tr><th class="text-left px-3 py-1.5 font-medium">#</th><th class="text-left px-3 py-1.5 font-medium">Số PO</th>
          <th class="text-left px-3 py-1.5 font-medium">DM</th><th class="text-left px-3 py-1.5 font-medium">Ghi chú</th><th></th></tr>
        </thead>
        <tbody>${pos.map((p, i) => p.po_id === editingId ? `<tr class="border-t border-slate-100 bg-primary-50/40" data-edit-row="${esc(p.po_id)}">
          <td class="px-3 py-1.5 text-slate-500">${i + 1}</td>
          <td class="px-1 py-1"><input data-f="po" value="${esc(p.po)}" aria-label="Số PO" class="w-full px-2 py-1 text-[12.5px] border border-slate-300 rounded outline-none focus:border-primary-500"/></td>
          <td class="px-1 py-1"><input data-f="de_nghi_mua_hang" value="${esc(p.de_nghi_mua_hang)}" aria-label="DM" class="w-full px-2 py-1 text-[12.5px] border border-slate-300 rounded outline-none focus:border-primary-500"/></td>
          <td class="px-1 py-1"><input data-f="ghi_chu" value="${esc(p.ghi_chu)}" aria-label="Ghi chú" class="w-full px-2 py-1 text-[12.5px] border border-slate-300 rounded outline-none focus:border-primary-500"/></td>
          <td class="px-2 py-1 text-right whitespace-nowrap"><button type="button" class="ctl-btn ctl-btn-primary" data-po-save="${esc(p.po_id)}">Lưu</button> <button type="button" class="ctl-btn" data-po-cancel="1">Hủy</button></td>
        </tr>` : `<tr class="border-t border-slate-100">
          <td class="px-3 py-1.5 text-slate-500">${i + 1}</td>
          <td class="px-3 py-1.5 font-medium text-slate-800">${esc(p.po)}</td>
          <td class="px-3 py-1.5 text-slate-600">${esc(p.de_nghi_mua_hang || '—')}</td>
          <td class="px-3 py-1.5 text-slate-600" title="${esc((p.tao_boi || '') + (p.tao_luc ? ' · ' + fmtDate(p.tao_luc) : ''))}">${esc(p.ghi_chu || '—')}</td>
          <td class="px-2 py-1 text-right whitespace-nowrap"><button type="button" class="ctl-btn" data-po-edit="${esc(p.po_id)}" aria-label="Sửa PO ${esc(p.po)}">Sửa</button>${canManage ? ` <button type="button" class="ctl-btn ctl-btn-warn" data-po-del="${esc(p.po_id)}" aria-label="Xóa PO ${esc(p.po)}">Xóa</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    }
    renderHeader();
  };

  // Esc / bấm nền: đang sửa 1 dòng thì chỉ hủy sửa, không đóng modal.
  const release = trapModal(modal, () => {
    if (editingId) { editingId = null; renderList(); return; }
    close();
  });
  const close = async () => {
    modal.classList.add('hidden');
    release();
    if (changed) { await loadSessions(); renderManageList(); }
  };
  $('#pmClose').onclick = close;
  $('#pmCancel').onclick = close;

  $('#pmList').innerHTML = '<div class="px-3 py-3"><div class="skeleton-line"></div></div>';
  renderHeader();
  rpc('listSessionPOs', sid)
    .then(list => { pos = Array.isArray(list) ? list : []; renderList(); })
    .catch(e => { $('#pmErr').textContent = 'Lỗi tải PO: ' + e.message; });
  if (canManage) setTimeout(() => $('#pmPO').focus(), 50);

  const saveEdit = async (poId) => {
    const row = $('#pmList').querySelector(`tr[data-edit-row="${CSS.escape(poId)}"]`);
    if (!row) return;
    const val = (f) => row.querySelector(`input[data-f="${f}"]`).value.trim();
    const input = { po: val('po'), de_nghi_mua_hang: val('de_nghi_mua_hang'), ghi_chu: val('ghi_chu') };
    if (!input.po) { $('#pmErr').textContent = 'Nhập số PO'; row.querySelector('input[data-f="po"]').focus(); return; }
    row.querySelectorAll('button, input').forEach(x => { x.disabled = true; });
    $('#pmErr').textContent = '';
    try {
      const r = await rpc('updateSessionPO', sid, poId, input);
      pos = r.pos || pos; editingId = null; changed = true;
      renderList();
      toast('Đã cập nhật PO');
    } catch (err) {
      $('#pmErr').textContent = err.message;
      row.querySelectorAll('button, input').forEach(x => { x.disabled = false; });
    }
  };

  // Lưu PO đang nhập vào danh sách. Trả true nếu lưu được.
  const add = async () => {
    const po = $('#pmPO').value.trim();
    if (!po) { $('#pmErr').textContent = 'Nhập số PO'; $('#pmPO').focus(); return false; }
    const btn = $('#pmAdd');
    btn.disabled = true;
    $('#pmErr').textContent = '';
    try {
      const r = await rpc('addSessionPO', sid, {
        po, de_nghi_mua_hang: $('#pmDM').value.trim(), ghi_chu: $('#pmNoteInput').value.trim(),
      });
      pos = r.pos || pos; status = r.trang_thai || status; changed = true;
      $('#pmPO').value = ''; $('#pmNoteInput').value = '';   // giữ DM: thường nhiều PO chung 1 DM
      renderList();
      $('#pmPO').focus();
      return true;
    } catch (e) {
      $('#pmErr').textContent = e.message;
      return false;
    } finally {
      btn.disabled = false;
    }
  };
  $('#pmAdd').onclick = add;
  ['#pmPO', '#pmDM', '#pmNoteInput'].forEach(id => {
    $(id).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  });

  // Sửa trên dòng: Enter = Lưu. Esc = Hủy sửa (xử lý trong onDismiss của trapModal).
  $('#pmList').onkeydown = (e) => {
    const row = e.target.closest('tr[data-edit-row]');
    if (row && e.key === 'Enter') { e.preventDefault(); saveEdit(row.dataset.editRow); }
  };

  $('#pmList').onclick = async (e) => {
    const ed = e.target.closest('button[data-po-edit]');
    if (ed) {
      editingId = ed.dataset.poEdit; $('#pmErr').textContent = '';
      renderList();
      const inp = $('#pmList').querySelector('tr[data-edit-row] input[data-f="po"]');
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
    if (e.target.closest('button[data-po-cancel]')) { editingId = null; renderList(); return; }
    const sv = e.target.closest('button[data-po-save]');
    if (sv) { await saveEdit(sv.dataset.poSave); return; }

    // Xóa: bấm 2 lần (lần 1 đổi nút thành "Xóa?") để tránh xóa nhầm.
    const b = e.target.closest('button[data-po-del]');
    if (!b) return;
    if (!b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Xóa?';
      setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Xóa'; } }, 3000);
      return;
    }
    b.disabled = true;
    $('#pmErr').textContent = '';
    try {
      const r = await rpc('deleteSessionPO', sid, b.dataset.poDel);
      pos = r.pos || []; status = r.trang_thai || status; changed = true;
      renderList();
    } catch (err) {
      $('#pmErr').textContent = err.message;
      b.disabled = false;
    }
  };

  $('#pmSubmit').onclick = async () => {
    const btn = $('#pmSubmit');
    btn.disabled = true; btn.textContent = 'Đang lưu…';
    // PO đang nhập (chưa bấm "+ Thêm PO") -> lưu luôn rồi mới hoàn thành.
    if ($('#pmPO').value.trim() && !(await add())) {
      btn.textContent = 'Hoàn thành đợt'; syncSubmit();
      return;
    }
    if (!pos.length) {
      $('#pmErr').textContent = 'Nhập số PO trước khi hoàn thành đợt';
      btn.textContent = 'Hoàn thành đợt'; syncSubmit();
      return;
    }
    btn.disabled = true;   // add() vẽ lại danh sách và bật lại nút -> khóa lại khi đang hoàn thành
    try {
      await rpc('completeSession', sid);
      toast(`Đợt hoàn thành · ${pos.length} PO`);
      changed = true;
      await close();
    } catch (e) {
      $('#pmErr').textContent = e.message;
      btn.disabled = false;
    } finally {
      btn.textContent = 'Hoàn thành đợt';
    }
  };
}
