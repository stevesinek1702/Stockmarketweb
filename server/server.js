/**
 * VN STOCK MARKET - BACKEND SERVER
 * Node.js Express server để proxy API requests và bypass CORS
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const { scanPotential, getCachedSignals } = require('./potential-scanner');
const fiintrade = require('./fiintrade');
const breadthHistory = require('./breadth-history');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Parse JSON bodies
app.use(express.json());

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

// Cookie cache for FireAnt API
let fireAntCookieCache = { cookie: '', fetchedAt: 0 };

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
const responseCache = new Map();

function getCachedResponse(key, ttlMs) {
    const entry = responseCache.get(key);
    if (entry && Date.now() - entry.time < ttlMs) {
        return entry.data;
    }
    return null;
}

function setCachedResponse(key, data) {
    responseCache.set(key, { data, time: Date.now() });
}

// Trả dữ liệu cache gần nhất BẤT KỂ đã hết hạn — dùng làm fallback khi nguồn ngoài lỗi.
function getStaleResponse(key) {
    const entry = responseCache.get(key);
    return entry ? entry.data : null;
}

// Cleanup old cache entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of responseCache) {
        if (now - entry.time > 300000) { // 5 minutes
            responseCache.delete(key);
        }
    }
}, 300000);

// ==========================================
// FIREANT API ENDPOINTS
// ==========================================

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
    const cacheKey = `market-stats-${symbol}`;
    // Cache tươi 20s: giảm tải FireAnt + phản hồi nhanh khi nhiều widget cùng gọi.
    const fresh = getCachedResponse(cacheKey, 20000);
    if (fresh) return res.json(fresh);
    try {
        const url = `${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=${symbol}`;
        const data = await fetchAPI(url, API_CONFIG.fireant.headers);
        setCachedResponse(cacheKey, data);
        res.json(data);
    } catch (error) {
        // Fallback: trả cache gần nhất (dù cũ) để card chỉ số không bị trống vì FireAnt chập chờn.
        const stale = getStaleResponse(cacheKey);
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
 * Lấy danh sách mã tác động tích cực/tiêu cực tới thị trường từ Fialda API
 */
app.get('/api/influential-stocks', async (req, res) => {
    // Cache 30 seconds
    const cached = getCachedResponse('influential-stocks', 30000);
    if (cached) {
        console.log('📊 Returning cached influential-stocks data');
        return res.json(cached);
    }
    try {
        console.log('📊 Fetching influential stocks from Fialda...');

        const response = await axios.get('https://fwtapi2.fialda.com/api/services/app/Derivative/GetTopInfluentialStocks?indexCode=TOPINFLUENTIALSTOCK_VNINDEX', {
            timeout: 10000
        });

        const result = response.data?.result;
        if (!result) {
            return res.status(500).json({ success: false, error: 'Invalid response from Fialda API' });
        }

        // API Fialda trả về: top10PositiveStocks và top10NegativeStocks
        const positiveStocks = result.top10PositiveStocks || result.positiveStocks || [];
        const negativeStocks = result.top10NegativeStocks || result.negativeStocks || [];

        console.log(`✅ Influential stocks: ${positiveStocks.length} positive, ${negativeStocks.length} negative`);

        const responseData = {
            success: true,
            data: {
                positive: positiveStocks.slice(0, 10).map(s => ({
                    symbol: s.symbol,
                    value: parseFloat((s.affectValue || 0).toFixed(2)),
                    percent: parseFloat(((s.affectPercent || 0) * 100).toFixed(2))
                })),
                negative: negativeStocks.slice(0, 10).map(s => ({
                    symbol: s.symbol,
                    value: parseFloat((s.affectValue || 0).toFixed(2)),
                    percent: parseFloat(((s.affectPercent || 0) * 100).toFixed(2))
                }))
            },
            timestamp: new Date().toISOString()
        };
        setCachedResponse('influential-stocks', responseData);
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
    const cached = getCachedResponse('market-breadth', 30000);
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
        setCachedResponse('market-breadth', responseData);
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
    const cached = getCachedResponse('all-stocks', 60000);
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
        const batch17 = 'TA3,TA6,TA9,TAG,TAN,TAR,TAW,TB8,TBC,TBD,TBH,TBR,TBT,TBX,TC6,TCB,TCD,TCH,TCI,TCJ,TCK,TCL,TCM,TCO,TCR,TCT,TCW,TDB,TDC,TDF,TDG,TDH,TDM,TDN,TDP,TDS,TDT,TDW,TED,TEG,TEL,TET,TFC,TGG,TGP,TH1,THB,THD,THG,THI,THN,THP,THS,THT,THU,THW,TID,TIE,TIG,TIN,TIP,TIS,TIX,TJC,TKA,TKC,TKG,TKU,TL4,TLD,TLG,TLH,TLI,TLP,TLT,TMB,TMC,TMG,TMP,TMS,TMT,TMW,TMX,TN1,TNA,TNB,TNC,TNG,TNH,TNI,TNM,TNP,TNS,TNT,TNW,TOP,TOS,TOT,TOW,TPB,TPC,TPH,TPP,TPS';
        const batch18 = 'TQN,TQW,TR1,TRA,TRC,TRS,TRT,TS3,TS4,TSB,TSC,TSD,TSG,TSJ,TST,TTA,TTB,TTC,TTD,TTE,TTF,TTG,TTH,TTL,TTN,TTP,TTS,TTT,TTZ,TUG,TV1,TV2,TV3,TV4,TV6,TVA,TVB,TVC,TVD,TVG,TVH,TVM,TVN,TVP,TVS,TVT,TVW,TW3,TXM,TYA,UCT,UDC,UDJ,UDL,UEM,UIC,UMC,UNI,UPC,UPH,USC,USD,V11,V12,V15,V21,VAB,VAF,VAT,VAV,VBB,VBC,VBG,VBH,VC1,VC2,VC3,VC5,VC6,VC7,VC9,VCA,VCB,VCC,VCE,VCF,VCG,VCI,VCM,VCP,VCR,VCS,VCT,VCW,VCX,VDB,VDL,VDN,VDP,VDS,VDT';
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

        // Helper to transform stock data với volRatio
        const transformStock = (s) => {
            const stats = tradingStatsMap[s.Symbol] || {};
            const currentVol = s.TotalVolume || 0;
            const avgVol = stats.avgVolume || 0;
            // Tính % khối lượng so với TB: (currentVol / avgVol - 1) * 100
            // User requested logic earlier was (current/avg)*100.
            const volRatio = avgVol > 0 ? Math.round((currentVol / avgVol) * 100) : 0;

            // Calculate Demand Strength (Lực cầu)
            // Lực cầu = TotalActiveBuyVolume / TotalVolume * 100
            const activeBuyVol = s.TotalActiveBuyVolume || 0;
            const demandStrength = currentVol > 0 ? ((activeBuyVol / currentVol) * 100).toFixed(1) : 0;

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
                demandStrength: parseFloat(demandStrength)
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
        setCachedResponse('all-stocks', responseData);
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
        const cacheKey = `industry-flow-${timeRange}-${level}`;

        const cached = getCachedResponse(cacheKey, 60000);
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
        setCachedResponse(cacheKey, responseData);
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
 * GET /api/investor-flow
 * "Phân tích lệnh" — dòng tiền ròng (khớp lệnh) toàn thị trường theo 4 nhóm NĐT:
 * cá nhân / tổ chức / tự doanh / nước ngoài, cho nhiều mốc thời gian (1D, 5D, 20D).
 * Nguồn: Fiintrade (tổng hợp 10 ngành cấp 1). Đơn vị: tỷ đồng.
 */
app.get('/api/investor-flow', async (req, res) => {
    const cached = getCachedResponse('investor-flow', 60000);
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
        setCachedResponse('investor-flow', responseData);
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
    const cached = getCachedResponse('foreign-flow', 60000);
    if (cached) return res.json(cached);
    try {
        console.log('🌍 Fetching foreign flow (Khối ngoại) from Fiintrade...');

        // Gọi song song; dùng allSettled để một nguồn lỗi không kéo sập cả endpoint.
        const settled = await Promise.allSettled([
            fiintrade.getForeignStatistic('VNINDEX'), // 0: today buy/sell/net
            fiintrade.getMarketInvestorFlow(1),        // 1: 1 phiên net (fallback cho today)
            fiintrade.getMarketInvestorFlow(5),        // 2: 5 phiên net
            fiintrade.getMarketInvestorFlow(20)        // 3: 20 phiên net
        ]);
        const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
        const stat = val(0), d1 = val(1), d5 = val(2), d20 = val(3);

        // Mua/Bán/Ròng hôm nay: ưu tiên GetStatisticInvestor (tách được buy/sell),
        // nếu lỗi thì lấy net-only từ getMarketInvestorFlow(1).nuocNgoai.
        let today;
        if (stat && stat.today && typeof stat.today.net === 'number') {
            today = { buy: stat.today.buy, sell: stat.today.sell, net: stat.today.net };
        } else if (d1 && typeof d1.nuocNgoai === 'number') {
            today = { buy: null, sell: null, net: d1.nuocNgoai };
        } else {
            throw new Error('No Fiintrade foreign data available');
        }

        const num = (o, k) => (o && typeof o[k] === 'number') ? o[k] : null;
        const responseData = {
            success: true,
            source: 'fiintrade',
            today,
            trend: [
                { label: '1 phiên', net: today.net },
                { label: '5 phiên', net: num(d5, 'nuocNgoai') },
                { label: '20 phiên', net: num(d20, 'nuocNgoai') }
            ],
            timestamp: new Date().toISOString()
        };
        setCachedResponse('foreign-flow', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('Foreign flow error (Fiintrade):', error.message);
        // Fallback cuối: FireAnt HOSTC (chỉ HOSE, phiên hiện tại) — vẫn có buy/sell/net.
        try {
            const url = `${API_CONFIG.fireant.base}/Markets/IntradayMarketStatistic?symbol=HOSTC`;
            const data = await fetchAPI(url, API_CONFIG.fireant.headers);
            const latest = Array.isArray(data) ? data[data.length - 1] : data;
            const buy = Math.round(((latest?.BuyForeignValue || 0) / 1e9) * 10) / 10;
            const sell = Math.round(((latest?.SellForeignValue || 0) / 1e9) * 10) / 10;
            const net = Math.round((buy - sell) * 10) / 10;
            const responseData = {
                success: true,
                source: 'fireant',
                today: { buy, sell, net },
                trend: [
                    { label: '1 phiên', net },
                    { label: '5 phiên', net: null },
                    { label: '20 phiên', net: null }
                ],
                timestamp: new Date().toISOString()
            };
            setCachedResponse('foreign-flow', responseData);
            return res.json(responseData);
        } catch (e2) {
            console.error('Foreign flow FireAnt fallback failed:', e2.message);
            return res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
        }
    }
});

/**
 * GET /api/investor-detail
 * Chi tiết dòng tiền (khớp lệnh) theo CẢ 4 nhóm NĐT: Mua / Bán / Ròng hôm nay
 * (+ ròng 1 tuần / 1 tháng) kèm Top 10 mã Mua ròng & Bán ròng cho từng nhóm.
 * Nguồn: Fiintrade MoneyFlow/GetStatisticInvestor. Đơn vị: tỷ đồng.
 */
app.get('/api/investor-detail', async (req, res) => {
    const cached = getCachedResponse('investor-detail', 60000);
    if (cached) {
        console.log('📊 Returning cached investor-detail data');
        return res.json(cached);
    }
    try {
        console.log('📊 Fetching investor-detail (4 nhóm NĐT) from Fiintrade...');
        const keys = Object.keys(fiintrade.INVESTOR_TYPES); // individual, institution, proprietary, foreign
        const settled = await Promise.all(
            keys.map(k => fiintrade.getInvestorStatistic(k).catch(() => null))
        );
        const groups = settled.filter(Boolean);

        if (groups.length === 0) {
            return res.status(500).json({ success: false, error: 'No data from Fiintrade', timestamp: new Date().toISOString() });
        }

        console.log(`✅ Investor detail: ${groups.length}/4 nhóm NĐT (Fiintrade)`);
        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            source: 'fiintrade',
            groups
        };
        setCachedResponse('investor-detail', responseData);
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
    const cacheKey = `stock-investor-flow-${symbol}-${freq}`;
    const cached = getCachedResponse(cacheKey, 60000);
    if (cached) return res.json(cached);
    try {
        const result = await fiintrade.getStockInvestorFlow(symbol, freq);
        const responseData = { success: true, source: 'fiintrade', timestamp: new Date().toISOString(), ...result };
        setCachedResponse(cacheKey, responseData);
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
    const cacheKey = `news-${category || 'all'}-${limit}`;
    const cached = getCachedResponse(cacheKey, 120000);
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
        setCachedResponse(cacheKey, responseData);
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
    const cached = getCachedResponse('industry-stats', 60000);
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
        const batch17 = 'TA3,TA6,TA9,TAG,TAN,TAR,TAW,TB8,TBC,TBD,TBH,TBR,TBT,TBX,TC6,TCB,TCD,TCH,TCI,TCJ,TCK,TCL,TCM,TCO,TCR,TCT,TCW,TDB,TDC,TDF,TDG,TDH,TDM,TDN,TDP,TDS,TDT,TDW,TED,TEG,TEL,TET,TFC,TGG,TGP,TH1,THB,THD,THG,THI,THN,THP,THS,THT,THU,THW,TID,TIE,TIG,TIN,TIP,TIS,TIX,TJC,TKA,TKC,TKG,TKU,TL4,TLD,TLG,TLH,TLI,TLP,TLT,TMB,TMC,TMG,TMP,TMS,TMT,TMW,TMX,TN1,TNA,TNB,TNC,TNG,TNH,TNI,TNM,TNP,TNS,TNT,TNW,TOP,TOS,TOT,TOW,TPB,TPC,TPH,TPP,TPS';
        const batch18 = 'TQN,TQW,TR1,TRA,TRC,TRS,TRT,TS3,TS4,TSB,TSC,TSD,TSG,TSJ,TST,TTA,TTB,TTC,TTD,TTE,TTF,TTG,TTH,TTL,TTN,TTP,TTS,TTT,TTZ,TUG,TV1,TV2,TV3,TV4,TV6,TVA,TVB,TVC,TVD,TVG,TVH,TVM,TVN,TVP,TVS,TVT,TVW,TW3,TXM,TYA,UCT,UDC,UDJ,UDL,UEM,UIC,UMC,UNI,UPC,UPH,USC,USD,V11,V12,V15,V21,VAB,VAF,VAT,VAV,VBB,VBC,VBG,VBH,VC1,VC2,VC3,VC5,VC6,VC7,VC9,VCA,VCB,VCC,VCE,VCF,VCG,VCI,VCM,VCP,VCR,VCS,VCT,VCW,VCX,VDB,VDL,VDN,VDP,VDS,VDT';
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

        // Group by ICB2 code using Quotes (has IndustryCode) + MA10 from TradingStatistic
        const industryGroups = {};

        allQuotes.forEach(quote => {
            if (!quote.Symbol) return;

            // Get ICB2 code (first 2 digits + "00")
            const industryCode = quote.IndustryCode || '';
            const icb2 = industryCode.substring(0, 2) + '00';

            if (!ICB2_MAP[icb2]) return;

            if (!industryGroups[icb2]) {
                industryGroups[icb2] = {
                    code: icb2,
                    name: ICB2_MAP[icb2],
                    stocks: [],
                    totalActiveBuy: 0,
                    totalVolume: 0,
                    totalMarketCap: 0
                };
            }

            const priceCurrent = quote.PriceCurrent || 0;
            const ma10 = ma10Map[quote.Symbol] || 0;
            const activeBuy = quote.TotalActiveBuyVolume || 0;
            const totalVol = quote.TotalVolume || 0;
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

            industryGroups[icb2].totalActiveBuy += activeBuy;
            industryGroups[icb2].totalVolume += totalVol;
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

            // Lực cầu = TotalActiveBuyVolume / TotalVolume * 100
            const lucCau = group.totalVolume > 0 ? (group.totalActiveBuy / group.totalVolume) * 100 : 50;

            return {
                code: group.code,
                name: group.name,
                stockCount: totalStocks,
                percentAboveMA10: Math.round(percentAboveMA10 * 10) / 10,
                lucCau: Math.round(lucCau * 10) / 10,
                upCount,
                downCount,
                flatCount,
                marketCap: group.totalMarketCap
            };
        }).filter(g => g.stockCount >= 1);

        results.sort((a, b) => b.stockCount - a.stockCount);

        console.log(`✅ Industry stats: ${results.length} industries`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            data: results
        };
        setCachedResponse('industry-stats', responseData);
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

        if (!ICB2_MAP[industryCode]) {
            return res.status(400).json({ success: false, error: 'Invalid industry code' });
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
        const batch17 = 'TA3,TA6,TA9,TAG,TAN,TAR,TAW,TB8,TBC,TBD,TBH,TBR,TBT,TBX,TC6,TCB,TCD,TCH,TCI,TCJ,TCK,TCL,TCM,TCO,TCR,TCT,TCW,TDB,TDC,TDF,TDG,TDH,TDM,TDN,TDP,TDS,TDT,TDW,TED,TEG,TEL,TET,TFC,TGG,TGP,TH1,THB,THD,THG,THI,THN,THP,THS,THT,THU,THW,TID,TIE,TIG,TIN,TIP,TIS,TIX,TJC,TKA,TKC,TKG,TKU,TL4,TLD,TLG,TLH,TLI,TLP,TLT,TMB,TMC,TMG,TMP,TMS,TMT,TMW,TMX,TN1,TNA,TNB,TNC,TNG,TNH,TNI,TNM,TNP,TNS,TNT,TNW,TOP,TOS,TOT,TOW,TPB,TPC,TPH,TPP,TPS';
        const batch18 = 'TQN,TQW,TR1,TRA,TRC,TRS,TRT,TS3,TS4,TSB,TSC,TSD,TSG,TSJ,TST,TTA,TTB,TTC,TTD,TTE,TTF,TTG,TTH,TTL,TTN,TTP,TTS,TTT,TTZ,TUG,TV1,TV2,TV3,TV4,TV6,TVA,TVB,TVC,TVD,TVG,TVH,TVM,TVN,TVP,TVS,TVT,TVW,TW3,TXM,TYA,UCT,UDC,UDJ,UDL,UEM,UIC,UMC,UNI,UPC,UPH,USC,USD,V11,V12,V15,V21,VAB,VAF,VAT,VAV,VBB,VBC,VBG,VBH,VC1,VC2,VC3,VC5,VC6,VC7,VC9,VCA,VCB,VCC,VCE,VCF,VCG,VCI,VCM,VCP,VCR,VCS,VCT,VCW,VCX,VDB,VDL,VDN,VDP,VDS,VDT';
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

        // Filter ALL stocks by industry code and calculate lucCau per stock
        const icb2Prefix = industryCode.substring(0, 2);
        const industryStocks = [];
        let countAboveMA10 = 0;

        allQuotes.forEach(quote => {
            if (!quote.Symbol) return;

            const stockIndustryCode = quote.IndustryCode || '';
            if (stockIndustryCode.substring(0, 2) !== icb2Prefix) return;

            const priceCurrent = quote.PriceCurrent || 0;
            const ma10 = ma10Map[quote.Symbol] || 0;
            const activeBuy = quote.TotalActiveBuyVolume || 0;
            const totalVol = quote.TotalVolume || 0;

            // Lực cầu = ActiveBuyVolume / TotalVolume * 100
            const lucCau = totalVol > 0 ? (activeBuy / totalVol) * 100 : 0;
            const aboveMA10 = ma10 > 0 && priceCurrent > ma10;
            if (aboveMA10) countAboveMA10++;

            industryStocks.push({
                symbol: quote.Symbol,
                price: priceCurrent,
                ma10: ma10,
                aboveMA10: aboveMA10,
                lucCau: Math.round(lucCau * 100) / 100,
                totalVolume: totalVol,
                activeBuyVolume: activeBuy,
                percentChange: quote.PricePercentChange ? parseFloat((quote.PricePercentChange * 100).toFixed(2)) : 0
            });
        });

        // Sort: aboveMA10 first, then by lucCau descending
        industryStocks.sort((a, b) => {
            if (a.aboveMA10 !== b.aboveMA10) return b.aboveMA10 - a.aboveMA10;
            return b.lucCau - a.lucCau;
        });

        console.log(`✅ Industry ${industryCode} (${ICB2_MAP[industryCode]}): ${industryStocks.length} CP, ${countAboveMA10} trên MA10`);

        res.json({
            success: true,
            industryCode: industryCode,
            industryName: ICB2_MAP[industryCode],
            totalStocks: industryStocks.length,
            totalAboveMA10: countAboveMA10,
            stocks: industryStocks
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
                        if (q && q.Symbol && (q.IndustryCode || '').substring(0, 2) === icb2Prefix) {
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
    const cached = getCachedResponse('marketcap-stats', 60000);
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
            'Small': { stocks: [], totalActiveBuy: 0, totalVolume: 0 },
            'Mid': { stocks: [], totalActiveBuy: 0, totalVolume: 0 },
            'Large': { stocks: [], totalActiveBuy: 0, totalVolume: 0 },
            'Super Large': { stocks: [], totalActiveBuy: 0, totalVolume: 0 }
        };

        tradingData.forEach(stock => {
            if (!stock.Symbol || stock.Symbol.length !== 3) return;

            const quoteData = quotesResponse?.find(q => q.Symbol === stock.Symbol);

            const priceCurrent = quoteData?.PriceCurrent || stock.LastPriceClose || 0;
            const sharesOutstanding = stock.SharesOutStanding || 0;
            const marketCap = priceCurrent * sharesOutstanding;
            const ma10 = stock.AvgPrice10d || 0;
            const activeBuy = quoteData?.TotalActiveBuyVolume || 0;
            const totalVol = quoteData?.TotalVolume || 0;

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

            groups[groupName].totalActiveBuy += activeBuy;
            groups[groupName].totalVolume += totalVol;
        });

        // Calculate stats for each group
        const results = Object.entries(groups).map(([name, group]) => {
            const totalStocks = group.stocks.length;
            const stocksAboveMA10 = group.stocks.filter(s => s.aboveMA10).length;
            const percentAboveMA10 = totalStocks > 0 ? (stocksAboveMA10 / totalStocks) * 100 : 0;

            // Lực cầu = TotalActiveBuyVolume / TotalVolume * 100
            const lucCau = group.totalVolume > 0 ? (group.totalActiveBuy / group.totalVolume) * 100 : 50;

            return {
                name,
                label: MARKET_CAP_GROUPS[name].label,
                color: MARKET_CAP_GROUPS[name].color,
                stockCount: totalStocks,
                percentAboveMA10: Math.round(percentAboveMA10 * 10) / 10,
                lucCau: Math.round(lucCau * 10) / 10
            };
        });

        console.log(`✅ Market cap stats: ${results.length} groups`);

        const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            data: results
        };
        setCachedResponse('marketcap-stats', responseData);
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

        // Market cap thresholds
        const thresholds = [
            { name: 'Super Large', min: 100e12 },
            { name: 'Large', min: 20e12 },
            { name: 'Mid', min: 1e12 },
            { name: 'Small', min: 0 }
        ];

        const targetGroup = thresholds.find(t => t.name === groupName);
        if (!targetGroup) {
            return res.status(400).json({ success: false, error: 'Invalid group name' });
        }

        const nextGroup = thresholds[thresholds.indexOf(targetGroup) + 1];
        const maxCap = nextGroup ? nextGroup.min : Infinity;

        const stocks = [];
        let countAboveMA10 = 0;

        tradingData.forEach(stock => {
            if (!stock.Symbol || stock.Symbol.length !== 3) return;

            const quote = quoteMap[stock.Symbol] || {};
            const priceCurrent = quote.PriceCurrent || stock.LastPriceClose || 0;
            const sharesOutstanding = stock.SharesOutStanding || 0;
            const marketCap = priceCurrent * sharesOutstanding;

            // Filter by group
            if (marketCap < targetGroup.min || marketCap >= maxCap) return;

            const ma10 = stock.AvgPrice10d || 0;
            const activeBuy = quote.TotalActiveBuyVolume || 0;
            const totalVol = quote.TotalVolume || 0;
            const lucCau = totalVol > 0 ? (activeBuy / totalVol) * 100 : 0;
            const aboveMA10 = ma10 > 0 && priceCurrent > ma10;

            if (aboveMA10) countAboveMA10++;

            stocks.push({
                symbol: stock.Symbol,
                price: priceCurrent,
                ma10: ma10,
                aboveMA10,
                lucCau: Math.round(lucCau * 100) / 100,
                totalVolume: totalVol,
                activeBuyVolume: activeBuy,
                percentChange: quote.PricePercentChange ? parseFloat((quote.PricePercentChange * 100).toFixed(2)) : 0,
                marketCap
            });
        });

        // Sort: aboveMA10 first, then by lucCau descending
        stocks.sort((a, b) => {
            if (a.aboveMA10 !== b.aboveMA10) return b.aboveMA10 - a.aboveMA10;
            return b.lucCau - a.lucCau;
        });

        console.log(`✅ [marketcap-top-stocks] ${groupName}: ${stocks.length} CP, ${countAboveMA10} trên MA10`);

        res.json({
            success: true,
            groupName,
            totalStocks: stocks.length,
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
    const cached = getCachedResponse('vnindex-demand', 30000);
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
        setCachedResponse('vnindex-demand', responseData);
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
    const cached = getCachedResponse('vn30-demand', 30000);
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
        setCachedResponse('vn30-demand', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('VN30 demand error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// FILTER PRESETS API (Persistent Storage)
// ==========================================

const PRESETS_FILE = path.join(__dirname, 'data', 'filter-presets.json');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Helper function to read presets from file
function readPresets() {
    try {
        if (fs.existsSync(PRESETS_FILE)) {
            const data = fs.readFileSync(PRESETS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error reading presets file:', error.message);
    }
    return {};
}

// Helper function to write presets to file
function writePresets(presets) {
    try {
        fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Error writing presets file:', error.message);
        return false;
    }
}

/**
 * GET /api/filter-presets
 * Lấy tất cả các bộ lọc đã lưu
 */
app.get('/api/filter-presets', (req, res) => {
    try {
        console.log('📂 Loading filter presets...');
        const presets = readPresets();
        console.log(`✅ Loaded ${Object.keys(presets).length} presets`);
        res.json({
            success: true,
            presets: presets
        });
    } catch (error) {
        console.error('Error loading presets:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/filter-presets
 * Lưu hoặc cập nhật một bộ lọc
 * Body: { name: string, conditions: array }
 */
app.post('/api/filter-presets', (req, res) => {
    try {
        const { name, conditions } = req.body;

        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({ success: false, error: 'Invalid preset name' });
        }

        if (!conditions || !Array.isArray(conditions)) {
            return res.status(400).json({ success: false, error: 'Invalid conditions' });
        }

        console.log(`💾 Saving filter preset: "${name}"`);

        const presets = readPresets();
        presets[name.trim()] = conditions;

        if (writePresets(presets)) {
            console.log(`✅ Preset "${name}" saved successfully`);
            res.json({ success: true, message: 'Preset saved' });
        } else {
            res.status(500).json({ success: false, error: 'Failed to save preset' });
        }
    } catch (error) {
        console.error('Error saving preset:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/filter-presets/:name
 * Xóa một bộ lọc
 */
app.delete('/api/filter-presets/:name', (req, res) => {
    try {
        const name = decodeURIComponent(req.params.name);

        console.log(`🗑️ Deleting filter preset: "${name}"`);

        const presets = readPresets();

        if (!presets[name]) {
            return res.status(404).json({ success: false, error: 'Preset not found' });
        }

        delete presets[name];

        if (writePresets(presets)) {
            console.log(`✅ Preset "${name}" deleted successfully`);
            res.json({ success: true, message: 'Preset deleted' });
        } else {
            res.status(500).json({ success: false, error: 'Failed to delete preset' });
        }
    } catch (error) {
        console.error('Error deleting preset:', error);
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
    const cached = getCachedResponse('top-net-stocks', 60000);
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
        setCachedResponse('top-net-stocks', responseData);
        res.json(responseData);
    } catch (error) {
        // Fallback: trả cache gần nhất (dù đã hết hạn) khi Google Sheet lỗi/timeout.
        const stale = getStaleResponse('top-net-stocks');
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
// START SERVER
// ==========================================

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
});
