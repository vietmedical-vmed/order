// Cấu hình môi trường — tách riêng khỏi code app để đổi dự án Supabase
// chỉ phải sửa đúng 1 file này, không đụng logic.
const cfg = window.ORDER_CONFIG || window.CTCH_CONFIG || {};

export const API_BASE = cfg.apiBase || 'https://nrfxymnfmjhbsgpipvkb.supabase.co/functions/v1';
export const ANON_KEY = cfg.anonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5yZnh5bW5mbWpoYnNncGlwdmtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4ODk2OTQsImV4cCI6MjA5ODQ2NTY5NH0.cN-jTdPOLWKd9kNa1nNMENzHcY0_BftyYgPEbuVTWeo';

// Khoá localStorage — migrate từ key cũ (ctch_*) sang key mới (order_*).
export const TOKEN_KEY = 'order_auth_token';
export const DRAFT_KEY = 'order_draft';

// Migrate localStorage key cũ sang mới (chạy 1 lần)
for (const [oldK, newK] of [['ctch_auth_token', TOKEN_KEY], ['ctch_order_draft', DRAFT_KEY]]) {
  if (!localStorage.getItem(newK) && localStorage.getItem(oldK)) {
    localStorage.setItem(newK, localStorage.getItem(oldK));
    localStorage.removeItem(oldK);
  }
}
