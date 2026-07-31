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
const { fetchOHLCVBatch } = require('./data/ohlcv-fetch');

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
 * Fetch top CP mỗi ngành từ /api/industry-top-stocks (lucCau cao, giá trên MA10).
 * Trả map {icb2: [{symbol, price, change}]}.
 * @param {number} port
 * @param {string[]} sectorCodes
 * @param {number} [limitPerSector=8]
 */
async function fetchIndustryTopStocks(port, sectorCodes, limitPerSector = 8) {
  const axios = require('axios');
  const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'vnstock-scheduler-internal';
  const out = {};
  // Fetch song song (mỗi ngành 1 call, ~10 ngành)
  const results = await Promise.all(sectorCodes.map(async code => {
    try {
      const { data } = await axios.get(
        `http://localhost:${port}/api/industry-top-stocks`,
        { params: { code, limit: limitPerSector }, timeout: 15000,
          headers: { 'X-Internal-Secret': INTERNAL_SECRET } }
      );
      return { code, data };
    } catch (e) {
      console.warn(`[sector-service] industry-top-stocks ${code} fail:`, e.message);
      return { code, data: null };
    }
  }));
  for (const { code, data } of results) {
    if (!data || !data.success) { out[code] = []; continue; }
    // industry-top-stocks trả {stocks:[{symbol,...}] hoặc array}
    const stocks = data.stocks || data.data || data.results || [];
    out[code] = stocks.map(s => ({
      symbol: s.symbol,
      price: s.priceCurrent || s.price || 0,
      change: s.percentChange || s.change || 0
    })).filter(s => s.symbol);
  }
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

  // 2) Per-sector ứng viên: top CP mạnh mỗi ngành (KHÔNG cần screenAll toàn bộ
  //    price-history.json). Lấy top ngành mạnh → industry-top-stocks → ứng viên.
  const strongSectors = sectorResult.sectors
    .filter(s => s.score >= 40) // bỏ ngành yếu (D)
    .slice(0, 10);              // top 10 ngành
  const topStocksBySector = await fetchIndustryTopStocks(
    opts.port || (process.env.PORT || 3000),
    strongSectors.map(s => s.code)
  );

  // 3) Fetch OHLCV thật cho ứng viên (on-demand, công khai FireAnt)
  const allCandidates = [];
  for (const sec of strongSectors) {
    const stocks = topStocksBySector[sec.code] || [];
    for (const st of stocks) {
      allCandidates.push({
        symbol: st.symbol, sector: sec.code, sectorName: sec.name,
        price: st.price, change: st.change,
        sectorScore: sec.score, sectorGrade: sec.grade
      });
    }
  }
  const symbols = [...new Set(allCandidates.map(c => c.symbol))];
  console.log(`🤖 [ai-picker] ${symbols.length} ứng viên từ ${strongSectors.length} ngành → fetch OHLCV...`);
  const ohlcvMap = await fetchOHLCVBatch(symbols, 5);

  // 4) Compute TA + SEPA cho mỗi ứng viên có OHLCV
  const { computeTA } = require('./ta');
  const { computeSEPA } = require('./scoring/score');
  const { rsRating } = require('./scoring/rs');
  const vnindexCloses = await fetchVNIndexCloses(opts.port || (process.env.PORT || 3000));
  const scoredCandidates = [];
  for (const c of allCandidates) {
    const h = ohlcvMap[c.symbol];
    if (!h || !h.ohlc || h.ohlc.length < 60) continue;
    try {
      const ta = computeTA(h);
      if (!ta) continue;
      const closes = h.ohlc.map(x => x.c);
      const rs = rsRating(closes, vnindexCloses);
      const ma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
      const distMA20 = ((closes[closes.length - 1] - ma20) / ma20) * 100;
      const r = computeSEPA(ta, { rsRating: rs, distMA20 });
      scoredCandidates.push({
        ...c,
        score: r.score, grade: r.grade, breakdown: r.breakdown,
        ta, price: closes[closes.length - 1]
      });
    } catch (e) { /* skip TA error */ }
  }

  // 5) Picker: filter + rank (sectorScores/sectorPeMedian đã build ở trên)
  const symbolSector = {};
  allCandidates.forEach(c => { symbolSector[c.symbol] = c.sector; });
  const allFunds = fundamentals.getAll();
  const stockPe = {};
  for (const [sym, f] of Object.entries(allFunds)) {
    if (f.pe != null) stockPe[sym] = f.pe;
  }
  const candidates = pickFromCandidates(scoredCandidates, {
    symbolSector, sectorScores, sectorPeMedian, stockPe,
    maxPicks: 15, maxPerSector: 3
  });

  // 6) Enrich with signal (entry/stop/target) + sector name
  //    Picker luôn đưa entry/stop/target (ATR-based) cho mọi pick, kể cả khi
  //    signal = WATCH/NONE — để UX luôn có trade cụ thể. ATR stop = entry - 2×ATR.
  const { generateSignal } = require('./signals/signal');
  const { loadConfig } = require('./signals/config');
  const cfg = loadConfig();
  const enriched = candidates.map(c => {
    const atr = (c.ta && c.ta.volatility && c.ta.volatility.atr) || 0;
    const entry = c.price;
    const stop = atr > 0 ? entry - cfg.atrMultiplier * atr : null;
    const risk = stop ? entry - stop : 0;
    const target1 = risk > 0 ? entry + cfg.targetRR * risk : null;
    // Signal (action/reason) — informational
    let signal = null;
    try {
      if (c.ta) {
        const scoreResult = { score: c.score, grade: c.grade, breakdown: c.breakdown };
        signal = generateSignal(scoreResult, c.ta, c.price);
      }
    } catch (e) { /* skip */ }
    const { ta, breakdown, ...rest } = c; // strip heavy TA/breakdown khỏi response
    return {
      ...rest,
      pe: stockPe[c.symbol] || null,
      entry,
      stop,
      target1,
      atr: atr > 0 ? Math.round(atr) : null,
      rr: cfg.targetRR,
      signal: signal ? signal.action : null,
      signalReason: signal ? signal.reason : null
    };
  });

  // 7) AI reasoning (LLM xếp hạng + giải thích)
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

  // 8) Merge AI reasoning với entry/stop đã tính
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
  fetchIndustryTopStocks,
  fetchVNIndexCloses,
  buildFundamentalsBySector,
  computeLiquidityRanks
};
