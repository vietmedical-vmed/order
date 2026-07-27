// ============ ĐÔNG CỨNG CỘT + HEADER NỔI (bảng màn đặt hàng) ============
// 1.5: vẫn giữ cách cuộn theo cả trang (không chuyển .group-body thành khung cuộn dọc riêng),
// nhưng bỏ hẳn kiểu "mỗi tick cuộn gọi getBoundingClientRect cho mọi card":
//   · IntersectionObserver lọc trước các card đang thực sự nằm trong viewport;
//   · toạ độ bảng được ĐO 1 LẦN rồi cache (chỉ đo lại khi resize / mở nhóm / render lại),
//     nên handler cuộn chỉ còn phép tính số học + đổi display/transform, không đọc layout;
//   · scrollLeft cache theo listener của chính khung cuộn ngang.
import { $$ } from './utils.js';

// { card, body, table, container, cloneTable, top, bottom, left, width, sx, visible }
let registry = [];
let observer = null;
let rafId = 0;
let headerOffset = 96;
let metricsDirty = true;
let dragMoved = false;

// Cho phép màn đặt hàng phân biệt "click để sắp xếp" với "kéo ngang thead để cuộn".
export function didDrag() { return dragMoved; }

// ============ ĐO & KHOÁ BỀ RỘNG CỘT ============
// Đo bề rộng thực (table-layout auto) rồi ghim bằng <colgroup> + table-layout fixed.
// Nhờ đó header (kể cả clone nổi) và thân bảng luôn khớp cột, không bị co lệch.
export function lockColumnWidths(root) {
  const scope = (root && root.querySelectorAll) ? root : document;
  scope.querySelectorAll('.group-body table.dt').forEach(tbl => {
    const hr = tbl.tHead && tbl.tHead.rows[0];
    if (!hr || !hr.cells.length) return;
    // Đo khi đang auto (tạm bỏ fixed nếu đã set từ lần trước) để lấy bề rộng tự nhiên
    tbl.style.tableLayout = 'auto';
    tbl.style.width = '';
    const existing = tbl.querySelector('colgroup');
    if (existing) existing.remove();
    const widths = [];
    for (const c of hr.cells) {
      const w = c.getBoundingClientRect().width;
      if (!w) return; // bảng ẩn → bỏ qua, sẽ khoá lại khi mở
      widths.push(Math.round(w));
    }
    const cg = document.createElement('colgroup');
    widths.forEach(w => {
      const col = document.createElement('col');
      col.style.width = w + 'px';
      cg.appendChild(col);
    });
    tbl.insertBefore(cg, tbl.firstChild);
    tbl.style.tableLayout = 'fixed';
    tbl.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
    tbl.__colWidths = widths; // clone nổi dùng lại
  });
  metricsDirty = true;
}

// Tính left offset cho các cột đông cứng theo bề rộng cột đã khoá.
// Ghi vào CSS var trên từng <table> để mọi cell con dùng chung; clone nổi copy lại các var này.
export function applyStickyCols(root) {
  const scope = (root && root.querySelectorAll) ? root : document;
  scope.querySelectorAll('.group-body table.dt').forEach(tbl => {
    const w = tbl.__colWidths;
    let w1, w2, w3;
    if (w && w.length >= 3) {
      [w1, w2, w3] = w;
    } else {
      const hr = tbl.tHead && tbl.tHead.rows[0];
      if (!hr || hr.cells.length < 4) return;
      w1 = hr.cells[0].getBoundingClientRect().width;
      w2 = hr.cells[1].getBoundingClientRect().width;
      w3 = hr.cells[2].getBoundingClientRect().width;
    }
    if (!w1) return; // bảng đang ẩn
    tbl.style.setProperty('--l1', '0px');
    tbl.style.setProperty('--l2', w1 + 'px');
    tbl.style.setProperty('--l3', (w1 + w2) + 'px');
    tbl.style.setProperty('--l4', (w1 + w2 + w3) + 'px');
  });
  // Đồng bộ var sang các clone nổi đang tồn tại
  document.querySelectorAll('.floating-thead-container table.dt').forEach(clone => {
    const card = clone.__srcCard;
    const src = card && card.querySelector('.group-body table.dt');
    if (!src) return;
    ['--l1', '--l2', '--l3', '--l4'].forEach(v => {
      const val = src.style.getPropertyValue(v);
      if (val) clone.style.setProperty(v, val);
    });
  });
}

// Đồng bộ chiều rộng inner của scroll-top-bar với table.scrollWidth
export function syncScrollWidths() {
  $$('.group-card').forEach(card => {
    const body = card.querySelector('[data-scroll-body]');
    const top = card.querySelector('[data-scroll-top]');
    if (!body || !top) return;
    const table = body.querySelector('table');
    const inner = top.querySelector('.scroll-top-inner');
    if (!table || !inner) return;
    inner.style.width = table.scrollWidth + 'px';
  });
}

// ============ HEADER NỔI ============
function applyCloneX(entry, sx) {
  entry.sx = sx;
  entry.container.style.setProperty('--sx', sx + 'px');
  entry.cloneTable.style.transform = 'translateX(' + (-sx) + 'px)';
}

function measure() {
  const y = window.scrollY;
  registry.forEach(e => {
    const r = e.body.getBoundingClientRect();
    e.top = r.top + y;
    e.bottom = r.bottom + y;
    e.left = r.left;
    e.width = r.width;
  });
  metricsDirty = false;
}

function update() {
  if (!registry.length) return;
  if (metricsDirty) measure();
  const y = window.scrollY;
  registry.forEach(e => {
    const show = e.visible && (e.top - y) < headerOffset && (e.bottom - y) > headerOffset + 40;
    if (!show) {
      if (e.shown) { e.container.style.display = 'none'; e.shown = false; }
      return;
    }
    if (!e.shown) { e.container.style.display = 'block'; e.shown = true; }
    if (e.appliedLeft !== e.left) { e.container.style.left = e.left + 'px'; e.appliedLeft = e.left; }
    if (e.appliedWidth !== e.width) { e.container.style.width = e.width + 'px'; e.appliedWidth = e.width; }
  });
}

function scheduleUpdate() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; update(); });
}

// Đánh dấu cần đo lại (mở/đóng nhóm, render lại thân bảng…) rồi vẽ lại header nổi.
export function invalidateTableMetrics() {
  metricsDirty = true;
  scheduleUpdate();
}

export function destroyOrderTable() {
  document.querySelectorAll('.floating-thead-container').forEach(el => el.remove());
  if (observer) { observer.disconnect(); observer = null; }
  registry = [];
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function buildFloatingHeaders() {
  const pageHeader = document.querySelector('header.sticky') || document.querySelector('header');
  headerOffset = pageHeader ? pageHeader.offsetHeight : 96;

  observer = new IntersectionObserver(entries => {
    entries.forEach(en => {
      const e = registry.find(x => x.body === en.target);
      if (e) e.visible = en.isIntersecting;
    });
    invalidateTableMetrics();
  });

  $$('.group-card').forEach(card => {
    const body = card.querySelector('[data-scroll-body]');
    if (!body) return;
    const table = body.querySelector('table');
    const thead = table && table.querySelector('thead');
    if (!table || !thead) return;

    const container = document.createElement('div');
    container.className = 'floating-thead-container';
    container.style.cssText = `position: fixed; top: ${headerOffset}px; overflow: hidden; z-index: 15; display: none; pointer-events: none;`;
    container.setAttribute('aria-hidden', 'true');   // 4.3: bản sao trang trí, screen reader đọc thead thật

    const cloneTable = document.createElement('table');
    cloneTable.className = 'dt';
    cloneTable.__srcCard = card; // để applyStickyCols đồng bộ var offset
    // Copy CSS var offset của cột đông cứng từ bảng gốc sang clone
    ['--l1', '--l2', '--l3', '--l4'].forEach(v => {
      const val = table.style.getPropertyValue(v);
      if (val) cloneTable.style.setProperty(v, val);
    });
    // Khoá bề rộng cột giống bảng gốc (đã đo & lock) → header clone khớp thân bảng
    const colW = table.__colWidths;
    if (colW && colW.length) {
      const cg = document.createElement('colgroup');
      colW.forEach(w => { const col = document.createElement('col'); col.style.width = w + 'px'; cg.appendChild(col); });
      cloneTable.appendChild(cg);
      cloneTable.style.tableLayout = 'fixed';
      cloneTable.style.width = colW.reduce((a, b) => a + b, 0) + 'px';
    } else {
      cloneTable.style.tableLayout = getComputedStyle(table).tableLayout || 'auto';
    }
    cloneTable.appendChild(thead.cloneNode(true));
    container.appendChild(cloneTable);
    document.body.appendChild(container);

    const entry = { card, body, table, container, cloneTable, visible: true, shown: false, sx: 0, top: 0, bottom: 0, left: 0, width: 0 };
    registry.push(entry);
    observer.observe(body);
    applyCloneX(entry, body.scrollLeft);
  });

  metricsDirty = true;
  update();
}

// ============ CUỘN NGANG ĐỒNG BỘ + KÉO THEAD ============
// Listener cấp document chỉ gắn 1 lần cho cả vòng đời trang (trước đây mỗi lần render bảng
// lại gắn thêm 1 cặp mousemove/mouseup mới → tích tụ dần).
let dragTarget = null;   // { body, thead, startX, startScrollLeft }

function bindGlobalDragHandlers() {
  document.addEventListener('mousemove', e => {
    if (!dragTarget) return;
    e.preventDefault();
    const dx = e.pageX - dragTarget.startX;
    if (Math.abs(dx) > 3) dragMoved = true;
    dragTarget.body.scrollLeft = dragTarget.startScrollLeft - dx;
  });
  document.addEventListener('mouseup', () => {
    if (!dragTarget) return;
    dragTarget.thead.classList.remove('grabbing');
    dragTarget = null;
  });
  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { applyStickyCols(); invalidateTableMetrics(); }, 150);
  }, { passive: true });
}
bindGlobalDragHandlers();

function bindCardScroll(card) {
  // setupOrderTable() còn được gọi lại khi mở nhóm (card cũ vẫn nguyên) → chống bind chồng.
  if (card.__scrollBound) return;
  const body = card.querySelector('[data-scroll-body]');
  const top = card.querySelector('[data-scroll-top]');
  if (!body || !top) return;
  card.__scrollBound = true;

  // 2-way sync scrollLeft (top bar ↔ body)
  let syncing = false;
  top.addEventListener('scroll', () => {
    if (syncing) return; syncing = true;
    body.scrollLeft = top.scrollLeft;
    requestAnimationFrame(() => { syncing = false; });
  });
  body.addEventListener('scroll', () => {
    if (!syncing) {
      syncing = true;
      top.scrollLeft = body.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    }
    const e = registry.find(x => x.body === body);
    if (e) applyCloneX(e, body.scrollLeft);
  });

  // Kéo ngang trên thead để cuộn bảng
  const thead = body.querySelector('thead');
  if (!thead) return;
  thead.addEventListener('mousedown', e => {
    if (e.target.closest('input, button, a, select')) return;
    dragMoved = false;
    dragTarget = { body, thead, startX: e.pageX, startScrollLeft: body.scrollLeft };
    thead.classList.add('grabbing');
    e.preventDefault();
  });
}

// Gọi sau mỗi lần render lại thân bảng đặt hàng.
export function setupOrderTable() {
  destroyOrderTable();
  $$('.group-card').forEach(bindCardScroll);
  lockColumnWidths();
  syncScrollWidths();
  applyStickyCols();
  buildFloatingHeaders();
}
