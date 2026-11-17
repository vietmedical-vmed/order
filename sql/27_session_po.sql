-- =====================================================================
--  27 — Nhiều PO cho một đợt đặt hàng (order_session_po)
--
--  Trước: order_sessions.po / de_nghi_mua_hang chỉ chứa 1 giá trị.
--  Sau:  mỗi PO là 1 dòng trong app_order.order_session_po. Mua hàng thêm/xóa
--  PO khi đợt APPROVED (hoặc COMPLETED), rồi bấm "Hoàn thành đợt" (cần >= 1 PO).
--  order_sessions.po / de_nghi_mua_hang GIỮ LẠI làm cột tóm tắt ("PO1; PO2"),
--  do order-api cập nhật mỗi lần thêm/xóa PO -> danh sách đợt, email, Excel
--  không phải đổi cách đọc.
--
--  Dữ liệu cũ: đợt nào đã có po -> chuyển thành 1 dòng PO.
--  Rollback: 27_session_po_ROLLBACK.sql
-- =====================================================================
begin;

create table if not exists app_order.order_session_po (
  po_id            uuid primary key default gen_random_uuid(),
  session_id       uuid not null references app_order.order_sessions(session_id) on delete cascade,
  po               text not null check (btrim(po) <> ''),
  de_nghi_mua_hang text,
  ghi_chu          text,
  tao_boi          text,
  tao_luc          timestamptz not null default now(),
  -- 1 số PO chỉ ghi 1 lần trong 1 đợt; index này cũng phục vụ lọc theo session_id.
  constraint order_session_po_session_po_key unique (session_id, po)
);

-- Chỉ order-api (service_role) đọc/ghi; RLS bật, không policy -> anon/authenticated bị chặn.
alter table app_order.order_session_po enable row level security;

insert into app_order.order_session_po (session_id, po, de_nghi_mua_hang, tao_boi, tao_luc)
select s.session_id, btrim(s.po), nullif(btrim(s.de_nghi_mua_hang), ''),
       s.nguoi_mua_hang, coalesce(s.ngay_mua_hang, now())
  from app_order.order_sessions s
 where coalesce(btrim(s.po), '') <> ''
on conflict (session_id, po) do nothing;

commit;
