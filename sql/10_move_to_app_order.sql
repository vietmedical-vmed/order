-- ════════════════════════════════════════════════════════════════════════
-- TÁCH SCHEMA — chuyển các bảng RIÊNG của app Đặt hàng sang schema app_order
--
-- GIỮ Ở LẠI public (dùng chung, sẽ đưa vào schema `shared` ở phase sau):
--   users, sale_target, và toàn bộ dm_* (order sở hữu nhưng sale-target đọc).
--
-- CHUYỂN sang app_order (9 bảng, chỉ app order đọc/ghi — đã xác minh trên live):
--   order_sessions, order_items, order_config_log, audit_log, stock,
--   login_attempts, app_config, sv, logistics_input
--   (order_catalog / usage_stat không tồn tại trên live → guard tự bỏ qua)
--
-- An toàn:
--   • FK trỏ public.dm_vat_tu (order_catalog nếu có), FK order_items→order_sessions,
--     RLS, trigger, index đều theo OID → tự đi theo bảng, KHÔNG gãy.
--   • 3 RPC đọc bảng riêng (usage_agg, stock_agg, session_stats) được sửa để
--     trỏ app_order. sale_target_agg đọc public.sale_target → GIỮ NGUYÊN.
--   • Frontend js/ không đụng DB (đi qua edge function) → không ảnh hưởng.
--   • Transaction: lỗi giữa chừng rollback sạch. Guard idempotent: chạy lại vô hại.
--
-- Áp dụng: dán vào SQL Editor (dashboard) → Run.
--          SAU ĐÓ: Settings → API → Exposed schemas → thêm "app_order" → Save.
--          RỒI: deploy lại order-api + order-login (push master) — code đã sửa sẵn.
-- ════════════════════════════════════════════════════════════════════════

begin;

-- ─── 1) Schema + USAGE ───────────────────────────────────────────────────
create schema if not exists app_order;
grant usage on schema app_order to anon, authenticated, service_role;

-- ─── 2) Chuyển các bảng riêng (idempotent, chỉ move nếu còn ở public) ─────
--     Grant/RLS/trigger/FK/index/sequence đi theo bảng.
do $$
declare r text;
begin
  foreach r in array array[
    'order_sessions','order_items','order_config_log','audit_log','stock',
    'login_attempts','app_config','sv','logistics_input',
    'order_catalog','usage_stat'   -- có thể không tồn tại → guard bỏ qua
  ]
  loop
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = r and c.relkind = 'r'
    ) then
      execute format('alter table public.%I set schema app_order', r);
      raise notice 'moved table public.% -> app_order.%', r, r;
    end if;
  end loop;
end $$;

-- ─── 3) Sửa 3 RPC đọc bảng riêng → trỏ app_order ─────────────────────────
--     CREATE OR REPLACE giữ nguyên chữ ký → grant execute cũ còn nguyên.
--     (sale_target_agg đọc public.sale_target nên KHÔNG đụng tới.)

-- 3a) usage_agg: đọc app_order.sv + public.dm_vat_tu (dm_vat_tu vẫn ở public)
create or replace function public.usage_agg(p_mien text, p_y int, p_m int)
returns table (mien text, item_code text, san_pham text, th numeric, th_months int)
language sql stable as $$
  with base as (
    select
      case when s.area in ('MB','Miền Bắc') then 'MB'
           when s.area in ('MN','Miền Nam') then 'MN' end               as mien,
      s.item_code,
      (split_part(s.month, '-', 1))::int                                as y,
      (split_part(s.month, '-', 2))::int                                as mo,
      coalesce(s.quantity, 0)                                           as q
    from app_order.sv s
    where s.item_code is not null
      and s.month ~ '^[0-9]{4}-[0-9]{1,2}'
      and s.month >= ((p_y - 1)::text || '-01')
      and ( (p_mien = 'ALL' and s.area in ('MB','Miền Bắc','MN','Miền Nam'))
         or (p_mien = 'MB'  and s.area in ('MB','Miền Bắc'))
         or (p_mien = 'MN'  and s.area in ('MN','Miền Nam')) )
  ),
  per_month as (
    select b.mien, b.item_code, b.y, b.mo, sum(b.q) as q
    from base b
    where b.mien is not null
    group by b.mien, b.item_code, b.y, b.mo
  ),
  agg as (
    select
      m.mien,
      m.item_code,
      coalesce(sum(m.q) filter (where m.q > 0 and (m.y * 12 + m.mo) <= (p_y * 12 + p_m - 1)), 0) as th,
      (count(*)     filter (where m.q > 0 and (m.y * 12 + m.mo) <= (p_y * 12 + p_m - 1)))::int   as th_months
    from per_month m
    group by m.mien, m.item_code
  ),
  vt as (
    select d.ma_bravo, max(d.san_pham) as san_pham
    from public.dm_vat_tu d group by d.ma_bravo
  )
  select a.mien, a.item_code, vt.san_pham, a.th, a.th_months
  from agg a
  left join vt on vt.ma_bravo = a.item_code;
$$;

-- 3b) stock_agg: đọc app_order.stock + app_order.logistics_input
create or replace function public.stock_agg(p_mien text, p_ngaymo timestamptz default null)
returns table (mien text, ma_bravo text, ton_kho numeric,
               hang_vet_thau numeric, hang_ktv_bv numeric, hang_di_duong numeric)
language plpgsql stable as $$
declare
  cd_mb app_order.stock.cycledate%type;
  cd_mn app_order.stock.cycledate%type;
begin
  if p_mien in ('ALL','MB') then
    select st.cycledate into cd_mb from app_order.stock st
    where st.mien = any(array['MB','Miền Bắc'])
      and (p_ngaymo is null or st.cycledate::date <= p_ngaymo::date)
    order by st.cycledate desc nulls last limit 1;
  end if;
  if p_mien in ('ALL','MN') then
    select st.cycledate into cd_mn from app_order.stock st
    where st.mien = any(array['MN','Miền Nam'])
      and (p_ngaymo is null or st.cycledate::date <= p_ngaymo::date)
    order by st.cycledate desc nulls last limit 1;
  end if;

  return query
  with stk as (
    select
      case when s.mien in ('MB','Miền Bắc') then 'MB'
           when s.mien in ('MN','Miền Nam') then 'MN' end as mien,
      s.ma_bravo,
      sum(coalesce(s.quantity, 0)) filter (
        where upper(trim(regexp_replace(coalesce(s.warehousetype, ''), '^.*\.', ''))) = 'DA'
      ) as ton_kho,
      sum(coalesce(s.quantity, 0)) filter (
        where upper(trim(regexp_replace(coalesce(s.warehousetype, ''), '^.*\.', ''))) = 'GU'
      ) as hang_vet_thau
    from app_order.stock s
    where s.ma_bravo is not null
      and (
           (s.mien in ('MB','Miền Bắc') and p_mien in ('ALL','MB') and (cd_mb is null or s.cycledate = cd_mb))
        or (s.mien in ('MN','Miền Nam') and p_mien in ('ALL','MN') and (cd_mn is null or s.cycledate = cd_mn))
      )
    group by 1, s.ma_bravo
  ),
  lg as (
    select
      case when l.mien in ('MB','Miền Bắc') then 'MB'
           when l.mien in ('MN','Miền Nam') then 'MN' end as mien,
      l.ma_bravo,
      sum(coalesce(l.hang_di_duong, 0)) as hang_di_duong,
      sum(coalesce(l.hang_ktv_bv, 0))   as hang_ktv_bv
    from app_order.logistics_input l
    where (l.mien in ('MB','Miền Bắc') and p_mien in ('ALL','MB'))
       or (l.mien in ('MN','Miền Nam') and p_mien in ('ALL','MN'))
    group by 1, l.ma_bravo
  )
  select
    coalesce(stk.mien, lg.mien)         as mien,
    coalesce(stk.ma_bravo, lg.ma_bravo) as ma_bravo,
    coalesce(stk.ton_kho, 0),
    coalesce(stk.hang_vet_thau, 0),
    coalesce(lg.hang_ktv_bv, 0),
    coalesce(lg.hang_di_duong, 0)
  from stk
  full join lg on lg.mien = stk.mien and lg.ma_bravo = stk.ma_bravo;
end $$;

-- 3c) session_stats: đọc app_order.order_items
create or replace function public.session_stats()
returns table (session_id uuid, sku bigint, sl_dat numeric, sl_duyet numeric,
               sl_dat_hang numeric, approved_sku bigint, ordered_sku bigint)
language sql stable as $$
  select
    oi.session_id,
    count(*)                          as sku,
    sum(coalesce(oi.sl_dat, 0))       as sl_dat,
    sum(coalesce(oi.sl_duyet, 0))     as sl_duyet,
    sum(coalesce(oi.sl_dat_hang, 0))  as sl_dat_hang,
    count(oi.sl_duyet)                as approved_sku,
    count(oi.sl_dat_hang)             as ordered_sku
  from app_order.order_items oi
  group by oi.session_id;
$$;

-- ─── 4) Index cho RPC (bảng đã sang app_order) ───────────────────────────
create index if not exists idx_sv_area_month on app_order.sv (area, month);

-- ─── 5) Default privileges cho object tạo mới sau này trong app_order ─────
alter default privileges in schema app_order
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema app_order
  grant usage, select on sequences to anon, authenticated, service_role;

commit;

-- ════════════════════════════════════════════════════════════════════════
-- KIỂM TRA SAU KHI CHẠY (chạy riêng từng SELECT)
-- ════════════════════════════════════════════════════════════════════════
-- (a) 9 bảng đã sang app_order:
--   select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--   where c.relname in ('order_sessions','order_items','order_config_log','audit_log',
--     'stock','login_attempts','app_config','sv','logistics_input') order by 1,2;
-- (b) RPC chạy được (không lỗi "relation does not exist"):
--   select * from public.session_stats() limit 1;
--   select * from public.stock_agg('ALL') limit 1;
--   select * from public.usage_agg('ALL', extract(year from now())::int, extract(month from now())::int) limit 1;
-- (c) Đếm dữ liệu còn nguyên:
--   select (select count(*) from app_order.order_items) items,
--          (select count(*) from app_order.stock) stock_rows,
--          (select count(*) from app_order.sv) sv_rows;
