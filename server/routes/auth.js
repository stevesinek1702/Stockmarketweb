const express = require('express');
const router = express.Router();
const { query } = require('../db');
const {
    hashPassword, verifyPassword, setAuthCookies, clearAuthCookies,
    requireAuth
} = require('../auth');

// ==========================================
// VALIDATION HELPERS (shared — also in admin.js)
// ==========================================

function validUsername(u) {
    return typeof u === 'string' && /^[a-zA-Z0-9_]{3,30}$/.test(u);
}
function validPassword(p) {
    return typeof p === 'string' && p.length >= 6 && p.length <= 200;
}
function validEmail(e) {
    return !e || (typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

/**
 * Strip thông tin nhạy cảm khỏi user record trước khi trả về client.
 */
function sanitizeUser(u) {
    return {
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        created_at: u.created_at,
        approved_at: u.approved_at,
        last_login_at: u.last_login_at
    };
}

// ==========================================
// AUTH ENDPOINTS (public: register/login/logout; me requires login)
// ==========================================

/**
 * POST /api/auth/register
 * User tự đăng ký → status=pending (chờ admin duyệt).
 */
router.post('/register', async (req, res) => {
    try {
        const { username, password, email } = req.body;
        if (!validUsername(username)) {
            return res.status(400).json({ success: false, error: 'Username 3-30 ký tự (chữ/số/_)' });
        }
        if (!validPassword(password)) {
            return res.status(400).json({ success: false, error: 'Mật khẩu tối thiểu 6 ký tự' });
        }
        if (!validEmail(email)) {
            return res.status(400).json({ success: false, error: 'Email không hợp lệ' });
        }

        const dup = await query(
            `SELECT username FROM users WHERE username = $1 OR (email IS NOT NULL AND email = $2)`,
            [username, email || null]
        );
        if (dup.rowCount > 0) {
            return res.status(409).json({ success: false, error: 'Username hoặc email đã tồn tại' });
        }

        const hash = await hashPassword(password);
        const r = await query(
            `INSERT INTO users (username, email, password_hash, role, status)
             VALUES ($1, $2, $3, 'user', 'pending')
             RETURNING *`,
            [username, email || null, hash]
        );
        res.status(201).json({
            success: true,
            message: 'Đăng ký thành công. Tài khoản chờ admin duyệt.',
            user: sanitizeUser(r.rows[0])
        });
    } catch (err) {
        console.error('register error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * POST /api/auth/login
 * Verify credentials + set cookie. Chỉ cho phép status=active.
 */
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Thiếu username/password' });
        }

        const r = await query(
            `SELECT * FROM users WHERE username = $1 OR email = $1`,
            [username]
        );
        if (r.rowCount === 0) {
            return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });
        }
        const user = r.rows[0];

        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) {
            return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });
        }

        if (user.status !== 'active') {
            const msg = user.status === 'pending'
                ? 'Tài khoản đang chờ admin duyệt'
                : 'Tài khoản đã bị khóa';
            return res.status(403).json({ success: false, error: msg });
        }

        await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

        setAuthCookies(res, user);
        res.json({ success: true, user: sanitizeUser(user) });
    } catch (err) {
        console.error('login error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * POST /api/auth/logout — clear cookie.
 */
router.post('/logout', (req, res) => {
    clearAuthCookies(res);
    res.json({ success: true });
});

/**
 * GET /api/auth/me — profile user hiện tại (cần login).
 */
router.get('/me', requireAuth, (req, res) => {
    res.json({ success: true, user: req.user });
});

module.exports = router;
