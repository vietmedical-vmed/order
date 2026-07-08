-- =====================================================================
--  01_shared_catalog.sql  —  DANH MỤC DÙNG CHUNG cho mọi web app
--  Dùng IF NOT EXISTS: an toàn chạy lại, không đè bảng đã có.
--  Nạp dữ liệu bằng scripts/migrate_catalog.py
-- =====================================================================

-- Ngành hàng / BU
create table if not exists public.dm_bu (
  bu       text primary key,
  ten_bu   text
);

-- Nhóm sản phẩm
create table if not exists public.dm_nhom_san_pham (
  bu              text,
  nhom_san_pham   text,
  primary key (bu, nhom_san_pham)
);

-- Sản phẩm (tổng)
create table if not exists public.dm_san_pham (
  bu              text,
  nhom_san_pham   text,
  san_pham        text,
  primary key (bu, nhom_san_pham, san_pham)
);

-- MASTER VẬT TƯ (SKU) — nguồn dùng chung: tên, giá, NCC, phân loại
create table if not exists public.dm_vat_tu (
  ma_bravo          text primary key,     -- Mã vật tư (Bravo)
  ten_vat_tu        text,                 -- Tên vật tư (Bravo)
  ma_ncc            text,                 -- Mã NCC
  bu                text,
  nhom_san_pham     text,
  san_pham          text,
  phan_loai_1       text,
  phan_loai_2       text,
  hang              text,
  ma_hang           text,
  don_gia_thau_cu   numeric,
  don_gia_thau_moi  numeric,
  ma_pldt           text,
  ten_pldt          text,
  nhom_pldt         text
);
create index if not exists idx_vattu_bu on public.dm_vat_tu(bu);
create index if not exists idx_vattu_pl1 on public.dm_vat_tu(phan_loai_1);

-- Bộ vật tư (kit) + định mức
create table if not exists public.dm_bo_vat_tu (
  bu              text,
  nhom_san_pham   text,
  bo_vat_tu       text,
  primary key (bu, nhom_san_pham, bo_vat_tu)
);
create table if not exists public.dm_bo_vat_tu_mapping (
  id                bigint generated always as identity primary key,
  bu                text,
  nhom_san_pham     text,
  bo_vat_tu         text,
  san_pham          text,
  so_luong_dinh_muc numeric
);

-- PS (sales / product specialist)
create table if not exists public.dm_ps (
  bu          text,
  area        text,
  team        text,
  ps          text,
  ten_ps      text,
  trang_thai  text,
  primary key (bu, ps)
);

-- Địa bàn (PS ↔ đối tượng)
create table if not exists public.dm_dia_ban (
  id            bigint generated always as identity primary key,
  bu            text,
  ten_ps        text,
  ten_ma_pldt   text,
  ten_doi_tuong text
);

-- Khách hàng
create table if not exists public.dm_khach_hang (
  customer_id   text primary key,
  customer_name text,
  group_id      text,
  area_id       text,
  type_lvl1     text,
  type_lvl2     text,
  address       text
);

-- RLS deny anon (Edge Function service_role bypass)
alter table public.dm_bu               enable row level security;
alter table public.dm_nhom_san_pham    enable row level security;
alter table public.dm_san_pham         enable row level security;
alter table public.dm_vat_tu           enable row level security;
alter table public.dm_bo_vat_tu        enable row level security;
alter table public.dm_bo_vat_tu_mapping enable row level security;
alter table public.dm_ps               enable row level security;
alter table public.dm_dia_ban          enable row level security;
alter table public.dm_khach_hang       enable row level security;
