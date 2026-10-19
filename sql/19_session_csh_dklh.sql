-- =====================================================================
--  Đợt đặt hàng theo chủ sở hữu ĐKLH (xuất xứ).
--  order_sessions.csh_dklh: chủ sở hữu đã chọn khi tạo đợt (vd 'Arthrex').
--    NULL = đợt không áp dụng (miền/nhóm chưa bật filter CSH)
--  Khi có giá trị: màn Đặt hàng + Excel chỉ hiện mã có lô của CSH đó (mã không có
--  tồn hoặc chỉ có lô chưa điền CSH thì không hiện), và
--  Tồn kho (DA) / Vét thầu (GU) / Tổng tồn / Gợi ý tính theo lô của CSH đó
--  (chỉ áp cho các nhóm đang bật filter CSH; nhóm khác giữ nguyên).
-- =====================================================================
alter table app_order.order_sessions add column if not exists csh_dklh text;
