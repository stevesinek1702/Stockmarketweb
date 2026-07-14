const axios = require('axios');

/**
 * Refresh Scheduler — định kỳ tự gọi các endpoint nội bộ để làm mới cache.
 *
 * Vì mỗi endpoint đã có cache (Redis+Postgres) ở đầu, self-call sẽ:
 *   - Cache miss (TTL hết) → fetch FireAnt/Fiintrade + update cache
 *   - Cache hit → trả nhanh, không gọi nguồn ngoài
 *
 * Cứ đặt interval < TTL thì cache luôn còn hạn khi user thật request
 * → user luôn cache hit → giảm API call tới FireAnt/Fiintrade bất kể số user.
 *
 * Chống multi-instance: dùng file lock đơn giản (env SCHEDULER_DISABLED=1 để tắt).
 * Khi scale lớn (PM2 cluster), chuyển sang Redis SETNX lock — Phase sau.
 *
 * @param {number} port port mà Express đang listen
 */

// { key, url, intervalMs } — interval đặt < TTL (xem CACHE_TTL_MS trong server.js)
const REFRESH_TARGETS = [
    // TTL 20-30s: refresh 25s
    { key: 'vnindex-demand',     url: '/api/vnindex-demand',          intervalMs: 25000 },
    { key: 'vn30-demand',        url: '/api/vn30-demand',             intervalMs: 25000 },
    { key: 'market-breadth',     url: '/api/market-breadth',          intervalMs: 25000 },
    // TTL 60s: refresh 55s
    { key: 'influential-stocks', url: '/api/influential-stocks',      intervalMs: 55000 },
    { key: 'all-stocks',         url: '/api/all-stocks',              intervalMs: 55000 },
    { key: 'investor-flow',      url: '/api/investor-flow',           intervalMs: 55000 },
    { key: 'foreign-flow',       url: '/api/foreign-flow',            intervalMs: 55000 },
    { key: 'investor-detail',    url: '/api/investor-detail',         intervalMs: 55000 },
    { key: 'industry-stats',     url: '/api/industry-stats',          intervalMs: 55000 },
    { key: 'marketcap-stats',    url: '/api/marketcap-stats',         intervalMs: 55000 },
    { key: 'top-net-stocks',     url: '/api/top-net-stocks',          intervalMs: 55000 },
    // TTL 120s: refresh 110s
    { key: 'news:all:20',        url: '/api/news?limit=20',           intervalMs: 110000 }
    // Dynamic key (market-stats:HOSTC, industry-flow:*, stock-investor-flow:*) — user-driven,
    // được cache lazy khi user request, không cần pre-warm.
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
    // Cho phép tắt scheduler qua env (vd khi chạy test hoặc 1 instance trong cluster)
    if (process.env.SCHEDULER_DISABLED === '1') {
        console.log('⏰ [scheduler] disabled by SCHEDULER_DISABLED env');
        return;
    }
    if (running) return;
    running = true;
    console.log(`⏰ [scheduler] starting ${REFRESH_TARGETS.length} refresh jobs`);

    for (const target of REFRESH_TARGETS) {
        // Kick-off sau 15-20s (để server đã listen xong + cookie-sync sẵn),
        // rồi lặp theo interval. Stagger để không gọi đồng loạt.
        const delay = 15000 + Math.random() * 5000;
        setTimeout(() => {
            refreshOne(target, port);
            const t = setInterval(() => refreshOne(target, port), target.intervalMs);
            timers.push(t);
        }, delay);
    }
}

function stopScheduler() {
    timers.forEach(clearInterval);
    timers.length = 0;
    running = false;
}

module.exports = { startScheduler, stopScheduler, REFRESH_TARGETS };
