// Cấu hình môi trường — tách riêng khỏi code app (mục 6.1) để đổi dự án Supabase
// chỉ phải sửa đúng 1 file này, không đụng logic.
// index.html vẫn có thể ghi đè trước khi module nạp bằng cách gán window.CTCH_CONFIG.
const cfg = window.CTCH_CONFIG || {};

export const API_BASE = cfg.apiBase || 'https://nrfxymnfmjhbsgpipvkb.supabase.co/functions/v1';
export const ANON_KEY = cfg.anonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5yZnh5bW5mbWpoYnNncGlwdmtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4ODk2OTQsImV4cCI6MjA5ODQ2NTY5NH0.cN-jTdPOLWKd9kNa1nNMENzHcY0_BftyYgPEbuVTWeo';

// Khoá localStorage dùng chung toàn app.
export const TOKEN_KEY = 'ctch_auth_token';
export const DRAFT_KEY = 'ctch_order_draft';
