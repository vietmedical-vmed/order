-- =====================================================================
--  03_rpc_aggregates.sql  —  Aggregate ngay trong Postgres cho loadOrderScreen
--  Mục tiêu: thay vì Edge Function kéo toàn bộ sv (~54k) / stock (~16k) về
--  rồi group bằng JS qua hàng chục request phân trang tuần tự, ta group
--  ngay trong DB và chỉ trả về vài nghìn dòng đã tổng hợp -> 1 RPC/loại.
--
--  QUY ƯỚC MIỀN: các bảng lưu 'MB'/'Miền Bắc' và 'MN'/'Miền Nam' lẫn lộn;
--  các hàm dưới chuẩn hoá về 'MB'/'MN' ở cột mien trả ra.
--
--  Chạy thủ công trên Supabase SQL Editor (giống 01/02). Idempotent.
-- =====================================================================

-- ---------- INDEX phục vụ RPC (production-only, trước đây note thủ công) ----------
create index if not exists idx_sv_area_month           on public.sv (area, month);
create index if not exists idx_sale_target_mien_thang  on public.sale_target (mien, thang_ke_hoach);
-- stock đã có idx_stock_mien_cycle (mien, cycledate desc) ở 02_order_app.sql.

-- =====================================================================
--  usage_agg — thay usageMapFor (đọc bảng sv)
--  Trả per (mien, item_code): ytd/cknt/yr THÔ (chưa chia, chưa làm tròn) +
--  san_pham (join dm_vat_tu) để JS tính %SD và làm tròn y hệt logic cũ.
--    ytd  = Σ quantity của năm p_y, tháng 1..p_m-1
--    cknt = Σ quantity trong cửa sổ 3 tháng CKNT: (p_y-1, p_m) .. +2 (vắt năm)
--    yr   = Σ quantity của năm p_y (dùng cho %SD)
--  p_y / p_m = năm/tháng hiện tại theo giờ UTC (khớp `new Date()` trong Deno).
-- =====================================================================
create or replace function public.usage_agg(p_mien text, p_y int, p_m int)
returns table (mien text, item_code text, san_pham text,
               ytd numeric, cknt numeric, yr numeric)
language sql stable as $$
  with base as (
    select
      case when s.area in ('MB','Miền Bắc') then 'MB'
           when s.area in ('MN','Miền Nam') then 'MN' end               as mien,
      s.item_code,
      (split_part(s.month, '-', 1))::int                                as y,
      (split_part(s.month, '-', 2))::int                                as mo,
      coalesce(s.quantity, 0)                                           as q
    from public.sv s
    where s.item_code is not null
      and s.month ~ '^[0-9]{4}-[0-9]{1,2}'
      and s.month >= ((p_y - 1)::text || '-01')          -- chỉ từ T01 năm ngoái
      and ( (p_mien = 'ALL' and s.area in ('MB','Miền Bắc','MN','Miền Nam'))
         or (p_mien = 'MB'  and s.area in ('MB','Miền Bắc'))
         or (p_mien = 'MN'  and s.area in ('MN','Miền Nam')) )
  )
  select
    b.mien,
    b.item_code,
    max(d.san_pham)                                                     as san_pham,
    sum(b.q) filter (where b.y = p_y and b.mo <= p_m - 1)               as ytd,
    sum(b.q) filter (
      where (b.y * 12 + b.mo)
            between ((p_y - 1) * 12 + p_m) and ((p_y - 1) * 12 + p_m + 2)
    )                                                                   as cknt,
    sum(b.q) filter (where b.y = p_y)                                   as yr
  from base b
  left join public.dm_vat_tu d on d.ma_bravo = b.item_code
  where b.mien is not null
  group by b.mien, b.item_code;
$$;

-- =====================================================================
--  stock_agg — thay stockMapFor (đọc bảng stock + logistics_input)
--  Chốt cycledate hiệu lực cho từng miền (mới nhất < p_ngaymo, hoặc mới nhất
--  tuyệt đối nếu p_ngaymo null), gộp quantity theo warehousetype:
--    DA -> ton_kho, GU -> hang_vet_thau  (lấy đuôi sau dấu '.' nếu có).
--  Cộng hang_di_duong / hang_ktv_bv từ logistics_input.
--  Trả per (mien, ma_bravo); JS ghép ALL và tính tong_ton y như cũ.
-- =====================================================================
create or replace function public.stock_agg(p_mien text, p_ngaymo timestamptz default null)
returns table (mien text, ma_bravo text, ton_kho numeric,
               hang_vet_thau numeric, hang_ktv_bv numeric, hang_di_duong numeric)
language plpgsql stable as $$
begin
  return query
  with miens as (
    select m from (values ('MB'), ('MN')) v(m)
    where p_mien = 'ALL' or p_mien = m
  ),
  cyc as (   -- cycledate hiệu lực cho mỗi miền
    select mn.m as mien,
      ( select st.cycledate
        from public.stock st
        where st.mien = any(case mn.m when 'MB' then array['MB','Miền Bắc']
                                      else array['MN','Miền Nam'] end)
          and (p_ngaymo is null or st.cycledate < p_ngaymo)
        order by st.cycledate desc nulls last
        limit 1 ) as cd
    from miens mn
  ),
  stk as (   -- gộp quantity theo ma_bravo, tách DA/GU tại cycledate hiệu lực
    select c.mien, s.ma_bravo,
      sum(coalesce(s.quantity, 0)) filter (
        where upper(trim(regexp_replace(coalesce(s.warehousetype, ''), '^.*\.', ''))) = 'DA'
      ) as ton_kho,
      sum(coalesce(s.quantity, 0)) filter (
        where upper(trim(regexp_replace(coalesce(s.warehousetype, ''), '^.*\.', ''))) = 'GU'
      ) as hang_vet_thau
    from cyc c
    join public.stock s
      on s.mien = any(case c.mien when 'MB' then array['MB','Miền Bắc']
                                  else array['MN','Miền Nam'] end)
     and (c.cd is null or s.cycledate = c.cd)
    where s.ma_bravo is not null
    group by c.mien, s.ma_bravo
  ),
  lg as (    -- logistics_input: 1 dòng / (ma_bravo, mien)
    select mn.m as mien, l.ma_bravo,
      sum(coalesce(l.hang_di_duong, 0)) as hang_di_duong,
      sum(coalesce(l.hang_ktv_bv, 0))   as hang_ktv_bv
    from miens mn
    join public.logistics_input l
      on l.mien = any(case mn.m when 'MB' then array['MB','Miền Bắc']
                                else array['MN','Miền Nam'] end)
    group by mn.m, l.ma_bravo
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

-- =====================================================================
--  sale_target_agg — thay saleTargetSumByBo (đọc bảng sale_target)
--  Lọc theo p_months (3 tháng kế hoạch), gộp theo san_pham THÔ; JS chuẩn hoá
--  normKey rồi cộng dồn (cả ghép 2 miền cho ALL — thuần cộng nên gộp thẳng).
--    tong = Σ coalesce(sl_ke_hoach_update, sl_ke_hoach_dau_nam)
-- =====================================================================
create or replace function public.sale_target_agg(p_mien text, p_months text[])
returns table (mien text, san_pham text, tong numeric)
language sql stable as $$
  select
    case when st.mien in ('MB','Miền Bắc') then 'MB'
         when st.mien in ('MN','Miền Nam') then 'MN' end as mien,
    st.san_pham,
    sum(case when st.sl_ke_hoach_update is not null
             then coalesce(st.sl_ke_hoach_update, 0)
             else coalesce(st.sl_ke_hoach_dau_nam, 0) end) as tong
  from public.sale_target st
  where st.thang_ke_hoach = any(p_months)
    and ( (p_mien = 'ALL' and st.mien in ('MB','Miền Bắc','MN','Miền Nam'))
       or (p_mien = 'MB'  and st.mien in ('MB','Miền Bắc'))
       or (p_mien = 'MN'  and st.mien in ('MN','Miền Nam')) )
  group by 1, st.san_pham;
$$;

-- ---------- Quyền thực thi ----------
grant execute on function public.usage_agg(text, int, int)          to anon, authenticated, service_role;
grant execute on function public.stock_agg(text, timestamptz)       to anon, authenticated, service_role;
grant execute on function public.sale_target_agg(text, text[])      to anon, authenticated, service_role;
