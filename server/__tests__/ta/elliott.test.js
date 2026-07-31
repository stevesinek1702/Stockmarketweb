import { describe, it, expect } from 'vitest';
import {
    detectSwings, fibRetracement, fibExtension, analyzeElliott,
    scoreImpulse, labelWaves, measureWaveRatios, projectFuture
} from '../../ta/elliott.js';

describe('detectSwings', () => {
    it('phát hiện pivot luân phiên high/low với data có swing rõ', () => {
        // data đủ dài + swing rõ (mỗi đợt tăng/giảm > 3%)
        const closes = [100, 105, 112, 108, 115, 120, 116, 122, 128, 124, 118, 110, 115, 121, 126, 132, 128, 122, 128, 134];
        const highs = closes.map(c => c + 2);
        const lows = closes.map(c => c - 2);
        const sw = detectSwings(closes, highs, lows, 0.03);
        expect(sw.length).toBeGreaterThanOrEqual(3);
        // kiểm tra luân phiên: không 2 high liên tiếp (sau khi sort theo index)
        for (let i = 1; i < sw.length; i++) {
            expect(sw[i].type).not.toBe(sw[i - 1].type);
        }
    });
    it('trả [] nếu data quá ngắn', () => {
        const sw = detectSwings([1, 2, 3], [1, 2, 3], [1, 2, 3], 0.03);
        expect(sw).toEqual([]);
    });
});

describe('fibRetracement', () => {
    it('mức 0.5 = trung điểm giữa start và end', () => {
        const r = fibRetracement(100, 200);
        // công thức: end - diff*r; diff=100
        // 0.5: 200 - 100*0.5 = 150
        expect(r[0.5]).toBe(150);
        // 0.618: 200 - 61.8 = 138.2
        expect(r[0.618]).toBeCloseTo(138.2, 1);
        // 0.382: 200 - 38.2 = 161.8
        expect(r[0.382]).toBeCloseTo(161.8, 1);
    });
});

describe('fibExtension', () => {
    it('tính target dự phóng từ 3 điểm (uptrend)', () => {
        // p0=100, p1=200, p2=150 (retrace về): wave1=100, dir=+1
        const e = fibExtension(100, 200, 150);
        // extension 1.0 = 150 + 100*1 = 250
        expect(e[1.0]).toBe(250);
        // 1.618 = 150 + 161.8 = 311.8
        expect(e[1.618]).toBeCloseTo(311.8, 1);
    });
    it('downtrend: dir = -1', () => {
        // p0=200, p1=100, p2=150 (retrace lên): wave1=100, dir=-1
        const e = fibExtension(200, 100, 150);
        // 1.0 = 150 - 100 = 50
        expect(e[1.0]).toBe(50);
    });
});

describe('analyzeElliott', () => {
    it('uptrend mạnh → pattern IMPULSE, trend strength cao', () => {
        const closes = [];
        let p = 100;
        for (let i = 0; i < 120; i++) {
            p = 100 + i * 1.5 + Math.sin(i / 5) * 8;
            closes.push(Math.round(p * 100) / 100);
        }
        const ohlc = closes.map(c => ({ o: c, h: c + 1.5, l: c - 1.5, c }));
        const r = analyzeElliott({ dates: Array(120).fill(''), ohlc });
        expect(r.success).toBe(true);
        expect(r.pattern).toMatch(/IMPULSE/);
        expect(r.trendDir).toBe('up');
        expect(r.trendStrength).toBeGreaterThan(0.5);
        expect(r.currentWave).toBeTruthy();
        expect(r.notes.length).toBeGreaterThan(0);
        expect(r.disclaimer).toBeTruthy();
    });
    it('trả success=false nếu data quá ngắn', () => {
        const r = analyzeElliott({ dates: [], ohlc: Array(30).fill({ o: 1, h: 1, l: 1, c: 1 }) });
        expect(r.success).toBe(false);
    });
    it('series close + dates để frontend vẽ chart', () => {
        const closes = [];
        let p = 100;
        for (let i = 0; i < 100; i++) { p += 1.5 + Math.sin(i / 5) * 4; closes.push(p); }
        const ohlc = closes.map(c => ({ o: c, h: c + 1, l: c - 1, c }));
        const r = analyzeElliott({ dates: Array(100).fill('d'), ohlc });
        expect(r.series.close.length).toBe(100);
        expect(r.series.dates.length).toBe(100);
    });
    it('trả thêm field nâng cấp: waveLabels, waveRatios, futureProjection', () => {
        const closes = [];
        let p = 100;
        for (let i = 0; i < 200; i++) { p = 100 + i * 0.8 + Math.sin(i / 4) * 6 + Math.sin(i / 13) * 10; closes.push(Math.round(p * 100) / 100); }
        const ohlc = closes.map(c => ({ o: c, h: c + 1.2, l: c - 1.2, c }));
        const r = analyzeElliott({ dates: Array(200).fill('d'), ohlc });
        expect(r.waveLabels).toBeDefined();
        expect(r.waveRatios).toBeDefined();
        expect(r.futureProjection).toBeDefined();
        expect(Array.isArray(r.waveLabels.labels)).toBe(true);
    });
});

describe('scoreImpulse', () => {
    it('impulse hợp lệ (uptrend) → valid=true, score cao', () => {
        // [100,120,108,150,140,160]: w1=20, w2=12, w3=42, w4=10, w5=20
        const res = scoreImpulse([100, 120, 108, 150, 140, 160]);
        expect(res.valid).toBe(true);
        expect(res.direction).toBe('up');
        expect(res.score).toBeGreaterThan(50);
    });
    it('R2 vi phạm (sóng 3 ngắn nhất) → valid=false', () => {
        // [100,150,130,135,120,160]: w1=50, w3=5 (ngắn nhất) → vi phạm
        const res = scoreImpulse([100, 150, 130, 135, 120, 160]);
        expect(res.valid).toBe(false);
        expect(res.violations.some(v => v.includes('R2'))).toBe(true);
    });
    it('R1 vi phạm (sóng 2 hồi quá sóng 1) → valid=false', () => {
        // uptrend: sóng 2 hồi dưới P0 (98 < 100) → vi phạm
        const res = scoreImpulse([100, 120, 98, 140, 110, 150]);
        expect(res.valid).toBe(false);
        expect(res.violations.some(v => v.includes('R1'))).toBe(true);
    });
});

describe('labelWaves', () => {
    it('dán nhãn 0-5 + ABC cho impulse uptrend hợp lệ', () => {
        const swings = [
            { i: 0, price: 100, type: 'low' }, { i: 5, price: 120, type: 'high' },
            { i: 10, price: 108, type: 'low' }, { i: 20, price: 150, type: 'high' },
            { i: 25, price: 140, type: 'low' }, { i: 35, price: 160, type: 'high' },
            { i: 40, price: 145, type: 'low' }, { i: 45, price: 155, type: 'high' },
            { i: 50, price: 140, type: 'low' }
        ];
        const lw = labelWaves(swings);
        expect(lw.score).toBeGreaterThan(0);
        expect(lw.direction).toBe('up');
        const labels = lw.labels.map(l => l.label);
        expect(labels).toEqual(['0', '1', '2', '3', '4', '5', 'A', 'B', 'C']);
    });
    it('trả labels rỗng nếu swings < 6', () => {
        const lw = labelWaves([{ i: 0, price: 100, type: 'low' }, { i: 1, price: 110, type: 'high' }]);
        expect(lw.labels).toEqual([]);
        expect(lw.score).toBe(0);
    });
});

describe('measureWaveRatios', () => {
    it('đo đúng tỷ lệ wave3/wave1 từ chu kỳ impulse', () => {
        // impulse: [100,120,108,150,140,160] → w1=20, w3=42 → 2.1
        const cycles = [{ pivots: [100, 120, 108, 150, 140, 160], direction: 'up' }];
        const r = measureWaveRatios(cycles);
        expect(r.wave3OverWave1).toBeCloseTo(2.1, 1);
        expect(r.retrace2Pct).toBeCloseTo(60, 0); // w2=12/20=0.6 → 60%
        expect(r.sampleCount).toBe(1);
    });
    it('sampleCount=0 nếu không có chu kỳ', () => {
        const r = measureWaveRatios([]);
        expect(r.sampleCount).toBe(0);
        expect(r.wave3OverWave1).toBeNull();
    });
});

describe('projectFuture', () => {
    it('trả targets + segments khi có labels', () => {
        const labels = [
            { i: 0, price: 100, label: '0' }, { i: 5, price: 110, label: '1' },
            { i: 10, price: 105, label: '2' }, { i: 20, price: 125, label: '3' }
        ];
        const ratios = { wave3OverWave1: 1.618, wave5OverWave1: 0.618, retrace2Pct: 50, retrace4Pct: 38.2, waveCOverWaveA: 1.0, sampleCount: 1 };
        const pf = projectFuture(labels, ratios, 120, 'up');
        expect(pf.currentWave).toContain('Sóng');
        expect(pf.usedFallback).toBe(false);
    });
    it('fallback Fibonacci khi sampleCount=0', () => {
        const pf = projectFuture([], { sampleCount: 0 }, 100, 'up');
        expect(pf.usedFallback).toBe(true);
        expect(pf.note).toContain('Fibonacci');
    });
});
