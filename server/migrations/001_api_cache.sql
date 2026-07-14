-- Bảng cache cho data market chung (Phase 2).
-- Mỗi row = 1 cache key (cả static lẫn dynamic key như 'market-stats:HOSTC').
CREATE TABLE IF NOT EXISTS api_cache (
    cache_key   TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ttl_seconds INT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_cache_fetched ON api_cache(fetched_at);
