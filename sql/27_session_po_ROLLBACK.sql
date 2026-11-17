-- =====================================================================
--  ROLLBACK 27 — bỏ bảng order_session_po.
--  Cột tóm tắt order_sessions.po / de_nghi_mua_hang vẫn giữ giá trị gộp
--  ("PO1; PO2") nên không mất thông tin số PO, chỉ mất tách dòng + ghi chú.
--  Cần deploy lại order-api bản trước commit thêm danh sách PO.
-- =====================================================================
begin;

drop table if exists app_order.order_session_po;

commit;
