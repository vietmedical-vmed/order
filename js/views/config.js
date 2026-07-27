// ============ MÀN CẤU HÌNH CÔNG THỨC (chỉ Admin) ============
import { $, $$, esc, fmtDate } from '../utils.js';
import { rpc } from '../api.js';
import { state } from '../state.js';
import { toast } from '../toast.js';

export async function initConfigView() {
  if (state.user.role !== 'ADMIN') {
    $('#main').innerHTML = '<div class="empty-state">Chỉ Admin mới truy cập được tab này</div>';
    return;
  }
  try {
    const cfg = await rpc('getConfig');
    $('#cfgK1').value = cfg.k1;
    $('#cfgK2').value = cfg.k2;
    $('#cfgK3').value = cfg.k3;
    $('#cfgSoThangDat').value = cfg.so_thang_dat_default;
    renderCfgGroups(cfg.groups_list || [], cfg.groups || {});
    updateCfgSumNote();
  } catch (e) {
    $('#cfgMsg').textContent = 'Lỗi tải cấu hình: ' + e.message;
    $('#cfgMsg').className = 'text-[12px] text-danger-600';
  }
  renderConfigLog();

  ['cfgK1', 'cfgK2', 'cfgK3'].forEach(id => {
    $('#' + id).addEventListener('input', updateCfgSumNote);
  });
  // Placeholder các ô nhóm cập nhật theo giá trị mặc định
  ['cfgK1', 'cfgK2', 'cfgK3', 'cfgSoThangDat'].forEach(id => {
    $('#' + id).addEventListener('input', updateCfgGroupPlaceholders);
  });

  $('#cfgSave').addEventListener('click', async () => {
    const cfg = {
      k1: parseFloat($('#cfgK1').value),
      k2: parseFloat($('#cfgK2').value),
      k3: parseFloat($('#cfgK3').value),
      so_thang_dat_default: parseFloat($('#cfgSoThangDat').value),
      groups: collectCfgGroups(),
    };
    if (isNaN(cfg.k1) || isNaN(cfg.k2) || isNaN(cfg.k3)) {
      $('#cfgMsg').textContent = 'k1/k2/k3 phải là số';
      $('#cfgMsg').className = 'text-[12px] text-danger-600';
      return;
    }
    try {
      await rpc('saveConfig', cfg);
      $('#cfgMsg').textContent = '✓ Đã lưu cấu hình lúc ' + new Date().toLocaleTimeString('vi-VN');
      $('#cfgMsg').className = 'text-[12px] text-primary-600';
      toast('Đã lưu cấu hình. Cột Gợi ý sẽ cập nhật khi mở tab Chi tiết.');
      renderConfigLog();
    } catch (e) {
      $('#cfgMsg').textContent = 'Lỗi: ' + e.message;
      $('#cfgMsg').className = 'text-[12px] text-danger-600';
    }
  });

  $('#cfgReset').addEventListener('click', () => {
    $('#cfgK1').value = 0.4; $('#cfgK2').value = 0.4; $('#cfgK3').value = 0.2;
    $('#cfgSoThangDat').value = 3;
    updateCfgSumNote();
    updateCfgGroupPlaceholders();
  });
}

// Lịch sử phiên bản cấu hình công thức (mới nhất trước).
async function renderConfigLog() {
  const host = $('#cfgLogHost');
  if (!host) return;
  host.innerHTML = `<div class="p-1" aria-busy="true">${'<div class="skeleton-line"></div>'.repeat(3)}</div>`;
  try {
    const list = await rpc('listConfigLog', 50);
    if (!Array.isArray(list) || !list.length) {
      host.innerHTML = `<div class="empty-state text-[12px]">Chưa có bản ghi nào — lưu cấu hình để bắt đầu lưu log.</div>`;
      return;
    }
    const grpSummary = (groups) => {
      const n = groups ? Object.keys(groups).length : 0;
      return n ? `${n} nhóm cấu hình riêng` : 'không có nhóm riêng';
    };
    host.innerHTML = `<div class="border border-slate-200 rounded-md overflow-x-auto scroll-area">
      <table class="dt">
        <thead><tr>
          <th style="width:170px">Thời điểm áp dụng</th>
          <th style="width:120px">Người lưu</th>
          <th class="c" style="width:70px">k1</th>
          <th class="c" style="width:70px">k2</th>
          <th class="c" style="width:70px">k3</th>
          <th class="c" style="width:90px">Số tháng đặt</th>
          <th>Nhóm riêng</th>
        </tr></thead>
        <tbody>${list.map((r, i) => {
          const v = r.value || {};
          const now = i === 0 ? ` <span class="pill st-app">Hiện hành</span>` : '';
          return `<tr>
            <td class="text-slate-700">${esc(fmtDate(r.created_at))}${now}</td>
            <td class="text-slate-600">${esc(r.created_by || '—')}</td>
            <td class="c num text-slate-700">${v.k1}</td>
            <td class="c num text-slate-700">${v.k2}</td>
            <td class="c num text-slate-700">${v.k3}</td>
            <td class="c num text-slate-700">${v.so_thang_dat_default}</td>
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

// Bảng cấu hình riêng theo nhóm sản phẩm — ô trống = dùng mặc định (hiển thị ở placeholder).
function renderCfgGroups(list, groups) {
  const body = $('#cfgGroupBody');
  if (!body) return;
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-slate-500 text-center py-3 text-[12px]">Chưa có nhóm sản phẩm nào — tích chọn vật tư ở tab "Cấu hình danh mục" trước.</td></tr>`;
    return;
  }
  const cell = (g, k, step, min, max, label) => {
    const gc = groups[g] || {};
    const v = (gc[k] === undefined || gc[k] === null) ? '' : gc[k];
    return `<td class="c"><input type="number" class="cfg-grp-input px-2 py-1 border border-slate-200 rounded text-[12px] w-full outline-none focus:border-primary-500"
      data-k="${k}" step="${step}" min="${min}" max="${max}" value="${v}" aria-label="${esc(label)} — ${esc(g)}"/></td>`;
  };
  body.innerHTML = list.map(g => `<tr data-cfg-grp="${esc(g)}">
    <td class="text-slate-700 text-[12px]">${esc(g)}</td>
    ${cell(g, 'k1', '0.05', '0', '2', 'k1')}
    ${cell(g, 'k2', '0.05', '0', '2', 'k2')}
    ${cell(g, 'k3', '0.05', '0', '2', 'k3')}
    ${cell(g, 'so_thang_dat', '1', '1', '12', 'Số tháng đặt')}
  </tr>`).join('');
  updateCfgGroupPlaceholders();
}

function updateCfgGroupPlaceholders() {
  const ph = { k1: $('#cfgK1').value, k2: $('#cfgK2').value, k3: $('#cfgK3').value, so_thang_dat: $('#cfgSoThangDat').value };
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
  const sum = (parseFloat($('#cfgK1').value) || 0) + (parseFloat($('#cfgK2').value) || 0) + (parseFloat($('#cfgK3').value) || 0);
  const note = $('#cfgSumNote');
  if (!note) return;
  note.innerHTML = Math.abs(sum - 1) < 0.001
    ? `<span class="text-primary-600">Tổng k1+k2+k3 = ${sum.toFixed(2)} ✓</span>`
    : `<span class="text-warning-700">Tổng k1+k2+k3 = ${sum.toFixed(2)} (khuyến nghị = 1.00)</span>`;
}
