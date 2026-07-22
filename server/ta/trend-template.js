const { sma } = require('./ma');

/**
 * Minervini Trend Template — 8 rules (Stage 2 uptrend filter).
 * Trả { pass: bool, rules: [8 booleans], details }.
 *
 * Rules:
 *   1. Price > MA150
 *   2. Price > MA200
 *   3. MA150 > MA200
 *   4. MA50 > MA150 AND MA50 > MA200
 *   5. Price > MA50
 *   6. MA200 rising: MA200 hôm nay > MA200 tại index (today - 22 phiên)
 *   7. Price >= 1.30 × 52-week low
 *   8. Price <= 1.25 × 52-week high
 */
function trendTemplate({ dates, closes }) {
  const rules = [false, false, false, false, false, false, false, false];
  const last = closes.length - 1;
  if (closes.length < 200) return { pass: false, rules, details: { reason: 'insufficient_history' } };

  const price = closes[last];
  const ma50 = sma(closes, 50)[last];
  const ma150 = sma(closes, 150)[last];
  const ma200 = sma(closes, 200)[last];
  const ma200Arr = sma(closes, 200);
  const ma200_22ago = last - 22 >= 0 ? ma200Arr[last - 22] : null;

  const year = Math.min(252, closes.length);
  const low52 = Math.min(...closes.slice(last - year + 1));
  const high52 = Math.max(...closes.slice(last - year + 1));

  rules[0] = price > ma150;
  rules[1] = price > ma200;
  rules[2] = ma150 > ma200;
  rules[3] = ma50 > ma150 && ma50 > ma200;
  rules[4] = price > ma50;
  rules[5] = ma200_22ago != null && ma200 > ma200_22ago;
  rules[6] = price >= 1.30 * low52;
  rules[7] = price <= 1.25 * high52;

  return {
    pass: rules.every(Boolean),
    rules,
    details: { price, ma50, ma150, ma200, ma200Rising: rules[5], low52, high52 }
  };
}

module.exports = { trendTemplate };
