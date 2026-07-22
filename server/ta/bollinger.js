const { sma } = require('./ma');

/**
 * Bollinger Bands tại điểm cuối. middle=SMA(period), upper/lower=±mult×σ.
 * squeeze: bandwidth hiện tại < 20th percentile của bandwidth history (rolling 120 ngày).
 *
 * @param {number[]} closes
 * @param {number} [period=20]
 * @param {number} [mult=2]
 * @returns {{upper:number,middle:number,lower:number,squeeze:boolean,bandwidth:number}}
 */
function bollinger(closes, period = 20, mult = 2) {
  const last = closes.length - 1;
  const middleArr = sma(closes, period);
  const middle = middleArr[last];
  if (middle == null) return { upper: null, middle: null, lower: null, squeeze: false, bandwidth: 0 };

  // σ của `period` phần tử cuối
  const slice = closes.slice(last - period + 1);
  const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;

  // bandwidth history (rolling 120 ngày) cho squeeze detection
  const bws = [];
  const window = Math.min(120, closes.length - period + 1);
  for (let w = 0; w < window; w++) {
    const idx = last - w;
    const m = middleArr[idx];
    if (m == null) continue;
    const sl = closes.slice(idx - period + 1, idx + 1);
    const v = sl.reduce((s, v) => s + (v - m) ** 2, 0) / period;
    bws.push(bandwidth(m + mult * Math.sqrt(v), m, m - mult * Math.sqrt(v)));
  }
  const cur = bandwidth(upper, middle, lower);
  bws.sort((a, b) => a - b);
  const p20 = bws.length > 0 ? bws[Math.floor(bws.length * 0.2)] : 0;
  return { upper, middle, lower, squeeze: cur < p20, bandwidth: cur };
}

function bandwidth(upper, middle, lower) {
  return middle > 0 ? ((upper - lower) / middle) * 100 : 0;
}

module.exports = { bollinger, bandwidth };
