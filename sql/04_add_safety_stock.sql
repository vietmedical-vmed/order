-- =====================================================================
--  04_add_safety_stock.sql  —  Thêm cột "Safety stock" (tồn kho an toàn)
--  Cấu hình per vật tư trên màn "Cấu hình danh mục", hiển thị ở màn
--  chi tiết đặt hàng. Số nguyên không âm (mặc định 0).
-- =====================================================================

alter table public.dm_vat_tu
  add column if not exists safety_stock integer not null default 0;
