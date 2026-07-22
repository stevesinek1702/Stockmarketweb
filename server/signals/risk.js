const { loadConfig } = require('./config');

/**
 * Tính position size dựa trên risk mgmt rules.
 *
 * FIX: trước đây chỉ check maxPositionPct của TOTAL account → mua vượt vốn
 * (7 lệnh × 200M = 1.4 tỷ > 1 tỷ). Giờ thêm availableCash: nếu positionValue
 * > cash còn đủ → cap xuống availableCash (không đi âm vốn).
 *
 * @param {number} accountValue  tổng vốn (VND) — cho % calc
 * @param {number} entry         giá mua
 * @param {number} stop          giá stop-loss
 * @param {number} [availableCash]  tiền mặt còn đủ (mặc định = accountValue)
 * @returns {{shares, riskAmount, positionValue, positionPct, capped, cashCapped}}
 */
function positionSize(accountValue, entry, stop, availableCash) {
  const cfg = loadConfig();
  if (entry <= stop || accountValue <= 0) {
    return { shares: 0, riskAmount: 0, positionValue: 0, positionPct: 0, capped: false, cashCapped: false };
  }
  const cash = (availableCash != null && availableCash >= 0) ? availableCash : accountValue;
  const riskPerShare = entry - stop;
  const riskAmount = accountValue * cfg.riskPerTradePct / 100;
  let shares = Math.floor(riskAmount / riskPerShare);

  // Cap 1: max % vốn / position (tính trên total account)
  const maxPositionValue = accountValue * cfg.maxPositionPct / 100;
  let capped = false;
  if (shares * entry > maxPositionValue) {
    capped = true;
    shares = Math.floor(maxPositionValue / entry);
  }

  // Cap 2 (FIX): không vượt cash còn đủ. Nếu cash không đủ 1 lô → 0 shares.
  let cashCapped = false;
  if (shares * entry > cash) {
    cashCapped = true;
    shares = Math.floor(cash / entry);
  }

  // Round về lô 100 (luật VN: lô chẵn 100 CP HOSE)
  shares = Math.floor(shares / 100) * 100;

  const positionValue = shares * entry;
  return {
    shares,
    riskAmount: Math.round(shares * riskPerShare),
    positionValue: Math.round(positionValue),
    positionPct: accountValue > 0 ? Math.round(positionValue / accountValue * 10000) / 100 : 0,
    capped,
    cashCapped,
    riskPct: cfg.riskPerTradePct
  };
}

module.exports = { positionSize };
