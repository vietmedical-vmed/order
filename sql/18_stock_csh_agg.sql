-- =====================================================================
--  stock_csh_agg — tồn kho (DA) / vét thầu (GU) tách theo chủ sở hữu ĐKLH
--  (stock.csh_dklh), dùng cho filter "Chủ sở hữu ĐKLH" trên màn Đặt hàng.
--
--  Chốt cycledate hiệu lực giống hệt stock_agg (mới nhất <= ngày mở đợt, theo
--  từng miền). Lô chưa có csh_dklh gom vào csh = '' (= "Không có thông tin").
--  Hàng ký gửi / đi đường (logistics_input) không có chủ sở hữu -> không nằm ở
--  đây; edge function giữ nguyên các cột đó ở mọi lựa chọn filter.
-- =====================================================================
create or replace function public.stock_csh_agg(p_mien text, p_ngaymo timestamptz default null)
returns table (mien text, ma_bravo text, csh text, ton_kho numeric, hang_vet_thau numeric)
language plpgsql stable
set search_path = ''
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
  select
    case when s.mien in ('MB','Miền Bắc') then 'MB'
         when s.mien in ('MN','Miền Nam') then 'MN' end as mien,
    s.ma_bravo,
    coalesce(nullif(trim(s.csh_dklh), ''), '') as csh,
    coalesce(sum(coalesce(s.quantity, 0)) filter (
      where upper(trim(regexp_replace(coalesce(s.warehousetype, ''), '^.*\.', ''))) = 'DA'
    ), 0) as ton_kho,
    coalesce(sum(coalesce(s.quantity, 0)) filter (
      where upper(trim(regexp_replace(coalesce(s.warehousetype, ''), '^.*\.', ''))) = 'GU'
    ), 0) as hang_vet_thau
  from app_order.stock s
  where s.ma_bravo is not null
    and (
         (s.mien in ('MB','Miền Bắc') and p_mien in ('ALL','MB') and (cd_mb is null or s.cycledate = cd_mb))
      or (s.mien in ('MN','Miền Nam') and p_mien in ('ALL','MN') and (cd_mn is null or s.cycledate = cd_mn))
    )
  group by 1, s.ma_bravo, 3;
end $$;

revoke execute on function public.stock_csh_agg(text, timestamptz) from public, anon;
grant execute on function public.stock_csh_agg(text, timestamptz) to authenticated, service_role;
