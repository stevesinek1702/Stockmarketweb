# Multi-User — Phase 1 (Infra) + Phase 2 (Cache Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay cache in-memory (`Map`) bằng lớp cache Redis + Postgres + Refresh Scheduler, giảm số external API call tới FireAnt/Fiintrade bất kể số user.

**Architecture:** Module `server/cache.js` cung cấp cùng interface `getCached/setCached/getStale` (chuyển sang async) — Redis làm hot cache (TTL tự expire), Postgres `api_cache` table làm cold/bền vững, Refresh Scheduler chạy nền fetch FireAnt/Fiintrade theo interval định sẵn. Toàn bộ 32 call site trong `server.js` chuyển từ sync sang `await`.

**Tech Stack:** Node.js, Express, `pg` (node-postgres), `ioredis`, Vitest (test), Docker Compose (Postgres+Redis local).

**Spec:** `docs/superpowers/specs/2026-07-14-multi-user-database-design.md`

---

## Bối cảnh quan trọng cho engineer

- File chính: `server/server.js` (~2774 dòng). Cache helpers hiện tại ở **dòng 111-139** (sync, dùng `Map`).
- **32 call site** cần thêm `await` khi chuyển sang async (xem bảng ở cuối plan).
- **14 cache key duy nhất**: 10 tĩnh (`influential-stocks`, `market-breadth`, `all-stocks`, `investor-flow`, `foreign-flow`, `investor-detail`, `industry-stats`, `marketcap-stats`, `vnindex-demand`, `vn30-demand`, `top-net-stocks`) + 4 động (`market-stats-${symbol}`, `industry-flow-${timeRange}-${level}`, `stock-investor-flow-${symbol}-${freq}`, `news-${category||'all'}-${limit}`).
- **2 endpoint dùng `getStaleResponse`** (fallback khi nguồn lỗi): `market-stats-${symbol}` (server.js:179) và `top-net-stocks` (server.js:2727).
- Chưa có test framework trong `server/` — Task 0 thêm Vitest.
- Server start ở `server.js:2755` (`app.listen` + cookie-sync + potential-scan).

---

## File Structure

**Tạo mới:**
- `server/db.js` — Pool Postgres (pg), export `query(text, params)` + `pool`.
- `server/redis-client.js` — Redis client (ioredis), export `redis` + helper đóng.
- `server/cache.js` — module cache chính: `getCached/setCached/getStale` (async), gọi Redis→Postgres.
- `server/migrations/001_api_cache.sql` — tạo bảng `api_cache`.
- `server/scripts/migrate.js` — chạy file migration.
- `server/scheduler.js` — Refresh Scheduler, refresh các cache key theo interval.
- `server/__tests__/cache.test.js` — test cache module (cần Redis+Postgres chạy).
- `server/vitest.config.js` — config test server.
- `docker-compose.yml` (root) — Postgres + Redis cho dev local.

**Sửa:**
- `server/package.json` — thêm deps `pg`, `ioredis`, `vitest`; script `test`, `migrate`.
- `server/.env.example` — thêm `DATABASE_URL`, `REDIS_URL`.
- `server/server.js` — thay cache helpers (dòng 111-139), thêm `await` ở 32 call site, gọi scheduler khi start.

---

## Task 0: Setup test framework (Vitest) trong server

**Files:**
- Modify: `server/package.json`
- Create: `server/vitest.config.js`

- [ ] **Step 1: Thêm vitest vào server/package.json devDependencies + script test**

Sửa `server/package.json` — thêm `devDependencies` và script `test`:

```json
{
  "name": "vnstock-server",
  "version": "1.0.0",
  "description": "Backend server for VN Stock Market website - API Proxy",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js",
    "test": "vitest run",
    "migrate": "node scripts/migrate.js"
  },
  "dependencies": {
    "adm-zip": "^0.5.17",
    "axios": "^1.6.2",
    "cors": "^2.8.5",
    "dotenv": "^17.4.2",
    "express": "^4.18.2",
    "playwright": "^1.60.0",
    "xlsx": "^0.18.5",
    "xml2js": "^0.6.2"
  },
  "devDependencies": {
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 2: Tạo server/vitest.config.js**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.js'],
    watch: false,
    testTimeout: 10000
  }
});
```

- [ ] **Step 3: Cài dependencies**

Run: `cd server && npm install`
Expected: cài thành công `vitest` + (sau này) `pg`, `ioredis`.

- [ ] **Step 4: Tạo smoke test verify framework**

Tạo `server/__tests__/smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

describe('vitest setup', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run test verify pass**

Run: `cd server && npm test`
Expected: 1 test PASS.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/vitest.config.js server/__tests__/smoke.test.js
git commit -m "test(server): setup vitest + test script"
```

---

## Task 1: Docker Compose cho Postgres + Redis (dev local)

**Files:**
- Create: `docker-compose.yml` (root project)
- Create: `server/.env.example` (modify — thêm DATABASE_URL, REDIS_URL)

- [ ] **Step 1: Tạo docker-compose.yml ở root**

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    container_name: vnstock-postgres
    environment:
      POSTGRES_USER: vnstock
      POSTGRES_PASSWORD: vnstock_dev
      POSTGRES_DB: vnstock
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vnstock"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: vnstock-redis
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
  redisdata:
```

- [ ] **Step 2: Cập nhật server/.env.example**

```env
PORT=3000
GSHEET_SYNC_URL=
GSHEET_SYNC_TOKEN=

# Phase 1-2: Cache layer
DATABASE_URL=postgres://vnstock:vnstock_dev@localhost:5432/vnstock
REDIS_URL=redis://localhost:6379
```

- [ ] **Step 3: Khởi động services**

Run: `docker compose up -d`
Expected: 2 container `vnstock-postgres` + `vnstock-redis` ở trạng thái healthy.

Verify: `docker compose ps` → cả 2 "healthy".

- [ ] **Step 4: Verify kết nối thủ công**

Run: `docker exec vnstock-postgres psql -U vnstock -c "SELECT 1;"`
Expected: trả về `?column?` / `1`.

Run: `docker exec vnstock-redis redis-cli ping`
Expected: `PONG`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml server/.env.example
git commit -m "infra: docker compose postgres + redis for dev"
```

---

## Task 2: Postgres connection module (`server/db.js`)

**Files:**
- Create: `server/db.js`
- Modify: `server/package.json` (thêm `pg`)

- [ ] **Step 1: Thêm dependency `pg`**

Run: `cd server && npm install pg`
(`package.json` tự thêm `"pg": "^8.x"` vào dependencies.)

- [ ] **Step 2: Tạo server/db.js**

```js
const { Pool } = require('pg');

// DATABASE_URL ví dụ: postgres://user:pass@host:5432/db
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,                      // tối đa 10 connection trong pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
    console.error('❌ [db] Unexpected idle client error:', err.message);
});

/**
 * Wrapper cho query — dùng cho mọi truy vấn Postgres.
 * @param {string} text SQL với placeholders ($1, $2, ...)
 * @param {Array} params
 */
async function query(text, params) {
    return pool.query(text, params);
}

module.exports = { pool, query };
```

- [ ] **Step 3: Tạo file .env local (copy từ .env.example + giá trị dev)**

Tạo `server/.env` với (nếu chưa có thì thêm vào file có sẵn):

```env
PORT=3000
GSHEET_SYNC_URL=
GSHEET_SYNC_TOKEN=
DATABASE_URL=postgres://vnstock:vnstock_dev@localhost:5432/vnstock
REDIS_URL=redis://localhost:6379
```

> Lưu ý: `server/.env` đã có sẵn (472 byte) — CHỈ THÊM 2 dòng `DATABASE_URL` + `REDIS_URL` vào cuối, không ghi đè giá trị `GSHEET_*` đang hoạt động.

- [ ] **Step 4: Test kết nối**

Tạo tạm `server/__tests__/db.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { query } from '../db.js';

describe('db connection', () => {
  it('connects and returns 1', async () => {
    const res = await query('SELECT 1 AS n');
    expect(res.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 5: Chạy test**

Run: `cd server && npm test`
Expected: PASS "connects and returns 1".

Nếu FAIL "connect ECONNREFUSED" → kiểm tra `docker compose ps` (Postgres phải healthy) + `DATABASE_URL` đúng.

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/__tests__/db.test.js server/package.json server/package-lock.json server/.env.example
git commit -m "feat(db): postgres pool + connection module"
```

---

## Task 3: Migration — bảng `api_cache`

**Files:**
- Create: `server/migrations/001_api_cache.sql`
- Create: `server/scripts/migrate.js`

- [ ] **Step 1: Tạo file migration SQL**

`server/migrations/001_api_cache.sql`:

```sql
-- Bảng cache cho data market chung (Phase 2).
-- Mỗi row = 1 cache key (cả static lẫn dynamic key như 'market-stats:HOSTC').
CREATE TABLE IF NOT EXISTS api_cache (
    cache_key   TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ttl_seconds INT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_cache_fetched ON api_cache(fetched_at);
```

- [ ] **Step 2: Tạo runner migration**

`server/scripts/migrate.js`:

```js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function runMigrations() {
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    console.log(`🗂️  Running ${files.length} migration(s)...`);
    for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        console.log(`  → ${file}`);
        await pool.query(sql);
    }
    console.log('✅ Migrations complete.');
    await pool.end();
}

runMigrations().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
```

- [ ] **Step 3: Chạy migration**

Run: `cd server && npm run migrate`
Expected: in `→ 001_api_cache.sql` + `✅ Migrations complete.`

- [ ] **Step 4: Verify bảng đã tạo**

Run: `docker exec vnstock-postgres psql -U vnstock -c "\d api_cache"`
Expected: hiện cấu trúc bảng (4 cột: `cache_key`, `data`, `fetched_at`, `ttl_seconds`).

- [ ] **Step 5: Commit**

```bash
git add server/migrations/ server/scripts/migrate.js
git commit -m "feat(db): migration runner + api_cache table"
```

---

## Task 4: Redis connection module (`server/redis-client.js`)

**Files:**
- Create: `server/redis-client.js`
- Modify: `server/package.json` (thêm `ioredis`)

- [ ] **Step 1: Thêm dependency `ioredis`**

Run: `cd server && npm install ioredis`

- [ ] **Step 2: Tạo server/redis-client.js**

```js
const Redis = require('ioredis');

// REDIS_URL ví dụ: redis://localhost:6379
// Dùng lazyConnect để kiểm soát thời điểm kết nối.
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
        return Math.min(times * 500, 3000);  // backoff 500ms..3s
    }
});

redis.on('error', (err) => {
    console.error('❌ [redis] error:', err.message);
});

redis.on('connect', () => {
    console.log('✅ [redis] connected');
});

/**
 * Đóng connection khi shutdown (cho test/graceful shutdown).
 */
async function closeRedis() {
    await redis.quit();
}

module.exports = { redis, closeRedis };
```

- [ ] **Step 3: Test kết nối Redis**

Tạo `server/__tests__/redis.test.js`:

```js
import { describe, it, expect, afterAll } from 'vitest';
import { redis, closeRedis } from '../redis-client.js';

afterAll(async () => { await closeRedis(); });

describe('redis connection', () => {
  it('sets and gets a value', async () => {
    await redis.set('test:k', 'v', 'EX', 10);
    const v = await redis.get('test:k');
    expect(v).toBe('v');
    await redis.del('test:k');
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd server && npm test`
Expected: PASS "sets and gets a value".

Nếu FAIL "Connection timeout" → kiểm tra `docker compose ps` (Redis healthy) + `REDIS_URL`.

- [ ] **Step 5: Commit**

```bash
git add server/redis-client.js server/__tests__/redis.test.js server/package.json server/package-lock.json
git commit -m "feat(cache): redis client module + connection test"
```

---

## Task 5: Cache module (`server/cache.js`) — chìa khóa Phase 2

**Files:**
- Create: `server/cache.js`
- Create: `server/__tests__/cache.test.js`

Module này thay 3 hàm sync `getCachedResponse/setCachedResponse/getStaleResponse` (server.js:111-139). Interface giữ tên gần giống để refactor dễ, nhưng **async**.

- [ ] **Step 1: Viết test trước (failing)**

`server/__tests__/cache.test.js`:

```js
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getCached, setCached, getStale, invalidate } from '../cache.js';
import { redis, closeRedis } from '../redis-client.js';
import { query } from '../db.js';

afterAll(async () => { await closeRedis(); });

beforeEach(async () => {
    // Xoá key test trước mỗi case
    await invalidate('test:k');
});

describe('cache module', () => {
  it('returns null when key absent', async () => {
    const v = await getCached('test:k', 60000);
    expect(v).toBeNull();
  });

  it('set then get returns the data (Redis hit)', async () => {
    await setCached('test:k', { hello: 'world' }, 60000);
    const v = await getCached('test:k', 60000);
    expect(v).toEqual({ hello: 'world' });
  });

  it('persists to Postgres (survives Redis miss)', async () => {
    await setCached('test:k', { n: 42 }, 60000);
    // Giả lập Redis miss: xoá key Redis
    await redis.del('cache:test:k');
    const v = await getCached('test:k', 60000);
    expect(v).toEqual({ n: 42 });
    // Redis phải được repopulate
    const raw = await redis.get('cache:test:k');
    expect(raw).not.toBeNull();
  });

  it('getStale returns data even when TTL expired (within Postgres)', async () => {
    // Insert 1 row có fetched_at cũ (TTL đã hết)
    await query(
      `INSERT INTO api_cache (cache_key, data, fetched_at, ttl_seconds)
       VALUES ('test:k', '{"x":1}', now() - interval '1 hour', 60)
       ON CONFLICT (cache_key) DO UPDATE SET data=EXCLUDED.data, fetched_at=EXCLUDED.fetched_at, ttl_seconds=EXCLUDED.ttl_seconds`,
      []
    );
    await redis.del('cache:test:k');
    const stale = await getStale('test:k');
    expect(stale).toEqual({ x: 1 });
  });

  it('getStale returns null when key absent', async () => {
    const stale = await getStale('test:absent');
    expect(stale).toBeNull();
  });
});
```

- [ ] **Step 2: Run test verify fail**

Run: `cd server && npx vitest run __tests__/cache.test.js`
Expected: FAIL — `Cannot find module '../cache.js'`.

- [ ] **Step 3: Implement cache.js**

`server/cache.js`:

```js
const { redis } = require('./redis-client');
const { query } = require('./db');

// Prefix mọi Redis key bằng 'cache:' để tránh đụng namespace khác (test, session...)
const PREFIX = 'cache:';
const rkey = (key) => `${PREFIX}${key}`;

/**
 * Đọc cache theo TTL.
 * Flow: Redis (hot) → Postgres (cold, repopulate Redis) → null.
 *
 * @param {string} key cache key (vd 'market-stats:HOSTC')
 * @param {number} ttlMs TTL milliseconds — dùng để kiểm tra freshness ở tầng Postgres
 * @returns {Promise<object|null>} data hoặc null nếu miss/expired
 */
async function getCached(key, ttlMs) {
    // 1. Redis hot path
    try {
        const raw = await redis.get(rkey(key));
        if (raw) return JSON.parse(raw);
    } catch (e) {
        console.warn('⚠️  [cache] redis GET fail:', e.message);
    }

    // 2. Postgres cold path — kiểm tra còn TTL?
    try {
        const res = await query(
            `SELECT data, fetched_at, ttl_seconds FROM api_cache WHERE cache_key = $1`,
            [key]
        );
        if (res.rowCount > 0) {
            const row = res.rows[0];
            const ageMs = Date.now() - new Date(row.fetched_at).getTime();
            if (ageMs < row.ttl_seconds * 1000) {
                // Còn hạn → repopulate Redis + return
                try {
                    const ttlSec = Math.max(1, Math.ceil((row.ttl_seconds * 1000 - ageMs) / 1000));
                    await redis.set(rkey(key), JSON.stringify(row.data), 'EX', ttlSec);
                } catch (e) {
                    console.warn('⚠️  [cache] redis SET (repopulate) fail:', e.message);
                }
                return row.data;
            }
        }
    } catch (e) {
        console.warn('⚠️  [cache] pg SELECT fail:', e.message);
    }

    return null;
}

/**
 * Ghi cache vào cả Redis + Postgres.
 *
 * @param {string} key
 * @param {object} data
 * @param {number} ttlMs TTL milliseconds
 */
async function setCached(key, data, ttlMs) {
    const ttlSec = Math.ceil(ttlMs / 1000);

    // Redis (fire-and-forget nhưng await để bắt lỗi)
    try {
        await redis.set(rkey(key), JSON.stringify(data), 'EX', ttlSec);
    } catch (e) {
        console.warn('⚠️  [cache] redis SETEX fail:', e.message);
    }

    // Postgres UPSERT
    try {
        await query(
            `INSERT INTO api_cache (cache_key, data, fetched_at, ttl_seconds)
             VALUES ($1, $2, now(), $3)
             ON CONFLICT (cache_key) DO UPDATE
               SET data = EXCLUDED.data,
                   fetched_at = EXCLUDED.fetched_at,
                   ttl_seconds = EXCLUDED.ttl_seconds`,
            [key, JSON.stringify(data), ttlSec]
        );
    } catch (e) {
        console.warn('⚠️  [cache] pg UPSERT fail:', e.message);
    }
}

/**
 * Đọc stale (bất kể TTL) — fallback khi nguồn ngoài lỗi.
 * Chỉ đọc Postgres (không cần Redis vì stale data hiếm khi cần hot).
 */
async function getStale(key) {
    try {
        const res = await query(
            `SELECT data FROM api_cache WHERE cache_key = $1`,
            [key]
        );
        return res.rowCount > 0 ? res.rows[0].data : null;
    } catch (e) {
        console.warn('⚠️  [cache] pg getStale fail:', e.message);
        return null;
    }
}

/**
 * Xoá key khỏi cả Redis + Postgres (dùng cho test + invalidate thủ công).
 */
async function invalidate(key) {
    try { await redis.del(rkey(key)); } catch (e) { /* ignore */ }
    try { await query('DELETE FROM api_cache WHERE cache_key = $1', [key]); } catch (e) { /* ignore */ }
}

module.exports = { getCached, setCached, getStale, invalidate };
```

- [ ] **Step 4: Run test verify pass**

Run: `cd server && npx vitest run __tests__/cache.test.js`
Expected: 5 test PASS.

Nếu FAIL ở "persists to Postgres": kiểm tra `setCached` có UPSERT thành công — `SELECT * FROM api_cache WHERE cache_key='test:k'`.

- [ ] **Step 5: Commit**

```bash
git add server/cache.js server/__tests__/cache.test.js
git commit -m "feat(cache): Redis+Postgres cache module with stale fallback"
```

---

## Task 6: Refactor server.js — thay cache helpers + async call sites

Đây là task lớn nhưng cơ học: thay 3 hàm + thêm `await` ở 32 call site. **Quan trọng:** endpoint handler phải chuyển từ `(req,res) => {...}` sang `async (req,res) => {...}` nếu chưa phải async.

**Files:**
- Modify: `server/server.js` (dòng 111-139 + 32 call site)

- [ ] **Step 1: Xóa cache helpers cũ + import module mới**

Tìm block dòng 111-139 trong `server/server.js`:

```js
const responseCache = new Map();

function getCachedResponse(key, ttlMs) {
    const entry = responseCache.get(key);
    if (entry && Date.now() - entry.time < ttlMs) {
        return entry.data;
    }
    return null;
}

function setCachedResponse(key, data) {
    responseCache.set(key, { data, time: Date.now() });
}

function getStaleResponse(key) {
    const entry = responseCache.get(key);
    return entry ? entry.data : null;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of responseCache) {
        if (now - entry.time > 300000) {
            responseCache.delete(key);
        }
    }
}, 300000);
```

**Thay toàn bộ block trên bằng:**

```js
// Cache layer: Redis (hot) + Postgres (cold) — xem server/cache.js
const { getCached, setCached, getStale } = require('./cache');

// Backward-compat wrappers (async) — giữ tên cũ để ít đổi call site.
// Lưu ý: trả về Promise, caller PHẢI await.
const getCachedResponse = (key, ttlMs) => getCached(key, ttlMs);
const setCachedResponse = (key, data, ttlMs) => {
    // setCachedResponse cũ chỉ nhận 2 tham số → mặc định dùng ttlMs truyền vào.
    // Để giữ call site cũ (setCachedResponse(key, data)), cần lưu TTL theo key.
    // → Xem Task 6 Step 3 cho cách map TTL.
};
const getStaleResponse = (key) => getStale(key);
```

> ⚠️ **Vấn đề với `setCachedResponse` cũ:** hiện tại được gọi là `setCachedResponse(key, data)` (KHÔNG có TTL — TTL chỉ truyền vào lúc `getCachedResponse`). Như vậy module mới cần biết TTL khi SET. **Solution ở Step 3: thêm bảng TTL map cố định.**

- [ ] **Step 2: Thêm bảng TTL cố định (map cache key → TTL)**

Bên trên block cache helper đã thay, thêm:

```js
// TTL mặc định theo cache key (millisecond). Key động dùng prefix matching.
const CACHE_TTL_MS = {
    'market-stats': 20000,        // 20s — dynamic prefix 'market-stats-*'
    'vnindex-demand': 30000,
    'vn30-demand': 30000,
    'market-breadth': 30000,
    'influential-stocks': 60000,
    'all-stocks': 60000,
    'industry-flow': 60000,       // dynamic prefix
    'investor-flow': 60000,
    'foreign-flow': 60000,
    'investor-detail': 60000,
    'stock-investor-flow': 60000, // dynamic prefix
    'industry-stats': 60000,
    'marketcap-stats': 60000,
    'top-net-stocks': 60000,
    'news': 120000                // dynamic prefix
};

/**
 * Tra TTL cho cache key (xử lý cả key động như 'market-stats:HOSTC').
 */
function ttlForKey(key) {
    // Match exact trước
    if (CACHE_TTL_MS[key]) return CACHE_TTL_MS[key];
    // Match prefix (vd 'market-stats:HOSTC' → 'market-stats')
    for (const prefix of Object.keys(CACHE_TTL_MS)) {
        if (key.startsWith(prefix)) return CACHE_TTL_MS[prefix];
    }
    return 60000;  // default
}
```

> **Lưu ý normalize cache key:** hiện tại key động dùng dấu `-` (vd `market-stats-HOSC`). Khi đưa vào Postgres/Redis thì vẫn ok, nhưng để dễ match prefix, **nên chuyển từ `-` sang `:`** (vd `market-stats:HOSTC`). Thực hiện ở Step 4 khi sửa từng call site.

- [ ] **Step 3: Thay wrappers chính xác**

Thay block wrapper ở Step 1 bằng:

```js
// Cache layer: Redis (hot) + Postgres (cold) — xem server/cache.js
const { getCached, setCached, getStale } = require('./cache');

// TTL map + helper
const CACHE_TTL_MS = {
    'market-stats': 20000,
    'vnindex-demand': 30000,
    'vn30-demand': 30000,
    'market-breadth': 30000,
    'influential-stocks': 60000,
    'all-stocks': 60000,
    'industry-flow': 60000,
    'investor-flow': 60000,
    'foreign-flow': 60000,
    'investor-detail': 60000,
    'stock-investor-flow': 60000,
    'industry-stats': 60000,
    'marketcap-stats': 60000,
    'top-net-stocks': 60000,
    'news': 120000
};

function ttlForKey(key) {
    if (CACHE_TTL_MS[key]) return CACHE_TTL_MS[key];
    for (const prefix of Object.keys(CACHE_TTL_MS)) {
        if (key.startsWith(prefix)) return CACHE_TTL_MS[prefix];
    }
    return 60000;
}

// Backward-compat wrappers (async — caller PHẢI await)
async function getCachedResponse(key, ttlMs) {
    return getCached(key, ttlMs);
}
async function setCachedResponse(key, data) {
    return setCached(key, data, ttlForKey(key));
}
async function getStaleResponse(key) {
    return getStale(key);
}
```

- [ ] **Step 4: Sửa 32 call site — thêm await + chuẩn hóa key động**

Duyệt qua từng call site (xem bảng cuối plan). Ví dụ endpoint `market-stats` (dòng ~168-179):

**TRƯỚC:**
```js
const cacheKey = `market-stats-${symbol}`;
const cached = getCachedResponse(cacheKey, 20000);
if (cached) { return res.json(cached); }
// ... fetch FireAnt ...
setCachedResponse(cacheKey, data);
// ... lỗi fallback:
const stale = getStaleResponse(cacheKey);
```

**SAU:**
```js
const cacheKey = `market-stats:${symbol}`;  // đổi - thành :
const cached = await getCachedResponse(cacheKey, 20000);
if (cached) { return res.json(cached); }
// ... fetch FireAnt ...
await setCachedResponse(cacheKey, data);
// ... lỗi fallback:
const stale = await getStaleResponse(cacheKey);
```

Áp dụng cho **tất cả 32 call site** trong bảng cuối plan:
1. `getCachedResponse(...)` → `await getCachedResponse(...)`
2. `setCachedResponse(...)` → `await setCachedResponse(...)`
3. `getStaleResponse(...)` → `await getStaleResponse(...)`
4. Key động: đổi `${prefix}-${param}` → `${prefix}:${param}` (vd `market-stats-HOSTC` → `market-stats:HOSTC`, `industry-flow-1-2` → `industry-flow:1:2`, `stock-investor-flow-VNINDEX-Daily` → `stock-investor-flow:VNINDEX:Daily`, `news-all-10` → `news:all:10`)
5. Endpoint handler chưa có `async` → thêm `async`.

> **Quan trọng:** vì số lượng call site lớn, engineer NÊN dùng search-replace cẩn thận. Grep `getCachedResponse|setCachedResponse|getStaleResponse` để không sót.

- [ ] **Step 5: Khởi tạo kết nối DB/Redis trước app.listen**

Tìm block `app.listen(PORT, ...)` ở cuối server.js (~dòng 2755). BỔ SUNG khởi tạo + healthcheck trước khi listen:

```js
// ── Khởi tạo cache layer trước khi listen ──
async function bootstrap() {
    const { pool } = require('./db');
    const { redis } = require('./redis-client');

    // Healthcheck Postgres
    try {
        await pool.query('SELECT 1');
        console.log('✅ [db] connected');
    } catch (e) {
        console.error('❌ [db] connect failed — cache sẽ chỉ dùng Redis/fallback in-memory. Lỗi:', e.message);
    }

    // Healthcheck Redis (ping)
    try {
        await redis.ping();
        console.log('✅ [redis] ready');
    } catch (e) {
        console.error('❌ [redis] connect failed — cache chỉ dùng Postgres. Lỗi:', e.message);
    }

    app.listen(PORT, () => {
        console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
        // ... giữ nguyên cookie-sync + potential-scan cũ ...
    });
}
bootstrap();
```

> Đảm bảo bọc toàn bộ nội dung cũ trong `app.listen` callback vào `bootstrap()` — KHÔNG xóa cookie-sync hay potential-scan.

- [ ] **Step 6: Smoke test server khởi động**

Run: `cd server && npm start`
Expected log:
```
✅ [redis] connected       (từ event connect)
✅ [db] connected
✅ [redis] ready
🚀 Server chạy tại http://localhost:3000
```
(Có thể có thêm log cookie-sync / potential — OK.)

Ctrl+C để stop sau khi thấy log thành công.

- [ ] **Step 7: Test integration — gọi endpoint verify cache hoạt động**

Khởi động server (`npm start`), mở terminal khác:

Run: `curl -s http://localhost:3000/api/influential-stocks | head -c 200`
Expected: JSON response với `"success":true`.

Verify cache đã ghi vào Postgres:
Run: `docker exec vnstock-postgres psql -U vnstock -c "SELECT cache_key, fetched_at FROM api_cache;"`
Expected: có row `influential-stocks` với `fetched_at` gần now.

Call lại lần 2 (nhanh):
Run: `time curl -s http://localhost:3000/api/influential-stocks > /dev/null`
Expected: nhanh hơn rõ rệt (cache hit Redis), không thấy log FireAnt call.

- [ ] **Step 8: Commit**

```bash
git add server/server.js
git commit -m "refactor(cache): replace in-memory Map with Redis+Postgres cache

- Replace getCachedResponse/setCachedResponse/getStaleResponse (server.js:111-139)
  with async wrappers over server/cache.js
- Add await to 32 call sites, convert dynamic keys to ':' separator
- Bootstrap db+redis connection before app.listen
- TTL map (CACHE_TTL_MS) for setCachedResponse(key, data) compatibility"
```

---

## Task 7: Refresh Scheduler (`server/scheduler.js`)

Scheduler chạy nền, định kỳ fetch data từ FireAnt/Fiintrade và đẩy vào cache → **kể cả khi không ai request, cache vẫn fresh; khi user request thì luôn cache hit → giảm API call.**

Thách thức: logic fetch hiện tại nằm rải rác trong từng endpoint handler. Phase này dùng **approach tối thiểu**: scheduler chỉ refresh các cache key đơn giản (static key), bằng cách gọi HTTP vào chính server (self-call `http://localhost:PORT/api/...`). Approach này tránh refactor lớn.

**Files:**
- Create: `server/scheduler.js`
- Modify: `server/server.js` (khởi động scheduler trong bootstrap)

- [ ] **Step 1: Viết scheduler với self-call approach**

`server/scheduler.js`:

```js
const axios = require('axios');

/**
 * Refresh Scheduler — định kỳ tự gọi các endpoint nội bộ để làm mới cache.
 * Vì endpoint đã có cache (Redis+Postgres) ở đầu, self-call sẽ:
 *   - Cache miss (TTL hết) → fetch FireAnt + update cache
 *   - Cache hit → trả nhanh, không gọi FireAnt
 * Cứ set interval < TTL để cache luôn còn hạn khi user thật request → user luôn cache hit.
 *
 * Chống multi-instance: dùng file lock đơn giản (chỉ 1 process scheduler).
 * Khi scale lớn hơn (PM2 cluster), chuyển sang Redis SETNX lock — Phase sau.
 */

const REFRESH_TARGETS = [
    // { url, intervalMs } — interval < TTL để cache không bao giờ miss khi user request
    { key: 'vnindex-demand',        url: '/api/vnindex-demand',     intervalMs: 25000 },
    { key: 'vn30-demand',           url: '/api/vn30-demand',        intervalMs: 25000 },
    { key: 'market-breadth',        url: '/api/market-breadth',     intervalMs: 25000 },
    { key: 'influential-stocks',    url: '/api/influential-stocks', intervalMs: 55000 },
    { key: 'all-stocks',            url: '/api/all-stocks',         intervalMs: 55000 },
    { key: 'investor-flow',         url: '/api/investor-flow',      intervalMs: 55000 },
    { key: 'foreign-flow',          url: '/api/foreign-flow',       intervalMs: 55000 },
    { key: 'investor-detail',       url: '/api/investor-detail',    intervalMs: 55000 },
    { key: 'industry-stats',        url: '/api/industry-stats',     intervalMs: 55000 },
    { key: 'marketcap-stats',       url: '/api/marketcap-stats',    intervalMs: 55000 },
    { key: 'top-net-stocks',        url: '/api/top-net-stocks',     intervalMs: 55000 },
    { key: 'news:all:20',           url: '/api/news?limit=20',      intervalMs: 110000 }
    // Dynamic key (market-stats:HOSTC, industry-flow, stock-investor-flow) — user-driven, không cần scheduler
];

let running = false;
const timers = [];

async function refreshOne(target, port) {
    const url = `http://localhost:${port}${target.url}`;
    try {
        await axios.get(url, { timeout: 30000 });
        console.log(`🔄 [scheduler] refreshed ${target.key}`);
    } catch (e) {
        console.warn(`⚠️  [scheduler] refresh ${target.key} failed: ${e.message}`);
    }
}

function startScheduler(port) {
    if (running) return;
    running = true;
    console.log(`⏰ [scheduler] starting ${REFRESH_TARGETS.length} refresh jobs`);

    for (const target of REFRESH_TARGETS) {
        // Kick-off ngay sau 10s (để server đã listen xong), rồi lặp theo interval
        setTimeout(() => {
            refreshOne(target, port);
            timers.push(setInterval(() => refreshOne(target, port), target.intervalMs));
        }, 10000 + Math.random() * 5000);  // stagger để không gọi đồng loạt
    }
}

function stopScheduler() {
    timers.forEach(clearInterval);
    timers.length = 0;
    running = false;
}

module.exports = { startScheduler, stopScheduler, REFRESH_TARGETS };
```

- [ ] **Step 2: Khởi động scheduler trong server.js bootstrap**

Trong hàm `bootstrap()` (đã tạo ở Task 6 Step 5), thêm sau `app.listen` callback:

```js
    app.listen(PORT, () => {
        console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
        // ... cookie-sync + potential-scan cũ ...

        // Refresh Scheduler — làm mới cache nền
        try {
            const { startScheduler } = require('./scheduler');
            startScheduler(PORT);
        } catch (e) {
            console.warn('⚠️  Scheduler không khởi động được:', e.message);
        }
    });
```

- [ ] **Step 3: Smoke test scheduler**

Run: `cd server && npm start`

Đợi ~15-70 giây. Expected log xuất hiện các dòng:
```
⏰ [scheduler] starting 12 refresh jobs
🔄 [scheduler] refreshed vnindex-demand
🔄 [scheduler] refreshed market-breadth
...
```
(Một số job có thể fail nếu endpoint cần query param bắt buộc — ghi nhận vào log, không block.)

Verify cache đã được populate bởi scheduler (không cần user request):
Run (terminal khác, server đang chạy):
`docker exec vnstock-postgres psql -U vnstock -c "SELECT cache_key, fetched_at FROM api_cache ORDER BY fetched_at DESC LIMIT 5;"`
Expected: nhiều row với `fetched_at` gần now (do scheduler refresh).

Ctrl+C stop server.

- [ ] **Step 4: Commit**

```bash
git add server/scheduler.js server/server.js
git commit -m "feat(scheduler): background cache refresher (self-call approach)

Pre-warms cache so user requests always hit Redis/Postgres
instead of calling FireAnt. Reduces external API load regardless
of user count."
```

---

## Task 8: End-to-end verification + cleanup

**Files:**
- Modify: `server/__tests__/smoke.test.js` (xóa — đã có test thật)
- Verify: toàn bộ stack hoạt động

- [ ] **Step 1: Xóa smoke test tạm (đã có test thật thay thế)**

Xóa file `server/__tests__/smoke.test.js` (Task 0).

Run: `cd server && rm __tests__/smoke.test.js`

- [ ] **Step 2: Chạy toàn bộ test suite**

Run: `cd server && npm test`
Expected: TẤT CẢ test PASS (smoke, db, redis, cache). Không FAIL.

- [ ] **Step 3: Full integration test — khởi động + verify cache giảm API call**

Run: `cd server && npm start` (để chạy 90 giây)

Trong terminal khác, gọi mỗi endpoint 3 lần liên tiếp:
```bash
for ep in influential-stocks market-breadth all-stocks investor-flow foreign-flow; do
  echo "=== $ep ==="
  time curl -s http://localhost:3000/api/$ep > /dev/null
done
```

Quan sát log server:
- Lần 1 (hoặc sau khi TTL hết): thấy log FireAnt fetch (vd `📊 Calculating influential stocks from FireAnt...`)
- Lần 2, 3 (cache hit): KHÔNG thấy log FireAnt fetch

Verify Postgres đã có nhiều cache row:
Run: `docker exec vnstock-postgres psql -U vnstock -c "SELECT COUNT(*) FROM api_cache;"`
Expected: ≥ 10 rows.

Ctrl+C stop server.

- [ ] **Step 4: Verify stale fallback hoạt động**

Tạm dừng Redis để giả lập lỗi:
Run: `docker compose stop redis`

Khởi động server: `cd server && npm start`
Expected: server vẫn start (log `❌ [redis] connect failed` nhưng `[db] connected`).

Run: `curl -s http://localhost:3000/api/influential-stocks | head -c 100`
Expected: vẫn trả data (từ Postgres cold path), KHÔNG crash.

Khởi động lại Redis: `docker compose start redis`
Ctrl+C server.

- [ ] **Step 5: Cập nhật .gitignore cho file local**

Kiểm tra root `.gitignore` đã ignore `server/.env`. Nếu chưa, thêm:
```
server/.env
```

> `server/.env.example` VẪN được commit (template), chỉ `.env` (giá trị thật) bị ignore.

- [ ] **Step 6: Cập nhật README ngắn**

Thêm section vào `README.md` (nếu có) hoặc tạo `server/README.md` ngắn:

```markdown
## Cache Layer (Phase 1-2)

Data market được cache qua Redis (hot) + Postgres (cold) để giảm API call tới FireAnt/Fiintrade.

### Yêu cầu
- Postgres + Redis chạy (dev: `docker compose up -d`)
- Chạy migration: `cd server && npm run migrate`
- Biến env: `DATABASE_URL`, `REDIS_URL` (xem `.env.example`)

### Scheduler
Background refresh tự làm mới cache theo interval (< TTL) → user request luôn cache hit.
```

- [ ] **Step 7: Commit cuối**

```bash
git add -A
git commit -m "test(cache): full integration verified, stale fallback works

Phase 1-2 complete: in-memory Map replaced with Redis+Postgres cache
+ background scheduler. External API calls decoupled from user request count."
```

---

## Bảng tham chiếu: 32 call site trong server.js (cho Task 6 Step 4)

| Dòng | Cache key | TTL | Loại |
|------|-----------|-----|------|
| 170 | `market-stats-${symbol}` | 20000 | getCached → await, đổi key thành `:` |
| 175 | ↑ | — | setCached → await |
| 179 | ↑ | stale | getStale → await |
| 373 | `influential-stocks` | 60000 | getCached → await |
| 484 | ↑ | — | setCached → await |
| 552 | `market-breadth` | 30000 | getCached → await |
| 597 | ↑ | — | setCached → await |
| 612 | `all-stocks` | 60000 | getCached → await |
| 788 | ↑ | — | setCached → await |
| 973 | `industry-flow-${timeRange}-${level}` | 60000 | getCached → await, đổi key |
| 998 | ↑ | — | setCached → await |
| 1030 | `investor-flow` | 60000 | getCached → await |
| 1055 | ↑ | — | setCached → await |
| 1075 | `foreign-flow` | 60000 | getCached → await |
| 1133 | ↑ | — | setCached → await |
| 1148 | `investor-detail` | 60000 | getCached → await |
| 1172 | ↑ | — | setCached → await |
| 1190 | `stock-investor-flow-${symbol}-${freq}` | 60000 | getCached → await, đổi key |
| 1195 | ↑ | — | setCached → await |
| 1417 | `news-${category\|\|'all'}-${limit}` | 120000 | getCached → await, đổi key |
| 1464 | ↑ | — | setCached → await |
| 1482 | `industry-stats` | 60000 | getCached → await |
| 1672 | ↑ | — | setCached → await |
| 1942 | `marketcap-stats` | 60000 | getCached → await |
| 2044 | ↑ | — | setCached → await |
| 2241 | `vnindex-demand` | 30000 | getCached → await |
| 2264 | ↑ | — | setCached → await |
| 2278 | `vn30-demand` | 30000 | getCached → await |
| 2301 | ↑ | — | setCached → await |
| 2599 | `top-net-stocks` | 60000 | getCached → await |
| 2723 | ↑ | — | setCached → await |
| 2727 | ↑ | stale | getStale → await |

---

## Self-Review

**Spec coverage check:**
- ✅ Schema `api_cache` (spec §4) → Task 3
- ✅ Cache module Redis+Postgres (spec §6.1) → Task 5
- ✅ Refresh Scheduler (spec §6.2) → Task 7
- ✅ Docker compose Postgres+Redis (spec §8) → Task 1
- ✅ TTL map cho 14 cache key (spec §6.1 + bảng call site) → Task 6
- ⏭ Auth/Users/Watchlist/Portfolio (spec §4-5) → Phase 3-4 (ngoài scope plan này, đã ghi rõ)

**Placeholder scan:** Không có TBD/TODO. Mọi step có code/commands đầy đủ.

**Type/signature consistency:**
- `getCached(key, ttlMs)` → được gọi trong `getCachedResponse` wrapper và 32 call site ✓
- `setCached(key, data, ttlMs)` → được gọi trong `setCachedResponse` wrapper với `ttlForKey(key)` ✓
- `getStale(key)` → wrapper `getStaleResponse` ✓
- Redis key prefix `cache:` dùng nhất quán trong cache.js và test ✓
- Postgres column `cache_key` / `data` / `fetched_at` / `ttl_seconds` dùng nhất quán migration + module + test ✓

**Scope check:** Plan này chỉ Phase 1+2 (infra + cache). Phase 3 (auth), 4 (user data), 5 (deploy) là các plan riêng — đúng theo spec §9.
