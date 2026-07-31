/**
 * Sector Strength Composite Score (0-100) — mirror computeSEPA ở cấp ngành.
 *
 * 9 yếu tố đa chiều (trọng số thiên swing 1-4 tuần). Mỗi yếu tố → 0-100,
 * rồi nhân trọng số ra composite. Spec §4.
 *
 * Khác computeSEPA: input là `factors` object (đã assemble từ breadth/flow/RS/
 * fundamentals) thay vì TA output, vì ngành không có 1 "bảng giá" duy nhất.
 *
 * @module scoring/sector-score
 */

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// Trọng số cố định (swing 1-4 tuần). Tổng = 1.0. Spec §4 bảng.
// (Backtest/optimize sector weights = phase sau, giống optimize.js cho CP.)
const WEIGHTS = {
  breadthTrend: 0.22,     // #1 — trend lành mạnh (mirror Trend Template)
  rsVsIndex: 0.18,        // #2 — outperform VNINDEX (mirror RS rating)
  smartMoney: 0.15,       // #3 — dòng tiền lớn 20D (THẾ MẠNH ngành, chưa có ở CP)
  momentumBreadth: 0.12,  // #4 — %CP MACD>0 (mirror MACD hist)
  breadthExpansion: 0.10, // #5 — sức mạnh lan rộng (mirror VCP)
  lucCau: 0.08,           // #6 — lực cầu phiên (mirror Pocket Pivot)
  maAlignment: 0.06,      // #7 — stack MA breadth (mirror MA alignment)
  valuation: 0.05,        // #8 — P/E, P/B (filter, nhẹ cho swing)
  liquidity: 0.04         // #9 — thanh khoản (mirror Bollinger squeeze)
};

// ═══════════════════════════════════════════════════════════════════════
// 9 SUB-SCORE FACTORS — mỗi cái → 0-100
// ═══════════════════════════════════════════════════════════════════════

/**
 * #1 Breadth Trend (22%) — "trend lành mạnh" Minervini ở cấp ngành.
 * breadth cao (<20%=0, ≥70%=100) + slope mở rộng/thu hẹp (±30).
 * @param {{pctMA50Now:number, pctMA50_20dAgo:number}|null} f
 */
function breadthTrendScore(f) {
  if (!f || typeof f.pctMA50Now !== 'number') return 50;
  const now = f.pctMA50Now;
  const ago = (typeof f.pctMA50_20dAgo === 'number') ? f.pctMA50_20dAgo : now;
  const base = clamp(((now - 20) / (70 - 20)) * 100);        // <20%=0, ≥70%=100
  const slope = clamp((now - ago) * 4, -30, 30);              // đang mở rộng?
  return Math.round(clamp(base + slope));
}

/**
 * #2 RS ngành vs VNINDEX (18%) — outperform index 3 tháng.
 * @param {{sectorReturn3m:number, indexReturn3m:number}|null} f  (phần trăm)
 */
function rsVsIndexScore(f) {
  if (!f || typeof f.sectorReturn3m !== 'number') return 50;
  const idx = (typeof f.indexReturn3m === 'number') ? f.indexReturn3m : 0;
  const out = f.sectorReturn3m - idx;                         // outperformance %
  return Math.round(clamp(50 + out * 25));
}

/**
 * #3 Smart-money flow 20D (15%) — (Org+Prop+Foreign) net / totalValue.
 * Thế mạnh ngành mà CP-level không có. netPct>0=gom, <0=xả.
 * @param {{netPct:number}|null} f  netPct = netFlow/totalValue×100
 */
function smartMoneyScore(f) {
  if (!f || typeof f.netPct !== 'number') return 50;
  return Math.round(clamp(50 + f.netPct * 8));
}

/**
 * #4 Momentum breadth (12%) — %CP ngành có MACD histogram > 0.
 * @param {{pctMACDpos:number}|null} f
 */
function momentumBreadthScore(f) {
  if (!f || typeof f.pctMACDpos !== 'number') return 50;
  return Math.round(clamp(f.pctMACDpos));
}

/**
 * #5 Breadth expansion (10%) — sức mạnh lan rộng (MA20 breadth delta 10 phiên).
 * @param {{pctMA20Now:number, pctMA20_10dAgo:number}|null} f
 */
function breadthExpansionScore(f) {
  if (!f || typeof f.pctMA20Now !== 'number') return 50;
  const ago = (typeof f.pctMA20_10dAgo === 'number') ? f.pctMA20_10dAgo : f.pctMA20Now;
  const delta = f.pctMA20Now - ago;
  return Math.round(clamp(50 + delta * 5));
}

/**
 * #6 lucCau hiện tại (8%) — lực cầu phiên (đã có sẵn, value-weighted).
 * <40%=yếu(0), ≥60%=mạnh(100), linear giữa.
 * @param {number|null} lucCau
 */
function lucCauScore(lucCau) {
  if (typeof lucCau !== 'number' || isNaN(lucCau)) return 50;
  return Math.round(clamp(((lucCau - 40) / (60 - 40)) * 100));
}

/**
 * #7 MA alignment breadth (6%) — cấu trúc MA xếp chồng khỏe ở cấp ngành.
 * stack bullish (pctMA10>pctMA20>pctMA50) → 100; partial → 60; break → 30.
 * @param {{pctMA10:number, pctMA20:number, pctMA50:number}|null} f
 */
function maAlignmentScore(f) {
  if (!f || typeof f.pctMA10 !== 'number') return 50;
  const { pctMA10, pctMA20, pctMA50 } = f;
  if (pctMA10 > pctMA20 && pctMA20 > pctMA50) return 100;
  if (pctMA10 > pctMA20) return 60;
  return 30;
}

/**
 * #8 Valuation (5%) — P/E + P/B trung bình ngành (cap-weight khi assemble).
 * P/E: 10=đẹp(100), 30=đắt(0). P/B: 1=đẹp(100), 3=đắt(0). Trung bình 2 chỉ số.
 * @param {{peAvg:number, pbAvg:number}|null} f
 */
function valuationScore(f) {
  if (!f || typeof f.peAvg !== 'number') return 50;
  const peScore = clamp(((30 - f.peAvg) / (30 - 10)) * 100);
  const pbScore = clamp(((3 - (f.pbAvg || 0)) / (3 - 1)) * 100);
  return Math.round((peScore + pbScore) / 2);
}

/**
 * #9 Liquidity (4%) — rank thanh khoản tương đối giữa các ngành.
 * rank 1 (top) → 100; rank cuối → 0. Percentile rank.
 * @param {{rank:number, totalSectors:number}|null} f
 */
function liquidityScore(f) {
  if (!f || typeof f.rank !== 'number' || !f.totalSectors) return 50;
  const { rank, totalSectors } = f;
  if (totalSectors <= 1) return 50;
  return Math.round(clamp(((totalSectors - rank) / (totalSectors - 1)) * 100));
}

// ═══════════════════════════════════════════════════════════════════════
// COMPOSITE
// ═══════════════════════════════════════════════════════════════════════

function gradeFor(score) {
  if (score >= 85) return 'A+';
  if (score >= 70) return 'A';
  if (score >= 55) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

/**
 * Sector composite score 0-100 từ 9 yếu tố.
 * @param {object} factors — { breadthTrend, rsVsIndex, smartMoney, momentumBreadth,
 *                             breadthExpansion, lucCau, maAlignment, valuation, liquidity }
 *   Mỗi sub-object là input của sub-score tương ứng (xem từng hàm).
 * @returns {{score:number, grade:string, breakdown:object, flags?:string[]}}
 */
function computeSectorScore(factors) {
  factors = factors || {};
  const breakdown = {
    breadthTrend: breadthTrendScore(factors.breadthTrend),
    rsVsIndex: rsVsIndexScore(factors.rsVsIndex),
    smartMoney: smartMoneyScore(factors.smartMoney),
    momentumBreadth: momentumBreadthScore(factors.momentumBreadth),
    breadthExpansion: breadthExpansionScore(factors.breadthExpansion),
    lucCau: lucCauScore(factors.lucCau),
    maAlignment: maAlignmentScore(factors.maAlignment),
    valuation: valuationScore(factors.valuation),
    liquidity: liquidityScore(factors.liquidity)
  };

  // Renormalize trọng số: nếu thiếu fundamentals (valuation=null → sub 50 neutral),
  // vẫn giữ weight (neutral 50 ≈ điểm trung bình, không thiên vị). KHÔNG renormalize
  // trừ khi yếu tố đó hoàn toàn không áp dụng — hiện tất cả đều có fallback neutral.
  const score =
    breakdown.breadthTrend * WEIGHTS.breadthTrend +
    breakdown.rsVsIndex * WEIGHTS.rsVsIndex +
    breakdown.smartMoney * WEIGHTS.smartMoney +
    breakdown.momentumBreadth * WEIGHTS.momentumBreadth +
    breakdown.breadthExpansion * WEIGHTS.breadthExpansion +
    breakdown.lucCau * WEIGHTS.lucCau +
    breakdown.maAlignment * WEIGHTS.maAlignment +
    breakdown.valuation * WEIGHTS.valuation +
    breakdown.liquidity * WEIGHTS.liquidity;

  let composite = Math.round(clamp(score));
  const flags = [];

  // HARD FILTER (Spec §4 #8): P/E ngành > 40 → bong bóng nghi ngờ → phạt nặng.
  if (factors.valuation && typeof factors.valuation.peAvg === 'number' && factors.valuation.peAvg > 40) {
    composite = Math.max(0, composite - 20);
    flags.push('PE_OVER_40');
  }

  return {
    score: clamp(composite),
    grade: gradeFor(composite),
    breakdown,
    ...(flags.length ? { flags } : {})
  };
}

module.exports = {
  computeSectorScore,
  gradeFor,
  WEIGHTS,
  breadthTrendScore,
  rsVsIndexScore,
  smartMoneyScore,
  momentumBreadthScore,
  breadthExpansionScore,
  lucCauScore,
  maAlignmentScore,
  valuationScore,
  liquidityScore
};
