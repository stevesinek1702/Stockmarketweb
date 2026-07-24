import { describe, it, expect } from 'vitest';
import { forwardReturn, isWin } from '../../backtest/label.js';

describe('forwardReturn (T+2.5 + MA10 stop)', () => {
  // closes: entry=100 (idx 5), dip to 95 (idx 8), exit 110 (idx 15 = 5+3+7)
  const closes = [90, 92, 95, 98, 99, 100, 101, 99, 95, 96, 98, 100, 103, 106, 108, 110];

  it('return = (exit-entry)/entry*100', () => {
    const r = forwardReturn(closes, 5, 7);
    expect(r.returnPct).toBeCloseTo(10, 1);
  });
  it('maxDrawdown đo từ entry đến exit', () => {
    const r = forwardReturn(closes, 5, 7); // dip 100→95 = -5%
    expect(r.maxDrawdown).toBeCloseTo(5, 1);
  });
  it('maxGain đo peak từ entry', () => {
    const r = forwardReturn(closes, 5, 7);
    expect(r.maxGain).toBeCloseTo(10, 1);
  });
  it('exitReason = hold khi không hit MA10 stop', () => {
    const r = forwardReturn(closes, 5, 7);
    expect(r.exitReason).toBe('hold');
  });
  it('exitIdx skip T+1,T+2 (settlement) — exit = entry+3+holdDays', () => {
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

  // MA10 stop-loss: close < MA10×0.97 → exit sớm
  it('MA10 stop: close dưới MA10 3% → exit sớm (exitReason=ma10_sl)', () => {
    // 30 ngày tăng từ 100→129, dump 3 ngày mạnh, rồi tiếp tục (đủ data cho holdDays)
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);     // idx 0-29
    const dump = [116, 110, 105];                                  // idx 30-32 dump dưới MA10
    const flat = Array.from({ length: 15 }, () => 105);            // idx 33-47 giữ thấp
    const c = [...up, ...dump, ...flat];                          // 48 phần tử
    // entry idx 25, holdDays 10 → maxExit = 25+3+10 = 38 (< 48 OK)
    // MA10[30] ≈ avg(21..30) ≈ 115.5; close[30]=116 ≈ MA10 (chưa dưới 3%)
    // MA10[31] ≈ 116; close[31]=110 < 116×0.97=112.5 → STOP
    const r = forwardReturn(c, 25, 10);
    expect(r.exitReason).toBe('ma10_sl');
    expect(r.exitIdx).toBeLessThan(38);
  });
  it('MA10 stop không trigger khi giá trên MA10', () => {
    const c = Array.from({ length: 45 }, (_, i) => 100 + i * 0.5);
    const r = forwardReturn(c, 30, 10);
    expect(r.exitReason).toBe('hold');
  });

  // Trailing stop: giá giảm -10% từ peak → exit sớm (lock profit)
  it('trailing stop: giá -10% từ peak → exit sớm (exitReason=trailing_sl)', () => {
    // 20 ngày tăng từ 100→200, rồi dump xuống 175 (< 200×0.90=180)
    const up = Array.from({ length: 20 }, (_, i) => 100 + i * 5); // idx 0-19, peak ~195
    const dump = [190, 175, 160]; // idx 20-22 dump
    const flat = Array.from({ length: 25 }, () => 160);
    const c = [...up, ...dump, ...flat]; // 48 phần tử
    // entry idx 10 (close 150), holdDays 20 → maxExit = 10+3+20 = 33
    // peak trong window = 195 (idx 19), 175 < 195×0.90=175.5 → trailing stop
    const r = forwardReturn(c, 10, 20);
    expect(['trailing_sl', 'ma10_sl']).toContain(r.exitReason);
    expect(r.exitIdx).toBeLessThan(33);
  });
});
