-- =====================================================================
--  05_config_log.sql  —  Log phiên bản cấu hình công thức Gợi ý
--  Mỗi lần lưu cấu hình (saveConfig) ghi 1 dòng vào đây. Bản log có hiệu
--  lực từ created_at đến khi có bản mới thay thế → xem lại đợt đặt hàng cũ
--  dùng đúng công thức tại thời điểm mở đợt (order_sessions.ngay_mo).
-- =====================================================================

create table if not exists public.order_config_log (
  id          bigint generated always as identity primary key,
  cfg_key     text        not null default 'goi_y',
  value       jsonb       not null,
  created_at  timestamptz not null default now(),
  created_by  text
);

-- Tra cứu nhanh "bản có hiệu lực tại thời điểm T": WHERE cfg_key=? AND created_at<=T ORDER BY created_at DESC LIMIT 1
create index if not exists idx_config_log_key_time
  on public.order_config_log(cfg_key, created_at desc);

alter table public.order_config_log enable row level security;

-- Seed 1 bản baseline từ cấu hình hiện hành (nếu bảng log còn trống) để các đợt
-- tạo quanh thời điểm bật tính năng có mốc tham chiếu.
insert into public.order_config_log(cfg_key, value, created_by)
select 'goi_y', c.value, 'system'
from public.app_config c
where c.key = 'goi_y'
  and not exists (select 1 from public.order_config_log l where l.cfg_key = 'goi_y');
