-- =====================================================================
--  23 — logistics_input có lịch sử theo ngày chốt (snapshot_date)
--
--  Trước: 1 dòng / (ma_bravo, mien), mỗi lần upload ghi đè -> mọi đợt (cũ lẫn
--  mới) đọc chung 1 bộ số, và mã không còn trong file mới bị đọng lại.
--  Sau:  1 dòng / (snapshot_date, mien, ma_bravo). Mỗi lần upload = 1 snapshot
--  (D:/1. GIANG/Data/Script/import supabase: build_logistics_input.py +
--  hang_di_duong_hang_ky_gui_pipeline.py). stock_agg chốt snapshot hiệu lực theo
--  từng miền giống cycledate của stock: mới nhất có ngày <= ngày mở đợt; đợt
--  mở trước snapshot đầu tiên dùng snapshot sớm nhất; p_ngaymo null -> mới nhất.
--
--  Dữ liệu hiện có (đã đưa về đúng template 26.10, backup ở
--  app_order.logistics_input_bak_20261102) -> snapshot 2026-10-26.
--  Rollback: 23_logistics_snapshot_date_ROLLBACK.sql
-- =====================================================================
begin;

alter table app_order.logistics_input
  add column if not exists snapshot_date date not null default date '2026-10-26';
alter table app_order.logistics_input alter column snapshot_date set default current_date;

alter table app_order.logistics_input drop constraint if exists logistics_input_pkey;
alter table app_order.logistics_input
  add constraint logistics_input_pkey primary key (snapshot_date, mien, ma_bravo);

create or replace function public.stock_agg(p_mien text, p_ngaymo timestamptz default null)
returns table (mien text, ma_bravo text, ton_kho numeric,
               hang_vet_thau numeric, hang_ktv_bv numeric, hang_di_duong numeric)
language plpgsql stable
set search_path to 'public', 'extensions'
as $$
declare
  cd_mb app_order.stock.cycledate%type;
  cd_mn app_order.stock.cycledate%type;
  sd_mb date;
  sd_mn date;
begin
  if p_mien in ('ALL','MB') then
    select st.cycledate into cd_mb from app_order.stock st
    where st.mien = any(array['MB','Miền Bắc'])
      and (p_ngaymo is null or st.cycledate::date <= p_ngaymo::date)
    order by st.cycledate desc nulls last limit 1;
    select coalesce(
             (select max(l.snapshot_date) from app_order.logistics_input l
               where l.mien = 'MB' and (p_ngaymo is null or l.snapshot_date <= p_ngaymo::date)),
             (select min(l.snapshot_date) from app_order.logistics_input l where l.mien = 'MB'))
      into sd_mb;
  end if;
  if p_mien in ('ALL','MN') then
    select st.cycledate into cd_mn from app_order.stock st
    where st.mien = any(array['MN','Miền Nam'])
      and (p_ngaymo is null or st.cycledate::date <= p_ngaymo::date)
    order by st.cycledate desc nulls last limit 1;
    select coalesce(
             (select max(l.snapshot_date) from app_order.logistics_input l
               where l.mien = 'MN' and (p_ngaymo is null or l.snapshot_date <= p_ngaymo::date)),
             (select min(l.snapshot_date) from app_order.logistics_input l where l.mien = 'MN'))
      into sd_mn;
  end if;

  return query
  with stk as (   -- gộp quantity theo ma_bravo, tách DA/GU tại cycledate hiệu lực
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
  lg as (    -- logistics_input tại snapshot hiệu lực của từng miền
    select l.mien, l.ma_bravo,
      sum(coalesce(l.hang_di_duong, 0)) as hang_di_duong,
      sum(coalesce(l.hang_ktv_bv, 0))   as hang_ktv_bv
    from app_order.logistics_input l
    where (l.mien = 'MB' and l.snapshot_date = sd_mb)
       or (l.mien = 'MN' and l.snapshot_date = sd_mn)
    group by l.mien, l.ma_bravo
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

-- Kiểm tra:
--   select snapshot_date, mien, count(*), sum(hang_di_duong), sum(hang_ktv_bv)
--     from app_order.logistics_input group by 1, 2 order by 1, 2;
--   select sum(hang_di_duong), sum(hang_ktv_bv) from public.stock_agg('ALL');
