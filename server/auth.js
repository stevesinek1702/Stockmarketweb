const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const ACCESS_TTL = '15m';       // access token 15 phút
const REFRESH_TTL = '7d';       // refresh token 7 ngày
const COOKIE_ACCESS = 'vnstock_access';
const COOKIE_REFRESH = 'vnstock_refresh';

const BCRYPT_ROUNDS = 12;

/**
 * Hash mật khẩu (bcryptjs).
 * @param {string} plain
 * @returns {Promise<string>} hash
 */
async function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * So sánh mật khẩu với hash.
 * @param {string} plain
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

/**
 * Tạo access JWT cho user.
 * Payload: { sub, username, role }
 */
function signAccessToken(user) {
    return jwt.sign(
        { sub: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: ACCESS_TTL }
    );
}

/**
 * Tạo refresh JWT (chỉ chứa sub — scope hẹp để gia hạn).
 */
function signRefreshToken(user) {
    return jwt.sign({ sub: user.id, refresh: true }, JWT_SECRET, { expiresIn: REFRESH_TTL });
}

/**
 * Verify JWT. Trả payload hoặc throw.
 */
function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

/**
 * Cookie options chuẩn: httpOnly + SameSite=Strict + path=/.
 * secure chỉ bật khi NODE_ENV=production (cần HTTPS).
 */
function cookieOptions(maxAgeSec) {
    return {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: maxAgeSec * 1000,
        // secure chỉ bật khi có HTTPS (COOKIE_SECURE=true).
        // Mặc định FALSE để HTTP hoạt động — khi deploy HTTPS, set COOKIE_SECURE=true.
        // Lưu ý: KHÔNG bind theo NODE_ENV vì dev/prod đều có thể chạy HTTP.
        secure: process.env.COOKIE_SECURE === 'true'
    };
}

const ACCESS_COOKIE_AGE = 15 * 60;          // 15 phút
const REFRESH_COOKIE_AGE = 7 * 24 * 3600;   // 7 ngày

/**
 * Set cả 2 cookie (access + refresh) vào response.
 */
function setAuthCookies(res, user) {
    res.cookie(COOKIE_ACCESS, signAccessToken(user), cookieOptions(ACCESS_COOKIE_AGE));
    res.cookie(COOKIE_REFRESH, signRefreshToken(user), cookieOptions(REFRESH_COOKIE_AGE));
}

/**
 * Xoá cả 2 cookie.
 */
function clearAuthCookies(res) {
    res.clearCookie(COOKIE_ACCESS, { path: '/' });
    res.clearCookie(COOKIE_REFRESH, { path: '/' });
}

// ==========================================
// MIDDLEWARE
// ==========================================

/**
 * Middleware: đọc access cookie → verify → gắn req.user.
 * Nếu không có token / token hết hạn → cố gắng refresh qua refresh cookie.
 * Nếu cả 2 đều thất bại → req.user = null (không chặn — endpoint tự quyết).
 */
async function authenticate(req, res, next) {
    // Internal bypass: scheduler self-call gửi X-Internal-Secret.
    // Chỉ server nội bộ biết giá trị này → không phải vector attack từ ngoài
    // (kẻ tấn công bên ngoài không biết INTERNAL_SECRET).
    const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'vnstock-scheduler-internal';
    if (req.get('X-Internal-Secret') === INTERNAL_SECRET) {
        req.user = { id: 0, username: 'scheduler', role: 'system' };
        return next();
    }

    const access = req.cookies && req.cookies[COOKIE_ACCESS];
    const refresh = req.cookies && req.cookies[COOKIE_REFRESH];

    // 1. Thử access token
    if (access) {
        try {
            const payload = verifyToken(access);
            req.user = { id: payload.sub, username: payload.username, role: payload.role };
            return next();
        } catch (e) {
            // access hết hạn → thử refresh bên dưới
        }
    }

    // 2. Thử refresh token → cấp access mới
    if (refresh) {
        try {
            const payload = verifyToken(refresh);
            // Load user từ DB (để bắt trường hợp bị disable sau khi cấp token)
            const r = await query(`SELECT id, username, role, status FROM users WHERE id = $1`, [payload.sub]);
            if (r.rowCount > 0 && r.rows[0].status === 'active') {
                const u = r.rows[0];
                req.user = { id: u.id, username: u.username, role: u.role };
                // Rotate: cấp access cookie mới
                res.cookie(COOKIE_ACCESS, signAccessToken(u), cookieOptions(ACCESS_COOKIE_AGE));
                return next();
            }
        } catch (e) {
            // refresh cũng hết hạn → clear cookies
        }
    }

    // 3. Không auth
    req.user = null;
    next();
}

/**
 * Middleware: yêu cầu đã login. Nếu chưa → 401.
 */
function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    next();
}

/**
 * Middleware: yêu cầu role=admin.
 */
function requireAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    next();
}

module.exports = {
    hashPassword,
    verifyPassword,
    signAccessToken,
    signRefreshToken,
    verifyToken,
    setAuthCookies,
    clearAuthCookies,
    authenticate,
    requireAuth,
    requireAdmin,
    COOKIE_ACCESS,
    COOKIE_REFRESH
};
