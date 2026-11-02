-- =====================================================================
--  24 — RPC logistics_replace_snapshot: ghi 1 snapshot logistics_input
--
--  Script nạp (D:\1. GIANG\Data\Script\import supabase\build_logistics_input.py)
--  chỉ có service key qua REST, không mở được transaction -> gom xoá + ghi
--  snapshot vào 1 hàm (1 lời gọi = 1 transaction: lỗi giữa chừng không đổi gì).
--
--  p_rows: [{"ma_bravo": "...", "mien": "MB"|"MN", "dd": 1, "kg": 0}, ...]
--  p_dry_run = true: KHÔNG ghi, chỉ trả kết quả dự kiến.
--  Trả về tổng theo miền của snapshot liền trước và snapshot p_date (sau khi ghi).
--  Chỉ service_role được gọi.
-- =====================================================================
begin;

create or replace function public.logistics_replace_snapshot(
  p_date date, p_rows jsonb, p_dry_run boolean default false)
returns table (snapshot date, mien text, so_ma bigint, di_duong numeric, ky_gui numeric)
language plpgsql
set search_path to ''
as $$
declare
  v_prev date;
begin
  if p_date is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'logistics_replace_snapshot: cần p_date và p_rows là mảng không rỗng';
  end if;

  select max(l.snapshot_date) into v_prev
    from app_order.logistics_input l where l.snapshot_date < p_date;

  if not p_dry_run then
    delete from app_order.logistics_input l where l.snapshot_date = p_date;
    insert into app_order.logistics_input (snapshot_date, ma_bravo, mien, hang_di_duong, hang_ktv_bv)
    select p_date, x.ma_bravo, x.mien, coalesce(x.dd, 0), coalesce(x.kg, 0)
      from jsonb_to_recordset(p_rows) as x(ma_bravo text, mien text, dd numeric, kg numeric);
    return query
      select l.snapshot_date, l.mien, count(*), sum(l.hang_di_duong), sum(l.hang_ktv_bv)
        from app_order.logistics_input l
       where l.snapshot_date in (v_prev, p_date)
       group by 1, 2 order by 1, 2;
  else
    return query
      select l.snapshot_date, l.mien, count(*), sum(l.hang_di_duong), sum(l.hang_ktv_bv)
        from app_order.logistics_input l
       where l.snapshot_date = v_prev
       group by 1, 2
      union all
      select p_date, x.mien, count(*), sum(coalesce(x.dd, 0)), sum(coalesce(x.kg, 0))
        from jsonb_to_recordset(p_rows) as x(ma_bravo text, mien text, dd numeric, kg numeric)
       group by 1, 2
      order by 1, 2;
  end if;
end $$;

revoke all on function public.logistics_replace_snapshot(date, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.logistics_replace_snapshot(date, jsonb, boolean) to service_role;

commit;
