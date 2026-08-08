/**
 * fireant-financials.js — Fetch quarterly financial statements (income statement)
 * từ restv2.fireant.vn bằng Playwright (login FireAnt → capture Bearer token → fetch).
 *
 * Lý do dùng Playwright: restv2 API từ chối request ngoài browser (IP-bind/CORS).
 * Token phải được fetch từ bên trong browser context sau khi login.
 *
 * Cache: token 30 phút, financial data 6 giờ (data quý đổi chậm).
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'data');
const TOKEN_CACHE_FILE = path.join(CACHE_DIR, 'fireant-token.json');
const FINANCIALS_CACHE_DIR = path.join(CACHE_DIR, 'financials-cache');

const TOKEN_TTL_MS = 30 * 60 * 1000;        // 30 phút
const FINANCIALS_TTL_MS = 6 * 60 * 60 * 1000; // 6 giờ

// Đảm bảo cache dir tồn tại
if (!fs.existsSync(FINANCIALS_CACHE_DIR)) {
    try { fs.mkdirSync(FINANCIALS_CACHE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

// ── Token cache (in-memory + disk) ─────────────────────────────────────────

let _tokenCache = null;
let _tokenFetching = null;

function loadTokenFromDisk() {
    try {
        const raw = fs.readFileSync(TOKEN_CACHE_FILE, 'utf-8');
        const obj = JSON.parse(raw);
        if (obj.token && obj.fetchedAt && Date.now() - obj.fetchedAt < TOKEN_TTL_MS) {
            return obj.token;
        }
    } catch (e) { /* ignore */ }
    return null;
}

function saveTokenToDisk(token) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token, fetchedAt: Date.now() }));
    } catch (e) { /* ignore */ }
}

function getCachedToken() {
    if (_tokenCache && _tokenCache.token && Date.now() - _tokenCache.fetchedAt < TOKEN_TTL_MS) {
        return _tokenCache.token;
    }
    const disk = loadTokenFromDisk();
    if (disk) {
        _tokenCache = { token: disk, fetchedAt: Date.now() };
        return disk;
    }
    return null;
}

/**
 * Login FireAnt qua Playwright → capture Bearer token từ network requests.
 * @returns {Promise<string|null>}
 */
async function fetchFreshToken() {
    const email = process.env.FIREANT_EMAIL;
    const password = process.env.FIREANT_PASSWORD;
    if (!email || !password) {
        console.error('❌ [FireAntFinancials] FIREANT_EMAIL/PASSWORD chưa cấu hình trong .env');
        return null;
    }

    console.log('🔐 [FireAntFinancials] Đang login FireAnt để lấy token...');
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'vi-VN',
        });
        const page = await context.newPage();

        let token = null;
        page.on('request', function (req) {
            const auth = req.headers()['authorization'] || '';
            if (req.url().indexOf('restv2.fireant.vn') !== -1 && auth.startsWith('Bearer ') && !token) {
                token = auth.substring(7);
            }
        });

        await page.goto('https://fireant.vn', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.locator('button:has-text("Đăng nhập")').first().click();
        await page.waitForURL(/accounts\.fireant\.vn\/login/, { timeout: 20000 });
        await page.waitForSelector('#username', { timeout: 10000 });
        await page.fill('#username', email);
        await page.fill('#password', password);
        const rem = page.locator('#rememberMe');
        if (await rem.count() > 0) await rem.check();
        await page.click('button.btn-primary');
        await page.waitForURL(/fireant\.vn(?!.*accounts)/, { timeout: 30000 });

        // SPA trigger restv2 calls
        await page.goto('https://www.fireant.vn/App#/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(8000);

        if (token) {
            _tokenCache = { token: token, fetchedAt: Date.now() };
            saveTokenToDisk(token);
            console.log('✅ [FireAntFinancials] Token captured (' + token.length + ' chars)');
            return token;
        }
        console.error('❌ [FireAntFinancials] Không capture được token sau login');
        return null;
    } catch (e) {
        console.error('❌ [FireAntFinancials] Login error:', e.message);
        return null;
    } finally {
        await browser.close();
    }
}

/**
 * Lấy token (cache hoặc fetch mới). Dedupe concurrent fetches.
 */
async function getToken() {
    const cached = getCachedToken();
    if (cached) return cached;

    if (!_tokenFetching) {
        _tokenFetching = fetchFreshToken().catch(function () { return null; });
    }
    const result = await _tokenFetching;
    _tokenFetching = null;
    return result;
}

// ── Financial data fetch ───────────────────────────────────────────────────

/**
 * Fetch financial-data từ browser context (token chỉ work trong browser).
 * @param {string} symbol  Mã cổ phiếu (VD: FPT)
 * @param {number} count   Số quý (VD: 8, 16)
 * @param {number} type    1=quarterly, 2=annual
 * @returns {Promise<object|null>}  { symbol, data: [...], fetchedAt }
 */
async function fetchFinancialsViaBrowser(symbol, count, type) {
    count = count || 8;
    type = type || 1;
    const token = await getToken();
    if (!token) return null;

    console.log('📊 [FireAntFinancials] Fetching ' + symbol + ' (count=' + count + ', type=' + type + ')');
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'vi-VN',
        });
        const page = await context.newPage();
        await page.goto('https://www.fireant.vn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000);

        const result = await page.evaluate(async function (params) {
            try {
                var resp = await fetch('https://restv2.fireant.vn/symbols/' + params.symbol + '/financial-data?type=' + params.type + '&count=' + params.count, {
                    headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + params.token }
                });
                if (!resp.ok) return { error: 'HTTP ' + resp.status };
                var data = await resp.json();
                return { ok: true, data: data };
            } catch (e) { return { error: e.message }; }
        }, { symbol: symbol, type: type, count: count, token: token });

        if (!result || result.error) {
            console.error('❌ [FireAntFinancials] fetch failed:', result ? result.error : 'null');
            // Nếu 401, invalidate token để lần sau refresh
            if (result && result.error === 'HTTP 401') {
                _tokenCache = null;
                try { fs.unlinkSync(TOKEN_CACHE_FILE); } catch (e) { /* ignore */ }
            }
            return null;
        }

        return {
            symbol: symbol,
            type: type,
            count: count,
            data: result.data,
            fetchedAt: Date.now()
        };
    } catch (e) {
        console.error('❌ [FireAntFinancials] browser error:', e.message);
        return null;
    } finally {
        await browser.close();
    }
}

// ── Cache layer ────────────────────────────────────────────────────────────

function cacheKey(symbol, count, type) {
    return symbol.toUpperCase() + '_' + type + '_' + count + '.json';
}

function loadFinancialsCache(symbol, count, type) {
    try {
        const file = path.join(FINANCIALS_CACHE_DIR, cacheKey(symbol, count, type));
        const raw = fs.readFileSync(file, 'utf-8');
        const obj = JSON.parse(raw);
        if (obj && obj.fetchedAt && Date.now() - obj.fetchedAt < FINANCIALS_TTL_MS) {
            return obj;
        }
    } catch (e) { /* ignore */ }
    return null;
}

function saveFinancialsCache(obj) {
    try {
        const file = path.join(FINANCIALS_CACHE_DIR, cacheKey(obj.symbol, obj.count, obj.type));
        fs.writeFileSync(file, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
}

// Dedupe concurrent requests cho cùng symbol
const _inFlight = {};

/**
 * API chính: lấy financial data (quarterly income statement) cho 1 symbol.
 * Có cache 6 giờ + dedupe concurrent requests.
 *
 * @param {string} symbol
 * @param {number} count  Số quý (default 8)
 * @param {number} type   1=quarterly (default), 2=annual
 * @returns {Promise<object|null>}
 */
async function getFinancials(symbol, count, type) {
    count = count || 8;
    type = type || 1;

    // 1. Check cache
    const cached = loadFinancialsCache(symbol, count, type);
    if (cached) return cached;

    // 2. Dedupe
    const key = symbol.toUpperCase() + ':' + type + ':' + count;
    if (_inFlight[key]) return _inFlight[key];

    // 3. Fetch
    _inFlight[key] = (async function () {
        const result = await fetchFinancialsViaBrowser(symbol, count, type);
        if (result) saveFinancialsCache(result);
        delete _inFlight[key];
        return result;
    })();

    return _inFlight[key];
}

/**
 * Trích các trường quan trọng (doanh thu, lợi nhuận, EPS, biên lợi nhuận) 
 * từ raw financial-data records → format dễ render frontend.
 */
function extractKeyMetrics(rawData) {
    if (!Array.isArray(rawData)) return [];

    return rawData.map(function (rec) {
        var fv = rec.financialValues || {};
        var netSale = fv.NetSale || fv.TotalRevenue || 0;
        var grossProfit = fv.GrossProfit || 0;
        var profitAfterTax = fv.ProfitAfterTax || 0;
        var eps = fv.BasicEPS || fv.EPS || 0;
        var ebitda = fv.EBITDA || 0;

        var grossMargin = netSale > 0 ? (grossProfit / netSale * 100) : 0;
        var netMargin = netSale > 0 ? (profitAfterTax / netSale * 100) : 0;

        return {
            year: rec.year,
            quarter: rec.quarter,
            period: 'Q' + rec.quarter + ' ' + rec.year,
            netSale: netSale,
            grossProfit: grossProfit,
            profitAfterTax: profitAfterTax,
            eps: eps,
            ebitda: ebitda,
            grossMargin: grossMargin,
            netMargin: netMargin
        };
    });
}

module.exports = {
    getFinancials: getFinancials,
    extractKeyMetrics: extractKeyMetrics,
    fetchFinancialsViaBrowser: fetchFinancialsViaBrowser,
    getToken: getToken,
    FINANCIALS_TTL_MS: FINANCIALS_TTL_MS,
    TOKEN_TTL_MS: TOKEN_TTL_MS
};
