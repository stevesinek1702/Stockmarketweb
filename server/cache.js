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

    // Redis (hot path)
    try {
        await redis.set(rkey(key), JSON.stringify(data), 'EX', ttlSec);
    } catch (e) {
        console.warn('⚠️  [cache] redis SETEX fail:', e.message);
    }

    // Postgres UPSERT (cold path, bền vững)
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
 * Chỉ đọc Postgres (stale data hiếm khi cần hot path).
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
