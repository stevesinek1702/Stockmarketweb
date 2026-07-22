const { ema } = require('./ma');

/**
 * MACD = EMA12(closes) - EMA26(closes); Signal = EMA9(macd); Histogram = macd - signal.
 * Trả { macd, signal, histogram }.
 *
 * Vì ema() trả null ở các vị trí chưa đủ period, cần align chỉ lấy đoạn overlap.
 */
function macd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (ema12.length === 0 || ema26.length === 0) return { macd: [], signal: [], histogram: [] };

  // MACD line: tại mỗi index i, nếu cả ema12[i] và ema26[i] !== null
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] !== null && ema26[i] !== null) {
      macdLine.push(ema12[i] - ema26[i]);
    }
  }
  if (macdLine.length === 0) return { macd: macdLine, signal: [], histogram: [] };

  // Signal = EMA9 của macdLine
  const signalRaw = ema(macdLine, 9);
  const signal = [];
  const histogram = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (signalRaw[i] !== null) {
      signal.push(signalRaw[i]);
      histogram.push(macdLine[i] - signalRaw[i]);
    }
  }
  return { macd: macdLine, signal, histogram };
}

module.exports = { macd };
