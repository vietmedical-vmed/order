-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK cho 15_master_data_dictionary.sql
-- Trả DB về trạng thái trước: bỏ trigger/hàm/bảng từ điển, bỏ cột bu_code mới
-- thêm, khôi phục order_sessions.bu từ bảng backup.
--
-- KHÔNG hoàn tác: giá trị bu_code đã backfill vào dm_vat_tu / dm_ps (trước đó
-- là '' hoặc NULL — vô hại). Muốn trả nguyên trạng thì bỏ comment khối (*).
-- Chạy SAU khi đã rollback code order-api (nếu đã deploy bản đọc dm_bu).
-- ════════════════════════════════════════════════════════════════════════

begin;

-- order_sessions.bu: giá trị cũ
update app_order.order_sessions s
   set bu = b.bu_cu
  from app_order.bak_20261002_session_bu b
 where s.session_id::text = b.session_id;
drop table if exists app_order.bak_20261002_session_bu;

-- Trigger + hàm điền bu_code
do $$
declare
  t text;
begin
  foreach t in array array[
    'dm_vat_tu', 'dm_nhom_san_pham', 'dm_san_pham_tong',
    'dm_bo_vat_tu', 'dm_bo_vat_tu_mapping', 'dm_ps'
  ] loop
    execute format('drop trigger if exists trg_fill_bu_code on shared.%I', t);
  end loop;
end
$$;
drop function if exists shared.trg_fill_bu_code();

-- Cột bu_code mới thêm (dm_vat_tu, dm_ps có từ trước → giữ)
alter table shared.dm_nhom_san_pham     drop column if exists bu_code;
alter table shared.dm_san_pham_tong     drop column if exists bu_code;
alter table shared.dm_bo_vat_tu         drop column if exists bu_code;
alter table shared.dm_bo_vat_tu_mapping drop column if exists bu_code;
alter table shared.dm_vat_tu alter column bu_code set default '';

-- (*) Trả bu_code backfill về rỗng — thường KHÔNG cần:
-- update shared.dm_vat_tu set bu_code = '' where ...;

-- Từ điển
drop function if exists shared.fn_mien_code(text);
drop function if exists shared.fn_bu_code(text);
drop table if exists shared.dm_mien_alias;
drop table if exists shared.dm_mien;
drop trigger if exists trg_dm_bu_self_alias on shared.dm_bu;
drop function if exists shared.trg_dm_bu_self_alias();
drop table if exists shared.dm_bu_alias;
drop table if exists shared.dm_bu;
drop function if exists shared.fn_norm_key(text);

commit;
