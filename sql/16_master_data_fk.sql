-- ════════════════════════════════════════════════════════════════════════
-- 16_master_data_fk.sql — KHOÁ RÀNG BUỘC BU / NHÓM SP / MIỀN (GĐ4, phần 1)
--
-- Tiền đề: đã chạy 15_master_data_dictionary.sql (dm_bu, dm_mien, bu_code).
--
-- NGUYÊN TẮC
--   • Chỉ khoá cột có dữ liệu ĐÃ SẠCH (đối chiếu live 2026-10-02: 0 dòng vi phạm).
--   • FK thêm NOT VALID rồi VALIDATE riêng: bước ADD khoá ngắn, bước VALIDATE
--     không chặn đọc/ghi.
--   • ON DELETE/UPDATE mặc định (NO ACTION): không cho xoá/đổi mã BU/miền đang dùng.
--   • 'all' (quyền xem tất cả) và '' (đợt không gắn BU) KHÔNG phải mã trong từ
--     điển → khoá qua cột sinh tự động *_ref (NULL khi 'all'/''), app không phải sửa.
--
-- KHOÁ GÌ
--   BU   : sale_target.bu, dm_dia_ban.bu, dm_*.bu_code, users.bu (qua bu_ref),
--          order_sessions.bu (qua bu_ref)
--          + CHECK dm_*: có bu thì bu_code phải nhận ra được (Excel ghi BU lạ → lỗi)
--   Nhóm : dm_nhom_san_pham.nhom_san_pham UNIQUE; (bu_code, nhom_san_pham) của
--          dm_vat_tu / dm_san_pham_tong / dm_bo_vat_tu / dm_bo_vat_tu_mapping
--          phải là cặp có trong dm_nhom_san_pham (nhóm đúng BU)
--   Miền : order_sessions.mien, users.mien (qua mien_ref) → dm_mien(ma_mien)
--          sale_target.mien, dm_dia_ban.mien, app_ccdc.ngan_sach.mien
--          → dm_mien(ten_mien)  [TẠM — đổi sang ma_mien ở bước chuyển miền về mã]
--
-- CHƯA KHOÁ (chờ quyết định nghiệp vụ — xem 17_*):
--   sale_target.nhom_san_pham (24 dòng rỗng, 12 dòng thnk + 'NSK Arthrex'),
--   dm_dia_ban.nhom_san_pham (43 dòng tên nhóm ngoài danh mục),
--   contract_contracts.mien ('DN'), app_order.stock.mien (pipeline sinh, đổi khi
--   chuyển miền về mã), app_contract.hoa_don_bovattu.bu / app_sale.sv_bovattu_actual.bu.
--
-- Rollback: 16_master_data_fk_ROLLBACK.sql
-- ════════════════════════════════════════════════════════════════════════

set lock_timeout = '10s';   -- đợi khoá quá 10s thì dừng, không treo app

begin;

-- ─── 1) Nhóm SP: tên nhóm duy nhất + cặp (bu_code, nhóm) ──────────────
-- Chỉ thêm khi chưa có (FK tổng hợp ở dưới phụ thuộc → không drop/add lại được).
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'shared.dm_nhom_san_pham'::regclass and conname = 'uq_dm_nhom_san_pham_ten') then
    alter table shared.dm_nhom_san_pham add constraint uq_dm_nhom_san_pham_ten unique (nhom_san_pham);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'shared.dm_nhom_san_pham'::regclass and conname = 'uq_dm_nhom_san_pham_bu_ten') then
    alter table shared.dm_nhom_san_pham add constraint uq_dm_nhom_san_pham_bu_ten unique (bu_code, nhom_san_pham);
  end if;
end
$$;

-- ─── 2) Cột sinh *_ref cho cột có giá trị phạm vi ('all', '') ──────────
alter table shared.users
  add column if not exists bu_ref text generated always as (
    case when lower(btrim(coalesce(bu, ''))) in ('', 'all') then null else bu end
  ) stored,
  add column if not exists mien_ref text generated always as (
    case when upper(btrim(coalesce(mien, ''))) in ('', 'ALL', 'BOTH') then null else mien end
  ) stored;
comment on column shared.users.bu_ref   is 'Sinh từ bu (NULL khi all/rỗng) — chỉ để FK sang dm_bu. Không ghi.';
comment on column shared.users.mien_ref is 'Sinh từ mien (NULL khi all/BOTH/rỗng) — chỉ để FK sang dm_mien. Không ghi.';

alter table app_order.order_sessions
  add column if not exists bu_ref text generated always as (nullif(btrim(bu), '')) stored;
comment on column app_order.order_sessions.bu_ref is 'Sinh từ bu (NULL khi đợt không gắn BU) — chỉ để FK sang dm_bu. Không ghi.';

-- ─── 3) Thêm FK / CHECK ở dạng NOT VALID ───────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- (schema, bảng, tên ràng buộc, định nghĩa)
      ('shared', 'sale_target',          'fk_sale_target_bu',           'foreign key (bu) references shared.dm_bu (bu_code)'),
      ('shared', 'dm_dia_ban',           'fk_dm_dia_ban_bu',            'foreign key (bu) references shared.dm_bu (bu_code)'),
      ('shared', 'dm_ps',                'fk_dm_ps_bu_code',            'foreign key (bu_code) references shared.dm_bu (bu_code)'),
      ('shared', 'dm_vat_tu',            'fk_dm_vat_tu_bu_code',        'foreign key (bu_code) references shared.dm_bu (bu_code)'),
      ('shared', 'dm_nhom_san_pham',     'fk_dm_nhom_san_pham_bu_code', 'foreign key (bu_code) references shared.dm_bu (bu_code)'),
      ('shared', 'dm_san_pham_tong',     'fk_dm_san_pham_tong_bu_code', 'foreign key (bu_code) references shared.dm_bu (bu_code)'),
      ('shared', 'dm_bo_vat_tu',         'fk_dm_bo_vat_tu_bu_code',     'foreign key (bu_code) references shared.dm_bu (bu_code)'),
      ('shared', 'dm_bo_vat_tu_mapping', 'fk_dm_bo_vat_tu_mapping_bu_code', 'foreign key (bu_code) references shared.dm_bu (bu_code)'),
      ('shared', 'users',                'fk_users_bu_ref',             'foreign key (bu_ref) references shared.dm_bu (bu_code)'),
      ('app_order', 'order_sessions',    'fk_order_sessions_bu_ref',    'foreign key (bu_ref) references shared.dm_bu (bu_code)'),

      -- Nhóm SP phải thuộc đúng BU (MATCH SIMPLE: bỏ qua dòng thiếu bu_code hoặc nhóm)
      ('shared', 'dm_vat_tu',            'fk_dm_vat_tu_nhom',           'foreign key (bu_code, nhom_san_pham) references shared.dm_nhom_san_pham (bu_code, nhom_san_pham)'),
      ('shared', 'dm_san_pham_tong',     'fk_dm_san_pham_tong_nhom',    'foreign key (bu_code, nhom_san_pham) references shared.dm_nhom_san_pham (bu_code, nhom_san_pham)'),
      ('shared', 'dm_bo_vat_tu',         'fk_dm_bo_vat_tu_nhom',        'foreign key (bu_code, nhom_san_pham) references shared.dm_nhom_san_pham (bu_code, nhom_san_pham)'),
      ('shared', 'dm_bo_vat_tu_mapping', 'fk_dm_bo_vat_tu_mapping_nhom','foreign key (bu_code, nhom_san_pham) references shared.dm_nhom_san_pham (bu_code, nhom_san_pham)'),

      -- Có ghi BU thì phải nhận ra được (trigger trg_fill_bu_code điền bu_code;
      -- NULL nghĩa là BU lạ → thêm alias / thêm BU vào Excel trước)
      ('shared', 'dm_vat_tu',            'ck_dm_vat_tu_bu_nhan_dien',            'check (nullif(btrim(bu), '''') is null or bu_code is not null)'),
      ('shared', 'dm_nhom_san_pham',     'ck_dm_nhom_san_pham_bu_nhan_dien',     'check (nullif(btrim(bu), '''') is null or bu_code is not null)'),
      ('shared', 'dm_san_pham_tong',     'ck_dm_san_pham_tong_bu_nhan_dien',     'check (nullif(btrim(bu), '''') is null or bu_code is not null)'),
      ('shared', 'dm_bo_vat_tu',         'ck_dm_bo_vat_tu_bu_nhan_dien',         'check (nullif(btrim(bu), '''') is null or bu_code is not null)'),
      ('shared', 'dm_bo_vat_tu_mapping', 'ck_dm_bo_vat_tu_mapping_bu_nhan_dien', 'check (nullif(btrim(bu), '''') is null or bu_code is not null)'),
      ('shared', 'dm_ps',                'ck_dm_ps_bu_nhan_dien',                'check (nullif(btrim(bu), '''') is null or bu_code is not null)'),

      -- Miền
      ('app_order', 'order_sessions',    'fk_order_sessions_mien',      'foreign key (mien) references shared.dm_mien (ma_mien)'),
      ('shared', 'users',                'fk_users_mien_ref',           'foreign key (mien_ref) references shared.dm_mien (ma_mien)'),
      ('shared', 'sale_target',          'fk_sale_target_ten_mien',     'foreign key (mien) references shared.dm_mien (ten_mien)'),
      ('shared', 'dm_dia_ban',           'fk_dm_dia_ban_ten_mien',      'foreign key (mien) references shared.dm_mien (ten_mien)'),
      ('app_ccdc', 'ngan_sach',          'fk_ngan_sach_ten_mien',       'foreign key (mien) references shared.dm_mien (ten_mien)')
    ) as t (sch, tbl, con, def)
  loop
    execute format('alter table %I.%I drop constraint if exists %I', r.sch, r.tbl, r.con);
    execute format('alter table %I.%I add constraint %I %s not valid', r.sch, r.tbl, r.con, r.def);
  end loop;
end
$$;

commit;

-- ─── 4) VALIDATE (ngoài transaction trên, khoá nhẹ) ───────────────────
alter table shared.sale_target          validate constraint fk_sale_target_bu;
alter table shared.sale_target          validate constraint fk_sale_target_ten_mien;
alter table shared.dm_dia_ban           validate constraint fk_dm_dia_ban_bu;
alter table shared.dm_dia_ban           validate constraint fk_dm_dia_ban_ten_mien;
alter table shared.dm_ps                validate constraint fk_dm_ps_bu_code;
alter table shared.dm_ps                validate constraint ck_dm_ps_bu_nhan_dien;
alter table shared.dm_vat_tu            validate constraint fk_dm_vat_tu_bu_code;
alter table shared.dm_vat_tu            validate constraint fk_dm_vat_tu_nhom;
alter table shared.dm_vat_tu            validate constraint ck_dm_vat_tu_bu_nhan_dien;
alter table shared.dm_nhom_san_pham     validate constraint fk_dm_nhom_san_pham_bu_code;
alter table shared.dm_nhom_san_pham     validate constraint ck_dm_nhom_san_pham_bu_nhan_dien;
alter table shared.dm_san_pham_tong     validate constraint fk_dm_san_pham_tong_bu_code;
alter table shared.dm_san_pham_tong     validate constraint fk_dm_san_pham_tong_nhom;
alter table shared.dm_san_pham_tong     validate constraint ck_dm_san_pham_tong_bu_nhan_dien;
alter table shared.dm_bo_vat_tu         validate constraint fk_dm_bo_vat_tu_bu_code;
alter table shared.dm_bo_vat_tu         validate constraint fk_dm_bo_vat_tu_nhom;
alter table shared.dm_bo_vat_tu         validate constraint ck_dm_bo_vat_tu_bu_nhan_dien;
alter table shared.dm_bo_vat_tu_mapping validate constraint fk_dm_bo_vat_tu_mapping_bu_code;
alter table shared.dm_bo_vat_tu_mapping validate constraint fk_dm_bo_vat_tu_mapping_nhom;
alter table shared.dm_bo_vat_tu_mapping validate constraint ck_dm_bo_vat_tu_mapping_bu_nhan_dien;
alter table shared.users                validate constraint fk_users_bu_ref;
alter table shared.users                validate constraint fk_users_mien_ref;
alter table app_order.order_sessions    validate constraint fk_order_sessions_bu_ref;
alter table app_order.order_sessions    validate constraint fk_order_sessions_mien;
alter table app_ccdc.ngan_sach          validate constraint fk_ngan_sach_ten_mien;

-- ─── 5) Index cột FK trên bảng lớn (sale_target ~34k dòng) ─────────────
-- Chỉ tạo khi chưa có index nào bắt đầu bằng cột đó. Bảng dm_* nhỏ → không cần.
do $$
declare
  c text;
begin
  foreach c in array array['bu', 'mien'] loop
    if not exists (
      select 1
      from   pg_index i
      join   pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where  i.indrelid = 'shared.sale_target'::regclass and a.attname = c
    ) then
      execute format('create index idx_sale_target_fk_%s on shared.sale_target (%I)', c, c);
    end if;
  end loop;
end
$$;

reset lock_timeout;

-- ─── KIỂM TRA SAU KHI CHẠY ────────────────────────────────────────────────
-- (a) Tất cả ràng buộc đã VALID (kỳ vọng 0 dòng):
--   select conrelid::regclass, conname from pg_constraint
--   where (conname like 'fk\_%' or conname like 'ck\_%nhan_dien' or conname like 'uq\_dm\_nhom%')
--     and connamespace in ('shared'::regnamespace, 'app_order'::regnamespace, 'app_ccdc'::regnamespace)
--     and not convalidated;
--
-- (b) Cột sinh đúng (kỳ vọng: all → NULL, BOTH → NULL):
--   select username, bu, bu_ref, mien, mien_ref from shared.users order by bu, mien;
--
-- (c) Chặn BU lạ (kỳ vọng LỖI ck_dm_vat_tu_bu_nhan_dien):
--   begin;
--     update shared.dm_vat_tu set bu = 'BU KHÔNG CÓ' where ma_bravo = (select ma_bravo from shared.dm_vat_tu limit 1);
--   rollback;
--
-- (d) Chặn nhóm sai BU (kỳ vọng LỖI fk_dm_vat_tu_nhom):
--   begin;
--     update shared.dm_vat_tu set nhom_san_pham = 'BSC - IC'
--      where ma_bravo = (select ma_bravo from shared.dm_vat_tu where bu_code = 'chcs' limit 1);
--   rollback;
--
-- (e) Chặn miền lạ (kỳ vọng LỖI fk_sale_target_ten_mien):
--   begin;
--     update shared.sale_target set mien = 'Miền Tây' where id = (select id from shared.sale_target limit 1);
--   rollback;
