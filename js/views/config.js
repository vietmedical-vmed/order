// ============ MÀN CẤU HÌNH (chỉ Admin) ============
// 3 tab con: Công thức gợi ý | Email thông báo | Dữ liệu & chỉ số.
// Tab Công thức và tab Email có thanh lưu dính đáy, chỉ hiện khi có thay đổi chưa lưu.
// Các tab chỉ ẩn/hiện (không dựng lại DOM) nên chuyển tab không mất phần đang sửa.
import { $, $$, esc, fmtDate } from '../utils.js';
import { rpc, rpcOpts } from '../api.js';
import { state, roleLabel } from '../state.js';
import { toast } from '../toast.js';

const TABS = ['formula', 'email', 'data'];
const TAB_KEY = 'order.cfgTab';
const DEFAULT_IDS = ['cfgK1', 'cfgK2', 'cfgLeadtime', 'cfgSoThangDat'];

export async function initConfigView() {
  if (state.user.role !== 'ADMIN') {
    $('#main').innerHTML = '<div class="empty-state">Chỉ Admin mới truy cập được tab này</div>';
    return;
  }
  bindTabs();
  bindFormula();
  bindEmail();
  bindLogPanel();
  $('#indRefresh').addEventListener('click', refreshIndicators);

  loadFormula();
  renderConfigLog();
  renderUserEmails();
  renderIndicatorsInfo();
}

// ============ TAB CON ============
function bindTabs() {
  const tabs = $$('.cfg-tab');
  tabs.forEach(b => b.addEventListener('click', () => showTab(b.dataset.cfgTab)));
  // ←/→ chuyển tab khi đang focus thanh tab
  tabs.forEach((b, i) => b.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.cfgTab);
    next.focus();
  }));
  let saved = '';
  try { saved = localStorage.getItem(TAB_KEY) || ''; } catch (e) {}
  showTab(TABS.includes(saved) ? saved : 'formula');
}

function showTab(name) {
  $$('.cfg-tab').forEach(b => {
    const on = b.dataset.cfgTab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  $$('.cfg-pane').forEach(p => p.classList.toggle('hidden', p.dataset.cfgPane !== name));
  try { localStorage.setItem(TAB_KEY, name); } catch (e) {}
}

// Chấm vàng trên tên tab con khi tab đó có thay đổi chưa lưu.
function markTabDirty(name, dirty) {
  const b = $(`.cfg-tab[data-cfg-tab="${name}"]`);
  if (!b) return;
  const dot = $('.cfg-dot', b);
  if (dirty && !dot) b.insertAdjacentHTML('beforeend', '<span class="cfg-dot" aria-label="có thay đổi chưa lưu"></span>');
  if (!dirty && dot) dot.remove();
}

// So giá trị ô với giá trị đã lưu (data-orig): tô vàng ô đã sửa, trả số ô đã sửa.
function countChanged(inputs) {
  let n = 0;
  inputs.forEach(i => {
    const changed = i.value.trim() !== (i.dataset.orig || '');
    i.classList.toggle('cfg-changed', changed);
    if (changed) n++;
  });
  return n;
}

const setOrig = inputs => inputs.forEach(i => { i.dataset.orig = i.value.trim(); });
const restoreOrig = inputs => inputs.forEach(i => { i.value = i.dataset.orig || ''; });

function setMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = 'text-[12px] ' + (kind === 'err' ? 'text-danger-600' : kind === 'ok' ? 'text-primary-600' : 'text-slate-600');
}

// ============ TAB 1: CÔNG THỨC GỢI Ý ============
const formulaInputs = () => DEFAULT_IDS.map(id => $('#' + id)).concat($$('#cfgGroupBody .cfg-grp-input'));

async function loadFormula() {
  try {
    const cfg = await rpc('getConfig');
    $('#cfgK1').value = cfg.k1;
    $('#cfgK2').value = cfg.k2;
    $('#cfgLeadtime').value = cfg.leadtime_thang_default;
    $('#cfgSoThangDat').value = cfg.so_thang_dat_default;
    renderCfgGroups(cfg.groups_list || [], cfg.groups || {});
    setOrig(formulaInputs());
    updateCfgSumNote();
    updateFormulaDirty();
  } catch (e) {
    setMsg($('#cfgMsg'), 'Lỗi tải cấu hình: ' + e.message, 'err');
  }
}

function bindFormula() {
  const pane = $('#cfgPaneFormula');
  pane.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'cfgGrpSearch') { applyGroupFilter(); return; }
    if (t.type !== 'number') return;
    if (DEFAULT_IDS.includes(t.id)) {
      updateCfgSumNote();
      updateCfgGroupPlaceholders();
    } else {
      markGroupRow(t.closest('tr'));
    }
    updateFormulaDirty();
  });
  $('#cfgGrpOnlySet').addEventListener('change', applyGroupFilter);

  $('#cfgReset').addEventListener('click', () => {
    $('#cfgK1').value = 0.8; $('#cfgK2').value = 0.2;
    $('#cfgLeadtime').value = 3; $('#cfgSoThangDat').value = 3;
    updateCfgSumNote();
    updateCfgGroupPlaceholders();
    updateFormulaDirty();
  });

  $('#cfgUndo').addEventListener('click', () => {
    restoreOrig(formulaInputs());
    $$('#cfgGroupBody tr[data-cfg-grp]').forEach(markGroupRow);
    updateCfgSumNote();
    updateCfgGroupPlaceholders();
    updateFormulaDirty();
    applyGroupFilter();
  });

  $('#cfgSave').addEventListener('click', saveFormula);
}

async function saveFormula() {
  const cfg = {
    k1: parseFloat($('#cfgK1').value),   // TB tháng TH
    k2: parseFloat($('#cfgK2').value),   // TB KH 3 tháng
    leadtime_thang_default: parseFloat($('#cfgLeadtime').value),
    so_thang_dat_default: parseFloat($('#cfgSoThangDat').value),
    groups: collectCfgGroups(),
  };
  if (isNaN(cfg.k1) || isNaN(cfg.k2)) {
    setMsg($('#cfgMsg'), 'k1/k2 phải là số', 'err');
    return;
  }
  const btn = $('#cfgSave');
  btn.disabled = true;
  try {
    await rpc('saveConfig', cfg);
    setOrig(formulaInputs());
    updateFormulaDirty();
    applyGroupFilter();
    setMsg($('#cfgMsg'), '✓ Đã lưu lúc ' + new Date().toLocaleTimeString('vi-VN'), 'ok');
    toast('Đã lưu cấu hình. Cột Gợi ý sẽ cập nhật khi mở tab Chi tiết.');
    renderConfigLog();
  } catch (e) {
    setMsg($('#cfgMsg'), 'Lỗi: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function updateFormulaDirty() {
  const n = countChanged(formulaInputs());
  $('#cfgDirtyCount').textContent = n;
  $('#cfgSaveBar').classList.toggle('hidden', n === 0);
  markTabDirty('formula', n > 0);
}

// Bảng cấu hình riêng theo nhóm sản phẩm — ô trống = dùng mặc định (hiển thị ở placeholder).
function renderCfgGroups(list, groups) {
  const body = $('#cfgGroupBody');
  if (!body) return;
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-slate-500 text-center py-3 text-[12px]">Chưa có nhóm sản phẩm nào — tích chọn vật tư ở tab "Cấu hình danh mục" trước.</td></tr>`;
    updateGroupCount();
    return;
  }
  const cell = (g, k, step, min, max, label) => {
    const gc = groups[g] || {};
    const v = (gc[k] === undefined || gc[k] === null) ? '' : gc[k];
    return `<td class="c"><input type="number" class="cfg-grp-input px-2 py-1 border border-slate-200 rounded text-[12px] w-full outline-none focus:border-primary-500"
      data-k="${k}" step="${step}" min="${min}" max="${max}" value="${v}" aria-label="${esc(label)} — ${esc(g)}"/></td>`;
  };
  body.innerHTML = list.map(g => `<tr data-cfg-grp="${esc(g)}">
    <td class="text-slate-700 text-[12px]"><span class="cfg-grp-name">${esc(g)}</span></td>
    ${cell(g, 'k1', '0.05', '0', '2', 'k1 (TB TH)')}
    ${cell(g, 'k2', '0.05', '0', '2', 'k2 (TB KH)')}
    ${cell(g, 'leadtime_thang', '1', '0', '12', 'Leadtime')}
    ${cell(g, 'so_thang_dat', '1', '1', '12', 'Số tháng đặt')}
  </tr>`).join('');
  $$('tr[data-cfg-grp]', body).forEach(markGroupRow);
  updateCfgGroupPlaceholders();
  applyGroupFilter();
}

const rowHasOverride = tr => $$('.cfg-grp-input', tr).some(i => i.value.trim() !== '');

// Gắn nhãn "Riêng" cho nhóm có ít nhất 1 ô khác mặc định.
function markGroupRow(tr) {
  if (!tr) return;
  const on = rowHasOverride(tr);
  const tag = $('.cfg-grp-tag', tr);
  if (on && !tag) $('td', tr).insertAdjacentHTML('beforeend', ' <span class="cfg-grp-tag pill pill-info ml-1">Riêng</span>');
  if (!on && tag) tag.remove();
  updateGroupCount();
}

function applyGroupFilter() {
  const q = ($('#cfgGrpSearch').value || '').trim().toLowerCase();
  const onlySet = $('#cfgGrpOnlySet').checked;
  $$('#cfgGroupBody tr[data-cfg-grp]').forEach(tr => {
    const show = (!q || tr.dataset.cfgGrp.toLowerCase().includes(q)) && (!onlySet || rowHasOverride(tr));
    tr.classList.toggle('hidden', !show);
  });
  updateGroupCount();
}

function updateGroupCount() {
  const el = $('#cfgGrpCount');
  if (!el) return;
  const rows = $$('#cfgGroupBody tr[data-cfg-grp]');
  const shown = rows.filter(tr => !tr.classList.contains('hidden')).length;
  const set = rows.filter(rowHasOverride).length;
  el.textContent = rows.length ? `${shown}/${rows.length} nhóm · ${set} cấu hình riêng` : '';
}

function updateCfgGroupPlaceholders() {
  const ph = { k1: $('#cfgK1').value, k2: $('#cfgK2').value, leadtime_thang: $('#cfgLeadtime').value, so_thang_dat: $('#cfgSoThangDat').value };
  $$('#cfgGroupBody .cfg-grp-input').forEach(inp => {
    inp.placeholder = ph[inp.dataset.k] !== '' ? ph[inp.dataset.k] : '—';
  });
}

function collectCfgGroups() {
  const out = {};
  $$('#cfgGroupBody tr[data-cfg-grp]').forEach(tr => {
    const g = tr.dataset.cfgGrp;
    const entry = {};
    tr.querySelectorAll('.cfg-grp-input').forEach(inp => {
      const val = inp.value.trim();
      if (val === '') return;
      const n = parseFloat(val);
      if (!isNaN(n)) entry[inp.dataset.k] = n;
    });
    if (Object.keys(entry).length) out[g] = entry;
  });
  return out;
}

function updateCfgSumNote() {
  const sum = (parseFloat($('#cfgK1').value) || 0) + (parseFloat($('#cfgK2').value) || 0);
  const note = $('#cfgSumNote');
  if (!note) return;
  note.innerHTML = Math.abs(sum - 1) < 0.001
    ? `<span class="text-primary-600">Tổng k1+k2 = ${sum.toFixed(2)} ✓</span>`
    : `<span class="text-warning-700">Tổng k1+k2 = ${sum.toFixed(2)} (khuyến nghị = 1.00)</span>`;
}

// ============ PANEL LỊCH SỬ CẤU HÌNH ============
function bindLogPanel() {
  const panel = $('#cfgLogPanel');
  const open = () => {
    panel.classList.remove('hidden');
    const close = $('button[data-close-log]', panel);
    if (close) close.focus();
  };
  const close = () => { panel.classList.add('hidden'); $('#cfgLogOpen').focus(); };
  $('#cfgLogOpen').addEventListener('click', open);
  panel.addEventListener('click', e => { if (e.target.closest('[data-close-log]')) close(); });
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

// Lịch sử phiên bản cấu hình công thức (mới nhất trước).
async function renderConfigLog() {
  const host = $('#cfgLogHost');
  if (!host) return;
  host.innerHTML = `<div class="p-1" aria-busy="true">${'<div class="skeleton-line"></div>'.repeat(3)}</div>`;
  try {
    const list = await rpc('listConfigLog', 50);
    $('#cfgLogCount').textContent = Array.isArray(list) && list.length ? ` (${list.length})` : '';
    if (!Array.isArray(list) || !list.length) {
      host.innerHTML = `<div class="empty-state text-[12px]">Chưa có bản ghi nào — lưu cấu hình để bắt đầu lưu log.</div>`;
      return;
    }
    const grpSummary = (groups) => {
      const n = groups ? Object.keys(groups).length : 0;
      return n ? `${n} nhóm riêng` : '—';
    };
    host.innerHTML = `<div class="border border-slate-200 rounded-md overflow-x-auto scroll-area">
      <table class="dt">
        <thead><tr>
          <th style="width:170px">Thời điểm áp dụng</th>
          <th style="width:110px">Người lưu</th>
          <th class="c" style="width:60px">k1</th>
          <th class="c" style="width:60px">k2</th>
          <th class="c" style="width:80px">Leadtime</th>
          <th class="c" style="width:90px">Số tháng đặt</th>
          <th>Nhóm riêng</th>
        </tr></thead>
        <tbody>${list.map((r, i) => {
          const v = r.value || {};
          const now = i === 0 ? ` <span class="pill st-app">Hiện hành</span>` : '';
          return `<tr>
            <td class="text-slate-700">${esc(fmtDate(r.created_at))}${now}</td>
            <td class="text-slate-600">${esc(r.created_by || '—')}</td>
            <td class="c num text-slate-700">${esc(v.k1 ?? '—')}</td>
            <td class="c num text-slate-700">${esc(v.k2 ?? '—')}</td>
            <td class="c num text-slate-700">${esc(v.leadtime_thang_default ?? '—')}</td>
            <td class="c num text-slate-700">${esc(v.so_thang_dat_default ?? '—')}</td>
            <td class="text-slate-500 text-[12px]">${esc(grpSummary(v.groups))}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
  } catch (e) {
    host.innerHTML = `<div class="empty-state text-[12px] text-danger-600">
      <div class="mb-2">Lỗi tải lịch sử: ${esc(e.message)}</div>
      <button id="cfgLogRetry" class="ctl-btn" type="button">Thử lại</button>
    </div>`;
    const retry = $('#cfgLogRetry');
    if (retry) retry.onclick = () => renderConfigLog();
  }
}

// ============ TAB 2: EMAIL THÔNG BÁO ============
// Quản lý email nhận thông báo — đọc/sửa shared.users.email. User nhóm theo role, lọc được.
const ROLE_ORDER = ['Admin', 'Manager', 'Product Manager', 'Area Manager', 'Mua hàng'];
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const emailInputs = () => $$('#emailCfgHost input.email-inp');

// Chuỗi email hợp lệ: rỗng, hoặc các email ngăn bằng dấu phẩy.
const emailValid = v => !v.trim() || v.split(',').every(p => EMAIL_RE.test(p.trim()));

function bindEmail() {
  $('#emailSearch').addEventListener('input', applyEmailFilter);
  ['emailRole', 'emailMien', 'emailOnlyEmpty'].forEach(id => $('#' + id).addEventListener('change', applyEmailFilter));
  $('#emailCfgHost').addEventListener('input', e => {
    if (!e.target.classList.contains('email-inp')) return;
    validateEmailInput(e.target);
    updateEmailDirty();
  });
  $('#emailUndo').addEventListener('click', () => {
    const inputs = emailInputs();
    restoreOrig(inputs);
    inputs.forEach(validateEmailInput);
    setMsg($('#emailMsg'), '', '');
    updateEmailDirty();
    applyEmailFilter();
  });
  $('#emailSave').addEventListener('click', saveUserEmails);
}

function validateEmailInput(inp) {
  const ok = emailValid(inp.value);
  inp.classList.toggle('cfg-invalid', !ok);
  inp.title = ok ? '' : 'Email không hợp lệ — nhiều email ngăn bằng dấu phẩy';
  inp.setAttribute('aria-invalid', ok ? 'false' : 'true');
  return ok;
}

function updateEmailDirty() {
  const n = countChanged(emailInputs());
  $('#emailDirtyCount').textContent = n;
  $('#emailSaveBar').classList.toggle('hidden', n === 0);
  markTabDirty('email', n > 0);
}

async function renderUserEmails() {
  const host = $('#emailCfgHost');
  if (!host) return;
  host.innerHTML = `<div class="p-1" aria-busy="true">${'<div class="skeleton-line"></div>'.repeat(4)}</div>`;
  try {
    const list = await rpc('listUserEmails');
    if (!Array.isArray(list) || !list.length) {
      host.innerHTML = `<div class="empty-state text-[12px]">Không có user nào.</div>`;
      return;
    }
    const byRole = new Map();
    list.forEach(r => {
      const lbl = roleLabel(r.role) || '(không có role)';
      if (!byRole.has(lbl)) byRole.set(lbl, []);
      byRole.get(lbl).push(r);
    });
    const rank = l => { const i = ROLE_ORDER.indexOf(l); return i < 0 ? ROLE_ORDER.length : i; };
    const roles = [...byRole.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'vi'));

    $('#emailRole').innerHTML = '<option value="">Tất cả role</option>'
      + roles.map(l => `<option value="${esc(l)}">${esc(l)} (${byRole.get(l).length})</option>`).join('');

    host.innerHTML = roles.map(l => `
      <details open class="email-grp border border-slate-200 rounded-md mb-2 overflow-hidden" data-role="${esc(l)}">
        <summary class="px-3 py-2 bg-slate-50 cursor-pointer text-[12px] font-semibold text-slate-700 select-none">
          ${esc(l)} <span class="email-grp-count font-normal text-slate-500"></span>
        </summary>
        <div class="overflow-x-auto scroll-area">
          <table class="dt">
            <thead><tr>
              <th>Họ tên</th><th style="width:130px">Username</th>
              <th class="c" style="width:60px">Miền</th>
              <th style="width:170px">Scope (PM/Mua hàng)</th>
              <th style="width:260px">Email nhận thông báo</th>
            </tr></thead>
            <tbody>${byRole.get(l).map(r => `<tr data-mien="${esc(r.mien || '-')}"
                data-search="${esc([r.ho_ten, r.username, r.scope, r.email].filter(Boolean).join(' ').toLowerCase())}">
              <td class="text-slate-700 text-[12px]">${esc(r.ho_ten)}</td>
              <td class="font-mono text-[11px] text-slate-500">${esc(r.username)}</td>
              <td class="c text-slate-600 text-[11px]">${esc(r.mien || '—')}</td>
              <td class="text-slate-500 text-[11px] truncate" title="${esc(r.scope || '')}">${esc(r.scope || '—')}</td>
              <td><input type="text" class="email-inp px-2 py-1 border border-slate-200 rounded text-[12px] w-full outline-none focus:border-primary-500"
                data-username="${esc(r.username)}" value="${esc(r.email)}" placeholder="a@caotoc24.com, b@caotoc24.com" aria-label="Email ${esc(r.username)}"/></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </details>`).join('');

    const inputs = emailInputs();
    setOrig(inputs);
    inputs.forEach(validateEmailInput);
    updateEmailDirty();
    applyEmailFilter();
  } catch (e) {
    host.innerHTML = `<div class="empty-state text-[12px] text-danger-600">
      <div class="mb-2">Lỗi tải danh sách: ${esc(e.message)}</div>
      <button id="emailRetry" class="ctl-btn" type="button">Thử lại</button></div>`;
    const retry = $('#emailRetry');
    if (retry) retry.onclick = () => renderUserEmails();
  }
}

function applyEmailFilter() {
  const q = ($('#emailSearch').value || '').trim().toLowerCase();
  const role = $('#emailRole').value;
  const mien = $('#emailMien').value;
  const onlyEmpty = $('#emailOnlyEmpty').checked;
  let shown = 0, total = 0;
  $$('#emailCfgHost .email-grp').forEach(grp => {
    const rows = $$('tbody tr', grp);
    let n = 0;
    rows.forEach(tr => {
      const inp = $('.email-inp', tr);
      const ok = (!role || grp.dataset.role === role)
        && (!mien || tr.dataset.mien === mien)
        && (!q || tr.dataset.search.includes(q) || inp.value.toLowerCase().includes(q))
        && (!onlyEmpty || !inp.value.trim());
      tr.classList.toggle('hidden', !ok);
      if (ok) n++;
    });
    grp.classList.toggle('hidden', n === 0);
    $('.email-grp-count', grp).textContent = n === rows.length ? `(${rows.length})` : `(${n}/${rows.length})`;
    shown += n; total += rows.length;
  });
  $('#emailCount').textContent = total ? `${shown}/${total} user` : '';
}

async function saveUserEmails() {
  const inputs = emailInputs();
  const bad = inputs.filter(i => !validateEmailInput(i));
  if (bad.length) {
    setMsg($('#emailMsg'), `${bad.length} ô email không hợp lệ (viền đỏ)`, 'err');
    bad[0].focus();
    return;
  }
  const rows = inputs.map(i => ({ username: i.dataset.username, email: i.value.trim() }));
  const btn = $('#emailSave');
  btn.disabled = true;
  try {
    const r = await rpc('saveUserEmails', rows);
    setOrig(inputs);
    setMsg($('#emailMsg'), '', '');
    updateEmailDirty();
    toast(`Đã lưu email nhận thông báo (${r.updated} user)`);
  } catch (e) {
    setMsg($('#emailMsg'), 'Lỗi: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ============ TAB 3: DỮ LIỆU & CHỈ SỐ ============
// Cache chỉ số sử dụng (app_order.usage_indicators): hiện lần tính gần nhất, Admin bấm để tính lại.
const indInfoText = (r) => r.updated_at
  ? `Lần tính gần nhất: ${fmtDate(r.updated_at)} — ${r.rows.toLocaleString('vi-VN')} dòng`
  : 'Chưa tính lần nào';

async function renderIndicatorsInfo() {
  const msg = $('#indMsg');
  if (!msg) return;
  try {
    msg.textContent = indInfoText(await rpc('indicatorsInfo'));
    msg.className = 'text-[13px] text-slate-700';
  } catch (e) {
    msg.textContent = 'Lỗi tải thông tin: ' + e.message;
    msg.className = 'text-[13px] text-danger-600';
  }
}

async function refreshIndicators() {
  const btn = $('#indRefresh'), msg = $('#indMsg');
  btn.disabled = true;
  btn.textContent = 'Đang tính…';
  try {
    const r = await rpcOpts({ timeoutMs: 120000 }, 'refreshIndicators');   // tính lại toàn bộ mã: lâu hơn timeout mặc định 15s
    msg.textContent = '✓ ' + indInfoText(r);
    msg.className = 'text-[13px] text-primary-600';
    toast('Đã tính lại chỉ số sử dụng. Mở lại tab Chi tiết để thấy số mới.');
  } catch (e) {
    msg.textContent = 'Lỗi: ' + e.message;
    msg.className = 'text-[13px] text-danger-600';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tính lại chỉ số';
  }
}
