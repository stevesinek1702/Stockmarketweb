import { describe, it, expect } from 'vitest';
import { rsi } from '../../ta/rsi.js';

describe('rsi (Wilder)', () => {
  it('RSI = 100 cho chuỗi chỉ tăng', () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
    const r = rsi(closes, 14);
    expect(r[r.length - 1]).toBeCloseTo(100, 1);
  });
  it('RSI = 0 cho chuỗi chỉ giảm', () => {
    const closes = [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10];
    const r = rsi(closes, 14);
    expect(r[r.length - 1]).toBeCloseTo(0, 1);
  });
  it('trả mảng rỗng khi closes <= period', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([]);
  });
});
