const { loadConfig } = require('./config');

/**
 * Tạo tín hiệu giao dịch từ score + TA.
 * @param {object} scoreResult  output computeSEPA {score, grade, breakdown}
 * @param {object} ta           output computeTA (cần trend, mas, volatility, sepa)
 * @param {number} price        giá hiện tại
 * @param {object} [position]   {entry} nếu đang giữ (cho HOLD/EXIT logic)
 * @returns {{action, entry, stop, target1, target2, atr, rr, reason}}
 */
function generateSignal(scoreResult, ta, price, position) {
  const cfg = loadConfig();
  const atr = (ta.volatility && ta.volatility.atr) || 0;
  const atrPct = (ta.volatility && ta.volatility.atrPct) || 0;
  const score = scoreResult.score;
  const grade = scoreResult.grade;
  const ttPass = ta.sepa && ta.sepa.trendTemplate && ta.sepa.trendTemplate.pass;
  const vcp = ta.sepa && ta.sepa.vcp && ta.sepa.vcp.isVCP;
  const pp = ta.sepa && ta.sepa.pocketPivot && ta.sepa.pocketPivot.detected;
  const ma50 = ta.mas && ta.mas.ma50;

  // Đang giữ position → check HOLD/EXIT/SELL
  if (position && position.entry) {
    const entry = position.entry;
    const stop = entry - cfg.atrMultiplier * atr;
    const risk = entry - stop;
    const target1 = entry + cfg.targetRR * risk;
    const target2 = entry + cfg.targetRR * 2 * risk;
    // MA10 stop-loss (ưu tiên cao): close < MA10×0.97 → cắt lỗ sớm
    const ma10 = ta.mas && ta.mas.ma10;
    if (ma10 && price < ma10 * 0.97) {
      return { action: 'SELL_SL_MA10', entry, stop, target1, target2, atr, atrPct, rr: cfg.targetRR,
               reason: `Giá ${price} dưới MA10×0.97=${(ma10 * 0.97).toFixed(2)} → cắt lỗ MA10` };
    }
    if (price <= stop) {
      return { action: 'SELL_SL', entry, stop, target1, target2, atr, atrPct, rr: cfg.targetRR,
               reason: `Giá ${price} chạm stop ${stop.toFixed(2)} (SL ATR×${cfg.atrMultiplier})` };
    }
    if (price >= target1) {
      return { action: 'SELL_TP', entry, stop, target1, target2, atr, atrPct, rr: cfg.targetRR,
               reason: `Giá ${price} đạt target ${target1.toFixed(2)} (TP R:R=${cfg.targetRR})` };
    }
    if (score < 40 || (ma50 && price < ma50)) {
      return { action: 'EXIT', entry, stop, target1, target2, atr, atrPct, rr: cfg.targetRR,
               reason: `Signal yếu (score=${score}${ma50 && price < ma50 ? ', giá<MA50' : ''})` };
    }
    return { action: 'HOLD', entry, stop, target1, target2, atr, atrPct, rr: cfg.targetRR,
             reason: `Đang giữ, score=${score} (${grade}), stop=${stop.toFixed(2)}` };
  }

  // Chưa giữ → check BUY/WATCH
  if (score >= 70 && ttPass && (vcp || pp)) {
    const entry = price;
    const stop = entry - cfg.atrMultiplier * atr;
    const risk = entry - stop;
    const target1 = entry + cfg.targetRR * risk;
    const target2 = entry + cfg.targetRR * 2 * risk;
    return { action: 'BUY', entry, stop, target1, target2, atr, atrPct, rr: cfg.targetRR,
             reason: `Score ${score} (${grade}), TT pass, ${vcp ? 'VCP' : 'PocketPivot'} confirm` };
  }
  if (score >= 55) {
    return { action: 'WATCH', entry: price, stop: null, target1: null, target2: null,
             atr, atrPct, rr: 0, reason: `Score ${score} (${grade}) — đợi confirm (TT${ttPass ? '✓' : '✗'} VCP${vcp ? '✓' : '✗'})` };
  }
  return { action: 'NONE', entry: null, stop: null, target1: null, target2: null,
           atr, atrPct, rr: 0, reason: `Score ${score} (${grade}) — bỏ qua` };
}

module.exports = { generateSignal };
