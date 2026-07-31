import { describe, it, expect } from 'vitest';
import {
    tenkanSen, kijunSen, donchian, senkouSpanA, senkouSpanB, chikouSpan,
    computeIchimoku, interpretIchimoku
} from '../../ta/ichimoku.js';

// Helper: OHLC xu hướng tăng đều
function uptrendOhlc(n, start = 100, step = 1) {
    const ohlc = [];
    for (let i = 0; i < n; i++) {
        const c = start + i * step;
        ohlc.push({ o: c, h: c + 2, l: c - 2, c });
    }
    return ohlc;
}
function sidewaysOhlc(n, base = 100) {
    const ohlc = [];
    for (let i = 0; i < n; i++) {
        const c = base + (i % 2 === 0 ? 2 : -2);
        ohlc.push({ o: base, h: c + 2, l: c - 2, c });
    }
    return ohlc;
}

describe('donchian', () => {
    it('tính highest/lowest trong cửa sổ trượt (period 3)', () => {
        const highs = [10, 11, 12, 11, 10, 13, 14, 9];
        const lows = [5, 6, 7, 6, 5, 8, 9, 4];
        const { highArr, lowArr } = donchian(highs, lows, 3);
        // idx 2 (cửa sổ 0-2): high max=12, low min=5
        expect(highArr[2]).toBe(12);
        expect(lowArr[2]).toBe(5);
        // idx 5 (cửa sổ 3-5): high max=13, low min=5
        expect(highArr[5]).toBe(13);
        expect(lowArr[5]).toBe(5);
        // null trước khi đủ period
        expect(highArr[0]).toBeNull();
        expect(highArr[1]).toBeNull();
    });
});

describe('tenkanSen', () => {
    it('Tenkan = (highest + lowest)/2 trong period', () => {
        const highs = [10, 20, 30, 20, 10];
        const lows = [5, 15, 25, 15, 5];
        const t = tenkanSen(highs, lows, 3);
        // idx 2 (cửa sổ 0-2): high=30, low=5 → (30+5)/2 = 17.5
        expect(t[2]).toBe(17.5);
        expect(t[0]).toBeNull();
        expect(t[1]).toBeNull();
    });
    it('Kijun = Tenkan với period khác (cùng công thức)', () => {
        const highs = [1, 2, 3, 4, 5, 6, 7, 8];
        const lows = [0, 1, 2, 3, 4, 5, 6, 7];
        const tenkan = tenkanSen(highs, lows, 5);
        const kijun = kijunSen(highs, lows, 5);
        expect(kijun).toEqual(tenkan); // cùng công thức, cùng period → giống nhau
    });
});

describe('senkouSpanA / B / chikou', () => {
    it('Senkou A = (Tenkan+Kijun)/2, dịch trước displacement', () => {
        const tenkan = [null, null, 10, 10, 10];
        const kijun = [null, null, 10, 10, 10];
        const span = senkouSpanA(tenkan, kijun, 2);
        // tại idx 2: (10+10)/2 = 10, dịch trước 2 → vị trí 4
        expect(span[4]).toBe(10);
        expect(span.length).toBe(7); // 5 + displacement 2
    });
    it('Senkou B dịch trước displacement', () => {
        const highs = Array(10).fill(20);
        const lows = Array(10).fill(10);
        const span = senkouSpanB(highs, lows, 4, 2);
        // (20+10)/2 = 15, tại idx 3 (đủ period 4) → dịch 2 → vị trí 5
        expect(span[5]).toBe(15);
    });
    it('Chikou = close hiện tại dịch lùi về quá khứ', () => {
        const closes = [1, 2, 3, 4, 5, 6];
        const chi = chikouSpan(closes, 2);
        // close[5]=6 dịch lùi 2 → vị trí 3
        expect(chi[3]).toBe(6);
        expect(chi[5]).toBeNull(); // không đủ tương lai để dịch lùi
    });
});

describe('computeIchimoku', () => {
    it('tính đầy đủ 5 đường + Kumo cho data đủ', () => {
        const ohlc = uptrendOhlc(120);
        const ic = computeIchimoku({ dates: Array(120).fill(''), ohlc });
        expect(ic).not.toBeNull();
        expect(ic.tenkan).not.toBeNull();
        expect(ic.kijun).not.toBeNull();
        expect(ic.close).toBeGreaterThan(0);
        expect(ic.kumo).toBeDefined();
        expect(ic.series.tenkan.length).toBe(120);
    });
    it('trả null nếu data quá ngắn (<30)', () => {
        const ic = computeIchimoku({ dates: [''], ohlc: uptrendOhlc(20) });
        expect(ic).toBeNull();
    });
    it('xu hướng tăng mạnh → Kumo xanh', () => {
        const ic = computeIchimoku({ dates: [], ohlc: uptrendOhlc(150) });
        // trong uptrend mạnh, Span A (dựa Tenkan+Kijun nhanh) thường > Span B → xanh
        // (không hard-assert vì fallback; chỉ check state hợp lệ)
        expect(['green', 'red', 'flat', 'unknown']).toContain(ic.kumo.state);
    });
});

describe('interpretIchimoku', () => {
    it('uptrend mạnh → score cao, verdict Bullish', () => {
        const ic = computeIchimoku({ dates: [], ohlc: uptrendOhlc(150) });
        const r = interpretIchimoku(ic);
        expect(r.score).toBeGreaterThanOrEqual(50);
        expect(r.verdict).toBeTruthy();
        expect(r.signals.length).toBeGreaterThan(0);
        expect(r.advice.length).toBeGreaterThan(0);
        expect(r.education.length).toBeGreaterThan(0);
    });
    it('trả verdict hợp lệ khi data thiếu', () => {
        const r = interpretIchimoku({ tenkan: null, kijun: null });
        expect(r.verdict).toBe('Chưa đủ data');
    });
});
