import { describe, it, expect } from 'vitest';
import { positionSize } from '../../signals/risk.js';

describe('positionSize', () => {
  it('risk 1% vốn, entry 100, stop 95 → shares đúng', () => {
    // 10M vốn, risk 1% = 100k, risk/share = 5 → 20k shares, nhưng cap 25%=2.5M → 25k shares@100=2.5M
    // floor 25k/100*100 = 25000
    const r = positionSize(10_000_000, 100, 95);
    expect(r.shares).toBeGreaterThan(0);
    expect(r.shares % 100).toBe(0); // lô chẵn 100
    expect(r.positionValue).toBeLessThanOrEqual(10_000_000 * 0.25 + 100); // cap 25% + lô round
  });
  it('risk amount đúng theo riskPct', () => {
    const r = positionSize(10_000_000, 100, 95);
    // shares × (100-95) = risk amount ≈ 1% vốn = 100k (trước cap)
    expect(r.riskAmount).toBeGreaterThan(0);
  });
  it('entry <= stop → 0 shares', () => {
    expect(positionSize(10_000_000, 100, 100).shares).toBe(0);
    expect(positionSize(10_000_000, 100, 105).shares).toBe(0);
  });
  it('lô chẵn 100 (luật VN HOSE)', () => {
    const r = positionSize(50_000_000, 30, 28);
    expect(r.shares % 100).toBe(0);
  });
});
