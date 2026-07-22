/**
 * SEPA Composite Score (0-100) from TA output (computeTA from server/ta/).
 * 9 factors weighted per spec §2.2.
 * @param {object} ta output of computeTA()
 * @param {object} [opts] { rsRating?: 0-100, distMA20?: number }
 * @returns {{score:number, grade:string, breakdown:object}}
 */
function computeSEPA(ta, opts) {
  opts = opts || {};
  const rs = (typeof opts.rsRating === 'number') ? opts.rsRating : 50;

  const tt = ta.sepa.trendTemplate;
  const fTT = tt.pass ? 100 : (tt.rules.filter(Boolean).length / 8) * 100;

  const fADX = Math.min(100, (ta.trend.adx || 0) * 2.5);

  const vcp = ta.sepa.vcp;
  let fVCP = 0;
  if (vcp.isVCP) fVCP = 100;
  else if (vcp.tightness != null && vcp.tightness <= 15) fVCP = 100 - vcp.tightness * 4;

  const fRS = Math.max(0, Math.min(100, rs));

  const m = ta.mas || {};
  let fMA = 0;
  if (m.ma50 != null && m.ma150 != null && m.ma200 != null) {
    if (m.ma50 > m.ma150 && m.ma150 > m.ma200) fMA = 100;
    else if (m.ma50 > m.ma150 || m.ma150 > m.ma200) fMA = 50;
  }

  const histArr = (ta.momentum && ta.momentum.macd && ta.momentum.macd.histogram) || [];
  const hist = Array.isArray(histArr) && histArr.length ? histArr[histArr.length - 1] : 0;
  const fMACD = hist > 0 ? 100 : Math.max(0, 50 + hist * 50);

  const pp = ta.sepa.pocketPivot;
  const fPP = pp.detected ? 100 : Math.min(100, (pp.volumeRatio || 0) * 50);

  const fDist = (typeof opts.distMA20 === 'number')
    ? (opts.distMA20 >= 0 && opts.distMA20 <= 8 ? 100 - opts.distMA20 * 5 : Math.max(0, 60 - opts.distMA20 * 3))
    : 50;

  const fSq = ta.bollinger.squeeze ? 100 : 0;

  const breakdown = {
    trendTemplate: Math.round(fTT), adx: Math.round(fADX), vcp: Math.round(fVCP),
    rs: Math.round(fRS), maAlignment: Math.round(fMA), macd: Math.round(fMACD),
    pocketPivot: Math.round(fPP), distMA20: Math.round(fDist), squeeze: Math.round(fSq)
  };

  // Weights: đọc từ config (scoring-weights.json) — optimize backtest ghi vào đó.
  // Fallback default nếu chưa optimize. Lazy require tránh circular dep.
  let w;
  try { w = require('../backtest/optimize').loadWeights(); }
  catch (e) { w = { trendTemplate:0.25, adx:0.15, vcp:0.15, rs:0.15, maAlignment:0.10, macd:0.08, pocketPivot:0.05, distMA20:0.04, squeeze:0.03 }; }

  const score = Math.round(
    fTT * w.trendTemplate + fADX * w.adx + fVCP * w.vcp + fRS * w.rs + fMA * w.maAlignment +
    fMACD * w.macd + fPP * w.pocketPivot + fDist * w.distMA20 + fSq * w.squeeze
  );

  return { score: Math.max(0, Math.min(100, score)), grade: gradeFor(score), breakdown };
}

function gradeFor(score) {
  if (score >= 85) return 'A+';
  if (score >= 70) return 'A';
  if (score >= 55) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

module.exports = { computeSEPA, gradeFor };
