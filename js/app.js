// ============ ĐIỂM VÀO ỨNG DỤNG ============
// index.html chỉ còn markup; toàn bộ JS nằm ở js/*.js (ES modules, xem mục 6.1 của
// OPTIMIZATION_PLAN.md). Thứ tự khởi động: boot → thử token sẵn có → showApp / showLogin.
import { $, $$, esc } from './utils.js';
import { TOKEN_KEY } from './config.js';
import { API_BASE, rpc, rpcRaw, fetchWithTimeout, headers, setAuthLostHandler } from './api.js';
import { state, roleLabel, canApprove, canCreateSession, canEditCatalog, isAM, isPurchasing } from './state.js';
import { toast } from './toast.js';
import { askConfirm } from './modal.js';
import { scheduleTokenExpiryWarning, clearTokenExpiryWarning } from './auth.js';
import { loadSessions } from './session.js';
import { renderView } from './router.js';
import { bindGlobalDraftActions } from './views/order.js';
setAuthLostHandler(() => showLogin());

// 3.1: chặn mất dữ liệu khi đóng tab/refresh lúc đang có thay đổi chưa lưu.
window.addEventListener('beforeunload', e => {
  if (state.changes.size || state.catalogDirty?.size) { e.preventDefault(); e.returnValue = ''; }
});

window.addEventListener('DOMContentLoaded', async () => {
  const boot = $('#boot');
  if (boot) boot.remove();
  try {
    // Bypass đăng nhập khi vào từ portal: ưu tiên token dùng chung (vmed_token),
    // fallback token riêng của app. Có token hợp lệ -> vào thẳng, bỏ qua màn login.
    const candidates = [...new Set([
      localStorage.getItem('vmed_token'),
      localStorage.getItem(TOKEN_KEY),
    ].filter(Boolean))];
    for (const tk of candidates) {
      state.token = tk;
      try {
        const u = await rpc('getCurrentUser');
        if (!u || !u.username) throw new Error('User trống từ server');
        state.user = u;
        localStorage.setItem(TOKEN_KEY, tk); // đồng bộ để phần còn lại của app dùng chung
        await safeShowApp();
        return;
      } catch (e) {
        console.error('[boot] token bypass fail:', e);
      }
    }
    state.token = null;
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
  } catch (e) {
    console.error('[boot] fatal:', e);
    // Fallback: hiện thông báo lỗi + lối thoát xoá phiên
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:Inter,sans-serif">
        <div style="background:#fff;border:1px solid #f5aab0;border-radius:12px;padding:24px;max-width:480px;text-align:center">
          <div style="color:#c81f3d;font-weight:600;font-size:15px;margin-bottom:8px">Lỗi khởi động ứng dụng</div>
          <div style="color:#65676b;font-size:13px;margin-bottom:16px">${esc(e.message)}</div>
          <button onclick="localStorage.removeItem('${TOKEN_KEY}');location.reload()"
            style="background:#1877f2;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px">
            Xoá phiên đăng nhập và tải lại
          </button>
        </div>
      </div>`;
  }
});

async function safeShowApp() {
  try {
    await showApp();
  } catch (e) {
    console.error('[showApp] fail:', e);
    // Reset về login nếu showApp bị crash
    const app = $('#app'); if (app) app.classList.add('hidden');
    const login = $('#loginScreen'); if (login) login.classList.remove('hidden');
    $('#loginErr').textContent = 'Lỗi khởi động: ' + e.message + '. Hãy đăng nhập lại.';
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
  }
}

function showLogin() {
  $('#loginScreen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#loginErr').textContent = '';
  // Không còn phiên nào để cảnh báo hết hạn -> huỷ hẹn giờ + ẩn banner cũ (nếu có).
  clearTokenExpiryWarning();
  const banner = $('#banner'); if (banner) { banner.classList.add('hidden'); banner.textContent = ''; }
  // Luôn hiện form đăng nhập (không kẹt ở form đổi mật khẩu nếu lần trước có mở).
  $('#loginForm').classList.remove('hidden');
  const _pf = $('#pwForm'); if (_pf) _pf.classList.add('hidden');
  // Reset nút về trạng thái sẵn sàng — nếu không, sau khi đăng nhập thành công rồi
  // đăng xuất, nút vẫn kẹt ở disabled + "Đang đăng nhập…".
  const _lb = $('#loginBtn');
  if (_lb) { _lb.disabled = false; _lb.textContent = 'Đăng nhập'; }
  const _lp = $('#loginPass'); if (_lp) _lp.value = '';
  $('#loginUser').focus();

  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const u = $('#loginUser').value.trim();
    const p = $('#loginPass').value;
    if (!u || !p) return;
    $('#loginBtn').disabled = true;
    $('#loginBtn').textContent = 'Đang đăng nhập…';
    $('#loginErr').textContent = '';
    try {
      const res = await rpcRaw('login', u, p);
      state.token = res.token;
      state.user = res.user;
      localStorage.setItem(TOKEN_KEY, res.token);
      showApp();
    } catch (e) {
      $('#loginErr').textContent = e.message;
      $('#loginBtn').disabled = false;
      $('#loginBtn').textContent = 'Đăng nhập';
    }
  };

  // ---- Đổi mật khẩu (ngay ở màn login, chưa cần đăng nhập) ----
  const showPwForm = (show) => {
    $('#loginForm').classList.toggle('hidden', show);
    $('#pwForm').classList.toggle('hidden', !show);
    $('#pwErr').textContent = '';
    if (show) {
      $('#pwUser').value = $('#loginUser').value.trim();
      $('#pwOld').value = ''; $('#pwNew').value = ''; $('#pwNew2').value = '';
      ($('#pwUser').value ? $('#pwOld') : $('#pwUser')).focus();
    }
  };
  $('#toChangePw').onclick = () => showPwForm(true);
  $('#pwCancel').onclick = () => showPwForm(false);

  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const u = $('#pwUser').value.trim();
    const oldP = $('#pwOld').value;
    const newP = $('#pwNew').value;
    const newP2 = $('#pwNew2').value;
    $('#pwErr').textContent = '';
    if (!u || !oldP || !newP) return;
    if (newP.length < 6) { $('#pwErr').textContent = 'Mật khẩu mới tối thiểu 6 ký tự'; return; }
    if (newP !== newP2) { $('#pwErr').textContent = 'Nhập lại mật khẩu mới không khớp'; return; }
    if (newP === oldP) { $('#pwErr').textContent = 'Mật khẩu mới phải khác mật khẩu hiện tại'; return; }
    $('#pwBtn').disabled = true;
    $('#pwBtn').textContent = 'Đang đổi…';
    try {
      await rpcRaw('changePassword', u, oldP, newP);
      showPwForm(false);
      $('#loginUser').value = u;
      $('#loginPass').value = '';
      $('#loginPass').focus();
      toast('Đổi mật khẩu thành công — hãy đăng nhập lại');
    } catch (e) {
      $('#pwErr').textContent = e.message;
    } finally {
      $('#pwBtn').disabled = false;
      $('#pwBtn').textContent = 'Đổi mật khẩu';
    }
  };
}

async function showApp() {
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  try { setupUserUI(); } catch (e) { console.error('setupUserUI:', e); }
  try { bindNav(); } catch (e) { console.error('bindNav:', e); }
  try { bindLogout(); } catch (e) { console.error('bindLogout:', e); }
  try { bindGlobalDraftActions(); } catch (e) { console.error('bindGlobalDraftActions:', e); }
  try { scheduleTokenExpiryWarning(); } catch (e) { console.error('scheduleTokenExpiryWarning:', e); }
  try {
    // Highlight đúng tab mặc định theo state.view
    $$('.nav-tab').forEach(x => x.classList.toggle('active', x.dataset.view === state.view));
    await loadSessions();
    renderView();
  } catch (e) {
    console.error('loadSessions/renderView:', e);
    const main = $('#main');
    if (main) main.innerHTML = `<div class="empty-state text-danger-600">Lỗi: ${esc(e.message)}</div>`;
  }
}

function setupUserUI() {
  const u = state.user;
  $('#userMeta').textContent = roleLabel(u.role);
  $('#userName').textContent = u.ho_ten;
  document.body.classList.toggle('is-approver', canApprove());
  document.body.classList.toggle('is-creator', canCreateSession());
  document.body.classList.toggle('is-admin', u.role === 'ADMIN');
  document.body.classList.toggle('is-am', isAM());
  document.body.classList.toggle('is-purchasing', isPurchasing());

  // Default mien theo role: AM khoá theo miền của mình; ADMIN/PM/MANAGER → 'ALL'
  state.mien = isAM() ? (u.mien || 'MB') : 'ALL';
}

function bindLogout() {
  $('#btnLogout').onclick = async () => {
    if (state.changes.size > 0 && !(await askConfirm({ title: 'Đăng xuất', message: 'Có thay đổi chưa lưu. Đăng xuất sẽ mất. Tiếp tục?', danger: true }))) return;
    const oldToken = state.token;
    localStorage.removeItem(TOKEN_KEY);
    state.token = null; state.user = null; state.changes.clear();
    showLogin();
    // Báo server biết (best-effort) — không chờ, không chặn UI dù server chậm/treo
    if (oldToken) {
      fetchWithTimeout(API_BASE + '/order-api', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ action: 'logout', token: oldToken, args: [] })
      }).catch(() => {});
    }
  };
}

function bindNav() {
  // "Cấu hình danh mục": Admin + PM (PM chỉ thao tác vật tư trong nhóm mình phụ trách — backend đã giới hạn scope).
  const okCatalog = canEditCatalog();
  $$('.nav-tab').forEach(a => {
    // AM/Mua hàng được xem tab "Quản lý đặt hàng" (chỉ xem); các tab approver khác vẫn ẩn.
    const isManageTab = a.dataset.view === 'approval';
    const okApprover = canApprove() || (isManageTab && (isAM() || isPurchasing()));
    // Ẩn các tab cần quyền user không có
    if (a.dataset.need === 'approver' && !okApprover) a.style.display = 'none';
    if (a.dataset.need === 'admin' && state.user.role !== 'ADMIN') a.style.display = 'none';
    if (a.dataset.need === 'catalog' && !okCatalog) a.style.display = 'none';

    a.addEventListener('click', e => {
      e.preventDefault();
      if (a.dataset.need === 'approver' && !okApprover) return;
      if (a.dataset.need === 'admin' && state.user.role !== 'ADMIN') return;
      if (a.dataset.need === 'catalog' && !okCatalog) return;
      $$('.nav-tab').forEach(x => {
        x.classList.remove('active');
        x.setAttribute('aria-current', 'false');
      });
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
      state.view = a.dataset.view;
      renderView();
    });
  });
}
