import { describe, it, expect } from 'vitest';
import { backtestSynthetic, aggregateMetrics } from '../../backtest/engine.js';

describe('aggregateMetrics', () => {
  it('tính winRate, avgReturn đúng', () => {
    const picks = [
      { symbol: 'A', returnPct: 8, maxDrawdown: 3, score: 80, grade: 'A' },
      { symbol: 'B', returnPct: -2, maxDrawdown: 5, score: 70, grade: 'A' },
      { symbol: 'C', returnPct: 12, maxDrawdown: 2, score: 85, grade: 'A+' },
    ];
    const m = aggregateMetrics(picks, { threshold: 5 });
    expect(m.totalPicks).toBe(3);
    expect(m.winRate).toBeCloseTo(66.67, 0); // 2/3 win
    expect(m.avgReturn).toBeCloseTo(6, 0); // (8-2+12)/3
    expect(m.avgMaxDrawdown).toBeCloseTo(3.33, 0); // (3+5+2)/3
  });
  it('riskAdjusted = avgReturn / avgMaxDrawdown', () => {
    const m = aggregateMetrics([
      { returnPct: 10, maxDrawdown: 5, score: 80, grade: 'A' }
    ], {});
    expect(m.riskAdjusted).toBeCloseTo(2, 0);
  });
  it('empty picks → zeros, không crash', () => {
    const m = aggregateMetrics([], {});
    expect(m.totalPicks).toBe(0);
    expect(m.winRate).toBe(0);
  });
});

describe('backtestSynthetic', () => {
  // 1 symbol tăng đều 60 ngày, entry ở các ngày khác nhau
  it('chạy không crash, trả metrics', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const r = backtestSynthetic([['TEST', closes]], { holdDays: 5, threshold: 5 });
    expect(r.totalPicks).toBeGreaterThan(0);
    expect(typeof r.winRate).toBe('number');
    expect(typeof r.avgReturn).toBe('number');
  });
});
