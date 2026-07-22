import { describe, it, expect } from 'vitest';
import { computeSEPA, gradeFor } from '../../scoring/score.js';

const perfectTA = {
  mas: { ma50: 100, ma150: 99, ma200: 98, ma200Rising: true },
  momentum: { macd: { histogram: [0.5] } },
  trend: { adx: 40, diPlus: 30, diMinus: 10, trendStrength: 'strong' },
  bollinger: { squeeze: true },
  sepa: {
    trendTemplate: { pass: true, rules: [true,true,true,true,true,true,true,true] },
    vcp: { isVCP: true, tightness: 3 },
    pocketPivot: { detected: true, volumeRatio: 2.5 }
  }
};
const weakTA = {
  mas: { ma50: 90, ma150: 100, ma200: 105, ma200Rising: false },
  momentum: { macd: { histogram: [-0.5] } },
  trend: { adx: 12, diPlus: 15, diMinus: 25, trendStrength: 'ranging' },
  bollinger: { squeeze: false },
  sepa: {
    trendTemplate: { pass: false, rules: [false,false,false,false,false,false,false,true] },
    vcp: { isVCP: false, tightness: 30 },
    pocketPivot: { detected: false, volumeRatio: 0.8 }
  }
};

describe('computeSEPA', () => {
  it('perfect setup → high score (≥85, grade A+)', () => {
    const r = computeSEPA(perfectTA, { rsRating: 95 });
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.grade).toBe('A+');
    expect(r.breakdown.trendTemplate).toBe(100);
    expect(r.breakdown.adx).toBe(100);
  });
  it('weak setup → low score (<40, grade D)', () => {
    const r = computeSEPA(weakTA, { rsRating: 30 });
    expect(r.score).toBeLessThan(40);
    expect(r.grade).toBe('D');
    expect(r.breakdown.trendTemplate).toBeLessThan(30);
  });
  it('score in [0,100]', () => {
    const r1 = computeSEPA(perfectTA, { rsRating: 100 });
    const r2 = computeSEPA(weakTA, { rsRating: 0 });
    expect(r1.score).toBeLessThanOrEqual(100);
    expect(r2.score).toBeGreaterThanOrEqual(0);
  });
  it('gradeFor maps correctly', () => {
    expect(gradeFor(90)).toBe('A+');
    expect(gradeFor(75)).toBe('A');
    expect(gradeFor(60)).toBe('B');
    expect(gradeFor(45)).toBe('C');
    expect(gradeFor(20)).toBe('D');
  });
  it('RS rating weighted 15%', () => {
    const hi = computeSEPA(perfectTA, { rsRating: 100 });
    const lo = computeSEPA(perfectTA, { rsRating: 0 });
    expect(hi.score - lo.score).toBeCloseTo(15, 0);
  });
});
