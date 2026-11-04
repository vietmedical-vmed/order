// ============ MÀN KIỂM CHỨNG GỢI Ý (BACKTEST) ============
// Mỗi mốc T: server (RPC backtest_goi_y, sql/26) tính lại TB TH và tồn chỉ bằng dữ liệu có
// trước T, kèm KH và SL thực tế từng tháng T … T+17. Màn này áp hệ số + cửa sổ ở client:
//   Dự báo   = (k1·TB TH + k2·TB KH) × N        so với   Thực tế = Σ SL các tháng T+lt … T+lt+N-1
//   Gợi ý    = max(0, Dự báo + Safety − Tồn tại T)        (giống buildGoiY ở order-api)
//   Tồn cuối = Tồn tại T + Gợi ý − Σ SL thực tế T … T+lt+N-1   (< 0 = hết hàng)
// "Cấu hình hiện hành": k1/k2/N/lt theo override của từng nhóm (như order-api), TB KH theo cửa
// sổ MẶC ĐỊNH (như cache usage_indicators). Đổi bộ lọc / hệ số chỉ tính lại ở client; đổi mốc
// phải bấm "Chạy".
import { $, $$, esc, fmt, viCmp, debounce } from '../utils.js';
import { rpc } from '../api.js';
import { toast } from '../toast.js';
import { loadSheetJS } from '../export-excel.js';

const _cache = new Map();          // asof -> kết quả RPC
let _results = [];                 // kết quả của lần chạy gần nhất (theo thứ tự mốc)
let _cfg = null;                   // cấu hình gợi ý hiện hành (k1/k2/override nhóm)
let _detailAsof = '';
let _range = null;                 // { from, to } người dùng đã chọn (giữ khi quay lại tab)

// ---------- tiện ích ----------
const mIdx = s => { const [y, m] = String(s).split('-').map(Number); return y * 12 + m - 1; };
const mStr = i => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`;
function nowVnMonth() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}
const pct = (v, d = 0) => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
const sgnPct = v => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
const sum = a => a.reduce((s, x) => s + x, 0);
const rnd = v => Math.round(Number(v) || 0);   // PG round(numeric) và Math.round giống nhau với số dương
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

const defLt = () => rnd(_cfg?.leadtime_thang_default ?? _cfg?.so_thang_dat_default ?? 3);
const defN = () => Math.max(1, rnd(_cfg?.so_thang_dat_default ?? 3));

function opts() {
  return {
    mien: $('#btMien').value, bu: $('#btBU').value, nhom: $('#btGrp').value,
    mode: $('#btMode').value,
    k1: Number($('#btK1').value) || 0, k2: Number($('#btK2').value) || 0,
    lt: clampInt($('#btLt').value, 0, 12, defLt()), n: clampInt($('#btN').value, 1, 12, defN()),
    thB: $('#btThB').checked, khDn: $('#btKhDn').checked, khGrp: $('#btKhGrp').checked,
  };
}

// Hệ số + cửa sổ áp cho 1 nhóm (khớp cfgForGroup ở order-api; leadtime làm tròn như sql/25).
function paramsFor(o, nhom) {
  if (o.mode === 'custom' || !_cfg) return { k1: o.k1, k2: o.k2, lt: o.lt, n: o.n, khLt: o.lt, khN: o.n };
  const g = (_cfg.groups && nhom && _cfg.groups[nhom]) || {};
  const n = Math.max(1, rnd(g.so_thang_dat ?? _cfg.so_thang_dat_default));
  const lt = Math.min(12, Math.max(0, rnd(g.leadtime_thang ?? _cfg.leadtime_thang_default)));
  return {
    k1: g.k1 ?? _cfg.k1, k2: g.k2 ?? _cfg.k2, lt, n,
    khLt: o.khGrp ? lt : defLt(), khN: o.khGrp ? n : defN(),
  };
}

// ---------- khởi tạo ----------
export async function initBacktestView() {
  try { _cfg = await rpc('getConfig'); } catch (e) { toast(e.message, 'error'); }
  $('#btLt').value = defLt();
  $('#btN').value = defN();
  $('#btK1').value = _cfg?.k1 ?? 0.8;
  $('#btK2').value = _cfg?.k2 ?? 0.2;
  // Mốc muộn nhất có đủ thực tế cho cửa sổ mặc định: tháng trước tháng hiện tại − (lt + N − 1).
  const maxT = nowVnMonth() - 1 - (defLt() + defN() - 1);
  $('#btFrom').value = _range?.from || mStr(maxT - 5);
  $('#btTo').value = _range?.to || mStr(maxT);

  $('#btRun').addEventListener('click', run);
  $('#btExport').addEventListener('click', exportExcel);
  ['#btMien', '#btBU', '#btGrp', '#btMode', '#btThB', '#btKhDn', '#btKhGrp'].forEach(s =>
    $(s).addEventListener('change', () => { syncModeUI(); render(); }));
  ['#btK1', '#btK2', '#btLt', '#btN'].forEach(s => $(s).addEventListener('input', debounce(render, 300)));
  syncModeUI();
  await loadBU();
  await run();
}

function syncModeUI() {
  const custom = $('#btMode').value === 'custom';
  ['#btK1', '#btK2', '#btLt', '#btN'].forEach(s => { $(s).disabled = !custom; });
  $('#btKhGrp').disabled = custom;
  $('#btKhGrp').closest('label').classList.toggle('opacity-50', custom);
}

async function loadBU() {
  try {
    const list = await rpc('listBU');
    if (Array.isArray(list) && list.length) {
      $('#btBU').innerHTML = '<option value="ALL">Tất cả BU</option>' +
        list.map(b => `<option value="${esc(b.bu_code || b.bu)}">${esc(b.ten_bu || b.bu)}</option>`).join('');
    }
  } catch (e) { console.warn('[backtest listBU]', e); }
}

// ---------- gọi server ----------
async function run() {
  const from = $('#btFrom').value, to = $('#btTo').value;
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) { toast('Chọn mốc từ / đến', 'error'); return; }
  let a = mIdx(from), b = mIdx(to);
  if (a > b) [a, b] = [b, a];
  if (b - a > 23) { toast('Tối đa 24 mốc mỗi lần chạy', 'error'); return; }
  _range = { from, to };
  const months = [];
  for (let i = a; i <= b; i++) months.push(mStr(i));

  const btn = $('#btRun');
  btn.disabled = true;
  const host = $('#btHost');
  try {
    const out = new Array(months.length);
    let done = 0;
    const progress = () => {
      host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 p-4 text-[13px] text-slate-600" aria-busy="true">
        Đang tính lại gợi ý tại ${done}/${months.length} mốc…${'<div class="skeleton-line mt-2"></div>'.repeat(3)}</div>`;
    };
    progress();
    // 2 mốc song song: mỗi mốc là 1 truy vấn ~1–2 giây trên sv + hoá đơn.
    let next = 0;
    const worker = async () => {
      while (next < months.length) {
        const i = next++;
        if (!_cache.has(months[i])) {
          const r = await rpc('backtestGoiY', { asof: months[i] });
          if (r.cfg) _cfg = r.cfg;
          _cache.set(months[i], r);
        }
        out[i] = _cache.get(months[i]);
        done++;
        progress();
      }
    };
    await Promise.all([worker(), worker()]);
    _results = out;
    if (!_results.some(r => r.asof === _detailAsof)) _detailAsof = _results[_results.length - 1]?.asof || '';
    buildGroupOptions();
    render();
  } catch (e) {
    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state text-danger-600">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function buildGroupOptions() {
  const sel = $('#btGrp');
  const cur = sel.value;
  const groups = [...new Set(_results.flatMap(r => (r.rows || []).map(x => x.nhom || '')).filter(Boolean))].sort(viCmp);
  sel.innerHTML = '<option value="">Tất cả nhóm SP</option>' +
    groups.map(g => `<option value="${esc(g)}"${g === cur ? ' selected' : ''}>${esc(g)}</option>`).join('');
}

// ---------- tính toán ----------
// Lọc BU / nhóm, gộp 2 miền khi chọn "Cả 2 miền" (cộng mọi số — như màn đặt hàng khi xem ALL).
const ARR = ['kh_m', 'kh_m_dn', 'act'];
function rowsOf(res, o) {
  const rows = (res.rows || []).filter(r =>
    (o.bu === 'ALL' || r.bu === o.bu) && (!o.nhom || r.nhom === o.nhom));
  if (o.mien !== 'ALL') return rows.filter(r => r.mien === o.mien);
  const m = new Map();
  for (const r of rows) {
    const x = m.get(r.sp_key);
    if (!x) { m.set(r.sp_key, { ...r, mien: 'MB+MN', kh_m: [...r.kh_m], kh_m_dn: [...r.kh_m_dn], act: [...r.act] }); continue; }
    for (const k of ['n_sku', 'n_hay', 'th_a', 'th_b', 'safety']) x[k] = Number(x[k]) + Number(r[k]);
    x.ton = (x.ton == null || r.ton == null) ? null : Number(x.ton) + Number(r.ton);
    for (const k of ARR) x[k] = x[k].map((v, i) => (v == null || r[k][i] == null) ? null : Number(v) + Number(r[k][i]));
  }
  return [...m.values()];
}

const winSum = (arr, from, len) => {
  const w = arr.slice(from, from + len);
  return (w.length < len || w.some(v => v == null)) ? null : sum(w.map(Number));
};

// Dòng đã tính: dự báo, thực tế, gợi ý, tồn cuối.
function evalRows(res, o) {
  return rowsOf(res, o).map(r => {
    const p = paramsFor(o, r.nhom);
    const th = Number(o.thB ? r.th_b : r.th_a);
    const kh = (winSum(o.khDn ? r.kh_m_dn : r.kh_m, p.khLt, p.khN) || 0) / p.khN;
    const f = (p.k1 * th + p.k2 * kh) * p.n;
    const a = winSum(r.act, p.lt, p.n);
    const all = winSum(r.act, 0, p.lt + p.n);
    const ton = r.ton == null ? null : Number(r.ton);
    const safety = Number(r.safety) || 0;
    const goiY = ton == null ? null : Math.max(0, Math.round(f + safety - ton));
    const end = (ton == null || all == null) ? null : ton + goiY - all;
    return { ...r, asof: res.asof, ...p, th, kh, f, a, all, ton, safety, goiY, end, err: a == null ? null : f - a,
      winLabel: `${res.months[p.lt]} → ${res.months[p.lt + p.n - 1]}` };
  });
}

// Chỉ số tổng hợp trên tập dòng đã có thực tế (bỏ dòng dự báo = thực tế = 0).
const evaluable = rows => rows.filter(r => r.a != null && !(r.a === 0 && Math.round(r.f) === 0));
function metrics(rows) {
  const ev = evaluable(rows);
  const sA = sum(ev.map(r => r.a)), sF = sum(ev.map(r => r.f));
  const pos = ev.filter(r => r.a > 0);
  const st = rows.filter(r => r.end != null);
  return {
    n: ev.length, sA, sF,
    wape: sA > 0 ? sum(ev.map(r => Math.abs(r.f - r.a))) / sA : null,
    bias: sA > 0 ? (sF - sA) / sA : null,
    within: pos.length ? pos.filter(r => Math.abs(r.f - r.a) <= 0.2 * r.a).length / pos.length : null,
    nStock: st.length,
    stockout: st.length ? st.filter(r => r.end < 0).length / st.length : null,
    over: st.length ? st.filter(r => r.a > 0 && r.end > r.a).length / st.length : null,
  };
}

// WAPE với k1/k2 cố định (giữ cửa sổ / TB TH / TB KH của từng dòng).
function wapeAt(rows, k1, k2) {
  const ev = evaluable(rows);
  const sA = sum(ev.map(r => r.a));
  return sA > 0 ? sum(ev.map(r => Math.abs((k1 * r.th + k2 * r.kh) * r.n - r.a))) / sA : null;
}
// Cặp k1/k2 (lưới 0 … 1, bước 0,1) cho WAPE thấp nhất.
function bestK(rows) {
  let best = null;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const w = wapeAt(rows, i / 10, j / 10);
    if (w != null && (!best || w < best.wape - 1e-9)) best = { k1: i / 10, k2: j / 10, wape: w };
  }
  return best;
}

const groupBy = rows => {
  const by = new Map();
  for (const r of rows) { const g = r.nhom || '(Chưa có nhóm)'; (by.get(g) || by.set(g, []).get(g)).push(r); }
  return by;
};
const uniq = (rows, f) => { const s = [...new Set(rows.map(f))]; return s.length === 1 ? s[0] : 'nhiều mức'; };

// ---------- vẽ ----------
function render() {
  const host = $('#btHost');
  if (!host || !_results.length) return;
  const o = opts();
  const per = _results.map(res => ({ res, rows: evalRows(res, o) }));
  const allRows = per.flatMap(x => x.rows);
  const tot = metrics(allRows);

  const note = [];
  const noEval = per.filter(x => !x.rows.some(r => r.a != null)).map(x => x.res.asof);
  const partial = per.filter(x => x.rows.some(r => r.a == null) && x.rows.some(r => r.a != null)).map(x => x.res.asof);
  if (noEval.length) note.push(`Mốc ${noEval.join(', ')} chưa đủ tháng thực tế (dữ liệu đến ${esc(_results[0].last_month)}) — không tính vào chỉ số.`);
  if (partial.length) note.push(`Mốc ${partial.join(', ')}: một số nhóm có cửa sổ dài hơn dữ liệu hiện có — các nhóm đó bị bỏ qua ở mốc này.`);
  if (!allRows.some(r => r.end != null)) note.push('Chưa mô phỏng được tồn: tồn kho lịch sử chỉ có từ 2026-08, chưa mốc nào vừa có snapshot tồn vừa đủ thực tế đến hết cửa sổ.');
  const onlyTh = wapeAt(allRows, 1, 0), onlyKh = wapeAt(allRows, 0, 1);

  host.innerHTML = `
    ${note.length ? `<div class="mb-3 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">${note.join('<br>')}</div>` : ''}
    <div class="flex flex-wrap gap-3 mb-4">
      ${card('Sai số WAPE', pct(tot.wape), wapeColor(tot.wape), `Σ|dự báo − thực tế| / Σ thực tế · nếu chỉ dùng TB TH: ${pct(onlyTh)} · chỉ TB KH: ${pct(onlyKh)}`)}
      ${card('Lệch hệ thống (Bias)', sgnPct(tot.bias), biasColor(tot.bias), tot.bias == null ? '' : tot.bias > 0 ? 'Dự báo cao hơn thực tế' : 'Dự báo thấp hơn thực tế')}
      ${card('SP lệch trong ±20%', pct(tot.within), '#0c5dc7', `${fmt(tot.n)} lượt sản phẩm × mốc được đánh giá`)}
      ${card('Hết hàng (mô phỏng)', pct(tot.stockout), tot.stockout == null ? '#65676b' : tot.stockout > 0.1 ? '#dc2626' : '#16a34a', tot.nStock ? `Tồn cuối > 1 kỳ đặt: ${pct(tot.over)} · trên ${fmt(tot.nStock)} lượt` : 'Chưa đủ dữ liệu tồn')}
    </div>

    <section class="mb-5">
      <h3 class="text-[13px] font-semibold text-slate-700 mb-2">Theo mốc <span class="font-normal text-slate-500">— bấm 1 dòng để xem chi tiết sản phẩm</span></h3>
      <div class="bg-white rounded-lg border border-slate-200 overflow-auto">
        <table class="dt text-[12px]">
          <thead><tr>
            <th>Mốc T</th><th>Cửa sổ thực tế</th><th class="c">SP</th>
            <th class="c">Σ Dự báo</th><th class="c">Σ Thực tế</th><th class="c">WAPE</th><th class="c">Bias</th>
            <th class="c">±20%</th><th class="c">Hết hàng</th><th>Tồn tại T</th>
          </tr></thead>
          <tbody>${per.map(({ res, rows }) => {
            const m = metrics(rows);
            const sd = ['MB', 'MN'].filter(k => res.stock_date?.[k]).map(k => `${k} ${res.stock_date[k]}`).join(', ');
            const sel = res.asof === _detailAsof;
            return `<tr class="cursor-pointer hover:bg-slate-50 ${sel ? 'bg-primary-50' : ''}" data-asof="${esc(res.asof)}">
              <td class="font-medium">${esc(res.asof)}</td>
              <td class="nowrap text-slate-500">${rows.length ? esc(uniq(rows, r => r.winLabel)) : '—'}</td>
              <td class="c num">${m.n ? fmt(m.n) : '—'}</td>
              <td class="c num">${m.n ? fmt(m.sF) : '—'}</td>
              <td class="c num">${m.n ? fmt(m.sA) : '<span class="text-slate-400">chưa đủ dữ liệu</span>'}</td>
              <td class="c num font-semibold" style="color:${wapeColor(m.wape)}">${pct(m.wape)}</td>
              <td class="c num" style="color:${biasColor(m.bias)}">${sgnPct(m.bias)}</td>
              <td class="c num">${pct(m.within)}</td>
              <td class="c num">${pct(m.stockout)}</td>
              <td class="text-slate-500 nowrap">${sd ? esc(sd) : '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </section>

    <section class="mb-5">
      <h3 class="text-[13px] font-semibold text-slate-700 mb-1">Theo nhóm sản phẩm</h3>
      <p class="text-[12px] text-slate-500 mb-2">"k1 / k2 tốt nhất" = cặp hệ số (lưới 0–1, bước 0,1) cho WAPE thấp nhất trên mọi mốc đã có thực tế, giữ nguyên cửa sổ. Dùng làm căn cứ đặt override theo nhóm ở tab Cấu hình — nên chạy đủ nhiều mốc để tránh khớp ngẫu nhiên.</p>
      <div class="bg-white rounded-lg border border-slate-200 overflow-auto">
        <table class="dt text-[12px]">
          <thead><tr>
            <th>Nhóm SP</th><th class="c">Lượt SP</th><th class="c">Leadtime / N</th><th class="c">Σ Dự báo</th><th class="c">Σ Thực tế</th>
            <th class="c">WAPE</th><th class="c">Bias</th><th class="c">k1 / k2 đang dùng</th>
            <th class="c">k1 / k2 tốt nhất</th><th class="c">WAPE tốt nhất</th>
          </tr></thead>
          <tbody>${groupTable(allRows)}</tbody>
        </table>
      </div>
    </section>

    <section>
      <div class="flex items-center gap-2 flex-wrap mb-2">
        <h3 class="text-[13px] font-semibold text-slate-700">Chi tiết sản phẩm tại mốc</h3>
        <select id="btDetailAsof" class="ctl-select">${_results.map(r => `<option${r.asof === _detailAsof ? ' selected' : ''}>${esc(r.asof)}</option>`).join('')}</select>
        <input id="btSearch" placeholder="Tìm sản phẩm, nhóm…" aria-label="Tìm sản phẩm" class="ctl-select w-full sm:w-56" value="${esc(_search)}"/>
        <span class="text-[12px] text-slate-500">Sắp theo độ lệch tuyệt đối giảm dần</span>
      </div>
      <div id="btDetail"></div>
    </section>`;

  $$('tr[data-asof]', host).forEach(tr => tr.addEventListener('click', () => { _detailAsof = tr.dataset.asof; render(); }));
  $('#btDetailAsof').addEventListener('change', e => { _detailAsof = e.target.value; render(); });
  $('#btSearch').addEventListener('input', debounce(e => { _search = e.target.value; renderDetail(per); }, 250));
  renderDetail(per);
}
let _search = '';

function groupTable(allRows) {
  const lines = [...groupBy(allRows).entries()]
    .map(([g, rows]) => ({ g, rows, m: metrics(rows) }))
    .filter(x => x.m.n > 0)
    .sort((a, b) => b.m.sA - a.m.sA);
  if (!lines.length) return `<tr><td colspan="10" class="empty-state">Chưa có mốc nào đủ dữ liệu thực tế</td></tr>`;
  const all = { g: 'Tất cả', rows: allRows, m: metrics(allRows) };
  return [all, ...lines].map(({ g, rows, m }, i) => {
    const ev = evaluable(rows);
    const best = bestK(ev);
    return `<tr class="${i === 0 ? 'font-semibold bg-slate-50' : ''}">
      <td>${esc(g)}</td>
      <td class="c num">${fmt(m.n)}</td>
      <td class="c num">${esc(uniq(ev, r => `${r.lt} / ${r.n}`))}</td>
      <td class="c num">${fmt(m.sF)}</td>
      <td class="c num">${fmt(m.sA)}</td>
      <td class="c num" style="color:${wapeColor(m.wape)}">${pct(m.wape)}</td>
      <td class="c num" style="color:${biasColor(m.bias)}">${sgnPct(m.bias)}</td>
      <td class="c num">${esc(uniq(ev, r => `${r.k1} / ${r.k2}`))}</td>
      <td class="c num">${best ? `${best.k1} / ${best.k2}` : '—'}</td>
      <td class="c num" style="color:${wapeColor(best?.wape)}">${best ? pct(best.wape) : '—'}</td>
    </tr>`;
  }).join('');
}

function detailRows(per) {
  const x = per.find(p => p.res.asof === _detailAsof) || per[per.length - 1];
  if (!x) return [];
  const q = _search.trim().toLowerCase();
  return x.rows
    .filter(r => !q || (r.sp || '').toLowerCase().includes(q) || (r.nhom || '').toLowerCase().includes(q))
    .filter(r => Math.round(r.f) !== 0 || (r.a || 0) !== 0 || (r.ton || 0) !== 0)
    .sort((a, b) => Math.abs(b.err ?? 0) - Math.abs(a.err ?? 0) || viCmp(a.sp, b.sp));
}

function renderDetail(per) {
  const box = $('#btDetail');
  if (!box) return;
  const rows = detailRows(per);
  if (!rows.length) { box.innerHTML = '<div class="bg-white rounded-lg border border-slate-200 empty-state">Không có sản phẩm phù hợp</div>'; return; }
  box.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 overflow-auto scroll-area" style="max-height:calc(100vh - 200px)">
    <table class="dt text-[12px]">
      <thead><tr>
        <th>Miền</th><th style="min-width:180px">Sản phẩm</th><th>Nhóm SP</th><th class="c">SKU</th>
        <th class="c" title="TB tháng thực hiện tại mốc">TB TH</th><th class="c" title="TB kế hoạch / tháng">TB KH</th>
        <th class="c">k1 / k2</th><th class="c">Cửa sổ thực tế</th><th class="c">Dự báo</th><th class="c">Thực tế</th><th class="c">Lệch</th><th class="c">Lệch %</th>
        <th class="c">Tồn tại T</th><th class="c">Safety</th><th class="c">Gợi ý</th><th class="c" title="Tồn T + Gợi ý − thực tế từ T đến hết cửa sổ">Tồn cuối</th>
      </tr></thead>
      <tbody>${rows.map(r => {
        const ep = r.a > 0 ? r.err / r.a : null;
        return `<tr class="hover:bg-slate-50">
          <td class="nowrap text-slate-500">${esc(r.mien)}</td>
          <td class="font-medium text-slate-800">${esc(r.sp)}</td>
          <td class="text-slate-600">${esc(r.nhom || '')}</td>
          <td class="c num text-slate-500">${fmt(r.n_sku)}</td>
          <td class="c num">${fmt(r.th)}</td>
          <td class="c num">${fmt(r.kh)}</td>
          <td class="c num text-slate-500">${r.k1} / ${r.k2}</td>
          <td class="c nowrap text-slate-500">${esc(r.winLabel)}</td>
          <td class="c num">${fmt(r.f)}</td>
          <td class="c num font-semibold">${r.a == null ? '—' : fmt(r.a)}</td>
          <td class="c num" style="color:${r.err == null ? '' : r.err > 0 ? '#b45309' : '#dc2626'}">${r.err == null ? '—' : (r.err > 0 ? '+' : '') + fmt(r.err)}</td>
          <td class="c num">${sgnPct(ep)}</td>
          <td class="c num">${r.ton == null ? '—' : fmt(r.ton)}</td>
          <td class="c num text-slate-500">${fmt(r.safety)}</td>
          <td class="c num">${r.goiY == null ? '—' : fmt(r.goiY)}</td>
          <td class="c num font-semibold" style="color:${r.end == null ? '' : r.end < 0 ? '#dc2626' : '#16a34a'}">${r.end == null ? '—' : fmt(r.end)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>
  <div class="mt-2 text-[12px] text-slate-500">${rows.length} sản phẩm · Lệch = Dự báo − Thực tế (dương = dự báo thừa)</div>`;
}

function card(label, value, color, sub) {
  return `<div class="stat-card">
    <div class="stat-card-label"><span class="stat-dot" style="background:${color}"></span>${esc(label)}</div>
    <div class="stat-card-value" style="color:${color}">${value}</div>
    <div class="stat-card-sub">${sub}</div>
  </div>`;
}
const wapeColor = w => w == null ? '#65676b' : w <= 0.3 ? '#16a34a' : w <= 0.5 ? '#d97706' : '#dc2626';
const biasColor = b => b == null ? '#65676b' : Math.abs(b) <= 0.1 ? '#16a34a' : Math.abs(b) <= 0.25 ? '#d97706' : '#dc2626';

// ---------- Excel ----------
async function exportExcel() {
  if (!_results.length) { toast('Chưa có dữ liệu để xuất', 'error'); return; }
  const btn = $('#btExport');
  btn.disabled = true;
  try {
    const XLSX = await loadSheetJS();
    const o = opts();
    const per = _results.map(res => ({ res, rows: evalRows(res, o) }));
    const r3 = v => (v == null || !isFinite(v)) ? '' : Math.round(v * 1000) / 1000;
    const n0 = v => (v == null || !isFinite(v)) ? '' : Math.round(v);

    const s1 = [['Mốc T', 'Số SP', 'Σ Dự báo', 'Σ Thực tế', 'WAPE', 'Bias', 'Tỷ lệ ±20%', 'Hết hàng (mô phỏng)']];
    per.forEach(({ res, rows }) => {
      const m = metrics(rows);
      s1.push([res.asof, m.n, n0(m.sF), n0(m.sA), r3(m.wape), r3(m.bias), r3(m.within), r3(m.stockout)]);
    });

    const allRows = per.flatMap(x => x.rows);
    const s2 = [['Nhóm SP', 'Lượt SP', 'Σ Dự báo', 'Σ Thực tế', 'WAPE', 'Bias', 'k1 tốt nhất', 'k2 tốt nhất', 'WAPE tốt nhất']];
    [['Tất cả', allRows], ...groupBy(allRows).entries()].forEach(([g, rows]) => {
      const m = metrics(rows); if (!m.n) return;
      const b = bestK(evaluable(rows));
      s2.push([g, m.n, n0(m.sF), n0(m.sA), r3(m.wape), r3(m.bias), b?.k1 ?? '', b?.k2 ?? '', r3(b?.wape)]);
    });

    const s3 = [['Mốc T', 'Miền', 'Sản phẩm', 'Nhóm SP', 'BU', 'Số SKU', 'TB TH', 'TB KH', 'k1', 'k2', 'Leadtime', 'Số tháng đặt',
      'Cửa sổ thực tế', 'Dự báo', 'Thực tế', 'Lệch', 'Tồn tại T', 'Safety', 'Gợi ý', 'Tồn cuối',
      ...Array.from({ length: 18 }, (_, i) => `Thực tế T+${i}`)]];
    allRows.forEach(r => s3.push([r.asof, r.mien, r.sp, r.nhom, r.bu, r.n_sku, r3(r.th), r3(r.kh), r.k1, r.k2, r.lt, r.n,
      r.winLabel, n0(r.f), n0(r.a), n0(r.err), n0(r.ton), n0(r.safety), n0(r.goiY), n0(r.end),
      ...r.act.map(v => v == null ? '' : Number(v))]));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), 'Theo mốc');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), 'Theo nhóm');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s3), 'Chi tiết');
    XLSX.writeFile(wb, `kiem_chung_goi_y_${_range.from}_${_range.to}.xlsx`);
    toast('Đã xuất Excel');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
