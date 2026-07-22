/**
 * ATR (Average True Range) Wilder. Cho stop-loss sizing.
 * @param {{o:number,h:number,l:number,c:number}[]} ohlc
 * @param {number} [period=14]
 * @returns {{atr:number|null, atrPct:number}} atrPct = atr/close×100
 */
function atr(ohlc, period = 14) {
  if (ohlc.length < period + 1) return { atr: null, atrPct: 0 };
  const tr = [];
  for (let i = 1; i < ohlc.length; i++) {
    tr.push(Math.max(
      ohlc[i].h - ohlc[i].l,
      Math.abs(ohlc[i].h - ohlc[i - 1].c),
      Math.abs(ohlc[i].l - ohlc[i - 1].c)
    ));
  }
  let a = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
  }
  const lastClose = ohlc[ohlc.length - 1].c || 1;
  return { atr: a, atrPct: (a / lastClose) * 100 };
}

module.exports = { atr };
