require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function runMigrations() {
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    console.log(`🗂️  Running ${files.length} migration(s)...`);
    for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        console.log(`  → ${file}`);
        await pool.query(sql);
    }
    console.log('✅ Migrations complete.');
    await pool.end();
}

runMigrations().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
