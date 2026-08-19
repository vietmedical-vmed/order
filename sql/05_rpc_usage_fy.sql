-- =====================================================================
--  05_rpc_usage_fy.sql  —  SL thực hiện theo Fiscal Year (FY = T04..T03)
--
--  Trả per (mien, item_code): tổng SL xuất trong từng FY.
--    FY24 = 2024-04 .. 2025-03
--    FY25 = 2025-04 .. 2026-03
--    FY26 YTD = 2026-04 .. tháng hiện tại (p_y, p_m)
--
--  Dùng cùng bảng app_order.sv và index idx_sv_area_month đã có.
--  Chạy thủ công trên Supabase SQL Editor. Idempotent.
-- =====================================================================

create or replace function public.usage_fy_agg(p_mien text, p_y int, p_m int)
returns table (mien text, item_code text,
               sl_fy24 numeric, sl_fy25 numeric, sl_fy26_ytd numeric)
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
      and s.month >= '2024-04'
      and ( (p_mien = 'ALL' and s.area in ('MB','Miền Bắc','MN','Miền Nam'))
         or (p_mien = 'MB'  and s.area in ('MB','Miền Bắc'))
         or (p_mien = 'MN'  and s.area in ('MN','Miền Nam')) )
  )
  select
    b.mien,
    b.item_code,
    coalesce(sum(b.q) filter (where
      (b.y = 2024 and b.mo >= 4) or (b.y = 2025 and b.mo <= 3)
    ), 0) as sl_fy24,
    coalesce(sum(b.q) filter (where
      (b.y = 2025 and b.mo >= 4) or (b.y = 2026 and b.mo <= 3)
    ), 0) as sl_fy25,
    coalesce(sum(b.q) filter (where
      ((b.y = 2026 and b.mo >= 4) or (b.y = 2027 and b.mo <= 3))
      and (b.y * 12 + b.mo <= p_y * 12 + p_m)
    ), 0) as sl_fy26_ytd
  from base b
  where b.mien is not null
  group by b.mien, b.item_code;
$$;

grant execute on function public.usage_fy_agg(text, int, int) to anon, authenticated, service_role;
