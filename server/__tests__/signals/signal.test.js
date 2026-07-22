import { describe, it, expect } from 'vitest';
import { generateSignal } from '../../signals/signal.js';

const taGood = {
  volatility: { atr: 2.5, atrPct: 5 },
  mas: { ma50: 48 },
  sepa: {
    trendTemplate: { pass: true, rules: [true,true,true,true,true,true,true,true] },
    vcp: { isVCP: true, tightness: 5 },
    pocketPivot: { detected: false, volumeRatio: 1.2 }
  }
};
const scoreA = { score: 78, grade: 'A', breakdown: {} };
const scoreB = { score: 60, grade: 'B', breakdown: {} };
const scoreD = { score: 30, grade: 'D', breakdown: {} };

describe('generateSignal', () => {
  it('BUY khi score A + TT pass + VCP', () => {
    const s = generateSignal(scoreA, taGood, 50);
    expect(s.action).toBe('BUY');
    expect(s.entry).toBe(50);
    expect(s.stop).toBeLessThan(50); // entry - 2*ATR
    expect(s.target1).toBeGreaterThan(50);
    expect(s.rr).toBe(2);
  });
  it('WATCH khi score B', () => {
    const s = generateSignal(scoreB, taGood, 50);
    expect(s.action).toBe('WATCH');
  });
  it('NONE khi score D', () => {
    const s = generateSignal(scoreD, taGood, 50);
    expect(s.action).toBe('NONE');
  });
  it('HOLD khi đang giữ + score OK + giá > MA50', () => {
    const s = generateSignal(scoreA, taGood, 50, { entry: 48 });
    expect(s.action).toBe('HOLD');
  });
  it('SELL_SL khi giá chạm stop', () => {
    // entry 48, ATR 2.5 → stop = 48-5 = 43; giá 42 < stop
    const s = generateSignal(scoreA, taGood, 42, { entry: 48 });
    expect(s.action).toBe('SELL_SL');
  });
  it('EXIT khi score < 40 (đang giữ)', () => {
    const s = generateSignal(scoreD, taGood, 49, { entry: 48 });
    expect(s.action).toBe('EXIT');
  });
});
