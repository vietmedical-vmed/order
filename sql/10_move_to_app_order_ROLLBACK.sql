-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK cho 10_move_to_app_order.sql
-- Đưa 9 bảng order về public và khôi phục 3 RPC về bản đọc public.
-- Chạy xong: gỡ "app_order" khỏi Exposed schemas + revert code (git revert).
-- ════════════════════════════════════════════════════════════════════════

begin;

-- 1) Chuyển bảng về public
do $$
declare r text;
begin
  foreach r in array array[
    'order_sessions','order_items','order_config_log','audit_log','stock',
    'login_attempts','app_config','sv','logistics_input','order_catalog','usage_stat'
  ]
  loop
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app_order' and c.relname = r and c.relkind = 'r'
    ) then
      execute format('alter table app_order.%I set schema public', r);
    end if;
  end loop;
end $$;

-- 2) Khôi phục 3 RPC về đọc public.* (chỉ đổi lại tham chiếu schema)
create or replace function public.usage_agg(p_mien text, p_y int, p_m int)
returns table (mien text, item_code text, san_pham text, th numeric, th_months int)
language sql stable as $$
  with base as (
    select case when s.area in ('MB','Miền Bắc') then 'MB'
                when s.area in ('MN','Miền Nam') then 'MN' end as mien,
           s.item_code, (split_part(s.month,'-',1))::int as y,
           (split_part(s.month,'-',2))::int as mo, coalesce(s.quantity,0) as q
    from public.sv s
    where s.item_code is not null and s.month ~ '^[0-9]{4}-[0-9]{1,2}'
      and s.month >= ((p_y-1)::text || '-01')
      and ( (p_mien='ALL' and s.area in ('MB','Miền Bắc','MN','Miền Nam'))
         or (p_mien='MB' and s.area in ('MB','Miền Bắc'))
         or (p_mien='MN' and s.area in ('MN','Miền Nam')) )
  ),
  per_month as (select b.mien,b.item_code,b.y,b.mo,sum(b.q) as q from base b
                where b.mien is not null group by b.mien,b.item_code,b.y,b.mo),
  agg as (select m.mien,m.item_code,
            coalesce(sum(m.q) filter (where m.q>0 and (m.y*12+m.mo)<=(p_y*12+p_m-1)),0) as th,
            (count(*) filter (where m.q>0 and (m.y*12+m.mo)<=(p_y*12+p_m-1)))::int as th_months
          from per_month m group by m.mien,m.item_code),
  vt as (select d.ma_bravo,max(d.san_pham) as san_pham from public.dm_vat_tu d group by d.ma_bravo)
  select a.mien,a.item_code,vt.san_pham,a.th,a.th_months
  from agg a left join vt on vt.ma_bravo=a.item_code;
$$;

create or replace function public.stock_agg(p_mien text, p_ngaymo timestamptz default null)
returns table (mien text, ma_bravo text, ton_kho numeric,
               hang_vet_thau numeric, hang_ktv_bv numeric, hang_di_duong numeric)
language plpgsql stable as $$
declare cd_mb stock.cycledate%type; cd_mn stock.cycledate%type;
begin
  if p_mien in ('ALL','MB') then
    select st.cycledate into cd_mb from public.stock st
    where st.mien = any(array['MB','Miền Bắc'])
      and (p_ngaymo is null or st.cycledate::date <= p_ngaymo::date)
    order by st.cycledate desc nulls last limit 1;
  end if;
  if p_mien in ('ALL','MN') then
    select st.cycledate into cd_mn from public.stock st
    where st.mien = any(array['MN','Miền Nam'])
      and (p_ngaymo is null or st.cycledate::date <= p_ngaymo::date)
    order by st.cycledate desc nulls last limit 1;
  end if;
  return query
  with stk as (
    select case when s.mien in ('MB','Miền Bắc') then 'MB'
                when s.mien in ('MN','Miền Nam') then 'MN' end as mien, s.ma_bravo,
      sum(coalesce(s.quantity,0)) filter (where upper(trim(regexp_replace(coalesce(s.warehousetype,''),'^.*\.','')))='DA') as ton_kho,
      sum(coalesce(s.quantity,0)) filter (where upper(trim(regexp_replace(coalesce(s.warehousetype,''),'^.*\.','')))='GU') as hang_vet_thau
    from public.stock s
    where s.ma_bravo is not null
      and ( (s.mien in ('MB','Miền Bắc') and p_mien in ('ALL','MB') and (cd_mb is null or s.cycledate=cd_mb))
         or (s.mien in ('MN','Miền Nam') and p_mien in ('ALL','MN') and (cd_mn is null or s.cycledate=cd_mn)) )
    group by 1,s.ma_bravo
  ),
  lg as (
    select case when l.mien in ('MB','Miền Bắc') then 'MB'
                when l.mien in ('MN','Miền Nam') then 'MN' end as mien, l.ma_bravo,
      sum(coalesce(l.hang_di_duong,0)) as hang_di_duong, sum(coalesce(l.hang_ktv_bv,0)) as hang_ktv_bv
    from public.logistics_input l
    where (l.mien in ('MB','Miền Bắc') and p_mien in ('ALL','MB'))
       or (l.mien in ('MN','Miền Nam') and p_mien in ('ALL','MN'))
    group by 1,l.ma_bravo
  )
  select coalesce(stk.mien,lg.mien), coalesce(stk.ma_bravo,lg.ma_bravo),
         coalesce(stk.ton_kho,0), coalesce(stk.hang_vet_thau,0),
         coalesce(lg.hang_ktv_bv,0), coalesce(lg.hang_di_duong,0)
  from stk full join lg on lg.mien=stk.mien and lg.ma_bravo=stk.ma_bravo;
end $$;

create or replace function public.session_stats()
returns table (session_id uuid, sku bigint, sl_dat numeric, sl_duyet numeric,
               sl_dat_hang numeric, approved_sku bigint, ordered_sku bigint)
language sql stable as $$
  select oi.session_id, count(*) as sku,
         sum(coalesce(oi.sl_dat,0)), sum(coalesce(oi.sl_duyet,0)),
         sum(coalesce(oi.sl_dat_hang,0)), count(oi.sl_duyet), count(oi.sl_dat_hang)
  from public.order_items oi group by oi.session_id;
$$;

commit;

-- drop schema if exists app_order restrict;   -- chỉ khi đã rỗng
