import { describe, it, expect } from 'vitest';
import { rsRating } from '../../scoring/rs.js';

describe('rsRating', () => {
  it('mã outperform VNINDEX → RS > 50', () => {
    const stock = Array.from({ length: 60 }, (_, i) => 100 + i * 0.2);
    const bench = Array.from({ length: 60 }, (_, i) => 100 + i * 0.04);
    expect(rsRating(stock, bench)).toBeGreaterThan(60);
  });
  it('mã underperform → RS < 50', () => {
    const stock = Array.from({ length: 60 }, (_, i) => 100 - i * 0.1);
    const bench = Array.from({ length: 60 }, (_, i) => 100 + i * 0.1);
    expect(rsRating(stock, bench)).toBeLessThan(40);
  });
  it('thiếu benchmark → fallback (không crash)', () => {
    const stock = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const r = rsRating(stock, null);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(100);
  });
});
