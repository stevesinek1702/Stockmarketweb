/**
 * Unit tests cho pure functions của MA Breadth module.
 * Chạy: npm test -- ma-breadth
 */
import { describe, it, expect } from 'vitest';
import {
    computeMAWithPrefix,
    countAboveMAForDate,
    aggregateByIndustry,
    filterSeriesByDateRange,
    clampDateRange
} from '../../server/breadth-history.js';

describe('computeMAWithPrefix', () => {
    it('tính đúng SMA cho chuỗi đủ dữ liệu', () => {
        // closes: 10,20,30,40,50 ; MA3 = [null, null, 20, 30, 40]
        const closes = [10, 20, 30, 40, 50];
        const ma = computeMAWithPrefix(closes, 3);
        expect(ma).toEqual([null, null, 20, 30, 40]);
    });

    it('trả toàn null khi n > length', () => {
        expect(computeMAWithPrefix([1, 2], 5)).toEqual([null, null]);
    });

    it('trả mảng rỗng khi input rỗng', () => {
        expect(computeMAWithPrefix([], 3)).toEqual([]);
    });

    it('MA1 = chính close', () => {
        expect(computeMAWithPrefix([5, 7, 9], 1)).toEqual([5, 7, 9]);
    });

    it('xử lý MA200 cho chuỗi dài', () => {
        const closes = Array(250).fill(0).map((_, i) => i + 1); // 1..250
        const ma = computeMAWithPrefix(closes, 200);
        // 199 null đầu, sau đó MA200 tại index 199 = avg(closes[0..199]) = avg(1..200) = 100.5
        expect(ma[198]).toBeNull();
        expect(ma[199]).toBeCloseTo(100.5, 5);
        // MA200 tại index 249 = avg(closes[50..249]) = avg(51..250) = 150.5
        expect(ma[249]).toBeCloseTo(150.5, 5);
    });
});

describe('countAboveMAForDate', () => {
    const icb2Map = { '8300': 'Ngân hàng', '8500': 'Bảo hiểm' };

    it('đếm đúng số CP trên MA + gom theo ngành', () => {
        // 3 CP tại 1 ngày: mỗi CP có close + 5 MA (10/20/50/100/200)
        const stocks = [
            { symbol: 'ACB', icb2: '8300', close: 25, ma10: 20, ma20: 18, ma50: 15, ma100: 12, ma200: 10 },
            { symbol: 'BID', icb2: '8300', close: 30, ma10: 35, ma20: 28, ma50: 22, ma100: 18, ma200: 15 },
            { symbol: 'BVH', icb2: '8500', close: 50, ma10: 48, ma20: 45, ma50: 40, ma100: 35, ma200: 30 }
        ];
        const result = countAboveMAForDate(stocks);
        // Market: ACB trên 5/5, BID trên 4/5 (ma10=35>close=30 sai), BVH trên 5/5
        expect(result.market).toEqual({
            ma10: 2, ma20: 3, ma50: 3, ma100: 3, ma200: 3, total: 3
        });
        // Ngành 8300: ACB trên 5/5, BID trên 4/5 (trừ ma10)
        expect(result.industries['8300']).toEqual({
            name: 'Ngân hàng', ma10: 1, ma20: 2, ma50: 2, ma100: 2, ma200: 2, total: 2
        });
        expect(result.industries['8500']).toEqual({
            name: 'Bảo hiểm', ma10: 1, ma20: 1, ma50: 1, ma100: 1, ma200: 1, total: 1
        });
    });

    it('bỏ qua MA null (mã mới chưa đủ dữ liệu)', () => {
        const stocks = [
            // Mã mới: ma200 = null (chưa đủ 200 ngày)
            { symbol: 'NEW', icb2: '8300', close: 25, ma10: 20, ma20: 18, ma50: 15, ma100: 12, ma200: null }
        ];
        const result = countAboveMAForDate(stocks);
        expect(result.market.ma200).toBe(0); // null → không đếm, không lỗi
        expect(result.market.ma10).toBe(1);
        expect(result.market.total).toBe(1);
    });

    it('bỏ qua close <= 0 (mã không giao dịch)', () => {
        const stocks = [
            { symbol: 'XXX', icb2: '8300', close: 0, ma10: 20, ma20: 18, ma50: 15, ma100: 12, ma200: 10 }
        ];
        const result = countAboveMAForDate(stocks);
        expect(result.market.total).toBe(0);
    });

    it('bỏ qua mã không có icb2 hợp lệ trong phần ngành (vẫn tính market)', () => {
        const stocks = [
            { symbol: 'UNK', icb2: '9999', close: 25, ma10: 20, ma20: 18, ma50: 15, ma100: 12, ma200: 10 }
        ];
        const result = countAboveMAForDate(stocks, icb2Map);
        expect(result.market.total).toBe(1);
        expect(result.industries['9999']).toBeUndefined();
    });
});

describe('aggregateByIndustry', () => {
    it('gom snapshot từng ngành thành chuỗi theo thời gian', () => {
        const history = {
            '2026-01-02': {
                market: { ma10: 700, ma20: 650, ma50: 600, ma100: 500, ma200: 400, total: 1000 },
                industries: {
                    '8300': { name: 'Ngân hàng', ma10: 18, ma20: 16, ma50: 14, ma100: 9, ma200: 5, total: 28 }
                }
            },
            '2026-01-03': {
                market: { ma10: 710, ma20: 660, ma50: 610, ma100: 510, ma200: 410, total: 1000 },
                industries: {
                    '8300': { name: 'Ngân hàng', ma10: 19, ma20: 17, ma50: 15, ma100: 10, ma200: 6, total: 28 }
                }
            }
        };
        const marketSeries = aggregateByIndustry(history, 'market');
        expect(marketSeries).toEqual([
            { date: '2026-01-02', ma10: 700, ma20: 650, ma50: 600, ma100: 500, ma200: 400, total: 1000 },
            { date: '2026-01-03', ma10: 710, ma20: 660, ma50: 610, ma100: 510, ma200: 410, total: 1000 }
        ]);

        const bankSeries = aggregateByIndustry(history, '8300');
        expect(bankSeries).toHaveLength(2);
        expect(bankSeries[1]).toEqual({ date: '2026-01-03', ma10: 19, ma20: 17, ma50: 15, ma100: 10, ma200: 6, total: 28 });
    });
});

describe('filterSeriesByDateRange', () => {
    const series = [
        { date: '2026-01-02', ma10: 1 },
        { date: '2026-02-15', ma10: 2 },
        { date: '2026-03-01', ma10: 3 },
        { date: '2026-06-01', ma10: 4 },
        { date: '2026-07-13', ma10: 5 }
    ];

    it('lọc đúng khoảng inclusive', () => {
        const r = filterSeriesByDateRange(series, '2026-02-01', '2026-06-30');
        expect(r).toHaveLength(3);
        expect(r[0].date).toBe('2026-02-15');
        expect(r[2].date).toBe('2026-06-01');
    });

    it('trả toàn bộ khi fromDate/toDate null', () => {
        expect(filterSeriesByDateRange(series, null, null)).toHaveLength(5);
    });

    it('chỉ fromDate', () => {
        const r = filterSeriesByDateRange(series, '2026-03-01', null);
        expect(r).toHaveLength(3);
    });

    it('chỉ toDate', () => {
        const r = filterSeriesByDateRange(series, null, '2026-02-15');
        expect(r).toHaveLength(2);
    });

    it('khoảng rỗng → trả []', () => {
        expect(filterSeriesByDateRange(series, '2025-01-01', '2025-12-31')).toEqual([]);
    });
});

describe('clampDateRange', () => {
    it('clamp vào khoảng thực của data', () => {
        const r = clampDateRange('2020-01-01', '2030-12-31', '2026-01-02', '2026-07-13');
        expect(r).toEqual({ fromDate: '2026-01-02', toDate: '2026-07-13' });
    });

    it('hoán đổi khi from > to', () => {
        const r = clampDateRange('2026-06-01', '2026-03-01', '2026-01-02', '2026-07-13');
        expect(r).toEqual({ fromDate: '2026-03-01', toDate: '2026-06-01' });
    });

    it('null → dùng boundary thực', () => {
        const r = clampDateRange(null, null, '2026-01-02', '2026-07-13');
        expect(r).toEqual({ fromDate: '2026-01-02', toDate: '2026-07-13' });
    });
});
