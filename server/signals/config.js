/**
 * Risk config — env-overridable defaults.
 * Override qua .env: RISK_PER_TRADE_PCT, MAX_POSITION_PCT, v.v.
 */
function loadConfig() {
  return {
    riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT || '1.0'),
    maxPositionPct: parseFloat(process.env.MAX_POSITION_PCT || '25'),
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '10'),
    maxSectorPct: parseFloat(process.env.MAX_SECTOR_PCT || '40'),
    atrMultiplier: parseFloat(process.env.ATR_MULTIPLIER || '2'),    // stop = entry - N×ATR
    targetRR: parseFloat(process.env.TARGET_RR || '2')               // target = entry + RR×risk
  };
}

module.exports = { loadConfig };
