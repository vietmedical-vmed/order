// ============ MÀN ĐẶT HÀNG (Chi tiết) ============
import { $, $$, esc, fmt, dash0, fmtVND, debounce, viCmp, splitGroups } from '../utils.js';
import { DRAFT_KEY } from '../config.js';
import { rpc } from '../api.js';
import { state, canCreateSession } from '../state.js';
import { toast } from '../toast.js';
import { askConfirm, trapModal } from '../modal.js';
import { loadSessions } from '../session.js';
import { renderView } from '../router.js';
import { setupOrderTable, lockColumnWidths, applyStickyCols, syncScrollWidths, invalidateTableMetrics, didDrag } from '../table-sticky.js';
import { exportToExcel } from '../export-excel.js';

// ============ ĐỊNH NGHĨA CỘT (nguồn duy nhất cho thead + dòng con + dòng tổng phân loại) ============
// Gộp 1 chỗ để header, ô dữ liệu và khoá sắp xếp (3.7) không bao giờ lệch nhau.
const NUM = 'num', TXT = 'text';

const QTY_LABELS = { sl_dat: 'SL yêu cầu', sl_duyet: 'SL PM duyệt', sl_dat_hang: 'SL đặt hàng' };

const qtyCell = (r, field, colorCls, ctx) => {
  const currentValue = r[field];
  const display = currentValue == null ? '—' : fmt(currentValue);
  const canEdit = ctx.editFields && ctx.editFields.has(field);
  if (canEdit && r.editable !== false) {
    // Điền sẵn gợi ý CHỈ cho cột chính của bước có bật prefill (AM xác nhận / PM / Manager).
    // Chế độ sửa-ô-đã-chỉnh (admin, AM cập nhật khi SUBMITTED): giữ nguyên giá trị đã lưu.
    const prefill = field === ctx.primaryField && ctx.prefill;
    const def = prefill ? qtyDefault(r, field) : 0;
    const saved = currentValue != null ? Number(currentValue) : null;
    const change = state.changes.get(r.ma_bravo);
    const shown = (change && change[field] !== undefined) ? Number(change[field] || 0)
                : (saved != null ? saved : (prefill ? def : ''));
    const baseline = prefill ? def : (saved != null ? saved : 0);
    const adjusted = shown !== '' && Number(shown || 0) !== baseline;
    return `<td class="c"><input type="number" class="qty-input ${adjusted ? 'dirty' : ''}" min="0" value="${shown === '' ? '' : (shown || '')}"
      data-field="${field}" data-id="${esc(r.ma_bravo)}" data-default="${def}" data-prefill="${prefill ? 1 : 0}" aria-label="${esc(QTY_LABELS[field] || 'Số lượng')} — ${esc(r.ma_bravo)}"/></td>`;
  }
  const lockTitle = (canEdit && r.editable === false) ? ' title="Ngoài scope của bạn"' : '';
  return `<td class="c num font-medium ${currentValue != null ? colorCls : 'text-slate-300'}"${lockTitle}>${display}</td>`;
};

// MoI = Tồn kho (DA) / TB tháng TH, làm tròn XUỐNG. Không có mức dùng (TB tháng TH = 0)
// thì không tính được -> null (hiển thị '—'), tránh chia cho 0.
const moiOf = (x) => {
  const th = Number(x.tb_th || 0);
  if (th <= 0) return null;
  return Math.floor(Number(x.ton_kho || 0) / th);
};

// Ô MoI: số nguyên + "tháng"; tô vàng khi tồn đủ dùng LÂU HƠN leadtime (lt = null -> không so).
const moiCell = (moi, lt) => {
  if (moi == null) return `<td class="c num text-slate-300">—</td>`;
  const over = lt != null && lt !== '' && moi > Number(lt);
  const cls = over ? 'bg-warning-100 text-warning-800 font-semibold' : 'text-slate-600';
  const t = over ? ' title="Tồn kho đủ dùng lâu hơn Leadtime"' : '';
  return `<td class="c num text-[11px] ${cls}"${t}>${moi} tháng</td>`;
};

const numCol = (key, label, width, opts = {}) => ({
  key, label, sort: NUM, cls: opts.cls || 'r', width,
  aggKey: opts.aggKey || key,
  cell: r => `<td class="${opts.cls || 'r'} num ${opts.cellCls || 'text-slate-600'}">${dash0(r[key])}</td>`,
  agg: a => `<td class="${opts.cls || 'r'} num ${opts.aggCls || ''}">${dash0(a[opts.aggKey || key])}</td>`,
  ...opts.override,
});

const BASE_COLUMNS = [
  {
    key: '__idx', label: '#', cls: 'c', width: 42, sort: null,
    cell: r => `<td class="c num text-slate-500 text-[11px]">${r.__idx}</td>`,
    agg: () => `<td class="c"><svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></td>`,
  },
  {
    key: 'ma_bravo', label: 'Mã Bravo', width: 130, sort: TXT,
    cell: r => `<td class="font-mono text-[11px] text-slate-700 nowrap">${esc(r.ma_bravo)}</td>`,
    agg: () => `<td class="text-slate-400">—</td>`,
  },
  {
    key: 'code_ncc', label: 'Mã NCC', width: 100, sort: TXT,
    cell: r => `<td class="font-mono text-[11px] text-slate-500 nowrap">${esc(r.code_ncc || '—')}</td>`,
    agg: () => `<td class="text-slate-400">—</td>`,
  },
  {
    key: 'ten_hang', label: 'Tên hàng', minWidth: 240, sort: TXT,
    cell: r => `<td class="font-medium text-slate-800 leading-snug">${esc(r.ten_hang || '')}</td>`,
    agg: (a, ctx) => `<td class="text-slate-900"><strong>${esc(ctx.pl)}</strong> <span class="text-[11px] text-slate-500 font-normal">(${ctx.count} SKU)</span></td>`,
  },
  {
    key: 'muc_do_sd', label: 'Mức độ', cls: 'c', width: 62, sort: TXT,
    cell: r => {
      const pillCls = r.muc_do_sd === 'Hay sử dụng' ? 'pill-hot' : r.muc_do_sd === 'Ít sử dụng' ? 'pill-mid' : 'pill-low';
      const pillText = r.muc_do_sd === 'Hay sử dụng' ? 'Hay' : r.muc_do_sd === 'Ít sử dụng' ? 'Ít' : 'Hiếm';
      return `<td class="c"><span class="pill ${pillCls}">${pillText}</span></td>`;
    },
    agg: () => `<td></td>`,
  },
  numCol('ton_kho', 'Tồn kho (DA)', 80),
  numCol('hang_ktv_bv', 'Hàng ký gửi', 90),
  numCol('hang_vet_thau', 'Vét thầu (GU)', 80),
  numCol('hang_di_duong', 'Hàng đi đường', 90),
  numCol('tong_ton', 'Tổng tồn', 80, { cellCls: 'font-semibold text-slate-800', aggCls: 'text-slate-900' }),
  {
    key: 'ty_le_sd_pct', label: '% SD', cls: 'r', width: 80, sort: NUM,
    cell: r => `<td class="r num text-slate-700">${r.ty_le_sd_pct ? `${Math.round(r.ty_le_sd_pct)}%<div class="mini-bar"><i style="width:${Math.min(100, r.ty_le_sd_pct * 5)}%"></i></div>` : '—'}</td>`,
    agg: () => `<td class="r num text-slate-400">—</td>`,
  },
  numCol('sl_th_fy24', 'SL TH FY24', 90, { override: { title: 'SL thực hiện FY24 (T04/2024 – T03/2025)' } }),
  numCol('sl_th_fy25', 'SL TH FY25', 90, { override: { title: 'SL thực hiện FY25 (T04/2025 – T03/2026)' } }),
  numCol('sl_th_fy26_ytd', 'SL TH FY26', 95, { override: { title: 'SL thực hiện FY26 YTD (từ T04/2026)' } }),
  // TB tháng TH = TB SL thực hiện, chỉ chia cho SỐ THÁNG CÓ PHÁT SINH (gộp CKNT + YTD cũ).
  numCol('tb_th', 'TB tháng TH', 95),
  {
    // TB KH là số ở mức sản phẩm (phân loại) — dòng SKU không có giá trị riêng nên không sắp xếp được.
    key: 'tb_kh_3_thang', label: 'TB KH', cls: 'r', width: 90, sort: null,
    cell: () => `<td class="r num text-slate-300">—</td>`,
    agg: a => `<td class="r num">${dash0(a.tb_kh_3_thang)}</td>`,
  },
  numCol('safety_stock', 'Safety stock', 90),
  {
    // MoI (Month of Inventory) = Tồn kho DA / TB tháng TH — tồn hiện có đủ dùng mấy tháng.
    // Dài hơn leadtime = hàng nằm kho lâu hơn thời gian cần để hàng mới về -> tô vàng.
    key: 'moi', label: 'MoI', cls: 'c', width: 80, sort: NUM,
    title: 'Month of Inventory = Tồn kho (DA) ÷ TB tháng TH — tồn hiện có đủ dùng bao nhiêu tháng (làm tròn xuống). Tô vàng khi dài hơn Leadtime.',
    cell: r => moiCell(moiOf(r), r.leadtime_thang),
    agg: a => moiCell(moiOf(a), null),   // dòng tổng: không có leadtime chung -> chỉ hiện số
  },
  {
    key: 'so_thang_dat', label: 'Số tháng đặt', cls: 'c', width: 78, sort: NUM,
    cell: r => `<td class="c num text-slate-600 text-[11px]">${r.so_thang_dat ? `${Math.round(r.so_thang_dat)} tháng` : '—'}</td>`,
    agg: () => `<td class="c num text-slate-400">—</td>`,
  },
  {
    key: 'leadtime_thang', label: 'Leadtime', cls: 'c', width: 75, sort: NUM,
    cell: r => `<td class="c num text-slate-600 text-[11px]">${r.leadtime_thang != null && r.leadtime_thang !== '' ? `${r.leadtime_thang} tháng` : '—'}</td>`,
    agg: () => `<td class="c num text-slate-400">—</td>`,
  },
  {
    key: 'goi_y_dat', label: 'Gợi ý', cls: 'c', width: 60, sort: NUM,
    cell: r => `<td class="c num"><span class="font-bold text-primary-700">${dash0(r.goi_y_dat)}</span></td>`,
    agg: a => `<td class="c num text-primary-700">${dash0(a.goi_y_dat)}</td>`,
  },
];

// Các cột chỉ hiện khi đang xem 1 đợt (chế độ "bảng thông tin" thì ẩn).
const SESSION_COLUMNS = [
  {
    key: 'sl_dat', label: 'SL yêu cầu', cls: 'c', width: 80, sort: NUM, qty: true,
    cell: (r, ctx) => qtyCell(r, 'sl_dat', 'text-warning-700', ctx),
    agg: (a, ctx) => `<td class="c num text-warning-700" data-pl-sum="sl_dat:${ctx.plId}">${fmt(a.sl_dat)}</td>`,
  },
  {
    key: 'sl_duyet', label: 'SL PM duyệt', cls: 'c', width: 80, sort: NUM, qty: true,
    cell: (r, ctx) => qtyCell(r, 'sl_duyet', 'text-primary-700', ctx),
    agg: (a, ctx) => `<td class="c num text-primary-700" data-pl-sum="sl_duyet:${ctx.plId}">${a.sl_duyet > 0 ? fmt(a.sl_duyet) : '—'}</td>`,
  },
  {
    key: 'sl_dat_hang', label: 'SL đặt hàng', cls: 'c', width: 80, sort: NUM, qty: true,
    cell: (r, ctx) => qtyCell(r, 'sl_dat_hang', 'text-primary-800 font-bold', ctx),
    agg: (a, ctx) => `<td class="c num text-primary-800 font-bold" data-pl-sum="sl_dat_hang:${ctx.plId}">${a.sl_dat_hang > 0 ? fmt(a.sl_dat_hang) : '—'}</td>`,
  },
  {
    key: 'de_nghi_mua_hang', label: 'DM', cls: 'c', width: 120, sort: null, title: 'Đề nghị mua hàng',
    cell: () => `<td class="c text-[11.5px] text-slate-600">${(state.currentSession && state.currentSession.de_nghi_mua_hang) ? esc(state.currentSession.de_nghi_mua_hang) : '—'}</td>`,
    agg: () => `<td class="c text-slate-300">—</td>`,
  },
  {
    key: 'po', label: 'PO', cls: 'c', width: 120, sort: null, title: 'Số PO',
    cell: () => `<td class="c text-[11.5px] text-slate-600">${(state.currentSession && state.currentSession.po) ? esc(state.currentSession.po) : '—'}</td>`,
    agg: () => `<td class="c text-slate-300">—</td>`,
  },
  {
    key: 'ghi_chu', label: 'Ghi chú', minWidth: 160, sort: null,
    cell: (r, ctx) => {
      const noteValue = noteEffective(r, ctx.editNoteField);
      return (ctx.editNoteField && r.editable !== false)
        ? `<td><input type="text" class="note-input" value="${esc(noteValue)}" placeholder="—" data-field="${ctx.editNoteField}" data-id="${esc(r.ma_bravo)}" aria-label="Ghi chú — ${esc(r.ma_bravo)}"/></td>`
        : `<td class="text-[11.5px] text-slate-500 italic">${esc(noteValue || '—')}</td>`;
    },
    agg: () => `<td></td>`,
  },
];

function columns() {
  return state.currentSession ? BASE_COLUMNS.concat(SESSION_COLUMNS) : BASE_COLUMNS;
}

// ============ KHỞI TẠO MÀN HÌNH ============
export async function initOrderView() {
  $('#btnNewSession').addEventListener('click', openCreateSessionModal);
  $('#fGrp').addEventListener('change', e => { state.filters.grp = e.target.value; renderPLOptions(); renderOrderBody(); });
  initPLFilter();
  initMucDoFilter();
  $('#fLowStock').addEventListener('change', e => { state.filters.lowStock = e.target.checked; renderOrderBody(); });
  $('#fOnlyQty').addEventListener('click', () => {
    state.filters.onlyWithQty = !state.filters.onlyWithQty;
    syncOnlyQtyButton();
    renderOrderBody();
    updateOrderStats();
  });
  $('#fSearch').addEventListener('input', debounce(e => { state.filters.search = e.target.value.toLowerCase(); renderOrderBody(); }, 250));
  const btnExport = $('#btnExport');
  if (btnExport) btnExport.onclick = () => exportToExcel();
  const btnExit = $('#btnExitSession');
  if (btnExit) btnExit.onclick = async () => {
    if (state.changes.size > 0 && !(await askConfirm({ title: 'Thoát đợt', message: 'Có thay đổi chưa lưu. Thoát đợt sẽ mất. Tiếp tục?', danger: true }))) return;
    state.pinnedSessionId = null;
    state.changes.clear();
    await loadOrderData();
  };
  bindOrderInputs();
  bindPLToggles();
  bindSortHeaders();

  // Bind mien buttons (chúng nằm trong template tpl-order, phải bind lại sau mỗi render)
  const role = state.user.role;
  $$('.mien-btn').forEach(b => {
    // AM: ẩn các miền khác miền của user; chỉ giữ nút miền của mình
    if (role === 'AM') {
      if (b.dataset.mien !== state.user.mien) {
        b.style.display = 'none';
        return;
      }
    }
    b.classList.toggle('active', b.dataset.mien === state.mien);
    b.setAttribute('aria-pressed', b.dataset.mien === state.mien ? 'true' : 'false');
    b.addEventListener('click', async () => {
      const m = b.dataset.mien;
      if (m === state.mien) return;
      if (state.changes.size > 0 && !(await askConfirm({ title: 'Chuyển miền', message: 'Có thay đổi chưa lưu. Chuyển miền sẽ mất. Tiếp tục?', danger: true }))) return;
      state.mien = m;
      state.changes.clear();
      state.pinnedSessionId = null;   // đổi miền -> chọn lại đợt của miền mới
      $$('.mien-btn').forEach(x => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      await loadSessions();
      await loadOrderData();
    });
  });

  await loadOrderData();
}

export async function loadOrderData(pinSessionId) {
  const host = $('#orderTableHost');
  host.innerHTML = tableSkeleton();
  $('#orderStats').innerHTML = '';
  const bannerHost = $('#sessionBanner');
  if (bannerHost) bannerHost.innerHTML = '';
  try {
    const sid = pinSessionId || state.pinnedSessionId || null;
    const data = await rpc('loadOrderScreen', sid, state.mien);
    if (!data || typeof data !== 'object') {
      throw new Error('Server trả về dữ liệu rỗng (' + (data === null ? 'null' : typeof data) + '). Xem log Supabase Edge Function order-api.');
    }
    state.rows = Array.isArray(data.rows) ? data.rows : [];
    state.rowIndex = new Map(state.rows.map(r => [r.ma_bravo, r]));
    state.readOnly = !!data.readOnly;
    state.currentSession = data.session || null;
    // Giữ đúng đợt đang xem cho các lần tải lại sau (đến khi đổi miền).
    state.pinnedSessionId = data.session ? data.session.session_id : null;
    state.currentAction = data.action || null;
    // Các cột số lượng được sửa trực tiếp (admin: cả 3; AM/PM/Manager: 1 cột của bước).
    // Fallback về cột của action cho tương thích payload cũ chưa có editFields.
    state.editFields = Array.isArray(data.editFields) && data.editFields.length
      ? data.editFields
      : (state.currentAction && state.currentAction.editField
          ? [{ field: state.currentAction.editField, noteField: state.currentAction.editNoteField }]
          : []);
    state.stockAsof = data.stock_asof || '';
    // Mặc định thu gọn "chỉ mã có số lượng" theo bước (trừ lúc AM nhập ở DRAFT thì hiện đủ).
    state.filters.onlyWithQty = defaultOnlyWithQty();
    syncOnlyQtyButton();
    syncExitSessionButton();
    await tryRestoreDraft();
    populateGrpAndPLOptions();
    renderSessionBanner();
    renderOrderBody();
    updateOrderStats();
    updateDraftIndicator();
  } catch (e) {
    console.error('[loadOrderData] error:', e);
    host.innerHTML = errorBox('Lỗi tải dữ liệu: ' + e.message, 'orderRetry');
    const retry = $('#orderRetry');
    if (retry) retry.onclick = () => loadOrderData(pinSessionId);
    state.currentSession = null;
    state.currentAction = null;
    state.editFields = [];
    state.filters.onlyWithQty = false;
    syncOnlyQtyButton();
    syncExitSessionButton();
    renderSessionBanner();
  }
}

// 3.8: skeleton xám thay dòng chữ "Đang tải…" — cảm giác nhanh hơn khi bảng lớn.
function tableSkeleton(rows = 8) {
  const line = '<div class="skeleton-line"></div>';
  return `<div class="bg-white rounded-lg border border-slate-200 p-4" aria-busy="true" aria-label="Đang tải dữ liệu">
    ${line.repeat(rows)}
  </div>`;
}

// 3.10: khối lỗi kèm nút Thử lại (id truyền vào để caller gắn handler đúng loader).
function errorBox(msg, retryId) {
  return `<div class="bg-white rounded-lg border border-slate-200 empty-state text-danger-600">
    <div class="mb-3">${esc(msg)}</div>
    <button id="${retryId}" class="ctl-btn" type="button">Thử lại</button>
  </div>`;
}

function renderSessionBanner() {
  const host = $('#sessionBanner');
  if (!host) return;
  const sess = state.currentSession;

  // Chú thích nguồn dữ liệu tồn kho (cycledate mới nhất trong bảng stock).
  const asof = state.stockAsof;
  const stockNote = asof
    ? `<div class="text-[11.5px] text-slate-500 mb-3 -mt-1 flex items-center gap-1.5">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Thông tin hàng tồn kho cập nhật đến ngày <strong class="text-slate-700">${esc(asof)}</strong></div>`
    : '';

  if (!sess) {
    const isAll = state.mien === 'ALL';
    const note = isAll
      ? `Đang xem <strong>tổng hợp MB + MN</strong> (${state.rows.length} SKU, số tồn & xuất là tổng 2 miền). Chuyển sang <strong>Miền Bắc</strong> hoặc <strong>Miền Nam</strong> để xem chi tiết đợt đặt hàng.`
      : `Đang xem <strong>danh mục</strong> (${state.rows.length} SKU) — chưa có đợt đặt hàng nào cho miền <strong>${state.mien}</strong>.`;
    host.innerHTML = (canCreateSession() && !isAll
      ? `<div class="bg-warning-50 border border-warning-200 rounded-lg px-4 py-2.5 mb-4 flex items-center gap-2 text-[13px] text-warning-900">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${note} Bấm <strong>+ Tạo đặt hàng</strong> bên dưới để bắt đầu.</span>
        </div>`
      : `<div class="bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 mb-4 text-[13px] text-slate-600">${note}</div>`) + stockNote;
    return;
  }

  // Đợt đã hủy: không hiển thị stepper (đã kết thúc) — chỉ báo trạng thái Đã hủy.
  if (sess.trang_thai === 'CANCELED') {
    host.innerHTML = `<div class="bg-danger-50 border border-danger-200 rounded-lg px-4 py-3 mb-4 flex items-center gap-2 text-[13px] text-danger-800">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        <span>Đợt <strong>${esc(sess.ten_dot)}</strong> đã bị <strong>hủy</strong> — chỉ xem, không thao tác được.</span>
      </div>` + stockNote;
    return;
  }

  const statusOrder = ['DRAFT', 'SUBMITTED', 'PM_APPROVED', 'APPROVED'];
  const stepLabels = { DRAFT: 'AM xác nhận', SUBMITTED: 'PM xác nhận', PM_APPROVED: 'Manager phê duyệt', APPROVED: 'Hoàn thành' };
  const stepHints = {
    DRAFT: 'AM nhập số lượng yêu cầu rồi bấm xác nhận',
    SUBMITTED: 'PM rà soát và điều chỉnh số lượng duyệt',
    PM_APPROVED: 'Manager phê duyệt lần cuối (hoặc từ chối trả về AM)',
    APPROVED: 'Đợt đã duyệt — Mua hàng ghi DM/PO và xuất Excel',
  };
  const currIdx = statusOrder.indexOf(sess.trang_thai);
  const isDone = sess.trang_thai === 'APPROVED' || sess.trang_thai === 'CLOSED';

  const stepsHtml = statusOrder.map((st, i) => {
    let circleCls, content;
    if (i < currIdx || (isDone && i === currIdx)) {
      circleCls = 'bg-primary-500 text-white';
      content = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    } else if (i === currIdx) {
      circleCls = 'bg-warning-500 text-white ring-2 ring-warning-200';
      content = String(i + 1);
    } else {
      circleCls = 'bg-slate-200 text-slate-500';
      content = String(i + 1);
    }
    const labelCls = i <= currIdx ? 'text-slate-800 font-medium' : 'text-slate-500';
    const conn = i < 3 ? `<div class="w-6 h-px ${i < currIdx ? 'bg-primary-400' : 'bg-slate-200'}"></div>` : '';
    // 4.4: tooltip giải thích từng bước cho người dùng mới
    return `<div class="flex items-center gap-1.5" title="${esc(stepHints[st])}">
      <div class="w-5 h-5 rounded-full ${circleCls} flex items-center justify-center text-[10px] font-semibold flex-shrink-0">${content}</div>
      <span class="text-[11px] ${labelCls} whitespace-nowrap">${stepLabels[st]}</span>
    </div>${conn}`;
  }).join('');

  const created = sess.ngay_mo ? new Date(sess.ngay_mo).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  const mienCls = sess.mien === 'MB' ? 'pill-info' : 'pill-mid';

  const rejectAlert = (sess.trang_thai === 'DRAFT' && sess.ly_do_tu_choi)
    ? `<div class="bg-danger-50 border border-danger-200 rounded-lg px-4 py-2.5 mb-4 flex items-start gap-2 text-[13px] text-danger-800">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mt-0.5 flex-shrink-0"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span><strong>Đợt bị từ chối${sess.tu_choi_o_buoc ? ' bởi ' + esc(sess.tu_choi_o_buoc) : ''}${sess.nguoi_tu_choi ? ' (' + esc(sess.nguoi_tu_choi) + ')' : ''}:</strong> ${esc(sess.ly_do_tu_choi)}<br>Vui lòng chỉnh sửa và xác nhận lại.</span>
      </div>`
    : '';

  host.innerHTML = rejectAlert + `
    <div class="bg-white rounded-lg border border-slate-200 px-4 py-3 mb-4 flex items-center gap-4 flex-wrap shadow-sm">
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white flex-shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Đang xem</span>
            <h2 class="font-semibold text-[14px] text-slate-900 truncate">${esc(sess.ten_dot)}</h2>
            <span class="pill ${mienCls}">${sess.mien === 'MB' ? 'Miền Bắc' : 'Miền Nam'}</span>
            ${splitGroups(sess.nhom_san_pham).map(g => `<span class="pill pill-info" title="Đợt chỉ gồm danh mục các nhóm sản phẩm này">${esc(g)}</span>`).join('')}
          </div>
          <div class="text-[11px] text-slate-500 mt-0.5">Tạo bởi <span class="font-medium">${esc(sess.tao_boi || '—')}</span> · ${created}</div>
        </div>
      </div>
      <div class="flex-1"></div>
      <div class="flex items-center gap-1.5 flex-wrap">${stepsHtml}</div>
    </div>
  ` + stockNote;
}

// ============ BỘ LỌC ============
// 4.3: điều hướng bàn phím cho dropdown lọc (↑↓ chuyển option, Enter/Space chọn, Esc đóng).
function bindMenuKeyboard(btn, menu, openMenu, closeMenu) {
  const items = () => $$('input[type=checkbox], button', menu).filter(el => el.offsetParent !== null);
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu();
      const first = items()[0];
      if (first) first.focus();
    } else if (e.key === 'Escape') closeMenu();
  });
  menu.addEventListener('keydown', e => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); btn.focus(); }
  });
}

// Dropdown lọc mức độ — cho phép chọn nhiều option qua checkbox.
function initMucDoFilter() {
  const btn = $('#fMucDoBtn');
  const menu = $('#fMucDoMenu');
  const label = $('#fMucDoLabel');
  if (!btn || !menu || !label) return;

  const opts = () => $$('.fmucdo-opt');
  // Khôi phục trạng thái đã chọn khi view được render lại
  const cur = state.filters.mucDo || [];
  opts().forEach(o => { o.checked = cur.includes(o.value); });

  const updateLabel = () => {
    const sel = state.filters.mucDo || [];
    if (!sel.length) label.textContent = 'Tất cả mức độ';
    else if (sel.length === 1) label.textContent = sel[0];
    else label.textContent = sel.length + ' mức độ';
    btn.classList.toggle('ctl-active', sel.length > 0);
  };
  updateLabel();

  const closeMenu = () => { menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); };
  const openMenu = () => { menu.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); };

  btn.onclick = (e) => {
    e.stopPropagation();
    menu.classList.contains('hidden') ? openMenu() : closeMenu();
  };
  opts().forEach(o => {
    o.onchange = () => {
      state.filters.mucDo = opts().filter(x => x.checked).map(x => x.value);
      updateLabel();
      renderOrderBody();
    };
  });
  const clearBtn = $('#fMucDoClear');
  if (clearBtn) clearBtn.onclick = (e) => {
    e.stopPropagation();
    opts().forEach(o => { o.checked = false; });
    state.filters.mucDo = [];
    updateLabel();
    renderOrderBody();
  };
  bindMenuKeyboard(btn, menu, openMenu, closeMenu);

  // Đóng menu khi click ra ngoài
  if (window.__mucDoOutside) document.removeEventListener('click', window.__mucDoOutside);
  window.__mucDoOutside = (e) => {
    const wrap = $('#fMucDoWrap');
    if (wrap && !wrap.contains(e.target)) closeMenu();
  };
  document.addEventListener('click', window.__mucDoOutside);
}

function populateGrpAndPLOptions() {
  const grps = [...new Set(state.rows.map(r => r.nhom_hang).filter(Boolean))].sort(viCmp);
  $('#fGrp').innerHTML = '<option value="">Tất cả nhóm hàng</option>' + grps.map(g => `<option ${state.filters.grp === g ? 'selected' : ''}>${esc(g)}</option>`).join('');
  renderPLOptions();
}

// Danh sách sản phẩm (phân loại) trong menu — link theo nhóm hàng đang chọn, sắp ABC, chọn nhiều.
function renderPLOptions() {
  const menu = $('#fPLMenu');
  if (!menu) return;
  const grp = state.filters.grp;
  const pls = [...new Set(
    state.rows.filter(r => !grp || r.nhom_hang === grp).map(r => r.phan_loai).filter(Boolean)
  )].sort(viCmp);
  // Bỏ các sản phẩm đã chọn nhưng không còn thuộc nhóm hiện tại
  state.filters.pl = (state.filters.pl || []).filter(p => pls.includes(p));
  const sel = state.filters.pl;

  menu.innerHTML = pls.length ? (
    pls.map(p => `
      <label class="flex items-center gap-2 px-2 py-1.5 text-[13px] rounded hover:bg-slate-50 cursor-pointer">
        <input type="checkbox" class="rounded fpl-opt shrink-0" value="${esc(p)}" ${sel.includes(p) ? 'checked' : ''}/>
        <span class="truncate">${esc(p)}</span>
      </label>`).join('') +
    `<div class="border-t border-slate-100 mt-1 pt-1 sticky bottom-0 bg-white">
       <button type="button" id="fPLClear" class="w-full text-left px-2 py-1.5 text-[12px] text-slate-500 rounded hover:bg-slate-50">Bỏ chọn tất cả</button>
     </div>`
  ) : `<div class="px-2 py-3 text-[12px] text-slate-500 text-center">Không có sản phẩm</div>`;

  $$('.fpl-opt', menu).forEach(o => {
    o.onchange = () => {
      state.filters.pl = $$('.fpl-opt', menu).filter(x => x.checked).map(x => x.value);
      updatePLLabel();
      renderOrderBody();
    };
  });
  const clr = $('#fPLClear');
  if (clr) clr.onclick = (e) => {
    e.stopPropagation();
    state.filters.pl = [];
    renderPLOptions();
    updatePLLabel();
    renderOrderBody();
  };
  updatePLLabel();
}

function updatePLLabel() {
  const label = $('#fPLLabel'); const btn = $('#fPLBtn');
  if (!label) return;
  const sel = state.filters.pl || [];
  label.textContent = !sel.length ? 'Tất cả sản phẩm' : (sel.length === 1 ? sel[0] : sel.length + ' sản phẩm');
  if (btn) btn.classList.toggle('ctl-active', sel.length > 0);
}

function initPLFilter() {
  const btn = $('#fPLBtn'); const menu = $('#fPLMenu');
  if (!btn || !menu) return;
  const openMenu = () => { menu.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); };
  const closeMenu = () => { menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = (e) => { e.stopPropagation(); menu.classList.contains('hidden') ? openMenu() : closeMenu(); };
  bindMenuKeyboard(btn, menu, openMenu, closeMenu);
  if (window.__plOutside) document.removeEventListener('click', window.__plOutside);
  window.__plOutside = (e) => { const w = $('#fPLWrap'); if (w && !w.contains(e.target)) closeMenu(); };
  document.addEventListener('click', window.__plOutside);
}

// Mã đã thực sự có trong đợt: ít nhất 1 cột SL đã lưu > 0 (bỏ null/0/điền sẵn gợi ý).
function hasSavedQty(r) {
  return Number(r.sl_dat || 0) > 0 || Number(r.sl_duyet || 0) > 0 || Number(r.sl_dat_hang || 0) > 0;
}

// Bước AM đang NHẬP ở DRAFT: cần thấy toàn danh mục để nhập/thêm mã -> mặc định KHÔNG thu gọn.
// Các bước còn lại (PM/Manager duyệt, admin, xem lại đợt đã duyệt): mặc định chỉ hiện mã có SL.
function defaultOnlyWithQty() {
  if (!state.currentSession) return false;
  const a = state.currentAction;
  const amEntry = a && a.editField === 'sl_dat' && state.currentSession.trang_thai === 'DRAFT';
  return !amEntry;
}

// Đồng bộ nút toggle: chỉ hiện khi đang xem 1 đợt; nhãn/aria đổi theo trạng thái lọc.
function syncOnlyQtyButton() {
  const btn = $('#fOnlyQty');
  if (!btn) return;
  const active = !!(state.currentSession && state.filters.onlyWithQty);
  btn.classList.toggle('hidden', !state.currentSession);
  btn.classList.toggle('ctl-active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  btn.textContent = active ? 'Chỉ mã có số lượng' : 'Đang xem toàn bộ';
}

function syncExitSessionButton() {
  const btn = $('#btnExitSession');
  if (btn) btn.classList.toggle('hidden', !state.currentSession);
}

function filteredOrderRows() {
  const f = state.filters;
  return state.rows.filter(r => {
    if (f.grp && r.nhom_hang !== f.grp) return false;
    if (f.pl && f.pl.length && !f.pl.includes(r.phan_loai)) return false;
    if (f.mucDo && f.mucDo.length && !f.mucDo.includes(r.muc_do_sd)) return false;
    if (f.lowStock && r.tong_ton > r.goi_y_dat) return false;
    // "Chỉ mã có số lượng": chỉ khi đang xem 1 đợt, lọc theo giá trị ĐÃ LƯU (không tính điền
    // sẵn gợi ý) — mã có ít nhất 1 trong SL yêu cầu / PM duyệt / đặt hàng > 0.
    if (f.onlyWithQty && state.currentSession && !hasSavedQty(r)) return false;
    if (f.search) {
      const hay = ((r.ma_bravo || '') + ' ' + (r.code_ncc || '') + ' ' + (r.ten_hang || '')
        + ' ' + (r.phan_loai || '') + ' ' + (r.nhom_hang || '')).toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  });
}

// ============ 3.7: SẮP XẾP CỘT ============
function sortValue(r, key) {
  if (key === 'sl_dat' || key === 'sl_duyet' || key === 'sl_dat_hang') return qtyEffective(r, key);
  if (key === 'moi') return moiOf(r) ?? -1;   // không tính được -> xuống cuối khi xếp giảm dần
  return r[key];
}

function sortItems(items) {
  const { key, dir } = state.sort;
  if (!key) return items;
  const col = columns().find(c => c.key === key);
  if (!col || !col.sort) return items;
  const isNum = col.sort === NUM;
  return items.slice().sort((a, b) => {
    if (isNum) return (Number(sortValue(a, key) || 0) - Number(sortValue(b, key) || 0)) * dir;
    return viCmp(sortValue(a, key) ?? '', sortValue(b, key) ?? '') * dir;
  });
}

function bindSortHeaders() {
  $('#orderTableHost').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort-key]');
    if (!th) return;
    if (didDrag()) return;   // vừa kéo ngang thead để cuộn, không phải click sắp xếp
    const key = th.dataset.sortKey;
    const numeric = th.dataset.sortType === NUM;
    if (state.sort.key === key) {
      // cùng cột: đảo chiều, chiều thứ 3 = bỏ sắp xếp (về thứ tự gốc)
      if ((numeric && state.sort.dir === 1) || (!numeric && state.sort.dir === -1)) state.sort = { key: null, dir: 1 };
      else state.sort = { key, dir: -state.sort.dir };
    } else {
      state.sort = { key, dir: numeric ? -1 : 1 };   // số: lớn→nhỏ trước; chữ: A→Z trước
    }
    renderOrderBody();
  });
}

function theadHtml(cols) {
  const cells = cols.map(c => {
    const w = c.width ? `width:${c.width}px` : (c.minWidth ? `min-width:${c.minWidth}px` : '');
    const title = c.title ? ` title="${esc(c.title)}"` : '';
    if (!c.sort) return `<th class="${c.cls || ''}" style="${w}"${title}>${esc(c.label)}</th>`;
    const active = state.sort.key === c.key;
    const arrow = active ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : '';
    const ariaSort = active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none';
    // (title đặt 1 lần ở cuối — kèm gợi ý bấm để sắp xếp; không lặp lại attribute)
    return `<th class="${c.cls || ''} th-sort${active ? ' th-sort-active' : ''}" style="${w}"
      data-sort-key="${c.key}" data-sort-type="${c.sort}" aria-sort="${ariaSort}"
      title="${esc(c.title || c.label)} — bấm để sắp xếp">${esc(c.label)}${arrow}</th>`;
  }).join('');
  return `<thead><tr>${cells}</tr></thead>`;
}

// ============ RENDER BẢNG ============
export function renderOrderBody() {
  const host = $('#orderTableHost');
  const rows = filteredOrderRows();
  updateFilterCount(rows.length);
  if (!rows.length) {
    const msg = !state.currentSession
      ? (canCreateSession() ? 'Đang xem danh mục — bấm "+ Tạo đặt hàng" ở trên để bắt đầu' : 'Đang xem danh mục — chưa có đợt nào để đặt hàng')
      : 'Không có SKU nào phù hợp với bộ lọc';
    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state">${emptySvg()}${esc(msg)}</div>`;
    return;
  }

  // Số thứ tự liên tục trong toàn bộ kết quả lọc
  rows.forEach((r, i) => r.__idx = i + 1);

  // Group 2 cấp: nhom_hang → phan_loai
  const byGroup = new Map();
  rows.forEach(r => {
    const g = r.nhom_hang || 'Khác';
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    const pl = r.phan_loai || '(không phân loại)';
    if (!byGroup.get(g).has(pl)) byGroup.get(g).set(pl, []);
    byGroup.get(g).get(pl).push(r);
  });

  // Sắp xếp nhóm hàng (ABC) và trong mỗi nhóm sắp xếp phân loại/sản phẩm (ABC) theo tiếng Việt
  const sortedGroups = Array.from(byGroup.entries())
    .sort((a, b) => viCmp(a[0], b[0]))
    .map(([grp, plMap]) => [grp, new Map(Array.from(plMap.entries()).sort((a, b) => viCmp(a[0], b[0])))]);

  // Cache plMap theo tên nhóm để render lười: nhóm đóng chỉ dựng tbody khi mở lần đầu
  // (xem bindGroupToggles) — placeOrder() không phụ thuộc DOM nên an toàn (xem 3.4).
  state.orderGroupsCache = new Map(sortedGroups);
  host.innerHTML = sortedGroups.map(([grp, plMap], gIdx) => groupCardHtml(grp, plMap, gIdx)).join('');
  bindGroupToggles();
  setupOrderTable();
}

// 4.4: empty state có hình minh hoạ nhẹ thay vì chỉ chữ.
function emptySvg() {
  return `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"
    stroke-linecap="round" stroke-linejoin="round" class="mx-auto mb-3 text-slate-300" aria-hidden="true">
    <path d="M3 7h18v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 7l2-4h14l2 4"/><path d="M9 11h6"/></svg>`;
}

function updateFilterCount(shown) {
  const el = $('#fCount');
  if (!el) return;
  const total = state.rows.length;
  const filtering = shown !== total;
  el.textContent = filtering ? `Đang hiện ${fmt(shown)}/${fmt(total)} SKU` : `${fmt(total)} SKU`;
  el.classList.toggle('text-primary-700', filtering);
  el.classList.toggle('font-medium', filtering);
}

// Nguồn "gợi ý mặc định" để điền sẵn cho mỗi ô số lượng theo bước:
//  SL yêu cầu ← Gợi ý · SL PM duyệt ← SL yêu cầu · SL đặt hàng ← SL PM duyệt.
const QTY_DEFAULT_SRC = { sl_dat: 'goi_y_dat', sl_duyet: 'sl_dat', sl_dat_hang: 'sl_duyet' };

// Giá trị điền sẵn (gợi ý) cho 1 ô số lượng của 1 dòng.
function qtyDefault(r, field) {
  const src = QTY_DEFAULT_SRC[field];
  return src ? Number(r[src] || 0) : 0;
}

// Giá trị hiệu lực của 1 ô số lượng: đang sửa > đã lưu > điền sẵn theo gợi ý.
// Chỉ điền sẵn cho cột đang nhập của bước hiện tại (và dòng trong phạm vi của user).
function qtyEffective(r, field) {
  const ch = state.changes.get(r.ma_bravo);
  if (ch && ch[field] !== undefined) return Number(ch[field] || 0);
  if (r[field] != null) return Number(r[field]);
  const action = state.currentAction;
  // Điền sẵn gợi ý chỉ khi bước có bật prefill (không áp dụng cho admin / AM cập nhật SUBMITTED).
  if (action && action.editField === field && action.prefill !== false && r.editable !== false) return qtyDefault(r, field);
  return 0;
}

// Ghi chú hiệu lực của 1 dòng: đang sửa > đã lưu (đúng field) > ghi chú các bước trước.
function noteEffective(r, field) {
  const ch = state.changes.get(r.ma_bravo);
  if (ch && ch[field] !== undefined) return ch[field];
  return r[field] || r.ghi_chu_dat || r.ghi_chu_duyet || r.ghi_chu_dat_hang || '';
}

function rowContext() {
  const action = state.currentAction;
  const fields = state.editFields || [];
  return {
    editFields: new Set(fields.map(f => f.field)),          // cột số lượng sửa được
    primaryField: action ? action.editField : null,         // cột chính (điền sẵn gợi ý)
    prefill: action ? action.prefill !== false : false,     // bước có điền sẵn gợi ý không
    editNoteField: action ? action.editNoteField : null,    // 1 cột ghi chú theo bước hiện tại
    editLabel: action ? action.label : null,
  };
}

function groupCardHtml(grp, plMap, gIdx) {
  const allItems = Array.from(plMap.values()).flat();
  const totalSku = allItems.length;
  const totalOrdered = allItems.reduce((s, r) => s + qtyEffective(r, 'sl_dat'), 0);
  const lowStockCount = allItems.filter(r => r.tong_ton <= r.goi_y_dat && r.muc_do_sd === 'Hay sử dụng').length;
  const open = gIdx === 0;
  const cols = columns();

  return `<div class="group-card" data-grp="${esc(grp)}">
    <button class="group-header" data-toggle type="button" aria-expanded="${open}">
      <svg class="chev text-slate-500 ${open ? '' : '-rotate-90'} transition-transform" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      <div class="flex-1 min-w-0">
        <div class="group-title">${esc(grp)}</div>
        <div class="group-meta">${totalSku} SKU · ${plMap.size} phân loại${lowStockCount ? ` · <span class="text-danger-600 font-medium">${lowStockCount} SKU tồn thấp</span>` : ''}</div>
      </div>
      <div class="hidden md:flex items-center gap-5">
        <div class="group-stat"><div class="group-stat-label">SKU</div><div class="group-stat-value text-slate-700">${totalSku}</div></div>
        <div class="group-stat"><div class="group-stat-label">SL đã đặt</div><div class="group-stat-value text-primary-700">${fmt(totalOrdered)}</div></div>
      </div>
    </button>
    <div class="scroll-top-bar ${open ? '' : 'hidden'}" data-scroll-top>
      <div class="scroll-top-inner"></div>
    </div>
    <div class="group-body ${open ? '' : 'hidden'} border-t border-slate-100" data-scroll-body>
      <table class="dt">
        ${theadHtml(cols)}
        <tbody${open ? '' : ' data-lazy="1"'}>${open ? plBlocksHtml(plMap, grp) : ''}</tbody>
      </table>
    </div>
  </div>`;
}

function plBlocksHtml(plMap, grp) {
  return Array.from(plMap.entries()).map(([pl, items]) => plBlockHtml(pl, items, grp)).join('');
}

// Tạo plId hợp lệ cho CSS class & attribute từ string Unicode
function _plId(grp, pl) {
  return 'pl' + (grp + '|' + pl).split('').map(c => c.charCodeAt(0).toString(36)).join('').slice(0, 40);
}

function plBlockHtml(pl, items, grp) {
  const plId = _plId(grp, pl);
  const cols = columns();
  const ctx = { ...rowContext(), plId, pl, count: items.length };

  const agg = items.reduce((a, r) => {
    a.ton_kho += Number(r.ton_kho || 0);
    a.hang_ktv_bv += Number(r.hang_ktv_bv || 0);
    a.hang_vet_thau += Number(r.hang_vet_thau || 0);
    a.hang_di_duong += Number(r.hang_di_duong || 0);
    a.tong_ton += Number(r.tong_ton || 0);
    a.sl_th_fy24 += Number(r.sl_th_fy24 || 0);
    a.sl_th_fy25 += Number(r.sl_th_fy25 || 0);
    a.sl_th_fy26_ytd += Number(r.sl_th_fy26_ytd || 0);
    a.tb_th += Number(r.tb_th || 0);
    // TB KH ở mức san_pham (mọi mã bravo cùng phân loại chia sẻ 1 giá trị) -> KHÔNG cộng dồn,
    // lấy đúng giá trị đó (max phòng dòng lệch/0) để tổng phân loại không bị nhân số SKU.
    a.tb_kh_3_thang = Math.max(a.tb_kh_3_thang, Number(r.tb_kh_3_thang || 0));
    a.safety_stock += Number(r.safety_stock || 0);
    a.goi_y_dat += Number(r.goi_y_dat || 0);
    a.sl_dat += qtyEffective(r, 'sl_dat');
    a.sl_duyet += qtyEffective(r, 'sl_duyet');
    a.sl_dat_hang += qtyEffective(r, 'sl_dat_hang');
    return a;
  }, { ton_kho: 0, hang_ktv_bv: 0, hang_vet_thau: 0, hang_di_duong: 0, tong_ton: 0, sl_th_fy24: 0, sl_th_fy25: 0, sl_th_fy26_ytd: 0, tb_th: 0, tb_kh_3_thang: 0, safety_stock: 0, goi_y_dat: 0, sl_dat: 0, sl_duyet: 0, sl_dat_hang: 0 });

  const parentRow = `<tr class="pl-parent" data-pl-toggle="${plId}">${cols.map(c => c.agg(agg, ctx)).join('')}</tr>`;
  const childRows = sortItems(items).map(r => productRowHtml(r, plId, cols, ctx)).join('');
  return parentRow + childRows;
}

function productRowHtml(r, plId, cols, ctx) {
  const dirty = state.changes.has(r.ma_bravo);
  return `<tr class="pl-child pl-child-${plId} ${dirty ? 'dirty' : ''}" data-id="${esc(r.ma_bravo)}" data-pl="${plId}">
    ${cols.map(c => c.cell(r, ctx)).join('')}
  </tr>`;
}

// ============ NHẬP LIỆU ============
// 1 listener delegation trên host (thay vì gắn cho từng input — bảng có thể có hàng nghìn ô)
// + tra dòng qua state.rowIndex (Map) thay vì state.rows.find() O(n) mỗi phím gõ.
function bindOrderInputs() {
  const host = $('#orderTableHost');
  host.addEventListener('input', e => {
    const inp = e.target.closest('input[data-id]');
    if (!inp) return;
    const id = inp.dataset.id;
    const field = inp.dataset.field;
    const row = state.rowIndex.get(id);
    if (!row) return;
    const existing = state.changes.get(id) || {};
    existing[field] = inp.type === 'number' ? Number(inp.value || 0) : inp.value;
    // Còn "chỉnh" hay không: xét MỌI field đã đụng vào so với baseline của nó (cột chính so
    // với gợi ý, cột khác/ghi chú so với giá trị đã lưu) — hỗ trợ admin sửa nhiều cột cùng lúc.
    if (isRowUnchanged(row, existing)) state.changes.delete(id);
    else state.changes.set(id, existing);

    const tr = inp.closest('tr');
    tr.classList.toggle('dirty', state.changes.has(id));
    if (inp.type === 'number') {
      // Baseline highlight: cột có điền sẵn so với gợi ý (data-default); còn lại so giá trị đã lưu.
      const usePrefill = inp.dataset.prefill === '1';
      const base = usePrefill ? Number(inp.dataset.default || 0) : (row[field] != null ? Number(row[field]) : 0);
      inp.classList.toggle('dirty', Number(inp.value || 0) !== base);
      const plId = tr.dataset.pl;
      if (plId) updatePLSum(plId, field);
    }
    updateOrderStats();
    updateDraftIndicator();
  });

  // 3.6: Enter/↓ nhảy xuống ô cùng cột dòng dưới (như Excel), ↑ nhảy lên, Esc bỏ focus.
  host.addEventListener('keydown', e => {
    const inp = e.target.closest('input.qty-input[data-field]');
    if (!inp) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); focusAdjacentQtyInput(inp, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAdjacentQtyInput(inp, -1); }
    else if (e.key === 'Escape') { inp.blur(); }
  });
  // Focus vào ô số -> tự select toàn bộ, gõ đè ngay không phải xoá tay.
  host.addEventListener('focusin', e => {
    const inp = e.target.closest('input.qty-input[data-field]');
    if (inp) inp.select();
  });
  // Chặn scroll-wheel đổi giá trị input số ngoài ý muốn khi đang cuộn bảng.
  host.addEventListener('wheel', e => {
    if (e.target.matches('input[type=number]') && document.activeElement === e.target) e.target.blur();
  }, { passive: true });
}

// Nhảy focus tới ô cùng data-field ở dòng kế tiếp/trước đó đang hiển thị (dir: 1 xuống, -1 lên).
function focusAdjacentQtyInput(current, dir) {
  const field = current.dataset.field;
  const all = $$(`#orderTableHost input.qty-input[data-field="${field}"]`).filter(el => el.offsetParent !== null);
  const idx = all.indexOf(current);
  if (idx === -1) return;
  const next = all[idx + dir];
  if (next) { next.focus(); next.select(); }
}

// Dòng có còn chỉnh so với baseline không? So từng field trong `existing`:
//  - ghi chú: so với giá trị đã lưu (row[field]).
//  - cột chính (điền sẵn gợi ý): so với gợi ý mặc định.
//  - cột khác (admin): so với giá trị đã lưu (row[field]).
function isRowUnchanged(row, existing) {
  const action = state.currentAction;
  const primary = action ? action.editField : null;
  const prefill = action ? action.prefill !== false : false;
  for (const key of Object.keys(existing)) {
    if (key.startsWith('ghi_chu')) {
      if ((existing[key] || '') !== (row[key] || '')) return false;
    } else {
      const base = (key === primary && prefill) ? qtyDefault(row, key) : (row[key] != null ? Number(row[key]) : 0);
      if (Number(existing[key] || 0) !== base) return false;
    }
  }
  return true;
}

// Cập nhật ô tổng của phân loại cho MỘT cột (mặc định: cột chính của bước hiện tại).
function updatePLSum(plId, field) {
  field = field || (state.currentAction && state.currentAction.editField);
  if (!field) return;
  let sum = 0;
  $$(`.pl-child-${plId} input[data-field="${field}"]`).forEach(inp => { sum += Number(inp.value || 0); });
  const cell = $(`[data-pl-sum="${field}:${plId}"]`);
  if (cell) cell.textContent = fmt(sum);
}

function bindGroupToggles() {
  $$('.group-card [data-toggle]').forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.group-card');
      const body = card.querySelector('[data-scroll-body]');
      const scrollTop = card.querySelector('[data-scroll-top]');
      const chev = btn.querySelector('.chev');
      const isHidden = body.classList.contains('hidden');
      body.classList.toggle('hidden');
      if (scrollTop) scrollTop.classList.toggle('hidden');
      chev.classList.toggle('-rotate-90', !isHidden);
      btn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
      if (isHidden) {   // vừa mở
        const tbody = body.querySelector('tbody[data-lazy]');
        if (tbody) {   // lần đầu mở nhóm này -> dựng tbody bây giờ (render lười, xem 1.4)
          const plMap = state.orderGroupsCache && state.orderGroupsCache.get(card.dataset.grp);
          if (plMap) tbody.innerHTML = plBlocksHtml(plMap, card.dataset.grp);
          tbody.removeAttribute('data-lazy');
        }
        lockColumnWidths(card);
        syncScrollWidths();
        applyStickyCols(card);
        setupOrderTable();   // dựng lại header nổi cho đúng bề rộng cột vừa đo
      } else {
        invalidateTableMetrics();
      }
    };
  });
}

// 1 listener delegation trên host (không phải bind từng dòng mỗi lần render) — nhóm render
// lười (1.4) dựng tbody sau khi mở vẫn hoạt động đúng vì không cần bind lại.
function bindPLToggles() {
  $('#orderTableHost').addEventListener('click', e => {
    if (e.target.closest('input, button, a, th')) return;
    const row = e.target.closest('[data-pl-toggle]');
    if (!row) return;
    const plId = row.dataset.plToggle;
    const children = $$(`.pl-child-${plId}`);
    const isOpen = children.length && !children[0].classList.contains('hidden');
    children.forEach(c => c.classList.toggle('hidden', isOpen));
    row.classList.toggle('collapsed', isOpen);
    invalidateTableMetrics();
  });
}

// ============ THỐNG KÊ ============
function statCard({ label, value, sub, accent }) {
  const dot = ({ primary: '#1877f2', warning: '#f59e0b', danger: '#fa383e', slate: '#8a8d91' })[accent] || '#8a8d91';
  const txt = ({ primary: '#0c5dc7', warning: '#b45309', danger: '#c81f3d', slate: '#242526' })[accent] || '#242526';
  return `<div class="stat-card">
    <div class="stat-card-label"><span class="stat-dot" style="background:${dot}"></span>${esc(label)}</div>
    <div class="stat-card-value" style="color:${txt}">${value}</div>
    <div class="stat-card-sub">${esc(sub || '')}</div>
  </div>`;
}

function updateOrderStats() {
  // Thống kê theo phần đang HIỂN THỊ (đã áp bộ lọc, gồm "chỉ mã có số lượng").
  const rows = filteredOrderRows();
  const eff = (r, field) => qtyEffective(r, field);
  // Tồn của 1 dòng theo công thức: DA + KG + Đi đường − GU
  const stockOf = r => Number(r.ton_kho || 0) + Number(r.hang_ktv_bv || 0)
    + Number(r.hang_di_duong || 0) - Number(r.hang_vet_thau || 0);

  // Tổng sản phẩm = số phân loại (sản phẩm) khác nhau; SKU cùng sản phẩm gộp 1.
  const totalProducts = new Set(rows.map(r => (r.nhom_hang || '') + '|' + (r.phan_loai || ''))).size;
  const totalSku = rows.length;
  const totalStock = rows.reduce((s, r) => s + stockOf(r), 0);
  const totalReqQty = rows.reduce((s, r) => s + eff(r, 'sl_dat'), 0);
  const totalReqValue = rows.reduce((s, r) => s + eff(r, 'sl_dat') * Number(r.gia || 0), 0);
  const totalOrderValue = rows.reduce((s, r) => s + eff(r, 'sl_dat_hang') * Number(r.gia || 0), 0);
  const lowCount = rows.filter(r => stockOf(r) <= r.goi_y_dat && r.muc_do_sd === 'Hay sử dụng').length;

  const fmtInt = n => fmt(Math.round(Number(n) || 0));

  $('#orderStats').innerHTML = [
    statCard({ label: 'Tổng sản phẩm', value: fmtInt(totalProducts), sub: 'phân loại khác nhau', accent: 'slate' }),
    statCard({ label: 'Tổng SKU', value: fmtInt(totalSku), sub: 'trong danh mục', accent: 'slate' }),
    statCard({ label: 'Tổng tồn', value: fmtInt(totalStock), sub: 'DA + Ký gửi + Đi đường − GU', accent: 'primary' }),
    statCard({ label: 'Tổng SL yêu cầu', value: fmtInt(totalReqQty), sub: 'gồm điền sẵn theo gợi ý', accent: 'primary' }),
    statCard({ label: 'Tổng giá trị yêu cầu', value: fmtVND(totalReqValue), sub: 'SL yêu cầu × đơn giá', accent: 'warning' }),
    statCard({ label: 'Tổng giá trị đặt hàng', value: fmtVND(totalOrderValue), sub: 'SL đặt hàng × đơn giá', accent: 'warning' }),
    statCard({ label: 'SKU tồn thấp', value: fmtInt(lowCount), sub: 'cần đặt thêm', accent: lowCount > 0 ? 'danger' : 'slate' }),
  ].join('');
}

// ============ NHÁP CỤC BỘ (3.2) ============
// Tự lưu nháp state.changes vào localStorage (debounce 1s) — khôi phục được nếu mất mạng/
// token hết hạn giữa chừng. Khoá theo session_id, chỉ 1 đợt gần nhất/trình duyệt.
export function saveDraftLocalNow() {
  const sess = state.currentSession;
  if (sess && state.changes.size > 0) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        sessionId: sess.session_id,
        changes: Array.from(state.changes.entries()),
        savedAt: Date.now(),
      }));
    } catch {}
    return;
  }
  // changes trống (hoặc chưa mở đợt nào) -> chỉ xoá nháp cũ nếu nó ĐÚNG là của đợt đang xem
  // (tránh xoá nhầm nháp của đợt khác khi vừa mở 1 đợt/màn khác mà chưa kịp gõ gì).
  if (!sess) return;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft && draft.sessionId === sess.session_id) localStorage.removeItem(DRAFT_KEY);
  } catch {}
}
const saveDraftLocal = debounce(saveDraftLocalNow, 1000);

// Hỏi khôi phục nếu có nháp khớp đúng đợt đang mở và chưa có thay đổi nào trong phiên hiện tại.
async function tryRestoreDraft() {
  const sess = state.currentSession;
  if (!sess || state.changes.size > 0) return;
  let draft;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { draft = null; }
  if (!draft || draft.sessionId !== sess.session_id || !Array.isArray(draft.changes) || !draft.changes.length) return;
  const ok = await askConfirm({ title: 'Khôi phục thay đổi', message: `Khôi phục ${draft.changes.length} thay đổi chưa gửi từ lần trước?` });
  if (ok) draft.changes.forEach(([k, v]) => state.changes.set(k, v));
  else { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
}

export function updateDraftIndicator() {
  saveDraftLocal();
  const n = state.changes.size;
  const draftActions = $('#draftActions');
  const status = $('#saveStatus');
  const action = state.currentAction;

  if (!action) {
    draftActions.classList.add('hidden');
    draftActions.classList.remove('flex');
    status.textContent = state.currentSession
      ? `Đợt ở trạng thái ${state.currentSession.trang_thai} · không có thao tác cho vai trò của bạn`
      : 'Danh mục · chỉ xem';
    return;
  }

  // Chế độ sửa-ô-đã-chỉnh (admin, AM cập nhật khi SUBMITTED): nút bật khi có ô đã sửa;
  // không điền sẵn hàng loạt, chỉ gửi những gì thay đổi.
  if (action.changesOnly) {
    if (n > 0) {
      draftActions.classList.remove('hidden');
      draftActions.classList.add('flex');
      $('#btnPlaceLabel').textContent = `${action.label} (${n} chỉnh)`;
      status.textContent = '';
      $('#btnPlace').disabled = false;
    } else {
      draftActions.classList.add('hidden');
      draftActions.classList.remove('flex');
      status.textContent = action.hint || 'Sửa ô cần thay đổi rồi bấm lưu';
    }
    return;
  }

  // Số dòng sẽ gửi = số ô số lượng (bước hiện tại) có giá trị > 0 (đã gồm điền sẵn theo gợi ý).
  const fillN = state.rows.reduce((a, r) => a + (qtyEffective(r, action.editField) > 0 ? 1 : 0), 0);

  if (fillN > 0) {
    draftActions.classList.remove('hidden');
    draftActions.classList.add('flex');
    if (n > 0) {
      $('#btnPlaceLabel').textContent = `${action.label} (${fillN} · ${n} chỉnh)`;
      status.textContent = '';
    } else {
      $('#btnPlaceLabel').textContent = `${action.label} theo gợi ý (${fillN})`;
      status.textContent = 'Đã điền sẵn theo gợi ý — chỉnh tay ở ô cần thay đổi rồi bấm xác nhận';
    }
    $('#btnPlace').disabled = false;
  } else {
    draftActions.classList.add('hidden');
    draftActions.classList.remove('flex');
    status.textContent = `Sẵn sàng — bấm "${action.label}" sau khi nhập`;
  }
}

// ============ GỬI ĐẶT HÀNG ============
async function placeOrder() {
  const action = state.currentAction;
  if (!action) return;
  const items = [];
  if (action.changesOnly) {
    // Chỉ gửi các dòng CÓ chỉnh (trong state.changes), mỗi dòng gồm đúng các field vừa sửa
    // — không đụng dòng/cột khác, không điền sẵn hàng loạt (admin & AM cập nhật SUBMITTED).
    const noteOf = {};
    (state.editFields || []).forEach(f => { if (f.noteField) noteOf[f.field] = f.noteField; });
    for (const [id, ch] of state.changes) {
      const r = state.rowIndex.get(id);
      if (!r || r.editable === false) continue;
      const item = { ma_bravo: id };
      let has = false;
      (state.editFields || []).forEach(f => {
        if (ch[f.field] !== undefined) { item[f.field] = Number(ch[f.field] || 0); has = true; }
        const nf = noteOf[f.field];
        if (nf && ch[nf] !== undefined) { item[nf] = ch[nf]; has = true; }
      });
      if (has) items.push(item);
    }
  } else {
    // Gom từ state (không phải DOM): mọi dòng có SL hiệu lực > 0 (đã gồm giá trị điền sẵn
    // theo gợi ý, không chỉ các dòng chỉnh tay) — không phụ thuộc dòng có đang render hay
    // không (bộ lọc ẩn dòng, nhóm đang đóng…), tránh sót thay đổi khi dòng không có trong DOM.
    state.rows.forEach(r => {
      if (r.editable === false) return; // ngoài scope -> không render input, không gửi
      const qty = qtyEffective(r, action.editField);
      if (qty <= 0) return;
      const item = { ma_bravo: r.ma_bravo };
      item[action.editField] = qty;
      item[action.editNoteField] = noteEffective(r, action.editNoteField);
      items.push(item);
    });
  }
  if (!items.length) return;
  const keepId = state.currentSession && state.currentSession.session_id;
  $('#btnPlace').disabled = true;
  $('#btnPlaceLabel').textContent = 'Đang lưu…';
  try {
    const res = await rpc(action.endpoint, keepId, items);
    toast(`Đã ${action.label.toLowerCase()}: +${res.created} ~${res.updated} -${res.deleted}. Trạng thái → ${res.newStatus}`);
    state.changes.clear();
    saveDraftLocalNow();
    await loadSessions();
    await loadOrderData(keepId);   // ở lại đúng đợt vừa xác nhận, không nhảy sang đợt khác
  } catch (e) {
    toast(e.message, 'error');
    $('#btnPlace').disabled = false;
    updateDraftIndicator();
  }
}

export function bindGlobalDraftActions() {
  $('#btnPlace').onclick = placeOrder;
  $('#btnReset').onclick = async () => {
    if (state.changes.size === 0) return;
    if (!(await askConfirm({ title: 'Huỷ thay đổi', message: 'Huỷ toàn bộ thay đổi chưa lưu?', danger: true, okLabel: 'Huỷ thay đổi' }))) return;
    state.changes.clear();
    saveDraftLocalNow();
    renderOrderBody();
    updateOrderStats();
    updateDraftIndicator();
  };
}

// ============ MODAL TẠO ĐỢT ============
// Nạp danh sách nhóm sản phẩm thành checkbox (chọn nhiều). Lỗi -> báo nhẹ, vẫn tạo được đợt
// "tất cả nhóm" (không tick gì).
async function populateSessionGroupOptions() {
  const box = $('#modalSessNhomList');
  if (!box) return;
  box.innerHTML = '<div class="px-2 py-1.5 text-slate-400">Đang tải…</div>';
  try {
    const groups = await rpc('listProductGroups');
    const list = Array.isArray(groups) ? groups : [];
    box.innerHTML = list.length
      ? list.map(g => `
        <label class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
          <input type="checkbox" class="rounded msn-opt shrink-0" value="${esc(g)}"/>
          <span class="truncate">${esc(g)}</span>
        </label>`).join('')
      : '<div class="px-2 py-1.5 text-slate-400">Không có nhóm sản phẩm</div>';
  } catch (e) {
    console.warn('[populateSessionGroupOptions]', e);
    box.innerHTML = '<div class="px-2 py-1.5 text-danger-600">Không tải được danh sách nhóm — có thể tạo đợt cho tất cả nhóm</div>';
  }
}

function openCreateSessionModal() {
  const modal = $('#modalCreateSession');
  modal.classList.remove('hidden');
  $('#modalSessName').value = '';
  $('#modalSessClose').value = '';
  $('#modalErr').textContent = '';
  populateSessionGroupOptions();

  // Hiển thị thông báo phù hợp role
  const role = state.user.role;
  const noteEl = $('#modalNote');
  if (noteEl) {
    noteEl.innerHTML = role === 'AM'
      ? `Đợt sẽ được tạo riêng cho miền <strong>${state.user.mien}</strong> (miền của bạn).`
      : `Đợt sẽ được tạo cho <strong>cả miền Bắc và miền Nam</strong> với cùng tên. Sale manager mỗi miền có thể bắt đầu nhập đặt hàng ngay.`;
  }
  setTimeout(() => $('#modalSessName').focus(), 50);

  const release = trapModal(modal, () => close());
  const close = () => { modal.classList.add('hidden'); release(); };
  $('#modalClose').onclick = close;
  $('#modalCancel').onclick = close;

  $('#modalSubmit').onclick = async () => {
    const name = $('#modalSessName').value.trim();
    if (!name) { $('#modalErr').textContent = 'Vui lòng nhập tên đợt'; return; }
    const ngayDong = $('#modalSessClose').value;
    const btn = $('#modalSubmit');
    btn.disabled = true; btn.textContent = 'Đang tạo…';
    try {
      let toastMsg;
      const nhom = $$('#modalSessNhomList .msn-opt').filter(x => x.checked).map(x => x.value);
      const nhomLabel = nhom.length ? ` · nhóm ${nhom.join(', ')}` : '';
      if (role === 'AM') {
        const s = await rpc('createSession', name, state.user.mien, ngayDong || '', nhom);
        // Mở thẳng đợt vừa tạo (không còn auto-pick ở backend).
        state.pinnedSessionId = (s && s.session_id) || null;
        toastMsg = `Đã tạo đợt "${name}" cho miền ${state.user.mien}${nhomLabel}`;
      } else {
        const r = await rpc('createSessionBoth', name, ngayDong || '', nhom);
        toastMsg = `Đã tạo đợt "${name}" cho cả 2 miền${nhomLabel}`;
        // Hiển thị + mở đợt mới tạo của 1 miền cụ thể (ALL không xem chi tiết đợt được).
        const targetMien = state.mien === 'MN' ? 'MN' : 'MB';
        const created = targetMien === 'MN' ? (r && r.mn) : (r && r.mb);
        state.mien = targetMien;
        state.pinnedSessionId = (created && created.session_id) || null;
        $$('.mien-btn').forEach(x => x.classList.toggle('active', x.dataset.mien === targetMien));
      }
      toast(toastMsg);
      close();
      await loadSessions();
      renderView();
    } catch (e) {
      $('#modalErr').textContent = e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Tạo đợt';
    }
  };
}
