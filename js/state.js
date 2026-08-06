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
  filters: { grp: '', pl: [], mucDo: [], search: '', lowStock: false, onlyWithQty: false },
  sort: { key: null, dir: 1 },   // 3.7: sắp xếp cột trong từng phân loại (dir 1 tăng, -1 giảm)
};

// ============ QUYỀN THEO VAI TRÒ ============
export function roleLabel(r) {
  return ({
    AM: 'Area Manager', PM: 'Product Manager', MANAGER: 'Manager', ADMIN: 'Admin',
    PURCHASING: 'Mua hàng',
    SALE_MANAGER: 'Area Manager', PRODUCT_MANAGER: 'Product Manager',
  })[r] || r;
}
export function isPurchasing() { return state.user.role === 'PURCHASING'; }
export function isAM() { return state.user.role === 'AM' || state.user.role === 'SALE_MANAGER'; }
export function canApprove() {
  return ['PM', 'MANAGER', 'ADMIN', 'PRODUCT_MANAGER'].indexOf(state.user.role) >= 0;
}
export function canCreateSession() { return state.user.role === 'ADMIN' || state.user.role === 'AM'; }
export function canEditCatalog() { return ['ADMIN', 'PM', 'PRODUCT_MANAGER'].includes(state.user.role); }
