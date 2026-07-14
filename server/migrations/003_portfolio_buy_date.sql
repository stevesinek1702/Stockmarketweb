-- Phase 4+: thêm ngày mua riêng cho portfolio (phục vụ tính T+x).
-- created_at là lúc tạo record trong DB, KHÔNG phải ngày mua thật.
-- buy_date cho phép KH nhập ngày lệnh, tính T+2 (luật HOSE/HNX/UPCoM).

ALTER TABLE user_portfolio ADD COLUMN IF NOT EXISTS buy_date DATE;

-- Backfill: record cũ lấy created_at (đã có sẵn) làm ngày mua mặc định.
UPDATE user_portfolio SET buy_date = created_at::date WHERE buy_date IS NULL;
