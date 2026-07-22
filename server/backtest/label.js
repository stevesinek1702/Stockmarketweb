const { exitIdx } = require('../trading/vn-settlement');

/**
 * Forward return từ entry, skip T+1/T+2 (T+2.5 settlement VN).
 *
 * @param {number[]} closes  chuỗi close (cũ→mới)
 * @param {number} entryIdx  index ngày mua (T0)
 * @param {number} holdDays  số phiên GIỮ thực (sau settle). Exit = entry+3+holdDays.
 * @returns {{exitIdx, returnPct, maxDrawdown, maxGain, holdDays}|null}
 */
function forwardReturn(closes, entryIdx, holdDays) {
  const exit = exitIdx(entryIdx, holdDays);
  if (exit >= closes.length) return null;
  const entry = closes[entryIdx];
  if (!entry || entry <= 0) return null;

  let maxDrawdown = 0;
  let maxGain = 0;
  let peak = entry;
  let trough = entry;
  // quét từ entry+1 đến exit (kể cả T+1/T+2 không bán được — vẫn ảnh hưởng DD)
  for (let i = entryIdx + 1; i <= exit; i++) {
    const p = closes[i];
    if (p > peak) peak = p;
    if (p < trough) trough = p;
    const dd = (entry - trough) / entry * 100;
    const gain = (peak - entry) / entry * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (gain > maxGain) maxGain = gain;
  }
  const exitPrice = closes[exit];
  return {
    exitIdx: exit,
    returnPct: Math.round((exitPrice - entry) / entry * 10000) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxGain: Math.round(maxGain * 100) / 100,
    holdDays
  };
}

/**
 * Label binary: win nếu return >= threshold.
 */
function isWin(result, threshold = 5) {
  return result && result.returnPct >= threshold;
}

module.exports = { forwardReturn, isWin };
