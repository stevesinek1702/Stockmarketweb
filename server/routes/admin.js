const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { hashPassword, requireAdmin } = require('../auth');

// ==========================================
// VALIDATION (mirror routes/auth.js)
// ==========================================

function validUsername(u) {
    return typeof u === 'string' && /^[a-zA-Z0-9_]{3,30}$/.test(u);
}
function validPassword(p) {
    return typeof p === 'string' && p.length >= 6 && p.length <= 200;
}

// ==========================================
// ADMIN ENDPOINTS — tất cả require admin role
// ==========================================

// Áp dụng requireAdmin cho toàn bộ router
router.use(requireAdmin);

/**
 * GET /api/admin/users — danh sách toàn bộ user.
 * Query: ?status=pending|active|disabled (lọc tùy chọn)
 */
router.get('/users', async (req, res) => {
    try {
        const { status } = req.query;
        let sql = `SELECT id, username, email, role, status, created_at, approved_at, last_login_at FROM users`;
        const params = [];
        if (status) {
            params.push(status);
            sql += ` WHERE status = $${params.length}`;
        }
        sql += ` ORDER BY created_at DESC`;
        const r = await query(sql, params);
        res.json({ success: true, users: r.rows });
    } catch (err) {
        console.error('admin list users error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/users — admin tạo account trực tiếp (status=active).
 */
router.post('/users', async (req, res) => {
    try {
        const { username, password, email, role } = req.body;
        if (!validUsername(username)) {
            return res.status(400).json({ success: false, error: 'Username 3-30 ký tự' });
        }
        if (!validPassword(password)) {
            return res.status(400).json({ success: false, error: 'Mật khẩu tối thiểu 6 ký tự' });
        }
        if (role && !['user', 'admin'].includes(role)) {
            return res.status(400).json({ success: false, error: 'Role không hợp lệ' });
        }

        const dup = await query(`SELECT id FROM users WHERE username = $1`, [username]);
        if (dup.rowCount > 0) {
            return res.status(409).json({ success: false, error: 'Username đã tồn tại' });
        }

        const hash = await hashPassword(password);
        const r = await query(
            `INSERT INTO users (username, email, password_hash, role, status, approved_at)
             VALUES ($1, $2, $3, $4, 'active', now())
             RETURNING id, username, email, role, status, created_at, approved_at`,
            [username, email || null, hash, role || 'user']
        );
        res.status(201).json({ success: true, user: r.rows[0] });
    } catch (err) {
        console.error('admin create user error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * PATCH /api/admin/users/:id — cập nhật status/role của user.
 * Body: { status?, role? }
 */
router.patch('/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { status, role, password } = req.body;

        // Ngăn admin tự khóa/hạ quyền chính mình
        if (id === req.user.id && (status === 'disabled' || (role && role !== 'admin'))) {
            return res.status(400).json({ success: false, error: 'Không thể tự khóa/hạ quyền chính mình' });
        }

        const sets = [];
        const params = [];
        if (status && ['pending', 'active', 'disabled'].includes(status)) {
            params.push(status);
            sets.push(`status = $${params.length}`);
            if (status === 'active') {
                sets.push(`approved_at = now()`);
            }
        }
        if (role && ['user', 'admin'].includes(role)) {
            params.push(role);
            sets.push(`role = $${params.length}`);
        }
        // Admin reset mật khẩu cho user
        if (password !== undefined) {
            if (!validPassword(password)) {
                return res.status(400).json({ success: false, error: 'Mật khẩu mới tối thiểu 6 ký tự' });
            }
            const hash = await hashPassword(password);
            params.push(hash);
            sets.push(`password_hash = $${params.length}`);
        }
        if (sets.length === 0) {
            return res.status(400).json({ success: false, error: 'Không có field hợp lệ để cập nhật' });
        }
        params.push(id);
        const r = await query(
            `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
             RETURNING id, username, email, role, status, created_at, approved_at, last_login_at`,
            params
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'User không tồn tại' });
        }
        res.json({ success: true, user: r.rows[0] });
    } catch (err) {
        console.error('admin patch user error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * DELETE /api/admin/users/:id — xóa user (cascade watchlist/portfolio/presets).
 */
router.delete('/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (id === req.user.id) {
            return res.status(400).json({ success: false, error: 'Không thể tự xóa chính mình' });
        }
        const r = await query(`DELETE FROM users WHERE id = $1 RETURNING id`, [id]);
        if (r.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'User không tồn tại' });
        }
        res.json({ success: true, deleted: id });
    } catch (err) {
        console.error('admin delete user error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

module.exports = router;
