import { describe, it, expect } from 'vitest';
import { pickFromCandidates, classifySector, effectiveScore, valuationFlag } from '../../scoring/picker.js';

// ── Test data ──────────────────────────────────────────────────────────
// SEPA candidates (giống output screenAll: {symbol, score, grade, price, ...})
const candidates = [
  { symbol: 'VCB', score: 88, grade: 'A+', price: 95000 },   // Ngân hàng mạnh
  { symbol: 'TCB', score: 76, grade: 'A',  price: 28000 },   // Ngân hàng mạnh
  { symbol: 'VHM', score: 72, grade: 'A',  price: 42000 },   // BĐS mạnh
  { symbol: 'XYZ', score: 65, grade: 'B',  price: 15000 },   // Thép yếu
  { symbol: 'ABC', score: 80, grade: 'A',  price: 30000 }    // Thép yếu nhưng SEPA cao
];

// Map symbol → ICB2 sector
const symbolSector = {
  VCB: '8300', TCB: '8300', VHM: '8600', XYZ: '1700', ABC: '1700'
};

// Sector scores (đã compute)
const sectorScores = {
  '8300': { score: 82, grade: 'A+' },  // Ngân hàng mạnh
  '8600': { score: 74, grade: 'A' },   // BĐS mạnh
  '1700': { score: 32, grade: 'D' }    // Thép yếu
};

// Sector median P/E (để flag CP đắt trong ngành)
const sectorPeMedian = { '8300': 14, '8600': 18, '1700': 12 };

// Per-stock P/E
const stockPe = { VCB: 13, TCB: 7, VHM: 16, XYZ: 11, ABC: 38 }; // ABC P/E 38 = đắt trong thép (median 12)

// ═══════════════════════════════════════════════════════════════════════

describe('classifySector', () => {
  it('score≥70 → STRONG', () => {
    expect(classifySector(82)).toBe('STRONG');
  });
  it('score 55-69 → NEUTRAL', () => {
    expect(classifySector(60)).toBe('NEUTRAL');
  });
  it('score<40 → WEAK', () => {
    expect(classifySector(32)).toBe('WEAK');
  });
  it('score 40-54 → NEUTRAL (trong khoảng giữa)', () => {
    expect(classifySector(45)).toBe('NEUTRAL');
  });
});

describe('effectiveScore', () => {
  it('CP ngành A+ được boost nhẹ', () => {
    // SEPA 80, sector 82 → 80 × (0.82)^0.6 = 80 × 0.888 = 71
    const eff = effectiveScore(80, 82);
    expect(eff).toBeGreaterThan(70);
    expect(eff).toBeLessThan(80); // boost nhẹ, không vượt SEPA
  });
  it('CP ngành yếu bị phạt', () => {
    // SEPA 80, sector 32 → 80 × (0.32)^0.6 = 80 × 0.492 = 39
    const eff = effectiveScore(80, 32);
    expect(eff).toBeLessThan(50);
  });
  it('sector null → giữ nguyên SEPA', () => {
    expect(effectiveScore(75, null)).toBe(75);
  });
});

describe('valuationFlag', () => {
  it('P/E > 2× median ngành → flag "đắt"', () => {
    expect(valuationFlag(38, 12)).toBe('EXPENSIVE'); // 38 > 24
  });
  it('P/E hợp lý → null', () => {
    expect(valuationFlag(13, 14)).toBeNull();
  });
  it('thiếu median → null (không flag)', () => {
    expect(valuationFlag(50, null)).toBeNull();
  });
});

describe('pickFromCandidates', () => {
  it('loại CP thuộc ngành yếu (WEAK)', () => {
    const r = pickFromCandidates(candidates, { symbolSector, sectorScores, sectorPeMedian, stockPe });
    // ABC & XYZ thuộc thép (1700, score 32 = WEAK) → bị loại dù SEPA cao
    expect(r.find(c => c.symbol === 'ABC')).toBeUndefined();
    expect(r.find(c => c.symbol === 'XYZ')).toBeUndefined();
  });

  it('giữ CP thuộc ngành mạnh (STRONG/NEUTRAL)', () => {
    const r = pickFromCandidates(candidates, { symbolSector, sectorScores, sectorPeMedian, stockPe });
    expect(r.find(c => c.symbol === 'VCB')).toBeDefined();
    expect(r.find(c => c.symbol === 'VHM')).toBeDefined();
  });

  it('rank theo effectiveScore desc', () => {
    const r = pickFromCandidates(candidates, { symbolSector, sectorScores, sectorPeMedian, stockPe });
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].effectiveScore).toBeGreaterThanOrEqual(r[i].effectiveScore);
    }
  });

  it('flag CP đắt trong ngành (P/E > 2× median)', () => {
    // ABC bị loại vì ngành yếu, nên test riêng: CP đắt trong ngành mạnh
    const cand2 = [
      { symbol: 'EXP', score: 78, grade: 'A', price: 30000 },  // Ngân hàng, P/E 35 (median 14)
      { symbol: 'OK',  score: 78, grade: 'A', price: 30000 }   // Ngân hàng, P/E 13
    ];
    const symSec = { EXP: '8300', OK: '8300' };
    const pe = { EXP: 35, OK: 13 };
    const r = pickFromCandidates(cand2, { symbolSector: symSec, sectorScores, sectorPeMedian, stockPe: pe });
    const exp = r.find(c => c.symbol === 'EXP');
    expect(exp.flags).toContain('EXPENSIVE');
  });

  it('respect maxPicks limit', () => {
    const r = pickFromCandidates(candidates, { symbolSector, sectorScores, sectorPeMedian, stockPe, maxPicks: 2 });
    expect(r.length).toBe(2);
  });

  it('mỗi candidate có effectiveScore, sector, sectorScore, sectorClass', () => {
    const r = pickFromCandidates(candidates, { symbolSector, sectorScores, sectorPeMedian, stockPe });
    r.forEach(c => {
      expect(c).toHaveProperty('effectiveScore');
      expect(c).toHaveProperty('sector');
      expect(c).toHaveProperty('sectorScore');
      expect(c).toHaveProperty('sectorClass');
    });
  });

  it('diversify: không quá maxPerSector CP/ngành', () => {
    // VCB + TCB cùng ngành 8300. maxPerSector=1 → chỉ giữ 1.
    const r = pickFromCandidates(candidates, { symbolSector, sectorScores, sectorPeMedian, stockPe, maxPerSector: 1 });
    const bankCount = r.filter(c => c.sector === '8300').length;
    expect(bankCount).toBeLessThanOrEqual(1);
  });

  it('thiếu fundamentals (stockPe rỗng) → không crash, không flag', () => {
    const r = pickFromCandidates(candidates, { symbolSector, sectorScores, sectorPeMedian: {}, stockPe: {} });
    expect(r.length).toBeGreaterThan(0);
    r.forEach(c => { expect(c.flags || []).not.toContain('EXPENSIVE'); });
  });
});
