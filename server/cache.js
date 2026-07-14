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

// ==========================================
// EOD SMART-CACHE — data theo ngày (dòng tiền ngành, v.v.)
// ==========================================
// Khác với TTL cố định: EOD data chỉ đổi 1 lần/ngày (buổi tối).
// Cache đến hết ngày giao dịch hiện tại. Khi data "hôm nay" đã có,
// mọi request trong ngày đều trả cache → 0 call Fiintrade.

/**
 * EOD cache key đánh thêm ngày hiện tại để tự expire sang ngày mới.
 * Vd 'industry-flow:1:2' + ngày 2026-07-15 → 'eod:2026-07-15:industry-flow:1:2'
 */
function eodKey(key) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `eod:${today}:${key}`;
}

/**
 * Đọc EOD cache. TTL = 24h (đủ an toàn, key đổi theo ngày nên qua ngày mới miss).
 */
async function getCachedEOD(key) {
    return getCached(eodKey(key), 24 * 3600 * 1000);
}

/**
 * Ghi EOD cache.
 */
async function setCachedEOD(key, data) {
    return setCached(eodKey(key), data, 24 * 3600 * 1000);
}

/**
 * Kiểm tra EOD data của hôm nay đã có chưa (để scheduler biết có cần retry).
 */
async function hasEODToday(key) {
    const v = await getCached(eodKey(key), 24 * 3600 * 1000);
    return v !== null;
}

// ==========================================
// API CALL COUNTER — đếm số lần gọi nguồn ngoài (FireAnt/Fiintrade)
// ==========================================
// Lưu trong Redis theo ngày, key 'api_calls:YYYY-MM-DD:source'.
// Reset tự động mỗi ngày (key theo ngày).

const apiCounter = {
    /**
     * Tăng counter khi gọi API ngoài.
     * @param {'fireant'|'fiintrade'} source
     */
    async bump(source) {
        const today = new Date().toISOString().slice(0, 10);
        const k = `api_calls:${today}:${source}`;
        try { await redis.incr(k); await redis.expire(k, 86400 * 2); } catch (e) { /* ignore */ }
    },

    /**
     * Đọc counter hôm nay. Trả { fireant, fiintrade }.
     */
    async today() {
        const today = new Date().toISOString().slice(0, 10);
        let fireant = 0, fiintrade = 0;
        try {
            const f = await redis.get(`api_calls:${today}:fireant`);
            const t = await redis.get(`api_calls:${today}:fiintrade`);
            fireant = f ? parseInt(f) : 0;
            fiintrade = t ? parseInt(t) : 0;
        } catch (e) { /* ignore */ }
        return { fireant, fiintrade, date: today };
    }
};

module.exports = { getCached, setCached, getStale, invalidate, getCachedEOD, setCachedEOD, hasEODToday, apiCounter };
