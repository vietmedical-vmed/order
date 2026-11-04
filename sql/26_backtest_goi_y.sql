-- ============================================================
--  26_backtest_goi_y.sql  —  Backtest công thức Gợi ý (tab "Kiểm chứng gợi ý")
-- ============================================================
--  public.backtest_goi_y(p_asofs text[]) -> jsonb   (mảng, mỗi phần tử = 1 mốc 'YYYY-MM')
--
--  Đặt mình ở đầu tháng T (mỗi mốc trong p_asofs) và tính lại các chỉ số Gợi ý CHỈ bằng
--  dữ liệu có trước T, rồi trả kèm SL thực tế các tháng sau T để so sánh. Logic chỉ số chép
--  từ refresh_usage_indicators() bản sql/25 — đổi logic ở đó thì đổi cả ở đây.
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
--  Hiệu năng: PostgREST cắt câu lệnh ở 8s (authenticator). Nhiều mốc dùng chung 1 lượt quét
--  sv / hoá đơn / sale_target (lọc khoảng tháng bằng index); các nguồn được GOM trước rồi mới
--  parse tháng / norm_key. Tối đa 12 mốc / lần gọi. Khi cache DB nguội, lượt quét đầu vẫn có
--  thể mất vài giây -> order-api gọi hàm này qua kết nối Postgres trực tiếp (timeout 60s).
--
--  Chỉ đọc, không ghi bảng nào. Rollback: drop function public.backtest_goi_y(text[]);
-- ============================================================

drop function if exists public.backtest_goi_y(text, int, int);
drop function if exists public.backtest_goi_y(text);

create or replace function public.backtest_goi_y(p_asofs text[])
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public', 'app_order', 'shared'
as $function$
declare
  c_k  constant int := 18;       -- số tháng trả về cho KH và thực tế (T … T+17)
  v_ts   int[];                  -- chỉ số tháng T = y*12 + m (cùng quy ước với sql/25)
  v_tmin int;
  v_tmax int;
  v_lo text;                     -- tháng nhỏ nhất / lớn nhất cần đọc ('YYYY-MM', so sánh chuỗi dùng index)
  v_hi text;
  v_cfg jsonb;
  v_def_n  int;
  v_def_lt int;
  v_last int;                    -- tháng cuối cùng đã đủ dữ liệu thực tế
  v_sv_start int;
  v_hd_start int;
  v_out jsonb;
begin
  if p_asofs is null or cardinality(p_asofs) = 0 or cardinality(p_asofs) > 12 then
    raise exception 'Truyền 1–12 mốc dạng YYYY-MM';
  end if;
  if exists (select 1 from unnest(p_asofs) a where a is null or a !~ '^[0-9]{4}-[0-9]{2}$') then
    raise exception 'Mốc phải có dạng YYYY-MM';
  end if;
  select array_agg(distinct split_part(a, '-', 1)::int * 12 + split_part(a, '-', 2)::int)
    into v_ts from unnest(p_asofs) a;
  select min(x), max(x) into v_tmin, v_tmax from unnest(v_ts) x;

  v_lo := to_char(make_date((v_tmin - 13) / 12, (v_tmin - 13) % 12 + 1, 1), 'YYYY-MM');
  v_hi := to_char(make_date((v_tmax + c_k - 2) / 12, (v_tmax + c_k - 2) % 12 + 1, 1), 'YYYY-MM');

  -- Cửa sổ TB KH mặc định, cùng cách đọc + làm tròn với refresh_usage_indicators (sql/25).
  select coalesce(value, '{}'::jsonb) into v_cfg from app_order.app_config where key = 'goi_y';
  v_cfg := coalesce(v_cfg, '{}'::jsonb);
  v_def_n := greatest(1, round(coalesce((v_cfg->>'so_thang_dat_default')::numeric, 3))::int);
  v_def_lt := greatest(0, round(coalesce((v_cfg->>'leadtime_thang_default')::numeric,
                                         (v_cfg->>'so_thang_dat_default')::numeric, 3))::int);

  -- Tháng đủ dữ liệu = min(tháng cuối của sv, tháng cuối của hoá đơn, tháng trước tháng hiện tại).
  select max(i), min(i) into v_last, v_sv_start from (
    select distinct split_part(s.month, '-', 1)::int * 12 + split_part(s.month, '-', 2)::int as i
    from (select distinct month from app_order.sv) s where s.month ~ '^[0-9]{4}-[0-9]{1,2}') z;
  select least(v_last, max(i)), min(i) into v_last, v_hd_start from (
    select split_part(h.thang, '-', 1)::int * 12 + split_part(h.thang, '-', 2)::int as i
    from (select distinct thang from app_sale.hoa_don_bovattu) h where h.thang ~ '^[0-9]{4}-[0-9]{1,2}') z;
  v_last := least(v_last,
    extract(year from now() at time zone 'Asia/Ho_Chi_Minh')::int * 12
    + extract(month from now() at time zone 'Asia/Ho_Chi_Minh')::int - 1);

  with
  tl as (
    select t, make_date((t - 1) / 12, (t - 1) % 12 + 1, 1) as d0 from unnest(v_ts) t
  ),
  td as (            -- snapshot tồn sớm nhất trong tháng T của từng miền
    select tl.t,
      (select min(st.cycledate::date) from app_order.stock st
        where st.mien in ('MB', 'Miền Bắc')
          and st.cycledate::date >= tl.d0 and st.cycledate::date < (tl.d0 + interval '1 month')::date) as d_mb,
      (select min(st.cycledate::date) from app_order.stock st
        where st.mien in ('MN', 'Miền Nam')
          and st.cycledate::date >= tl.d0 and st.cycledate::date < (tl.d0 + interval '1 month')::date) as d_mn
    from tl
  ),

  -- ── SL thực hiện theo tháng: gom thô trước rồi mới parse ──
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
  sv_m as (
    select s.area, s.item_code, s.month, sum(coalesce(s.quantity, 0)) as q
    from app_order.sv s
    where s.item_code is not null and s.area in ('MB','Miền Bắc','MN','Miền Nam')
      and s.month between v_lo and v_hi
    group by s.area, s.item_code, s.month
  ),
  hd_m as (
    select h.ten_ps, btrim(h.ma_vat_tu) as ma, h.thang, sum(coalesce(h.so_luong, 0)) as q
    from app_sale.hoa_don_bovattu h
    where h.thang between v_lo and v_hi
    group by h.ten_ps, btrim(h.ma_vat_tu), h.thang
  ),
  th_base as (
    select case when x.area in ('MB','Miền Bắc') then 'MB' else 'MN' end as mien,
      x.item_code,
      split_part(x.month,'-',1)::int * 12 + split_part(x.month,'-',2)::int as idx,
      x.q
    from sv_m x
    left join vt_bu vb on vb.ma_bravo = x.item_code
    where x.month ~ '^[0-9]{4}-[0-9]{1,2}' and coalesce(vb.chcs, true)
    union all
    select pm.mien, vb.ma_bravo,
      split_part(h.thang,'-',1)::int * 12 + split_part(h.thang,'-',2)::int,
      h.q
    from hd_m h
    join vt_bu vb   on vb.ma_bravo = h.ma and not vb.chcs
    join ps_mien pm on pm.ps_key = regexp_replace(lower(btrim(h.ten_ps)), '\s+', ' ', 'g')
    where h.thang ~ '^[0-9]{4}-[0-9]{1,2}'
  ),
  per_month as materialized (
    select b.mien, b.item_code, b.idx, sum(b.q) as q
    from th_base b
    where b.idx between v_tmin - 12 and v_tmax + c_k - 1
    group by b.mien, b.item_code, b.idx
  ),
  usage_raw as (
    select tl.t, m.mien, m.item_code,
      coalesce(sum(m.q)  filter (where m.q > 0), 0)                               as th,
      count(*)           filter (where m.q > 0)                                   as th_m,
      coalesce(sum(m.q)  filter (where m.q > 0 and m.idx >= tl.t - 6), 0)         as th6,
      count(*)           filter (where m.q > 0 and m.idx >= tl.t - 6)             as th6_m
    from tl
    join per_month m on m.idx between tl.t - 12 and tl.t - 1
    group by tl.t, m.mien, m.item_code
  ),

  -- ── KH theo tháng: gom thô trước, norm_key trên số dòng đã gom (giống sql/25 + biến thể đầu năm) ──
  st_raw as (
    select st.mien, st.san_pham, st.thang_ke_hoach,
      sum(case when st.sl_ke_hoach_update is not null
               then coalesce(st.sl_ke_hoach_update, 0)
               else coalesce(st.sl_ke_hoach_dau_nam, 0) end) as tong,
      sum(coalesce(st.sl_ke_hoach_dau_nam, 0))               as tong_dn
    from shared.sale_target st
    where st.thang_ke_hoach between v_lo and v_hi
      and st.mien in ('MB','Miền Bắc','MN','Miền Nam')
    group by st.mien, st.san_pham, st.thang_ke_hoach
  ),
  st_sum as materialized (
    select
      case when r.mien in ('MB','Miền Bắc') then 'MB' else 'MN' end as mien,
      app_order.norm_key(r.san_pham) as sp_key,
      split_part(r.thang_ke_hoach,'-',1)::int * 12 + split_part(r.thang_ke_hoach,'-',2)::int as idx,
      sum(r.tong) as tong, sum(r.tong_dn) as tong_dn
    from st_raw r
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
  mapping_class as materialized (
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
    select be.sp_key, ss.mien, ss.idx, sum(ss.tong) as tong, sum(ss.tong_dn) as tong_dn
    from bo_expanded be
    join st_sum ss on ss.sp_key = be.bo_key
    group by be.sp_key, ss.mien, ss.idx
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
  vm as materialized (
    select v.*, ml.mien
    from vt v
    cross join (select unnest(array['MB','MN']) as mien) ml
    where v.sp_key <> ''
  ),
  sp_list as materialized (
    select distinct vm.mien, vm.sp_key from vm
  ),
  kh_sp as materialized (
    select x.mien, x.sp_key, ss.idx, ss.tong, ss.tong_dn
    from sp_list x
    left join mapping_class mc on mc.sp_key = x.sp_key
    join st_sum ss on ss.mien = x.mien and ss.sp_key = x.sp_key
    where mc.sp_key is null or mc.has_le or coalesce(array_length(mc.bos, 1), 0) = 0
    union all
    select x.mien, x.sp_key, bs.idx, bs.tong, bs.tong_dn
    from sp_list x
    join mapping_class mc on mc.sp_key = x.sp_key
    join bo_st_sum bs on bs.mien = x.mien and bs.sp_key = x.sp_key
    where not (mc.has_le or coalesce(array_length(mc.bos, 1), 0) = 0)
  ),
  stk as (
    select td.t, s.mien, s.ma_bravo,
      sum(s.ton_kho + s.hang_ktv_bv + s.hang_di_duong - s.hang_vet_thau) as tong_ton
    from td
    cross join lateral (
      select * from public.stock_agg('MB', td.d_mb::timestamptz) where td.d_mb is not null
      union all
      select * from public.stock_agg('MN', td.d_mn::timestamptz) where td.d_mn is not null
    ) s
    group by td.t, s.mien, s.ma_bravo
  ),
  item as materialized (
    select tl.t, vm.mien, vm.ma_bravo, vm.sp_key, vm.sp_name, vm.nhom, vm.bu_code, vm.hay, vm.safety,
      case when vm.hay
           then case when coalesce(ur.th6_m, 0) > 0 then round(ur.th6 / ur.th6_m) else 0 end
           else case when coalesce(ur.th_m, 0)  > 0 then round(ur.th  / ur.th_m)  else 0 end
      end as tb_a,
      -- chia cho số tháng cửa sổ mà nguồn của mã đã có dữ liệu (hoá đơn chỉ có từ 2025-04)
      coalesce(case when vm.hay then ur.th6 else ur.th end, 0)
        / greatest(1, (tl.t - greatest(tl.t - case when vm.hay then 6 else 12 end,
                                       case when vm.chcs then v_sv_start else v_hd_start end)))::numeric as tb_b,
      stk.tong_ton
    from tl
    cross join vm
    left join usage_raw ur on ur.t = tl.t and ur.mien = vm.mien and ur.item_code = vm.ma_bravo
    left join stk          on stk.t = tl.t and stk.mien = vm.mien and stk.ma_bravo = vm.ma_bravo
  ),
  act_sp as (
    select i.t, i.mien, i.sp_key, m.idx - i.t as k, sum(m.q) as q
    from item i
    join per_month m on m.mien = i.mien and m.item_code = i.ma_bravo
                    and m.idx between i.t and i.t + c_k - 1
    group by i.t, i.mien, i.sp_key, m.idx - i.t
  ),
  -- KH trải theo mốc: k = tháng − T (join bằng khoá bằng nhau ở bước sau; join theo khoảng
  -- trực tiếp trong arr khiến planner ước lượng sai và so khớp hàng chục triệu dòng).
  kh_t as (
    select tl.t, h.mien, h.sp_key, h.idx - tl.t as k, h.tong, h.tong_dn
    from tl
    join kh_sp h on h.idx between tl.t and tl.t + c_k - 1
  ),
  -- Mảng 18 tháng / sản phẩm / mốc: gom bằng GROUP BY (subquery tương quan trên CTE quét lặp -> chậm).
  arr as (
    select tl.t, x.mien, x.sp_key,
      jsonb_agg(coalesce(h.tong, 0)    order by g.g) as kh_m,
      jsonb_agg(coalesce(h.tong_dn, 0) order by g.g) as kh_m_dn,
      jsonb_agg(case when tl.t + g.g > v_last then null else coalesce(a.q, 0) end order by g.g) as act
    from tl
    cross join sp_list x
    cross join generate_series(0, c_k - 1) as g(g)
    left join kh_t h   on h.t = tl.t and h.mien = x.mien and h.sp_key = x.sp_key and h.k = g.g
    left join act_sp a on a.t = tl.t and a.mien = x.mien and a.sp_key = x.sp_key and a.k = g.g
    group by tl.t, x.mien, x.sp_key
  ),
  sp as (
    select i.t, i.mien, i.sp_key,
      max(i.sp_name) as sp_name, max(i.nhom) as nhom, max(i.bu_code) as bu_code,
      count(*) as n_sku, count(*) filter (where i.hay) as n_hay,
      sum(i.tb_a) as th_a, round(sum(i.tb_b), 2) as th_b,
      sum(i.safety) as safety,
      sum(coalesce(i.tong_ton, 0)) as ton
    from item i
    group by i.t, i.mien, i.sp_key
  ),
  rows_t as (
    select sp.t, jsonb_agg(jsonb_build_object(
        'mien', sp.mien, 'sp_key', sp.sp_key, 'sp', sp.sp_name, 'nhom', sp.nhom, 'bu', sp.bu_code,
        'n_sku', sp.n_sku, 'n_hay', sp.n_hay,
        'th_a', sp.th_a, 'th_b', sp.th_b,
        'safety', sp.safety,
        'ton', case when (sp.mien = 'MB' and td.d_mb is not null) or (sp.mien = 'MN' and td.d_mn is not null)
                    then sp.ton end,
        'kh_m', arr.kh_m, 'kh_m_dn', arr.kh_m_dn, 'act', arr.act
      ) order by sp.mien, sp.sp_key) as rows
    from sp
    join arr on arr.t = sp.t and arr.mien = sp.mien and arr.sp_key = sp.sp_key
    join td  on td.t = sp.t
    group by sp.t
  )
  select jsonb_agg(jsonb_build_object(
      'asof', to_char(make_date((td.t - 1) / 12, (td.t - 1) % 12 + 1, 1), 'YYYY-MM'),
      'months', (select jsonb_agg(to_char(make_date((td.t + g - 1) / 12, (td.t + g - 1) % 12 + 1, 1), 'YYYY-MM') order by g)
                 from generate_series(0, c_k - 1) g),
      'kh_def_lt', v_def_lt, 'kh_def_n', v_def_n,
      'last_month', to_char(make_date((v_last - 1) / 12, (v_last - 1) % 12 + 1, 1), 'YYYY-MM'),
      'stock_date', jsonb_build_object('MB', td.d_mb, 'MN', td.d_mn),
      'rows', coalesce(r.rows, '[]'::jsonb)
    ) order by td.t)
  into v_out
  from td
  left join rows_t r on r.t = td.t;

  return coalesce(v_out, '[]'::jsonb);
end;
$function$;

revoke all on function public.backtest_goi_y(text[]) from public, anon, authenticated;
grant execute on function public.backtest_goi_y(text[]) to service_role;
