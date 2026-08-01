/**
 * ICHIMOKU BREADTH — đếm bao nhiêu CP đang TRÊN/DƯỚI từng đường Tenkan/Kijun.
 * ─────────────────────────────────────────────────────────────────────────
 * Nguồn data: server/data/ma-breadth-close.json (1576 mã × {dates, closes}).
 * Chỉ có closes (không có high/low) → dùng proxy highest-close/lowest-close
 * cho Tenkan/Kijun. Hợp lý cho breadth (đếm số mã), sai số nhỏ.
 *
 * Đếm theo: TOÀN THỊ TRƯỜNG (market) + từng NGÀNH ICB2 (industries).
 * Map symbol→icb2 lấy từ all-stocks cache (industryCode.substring(0,2)+'00',
 * có override cho mã FireAnt phân loại sai).
 *
 * Pattern reuse từ breadth-history.js: countAboveMAForDate + buildMAMap.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CLOSE_FILE = path.join(DATA_DIR, 'ma-breadth-close.json');

// 20 ngành ICB2 — đồng bộ breadth-history.js
const ICB2_MAP = {
    '0500': 'Dầu khí', '1300': 'Hóa chất', '1700': 'Tài nguyên cơ bản',
    '2300': 'Xây dựng và VLXD', '2700': 'Sản phẩm & DV công nghiệp',
    '3300': 'Ôtô và linh kiện', '3500': 'Thực phẩm và đồ uống',
    '3700': 'Hàng tiêu dùng', '4500': 'Y tế', '5300': 'Bán lẻ',
    '5500': 'Truyền thông', '5700': 'Du lịch và giải trí', '6500': 'Viễn thông',
    '7500': 'Các dịch vụ hạ tầng', '8300': 'Ngân hàng', '8500': 'Bảo hiểm',
    '8600': 'Bất động sản', '8700': 'Dịch vụ tài chính', '8900': 'Quỹ', '9500': 'Công nghệ'
};

// Period mặc định (user yêu cầu 5 đường, có thể edit): 9, 26, 65, 129, 234
const DEFAULT_PERIODS = [9, 26, 65, 129, 234];

let _closeCache = null;
let _closeMtime = 0;

/**
 * Load close data (cache in-process, reload khi file đổi — giống price-history.js).
 * @returns {{meta, symbols}}
 */
function _loadClose() {
    try {
        const stat = fs.existsSync(CLOSE_FILE) ? fs.statSync(CLOSE_FILE) : null;
        if (!stat) return { meta: { window: 0 }, symbols: {} };
        if (!_closeCache || stat.mtimeMs !== _closeMtime) {
            _closeCache = JSON.parse(fs.readFileSync(CLOSE_FILE, 'utf8'));
            _closeMtime = stat.mtimeMs;
        }
        return _closeCache;
    } catch (e) {
        console.error('[ichimoku-breadth] load close fail:', e.message);
        return { meta: { window: 0 }, symbols: {} };
    }
}

/**
 * Tính Tenkan-sen hiện tại của 1 symbol từ closes (proxy high=low=close).
 * Tenkan = (highest-close + lowest-close)/2 trong `period` phiên gần nhất.
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null} null nếu không đủ data
 */
function tenkanOfCloses(closes, period) {
    if (!Array.isArray(closes) || closes.length < period || period <= 0) return null;
    const slice = closes.slice(-period);
    let hi = -Infinity, lo = Infinity;
    for (const v of slice) {
        if (v > hi) hi = v;
        if (v < lo) lo = v;
    }
    return (hi + lo) / 2;
}

/**
 * Tính breadth Ichimoku: với mỗi period, đếm số mã có close HIỆN TẠI > Tenkan(period).
 *
 * @param {Object} opts
 *   - periods: number[] (mặc định DEFAULT_PERIODS)
 *   - symbolIcb2: {SYMBOL: icb2Code} map (lấy từ all-stocks). Nếu null → chỉ tính market.
 * @returns {{market, industries, meta}}
 *   market: { total, byPeriod: {9: {above, below, pct, coverage}, ...} }
 *   industries: {icb2: {name, total, byPeriod: {...}}}
 */
function computeIchimokuBreadth({ periods = DEFAULT_PERIODS, symbolIcb2 = null } = {}) {
    const data = _loadClose();
    const symbols = data.symbols || {};

    // Khởi tạo accumulator
    const market = {
        total: 0,
        byPeriod: {}
    };
    const industries = {};
    for (const p of periods) {
        market.byPeriod[p] = { above: 0, below: 0, coverage: 0, aboveStocks: [], belowStocks: [] };
    }

    for (const sym of Object.keys(symbols)) {
        const sd = symbols[sym];
        const closes = sd && Array.isArray(sd.closes) ? sd.closes : null;
        if (!closes || closes.length === 0) continue;
        const close = closes[closes.length - 1];
        if (!close || close <= 0) continue; // skip mã không giao dịch

        market.total++;

        // Phần ngành (chỉ nếu có map)
        let indAcc = null;
        if (symbolIcb2) {
            const code = symbolIcb2[sym];
            if (code && ICB2_MAP[code]) {
                if (!industries[code]) {
                    industries[code] = { name: ICB2_MAP[code], total: 0, byPeriod: {} };
                    for (const p of periods) industries[code].byPeriod[p] = { above: 0, below: 0, coverage: 0, aboveStocks: [], belowStocks: [] };
                }
                indAcc = industries[code];
                indAcc.total++;
            }
        }

        for (const p of periods) {
            const tenkan = tenkanOfCloses(closes, p);
            if (tenkan != null && tenkan > 0) {
                market.byPeriod[p].coverage++;
                const isAbove = close > tenkan;
                if (isAbove) {
                    market.byPeriod[p].above++;
                    market.byPeriod[p].aboveStocks.push({ symbol: sym, close, line: Math.round(tenkan * 100) / 100 });
                } else {
                    market.byPeriod[p].below++;
                    market.byPeriod[p].belowStocks.push({ symbol: sym, close, line: Math.round(tenkan * 100) / 100 });
                }
                if (indAcc) {
                    indAcc.byPeriod[p].coverage++;
                    if (isAbove) {
                        indAcc.byPeriod[p].above++;
                        indAcc.byPeriod[p].aboveStocks.push({ symbol: sym, close, line: Math.round(tenkan * 100) / 100 });
                    } else {
                        indAcc.byPeriod[p].below++;
                        indAcc.byPeriod[p].belowStocks.push({ symbol: sym, close, line: Math.round(tenkan * 100) / 100 });
                    }
                }
            }
        }
    }

    // Tính % cho dễ render
    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
    for (const p of periods) {
        const m = market.byPeriod[p];
        m.pctAbove = pct(m.above, m.coverage);
    }
    for (const code of Object.keys(industries)) {
        for (const p of periods) {
            const m = industries[code].byPeriod[p];
            m.pctAbove = pct(m.above, m.coverage);
        }
    }

    // Lấy ngày gần nhất từ 1 symbol đại diện
    let lastDate = null;
    for (const sym of Object.keys(symbols)) {
        const d = symbols[sym].dates;
        if (Array.isArray(d) && d.length) { lastDate = d[d.length - 1]; break; }
    }

    return {
        success: true,
        periods,
        market,
        industries,
        meta: {
            symbolCount: market.total,
            lastDate,
            window: (data.meta && data.meta.window) || 0,
            note: 'Tenkan/Kijun breadth dùng proxy highest-close/lowest-close (file chỉ có closes). ' +
                  'Cho 1 mã riêng, dùng /api/ichimoku/:symbol (high/low thật).'
        }
    };
}

/**
 * Lọc breadth chỉ cho 1 ngành (giảm payload cho UI khi user chọn ngành cụ thể).
 */
function computeIchimokuBreadthForIndustry(industryCode, periods) {
    const full = computeIchimokuBreadth({ periods });
    const ind = full.industries[industryCode];
    return {
        success: !!ind,
        industryCode,
        industryName: ICB2_MAP[industryCode] || industryCode,
        periods,
        data: ind || null,
        market: full.market, // luôn kèm market để UI so sánh
        meta: full.meta
    };
}

/**
 * Build map {SYMBOL: icb2Code} từ danh sách quotes của all-stocks.
 * @param {Array} quotes [{Symbol, IndustryCode}, ...] — output của /api/all-stocks
 * @param {Object} override INDUSTRY_OVERRIDE map (mã FireAnt phân loại sai)
 * @returns {Object} {SYMBOL: '8300', ...}
 */
function buildSymbolIcb2Map(quotes, override = {}) {
    const map = {};
    // Chấp nhận: array HOẶC object {HSX:[],HNX:[],UPCOM:[]}
    let list = [];
    if (Array.isArray(quotes)) list = quotes;
    else if (quotes && typeof quotes === 'object') {
        // all-stocks trả {HSX:[...], HNX:[...], UPCOM:[...]} → gộp
        list = Object.values(quotes).flat();
    }
    for (const q of list) {
        if (!q) continue;
        // Field tên linh hoạt: Symbol/symbol, IndustryCode/industryCode
        const sym = q.Symbol || q.symbol;
        if (!sym) continue;
        const ic = q.IndustryCode || q.industryCode || '';
        map[sym] = override[sym] || (ic.substring(0, 2) + '00');
    }
    return map;
}

module.exports = {
    computeIchimokuBreadth,
    computeIchimokuBreadthForIndustry,
    tenkanOfCloses,
    buildSymbolIcb2Map,
    ICB2_MAP,
    DEFAULT_PERIODS,
    CLOSE_FILE
};
