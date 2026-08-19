-- =====================================================================
--  06_usage_indicators.sql  —  Pre-compute cache: TB TH, %SD, FY, TB KH
--
--  Thay vì mỗi lần loadOrderScreen gọi 4 RPC (usage_agg, usage_fy_agg,
--  sale_target_agg + dm_bo_vat_tu_mapping) rồi tính toán JS, tính sẵn
--  vào bảng cache.  Edge Function chỉ SELECT 1 bảng.
--
--  Refresh khi: upload sv / sale_target / mapping, đổi config (tự động),
--  hoặc gọi thủ công:  SELECT refresh_usage_indicators();
--
--  Chạy thủ công trên Supabase SQL Editor.  Idempotent.
-- =====================================================================

-- Helper: replicate JS normKey() — chuẩn hoá tên sản phẩm/bộ để so khớp.
create or replace function app_order.norm_key(s text)
returns text language sql immutable as $$
  select lower(regexp_replace(
           regexp_replace(trim(coalesce(s, '')), '\s+', ' ', 'g'),
         '\s*-\s*', '-', 'g'));
$$;

-- Bảng cache: 1 dòng / (miền, mã bravo).  ALL = merge từ MB + MN tại query time.
create table if not exists app_order.usage_indicators (
  mien            text    not null,
  ma_bravo        text    not null,
  tb_th           numeric not null default 0,
  ty_le_sd_pct    int     not null default 0,
  th_raw          numeric not null default 0,     -- SL thô item   (cho merge ALL)
  th_product_raw  numeric not null default 0,     -- SL thô sản phẩm (cho merge ALL)
  sl_th_fy24      numeric not null default 0,
  sl_th_fy25      numeric not null default 0,
  sl_th_fy26_ytd  numeric not null default 0,
  tb_kh_3_thang   numeric not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (mien, ma_bravo)
);
alter table app_order.usage_indicators enable row level security;

-- =====================================================================
--  refresh_usage_indicators()  —  Xoá + nạp lại cache từ sv, sale_target,
--  dm_bo_vat_tu_mapping.  Chạy trong 1 transaction → readers thấy data
--  cũ cho đến khi commit.
--
--  Logic khớp 1-1 với JS trong Edge Function:
--    TB TH  = usage_agg  (cửa sổ T01 năm trước .. tháng trước hiện tại)
--    %SD    = SL item / SL sản phẩm  (cùng cửa sổ TH)
--    FY     = usage_fy_agg  (FY24 / FY25 / FY26 YTD)
--    TB KH  = sale_target ÷ số tháng đặt  (logic bộ / vật tư lẻ)
-- =====================================================================
create or replace function public.refresh_usage_indicators()
returns void language plpgsql
set search_path = public, app_order, shared
as $$
declare
  v_y   int;
  v_m   int;
  v_cfg jsonb;
  v_so_thang_dat int;
  v_leadtime     int;
  v_kh_months    text[];
  v_base_m int;
  v_base_y int;
begin
  v_y := extract(year from now())::int;
  v_m := extract(month from now())::int;

  -- Đọc config gợi ý (dùng mặc định toàn cục cho KH window)
  select coalesce(value, '{}'::jsonb) into v_cfg
  from app_order.app_config where key = 'goi_y';
  v_cfg := coalesce(v_cfg, '{}'::jsonb);

  v_so_thang_dat := greatest(1, round(coalesce(
    (v_cfg->>'so_thang_dat_default')::numeric, 3))::int);
  v_leadtime := greatest(0, round(coalesce(
    (v_cfg->>'leadtime_thang_default')::numeric,
    (v_cfg->>'so_thang_dat_default')::numeric, 3))::int);

  -- Cửa sổ KH: giờ VN (UTC+7), khớp JS planMonthsKH(count, offset)
  v_base_m := extract(month from now() at time zone 'Asia/Ho_Chi_Minh')::int
              - 1 + v_leadtime;                               -- 0-based + offset
  v_base_y := extract(year  from now() at time zone 'Asia/Ho_Chi_Minh')::int;
  v_base_y := v_base_y + floor(v_base_m / 12.0)::int;
  v_base_m := ((v_base_m % 12) + 12) % 12;
  v_kh_months := array[]::text[];
  for i in 0 .. v_so_thang_dat - 1 loop
    v_kh_months := v_kh_months
      || (v_base_y || '-' || lpad((v_base_m + 1)::text, 2, '0'));
    v_base_m := v_base_m + 1;
    if v_base_m > 11 then v_base_m := 0; v_base_y := v_base_y + 1; end if;
  end loop;

  delete from app_order.usage_indicators;

  insert into app_order.usage_indicators
    (mien, ma_bravo, tb_th, ty_le_sd_pct, th_raw, th_product_raw,
     sl_th_fy24, sl_th_fy25, sl_th_fy26_ytd, tb_kh_3_thang, updated_at)
  with
  -- ── sv: parse 1 lần cho cả TH lẫn FY ──
  sv_base as (
    select
      case when s.area in ('MB','Miền Bắc') then 'MB'
           when s.area in ('MN','Miền Nam') then 'MN' end  as mien,
      s.item_code,
      (split_part(s.month,'-',1))::int as y,
      (split_part(s.month,'-',2))::int as mo,
      coalesce(s.quantity, 0)          as q
    from app_order.sv s
    where s.item_code is not null
      and s.month ~ '^[0-9]{4}-[0-9]{1,2}'
      and s.area in ('MB','Miền Bắc','MN','Miền Nam')
      and s.month >= '2024-01'
  ),

  -- ── per-month: gộp 1 dòng / (mien, item, tháng) để đếm tháng đúng ──
  per_month as (
    select b.mien, b.item_code, b.y, b.mo, sum(b.q) as q
    from sv_base b where b.mien is not null
    group by b.mien, b.item_code, b.y, b.mo
  ),

  -- ── TH: tổng + số tháng có phát sinh trong cửa sổ ──
  usage_raw as (
    select m.mien, m.item_code,
      coalesce(sum(m.q) filter (
        where m.q > 0 and m.y*12+m.mo <= v_y*12+v_m-1), 0)        as th,
      coalesce(count(*) filter (
        where m.q > 0 and m.y*12+m.mo <= v_y*12+v_m-1), 0)::int   as th_months
    from per_month m
    where m.y >= v_y - 1
    group by m.mien, m.item_code
  ),

  -- ── FY: tổng theo Fiscal Year (từ sv_base, không qua per_month) ──
  fy_raw as (
    select b.mien, b.item_code,
      coalesce(sum(b.q) filter (where
        (b.y=2024 and b.mo>=4) or (b.y=2025 and b.mo<=3)), 0)      as sl_fy24,
      coalesce(sum(b.q) filter (where
        (b.y=2025 and b.mo>=4) or (b.y=2026 and b.mo<=3)), 0)      as sl_fy25,
      coalesce(sum(b.q) filter (where
        ((b.y=2026 and b.mo>=4) or (b.y=2027 and b.mo<=3))
        and b.y*12+b.mo <= v_y*12+v_m), 0)                         as sl_fy26_ytd
    from sv_base b where b.mien is not null
    group by b.mien, b.item_code
  ),

  -- ── san_pham lookup (cho %SD — gồm cả vật tư không đặt hàng) ──
  vt_sp as (
    select d.ma_bravo,
      coalesce(nullif(trim(max(d.san_pham)),''), '__' || d.ma_bravo) as san_pham
    from shared.dm_vat_tu d group by d.ma_bravo
  ),
  usage_sp as (
    select ur.mien, ur.item_code,
      coalesce(vt.san_pham, '__' || ur.item_code) as san_pham,
      ur.th, ur.th_months
    from usage_raw ur
    left join vt_sp vt on vt.ma_bravo = ur.item_code
  ),
  product_th as (
    select us.mien, us.san_pham, sum(us.th) as total_th
    from usage_sp us group by us.mien, us.san_pham
  ),
  usage_ind as (
    select us.mien, us.item_code,
      case when us.th_months > 0
           then round(us.th / us.th_months) else 0 end             as tb_th,
      case when pt.total_th > 0
           then round((us.th / pt.total_th) * 100)::int else 0 end as ty_le_sd_pct,
      us.th                     as th_raw,
      coalesce(pt.total_th, 0)  as th_product_raw
    from usage_sp us
    left join product_th pt on pt.mien = us.mien and pt.san_pham = us.san_pham
  ),

  -- ── Sale target: tổng KH cho cửa sổ, per (miền, norm_key(san_pham)) ──
  st_sum as (
    select
      case when st.mien in ('MB','Miền Bắc') then 'MB'
           when st.mien in ('MN','Miền Nam') then 'MN' end  as mien,
      app_order.norm_key(st.san_pham)                        as sp_key,
      sum(case when st.sl_ke_hoach_update is not null
               then coalesce(st.sl_ke_hoach_update, 0)
               else coalesce(st.sl_ke_hoach_dau_nam, 0) end) as tong
    from shared.sale_target st
    where st.thang_ke_hoach = any(v_kh_months)
      and st.mien in ('MB','Miền Bắc','MN','Miền Nam')
    group by 1, 2
  ),

  -- ── Mapping bộ / vật tư lẻ ──
  mapping_raw as (
    select
      app_order.norm_key(m.san_pham)  as sp_key,
      app_order.norm_key(m.bo_vat_tu) as bo_key,
      app_order.norm_key(m.bo_vat_tu) like 'vật tư riêng lẻ%' as is_le
    from shared.dm_bo_vat_tu_mapping m
    where m.san_pham is not null and trim(m.san_pham) <> ''
  ),
  mapping_class as (
    select mr.sp_key,
      bool_or(mr.is_le) as has_le,
      array_agg(distinct mr.bo_key)
        filter (where not mr.is_le and mr.bo_key <> '') as bos
    from mapping_raw mr group by mr.sp_key
  ),
  bo_expanded as (
    select mc.sp_key, unnest(mc.bos) as bo_key
    from mapping_class mc
    where not mc.has_le
      and mc.bos is not null and array_length(mc.bos,1) > 0
  ),
  bo_st_sum as (
    select be.sp_key, ss.mien, sum(ss.tong) as tong
    from bo_expanded be
    join st_sum ss on ss.sp_key = be.bo_key
    group by be.sp_key, ss.mien
  ),

  -- ── Base: tất cả vật tư đặt hàng × 2 miền ──
  vt_dat_hang as (
    select d.ma_bravo,
      app_order.norm_key(coalesce(max(d.san_pham),'')) as sp_key
    from shared.dm_vat_tu d where d.dat_hang = true
    group by d.ma_bravo
  ),
  vt_mien as (
    select v.ma_bravo, v.sp_key, ml.mien
    from vt_dat_hang v
    cross join (select unnest(array['MB','MN']) as mien) ml
  ),

  -- ── TB KH per (mien, ma_bravo) ──
  tb_kh as (
    select vm.mien, vm.ma_bravo,
      case
        when mc.sp_key is null or mc.has_le
             or mc.bos is null or array_length(mc.bos,1) is null
             or array_length(mc.bos,1) = 0
        then coalesce(sd.tong, 0)
        else coalesce(bs.tong, 0)
      end / greatest(1, v_so_thang_dat)::numeric  as tb_kh_3_thang
    from vt_mien vm
    left join mapping_class mc on mc.sp_key = vm.sp_key
    left join st_sum sd        on sd.mien = vm.mien and sd.sp_key = vm.sp_key
    left join bo_st_sum bs     on bs.sp_key = vm.sp_key and bs.mien = vm.mien
  )

  -- ── Final: ghép tất cả chỉ số ──
  select
    vm.mien,
    vm.ma_bravo,
    coalesce(ui.tb_th, 0),
    coalesce(ui.ty_le_sd_pct, 0)::int,
    coalesce(ui.th_raw, 0),
    coalesce(ui.th_product_raw, 0),
    coalesce(fy.sl_fy24, 0),
    coalesce(fy.sl_fy25, 0),
    coalesce(fy.sl_fy26_ytd, 0),
    coalesce(kh.tb_kh_3_thang, 0),
    now()
  from vt_mien vm
  left join usage_ind ui on ui.mien = vm.mien and ui.item_code = vm.ma_bravo
  left join fy_raw fy    on fy.mien = vm.mien and fy.item_code = vm.ma_bravo
  left join tb_kh kh     on kh.mien = vm.mien and kh.ma_bravo  = vm.ma_bravo;
end;
$$;

grant execute on function app_order.norm_key(text)           to anon, authenticated, service_role;
grant execute on function public.refresh_usage_indicators()  to anon, authenticated, service_role;
