/**
 * FIREANT COOKIE SYNC
 * ============================================================
 * Tự động đăng nhập FireAnt bằng Playwright, lấy cookie
 * FireAnt.Authentication.v3, rồi đẩy lên Google Apps Script
 * để lưu vào Google Sheets D2 — giữ nguyên pipeline cũ.
 *
 * Chạy standalone:  node cookie-sync.js
 * Tích hợp server:  require('./cookie-sync').startAutoSync()
 *
 * Flow:
 *   Playwright login fireant.vn
 *     → navigate to /App#/dashboard (để cookie .v3 xuất hiện)
 *     → extract FireAnt.Authentication.v3
 *     → POST ?cookie=<value> lên Apps Script URL
 *     → Apps Script ghi vào D2 → server đọc bình thường
 */

require('dotenv').config();
const { chromium } = require('playwright');
const axios        = require('axios');

// ── Config ──────────────────────────────────────────────────────────────────
const EMAIL           = process.env.FIREANT_EMAIL;
const PASSWORD        = process.env.FIREANT_PASSWORD;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // URL Apps Script web app
const SYNC_INTERVAL_H = parseFloat(process.env.COOKIE_SYNC_HOURS || '5'); // mặc định 5 tiếng
const SYNC_INTERVAL_MS = SYNC_INTERVAL_H * 60 * 60 * 1000;

// ── State ────────────────────────────────────────────────────────────────────
let syncTimer = null;

// ── Core: Login + lấy cookie ─────────────────────────────────────────────────

async function loginAndGetCookie() {
    console.log('🔐 [CookieSync] Đang đăng nhập FireAnt...');

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            viewport : { width: 1280, height: 800 },
            locale   : 'vi-VN',
        });
        const page = await context.newPage();

        // 1. Trang chủ
        await page.goto('https://fireant.vn', { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 2. Click "Đăng nhập" → redirect accounts.fireant.vn
        await page.locator('button:has-text("Đăng nhập")').first().click();
        await page.waitForURL(/accounts\.fireant\.vn\/login/, { timeout: 20000 });

        // 3. Điền form
        await page.waitForSelector('#username', { timeout: 10000 });
        await page.fill('#username', EMAIL);
        await page.fill('#password', PASSWORD);

        // Tick "Ghi nhớ" để cookie sống lâu hơn
        const rem = page.locator('#rememberMe');
        if (await rem.count() > 0) await rem.check();

        // 4. Submit (nút có class btn-primary)
        await page.click('button.btn-primary');

        // 5. Chờ redirect về fireant.vn
        await page.waitForURL(/fireant\.vn(?!.*accounts)/, { timeout: 30000 });

        // 6. Vào /App#/dashboard để FireAnt.Authentication.v3 xuất hiện
        await page.goto('https://www.fireant.vn/App#/dashboard', {
            waitUntil: 'networkidle',
            timeout  : 30000,
        });
        await page.waitForTimeout(2000); // đảm bảo cookie được set

        // 7. Lấy toàn bộ cookies
        const allCookies = await context.cookies([
            'https://fireant.vn',
            'https://www.fireant.vn',
            'https://accounts.fireant.vn',
        ]);

        // 8. Tìm FireAnt.Authentication.v3
        const authCookie = allCookies.find(c => c.name === 'FireAnt.Authentication.v3');
        if (!authCookie) {
            throw new Error('Không tìm thấy cookie FireAnt.Authentication.v3 sau khi đăng nhập');
        }

        console.log(`✅ [CookieSync] Lấy được FireAnt.Authentication.v3 (${authCookie.value.length} ký tự)`);
        return authCookie.value;

    } finally {
        await browser.close();
    }
}

// ── Push cookie lên Google Apps Script → Google Sheets ───────────────────────

async function pushCookieToSheets(cookieValue) {
    if (!APPS_SCRIPT_URL) {
        console.warn('⚠️  [CookieSync] APPS_SCRIPT_URL chưa cấu hình trong .env — bỏ qua bước push.');
        return false;
    }

    try {
        const url  = `${APPS_SCRIPT_URL}?cookie=${encodeURIComponent(cookieValue)}`;
        const resp = await axios.get(url, { timeout: 15000 });
        const body = resp.data;

        if (body.status === 'success') {
            console.log('✅ [CookieSync] Google Sheets D2 đã được cập nhật:', body.message);
            return true;
        } else {
            console.error('❌ [CookieSync] Apps Script lỗi:', body.message);
            return false;
        }
    } catch (err) {
        console.error('❌ [CookieSync] Không kết nối được Apps Script:', err.message);
        return false;
    }
}

// ── Main sync job ─────────────────────────────────────────────────────────────

async function runSync() {
    const timestamp = new Date().toLocaleString('vi-VN');
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🔄 [CookieSync] Bắt đầu sync lúc ${timestamp}`);

    try {
        const cookieValue = await loginAndGetCookie();
        await pushCookieToSheets(cookieValue);
        console.log(`✅ [CookieSync] Sync hoàn tất! Lần sync tiếp theo sau ${SYNC_INTERVAL_H} giờ.`);
        const nextTime = new Date(Date.now() + SYNC_INTERVAL_MS);
        console.log(`⏰ [CookieSync] Lần tiếp: ${nextTime.toLocaleString('vi-VN')}`);
        return true;
    } catch (err) {
        console.error('❌ [CookieSync] Sync thất bại:', err.message);
        console.log('   → Sẽ thử lại sau 30 phút...');
        // Retry sau 30 phút nếu thất bại
        setTimeout(runSync, 30 * 60 * 1000);
        return false;
    }
}

// ── Auto-sync theo lịch ───────────────────────────────────────────────────────

function startAutoSync() {
    console.log(`🚀 [CookieSync] Khởi động auto-sync mỗi ${SYNC_INTERVAL_H} giờ`);

    // Chạy ngay lần đầu
    runSync();

    // Lặp theo interval
    syncTimer = setInterval(runSync, SYNC_INTERVAL_MS);
    return syncTimer;
}

function stopAutoSync() {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
        console.log('⛔ [CookieSync] Đã dừng auto-sync.');
    }
}

module.exports = { runSync, startAutoSync, stopAutoSync, loginAndGetCookie };

// ── Standalone: node cookie-sync.js ──────────────────────────────────────────
if (require.main === module) {
    (async () => {
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║   FIREANT COOKIE SYNC — STANDALONE TEST      ║');
        console.log('╚══════════════════════════════════════════════╝');
        console.log('Email          :', EMAIL);
        console.log('Apps Script URL:', APPS_SCRIPT_URL || '(chưa cấu hình)');
        console.log('Sync interval  :', SYNC_INTERVAL_H, 'giờ');
        console.log('');

        const ok = await runSync();
        process.exit(ok ? 0 : 1);
    })();
}
