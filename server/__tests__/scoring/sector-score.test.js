import { describe, it, expect } from 'vitest';
import {
  computeSectorScore,
  gradeFor,
  breadthTrendScore,
  rsVsIndexScore,
  smartMoneyScore,
  momentumBreadthScore,
  breadthExpansionScore,
  lucCauScore,
  maAlignmentScore,
  valuationScore,
  liquidityScore,
  WEIGHTS
} from '../../scoring/sector-score.js';

// ═══════════════════════════════════════════════════════════════════════
// 9 SUB-SCORE FACTORS (mỗi cái → 0-100)
// ═══════════════════════════════════════════════════════════════════════

describe('breadthTrendScore — #1 (22%)', () => {
  it('breadth cao + mở rộng → cao', () => {
    // pctMA50=70 → base 100; slope 0 → 100
    expect(breadthTrendScore({ pctMA50Now: 70, pctMA50_20dAgo: 70 })).toBe(100);
  });
  it('breadth thấp → thấp', () => {
    // pctMA50=20 → base 0
    expect(breadthTrendScore({ pctMA50Now: 20, pctMA50_20dAgo: 20 })).toBe(0);
  });
  it('breadth đang mở rộng → boost slope', () => {
    // pctMA50=50 → base (50-20)/50*100=60; slope (50-35)*4=+60→cap 30 → 90
    expect(breadthTrendScore({ pctMA50Now: 50, pctMA50_20dAgo: 35 })).toBe(90);
  });
  it('breadth đang thu hẹp → phạt (cảnh báo đỉnh)', () => {
    // base 60; slope (50-65)*4=-60→floor -30 → 30
    expect(breadthTrendScore({ pctMA50Now: 50, pctMA50_20dAgo: 65 })).toBe(30);
  });
  it('thiếu dữ liệu (null) → neutral 50', () => {
    expect(breadthTrendScore(null)).toBe(50);
  });
});

describe('rsVsIndexScore — #2 (18%)', () => {
  it('ngành outperform VNINDEX 20% → cao', () => {
    // out=20 → 50+20*25=550 → cap 100
    expect(rsVsIndexScore({ sectorReturn3m: 30, indexReturn3m: 10 })).toBe(100);
  });
  it('ngành underperform → thấp', () => {
    // out=-20 → 50-500 → floor 0
    expect(rsVsIndexScore({ sectorReturn3m: -10, indexReturn3m: 10 })).toBe(0);
  });
  it('ngành bằng index → neutral 50', () => {
    expect(rsVsIndexScore({ sectorReturn3m: 10, indexReturn3m: 10 })).toBe(50);
  });
});

describe('smartMoneyScore — #3 (15%)', () => {
  it('smart money gom (netPct>0) → trên 50', () => {
    // netPct=2 → 50+16=66
    expect(smartMoneyScore({ netPct: 2 })).toBe(66);
  });
  it('smart money xả (netPct<0) → dưới 50', () => {
    expect(smartMoneyScore({ netPct: -2 })).toBe(34);
  });
  it('thiếu flow → neutral 50', () => {
    expect(smartMoneyScore(null)).toBe(50);
  });
});

describe('momentumBreadthScore — #4 (12%)', () => {
  it('100% CP MACD>0 → 100', () => {
    expect(momentumBreadthScore({ pctMACDpos: 100 })).toBe(100);
  });
  it('0% CP MACD>0 → 0', () => {
    expect(momentumBreadthScore({ pctMACDpos: 0 })).toBe(0);
  });
  it('thiếu → neutral 50', () => {
    expect(momentumBreadthScore(null)).toBe(50);
  });
});

describe('breadthExpansionScore — #5 (10%)', () => {
  it('breadth mở rộng (MA20 tăng) → trên 50', () => {
    // delta=10 → 50+50=100
    expect(breadthExpansionScore({ pctMA20Now: 70, pctMA20_10dAgo: 60 })).toBe(100);
  });
  it('breadth thu hẹp → dưới 50', () => {
    // delta=-10 → 50-50=0
    expect(breadthExpansionScore({ pctMA20Now: 60, pctMA20_10dAgo: 70 })).toBe(0);
  });
});

describe('lucCauScore — #6 (8%)', () => {
  it('lucCau 60 → 100', () => {
    expect(lucCauScore(60)).toBe(100);
  });
  it('lucCau 40 → 0', () => {
    expect(lucCauScore(40)).toBe(0);
  });
  it('lucCau null (thiếu) → neutral 50', () => {
    expect(lucCauScore(null)).toBe(50);
  });
});

describe('maAlignmentScore — #7 (6%)', () => {
  it('stack bullish (pctMA10>pctMA20>pctMA50) → 100', () => {
    expect(maAlignmentScore({ pctMA10: 80, pctMA20: 70, pctMA50: 60 })).toBe(100);
  });
  it('pctMA10>pctMA20 nhưng break → 60', () => {
    expect(maAlignmentScore({ pctMA10: 80, pctMA20: 70, pctMA50: 90 })).toBe(60);
  });
  it('break hoàn toàn → 30', () => {
    expect(maAlignmentScore({ pctMA10: 50, pctMA20: 70, pctMA50: 90 })).toBe(30);
  });
});

describe('valuationScore — #8 (5%)', () => {
  it('P/E thấp, P/B thấp → cao', () => {
    // peScore: (30-10)/(30-10)*100=100; pbScore: (3-1)/(3-1)*100=100 → 100
    expect(valuationScore({ peAvg: 10, pbAvg: 1 })).toBe(100);
  });
  it('P/E cao, P/B cao → thấp', () => {
    // peScore 0; pbScore 0
    expect(valuationScore({ peAvg: 30, pbAvg: 3 })).toBe(0);
  });
  it('thiếu fundamentals → neutral 50', () => {
    expect(valuationScore(null)).toBe(50);
  });
});

describe('liquidityScore — #9 (4%)', () => {
  it('rank cao (top) → 100', () => {
    // rank 1/20 → percentile (20-1)/19*100=100
    expect(liquidityScore({ rank: 1, totalSectors: 20 })).toBe(100);
  });
  it('rank thấp (bottom) → 0', () => {
    expect(liquidityScore({ rank: 20, totalSectors: 20 })).toBe(0);
  });
  it('thiếu → neutral 50', () => {
    expect(liquidityScore(null)).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// COMPOSITE
// ═══════════════════════════════════════════════════════════════════════

describe('computeSectorScore — composite', () => {
  const strongSector = {
    breadthTrend: { pctMA50Now: 70, pctMA50_20dAgo: 75 },        // ~85
    rsVsIndex: { sectorReturn3m: 25, indexReturn3m: 5 },          // 100
    smartMoney: { netPct: 3 },                                     // 74
    momentumBreadth: { pctMACDpos: 80 },                          // 80
    breadthExpansion: { pctMA20Now: 75, pctMA20_10dAgo: 70 },     // 75
    lucCau: 58,                                                    // 90
    maAlignment: { pctMA10: 85, pctMA20: 75, pctMA50: 65 },       // 100
    valuation: { peAvg: 12, pbAvg: 1.5 },                          // high
    liquidity: { rank: 2, totalSectors: 20 }                       // ~95
  };
  const weakSector = {
    breadthTrend: { pctMA50Now: 25, pctMA50_20dAgo: 35 },         // low
    rsVsIndex: { sectorReturn3m: -5, indexReturn3m: 10 },          // 0
    smartMoney: { netPct: -3 },                                    // 26
    momentumBreadth: { pctMACDpos: 20 },                          // 20
    breadthExpansion: { pctMA20Now: 30, pctMA20_10dAgo: 50 },     // low
    lucCau: 42,                                                    // 10
    maAlignment: { pctMA10: 40, pctMA20: 60, pctMA50: 80 },       // 30
    valuation: { peAvg: 28, pbAvg: 2.8 },                          // low
    liquidity: { rank: 18, totalSectors: 20 }                      // ~10
  };

  it('ngành mạnh → điểm cao, grade A/A+', () => {
    const r = computeSectorScore(strongSector);
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(['A', 'A+']).toContain(r.grade);
    expect(r.breakdown).toHaveProperty('breadthTrend');
    expect(r.breakdown).toHaveProperty('rsVsIndex');
    expect(r.breakdown).toHaveProperty('smartMoney');
  });
  it('ngành yếu → điểm thấp, grade C/D', () => {
    const r = computeSectorScore(weakSector);
    expect(r.score).toBeLessThan(50);
    expect(['C', 'D']).toContain(r.grade);
  });
  it('score ∈ [0,100]', () => {
    const r1 = computeSectorScore(strongSector);
    const r2 = computeSectorScore(weakSector);
    expect(r1.score).toBeLessThanOrEqual(100);
    expect(r2.score).toBeGreaterThanOrEqual(0);
  });
  it('gradeFor maps đúng ngưỡng', () => {
    expect(gradeFor(90)).toBe('A+');
    expect(gradeFor(75)).toBe('A');
    expect(gradeFor(60)).toBe('B');
    expect(gradeFor(45)).toBe('C');
    expect(gradeFor(20)).toBe('D');
  });
  it('HARD FILTER: P/E ngành > 40 → phạt nặng composite', () => {
    const bubble = { ...strongSector, valuation: { peAvg: 50, pbAvg: 2 } };
    const normal = { ...strongSector, valuation: { peAvg: 15, pbAvg: 2 } };
    expect(computeSectorScore(bubble).score).toBeLessThan(computeSectorScore(normal).score);
  });
  it('thiếu fundamentals: valuation neutral, không crash, weights renormalize', () => {
    const noFund = { ...strongSector, valuation: null };
    const r = computeSectorScore(noFund);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('WEIGHTS — tổng 100%', () => {
  it('tổng trọng số = 1', () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 2);
  });
});
