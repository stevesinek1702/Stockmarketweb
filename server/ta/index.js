/**
 * server/ta/index.js — barrel export + computeTA() composite.
 * Single entry point cho subsystem #2-#6.
 */
const { sma, ema } = require('./ma');
const { rsi } = require('./rsi');
const { macd } = require('./macd');
const { adx, trendStrength } = require('./adx');
const { atr } = require('./atr');
const { bollinger } = require('./bollinger');
const { trendTemplate } = require('./trend-template');
const { detectVCP } = require('./vcp');
const { detectPocketPivot } = require('./pocket-pivot');

/**
 * Composite TA cho 1 symbol. Trả object đầy đủ.
 * @param {{dates:string[], ohlc:{o,h,l,c}[], volumes:number[]}} history
 */
function computeTA(history) {
  const closes = (history.ohlc || []).map(x => x.c);
  const ohlc = history.ohlc || [];
  const last = closes.length - 1;
  if (last < 0) return null;

  const rsiArr = rsi(closes);
  const adxRes = adx(ohlc, 14);
  const ma200Arr = sma(closes, 200);
  const ma200_22ago = (last - 22 >= 0 && ma200Arr[last - 22] != null) ? ma200Arr[last - 22] : null;

  return {
    mas: {
      ma10: sma(closes, 10)[last],
      ma20: sma(closes, 20)[last],
      ma50: sma(closes, 50)[last],
      ma150: sma(closes, 150)[last],
      ma200: ma200Arr[last],
      ma200Rising: ma200_22ago != null && ma200Arr[last] != null && ma200Arr[last] > ma200_22ago
    },
    momentum: {
      rsi: rsiArr.length ? rsiArr[rsiArr.length - 1] : null,
      macd: macd(closes)
    },
    trend: { ...adxRes, trendStrength: trendStrength(adxRes.adx) },
    volatility: atr(ohlc, 14),
    bollinger: bollinger(closes, 20, 2),
    sepa: {
      trendTemplate: trendTemplate({ dates: history.dates, closes }),
      vcp: detectVCP({ dates: history.dates, ohlc, volumes: history.volumes || [] }),
      pocketPivot: detectPocketPivot({ dates: history.dates, ohlc, volumes: history.volumes || [] })
    }
  };
}

module.exports = {
  sma, ema, rsi, macd, adx, trendStrength, atr, bollinger,
  trendTemplate, detectVCP, detectPocketPivot,
  computeTA,
  priceHistory: require('./price-history')
};
