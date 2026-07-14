require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

/**
 * Import filter-presets.json cũ (global) vào DB per-user, gán cho admin đầu tiên.
 * Chạy 1 lần khi upgrade lên Phase 4. Idempotent (skip nếu admin đã có preset).
 *
 * Usage: node scripts/import-presets.js
 */
async function importPresets() {
    const file = path.join(__dirname, '..', 'data', 'filter-presets.json');
    if (!fs.existsSync(file)) {
        console.log('ℹ️  Không có filter-presets.json cũ — skip.');
        await pool.end();
        return;
    }

    // Tìm admin đầu tiên
    const adminRes = await pool.query(
        `SELECT id, username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`
    );
    if (adminRes.rowCount === 0) {
        console.error('❌ Chưa có admin. Chạy `npm run seed-admin` trước.');
        process.exit(1);
    }
    const admin = adminRes.rows[0];

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = Object.keys(raw);
    console.log(`📂 Tìm thấy ${names.length} preset(s) trong file JSON. Import cho admin "${admin.username}" (id=${admin.id})...`);

    let imported = 0;
    for (const name of names) {
        const conditions = raw[name];
        if (!Array.isArray(conditions)) continue;
        await pool.query(
            `INSERT INTO filter_presets (user_id, name, filters)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, name) DO NOTHING`,
            [admin.id, name, JSON.stringify(conditions)]
        );
        imported++;
        console.log(`   ✓ ${name}`);
    }
    console.log(`✅ Đã import ${imported} preset(s).`);
    await pool.end();
}

importPresets().catch(err => {
    console.error('❌ Import presets failed:', err.message);
    process.exit(1);
});
