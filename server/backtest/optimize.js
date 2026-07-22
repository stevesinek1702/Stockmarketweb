const fs = require('fs');
const path = require('path');
const { backtest } = require('./engine');

const WEIGHTS_FILE = path.join(__dirname, '..', '..', 'config', 'scoring-weights.json');

// Trọng số mặc định (đồng bộ với scoring/score.js hardcode ban đầu)
const DEFAULT_WEIGHTS = {
  trendTemplate: 0.25, adx: 0.15, vcp: 0.15, rs: 0.15, maAlignment: 0.10,
  macd: 0.08, pocketPivot: 0.05, distMA20: 0.04, squeeze: 0.03
};

// Grid search: ~6 tổ hợp trọng số coarse (nhấn trend vs momentum vs value)
const GRID = [
  { label: 'default', w: DEFAULT_WEIGHTS },
  { label: 'trend-heavy', w: { ...DEFAULT_WEIGHTS, trendTemplate: 0.35, adx: 0.20, vcp: 0.10, rs: 0.10 } },
  { label: 'momentum-heavy', w: { ...DEFAULT_WEIGHTS, macd: 0.15, pocketPivot: 0.10, trendTemplate: 0.18, adx: 0.10 } },
  { label: 'rs-heavy', w: { ...DEFAULT_WEIGHTS, rs: 0.25, trendTemplate: 0.20, adx: 0.10 } },
  { label: 'vcp-heavy', w: { ...DEFAULT_WEIGHTS, vcp: 0.25, trendTemplate: 0.20, squeeze: 0.08 } },
  { label: 'balanced-flat', w: { trendTemplate: 0.18, adx: 0.12, vcp: 0.12, rs: 0.12, maAlignment: 0.12,
                                  macd: 0.12, pocketPivot: 0.08, distMA20: 0.08, squeeze: 0.06 } },
];

/**
 * Đọc trọng số active từ config (fallback default).
 */
function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return DEFAULT_WEIGHTS;
}

/**
 * Tối ưu trọng số bằng grid search: chạy backtest cho mỗi tổ hợp → chọn riskAdjusted cao nhất.
 * @param {object} opts backtest opts (fromDate, toDate, minScore, holdDays)
 * @returns {{best: object, comparisons: Array, saved: boolean}}
 */
function optimizeWeights(opts) {
  const comparisons = [];
  for (const variant of GRID) {
    // Ghi trọng số tạm để computeSEPA đọc — nhưng computeSEPA hiện hardcode.
    // NOTE: để optimize có hiệu lực thật, computeSEPA phải đọc loadWeights().
    // (Phase 2: wire computeSEPA đọc weights từ config)
    const result = backtest({ ...opts, minScore: opts.minScore || 55 });
    comparisons.push({
      label: variant.label,
      weights: variant.w,
      riskAdjusted: result.riskAdjusted,
      winRate: result.winRate,
      avgReturn: result.avgReturn,
      totalPicks: result.totalPicks
    });
  }
  comparisons.sort((a, b) => b.riskAdjusted - a.riskAdjusted);
  const best = comparisons[0];
  return { best, comparisons, saved: false }; // saved=false: chưa wire computeSEPA đọc config
}

module.exports = { optimizeWeights, loadWeights, DEFAULT_WEIGHTS, GRID };
