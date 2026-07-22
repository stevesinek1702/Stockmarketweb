const { loadConfig } = require('./config');

/**
 * Tính position size dựa trên risk mgmt rules.
 * @param {number} accountValue  tổng vốn (VND)
 * @param {number} entry         giá mua
 * @param {number} stop          giá stop-loss
 * @returns {{shares, riskAmount, positionValue, positionPct, capped}}
 */
function positionSize(accountValue, entry, stop) {
  const cfg = loadConfig();
  if (entry <= stop || accountValue <= 0) {
    return { shares: 0, riskAmount: 0, positionValue: 0, positionPct: 0, capped: false };
  }
  const riskPerShare = entry - stop;
  const riskAmount = accountValue * cfg.riskPerTradePct / 100;
  let shares = Math.floor(riskAmount / riskPerShare);

  // Cap: max % vốn / position
  const maxPositionValue = accountValue * cfg.maxPositionPct / 100;
  const capped = shares * entry > maxPositionValue;
  if (capped) {
    shares = Math.floor(maxPositionValue / entry);
  }
  // Round về lô 100 (luật VN: lô chẵn 100 CP HOSE)
  shares = Math.floor(shares / 100) * 100;

  const positionValue = shares * entry;
  return {
    shares,
    riskAmount: Math.round(shares * riskPerShare),
    positionValue: Math.round(positionValue),
    positionPct: Math.round(positionValue / accountValue * 10000) / 100,
    capped,
    riskPct: cfg.riskPerTradePct
  };
}

module.exports = { positionSize };
