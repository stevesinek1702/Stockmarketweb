/**
 * RSI (Relative Strength Index) — Wilder smoothing.
 * Trả mảng RSI values (length = closes.length - period). [] nếu không đủ data.
 */
function rsi(closes, period = 14) {
  if (closes.length <= period) return [];
  const out = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // RSI chuẩn: avgLoss=0 → 100 (chỉ tăng, không loss); avgGain=0 → 0 (chỉ giảm).
  // Công thức 100-100/(1+rs) chỉ dùng khi cả 2 > 0.
  out.push(avgLoss === 0 ? (avgGain > 0 ? 100 : 50) : 100 - (100 / (1 + avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push(avgLoss === 0 ? (avgGain > 0 ? 100 : 50) : 100 - (100 / (1 + avgGain / avgLoss)));
  }
  return out;
}

module.exports = { rsi };
