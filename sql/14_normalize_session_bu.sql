-- 14_normalize_session_bu.sql — Chuẩn hoá order_sessions.bu sang bu_code
-- Trước: bu = 'CH&CS', 'CTTM & CTUT'... (tên hiển thị gốc từ dm_vat_tu)
-- Sau:   bu = 'chcs', 'cttm', 'thnk'... (khớp users.bu và bu_code)

UPDATE app_order.order_sessions SET bu = 'chcs' WHERE LOWER(bu) = 'ch&cs';
UPDATE app_order.order_sessions SET bu = 'cttm' WHERE LOWER(bu) IN ('cttm', 'cttm & ctut');
UPDATE app_order.order_sessions SET bu = 'thnk' WHERE LOWER(bu) = 'thnk';
