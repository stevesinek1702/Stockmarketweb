const { exitIdx } = require('../trading/vn-settlement');
const { sma } = require('../ta/ma');

/**
 * Forward return từ entry, skip T+1/T+2 (T+2.5 settlement VN).
 *
 * Exit logic (ưu tiên theo thứ tự):
 *   1. MA10 stop-loss: từ T+3 trở đi, nếu close < MA10×0.97 (đóng cửa dưới MA10 3%)
 *      → exit sớm tại phiên đó (cut loss).
 *   2. Hold到期: nếu không hit stop → exit tại entry+3+holdDays.
 *
 * @param {number[]} closes  chuỗi close (cũ→mới)
 * @param {number} entryIdx  index ngày mua (T0)
 * @param {number} holdDays  số phiên GIỮ thực (sau settle). Exit = entry+3+holdDays.
 * @returns {{exitIdx, returnPct, maxDrawdown, maxGain, holdDays, exitReason}|null}
 */
function forwardReturn(closes, entryIdx, holdDays) {
  const maxExit = exitIdx(entryIdx, holdDays);
  if (maxExit >= closes.length) return null;
  const entry = closes[entryIdx];
  if (!entry || entry <= 0) return null;

  // Tính MA10 cho toàn bộ chuỗi (1 lần, O(n))
  const ma10Arr = closes.length >= 10 ? sma(closes, 10) : null;

  let maxDrawdown = 0;
  let maxGain = 0;
  let peak = entry;
  let trough = entry;
  let actualExit = maxExit;
  let exitReason = 'hold'; // 'hold' (到期) hoặc 'ma10_sl' (cut loss)

  // Quét từ entry+1 đến maxExit. T+1/T+2 không bán được (settle) nhưng vẫn tính DD.
  // MA10 stop chỉ check từ earliestExitIdx (entry+3) trở đi.
  const earliestSell = entryIdx + 3; // T+3: sớm nhất có thể bán
  for (let i = entryIdx + 1; i <= maxExit; i++) {
    const p = closes[i];
    if (p > peak) peak = p;
    if (p < trough) trough = p;
    const dd = (entry - trough) / entry * 100;
    const gain = (peak - entry) / entry * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (gain > maxGain) maxGain = gain;

    // MA10 stop-loss: chỉ check từ T+3 (đã settle) + chỉ khi MA10 có giá trị
    if (i >= earliestSell && ma10Arr && ma10Arr[i] != null) {
      if (p < ma10Arr[i] * 0.97) {
        actualExit = i;
        exitReason = 'ma10_sl';
        break; // cut loss, thoát sớm
      }
    }
  }
  const exitPrice = closes[actualExit];
  return {
    exitIdx: actualExit,
    returnPct: Math.round((exitPrice - entry) / entry * 10000) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxGain: Math.round(maxGain * 100) / 100,
    holdDays,
    exitReason
  };
}

/**
 * Label binary: win nếu return >= threshold.
 */
function isWin(result, threshold = 5) {
  return result && result.returnPct >= threshold;
}

module.exports = { forwardReturn, isWin };
