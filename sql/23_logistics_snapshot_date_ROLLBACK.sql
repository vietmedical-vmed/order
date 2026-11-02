-- =====================================================================
--  ROLLBACK 23 — bỏ snapshot_date, giữ lại snapshot MỚI NHẤT của từng miền
--  (các snapshot cũ bị xoá) và trả stock_agg về bản đọc toàn bảng.
-- =====================================================================
begin;

delete from app_order.logistics_input l
 where l.snapshot_date < (select max(x.snapshot_date) from app_order.logistics_input x
                           where x.mien = l.mien);

alter table app_order.logistics_input drop constraint if exists logistics_input_pkey;
alter table app_order.logistics_input drop column if exists snapshot_date;
alter table app_order.logistics_input
  add constraint logistics_input_pkey primary key (ma_bravo, mien);

create or replace function public.stock_agg(p_mien text, p_ngaymo timestamptz default null)
returns table (mien text, ma_bravo text, ton_kho numeric,
               hang_vet_thau numeric, hang_ktv_bv numeric, hang_di_duong numeric)
language plpgsql stable
set search_path to 'public', 'extensions'
as $$
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

commit;
