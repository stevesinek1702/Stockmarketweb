import { describe, it, expect } from 'vitest';
import { atr } from '../../ta/atr.js';

describe('atr', () => {
  it('ATR của nến range cố định = range đó', () => {
    // mỗi nến high-low = 2, không gap → TR = 2 → ATR = 2
    const ohlc = Array.from({ length: 20 }, () => ({ o: 100, h: 101, l: 99, c: 100 }));
    const a = atr(ohlc, 14);
    expect(a.atr).toBeCloseTo(2, 5);
    expect(a.atrPct).toBeCloseTo(2, 5); // 2/100*100
  });
  it('chuỗi quá ngắn → null', () => {
    expect(atr([{ o: 1, h: 2, l: 0, c: 1 }], 14).atr).toBeNull();
  });
});
