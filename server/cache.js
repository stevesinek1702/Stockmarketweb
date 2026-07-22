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
 * Ngày hiện tại theo giờ VN (GMT+7) — định dạng 'YYYY-MM-DD'.
 * QUAN TRỌNG: không dùng new Date().toISOString() vì nó trả về UTC.
 * VPS chạy UTC, nhưng thị trường VN đóng cửa 15:00 VN = 08:00 UTC.
 * Nếu dùng UTC thì 0:00-7:00 sáng VN (17-24h UTC hôm trước) sẽ lệch ngày
 * → cache key sai → serve stale data tới 7h sáng.
 */
function vnToday() {
    // Cộng 7h rồi mới lấy date part → ra ngày VN đúng.
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * EOD cache key đánh thêm ngày hiện tại (VN) để tự expire sang ngày mới.
 * Vd 'industry-flow:1:2' + ngày 2026-07-15 → 'eod:2026-07-15:industry-flow:1:2'
 */
function eodKey(key) {
    return `eod:${vnToday()}:${key}`;
}

/**
 * Đọc EOD cache. TTL = 24h (đủ an toàn, key đổi theo ngày nên qua ngày mới miss).
 *
 * Tùy chọn validateToDate: nếu truyền, kiểm tra toDate/toDate trong data cache.
 * Khi toDate trong cache < ngày mong muốn (VN) → coi như miss (trả null) →
 * endpoint fetch lại. Tránh serve data hôm qua cho ngày hôm nay khi Fiintrade
 * đã update data mới.
 *
 * @param {string} key cache key
 * @param {object} [opts] {
 *   validateToDate?: boolean,  // mặc định false
 *   expectedDate?: string      // 'YYYY-MM-DD' mong muốn (mặc định = vnToday()).
 *                              // Scheduler catch-up truyền lastTradingDay() để
 *                              // chấp nhận data Thứ 6 khi chưa có data hôm nay.
 * }
 */
async function getCachedEOD(key, opts) {
    const data = await getCached(eodKey(key), 24 * 3600 * 1000);
    if (!data) return null;
    if (opts && opts.validateToDate) {
        const expected = (opts.expectedDate || vnToday()).slice(0, 10);
        // Lấy toDate từ data (endpoint investor-flow/foreign-flow lưu ở top-level)
        const toDate = data.toDate || (data.today && data.today.date) || null;
        if (toDate && String(toDate).slice(0, 10) !== expected) {
            // Cache chứa data ngày khác mong muốn → miss để endpoint fetch data mới
            console.log(`♻️  [cache-eod] ${key}: toDate ${toDate} ≠ expected ${expected} → cache miss (refresh)`);
            return null;
        }
    }
    return data;
}

/**
 * Ghi EOD cache.
 * @param {string} key
 * @param {object} data
 * @param {number} [ttlMs=24h] TTL tùy chọn (15 phút khi Fiintrade chưa update cho hôm nay)
 */
async function setCachedEOD(key, data, ttlMs) {
    return setCached(eodKey(key), data, ttlMs || 24 * 3600 * 1000);
}

/**
 * Kiểm tra EOD data của ngày mong muốn đã có chưa (để scheduler biết có cần retry).
 * Có validate toDate: data phải thực sự có toDate = ngày mong muốn.
 * Nếu data chỉ là của ngày khác (toDate < expected) → trả false để scheduler retry.
 *
 * @param {string} key cache key
 * @param {object} [opts] { validateToDate?: boolean, expectedDate?: string }
 *        expectedDate mặc định = vnToday(). Catch-up truyền lastTradingDay().
 */
async function hasEODToday(key, opts) {
    const v = await getCachedEOD(key, {
        validateToDate: opts && opts.validateToDate,
        expectedDate: opts && opts.expectedDate
    });
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
        const today = vnToday();
        const k = `api_calls:${today}:${source}`;
        try { await redis.incr(k); await redis.expire(k, 86400 * 2); } catch (e) { /* ignore */ }
    },

    /**
     * Đọc counter hôm nay. Trả { fireant, fiintrade }.
     */
    async today() {
        const today = vnToday();
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

module.exports = { getCached, setCached, getStale, invalidate, getCachedEOD, setCachedEOD, hasEODToday, apiCounter, vnToday };
