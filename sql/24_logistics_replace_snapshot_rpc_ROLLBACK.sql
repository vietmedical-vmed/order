-- ROLLBACK 24 — bỏ RPC logistics_replace_snapshot (dữ liệu không đổi)
drop function if exists public.logistics_replace_snapshot(date, jsonb, boolean);
