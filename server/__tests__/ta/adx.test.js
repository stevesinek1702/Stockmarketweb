import { describe, it, expect } from 'vitest';
import { adx, trendStrength } from '../../ta/adx.js';

// Helper: OHLC xu hướng tăng đều
function uptrend(n, start = 100, step = 1) {
  const ohlc = [];
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    ohlc.push({ o: c - step, h: c + 1, l: c - step - 1, c });
  }
  return ohlc;
}
function sideways(n, base = 100) {
  const ohlc = [];
  for (let i = 0; i < n; i++) {
    const c = base + (i % 2 === 0 ? 0.5 : -0.5);
    ohlc.push({ o: base, h: c + 0.5, l: c - 0.5, c });
  }
  return ohlc;
}

describe('adx', () => {
  it('ADX cao cho xu hướng mạnh', () => {
    const ohlc = uptrend(50);
    const r = adx(ohlc, 14);
    expect(r.adx).toBeGreaterThan(25);
  });
  it('ADX thấp cho sideway', () => {
    const ohlc = sideways(50);
    const r = adx(ohlc, 14);
    expect(r.adx).toBeLessThan(25);
  });
  it('trendStrength maps adx đúng', () => {
    expect(trendStrength(30)).toBe('strong');
    expect(trendStrength(22)).toBe('weak');
    expect(trendStrength(15)).toBe('ranging');
  });
  it('chuỗi quá ngắn → adx null', () => {
    expect(adx(uptrend(10), 14).adx).toBeNull();
  });
});
