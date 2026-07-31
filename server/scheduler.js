const axios = require('axios');
const tt = require('./trading-time');

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
 * Chống multi-instance: dùng Redis SETEX ngầm ở tầng cache + Redis lock riêng
 * cho các job nặng (xem server.js acquireLock).
 *
 * TRADING-DAY AWARE (fix 2026-07-22):
 *   - Cuối tuần (T7/CN): SKIP toàn bộ — FireAnt/Fiintrade không có data mới,
 *     gọi chỉ tốn API call. Data giữ nguyên phiên Thứ 6.
 *   - Ngày giao dịch: intraday refresh trong phiên (9-15h), EOD refresh sau
 *     đóng cửa (15-23h).
 *   - MORNING CATCH-UP: mỗi 30 phút, nếu EOD data của phiên gần nhất
 *     (lastTradingDay) còn thiếu → fetch. Fix bug "data stuck hôm trước" khi
 *     container restart đêm hoặc lỡ mất window 15-23h.
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
    // industry-stats: intraday (lực cầu ngành đổi theo phiên) — KHÔNG còn là EOD (fix bug
    // "Chuyển Động Ngành đứng im cả phiên"). Cache 60s, warm 55s như marketcap-stats.
    { key: 'industry-stats',     url: '/api/industry-stats',          intervalMs: 55000 },
    // TTL 120s: refresh 110s
    { key: 'news:all:20',        url: '/api/news?limit=20',           intervalMs: 110000 }
    // EOD endpoints (Fiintrade) tách riêng bên dưới — refresh 15-23h + catch-up
    // Dynamic key (market-stats:HOSTC, industry-flow:*, stock-investor-flow:*) — user-driven,
    // được cache lazy khi user request, không cần pre-warm.
];

// EOD endpoints: data chỉ đổi 1 lần/ngày (cuối phiên). Cache 24h.
// Scheduler refresh trong 15-23h VN khi data hôm nay chưa có.
// (Fiintrade update data sau 15:00 đóng cửa; trước đó vẫn là data hôm qua.)
// validateToDate: endpoint có toDate trong response → kiểm tra toDate thực = ngày mong muốn.
const EOD_TARGETS = [
    { key: 'investor-flow',   url: '/api/investor-flow',   validateToDate: true },
    { key: 'foreign-flow',    url: '/api/foreign-flow',    validateToDate: true },
    { key: 'investor-detail', url: '/api/investor-detail', validateToDate: true },
    { key: 'top-net-stocks',  url: '/api/top-net-stocks',  validateToDate: false }
    // industry-flow: dynamic key (timeRange:level) — user-driven, scheduler không pre-warm
];

// Fundamentals refresh: 1 lần/ngày sau đóng cửa (P/E,P/B,ROE,EPS đổi chậm).
// POST endpoint — khác với EOD_TARGETS (GET). Tách logic riêng, chạy 1 lần/ngày.
const FUNDAMENTALS_TARGET = { key: 'fundamentals', url: '/api/admin/refresh-fundamentals' };
const EOD_RETRY_INTERVAL_MS = 30 * 60 * 1000; // 30 phút
const CATCHUP_INTERVAL_MS = 30 * 60 * 1000;   // 30 phút — morning catch-up

// State cho /api/admin/system-status giám sát scheduler health.
let running = false;
let lastTickAt = null;     // ISO timestamp lần tick gần nhất (bất kỳ tick nào)
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
 * Refresh POST endpoint (fundamentals). Tương tự refreshOne nhưng POST.
 * Endpoint /api/admin/refresh-fundamentals là POST nên cần helper riêng.
 */
async function refreshOnePost(target, port) {
    const url = `http://localhost:${port}${target.url}`;
    try {
        await axios.post(url, {}, {
            timeout: 60000, // fundamentals fetch nhiều batch → timeout dài hơn
            headers: { 'X-Internal-Secret': INTERNAL_SECRET }
        });
        console.log(`🔄 [scheduler] refreshed ${target.key} (POST)`);
    } catch (e) {
        console.warn(`⚠️  [scheduler] refresh ${target.key} (POST) failed: ${e.message}`);
    }
}

/**
 * EOD refresh: gọi endpoint → nếu server cache miss sẽ fetch Fiintrade + set EOD cache.
 * Skip nếu data ngày mong muốn đã có (tránh gọi thỡ khi 600 user cùng xem).
 * validateToDate: nếu true, hasEODToday kiểm tra toDate thực = ngày mong muốn.
 *
 * @param {object} target  { key, url, validateToDate }
 * @param {number} port
 * @param {string} expectedDate  'YYYY-MM-DD' phiên cần check (mặc định hôm nay).
 *                                Catch-up truyền lastTradingDay().
 */
async function refreshEOD(target, port, expectedDate) {
    const { hasEODToday } = require('./cache');
    // Đã có data ngày mong muốn (và toDate đúng) → skip
    if (await hasEODToday(target.key, {
        validateToDate: target.validateToDate,
        expectedDate
    })) {
        console.log(`✅ [scheduler-eod] ${target.key} đã có data ${expectedDate || 'today'} (toDate OK) — skip`);
        return;
    }
    // Chưa có → gọi endpoint (cache miss → fetch + cache EOD)
    await refreshOne(target, port);
}

function startScheduler(port) {
    // Cho phép tắt scheduler qua env (vd khi chạy test hoặc 1 instance trong cluster)
    if (process.env.SCHEDULER_DISABLED === '1') {
        console.log('⏰ [scheduler] disabled by SCHEDULER_DISABLED env');
        return;
    }
    if (running) return;
    running = true;
    console.log(`⏰ [scheduler] starting ${REFRESH_TARGETS.length} intraday + ${EOD_TARGETS.length} EOD + morning catch-up`);

    // ── Intraday endpoints: refresh liên tục theo interval ──────────────
    // CHỈ chạy trong phiên giao dịch (T2-T6, 9-15h VN). Cuối tuần skip hoàn toàn
    // (trước đây chạy 7 ngày/tuần → tốn FireAnt call vô ích).
    for (const target of REFRESH_TARGETS) {
        const delay = 15000 + Math.random() * 5000;
        setTimeout(() => {
            const tick = async () => {
                lastTickAt = new Date().toISOString();
                if (!tt.isInTradingHours()) return; // ngoài phiên / cuối tuần → skip
                await refreshOne(target, port);
            };
            tick();
            const t = setInterval(tick, target.intervalMs);
            timers.push(t);
        }, delay);
    }

    // ── EOD endpoints: sau đóng cửa (15-23h VN, T2-T6) ──────────────────
    setTimeout(() => {
        const eodTick = async () => {
            lastTickAt = new Date().toISOString();
            if (!tt.isInEODWindow()) return;
            const today = tt.vnToday();
            for (const target of EOD_TARGETS) {
                await refreshEOD(target, port, today);
            }

            // ── Fundamentals refresh: 1 lần/ngày (POST endpoint) ─────────
            // P/E,P/B,ROE,EPS đổi chậm → đủ 1 lần/ngày. Check hasEODToday
            // (cache file lastUpdated = today) để skip nếu đã refresh.
            try {
                const { hasEODToday } = require('./cache');
                const already = await hasEODToday(FUNDAMENTALS_TARGET.key, {
                    validateToDate: true, expectedDate: today
                });
                if (!already) {
                    console.log(`📊 [scheduler-eod] ${FUNDAMENTALS_TARGET.key} refresh fundamentals ${today}`);
                    await refreshOnePost(FUNDAMENTALS_TARGET, port);
                }
            } catch (e) {
                console.warn(`⚠️  [scheduler-eod] fundamentals refresh fail: ${e.message}`);
            }
        };
        eodTick(); // chạy thử ngay khi start (phòng khi start trong giờ EOD)
        timers.push(setInterval(eodTick, EOD_RETRY_INTERVAL_MS));
    }, 20000);

    // ── MORNING CATCH-UP: mỗi 30 phút, kiểm tra data phiên gần nhất ─────
    // Fix bug "data stuck hôm trước": nếu container restart đêm hoặc lỡ window
    // 15-23h, data EOD của phiên gần nhất (lastTradingDay) sẽ thiếu → user vào
    // buổi sáng hôm sau thấy data cũ. Catch-up này fetch lại bất kể giờ (miễn
    // là ngày giao dịch) khi data phiên gần nhất còn thiếu.
    setTimeout(() => {
        const catchupTick = async () => {
            lastTickAt = new Date().toISOString();
            if (!tt.isTradingDay()) return; // cuối tuần skip
            const ltd = tt.lastTradingDay();
            for (const target of EOD_TARGETS) {
                const { hasEODToday } = require('./cache');
                const has = await hasEODToday(target.key, {
                    validateToDate: target.validateToDate,
                    expectedDate: ltd
                });
                if (!has) {
                    console.log(`🌅 [scheduler-catchup] ${target.key} thiếu data ${ltd} → refresh`);
                    await refreshOne(target, port);
                }
            }
        };
        catchupTick(); // chạy ngay khi start (sau 25s) — prewarm sau restart
        timers.push(setInterval(catchupTick, CATCHUP_INTERVAL_MS));
    }, 25000);
}

function stopScheduler() {
    timers.forEach(clearInterval);
    timers.length = 0;
    running = false;
}

/**
 * Trạng thái scheduler cho /api/admin/system-status.
 */
function status() {
    return {
        running,
        schedulerDisabled: process.env.SCHEDULER_DISABLED === '1',
        lastTickAt,
        isTradingDay: tt.isTradingDay(),
        isInTradingHours: tt.isInTradingHours(),
        isInEODWindow: tt.isInEODWindow(),
        lastTradingDay: tt.lastTradingDay(),
        vnToday: tt.vnToday()
    };
}

module.exports = { startScheduler, stopScheduler, status, REFRESH_TARGETS };
