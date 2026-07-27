// ============ MÀN NHẬT KÝ (chỉ Admin) ============
import { $, esc, fmtDate, debounce } from '../utils.js';
import { rpc } from '../api.js';
import { askConfirm } from '../modal.js';

const ACTION_LABELS = {
  LOGIN: 'Đăng nhập', LOGOUT: 'Đăng xuất', CHANGE_PASSWORD: 'Đổi mật khẩu',
  PLACE_ORDER: 'Đặt hàng', PLACE_ORDER_BUSY: 'Bị khoá',
  APPROVE: 'Duyệt SKU', CLOSE_SESSION: 'Chốt đợt', CREATE_SESSION: 'Tạo đợt',
  CONFIG_CATALOG: 'Cấu hình danh mục', SAVE_CONFIG: 'Cấu hình công thức',
  AM_CONFIRM: 'AM xác nhận', PM_CONFIRM: 'PM xác nhận', PM_APPROVE: 'PM phê duyệt',
  MANAGER_APPROVE: 'Manager phê duyệt', REJECT: 'Từ chối', EXPORT: 'Xuất Excel', PURCHASE: 'Đặt hàng (DM/PO)',
};

export async function initAuditView() {
  $('#lAction').addEventListener('change', renderAudit);
  $('#lSearch').addEventListener('input', debounce(renderAudit, 300));
  $('#lRefresh').addEventListener('click', renderAudit);
  await renderAudit();
}

async function renderAudit() {
  const host = $('#auditHost');
  host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 p-4" aria-busy="true">
    ${'<div class="skeleton-line"></div>'.repeat(6)}</div>`;
  try {
    const logs = await rpc('loadAuditLog', { action: $('#lAction').value, username: $('#lSearch').value, limit: 200 });
    if (!Array.isArray(logs)) {
      throw new Error(`Server trả về ${logs === null ? 'null' : typeof logs} thay vì danh sách log.`);
    }
    if (!logs.length) {
      host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state">Chưa có log
        <div class="mt-3"><button id="auditPingBtn" class="ctl-btn" type="button">Test ping server</button></div>
      </div>`;
      bindAuditPing();
      return;
    }

    // Lấy meta resolve riêng (ho_ten / ten_dot / mien) — nếu fail thì hiển thị thô
    let meta = { userMap: {}, sessMap: {} };
    try {
      meta = await rpc('resolveAuditMeta');
    } catch (e) {
      console.warn('resolveAuditMeta fail, hiển thị thô:', e);
    }

    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 overflow-x-auto scroll-area">
      <table class="dt">
        <thead><tr>
          <th>Thời gian</th><th>Người dùng</th><th>Thao tác</th><th class="hidden md:table-cell">Đợt</th><th class="hidden md:table-cell">Chi tiết</th>
        </tr></thead>
        <tbody>${logs.map(l => {
          const cls = l.action === 'PLACE_ORDER_BUSY' ? 'pill-hot'
                    : (l.action === 'APPROVE' || l.action === 'CLOSE_SESSION') ? 'pill-mid'
                    : (l.action === 'LOGIN' || l.action === 'PLACE_ORDER') ? 'pill-ok'
                    : 'pill-low';
          const ho_ten = (meta.userMap && meta.userMap[l.username.toLowerCase()]) || l.username;
          const sess = (meta.sessMap && meta.sessMap[l.session_id]) || {};
          const mien = sess.mien || '';
          return `<tr>
            <td class="text-slate-600">${fmtDate(l.timestamp)}</td>
            <td><div class="font-medium text-slate-800">${esc(ho_ten)}</div><div class="text-[11px] text-slate-500">${esc(l.username)}</div></td>
            <td><span class="pill ${cls}">${esc(ACTION_LABELS[l.action] || l.action)}</span></td>
            <td class="text-slate-600 hidden md:table-cell">${esc(sess.ten_dot || '—')}${mien ? ' · ' + mien : ''}</td>
            <td class="text-slate-500 text-[11.5px] hidden md:table-cell">${esc(l.detail || '')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
  } catch (e) {
    console.error('[renderAudit] error:', e);
    host.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 empty-state text-danger-600">
      <div class="font-medium mb-2">Lỗi: ${esc(e.message)}</div>
      <button id="auditRetry" class="ctl-btn" type="button">Thử lại</button>
      <button id="auditPingBtn" class="ctl-btn" type="button">Test ping server</button>
      <div class="text-[11px] text-slate-500 mt-3">Bấm Test ping → nếu OK thì server deploy đúng. Lỗi là trong loadAuditLog — xem log Supabase Edge Function.</div>
    </div>`;
    const retry = $('#auditRetry');
    if (retry) retry.onclick = () => renderAudit();
    bindAuditPing();
  }
}

function bindAuditPing() {
  const btn = $('#auditPingBtn');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Đang test…';
    try {
      const r = await rpc('auditPing');
      if (Array.isArray(r) && r.length > 0) {
        await askConfirm({ title: 'Test ping server', infoOnly: true, message: '✓ Deploy server OK!\n\nNhận được:\n' + JSON.stringify(r, null, 2) + '\n\nNếu loadAuditLog vẫn lỗi → vấn đề trong code function. Xem log Supabase Edge Function.' });
      } else {
        await askConfirm({ title: 'Test ping server', infoOnly: true, message: '✗ auditPing trả về: ' + JSON.stringify(r) + '\n\nĐiều này chứng tỏ deploy chưa cập nhật code mới. Cần chạy supabase functions deploy order-api.' });
      }
    } catch (e) {
      await askConfirm({ title: 'Test ping server', infoOnly: true, danger: true, message: '✗ auditPing lỗi: ' + e.message + '\n\nHàm auditPing chưa tồn tại = chưa deploy. Hoặc lỗi auth.' });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test ping server';
    }
  };
}
