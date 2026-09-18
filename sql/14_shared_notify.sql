-- ============================================================================
-- HẠ TẦNG THÔNG BÁO DÙNG CHUNG cho nhiều app (schema shared).
--   - shared.users.email : email nhận thông báo, 1 nguồn cho mọi app.
--   - shared.notifications : hộp gửi (outbox). App chỉ INSERT; 1 sender gửi + retry.
-- Edge Function service_role bypass RLS. Chạy 1 lần trên Supabase.
-- ============================================================================

alter table shared.users
  add column if not exists email text;

create table if not exists shared.notifications (
  id         uuid primary key default gen_random_uuid(),
  app        text        not null,               -- 'order', ... (app phát sinh)
  event      text        not null,               -- mã sự kiện của app
  to_emails  text[]      not null,               -- danh sách email nhận
  subject    text        not null,
  body       text        not null,               -- text thuần (có dấu); sender tự chuẩn hoá theo kênh
  channel    text        not null default 'email', -- email | zalo | ... (mở rộng sau)
  status     text        not null default 'pending', -- pending | sent | failed
  retries    int         not null default 0,
  error      text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);

-- Sender chỉ quét dòng chờ gửi -> partial index theo thời gian.
create index if not exists idx_notifications_pending
  on shared.notifications(created_at) where status = 'pending';

alter table shared.notifications enable row level security;

-- Seed email cho user (đổi cho đúng). Về sau quản lý qua màn admin.
-- update shared.users set email = 'giang.dohoang@caotoc24.com' where username = 'giang.dohoang';
