-- ============================================================================
-- Danh bạ nhận thông báo theo VAI TRÒ (thay cho notify_recipients theo bước).
-- Mỗi chuyển trạng thái, hệ thống gửi email cho các role liên quan (xem bảng
-- role x sự kiện trong tài liệu / code EVENT_ROLES).
--   role       : ADMIN | AM | PM | MANAGER | PURCHASING
--   mien       : chỉ áp cho role AM — 'MB'/'MN' để nhận đúng miền; NULL = mọi miền
--   all_events : true = nhận MỌI sự kiện (admin/người theo dõi), bỏ qua lọc role
--   active     : false = tắt tạm mà không xoá
-- Edge Function gọi bằng service_role -> bypass RLS. Chạy 1 lần trên Supabase.
-- ============================================================================

create table if not exists app_order.notify_contacts (
  username   text primary key,               -- khoá theo user cho dễ quản lý (1 người 1 dòng)
  email      text        not null,
  role       text,                            -- ADMIN | AM | PM | MANAGER | PURCHASING
  mien       text,                            -- chỉ dùng cho AM: MB | MN | NULL(mọi miền)
  all_events boolean     not null default false,
  active     boolean     not null default true
);

alter table app_order.notify_contacts enable row level security;

-- Seed test: nhận MỌI sự kiện (đổi username/email cho đúng).
-- insert into app_order.notify_contacts(username, email, role, all_events) values
--   ('giang.dohoang', 'giang.dohoang@caotoc24.com', 'ADMIN', true)
-- on conflict (username) do update
--   set email = excluded.email, role = excluded.role, all_events = excluded.all_events, active = true;
