-- 13_bu_code.sql — Thêm cột bu_code vào dm_vat_tu làm ID chuẩn để mapping
-- bu_code: giá trị chuẩn hoá (chcs, cttm, thnk...) dùng để lọc theo users.bu
-- bu (cột gốc): giữ nguyên tên hiển thị (CH&CS, CTTM & CTUT...)

-- 1. Thêm cột bu_code vào dm_vat_tu
ALTER TABLE shared.dm_vat_tu ADD COLUMN IF NOT EXISTS bu_code text DEFAULT '';

-- 2. Populate bu_code từ bu hiện tại
UPDATE shared.dm_vat_tu SET bu_code = 'chcs' WHERE LOWER(bu) = 'ch&cs';
UPDATE shared.dm_vat_tu SET bu_code = 'cttm' WHERE LOWER(bu) IN ('cttm', 'cttm & ctut');
-- Thêm mapping cho các BU khác nếu cần:
-- UPDATE shared.dm_vat_tu SET bu_code = 'thnk' WHERE LOWER(bu) = '...';

-- 3. Index
CREATE INDEX IF NOT EXISTS idx_vattu_bu_code ON shared.dm_vat_tu (bu_code);

-- 4. Thêm bu_code vào dm_bu
ALTER TABLE shared.dm_bu ADD COLUMN IF NOT EXISTS bu_code text DEFAULT '';
UPDATE shared.dm_bu SET bu_code = 'chcs' WHERE LOWER(bu) = 'ch&cs';
UPDATE shared.dm_bu SET bu_code = 'cttm' WHERE LOWER(bu) IN ('cttm', 'cttm & ctut');
