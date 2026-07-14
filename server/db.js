const { Pool } = require('pg');

// DATABASE_URL ví dụ: postgres://user:pass@host:5432/db
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,                      // tối đa 10 connection trong pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
    console.error('❌ [db] Unexpected idle client error:', err.message);
});

/**
 * Wrapper cho query — dùng cho mọi truy vấn Postgres.
 * @param {string} text SQL với placeholders ($1, $2, ...)
 * @param {Array} [params]
 */
async function query(text, params) {
    return pool.query(text, params);
}

module.exports = { pool, query };
