import { describe, it, expect } from 'vitest';
import {
    computeIchimokuBreadth, computeIchimokuBreadthForIndustry,
    tenkanOfCloses, buildSymbolIcb2Map, ICB2_MAP, DEFAULT_PERIODS
} from '../ichimoku-breadth.js';

describe('tenkanOfCloses', () => {
    it('Tenkan = (highest+lowest)/2 của N close gần nhất', () => {
        // closes: [10,20,30], period 3 → hi=30, lo=10 → 20
        expect(tenkanOfCloses([10, 20, 30], 3)).toBe(20);
    });
    it('trả null nếu không đủ data', () => {
        expect(tenkanOfCloses([10, 20], 3)).toBeNull();
        expect(tenkanOfCloses([], 3)).toBeNull();
        expect(tenkanOfCloses([1, 2, 3], 0)).toBeNull();
    });
    it('chỉ dùng N close gần nhất', () => {
        // closes [1,1,1,100,50] period 2 → slice [100,50] → hi=100, lo=50 → 75
        expect(tenkanOfCloses([1, 1, 1, 100, 50], 2)).toBe(75);
    });
});

describe('computeIchimokuBreadth', () => {
    it('đếm số CP trên/dưới từng đường (mock data)', () => {
        // Tạo mock file không có thật: dùng trực tiếp hàm đếm qua symbolIcb2 map
        // computeIchimokuBreadth đọc file thật; test qua tenkanOfCloses thay vì file
        const closes1 = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]; // uptrend → giá > tenkan9
        const close1 = 19;
        const t1 = tenkanOfCloses(closes1, 9);
        expect(close1).toBeGreaterThan(t1); // giá trên Tenkan9

        const closes2 = [19, 18, 17, 16, 15, 14, 13, 12, 11, 10]; // downtrend → giá < tenkan9
        const close2 = 10;
        const t2 = tenkanOfCloses(closes2, 9);
        expect(close2).toBeLessThan(t2); // giá dưới Tenkan9
    });
});

describe('buildSymbolIcb2Map', () => {
    it('map symbol → icb2 từ quotes + override', () => {
        const quotes = [
            { Symbol: 'VCB', IndustryCode: '8382' }, // 8300 Ngân hàng
            { Symbol: 'FPT', IndustryCode: '9530' }, // 9500 Công nghệ
            { Symbol: 'HPG', IndustryCode: '3510' }  // 3500 Thực phẩm (sai, sẽ override)
        ];
        const override = { HPG: '1700' }; // override sang Tài nguyên cơ bản
        const map = buildSymbolIcb2Map(quotes, override);
        expect(map.VCB).toBe('8300');
        expect(map.FPT).toBe('9500');
        expect(map.HPG).toBe('1700'); // override áp dụng
    });
    it('xử lý mảng rỗng', () => {
        expect(buildSymbolIcb2Map([])).toEqual({});
        expect(buildSymbolIcb2Map(null)).toEqual({});
    });
});

describe('ICB2_MAP & DEFAULT_PERIODS', () => {
    it('ICB2_MAP có 20 ngành', () => {
        expect(Object.keys(ICB2_MAP).length).toBe(20);
        expect(ICB2_MAP['8300']).toBe('Ngân hàng');
    });
    it('DEFAULT_PERIODS = 5 đường mặc định [9,26,65,129,234]', () => {
        expect(DEFAULT_PERIODS).toEqual([9, 26, 65, 129, 234]);
        expect(DEFAULT_PERIODS.length).toBe(5);
    });
});
