-- ============================================================
--  26_backtest_goi_y.sql  —  Backtest công thức Gợi ý (tab "Kiểm chứng gợi ý")
-- ============================================================
--  public.backtest_goi_y(p_asof 'YYYY-MM') -> jsonb
--
--  Đặt mình ở đầu tháng p_asof (= mốc T) và tính lại các chỉ số Gợi ý CHỈ bằng dữ liệu
--  có trước T, rồi trả kèm SL thực tế các tháng sau T để so sánh. Logic chỉ số chép từ
--  refresh_usage_indicators() bản sql/25 — đổi logic ở đó thì đổi cả ở đây.
--
--    TB TH  : cửa sổ hết ở tháng T-1. "Hay sử dụng" 6 tháng, còn lại 12 tháng.
--             Nguồn: sv cho mã CH&CS (và mã ngoài dm_vat_tu), hoá đơn cho BU khác.
--             th_a = cách production (chia cho SỐ THÁNG CÓ PHÁT SINH, làm tròn từng mã).
--             th_b = biến thể chia cho số tháng của cửa sổ (chỉ tính tháng nguồn đã có dữ liệu).
--    KH     : kh_m[k] = Σ sale_target tháng T+k (ưu tiên sl_ke_hoach_update), k = 0 … 17.
--             kh_m_dn[k] = chỉ sl_ke_hoach_dau_nam (tránh KH được sửa sau T).
--             Client tự chia cửa sổ: production lấy TB KH theo leadtime / số tháng đặt MẶC ĐỊNH
--             (kh_def_lt, kh_def_n — cùng cách làm tròn với refresh_usage_indicators).
--    Tồn    : snapshot stock SỚM NHẤT trong tháng T của từng miền (null nếu tháng đó chưa
--             có snapshot — không dùng stock_agg với ngày không có snapshot vì khi đó nó
--             cộng dồn mọi cycledate).
--    Thực tế: act[k] = Σ SL ròng tháng T+k, k = 0 … 17 (null khi tháng đó chưa đủ dữ liệu).
--             18 tháng để client áp cửa sổ leadtime / số tháng đặt riêng của từng nhóm.
--
--  Mức trả về: SẢN PHẨM × miền (giống chỗ tính Gợi ý ở order-api), chỉ vật tư dat_hang
--  có san_pham. Hệ số k1/k2 và cửa sổ áp ở client để thử nhiều cấu hình mà không gọi lại.
--
--  Chỉ đọc, không ghi bảng nào. Rollback: drop function public.backtest_goi_y(text);
-- ============================================================

drop function if exists public.backtest_goi_y(text, int, int);

create or replace function public.backtest_goi_y(p_asof text)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public', 'app_order', 'shared'
as $function$
declare
  c_k  constant int := 18;       -- số tháng trả về cho KH và thực tế (T … T+17)
  v_y  int;
  v_m  int;
  v_t  int;                      -- chỉ số tháng T = y*12 + m (cùng quy ước với sql/25)
  v_months text[];
  v_cfg jsonb;
  v_def_n  int;
  v_def_lt int;
  v_last int;                    -- tháng cuối cùng đã đủ dữ liệu thực tế
  v_sv_start int;
  v_hd_start int;
  d_mb date;
  d_mn date;
  v_rows jsonb;
begin
  if p_asof is null or p_asof !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'Mốc phải có dạng YYYY-MM (nhận: %)', p_asof;
  end if;
  v_y := split_part(p_asof, '-', 1)::int;
  v_m := split_part(p_asof, '-', 2)::int;
  v_t := v_y * 12 + v_m;

  select array_agg(to_char(make_date((v_t + g - 1) / 12, (v_t + g - 1) % 12 + 1, 1), 'YYYY-MM') order by g)
    into v_months
  from generate_series(0, c_k - 1) g;

  -- Cửa sổ TB KH mặc định, cùng cách đọc + làm tròn với refresh_usage_indicators (sql/25).
  select coalesce(value, '{}'::jsonb) into v_cfg from app_order.app_config where key = 'goi_y';
  v_cfg := coalesce(v_cfg, '{}'::jsonb);
  v_def_n := greatest(1, round(coalesce((v_cfg->>'so_thang_dat_default')::numeric, 3))::int);
  v_def_lt := greatest(0, round(coalesce((v_cfg->>'leadtime_thang_default')::numeric,
                                         (v_cfg->>'so_thang_dat_default')::numeric, 3))::int);

  -- Tháng đủ dữ liệu = min(tháng cuối của sv, tháng cuối của hoá đơn, tháng trước tháng hiện tại).
  select max(split_part(s.month, '-', 1)::int * 12 + split_part(s.month, '-', 2)::int),
         min(split_part(s.month, '-', 1)::int * 12 + split_part(s.month, '-', 2)::int)
    into v_last, v_sv_start
  from app_order.sv s where s.month ~ '^[0-9]{4}-[0-9]{1,2}';
  select least(v_last, max(split_part(h.thang, '-', 1)::int * 12 + split_part(h.thang, '-', 2)::int)),
         min(split_part(h.thang, '-', 1)::int * 12 + split_part(h.thang, '-', 2)::int)
    into v_last, v_hd_start
  from app_sale.hoa_don_bovattu h where h.thang ~ '^[0-9]{4}-[0-9]{1,2}';
  v_last := least(v_last,
    extract(year from now() at time zone 'Asia/Ho_Chi_Minh')::int * 12
    + extract(month from now() at time zone 'Asia/Ho_Chi_Minh')::int - 1);

  select min(st.cycledate::date) into d_mb from app_order.stock st
  where st.mien in ('MB', 'Miền Bắc')
    and st.cycledate::date >= make_date(v_y, v_m, 1)
    and st.cycledate::date <  (make_date(v_y, v_m, 1) + interval '1 month')::date;
  select min(st.cycledate::date) into d_mn from app_order.stock st
  where st.mien in ('MN', 'Miền Nam')
    and st.cycledate::date >= make_date(v_y, v_m, 1)
    and st.cycledate::date <  (make_date(v_y, v_m, 1) + interval '1 month')::date;

  with
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
  ),
  vt_bu as (
    select d.ma_bravo, bool_or(d.bu_code = 'chcs') as chcs
    from shared.dm_vat_tu d group by d.ma_bravo
  ),
  ps_mien as (
    select distinct on (x.ps_key) x.ps_key, x.mien
    from (
      select regexp_replace(lower(btrim(p.ten_ps)), '\s+', ' ', 'g') as ps_key,
        case when p.area in ('MB','Miền Bắc') then 'MB'
             when p.area in ('MN','Miền Nam') then 'MN' end        as mien,
        p.trang_thai
      from shared.dm_ps p
      where p.ten_ps is not null
    ) x
    where x.mien is not null
    order by x.ps_key, (x.trang_thai = 'Active') desc
  ),
  th_base as (
    select b.mien, b.item_code, b.y, b.mo, b.q
    from sv_base b
    left join vt_bu vb on vb.ma_bravo = b.item_code
    where b.mien is not null and coalesce(vb.chcs, true)
    union all
    select pm.mien, vb.ma_bravo,
      (split_part(h.thang,'-',1))::int,
      (split_part(h.thang,'-',2))::int,
      coalesce(h.so_luong, 0)
    from app_sale.hoa_don_bovattu h
    join vt_bu vb   on vb.ma_bravo = btrim(h.ma_vat_tu) and not vb.chcs
    join ps_mien pm on pm.ps_key = regexp_replace(lower(btrim(h.ten_ps)), '\s+', ' ', 'g')
    where h.thang ~ '^[0-9]{4}-[0-9]{1,2}'
  ),
  per_month as (
    select b.mien, b.item_code, b.y * 12 + b.mo as idx, sum(b.q) as q
    from th_base b
    where b.y * 12 + b.mo between v_t - 12 and v_t + c_k - 1
    group by b.mien, b.item_code, b.y * 12 + b.mo
  ),
  usage_raw as (
    select m.mien, m.item_code,
      coalesce(sum(m.q)  filter (where m.q > 0 and m.idx between v_t - 12 and v_t - 1), 0)       as th,
      coalesce(count(*)  filter (where m.q > 0 and m.idx between v_t - 12 and v_t - 1), 0)::int  as th_m,
      coalesce(sum(m.q)  filter (where m.q > 0 and m.idx between v_t - 6  and v_t - 1), 0)       as th6,
      coalesce(count(*)  filter (where m.q > 0 and m.idx between v_t - 6  and v_t - 1), 0)::int  as th6_m
    from per_month m
    group by m.mien, m.item_code
  ),
  act_item as (
    select m.mien, m.item_code, m.idx - v_t as k, m.q
    from per_month m
    where m.idx between v_t and v_t + c_k - 1
  ),

  -- ── KH theo tháng (giống sql/25, thêm biến thể chỉ KH đầu năm) ──
  st_sum as (
    select
      case when st.mien in ('MB','Miền Bắc') then 'MB'
           when st.mien in ('MN','Miền Nam') then 'MN' end  as mien,
      app_order.norm_key(st.san_pham)                        as sp_key,
      array_position(v_months, st.thang_ke_hoach) - 1        as k,
      sum(case when st.sl_ke_hoach_update is not null
               then coalesce(st.sl_ke_hoach_update, 0)
               else coalesce(st.sl_ke_hoach_dau_nam, 0) end) as tong,
      sum(coalesce(st.sl_ke_hoach_dau_nam, 0))               as tong_dn
    from shared.sale_target st
    where st.thang_ke_hoach = any(v_months)
      and st.mien in ('MB','Miền Bắc','MN','Miền Nam')
    group by 1, 2, 3
  ),
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
    select be.sp_key, ss.mien, ss.k, sum(ss.tong) as tong, sum(ss.tong_dn) as tong_dn
    from bo_expanded be
    join st_sum ss on ss.sp_key = be.bo_key
    group by be.sp_key, ss.mien, ss.k
  ),

  -- ── Vật tư đặt hàng × 2 miền, chỉ mã có san_pham (order-api bỏ qua mã không có SP) ──
  vt as (
    select d.ma_bravo,
      app_order.norm_key(coalesce(max(d.san_pham), ''))                         as sp_key,
      max(btrim(d.san_pham))                                                    as sp_name,
      max(d.nhom_san_pham)                                                      as nhom,
      max(d.bu_code)                                                            as bu_code,
      coalesce(bool_or(app_order.norm_key(d.muc_do_sd) = 'hay sử dụng'), false) as hay,
      coalesce(max(d.safety_stock), 0)                                          as safety,
      coalesce(bool_or(d.bu_code = 'chcs'), true)                               as chcs
    from shared.dm_vat_tu d where d.dat_hang = true
    group by d.ma_bravo
  ),
  vm as (
    select v.*, ml.mien
    from vt v
    cross join (select unnest(array['MB','MN']) as mien) ml
    where v.sp_key <> ''
  ),
  stk as (
    select s.mien, s.ma_bravo,
      sum(s.ton_kho + s.hang_ktv_bv + s.hang_di_duong - s.hang_vet_thau) as tong_ton
    from (
      select * from public.stock_agg('MB', d_mb::timestamptz) where d_mb is not null
      union all
      select * from public.stock_agg('MN', d_mn::timestamptz) where d_mn is not null
    ) s
    group by s.mien, s.ma_bravo
  ),
  item as (
    select vm.mien, vm.ma_bravo, vm.sp_key, vm.sp_name, vm.nhom, vm.bu_code, vm.hay, vm.safety,
      case when vm.hay
           then case when coalesce(ur.th6_m, 0) > 0 then round(ur.th6 / ur.th6_m) else 0 end
           else case when coalesce(ur.th_m, 0)  > 0 then round(ur.th  / ur.th_m)  else 0 end
      end as tb_a,
      -- chia cho số tháng cửa sổ mà nguồn của mã đã có dữ liệu (hoá đơn chỉ có từ 2025-04)
      coalesce(case when vm.hay then ur.th6 else ur.th end, 0)
        / greatest(1, (v_t - greatest(v_t - case when vm.hay then 6 else 12 end,
                                      case when vm.chcs then v_sv_start else v_hd_start end)))::numeric as tb_b,
      stk.tong_ton
    from vm
    left join usage_raw ur on ur.mien = vm.mien and ur.item_code = vm.ma_bravo
    left join stk          on stk.mien = vm.mien and stk.ma_bravo = vm.ma_bravo
  ),
  -- KH theo tháng của sản phẩm: vật tư lẻ / không mapping -> tra thẳng san_pham, còn lại Σ các bộ.
  sp_list as (
    select distinct vm.mien, vm.sp_key from vm
  ),
  kh_sp as (
    select x.mien, x.sp_key, ss.k, ss.tong, ss.tong_dn
    from sp_list x
    left join mapping_class mc on mc.sp_key = x.sp_key
    join st_sum ss on ss.mien = x.mien and ss.sp_key = x.sp_key
    where mc.sp_key is null or mc.has_le or coalesce(array_length(mc.bos, 1), 0) = 0
    union all
    select x.mien, x.sp_key, bs.k, bs.tong, bs.tong_dn
    from sp_list x
    join mapping_class mc on mc.sp_key = x.sp_key
    join bo_st_sum bs on bs.mien = x.mien and bs.sp_key = x.sp_key
    where not (mc.has_le or coalesce(array_length(mc.bos, 1), 0) = 0)
  ),
  act_sp as (
    select i.mien, i.sp_key, a.k, sum(a.q) as q
    from item i
    join act_item a on a.mien = i.mien and a.item_code = i.ma_bravo
    group by i.mien, i.sp_key, a.k
  ),
  -- Mảng 18 tháng / sản phẩm: gom bằng GROUP BY (subquery tương quan trên CTE quét lặp -> timeout).
  arr as (
    select x.mien, x.sp_key,
      jsonb_agg(coalesce(h.tong, 0)    order by g.g) as kh_m,
      jsonb_agg(coalesce(h.tong_dn, 0) order by g.g) as kh_m_dn,
      jsonb_agg(case when v_t + g.g > v_last then null else coalesce(a.q, 0) end order by g.g) as act
    from sp_list x
    cross join generate_series(0, c_k - 1) as g(g)
    left join kh_sp h  on h.mien = x.mien and h.sp_key = x.sp_key and h.k = g.g
    left join act_sp a on a.mien = x.mien and a.sp_key = x.sp_key and a.k = g.g
    group by x.mien, x.sp_key
  ),
  sp as (
    select i.mien, i.sp_key,
      max(i.sp_name) as sp_name, max(i.nhom) as nhom, max(i.bu_code) as bu_code,
      count(*) as n_sku, count(*) filter (where i.hay) as n_hay,
      sum(i.tb_a) as th_a, round(sum(i.tb_b), 2) as th_b,
      sum(i.safety) as safety,
      sum(coalesce(i.tong_ton, 0)) as ton
    from item i
    group by i.mien, i.sp_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'mien', sp.mien, 'sp_key', sp.sp_key, 'sp', sp.sp_name, 'nhom', sp.nhom, 'bu', sp.bu_code,
      'n_sku', sp.n_sku, 'n_hay', sp.n_hay,
      'th_a', sp.th_a, 'th_b', sp.th_b,
      'safety', sp.safety,
      'ton', case when (sp.mien = 'MB' and d_mb is not null) or (sp.mien = 'MN' and d_mn is not null)
                  then sp.ton end,
      'kh_m', arr.kh_m, 'kh_m_dn', arr.kh_m_dn, 'act', arr.act
    ) order by sp.mien, sp.sp_key), '[]'::jsonb)
  into v_rows
  from sp
  join arr on arr.mien = sp.mien and arr.sp_key = sp.sp_key;

  return jsonb_build_object(
    'asof', p_asof, 'months', to_jsonb(v_months),
    'kh_def_lt', v_def_lt, 'kh_def_n', v_def_n,
    'last_month', to_char(make_date((v_last - 1) / 12, (v_last - 1) % 12 + 1, 1), 'YYYY-MM'),
    'stock_date', jsonb_build_object('MB', d_mb, 'MN', d_mn),
    'rows', v_rows);
end;
$function$;

revoke all on function public.backtest_goi_y(text) from public, anon, authenticated;
grant execute on function public.backtest_goi_y(text) to service_role;
