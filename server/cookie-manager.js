/**
 * FIREANT COOKIE MANAGER
 * Dùng Playwright để tự động đăng nhập FireAnt và lấy cookie tươi.
 * Cookie được cache trong memory, tự re-login khi hết hạn.
 *
 * Flow login đúng của FireAnt:
 *   fireant.vn → click "Đăng nhập"
 *   → redirect: accounts.fireant.vn/login?signin=...
 *   → nhập username + password → submit
 *   → redirect về fireant.vn (đã authenticated)
 *   → lấy cookie từ context
 */

require('dotenv').config();
const { chromium } = require('playwright');

// ── Config ──────────────────────────────────────────────────────────────────
const EMAIL     = process.env.FIREANT_EMAIL;
const PASSWORD  = process.env.FIREANT_PASSWORD;
const TTL_MS    = (parseFloat(process.env.COOKIE_TTL_HOURS) || 6) * 60 * 60 * 1000;

// ── State ────────────────────────────────────────────────────────────────────
let cachedCookie    = '';
let cookieExpiresAt = 0;
let isLoggingIn     = false;
let loginPromise    = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build cookie string từ mảng cookie objects của Playwright */
function buildCookieString(cookies) {
    return cookies
        .filter(c => c.domain && (c.domain.includes('fireant.vn') || c.domain.includes('accounts.fireant.vn')))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
}

/** Thực hiện đăng nhập bằng Playwright và trả về cookie string */
async function doLogin() {
    console.log('🔐 [CookieManager] Đang đăng nhập FireAnt...');

    if (!EMAIL || !PASSWORD) {
        throw new Error('Thiếu FIREANT_EMAIL hoặc FIREANT_PASSWORD trong .env');
    }

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ]
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'vi-VN',
        });

        const page = await context.newPage();

        // ── Bước 1: Vào trang chủ FireAnt ─────────────────────────────────
        console.log('   → [1/5] Mở fireant.vn...');
        await page.goto('https://fireant.vn', { waitUntil: 'domcontentloaded', timeout: 30000 });

        // ── Bước 2: Click nút "Đăng nhập" → redirect sang accounts.fireant.vn ──
        console.log('   → [2/5] Click nút Đăng nhập...');
        const loginBtn = page.locator('button:has-text("Đăng nhập")').first();
        await loginBtn.click();

        // Chờ redirect sang accounts.fireant.vn
        await page.waitForURL(/accounts\.fireant\.vn\/login/, { timeout: 20000 });
        console.log('   → Đang ở trang login:', page.url().substring(0, 80));

        // ── Bước 3: Điền username ──────────────────────────────────────────
        console.log('   → [3/5] Điền username...');
        await page.waitForSelector('#username', { timeout: 10000 });
        await page.fill('#username', EMAIL);

        // ── Bước 4: Điền password ──────────────────────────────────────────
        console.log('   → [4/5] Điền password...');
        await page.fill('#password', PASSWORD);

        // Tick "Ghi nhớ đăng nhập" để cookie tồn tại lâu hơn
        const rememberMe = page.locator('#rememberMe');
        if (await rememberMe.count() > 0) {
            await rememberMe.check();
        }

        // ── Bước 5: Submit form ─────────────────────────────────────
        console.log('   → [5/5] Submit đăng nhập...');
        // Nút có class btn-primary (không phải type=submit do trang dùng Angular/React)
        await page.click('button.btn-primary');

        // Chờ redirect về fireant.vn sau khi login thành công
        await page.waitForURL(/fireant\.vn(?!.*accounts)/, { timeout: 30000 });
        // Chờ thêm để session cookie được set đầy đủ
        await page.waitForTimeout(2500);

        console.log('   → URL sau login:', page.url().substring(0, 80));

        // ── Lấy cookies ───────────────────────────────────────────────────
        const allCookies = await context.cookies([
            'https://fireant.vn',
            'https://www.fireant.vn',
            'https://accounts.fireant.vn',
            'https://restv2.fireant.vn',
        ]);

        const cookieStr = buildCookieString(allCookies);

        if (!cookieStr) {
            throw new Error('Đăng nhập có vẻ OK nhưng không tìm thấy cookie nào từ fireant.vn');
        }

        const hasAuth = cookieStr.includes('FireAnt.Authentication');
        console.log(`✅ [CookieManager] Login thành công!`);
        console.log(`   Có FireAnt.Authentication: ${hasAuth ? 'YES ✅' : 'NO ⚠️'}`);
        console.log(`   Cookie preview: ${cookieStr.substring(0, 80)}...`);
        console.log(`   Tổng số cookies: ${allCookies.filter(c => c.domain.includes('fireant')).length}`);

        return cookieStr;

    } finally {
        await browser.close();
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Trả về cookie string hợp lệ.
 * Nếu chưa có hoặc đã hết hạn → tự đăng nhập lại.
 */
async function getCookie() {
    const now = Date.now();

    // Cookie còn hạn → dùng luôn
    if (cachedCookie && now < cookieExpiresAt) {
        return cachedCookie;
    }

    // Nếu đang login rồi (concurrent request) → chờ promise đó
    if (isLoggingIn && loginPromise) {
        console.log('⏳ [CookieManager] Đang chờ login đang diễn ra...');
        await loginPromise;
        return cachedCookie;
    }

    // Bắt đầu login
    isLoggingIn  = true;
    loginPromise = doLogin()
        .then(cookie => {
            cachedCookie    = cookie;
            cookieExpiresAt = Date.now() + TTL_MS;
            console.log(`⏰ [CookieManager] Cookie hết hạn lúc ${new Date(cookieExpiresAt).toLocaleTimeString('vi-VN')}`);
        })
        .catch(err => {
            console.error('❌ [CookieManager] Login thất bại:', err.message);
            cachedCookie = ''; // reset để lần sau thử lại
        })
        .finally(() => {
            isLoggingIn  = false;
            loginPromise = null;
        });

    await loginPromise;
    return cachedCookie;
}

/**
 * Vô hiệu hóa cookie → lần sau getCookie() sẽ re-login.
 * Gọi khi nhận 401/403 từ FireAnt API.
 */
function invalidate() {
    console.log('🔄 [CookieManager] Cookie bị invalidate → sẽ re-login lần sau.');
    cachedCookie    = '';
    cookieExpiresAt = 0;
}

/** Thông tin debug */
function status() {
    return {
        hasCookie:  !!cachedCookie,
        expiresAt:  cookieExpiresAt ? new Date(cookieExpiresAt).toISOString() : null,
        isLoggingIn,
        preview:    cachedCookie ? cachedCookie.substring(0, 80) + '...' : '(none)',
    };
}

module.exports = { getCookie, invalidate, status };

// ── Standalone test ───────────────────────────────────────────────────────────
if (require.main === module) {
    (async () => {
        console.log('╔══════════════════════════════════════╗');
        console.log('║   TEST FIREANT AUTO-LOGIN            ║');
        console.log('╚══════════════════════════════════════╝');
        console.log('Email :', EMAIL);
        console.log('TTL   :', TTL_MS / 3600000, 'giờ');
        console.log('');

        try {
            const cookie = await getCookie();
            if (cookie) {
                console.log('\n╔══════════════════════════════════════╗');
                console.log('║   ✅ TEST PASS!                       ║');
                console.log('╚══════════════════════════════════════╝');
                console.log('Cookie length:', cookie.length, 'ký tự');
                console.log('Có FireAnt.Authentication:', cookie.includes('FireAnt.Authentication') ? '✅ YES' : '❌ NO');
                console.log('\nFull cookie string:');
                console.log(cookie);
            } else {
                console.log('\n❌ TEST FAIL — Không lấy được cookie');
                process.exit(1);
            }
        } catch (err) {
            console.error('\n❌ TEST ERROR:', err.message);
            process.exit(1);
        }
    })();
}
