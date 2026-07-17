const axios = require('axios');

// Internal secret để bypass auth cho scheduler self-call.
// Middleware authenticate bỏ qua nếu header này khớp (chỉ scheduler nội bộ biết).
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'vnstock-scheduler-internal';

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
// Intraday endpoints: FireAnt realtime, refresh trong giờ giao dịch
const REFRESH_TARGETS = [
    // TTL 20-30s: refresh 25s
    { key: 'vnindex-demand',     url: '/api/vnindex-demand',          intervalMs: 25000 },
    { key: 'vn30-demand',        url: '/api/vn30-demand',             intervalMs: 25000 },
    { key: 'market-breadth',     url: '/api/market-breadth',          intervalMs: 25000 },
    // TTL 60s: refresh 55s
    { key: 'influential-stocks', url: '/api/influential-stocks',      intervalMs: 55000 },
    { key: 'all-stocks',         url: '/api/all-stocks',              intervalMs: 55000 },
    { key: 'marketcap-stats',    url: '/api/marketcap-stats',         intervalMs: 55000 },
    // TTL 120s: refresh 110s
    { key: 'news:all:20',        url: '/api/news?limit=20',           intervalMs: 110000 }
    // EOD endpoints (Fiintrade) tách riêng bên dưới — refresh 19-22h, không 55s
    // Dynamic key (market-stats:HOSTC, industry-flow:*, stock-investor-flow:*) — user-driven,
    // được cache lazy khi user request, không cần pre-warm.
];

// EOD endpoints: data chỉ đổi 1 lần/ngày (cuối phiên). Cache 24h.
// Scheduler refresh mỗi 30 phút trong khoảng 15:00-22:00 VN, skip nếu data hôm nay đã có.
// (Fiintrade update data sau 15:00 đóng cửa; trước đó vẫn là data hôm qua.)
// validateToDate: endpoint có toDate trong response → kiểm tra toDate thực = hôm nay.
const EOD_TARGETS = [
    { key: 'investor-flow',   url: '/api/investor-flow',   validateToDate: true },
    { key: 'foreign-flow',    url: '/api/foreign-flow',    validateToDate: true },
    { key: 'investor-detail', url: '/api/investor-detail', validateToDate: true },
    { key: 'industry-stats',  url: '/api/industry-stats',  validateToDate: false },
    { key: 'top-net-stocks',  url: '/api/top-net-stocks',  validateToDate: false }
];
const EOD_RETRY_INTERVAL_MS = 30 * 60 * 1000; // 30 phút

let running = false;
const timers = [];

async function refreshOne(target, port) {
    const url = `http://localhost:${port}${target.url}`;
    try {
        // Gửi X-Internal-Secret để bypass auth (endpoint requireAuth sẽ allow)
        await axios.get(url, {
            timeout: 30000,
            headers: { 'X-Internal-Secret': INTERNAL_SECRET }
        });
        console.log(`🔄 [scheduler] refreshed ${target.key}`);
    } catch (e) {
        console.warn(`⚠️  [scheduler] refresh ${target.key} failed: ${e.message}`);
    }
}

/**
 * EOD refresh: gọi endpoint → nếu server cache miss sẽ fetch Fiintrade + set EOD cache.
 * Skip nếu data hôm nay đã có (tránh gọi thỡ khi 600 user cùng xem).
 * validateToDate: nếu true, hasEODToday kiểm tra toDate thực = hôm nay (không chỉ key tồn tại).
 */
async function refreshEOD(target, port) {
    const { hasEODToday } = require('./cache');
    // Đã có data hôm nay (và toDate đúng) → skip
    if (await hasEODToday(target.key, { validateToDate: target.validateToDate })) {
        console.log(`✅ [scheduler-eod] ${target.key} đã có data hôm nay (toDate OK) — skip`);
        return;
    }
    // Chưa có → gọi endpoint (cache miss → fetch + cache EOD)
    await refreshOne(target, port);
}

/**
 * Kiểm tra có trong khoảng giờ EOD refresh (15:00-22:00 giờ VN) không.
 * Fiintrade update data sau 15:00 đóng cửa → bắt đầu refresh từ 15:00.
 */
function isInEODWindow() {
    const now = new Date();
    // VPS chạy UTC; giờ VN = UTC+7. 15:00 VN = 08:00 UTC, 22:00 VN = 15:00 UTC.
    const vnHour = (now.getUTCHours() + 7) % 24;
    return vnHour >= 15 && vnHour < 22;
}

function startScheduler(port) {
    // Cho phép tắt scheduler qua env (vd khi chạy test hoặc 1 instance trong cluster)
    if (process.env.SCHEDULER_DISABLED === '1') {
        console.log('⏰ [scheduler] disabled by SCHEDULER_DISABLED env');
        return;
    }
    if (running) return;
    running = true;
    console.log(`⏰ [scheduler] starting ${REFRESH_TARGETS.length} intraday + ${EOD_TARGETS.length} EOD refresh jobs`);

    // Intraday endpoints: refresh liên tục theo interval
    for (const target of REFRESH_TARGETS) {
        const delay = 15000 + Math.random() * 5000;
        setTimeout(() => {
            refreshOne(target, port);
            const t = setInterval(() => refreshOne(target, port), target.intervalMs);
            timers.push(t);
        }, delay);
    }

    // EOD endpoints: check mỗi 30 phút, chỉ refresh trong 19-22h VN khi data hôm nay chưa có
    setTimeout(() => {
        const eodTick = async () => {
            if (!isInEODWindow()) return;
            for (const target of EOD_TARGETS) {
                await refreshEOD(target, port);
            }
        };
        eodTick(); // chạy thử ngay khi start (phòng khi start trong giờ EOD)
        timers.push(setInterval(eodTick, EOD_RETRY_INTERVAL_MS));
    }, 20000);
}

function stopScheduler() {
    timers.forEach(clearInterval);
    timers.length = 0;
    running = false;
}

module.exports = { startScheduler, stopScheduler, REFRESH_TARGETS };
