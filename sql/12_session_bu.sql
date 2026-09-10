-- 12_session_bu.sql — Thêm cột BU vào order_sessions để phân tách đợt theo BU
-- Mở rộng app cho nhiều BU (CTTM, CTUT, …) ngoài CH&CS.

ALTER TABLE app_order.order_sessions
  ADD COLUMN IF NOT EXISTS bu text NOT NULL DEFAULT '';

-- Index hỗ trợ lọc đợt theo BU
CREATE INDEX IF NOT EXISTS idx_sessions_bu ON app_order.order_sessions (bu);

-- Cập nhật đợt cũ (chưa có BU) về CH&CS
UPDATE app_order.order_sessions SET bu = 'CH&CS' WHERE bu = '';
