/**
 * BREADTH DAILY SNAPSHOT — Lưu lịch sử breadth (Phá Đỉnh/Phá Đáy) theo ngày.
 * ─────────────────────────────────────────────────────────────────────────
 * Mục đích: chụp snapshot EOD mỗi ngày → vẽ trend chart (ratio, count, calendar).
 *
 * Storage: PostgreSQL table breadth_daily_snapshot (15 cột + meta).
 * Logic insight reuse từ computeBreadthInsight() — cùng logic với endpoint live.
 *
 * Public API (mirror breadth-history.js):
 *   - buildToday()       → fetch 6 endpoint + tính insight + UPSERT hôm nay
 *   - getHistory(days)   → mảng snapshots ascending (cho chart)
 *   - hasToday()         → check hôm nay đã có chưa
 *   - getMeta()          → { total, firstDate, lastDate, hasToday }
 */

const fiintrade = require('./fiintrade');
const { query } = require('./db');

// ── Time helpers (GMT+7) ──────────────────────────────────────────────
function _vnTodayKey() {
    const now = new Date(Date.now() + 7 * 3600 * 1000);
    return now.toISOString().split('T')[0];
}

/**
 * Tính insight breadth từ 6 mảng ticker đã fetch.
 * REFACTOR: logic này từng inline trong /api/breadth-breakout → tách ra share.
 * Trả về { summary, capSummary, verdict, snapshotRow } — snapshotRow là object
 * sẵn sàng UPSERT vào DB.
 */
function computeBreadthInsight(high3T, high6T, high1Y, low3T, low6T, low1Y) {
    const RANGES = ['ThreeMonths', 'SixMonths', 'OneYear'];
    const highByTf = { ThreeMonths: high3T, SixMonths: high6T, OneYear: high1Y };
    const lowByTf = { ThreeMonths: low3T, SixMonths: low6T, OneYear: low1Y };

    // summary: count + ratio + verdict từng tf
    const summary = RANGES.map(tf => {
        const h = highByTf[tf].length;
        const l = lowByTf[tf].length;
        const ratio = l > 0 ? h / l : (h > 0 ? 99 : 0);
        const verdict = ratio >= 1.25 ? 'Bullish' : (ratio <= 0.8 ? 'Bearish' : 'Neutral');
        return { tf, high: h, low: l, ratio: Math.round(ratio * 100) / 100, verdict };
    });

    // capSummary: tổng vốn hóa H/L từng tf (tỷ VND)
    const sumCap = (arr) => arr.reduce((s, it) => s + (it.marketCap || 0), 0);
    const capSummary = RANGES.map(tf => {
        const capHigh = Math.round(sumCap(highByTf[tf]));
        const capLow = Math.round(sumCap(lowByTf[tf]));
        const lowOverHigh = capHigh > 0 ? capLow / capHigh : (capLow > 0 ? 99 : 0);
        return { tf, capHigh, capLow, lowOverHigh: Math.round(lowOverHigh * 100) / 100 };
    });

    // verdict tổng = verdict 1N
    const verdict = summary[2].verdict;

    // snapshotRow: object ready để UPSERT
    const r = (i) => Math.round(summary[i].ratio * 100) / 100;
    const snapshotRow = {
        high_3t: summary[0].high, low_3t: summary[0].low, ratio_3t: r(0),
        cap_high_3t: capSummary[0].capHigh, cap_low_3t: capSummary[0].capLow,
        high_6t: summary[1].high, low_6t: summary[1].low, ratio_6t: r(1),
        cap_high_6t: capSummary[1].capHigh, cap_low_6t: capSummary[1].capLow,
        high_1y: summary[2].high, low_1y: summary[2].low, ratio_1y: r(2),
        cap_high_1y: capSummary[2].capHigh, cap_low_1y: capSummary[2].capLow,
        verdict
    };

    return { summary, capSummary, verdict, snapshotRow };
}

/**
 * Fetch 6 endpoint + tính insight + UPSERT hôm nay vào DB.
 * @param {Object} opts { silent:boolean }
 * @returns {Object} snapshot đã lưu (snapshotRow + snapshot_date)
 */
async function buildToday(opts = {}) {
    const { snapshotRow } = await _fetchAndCompute();
    const snapshot_date = _vnTodayKey();
    await _saveRow(snapshot_date, snapshotRow);
    if (!opts.silent) console.log(`📸 [breadth-snapshot] saved ${snapshot_date}: verdict=${snapshotRow.verdict}, H3T=${snapshotRow.high_3t} L3T=${snapshotRow.low_3t} ratio=${snapshotRow.ratio_3t}`);
    return { snapshot_date, ...snapshotRow };
}

/**
 * Fetch 6 endpoint + tính insight (KHÔNG lưu DB).
 * Dùng cho endpoint live và cho buildToday.
 */
async function _fetchAndCompute() {
    const safeFetch = async (fn, range) => {
        try { return await fn(range); }
        catch (e) { console.warn(`⚠️ [breadth-snapshot] fetch fail ${range}:`, e.message); return []; }
    };
    const [high3T, high6T, high1Y, low3T, low6T, low1Y] = await Promise.all([
        safeFetch(fiintrade.getTopNewHigh, 'ThreeMonths'),
        safeFetch(fiintrade.getTopNewHigh, 'SixMonths'),
        safeFetch(fiintrade.getTopNewHigh, 'OneYear'),
        safeFetch(fiintrade.getTopNewLow, 'ThreeMonths'),
        safeFetch(fiintrade.getTopNewLow, 'SixMonths'),
        safeFetch(fiintrade.getTopNewLow, 'OneYear')
    ]);
    return computeBreadthInsight(high3T, high6T, high1Y, low3T, low6T, low1Y);
}

/**
 * UPSERT 1 row vào breadth_daily_snapshot.
 */
async function _saveRow(snapshot_date, row) {
    const sql = `
        INSERT INTO breadth_daily_snapshot (
            snapshot_date,
            high_3t, low_3t, ratio_3t, cap_high_3t, cap_low_3t,
            high_6t, low_6t, ratio_6t, cap_high_6t, cap_low_6t,
            high_1y, low_1y, ratio_1y, cap_high_1y, cap_low_1y,
            verdict
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (snapshot_date) DO UPDATE SET
            high_3t=EXCLUDED.high_3t, low_3t=EXCLUDED.low_3t, ratio_3t=EXCLUDED.ratio_3t,
            cap_high_3t=EXCLUDED.cap_high_3t, cap_low_3t=EXCLUDED.cap_low_3t,
            high_6t=EXCLUDED.high_6t, low_6t=EXCLUDED.low_6t, ratio_6t=EXCLUDED.ratio_6t,
            cap_high_6t=EXCLUDED.cap_high_6t, cap_low_6t=EXCLUDED.cap_low_6t,
            high_1y=EXCLUDED.high_1y, low_1y=EXCLUDED.low_1y, ratio_1y=EXCLUDED.ratio_1y,
            cap_high_1y=EXCLUDED.cap_high_1y, cap_low_1y=EXCLUDED.cap_low_1y,
            verdict=EXCLUDED.verdict
    `;
    const p = [
        snapshot_date,
        row.high_3t, row.low_3t, row.ratio_3t, row.cap_high_3t, row.cap_low_3t,
        row.high_6t, row.low_6t, row.ratio_6t, row.cap_high_6t, row.cap_low_6t,
        row.high_1y, row.low_1y, row.ratio_1y, row.cap_high_1y, row.cap_low_1y,
        row.verdict
    ];
    await query(sql, p);
}

/**
 * Lấy history N ngày gần nhất, trả mảng ASCENDING (cũ → mới) cho chart.
 */
async function getHistory(days = 90) {
    const res = await query(
        `SELECT * FROM breadth_daily_snapshot
         ORDER BY snapshot_date DESC LIMIT $1`,
        [days]
    );
    return res.rows.reverse().map(r => _normalizeRow(r));
}

/**
 * Kiểm tra hôm nay đã có snapshot chưa.
 */
async function hasToday() {
    const today = _vnTodayKey();
    const res = await query(
        `SELECT 1 FROM breadth_daily_snapshot WHERE snapshot_date = $1`,
        [today]
    );
    return res.rowCount > 0;
}

/**
 * Meta info cho UI.
 */
async function getMeta() {
    const res = await query(
        `SELECT COUNT(*)::int AS total,
                MIN(snapshot_date) AS first_date,
                MAX(snapshot_date) AS last_date
         FROM breadth_daily_snapshot`
    );
    const row = res.rows[0] || {};
    const fmt = (d) => {
        if (!d) return null;
        const dt = d instanceof Date ? d : new Date(d);
        return dt.toISOString().split('T')[0];
    };
    return {
        total: row.total || 0,
        firstDate: fmt(row.first_date),
        lastDate: fmt(row.last_date),
        hasToday: await hasToday()
    };
}

/** Convert pg row (snake_case) → camelCase cho frontend dễ dùng. */
function _normalizeRow(r) {
    // Force date thành 'YYYY-MM-DD' (bỏ phần thời gian do pg trả về object Date)
    const d = r.snapshot_date instanceof Date ? r.snapshot_date : new Date(r.snapshot_date);
    const dateStr = d.toISOString().split('T')[0];
    return {
        date: dateStr,
        high3T: r.high_3t, low3T: r.low_3t, ratio3T: parseFloat(r.ratio_3t),
        capHigh3T: r.cap_high_3t, capLow3T: r.cap_low_3t,
        high6T: r.high_6t, low6T: r.low_6t, ratio6T: parseFloat(r.ratio_6t),
        capHigh6T: r.cap_high_6t, capLow6T: r.cap_low_6t,
        high1Y: r.high_1y, low1Y: r.low_1y, ratio1Y: parseFloat(r.ratio_1y),
        capHigh1Y: r.cap_high_1y, capLow1Y: r.cap_low_1y,
        verdict: r.verdict
    };
}

module.exports = {
    buildToday,
    getHistory,
    hasToday,
    getMeta,
    computeBreadthInsight,
    _vnTodayKey
};
