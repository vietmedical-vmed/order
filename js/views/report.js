// ============ MÀN BÁO CÁO ĐẶT HÀNG ============
import { $, $$, esc, fmt, dash0, debounce, viCmp } from '../utils.js';
import { rpc } from '../api.js';
import { state } from '../state.js';
import { toast } from '../toast.js';

const MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const MONTH_LABELS = { 1: 'Tháng 1', 2: 'Tháng 2', 3: 'Tháng 3', 4: 'Tháng 4', 5: 'Tháng 5', 6: 'Tháng 6', 7: 'Tháng 7', 8: 'Tháng 8', 9: 'Tháng 9', 10: 'Tháng 10', 11: 'Tháng 11', 12: 'Tháng 12' };

let _filterBound = false;
let _reportData = [];
let _selectedGroups = new Set();
let _groupList = [];

export async function initReportView() {
  if (!_filterBound) {
    _filterBound = true;
    $('#rptSearch').addEventListener('input', debounce(renderTable, 300));
    $$('.rmien-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.rmien-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        loadReport();
      });
    });
    $('#rptGrpBtn').addEventListener('click', toggleGroupMenu);
    document.addEventListener('click', e => {
      const menu = $('#rptGrpMenu');
      if (menu && !menu.classList.contains('hidden') && !e.target.closest('#rptGrpWrap')) menu.classList.add('hidden');
    });
    $('#rptExport').addEventListener('click', exportReport);
  }
  await loadReport();
}

async function loadReport() {
  const host = $('#reportHost');
  host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 p-4" aria-busy="true">
    ${'<div class="skeleton-line"></div>'.repeat(6)}</div>`;

  try {
    const mien = $$('.rmien-btn').find(b => b.classList.contains('active'))?.dataset.rmien || 'ALL';
    const groups = _selectedGroups.size ? [..._selectedGroups] : [];

    const result = await rpc('loadOrderReport', { mien, groups });
    _reportData = result.rows || [];

    if (!_groupList.length) {
      const allGroups = await rpc('listProductGroups');
      _groupList = (allGroups || []).sort(viCmp);
      buildGroupMenu();
    }

    renderTable();
  } catch (e) {
    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state text-danger-600">${esc(e.message)}</div>`;
  }
}

function buildGroupMenu() {
  const menu = $('#rptGrpMenu');
  if (!menu) return;
  menu.innerHTML = _groupList.map(g => {
    const checked = _selectedGroups.has(g) ? 'checked' : '';
    return `<label class="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded cursor-pointer text-[13px]">
      <input type="checkbox" class="rpt-grp-cb rounded" value="${esc(g)}" ${checked}/>${esc(g)}</label>`;
  }).join('');
  $$('.rpt-grp-cb', menu).forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) _selectedGroups.add(cb.value);
      else _selectedGroups.delete(cb.value);
      updateGroupLabel();
      loadReport();
    });
  });
}

function toggleGroupMenu() {
  const menu = $('#rptGrpMenu');
  menu.classList.toggle('hidden');
}

function updateGroupLabel() {
  const label = $('#rptGrpLabel');
  if (_selectedGroups.size === 0) label.textContent = 'Tất cả nhóm SP';
  else if (_selectedGroups.size === 1) label.textContent = [..._selectedGroups][0];
  else label.textContent = _selectedGroups.size + ' nhóm SP';
}

function renderTable() {
  const host = $('#reportHost');
  const search = ($('#rptSearch')?.value || '').trim().toLowerCase();

  let rows = _reportData;
  if (search) {
    rows = rows.filter(r =>
      (r.ma_bravo || '').toLowerCase().includes(search) ||
      (r.code_ncc || '').toLowerCase().includes(search) ||
      (r.ten_hang || '').toLowerCase().includes(search)
    );
  }

  if (!rows.length) {
    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state">Không có dữ liệu đặt hàng</div>`;
    return;
  }

  const html = `
    <div class="bg-white rounded-lg border border-slate-200 overflow-x-auto scroll-area">
      <table class="dt text-[12px]">
        <thead>
          <tr>
            <th colspan="4" class="text-center border-b border-r border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide">Thông tin đặt hàng</th>
            <th colspan="13" class="text-center border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide">Số lượng đặt hàng</th>
          </tr>
          <tr>
            <th class="c" style="width:45px">STT</th>
            <th style="min-width:120px">Mã vật tư</th>
            <th style="min-width:90px">Mã NCC</th>
            <th style="min-width:220px" class="border-r border-slate-200">Tên vật tư</th>
            <th class="c" style="min-width:70px">Tổng</th>
            ${MONTHS.map(m => `<th class="c" style="min-width:70px">${esc(MONTH_LABELS[m])}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `<tr class="hover:bg-slate-50">
            <td class="c num text-slate-500">${i + 1}</td>
            <td class="font-mono text-[11px] text-slate-700 nowrap">${esc(r.ma_bravo)}</td>
            <td class="font-mono text-[11px] text-slate-500 nowrap">${esc(r.code_ncc || '—')}</td>
            <td class="font-medium text-slate-800 border-r border-slate-200">${esc(r.ten_hang || '')}</td>
            <td class="c num font-semibold text-primary-700">${dash0(r.tong)}</td>
            ${MONTHS.map(m => {
              const v = r[m];
              return `<td class="c num ${v ? 'text-slate-700' : 'text-slate-300'}">${dash0(v)}</td>`;
            }).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="mt-2 text-[12px] text-slate-500">${rows.length} vật tư</div>`;

  host.innerHTML = html;
}

async function exportReport() {
  const btn = $('#rptExport');
  if (btn) btn.disabled = true;
  try {
    const search = ($('#rptSearch')?.value || '').trim().toLowerCase();
    let rows = _reportData;
    if (search) {
      rows = rows.filter(r =>
        (r.ma_bravo || '').toLowerCase().includes(search) ||
        (r.code_ncc || '').toLowerCase().includes(search) ||
        (r.ten_hang || '').toLowerCase().includes(search)
      );
    }
    if (!rows.length) { toast('Chưa có dữ liệu để xuất', 'error'); return; }

    if (!window.XLSX) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Không tải được thư viện xuất Excel'));
        document.head.appendChild(s);
      });
    }
    const XLSX = window.XLSX;

    const n0 = v => { const n = Number(v); return isFinite(n) && n !== 0 ? n : ''; };
    const header1 = ['', 'Thông tin đặt hàng', '', '', 'Số lượng đặt hàng', ...Array(12).fill('')];
    const header2 = ['STT', 'Mã vật tư', 'Mã NCC', 'Tên vật tư', 'Tổng', ...MONTHS.map(m => MONTH_LABELS[m])];
    const aoa = [header1, header2];
    rows.forEach((r, i) => {
      aoa.push([i + 1, r.ma_bravo, r.code_ncc || '', r.ten_hang || '', n0(r.tong),
        ...MONTHS.map(m => n0(r[m]))]);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
      { s: { r: 0, c: 4 }, e: { r: 0, c: 16 } },
    ];
    ws['!cols'] = [
      { wch: 5 }, { wch: 16 }, { wch: 12 }, { wch: 35 }, { wch: 8 },
      ...Array(12).fill({ wch: 9 }),
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Báo cáo đặt hàng');
    XLSX.writeFile(wb, 'bao_cao_dat_hang.xlsx');
    toast('Đã xuất Excel');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
