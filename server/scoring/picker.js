/**
 * Stock Picker — lọc SEPA top picks theo ngành mạnh + định giá + rank.
 *
 * Pure logic (testable) ở pickFromCandidates(). Heavy network assembly
 * (screenAll + sector scores + fundamentals) ở assembleCandidates() async
 * — thêm ở Step 4 wiring. Spec §5.
 *
 * @module scoring/picker
 */

/**
 * Phân loại sức mạnh ngành theo sector score.
 * STRONG (A/A+, ≥70) · NEUTRAL (B/C, 40-69) · WEAK (D, <40).
 * @param {number} score
 * @returns {'STRONG'|'NEUTRAL'|'WEAK'}
 */
function classifySector(score) {
  if (typeof score !== 'number' || isNaN(score)) return 'NEUTRAL';
  if (score >= 70) return 'STRONG';
  if (score < 40) return 'WEAK';
  return 'NEUTRAL';
}

/**
 * Effective score = SEPA × (sectorScore/100)^0.6.
 * Boost nhẹ cho CP thuộc ngành A+, phạt ngành yếu. Spec §5 step 5.
 * @param {number} sepaScore
 * @param {number|null} sectorScore
 * @returns {number}
 */
function effectiveScore(sepaScore, sectorScore) {
  if (typeof sectorScore !== 'number' || sectorScore == null) return sepaScore;
  return Math.round(sepaScore * Math.pow(sectorScore / 100, 0.6));
}

/**
 * Flag CP đắt trong ngành: P/E > 2× median ngành.
 * (P/E so median ngành chứ không absolute — Ngân hàng P/E 15 OK, Tech 25 OK.)
 * @param {number} stockPe
 * @param {number|null} sectorPeMedian
 * @returns {'EXPENSIVE'|null}
 */
function valuationFlag(stockPe, sectorPeMedian) {
  if (typeof stockPe !== 'number' || typeof sectorPeMedian !== 'number' || sectorPeMedian <= 0) return null;
  return stockPe > sectorPeMedian * 2 ? 'EXPENSIVE' : null;
}

/**
 * Lọc + rank SEPA candidates theo sức mạnh ngành + định giá. Pure function.
 *
 * Bước (Spec §5): loại ngành yếu → flag đắt → tính effectiveScore →
 * diversify (maxPerSector) → rank → limit.
 *
 * @param {Array} candidates     — output screenAll: {symbol, score, grade, price, ...}
 * @param {object} ctx
 *   { symbolSector, sectorScores, sectorPeMedian, stockPe,
 *     maxPicks=20, maxPerSector=3, weakSectorExclude=true }
 * @returns {Array} ranked candidates with {effectiveScore, sector, sectorScore, sectorClass, flags}
 */
function pickFromCandidates(candidates, ctx) {
  ctx = ctx || {};
  const {
    symbolSector = {},
    sectorScores = {},
    sectorPeMedian = {},
    stockPe = {},
    maxPicks = 20,
    maxPerSector = 3,
    weakSectorExclude = true
  } = ctx;

  const enriched = candidates.map(c => {
    const sector = symbolSector[c.symbol] || null;
    const sectorInfo = sector ? sectorScores[sector] : null;
    const sectorScore = sectorInfo ? sectorInfo.score : null;
    const sectorClass = classifySector(sectorScore);
    const eff = effectiveScore(c.score, sectorScore);
    const flags = [];
    const vFlag = valuationFlag(stockPe[c.symbol], sector ? sectorPeMedian[sector] : null);
    if (vFlag) flags.push(vFlag);
    return { ...c, effectiveScore: eff, sector, sectorScore, sectorClass, flags };
  });

  // Loại CP thuộc ngành yếu (trừ khi tắt)
  let filtered = weakSectorExclude
    ? enriched.filter(c => c.sectorClass !== 'WEAK')
    : enriched;

  // Rank theo effectiveScore desc (CP đắt vẫn giữ, chỉ flag — không hard-reject,
  // để LLM quyết định cuối; nhưng xếp dưới CP hợp lý cùng điểm).
  filtered.sort((a, b) => {
    // CP không flag EXPENSIVE ưu tiên trước khi cùng effScore
    const aExp = a.flags.includes('EXPENSIVE') ? 1 : 0;
    const bExp = b.flags.includes('EXPENSIVE') ? 1 : 0;
    if (aExp !== bExp) return aExp - bExp;
    return b.effectiveScore - a.effectiveScore;
  });

  // Diversify: không quá maxPerSector CP/ngành (giữ top theo effectiveScore)
  if (maxPerSector) {
    const sectorCount = {};
    filtered = filtered.filter(c => {
      if (!c.sector) return true;
      sectorCount[c.sector] = (sectorCount[c.sector] || 0) + 1;
      return sectorCount[c.sector] <= maxPerSector;
    });
  }

  return filtered.slice(0, maxPicks);
}

module.exports = { classifySector, effectiveScore, valuationFlag, pickFromCandidates };
