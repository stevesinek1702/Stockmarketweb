/**
 * VN STOCK MARKET - BACKEND SERVER
 * Node.js Express server để proxy API requests và bypass CORS
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cookieParser = require('cookie-parser');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const { scanPotential, getCachedSignals } = require('./potential-scanner');
const fiintrade = require('./fiintrade');
const aiModule = require('./ai');
const breadthHistory = require('./breadth-history');
const { authenticate } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes (credentials để cookie httpOnly hoạt động cross-origin nếu cần)
app.use(cors({ origin: true, credentials: true }));

// Parse JSON + cookies
app.use(express.json());
app.use(cookieParser());

// Auth middleware: đọc cookie → gắn req.user (không chặn — endpoint tự quyết).
// Phải nằm TRƯỚC các route /api để mọi handler đều có req.user.
app.use(authenticate);

// Phase: chặn /register.html khi REGISTER_ENABLED !== 'true' (mặc định tắt).
// Phải nằm TRƯỚC express.static để override static catch-all.
// Chỉ admin tạo account qua /admin.html — phù hợp use case nội bộ.
app.get('/register.html', (req, res) => {
    if (process.env.REGISTER_ENABLED !== 'true') {
        return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Đăng ký đã tắt</title>
<link rel="stylesheet" href="/css/style.css"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Space+Grotesk:wght@600&display=swap" rel="stylesheet"></head>
<body class="auth-page"><div class="auth-card">
<div class="auth-logo"><div class="logo-icon">🔒</div><div class="logo-text" style="font-size:1.3rem;">Đăng ký đã bị khóa</div></div>
<div class="auth-error show">Tính năng đăng ký hiện đã tắt. Vui lòng liên hệ quản trị viên để được cấp tài khoản.</div>
<div class="auth-link"><a href="/login.html">← Về trang đăng nhập</a></div>
</div></body></html>`);
    }
    res.sendFile(path.join(__dirname, '..', 'register.html'));
});

// Serve static files from parent directory
app.use(express.static(path.join(__dirname, '..')));

// API Configuration
const API_CONFIG = {
    fireant: {
        base: 'https://www.fireant.vn/api/Data',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        }
    },

    fitrade: {
        base: 'https://apigw.fitrade.vn/pbapi/api',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        }
    },
    sstock: {
        base: 'https://api-feature.sstock.vn/api/v1',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        }
    }
};

// Utility function to make API requests
async function fetchAPI(url, headers = {}) {
    // Đếm API call tới FireAnt (chỉ khi URL chứa fireant.vn)
    const { apiCounter } = require('./cache');
    if (url.includes('fireant.vn')) apiCounter.bump('fireant').catch(() => {});
    try {
        const response = await axios.get(url, {
            headers: {
                ...headers,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });
        return response.data;
    } catch (error) {
        console.error(`API Error: ${url}`, error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════
// LỰC CẦU (Demand Strength) — Value-weighted + Liquidity Filter
// ═══════════════════════════════════════════════════════════════════
// VẤN ĐỀ cũ: lucCau = TotalActiveBuyVolume / TotalVolume × 100 (theo SỐ CP)
//   → mã penny 100 CP × 7.600đ = 760K VND nhưng vẫn count 100% lực cầu
//   → mã không giao dịch (vol=0) bị gán 0% hoặc 50% giả định → tạo nhiễu
//   → mẫu số phình ở ngành nhiều mã (BDS 125, SPDV CN 236, Hạ tầng 155)
//
// GIẢI PHÁP: tính theo GIÁ TRỊ (VND) + lọc thanh khoản + lọc nhiễu
//   lucCau = activeBuyValue / totalValue × 100
//   activeBuyValue = TotalActiveBuyVolume × PriceAverage (giá TB khớp lệnh)
//   Loại mã nếu:
//     - TotalValue < LIQUIDITY_MIN_VALUE (100 triệu VND) — rác/dorman
//     - TotalVolume < LIQUIDITY_MIN_VOLUME (30k CP) — quá ít lô, nhiễu
//     - lucCau > LUC_CAU_MAX (80%) — outlier, 1 lệnh mua trúng ceiling → nhiễu
// ═══════════════════════════════════════════════════════════════════
const LIQUIDITY_MIN_VALUE = 100_000_000; // 100 triệu VND — ngưỡng GTGD tối thiểu
const LIQUIDITY_MIN_VOLUME = 30_000;     // 30k CP — ngưỡng volume tối thiểu (mã dưới 30k CP = rác)
const LUC_CAU_MAX = 80;                  // 80% — lucCau > 80 = outlier, loại (1 lệnh trúng ceiling)

/**
 * Kiểm tra 1 quote có đủ điều kiện thanh khoản để tính lucCau không.
 * Trả về true nếu ĐỦ (đưa vào calculation), false nếu bị loại (nhiễu).
 */
function isLiquidEnough(quote) {
    const tv = quote.TotalValue || quote.totalValue || 0;
    const vol = quote.TotalVolume || quote.totalVolume || 0;
    return tv >= LIQUIDITY_MIN_VALUE && vol >= LIQUIDITY_MIN_VOLUME;
}

/**
 * Tính lực cầu cho 1 quote theo GIÁ TRỊ (VND).
 * @param {Object} quote - FireAnt quote object (có TotalValue, TotalActiveBuyVolume, PriceAverage)
 * @returns {number|null} lucCau (0-100, 1 số lẻ) hoặc null nếu không đủ thanh khoản
 */
function computeLucCauByValue(quote) {
    // Mã không đủ thanh khoản → loại khỏi calculation, trả null
    if (!isLiquidEnough(quote)) return null;
    const totalValue = quote.TotalValue || quote.totalValue || 0;
    const activeBuyValue = (quote.TotalActiveBuyVolume || 0) * (quote.PriceAverage || 0);
    if (totalValue <= 0) return null;
    const lc = Math.round((activeBuyValue / totalValue) * 1000) / 10; // 1 số lẻ
    // lucCau > 80% = outlier (1 lệnh mua trúng ceiling) → loại, trả null
    return lc > LUC_CAU_MAX ? null : lc;
}

/**
 * Tổng hợp lucCau value-weighted cho 1 nhóm (ngành / cap-group).
 * Sum(activeBuyValue) / Sum(totalValue) — dòng tiền lớn có weight đúng.
 * Loại mã nhiễu: vol<30k, value<100tr, lucCau>80%.
 * @param {Array} quotes - mảng FireAnt quote thuộc nhóm
 * @returns {{lucCau:number|null, liquidCount:number, filteredCount:number}}
 */
function aggregateLucCauByValue(quotes) {
    let sumBuyValue = 0, sumTotalValue = 0, liquidCount = 0, filteredCount = 0;
    quotes.forEach(q => {
        if (!isLiquidEnough(q)) { filteredCount++; return; }
        const lc = computeLucCauByValue(q);
        if (lc === null) { filteredCount++; return; } // lucCau > 80% hoặc lỗi → loại
        const tv = q.TotalValue || q.totalValue || 0;
        sumBuyValue += (q.TotalActiveBuyVolume || 0) * (q.PriceAverage || 0);
        sumTotalValue += tv;
        liquidCount++;
    });
    if (liquidCount === 0 || sumTotalValue === 0) {
        return { lucCau: null, liquidCount: 0, filteredCount };
    }
    return {
        lucCau: Math.round((sumBuyValue / sumTotalValue) * 1000) / 10,
        liquidCount,
        filteredCount
    };
}

// Cookie cache for FireAnt API
let fireAntCookieCache = { cookie: '', fetchedAt: 0 };

// In-process cache MA50/100/200 map (rebuild 1h) cho /api/all-stocks
let maMapCache = { time: 0, map: {} };

/**
 * Fetch FireAnt cookie from Google Sheets (reuse logic from /api/all-stocks)
 */
async function getFireAntCookie() {
    // Cache 10 minutes
    if (fireAntCookieCache.cookie && Date.now() - fireAntCookieCache.fetchedAt < 600000) {
        return fireAntCookieCache.cookie;
    }

    try {
        const xlsx = require('xlsx');
        const cookieSheetUrl = `https://docs.google.com/spreadsheets/d/e/2PACX-1vQSIlfpp-orc4QSu-TOusAwsBc--AEIFLLQd9uELBuxg_c50a-2VjHEmRoOnP66VJRa-3W6O-t1JeTN/pub?output=xlsx&_t=${Date.now()}`;

        const cookieResponse = await axios.get(cookieSheetUrl, { responseType: 'arraybuffer', timeout: 15000 });
        const workbook = xlsx.read(cookieResponse.data, { type: 'buffer' });
        const dashboardSheet = workbook.Sheets['Dashboard'];

        if (dashboardSheet) {
            const keys = Object.keys(dashboardSheet).filter(k => !k.startsWith('!'));
            for (const key of keys) {
                const val = String(dashboardSheet[key].v || '');
                if (val.includes('FireAnt.Authentication')) {
                    fireAntCookieCache = { cookie: val, fetchedAt: Date.now() };
                    console.log('🍪 Cookie cached:', val.substring(0, 50) + '...');
                    return val;
                }
            }
        }
    } catch (e) {
        console.log('⚠️ Could not fetch cookie:', e.message);
    }
    return '';
}

// ==========================================
// RESPONSE CACHE UTILITY
// ==========================================
// Cache layer: Redis (hot) + Postgres (cold) — xem server/cache.js.
// Thay cho in-memory Map cũ: cache giờ bền vững khi restart + share giữa các process,
// giúp giảm external API call tới FireAnt/Fiintrade khi multi-user.
const { getCached, setCached: _setCached, getStale } = require('./cache');

// TTL mặc định theo cache key (millisecond). Key động match theo prefix.
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
    'news': 120000,
    'ai-report': 24 * 3600 * 1000  // 24h — AI report 1 lần/ngày đủ (data thị trường EOD)
};

// EOD keys: data chỉ đổi 1 lần/ngày (cuối phiên) → cache 24h, không TTL cố định.
// Prefix match. Scheduler sẽ refresh 15-22h VN (xem scheduler.js).
const EOD_KEYS = [
    'industry-flow',
    'investor-flow',
    'foreign-flow',
    'investor-detail',
    'industry-stats',
    'top-net-stocks'
];
// Subset EOD keys có toDate/date trong response → validate toDate trước khi trả cache.
// Khi toDate trong cache < hôm nay (VN) → coi như miss → fetch data mới.
// Tránh serve data hôm qua cho ngày hôm nay (lúc đầu ngày khi Fiintrade chưa update).
const EOD_KEYS_WITH_DATE = ['industry-flow', 'investor-flow', 'foreign-flow', 'investor-detail', 'stock-investor-flow'];
function isEODKey(key) {
    return EOD_KEYS.some(k => key === k || key.startsWith(k + ':') || key.startsWith(k));
}
function shouldValidateToDate(key) {
    return EOD_KEYS_WITH_DATE.some(k => key === k || key.startsWith(k + ':'));
}

function ttlForKey(key) {
    if (CACHE_TTL_MS[key]) return CACHE_TTL_MS[key];
    for (const prefix of Object.keys(CACHE_TTL_MS)) {
        if (key.startsWith(prefix)) return CACHE_TTL_MS[prefix];
    }
    return 60000;
}

// Wrappers async — caller PHẢI await (giữ tên cũ để ít đổi call site).
// EOD keys dùng smart-cache 24h (key đổi theo ngày) thay vì TTL cố định.
// EOD keys có toDate (investor-flow, foreign-flow, ...) validate toDate: nếu cache chứa
// data ngày cũ → miss → endpoint fetch data mới (tránh serve stale data cho ngày hôm nay).
const { getCachedEOD, setCachedEOD } = require('./cache');
async function getCachedResponse(key, ttlMs) {
    if (isEODKey(key)) {
        return getCachedEOD(key, { validateToDate: shouldValidateToDate(key) });
    }
    return getCached(key, ttlMs);
}
async function setCachedResponse(key, data) {
    if (isEODKey(key)) {
        // EOD key có toDate: nếu data fetch về vẫn là ngày hôm qua (Fiintrade chưa update
        // cho hôm nay, vd trước 15h VN) → cache TTL ngắn (15 phút) để retry sớm.
        // Khi toDate = hôm nay → cache 24h (data ổn định cả ngày).
        if (shouldValidateToDate(key)) {
            const toDate = data.toDate || (data.today && data.today.date) || null;
            const today = require('./cache').vnToday();
            if (toDate && String(toDate).slice(0, 10) !== today) {
                console.log(`⏳ [cache-eod] ${key}: toDate ${toDate} ≠ today ${today} → cache TTL ngắn 15 phút (đợi Fiintrade update)`);
                return setCachedEOD(key, data, 15 * 60 * 1000);
            }
        }
        return setCachedEOD(key, data);
    }
    return _setCached(key, data, ttlForKey(key));
}
async function getStaleResponse(key) {
    return getStale(key);
}

// ==========================================
// FIREANT API ENDPOINTS
// ==========================================

// ── Phase 3: Auth routes (public: register/login/logout; me requires login) ─
const { requireAuth } = require('./auth');
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
// ── Phase 4: User data (watchlist + portfolio + presets per-user, requireAuth) ─
app.use('/api/user', require('./routes/user'));

// ── Health check (public, không cần auth) ────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ── Protect tất cả /api/* còn lại — yêu cầu login ────────────────────────
// App là private (admin duyệt tài khoản), nên mọi data endpoint đều cần auth.
// allowlist: /api/auth/*, /api/admin/*, /api/health (đã mount ở trên, requireAuth riêng).
app.use('/api', (req, res, next) => {
    // Bỏ qua các path đã có route riêng (auth/admin/health)
    if (req.path.startsWith('/auth/') || req.path.startsWith('/admin/') || req.path === '/health') {
        return next();
    }
    return requireAuth(req, res, next);
});

/**
 * GET /api/quotes
 * Lấy bảng giá cổ phiếu
 * Query params: symbols (comma-separated)
 */
app.get('/api/quotes', async (req, res) => {
    try {
        const symbols = req.query.symbols || 'VNM,VHM,VIC,HPG,TCB,VCB,BID,CTG,MBB,VPB,FPT,MWG,MSN,GAS,PLX';
        const url = `${API_CONFIG.fireant.base}/Markets/Quotes?symbols=${symbols}`;
        const data = await fetchAPI(url, API_CONFIG.fireant.headers);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/market-stats
 * Lấy thống kê thị trường intraday
 * Query params: symbol (HOSTC, VN30, HNX)
 */
app.get('/api/market-stats', async (req, res) => {
    const symbol = req.query.symbol || 'HOSTC';
    const cacheKey = `market-stats:${symbol}`;
    // Cache tươi 20s: giảm tải FireAnt + phản hồi nhanh khi nhiều widget cùng gọi.
    const fresh = await getCachedResponse(cacheKey, 20000);
    if (fresh) return res.json(fresh);
    try {
        const url = `${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=${symbol}`;
        const data = await fetchAPI(url, API_CONFIG.fireant.headers);
        await setCachedResponse(cacheKey, data);
        res.json(data);
    } catch (error) {
        // Fallback: trả cache gần nhất (dù cũ) để card chỉ số không bị trống vì FireAnt chập chờn.
        const stale = await getStaleResponse(cacheKey);
        if (stale) {
            console.warn(`⚠️ market-stats ${symbol}: FireAnt lỗi, trả cache cũ (${error.message})`);
            return res.json(stale);
        }
        // Chưa từng có cache: trả 200 kèm {error} — frontend tự fallback mock, không phát sinh lỗi 500 trên console.
        console.error(`market-stats ${symbol} lỗi, chưa có cache:`, error.message);
        res.json({ error: error.message, symbol });
    }
});

/**
 * GET /api/market-dashboard
 * Lấy dữ liệu Dashboard tổng hợp: VNINDEX + VN30
 * Bao gồm: Index, TotalValue, TotalVolume, Advances, Declines, Lực cầu
 */
app.get('/api/market-dashboard', async (req, res) => {
    try {
        console.log('📊 Fetching market dashboard data...');

        // Fetch VNINDEX and VN30 in parallel
        const [vnindexRes, vn30Res] = await Promise.all([
            axios.get(`${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=HOSTC`, {
                headers: API_CONFIG.fireant.headers,
                timeout: 10000
            }),
            axios.get(`${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=VN30`, {
                headers: API_CONFIG.fireant.headers,
                timeout: 10000
            })
        ]);

        // Get latest data point (last item in array)
        const vnindexData = vnindexRes.data[vnindexRes.data.length - 1] || {};
        const vn30Data = vn30Res.data[vn30Res.data.length - 1] || {};

        // Calculate Lực cầu (Demand Strength) = ActiveBuyVolume / (ActiveBuyVolume + ActiveSellVolume) * 100
        const calcDemandStrength = (activeBuy, activeSell) => {
            const totalActive = (activeBuy || 0) + (activeSell || 0);
            return totalActive > 0 ? ((activeBuy || 0) / totalActive * 100).toFixed(1) : 50;
        };

        // Get historical data for previous close (fetch last 7 days to cover weekends/holidays)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const startDateStr = sevenDaysAgo.toISOString().split('T')[0];
        const todayStr = new Date().toISOString().split('T')[0];

        const [vnindexHistRes, vn30HistRes] = await Promise.all([
            axios.get(`${API_CONFIG.fireant.base}/Markets/HistoricalQuotes?symbol=VNINDEX&startDate=${startDateStr}&endDate=${todayStr}`, {
                headers: API_CONFIG.fireant.headers,
                timeout: 10000
            }).catch(() => ({ data: [] })),
            axios.get(`${API_CONFIG.fireant.base}/Markets/HistoricalQuotes?symbol=VN30&startDate=${startDateStr}&endDate=${todayStr}`, {
                headers: API_CONFIG.fireant.headers,
                timeout: 10000
            }).catch(() => ({ data: [] }))
        ]);

        // Historical data response has .value array, sorted oldest first
        const vnindexHistArr = vnindexHistRes.data?.value || vnindexHistRes.data || [];
        const vn30HistArr = vn30HistRes.data?.value || vn30HistRes.data || [];

        // Previous close = second to last item
        const vnindexPrevData = vnindexHistArr.length > 1 ? vnindexHistArr[vnindexHistArr.length - 2] : null;
        const vn30PrevData = vn30HistArr.length > 1 ? vn30HistArr[vn30HistArr.length - 2] : null;
        const vnindexPrevClose = vnindexPrevData?.Close || null;
        const vn30PrevClose = vn30PrevData?.Close || null;

        // Current session data
        const vnindexTotalValue = Math.round((vnindexData.TotalValue || 0) / 1e9);
        const vnindexTotalVolume = Math.round((vnindexData.TotalVolume || 0) / 1e6);
        const vn30TotalValue = Math.round((vn30Data.TotalValue || 0) / 1e9);
        const vn30TotalVolume = Math.round((vn30Data.TotalVolume || 0) / 1e6);

        // ── Load stored daily stats for previous session fallback ──
        const statsFile = path.join(__dirname, 'data', 'daily-stats.json');
        let storedStats = {};
        try {
            if (fs.existsSync(statsFile)) {
                storedStats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
            }
        } catch (e) {
            console.warn('⚠️ Could not read daily-stats.json:', e.message);
        }

        // Determine previous session date from historical data
        const prevDate = vnindexPrevData?.Date?.split('T')[0] || null;

        // Get previous session KLGD/GTGD: prefer stored data, fallback to historical estimate
        let vnindexPrevVol = null;
        let vnindexPrevVal = null;
        let vn30PrevVol = null;
        let vn30PrevVal = null;

        if (prevDate && storedStats[prevDate]) {
            // Use stored data (accurate)
            vnindexPrevVol = storedStats[prevDate].vnindex?.volume || null;
            vnindexPrevVal = storedStats[prevDate].vnindex?.value || null;
            vn30PrevVol = storedStats[prevDate].vn30?.volume || null;
            vn30PrevVal = storedStats[prevDate].vn30?.value || null;
        }

        // Fallback: estimate from historical data (Volume × Close)
        if (!vnindexPrevVol && vnindexPrevData) {
            vnindexPrevVol = Math.round((vnindexPrevData.Volume || 0) / 1e6);
        }
        if (!vnindexPrevVal && vnindexPrevData) {
            vnindexPrevVal = Math.round((vnindexPrevData.Volume || 0) * (vnindexPrevData.Close || 0) / 1e9);
        }
        if (!vn30PrevVol && vn30PrevData) {
            vn30PrevVol = Math.round((vn30PrevData.Volume || 0) / 1e6);
        }
        if (!vn30PrevVal && vn30PrevData) {
            vn30PrevVal = Math.round((vn30PrevData.Volume || 0) * (vn30PrevData.Close || 0) / 1e9);
        }

        // ── Save current session data for future use ──
        const todayDate = todayStr;
        storedStats[todayDate] = {
            vnindex: { volume: vnindexTotalVolume, value: vnindexTotalValue },
            vn30: { volume: vn30TotalVolume, value: vn30TotalValue }
        };

        // Keep only last 7 days to avoid bloat
        const dates = Object.keys(storedStats).sort();
        while (dates.length > 7) {
            delete storedStats[dates.shift()];
        }

        try {
            if (!fs.existsSync(path.join(__dirname, 'data'))) {
                fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
            }
            fs.writeFileSync(statsFile, JSON.stringify(storedStats, null, 2));
        } catch (e) {
            console.warn('⚠️ Could not write daily-stats.json:', e.message);
        }

        const result = {
            vnindex: {
                indexCurrent: vnindexData.IndexCurrent || 0,
                prevClose: vnindexPrevClose,
                change: vnindexPrevClose ? (vnindexData.IndexCurrent - vnindexPrevClose).toFixed(2) : null,
                percentChange: vnindexPrevClose ? ((vnindexData.IndexCurrent - vnindexPrevClose) / vnindexPrevClose * 100).toFixed(2) : null,
                totalValue: vnindexTotalValue,
                totalVolume: vnindexTotalVolume,
                prevTotalValue: vnindexPrevVal,
                prevTotalVolume: vnindexPrevVol,
                advances: vnindexData.Advances || 0,
                declines: vnindexData.Declines || 0,
                unchanged: vnindexData.Unchange || 0,
                demandStrength: calcDemandStrength(vnindexData.TotalActiveBuyVolume, vnindexData.TotalActiveSellVolume)
            },
            vn30: {
                indexCurrent: vn30Data.IndexCurrent || 0,
                prevClose: vn30PrevClose,
                change: vn30PrevClose ? (vn30Data.IndexCurrent - vn30PrevClose).toFixed(2) : null,
                percentChange: vn30PrevClose ? ((vn30Data.IndexCurrent - vn30PrevClose) / vn30PrevClose * 100).toFixed(2) : null,
                totalValue: vn30TotalValue,
                totalVolume: vn30TotalVolume,
                prevTotalValue: vn30PrevVal,
                prevTotalVolume: vn30PrevVol,
                advances: vn30Data.Advances || 0,
                declines: vn30Data.Declines || 0,
                unchanged: vn30Data.Unchange || 0,
                demandStrength: calcDemandStrength(vn30Data.TotalActiveBuyVolume, vn30Data.TotalActiveSellVolume)
            },
            timestamp: new Date().toISOString()
        };

        console.log(`✅ Dashboard: VNINDEX=${result.vnindex.indexCurrent}, VN30=${result.vn30.indexCurrent}`);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Market dashboard error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/influential-stocks
 * Mã tác động tích cực/tiêu cực tới VNINDEX.
 *
 * Nguồn cũ Fialda (fwtapi2.fialda.com) đã chết (timeout 07/2026). Chuyển sang tính
 * từ FireAnt: contribution điểm index của từng mã =
 *   (vốn hóa mã / tổng vốn hóa HOSE) × (% thay đổi / 100) × giá trị VNINDEX.
 * Tổng contribution của các mã ≈ biến động điểm VNINDEX phiên đó.
 *
 * Dùng TradingStatistic (SharesOutStanding, LastPriceClose, AvgPrice10d) +
 * Quotes (PriceCurrent, PricePercentChange) — cùng nguồn đã dùng cho marketcap.
 * Giá trị VNINDEX lấy từ IntradayMarketStatistic (field IndexCurrent).
 */
app.get('/api/influential-stocks', async (req, res) => {
    // Cache 60 seconds
    const cached = await getCachedResponse('influential-stocks', 60000);
    if (cached) {
        console.log('📊 Returning cached influential-stocks data');
        return res.json(cached);
    }
    try {
        console.log('📊 Calculating influential stocks from FireAnt...');

        const cookie = await getFireAntCookie();
        const authHeaders = {
            ...API_CONFIG.fireant.headers,
            'Cookie': cookie,
            'Accept-Encoding': 'gzip, deflate',
            'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
        };

        const tradingUrl = `${API_CONFIG.fireant.base}/Markets/TradingStatistic`;
        const quotesUrl = `${API_CONFIG.fireant.base}/Markets/Quotes`;

        const intradayUrl = `${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=HOSTC`;
        const [tradingData, _, vnindexSeries] = await Promise.all([
            fetchAPI(tradingUrl, authHeaders).catch(() => []),
            Promise.resolve(),
            fetchAPI(intradayUrl, authHeaders).catch(() => [])
        ]);

        if (!Array.isArray(tradingData) || !tradingData.length) {
            return res.status(500).json({ success: false, error: 'No trading data from FireAnt' });
        }

        // Giá trị VNINDEX hiện tại (điểm) — dùng làm base để scale contribution về "điểm index".
        // Lấy point cuối của IntradayMarketStatistic (latest), fallback 1900 nếu fetch lỗi.
        const vnindexValue = (Array.isArray(vnindexSeries) && vnindexSeries.length &&
            vnindexSeries[vnindexSeries.length - 1].IndexCurrent) || 1900;

        // Fetch quotes cho tất cả mã (batch) để có PricePercentChange real-time
        const allSymbols = tradingData.filter(s => s.Symbol && s.Symbol.length === 3).map(s => s.Symbol);
        const batches = require('./breadth-symbols');
        const quoteMap = {};
        for (let i = 0; i < batches.length; i += 5) {
            const chunk = batches.slice(i, i + 5);
            const proms = chunk.map(s => fetchAPI(`${quotesUrl}?symbols=${s}`, authHeaders).catch(() => []));
            const responses = await Promise.all(proms);
            responses.forEach(arr => {
                if (Array.isArray(arr)) arr.forEach(q => { if (q && q.Symbol) quoteMap[q.Symbol] = q; });
            });
        }

        // Tính contribution điểm index: contribution_i = (marketCap_i / totalMarketCap)
        // × (pctChange_i / 100) × vnindexValue. Tổng các contribution của mã tăng −
        // mã giảm ≈ biến động điểm VNINDEX phiên đó. Đơn vị: điểm VNINDEX (~1900).
        const stocks = [];
        let totalMarketCap = 0;
        tradingData.forEach(stock => {
            if (!stock.Symbol || stock.Symbol.length !== 3) return;
            const quote = quoteMap[stock.Symbol] || {};
            const priceCurrent = quote.PriceCurrent || stock.LastPriceClose || 0;
            const shares = stock.SharesOutStanding || 0;
            const marketCap = priceCurrent * shares;
            if (marketCap <= 0) return;
            totalMarketCap += marketCap;
            stocks.push({
                symbol: stock.Symbol,
                marketCap,
                priceCurrent,
                shares,
                pctChange: quote.PricePercentChange ? quote.PricePercentChange * 100 : 0
            });
        });

        if (totalMarketCap <= 0) {
            return res.status(500).json({ success: false, error: 'Cannot compute total market cap' });
        }

        // Vòng 2: normalize về điểm index contribution.
        const resultStocks = stocks.map(s => {
            const impact = (s.marketCap / totalMarketCap) * (s.pctChange / 100) * vnindexValue;
            return {
                symbol: s.symbol,
                marketCap: Math.round(s.marketCap / 1e12 * 10) / 10,  // nghìn tỷ
                percentChange: Math.round(s.pctChange * 100) / 100,
                impact: Math.round(impact * 100) / 100
            };
        });

        // Sort theo impact giảm dần → top positive (đầu) + top negative (cuối)
        resultStocks.sort((a, b) => b.impact - a.impact);
        const positive = resultStocks.filter(s => s.impact > 0).slice(0, 10);
        const negative = resultStocks.filter(s => s.impact < 0).slice(-10).reverse();

        console.log(`✅ Influential stocks: ${positive.length} positive, ${negative.length} negative (from ${resultStocks.length} stocks, VNINDEX=${vnindexValue}, totalMCap=${(totalMarketCap/1e12).toFixed(0)}nghìn tỷ)`);

        const responseData = {
            success: true,
            source: 'fireant',
            data: {
                positive: positive.map(s => ({
                    symbol: s.symbol,
                    value: s.impact,
                    percent: s.percentChange,
                    marketCap: s.marketCap
                })),
                negative: negative.map(s => ({
                    symbol: s.symbol,
                    value: s.impact,
                    percent: s.percentChange,
                    marketCap: s.marketCap
                }))
            },
            timestamp: new Date().toISOString()
        };
        await setCachedResponse('influential-stocks', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Influential stocks error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/historical
 * Lấy dữ liệu lịch sử
 * Query params: symbol, startDate, endDate
 */
app.get('/api/historical', async (req, res) => {
    try {
        const { symbol = 'VNINDEX', startDate, endDate } = req.query;

        // Default: 30 days ago to today
        const end = endDate || new Date().toISOString().split('T')[0];
        const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const url = `${API_CONFIG.fireant.base}/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${start}&endDate=${end}`;
        const data = await fetchAPI(url, API_CONFIG.fireant.headers);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading-stats
 * Lấy thống kê giao dịch
 * Query params: symbol
 */
app.get('/api/trading-stats', async (req, res) => {
    try {
        const symbol = req.query.symbol || 'HOSTC';
        const url = `${API_CONFIG.fireant.base}/Markets/TradingStatistic?symbol=${symbol}`;
        const data = await fetchAPI(url, API_CONFIG.fireant.headers);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/intraday-quotes
 * Lấy dữ liệu intraday cho một mã
 * Query params: symbol
 */
app.get('/api/intraday-quotes', async (req, res) => {
    try {
        const symbol = req.query.symbol || 'VNM';
        const url = `${API_CONFIG.fireant.base}/Markets/IntradayQuotes?symbol=${symbol}`;
        const data = await fetchAPI(url, API_CONFIG.fireant.headers);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/market-breadth
 * Lấy độ rộng thị trường thực (Advances, Declines, Unchange)
 * Trả về dữ liệu cho HOSTC, VN30 và HNX
 */
app.get('/api/market-breadth', async (req, res) => {
    // Cache 30 seconds
    const cached = await getCachedResponse('market-breadth', 30000);
    if (cached) {
        console.log('📊 Returning cached market-breadth data');
        return res.json(cached);
    }
    try {
        console.log('📊 Fetching market breadth data...');

        const symbols = ['HOSTC', 'VN30', 'HNX'];
        const results = {};

        for (const symbol of symbols) {
            const url = `${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=${symbol}`;
            try {
                const data = await fetchAPI(url, API_CONFIG.fireant.headers);
                // API trả về array, lấy phần tử cuối cùng (mới nhất)
                const latest = Array.isArray(data) ? data[data.length - 1] : data;

                results[symbol.toLowerCase()] = {
                    indexCurrent: latest?.IndexCurrent || 0,
                    advances: latest?.Advances || 0,
                    declines: latest?.Declines || 0,
                    unchanged: latest?.Unchange || 0,
                    totalVolume: latest?.TotalVolume || 0,
                    totalValue: latest?.TotalValue || 0,
                    buyForeignValue: latest?.BuyForeignValue || 0,
                    sellForeignValue: latest?.SellForeignValue || 0,
                    totalActiveBuyVolume: latest?.TotalActiveBuyVolume || 0,
                    totalActiveSellVolume: latest?.TotalActiveSellVolume || 0,
                    totalPositiveValue: latest?.TotalPositiveValue || 0,
                    totalNegativeValue: latest?.TotalNegativeValue || 0,
                    totalNeutralValue: latest?.TotalNeutralValue || 0
                };
            } catch (e) {
                console.error(`Error fetching ${symbol}:`, e.message);
                results[symbol.toLowerCase()] = null;
            }
        }

        console.log('✅ Market breadth fetched successfully');
        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            data: results
        };
        await setCachedResponse('market-breadth', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Market breadth error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/all-stocks
 * Lấy bảng giá TẤT CẢ cổ phiếu trên sàn HOSE (700+ mã)
 * Để tính độ rộng chính xác và hiển thị top tăng/giảm
 */
app.get('/api/all-stocks', async (req, res) => {
    // Cache 60 seconds - very heavy endpoint (20 batch calls)
    const cached = await getCachedResponse('all-stocks', 60000);
    if (cached) {
        console.log('📈 Returning cached all-stocks data');
        return res.json(cached);
    }
    try {
        console.log('📈 Fetching all stocks data...');

        // Danh sách 700+ mã cổ phiếu chia thành nhiều batch
        const batch1 = 'A32,AAA,AAM,AAS,AAT,AAV,ABB,ABC,ABI,ABR,ABS,ABT,ACB,ACC,ACE,ACG,ACL,ACM,ACS,ACV,ADC,ADG,ADP,ADS,AFX,AG1,AGE,AGF,AGG,AGM,AGP,AGR,AGX,AIC,ALT,ALV,AMC,AMD,AME,AMP,AMS,AMV,ANT,ANV,APC,APF,APG,APH,API,APL,APP,APS,APT,ARM,ART,ASA,ASG,ASM,ASP,AST,ATA,ATB,ATG,ATS,AUM,AVC,AVF';
        const batch2 = 'BAB,BAF,BAL,BAX,BBC,BBH,BBM,BBS,BBT,BCA,BCB,BCC,BCE,BCF,BCG,BCM,BCP,BCV,BDB,BDG,BDT,BDW,BED,BEL,BFC,BGW,BHA,BHC,BHG,BHK,BHN,BHP,BHT,BIC,BID,BIG,BII,BIO,BKC,BKG,BKH,BLF,BLI,BLN,BLT,BLW,BMC,BMD,BMF,BMG,BMI,BMJ,BMN,BMP,BMS,BMV,BNA,BNW,BOT,BPC,BQB,BRC,BRR,BRS,BSA,BSC,BSD,BSG,BSH,BSI,BSL,BSP,BSQ,BSR,BST';
        const batch3 = 'BT1,BT6,BTB,BTD,BTG,BTH,BTN,BTP,BTS,BTT,BTU,BTV,BTW,BVB,BVG,BVH,BVL,BVN,BVS,BWA,BWE,BWS,BXH,C12,C21,C22,C32,C47,C4G,C69,C92,CAB,CAD,CAG,CAN,CAP,CAR,CAT,CAV,CBI,CBS,CC1,CC4,CCA,CCI,CCL,CCM,CCP,CCR,CCT,CCV,CDC,CDG,CDH,CDN,CDO,CDP,CDR,CE1,CEG,CEN,CEO,CET,CFM,CFV,CGV,CH5,CHC,CHP,CHS';
        const batch4 = 'CI5,CIA,CID,CIG,CII,CIP,CJC,CKA,CKD,CKG,CKV,CLC,CLG,CLH,CLL,CLM,CLW,CLX,CMC,CMD,CMF,CMG,CMI,CMK,CMM,CMN,CMP,CMS,CMT,CMV,CMW,CMX,CNA,CNC,CNG,CNN,CNT,COM,CPA,CPC,CPH,CPI,CQN,CQT,CRC,CRE,CSC,CSI,CSM,CST,CSV,CT3,CT6,CTA,CTB,CTC,CTD,CTF,CTG,CTI,CTN,CTP,CTR,CTS,CTT,CTW,CTX,CVN,CVP,CVT';
        const batch5 = 'D11,D2D,DAC,DAD,DAE,DAG,DAH,DAN,DAS,DAT,DBC,DBD,DBM,DBT,DBW,DC1,DC2,DC4,DCF,DCG,DCH,DCL,DCM,DCR,DCS,DCT,DDG,DDH,DDM,DDN,DDV,DFC,DFF,DGC,DGT,DGW,DHA,DHB,DHC,DHD,DHG,DHM,DHN,DHP,DHT,DIC,DID,DIG,DIH,DKC,DL1,DLD,DLG,DLR,DLT,DM7,DMC,DMN,DNA,DNC,DND,DNE,DNH,DNL,DNM,DNN,DNP,DNT,DNW';
        const batch6 = 'DOC,DOP,DP1,DP2,DP3,DPC,DPD,DPG,DPH,DPM,DPP,DPR,DPS,DQC,DRC,DRG,DRH,DRI,DRL,DS3,DSC,DSD,DSG,DSN,DSP,DST,DSV,DTA,DTB,DTC,DTD,DTE,DTG,DTH,DTI,DTK,DTL,DTP,DTT,DTV,DUS,DVC,DVG,DVM,DVN,DVP,DVW,DWC,DWS,DXG,DXL,DXP,DXS,DXV,DZM,E12,E29,EBS,ECI,EFI,EIB,EIC,EID,EIN,ELC,EMC,EME,EMG,EMS,EPC,EPH,EVE,EVF,EVG,EVS';
        const batch7 = 'FBA,FBC,FCC,FCM,FCN,FCS,FDC,FGL,FHN,FHS,FIC,FID,FIR,FIT,FLC,FMC,FOC,FOX,FPT,FRC,FRM,FRT,FSO,FT1,FTI,FTM,FTS,G20,G36,GAB,GAS,GCB,GCF,GDT,GDW,GE2,GEE,GEG,GER,GEX,GGG,GH3,GHC,GIC,GIL,GKM,GLC,GLT,GLW,GMA,GMC,GMD,GMH,GMX,GND,GSM,GSP,GTA,GTD,GTH,GTS,GTT,GVR,GVT,H11,HAC,HAD,HAF,HAG,HAH,HAI';
        const batch8 = 'HAM,HAN,HAP,HAR,HAS,HAT,HAV,HAX,HBC,HBD,HBH,HBS,HC1,HC3,HCB,HCC,HCD,HCI,HCM,HCT,HD2,HD6,HD8,HDA,HDB,HDC,HDG,HDM,HDO,HDP,HDW,HEC,HEJ,HEM,HEP,HES,HEV,HFB,HFC,HFX,HGM,HGT,HGW,HHC,HHG,HHN,HHP,HHR,HHS,HHV,HID,HIG,HII,HJC,HJS,HKB,HKP,HKT,HLA,HLB,HLC,HLD,HLG,HLR,HLS,HLT,HLY,HMC,HMG,HMH,HMR,HMS';
        const batch9 = 'HNA,HNB,HND,HNF,HNG,HNI,HNM,HNP,HNR,HOM,HOT,HPB,HPD,HPG,HPH,HPI,HPM,HPP,HPT,HPW,HPX,HQC,HRB,HRC,HRT,HSA,HSG,HSI,HSL,HSM,HSP,HSV,HT1,HTC,HTE,HTG,HTI,HTL,HTM,HTN,HTP,HTR,HTT,HTV,HTW,HU1,HU3,HU4,HU6,HUB,HUG,HUT,HVA,HVG,HVH,HVN,HVT,HVX,HWS,IBC,IBD,ICC,ICF,ICG,ICI,ICN,ICT,IDC,IDI,IDJ,IDP,IDV,IFS,IHK,IJC';
        const batch10 = 'ILA,ILB,ILC,ILS,IME,IMP,IN4,INC,INN,IPA,IRC,ISG,ISH,IST,ITA,ITC,ITD,ITQ,ITS,IVS,JOS,JVC,KAC,KBC,KCB,KCE,KDC,KDH,KDM,KGM,KHA,KHD,KHG,KHL,KHP,KHS,KHW,KIP,KKC,KLB,KLF,KLM,KMR,KMT,KOS,KPF,KSB,KSD,KSF,KSH,KSQ,KST,KSV,KTC,KTL,KTS,KTT,KVC,L10,L12,L14,L18,L35,L40,L43,L44,L45,L61,L62,L63,LAF,LAI,LAS,LAW,LBC,LBE,LBM';
        const batch11 = 'LCC,LCD,LCG,LCM,LCS,LCW,LDG,LDP,LDW,LEC,LG9,LGC,LGL,LGM,LHC,LHG,LIC,LIG,LIX,LKW,LLM,LM3,LM7,LM8,LMC,LMH,LMI,LNC,LO5,LPB,LPT,LQN,LSG,LSS,LTC,LTG,LUT,LWS,M10,MA1,MAC,MAS,MBB,MBG,MBN,MBS,MCC,MCD,MCF,MCG,MCH,MCI,MCM,MCO,MCP,MDA,MDC,MDF,MDG,MEC,MED,MEF,MEL,MES,MFS,MGC,MGG,MGR,MH3,MHC,MHL,MIC,MIE,MIG,MIM,MKP,MKV,MLC,MLS';
        const batch12 = 'MML,MNB,MND,MPC,MPT,MPY,MQB,MQN,MRF,MSB,MSH,MSN,MSR,MST,MTA,MTB,MTC,MTG,MTH,MTL,MTP,MTS,MTV,MVB,MVC,MVN,MWG,NAB,NAC,NAF,NAG,NAP,NAS,NAU,NAV,NAW,NBB,NBC,NBE,NBP,NBT,NBW,NCS,NCT,ND2,NDC,NDF,NDN,NDP,NDT,NDW,NDX,NED,NET,NFC,NGC,NHA,NHC,NHH,NHP,NHT,NHV,NJC,NKG,NLG,NLS,NNC,NNG,NNT,NO1,NOS,NQB,NQN,NQT,NRC,NS2,NSC,NSG,NSH,NSL,NSS,NST,NT2';
        const batch13 = 'NTB,NTC,NTF,NTH,NTL,NTP,NTT,NTW,NUE,NVB,NVL,NVP,NVT,NWT,NXT,OCB,OCH,ODE,OGC,OIL,ONE,ONW,OPC,ORS,PAC,PAI,PAN,PAP,PAS,PAT,PBC,PBP,PBT,PC1,PCC,PCE,PCF,PCG,PCH,PCM,PCN,PCT,PDB,PDC,PDN,PDR,PDV,PEC,PEG,PEN,PEQ,PET,PFL,PGB,PGC,PGD,PGI,PGN,PGS,PGT,PGV,PHC,PHH,PHN,PHP,PHR,PHS,PIA,PIC,PID,PIS,PIT,PIV,PJC,PJS,PJT,PLA,PLC,PLE,PLO,PLP,PLX';
        const batch14 = 'PMB,PMC,PMG,PMJ,PMP,PMS,PMT,PMW,PNC,PND,PNG,PNJ,PNP,PNT,POB,POM,POS,POT,POV,POW,PPC,PPE,PPH,PPI,PPP,PPS,PPT,PPY,PQN,PRC,PRE,PRO,PRT,PSB,PSC,PSD,PSE,PSG,PSH,PSI,PSL,PSN,PSP,PSW,PTB,PTC,PTD,PTE,PTG,PTH,PTI,PTL,PTN,PTO,PTP,PTS,PTT,PTV,PTX,PV2,PVA,PVB,PVC,PVD,PVE,PVG,PVH,PVI,PVL,PVM,PVO,PVP,PVR,PVS,PVT,PVV,PVX,PVY,PWA,PWS,PX1,PXA,PXC,PXI,PXL,PXM,PXS,PXT';
        const batch15 = 'QBS,QCC,QCG,QHD,QHW,QLT,QNC,QNS,QNT,QNU,QNW,QPH,QSP,QST,QTC,QTP,RAL,RAT,RBC,RCC,RCD,RCL,RDP,REE,RGC,RIC,RTB,S12,S27,S4A,S55,S72,S74,S96,S99,SAB,SAC,SAF,SAL,SAM,SAP,SAS,SAV,SB1,SBA,SBD,SBH,SBL,SBM,SBR,SBS,SBT,SBV,SC5,SCC,SCD,SCG,SCI,SCJ,SCL,SCO,SCR,SCS,SCY,SD1,SD2,SD3,SD4,SD5,SD6,SD7,SD8,SD9,SDA,SDB,SDC,SDD,SDG,SDJ,SDK,SDN,SDP,SDT,SDU,SDV,SDX,SDY,SEA,SEB,SED,SEP,SFC,SFG,SFI,SFN';
        const batch16 = 'SGB,SGC,SGD,SGH,SGI,SGN,SGO,SGP,SGR,SGS,SGT,SHA,SHB,SHC,SHE,SHG,SHI,SHN,SHP,SHS,SHX,SIC,SID,SIG,SII,SIP,SIV,SJ1,SJC,SJD,SJE,SJF,SJG,SJM,SJS,SKG,SKH,SKN,SKV,SLS,SMA,SMB,SMC,SMN,SMT,SNC,SNZ,SP2,SPB,SPC,SPD,SPH,SPI,SPM,SPP,SPV,SQC,SRA,SRB,SRC,SRF,SRT,SSB,SSC,SSF,SSG,SSH,SSI,SSM,SSN,ST8,STB,STC,STG,STH,STK,STL,STP,STS,STT,STW,SVC,SVD,SVG,SVH,SVI,SVN,SVT,SWC,SZB,SZC,SZE,SZG,SZL';
        const batch17 = 'TA3,TA6,TA9,TAG,TAN,TAR,TAW,TB8,TBC,TBD,TBH,TBR,TBT,TBX,TC6,TCB,TCD,TCH,TCI,TCJ,TCK,TCL,TCM,TCO,TCR,TCT,TCW,TCX,TDB,TDC,TDF,TDG,TDH,TDM,TDN,TDP,TDS,TDT,TDW,TED,TEG,TEL,TET,TFC,TGG,TGP,TH1,THB,THD,THG,THI,THN,THP,THS,THT,THU,THW,TID,TIE,TIG,TIN,TIP,TIS,TIX,TJC,TKA,TKC,TKG,TKU,TL4,TLD,TLG,TLH,TLI,TLP,TLT,TMB,TMC,TMG,TMP,TMS,TMT,TMW,TMX,TN1,TNA,TNB,TNC,TNG,TNH,TNI,TNM,TNP,TNS,TNT,TNW,TOP,TOS,TOT,TOW,TPB,TPC,TPH,TPP,TPS';
        const batch18 = 'TQN,TQW,TR1,TRA,TRC,TRS,TRT,TS3,TS4,TSB,TSC,TSD,TSG,TSJ,TST,TTA,TTB,TTC,TTD,TTE,TTF,TTG,TTH,TTL,TTN,TTP,TTS,TTT,TTZ,TUG,TV1,TV2,TV3,TV4,TV6,TVA,TVB,TVC,TVD,TVG,TVH,TVM,TVN,TVP,TVS,TVT,TVW,TW3,TXM,TYA,UCT,UDC,UDJ,UDL,UEM,UIC,UMC,UNI,UPC,UPH,USC,USD,V11,V12,V15,V21,VAB,VAF,VAT,VAV,VBB,VBC,VBG,VBH,VC1,VC2,VC3,VC5,VC6,VC7,VC9,VCA,VCK,VCB,VCC,VCE,VCF,VCG,VCI,VCM,VCP,VCR,VCS,VCT,VCW,VCX,VDB,VDL,VDN,VDP,VDS,VDT';
        const batch19 = 'VE1,VE2,VE3,VE4,VE8,VE9,VEA,VEC,VEF,VES,VET,VFC,VFG,VFR,VFS,VGC,VGG,VGI,VGL,VGP,VGR,VGS,VGT,VGV,VHC,VHD,VHE,VHF,VHG,VHH,VHL,VHM,VIB,VIC,VID,VIE,VIF,VIG,VIH,VIM,VIN,VIP,VIR,VIT,VIW,VIX,VJC,VKC,VKP,VLA,VLB,VLC,VLF,VLG,VLP,VLW,VMA,VMC,VMD,VMG,VMS,VNA,VNB,VNC,VND,VNE,VNF,VNG,VNH,VNI,VNL,VNM,VNP,VNR,VNS,VNT,VNX,VNY,VOC,VOS,VPA,VPB,VPC,VPD,VPG,VPH,VPI,VPL,VPR,VPS,VPW,VQC,VRC,VRE,VRG,VSA,VSC,VSE,VSF,VSG,VSH,VSI,VSM,VSN,VST';
        const batch20 = 'VTA,VTB,VTC,VTD,VTE,VTG,VTH,VTI,VTJ,VTK,VTL,VTM,VTO,VTP,VTQ,VTR,VTS,VTV,VTX,VTZ,VUA,VVN,VVS,VW3,VWS,VXB,VXP,VXT,WCS,WSB,WSS,WTC,X20,X26,X77,XDC,XDH,XHC,XLV,XMC,XMD,XMP,XPH,YBC,YBM,YEG,YTC';

        const batches = [batch1, batch2, batch3, batch4, batch5, batch6, batch7, batch8, batch9, batch10, batch11, batch12, batch13, batch14, batch15, batch16, batch17, batch18, batch19, batch20];

        let allStocks = [];

        for (const symbols of batches) {
            try {
                const url = `${API_CONFIG.fireant.base}/Markets/Quotes?symbols=${symbols}`;
                const data = await fetchAPI(url, API_CONFIG.fireant.headers);
                if (Array.isArray(data)) {
                    allStocks = allStocks.concat(data);
                }
            } catch (e) {
                console.error('Batch fetch error:', e.message);
            }
        }

        // Fetch TradingStatistic để lấy AvgVolume45d - cần đúng 4 headers từ Excel M code
        let tradingStatsMap = {};
        try {
            // Sử dụng cookie đã cache
            const cookieValue = await getFireAntCookie();

            const tradingUrl = `${API_CONFIG.fireant.base}/Markets/TradingStatistic`;
            // Sử dụng 4 headers giống Excel M code: Accept-Encoding, Accept-Language, Cookie, User-Agent
            const tradingData = await fetchAPI(tradingUrl, {
                'Accept-Encoding': 'gzip, deflate',
                'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
                'Cookie': cookieValue,
                'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36'
            });

            // Debug log
            console.log('📊 TradingStatistic response type:', typeof tradingData, Array.isArray(tradingData) ? `Array[${tradingData.length}]` : '');

            if (Array.isArray(tradingData) && tradingData.length > 0) {
                // Log sample fields from first item
                console.log('📊 Sample fields:', Object.keys(tradingData[0]).slice(0, 10).join(', '));

                tradingData.forEach(item => {
                    if (item.Symbol) {
                        tradingStatsMap[item.Symbol] = {
                            avgVolume: item.AvgVolume45d || item.AvgVol45 || item.AvgVolume || 0,
                            avgVolume10: item.AvgVolume10d || item.AvgVol10 || 0,
                            // MA values (Average Price)
                            ma10: item.AvgPrice10d || 0,
                            ma20: item.AvgPrice20d || 0,
                            ma45: item.AvgPrice45d || 0
                        };
                    }
                });
                console.log(`📊 Loaded TradingStatistic: ${Object.keys(tradingStatsMap).length} stocks`);
                // Debug: log sample avgVolume values
                const sampleSymbols = ['VNM', 'FPT', 'HPG', 'VHM'].filter(s => tradingStatsMap[s]);
                sampleSymbols.forEach(s => console.log(`  ${s}: avgVol45d=${tradingStatsMap[s].avgVolume}, MA10=${tradingStatsMap[s].ma10}`));
            } else {
                console.log('⚠️ TradingStatistic returned no data or unexpected format:', typeof tradingData);
            }
        } catch (e) {
            console.error('TradingStatistic fetch error:', e.message);
        }

        // Helper function to format price: chia 1000, bỏ trailing zeros
        const formatPrice = (price) => {
            if (price === null || price === undefined) return null;
            return parseFloat((price / 1000).toFixed(2)); // MA usually needs more precision, maybe 2 decimals for MA? Standard price is 1 decimal usually for stocks > 10. Let's stick to 2 to be safe or 1 if standard.
            // User current code uses toFixed(1). Let's use toFixed(2) for MA to show more detail or keep consistency.
            // Standard Vietnamese stock prices are usually x.x or x.xx.
            // Let's keep formatPrice as is for standard fields, create formatMA if needed.
            // Actually existing formatPrice does (price/1000).toFixed(1).
        };

        const formatMA = (price) => {
            if (price === null || price === undefined) return null;
            return parseFloat((price / 1000).toFixed(2));
        };

        // ── Build MA50/100/200 map 1 lần (cache in-process 1h) ──
        // Đọc file close cache 1 lần cho toàn bộ symbol (hiệu năng cao).
        let maMap = {};
        if (!maMapCache.time || Date.now() - maMapCache.time > 3600000) {
            try {
                const { buildMAMap } = require('./breadth-history');
                const allSyms = (Array.isArray(allStocks) ? allStocks : []).map(s => s.Symbol).filter(Boolean);
                const tmp = buildMAMap(allSyms, [50, 100, 200]);
                maMapCache = { time: Date.now(), map: tmp };
                console.log(`📈 MA50/100/200 loaded for ${Object.keys(tmp).length} symbols`);
            } catch (e) {
                console.warn('⚠️ MA map build fail:', e.message);
            }
        }
        maMap = maMapCache.map || {};

        // ── Build MACD/RSI signal map từ potential-signals cache ──
        const macdRsiMap = {};
        try {
            const { getCachedSignals } = require('./potential-scanner');
            const sigs = getCachedSignals();
            if (sigs && Array.isArray(sigs.macdRsiSignals)) {
                sigs.macdRsiSignals.forEach(sg => {
                    macdRsiMap[sg.symbol] = {
                        macdRsiSignal: sg.signalType, // 'BUY' | 'SELL'
                        macdRsiIndicator: sg.indicator, // 'MACD' | 'RSI' | 'BOTH'
                        rsi: sg.rsi || null,
                        macdHist: sg.histogram || null
                    };
                });
            }
        } catch (e) { /* potential-scanner chưa sẵn sàng */ }

        // Helper to transform stock data với volRatio
        const transformStock = (s) => {
            const stats = tradingStatsMap[s.Symbol] || {};
            const maExtra = maMap[s.Symbol] || {};
            const techSig = macdRsiMap[s.Symbol] || {};
            const currentVol = s.TotalVolume || 0;
            const avgVol = stats.avgVolume || 0;
            // Tính % khối lượng so với TB: (currentVol / avgVol - 1) * 100
            // User requested logic earlier was (current/avg)*100.
            const volRatio = avgVol > 0 ? Math.round((currentVol / avgVol) * 100) : 0;

            // Calculate Demand Strength (Lực cầu) — Value-weighted + liquidity filter
            // Mã có TotalValue < 100 triệu → demandStrength = null (hiện '—', không ẩn)
            // Tránh nhiễu: mã 100 CP × 7.600đ = 760K không bị count 100% lực cầu
            const lucCauValue = computeLucCauByValue(s); // null nếu < 100tr GD

            return {
                symbol: s.Symbol,
                name: s.Name || '',
                price: formatPrice(s.PriceCurrent),
                change: formatPrice(s.PriceChange),
                changePercent: s.PricePercentChange ? parseFloat((s.PricePercentChange * 100).toFixed(2)) : 0,
                volume: s.TotalVolume,
                value: s.TotalValue ? Math.round(s.TotalValue / 1e9 * 10) / 10 : 0,
                // Remove Open/High/Low as requested
                // open: formatPrice(s.PriceOpen),
                // high: formatPrice(s.PriceHigh),
                // low: formatPrice(s.PriceLow),
                exchange: s.Exchange,
                avgVolume: avgVol,
                volRatio: volRatio,
                // New columns
                ma10: formatMA(stats.ma10),
                ma20: formatMA(stats.ma20),
                ma45: formatMA(stats.ma45),
                // ma50/100/200 từ close cache (raw VND) → chia 1000 để khớp price
                ma50: maExtra.ma50 != null ? parseFloat((maExtra.ma50 / 1000).toFixed(2)) : null,
                ma100: maExtra.ma100 != null ? parseFloat((maExtra.ma100 / 1000).toFixed(2)) : null,
                ma200: maExtra.ma200 != null ? parseFloat((maExtra.ma200 / 1000).toFixed(2)) : null,
                rsi: techSig.rsi != null ? parseFloat(techSig.rsi.toFixed(1)) : null,
                macdHist: techSig.macdHist != null ? parseFloat(techSig.macdHist.toFixed(2)) : null,
                macdRsiSignal: techSig.macdRsiSignal || null,
                macdRsiIndicator: techSig.macdRsiIndicator || null,
                demandStrength: lucCauValue   // number (0-100) hoặc null nếu mã < 100tr GD
            };
        };

        // Phân loại theo 3 sàn
        const hsxStocks = allStocks
            .filter(s => s && s.Symbol && s.Exchange === 'HOSTC')
            .map(transformStock)
            .sort((a, b) => (b.value || 0) - (a.value || 0));

        const hnxStocks = allStocks
            .filter(s => s && s.Symbol && s.Exchange === 'HASTC')
            .map(transformStock)
            .sort((a, b) => (b.value || 0) - (a.value || 0));

        const upcomStocks = allStocks
            .filter(s => s && s.Symbol && (s.Exchange === 'UPCOM' || s.Exchange === 'UPCoM'))
            .map(transformStock)
            .sort((a, b) => (b.value || 0) - (a.value || 0));

        console.log(`✅ Fetched: HSX ${hsxStocks.length}, HNX ${hnxStocks.length}, UPCOM ${upcomStocks.length}`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            counts: {
                HSX: hsxStocks.length,
                HNX: hnxStocks.length,
                UPCOM: upcomStocks.length,
                total: hsxStocks.length + hnxStocks.length + upcomStocks.length
            },
            stocks: {
                HSX: hsxStocks,
                HNX: hnxStocks,
                UPCOM: upcomStocks
            }
        };
        await setCachedResponse('all-stocks', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('All stocks error:', error);
        res.status(500).json({ error: error.message });
    }
});


// ==========================================
// POTENTIAL STOCKS API ENDPOINTS
// ==========================================

/**
 * GET /api/potential-stocks
 * Lấy danh sách cổ phiếu tiềm năng từ cache
 */
app.get('/api/potential-stocks', async (req, res) => {
    try {
        const cachedData = getCachedSignals();
        if (cachedData) {
            res.json(cachedData);
        } else {
            res.json({
                success: false,
                message: 'No cached signals found. Starting background scan...',
                signals: []
            });
            // Tự động quét trong background nếu chưa có cache
            const cookie = await getFireAntCookie();
            scanPotential(cookie).catch(err => console.error('[POTENTIAL] Auto-scan error:', err.message));
        }
    } catch (error) {
        console.error('Error fetching potential stocks:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/potential-stocks/scan
 * Kích hoạt quét cổ phiếu tiềm năng trực tiếp
 */
app.post('/api/potential-stocks/scan', async (req, res) => {
    try {
        console.log('⚡ [POTENTIAL] Manual scan triggered via API...');
        const cookie = await getFireAntCookie();
        const scanData = await scanPotential(cookie);
        res.json(scanData);
    } catch (error) {
        console.error('Manual scan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/breakout-trendline
 * Tín hiệu break trendline (từ cache của potential-scanner). Trả toàn bộ (cửa sổ ~30 phiên),
 * frontend tự lọc theo khoảng thời gian.
 */
app.get('/api/breakout-trendline', (req, res) => {
    try {
        const cache = getCachedSignals();
        const data = (cache && Array.isArray(cache.trendlineSignals)) ? cache.trendlineSignals : [];
        res.json({ success: true, timestamp: cache ? cache.timestamp : null, count: data.length, data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// ==========================================
// BUBBLE CHART API ENDPOINTS
// ==========================================

// ICB Industry code → tên ngành tiếng Việt
const ICB_INDUSTRY_MAP = {
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

// Override IndustryCode cho các mã FireAnt phân loại sai.
// VD: TIN (Tín Việt = công ty tài chính) FireAnt trả 8355 → cắt 2 số đầu = 8300 (Ngân hàng) SAI.
// Thực ra TIN thuộc 8700 (Dịch vụ tài chính). Override để gán đúng nhóm ngành.
const INDUSTRY_OVERRIDE = {
    TIN: '8700'   // Công ty Tài chính Tổng hợp Tín Việt → Dịch vụ tài chính (không phải Ngân hàng)
};

// ═══════════════════════════════════════════════════════════════════
// CUSTOM THEMES — nhóm chủ đề tùy chỉnh (không theo ICB2)
// ═══════════════════════════════════════════════════════════════════
// User muốn tách nhỏ theo chủ đề kinh doanh (Cá tra, Tôm, Vingroup...)
// thay vì chỉ theo ngành ICB2 chính thức.
// Prefix 'CT:' (Custom Theme) tránh đụng ICB2 code (là số).
// Mỗi theme tự định nghĩa danh sách symbol thuộc nhóm.
// Endpoint /api/industry-stats sẽ tính lucCau/stats cho các theme này
// giống như ngành ICB2, và append vào results.
// ═══════════════════════════════════════════════════════════════════
const CUSTOM_THEMES = {
    'CT:CA_TRA': {
        name: '🐟 Cá tra',
        symbols: ['VHC', 'IDI', 'ANV', 'ASM', 'AGF', 'ABT', 'ACL', 'HVG']
    },
    'CT:TOM': {
        name: '🦐 Tôm',
        symbols: ['MPC', 'FMC', 'CMX']
    },
    'CT:VINGROUP': {
        name: '🏢 Vingroup',
        symbols: ['VIC', 'VHM', 'VRE', 'VPL']
    }
};

// Map symbol → ICB code (top stocks)
const SYMBOL_TO_ICB = {
    // Ngân hàng
    VCB:'8300',BID:'8300',CTG:'8300',TCB:'8300',MBB:'8300',ACB:'8300',VPB:'8300',
    STB:'8300',HDB:'8300',VIB:'8300',OCB:'8300',MSB:'8300',TPB:'8300',SSB:'8300',
    LPB:'8300',NVB:'8300',BAB:'8300',BVB:'8300',KLB:'8300',ABB:'8300',
    // BĐS
    VHM:'8600',VIC:'8600',NVL:'8600',PDR:'8600',DIG:'8600',KDH:'8600',NLG:'8600',
    DXG:'8600',BCM:'8600',SGR:'8600',CRE:'8600',HDC:'8600',TDC:'8600',CEO:'8600',
    IDC:'8600',LDG:'8600',D2D:'8600',TIP:'8600',NRC:'8600',ITC:'8600',
    // Chứng khoán/Tài chính
    SSI:'8700',VND:'8700',HCM:'8700',MBS:'8700',VCI:'8700',BSI:'8700',ORS:'8700',
    AGR:'8700',CTS:'8700',FTS:'8700',TVS:'8700',IVS:'8700',VDS:'8700',SHS:'8700',
    // Công nghệ
    FPT:'9500',CMG:'9500',ELC:'9500',ITD:'9500',SAM:'9500',ST8:'9500',
    // Thực phẩm
    MSN:'3500',VNM:'3500',SAB:'3500',MCH:'3500',ANV:'3500',ABT:'3500',LAF:'3500',
    CAN:'3500',TAC:'3500',AAM:'3500',FMC:'3500',IDI:'3500',
    // Dầu khí
    GAS:'0500',PLX:'0500',PVD:'0500',PVS:'0500',BSR:'0500',OIL:'0500',PVC:'0500',
    // Tài nguyên/Khoáng sản
    HPG:'1700',HSG:'1700',NKG:'1700',TVN:'1700',SMC:'1700',TIS:'1700',POM:'1700',
    // Xây dựng
    CTD:'2300',HBC:'2300',FCN:'2300',VCG:'2300',LCG:'2300',DPG:'2300',
    // Y tế
    DHG:'3700',IMP:'3700',DMC:'3700',TRA:'3700',PME:'3700',
    // Bán lẻ (ICB2: 5300)
    MWG:'5300',FRT:'5300',DGW:'5300',PNJ:'5300',
    // Du lịch & giải trí (ICB2: 5700)
    HVN:'5700',VJC:'5700',
    // Hàng không/Vận tải
    GMD:'2800',VSC:'2800',STG:'2800',
    // Tiện ích điện
    POW:'7700',PC1:'7700',REE:'7700',BWE:'7700',GEX:'7700',
    // Hóa chất
    DGC:'4500',DCM:'4500',DPM:'4500',CSV:'4500',
};

/**
 * Shared: lấy danh sách tất cả cổ phiếu từ Fireant (nhanh, không cần all-stocks nặng)
 * Chỉ lấy HSX để tính bubble chart
 */
async function fetchAllStocksLight() {
    const batches = [
        'VCB,BID,CTG,TCB,MBB,ACB,VPB,STB,HDB,VIB,OCB,MSB,TPB,SSB,LPB,NVB,BAB,BVB,KLB,ABB',
        'VHM,VIC,NVL,PDR,DIG,KDH,NLG,DXG,BCM,SGR,CRE,HDC,TDC,CEO,IDC,LDG,D2D,TIP,NRC,ITC',
        'SSI,VND,HCM,MBS,VCI,BSI,ORS,AGR,CTS,FTS,TVS,IVS,VDS,SHS,FPT,CMG,ELC,ITD,SAM,ST8',
        'MSN,VNM,SAB,MCH,ANV,ABT,LAF,CAN,TAC,AAM,FMC,IDI,GAS,PLX,PVD,PVS,BSR,OIL,PVC',
        'HPG,HSG,NKG,TVN,SMC,TIS,POM,CTD,HBC,FCN,VCG,LCG,DPG,DHG,IMP,DMC,TRA,PME',
        'MWG,FRT,DGW,PNJ,HVN,VJC,GMD,VSC,STG,POW,PC1,REE,BWE,GEX,DGC,DCM,DPM,CSV',
        'VGC,DBC,TCM,TNG,GVR,PHR,BST,SBT,QNS,KBC,PHC,VCA,DRC,CSM,GIL,TCH,CLW,BWS'
    ];
    let allStocks = [];
    for (const symbols of batches) {
        try {
            const url = `${API_CONFIG.fireant.base}/Markets/Quotes?symbols=${symbols}`;
            const data = await fetchAPI(url, API_CONFIG.fireant.headers);
            if (Array.isArray(data)) allStocks = allStocks.concat(data);
        } catch(e) { /* bỏ qua lỗi từng batch */ }
    }
    return allStocks;
}

// NOTE: /api/industry-stats endpoint moved to line ~1913 (uses FireAnt IndustryCode instead of SYMBOL_TO_ICB)

// NOTE: Old /api/marketcap-stats endpoint removed (it categorized by transaction volume rank instead of true market cap, and conflicted with the correct version at line ~2342)


// ==========================================
// FIINTRADE API ENDPOINTS (Industry Flow + Investor Flow)
// Nguồn dữ liệu dòng tiền ngành & phân tích lệnh theo 4 nhóm NĐT.
// (Thay thế Fitrade cũ - apigw.fitrade.vn đã ngừng hoạt động.)
// ==========================================

/**
 * GET /api/industry-flow
 * Lấy dữ liệu dòng tiền ngành - Logic giống Apps Script Dòng tiền.txt
 * Query params: fromDate, toDate (format: dd-MM-yyyy)
 */
app.get('/api/industry-flow', async (req, res) => {
    try {
        // timeRange: 1 (1 ngày) | 5 (5 ngày) | 20 (20 ngày) | 0 (từ đầu năm)
        // level: 1 (10 ngành cấp 1) | 2 (18 ngành cấp 2)
        const timeRange = [0, 1, 5, 20].includes(parseInt(req.query.timeRange)) ? parseInt(req.query.timeRange) : 1;
        const level = parseInt(req.query.level) === 1 ? 1 : 2;
        const cacheKey = `industry-flow:${timeRange}:${level}`;

        const cached = await getCachedResponse(cacheKey, 60000);
        if (cached) {
            console.log('📊 Returning cached industry-flow data');
            return res.json(cached);
        }

        console.log(`📊 Fetching industry flow from Fiintrade (timeRange=${timeRange}, level=${level})...`);
        const { fromDate, toDate, data } = await fiintrade.getSectorFlow(timeRange, level);

        if (!data || data.length === 0) {
            return res.json({ success: false, error: 'No data from Fiintrade' });
        }

        console.log(`✅ Industry flow: ${data.length} industries (Fiintrade)`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            source: 'fiintrade',
            timeRange,
            level,
            fromDate,
            toDate,
            data
        };
        await setCachedResponse(cacheKey, responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Industry flow error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/industry-cumulative  (đã chuyển sang Fiintrade)
 * Alias của /api/industry-flow để tương thích ngược: trả về dòng tiền ròng
 * theo ngành & nhóm NĐT cho timeRange chỉ định.
 */
app.get('/api/industry-cumulative', async (req, res) => {
    try {
        const timeRange = [0, 1, 5, 20].includes(parseInt(req.query.timeRange)) ? parseInt(req.query.timeRange) : 5;
        const level = parseInt(req.query.level) === 1 ? 1 : 2;
        const { fromDate, toDate, data } = await fiintrade.getSectorFlow(timeRange, level);
        res.json({ success: true, source: 'fiintrade', timeRange, level, fromDate, toDate, data });
    } catch (error) {
        console.error('Industry cumulative error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/breadth-breakout
 * "Phá Đỉnh / Phá Đáy" — breadth thị trường dựa trên số mã lập đỉnh mới (New High)
 * vs đáy mới (New Low) theo 3 timeframe (3T / 6T / 1N). Nguồn: Fiintrade TopMover.
 *
 * Insight được tính sẵn server-side để frontend chỉ render:
 *   - summary: H/L count + ratio + verdict cho từng timeframe
 *   - capSummary: tổng vốn hóa H vs L + Low/High multiplier
 *   - sizeBuckets: phân nhóm vốn hóa (Mega/Large/Mid/Small/Micro) cho H & L (3T)
 *   - sectorBreakdown: gom theo ngành, đếm count + vốn hóa, cho H & L (3T)
 *   - topHighs3T: mã High 3T sort theo GTGD (lật "phá đỉnh ma" GTGD≈0)
 *   - topLows1Y: top 10 mã Low 1Y giảm sâu nhất
 *   - rsiSummary: RSI trung bình nhóm H 3T & L 3T (overbought/oversold)
 */
app.get('/api/breadth-breakout', async (req, res) => {
    const cacheKey = 'breadth-breakout';
    const cached = await getCachedResponse(cacheKey, 60000);
    if (cached) {
        console.log('📈 Returning cached breadth-breakout data');
        return res.json(cached);
    }

    try {
        console.log('📈 Fetching TopMover New High/Low from Fiintrade (6 endpoints)...');

        // Fetch song song 6 combos. Mỗi call wrap try/catch riêng → partial response nếu 1 fail.
        const safeFetch = async (fn, range, label) => {
            try { return await fn(range); }
            catch (e) { console.warn(`⚠️ TopMover ${label} fail:`, e.message); return []; }
        };

        const [high3T, high6T, high1Y, low3T, low6T, low1Y] = await Promise.all([
            safeFetch(fiintrade.getTopNewHigh, 'ThreeMonths', 'High/3T'),
            safeFetch(fiintrade.getTopNewHigh, 'SixMonths',  'High/6T'),
            safeFetch(fiintrade.getTopNewHigh, 'OneYear',    'High/1Y'),
            safeFetch(fiintrade.getTopNewLow,  'ThreeMonths', 'Low/3T'),
            safeFetch(fiintrade.getTopNewLow,  'SixMonths',  'Low/6T'),
            safeFetch(fiintrade.getTopNewLow,  'OneYear',    'Low/1Y')
        ]);

        const RANGES = ['ThreeMonths', 'SixMonths', 'OneYear'];
        const highByTf = { ThreeMonths: high3T, SixMonths: high6T, OneYear: high1Y };
        const lowByTf  = { ThreeMonths: low3T,  SixMonths: low6T,  OneYear: low1Y };

        // ── summary: H/L count + ratio + verdict cho từng timeframe ──────
        const summary = RANGES.map(tf => {
            const h = highByTf[tf].length;
            const l = lowByTf[tf].length;
            const ratio = l > 0 ? h / l : (h > 0 ? 99 : 0);
            const verdict = ratio >= 1.25 ? 'Bullish' : (ratio <= 0.8 ? 'Bearish' : 'Neutral');
            return { tf, high: h, low: l, ratio: Math.round(ratio * 100) / 100, verdict };
        });

        // ── capSummary: tổng vốn hóa H vs L theo timeframe ───────────────
        const sumCap = (arr) => arr.reduce((s, it) => s + (it.marketCap || 0), 0);
        const capSummary = RANGES.map(tf => {
            const capHigh = sumCap(highByTf[tf]);
            const capLow  = sumCap(lowByTf[tf]);
            const lowOverHigh = capHigh > 0 ? capLow / capHigh : (capLow > 0 ? 99 : 0);
            return {
                tf,
                capHigh: Math.round(capHigh),
                capLow:  Math.round(capLow),
                lowOverHigh: Math.round(lowOverHigh * 100) / 100
            };
        });

        // ── sizeBuckets: phân nhóm vốn hóa cho H & L (3T) ────────────────
        // Ngưỡng (tỷ VND): Mega ≥50K · Large 10-50K · Mid 2-10K · Small 0.5-2K · Micro <0.5K
        const bucketOf = (cap) => {
            if (cap >= 50000) return 'Mega';
            if (cap >= 10000) return 'Large';
            if (cap >= 2000)  return 'Mid';
            if (cap >= 500)   return 'Small';
            return 'Micro';
        };
        const bucketize = (arr) => {
            const b = { Mega: 0, Large: 0, Mid: 0, Small: 0, Micro: 0 };
            for (const it of arr) b[bucketOf(it.marketCap || 0)]++;
            return b;
        };
        const sizeBuckets = { high: bucketize(high3T), low: bucketize(low3T) };

        // ── sectorBreakdown: gom theo ngành cho H & L, ĐỦ 3 timeframe ───
        // Mỗi ngành 1 dòng, mỗi timeframe có {highCount, lowCount, highCap, lowCap}.
        // Sort theo "tác động" = tổng vốn hóa phá đáy giảm dần (đọng vốn hóa lớn nhất trước).
        const groupSectorCombined = () => {
            const m = new Map(); // sector → { perTf: {3T:{h:0,l:0,hCap:0,lCap:0}, ...} }
            const TF_LIST = ['ThreeMonths', 'SixMonths', 'OneYear'];
            const ensure = (sec) => {
                if (!m.has(sec)) {
                    const perTf = {};
                    for (const tf of TF_LIST) perTf[tf] = { h: 0, l: 0, hCap: 0, lCap: 0 };
                    m.set(sec, { sector: sec, perTf });
                }
                return m.get(sec);
            };
            const apply = (arr, type, tf) => {
                for (const it of arr) {
                    const sec = it.sector || '(không rõ)';
                    const o = ensure(sec).perTf[tf];
                    if (type === 'high') { o.h++; o.hCap += it.marketCap || 0; }
                    else { o.l++; o.lCap += it.marketCap || 0; }
                }
            };
            apply(high3T, 'high', 'ThreeMonths');
            apply(high6T, 'high', 'SixMonths');
            apply(high1Y, 'high', 'OneYear');
            apply(low3T,  'low',  'ThreeMonths');
            apply(low6T,  'low',  'SixMonths');
            apply(low1Y,  'low',  'OneYear');
            // Tính tổng + format
            const rows = [...m.values()].map(o => {
                let totalHigh = 0, totalLow = 0, totalHCnt = 0, totalLCnt = 0;
                for (const tf of TF_LIST) {
                    const p = o.perTf[tf];
                    totalHigh += p.hCap; totalLow += p.lCap;
                    totalHCnt += p.h; totalLCnt += p.l;
                    p.hCap = Math.round(p.hCap); p.lCap = Math.round(p.lCap);
                }
                return {
                    sector: o.sector,
                    perTf: o.perTf,
                    totalHighCap: Math.round(totalHigh),
                    totalLowCap: Math.round(totalLow),
                    totalHCnt, totalLCnt,
                    impact: Math.round(totalLow - totalHigh) // tác động ròng (đáy - đỉnh)
                };
            });
            // Sort theo vốn hóa phá đáy giảm dần (ngành đọng vốn hóa yếu nhất trước)
            rows.sort((a, b) => b.totalLowCap - a.totalLowCap);
            return rows;
        };
        const sectorBreakdown = groupSectorCombined();

        // ── topHighs3T: sort theo GTGD desc (lật "phá đỉnh ma" GTGD≈0) ───
        const topHighs3T = [...high3T].sort((a, b) => (b.value || 0) - (a.value || 0));

        // ── topLows1Y: top 10 Low 1Y giảm sâu nhất ───────────────────────
        const topLows1Y = [...low1Y]
            .sort((a, b) => (a.pct1Y || 0) - (b.pct1Y || 0))
            .slice(0, 10);

        // ── allStocks: gộp tất cả mã vào 1 bảng, đánh dấu timeframe xuất hiện
        // mỗi ticker chỉ xuất hiện 1 lần; cột High/Low ghi badge 3T/6T/1N nếu có.
        const TFMAP = { ThreeMonths: '3T', SixMonths: '6T', OneYear: '1N' };
        const mergeMap = new Map();
        const addRange = (arr, type, tf) => {
            for (const it of arr) {
                if (!mergeMap.has(it.ticker)) {
                    mergeMap.set(it.ticker, {
                        ticker: it.ticker,
                        sector: it.sector,
                        price: it.price,
                        value: it.value,
                        volume: it.volume,
                        marketCap: it.marketCap,
                        pct3M: it.pct3M,
                        pct6M: it.pct6M,
                        pct1Y: it.pct1Y,
                        pctYTD: it.pctYTD,
                        rsi: it.rsi,
                        highTfs: [],
                        lowTfs: []
                    });
                }
                const o = mergeMap.get(it.ticker);
                // Giữ giá trị/GTGD/volume/rsi lớn nhất (mã phá đỉnh gần nhất thường ở 3T)
                if ((it.value || 0) > (o.value || 0)) o.value = it.value;
                if ((it.volume || 0) > (o.volume || 0)) o.volume = it.volume;
                if ((it.rsi || 0) > (o.rsi || 0)) o.rsi = it.rsi;
                const tag = TFMAP[tf];
                if (type === 'high') o.highTfs.push(tag);
                else o.lowTfs.push(tag);
            }
        };
        addRange(high3T, 'high', 'ThreeMonths');
        addRange(high6T, 'high', 'SixMonths');
        addRange(high1Y, 'high', 'OneYear');
        addRange(low3T,  'low',  'ThreeMonths');
        addRange(low6T,  'low',  'SixMonths');
        addRange(low1Y,  'low',  'OneYear');
        // Sort: loại (chỉ đỉnh trước, chỉ đáy sau), rồi vốn hóa giảm dần
        const allStocks = [...mergeMap.values()].sort((a, b) => {
            const aType = a.highTfs.length > 0 && a.lowTfs.length === 0 ? 0
                : a.lowTfs.length > 0 && a.highTfs.length === 0 ? 2 : 1;
            const bType = b.highTfs.length > 0 && b.lowTfs.length === 0 ? 0
                : b.lowTfs.length > 0 && b.highTfs.length === 0 ? 2 : 1;
            if (aType !== bType) return aType - bType;
            return (b.marketCap || 0) - (a.marketCap || 0);
        });

        // ── rsiSummary: RSI trung bình H 3T & L 3T ───────────────────────
        const avgRsi = (arr) => {
            const rs = arr.map(it => it.rsi).filter(r => r > 0);
            return rs.length ? Math.round(rs.reduce((a, b) => a + b, 0) / rs.length * 10) / 10 : 0;
        };
        const rsiSummary = { high3T: avgRsi(high3T), low3T: avgRsi(low3T) };

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            source: 'fiintrade',
            summary,
            capSummary,
            sizeBuckets,
            sectorBreakdown,
            topHighs3T,
            topLows1Y,
            allStocks,
            rsiSummary,
            raw: { high3T, high6T, high1Y, low3T, low6T, low1Y }
        };

        await setCachedResponse(cacheKey, responseData);
        console.log(`✅ Breadth breakout: H=${high3T.length}/${high6T.length}/${high1Y.length} L=${low3T.length}/${low6T.length}/${low1Y.length}`);
        res.json(responseData);
    } catch (error) {
        console.error('Breadth breakout error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/breadth-snapshot?days=90
 * Lịch sử snapshot breadth theo ngày (cho vẽ trend chart).
 */
app.get('/api/breadth-snapshot', async (req, res) => {
    const cacheKey = 'breadth-snapshot';
    const cached = await getCachedResponse(cacheKey, 60000);
    if (cached) return res.json(cached);
    try {
        const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 730);
        const breadthSnapshot = require('./breadth-snapshot');
        const [series, meta] = await Promise.all([
            breadthSnapshot.getHistory(days),
            breadthSnapshot.getMeta()
        ]);
        const responseData = {
            success: true,
            days,
            meta,
            series,
            timestamp: new Date().toISOString()
        };
        await setCachedResponse(cacheKey, responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Breadth snapshot error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/breadth-snapshot/meta
 */
app.get('/api/breadth-snapshot/meta', async (req, res) => {
    try {
        const breadthSnapshot = require('./breadth-snapshot');
        const meta = await breadthSnapshot.getMeta();
        res.json({ success: true, meta });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/breadth-snapshot/capture
 * Trigger snapshot hôm nay (admin only — cho lần đầu bật + test).
 */
app.post('/api/breadth-snapshot/capture', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Admin only' });
    }
    try {
        const breadthSnapshot = require('./breadth-snapshot');
        const snapshot = await breadthSnapshot.buildToday();
        res.json({ success: true, snapshot });
    } catch (error) {
        console.error('Breadth snapshot capture error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/investor-flow
 * "Phân tích lệnh" — dòng tiền ròng (khớp lệnh) toàn thị trường theo 4 nhóm NĐT:
 * cá nhân / tổ chức / tự doanh / nước ngoài, cho nhiều mốc thời gian (1D, 5D, 20D).
 * Nguồn: Fiintrade (tổng hợp 10 ngành cấp 1). Đơn vị: tỷ đồng.
 */
app.get('/api/investor-flow', async (req, res) => {
    const cached = await getCachedResponse('investor-flow', 60000);
    if (cached) return res.json(cached);
    try {
        console.log('📊 Fetching investor-group flow from Fiintrade...');
        const [d1, d5, d20] = await Promise.all([
            fiintrade.getMarketInvestorFlow(1),
            fiintrade.getMarketInvestorFlow(5),
            fiintrade.getMarketInvestorFlow(20)
        ]);

        const groups = [
            { key: 'caNhan',    name: 'Cá nhân',    d1: d1.caNhan,    d5: d5.caNhan,    d20: d20.caNhan },
            { key: 'toChuc',    name: 'Tổ chức',    d1: d1.toChuc,    d5: d5.toChuc,    d20: d20.toChuc },
            { key: 'tuDoanh',   name: 'Tự doanh',   d1: d1.tuDoanh,   d5: d5.tuDoanh,   d20: d20.tuDoanh },
            { key: 'nuocNgoai', name: 'Nước ngoài', d1: d1.nuocNgoai, d5: d5.nuocNgoai, d20: d20.nuocNgoai }
        ];

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            source: 'fiintrade',
            fromDate: d1.fromDate,
            toDate: d1.toDate,
            groups
        };
        await setCachedResponse('investor-flow', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Investor flow error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/foreign-flow
 * Khối ngoại Mua / Bán / Ròng (khớp lệnh) toàn thị trường + xu hướng 1/5/20 phiên.
 * Đơn vị: tỷ đồng.
 *
 * Nguồn chính (Fiintrade):
 *   - today {buy, sell, net}: GetStatisticInvestor?investorType=ForeignMatch (có tách Mua/Bán).
 *   - net 5/20 phiên: getMarketInvestorFlow(5/20).nuocNgoai (tổng ICB cấp 1, khớp lệnh ròng).
 *   - "1 phiên" trong trend = today.net (cùng nguồn, đảm bảo nhất quán).
 * Fallback cuối: FireAnt HOSTC IntradayMarketStatistic (chỉ HOSE, phiên hiện tại).
 */
app.get('/api/foreign-flow', async (req, res) => {
    const cached = await getCachedResponse('foreign-flow', 60000);
    if (cached) return res.json(cached);
    try {
        console.log('🌍 Fetching foreign flow (Khối ngoại)...');

        // Gọi song song:
        //  - FireAnt HOSTC: today buy/sell/net HOSE (KHỚP với số các trang CK hiển thị).
        //    Fiintrade (VNINDEX) lệch đáng kể (tính cả 3 sàn / cache chậm) → chỉ dùng cho trend 5/20.
        //  - Fiintrade: trend 5/20 phiên (FireAnt không có multi-day net).
        const cookie = await getFireAntCookie();
        const authHeaders = {
            ...API_CONFIG.fireant.headers,
            'Cookie': cookie,
            'Accept-Encoding': 'gzip, deflate'
        };
        const settled = await Promise.allSettled([
            fetchAPI(`${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=HOSTC`, authHeaders), // 0: FireAnt today
            fiintrade.getMarketInvestorFlow(5),  // 1: 5 phiên net
            fiintrade.getMarketInvestorFlow(20)  // 2: 20 phiên net
        ]);

        // 1. Today từ FireAnt HOSTC (chính xác, khớp số thị trường)
        const fa = settled[0].status === 'fulfilled' ? settled[0].value : null;
        const latest = Array.isArray(fa) ? fa[fa.length - 1] : fa;
        let today;
        if (latest && (latest.BuyForeignValue != null || latest.SellForeignValue != null)) {
            const buy = Math.round(((latest.BuyForeignValue || 0) / 1e9) * 10) / 10;
            const sell = Math.round(((latest.SellForeignValue || 0) / 1e9) * 10) / 10;
            const net = Math.round((buy - sell) * 10) / 10;
            today = { buy, sell, net };
        }

        // Fallback today: Fiintrade nếu FireAnt lỗi
        if (!today) {
            const stat = settled.length > 3 && settled[3].status === 'fulfilled' ? settled[3].value : null;
            if (stat && stat.today && typeof stat.today.net === 'number') {
                today = { buy: stat.today.buy, sell: stat.today.sell, net: stat.today.net };
            } else {
                throw new Error('No foreign data (FireAnt + Fiintrade đều lỗi)');
            }
        }

        // 2. Trend 5/20 phiên từ Fiintrade (FireAnt không có)
        const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
        const d5 = val(1), d20 = val(2);
        const num = (o, k) => (o && typeof o[k] === 'number') ? o[k] : null;

        const responseData = {
            success: true,
            source: 'fireant',  // today từ FireAnt (primary), trend từ Fiintrade
            today,
            trend: [
                { label: '1 phiên', net: today.net },
                { label: '5 phiên', net: num(d5, 'nuocNgoai') },
                { label: '20 phiên', net: num(d20, 'nuocNgoai') }
            ],
            timestamp: new Date().toISOString()
        };
        await setCachedResponse('foreign-flow', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Foreign flow error:', error.message);
        return res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
    }
});

/**
 * GET /api/investor-detail
 * Chi tiết dòng tiền (khớp lệnh) theo CẢ 4 nhóm NĐT: Mua / Bán / Ròng hôm nay
 * (+ ròng 1 tuần / 1 tháng) kèm Top 10 mã Mua ròng & Bán ròng cho từng nhóm.
 * Nguồn: Fiintrade MoneyFlow/GetStatisticInvestor. Đơn vị: tỷ đồng.
 */
app.get('/api/investor-detail', async (req, res) => {
    // Range: today | oneWeek | oneMonth | yearToDate (mặc định today)
    const range = ['today', 'oneWeek', 'oneMonth', 'yearToDate'].includes(req.query.range) ? req.query.range : 'today';
    const cacheKey = `investor-detail:${range}`;
    const cached = await getCachedResponse(cacheKey, 60000);
    if (cached) {
        console.log(`📊 Returning cached ${cacheKey} data`);
        return res.json(cached);
    }
    try {
        console.log(`📊 Fetching investor-detail (4 nhóm NĐT, range=${range}) from Fiintrade...`);
        const keys = Object.keys(fiintrade.INVESTOR_TYPES); // individual, institution, proprietary, foreign
        const settled = await Promise.all(
            keys.map(k => fiintrade.getInvestorStatistic(k, 'VNINDEX', range).catch(() => null))
        );
        const groups = settled.filter(Boolean);

        if (groups.length === 0) {
            return res.status(500).json({ success: false, error: 'No data from Fiintrade', timestamp: new Date().toISOString() });
        }

        // Rút fromDate/toDate từ group đầu (tất cả nhóm cùng range → cùng date)
        const fromDate = groups[0].fromDate;
        const toDate = groups[0].toDate;
        console.log(`✅ Investor detail: ${groups.length}/4 nhóm NĐT (Fiintrade, range=${range}, ${fromDate} → ${toDate})`);
        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            source: 'fiintrade',
            range,
            fromDate,
            toDate,
            groups
        };
        await setCachedResponse(cacheKey, responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Investor detail error:', error.message);
        res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
    }
});

/**
 * GET /api/stock-investor-flow?symbol=HPG&freq=Daily
 * Dòng tiền khớp ròng (GT, tỷ) theo 4 nhóm NĐT cho 1 mã, theo thời gian.
 * Nguồn: Fiintrade GetPriceData. freq: Daily|Weekly|Monthly.
 */
app.get('/api/stock-investor-flow', async (req, res) => {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const freq = ['Daily', 'Weekly', 'Monthly'].includes(req.query.freq) ? req.query.freq : 'Daily';
    if (!symbol) return res.status(400).json({ success: false, error: 'Thiếu tham số symbol' });
    const cacheKey = `stock-investor-flow:${symbol}:${freq}`;
    const cached = await getCachedResponse(cacheKey, 60000);
    if (cached) return res.json(cached);
    try {
        const result = await fiintrade.getStockInvestorFlow(symbol, freq);
        const responseData = { success: true, source: 'fiintrade', timestamp: new Date().toISOString(), ...result };
        await setCachedResponse(cacheKey, responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Stock investor flow error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// SSTOCK API ENDPOINTS (Macro Data)
// ==========================================

/**
 * GET /api/macro/:type
 * Lấy dữ liệu vĩ mô
 * Params: type (interest-rate, liquidity, bond-yield, exchange-rate)
 */
app.get('/api/macro/:type', async (req, res) => {
    try {
        const macroEndpoints = {
            'interest-rate-on': 'Liên ngân hàng - Lãi suất ON',
            'interest-rate-omo': 'Lãi suất điều hành - Lãi suất OMO',
            'bond-yield-vn10y': 'Lợi tức trái phiếu VN - 10 năm',
            'bond-yield-us10y': 'Lợi tức trái phiếu Hoa Kỳ - 10 năm',
            'exchange-rate-usd': 'Tỷ giá VND/USD - Tỷ giá USD NHTM bán ra',
            'dxy-index': 'Chỉ số DXY - Dollar Index Futures'
        };

        const type = req.params.type;
        const dataSeriesName = macroEndpoints[type];

        if (!dataSeriesName) {
            return res.status(400).json({ error: 'Invalid macro type' });
        }

        const url = `${API_CONFIG.sstock.base}/chart/general-data-series?dataSeriesNames=${encodeURIComponent(dataSeriesName)}`;
        const data = await fetchAPI(url, API_CONFIG.sstock.headers);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vnindex-history
 * Lấy lịch sử VNINDEX
 */
app.get('/api/vnindex-history', async (req, res) => {
    try {
        const from = req.query.from || '2024-01-01';
        const to = req.query.to || new Date().toISOString().split('T')[0];

        // Nguồn sstock đã ngừng hoạt động → dùng FireAnt HistoricalQuotes (đã kiểm chứng)
        const url = `${API_CONFIG.fireant.base}/Markets/HistoricalQuotes?symbol=VNINDEX&startDate=${from}&endDate=${to}`;
        const raw = await fetchAPI(url, API_CONFIG.fireant.headers);
        const arr = Array.isArray(raw) ? raw : (raw && raw.value) || [];

        const data = arr.map(d => ({
            date: (d.Date || '').split('T')[0],
            close: d.Close,
            open: d.Open,
            high: d.High,
            low: d.Low,
            volume: d.Volume
        })).sort((a, b) => a.date.localeCompare(b.date));

        res.json({ success: true, source: 'fireant', symbol: 'VNINDEX', data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/foreign-daily
 * Lấy dữ liệu khối ngoại mua bán ròng hàng ngày
 */
app.get('/api/foreign-daily', async (req, res) => {
    // Nguồn sstock (api-feature.sstock.vn) đã ngừng hoạt động và chưa có nguồn thay thế
    // cho chuỗi GTGD khối ngoại theo NGÀY. Trả về graceful (HTTP 200) thay vì lỗi 500.
    // Khối ngoại phiên hiện tại xem ở /api/market-breadth (FireAnt).
    res.json({
        success: false,
        error: 'Nguồn dữ liệu khối ngoại theo ngày tạm ngưng (sstock offline). Dùng /api/market-breadth cho khối ngoại phiên hiện tại.',
        data: []
    });
});

// ==========================================
// COMBINED ENDPOINTS (Dashboard Data)
// ==========================================

/**
 * GET /api/dashboard
 * Lấy tất cả dữ liệu dashboard
 */
app.get('/api/dashboard', async (req, res) => {
    try {
        const results = {
            vnindex: null,
            vn30: null,
            hnx: null,
            quotes: null,
            timestamp: new Date().toISOString()
        };

        // Fetch market indices in parallel
        const [vnindex, vn30, hnx] = await Promise.allSettled([
            fetchAPI(`${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=HOSTC`, API_CONFIG.fireant.headers),
            fetchAPI(`${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=VN30`, API_CONFIG.fireant.headers),
            fetchAPI(`${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=HNX`, API_CONFIG.fireant.headers)
        ]);

        if (vnindex.status === 'fulfilled') results.vnindex = vnindex.value;
        if (vn30.status === 'fulfilled') results.vn30 = vn30.value;
        if (hnx.status === 'fulfilled') results.hnx = hnx.value;

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// RSS NEWS ENDPOINTS
// ==========================================

const xml2js = require('xml2js');

// RSS Feed Sources
const RSS_FEEDS = [
    { url: 'https://vietstock.vn/737/doanh-nghiep/hoat-dong-kinh-doanh.rss', category: 'Doanh nghiệp', source: 'Vietstock' },
    { url: 'https://vietstock.vn/738/doanh-nghiep/co-tuc.rss', category: 'Cổ tức', source: 'Vietstock' },
    { url: 'https://vietstock.vn/764/doanh-nghiep/tang-von-m-a.rss', category: 'Tăng vốn - M&A', source: 'Vietstock' },
    { url: 'https://vietstock.vn/830/chung-khoan/co-phieu.rss', category: 'Cổ phiếu', source: 'Vietstock' },
    { url: 'https://vietstock.vn/761/kinh-te/vi-mo.rss', category: 'Kinh tế vĩ mô', source: 'Vietstock' },
    { url: 'https://vietstock.vn/757/tai-chinh/ngan-hang.rss', category: 'Ngân hàng', source: 'Vietstock' },
    { url: 'https://vietstock.vn/1328/dong-duong/thi-truong-chung-khoan.rss', category: 'Thị trường CK', source: 'Vietstock' },
    { url: 'https://vietstock.vn/739/chung-khoan/giao-dich-noi-bo.rss', category: 'Giao dịch nội bộ', source: 'Vietstock' },
    { url: 'https://cafef.vn/thi-truong-chung-khoan.rss', category: 'Chứng khoán', source: 'CafeF' },
    { url: 'https://cafef.vn/bat-dong-san.rss', category: 'Bất động sản', source: 'CafeF' },
    { url: 'https://cafef.vn/doanh-nghiep.rss', category: 'Doanh nghiệp', source: 'CafeF' },
    { url: 'https://cafef.vn/tai-chinh-ngan-hang.rss', category: 'Ngân hàng', source: 'CafeF' },
    { url: 'https://vnexpress.net/rss/kinh-doanh.rss', category: 'Kinh doanh', source: 'VnExpress' },
    { url: 'https://vnexpress.net/rss/chung-khoan.rss', category: 'Chứng khoán', source: 'VnExpress' },
    { url: 'https://vnexpress.net/rss/bat-dong-san.rss', category: 'Bất động sản', source: 'VnExpress' },
    { url: 'https://baodautu.vn/dau-tu.rss', category: 'Đầu tư', source: 'Báo Đầu Tư' },
    { url: 'https://baodautu.vn/chung-khoan.rss', category: 'Chứng khoán', source: 'Báo Đầu Tư' },
    { url: 'https://baodautu.vn/doanh-nghiep.rss', category: 'Doanh nghiệp', source: 'Báo Đầu Tư' },
    { url: 'https://baodautu.vn/bat-dong-san.rss', category: 'Bất động sản', source: 'Báo Đầu Tư' }
];

/**
 * Parse RSS XML to JSON
 */
async function parseRSS(xmlData) {
    const parser = new xml2js.Parser({ explicitArray: false });
    return new Promise((resolve, reject) => {
        parser.parseString(xmlData, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

/**
 * Fetch and parse a single RSS feed
 */
async function fetchRSSFeed(feed) {
    try {
        const response = await axios.get(feed.url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 8000,
            responseType: 'text'
        });

        const parsed = await parseRSS(response.data);
        const channel = parsed.rss?.channel;

        if (!channel || !channel.item) return [];

        const items = Array.isArray(channel.item) ? channel.item : [channel.item];

        return items.slice(0, 10).map(item => ({
            title: item.title || '',
            link: item.link || '',
            pubDate: item.pubDate || '',
            description: item.description?.replace(/<[^>]*>/g, '').substring(0, 200) || '',
            category: feed.category,
            source: feed.source
        }));
    } catch (error) {
        console.error(`RSS Error: ${feed.url}`, error.message);
        return [];
    }
}

/**
 * Calculate time ago string
 */
function getTimeAgo(pubDate) {
    const now = new Date();
    const pub = new Date(pubDate);
    const diffMs = now - pub;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins} phút trước`;
    if (diffHours < 24) return `${diffHours} giờ trước`;
    if (diffDays < 7) return `${diffDays} ngày trước`;
    return pub.toLocaleDateString('vi-VN');
}

/**
 * GET /api/news
 * Lấy tin tức từ các nguồn RSS
 * Query params: category (optional), limit (default 30)
 */
app.get('/api/news', async (req, res) => {
    const { category, limit = 30 } = req.query;
    // Cache 120 seconds - RSS feeds
    const cacheKey = `news:${category || 'all'}:${limit}`;
    const cached = await getCachedResponse(cacheKey, 120000);
    if (cached) {
        console.log('📰 Returning cached news data');
        return res.json(cached);
    }
    try {

        console.log('Fetching news from RSS feeds...');

        // Fetch all feeds in parallel
        const feedPromises = RSS_FEEDS.map(feed => fetchRSSFeed(feed));
        const results = await Promise.allSettled(feedPromises);

        // Collect all news items
        let allNews = [];
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                allNews = allNews.concat(result.value);
            }
        });

        // Add timeAgo field
        allNews = allNews.map(item => ({
            ...item,
            timeAgo: getTimeAgo(item.pubDate)
        }));

        // Sort by pubDate (newest first)
        allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        // Filter by category if specified
        if (category && category !== 'all') {
            allNews = allNews.filter(item =>
                item.category.toLowerCase().includes(category.toLowerCase())
            );
        }

        // Limit results
        allNews = allNews.slice(0, parseInt(limit));

        console.log(`Fetched ${allNews.length} news items`);

        const responseData = {
            success: true,
            count: allNews.length,
            news: allNews
        };
        await setCachedResponse(cacheKey, responseData);
        res.json(responseData);
    } catch (error) {
        console.error('News fetch error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// DASHBOARD CHARTS ENDPOINTS
// ==========================================

/**
 * GET /api/industry-stats
 * Tính % CP > MA10 và Lực Cầu theo ngành ICB2 cho Bubble Chart
 */
app.get('/api/industry-stats', async (req, res) => {
    // Cache 60 seconds - very heavy endpoint (700+ quotes)
    const cached = await getCachedResponse('industry-stats', 60000);
    if (cached) {
        console.log('📊 Returning cached industry-stats data');
        return res.json(cached);
    }
    try {
        console.log('📊 Calculating industry stats for bubble chart...');

        // ICB2 mapping
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

        // Get cookie for authenticated requests
        const cookie = await getFireAntCookie();
        const authHeaders = {
            ...API_CONFIG.fireant.headers,
            'Cookie': cookie,
            'Accept-Encoding': 'gzip, deflate',
            'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
        };

        const tradingUrl = `${API_CONFIG.fireant.base}/Markets/TradingStatistic`;
        const quotesUrl = `${API_CONFIG.fireant.base}/Markets/Quotes`;

        // Fetch TradingStatistic for AvgPrice10d, then fetch ALL quotes in batches for IndustryCode + ActiveBuy/Sell
        const tradingData = await fetchAPI(tradingUrl, authHeaders).catch(() => []);

        if (!tradingData || !tradingData.length) {
            return res.json({ success: false, error: 'No trading data' });
        }

        // Build MA10 and shares outstanding map from TradingStatistic
        const ma10Map = {};
        const sharesMap = {};
        tradingData.forEach(stock => {
            if (stock.Symbol) {
                ma10Map[stock.Symbol] = stock.AvgPrice10d || 0;
                sharesMap[stock.Symbol] = stock.SharesOutStanding || 0;
            }
        });

        // Fetch ALL quotes in batches to get IndustryCode + ActiveBuy/Sell
        const allQuotes = [];
        const batch1 = 'A32,AAA,AAM,AAS,AAT,AAV,ABB,ABC,ABI,ABR,ABS,ABT,ACB,ACC,ACE,ACG,ACL,ACM,ACS,ACV,ADC,ADG,ADP,ADS,AFX,AG1,AGE,AGF,AGG,AGM,AGP,AGR,AGX,AIC,ALT,ALV,AMC,AMD,AME,AMP,AMS,AMV,ANT,ANV,APC,APF,APG,APH,API,APL,APP,APS,APT,ARM,ART,ASA,ASG,ASM,ASP,AST,ATA,ATB,ATG,ATS,AUM,AVC,AVF';
        const batch2 = 'BAB,BAF,BAL,BAX,BBC,BBH,BBM,BBS,BBT,BCA,BCB,BCC,BCE,BCF,BCG,BCM,BCP,BCV,BDB,BDG,BDT,BDW,BED,BEL,BFC,BGW,BHA,BHC,BHG,BHK,BHN,BHP,BHT,BIC,BID,BIG,BII,BIO,BKC,BKG,BKH,BLF,BLI,BLN,BLT,BLW,BMC,BMD,BMF,BMG,BMI,BMJ,BMN,BMP,BMS,BMV,BNA,BNW,BOT,BPC,BQB,BRC,BRR,BRS,BSA,BSC,BSD,BSG,BSH,BSI,BSL,BSP,BSQ,BSR,BST';
        const batch3 = 'BT1,BT6,BTB,BTD,BTG,BTH,BTN,BTP,BTS,BTT,BTU,BTV,BTW,BVB,BVG,BVH,BVL,BVN,BVS,BWA,BWE,BWS,BXH,C12,C21,C22,C32,C47,C4G,C69,C92,CAB,CAD,CAG,CAN,CAP,CAR,CAV,CBI,CBS,CC1,CC4,CCA,CCI,CCL,CCM,CCP,CCR,CCT,CCV,CDC,CDG,CDH,CDN,CDO,CDP,CDR,CE1,CEG,CEN,CEO,CET,CFM,CFV,CGV,CH5,CHC,CHP,CHS';
        const batch4 = 'CI5,CIA,CID,CIG,CII,CIP,CJC,CKA,CKD,CKG,CKV,CLC,CLG,CLH,CLL,CLM,CLW,CLX,CMC,CMD,CMF,CMG,CMI,CMK,CMM,CMN,CMP,CMS,CMT,CMV,CMW,CMX,CNA,CNC,CNG,CNN,CNT,COM,CPA,CPC,CPH,CPI,CQN,CQT,CRC,CRE,CSC,CSI,CSM,CST,CSV,CT3,CT6,CTA,CTB,CTC,CTD,CTF,CTG,CTI,CTN,CTP,CTR,CTS,CTT,CTW,CTX,CVN,CVP,CVT';
        const batch5 = 'D11,D2D,DAC,DAD,DAE,DAG,DAH,DAN,DAS,DAT,DBC,DBD,DBM,DBT,DBW,DC1,DC2,DC4,DCF,DCG,DCH,DCL,DCM,DCR,DCS,DCT,DDG,DDH,DDM,DDN,DDV,DFC,DFF,DGC,DGT,DGW,DHA,DHB,DHC,DHD,DHG,DHM,DHN,DHP,DHT,DIC,DID,DIG,DIH,DKC,DL1,DLD,DLG,DLR,DLT,DM7,DMC,DMN,DNA,DNC,DND,DNE,DNH,DNL,DNM,DNN,DNP,DNT,DNW';
        const batch6 = 'DOC,DOP,DP1,DP2,DP3,DPC,DPD,DPG,DPH,DPM,DPP,DPR,DPS,DQC,DRC,DRG,DRH,DRI,DRL,DS3,DSC,DSD,DSG,DSN,DSP,DST,DSV,DTA,DTB,DTC,DTD,DTE,DTG,DTH,DTI,DTK,DTL,DTP,DTT,DTV,DUS,DVC,DVG,DVM,DVN,DVP,DVW,DWC,DWS,DXG,DXL,DXP,DXS,DXV,DZM,E12,E29,EBS,ECI,EFI,EIB,EIC,EID,EIN,ELC,EMC,EME,EMG,EMS,EPC,EPH,EVE,EVF,EVG,EVS';
        const batch7 = 'FBA,FBC,FCC,FCM,FCN,FCS,FDC,FGL,FHN,FHS,FIC,FID,FIR,FIT,FLC,FMC,FOC,FOX,FPT,FRC,FRM,FRT,FSO,FT1,FTI,FTM,FTS,G20,G36,GAB,GAS,GCB,GCF,GDT,GDW,GE2,GEE,GEG,GER,GEX,GGG,GH3,GHC,GIC,GIL,GKM,GLC,GLT,GLW,GMA,GMC,GMD,GMH,GMX,GND,GSM,GSP,GTA,GTD,GTH,GTS,GTT,GVR,GVT,H11,HAC,HAD,HAF,HAG,HAH,HAI';
        const batch8 = 'HAM,HAN,HAP,HAR,HAS,HAT,HAV,HAX,HBC,HBD,HBH,HBS,HC1,HC3,HCB,HCC,HCD,HCI,HCM,HCT,HD2,HD6,HD8,HDA,HDB,HDC,HDG,HDM,HDO,HDP,HDW,HEC,HEJ,HEM,HEP,HES,HEV,HFB,HFC,HFX,HGM,HGT,HGW,HHC,HHG,HHN,HHP,HHR,HHS,HHV,HID,HIG,HII,HJC,HJS,HKB,HKP,HKT,HLA,HLB,HLC,HLD,HLG,HLR,HLS,HLT,HLY,HMC,HMG,HMH,HMR,HMS';
        const batch9 = 'HNA,HNB,HND,HNF,HNG,HNI,HNM,HNP,HNR,HOM,HOT,HPB,HPD,HPG,HPH,HPI,HPM,HPP,HPT,HPW,HPX,HQC,HRB,HRC,HRT,HSA,HSG,HSI,HSL,HSM,HSP,HSV,HT1,HTC,HTE,HTG,HTI,HTL,HTM,HTN,HTP,HTR,HTT,HTV,HTW,HU1,HU3,HU4,HU6,HUB,HUG,HUT,HVA,HVG,HVH,HVN,HVT,HVX,HWS,IBC,IBD,ICC,ICF,ICG,ICI,ICN,ICT,IDC,IDI,IDJ,IDP,IDV,IFS,IHK,IJC';
        const batch10 = 'ILA,ILB,ILC,ILS,IME,IMP,IN4,INC,INN,IPA,IRC,ISG,ISH,IST,ITA,ITC,ITD,ITQ,ITS,IVS,JOS,JVC,KAC,KBC,KCB,KCE,KDC,KDH,KDM,KGM,KHA,KHD,KHG,KHL,KHP,KHS,KHW,KIP,KKC,KLB,KLF,KLM,KMR,KMT,KOS,KPF,KSB,KSD,KSF,KSH,KSQ,KST,KSV,KTC,KTL,KTS,KTT,KVC,L10,L12,L14,L18,L35,L40,L43,L44,L45,L61,L62,L63,LAF,LAI,LAS,LAW,LBC,LBE,LBM';
        const batch11 = 'LCC,LCD,LCG,LCM,LCS,LCW,LDG,LDP,LDW,LEC,LG9,LGC,LGL,LGM,LHC,LHG,LIC,LIG,LIX,LKW,LLM,LM3,LM7,LM8,LMC,LMH,LMI,LNC,LO5,LPB,LPT,LQN,LSG,LSS,LTC,LTG,LUT,LWS,M10,MA1,MAC,MAS,MBB,MBG,MBN,MBS,MCC,MCD,MCF,MCG,MCH,MCI,MCM,MCO,MCP,MDA,MDC,MDF,MDG,MEC,MED,MEF,MEL,MES,MFS,MGC,MGG,MGR,MH3,MHC,MHL,MIC,MIE,MIG,MIM,MKP,MKV,MLC,MLS';
        const batch12 = 'MML,MNB,MND,MPC,MPT,MPY,MQB,MQN,MRF,MSB,MSH,MSN,MSR,MST,MTA,MTB,MTC,MTG,MTH,MTL,MTP,MTS,MTV,MVB,MVC,MVN,MWG,NAB,NAC,NAF,NAG,NAP,NAS,NAU,NAV,NAW,NBB,NBC,NBE,NBP,NBT,NBW,NCS,NCT,ND2,NDC,NDF,NDN,NDP,NDT,NDW,NDX,NED,NET,NFC,NGC,NHA,NHC,NHH,NHP,NHT,NHV,NJC,NKG,NLG,NLS,NNC,NNG,NNT,NO1,NOS,NQB,NQN,NQT,NRC,NS2,NSC,NSG,NSH,NSL,NSS,NST,NT2';
        const batch13 = 'NTB,NTC,NTF,NTH,NTL,NTP,NTT,NTW,NUE,NVB,NVL,NVP,NVT,NWT,NXT,OCB,OCH,ODE,OGC,OIL,ONE,ONW,OPC,ORS,PAC,PAI,PAN,PAP,PAS,PAT,PBC,PBP,PBT,PC1,PCC,PCE,PCF,PCG,PCH,PCM,PCN,PCT,PDB,PDC,PDN,PDR,PDV,PEC,PEG,PEN,PEQ,PET,PFL,PGB,PGC,PGD,PGI,PGN,PGS,PGT,PGV,PHC,PHH,PHN,PHP,PHR,PHS,PIA,PIC,PID,PIS,PIT,PIV,PJC,PJS,PJT,PLA,PLC,PLE,PLO,PLP,PLX';
        const batch14 = 'PMB,PMC,PMG,PMJ,PMP,PMS,PMT,PMW,PNC,PND,PNG,PNJ,PNP,PNT,POB,POM,POS,POT,POV,POW,PPC,PPE,PPH,PPI,PPP,PPS,PPT,PPY,PQN,PRC,PRE,PRO,PRT,PSB,PSC,PSD,PSE,PSG,PSH,PSI,PSL,PSN,PSP,PSW,PTB,PTC,PTD,PTE,PTG,PTH,PTI,PTL,PTN,PTO,PTP,PTS,PTT,PTV,PTX,PV2,PVA,PVB,PVC,PVD,PVE,PVG,PVH,PVI,PVL,PVM,PVO,PVP,PVR,PVS,PVT,PVV,PVX,PVY,PWA,PWS,PX1,PXA,PXC,PXI,PXL,PXM,PXS,PXT';
        const batch15 = 'QBS,QCC,QCG,QHD,QHW,QLT,QNC,QNS,QNT,QNU,QNW,QPH,QSP,QST,QTC,QTP,RAL,RAT,RBC,RCC,RCD,RCL,RDP,REE,RGC,RIC,RTB,S12,S27,S4A,S55,S72,S74,S96,S99,SAB,SAC,SAF,SAL,SAM,SAP,SAS,SAV,SB1,SBA,SBD,SBH,SBL,SBM,SBR,SBS,SBT,SBV,SC5,SCC,SCD,SCG,SCI,SCJ,SCL,SCO,SCR,SCS,SCY,SD1,SD2,SD3,SD4,SD5,SD6,SD7,SD8,SD9,SDA,SDB,SDC,SDD,SDG,SDJ,SDK,SDN,SDP,SDT,SDU,SDV,SDX,SDY,SEA,SEB,SED,SEP,SFC,SFG,SFI,SFN';
        const batch16 = 'SGB,SGC,SGD,SGH,SGI,SGN,SGO,SGP,SGR,SGS,SGT,SHA,SHB,SHC,SHE,SHG,SHI,SHN,SHP,SHS,SHX,SIC,SID,SIG,SII,SIP,SIV,SJ1,SJC,SJD,SJE,SJF,SJG,SJM,SJS,SKG,SKH,SKN,SKV,SLS,SMA,SMB,SMC,SMN,SMT,SNC,SNZ,SP2,SPB,SPC,SPD,SPH,SPI,SPM,SPP,SPV,SQC,SRA,SRB,SRC,SRF,SRT,SSB,SSC,SSF,SSG,SSH,SSI,SSM,SSN,ST8,STB,STC,STG,STH,STK,STL,STP,STS,STT,STW,SVC,SVD,SVG,SVH,SVI,SVN,SVT,SWC,SZB,SZC,SZE,SZG,SZL';
        const batch17 = 'TA3,TA6,TA9,TAG,TAN,TAR,TAW,TB8,TBC,TBD,TBH,TBR,TBT,TBX,TC6,TCB,TCD,TCH,TCI,TCJ,TCK,TCL,TCM,TCO,TCR,TCT,TCW,TCX,TDB,TDC,TDF,TDG,TDH,TDM,TDN,TDP,TDS,TDT,TDW,TED,TEG,TEL,TET,TFC,TGG,TGP,TH1,THB,THD,THG,THI,THN,THP,THS,THT,THU,THW,TID,TIE,TIG,TIN,TIP,TIS,TIX,TJC,TKA,TKC,TKG,TKU,TL4,TLD,TLG,TLH,TLI,TLP,TLT,TMB,TMC,TMG,TMP,TMS,TMT,TMW,TMX,TN1,TNA,TNB,TNC,TNG,TNH,TNI,TNM,TNP,TNS,TNT,TNW,TOP,TOS,TOT,TOW,TPB,TPC,TPH,TPP,TPS';
        const batch18 = 'TQN,TQW,TR1,TRA,TRC,TRS,TRT,TS3,TS4,TSB,TSC,TSD,TSG,TSJ,TST,TTA,TTB,TTC,TTD,TTE,TTF,TTG,TTH,TTL,TTN,TTP,TTS,TTT,TTZ,TUG,TV1,TV2,TV3,TV4,TV6,TVA,TVB,TVC,TVD,TVG,TVH,TVM,TVN,TVP,TVS,TVT,TVW,TW3,TXM,TYA,UCT,UDC,UDJ,UDL,UEM,UIC,UMC,UNI,UPC,UPH,USC,USD,V11,V12,V15,V21,VAB,VAF,VAT,VAV,VBB,VBC,VBG,VBH,VC1,VC2,VC3,VC5,VC6,VC7,VC9,VCA,VCK,VCB,VCC,VCE,VCF,VCG,VCI,VCM,VCP,VCR,VCS,VCT,VCW,VCX,VDB,VDL,VDN,VDP,VDS,VDT';
        const batch19 = 'VE1,VE2,VE3,VE4,VE8,VE9,VEA,VEC,VEF,VES,VET,VFC,VFG,VFR,VFS,VGC,VGG,VGI,VGL,VGP,VGR,VGS,VGT,VGV,VHC,VHD,VHE,VHF,VHG,VHH,VHL,VHM,VIB,VIC,VID,VIE,VIF,VIG,VIH,VIM,VIN,VIP,VIR,VIT,VIW,VIX,VJC,VKC,VKP,VLA,VLB,VLC,VLF,VLG,VLP,VLW,VMA,VMC,VMD,VMG,VMS,VNA,VNB,VNC,VND,VNE,VNF,VNG,VNH,VNI,VNL,VNM,VNP,VNR,VNS,VNT,VNX,VNY,VOC,VOS,VPA,VPB,VPC,VPD,VPG,VPH,VPI,VPL,VPR,VPS,VPW,VQC,VRC,VRE,VRG,VSA,VSC,VSE,VSF,VSG,VSH,VSI,VSM,VSN,VST';
        const batch20 = 'VTA,VTB,VTC,VTD,VTE,VTG,VTH,VTI,VTJ,VTK,VTL,VTM,VTO,VTP,VTQ,VTR,VTS,VTV,VTX,VTZ,VUA,VVN,VVS,VW3,VWS,VXB,VXP,VXT,WCS,WSB,WSS,WTC,X20,X26,X77,XDC,XDH,XHC,XLV,XMC,XMD,XMP,XPH,YBC,YBM,YEG,YTC';

        const batches = [batch1, batch2, batch3, batch4, batch5, batch6, batch7, batch8, batch9, batch10, batch11, batch12, batch13, batch14, batch15, batch16, batch17, batch18, batch19, batch20];

        // Fetch quotes in parallel batches (5 at a time to avoid rate limiting)
        for (let i = 0; i < batches.length; i += 5) {
            const chunk = batches.slice(i, i + 5);
            const promises = chunk.map(symbols =>
                fetchAPI(`${quotesUrl}?symbols=${symbols}`, authHeaders).catch(() => [])
            );
            const results = await Promise.all(promises);
            results.forEach(data => {
                if (Array.isArray(data)) allQuotes.push(...data);
            });
        }

        console.log(`📊 Fetched ${allQuotes.length} quotes with IndustryCode, ${Object.keys(ma10Map).length} MA10 entries`);

        // Build set các symbol thuộc custom themes (Cá tra, Tôm, Vingroup...).
        // Các mã này sẽ bị LOẠI khỏi ngành ICB2 (chỉ thuộc custom theme, không trùng lặp).
        const customThemeSymbols = new Set();
        Object.values(CUSTOM_THEMES).forEach(theme => {
            theme.symbols.forEach(sym => customThemeSymbols.add(sym));
        });

        // Group by ICB2 code using Quotes (has IndustryCode) + MA10 from TradingStatistic
        const industryGroups = {};

        allQuotes.forEach(quote => {
            if (!quote.Symbol) return;

            // Mã thuộc custom theme → LOẠI khỏi ngành ICB2 (chỉ thuộc custom theme)
            if (customThemeSymbols.has(quote.Symbol)) return;

            // Get ICB2 code (first 2 digits + "00")
            // Override cho các mã FireAnt phân loại sai (xem INDUSTRY_OVERRIDE)
            const industryCode = quote.IndustryCode || '';
            const icb2 = INDUSTRY_OVERRIDE[quote.Symbol] || (industryCode.substring(0, 2) + '00');

            if (!ICB2_MAP[icb2]) return;

            if (!industryGroups[icb2]) {
                industryGroups[icb2] = {
                    code: icb2,
                    name: ICB2_MAP[icb2],
                    stocks: [],
                    quotes: [], // FireAnt quote gốc để tính lucCau value-weighted
                    totalMarketCap: 0
                };
            }

            const priceCurrent = quote.PriceCurrent || 0;
            const ma10 = ma10Map[quote.Symbol] || 0;
            const sharesOutstanding = sharesMap[quote.Symbol] || 0;
            const marketCap = priceCurrent * sharesOutstanding;

            industryGroups[icb2].stocks.push({
                symbol: quote.Symbol,
                priceCurrent,
                ma10,
                aboveMA10: priceCurrent > ma10 && ma10 > 0,
                percentChange: quote.PricePercentChange ? quote.PricePercentChange * 100 : 0,
                marketCap
            });

            industryGroups[icb2].quotes.push(quote); // giữ nguyên để aggregateLucCauByValue lọc
            industryGroups[icb2].totalMarketCap += marketCap;
        });

        // Calculate stats for each industry
        const results = Object.values(industryGroups).map(group => {
            const totalStocks = group.stocks.length;
            const stocksAboveMA10 = group.stocks.filter(s => s.aboveMA10).length;
            const percentAboveMA10 = totalStocks > 0 ? (stocksAboveMA10 / totalStocks) * 100 : 0;

            // Calculate advances/declines/unchanged stats
            let upCount = 0;
            let downCount = 0;
            let flatCount = 0;
            group.stocks.forEach(s => {
                const change = s.percentChange || 0;
                if (change > 0) {
                    upCount++;
                } else if (change < 0) {
                    downCount++;
                } else {
                    flatCount++;
                }
            });

            // Lực cầu = activeBuyValue / totalValue × 100 (value-weighted)
            // Chỉ tính mã có TotalValue ≥ 100 triệu VND (loại mã rác/dorman)
            const { lucCau, liquidCount, filteredCount } = aggregateLucCauByValue(group.quotes);

            return {
                code: group.code,
                name: group.name,
                stockCount: totalStocks,
                liquidCount,         // số mã đủ thanh khoản (≥100tr GD) — dùng để tính lucCau
                filteredCount,       // số mã bị loại (vol=0 hoặc GD<100tr)
                percentAboveMA10: Math.round(percentAboveMA10 * 10) / 10,
                lucCau,              // null nếu không còn mã nào đủ ĐK
                upCount,
                downCount,
                flatCount,
                marketCap: group.totalMarketCap
            };
        }).filter(g => g.stockCount >= 1);

        results.sort((a, b) => b.stockCount - a.stockCount);

        // ═══ Custom themes: nhóm chủ đề tùy chỉnh (Cá tra, Tôm, Vingroup...) ═══
        // Tính lucCau/stats giống ngành ICB2 nhưng filter theo danh sách symbol.
        // allQuotes đã fetch ở trên (có IndustryCode, TotalValue, TotalVolume, ...).
        const quoteMap = {};
        allQuotes.forEach(q => { if (q.Symbol) quoteMap[q.Symbol] = q; });

        const ma10For = (sym) => ma10Map[sym] || 0;
        Object.entries(CUSTOM_THEMES).forEach(([themeCode, theme]) => {
            const themeStocks = [];
            const themeQuotes = [];
            let totalMarketCap = 0;

            theme.symbols.forEach(sym => {
                const quote = quoteMap[sym];
                if (!quote) return; // mã chưa fetch / IPO mới chưa trong batch
                const priceCurrent = quote.PriceCurrent || 0;
                const sharesOutstanding = sharesMap[sym] || 0;
                const marketCap = priceCurrent * sharesOutstanding;
                const ma10 = ma10For(sym);

                themeStocks.push({
                    symbol: sym,
                    priceCurrent,
                    ma10,
                    aboveMA10: priceCurrent > ma10 && ma10 > 0,
                    percentChange: quote.PricePercentChange ? quote.PricePercentChange * 100 : 0,
                    marketCap
                });
                themeQuotes.push(quote);
                totalMarketCap += marketCap;
            });

            if (themeStocks.length === 0) return; // theme rỗng (mã chưa fetch)

            const totalStocks = themeStocks.length;
            const stocksAboveMA10 = themeStocks.filter(s => s.aboveMA10).length;
            const percentAboveMA10 = totalStocks > 0 ? (stocksAboveMA10 / totalStocks) * 100 : 0;
            let upCount = 0, downCount = 0, flatCount = 0;
            themeStocks.forEach(s => {
                const change = s.percentChange || 0;
                if (change > 0) upCount++;
                else if (change < 0) downCount++;
                else flatCount++;
            });

            const { lucCau, liquidCount, filteredCount } = aggregateLucCauByValue(themeQuotes);

            results.push({
                code: themeCode,
                name: theme.name,
                stockCount: totalStocks,
                liquidCount,
                filteredCount,
                percentAboveMA10: Math.round(percentAboveMA10 * 10) / 10,
                lucCau,
                upCount,
                downCount,
                flatCount,
                marketCap: totalMarketCap,
                isCustomTheme: true   // flag để frontend phân biệt
            });
        });

        console.log(`✅ Industry stats: ${results.length} industries (gồm ${Object.keys(CUSTOM_THEMES).length} custom themes)`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            data: results
        };
        await setCachedResponse('industry-stats', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Industry stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/industry-top-stocks?code=8300&limit=7
 * Lấy top CP mạnh nhất trong ngành (lực cầu cao, giá trên MA10)
 */
app.get('/api/industry-top-stocks', async (req, res) => {
    try {
        const industryCode = req.query.code;

        if (!industryCode) {
            return res.status(400).json({ success: false, error: 'Missing industry code' });
        }

        console.log(`📊 Fetching all stocks for industry: ${industryCode}`);

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

        // Validate industryCode: phải là ICB2 code hợp lệ (trong ICB2_MAP)
        // HOẶC custom theme code (bắt đầu 'CT:' + có trong CUSTOM_THEMES)
        const isCustomTheme = industryCode && industryCode.startsWith('CT:');
        if (!isCustomTheme && !ICB2_MAP[industryCode]) {
            return res.status(400).json({ success: false, error: 'Invalid industry code' });
        }
        if (isCustomTheme && !CUSTOM_THEMES[industryCode]) {
            return res.status(400).json({ success: false, error: 'Unknown custom theme: ' + industryCode });
        }

        // Get cookie for authenticated requests
        const cookie = await getFireAntCookie();
        const authHeaders = {
            ...API_CONFIG.fireant.headers,
            'Cookie': cookie,
            'Accept-Encoding': 'gzip, deflate',
            'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
        };

        const tradingUrl = `${API_CONFIG.fireant.base}/Markets/TradingStatistic`;
        const quotesUrl = `${API_CONFIG.fireant.base}/Markets/Quotes`;

        // Fetch TradingStatistic for MA10
        const tradingData = await fetchAPI(tradingUrl, authHeaders).catch(() => []);

        if (!tradingData || !tradingData.length) {
            return res.json({ success: false, error: 'No trading data' });
        }

        // Build MA10 map from TradingStatistic
        const ma10Map = {};
        tradingData.forEach(stock => {
            if (stock.Symbol) {
                ma10Map[stock.Symbol] = stock.AvgPrice10d || 0;
            }
        });

        // Fetch ALL quotes in batches
        const allQuotes = [];
        const batch1 = 'A32,AAA,AAM,AAS,AAT,AAV,ABB,ABC,ABI,ABR,ABS,ABT,ACB,ACC,ACE,ACG,ACL,ACM,ACS,ACV,ADC,ADG,ADP,ADS,AFX,AG1,AGE,AGF,AGG,AGM,AGP,AGR,AGX,AIC,ALT,ALV,AMC,AMD,AME,AMP,AMS,AMV,ANT,ANV,APC,APF,APG,APH,API,APL,APP,APS,APT,ARM,ART,ASA,ASG,ASM,ASP,AST,ATA,ATB,ATG,ATS,AUM,AVC,AVF';
        const batch2 = 'BAB,BAF,BAL,BAX,BBC,BBH,BBM,BBS,BBT,BCA,BCB,BCC,BCE,BCF,BCG,BCM,BCP,BCV,BDB,BDG,BDT,BDW,BED,BEL,BFC,BGW,BHA,BHC,BHG,BHK,BHN,BHP,BHT,BIC,BID,BIG,BII,BIO,BKC,BKG,BKH,BLF,BLI,BLN,BLT,BLW,BMC,BMD,BMF,BMG,BMI,BMJ,BMN,BMP,BMS,BMV,BNA,BNW,BOT,BPC,BQB,BRC,BRR,BRS,BSA,BSC,BSD,BSG,BSH,BSI,BSL,BSP,BSQ,BSR,BST';
        const batch3 = 'BT1,BT6,BTB,BTD,BTG,BTH,BTN,BTP,BTS,BTT,BTU,BTV,BTW,BVB,BVG,BVH,BVL,BVN,BVS,BWA,BWE,BWS,BXH,C12,C21,C22,C32,C47,C4G,C69,C92,CAB,CAD,CAG,CAN,CAP,CAR,CAV,CBI,CBS,CC1,CC4,CCA,CCI,CCL,CCM,CCP,CCR,CCT,CCV,CDC,CDG,CDH,CDN,CDO,CDP,CDR,CE1,CEG,CEN,CEO,CET,CFM,CFV,CGV,CH5,CHC,CHP,CHS';
        const batch4 = 'CI5,CIA,CID,CIG,CII,CIP,CJC,CKA,CKD,CKG,CKV,CLC,CLG,CLH,CLL,CLM,CLW,CLX,CMC,CMD,CMF,CMG,CMI,CMK,CMM,CMN,CMP,CMS,CMT,CMV,CMW,CMX,CNA,CNC,CNG,CNN,CNT,COM,CPA,CPC,CPH,CPI,CQN,CQT,CRC,CRE,CSC,CSI,CSM,CST,CSV,CT3,CT6,CTA,CTB,CTC,CTD,CTF,CTG,CTI,CTN,CTP,CTR,CTS,CTT,CTW,CTX,CVN,CVP,CVT';
        const batch5 = 'D11,D2D,DAC,DAD,DAE,DAG,DAH,DAN,DAS,DAT,DBC,DBD,DBM,DBT,DBW,DC1,DC2,DC4,DCF,DCG,DCH,DCL,DCM,DCR,DCS,DCT,DDG,DDH,DDM,DDN,DDV,DFC,DFF,DGC,DGT,DGW,DHA,DHB,DHC,DHD,DHG,DHM,DHN,DHP,DHT,DIC,DID,DIG,DIH,DKC,DL1,DLD,DLG,DLR,DLT,DM7,DMC,DMN,DNA,DNC,DND,DNE,DNH,DNL,DNM,DNN,DNP,DNT,DNW';
        const batch6 = 'DOC,DOP,DP1,DP2,DP3,DPC,DPD,DPG,DPH,DPM,DPP,DPR,DPS,DQC,DRC,DRG,DRH,DRI,DRL,DS3,DSC,DSD,DSG,DSN,DSP,DST,DSV,DTA,DTB,DTC,DTD,DTE,DTG,DTH,DTI,DTK,DTL,DTP,DTT,DTV,DUS,DVC,DVG,DVM,DVN,DVP,DVW,DWC,DWS,DXG,DXL,DXP,DXS,DXV,DZM,E12,E29,EBS,ECI,EFI,EIB,EIC,EID,EIN,ELC,EMC,EME,EMG,EMS,EPC,EPH,EVE,EVF,EVG,EVS';
        const batch7 = 'FBA,FBC,FCC,FCM,FCN,FCS,FDC,FGL,FHN,FHS,FIC,FID,FIR,FIT,FLC,FMC,FOC,FOX,FPT,FRC,FRM,FRT,FSO,FT1,FTI,FTM,FTS,G20,G36,GAB,GAS,GCB,GCF,GDT,GDW,GE2,GEE,GEG,GER,GEX,GGG,GH3,GHC,GIC,GIL,GKM,GLC,GLT,GLW,GMA,GMC,GMD,GMH,GMX,GND,GSM,GSP,GTA,GTD,GTH,GTS,GTT,GVR,GVT,H11,HAC,HAD,HAF,HAG,HAH,HAI';
        const batch8 = 'HAM,HAN,HAP,HAR,HAS,HAT,HAV,HAX,HBC,HBD,HBH,HBS,HC1,HC3,HCB,HCC,HCD,HCI,HCM,HCT,HD2,HD6,HD8,HDA,HDB,HDC,HDG,HDM,HDO,HDP,HDW,HEC,HEJ,HEM,HEP,HES,HEV,HFB,HFC,HFX,HGM,HGT,HGW,HHC,HHG,HHN,HHP,HHR,HHS,HHV,HID,HIG,HII,HJC,HJS,HKB,HKP,HKT,HLA,HLB,HLC,HLD,HLG,HLR,HLS,HLT,HLY,HMC,HMG,HMH,HMR,HMS';
        const batch9 = 'HNA,HNB,HND,HNF,HNG,HNI,HNM,HNP,HNR,HOM,HOT,HPB,HPD,HPG,HPH,HPI,HPM,HPP,HPT,HPW,HPX,HQC,HRB,HRC,HRT,HSA,HSG,HSI,HSL,HSM,HSP,HSV,HT1,HTC,HTE,HTG,HTI,HTL,HTM,HTN,HTP,HTR,HTT,HTV,HTW,HU1,HU3,HU4,HU6,HUB,HUG,HUT,HVA,HVG,HVH,HVN,HVT,HVX,HWS,IBC,IBD,ICC,ICF,ICG,ICI,ICN,ICT,IDC,IDI,IDJ,IDP,IDV,IFS,IHK,IJC';
        const batch10 = 'ILA,ILB,ILC,ILS,IME,IMP,IN4,INC,INN,IPA,IRC,ISG,ISH,IST,ITA,ITC,ITD,ITQ,ITS,IVS,JOS,JVC,KAC,KBC,KCB,KCE,KDC,KDH,KDM,KGM,KHA,KHD,KHG,KHL,KHP,KHS,KHW,KIP,KKC,KLB,KLF,KLM,KMR,KMT,KOS,KPF,KSB,KSD,KSF,KSH,KSQ,KST,KSV,KTC,KTL,KTS,KTT,KVC,L10,L12,L14,L18,L35,L40,L43,L44,L45,L61,L62,L63,LAF,LAI,LAS,LAW,LBC,LBE,LBM';
        const batch11 = 'LCC,LCD,LCG,LCM,LCS,LCW,LDG,LDP,LDW,LEC,LG9,LGC,LGL,LGM,LHC,LHG,LIC,LIG,LIX,LKW,LLM,LM3,LM7,LM8,LMC,LMH,LMI,LNC,LO5,LPB,LPT,LQN,LSG,LSS,LTC,LTG,LUT,LWS,M10,MA1,MAC,MAS,MBB,MBG,MBN,MBS,MCC,MCD,MCF,MCG,MCH,MCI,MCM,MCO,MCP,MDA,MDC,MDF,MDG,MEC,MED,MEF,MEL,MES,MFS,MGC,MGG,MGR,MH3,MHC,MHL,MIC,MIE,MIG,MIM,MKP,MKV,MLC,MLS';
        const batch12 = 'MML,MNB,MND,MPC,MPT,MPY,MQB,MQN,MRF,MSB,MSH,MSN,MSR,MST,MTA,MTB,MTC,MTG,MTH,MTL,MTP,MTS,MTV,MVB,MVC,MVN,MWG,NAB,NAC,NAF,NAG,NAP,NAS,NAU,NAV,NAW,NBB,NBC,NBE,NBP,NBT,NBW,NCS,NCT,ND2,NDC,NDF,NDN,NDP,NDT,NDW,NDX,NED,NET,NFC,NGC,NHA,NHC,NHH,NHP,NHT,NHV,NJC,NKG,NLG,NLS,NNC,NNG,NNT,NO1,NOS,NQB,NQN,NQT,NRC,NS2,NSC,NSG,NSH,NSL,NSS,NST,NT2';
        const batch13 = 'NTB,NTC,NTF,NTH,NTL,NTP,NTT,NTW,NUE,NVB,NVL,NVP,NVT,NWT,NXT,OCB,OCH,ODE,OGC,OIL,ONE,ONW,OPC,ORS,PAC,PAI,PAN,PAP,PAS,PAT,PBC,PBP,PBT,PC1,PCC,PCE,PCF,PCG,PCH,PCM,PCN,PCT,PDB,PDC,PDN,PDR,PDV,PEC,PEG,PEN,PEQ,PET,PFL,PGB,PGC,PGD,PGI,PGN,PGS,PGT,PGV,PHC,PHH,PHN,PHP,PHR,PHS,PIA,PIC,PID,PIS,PIT,PIV,PJC,PJS,PJT,PLA,PLC,PLE,PLO,PLP,PLX';
        const batch14 = 'PMB,PMC,PMG,PMJ,PMP,PMS,PMT,PMW,PNC,PND,PNG,PNJ,PNP,PNT,POB,POM,POS,POT,POV,POW,PPC,PPE,PPH,PPI,PPP,PPS,PPT,PPY,PQN,PRC,PRE,PRO,PRT,PSB,PSC,PSD,PSE,PSG,PSH,PSI,PSL,PSN,PSP,PSW,PTB,PTC,PTD,PTE,PTG,PTH,PTI,PTL,PTN,PTO,PTP,PTS,PTT,PTV,PTX,PV2,PVA,PVB,PVC,PVD,PVE,PVG,PVH,PVI,PVL,PVM,PVO,PVP,PVR,PVS,PVT,PVV,PVX,PVY,PWA,PWS,PX1,PXA,PXC,PXI,PXL,PXM,PXS,PXT';
        const batch15 = 'QBS,QCC,QCG,QHD,QHW,QLT,QNC,QNS,QNT,QNU,QNW,QPH,QSP,QST,QTC,QTP,RAL,RAT,RBC,RCC,RCD,RCL,RDP,REE,RGC,RIC,RTB,S12,S27,S4A,S55,S72,S74,S96,S99,SAB,SAC,SAF,SAL,SAM,SAP,SAS,SAV,SB1,SBA,SBD,SBH,SBL,SBM,SBR,SBS,SBT,SBV,SC5,SCC,SCD,SCG,SCI,SCJ,SCL,SCO,SCR,SCS,SCY,SD1,SD2,SD3,SD4,SD5,SD6,SD7,SD8,SD9,SDA,SDB,SDC,SDD,SDG,SDJ,SDK,SDN,SDP,SDT,SDU,SDV,SDX,SDY,SEA,SEB,SED,SEP,SFC,SFG,SFI,SFN';
        const batch16 = 'SGB,SGC,SGD,SGH,SGI,SGN,SGO,SGP,SGR,SGS,SGT,SHA,SHB,SHC,SHE,SHG,SHI,SHN,SHP,SHS,SHX,SIC,SID,SIG,SII,SIP,SIV,SJ1,SJC,SJD,SJE,SJF,SJG,SJM,SJS,SKG,SKH,SKN,SKV,SLS,SMA,SMB,SMC,SMN,SMT,SNC,SNZ,SP2,SPB,SPC,SPD,SPH,SPI,SPM,SPP,SPV,SQC,SRA,SRB,SRC,SRF,SRT,SSB,SSC,SSF,SSG,SSH,SSI,SSM,SSN,ST8,STB,STC,STG,STH,STK,STL,STP,STS,STT,STW,SVC,SVD,SVG,SVH,SVI,SVN,SVT,SWC,SZB,SZC,SZE,SZG,SZL';
        const batch17 = 'TA3,TA6,TA9,TAG,TAN,TAR,TAW,TB8,TBC,TBD,TBH,TBR,TBT,TBX,TC6,TCB,TCD,TCH,TCI,TCJ,TCK,TCL,TCM,TCO,TCR,TCT,TCW,TCX,TDB,TDC,TDF,TDG,TDH,TDM,TDN,TDP,TDS,TDT,TDW,TED,TEG,TEL,TET,TFC,TGG,TGP,TH1,THB,THD,THG,THI,THN,THP,THS,THT,THU,THW,TID,TIE,TIG,TIN,TIP,TIS,TIX,TJC,TKA,TKC,TKG,TKU,TL4,TLD,TLG,TLH,TLI,TLP,TLT,TMB,TMC,TMG,TMP,TMS,TMT,TMW,TMX,TN1,TNA,TNB,TNC,TNG,TNH,TNI,TNM,TNP,TNS,TNT,TNW,TOP,TOS,TOT,TOW,TPB,TPC,TPH,TPP,TPS';
        const batch18 = 'TQN,TQW,TR1,TRA,TRC,TRS,TRT,TS3,TS4,TSB,TSC,TSD,TSG,TSJ,TST,TTA,TTB,TTC,TTD,TTE,TTF,TTG,TTH,TTL,TTN,TTP,TTS,TTT,TTZ,TUG,TV1,TV2,TV3,TV4,TV6,TVA,TVB,TVC,TVD,TVG,TVH,TVM,TVN,TVP,TVS,TVT,TVW,TW3,TXM,TYA,UCT,UDC,UDJ,UDL,UEM,UIC,UMC,UNI,UPC,UPH,USC,USD,V11,V12,V15,V21,VAB,VAF,VAT,VAV,VBB,VBC,VBG,VBH,VC1,VC2,VC3,VC5,VC6,VC7,VC9,VCA,VCK,VCB,VCC,VCE,VCF,VCG,VCI,VCM,VCP,VCR,VCS,VCT,VCW,VCX,VDB,VDL,VDN,VDP,VDS,VDT';
        const batch19 = 'VE1,VE2,VE3,VE4,VE8,VE9,VEA,VEC,VEF,VES,VET,VFC,VFG,VFR,VFS,VGC,VGG,VGI,VGL,VGP,VGR,VGS,VGT,VGV,VHC,VHD,VHE,VHF,VHG,VHH,VHL,VHM,VIB,VIC,VID,VIE,VIF,VIG,VIH,VIM,VIN,VIP,VIR,VIT,VIW,VIX,VJC,VKC,VKP,VLA,VLB,VLC,VLF,VLG,VLP,VLW,VMA,VMC,VMD,VMG,VMS,VNA,VNB,VNC,VND,VNE,VNF,VNG,VNH,VNI,VNL,VNM,VNP,VNR,VNS,VNT,VNX,VNY,VOC,VOS,VPA,VPB,VPC,VPD,VPG,VPH,VPI,VPL,VPR,VPS,VPW,VQC,VRC,VRE,VRG,VSA,VSC,VSE,VSF,VSG,VSH,VSI,VSM,VSN,VST';
        const batch20 = 'VTA,VTB,VTC,VTD,VTE,VTG,VTH,VTI,VTJ,VTK,VTL,VTM,VTO,VTP,VTQ,VTR,VTS,VTV,VTX,VTZ,VUA,VVN,VVS,VW3,VWS,VXB,VXP,VXT,WCS,WSB,WSS,WTC,X20,X26,X77,XDC,XDH,XHC,XLV,XMC,XMD,XMP,XPH,YBC,YBM,YEG,YTC';

        const batches = [batch1, batch2, batch3, batch4, batch5, batch6, batch7, batch8, batch9, batch10, batch11, batch12, batch13, batch14, batch15, batch16, batch17, batch18, batch19, batch20];

        // Fetch quotes in parallel batches (5 at a time)
        for (let i = 0; i < batches.length; i += 5) {
            const chunk = batches.slice(i, i + 5);
            const promises = chunk.map(symbols =>
                fetchAPI(`${quotesUrl}?symbols=${symbols}`, authHeaders).catch(() => [])
            );
            const results = await Promise.all(promises);
            results.forEach(data => {
                if (Array.isArray(data)) allQuotes.push(...data);
            });
        }

        // Filter ALL stocks by industry code and calculate lucCau per stock (value-weighted)
        // isCustomTheme đã xác định ở validation trên. Custom theme → filter theo danh sách
        // symbol trong theme, ICB2 → filter theo prefix.
        const themeSymbols = isCustomTheme && CUSTOM_THEMES[industryCode]
            ? new Set(CUSTOM_THEMES[industryCode].symbols)
            : null;
        // Set tất cả symbol thuộc custom themes — dùng để LOẠI khỏi ngành ICB2
        // (mã thuộc custom theme không còn hiện ở ngành ICB2 cũ)
        const allCustomThemeSymbols = new Set();
        Object.values(CUSTOM_THEMES).forEach(t => t.symbols.forEach(s => allCustomThemeSymbols.add(s)));
        const icb2Prefix = isCustomTheme ? null : industryCode.substring(0, 2);
        const industryStocks = []; // chỉ mã đủ thanh khoản (≥100tr GD)
        let countAboveMA10 = 0;
        let totalStocks = 0;     // tổng mã trong ngành (kể cả bị loại)
        let filteredCount = 0;   // mã bị loại (vol=0 hoặc GD<100tr)

        allQuotes.forEach(quote => {
            if (!quote.Symbol) return;

            if (isCustomTheme) {
                // Custom theme: chỉ lấy mã trong danh sách symbols của theme
                if (!themeSymbols.has(quote.Symbol)) return;
            } else {
                // ICB2 ngành: loại mã đã thuộc custom theme (chỉ thuộc 1 nhóm)
                if (allCustomThemeSymbols.has(quote.Symbol)) return;
                // Filter theo prefix (có override cho mã FireAnt sai)
                const stockIndustryCode = INDUSTRY_OVERRIDE[quote.Symbol]
                    ? INDUSTRY_OVERRIDE[quote.Symbol].substring(0, 2)
                    : (quote.IndustryCode || '').substring(0, 2);
                if (stockIndustryCode !== icb2Prefix) return;
            }
            totalStocks++;

            const priceCurrent = quote.PriceCurrent || 0;
            const ma10 = ma10Map[quote.Symbol] || 0;
            const totalVol = quote.TotalVolume || 0;
            const totalValue = quote.TotalValue || 0;

            // Lọc thanh khoản + nhiễu:
            // - GTGD < 100 triệu hoặc Volume < 30k CP → loại (mã rác/dorman)
            // - lucCau > 80% → loại (outlier, 1 lệnh mua trúng ceiling)
            const lucCau = computeLucCauByValue(quote);
            if (lucCau === null) { filteredCount++; return; }  // không đủ ĐK hoặc > 80%
            const aboveMA10 = ma10 > 0 && priceCurrent > ma10;
            if (aboveMA10) countAboveMA10++;

            industryStocks.push({
                symbol: quote.Symbol,
                price: priceCurrent,
                ma10: ma10,
                aboveMA10: aboveMA10,
                lucCau: lucCau,  // luôn có giá trị (đã filter), null chỉ khi totalValue=0 hiếm
                totalVolume: totalVol,
                totalValue: totalValue,
                activeBuyVolume: quote.TotalActiveBuyVolume || 0,
                percentChange: quote.PricePercentChange ? parseFloat((quote.PricePercentChange * 100).toFixed(2)) : 0
            });
        });

        // Sort: aboveMA10 first, then by lucCau descending (null cuối)
        industryStocks.sort((a, b) => {
            if (a.aboveMA10 !== b.aboveMA10) return b.aboveMA10 - a.aboveMA10;
            const la = a.lucCau == null ? -1 : a.lucCau;
            const lb = b.lucCau == null ? -1 : b.lucCau;
            return lb - la;
        });

        // Industry name: custom theme lấy từ CUSTOM_THEMES, ICB2 lấy từ ICB2_MAP
        const industryName = isCustomTheme && CUSTOM_THEMES[industryCode]
            ? CUSTOM_THEMES[industryCode].name
            : ICB2_MAP[industryCode];

        console.log(`✅ Industry ${industryCode} (${industryName}): ${totalStocks} mã tổng, ${industryStocks.length} đủ thanh khoản, ${filteredCount} bị loại, ${countAboveMA10} trên MA10`);

        res.json({
            success: true,
            industryCode: industryCode,
            industryName: industryName,
            totalStocks: totalStocks,            // tổng mã trong ngành
            liquidCount: industryStocks.length,  // mã đủ thanh khoản (hiện trên bảng)
            filteredCount: filteredCount,        // mã bị ẩn (vol thấp)
            totalAboveMA10: countAboveMA10,
            stocks: industryStocks,
            isCustomTheme: isCustomTheme
        });
    } catch (error) {
        console.error('Industry top stocks error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/industry-top-flow?code=8300&top=5
 * Lấy top mã MUA RÒNG / BÁN RÒNG theo dòng tiền lớn (TC+TD+NN) trong 1 ngành,
 * cho phiên gần nhất. Dùng FireAnt Quotes để lọc mã theo ngành + Fiintrade
 * GetPriceData để lấy dòng tiền 4 nhóm per mã.
 *
 * Query: code (ICB2), top (số mã top mỗi bên, mặc định 5)
 * Response: { success, industryCode, industryName, date, topBuy:[], topSell:[], allStocks }
 */
app.get('/api/industry-top-flow', async (req, res) => {
    req.setTimeout(120000); // job nặng: gọi Fiintrade từng mã
    const industryCode = req.query.code;
    const top = parseInt(req.query.top) || 5;

    const ICB2_MAP = {
        '0500':'Dầu khí','1300':'Hóa chất','1700':'Tài nguyên cơ bản','2300':'Xây dựng và VLXD',
        '2700':'Sản phẩm & DV công nghiệp','3300':'Ôtô và linh kiện','3500':'Thực phẩm và đồ uống',
        '3700':'Hàng tiêu dùng','4500':'Y tế','5300':'Bán lẻ','5500':'Truyền thông',
        '5700':'Du lịch và giải trí','6500':'Viễn thông','7500':'Các dịch vụ hạ tầng',
        '8300':'Ngân hàng','8500':'Bảo hiểm','8600':'Bất động sản','8700':'Dịch vụ tài chính',
        '8900':'Quỹ','9500':'Công nghệ'
    };

    if (!industryCode || !ICB2_MAP[industryCode]) {
        return res.status(400).json({ success: false, error: 'Invalid or missing industry code' });
    }

    try {
        // 1. Lấy danh sách mã trong ngành qua FireAnt Quotes
        const cookie = await getFireAntCookie();
        const authHeaders = {
            ...API_CONFIG.fireant.headers,
            'Cookie': cookie,
            'Accept-Encoding': 'gzip, deflate'
        };
        const batches = require('./breadth-symbols');
        const icb2Prefix = industryCode.substring(0, 2);
        const sectorTickers = [];
        for (let i = 0; i < batches.length; i += 5) {
            const chunk = batches.slice(i, i + 5);
            const proms = chunk.map(s =>
                fetchAPI(`${API_CONFIG.fireant.base}/Markets/Quotes?symbols=${s}`, authHeaders).catch(() => [])
            );
            const responses = await Promise.all(proms);
            responses.forEach(arr => {
                if (Array.isArray(arr)) {
                    arr.forEach(q => {
                        if (!q || !q.Symbol) return;
                        // Override IndustryCode cho mã FireAnt phân loại sai (xem INDUSTRY_OVERRIDE)
                        const prefix = INDUSTRY_OVERRIDE[q.Symbol]
                            ? INDUSTRY_OVERRIDE[q.Symbol].substring(0, 2)
                            : (q.IndustryCode || '').substring(0, 2);
                        if (prefix === icb2Prefix) {
                            sectorTickers.push(q.Symbol);
                        }
                    });
                }
            });
        }

        if (sectorTickers.length === 0) {
            return res.json({ success: false, error: 'Không tìm thấy mã nào trong ngành này' });
        }

        console.log(`📊 [industry-top-flow] ${ICB2_MAP[industryCode]}: ${sectorTickers.length} mã, đang tải dòng tiền...`);

        // 2. Gọi Fiintrade GetPriceData từng mã (batch 10 song song)
        // days: số phiên gần nhất cần giữ (1=1D, 5=5D, 20=20D, YTD→20 cho gọn)
        const reqDays = parseInt(req.query.days) || 1;
        const days = Math.max(1, Math.min(reqDays, 20));
        const flows = await fiintrade.getSectorTopStocksFlow(sectorTickers, 10, null, days);
        const date = flows.length > 0 ? flows[0].date : null;
        // Danh sách N ngày (cũ → mới) — lấy từ mã đầu có data
        const dates = flows.length > 0 && flows[0].days ? flows[0].days.map(d => d.date) : (date ? [date] : []);

        // 3. Top mua ròng / bán ròng theo netSmart CỘNG DỒN N ngày (netSmartCum)
        const sorted = flows.slice().sort((a, b) => b.netSmartCum - a.netSmartCum);
        const topBuy = sorted.filter(s => s.netSmartCum > 0).slice(0, top);
        const topSell = sorted.filter(s => s.netSmartCum < 0).reverse().slice(0, top);

        console.log(`✅ [industry-top-flow] ${ICB2_MAP[industryCode]}: days=${days}, topBuy=${topBuy.length}, topSell=${topSell.length}, date=${date}`);

        res.json({
            success: true,
            industryCode,
            industryName: ICB2_MAP[industryCode],
            date,
            dates,           // danh sách N phiên (cũ → mới)
            days,
            totalStocks: sectorTickers.length,
            stocksWithData: flows.length,
            topBuy,
            topSell,
            allStocks: sorted
        });
    } catch (error) {
        console.error('Industry top flow error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/marketcap-stats
 * Tính % CP > MA10 và Lực Cầu theo nhóm vốn hóa cho Bubble Chart
 */
app.get('/api/marketcap-stats', async (req, res) => {
    // Cache 60 seconds - heavy endpoint
    const cached = await getCachedResponse('marketcap-stats', 60000);
    if (cached) {
        console.log('📊 Returning cached marketcap-stats data');
        return res.json(cached);
    }
    try {
        console.log('📊 Calculating market cap stats for bubble chart...');

        const tradingUrl = `${API_CONFIG.fireant.base}/Markets/TradingStatistic`;
        const quotesUrl = `${API_CONFIG.fireant.base}/Markets/Quotes`;

        // Get cookie for authenticated requests
        const cookie = await getFireAntCookie();
        const authHeaders = {
            ...API_CONFIG.fireant.headers,
            'Cookie': cookie,
            'Accept-Encoding': 'gzip, deflate',
            'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
        };

        const symbols = 'AAA,ACB,AGG,AGR,ANV,BCG,BCM,BID,BVH,CTG,DGC,DGW,DIG,DPM,DXG,EIB,FPT,GAS,GEX,GMD,GVR,HAG,HCM,HDB,HDG,HPG,HSG,HVN,KBC,KDH,KDC,LPB,MBB,MSB,MSN,MWG,NLG,NVL,OCB,PDR,PHR,PLX,PNJ,POW,PVD,PVS,REE,SAB,SBT,SHB,SSI,STB,TCB,TCH,TPB,VCB,VHC,VHM,VIB,VIC,VJC,VND,VNM,VPB,VRE';

        const [tradingData, quotesResponse] = await Promise.all([
            fetchAPI(tradingUrl, authHeaders).catch(() => []),
            fetchAPI(`${quotesUrl}?symbols=${symbols}`, authHeaders).catch(() => [])
        ]);

        if (!tradingData || !tradingData.length) {
            return res.json({ success: false, error: 'No trading data' });
        }

        // Market cap groups (in VND)
        const MARKET_CAP_GROUPS = {
            'Small': { min: 0, max: 1e12, label: 'Small', color: '#9966FF' },
            'Mid': { min: 1e12, max: 20e12, label: 'Mid', color: '#4BC0C0' },
            'Large': { min: 20e12, max: 100e12, label: 'Large', color: '#36A2EB' },
            'Super Large': { min: 100e12, max: Infinity, label: 'Super Large', color: '#FFCE56' }
        };

        const groups = {
            'Small': { stocks: [], quotes: [] },
            'Mid': { stocks: [], quotes: [] },
            'Large': { stocks: [], quotes: [] },
            'Super Large': { stocks: [], quotes: [] }
        };

        tradingData.forEach(stock => {
            if (!stock.Symbol || stock.Symbol.length !== 3) return;

            const quoteData = quotesResponse?.find(q => q.Symbol === stock.Symbol);

            const priceCurrent = quoteData?.PriceCurrent || stock.LastPriceClose || 0;
            const sharesOutStanding = stock.SharesOutStanding || 0;
            const marketCap = priceCurrent * sharesOutStanding;
            const ma10 = stock.AvgPrice10d || 0;

            // Determine group
            let groupName = 'Small';
            if (marketCap >= 100e12) groupName = 'Super Large';
            else if (marketCap >= 20e12) groupName = 'Large';
            else if (marketCap >= 1e12) groupName = 'Mid';

            groups[groupName].stocks.push({
                symbol: stock.Symbol,
                marketCap,
                priceCurrent,
                ma10,
                aboveMA10: priceCurrent > ma10 && ma10 > 0
            });

            // Lưu quote gốc để aggregate lucCau value-weighted (cần TotalValue/PriceAverage/TotalActiveBuyVolume)
            if (quoteData) groups[groupName].quotes.push(quoteData);
        });

        // Calculate stats for each group
        const results = Object.entries(groups).map(([name, group]) => {
            const totalStocks = group.stocks.length;
            const stocksAboveMA10 = group.stocks.filter(s => s.aboveMA10).length;
            const percentAboveMA10 = totalStocks > 0 ? (stocksAboveMA10 / totalStocks) * 100 : 0;

            // Lực cầu = activeBuyValue / totalValue × 100 (value-weighted, lọc thanh khoản ≥100tr)
            const { lucCau, liquidCount, filteredCount } = aggregateLucCauByValue(group.quotes);

            return {
                name,
                label: MARKET_CAP_GROUPS[name].label,
                color: MARKET_CAP_GROUPS[name].color,
                stockCount: totalStocks,
                liquidCount,
                filteredCount,
                percentAboveMA10: Math.round(percentAboveMA10 * 10) / 10,
                lucCau
            };
        });

        console.log(`✅ Market cap stats: ${results.length} groups`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            data: results
        };
        await setCachedResponse('marketcap-stats', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Market cap stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/marketcap-top-stocks?group=Super Large
 * Lấy danh sách CP trong nhóm vốn hóa (khi click bubble)
 */
app.get('/api/marketcap-top-stocks', async (req, res) => {
    try {
        const groupName = req.query.group;
        if (!groupName) {
            return res.status(400).json({ success: false, error: 'Missing group parameter' });
        }

        console.log(`📊 [marketcap-top-stocks] Fetching stocks for group: ${groupName}`);

        const tradingUrl = `${API_CONFIG.fireant.base}/Markets/TradingStatistic`;
        const quotesUrl = `${API_CONFIG.fireant.base}/Markets/Quotes`;

        const cookie = await getFireAntCookie();
        const authHeaders = {
            ...API_CONFIG.fireant.headers,
            'Cookie': cookie,
            'Accept-Encoding': 'gzip, deflate',
            'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
        };

        // Fetch ALL trading data (not just top 65)
        const tradingData = await fetchAPI(tradingUrl, authHeaders).catch(() => []);

        if (!tradingData || !tradingData.length) {
            return res.json({ success: false, error: 'No trading data' });
        }

        // Collect all symbols for quotes fetch
        const allSymbols = tradingData
            .filter(s => s.Symbol && s.Symbol.length === 3)
            .map(s => s.Symbol);

        // Fetch quotes in batches
        const allQuotes = [];
        const batchSize = 65;
        for (let i = 0; i < allSymbols.length; i += batchSize) {
            const chunk = allSymbols.slice(i, i + batchSize).join(',');
            const data = await fetchAPI(`${quotesUrl}?symbols=${chunk}`, authHeaders).catch(() => []);
            if (Array.isArray(data)) allQuotes.push(...data);
        }

        // Build quote map
        const quoteMap = {};
        allQuotes.forEach(q => {
            if (q.Symbol) quoteMap[q.Symbol] = q;
        });

        // Market cap thresholds (sort TĂNG dần theo min để nextGroup đúng)
        const thresholds = [
            { name: 'Small', min: 0 },
            { name: 'Mid', min: 1e12 },
            { name: 'Large', min: 20e12 },
            { name: 'Super Large', min: 100e12 }
        ];

        const targetGroup = thresholds.find(t => t.name === groupName);
        if (!targetGroup) {
            return res.status(400).json({ success: false, error: 'Invalid group name' });
        }

        // nextGroup = nhóm vốn hóa lớn hơn tiếp theo → maxCap = min của nhóm lớn hơn
        const nextGroup = thresholds[thresholds.indexOf(targetGroup) + 1];
        const maxCap = nextGroup ? nextGroup.min : Infinity;

        const stocks = [];
        let countAboveMA10 = 0;
        let totalStocks = 0;
        let filteredCount = 0;

        tradingData.forEach(stock => {
            if (!stock.Symbol || stock.Symbol.length !== 3) return;

            const quote = quoteMap[stock.Symbol] || {};
            // Ưu tiên PriceCurrent từ quote (real-time); fallback LastPriceClose từ TradingStatistic
            const priceCurrent = quote.PriceCurrent || stock.LastPriceClose || 0;
            const sharesOutstanding = stock.SharesOutStanding || 0;
            const marketCap = priceCurrent * sharesOutstanding;

            // Filter by group
            if (marketCap < targetGroup.min || marketCap >= maxCap) return;
            totalStocks++;

            const ma10 = stock.AvgPrice10d || 0;
            const totalValue = quote.TotalValue || 0;

            // Lọc thanh khoản + nhiễu:
            // - GTGD < 100 triệu hoặc Volume < 30k CP → loại (mã rác/dorman)
            // - lucCau > 80% → loại (outlier, 1 lệnh mua trúng ceiling)
            const lucCau = computeLucCauByValue(quote);
            if (lucCau === null) { filteredCount++; return; }  // không đủ ĐK hoặc > 80%
            const aboveMA10 = ma10 > 0 && priceCurrent > ma10;

            if (aboveMA10) countAboveMA10++;

            stocks.push({
                symbol: stock.Symbol,
                price: priceCurrent,
                ma10: ma10,
                aboveMA10,
                lucCau: lucCau,
                totalVolume: quote.TotalVolume || 0,
                totalValue: totalValue,
                activeBuyVolume: quote.TotalActiveBuyVolume || 0,
                percentChange: quote.PricePercentChange ? parseFloat((quote.PricePercentChange * 100).toFixed(2)) : 0,
                marketCap
            });
        });

        // Sort: aboveMA10 first, then by lucCau descending (null cuối)
        stocks.sort((a, b) => {
            if (a.aboveMA10 !== b.aboveMA10) return b.aboveMA10 - a.aboveMA10;
            const la = a.lucCau == null ? -1 : a.lucCau;
            const lb = b.lucCau == null ? -1 : b.lucCau;
            return lb - la;
        });

        console.log(`✅ [marketcap-top-stocks] ${groupName}: ${totalStocks} mã tổng, ${stocks.length} đủ thanh khoản, ${filteredCount} bị loại, ${countAboveMA10} trên MA10`);

        res.json({
            success: true,
            groupName,
            totalStocks: totalStocks,
            liquidCount: stocks.length,
            filteredCount: filteredCount,
            totalAboveMA10: countAboveMA10,
            stocks
        });
    } catch (error) {
        console.error('marketcap-top-stocks error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Helper: chuyển dữ liệu IntradayMarketStatistic (FireAnt) thành chuỗi Lực Cầu
 * đã được lấy mẫu lại (resample) theo mốc thời gian cố định.
 *
 * Vì sao cần: FireAnt trả về ~2700 điểm/phiên (tick) khiến chart nặng và rối.
 * Ta gom theo bucket (mặc định 3 phút) và lấy điểm CUỐI mỗi bucket vì
 * TotalActiveBuyVolume/SellVolume là giá trị luỹ kế trong ngày.
 *
 * @param {Array} rawData mảng dữ liệu thô từ FireAnt
 * @param {number} bucketMin số phút mỗi bucket
 * @returns {Array} [{ time:'HH:MM', index, lucCau, activeBuy, activeSell }]
 */
function buildIntradayDemandSeries(rawData, bucketMin = 3) {
    if (!Array.isArray(rawData) || rawData.length === 0) return [];

    const buckets = new Map(); // key: bucketStartMinute -> point

    rawData.forEach(point => {
        const dateStr = point.Date || '';
        if (!dateStr.includes('T')) return;

        const utcTime = dateStr.split('T')[1].substring(0, 5);
        const [hours, mins] = utcTime.split(':').map(Number);
        if (Number.isNaN(hours) || Number.isNaN(mins)) return;

        // Convert UTC -> giờ Việt Nam (+7)
        const vnTotalMin = ((hours + 7) % 24) * 60 + mins;

        // Chỉ giữ trong khung giờ giao dịch HSX: 09:00 (540) → 15:00 (900)
        if (vnTotalMin < 540 || vnTotalMin > 900) return;

        const bucketStart = Math.floor(vnTotalMin / bucketMin) * bucketMin;
        // Luôn ghi đè -> giữ điểm cuối cùng (mới nhất) trong bucket
        buckets.set(bucketStart, point);
    });

    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);

    return sortedKeys.map(key => {
        const point = buckets.get(key);
        const hh = String(Math.floor(key / 60)).padStart(2, '0');
        const mm = String(key % 60).padStart(2, '0');

        const activeBuy = point.TotalActiveBuyVolume || 0;
        const activeSell = point.TotalActiveSellVolume || 0;
        const totalActive = activeBuy + activeSell;
        const lucCau = totalActive > 0 ? (activeBuy / totalActive * 100) : 50;

        return {
            time: `${hh}:${mm}`,
            index: point.IndexCurrent || 0,
            lucCau: Math.round(lucCau * 10) / 10,
            activeBuy,
            activeSell
        };
    });
}

/**
 * GET /api/vnindex-demand
 * Lấy dữ liệu INTRADAY của VNINDEX + Lực Cầu cho Line Chart dual axis (đã resample).
 * Lực Cầu = TotalActiveBuyVolume / (TotalActiveBuyVolume + TotalActiveSellVolume) * 100
 */
app.get('/api/vnindex-demand', async (req, res) => {
    const cached = await getCachedResponse('vnindex-demand', 30000);
    if (cached) return res.json(cached);
    try {
        console.log('📈 Fetching VNINDEX intraday + Demand...');

        // Fetch VNINDEX intraday data - contains all data points throughout the trading day
        const vnindexUrl = `${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=HOSTC`;
        const vnindexData = await fetchAPI(vnindexUrl, API_CONFIG.fireant.headers);

        if (!vnindexData || !vnindexData.length) {
            return res.json({ success: false, error: 'No VNINDEX intraday data' });
        }

        const series = buildIntradayDemandSeries(vnindexData, 3);
        const results = series.map(p => ({ time: p.time, vnindex: p.index, lucCau: p.lucCau }));

        console.log(`✅ VNINDEX intraday demand: ${results.length} points (resampled from ${vnindexData.length})`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            data: results
        };
        await setCachedResponse('vnindex-demand', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('VNINDEX demand error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vn30-demand
 * Lấy dữ liệu INTRADAY của VN30 + Lực Cầu cho Line Chart dual axis
 * Lực Cầu = TotalActiveBuyVolume / TotalVolume * 100
 */
app.get('/api/vn30-demand', async (req, res) => {
    const cached = await getCachedResponse('vn30-demand', 30000);
    if (cached) return res.json(cached);
    try {
        console.log('📈 Fetching VN30 intraday + Demand...');

        // Fetch VN30 intraday data - contains all data points throughout the trading day
        const vn30Url = `${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=VN30`;
        const vn30Data = await fetchAPI(vn30Url, API_CONFIG.fireant.headers);

        if (!vn30Data || !vn30Data.length) {
            return res.json({ success: false, error: 'No VN30 intraday data' });
        }

        const series = buildIntradayDemandSeries(vn30Data, 3);
        const results = series.map(p => ({ time: p.time, vn30: p.index, lucCauVN30: p.lucCau }));

        console.log(`✅ VN30 intraday demand: ${results.length} points (resampled from ${vn30Data.length})`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            data: results
        };
        await setCachedResponse('vn30-demand', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('VN30 demand error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// FILTER PRESETS API (Phase 4: per-user DB-backed)
// Backwards-compat: các endpoint cũ /api/filter-presets giờ delegate
// tới bảng filter_presets theo user_id (đã được auth middleware gắn).
// Frontend js/app.js gọi endpoint này — không cần đổi.
// ==========================================

/**
 * GET /api/filter-presets — presets của user hiện tại.
 */
app.get('/api/filter-presets', async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        const r = await query(
            `SELECT name, filters FROM filter_presets WHERE user_id = $1 ORDER BY name ASC`,
            [req.user.id]
        );
        const presets = {};
        for (const row of r.rows) presets[row.name] = row.filters;
        res.json({ success: true, presets });
    } catch (error) {
        console.error('Error loading presets:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/filter-presets — lưu/cập nhật preset.
 * Body: { name, conditions }
 */
app.post('/api/filter-presets', async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        const { name, conditions } = req.body;
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({ success: false, error: 'Invalid preset name' });
        }
        if (!conditions || !Array.isArray(conditions)) {
            return res.status(400).json({ success: false, error: 'Invalid conditions' });
        }
        await query(
            `INSERT INTO filter_presets (user_id, name, filters)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, name) DO UPDATE
               SET filters = EXCLUDED.filters, updated_at = now()`,
            [req.user.id, name.trim(), JSON.stringify(conditions)]
        );
        res.json({ success: true, message: 'Preset saved' });
    } catch (error) {
        console.error('Error saving preset:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/filter-presets/:name — xóa preset của user hiện tại.
 */
app.delete('/api/filter-presets/:name', async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        const name = decodeURIComponent(req.params.name);
        const r = await query(
            `DELETE FROM filter_presets WHERE user_id = $1 AND name = $2 RETURNING id`,
            [req.user.id, name]
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Preset not found' });
        }
        res.json({ success: true, message: 'Preset deleted' });
    } catch (error) {
        console.error('Error deleting preset:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// COOKIE STATUS ENDPOINT
// ==========================================

/**
 * GET /api/cookie-status
 * Kiểm tra trạng thái cookie sync
 */
app.get('/api/cookie-status', (req, res) => {
    try {
        const { runSync } = require('./cookie-sync');
        res.json({
            status: 'ok',
            message: 'Cookie sync đang hoạt động',
            syncInterval: `${process.env.COOKIE_SYNC_HOURS || 5} giờ`,
            timestamp: new Date().toISOString()
        });
    } catch(e) {
        res.json({ status: 'error', message: e.message });
    }
});

/**
 * POST /api/cookie-sync/force
 * Buộc chạy sync ngay lập tức (debug/admin)
 */
app.post('/api/cookie-sync/force', async (req, res) => {
    try {
        console.log('🔄 Force sync requested...');
        const { runSync } = require('./cookie-sync');
        res.json({ status: 'started', message: 'Cookie sync đã được kích hoạt' });
        // Chạy async sau khi trả response
        runSync().catch(e => console.error('Force sync error:', e.message));
    } catch(e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});


// ==========================================
// MA BREADTH ENDPOINTS (Độ Rộng Kỹ Thuật)
// Xem docs/superpowers/specs/2026-07-13-ma-breadth-design.md
// ==========================================

/**
 * GET /api/ma-breadth
 * Đọc file cache MA breadth (rất nhanh, không fetch FireAnt).
 * Query: scope=market|industry, industryCode=8300, fromDate, toDate, days
 */
app.get('/api/ma-breadth', (req, res) => {
    try {
        const result = breadthHistory.getBreadth({
            scope: req.query.scope || 'market',
            industryCode: req.query.industryCode || null,
            fromDate: req.query.fromDate || null,
            toDate: req.query.toDate || null,
            days: parseInt(req.query.days) || 0
        });
        res.json(result);
    } catch (error) {
        console.error('MA breadth error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/ma-breadth/meta — metadata tóm tắt cho UI (đã có data chưa, range thực).
 */
app.get('/api/ma-breadth/meta', (req, res) => {
    res.json(breadthHistory.getMeta());
});

/**
 * POST /api/ma-breadth/refresh — incremental build ngày mới nhất (~3-5s).
 */
app.post('/api/ma-breadth/refresh', async (req, res) => {
    req.setTimeout(30000);
    try {
        const result = await breadthHistory.buildToday({
            fetchFn: fetchAPI,
            getCookie: getFireAntCookie
        });
        res.json(result);
    } catch (error) {
        console.error('MA breadth refresh error:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

/**
 * POST /api/ma-breadth/build-history — full build lần đầu (~30-90s).
 * Body: { windowDays?: 370 }
 */
app.post('/api/ma-breadth/build-history', async (req, res) => {
    req.setTimeout(300000);
    const windowDays = (req.body && req.body.windowDays) || 370;
    try {
        const result = await breadthHistory.buildHistory({
            fetchFn: fetchAPI,
            getCookie: getFireAntCookie
        }, windowDays);
        res.json(result);
    } catch (error) {
        console.error('MA breadth build-history error:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Job nền auto-save snapshot mỗi ngày (15:15-22:00 giờ VN), kiểm tra mỗi 30 phút.
const BREADTH_CHECK_INTERVAL = 30 * 60 * 1000;
setInterval(async () => {
    const vnNow = new Date(Date.now() + 7 * 3600 * 1000);
    const vnHour = vnNow.getUTCHours();
    if (vnHour >= 15 && vnHour < 22) {
        try {
            if (!breadthHistory.hasToday()) {
                console.log('[MA Breadth] Auto-building today snapshot...');
                await breadthHistory.buildToday({
                    fetchFn: fetchAPI,
                    getCookie: getFireAntCookie
                });
            }
        } catch (e) {
            console.error('[MA Breadth] auto-build error:', e.message);
        }
    }
}, BREADTH_CHECK_INTERVAL);

// Job nền auto-save breadth daily snapshot (Phá Đỉnh/Phá Đáy) mỗi ngày EOD.
// Cùng window 15:00-22:00 VN (sau giờ đóng cửa). Idempotent: UPSERT tự xử lý trùng.
let _breadthSnapshotMod = null;
setInterval(async () => {
    const vnHour = (new Date(Date.now() + 7 * 3600 * 1000)).getUTCHours();
    if (vnHour >= 15 && vnHour < 22) {
        try {
            if (!_breadthSnapshotMod) _breadthSnapshotMod = require('./breadth-snapshot');
            if (!await _breadthSnapshotMod.hasToday()) {
                console.log('📸 [breadth-snapshot] Auto-capturing today...');
                await _breadthSnapshotMod.buildToday({ silent: false });
            }
        } catch (e) {
            console.error('[breadth-snapshot] auto-capture error:', e.message);
        }
    }
}, 30 * 60 * 1000);


app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        endpoints: [
            '/api/quotes',
            '/api/market-stats',
            '/api/market-dashboard',
            '/api/market-breadth',
            '/api/historical',
            '/api/vnindex-history',
            '/api/influential-stocks',
            '/api/industry-stats',
            '/api/industry-flow',
            '/api/investor-flow',
            '/api/investor-detail',
            '/api/foreign-flow',
            '/api/marketcap-stats',
            '/api/vnindex-demand',
            '/api/vn30-demand',
            '/api/top-net-stocks',
            '/api/potential-stocks',
            '/api/breakout-trendline',
            '/api/dashboard',
            '/api/news'
        ]
    });
});

// ==========================================
// TOP MUA/BÁN RÒNG FROM GOOGLE SHEETS
// ==========================================

/**
 * GET /api/top-net-stocks
 * Đọc Top Mua/Bán Ròng từ Google Sheet
 * Sheet: https://docs.google.com/spreadsheets/d/1lvf27UzhXFQo9K-gijhGjmRmDKL_MkPHVTFaKk_o8IY
 * gid=1003056759: cột A,B = Top Mua Ròng 1 ngày, cột D,E = Top Bán Ròng 1 ngày
 *                 Row 12+: Top Mua/Bán Ròng 1 tháng
 */
app.get('/api/top-net-stocks', async (req, res) => {
    // Cache 60 seconds - Google Sheets fetch
    const cached = await getCachedResponse('top-net-stocks', 60000);
    if (cached) {
        console.log('📊 Returning cached top-net-stocks data');
        return res.json(cached);
    }
    try {
        console.log('📊 [top-net-stocks] Fetching from Google Sheets...');

        const SHEET_ID = '1lvf27UzhXFQo9K-gijhGjmRmDKL_MkPHVTFaKk_o8IY';
        const GID = '1003056759';
        const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`;

        const response = await axios.get(csvUrl, { timeout: 15000, responseType: 'text' });
        const csvText = response.data;

        // Parse CSV rows
        const rows = csvText.split('\n').map(row => {
            const cols = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < row.length; i++) {
                const ch = row[i];
                if (ch === '"') {
                    inQuotes = !inQuotes;
                } else if (ch === ',' && !inQuotes) {
                    cols.push(current.trim());
                    current = '';
                } else {
                    current += ch;
                }
            }
            cols.push(current.trim());
            return cols;
        });

        // Column layout (0-based index):
        // 0,1,2 = Top Ngành Tăng (5 ngày) | value | empty
        // 3,4,5 = Top Ngành Giảm (5 ngày) | value | empty
        // 6,7,8 = Top Mua Ròng (1 ngày / 1 tháng) | value | empty
        // 9,10,11 = Top Bán Ròng (1 ngày / 1 tháng) | value | empty
        // 12,13,14 = Top Mua Ròng (10 ngày / 3 tháng) | value | empty
        // 15,16,17 = Top Bán Ròng (10 ngày / 3 tháng) | value | empty
        // Row 13 = header for monthly/quarterly section

        const dailyBuy = [];
        const dailySell = [];
        const tenDayBuy = [];
        const tenDaySell = [];
        const monthlyBuy = [];
        const monthlySell = [];
        const quarterlyBuy = [];
        const quarterlySell = [];

        let section = 'daily'; // daily | monthly

        // Parse value: "226.74" -> 226.74, "2,599.00" -> 2599.00
        const parseValue = (val) => {
            if (!val) return 0;
            const cleaned = val.replace(/,/g, '');
            return parseFloat(cleaned) || 0;
        };

        const clean = (row, idx) => (row[idx] || '').replace(/"/g, '').trim();

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length < 7) continue;

            // Detect monthly header: column G (index 6) contains "1 Tháng"
            const colG = clean(row, 6);
            if (colG.includes('1 Tháng') || colG.includes('1 tháng')) {
                section = 'monthly';
                continue;
            }

            // Skip header rows
            if (colG.includes('Top Mua') || colG.includes('Top Bán')) continue;
            if (colG.includes('Top Ngành') || colG.includes('Ngành Tăng')) continue;

            const isValidSymbol = (s) => s && s.length >= 2 && s.length <= 10 && !s.includes('Ngành') && !s.includes('Top');

            // Parse stock from a pair of columns (symbol, value)
            const parseStockPair = (row, symIdx, valIdx) => {
                const sym = clean(row, symIdx).toUpperCase();
                const val = clean(row, valIdx);
                if (isValidSymbol(sym) && val) {
                    return { symbol: sym, value: parseValue(val) };
                }
                return null;
            };

            if (section === 'daily') {
                const buy = parseStockPair(row, 6, 7);   // G, H
                const sell = parseStockPair(row, 9, 10);  // J, K
                const buy10d = parseStockPair(row, 12, 13); // M, N
                const sell10d = parseStockPair(row, 15, 16); // P, Q
                if (buy) dailyBuy.push(buy);
                if (sell) dailySell.push(sell);
                if (buy10d) tenDayBuy.push(buy10d);
                if (sell10d) tenDaySell.push(sell10d);
            } else {
                const buy = parseStockPair(row, 6, 7);
                const sell = parseStockPair(row, 9, 10);
                const buy3m = parseStockPair(row, 12, 13);
                const sell3m = parseStockPair(row, 15, 16);
                if (buy) monthlyBuy.push(buy);
                if (sell) monthlySell.push(sell);
                if (buy3m) quarterlyBuy.push(buy3m);
                if (sell3m) quarterlySell.push(sell3m);
            }
        }

        console.log(`✅ [top-net-stocks] Daily: ${dailyBuy.length}b/${dailySell.length}s | 10D: ${tenDayBuy.length}b/${tenDaySell.length}s | Monthly: ${monthlyBuy.length}b/${monthlySell.length}s | Q: ${quarterlyBuy.length}b/${quarterlySell.length}s`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            data: {
                daily: { buy: dailyBuy, sell: dailySell },
                tenDay: { buy: tenDayBuy, sell: tenDaySell },
                monthly: { buy: monthlyBuy, sell: monthlySell },
                quarterly: { buy: quarterlyBuy, sell: quarterlySell }
            }
        };
        await setCachedResponse('top-net-stocks', responseData);
        res.json(responseData);
    } catch (error) {
        // Fallback: trả cache gần nhất (dù đã hết hạn) khi Google Sheet lỗi/timeout.
        const stale = await getStaleResponse('top-net-stocks');
        if (stale) {
            console.warn(`⚠️ top-net-stocks: Google Sheet lỗi, trả cache cũ (${error.message})`);
            return res.json(stale);
        }
        console.error('top-net-stocks error:', error.message);
        // Chưa có cache: trả 200 success:false — frontend xử lý null an toàn, không phát sinh lỗi 500.
        res.json({ success: false, error: error.message, data: null });
    }
});

// ==========================================
// AI MARKET REPORT — Báo cáo thị trường tự động (DeepSeek + Gemini)
// ==========================================

/**
 * Gọi nội bộ 1 endpoint của chính server (localhost) — dùng để gom data cho AI.
 * Truyền req (có cookies auth) để đi qua requireAuth middleware.
 */
async function fetchInternal(req, path) {
    try {
        const url = `http://localhost:${PORT}${path}`;
        const resp = await axios.get(url, {
            headers: { Cookie: req.headers.cookie || '' },
            timeout: 10000
        });
        return resp.data;
    } catch (e) {
        console.warn(`⚠️  [ai] fetchInternal ${path} fail:`, e.message);
        return null;
    }
}

/**
 * Tính MA50/100/200 của VNINDEX (GIÁ TRỊ ĐIỂM, vd ~1771) — khác với breadth
 * (số mã trên MA). Lấy history 250 ngày qua FireAnt HistoricalQuotes, tính SMA.
 * Cache trong process 1h để tránh fetch lại.
 * @returns {Promise<{close, ma50, ma100, ma200, aboveMA50, aboveMA100, aboveMA200}|null>}
 */
let _vnindexMACache = { time: 0, data: null };
async function computeVNIndexMA() {
    // Cache 1h
    if (_vnindexMACache.data && Date.now() - _vnindexMACache.time < 3600000) {
        return _vnindexMACache.data;
    }
    try {
        const from = new Date();
        from.setDate(from.getDate() - 400); // 400 ngày để có đủ data cho MA200
        const fromStr = from.toISOString().split('T')[0];
        const toStr = new Date().toISOString().split('T')[0];
        const url = `${API_CONFIG.fireant.base}/Markets/HistoricalQuotes?symbol=VNINDEX&startDate=${fromStr}&endDate=${toStr}`;
        const raw = await fetchAPI(url, API_CONFIG.fireant.headers);
        const arr = Array.isArray(raw) ? raw : (raw && raw.value) || [];
        const closes = arr.map(d => d.Close).filter(v => typeof v === 'number');
        if (closes.length < 200) return null;

        const close = closes[closes.length - 1];
        const sma = (period) => {
            if (closes.length < period) return null;
            const slice = closes.slice(-period);
            return Math.round(slice.reduce((a, b) => a + b, 0) / period * 100) / 100;
        };
        const ma50 = sma(50);
        const ma100 = sma(100);
        const ma200 = sma(200);

        const data = {
            close: Math.round(close * 100) / 100,
            ma50, ma100, ma200,
            aboveMA50: ma50 ? Math.round((close - ma50) / ma50 * 1000) / 10 : null,   // % giá trên MA50
            aboveMA100: ma100 ? Math.round((close - ma100) / ma100 * 1000) / 10 : null,
            aboveMA200: ma200 ? Math.round((close - ma200) / ma200 * 1000) / 10 : null
        };
        _vnindexMACache = { time: Date.now(), data };
        console.log(`📈 [ai] VNINDEX MA: close=${close}, MA50=${ma50}, MA100=${ma100}, MA200=${ma200}`);
        return data;
    } catch (e) {
        console.warn('⚠️  [ai] computeVNIndexMA fail:', e.message);
        return null;
    }
}

/**
 * Gom data từ 9 endpoint thành 1 object gọn để feed vào AI.
 * Chỉ trích fields quan trọng — bỏ noise để prompt gọn (~2-3K tokens).
 */
function buildMarketContext(dashboard, breadth, industry, investor, foreign, breakout, influential, maBreadth, potential) {
    const ctx = { date: new Date().toLocaleDateString('vi-VN') };

    // 1. VNINDEX + VN30
    if (dashboard?.success && dashboard.data) {
        const d = dashboard.data;
        const idx = (name) => d[name] ? {
            gia: d[name].indexCurrent,
            phanTram: d[name].percentChange,
            lucCau: d[name].demandStrength,
            gtgdTy: d[name].totalValue,
            tang: d[name].advances,
            giam: d[name].declines
        } : null;
        ctx.vnindex = idx('vnindex');
        ctx.vn30 = idx('vn30');
    }

    // 2. Breadth (số mã tăng/giảm tổng)
    if (breadth?.success && breadth.data?.hostc) {
        const h = breadth.data.hostc;
        ctx.breadthHostc = {
            tang: h.advances, giam: h.declines, dung: h.unchanged,
            gtTangTy: (h.totalPositiveValue / 1e9).toFixed(0),
            gtGiamTy: (h.totalNegativeValue / 1e9).toFixed(0),
            khoiNgoaiMuaTy: (h.buyForeignValue / 1e9).toFixed(1),
            khoiNgoaiBanTy: (h.sellForeignValue / 1e9).toFixed(1)
        };
    }

    // 3. Lực cầu ngành (top 5 mạnh + top 5 yếu + custom themes)
    if (industry?.success && Array.isArray(industry.data)) {
        const valid = industry.data.filter(g => g.lucCau != null && !g.isCustomTheme);
        const byLucCau = [...valid].sort((a, b) => (b.lucCau || 0) - (a.lucCau || 0));
        ctx.nganhManhNhat = byLucCau.slice(0, 5).map(g => ({
            nganh: g.name, lucCau: g.lucCau, phanTramTrenMA10: g.percentAboveMA10,
            maDuDK: g.liquidCount, tongMa: g.stockCount
        }));
        ctx.nganhYeuNhat = byLucCau.slice(-5).reverse().map(g => ({
            nganh: g.name, lucCau: g.lucCau, phanTramTrenMA10: g.percentAboveMA10
        }));
        // Custom themes (Cá tra, Tôm, Vingroup)
        const themes = industry.data.filter(g => g.isCustomTheme);
        if (themes.length > 0) {
            ctx.nhomChuDe = themes.map(g => ({
                nhom: g.name, lucCau: g.lucCau, maDuDK: g.liquidCount, tongMa: g.stockCount
            }));
        }
    }

    // 4. Dòng tiền 4 nhóm NĐT (net today)
    if (investor?.success && Array.isArray(investor.groups)) {
        ctx.dongTienNhomNDT = investor.groups.map(g => ({
            nhom: g.name,
            netHomNayTy: g.today?.net,
            net1TuanTy: g.oneWeek?.net,
            net1ThangTy: g.oneMonth?.net,
            topMua: (g.topBuy || []).slice(0, 5).map(s => ({ ma: s.ticker, netTy: s.net, gia: s.price })),
            topBan: (g.topSell || []).slice(0, 5).map(s => ({ ma: s.ticker, netTy: s.net, gia: s.price }))
        }));
    }

    // 5. Khối ngoại
    if (foreign?.success && foreign.today) {
        ctx.khoiNgoai = {
            netHomNayTy: foreign.today.net,
            trend: (foreign.trend || []).map(t => ({ moc: t.label, netTy: t.net }))
        };
    }

    // 6. Breadth breakout (phá đỉnh/đáy) — full insight cho AI phân tích
    if (breakout?.success) {
        const summary = breakout.summary || [];
        // Trạng thái thị trường (theo 1N — timeframe dài nhất, đáng tin nhất)
        const trangThaiThiTruong = summary.length > 0 ? summary[summary.length - 1].verdict : null;
        ctx.phaDinhDay = {
            // summary: số mã phá đỉnh vs đáy + ratio + trạng thái từng tf (3T/6T/1N)
            summary: summary.map(s => ({
                tf: s.tf, phaDinh: s.high, phaDay: s.low, ratio: s.ratio, trangThai: s.verdict
            })),
            // Trạng thái thị trường tổng: Bullish (tích cực) / Bearish (tiêu cực) / Neutral (trung lập)
            trangThaiThiTruong: trangThaiThiTruong,
            // capSummary: vốn hóa phá đỉnh vs đáy + tỷ lệ lowOverHigh
            // (VD lowOverHigh=4.19 nghĩa là vốn hóa phá đáy gấp 4.19 lần phá đỉnh → rất Bearish)
            vonHoaPhaDinhDay: (breakout.capSummary || []).map(c => ({
                tf: c.tf, vonHoaPhaDinhTy: c.capHigh, vonHoaPhaDayTy: c.capLow,
                tyLeDayDinh: c.lowOverHigh  // >1 = vốn hóa đáy > đỉnh → Bearish mạnh
            })),
            rsi: breakout.rsiSummary || null,
            // Top 5 ngành bị thủng đáy nhiều nhất (theo vốn hóa phá đáy)
            // field impact = 'Cao'|'Trung bình'|'Thấp' mức độ tác động
            nganhThuungDayNhieuNhat: (breakout.sectorBreakdown || [])
                .sort((a, b) => (b.totalLowCap || 0) - (a.totalLowCap || 0))
                .slice(0, 5)
                .map(s => ({
                    nganh: s.sector,
                    vonHoaPhaDay3T: s.perTf?.ThreeMonths?.lCap,
                    vonHoaPhaDay1N: s.perTf?.OneYear?.lCap,
                    soMaPhaDay: s.totalLCnt,
                    soMaPhaDinh: s.totalHCnt,
                    tacDong: s.impact
                })),
            topPhaDinh3T: (breakout.topHighs3T || []).slice(0, 5).map(s => ({
                ma: s.ticker, nganh: s.sector, gia: s.price, phanTram3T: s.pct3M, rsi: s.rsi
            })),
            topPhaDay1Y: (breakout.topLows1Y || []).slice(0, 5).map(s => ({
                ma: s.ticker, nganh: s.sector, gia: s.price, phanTram1Y: s.pct1Y, rsi: s.rsi
            }))
        };
    }

    // 7. Mã tác động VNINDEX
    if (influential?.success && influential.data) {
        ctx.maTacDong = {
            tangManhNhat: (influential.data.positive || []).slice(0, 5).map(s => ({
                ma: s.symbol, diemDongGop: s.value, phanTram: s.percent
            })),
            giamManhNhat: (influential.data.negative || []).slice(0, 5).map(s => ({
                ma: s.symbol, diemDongGop: s.value, phanTram: s.percent
            }))
        };
    }

    // Lưu ý: đã bỏ top-net-stocks (Google Sheet đã xóa khỏi dashboard).
    // Top mua/bán ròng 1 ngày đã có trong dongTienNhomNDT.topMua/topBan (từ investor-detail).

    // 8. Độ rộng kỹ thuật (BREADTH = SỐ MÃ trên MA10/20/50/100/200)
    // QUAN TRỌNG: đây là số MÃ trên MA, KHÔNG PHẢI giá trị điểm MA của VNINDEX.
    // Format rõ ràng để AI không nhầm lẫn.
    if (maBreadth?.success && Array.isArray(maBreadth.series) && maBreadth.series.length > 0) {
        const last = maBreadth.series[maBreadth.series.length - 1];
        const prev = maBreadth.series[maBreadth.series.length - 2] || last;
        const total = last.total || 1;
        const pct = (n) => Math.round((n / total) * 1000) / 10;
        ctx.doRongKyThuat = {
            chuThich: 'ĐỘ RỘNG = số mã cổ phiếu trên MA (không phải điểm VNINDEX)',
            tongMa: total,
            soMaTrenMA: {
                MA10: last.ma10, MA20: last.ma20, MA50: last.ma50,
                MA100: last.ma100, MA200: last.ma200
            },
            phanTramMaTrenMA: `${pct(last.ma50)}% mã trên MA50, ${pct(last.ma100)}% trên MA100, ${pct(last.ma200)}% trên MA200`,
            xuHuongMA50: `${pct(prev.ma50)}% → ${pct(last.ma50)}% (phiên trước → hôm nay)`
        };
    }

    // 9. Mã tiềm năng (RS-based scanner — Relative Strength + volume + MA)
    // Fields: symbol, price, change, ma20, ma50, distMA20, rs (relative strength),
    //         rsMA10, volume, avgVolume20, volumeRatio, rsTrend
    if (potential?.success && Array.isArray(potential.signals)) {
        ctx.maTiemNang = potential.signals.slice(0, 10).map(s => ({
            ma: s.symbol,
            gia: s.price,
            phanTram: s.change ? Math.round(s.change * 100) / 100 : null,
            trenMA20: s.distMA20 ? Math.round(s.distMA20 * 100) / 100 : null,  // % giá trên MA20
            trenMA50: s.ma50 ? Math.round(((s.price - s.ma50) / s.ma50) * 1000) / 10 : null,
            relativeStrength: s.rs,           // RS score (cao = mạnh hơn thị trường)
            rsTrend: s.rsTrend,               // 'up' | 'down' | 'sideways'
            volumeRatio: s.volumeRatio ? Math.round(s.volumeRatio * 100) / 100 : null  // vol/avgVol20
        }));
        ctx.tongTinHieu = potential.total || potential.signals.length;
    }

    return ctx;
}

/**
 * POST /api/ai/market-report?refresh=true
 * Sinh báo cáo thị trường hôm nay bằng AI.
 * Provider preference + API key + system prompt lấy từ user_ai_settings của user đang login.
 * Nếu user chưa set → fallback env DEEPSEEK_API_KEY/GEMINI_API_KEY + SYSTEM_PROMPT default.
 * Cache 24h per-user (mỗi user có prompt/key khác nhau → báo cáo khác nhau).
 */
app.post('/api/ai/market-report', requireAuth, async (req, res) => {
    const userId = req.user.id;

    // Load user AI settings (nếu có)
    let userSettings = { provider: 'auto', deepseekKey: null, geminiKey: null, tokenrouterKey: null, systemPrompt: null };
    try {
        const { query } = require('./db');
        const sr = await query(
            `SELECT provider, deepseek_api_key, gemini_api_key, tokenrouter_api_key, system_prompt
             FROM user_ai_settings WHERE user_id = $1`, [userId]);
        if (sr.rowCount > 0) {
            const r = sr.rows[0];
            userSettings = {
                provider: r.provider || 'auto',
                deepseekKey: r.deepseek_api_key || null,
                geminiKey: r.gemini_api_key || null,
                tokenrouterKey: r.tokenrouter_api_key || null,
                systemPrompt: r.system_prompt || null
            };
        }
    } catch (e) { /* table chưa migrate hoặc lỗi → fallback default */ }

    // Check AI available (cả env lẫn user key)
    const hasAnyKey = aiModule.isAvailable() || userSettings.deepseekKey || userSettings.geminiKey || userSettings.tokenrouterKey;
    if (!hasAnyKey) {
        return res.status(503).json({
            success: false,
            error: 'AI service chưa cấu hình. Vui lòng set API key trong ⚙️ Cấu hình AI hoặc liên hệ admin.'
        });
    }

    const forceRefresh = req.query.refresh === 'true';
    // Cache per-user: mỗi user có prompt/key khác nhau → cache key riêng
    const cacheKey = `ai-report:user:${userId}`;

    // 1. Cache check (24h) — skip nếu forceRefresh
    if (!forceRefresh) {
        const cached = await getCachedResponse(cacheKey, 24 * 3600 * 1000);
        if (cached) {
            console.log(`🤖 Returning cached AI report (user ${userId})`);
            return res.json(cached);
        }
    }

    try {
        console.log(`🤖 [ai] Generating market report (user ${userId}, provider ${userSettings.provider})...`);

        // 2. Gom data song song (9 endpoint)
        const [dashboard, breadth, industry, investor, foreign, breakout, influential, maBreadth, potential] = await Promise.all([
            fetchInternal(req, '/api/market-dashboard'),
            fetchInternal(req, '/api/market-breadth'),
            fetchInternal(req, '/api/industry-stats'),
            fetchInternal(req, '/api/investor-detail?range=today'),
            fetchInternal(req, '/api/foreign-flow'),
            fetchInternal(req, '/api/breadth-breakout'),
            fetchInternal(req, '/api/influential-stocks'),
            fetchInternal(req, '/api/ma-breadth?scope=market&days=5'),
            fetchInternal(req, '/api/potential-stocks')
        ]);

        // 3. Build context gọn
        const dateStr = require('./cache').vnToday();
        const context = buildMarketContext(dashboard, breadth, industry, investor, foreign, breakout, influential, maBreadth, potential);

        // 3b. Thêm MA VNINDEX (giá trị điểm ~1771) — async, tính riêng
        const vnindexMA = await computeVNIndexMA();
        if (vnindexMA) {
            context.vnindexMA = {
                chuThich: 'GIÁ TRỊ ĐIỂM VNINDEX + MA (khác breadth số mã trên MA)',
                close: vnindexMA.close,
                MA50: vnindexMA.ma50,
                MA100: vnindexMA.ma100,
                MA200: vnindexMA.ma200,
                viTri: `VNINDEX ${vnindexMA.close} ${vnindexMA.aboveMA200 >= 0 ? 'TRÊN' : 'DƯỚI'} MA200 (${vnindexMA.ma200}), cách ${Math.abs(vnindexMA.aboveMA200)}%`,
                trenMA50Pct: vnindexMA.aboveMA50,
                trenMA200Pct: vnindexMA.aboveMA200
            };
        }

        // 4. Generate AI report với user settings
        const { text, provider } = await aiModule.generateMarketReport(context, dateStr, {
            deepseekKey: userSettings.deepseekKey,
            geminiKey: userSettings.geminiKey,
            tokenrouterKey: userSettings.tokenrouterKey,
            systemPrompt: userSettings.systemPrompt,
            provider: userSettings.provider
        });

        const responseData = {
            success: true,
            report: text,
            provider,
            generatedAt: new Date().toISOString(),
            date: dateStr,
            userId
        };

        // 5. Cache 24h per-user
        await setCachedResponse(cacheKey, responseData);
        console.log(`✅ [ai] Report generated (user ${userId}, provider ${provider}, ${text.length} chars)`);
        res.json(responseData);
    } catch (error) {
        console.error('[ai] market-report error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            providerErrors: error.providerErrors || null
        });
    }
});

// ==========================================
// START SERVER
// ==========================================

// ── Khởi tạo cache layer trước khi listen ─────────────────────────────
async function bootstrap() {
    const { pool } = require('./db');
    const { redis } = require('./redis-client');

    // Healthcheck Postgres (non-fatal — server vẫn start nếu DB lỗi)
    try {
        await pool.query('SELECT 1');
        console.log('✅ [db] connected');
    } catch (e) {
        console.error('❌ [db] connect failed — cache sẽ chỉ dùng Redis/fallback. Lỗi:', e.message);
    }

    // Healthcheck Redis (ping)
    try {
        await redis.ping();
        console.log('✅ [redis] ready');
    } catch (e) {
        console.error('❌ [redis] connect failed — cache chỉ dùng Postgres. Lỗi:', e.message);
    }

    app.listen(PORT, () => {
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 VN STOCK MARKET SERVER                               ║
║                                                           ║
║   Server running at: http://localhost:${PORT}              ║
║   API Health Check:  http://localhost:${PORT}/api/health   ║
║                                                           ║
║   Website:           http://localhost:${PORT}/index.html   ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);

        // ── Khởi động Auto Cookie Sync ────────────────────────────────────────
        try {
            const { startAutoSync } = require('./cookie-sync');
            startAutoSync();
        } catch (e) {
            console.error('⚠️  Cookie sync không khởi động được:', e.message);
        }

        // ── Refresh Scheduler — làm mới cache nền ────────────────────────────
        try {
            const { startScheduler } = require('./scheduler');
            startScheduler(PORT);
        } catch (e) {
            console.warn('⚠️  Scheduler không khởi động được:', e.message);
        }

        // ── Khởi động quét cổ phiếu tiềm năng ban đầu (sau 5 giây để server ổn định) ────────────────
        setTimeout(async () => {
            try {
                console.log('🚀 [POTENTIAL] Starting initial potential stocks scan...');
                const cookie = await getFireAntCookie();
                scanPotential(cookie).catch(err => console.error('[POTENTIAL] Initial scan error:', err.message));
            } catch (err) {
                console.error('Failed to trigger initial potential scan:', err.message);
            }
        }, 5000);

        // ── Pre-warm data khi server start (user vào là data sẵn) ────────────
        // all-stocks: build MA map + cache server (~3s lần đầu, sau đó <50ms)
        // EOD endpoints: cache data hôm qua (hoặc hôm nay nếu 19-22h) để user
        //   vào xem dòng tiền ngành ngay, không đợi fetch.
        const INTERNAL_SECRET_PREWARM = process.env.INTERNAL_SECRET || 'vnstock-scheduler-internal';
        setTimeout(async () => {
            const prewarmEndpoints = [
                '/api/all-stocks',
                '/api/industry-stats',
                '/api/top-net-stocks',
                '/api/investor-flow',
                '/api/foreign-flow',
                '/api/investor-detail',
                '/api/influential-stocks',
                '/api/market-breadth',
                '/api/marketcap-stats',
                '/api/vnindex-demand',
                '/api/vn30-demand'
            ];
            for (const ep of prewarmEndpoints) {
                try {
                    await axios.get(`http://localhost:${PORT}${ep}`, {
                        timeout: 30000,
                        headers: { 'X-Internal-Secret': INTERNAL_SECRET_PREWARM }
                    });
                    console.log(`🔥 [prewarm] ${ep}`);
                } catch (e) {
                    console.warn(`⚠️ [prewarm] ${ep} fail: ${e.message}`);
                }
            }
            console.log('✅ [prewarm] data đã sẵn sàng cho user');
        }, 12000);
    });
}
bootstrap();
