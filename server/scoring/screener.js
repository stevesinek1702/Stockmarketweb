const { computeTA } = require('../ta');
const { computeSEPA } = require('./score');
const { rsRating } = require('./rs');
const ph = require('../ta/price-history');

/**
 * Screen + rank danh sách symbol đã chấm điểm. Pure filter/sort (testable).
 */
function screenList(scored, opts) {
  opts = opts || {};
  const minScore = opts.minScore || 0;
  const limit = opts.limit || 50;
  const grade = opts.grade;
  let r = scored.filter(s => s.score >= minScore);
  if (grade) r = r.filter(s => s.grade === grade);
  r.sort((a, b) => b.score - a.score);
  return r.slice(0, limit);
}

/**
 * Scan toàn bộ symbol trong price-history → computeTA → computeSEPA → rank.
 * Heavy (~1500 mã). Endpoint nên cache 5 phút.
 */
function screenAll(opts) {
  opts = opts || {};
  const minScore = opts.minScore || 55;
  const limit = opts.limit || 50;
  const grade = opts.grade;

  const vnindex = ph.getHistory('VNINDEX');
  const benchCloses = vnindex ? (vnindex.closes || (vnindex.ohlc || []).map(x => x.c)) : null;

  const symbols = ph.listSymbols();
  const scored = [];
  for (const symbol of symbols) {
    if (symbol === 'VNINDEX') continue;
    const h = ph.getHistory(symbol);
    if (!h || !h.ohlc || h.ohlc.length < 60) continue;
    try {
      const ta = computeTA(h);
      if (!ta) continue;
      const closes = h.ohlc.map(x => x.c);
      const rs = rsRating(closes, benchCloses);
      const last = h.ohlc.length - 1;
      const ma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
      const distMA20 = ((closes[last] - ma20) / ma20) * 100;
      const change = last > 0 ? ((closes[last] - closes[last - 1]) / closes[last - 1]) * 100 : 0;
      const r = computeSEPA(ta, { rsRating: rs, distMA20 });
      scored.push({
        symbol, score: r.score, grade: r.grade, price: closes[last],
        change: Math.round(change * 100) / 100, breakdown: r.breakdown,
        ta: {
          trendTemplatePass: ta.sepa.trendTemplate.pass,
          vcp: ta.sepa.vcp.isVCP,
          pocketPivot: ta.sepa.pocketPivot.detected,
          adx: Math.round(ta.trend.adx || 0)
        }
      });
    } catch (e) { /* skip symbol on TA error */ }
  }
  const filtered = screenList(scored, { minScore, limit, grade });
  return {
    success: true,
    timestamp: new Date().toISOString(),
    source: 'sepa-scoring',
    scanned: scored.length,
    filtered: filtered.length,
    results: filtered
  };
}

module.exports = { screenList, screenAll };
