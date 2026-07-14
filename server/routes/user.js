const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, hashPassword, verifyPassword } = require('../auth');

// Toàn bộ user routes yêu cầu login
router.use(requireAuth);

// ==========================================
// VALIDATION
// ==========================================

function validSymbol(s) {
    return typeof s === 'string' && /^[A-Z0-9]{1,10}$/i.test(s);
}
function validNumber(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0;
}

// ==========================================
// WATCHLIST — /api/user/watchlist
// ==========================================

/**
 * GET /api/user/watchlist — danh sách mã theo dõi của user.
 */
router.get('/watchlist', async (req, res) => {
    try {
        const r = await query(
            `SELECT id, symbol, notes, created_at FROM user_watchlist
             WHERE user_id = $1 ORDER BY created_at ASC`,
            [req.user.id]
        );
        res.json({ success: true, watchlist: r.rows });
    } catch (err) {
        console.error('watchlist get error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * POST /api/user/watchlist — thêm mã vào watchlist.
 * Body: { symbol, notes? }
 */
router.post('/watchlist', async (req, res) => {
    try {
        const { symbol, notes } = req.body;
        if (!validSymbol(symbol)) {
            return res.status(400).json({ success: false, error: 'Symbol không hợp lệ' });
        }
        const r = await query(
            `INSERT INTO user_watchlist (user_id, symbol, notes)
             VALUES ($1, UPPER($2), $3)
             ON CONFLICT (user_id, symbol) DO UPDATE SET notes = EXCLUDED.notes
             RETURNING id, symbol, notes, created_at`,
            [req.user.id, symbol.toUpperCase(), notes || null]
        );
        res.status(201).json({ success: true, item: r.rows[0] });
    } catch (err) {
        console.error('watchlist add error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * DELETE /api/user/watchlist/:symbol — xóa mã khỏi watchlist.
 */
router.delete('/watchlist/:symbol', async (req, res) => {
    try {
        const symbol = (req.params.symbol || '').toUpperCase();
        if (!validSymbol(symbol)) {
            return res.status(400).json({ success: false, error: 'Symbol không hợp lệ' });
        }
        const r = await query(
            `DELETE FROM user_watchlist WHERE user_id = $1 AND symbol = $2 RETURNING id`,
            [req.user.id, symbol]
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Không có trong watchlist' });
        }
        res.json({ success: true, removed: symbol });
    } catch (err) {
        console.error('watchlist delete error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// PORTFOLIO — /api/user/portfolio
// ==========================================

/**
 * GET /api/user/portfolio — sổ cổ phiếu của user.
 */
router.get('/portfolio', async (req, res) => {
    try {
        const r = await query(
            `SELECT id, symbol, quantity, avg_price, created_at, updated_at
             FROM user_portfolio
             WHERE user_id = $1 ORDER BY symbol ASC`,
            [req.user.id]
        );
        res.json({ success: true, portfolio: r.rows });
    } catch (err) {
        console.error('portfolio get error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * POST /api/user/portfolio — thêm/cập nhật vị thế.
 * Body: { symbol, quantity, avg_price }
 * UPSERT theo (user_id, symbol).
 */
router.post('/portfolio', async (req, res) => {
    try {
        const { symbol, quantity, avg_price } = req.body;
        if (!validSymbol(symbol)) {
            return res.status(400).json({ success: false, error: 'Symbol không hợp lệ' });
        }
        if (!validNumber(quantity) || !validNumber(avg_price)) {
            return res.status(400).json({ success: false, error: 'quantity/avg_price phải là số ≥ 0' });
        }
        const r = await query(
            `INSERT INTO user_portfolio (user_id, symbol, quantity, avg_price)
             VALUES ($1, UPPER($2), $3, $4)
             ON CONFLICT (user_id, symbol) DO UPDATE
               SET quantity = EXCLUDED.quantity,
                   avg_price = EXCLUDED.avg_price,
                   updated_at = now()
             RETURNING id, symbol, quantity, avg_price, created_at, updated_at`,
            [req.user.id, symbol.toUpperCase(), quantity, avg_price]
        );
        res.status(201).json({ success: true, item: r.rows[0] });
    } catch (err) {
        console.error('portfolio upsert error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * DELETE /api/user/portfolio/:symbol — xóa vị thế.
 */
router.delete('/portfolio/:symbol', async (req, res) => {
    try {
        const symbol = (req.params.symbol || '').toUpperCase();
        if (!validSymbol(symbol)) {
            return res.status(400).json({ success: false, error: 'Symbol không hợp lệ' });
        }
        const r = await query(
            `DELETE FROM user_portfolio WHERE user_id = $1 AND symbol = $2 RETURNING id`,
            [req.user.id, symbol]
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Không có trong portfolio' });
        }
        res.json({ success: true, removed: symbol });
    } catch (err) {
        console.error('portfolio delete error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// CHANGE PASSWORD — /api/user/password
// ==========================================

/**
 * POST /api/user/password — user tự đổi mật khẩu.
 * Body: { currentPassword, newPassword }
 */
router.post('/password', async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Thiếu mật khẩu hiện tại/mật khẩu mới' });
        }
        if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200) {
            return res.status(400).json({ success: false, error: 'Mật khẩu mới tối thiểu 6 ký tự' });
        }

        // Lấy hash hiện tại để verify
        const r = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
        if (r.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'User không tồn tại' });
        }
        const ok = await verifyPassword(currentPassword, r.rows[0].password_hash);
        if (!ok) {
            return res.status(401).json({ success: false, error: 'Mật khẩu hiện tại không đúng' });
        }

        const hash = await hashPassword(newPassword);
        await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.user.id]);
        res.json({ success: true, message: 'Đổi mật khẩu thành công' });
    } catch (err) {
        console.error('change password error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// FILTER PRESETS — /api/user/presets (per-user, thay /api/filter-presets)
// ==========================================

/**
 * GET /api/user/presets — danh sách preset của user.
 */
router.get('/presets', async (req, res) => {
    try {
        const r = await query(
            `SELECT name, filters, updated_at FROM filter_presets
             WHERE user_id = $1 ORDER BY name ASC`,
            [req.user.id]
        );
        // Map về format frontend mong đợi: { name: conditions[] }
        const presets = {};
        for (const row of r.rows) {
            presets[row.name] = row.filters;
        }
        res.json({ success: true, presets });
    } catch (err) {
        console.error('presets get error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * POST /api/user/presets — lưu/cập nhật preset.
 * Body: { name, conditions }
 */
router.post('/presets', async (req, res) => {
    try {
        const { name, conditions } = req.body;
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Tên preset không hợp lệ' });
        }
        if (!Array.isArray(conditions)) {
            return res.status(400).json({ success: false, error: 'conditions phải là mảng' });
        }
        const r = await query(
            `INSERT INTO filter_presets (user_id, name, filters)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, name) DO UPDATE
               SET filters = EXCLUDED.filters,
                   updated_at = now()
             RETURNING name, filters`,
            [req.user.id, name.trim(), JSON.stringify(conditions)]
        );
        res.status(201).json({ success: true, preset: { name: r.rows[0].name, conditions: r.rows[0].filters } });
    } catch (err) {
        console.error('presets save error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/**
 * DELETE /api/user/presets/:name — xóa preset.
 */
router.delete('/presets/:name', async (req, res) => {
    try {
        const name = decodeURIComponent(req.params.name || '');
        if (!name) {
            return res.status(400).json({ success: false, error: 'Tên preset không hợp lệ' });
        }
        const r = await query(
            `DELETE FROM filter_presets WHERE user_id = $1 AND name = $2 RETURNING id`,
            [req.user.id, name]
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Preset không tồn tại' });
        }
        res.json({ success: true, removed: name });
    } catch (err) {
        console.error('presets delete error:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

module.exports = router;
