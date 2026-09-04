// Điều hướng giữa 5 màn hình — mỗi màn là 1 <template> trong index.html.
import { $ } from './utils.js';
import { state } from './state.js';
import { destroyOrderTable } from './table-sticky.js';
import { initOrderView } from './views/order.js';
import { initApprovalView } from './views/manage.js';
import { initAuditView } from './views/audit.js';
import { initConfigView } from './views/config.js';
import { initCatalogView } from './views/catalog.js';

const VIEWS = {
  order: initOrderView,
  approval: initApprovalView,
  audit: initAuditView,
  config: initConfigView,
  catalog: initCatalogView,
};

export function renderView() {
  destroyOrderTable();   // dọn header nổi + observer của màn trước

  const main = $('#main');
  main.innerHTML = '';
  const tpl = $('#tpl-' + state.view);
  if (!tpl) { main.innerHTML = '<div class="empty-state">Màn hình không tồn tại</div>'; return; }
  main.appendChild(tpl.content.cloneNode(true));

  const fb = $('#orderFilterBar');
  if (fb) fb.classList.toggle('hidden', state.view !== 'order');

  const init = VIEWS[state.view];
  if (init) init();
}
