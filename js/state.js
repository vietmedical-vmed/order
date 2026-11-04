// ============ STATE DÙNG CHUNG ============
export const state = {
  token: null,
  user: null,
  mien: 'MB',
  view: 'order',   // mặc định khi login: màn chi tiết ở chế độ "bảng thông tin" (danh mục, không thuộc đợt nào)
  sessions: [],
  currentSession: null,
  rows: [],
  readOnly: true,
  currentAction: null,
  editFields: [],   // [{field, noteField}] các cột số lượng được sửa trực tiếp trên bảng
  changes: new Map(),
  filters: { grp: [], pl: [], csh: '', search: '', onlyWithQty: false },
  sort: { key: null, dir: 1 },   // 3.7: sắp xếp cột trong từng phân loại (dir 1 tăng, -1 giảm)
};

// ============ QUYỀN THEO VAI TRÒ ============
// Role luôn là 1 trong 5 mã ADMIN | MANAGER | AM | PM | PURCHASING: order-login và order-api
// đã map role gốc của bảng users (sale_manager, product_manager, …) về các mã này,
// nên frontend không cần xử lý alias. Quyền ở đây chỉ để ẩn/hiện UI — server chặn từng RPC.
export function roleLabel(r) {
  return ({
    AM: 'Area Manager', PM: 'Product Manager', MANAGER: 'Manager', ADMIN: 'Admin',
    PURCHASING: 'Mua hàng',
  })[r] || r;
}
export function isPurchasing() { return state.user.role === 'PURCHASING'; }
export function isAM() { return state.user.role === 'AM'; }
// Miền AM phụ trách: users.mien có thể là "MB, MN"; BOTH/ALL/rỗng = cả 2 miền.
export function userMiens() {
  const list = String(state.user.mien || '').split(/[,;]/).map(x => x.trim().toUpperCase()).filter(Boolean);
  return !list.length || list.includes('BOTH') || list.includes('ALL') ? ['MB', 'MN'] : list;
}
export function canApprove() {
  return ['PM', 'MANAGER', 'ADMIN'].includes(state.user.role);
}
export function canCreateSession() { return state.user.role === 'ADMIN' || state.user.role === 'AM'; }
// Khớp listCatalog / saveCatalog trên order-api (PM bị server giới hạn theo scope).
export function canEditCatalog() { return ['ADMIN', 'MANAGER', 'PM'].includes(state.user.role); }
