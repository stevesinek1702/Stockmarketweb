/**
 * SMA (Simple Moving Average) bằng prefix-sum O(1)/phần tử.
 * Trả mảng cùng độ dài, null ở vị trí chưa đủ period.
 */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const prefix = new Array(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = period - 1; i < values.length; i++) {
    out[i] = (prefix[i + 1] - prefix[i + 1 - period]) / period;
  }
  return out;
}

/**
 * EMA (Exponential Moving Average) — seed = SMA của period đầu.
 * Trả mảng cùng độ dài; null trước seed. Multiplier k = 2/(period+1).
 */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev = prev / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

module.exports = { sma, ema };
