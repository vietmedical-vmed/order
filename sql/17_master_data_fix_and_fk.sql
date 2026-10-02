-- ════════════════════════════════════════════════════════════════════════
-- 17_master_data_fix_and_fk.sql — SỬA DỮ LIỆU LỆCH + KHOÁ NỐT (GĐ4, phần 2)
--
-- Tiền đề: đã chạy 15 + 16.
--
-- QUYẾT ĐỊNH NGHIỆP VỤ (2026-10-02)
--   dm_dia_ban (thnk) dùng tên nhóm cũ:
--     TH DHM / TH DMĐ / TH DSA  = '... - Medtronic'
--     NSCT (Applied)            = 'NSTQ - Applied'
--     NSCT Khác                 = 'CSVT - S&N'
--     → 41/42 dòng là BẢN SAO của dòng tên đúng đã có (cùng KH, PS, tu_thang)
--       → XOÁ bản sao (đổi tên sẽ trùng khoá uq_dm_dia_ban).
--     → id 1452 (Khách lẻ, CSVT - S&N, PS Trang Trần) XOÁ: tổ hợp này thuộc
--       Lợi Phan (id 318 đã có).
--     → dòng BU 'test' nhóm 'CHCS Khác': XOÁ.
--   sale_target:
--     → 24 dòng ngoài kế hoạch có nhom_san_pham = '' (SP chưa có danh mục,
--       doanh thu thật): GIỮ NGUYÊN. FK đi qua cột sinh nhom_ref ('' → NULL).
--     → 12 dòng thnk + 'NSK Arthrex' (PS Ngân Nguyễn, KH DN8184, toàn số 0):
--       XOÁ (trigger tombstone ghi nhận → client sync tự bỏ).
--   contract_contracts.mien 'DN' (32 dòng) = 'Miền Trung'.
--
-- KHOÁ THÊM
--   sale_target.nhom_ref, dm_dia_ban.nhom_san_pham → dm_nhom_san_pham(nhom_san_pham)
--   public.contract_contracts.mien                → dm_mien(ten_mien)  [tạm]
--   Trigger shared.sale_target: bu tên dài → mã. Phòng hàm sync
--   map_hoadon_to_sale_target lấy bu tên dài từ hoá đơn khi PS chưa có trong
--   dm_ps → FK fk_sale_target_bu chặn → cả lượt sync lỗi.
--
-- KHÔNG khoá cặp (bu, nhóm) ở sale_target / dm_dia_ban: sync ngoài kế hoạch
-- lấy bu theo PS, nhóm theo hoá đơn → khoá cặp có thể làm hỏng cả lượt sync;
-- dm_dia_ban BU 'test' dùng nhóm của chcs.
--
-- Dòng bị xoá/sửa được lưu ở bảng bak_20261002_* → rollback được.
-- Rollback: 17_master_data_fix_and_fk_ROLLBACK.sql
-- ════════════════════════════════════════════════════════════════════════

set lock_timeout = '10s';

begin;

-- ─── 0) Cố định search_path cho trigger sẵn có của sale_target ─────────
-- sale_target_tombstone_fn() ghi "sale_target_tombstone" không kèm schema và
-- không đặt search_path → chạy được qua API (search_path = shared) nhưng LỖI
-- 42P01 khi xoá dòng từ SQL Editor (search_path = public). Sửa tận gốc,
-- không đổi hành vi qua API. KHÔNG hoàn tác ở file ROLLBACK (là sửa lỗi).
alter function shared.sale_target_tombstone_fn() set search_path = shared, public;
alter function shared.sale_target_set_rev()      set search_path = shared, public;

-- ─── 1) dm_dia_ban: xoá bản sao tên nhóm cũ + dòng đã chốt ────────────
create temp table _ten_nhom_cu (cu text primary key, moi text not null) on commit drop;
insert into _ten_nhom_cu values
  ('TH DHM',         'TH DHM - Medtronic'),
  ('TH DMĐ',         'TH DMĐ - Medtronic'),
  ('TH DSA',         'TH DSA - Medtronic'),
  ('NSCT (Applied)', 'NSTQ - Applied'),
  ('NSCT Khác',      'CSVT - S&N');

create temp table _dia_ban_xoa on commit drop as
select d.id
from   shared.dm_dia_ban d
join   _ten_nhom_cu m on m.cu = d.nhom_san_pham
where  exists (                         -- bản sao: đã có dòng tên đúng cùng KH + PS
         select 1 from shared.dm_dia_ban g
          where g.bu = d.bu and g.cust_key = d.cust_key
            and g.nhom_san_pham = m.moi and g.ps = d.ps)
   or  (d.id = 1452 and d.ps = 'Trang Trần' and d.nhom_san_pham = 'NSCT Khác')
union
select d.id from shared.dm_dia_ban d
where  d.bu = 'test' and d.nhom_san_pham = 'CHCS Khác';

create table if not exists shared.bak_20261002_dm_dia_ban
  as select * from shared.dm_dia_ban with no data;
alter table shared.bak_20261002_dm_dia_ban enable row level security;
-- Liệt kê cột theo bảng backup (chạy lại an toàn kể cả khi bảng gốc đã thêm cột).
create or replace function pg_temp.backup_rows(p_bak regclass, p_src regclass, p_ids regclass)
returns void
language plpgsql
as $$
declare
  cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into cols
  from   pg_attribute
  where  attrelid = p_bak and attnum > 0 and not attisdropped;
  execute format(
    'insert into %s (%s) select %s from %s s
      where s.id in (select id from %s)
        and not exists (select 1 from %s b where b.id = s.id)',
    p_bak, cols, cols, p_src, p_ids, p_bak);
end
$$;

select pg_temp.backup_rows('shared.bak_20261002_dm_dia_ban', 'shared.dm_dia_ban', '_dia_ban_xoa');

delete from shared.dm_dia_ban where id in (select id from _dia_ban_xoa);

-- Dòng tên cũ phát sinh sau khi đối chiếu (không trùng) → đổi sang tên đúng.
update shared.dm_dia_ban d
   set nhom_san_pham = m.moi
  from _ten_nhom_cu m
 where m.cu = d.nhom_san_pham;

-- ─── 2) sale_target: xoá 12 dòng thnk + NSK Arthrex (toàn số 0) ────────
create table if not exists shared.bak_20261002_sale_target
  as select * from shared.sale_target with no data;
alter table shared.bak_20261002_sale_target enable row level security;

create temp table _st_xoa on commit drop as
select s.id
from   shared.sale_target s
where  s.bu = 'thnk'
  and  s.nhom_san_pham = 'NSK Arthrex'
  and  s.ps = 'Ngân Nguyễn'
  and  coalesce(s.sl_ke_hoach_dau_nam, 0) = 0
  and  coalesce(s.sl_ke_hoach_update, 0) = 0
  and  coalesce(s.sl_thuc_hien, 0) = 0
  and  coalesce(s.doanh_thu_thuc_hien, 0) = 0;

select pg_temp.backup_rows('shared.bak_20261002_sale_target', 'shared.sale_target', '_st_xoa');

delete from shared.sale_target where id in (select id from _st_xoa);

-- ─── 3) contract_contracts: 'DN' → 'Miền Trung' ────────────────────────
create table if not exists public.bak_20261002_contract_mien (
  ma_hd    text primary key,
  mien_cu  text not null
);
alter table public.bak_20261002_contract_mien enable row level security;

insert into public.bak_20261002_contract_mien (ma_hd, mien_cu)
select ma_hd, mien from public.contract_contracts where mien = 'DN'
on conflict (ma_hd) do nothing;

update public.contract_contracts set mien = 'Miền Trung' where mien = 'DN';

-- ─── 4) Chặn nếu còn giá trị ngoài từ điển (không khoá trên dữ liệu bẩn) ─
do $$
declare
  v text;
begin
  select string_agg(distinct nhom_san_pham, ', ') into v
  from   shared.dm_dia_ban d
  where  not exists (select 1 from shared.dm_nhom_san_pham n where n.nhom_san_pham = d.nhom_san_pham);
  if v is not null then
    raise exception 'dm_dia_ban còn nhóm ngoài danh mục: [%]', v;
  end if;

  select string_agg(distinct nhom_san_pham, ', ') into v
  from   shared.sale_target s
  where  nullif(btrim(s.nhom_san_pham), '') is not null
    and  not exists (select 1 from shared.dm_nhom_san_pham n where n.nhom_san_pham = s.nhom_san_pham);
  if v is not null then
    raise exception 'sale_target còn nhóm ngoài danh mục: [%]', v;
  end if;

  select string_agg(distinct mien, ', ') into v
  from   public.contract_contracts c
  where  c.mien is not null
    and  not exists (select 1 from shared.dm_mien m where m.ten_mien = c.mien);
  if v is not null then
    raise exception 'contract_contracts còn miền ngoài danh mục: [%]', v;
  end if;
end
$$;

-- ─── 5) Trigger sale_target: bu tên dài → mã ───────────────────────────
create or replace function shared.trg_sale_target_bu_code()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v text;
begin
  if new.bu is not null then
    v := shared.fn_bu_code(new.bu);
    if v is not null and v <> 'all' then
      new.bu := v;            -- BU lạ (v NULL) giữ nguyên → FK báo lỗi rõ ràng
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists trg_sale_target_bu_code on shared.sale_target;
create trigger trg_sale_target_bu_code
  before insert or update of bu on shared.sale_target
  for each row execute function shared.trg_sale_target_bu_code();

-- ─── 6) Cột sinh nhom_ref + FK ─────────────────────────────────────────
-- Thêm cột STORED → ghi lại bảng ~34k dòng (khoá ngắn, vài giây).
alter table shared.sale_target
  add column if not exists nhom_ref text
  generated always as (nullif(btrim(nhom_san_pham), '')) stored;
comment on column shared.sale_target.nhom_ref is
  'Sinh từ nhom_san_pham ('''' → NULL: dòng ngoài kế hoạch chưa có danh mục) — chỉ để FK sang dm_nhom_san_pham. Không ghi.';

alter table shared.sale_target        drop constraint if exists fk_sale_target_nhom;
alter table shared.sale_target        add  constraint fk_sale_target_nhom
  foreign key (nhom_ref) references shared.dm_nhom_san_pham (nhom_san_pham) not valid;
alter table shared.dm_dia_ban         drop constraint if exists fk_dm_dia_ban_nhom;
alter table shared.dm_dia_ban         add  constraint fk_dm_dia_ban_nhom
  foreign key (nhom_san_pham) references shared.dm_nhom_san_pham (nhom_san_pham) not valid;
alter table public.contract_contracts drop constraint if exists fk_contract_contracts_ten_mien;
alter table public.contract_contracts add  constraint fk_contract_contracts_ten_mien
  foreign key (mien) references shared.dm_mien (ten_mien) not valid;

commit;

alter table shared.sale_target        validate constraint fk_sale_target_nhom;
alter table shared.dm_dia_ban         validate constraint fk_dm_dia_ban_nhom;
alter table public.contract_contracts validate constraint fk_contract_contracts_ten_mien;

reset lock_timeout;

-- ─── KIỂM TRA SAU KHI CHẠY ────────────────────────────────────────────────
-- (a) Số dòng đã xoá/sửa (kỳ vọng: 43, 12, 32):
--   select (select count(*) from shared.bak_20261002_dm_dia_ban)  dia_ban_xoa,
--          (select count(*) from shared.bak_20261002_sale_target) sale_target_xoa,
--          (select count(*) from public.bak_20261002_contract_mien) contract_dn;
--
-- (b) Ràng buộc mới đã VALID (kỳ vọng 3 dòng, convalidated = true):
--   select conrelid::regclass, conname, convalidated from pg_constraint
--   where conname in ('fk_sale_target_nhom','fk_dm_dia_ban_nhom','fk_contract_contracts_ten_mien');
--
-- (c) Khách lẻ CSVT - S&N chỉ còn PS Lợi Phan:
--   select id, ps, tu_thang, den_thang from shared.dm_dia_ban
--   where nhom_san_pham = 'CSVT - S&N' and khach_hang ilike 'khách lẻ%';
--
-- (d) 24 dòng ngoài kế hoạch vẫn còn, nhom_ref NULL:
--   select count(*) from shared.sale_target where nhom_san_pham = '' and nhom_ref is null;
--
-- (e) Trigger đổi bu tên dài → mã (rollback, không ghi thật):
--   begin;
--     update shared.sale_target set bu = 'THNS & CSVT'
--      where id = (select id from shared.sale_target where bu = 'thnk' limit 1)
--      returning id, bu;                    -- kỳ vọng bu = thnk
--   rollback;
--
-- (f) Chặn nhóm lạ (kỳ vọng LỖI fk_dm_dia_ban_nhom):
--   begin;
--     update shared.dm_dia_ban set nhom_san_pham = 'TH DHM'
--      where id = (select id from shared.dm_dia_ban where bu = 'thnk' limit 1);
--   rollback;
