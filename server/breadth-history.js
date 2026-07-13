/**
 * MA BREADTH HISTORY MODULE
 * ─────────────────────────────────────────────────────────────────────────
 * Tính & lưu số lượng CP trên MA10/20/50/100/200 theo ngày, gom theo
 * Toàn thị trường (market) và 18 ngành ICB2.
 *
 * THIẾT KẾ (xem docs/superpowers/specs/2026-07-13-ma-breadth-design.md):
 *   - Foreground (mở web) CHỈ đọc file cache → < 100ms.
 *   - Background: buildHistory() (full lần đầu) và buildToday() (incremental).
 *   - 2 file cache:
 *       data/ma-breadth-history.json  — snapshot breadth theo ngày (~500KB)
 *       data/ma-breadth-close.json    — chuỗi close ~620 ngày/mã (~10MB) để
 *                                       rolling update chính xác (Cách A).
 *
 * NGUỒN MA:
 *   - MA10/MA20 (ngày mới): dùng sẵn AvgPrice10d/20d từ TradingStatistic.
 *   - MA10/20/50/100/200 (quá khứ + MA50/100/200 mọi lúc): tự tính từ
 *     chuỗi close (FireAnt HistoricalQuotes) bằng prefix-sum O(1).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ═══════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'ma-breadth-history.json');
const CLOSE_FILE = path.join(DATA_DIR, 'ma-breadth-close.json');

const MAX_HISTORY_DAYS = 550;   // giữ tối đa ~1.5 năm snapshot
const MAX_CLOSE_WINDOW = 620;   // đủ cho MA200 + history window 370 ngày
const MA_PERIODS = [10, 20, 50, 100, 200];

// 18 ngành ICB2 (đồng bộ với /api/industry-stats trong server.js)
const ICB2_MAP = {
    '0500': 'Dầu khí',
    '1300': 'Hóa chất',
    '1700': 'Tài nguyên cơ bản',
    '2300': 'Xây dựng và VLXD',
    '2700': 'Sản phẩm & DV công nghiệp',
    '3300': 'Ôtô và linh kiện',
    '3500': 'Thực phẩm và đồ uống',
    '3700': 'Hàng tiêu dùng',
    '4500': 'Y tế',
    '5300': 'Bán lẻ',
    '5500': 'Truyền thông',
    '5700': 'Du lịch và giải trí',
    '6500': 'Viễn thông',
    '7500': 'Các dịch vụ hạ tầng',
    '8300': 'Ngân hàng',
    '8500': 'Bảo hiểm',
    '8600': 'Bất động sản',
    '8700': 'Dịch vụ tài chính',
    '8900': 'Quỹ',
    '9500': 'Công nghệ'
};

// FireAnt headers (public, không cần cookie cho HistoricalQuotes)
const FA_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};

// Lock để tránh concurrent build
let _building = false;

// ═══════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS (export cho unit test)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Tính SMA (simple moving average) cho chuỗi close bằng prefix-sum (O(1)/phần tử).
 * @param {number[]} closes chuỗi close, cũ→mới
 * @param {number} n kỳ MA
 * @returns {(number|null)[]} mảng cùng độ dài, null nếu chưa đủ n ngày
 */
function computeMAWithPrefix(closes, n) {
    const len = closes.length;
    const ma = new Array(len).fill(null);
    if (len === 0 || n <= 0 || n > len) return ma;

    // prefix[i] = closes[0] + ... + closes[i-1]; prefix[0] = 0
    const prefix = new Array(len + 1);
    prefix[0] = 0;
    for (let i = 0; i < len; i++) prefix[i + 1] = prefix[i] + closes[i];

    // MA_n tại index i (i >= n-1) = (prefix[i+1] - prefix[i+1-n]) / n
    for (let i = n - 1; i < len; i++) {
        ma[i] = (prefix[i + 1] - prefix[i + 1 - n]) / n;
    }
    return ma;
}

/**
 * Đếm số CP trên từng MA cho 1 ngày, gom theo market + industries.
 * @param {Array} stocks [{symbol, icb2, close, ma10, ma20, ma50, ma100, ma200}]
 *                        ma_n có thể null (chưa đủ dữ liệu) → bỏ qua
 * @param {Object} icb2Map tùy chọn: map code→name (mặc định ICB2_MAP)
 * @returns {{market:Object, industries:Object}}
 */
function countAboveMAForDate(stocks, icb2Map = ICB2_MAP) {
    const market = { ma10: 0, ma20: 0, ma50: 0, ma100: 0, ma200: 0, total: 0 };
    const industries = {};

    for (const s of stocks) {
        const close = s.close;
        if (!close || close <= 0) continue; // skip mã không giao dịch

        market.total++;
        for (const n of MA_PERIODS) {
            const ma = s['ma' + n];
            if (ma != null && ma > 0 && close > ma) market['ma' + n]++;
        }

        const code = s.icb2;
        if (!code || !icb2Map[code]) continue; // skip mã không có ngành hợp lệ (phần ngành)
        if (!industries[code]) {
            industries[code] = { name: icb2Map[code], ma10: 0, ma20: 0, ma50: 0, ma100: 0, ma200: 0, total: 0 };
        }
        industries[code].total++;
        for (const n of MA_PERIODS) {
            const ma = s['ma' + n];
            if (ma != null && ma > 0 && close > ma) industries[code]['ma' + n]++;
        }
    }
    return { market, industries };
}

/**
 * Trích chuỗi thời gian của 1 scope (market hoặc 1 industry code) từ history.
 * @param {Object} history object {date: {market, industries, vnindex?}} (sorted keys)
 * @param {string} scope 'market' hoặc ICB2 code
 * @returns {Array} [{date, ma10, ma20, ma50, ma100, ma200, total, vnindex?}]
 */
function aggregateByIndustry(history, scope) {
    const dates = Object.keys(history).sort();
    const series = [];
    for (const date of dates) {
        const snap = history[date];
        const rec = scope === 'market'
            ? snap.market
            : (snap.industries && snap.industries[scope]);
        if (!rec) continue;
        const point = {
            date,
            ma10: rec.ma10, ma20: rec.ma20, ma50: rec.ma50,
            ma100: rec.ma100, ma200: rec.ma200, total: rec.total
        };
        // Thêm VNINDEX close nếu snapshot có (cho overlay dual-axis)
        if (snap.vnindex != null) point.vnindex = snap.vnindex;
        series.push(point);
    }
    return series;
}

/**
 * Lọc series theo khoảng ngày inclusive. null = không giới hạn.
 */
function filterSeriesByDateRange(series, fromDate, toDate) {
    return series.filter(s => {
        if (fromDate && s.date < fromDate) return false;
        if (toDate && s.date > toDate) return false;
        return true;
    });
}

/**
 * Clamp khoảng ngày vào boundary thực, tự hoán đổi nếu from > to.
 */
function clampDateRange(fromDate, toDate, minDate, maxDate) {
    let from = fromDate || minDate;
    let to = toDate || maxDate;
    if (from > to) { const t = from; from = to; to = t; }
    if (minDate && from < minDate) from = minDate;
    if (maxDate && to > maxDate) to = maxDate;
    return { fromDate: from, toDate: to };
}

// ═══════════════════════════════════════════════════════════════════════
// FILE I/O
// ═══════════════════════════════════════════════════════════════════════

function _vnTodayKey() {
    const now = new Date(Date.now() + 7 * 3600 * 1000);
    return now.toISOString().split('T')[0];
}

function _formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function _loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.error(`[BreadthHistory] load ${path.basename(file)} error:`, e.message);
        return fallback;
    }
}

function _saveJSON(file, data) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data), 'utf8');
        return true;
    } catch (e) {
        console.error(`[BreadthHistory] save ${path.basename(file)} error:`, e.message);
        return false;
    }
}

function _loadHistory() {
    return _loadJSON(HISTORY_FILE, { meta: { version: 1 }, history: {} });
}

function _loadClose() {
    return _loadJSON(CLOSE_FILE, { meta: { window: MAX_CLOSE_WINDOW }, symbols: {} });
}

function _trimHistory(history) {
    const keys = Object.keys(history.history).sort();
    if (keys.length > MAX_HISTORY_DAYS) {
        const toRemove = keys.slice(0, keys.length - MAX_HISTORY_DAYS);
        toRemove.forEach(k => delete history.history[k]);
    }
}

/**
 * Trim mỗi symbol trong close cache giữ MAX_CLOSE_WINDOW ngày gần nhất.
 */
function _trimClose(closeData) {
    const win = MAX_CLOSE_WINDOW;
    for (const sym of Object.keys(closeData.symbols)) {
        const s = closeData.symbols[sym];
        if (!s || !s.dates) continue;
        if (s.dates.length > win) {
            s.dates = s.dates.slice(-win);
            s.closes = s.closes.slice(-win);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC READ API (foreground — đọc file, rất nhanh)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Lấy chuỗi MA breadth theo scope + khoảng ngày.
 * @param {Object} opts { scope, industryCode, fromDate, toDate, days }
 * @returns {{success, scope, industryCode?, industryName?, meta, series}}
 */
function getBreadth({ scope = 'market', industryCode = null, fromDate = null, toDate = null, days = 0 } = {}) {
    const data = _loadHistory();
    const history = data.history || {};
    const dates = Object.keys(history).sort();

    if (dates.length === 0) {
        return { success: false, needBuild: true, error: 'no-data' };
    }

    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];

    // Chọn scope thực
    const realScope = scope === 'industry' ? (industryCode || 'market') : 'market';

    // Lấy full series của scope
    let series = aggregateByIndustry(history, realScope);

    // Nếu days > 0: lấy N ngày gần nhất (mutually exclusive với fromDate/toDate)
    if (days && days > 0) {
        series = series.slice(-days);
    } else {
        // Clamp theo fromDate/toDate
        const clamped = clampDateRange(fromDate, toDate, firstDate, lastDate);
        series = filterSeriesByDateRange(series, clamped.fromDate, clamped.toDate);
    }

    const industryName = realScope !== 'market' && series.length > 0
        ? (ICB2_MAP[realScope] || data.history[series[0].date].industries[realScope]?.name)
        : (realScope !== 'market' ? (ICB2_MAP[realScope] || industryCode) : 'Toàn Thị Trường');

    const lastRec = series.length > 0 ? series[series.length - 1] : null;

    return {
        success: true,
        scope: realScope === 'market' ? 'market' : 'industry',
        industryCode: realScope === 'market' ? null : realScope,
        industryName,
        meta: {
            lastUpdated: data.meta && data.meta.lastUpdated ? data.meta.lastUpdated : lastDate,
            historyDays: dates.length,
            firstDate,
            lastDate,
            total: lastRec ? lastRec.total : 0,
            // echo lại range thực trả
            fromDate: series.length > 0 ? series[0].date : fromDate,
            toDate: series.length > 0 ? series[series.length - 1].date : toDate
        },
        series
    };
}

/**
 * Metadata tóm tắt cho UI.
 */
function getMeta() {
    const data = _loadHistory();
    const dates = Object.keys(data.history || {}).sort();
    if (dates.length === 0) {
        return { exists: false, lastUpdated: null, historyDays: 0, needBuild: true };
    }
    return {
        exists: true,
        lastUpdated: (data.meta && data.meta.lastUpdated) || dates[dates.length - 1],
        historyDays: dates.length,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        symbolsTracked: (data.meta && data.meta.symbolsTracked) || 0
    };
}

/**
 * Đã có snapshot cho ngày hôm nay chưa?
 */
function hasToday() {
    const data = _loadHistory();
    return Boolean((data.history || {})[_vnTodayKey()]);
}

// ═══════════════════════════════════════════════════════════════════════
// FETCH DATA (FireAnt)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Lấy danh sách symbol + icb2 từ Quotes (gộp batch).
 * @param {Function} fetchFn dependency injection (truyền fetchAPI của server.js)
 * @param {string} cookie FireAnt cookie cho Quotes
 * @returns {Promise<Array>} [{symbol, icb2, priceCurrent}]
 */
async function fetchAllSymbols(fetchFn, cookie) {
    // Dùng lại danh sách batch từ server.js — include để đồng bộ
    const batches = require('./breadth-symbols');
    const authHeaders = cookie
        ? { ...FA_HEADERS, Cookie: cookie }
        : FA_HEADERS;
    const results = [];
    // 5 batch song song
    for (let i = 0; i < batches.length; i += 5) {
        const chunk = batches.slice(i, i + 5);
        const proms = chunk.map(symbols =>
            fetchFn(`https://www.fireant.vn/api/Data/Markets/Quotes?symbols=${symbols}`, authHeaders).catch(() => [])
        );
        const responses = await Promise.all(proms);
        responses.forEach(arr => {
            if (Array.isArray(arr)) {
                arr.forEach(q => {
                    if (!q || !q.Symbol) return;
                    const icb2 = (q.IndustryCode || '').substring(0, 2) + '00';
                    results.push({
                        symbol: q.Symbol,
                        icb2,
                        priceCurrent: q.PriceCurrent || 0
                    });
                });
            }
        });
    }
    return results;
}

/**
 * Fetch HistoricalQuotes cho 1 symbol.
 * @param {string} symbol
 * @param {number} days số ngày cần fetch
 * @param {string} cookie tùy chọn
 * @returns {Promise<Array>} [{date, close}] cũ→mới
 */
async function fetchHistory(symbol, days, cookie) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}`
        + `&startDate=${_formatDate(start)}&endDate=${_formatDate(end)}`;
    const headers = cookie ? { ...FA_HEADERS, Cookie: cookie } : FA_HEADERS;
    try {
        const res = await axios.get(url, { headers, timeout: 10000 });
        const raw = res.data;
        if (!Array.isArray(raw) || !raw.length) return [];
        const data = raw.map(it => ({
            date: (it.Date || it.date || '').split('T')[0],
            close: it.Close || it.PriceClose || it.close || 0
        })).filter(d => d.close > 0 && d.date);
        data.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        return data;
    } catch (e) {
        return [];
    }
}

/**
 * Fetch giá close VNINDEX theo ngày (cho overlay dual-axis).
 * Dùng HistoricalQuotes với symbol=VNINDEX (endpoint công khai, không cần cookie).
 * @param {number} days số ngày cần fetch
 * @returns {Promise<Object>} map {date: close}
 */
async function fetchVNIndexHistory(days) {
    const data = await fetchHistory('VNINDEX', days, '');
    const map = {};
    for (const d of data) {
        if (d.date && d.close > 0) map[d.date] = d.close;
    }
    return map;
}

/**
 * Tính breadth cho 1 ngày T từ closeCache của tất cả symbol.
 * @param {Object} closeCache {symbol: {dates:[], closes:[]}}
 * @param {Object} symMeta {symbol: {icb2}} industry map
 * @param {string} date ngày 'YYYY-MM-DD'
 * @returns {{market, industries} | null} null nếu không có close cho ngày này
 */
function computeBreadthForDate(closeCache, symMeta, date) {
    const stocks = [];
    for (const sym of Object.keys(closeCache)) {
        const rec = closeCache[sym];
        if (!rec || !rec.dates || !rec.closes) continue;
        // Tìm index của date (dùng binary search hoặc last match)
        const idx = rec.dates.indexOf(date);
        if (idx < 0) continue;
        const close = rec.closes[idx];
        if (!close || close <= 0) continue;

        // Tính 5 MA tại idx bằng prefix-sum local
        const closes = rec.closes;
        const ma = {};
        for (const n of MA_PERIODS) {
            if (idx + 1 < n) { ma['ma' + n] = null; continue; }
            let sum = 0;
            for (let k = idx + 1 - n; k <= idx; k++) sum += closes[k];
            ma['ma' + n] = sum / n;
        }
        stocks.push({
            symbol: sym,
            icb2: (symMeta[sym] && symMeta[sym].icb2) || null,
            close,
            ...ma
        });
    }
    if (stocks.length === 0) return null;
    return countAboveMAForDate(stocks);
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC BUILD API (background)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full build: fetch HistoricalQuotes cho tất cả symbol, tính breadth toàn window.
 * @param {Object} deps { fetchFn, getCookie, onProgress }  (inject từ server)
 * @param {number} windowDays số ngày snapshot cần build (mặc định 370)
 * @returns {Promise<{ok, days, symbolsTracked, lastDate}>}
 */
async function buildHistory({ fetchFn, getCookie, onProgress } = {}, windowDays = 370) {
    if (_building) throw new Error('Build đang chạy. Vui lòng đợi.');
    _building = true;
    try {
        const cookie = getCookie ? await getCookie() : '';

        // 1. Lấy danh sách symbol + icb2
        onProgress && onProgress({ phase: 'symbols', msg: 'Đang lấy danh sách mã...' });
        const allSyms = await fetchAllSymbols(fetchFn || _defaultFetchFn, cookie);
        const symMeta = {};
        allSyms.forEach(s => { symMeta[s.symbol] = { icb2: s.icb2 }; });

        const symbols = Object.keys(symMeta);
        onProgress && onProgress({ phase: 'history', msg: `Đang tải lịch sử giá ${symbols.length} mã...`, done: 0, total: symbols.length });

        // 2. Fetch HistoricalQuotes (windowDays + 200 buffer cho MA200)
        const fetchDays = windowDays + 200 + 50;
        const closeData = _loadClose();
        const BATCH = 25;
        let done = 0;
        for (let i = 0; i < symbols.length; i += BATCH) {
            const chunk = symbols.slice(i, i + BATCH);
            const proms = chunk.map(sym => fetchHistory(sym, fetchDays, cookie));
            const results = await Promise.all(proms);
            chunk.forEach((sym, j) => {
                if (results[j] && results[j].length > 0) {
                    closeData.symbols[sym] = {
                        dates: results[j].map(d => d.date),
                        closes: results[j].map(d => d.close)
                    };
                }
            });
            done += chunk.length;
            onProgress && onProgress({ phase: 'history', msg: `Đang tải lịch sử giá... ${done}/${symbols.length}`, done, total: symbols.length });
        }
        _trimClose(closeData);
        _saveJSON(CLOSE_FILE, closeData);

        // 3. Tính breadth cho từng ngày trong window
        onProgress && onProgress({ phase: 'compute', msg: 'Đang tính MA breadth...' });
        const allDates = new Set();
        for (const sym of Object.keys(closeData.symbols)) {
            const rec = closeData.symbols[sym];
            if (rec && rec.dates) rec.dates.forEach(d => allDates.add(d));
        }
        let dateList = [...allDates].sort();
        // Chỉ giữ windowDays ngày gần nhất
        if (dateList.length > windowDays) dateList = dateList.slice(-windowDays);

        // Fetch giá VNINDEX 1 lần để gắn vào mỗi snapshot (overlay dual-axis)
        const vnindexMap = await fetchVNIndexHistory(fetchDays);

        const history = _loadHistory();
        if (!history.history) history.history = {};
        for (const date of dateList) {
            const snap = computeBreadthForDate(closeData.symbols, symMeta, date);
            if (snap) {
                if (vnindexMap[date]) snap.vnindex = vnindexMap[date];
                history.history[date] = snap;
            }
        }
        _trimHistory(history);
        history.meta = {
            version: 1,
            lastUpdated: _vnTodayKey(),
            symbolsTracked: Object.keys(closeData.symbols).length,
            historyDays: Object.keys(history.history).length,
            firstDate: dateList[0],
            lastDate: dateList[dateList.length - 1]
        };
        _saveJSON(HISTORY_FILE, history);

        onProgress && onProgress({ phase: 'done', msg: `Hoàn tất: ${history.meta.historyDays} ngày, ${history.meta.symbolsTracked} mã` });
        return { ok: true, days: history.meta.historyDays, symbolsTracked: history.meta.symbolsTracked, lastDate: history.meta.lastDate };
    } finally {
        _building = false;
    }
}

/**
 * Incremental build: tính breadth cho ngày mới nhất (Quotes gộp + closeCache).
 * @param {Object} deps { fetchFn, getCookie } inject từ server
 * @returns {Promise<{ok, date, market, industries, already?}>}
 */
async function buildToday({ fetchFn, getCookie } = {}) {
    if (_building) throw new Error('Build đang chạy. Vui lòng đợi.');
    const today = _vnTodayKey();

    // Nếu đã có snapshot hôm nay → trả luôn
    const existing = _loadHistory();
    if (existing.history && existing.history[today]) {
        return { ok: true, already: true, date: today, market: existing.history[today].market, industries: existing.history[today].industries };
    }

    _building = true;
    try {
        const cookie = getCookie ? await getCookie() : '';

        // 1. Lấy close mới nhất + icb2 qua Quotes (gộp batch)
        const allSyms = await fetchAllSymbols(fetchFn || _defaultFetchFn, cookie);
        const symMeta = {};
        const priceMap = {};
        allSyms.forEach(s => {
            symMeta[s.symbol] = { icb2: s.icb2 };
            if (s.priceCurrent > 0) priceMap[s.symbol] = s.priceCurrent;
        });

        // 2. Append close mới vào closeCache
        const closeData = _loadClose();
        for (const sym of Object.keys(symMeta)) {
            const price = priceMap[sym];
            if (!price) continue;
            if (!closeData.symbols[sym]) {
                closeData.symbols[sym] = { dates: [], closes: [] };
            }
            const rec = closeData.symbols[sym];
            const lastDate = rec.dates[rec.dates.length - 1];
            if (lastDate === today) {
                // đã có → update giá
                rec.closes[rec.closes.length - 1] = price;
            } else if (!lastDate || lastDate < today) {
                rec.dates.push(today);
                rec.closes.push(price);
            }
        }
        _trimClose(closeData);
        _saveJSON(CLOSE_FILE, closeData);

        // 3. Tính breadth cho ngày hôm nay
        const snap = computeBreadthForDate(closeData.symbols, symMeta, today);
        if (!snap) {
            return { ok: false, error: 'Không có dữ liệu giá cho ngày hôm nay (có thể chưa có giao dịch).' };
        }

        // 3b. Lấy giá VNINDEX hôm nay (cho overlay dual-axis)
        const vnindexToday = await fetchVNIndexHistory(5);
        if (vnindexToday[today] != null) snap.vnindex = vnindexToday[today];

        // 4. Append vào history
        const history = existing;
        if (!history.history) history.history = {};
        history.history[today] = snap;
        _trimHistory(history);
        const dates = Object.keys(history.history).sort();
        history.meta = {
            version: 1,
            lastUpdated: today,
            symbolsTracked: Object.keys(closeData.symbols).length,
            historyDays: dates.length,
            firstDate: dates[0],
            lastDate: dates[dates.length - 1]
        };
        _saveJSON(HISTORY_FILE, history);

        return { ok: true, date: today, market: snap.market, industries: snap.industries };
    } finally {
        _building = false;
    }
}

// Fallback fetchFn nếu không inject (dùng axios trực tiếp)
async function _defaultFetchFn(url, headers) {
    try {
        const res = await axios.get(url, { headers, timeout: 15000 });
        return res.data;
    } catch (e) {
        return [];
    }
}

module.exports = {
    // pure functions (test)
    computeMAWithPrefix,
    countAboveMAForDate,
    aggregateByIndustry,
    filterSeriesByDateRange,
    clampDateRange,
    computeBreadthForDate,
    // config
    ICB2_MAP,
    MA_PERIODS,
    // read API
    getBreadth,
    getMeta,
    hasToday,
    // build API
    buildHistory,
    buildToday
};
