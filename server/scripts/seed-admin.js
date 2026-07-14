require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

/**
 * Tạo admin user ban đầu nếu chưa có.
 * Đọc từ env:
 *   ADMIN_USERNAME (mặc định 'admin')
 *   ADMIN_PASSWORD (BẮT BUỘC — sẽ báo lỗi nếu thiếu)
 *   ADMIN_EMAIL    (tùy chọn)
 *
 * Chạy: node scripts/seed-admin.js
 */
async function seedAdmin() {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD;
    const email = process.env.ADMIN_EMAIL || null;

    if (!password) {
        console.error('❌ Thiếu ADMIN_PASSWORD trong .env');
        console.error('   Thêm dòng: ADMIN_PASSWORD=mat-khau-cua-ban');
        process.exit(1);
    }

    // Kiểm tra đã có admin chưa
    const existing = await pool.query(
        `SELECT id, username FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (existing.rowCount > 0) {
        console.log(`ℹ️  Đã có admin: ${existing.rows[0].username} (id=${existing.rows[0].id}). Bỏ qua.`);
        await pool.end();
        return;
    }

    const hash = await bcrypt.hash(password, 12);
    const res = await pool.query(
        `INSERT INTO users (username, email, password_hash, role, status, approved_at)
         VALUES ($1, $2, $3, 'admin', 'active', now())
         RETURNING id, username`,
        [username, email, hash]
    );
    console.log(`✅ Tạo admin thành công: ${res.rows[0].username} (id=${res.rows[0].id})`);
    console.log(`   → Login tại /login với username="${username}"`);
    await pool.end();
}

seedAdmin().catch(err => {
    console.error('❌ Seed admin failed:', err.message);
    process.exit(1);
});
