// ============ MÀN CẤU HÌNH DANH MỤC (Admin + PM) ============
import { $, $$, esc, fmt, debounce, viCmp } from '../utils.js';
import { rpc, rpcOpts } from '../api.js';
import { state, canEditCatalog } from '../state.js';
import { toast } from '../toast.js';
import { askConfirm } from '../modal.js';

const CAT_RENDER_CAP = 600;
const MUC_DO_OPTS = ['', 'Hay sử dụng', 'Ít sử dụng', 'Hiếm khi sử dụng'];

let _catalogFilterBound = false;

function bindCatalogFilterOnce() {
  if (_catalogFilterBound) return;
  _catalogFilterBound = true;
  $('#catSearch').addEventListener('input', debounce(e => { state.catFilter.search = e.target.value.toLowerCase(); renderCatalogBody(); }, 200));
  // BU -> giới hạn danh sách nhóm SP; nhóm đã chọn nhưng không thuộc BU mới bị bỏ.
  $('#catBU').addEventListener('change', e => {
    state.catFilter.bu = e.target.value;
    const allowed = new Set(groupsForBU(state.catFilter.bu));
    state.catFilter.grps = new Set([...state.catFilter.grps].filter(g => allowed.has(g)));
    renderGroupMenu();
    renderCatalogBody();
  });
  const btn = $('#catGrpBtn');
  const menu = $('#catGrpMenu');
  btn.addEventListener('click', () => {
    const open = menu.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', e => {
    if (!menu.classList.contains('hidden') && !e.target.closest('#catGrpWrap')) {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  menu.addEventListener('change', e => {
    const cb = e.target.closest('input.cat-grp-cb');
    if (!cb) return;
    if (cb.checked) state.catFilter.grps.add(cb.value);
    else state.catFilter.grps.delete(cb.value);
    updateGroupLabel();
    renderCatalogBody();
  });
  menu.addEventListener('click', e => {
    const act = e.target.closest('[data-cat-grp-act]');
    if (!act) return;
    const groups = groupsForBU(state.catFilter.bu);
    state.catFilter.grps = act.dataset.catGrpAct === 'all' ? new Set(groups) : new Set();
    renderGroupMenu();
    renderCatalogBody();
  });
  $('#catOnlySel').addEventListener('change', e => { state.catFilter.onlySelected = e.target.checked; renderCatalogBody(); });
  $('#catSelectAll').addEventListener('click', () => bulkSelectCatalog(true));
  $('#catUnselectAll').addEventListener('click', () => bulkSelectCatalog(false));
  $('#catSave').addEventListener('click', saveCatalog);
}

export async function initCatalogView() {
  if (!canEditCatalog()) {
    $('#main').innerHTML = '<div class="empty-state">Chỉ Admin / Manager / PM mới truy cập được tab này</div>';
    return;
  }
  state.catalog = [];
  state.catalogDirty = new Map();
  state.catFilter = { search: '', bu: '', grps: new Set(), onlySelected: false };
  const searchEl = $('#catSearch'); if (searchEl) searchEl.value = '';
  const onlyEl = $('#catOnlySel'); if (onlyEl) onlyEl.checked = false;

  bindCatalogFilterOnce();
  bindCatalogInputs();

  await loadCatalog();
}

async function loadCatalog() {
  const host = $('#catalogHost');
  host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 p-4" aria-busy="true">
    ${'<div class="skeleton-line"></div>'.repeat(8)}</div>`;
  try {
    const list = await rpc('listCatalog');
    state.catalog = Array.isArray(list) ? list : [];
    state.catalogIndex = new Map(state.catalog.map(r => [r.ma_bravo, r]));
    renderBUOptions();
    renderGroupMenu();
    renderCatalogBody();
  } catch (e) {
    // 3.10: nút Thử lại gọi lại đúng loader
    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state text-danger-600">
      <div class="mb-3">Lỗi tải danh mục: ${esc(e.message)}</div>
      <button id="catRetry" class="ctl-btn" type="button">Thử lại</button>
    </div>`;
    const retry = $('#catRetry');
    if (retry) retry.onclick = () => loadCatalog();
  }
}

const NO_BU = '__none__';

function rowBU(r) { return r.bu_code || NO_BU; }

function renderBUOptions() {
  const sel = $('#catBU');
  const map = new Map();
  state.catalog.forEach(r => { if (r.bu_code && !map.has(r.bu_code)) map.set(r.bu_code, r.bu || r.bu_code); });
  const hasNoBU = state.catalog.some(r => !r.bu_code);
  const opts = [...map.entries()].sort((a, b) => viCmp(a[1], b[1]));
  sel.innerHTML = '<option value="">Tất cả BU</option>'
    + opts.map(([code, label]) => `<option value="${esc(code)}">${esc(label)}</option>`).join('')
    + (hasNoBU && opts.length ? `<option value="${NO_BU}">(Chưa gán BU)</option>` : '');
  sel.value = state.catFilter.bu;
  // Không có dữ liệu BU (vd. backend chưa deploy) -> ẩn filter BU.
  sel.classList.toggle('hidden', opts.length === 0);
}

function groupsForBU(bu) {
  const set = new Set();
  state.catalog.forEach(r => {
    if (!r.nhom_san_pham) return;
    if (bu && rowBU(r) !== bu) return;
    set.add(r.nhom_san_pham);
  });
  return [...set].sort(viCmp);
}

function renderGroupMenu() {
  const menu = $('#catGrpMenu');
  const groups = groupsForBU(state.catFilter.bu);
  const f = state.catFilter;
  menu.innerHTML = groups.length
    ? `<div class="flex items-center justify-between px-2 py-1 border-b border-slate-100 mb-1 text-[12px]">
        <button type="button" class="text-primary-600 hover:underline" data-cat-grp-act="all">Chọn tất cả</button>
        <button type="button" class="text-slate-500 hover:underline" data-cat-grp-act="none">Bỏ chọn</button>
      </div>` + groups.map(g => `<label class="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded cursor-pointer text-[13px]">
        <input type="checkbox" class="cat-grp-cb rounded" value="${esc(g)}" ${f.grps.has(g) ? 'checked' : ''}/>${esc(g)}</label>`).join('')
    : '<div class="px-2 py-1.5 text-[12px] text-slate-500">Không có nhóm sản phẩm</div>';
  updateGroupLabel();
}

function updateGroupLabel() {
  const label = $('#catGrpLabel');
  const g = state.catFilter.grps;
  if (g.size === 0) label.textContent = 'Tất cả nhóm sản phẩm';
  else if (g.size === 1) label.textContent = [...g][0];
  else label.textContent = g.size + ' nhóm sản phẩm';
  $('#catGrpBtn').title = [...g].join(', ');
}

function catEffective(r) {
  const d = state.catalogDirty.get(r.ma_bravo) || {};
  return {
    dat_hang: d.dat_hang !== undefined ? d.dat_hang : r.dat_hang,
    muc_do_sd: d.muc_do_sd !== undefined ? d.muc_do_sd : r.muc_do_sd,
    safety_stock: d.safety_stock !== undefined ? d.safety_stock : (r.safety_stock ?? 0),
  };
}

function filteredCatalog() {
  const f = state.catFilter;
  return state.catalog.filter(r => {
    if (f.bu && rowBU(r) !== f.bu) return false;
    if (f.grps.size && !f.grps.has(r.nhom_san_pham)) return false;
    if (f.onlySelected && !catEffective(r).dat_hang) return false;
    if (f.search) {
      const hay = ((r.ma_bravo || '') + ' ' + (r.code_ncc || '') + ' ' + (r.ten_hang || '')).toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  });
}

function markCatDirty(ma, field, value) {
  const r = state.catalogIndex.get(ma);
  if (!r) return;
  const cur = state.catalogDirty.get(ma) || {};
  cur[field] = value;
  const effDat = cur.dat_hang !== undefined ? cur.dat_hang : r.dat_hang;
  const effMuc = cur.muc_do_sd !== undefined ? cur.muc_do_sd : r.muc_do_sd;
  const effSafety = cur.safety_stock !== undefined ? cur.safety_stock : (r.safety_stock ?? 0);
  if (effDat === r.dat_hang && effMuc === r.muc_do_sd && effSafety === (r.safety_stock ?? 0)) state.catalogDirty.delete(ma);
  else state.catalogDirty.set(ma, cur);
}

function updateCatHeader() {
  const selectedTotal = state.catalog.filter(r => catEffective(r).dat_hang).length;
  $('#catCounter').textContent = `Đã chọn ${fmt(selectedTotal)} / ${fmt(state.catalog.length)} · đang lọc ${fmt(filteredCatalog().length)}`;
  const btn = $('#catSave');
  btn.disabled = state.catalogDirty.size === 0;
  btn.textContent = state.catalogDirty.size ? `Lưu thay đổi (${state.catalogDirty.size})` : 'Lưu thay đổi';
}

function catRowHtml(r) {
  const eff = catEffective(r);
  const dirty = state.catalogDirty.has(r.ma_bravo);
  return `<tr class="${dirty ? 'dirty' : ''}" data-cat="${esc(r.ma_bravo)}">
    <td class="c"><input type="checkbox" data-cat-chk="${esc(r.ma_bravo)}" ${eff.dat_hang ? 'checked' : ''} aria-label="Đặt hàng — ${esc(r.ma_bravo)}"/></td>
    <td class="text-slate-600 text-[12px]">${esc(r.nhom_san_pham || '—')}</td>
    <td class="font-mono text-[11px] text-slate-700 nowrap">${esc(r.ma_bravo)}</td>
    <td class="font-mono text-[11px] text-slate-500 nowrap">${esc(r.code_ncc || '—')}</td>
    <td class="text-slate-800">${esc(r.ten_hang || '')}</td>
    <td class="text-slate-600 text-[12px] hidden lg:table-cell">${esc(r.phan_loai_1 || '—')}</td>
    <td class="text-slate-600 text-[12px] hidden lg:table-cell">${esc(r.phan_loai_2 || '—')}</td>
    <td class="r num text-slate-600 hidden md:table-cell">${fmt(r.gia)}</td>
    <td class="c"><select class="ctl-select" data-cat-muc="${esc(r.ma_bravo)}" style="width:100%" aria-label="Mức độ sử dụng — ${esc(r.ma_bravo)}">
      ${MUC_DO_OPTS.map(o => `<option value="${esc(o)}" ${eff.muc_do_sd === o ? 'selected' : ''}>${o || '—'}</option>`).join('')}
    </select></td>
    <td class="c"><input type="number" class="qty-input" min="0" step="1" value="${eff.safety_stock ?? 0}" data-cat-safety="${esc(r.ma_bravo)}" style="width:100%" aria-label="Safety stock — ${esc(r.ma_bravo)}"/></td>
  </tr>`;
}

function renderCatalogBody() {
  const host = $('#catalogHost');
  const all = filteredCatalog();
  updateCatHeader();
  if (!all.length) {
    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state">Không có vật tư phù hợp bộ lọc</div>`;
    return;
  }
  const rows = all.slice(0, CAT_RENDER_CAP);
  const capNote = all.length > CAT_RENDER_CAP
    ? `<div class="px-4 py-2 text-[12px] text-warning-700 bg-warning-50 border-b border-warning-100">Hiển thị ${CAT_RENDER_CAP}/${fmt(all.length)} dòng — lọc bớt để xem hết. ("Chọn tất cả đang lọc" vẫn áp cho toàn bộ ${fmt(all.length)} dòng.)</div>`
    : '';

  const bySP = new Map();
  rows.forEach(r => {
    const sp = r.san_pham || '(không có sản phẩm)';
    if (!bySP.has(sp)) bySP.set(sp, []);
    bySP.get(sp).push(r);
  });
  const noSP = '(không có sản phẩm)';
  const sortedSP = Array.from(bySP.entries()).sort((a, b) => {
    if (a[0] === noSP) return 1;
    if (b[0] === noSP) return -1;
    return viCmp(a[0], b[0]);
  });

  const theadHtml = `<thead><tr>
    <th class="c" style="width:64px">Đặt hàng</th>
    <th style="width:130px">Nhóm SP</th>
    <th style="width:130px">Mã Bravo</th>
    <th style="width:120px">Mã NCC</th>
    <th style="min-width:240px">Tên vật tư</th>
    <th class="hidden lg:table-cell" style="width:130px">Phân loại 1</th>
    <th class="hidden lg:table-cell" style="width:130px">Phân loại 2</th>
    <th class="r hidden md:table-cell" style="width:110px">Đơn giá thầu</th>
    <th class="c" style="width:150px">Mức độ SD</th>
    <th class="c" style="width:120px">Safety stock</th>
  </tr></thead>`;

  const bodyHtml = sortedSP.map(([sp, items]) => {
    const selected = items.filter(r => catEffective(r).dat_hang).length;
    return `<tr class="pl-parent" data-cat-sp-toggle="${esc(sp)}">
      <td colspan="10" style="cursor:pointer">
        <div class="flex items-center gap-2">
          <svg class="cat-chev text-slate-500 -rotate-90 transition-transform" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          <span class="font-semibold text-[13px] text-slate-800">${esc(sp)}</span>
          <span class="text-[11px] text-slate-500">Đã chọn ${selected}/${items.length} SKU</span>
        </div>
      </td>
    </tr>` + items.map(r => `<tr class="cat-child cat-child-hidden ${state.catalogDirty.has(r.ma_bravo) ? 'dirty' : ''}" data-cat="${esc(r.ma_bravo)}" data-cat-sp="${esc(sp)}" style="display:none">${catRowHtml(r).replace(/^<tr[^>]*>/, '').replace(/<\/tr>$/, '')}</tr>`).join('');
  }).join('');

  host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 overflow-auto scroll-area" style="max-height:calc(100vh - 220px)">
    ${capNote}
    <table class="dt">
      ${theadHtml}
      <tbody>${bodyHtml}</tbody>
    </table>
  </div>`;

  bindCatGroupToggles();
}

function bindCatGroupToggles() {
  $$('[data-cat-sp-toggle]', $('#catalogHost')).forEach(row => {
    row.addEventListener('click', () => {
      const sp = row.dataset.catSpToggle;
      const children = $$(`[data-cat-sp="${CSS.escape(sp)}"]`, $('#catalogHost'));
      const open = children[0] && children[0].style.display !== 'none';
      children.forEach(c => c.style.display = open ? 'none' : '');
      const chev = row.querySelector('.cat-chev');
      if (chev) chev.classList.toggle('-rotate-90', open);
    });
  });
}

function bindCatalogInputs() {
  const host = $('#catalogHost');
  host.addEventListener('change', e => {
    const chk = e.target.closest('input[data-cat-chk]');
    if (chk) {
      const ma = chk.dataset.catChk;
      markCatDirty(ma, 'dat_hang', chk.checked);
      chk.closest('tr').classList.toggle('dirty', state.catalogDirty.has(ma));
      updateCatHeader();
      return;
    }
    const sel = e.target.closest('select[data-cat-muc]');
    if (sel) {
      const ma = sel.dataset.catMuc;
      markCatDirty(ma, 'muc_do_sd', sel.value);
      sel.closest('tr').classList.toggle('dirty', state.catalogDirty.has(ma));
      updateCatHeader();
    }
  });
  host.addEventListener('input', e => {
    const inp = e.target.closest('input[data-cat-safety]');
    if (!inp) return;
    const ma = inp.dataset.catSafety;
    let v = Math.floor(Number(inp.value));
    if (!Number.isFinite(v) || v < 0) v = 0;
    markCatDirty(ma, 'safety_stock', v);
    inp.closest('tr').classList.toggle('dirty', state.catalogDirty.has(ma));
    updateCatHeader();
  });
  // Chặn scroll-wheel đổi giá trị ngoài ý muốn (giống màn đặt hàng, xem 3.6).
  host.addEventListener('wheel', e => {
    if (e.target.matches('input[type=number]') && document.activeElement === e.target) e.target.blur();
  }, { passive: true });
}

async function bulkSelectCatalog(value) {
  const all = filteredCatalog();
  if (!all.length) return;
  if (!(await askConfirm({ title: value ? 'Chọn tất cả' : 'Bỏ chọn tất cả', message: `${value ? 'Chọn' : 'Bỏ chọn'} ${all.length} vật tư đang lọc?` }))) return;
  all.forEach(r => markCatDirty(r.ma_bravo, 'dat_hang', value));
  renderCatalogBody();
}

async function saveCatalog() {
  if (state.catalogDirty.size === 0) return;
  const changes = Array.from(state.catalogDirty.entries()).map(([ma_bravo, v]) => ({ ma_bravo, ...v }));
  const btn = $('#catSave');
  btn.disabled = true; btn.textContent = 'Đang lưu…';
  try {
    const res = await rpcOpts({ timeoutMs: 60000 }, 'saveCatalog', changes);
    toast(`Đã lưu ${res.updated} vật tư vào danh mục đặt hàng`);
    changes.forEach(c => {
      const r = state.catalogIndex.get(c.ma_bravo);
      if (r) {
        if (c.dat_hang !== undefined) r.dat_hang = c.dat_hang;
        if (c.muc_do_sd !== undefined) r.muc_do_sd = c.muc_do_sd;
        if (c.safety_stock !== undefined) r.safety_stock = c.safety_stock;
      }
    });
    state.catalogDirty.clear();
    renderCatalogBody();
  } catch (e) {
    toast(e.message, 'error');
    updateCatHeader();
  }
}
