-- =====================================================================
--  06_password_v2_and_rate_limit.sql
--  5.1: nâng cấp scheme hash mật khẩu (SHA-256 yếu -> PBKDF2-SHA256, lazy
--       migration qua cột mới password_hash_v2). KHÔNG đổi/xoá password_hash
--       + salt cũ -> các app khác dùng chung bảng `users` không bị ảnh hưởng,
--       chỉ order-login tự nâng cấp dần khi user đăng nhập thành công.
--  5.2: rate-limit đăng nhập sai theo username+IP (bảng đếm riêng, không đụng
--       bảng `users`) — khoá 15 phút sau 5 lần sai liên tiếp.
--  Chạy thủ công trên Supabase SQL Editor (giống 01-05). Idempotent.
-- =====================================================================

alter table public.users add column if not exists password_hash_v2 text;

create table if not exists public.login_attempts (
  id          bigint generated always as identity primary key,
  username    text        not null,
  ip          text        not null default 'unknown',
  success     boolean     not null,
  created_at  timestamptz not null default now()
);
-- Tra cứu nhanh "N lần sai gần đây theo username+ip" (khoá 15 phút = 900s).
create index if not exists idx_login_attempts_lookup
  on public.login_attempts(username, ip, created_at desc);
-- Dọn bớt dòng cũ định kỳ (giữ ~1 ngày là đủ cho mục đích rate-limit 15 phút).
create index if not exists idx_login_attempts_created
  on public.login_attempts(created_at);

alter table public.login_attempts enable row level security;
