/**
 * ADX + DI+/DI- (Wilder). Đo strength of trend (không phải hướng).
 * adx >= 25 = strong, >= 20 = weak, < 20 = ranging.
 *
 * @param {{o:number,h:number,l:number,c:number}[]} ohlc
 * @param {number} [period=14]
 * @returns {{adx:number|null, diPlus:number, diMinus:number}}
 */
function adx(ohlc, period = 14) {
  if (ohlc.length < period * 2 + 1) return { adx: null, diPlus: 0, diMinus: 0 };

  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < ohlc.length; i++) {
    const up = ohlc[i].h - ohlc[i - 1].h;
    const down = ohlc[i - 1].l - ohlc[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const t = Math.max(
      ohlc[i].h - ohlc[i].l,
      Math.abs(ohlc[i].h - ohlc[i - 1].c),
      Math.abs(ohlc[i].l - ohlc[i - 1].c)
    );
    tr.push(t);
  }
  // Wilder smoothing seed
  let trN = tr.slice(0, period).reduce((s, v) => s + v, 0);
  let plusN = plusDM.slice(0, period).reduce((s, v) => s + v, 0);
  let minusN = minusDM.slice(0, period).reduce((s, v) => s + v, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    trN = trN - trN / period + tr[i];
    plusN = plusN - plusN / period + plusDM[i];
    minusN = minusN - minusN / period + minusDM[i];
    const pdi = trN > 0 ? 100 * plusN / trN : 0;
    const mdi = trN > 0 ? 100 * minusN / trN : 0;
    const denom = pdi + mdi;
    dx.push(denom > 0 ? 100 * Math.abs(pdi - mdi) / denom : 0);
  }
  if (dx.length < period) return { adx: null, diPlus: 0, diMinus: 0 };
  // ADX = Wilder smoothing của DX
  let adxVal = dx.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
  }
  const pdiLast = trN > 0 ? 100 * plusN / trN : 0;
  const mdiLast = trN > 0 ? 100 * minusN / trN : 0;
  return { adx: adxVal, diPlus: pdiLast, diMinus: mdiLast };
}

function trendStrength(adxVal) {
  if (adxVal == null) return 'unknown';
  if (adxVal >= 25) return 'strong';
  if (adxVal >= 20) return 'weak';
  return 'ranging';
}

module.exports = { adx, trendStrength };
