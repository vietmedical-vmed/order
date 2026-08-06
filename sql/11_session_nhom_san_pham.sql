-- ============================================================================
-- Đợt đặt hàng theo NHÓM SẢN PHẨM
-- Thêm cột nhom_san_pham cho order_sessions: đợt chỉ hiển thị danh mục vật tư
-- thuộc nhóm sản phẩm này (khớp dm_vat_tu.nhom_san_pham). NULL = tất cả nhóm
-- (giữ nguyên hành vi cũ cho mọi đợt đã tạo trước đây).
--
-- Chạy 1 lần trên Supabase SQL editor TRƯỚC khi dùng tính năng "chọn nhóm khi tạo đợt".
-- ============================================================================

alter table app_order.order_sessions
  add column if not exists nhom_san_pham text;
