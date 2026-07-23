const { forwardReturn, isWin } = require('./label');
const { computeTA } = require('../ta');
const { computeSEPA } = require('../scoring');
const { rsRating } = require('../scoring/rs');
const ph = require('../ta/price-history');

/**
 * Tính aggregate metrics từ danh sách picks (mỗi pick có returnPct, maxDrawdown, score, grade).
 */
function aggregateMetrics(picks, opts) {
  opts = opts || {};
  const threshold = opts.threshold || 5;
  if (picks.length === 0) {
    return { totalPicks: 0, winRate: 0, avgReturn: 0, medianReturn: 0,
             avgMaxDrawdown: 0, riskAdjusted: 0, perGrade: {} };
  }
  const wins = picks.filter(p => p.returnPct >= threshold);
  const returns = picks.map(p => p.returnPct).sort((a, b) => a - b);
  const avgRet = returns.reduce((s, v) => s + v, 0) / returns.length;
  const median = returns[Math.floor(returns.length / 2)];
  const avgDD = picks.reduce((s, p) => s + (p.maxDrawdown || 0), 0) / picks.length;

  // per-grade breakdown
  const grades = ['A+', 'A', 'B', 'C', 'D'];
  const perGrade = {};
  for (const g of grades) {
    const gp = picks.filter(p => p.grade === g);
    if (gp.length > 0) {
      const gw = gp.filter(p => p.returnPct >= threshold).length;
      perGrade[g] = { count: gp.length, winRate: Math.round(gw / gp.length * 10000) / 100,
                      avgReturn: Math.round(gp.reduce((s, p) => s + p.returnPct, 0) / gp.length * 100) / 100 };
    }
  }

  return {
    totalPicks: picks.length,
    winRate: Math.round(wins.length / picks.length * 10000) / 100,
    avgReturn: Math.round(avgRet * 100) / 100,
    medianReturn: Math.round(median * 100) / 100,
    avgMaxDrawdown: Math.round(avgDD * 100) / 100,
    riskAdjusted: avgDD > 0 ? Math.round(avgRet / avgDD * 100) / 100 : 0,
    perGrade
  };
}

/**
 * Backtest tổng hợp: cho mỗi ngày trong [fromDate,toDate], score tất cả symbol,
 * filter minScore → tính forwardReturn → aggregate.
 *
 * @param {object} opts { fromDate, toDate, minScore, holdDays, threshold }
 * @returns {object} metrics + sample picks
 */
function backtest(opts) {
  opts = opts || {};
  const minScore = opts.minScore || 55;
  const holdDays = opts.holdDays || 20;
  const threshold = opts.threshold || 5;
  const fromDate = opts.fromDate; // YYYY-MM-DD hoặc undefined
  const toDate = opts.toDate;

  const vnindex = ph.getHistory('VNINDEX');
  const benchCloses = vnindex ? (vnindex.closes || (vnindex.ohlc || []).map(x => x.c)) : null;

  const symbols = ph.listSymbols().filter(s => s !== 'VNINDEX');
  const picks = [];
  let daysScanned = 0;

  for (const symbol of symbols) {
    const h = ph.getHistory(symbol);
    if (!h || !h.ohlc || h.ohlc.length < 200) continue;
    const closes = h.ohlc.map(x => x.c);
    const dates = h.dates;

    // Quét mỗi ngày có đủ history (≥200) và đủ forward (exit trong data)
    for (let i = 200; i < closes.length - 3 - holdDays; i++) {
      const d = dates[i];
      if (fromDate && d < fromDate) continue;
      if (toDate && d > toDate) continue;

      // Score snapshot tại ngày i (dùng closes[0..i])
      const partialH = { dates: dates.slice(0, i + 1), ohlc: h.ohlc.slice(0, i + 1), volumes: (h.volumes || []).slice(0, i + 1) };
      let ta;
      try { ta = computeTA(partialH); } catch (e) { continue; }
      if (!ta) continue;

      const rs = rsRating(closes.slice(0, i + 1), benchCloses);
      const scoreRes = computeSEPA(ta, { rsRating: rs });
      if (scoreRes.score < minScore) continue;

      const fr = forwardReturn(closes, i, holdDays);
      if (!fr) continue;

      picks.push({
        symbol, date: d, entryPrice: closes[i], exitPrice: closes[fr.exitIdx],
        score: scoreRes.score, grade: scoreRes.grade,
        returnPct: fr.returnPct, maxDrawdown: fr.maxDrawdown, maxGain: fr.maxGain
      });
      daysScanned++;
    }
  }

  const metrics = aggregateMetrics(picks, { threshold });
  return {
    success: true,
    params: { minScore, holdDays, threshold, fromDate, toDate },
    ...metrics,
    symbolsScanned: symbols.length,
    samplePicks: picks.sort((a, b) => b.returnPct - a.returnPct).slice(0, 20)
  };
}

/**
 * Backtest trên data giả (cho test, không cần price-history.json).
 * @param {Array<[string, number[]]>} synthetic  [[symbol, closes], ...]
 */
function backtestSynthetic(synthetic, opts) {
  opts = opts || {};
  const minScore = opts.minScore || 0; // synthetic không score, accept all
  const holdDays = opts.holdDays || 5;
  const threshold = opts.threshold || 5;
  const picks = [];
  for (const [symbol, closes] of synthetic) {
    // entry mỗi 10 ngày, đủ forward
    for (let i = 50; i < closes.length - 3 - holdDays; i += 10) {
      const fr = forwardReturn(closes, i, holdDays);
      if (!fr) continue;
      picks.push({ symbol, returnPct: fr.returnPct, maxDrawdown: fr.maxDrawdown,
                   score: 75, grade: 'A' });
    }
  }
  return aggregateMetrics(picks, { threshold });
}

module.exports = { backtest, backtestSynthetic, aggregateMetrics };
