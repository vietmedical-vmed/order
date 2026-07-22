-- =====================================================================
--  02_order_app.sql  —  Bảng RIÊNG của app Đặt hàng CTCH
--  Phụ thuộc: bảng dùng chung public.users (đã có sẵn trên cloud) và
--             public.dm_vat_tu (01_shared_catalog.sql).
-- =====================================================================

-- ---------- PHÂN QUYỀN ----------
--  KHÔNG có bảng role riêng. App đọc role/mien trực tiếp từ bảng users dùng chung.
--  Map role: area_manager->AM, product_manager->PM, manager->MANAGER, admin->ADMIN.
--  Role khác (vd ps) sẽ bị chặn đăng nhập app này.

-- ---------- DANH MỤC ĐẶT HÀNG (chỉ thuộc tính riêng app) ----------
--  Tên/giá/NCC/nhóm... lấy từ dm_vat_tu qua ma_bravo.
create table if not exists public.order_catalog (
  ma_bravo        text primary key references public.dm_vat_tu(ma_bravo) on delete cascade,
  muc_do_sd       text default '',        -- Hay sử dụng | Ít sử dụng | Hiếm khi sử dụng
  don_vi          text default '',
  leadtime_ngay   numeric default 0,
  tb_kh_3_thang   numeric default 0,
  so_thang_dat    numeric,                -- null => dùng default app_config
  active          boolean default true
);

-- ---------- ĐỢT ĐẶT HÀNG ----------
create table if not exists public.order_sessions (
  session_id  uuid primary key default gen_random_uuid(),
  ten_dot     text not null,
  mien        text not null,              -- MB | MN
  ngay_mo     timestamptz not null default now(),
  ngay_dong   timestamptz,
  trang_thai  text not null default 'DRAFT',  -- DRAFT|SUBMITTED|PM_APPROVED|APPROVED|CLOSED
  tao_boi     text
);

-- ---------- DÒNG ĐẶT HÀNG ----------
create table if not exists public.order_items (
  item_id          uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.order_sessions(session_id) on delete cascade,
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
create index if not exists idx_items_session on public.order_items(session_id);

-- ---------- NHẬT KÝ ----------
create table if not exists public.audit_log (
  log_id     uuid primary key default gen_random_uuid(),
  timestamp  timestamptz not null default now(),
  username   text,
  action     text,
  session_id text default '',
  detail     text default ''
);
create index if not exists idx_audit_ts on public.audit_log(timestamp desc);

-- ---------- TỒN KHO / USAGE (aggregate sẵn) ----------
-- stock: dữ liệu tồn kho RAW ở mức LÔ (mỗi dòng = 1 lô/serial trong 1 kho tại 1
-- kỳ cycledate). KHÔNG aggregate — tổng DA/GU/KG được RPC stock_agg gộp lúc đọc.
--   warehousetype: DA (tồn kho) | GU (vét thầu) | KG (ký gửi) — phân loại nguồn.
--   quantity     : số lượng của lô (có thể âm khi điều chuyển/chênh lệch).
--   cycledate    : ngày chốt snapshot; stock_agg chọn cycledate hiệu lực theo đợt.
-- Không đặt primary key: 1 (ma_bravo, mien, cycledate) có nhiều lô trùng khoá.
create table if not exists public.stock (
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
create table if not exists public.usage_stat (
  ma_bravo     text not null,
  mien         text not null,
  xuat_2024    numeric default 0,
  xuat_2025    numeric default 0,
  xuat_lk_2026 numeric default 0,
  ty_le_sd_pct numeric default 0,
  primary key (ma_bravo, mien)
);

-- ---------- CẤU HÌNH GỢI Ý ----------
create table if not exists public.app_config (
  key    text primary key,
  value  jsonb not null
);
-- goi_y: k1/k2/k3 + so_thang_dat_default là MẶC ĐỊNH; có thể override theo nhóm
-- sản phẩm qua key "groups": { "<nhom_san_pham>": { k1,k2,k3,so_thang_dat } }.
-- Công thức: (k1·TB CKNT + k2·TB YTD + k3·TB KH) × Số tháng đặt + Safety stock − Tổng tồn.
insert into public.app_config(key, value)
values ('goi_y', '{"k1":0.4,"k2":0.4,"k3":0.2,"so_thang_dat_default":3,"groups":{}}'::jsonb)
on conflict (key) do nothing;

-- ---------- Trigger updated_at ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_items_touch on public.order_items;
create trigger trg_items_touch before update on public.order_items
  for each row execute function public.touch_updated_at();

-- ---------- INDEX (performance) ----------
-- stock: tìm cycledate mới nhất theo miền, filter theo cycledate
create index if not exists idx_stock_mien_cycle
  on public.stock (mien, cycledate desc);

-- sv, sale_target: nằm ngoài schema file (production-only), chạy thủ công trên SQL Editor:
--   CREATE INDEX IF NOT EXISTS idx_sv_area_month ON public.sv (area, month);
--   CREATE INDEX IF NOT EXISTS idx_sale_target_mien_thang ON public.sale_target (mien, thang_ke_hoach);

-- ---------- RLS ----------
alter table public.order_catalog    enable row level security;
alter table public.order_sessions   enable row level security;
alter table public.order_items      enable row level security;
alter table public.audit_log        enable row level security;
alter table public.stock            enable row level security;
alter table public.usage_stat       enable row level security;
alter table public.app_config       enable row level security;
