-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK cho 17_master_data_fix_and_fk.sql
-- Gỡ FK + trigger + cột sinh nhom_ref, trả lại dòng đã xoá/sửa từ bak_20261002_*.
-- Bảng backup được giữ lại (xoá tay khi chắc chắn không cần).
-- search_path đã cố định cho sale_target_tombstone_fn / sale_target_set_rev
-- KHÔNG hoàn tác (là sửa lỗi; hoàn tác thì xoá dòng từ SQL Editor lại lỗi 42P01).
-- ════════════════════════════════════════════════════════════════════════

begin;

alter table shared.sale_target        drop constraint if exists fk_sale_target_nhom;
alter table shared.dm_dia_ban         drop constraint if exists fk_dm_dia_ban_nhom;
alter table public.contract_contracts drop constraint if exists fk_contract_contracts_ten_mien;

alter table shared.sale_target drop column if exists nhom_ref;

drop trigger if exists trg_sale_target_bu_code on shared.sale_target;
drop function if exists shared.trg_sale_target_bu_code();

-- contract: 'Miền Trung' → 'DN' đúng các hợp đồng đã đổi
update public.contract_contracts c
   set mien = b.mien_cu
  from public.bak_20261002_contract_mien b
 where c.ma_hd = b.ma_hd;

-- Trả dòng đã xoá (cùng id). Chỉ chèn cột thường có ở cả 2 bảng (bỏ cột sinh
-- như dm_dia_ban.cust_key). sale_target: _rev mới do trigger gán → client sync nhận lại.
do $$
declare
  r    record;
  cols text;
begin
  for r in
    select * from (values
      ('shared.sale_target'::regclass, 'shared.bak_20261002_sale_target'::regclass),
      ('shared.dm_dia_ban'::regclass,  'shared.bak_20261002_dm_dia_ban'::regclass)
    ) as t (dst, bak)
  loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
    from   pg_attribute a
    join   pg_attribute b on b.attrelid = r.bak and b.attname = a.attname
                         and b.attnum > 0 and not b.attisdropped
    where  a.attrelid = r.dst and a.attnum > 0 and not a.attisdropped
      and  a.attgenerated = '';
    execute format(
      'insert into %s (%s) overriding system value
       select %s from %s b where not exists (select 1 from %s d where d.id = b.id)',
      r.dst, cols, cols, r.bak, r.dst);
  end loop;
end
$$;

commit;
