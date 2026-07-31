/**
 * TRADING-TIME HELPERS — single source of truth cho logic giờ VN (UTC+7).
 * ─────────────────────────────────────────────────────────────────────────
 * Trước đây logic giờ VN bị duplicate inline ở 4 chỗ (server.js:183, 3228, 3248,
 * scheduler.js:95, cache.js:126) — mỗi chỗ tự hand-roll `(getUTCHours()+7)%24`
 * và KHÔNG bao giờ check cuối tuần → scheduler gọi FireAnt vô ích T7/CN, và
 * không có khái niệm "catch-up ngày giao dịch gần nhất".
 *
 * Module này gom lại + thêm weekend/trading-day awareness. Toàn bộ pure function,
 * clock có thể override qua __setClock(ts) để unit test.
 *
 * NHẬT LỆ HOLIDAY: chưa hỗ trợ lễ Tết VN (cần bảng holiday duy trì). Khi holiday
 * xảy ra, Fiintrade/FireAnt vẫn trả data phiên trước → cache toDate validation
 * (cache.js) tự xử lý. TODO: thêm holiday list khi cần.
 */

// Clock override cho test. null = dùng real Date.now().
let _now = null;

/**
 * Override clock (ms epoch). Truyền null để reset về real-time.
 * Chỉ dùng cho test — KHÔNG gọi trong production code.
 */
function __setClock(ts) { _now = ts; }

function __now() { return _now !== null ? _now : Date.now(); }

/**
 * Date object "logical VN" = UTC + 7h. Dùng getUTC* để đọc → ra giá trị VN.
 * (VPS chạy UTC; cộng 7h rồi mới getUTCX = giờ VN.)
 */
function vnNow() { return new Date(__now() + 7 * 3600 * 1000); }

/** Ngày VN hiện tại dạng 'YYYY-MM-DD'. */
function vnToday() { return vnNow().toISOString().slice(0, 10); }

/** Thứ trong tuần theo VN: 0=CN, 1=T2, ..., 6=T7. */
function vnWeekday() { return vnNow().getUTCDay(); }

/** true nếu T7 hoặc CN (VN). */
function isWeekend() {
    const d = vnWeekday();
    return d === 0 || d === 6;
}

/** true nếu ngày giao dịch (T2-T6). */
function isTradingDay() { return !isWeekend(); }

/** Giờ VN dạng thập phân (vd 14.5 = 14:30 VN). */
function _vnDecimalHour() {
    const n = vnNow();
    return n.getUTCHours() + n.getUTCMinutes() / 60;
}

/**
 * true nếu trong phiên giao dịch VN (9:00-15:00, gồm ATC 14:45-15:00).
 * Cuối tuần luôn false.
 */
function isInTradingHours() {
    const t = _vnDecimalHour();
    return isTradingDay() && t >= 9 && t < 15;
}

/**
 * true nếu trong khoảng EOD refresh (15:00-23:00 VN).
 * Fiintrade update data sau 15:00 đóng cửa; kéo dài đến 23:00 cho an toàn
 * (trước đây chỉ 22:00 — đôi khi Fiintrade update trễ hơn 22:00).
 * Cuối tuần luôn false.
 */
function isInEODWindow() {
    const t = _vnDecimalHour();
    return isTradingDay() && t >= 15 && t < 23;
}

/**
 * true nếu trong khoảng Fiintrade auto-fetch (19:00-20:00 VN, T2-T6).
 * Fiintrade update EOD data xong ~18-19h. Gọi lúc này để có data hôm nay.
 * Giới hạn 1h để giảm tần suất gọi fiintrade (tránh bị block IP do spam).
 * Ngoài khoảng này → chỉ gọi khi user nhấn nút thủ công (?force=1).
 * Cuối tuần luôn false.
 */
function isInFiintradeWindow() {
    const t = _vnDecimalHour();
    return isTradingDay() && t >= 19 && t < 20;
}

/**
 * Ngày giao dịch gần nhất MÀ dữ liệu EOD có thể đã có sẵn.
 *
 * Quy tắc:
 *   - Nếu hôm nay là ngày giao dịch VÀ đã qua 15:00 VN (đóng cửa) → hôm nay.
 *   - Ngược lại (ngày giao dịch trước 15h, hoặc cuối tuần) → ngày giao dịch
 *     gần nhất TRƯỚC hôm nay (walk-back từng ngày đến khi gặp T2-T6).
 *
 * Ví dụ:
 *   T2 10:00 VN (chưa đóng cửa) → Thứ 6 tuần trước
 *   T2 16:00 VN (đã đóng cửa)   → Thứ 2 hôm nay
 *   T3-T6 10:00 VN              → hôm trước
 *   T3-T6 16:00 VN              → hôm nay
 *   T7 / CN (bất kể giờ)        → Thứ 6 tuần trước
 *
 * @returns {string} 'YYYY-MM-DD'
 */
function lastTradingDay() {
    const n = vnNow(); // đã +7h, đọc getUTC*
    const dow = n.getUTCDay();
    const beforeClose = n.getUTCHours() < 15;

    // Hôm nay là ngày giao dịch và đã đóng cửa → hôm nay
    if (dow >= 1 && dow <= 5 && !beforeClose) {
        return _ymd(n);
    }

    // Ngược lại: walk-back từng ngày từ hôm qua trở đi
    // (dùng Date UTC để tránh DST/leap weirdness)
    const base = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
    for (let i = 1; i <= 7; i++) {
        const prev = new Date(base.getTime() - i * 86400000);
        const pdow = prev.getUTCDay();
        if (pdow >= 1 && pdow <= 5) {
            return _ymd(prev);
        }
    }
    // Fallback (không bao giờ tới đây trong tuần 7 ngày)
    return _ymd(base);
}

/** Format Date → 'YYYY-MM-DD' (dùng UTC fields). */
function _ymd(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

module.exports = {
    __setClock,
    vnNow,
    vnToday,
    vnWeekday,
    isWeekend,
    isTradingDay,
    isInTradingHours,
    isInEODWindow,
    isInFiintradeWindow,
    lastTradingDay
};
