-- =====================================================================
--  02_order_app.sql  —  Bảng RIÊNG của app Đặt hàng CTCH (schema app_order)
--  Phụ thuộc: bảng DÙNG CHUNG ở public — public.users (đã có sẵn trên cloud)
--             và public.dm_vat_tu (01_shared_catalog.sql).
--
--  LƯU Ý: sau khi chạy file này, thêm "app_order" vào
--  Settings → API → Exposed schemas thì edge function (qua PostgREST) mới truy cập được.
-- =====================================================================

-- ---------- SCHEMA RIÊNG CHO APP ----------
create schema if not exists app_order;
grant usage on schema app_order to anon, authenticated, service_role;
alter default privileges in schema app_order
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema app_order
  grant usage, select on sequences to anon, authenticated, service_role;

-- ---------- PHÂN QUYỀN ----------
--  KHÔNG có bảng role riêng. App đọc role/mien trực tiếp từ bảng users dùng chung.
--  Map role: area_manager->AM, product_manager->PM, manager->MANAGER, admin->ADMIN.
--  Role khác (vd ps) sẽ bị chặn đăng nhập app này.

-- ---------- DANH MỤC ĐẶT HÀNG (chỉ thuộc tính riêng app) ----------
--  Tên/giá/NCC/nhóm... lấy từ dm_vat_tu qua ma_bravo (FK trỏ bảng chung public.dm_vat_tu).
create table if not exists app_order.order_catalog (
  ma_bravo        text primary key references public.dm_vat_tu(ma_bravo) on delete cascade,
  muc_do_sd       text default '',        -- Hay sử dụng | Ít sử dụng | Hiếm khi sử dụng
  don_vi          text default '',
  leadtime_ngay   numeric default 0,
  tb_kh_3_thang   numeric default 0,
  so_thang_dat    numeric,                -- null => dùng default app_config
  active          boolean default true
);

-- ---------- ĐỢT ĐẶT HÀNG ----------
create table if not exists app_order.order_sessions (
  session_id  uuid primary key default gen_random_uuid(),
  ten_dot     text not null,
  mien        text not null,              -- MB | MN
  ngay_mo     timestamptz not null default now(),
  ngay_dong   timestamptz,
  trang_thai  text not null default 'DRAFT',  -- DRAFT|SUBMITTED|PM_APPROVED|APPROVED|CLOSED|CANCELED
  tao_boi     text,
  nhom_san_pham text                          -- lọc danh mục theo nhóm SP; NULL = tất cả nhóm
);

-- ---------- DÒNG ĐẶT HÀNG ----------
create table if not exists app_order.order_items (
  item_id          uuid primary key default gen_random_uuid(),
  session_id       uuid not null references app_order.order_sessions(session_id) on delete cascade,
  ma_bravo         text not null,
  sl_dat           numeric,
  sl_duyet         numeric,
  sl_dat_hang      numeric,
  ghi_chu_dat      text default '',
  ghi_chu_duyet    text default '',
  ghi_chu_dat_hang text default '',
  updated_at       timestamptz default now(),
  updated_by       text,
  unique (session_id, ma_bravo)
);
create index if not exists idx_items_session on app_order.order_items(session_id);

-- ---------- NHẬT KÝ ----------
create table if not exists app_order.audit_log (
  log_id     uuid primary key default gen_random_uuid(),
  timestamp  timestamptz not null default now(),
  username   text,
  action     text,
  session_id text default '',
  detail     text default ''
);
create index if not exists idx_audit_ts on app_order.audit_log(timestamp desc);

-- ---------- TỒN KHO / USAGE (aggregate sẵn) ----------
-- stock: dữ liệu tồn kho RAW ở mức LÔ (mỗi dòng = 1 lô/serial trong 1 kho tại 1
-- kỳ cycledate). KHÔNG aggregate — tổng DA/GU/KG được RPC stock_agg gộp lúc đọc.
--   warehousetype: DA (tồn kho) | GU (vét thầu) | KG (ký gửi) — phân loại nguồn.
--   quantity     : số lượng của lô (có thể âm khi điều chuyển/chênh lệch).
--   cycledate    : ngày chốt snapshot; stock_agg chọn cycledate hiệu lực theo đợt.
-- Không đặt primary key: 1 (ma_bravo, mien, cycledate) có nhiều lô trùng khoá.
create table if not exists app_order.stock (
  ma_bravo      text not null,
  mien          text not null,       -- 'MB'|'MN' hoặc 'Miền Bắc'|'Miền Nam'
  cycledate     date,                -- ngày chốt tồn (snapshot)
  itemcode_ncc  text,                -- mã hàng theo NCC
  warehousetype text,                -- DA | GU | KG (đuôi sau '.' nếu có)
  warehousecode text,
  warehousename text,
  serialcode    text,
  so_lo         text,
  quantity      numeric default 0,
  expirydate    date,
  mfgdate       date,
  note          text
);
create table if not exists app_order.usage_stat (
  ma_bravo     text not null,
  mien         text not null,
  xuat_2024    numeric default 0,
  xuat_2025    numeric default 0,
  xuat_lk_2026 numeric default 0,
  ty_le_sd_pct numeric default 0,
  primary key (ma_bravo, mien)
);

-- ---------- CẤU HÌNH GỢI Ý ----------
create table if not exists app_order.app_config (
  key    text primary key,
  value  jsonb not null
);
-- goi_y: k1/k2 + so_thang_dat_default là MẶC ĐỊNH; có thể override theo nhóm
-- sản phẩm qua key "groups": { "<nhom_san_pham>": { k1,k2,so_thang_dat,leadtime_thang } }.
-- Công thức: (k1·TB tháng TH + k2·TB KH) × Số tháng đặt + Safety stock − Tổng tồn.
-- Bản cũ 3 hệ số (k1·TB CKNT + k2·TB YTD + k3·TB KH) vẫn đọc được: Edge Function quy đổi
-- k1_mới = k1_cũ + k2_cũ, k2_mới = k3_cũ (xem normalizeCfg/migrateK).
insert into app_order.app_config(key, value)
values ('goi_y', '{"k1":0.8,"k2":0.2,"so_thang_dat_default":3,"groups":{}}'::jsonb)
on conflict (key) do nothing;

-- ---------- Trigger updated_at (hàm dùng chung, giữ ở public) ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_items_touch on app_order.order_items;
create trigger trg_items_touch before update on app_order.order_items
  for each row execute function public.touch_updated_at();

-- ---------- INDEX (performance) ----------
-- stock: tìm cycledate mới nhất theo miền, filter theo cycledate
create index if not exists idx_stock_mien_cycle
  on app_order.stock (mien, cycledate desc);

-- sv (đã sang app_order), sale_target (DÙNG CHUNG, vẫn ở public):
--   CREATE INDEX IF NOT EXISTS idx_sv_area_month ON app_order.sv (area, month);
--   CREATE INDEX IF NOT EXISTS idx_sale_target_mien_thang ON public.sale_target (mien, thang_ke_hoach);

-- ---------- RLS ----------
alter table app_order.order_catalog    enable row level security;
alter table app_order.order_sessions   enable row level security;
alter table app_order.order_items      enable row level security;
alter table app_order.audit_log        enable row level security;
alter table app_order.stock            enable row level security;
alter table app_order.usage_stat       enable row level security;
alter table app_order.app_config       enable row level security;
