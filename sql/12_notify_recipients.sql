-- ============================================================================
-- Người nhận thông báo "chờ duyệt" theo bước duyệt.
--   step = 'SUBMITTED'    -> gửi khi AM gửi duyệt (PM cần duyệt)
--   step = 'PM_APPROVED'  -> gửi khi PM duyệt xong (Manager cần duyệt)
-- Mỗi bước có thể có nhiều email. active=false để tắt tạm 1 người mà không xoá.
-- Edge Function gọi bằng service_role -> bypass RLS.
-- Chạy 1 lần trên Supabase SQL editor.
-- ============================================================================

create table if not exists app_order.notify_recipients (
  id         uuid primary key default gen_random_uuid(),
  step       text        not null,          -- SUBMITTED | PM_APPROVED
  email      text        not null,
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);

-- Lọc luôn theo step + active -> partial index chỉ trên dòng đang bật.
create index if not exists idx_notify_step_active
  on app_order.notify_recipients(step) where active;

alter table app_order.notify_recipients enable row level security;

-- Ví dụ seed (đổi email cho đúng): gửi cho 1 người ở cả 2 bước.
-- insert into app_order.notify_recipients(step, email) values
--   ('SUBMITTED',   'giang.dohoang@caotoc24.com'),
--   ('PM_APPROVED', 'giang.dohoang@caotoc24.com');
