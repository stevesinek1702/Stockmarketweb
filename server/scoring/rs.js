/**
 * Relative Strength rating 0-100 (Mansfield-style simplified).
 * @param {number[]} stockCloses
 * @param {number[]|null} benchCloses  VNINDEX closes
 * @returns {number} 0-100
 */
function rsRating(stockCloses, benchCloses) {
  const period = Math.min(50, stockCloses.length - 1);
  if (period < 10) return 50;
  const stockRet = (stockCloses[stockCloses.length - 1] / stockCloses[stockCloses.length - 1 - period] - 1) * 100;
  if (!benchCloses || benchCloses.length < period + 1) {
    return Math.max(0, Math.min(100, 50 + stockRet * 2.5));
  }
  const benchRet = (benchCloses[benchCloses.length - 1] / benchCloses[benchCloses.length - 1 - period] - 1) * 100;
  const out = stockRet - benchRet;
  return Math.max(0, Math.min(100, 50 + out * 5));
}

module.exports = { rsRating };
