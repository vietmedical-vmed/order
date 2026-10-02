-- ════════════════════════════════════════════════════════════════════════
-- 15_master_data_dictionary.sql — TỪ ĐIỂN DÙNG CHUNG: BU + MIỀN (GĐ1 + GĐ2)
--
-- BỐI CẢNH
-- Các app đang ghi BU theo 2 kiểu không quy đổi được bằng quy tắc:
--   mã ngắn : chcs, cttm, thnk, test   (users, sale_target, dm_dia_ban, token)
--   tên dài : CH&CS, CTTM & CTUT, THNS & CSVT (dm_vat_tu, dm_nhom_san_pham, ...)
-- và miền theo 2 kiểu: MB/MN (users, order_sessions) vs 'Miền Bắc'/'Miền Nam'.
-- Mỗi app tự giữ 1 bảng ánh xạ viết cứng → lệch nhau, lọc sai (vd thnk vs
-- 'THNS & CSVT' không khớp được trong order-api).
--
-- CHUẨN ĐÃ CHỐT (2026-10-02)
--   • Khoá BU = mã ngắn (bu_code). Tên dài chỉ là nhãn hiển thị (ten_bu).
--   • Khoá miền = MB / MT / MN. Hiển thị 'Miền Bắc' / 'Miền Trung' / 'Miền Nam'.
--   • 'all' = quyền xem tất cả (chỉ dùng trong phạm vi user, không phải 1 BU/miền).
--   • Nguồn danh mục = file Excel (sheet 'Ngành hàng' → shared.dm_bu).
--   • BU 'test' giữ trong dm_bu với is_test = true.
--
-- FILE NÀY LÀM GÌ (chỉ THÊM MỚI + điền chỗ trống, không đổi giá trị đang có)
--   1) shared.fn_norm_key  : chuẩn hoá khoá so khớp (NFC, lower, bỏ khoảng trắng)
--   2) shared.dm_bu + dm_bu_alias + fn_bu_code
--   3) shared.dm_mien + dm_mien_alias + fn_mien_code
--   4) Cột bu_code cho mọi bảng dm_* có cột bu, backfill chỗ trống
--   5) Trigger tự điền bu_code khi ghi dm_* → mọi script import đều được phủ
--   6) app_order.order_sessions.bu: tên dài → mã (có bảng backup để rollback)
--
-- CHƯA LÀM (giai đoạn sau): FK / NOT NULL, đổi cột miền tên dài → mã,
-- users.mien 'BOTH' → 'all', bỏ bảng ánh xạ viết cứng trong các app.
--
-- Idempotent: chạy lại an toàn. Rollback: 15_master_data_dictionary_ROLLBACK.sql
-- ════════════════════════════════════════════════════════════════════════

begin;

-- ─── 1) Hàm chuẩn hoá khoá ──────────────────────────────────────────────
-- NFC: dữ liệu dán từ Excel có thể ở dạng tổ hợp (NFD) → 'Miền' không khớp.
-- Bỏ MỌI khoảng trắng: 'CTTM & CTUT' = 'CTTM&CTUT' = 'cttm & ctut'.
create or replace function shared.fn_norm_key(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(regexp_replace(normalize(coalesce(p, ''), NFC), '\s+', '', 'g'))
$$;

comment on function shared.fn_norm_key(text) is
  'Khoá so khớp danh mục: NFC + lower + bỏ khoảng trắng. Dùng chung cho alias BU/miền.';

-- ─── 2) BU ──────────────────────────────────────────────────────────────
create table if not exists shared.dm_bu (
  bu_code     text primary key,
  ten_bu      text not null,
  ten_day_du  text,
  thu_tu      smallint not null default 100,
  mau         text,
  is_test     boolean not null default false,
  active      boolean not null default true,
  updated_at  timestamptz not null default now(),
  constraint ck_dm_bu_code check (
    bu_code = lower(btrim(bu_code)) and bu_code <> '' and bu_code <> 'all'
  ),
  constraint uq_dm_bu_ten_bu unique (ten_bu)
);

comment on table  shared.dm_bu is 'Từ điển BU dùng chung. Nguồn: Excel sheet "Ngành hàng". Khoá = bu_code.';
comment on column shared.dm_bu.bu_code is 'Mã chuẩn (chcs, cttm, thnk...). Mọi bảng lưu mã này. ''all'' KHÔNG phải BU.';
comment on column shared.dm_bu.ten_bu  is 'Nhãn hiển thị ngắn (CH&CS, CTTM & CTUT...).';

create table if not exists shared.dm_bu_alias (
  alias_norm  text primary key,
  bu_code     text not null references shared.dm_bu (bu_code) on update cascade on delete cascade,
  ghi_chu     text,
  constraint ck_dm_bu_alias_norm check (alias_norm = shared.fn_norm_key(alias_norm) and alias_norm <> '')
);
create index if not exists idx_dm_bu_alias_bu_code on shared.dm_bu_alias (bu_code);

comment on table shared.dm_bu_alias is
  'Cách viết khác của BU → bu_code. alias_norm = fn_norm_key(cách viết). Mã và ten_bu tự được thêm qua trigger.';

alter table shared.dm_bu       enable row level security;
alter table shared.dm_bu_alias enable row level security;

insert into shared.dm_bu (bu_code, ten_bu, thu_tu, mau, is_test) values
  ('chcs', 'CH&CS',       1, '#2a78d6', false),
  ('cttm', 'CTTM & CTUT', 2, '#1baf7a', false),
  ('thnk', 'THNS & CSVT', 3, '#eda100', false),
  ('test', 'TEST',        99, '#898781', true)
on conflict (bu_code) do nothing;

-- Mã + ten_bu luôn là alias của chính nó → thêm/sửa BU trong Excel không cần
-- nhớ khai alias.
create or replace function shared.trg_dm_bu_self_alias()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into shared.dm_bu_alias (alias_norm, bu_code, ghi_chu)
  values (shared.fn_norm_key(new.bu_code), new.bu_code, 'mã'),
         (shared.fn_norm_key(new.ten_bu),  new.bu_code, 'ten_bu')
  on conflict (alias_norm) do nothing;  -- không cướp alias đang trỏ BU khác
  return new;
end
$$;

drop trigger if exists trg_dm_bu_self_alias on shared.dm_bu;
create trigger trg_dm_bu_self_alias
  after insert or update of bu_code, ten_bu on shared.dm_bu
  for each row execute function shared.trg_dm_bu_self_alias();

-- Seed alias cho 4 BU đã có (trigger chỉ chạy cho dòng mới insert).
insert into shared.dm_bu_alias (alias_norm, bu_code, ghi_chu)
select shared.fn_norm_key(v.alias), v.bu_code, v.ghi_chu
from (values
  ('chcs',        'chcs', 'mã'),
  ('CH&CS',       'chcs', 'ten_bu'),
  ('cttm',        'cttm', 'mã'),
  ('CTTM & CTUT', 'cttm', 'ten_bu'),
  ('CTUT',        'cttm', 'viết tắt cũ'),
  ('thnk',        'thnk', 'mã'),
  ('THNS & CSVT', 'thnk', 'ten_bu'),
  ('THNS',        'thnk', 'viết tắt cũ'),
  ('test',        'test', 'mã')
) as v (alias, bu_code, ghi_chu)
on conflict (alias_norm) do nothing;

-- Trả bu_code, 'all' cho quyền xem tất cả, NULL nếu không nhận ra.
create or replace function shared.fn_bu_code(p_bu text)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select case
    when shared.fn_norm_key(p_bu) = '' then null
    when shared.fn_norm_key(p_bu) in ('all', 'tatca', 'tấtcả') then 'all'
    else (select a.bu_code from shared.dm_bu_alias a
           where a.alias_norm = shared.fn_norm_key(p_bu))
  end
$$;

comment on function shared.fn_bu_code(text) is
  'Mọi cách viết BU → bu_code chuẩn. ''all'' = quyền xem tất cả. NULL = chưa có trong dm_bu_alias.';

-- ─── 3) Miền ────────────────────────────────────────────────────────────
create table if not exists shared.dm_mien (
  ma_mien   text primary key,
  ten_mien  text not null,
  thu_tu    smallint not null,
  constraint ck_dm_mien_ma check (ma_mien in ('MB', 'MT', 'MN')),
  constraint uq_dm_mien_ten unique (ten_mien)
);

create table if not exists shared.dm_mien_alias (
  alias_norm  text primary key,
  ma_mien     text not null references shared.dm_mien (ma_mien) on update cascade on delete cascade,
  ghi_chu     text,
  constraint ck_dm_mien_alias_norm check (alias_norm = shared.fn_norm_key(alias_norm) and alias_norm <> '')
);
create index if not exists idx_dm_mien_alias_ma on shared.dm_mien_alias (ma_mien);

comment on table shared.dm_mien is 'Từ điển miền. Lưu ma_mien (MB/MT/MN), hiển thị ten_mien.';

alter table shared.dm_mien       enable row level security;
alter table shared.dm_mien_alias enable row level security;

insert into shared.dm_mien (ma_mien, ten_mien, thu_tu) values
  ('MB', 'Miền Bắc',   1),
  ('MT', 'Miền Trung', 2),
  ('MN', 'Miền Nam',   3)
on conflict (ma_mien) do nothing;

insert into shared.dm_mien_alias (alias_norm, ma_mien, ghi_chu)
select shared.fn_norm_key(v.alias), v.ma_mien, v.ghi_chu
from (values
  ('MB', 'MB', 'mã'), ('Miền Bắc', 'MB', 'tên'), ('Mien Bac', 'MB', 'không dấu'),
  ('Bắc', 'MB', 'rút gọn'), ('Bac', 'MB', 'rút gọn'), ('HN', 'MB', 'Area Bravo'),
  ('MT', 'MT', 'mã'), ('Miền Trung', 'MT', 'tên'), ('Mien Trung', 'MT', 'không dấu'),
  ('Trung', 'MT', 'rút gọn'),
  ('MN', 'MN', 'mã'), ('Miền Nam', 'MN', 'tên'), ('Mien Nam', 'MN', 'không dấu'),
  ('Nam', 'MN', 'rút gọn'), ('HCM', 'MN', 'Area Bravo')
) as v (alias, ma_mien, ghi_chu)
on conflict (alias_norm) do nothing;

-- Trả MB/MT/MN, 'all' cho quyền xem tất cả (gồm 'BOTH' cũ), NULL nếu không nhận ra.
create or replace function shared.fn_mien_code(p_mien text)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select case
    when shared.fn_norm_key(p_mien) = '' then null
    when shared.fn_norm_key(p_mien) in ('all', 'both', 'tatca', 'tấtcả') then 'all'
    else (select a.ma_mien from shared.dm_mien_alias a
           where a.alias_norm = shared.fn_norm_key(p_mien))
  end
$$;

comment on function shared.fn_mien_code(text) is
  'Mọi cách viết miền → MB/MT/MN. ''all''/''BOTH'' → ''all''. NULL = chưa có trong dm_mien_alias.';

-- ─── 4) Cột bu_code cho các bảng dm_* có cột bu + backfill chỗ trống ────
alter table shared.dm_nhom_san_pham     add column if not exists bu_code text;
alter table shared.dm_san_pham_tong     add column if not exists bu_code text;
alter table shared.dm_bo_vat_tu         add column if not exists bu_code text;
alter table shared.dm_bo_vat_tu_mapping add column if not exists bu_code text;
-- dm_vat_tu.bu_code, dm_ps.bu_code đã có. Bỏ default '' của dm_vat_tu: chuỗi
-- rỗng sẽ vi phạm FK ở giai đoạn sau, NULL mới đúng nghĩa "chưa biết".
alter table shared.dm_vat_tu alter column bu_code drop default;

update shared.dm_vat_tu            set bu_code = shared.fn_bu_code(bu) where nullif(btrim(bu_code), '') is null;
update shared.dm_nhom_san_pham     set bu_code = shared.fn_bu_code(bu) where bu_code is null;
update shared.dm_san_pham_tong     set bu_code = shared.fn_bu_code(bu) where bu_code is null;
update shared.dm_bo_vat_tu         set bu_code = shared.fn_bu_code(bu) where bu_code is null;
update shared.dm_bo_vat_tu_mapping set bu_code = shared.fn_bu_code(bu) where bu_code is null;
-- dm_ps.bu_code đã suy từ sale_target (ưu tiên cao hơn) → chỉ điền dòng trống.
update shared.dm_ps                set bu_code = shared.fn_bu_code(bu) where nullif(btrim(bu_code), '') is null;

-- ─── 5) Trigger tự điền bu_code khi ghi dm_* ────────────────────────────
-- Quy tắc: bu_code người ghi tự set → giữ (chỉ hạ chữ thường). Bỏ trống, hoặc
-- đổi bu mà không đổi bu_code → tính lại từ bu. Không nhận ra → NULL.
-- Chỉ fire khi đụng cột bu / bu_code → update dat_hang, safety_stock... không tốn gì.
create or replace function shared.trg_fill_bu_code()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.bu is distinct from old.bu
     and new.bu_code is not distinct from old.bu_code then
    new.bu_code := null;
  end if;

  if nullif(btrim(new.bu_code), '') is null then
    new.bu_code := shared.fn_bu_code(new.bu);
  else
    new.bu_code := lower(btrim(new.bu_code));
  end if;
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'dm_vat_tu', 'dm_nhom_san_pham', 'dm_san_pham_tong',
    'dm_bo_vat_tu', 'dm_bo_vat_tu_mapping', 'dm_ps'
  ] loop
    execute format('drop trigger if exists trg_fill_bu_code on shared.%I', t);
    execute format(
      'create trigger trg_fill_bu_code before insert or update of bu, bu_code on shared.%I
         for each row execute function shared.trg_fill_bu_code()', t);
  end loop;
end
$$;

-- ─── 6) order_sessions.bu: tên dài → mã ────────────────────────────────
-- Backup trước để rollback được đúng giá trị cũ.
create table if not exists app_order.bak_20261002_session_bu (
  session_id  text primary key,
  bu_cu       text not null
);
alter table app_order.bak_20261002_session_bu enable row level security;

insert into app_order.bak_20261002_session_bu (session_id, bu_cu)
select s.session_id::text, s.bu
from   app_order.order_sessions s
where  s.bu <> ''
  and  shared.fn_bu_code(s.bu) is not null
  and  s.bu is distinct from shared.fn_bu_code(s.bu)
on conflict (session_id) do nothing;

update app_order.order_sessions s
   set bu = shared.fn_bu_code(s.bu)
 where s.bu <> ''
   and shared.fn_bu_code(s.bu) is not null
   and s.bu is distinct from shared.fn_bu_code(s.bu);

-- ─── Cảnh báo: giá trị chưa nhận ra ─────────────────────────────────────
do $$
declare
  v text;
begin
  select string_agg(distinct bu, ', ') into v
  from (
    select bu from shared.dm_vat_tu            where bu_code is null and nullif(btrim(bu), '') is not null
    union all select bu from shared.dm_nhom_san_pham     where bu_code is null and nullif(btrim(bu), '') is not null
    union all select bu from shared.dm_san_pham_tong     where bu_code is null and nullif(btrim(bu), '') is not null
    union all select bu from shared.dm_bo_vat_tu         where bu_code is null and nullif(btrim(bu), '') is not null
    union all select bu from shared.dm_bo_vat_tu_mapping where bu_code is null and nullif(btrim(bu), '') is not null
    union all select bu from shared.dm_ps                where bu_code is null and nullif(btrim(bu), '') is not null
  ) x;
  if v is not null then
    raise warning 'BU chưa có trong dm_bu_alias: [%] — thêm alias rồi chạy lại file này', v;
  end if;
end
$$;

commit;

analyze shared.dm_bu, shared.dm_bu_alias, shared.dm_mien, shared.dm_mien_alias;

-- ─── KIỂM TRA SAU KHI CHẠY ────────────────────────────────────────────────
-- (a) Hàm chuẩn hoá:
--   select shared.fn_bu_code(x) from unnest(array['CH&CS','chcs','CTTM & CTUT','cttm',
--     'THNS & CSVT','THNK','all','xyz']) x;
--   -- Kỳ vọng: chcs chcs cttm cttm thnk thnk all NULL
--   select shared.fn_mien_code(x) from unnest(array['MB','Miền Bắc','HCM','BOTH','Miền Trung']) x;
--   -- Kỳ vọng: MB MB MN all MT
--
-- (b) Không còn dòng có bu mà thiếu bu_code (kỳ vọng 0 hết):
--   select 'dm_vat_tu' t, count(*) from shared.dm_vat_tu where bu_code is null and nullif(btrim(bu),'') is not null
--   union all select 'dm_nhom_san_pham', count(*) from shared.dm_nhom_san_pham where bu_code is null
--   union all select 'dm_san_pham_tong', count(*) from shared.dm_san_pham_tong where bu_code is null and nullif(btrim(bu),'') is not null
--   union all select 'dm_bo_vat_tu', count(*) from shared.dm_bo_vat_tu where bu_code is null and nullif(btrim(bu),'') is not null
--   union all select 'dm_bo_vat_tu_mapping', count(*) from shared.dm_bo_vat_tu_mapping where bu_code is null and nullif(btrim(bu),'') is not null
--   union all select 'dm_ps', count(*) from shared.dm_ps where bu_code is null;
--
-- (c) dm_ps: bu_code (suy từ kế hoạch) lệch với tên BU (kỳ vọng 0 dòng):
--   select ps, bu, bu_code, shared.fn_bu_code(bu) from shared.dm_ps
--   where bu_code is distinct from shared.fn_bu_code(bu);
--
-- (d) order_sessions chỉ còn mã (kỳ vọng: chcs, cttm, thnk):
--   select bu, count(*) from app_order.order_sessions group by 1;
--
-- (e) Trigger hoạt động (rollback, không ghi thật):
--   begin;
--     update shared.dm_vat_tu set bu = 'THNS & CSVT', bu_code = bu_code
--      where ma_bravo = (select ma_bravo from shared.dm_vat_tu where bu = 'CH&CS' limit 1)
--      returning ma_bravo, bu, bu_code;   -- kỳ vọng bu_code = thnk
--   rollback;
