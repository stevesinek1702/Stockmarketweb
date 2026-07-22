import { describe, it, expect } from 'vitest';
import { forwardReturn, isWin } from '../../backtest/label.js';

describe('forwardReturn (T+2.5 aware)', () => {
  // closes: entry=100 (idx 5), dip to 95 (idx 8), exit 110 (idx 15 = 5+3+7)
  const closes = [90, 92, 95, 98, 99, 100, 101, 99, 95, 96, 98, 100, 103, 106, 108, 110];

  it('return = (exit-entry)/entry*100', () => {
    const r = forwardReturn(closes, 5, 7); // entry idx5=100, exit idx15=110
    expect(r.returnPct).toBeCloseTo(10, 1);
  });
  it('maxDrawdown đo từ entry đến exit', () => {
    const r = forwardReturn(closes, 5, 7); // dip 100→95 = -5%
    expect(r.maxDrawdown).toBeCloseTo(5, 1);
  });
  it('maxGain đo peak từ entry', () => {
    const r = forwardReturn(closes, 5, 7); // peak 110 = +10%
    expect(r.maxGain).toBeCloseTo(10, 1);
  });
  it('exitIdx skip T+1,T+2 (settlement) — exit = entry+3+holdDays', () => {
    // entry idx5, holdDays 7 → exit idx 5+3+7=15
    const r = forwardReturn(closes, 5, 7);
    expect(r.exitIdx).toBe(15);
  });
  it('return null nếu không đủ data cho holdDays', () => {
    expect(forwardReturn(closes, 14, 7)).toBeNull();
  });
  it('isWin: return >= threshold', () => {
    expect(isWin({ returnPct: 6 }, 5)).toBe(true);
    expect(isWin({ returnPct: 3 }, 5)).toBe(false);
  });
});
