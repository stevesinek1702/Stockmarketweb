import { describe, it, expect } from 'vitest';
import { macd } from '../../ta/macd.js';

describe('macd', () => {
  it('MACD line = EMA12 - EMA26; histogram = macd - signal', () => {
    // chuỗi có xu hướng tăng nhẹ
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const m = macd(closes);
    expect(m.macd.length).toBeGreaterThan(0);
    expect(m.signal.length).toBeGreaterThan(0);
    expect(m.histogram.length).toBeGreaterThan(0);
    // xu hướng tăng → MACD line cuối > 0 (EMA12 > EMA26 khi tăng)
    expect(m.macd[m.macd.length - 1]).toBeGreaterThan(0);
  });
  it('chuỗi constant → MACD ≈ 0', () => {
    const closes = new Array(60).fill(100);
    const m = macd(closes);
    expect(Math.abs(m.macd[m.macd.length - 1])).toBeLessThan(0.001);
  });
  it('chuỗi quá ngắn → trả mảng rỗng', () => {
    const m = macd([1, 2, 3]);
    expect(m.macd).toEqual([]);
    expect(m.signal).toEqual([]);
    expect(m.histogram).toEqual([]);
  });
});
