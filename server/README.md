# VN Stock Market Server

Backend Express proxy cho dashboard chứng khoán VN.

## Cache Layer (Phase 1-2)

Data market được cache qua **Redis (hot) + Postgres (cold)** để giảm API call tới FireAnt/Fiintrade khi nhiều user.

### Kiến trúc

```
User → Express endpoint → cache.js
                           ├─ Redis (TTL 20s-2p, hot path <1ms)
                           └─ Postgres api_cache (cold, repopulate Redis khi miss)
```

- **`cache.js`** — module cache: `getCached/setCached/getStale` (async).
- **`db.js`** — pool Postgres (`pg`).
- **`redis-client.js`** — client Redis (`ioredis`).
- **`scheduler.js`** — Refresh Scheduler: định kỳ self-call endpoint để làm mới cache nền → user luôn cache hit.

### Setup

```bash
# 1. Khởi động Postgres + Redis (dev local)
docker compose up -d

# 2. Cài deps
npm install

# 3. Chạy migration (tạo bảng api_cache)
npm run migrate

# 4. Khởi động server
npm start
```

### Biến env (xem `.env.example`)

- `DATABASE_URL` — connection string Postgres
- `REDIS_URL` — connection string Redis
- `SCHEDULER_DISABLED=1` — tắt Refresh Scheduler (vd khi chạy test)

### Test

```bash
npm test    # vitest — cần Postgres + Redis đang chạy
```

### TTL cache theo endpoint

| Endpoint group | TTL |
|---|---|
| market-stats, vnindex-demand, vn30-demand | 20-30s |
| market-breadth | 30s |
| influential-stocks, all-stocks, investor-flow, foreign-flow, investor-detail, industry-stats, marketcap-stats, top-net-stocks, industry-flow, stock-investor-flow | 60s |
| news | 120s |

Khi Postgres/Redis lỗi, cache fallback (stale data từ lần fetch gần nhất) vẫn trả về để dashboard không trắng.
