-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK cho 16_master_data_fk.sql — gỡ FK/CHECK/UNIQUE, cột sinh *_ref,
-- index FK đã tạo. Không đổi dữ liệu.
-- ════════════════════════════════════════════════════════════════════════

begin;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('shared', 'sale_target',          'fk_sale_target_bu'),
      ('shared', 'sale_target',          'fk_sale_target_ten_mien'),
      ('shared', 'dm_dia_ban',           'fk_dm_dia_ban_bu'),
      ('shared', 'dm_dia_ban',           'fk_dm_dia_ban_ten_mien'),
      ('shared', 'dm_ps',                'fk_dm_ps_bu_code'),
      ('shared', 'dm_ps',                'ck_dm_ps_bu_nhan_dien'),
      ('shared', 'dm_vat_tu',            'fk_dm_vat_tu_bu_code'),
      ('shared', 'dm_vat_tu',            'fk_dm_vat_tu_nhom'),
      ('shared', 'dm_vat_tu',            'ck_dm_vat_tu_bu_nhan_dien'),
      ('shared', 'dm_nhom_san_pham',     'fk_dm_nhom_san_pham_bu_code'),
      ('shared', 'dm_nhom_san_pham',     'ck_dm_nhom_san_pham_bu_nhan_dien'),
      ('shared', 'dm_san_pham_tong',     'fk_dm_san_pham_tong_bu_code'),
      ('shared', 'dm_san_pham_tong',     'fk_dm_san_pham_tong_nhom'),
      ('shared', 'dm_san_pham_tong',     'ck_dm_san_pham_tong_bu_nhan_dien'),
      ('shared', 'dm_bo_vat_tu',         'fk_dm_bo_vat_tu_bu_code'),
      ('shared', 'dm_bo_vat_tu',         'fk_dm_bo_vat_tu_nhom'),
      ('shared', 'dm_bo_vat_tu',         'ck_dm_bo_vat_tu_bu_nhan_dien'),
      ('shared', 'dm_bo_vat_tu_mapping', 'fk_dm_bo_vat_tu_mapping_bu_code'),
      ('shared', 'dm_bo_vat_tu_mapping', 'fk_dm_bo_vat_tu_mapping_nhom'),
      ('shared', 'dm_bo_vat_tu_mapping', 'ck_dm_bo_vat_tu_mapping_bu_nhan_dien'),
      ('shared', 'users',                'fk_users_bu_ref'),
      ('shared', 'users',                'fk_users_mien_ref'),
      ('app_order', 'order_sessions',    'fk_order_sessions_bu_ref'),
      ('app_order', 'order_sessions',    'fk_order_sessions_mien'),
      ('app_ccdc', 'ngan_sach',          'fk_ngan_sach_ten_mien')
    ) as t (sch, tbl, con)
  loop
    execute format('alter table %I.%I drop constraint if exists %I', r.sch, r.tbl, r.con);
  end loop;
end
$$;

-- Sau khi gỡ FK con mới gỡ được UNIQUE (FK tổng hợp phụ thuộc vào nó)
alter table shared.dm_nhom_san_pham drop constraint if exists uq_dm_nhom_san_pham_bu_ten;
alter table shared.dm_nhom_san_pham drop constraint if exists uq_dm_nhom_san_pham_ten;

alter table shared.users drop column if exists bu_ref, drop column if exists mien_ref;
alter table app_order.order_sessions drop column if exists bu_ref;

drop index if exists shared.idx_sale_target_fk_bu;
drop index if exists shared.idx_sale_target_fk_mien;

commit;
