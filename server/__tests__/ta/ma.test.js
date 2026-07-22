import { describe, it, expect } from 'vitest';
import { sma, ema } from '../../ta/ma.js';

describe('sma', () => {
  it('computes SMA of given period', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([
      null, null,
      2,          // (1+2+3)/3
      3,          // (2+3+4)/3
      4,          // (3+4+5)/3
    ]);
  });
  it('returns all-null when values shorter than period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe('ema', () => {
  it('EMA of constant series equals the constant', () => {
    const vals = [10, 10, 10, 10, 10];
    const e = ema(vals, 3);
    expect(e[e.length - 1]).toBeCloseTo(10, 5);
  });
  it('EMA responds to latest value more (weight > older)', () => {
    const e = ema([10, 10, 10, 10, 20], 3);
    expect(e[e.length - 1]).toBeGreaterThan(10);
    expect(e[e.length - 1]).toBeLessThan(20);
  });
});
