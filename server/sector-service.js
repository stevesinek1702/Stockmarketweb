/**
 * Sector Strength Service — orchestration layer cho /api/sector-strength
 * và /api/ai/stock-picker.
 *
 * Gộp: industry-stats (lucCau, totalValue) + fiintrade flow (netSmart) +
 * breadth-history + close cache (RS/momentum) + fundamentals →
 * computeSectorScore cho 20 ngành. Spec §4 + §9.2.
 *
 * Endpoint /api/sector-strength gọi computeSectorScores().
 * Endpoint /api/ai/stock-picker gọi computeStockPicks() (reuses screenAll
 * + picker + generateStockPicks).
 *
 * @module sector-service
 */

const fiintrade = require('./fiintrade');
const breadthHistory = require('./breadth-history');
const assembly = require('./scoring/sector-assembly');
const { computeSectorScore } = require('./scoring/sector-score');
const { pickFromCandidates } = require('./scoring/picker');
const fundamentals = require('./data/fundamentals');

/**
 * Lấy industry-stats (lucCau, totalValue, stockCount per ICB2) — gọi internal
 * endpoint logic tương đương /api/industry-stats nhưng trích ra map gọn.
 * Tránh HTTP self-call: tính trực tiếp reuse helpers khi có thể, fallback fetch.
 *
 * @returns {Promise<{industryStats, flowBySector}>}
 */
async function fetchSectorInputs() {
  // ── Smart-money flow (netSmart per sector, timeRange=20) ──
  let netSmartBySector = {};
  try {
    const flow = await fiintrade.getSectorFlow(20, 2);
    for (const d of (flow.data || [])) {
      // Fiintrade icbCode là cấp-2, có thể có đuôi (vd "8300") → match ICB2 4 số đầu
      const code = String(d.code || '').substring(0, 4).padEnd(4, '0');
      netSmartBySector[code] = d.netSmart;
    }
  } catch (e) {
    console.warn('[sector-service] getSectorFlow fail:', e.message);
  }
  const netPctBySector = assembly.netSmartToNetPctByRank(netSmartBySector);

  return { netPctBySector };
}

/**
 * Lấy lucCau + totalValue per sector từ /api/industry-stats (self-call, cached).
 * Trả về map {icb2: {lucCau, totalValue, stockCount}}.
 */
async function fetchIndustryStats(port) {
  try {
    const axios = require('axios');
    const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'vnstock-scheduler-internal';
    const { data } = await axios.get(`http://localhost:${port}/api/industry-stats`, {
      timeout: 15000,
      headers: { 'X-Internal-Secret': INTERNAL_SECRET }
    });
    const out = {};
    for (const s of (data.results || data.sectors || [])) {
      if (s.code) out[s.code] = {
        lucCau: s.lucCau,
        totalValue: s.totalValue || s.totalMarketCap,
        stockCount: s.stockCount
      };
    }
    return out;
  } catch (e) {
    console.warn('[sector-service] industry-stats fetch fail:', e.message);
    return {};
  }
}

/**
 * Build fundamentals-by-sector: gộp fundamentals per symbol vào per sector.
 * Cần symbol→sector map (từ breadth-history symMeta).
 */
function buildFundamentalsBySector(symbolBySector) {
  const allFunds = fundamentals.getAll();
  const out = {};
  for (const [sector, syms] of Object.entries(symbolBySector)) {
    const funds = [];
    for (const sym of syms) {
      const f = allFunds[sym];
      if (f && (f.pe != null || f.pb != null)) funds.push(f);
    }
    if (funds.length) out[sector] = funds;
  }
  return out;
}

/**
 * Compute liquidity ranks (per ICB2) từ totalValue.
 */
function computeLiquidityRanks(industryStats) {
  const entries = Object.entries(industryStats)
    .filter(([_, s]) => typeof s.totalValue === 'number' && s.totalValue > 0)
    .sort((a, b) => b[1].totalValue - a[1].totalValue);
  const n = entries.length;
  const out = {};
  entries.forEach(([code], idx) => {
    out[code] = { rank: idx + 1, totalSectors: n };
  });
  return out;
}

/**
 * Fetch VNINDEX closes từ /api/vnindex-history (FireAnt HistoricalQuotes, công khai).
 * Close cache không chứa VNINDEX → phải lấy riêng cho price-based RS.
 * @param {number} port
 * @returns {Promise<number[]>}
 */
async function fetchVNIndexCloses(port) {
  try {
    const axios = require('axios');
    const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'vnstock-scheduler-internal';
    const { data } = await axios.get(`http://localhost:${port}/api/vnindex-history`, {
      timeout: 10000,
      headers: { 'X-Internal-Secret': INTERNAL_SECRET }
    });
    const rows = (data && data.data) || [];
    return rows.map(r => r.close).filter(v => typeof v === 'number');
  } catch (e) {
    console.warn('[sector-service] vnindex-history fetch fail:', e.message);
    return [];
  }
}

/**
 * Compute sector scores cho tất cả ICB2.
 * @returns {Promise<{success, generatedAt, sectors:[]}>}
 */
async function computeSectorScores(opts = {}) {
  const port = opts.port || (process.env.PORT || 3000);
  const ICB2_MAP = assembly.getICB2Map();
  const { netPctBySector } = await fetchSectorInputs();
  const industryStats = await fetchIndustryStats(port);
  const liquidityRanks = computeLiquidityRanks(industryStats);

  const { symbols: closeSymbols } = assembly.loadCloseCache();
  const symbolBySector = assembly.buildSymbolBySector();
  const fundamentalsBySector = buildFundamentalsBySector(symbolBySector);
  // VNINDEX closes: close cache không có → fetch từ vnindex-history (cho price RS).
  const vnindexCloses = await fetchVNIndexCloses(port);

  const ctx = {
    netPctBySector, industryStats, liquidityRanks,
    closeSymbols, vnindexCloses, symbolBySector, fundamentalsBySector
  };

  const sectors = Object.keys(ICB2_MAP).map(icb2 => {
    try {
      return assembly.assembleSector(icb2, ctx);
    } catch (e) {
      console.warn(`[sector-service] assembleSector ${icb2} fail:`, e.message);
      return { code: icb2, name: ICB2_MAP[icb2], score: 50, grade: 'C', breakdown: {}, error: e.message };
    }
  });

  // Sort by score desc + thêm trend arrow
  sectors.sort((a, b) => b.score - a.score);
  sectors.forEach((s, i) => {
    s.trend = (s.breakdown && s.breakdown.breadthExpansion > 55) ? 'up'
            : (s.breakdown && s.breakdown.breadthExpansion < 45) ? 'down' : 'flat';
    s.rank = i + 1;
  });

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    sectors
  };
}

/**
 * Compute AI stock picks: sector scores → screenAll → picker → LLM.
 * @returns {Promise<{success, sectorContext, picks, provider, aiFallback?}>}
 */
async function computeStockPicks(opts = {}) {
  const port = opts.port || (process.env.PORT || 3000);
  const maxPicks = opts.maxPicks || 8;

  // 1) Sector scores
  const sectorResult = await computeSectorScores({ port });
  const sectorScores = {};
  const sectorPeMedian = {};
  const sectorNames = {};
  for (const s of sectorResult.sectors) {
    sectorScores[s.code] = { score: s.score, grade: s.grade };
    sectorNames[s.code] = s.name;
    // median P/E ngành từ fundamentals breakdown (nếu có)
    if (s.valuation && typeof s.valuation.peAvg === 'number') {
      sectorPeMedian[s.code] = s.valuation.peAvg;
    }
  }

  // 2) SEPA screen (reuse screener.screenAll)
  let screenResult;
  try {
    const { screenAll } = require('./scoring/screener');
    screenResult = screenAll({ minScore: 70, limit: 100, grade: 'A' });
  } catch (e) {
    // price-history.json có thể chưa backfill → screenAll rỗng
    console.warn('[sector-service] screenAll fail (cần backfill price-history?):', e.message);
    screenResult = { results: [] };
  }

  // 3) Symbol→sector map + per-stock PE
  const symbolBySector = assembly.buildSymbolBySector();
  const symbolSector = {};
  for (const [sector, syms] of Object.entries(symbolBySector)) {
    for (const sym of syms) symbolSector[sym] = sector;
  }
  const allFunds = fundamentals.getAll();
  const stockPe = {};
  for (const [sym, f] of Object.entries(allFunds)) {
    if (f.pe != null) stockPe[sym] = f.pe;
  }

  // 4) Picker: filter + rank
  const candidates = pickFromCandidates(screenResult.results || [], {
    symbolSector, sectorScores, sectorPeMedian, stockPe,
    maxPicks: 15, maxPerSector: 3
  });

  // 5) Enrich with signal (entry/stop/target) + sector name
  const enriched = candidates.map(c => {
    let signal = null;
    try {
      // Tính signal cần TA — heavy; skip nếu không có price-history
      const ph = require('./ta/price-history');
      const h = ph.getHistory(c.symbol);
      if (h) {
        const { computeTA } = require('./ta');
        const { computeSEPA } = require('./scoring/score');
        const { rsRating } = require('./scoring/rs');
        const ta = computeTA(h);
        if (ta) {
          const closes = h.ohlc.map(x => x.c);
          const rs = rsRating(closes, null);
          const scoreResult = computeSEPA(ta, { rsRating: rs });
          const { generateSignal } = require('./signals/signal');
          signal = generateSignal(scoreResult, ta, c.price);
        }
      }
    } catch (e) { /* skip signal */ }
    return {
      ...c,
      sectorName: sectorNames[c.sector] || c.sector,
      sectorGrade: sectorScores[c.sector] ? sectorScores[c.sector].grade : null,
      sepaScore: c.score,
      sepaGrade: c.grade,
      pe: stockPe[c.symbol] || null,
      entry: signal ? signal.entry : c.price,
      stop: signal ? signal.stop : null,
      target1: signal ? signal.target1 : null,
      atr: signal ? signal.atr : null,
      rr: signal ? signal.rr : null
    };
  });

  // 6) AI reasoning (LLM xếp hạng + giải thích)
  const sectorContext = sectorResult.sectors.slice(0, 8).map(s => ({
    code: s.code, name: s.name, score: s.score, grade: s.grade, trend: s.trend
  }));

  const aiModule = require('./ai');
  let aiResult;
  try {
    aiResult = await aiModule.generateStockPicks(
      { sectorContext, candidates: enriched },
      { maxPicks, provider: opts.provider }
    );
  } catch (e) {
    // Fallback: dùng pre-rank không lý do
    aiResult = { picks: e.picks || [], provider: 'fallback', aiFallback: true };
  }

  // 7) Merge AI reasoning với entry/stop đã tính
  const finalPicks = (aiResult.picks || []).map(p => {
    const match = enriched.find(c => c.symbol === p.symbol);
    return { ...p, ...(match || {}) };
  });

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    provider: aiResult.provider,
    aiFallback: aiResult.aiFallback || false,
    sectorContext,
    picks: finalPicks,
    candidateCount: enriched.length
  };
}

module.exports = {
  computeSectorScores,
  computeStockPicks,
  fetchSectorInputs,
  fetchIndustryStats,
  fetchVNIndexCloses,
  buildFundamentalsBySector,
  computeLiquidityRanks
};
