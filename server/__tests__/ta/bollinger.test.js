import { describe, it, expect } from 'vitest';
import { bollinger, bandwidth } from '../../ta/bollinger.js';

describe('bollinger', () => {
  it('middle = SMA20, upper/lower = ±2σ', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
    const b = bollinger(closes, 20, 2);
    expect(b.upper).toBeGreaterThan(b.middle);
    expect(b.lower).toBeLessThan(b.middle);
  });
  it('bandwidth của chuỗi constant = 0', () => {
    expect(bandwidth(100, 100, 100)).toBe(0);
  });
  it('squeeze = true khi bandwidth ở 20th percentile history', () => {
    // tạo 120 ngày: đầu biến động lớn, 20 ngày cuối rất hẹp
    const closes = [
      ...Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i) * 10),
      ...Array.from({ length: 20 }, () => 100 + (Math.random() - 0.5) * 0.2),
    ];
    const b = bollinger(closes, 20, 2);
    expect(b.squeeze).toBe(true);
  });
  it('chuỗi quá ngắn → null', () => {
    expect(bollinger([1, 2, 3], 20, 2).middle).toBeNull();
  });
});
