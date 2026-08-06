-- ============================================================================
-- Đợt đặt hàng theo NHÓM SẢN PHẨM
-- Thêm cột nhom_san_pham cho order_sessions: đợt chỉ hiển thị danh mục vật tư
-- thuộc các nhóm sản phẩm này (khớp dm_vat_tu.nhom_san_pham). Chọn được NHIỀU nhóm,
-- lưu dạng "Khớp UOC;Cột sống Ulrich". NULL/rỗng = tất cả nhóm (giữ hành vi cũ).
--
-- Chạy 1 lần trên Supabase SQL editor TRƯỚC khi dùng tính năng "chọn nhóm khi tạo đợt".
-- ============================================================================

alter table app_order.order_sessions
  add column if not exists nhom_san_pham text;
