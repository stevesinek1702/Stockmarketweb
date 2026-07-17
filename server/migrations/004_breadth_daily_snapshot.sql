-- Bảng lưu snapshot breadth (Phá Đỉnh / Phá Đáy) theo ngày.
-- Mỗi ngày 1 row, chụp EOD (~15:00-22:00 VN) để vẽ trend theo thời gian.
-- Cột riêng biệt (không JSONB) cho query/sort/index nhanh khi vẽ chart.
CREATE TABLE IF NOT EXISTS breadth_daily_snapshot (
    snapshot_date DATE PRIMARY KEY,           -- ngày giao dịch VN (GMT+7)

    -- 3 Tháng
    high_3t       INT NOT NULL DEFAULT 0,     -- số mã lập đỉnh mới 3T
    low_3t        INT NOT NULL DEFAULT 0,     -- số mã lập đáy mới 3T
    ratio_3t      NUMERIC(6,2) NOT NULL DEFAULT 0,  -- high_3t / low_3t
    cap_high_3t   BIGINT NOT NULL DEFAULT 0,  -- tổng vốn hóa nhóm đỉnh (tỷ VND)
    cap_low_3t    BIGINT NOT NULL DEFAULT 0,  -- tổng vốn hóa nhóm đáy (tỷ VND)

    -- 6 Tháng
    high_6t       INT NOT NULL DEFAULT 0,
    low_6t        INT NOT NULL DEFAULT 0,
    ratio_6t      NUMERIC(6,2) NOT NULL DEFAULT 0,
    cap_high_6t   BIGINT NOT NULL DEFAULT 0,
    cap_low_6t    BIGINT NOT NULL DEFAULT 0,

    -- 1 Năm
    high_1y       INT NOT NULL DEFAULT 0,
    low_1y        INT NOT NULL DEFAULT 0,
    ratio_1y      NUMERIC(6,2) NOT NULL DEFAULT 0,
    cap_high_1y   BIGINT NOT NULL DEFAULT 0,
    cap_low_1y    BIGINT NOT NULL DEFAULT 0,

    -- Meta
    verdict       TEXT NOT NULL,              -- 'Bullish' | 'Bearish' | 'Neutral' (theo ratio 1N)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bds_date ON breadth_daily_snapshot(snapshot_date);
