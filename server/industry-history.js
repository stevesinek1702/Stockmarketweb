/**
 * INDUSTRY HISTORY - Lưu snapshot lực cầu ngành theo ngày
 * ────────────────────────────────────────────────────────
 * Mỗi ngày lưu 1 bản ghi {lucCau, percentAboveMA10, ...} cho từng ngành
 * vào file JSON. Dùng để đánh giá xu hướng lực cầu qua tuần/tháng.
 *
 * Cấu trúc file (data/industry-history.json):
 * {
 *   "2026-06-01": {
 *      "8300": { name, lucCau, percentAboveMA10, stockCount, marketCap },
 *      ...
 *   },
 *   ...
 * }
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'data', 'industry-history.json');
const MAX_DAYS = 180; // giữ tối đa 6 tháng

function _todayKey() {
    // Theo giờ VN (UTC+7)
    const now = new Date(Date.now() + 7 * 3600 * 1000);
    return now.toISOString().split('T')[0];
}

function _load() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return {};
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {
        console.error('[IndustryHistory] load error:', e.message);
        return {};
    }
}

function _save(data) {
    try {
        const dir = path.dirname(HISTORY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {
        console.error('[IndustryHistory] save error:', e.message);
    }
}

/**
 * Lưu snapshot lực cầu ngành cho ngày hôm nay (ghi đè nếu đã có trong ngày).
 * @param {Array} industries - mảng kết quả từ /api/industry-stats
 */
function saveSnapshot(industries) {
    if (!Array.isArray(industries) || industries.length === 0) return;

    const history = _load();
    const key = _todayKey();

    const snapshot = {};
    industries.forEach(ind => {
        if (!ind.code) return;
        snapshot[ind.code] = {
            name: ind.name,
            lucCau: ind.lucCau,
            percentAboveMA10: ind.percentAboveMA10,
            stockCount: ind.stockCount,
            marketCap: ind.marketCap
        };
    });

    history[key] = snapshot;

    // Cắt bớt nếu quá MAX_DAYS
    const keys = Object.keys(history).sort();
    if (keys.length > MAX_DAYS) {
        keys.slice(0, keys.length - MAX_DAYS).forEach(k => delete history[k]);
    }

    _save(history);
    console.log(`[IndustryHistory] 💾 Đã lưu snapshot ngày ${key} (${industries.length} ngành)`);
}

/**
 * Lấy toàn bộ lịch sử (hoặc giới hạn số ngày gần nhất).
 * @param {number} days - số ngày gần nhất (mặc định tất cả)
 */
function getHistory(days = 0) {
    const history = _load();
    let keys = Object.keys(history).sort();
    if (days > 0) keys = keys.slice(-days);

    const result = {};
    keys.forEach(k => { result[k] = history[k]; });
    return result;
}

/**
 * Lấy chuỗi lực cầu theo thời gian của 1 ngành cụ thể.
 * @param {string} code - mã ngành ICB2
 * @returns {Array} [{date, lucCau, percentAboveMA10}]
 */
function getIndustrySeries(code) {
    const history = _load();
    const series = [];
    Object.keys(history).sort().forEach(date => {
        const rec = history[date][code];
        if (rec) {
            series.push({
                date,
                lucCau: rec.lucCau,
                percentAboveMA10: rec.percentAboveMA10
            });
        }
    });
    return series;
}

/**
 * Lấy giá trị lực cầu của ngày gần nhất TRƯỚC hôm nay (để tính delta).
 * Trả về map { code: { lucCau, percentAboveMA10, date } }
 */
function getPreviousSnapshot() {
    const history = _load();
    const keys = Object.keys(history).sort();
    const today = _todayKey();
    // Tìm ngày gần nhất khác hôm nay
    for (let i = keys.length - 1; i >= 0; i--) {
        if (keys[i] !== today) {
            return { date: keys[i], data: history[keys[i]] };
        }
    }
    return null;
}

module.exports = { saveSnapshot, getHistory, getIndustrySeries, getPreviousSnapshot };
