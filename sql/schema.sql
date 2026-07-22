-- =====================================================================
--  ĐẶT HÀNG CTCH — Supabase schema
--  Chạy 1 lần trong Supabase → SQL Editor.
--  Tất cả bảng bật RLS + policy DENY cho anon; Edge Function dùng
--  service_role key nên bypass RLS (giống mô hình CHCS FY26).
-- =====================================================================

-- ---------- USERS ----------
create table if not exists public.users (
  username        text primary key,
  ho_ten          text        not null default '',
  password_hash   text        not null,
  salt            text        not null,
  role            text        not null default 'AM',   -- ADMIN | AM | PM | MANAGER
  mien            text        not null default 'MB',   -- MB | MN | BOTH
  active          boolean     not null default true
);

-- ---------- PRODUCTS (danh mục) ----------
create table if not exists public.products (
  ma_bravo        text primary key,
  code_ncc        text default '',
  ten_hang_hoa    text default '',
  nhom_hang       text default '',
  phan_loai       text default '',
  muc_do_sd       text default '',
  don_vi          text default '',
  gia             numeric default 0,
  leadtime_ngay   numeric default 0,
  tb_kh_3_thang   numeric default 0,     -- TB KH 3 tháng tiếp theo
  so_thang_dat    numeric,               -- null => dùng default trong app_config
  active          boolean default true
);

-- ---------- ORDER SESSIONS ----------
create table if not exists public.order_sessions (
  session_id      uuid primary key default gen_random_uuid(),
  ten_dot         text not null,
  mien            text not null,          -- MB | MN
  ngay_mo         timestamptz not null default now(),
  ngay_dong       timestamptz,
  trang_thai      text not null default 'DRAFT',  -- DRAFT|SUBMITTED|PM_APPROVED|APPROVED|CLOSED
  tao_boi         text
);

-- ---------- ORDER ITEMS ----------
create table if not exists public.order_items (
  item_id         uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.order_sessions(session_id) on delete cascade,
  ma_bravo        text not null,
  sl_dat          numeric,
  sl_duyet        numeric,
  sl_dat_hang     numeric,
  ghi_chu_dat     text default '',
  ghi_chu_duyet   text default '',
  ghi_chu_dat_hang text default '',
  updated_at      timestamptz default now(),
  updated_by      text,
  unique (session_id, ma_bravo)
);
create index if not exists idx_items_session on public.order_items(session_id);

-- ---------- AUDIT LOG ----------
create table if not exists public.audit_log (
  log_id          uuid primary key default gen_random_uuid(),
  timestamp       timestamptz not null default now(),
  username        text,
  action          text,
  session_id      text default '',
  detail          text default ''
);
create index if not exists idx_audit_ts on public.audit_log(timestamp desc);

-- ---------- STOCK (đã aggregate trước — thay cho đọc live "Chi tiết") ----------
--  Nạp bằng scripts/refresh_stock.py. Khoá kép (ma_bravo, mien).
-- stock: tồn kho RAW ở mức LÔ (mỗi dòng = 1 lô/serial trong 1 kho tại 1 kỳ
-- cycledate). Aggregate DA/GU/KG thực hiện lúc đọc trong RPC stock_agg
-- (sql/03_rpc_aggregates.sql). Logistics (đi đường/ký gửi tay) ở logistics_input.
create table if not exists public.stock (
  ma_bravo        text not null,
  mien            text not null,           -- 'MB'|'MN' hoặc 'Miền Bắc'|'Miền Nam'
  cycledate       date,                    -- ngày chốt snapshot
  itemcode_ncc    text,                    -- mã hàng theo NCC
  warehousetype   text,                    -- DA (tồn) | GU (vét thầu) | KG (ký gửi)
  warehousecode   text,
  warehousename   text,
  serialcode      text,
  so_lo           text,
  quantity        numeric default 0,       -- SL của lô (có thể âm)
  expirydate      date,
  mfgdate         date,
  note            text
);
create index if not exists idx_stock_mien_cycle on public.stock (mien, cycledate desc);

-- ---------- USAGE (đã aggregate trước — thay cho đọc live "SDVT") ----------
create table if not exists public.usage_stat (
  ma_bravo        text not null,
  mien            text not null,
  xuat_2024       numeric default 0,
  xuat_2025       numeric default 0,       -- TB tháng CKNT
  xuat_lk_2026    numeric default 0,       -- TB tháng YTD
  ty_le_sd_pct    numeric default 0,
  primary key (ma_bravo, mien)
);

-- ---------- APP CONFIG (thay ScriptProperties GOI_Y_CONFIG) ----------
create table if not exists public.app_config (
  key             text primary key,
  value           jsonb not null
);
insert into public.app_config(key, value)
values ('goi_y', '{"k1":0.4,"k2":0.4,"k3":0.2,"so_thang_dat_default":3}'::jsonb)
on conflict (key) do nothing;

-- ---------- Trigger updated_at cho order_items ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_items_touch on public.order_items;
create trigger trg_items_touch before update on public.order_items
  for each row execute function public.touch_updated_at();

-- =====================================================================
--  RLS: bật trên mọi bảng, KHÔNG tạo policy cho anon => deny mặc định.
--  Edge Function gọi bằng service_role => bypass RLS.
-- =====================================================================
alter table public.users          enable row level security;
alter table public.products       enable row level security;
alter table public.order_sessions enable row level security;
alter table public.order_items    enable row level security;
alter table public.audit_log      enable row level security;
alter table public.stock          enable row level security;
alter table public.usage_stat     enable row level security;
alter table public.app_config     enable row level security;
