-- Phase 3: Auth — bảng users + dữ liệu cá nhân per-user.
--
-- status lifecycle:
--   pending  → user tự đăng ký, chờ admin duyệt
--   active   → admin đã duyệt, có thể login
--   disabled → admin khóa tạm thời
--
-- role:
--   admin → có thể duyệt/tạo/sửa/xóa user (truy cập /admin)
--   user  → user thường

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE,
    password_hash TEXT NOT NULL,                 -- bcryptjs hash
    role          TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
    status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'active' | 'disabled'
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at   TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_watchlist (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    notes      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, symbol)
);

CREATE TABLE IF NOT EXISTS user_portfolio (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    quantity   NUMERIC(20,2) NOT NULL,
    avg_price  NUMERIC(20,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, symbol)
);

CREATE TABLE IF NOT EXISTS filter_presets (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    filters    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_watchlist_user ON user_watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_user_portfolio_user ON user_portfolio(user_id);
CREATE INDEX IF NOT EXISTS idx_filter_presets_user ON filter_presets(user_id);
