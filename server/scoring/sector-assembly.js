/**
 * Sector Score Assembly — wiring data sources → factors → computeSectorScore.
 *
 * Orchestrator async (như screener.screenAll): gộp breadth-history + fiintrade
 * flow + industry-stats (lucCau/totalValue) + close cache (RS/momentum) +
 * fundamentals → assemble factors cho computeSectorScore(). Spec §4 + §9.2.
 *
 * Pure scoring logic nằm ở sector-score.js (đã test). Module này chỉ assemble.
 *
 * @module scoring/sector-assembly
 */

const path = require('path');
const fs = require('fs');
const breadthHistory = require('../breadth-history');
const { computeSectorScore } = require('./sector-score');
const { rsRating } = require('./rs');

// ICB2_MAP (20 ngành) — canonical từ breadth-history.js, fallback local.
let _icb2Map = null;
function getICB2Map() {
  if (_icb2Map) return _icb2Map;
  try { _icb2Map = breadthHistory.ICB2_MAP || null; } catch (e) { _icb2Map = null; }
  if (!_icb2Map) {
    // Fallback (đồng bộ với breadth-history.js:38-59)
    _icb2Map = {
      '0500': 'Dầu khí', '1300': 'Hóa chất', '1700': 'Tài nguyên cơ bản',
      '2300': 'Xây dựng và VLXD', '2700': 'Sản phẩm & DV công nghiệp',
      '3300': 'Ôtô và linh kiện', '3500': 'Thực phẩm và đồ uống',
      '3700': 'Hàng tiêu dùng', '4500': 'Y tế', '5300': 'Bán lẻ',
      '5500': 'Truyền thông', '5700': 'Du lịch và giải trí',
      '6500': 'Viễn thông', '7500': 'Các dịch vụ hạ tầng',
      '8300': 'Ngân hàng', '8500': 'Bảo hiểm', '8600': 'Bất động sản',
      '8700': 'Dịch vụ tài chính', '8900': 'Quỹ', '9500': 'Công nghệ'
    };
  }
  return _icb2Map;
}

/**
 * Load close cache (ma-breadth-close.json) → {symbols, vnindexCloses}.
 */
function loadCloseCache() {
  try {
    const file = path.join(__dirname, '..', 'data', 'ma-breadth-close.json');
    if (!fs.existsSync(file)) return { symbols: {}, vnindexCloses: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = data.symbols && data.symbols.VNINDEX;
    return {
      symbols: data.symbols || {},
      vnindexCloses: v ? (v.closes || []) : []
    };
  } catch (e) {
    return { symbols: {}, vnindexCloses: [] };
  }
}

/**
 * Tính RS ngành vs VNINDEX (factor #2).
 * Ưu tiên từ close cache (cần symbol→sector map). Nếu thiếu map → fallback
 * breadth RS: so %MA50 breadth của ngành vs toàn thị trường (~3 tháng).
 * Breadth RS luôn khả dụng (dùng data sẵn có, không cần symbol→sector).
 *
 * @param {string} icb2
 * @param {object} symbolBySector  map icb2 → [symbol,...] (có thể rỗng)
 * @param {object} closeSymbols    map symbol → {closes:[]}
 * @param {number[]} vnindexCloses
 */
function computeSectorRS(icb2, symbolBySector, closeSymbols, vnindexCloses) {
  // Ưu tiên price-based RS (chính xác hơn) nếu có symbol→sector map
  const syms = symbolBySector[icb2] || [];
  if (syms.length) {
    const period = 60; // ~3 tháng
    let returns = [];
    for (const sym of syms) {
      const s = closeSymbols[sym];
      if (!s || !Array.isArray(s.closes) || s.closes.length < period + 1) continue;
      const c = s.closes;
      const ret = (c[c.length - 1] / c[c.length - 1 - period] - 1) * 100;
      if (isFinite(ret)) returns.push(ret);
    }
    if (returns.length) {
      returns = returns.filter(r => r > -100 && r < 200);
      if (returns.length) {
        const sectorRet = returns.reduce((a, b) => a + b, 0) / returns.length;
        let indexRet = 0;
        if (vnindexCloses.length >= period + 1) {
          indexRet = (vnindexCloses[vnindexCloses.length - 1] / vnindexCloses[vnindexCloses.length - 1 - period] - 1) * 100;
        }
        return { sectorReturn3m: Math.round(sectorRet * 100) / 100, indexReturn3m: Math.round(indexRet * 100) / 100 };
      }
    }
  }

  // Fallback: breadth RS — %MA50 breadth của ngành vs thị trường
  return computeSectorRSFromBreadth(icb2);
}

/**
 * Breadth RS: ngành có %MA50 breadth vượt trội thị trường = mạnh hơn.
 *
 * Calibration: breadth delta thực tế ~±15% (delta=13.9 → ngành mạnh nhất).
 * rsVsIndexScore = 50 + return×25. Để delta=13.9 → RS~90 (không bị clamp 100):
 *   return cần = (90-50)/25 = 1.6 → scale = 1.6/13.9 ≈ 0.12.
 * Dùng scale 0.12: delta breadth → return proxy → score 50±~40 (spread tốt).
 */
function computeSectorRSFromBreadth(icb2) {
  try {
    const secBreadth = breadthHistory.getBreadth({ scope: 'industry', industryCode: icb2, days: 60 });
    const mktBreadth = breadthHistory.getBreadth({ scope: 'market', days: 60 });
    const sSeries = (secBreadth && secBreadth.series) || [];
    const mSeries = (mktBreadth && mktBreadth.series) || [];
    if (!sSeries.length || !mSeries.length) return null;
    // %MA50 hiện tại (độ rộng ngành vs thị trường) — count/total → %
    const sLast = sSeries[sSeries.length - 1];
    const mLast = mSeries[mSeries.length - 1];
    if (sLast.ma50 == null || mLast.ma50 == null) return null;
    const sNow = (sLast.total > 0) ? (sLast.ma50 / sLast.total) * 100 : null;
    const mNow = (mLast.total > 0) ? (mLast.ma50 / mLast.total) * 100 : null;
    if (sNow == null || mNow == null) return null;
    // delta breadth → return proxy (scale 0.12) → rsVsIndexScore cho score spread tốt
    return { sectorReturn3m: Math.round((sNow - mNow) * 0.12 * 100) / 100, indexReturn3m: 0 };
  } catch (e) { return null; }
}

/**
 * Tính momentum breadth (factor #4) — %CP ngành có MACD hist > 0.
 * Nhanh: xấp xỉ MACD bằng EMA(12,26) trên close (đủ chính xác cho breadth).
 */
function computeMomentumBreadth(icb2, symbolBySector, closeSymbols) {
  const syms = symbolBySector[icb2] || [];
  let pos = 0, total = 0;
  for (const sym of syms) {
    const s = closeSymbols[sym];
    if (!s || !Array.isArray(s.closes) || s.closes.length < 35) continue;
    const hist = macdHist(s.closes);
    if (hist == null) continue;
    total++;
    if (hist > 0) pos++;
  }
  if (!total) return null;
  return { pctMACDpos: Math.round((pos / total) * 1000) / 10 };
}

// EMA nhanh (xấp xỉ MACD hist = EMA12 - EMA26 signal=EMA9).
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function macdHist(closes) {
  const macdLine = (ema(closes, 12) || 0) - (ema(closes, 26) || 0);
  // signal xấp xỉ: EMA9 của (macdLine đơn điểm) → dùng heuristic đơn giản
  // Đủ cho breadth (chỉ cần dấu +/-). Dùng slope EMA12 vs EMA26.
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  if (e12 == null || e26 == null) return null;
  return e12 - e26;
}

/**
 * Build symbol→sector map từ breadth-history snapshots (lấy icb2 per symbol).
 */
function buildSymbolBySector() {
  const data = breadthHistory._loadHistory ? breadthHistory._loadHistory() : null;
  const map = {};
  // breadth-history lưu symMeta trong meta — thử lấy; nếu không có → map rỗng
  // (RS/momentum factor sẽ fallback neutral 50).
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'ma-breadth-history.json'), 'utf8');
    const hist = JSON.parse(raw);
    const symMeta = (hist.meta && hist.meta.symMeta) || {};
    for (const [sym, m] of Object.entries(symMeta)) {
      if (m && m.icb2) {
        if (!map[m.icb2]) map[m.icb2] = [];
        map[m.icb2].push(sym);
      }
    }
  } catch (e) { /* fallback rỗng */ }
  return map;
}

/**
 * Convert netSmart (tỷ VND) per sector → netPct tương đối qua percentile rank.
 * Fiintrade flow không có totalValue/ngành → dùng rank tương đối thay thế:
 * rank 1 (gom nhiều nhất) → netPct +6, rank cuối → netPct -6, median → 0.
 * (netPct±6 maps qua smartMoneyScore → 50±48, đúng khoảng phân cực.)
 *
 * @param {object} flowBySector  {icb2: netSmart số tỷ VND}
 * @returns {object} {icb2: netPct}
 */
function netSmartToNetPctByRank(flowBySector) {
  const entries = Object.entries(flowBySector)
    .filter(([_, v]) => typeof v === 'number' && !isNaN(v));
  entries.sort((a, b) => b[1] - a[1]); // netSmart giảm dần (gom nhiều nhất trước)
  const n = entries.length;
  const out = {};
  if (n <= 1) return out;
  entries.forEach(([code], idx) => {
    const rank = idx + 1; // 1..n
    // percentile: 1 (top) → +6, n (bottom) → -6. median(n/2) → ~0.
    const pct = (n - rank) / (n - 1); // 0..1
    out[code] = Math.round((pct * 12 - 6) * 100) / 100; // -6..+6
  });
  return out;
}

/**
 * Assemble factors cho 1 ngành → computeSectorScore.
 *
 * @param {string} icb2
 * @param {object} ctx — pre-fetched data:
 *   { symbolBySector, closeSymbols, vnindexCloses,
 *     netPctBySector: {icb2: netPct},  // đã convert từ netSmart rank
 *     industryStats: {icb2: {lucCau, totalValue, stockCount}},
 *     fundamentalsBySector: {icb2: [{pe,pb},...]},
 *     liquidityRanks: {icb2: {rank, totalSectors}} }
 * @returns {{score, grade, breakdown, name, code, flags?}}
 */
function assembleSector(icb2, ctx) {
  const factors = {};

  // #1 + #5 + #7: breadth trend, expansion, MA alignment (từ ma-breadth-history)
  // LƯU Ý: getBreadth trả ma{n} = COUNT (số CP trên MA), cần / total → %.
  const pctOf = (count, total) => (total > 0) ? Math.round((count / total) * 1000) / 10 : null;
  const br = safeBreadth(icb2, 25); // ~25 ngày gần nhất
  const brNow = br.length ? br[br.length - 1] : null;
  const br20 = br.length >= 21 ? br[br.length - 21] : null;
  const br10 = br.length >= 11 ? br[br.length - 11] : null;
  factors.breadthTrend = (brNow && br20 && brNow.ma50 != null && br20.ma50 != null)
    ? { pctMA50Now: pctOf(brNow.ma50, brNow.total), pctMA50_20dAgo: pctOf(br20.ma50, br20.total) }
    : null;
  factors.breadthExpansion = (brNow && br10 && brNow.ma20 != null && br10.ma20 != null)
    ? { pctMA20Now: pctOf(brNow.ma20, brNow.total), pctMA20_10dAgo: pctOf(br10.ma20, br10.total) }
    : null;
  factors.maAlignment = (brNow && brNow.ma10 != null && brNow.ma20 != null && brNow.ma50 != null)
    ? { pctMA10: pctOf(brNow.ma10, brNow.total), pctMA20: pctOf(brNow.ma20, brNow.total), pctMA50: pctOf(brNow.ma50, brNow.total) }
    : null;

  // #2: RS vs VNINDEX
  factors.rsVsIndex = computeSectorRS(icb2, ctx.symbolBySector || {}, ctx.closeSymbols || {}, ctx.vnindexCloses || []);

  // #4: momentum breadth
  factors.momentumBreadth = computeMomentumBreadth(icb2, ctx.symbolBySector || {}, ctx.closeSymbols || {});

  // #6: lucCau (từ industry-stats)
  const stats = ctx.industryStats && ctx.industryStats[icb2];
  factors.lucCau = stats && typeof stats.lucCau === 'number' ? stats.lucCau : null;

  // #3: smart money — netPct đã convert từ netSmart rank (relative giữa 20 ngành)
  const netPct = ctx.netPctBySector && ctx.netPctBySector[icb2];
  factors.smartMoney = (typeof netPct === 'number') ? { netPct } : null;

  // #8: valuation (từ fundamentals)
  const funds = ctx.fundamentalsBySector && ctx.fundamentalsBySector[icb2];
  factors.valuation = funds && funds.length >= 3
    ? { peAvg: medianArr(funds.map(f => f.pe)), pbAvg: medianArr(funds.map(f => f.pb)) }
    : null;

  // #9: liquidity rank
  const liq = ctx.liquidityRanks && ctx.liquidityRanks[icb2];
  factors.liquidity = liq ? { rank: liq.rank, totalSectors: liq.totalSectors } : null;

  const result = computeSectorScore(factors);
  return { ...result, code: icb2, name: getICB2Map()[icb2] || icb2 };
}

function safeBreadth(icb2, days) {
  try {
    const r = breadthHistory.getBreadth({ scope: 'industry', industryCode: icb2, days });
    return (r && r.series) ? r.series : [];
  } catch (e) { return []; }
}

function medianArr(arr) {
  const nums = arr.filter(v => typeof v === 'number' && !isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

module.exports = {
  assembleSector,
  getICB2Map,
  loadCloseCache,
  buildSymbolBySector,
  computeSectorRS,
  computeSectorRSFromBreadth,
  computeMomentumBreadth,
  netSmartToNetPctByRank
};
