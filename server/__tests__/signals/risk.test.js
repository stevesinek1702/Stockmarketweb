import { describe, it, expect } from 'vitest';
import { positionSize } from '../../signals/risk.js';

describe('positionSize', () => {
  it('risk 1% vốn, entry 100, stop 95 → shares đúng', () => {
    const r = positionSize(10_000_000, 100, 95);
    expect(r.shares).toBeGreaterThan(0);
    expect(r.shares % 100).toBe(0);
    expect(r.positionValue).toBeLessThanOrEqual(10_000_000 * 0.25 + 100);
  });
  it('risk amount đúng theo riskPct', () => {
    const r = positionSize(10_000_000, 100, 95);
    expect(r.riskAmount).toBeGreaterThan(0);
  });
  it('entry <= stop → 0 shares', () => {
    expect(positionSize(10_000_000, 100, 100).shares).toBe(0);
    expect(positionSize(10_000_000, 100, 105).shares).toBe(0);
  });
  it('lô chẵn 100', () => {
    const r = positionSize(50_000_000, 30, 28);
    expect(r.shares % 100).toBe(0);
  });

  // FIX test: không vượt cash còn đủ
  it('cash còn 200M → position không vượt 200M', () => {
    const r = positionSize(1_000_000_000, 25000, 24000, 200_000_000);
    expect(r.shares).toBeGreaterThan(0);
    expect(r.positionValue).toBeLessThanOrEqual(200_000_000);
    expect(r.cashCapped).toBe(true);
  });
  it('cash không đủ 1 lô → 0 shares', () => {
    const r = positionSize(1_000_000_000, 100000, 95000, 50_000); // 50k cash, giá 100k/CP
    expect(r.shares).toBe(0);
  });
  it('cash đủ → không cashCapped', () => {
    const r = positionSize(1_000_000_000, 25000, 24000, 1_000_000_000);
    expect(r.cashCapped).toBe(false);
  });
});
