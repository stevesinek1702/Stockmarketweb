# Multi-User + Database Caching — Thiết kế

- **Ngày:** 2026-07-14
- **Trạng thái:** Chờ user duyệt
- **Quy mô mục tiêu:** 200–2000 user đồng thời
- **Kiến trúc:** Phương án A — Postgres + Redis + Refresh Scheduler + Nginx/PM2

## 1. Bối cảnh & Vấn đề

App hiện tại là dashboard chứng khoán VN **single-user**, Express proxy thuần:
- **Không có auth, không có database.**
- Cache = in-memory `Map` (`server.js:111-139`), 16 key, TTL 20s–2 phút.
- Mỗi lần load dashboard = **~30–60 external API calls** tới FireAnt/Fiintrade nếu cache miss.
- FireAnt dùng **1 cookie dùng chung** (auto-login bằng Playwright).
- Chỉ 1 chỗ user ghi dữ liệu: `filter-presets.json` (global, không có user_id).
- Deploy = chạy foreground 1 process (no PM2/Docker).

**Hệ quả khi mở multi-user nguyên trạng:** cache per-process không share được, restart mất sạch, mỗi user load dashboard = thêm API call → FireAnt bị rate-limit/block nhanh chóng.

## 2. Mục tiêu

1. **Giảm API call tới FireAnt/Fiintrade:** cache trung gian + refresh scheduler → FireAnt chỉ bị gọi theo lịch định sẵn, **bất kể số user**.
2. **Multi-user với đăng nhập:** admin tạo/duyệt tài khoản, mỗi user có data cá nhân.
3. **Data cá nhân per-user:** filter presets, watchlist, portfolio.
4. **Production-ready:** Docker, Nginx, PM2 cluster, bền khi restart.

## 3. Kiến trúc tổng quan

```
                    ┌─────────────────────────────────────────────┐
                    │              VPS (Cloud)                     │
   User Browser ───►│  Nginx (TLS, static, reverse proxy)          │
   (200-2000)       │         │                                    │
                    │         ▼                                    │
                    │  Express + PM2 cluster (2-N process)         │
                    │    │           │           │                 │
                    │    │ auth      │ /api/*    │ /api/user/*     │
                    │    │ mw        │ (cached)  │ (cá nhân)       │
                    │    ▼           ▼           ▼                 │
                    │  JWT verify   Redis ◄──── read cache         │
                    │    │           │ miss?                          │
                    │    │           ▼                                │
                    │    │       Postgres (api_cache table)         │
                    │    │           ▲                                │
                    │    │       Refresh Scheduler                  │
                    │    │       (fetch FireAnt/Fiintrade           │
                    │    │        mỗi 30s-2p, write DB+Redis)       │
                    │    ▼                                           │
                    │  Postgres                                    │
                    │   users / user_watchlist / user_portfolio    │
                    │   filter_presets                             │
                    └─────────────────────────────────────────────┘
```

### Luồng dữ liệu

1. **Request `/api/market-stats`** (public data) → Express → `getCached(key)`:
   - Redis HIT → return (<1ms)
   - Redis MISS → Postgres `api_cache` (còn TTL?) → repopulate Redis + return
   - cả hai MISS → endpoint fallback call FireAnt + `setCached`
2. **Refresh Scheduler** (worker độc lập): mỗi endpoint có interval → fetch FireAnt/Fiintrade → write Postgres `api_cache` + Redis. **FireAnt chỉ bị call 1 lần/interval bất kể số user.**
3. **Request `/api/user/watchlist`** (data cá nhân) → JWT auth middleware → query Postgres `user_watchlist WHERE user_id=?`. Không cache (riêng từng user).

## 4. Database Schema (Postgres)

```sql
-- ============ AUTH & USERS ============
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE,
    password_hash TEXT NOT NULL,              -- bcrypt cost 12
    role          TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user'
    status        TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'active'|'disabled'
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at   TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ
);

-- ============ DATA CÁ NHÂN PER-USER ============
CREATE TABLE user_watchlist (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    notes      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, symbol)
);

CREATE TABLE user_portfolio (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    quantity   NUMERIC(20,2) NOT NULL,
    avg_price  NUMERIC(20,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, symbol)
);

CREATE TABLE filter_presets (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    filters    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, name)
);

-- ============ CACHE LAYER (data market chung) ============
CREATE TABLE api_cache (
    cache_key   TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ttl_seconds INT NOT NULL
);
CREATE INDEX idx_api_cache_fetched ON api_cache(fetched_at);
```

**Migration dữ liệu hiện có:** `filter-presets.json` → gán cho user admin (user đầu tiên).

## 5. Auth (admin tạo/duyệt)

- **Mã hóa mật khẩu:** bcrypt (cost 12).
- **Session:** JWT (HS256) trong httpOnly + SameSite=Strict cookie, TTL access 15 phút + refresh 7 ngày.
- **Vòng đời tài khoản:**
  - User submit đăng ký → `status=pending`.
  - Admin duyệt trong `/admin` panel → `status=active` mới login được.
  - Admin cũng có thể tạo account trực tiếp + set password tạm.
  - Admin có thể disable (`status=disabled`).
- **Middleware:**
  - `requireAuth` — đã login (dùng cho toàn dashboard + user data).
  - `requireAdmin` — role=admin (quản trị user).
- **Endpoints mới:**
  - `POST /api/auth/register` — tạo pending account
  - `POST /api/auth/login` — verify + set cookie
  - `POST /api/auth/logout` — clear cookie
  - `GET  /api/auth/me` — profile hiện tại
  - `GET/POST/PATCH/DELETE /api/admin/users` — CRUD + approve (admin)
  - `GET/POST/DELETE /api/user/watchlist`
  - `GET/POST/PATCH/DELETE /api/user/portfolio`
  - `GET/POST/DELETE /api/user/presets` (thay `/api/filter-presets` hiện tại)

## 6. Cache Layer + Refresh Scheduler

### 6.1. Module `server/cache.js` (thay in-memory Map)

Giữ nguyên interface hiện tại để endpoint ít đổi:

```js
// getCached(key, ttlMs) → data | null
//   1. Redis GET key → hit? return (<1ms, path nóng nhất)
//   2. Postgres api_cache (fetched_at + ttl còn hạn?) → repopulate Redis + return
//   3. miss → null
//
// setCached(key, data, ttlMs) → Redis SETEX + Postgres UPSERT
// getStaleResponse(key) → Redis/Postgres bất kể TTL (fallback khi nguồn lỗi)
```

Toàn bộ `getCachedResponse/setCachedResponse/getStaleResponse` hiện tại (`server.js:111-139`) được thay bằng gọi module này. Logic endpoint không đổi.

### 6.2. Refresh Scheduler (`server/scheduler.js`)

Worker khởi động cùng process Express (qua `setInterval` trong `server.js`). Chống multi-instance conflict bằng Redis lock (SETNX): mỗi tick, chỉ worker nào lấy được lock cho key đó mới refresh; worker còn lại skip (đã có data từ worker khác). Khi scale lớn về sau có thể tách scheduler ra process riêng — không đổi interface.

| Endpoint group | Interval | Cache key |
|---|---|---|
| market-stats (HOSTC/VN30/HNX), vnindex-demand, vn30-demand | 20–30s | dynamic theo symbol |
| market-breadth, all-stocks, influential-stocks, investor-flow, foreign-flow, investor-detail, industry-stats, marketcap-stats, top-net-stocks | 60s | cố định |
| news (theo category) | 120s | theo category |

Mỗi tick: scheduler gọi hàm fetch nội bộ (refactor logic fetch từ endpoint ra function shared) → `setCached` → Redis + Postgres. **2000 user request cùng lúc → Redis trả cached, FireAnt không bị thêm call.**

### 6.3. FireAnt cookie pooling (optional, phase sau)

Hiện 1 cookie dùng chung → khi scale lớn có thể bị rate-limit. Phase sau có thể pool nhiều account FireAnt (mỗi account 1 cookie) xoay vòng. **Nằm ngoài scope phase đầu.**

## 7. Frontend (tối thiểu)

- **Login/Register page** (route mới `/login`, `/register`).
- **Admin panel** (`/admin`): bảng user + nút approve/disable/create.
- **Watchlist/Portfolio UI**: tích hợp vào dashboard hiện có (panel nhỏ hoặc trang riêng).
- Toàn bộ API call thêm header `Authorization` (hoặc dùng cookie httpOnly — ưu tiên cookie để chống XSS).
- Khi 401 → redirect `/login`.
- `js/cache.js` (SWR localStorage) giữ nguyên — chỉ là cache client, bổ sung cho cache server.

## 8. Deploy

**Docker Compose — 4 service:**
```yaml
services:
  nginx:    # TLS termination + serve static + reverse proxy /api → express
  express:  # app, PM2 cluster 2-N worker
  postgres: # volume mount cho persistence
  redis:    # AOF persistence (optional)
```

- `.env`: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `FIREANT_USER`, `FIREANT_PASS`, `GSHEET_SYNC_URL/TOKEN` (giữ nguyên).
- **Bootstrap:** migration script tạo admin user đầu tiên (từ env) + migrate `filter-presets.json`.
- **VPS tối thiểu:** 2 vCPU / 2GB RAM (Postgres + Redis + Express + Nginx).

## 9. Phân pha triển khai

Mỗi phase **shippable độc lập**, test được riêng:

| Phase | Scope | Giải quyết vấn đề |
|---|---|---|
| **1. Infra** | Docker + Postgres + Redis + migrations + connection helpers | Nền tảng DB |
| **2. Cache layer** | `server/cache.js` (Redis+Postgres) + refresh scheduler; thay Map in-memory | **Giảm API call FireAnt** (trọng tâm) |
| **3. Auth** | users table, register/login, JWT cookie middleware, admin approval | Multi-user login |
| **4. User data** | watchlist + portfolio + migrate filter-presets per-user | Data cá nhân |
| **5. Deploy** | Nginx + PM2 cluster + hardening + TLS | Production |

> **Phase 2** giải quyết trực tiếp vấn đề user nêu (giảm API call), và **đã có giá trị ngay cả khi chưa làm multi-user** — vì cache được bền + share giữa các process.

## 10. Out of scope (defer)

- FireAnt cookie pooling đa account (phase sau, khi bị rate-limit thực tế).
- Realtime push (WebSocket/SSE) — dashboard hiện poll đủ, chưa cần.
- Alert/cảnh báo giá (user đã bỏ chọn — không làm phase đầu).
- Payment/billing (không yêu cầu).

## 11. Rủi ro & cách xử lý

| Rủi ro | Cách xử lý |
|---|---|
| FireAnt block IP khi scheduler call quá thường xuyên | Interval tối thiểu 20s + stale fallback + cookie rotation sau |
| Scheduler chạy nhiều instance PM2 cùng refresh | Redis SETNX lock, chỉ 1 worker refresh mỗi key |
| Postgres quá tải khi 2000 user query watchlist | Index `(user_id, symbol)`; watchlist query nhẹ, cache hit Redis cho market data |
| JWT bị rò rỉ | httpOnly + SameSite=Strict + short access TTL (15p) + refresh rotation |
| Migrate filter-presets.json mất data | Script migrate chạy 1 lần, gán cho admin; giữ file backup |
| Playwright autologin FireAnt nặng khi multi-process | Tách thành worker riêng (đã có `cookie-sync.js`), cookie cache 10 phút share qua Redis |
