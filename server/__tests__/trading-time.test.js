import { describe, it, expect, afterEach } from 'vitest';
import * as tt from '../trading-time.js';

// Helper: tạo timestamp (ms) cho một thời điểm cụ thể theo UTC.
// VN = UTC+7. Truyền vào [year, month0, day, hourUTC, minUTC].
function atUTC(y, mo, d, hUTC, min = 0) {
    return Date.UTC(y, mo - 1, d, hUTC, min, 0);
}

afterEach(() => {
    // Reset clock về real-time sau mỗi test
    tt.__setClock(null);
});

describe('trading-time — vnToday / vnNow', () => {
    it('vnToday trả YYYY-MM-DD theo giờ VN (UTC+7)', () => {
        // 2026-07-20 00:30 UTC = 2026-07-20 07:30 VN → cùng ngày
        tt.__setClock(atUTC(2026, 7, 20, 0, 30));
        expect(tt.vnToday()).toBe('2026-07-20');
    });

    it('vnToday lùi 1 ngày khi 0-7h sáng VN (17-24h UTC hôm trước)', () => {
        // 2026-07-21 23:30 UTC = 2026-07-22 06:30 VN → ngày VN vẫn là 22, nhưng nếu
        // tính sai theo UTC sẽ ra 21. Helper phải ra 22 (VN). Thực tế 23:30 UTC +7h = 06:30 VN ngày 22.
        tt.__setClock(atUTC(2026, 7, 21, 23, 30));
        expect(tt.vnToday()).toBe('2026-07-22');
    });
});

describe('trading-time — weekend / trading day', () => {
    // 2026-07-18 là Thứ Bảy, 2026-07-19 là Chủ Nhật (VN), 2026-07-20 là Thứ Hai.
    it('isWeekend true vào Thứ Bảy (VN)', () => {
        // 2026-07-18 10:00 UTC = 17:00 VN Thứ Bảy
        tt.__setClock(atUTC(2026, 7, 18, 10, 0));
        expect(tt.isWeekend()).toBe(true);
        expect(tt.isTradingDay()).toBe(false);
    });

    it('isWeekend true vào Chủ Nhật (VN)', () => {
        // 2026-07-19 02:00 UTC = 09:00 VN Chủ Nhật
        tt.__setClock(atUTC(2026, 7, 19, 2, 0));
        expect(tt.isWeekend()).toBe(true);
        expect(tt.isTradingDay()).toBe(false);
    });

    it('isWeekend false vào Thứ Hai (VN)', () => {
        // 2026-07-20 02:00 UTC = 09:00 VN Thứ Hai
        tt.__setClock(atUTC(2026, 7, 20, 2, 0));
        expect(tt.isWeekend()).toBe(false);
        expect(tt.isTradingDay()).toBe(true);
    });
});

describe('trading-time — isInTradingHours (9-15h VN, chỉ ngày giao dịch)', () => {
    it('true khi 9-15h VN trong tuần', () => {
        // 2026-07-22 (T4) 03:00 UTC = 10:00 VN
        tt.__setClock(atUTC(2026, 7, 22, 3, 0));
        expect(tt.isInTradingHours()).toBe(true);
    });

    it('false trước 9h VN', () => {
        // 2026-07-22 01:00 UTC = 08:00 VN
        tt.__setClock(atUTC(2026, 7, 22, 1, 0));
        expect(tt.isInTradingHours()).toBe(false);
    });

    it('false sau 15h VN', () => {
        // 2026-07-22 09:00 UTC = 16:00 VN
        tt.__setClock(atUTC(2026, 7, 22, 9, 0));
        expect(tt.isInTradingHours()).toBe(false);
    });

    it('false vào cuối tuần dù trong khung 9-15h VN', () => {
        // 2026-07-18 (T7) 03:00 UTC = 10:00 VN
        tt.__setClock(atUTC(2026, 7, 18, 3, 0));
        expect(tt.isInTradingHours()).toBe(false);
    });
});

describe('trading-time — isInEODWindow (15-23h VN, chỉ ngày giao dịch)', () => {
    it('true khi 15-23h VN trong tuần', () => {
        // 2026-07-22 09:00 UTC = 16:00 VN
        tt.__setClock(atUTC(2026, 7, 22, 9, 0));
        expect(tt.isInEODWindow()).toBe(true);
    });

    it('false trước 15h VN', () => {
        // 2026-07-22 03:00 UTC = 10:00 VN
        tt.__setClock(atUTC(2026, 7, 22, 3, 0));
        expect(tt.isInEODWindow()).toBe(false);
    });

    it('false sau 23h VN', () => {
        // 2026-07-22 17:00 UTC = 00:00 VN ngày 23 → ngoài EOD
        tt.__setClock(atUTC(2026, 7, 22, 17, 0));
        expect(tt.isInEODWindow()).toBe(false);
    });

    it('false vào cuối tuần dù trong khung 15-23h VN', () => {
        // 2026-07-18 (T7) 10:00 UTC = 17:00 VN
        tt.__setClock(atUTC(2026, 7, 18, 10, 0));
        expect(tt.isInEODWindow()).toBe(false);
    });
});

describe('trading-time — lastTradingDay', () => {
    it('sáng Thứ Hai trước 15h → trả về Thứ Sáu tuần trước', () => {
        // 2026-07-20 (T2) 03:00 UTC = 10:00 VN — phiên hôm nay chưa đóng cửa
        // → lastTradingDay = Thứ Sáu 2026-07-17
        tt.__setClock(atUTC(2026, 7, 20, 3, 0));
        expect(tt.lastTradingDay()).toBe('2026-07-17');
    });

    it('chiều Thứ Hai sau 15h → trả về Thứ Hai hôm nay', () => {
        // 2026-07-20 (T2) 09:00 UTC = 16:00 VN — đã đóng cửa
        // → lastTradingDay = Thứ Hai 2026-07-20
        tt.__setClock(atUTC(2026, 7, 20, 9, 0));
        expect(tt.lastTradingDay()).toBe('2026-07-20');
    });

    it('giữa tuần trước 15h → trả về ngày hôm trước', () => {
        // 2026-07-22 (T4) 03:00 UTC = 10:00 VN → hôm nay chưa đóng cửa
        // → lastTradingDay = 2026-07-21 (T3)
        tt.__setClock(atUTC(2026, 7, 22, 3, 0));
        expect(tt.lastTradingDay()).toBe('2026-07-21');
    });

    it('giữa tuần sau 15h → trả về hôm nay', () => {
        // 2026-07-22 (T4) 09:00 UTC = 16:00 VN
        tt.__setClock(atUTC(2026, 7, 22, 9, 0));
        expect(tt.lastTradingDay()).toBe('2026-07-22');
    });

    it('Thứ Bảy → trả về Thứ Sáu', () => {
        // 2026-07-18 (T7) 03:00 UTC = 10:00 VN → Thứ Sáu 2026-07-17
        tt.__setClock(atUTC(2026, 7, 18, 3, 0));
        expect(tt.lastTradingDay()).toBe('2026-07-17');
    });

    it('Chủ Nhật → trả về Thứ Sáu', () => {
        // 2026-07-19 (CN) 02:00 UTC = 09:00 VN → Thứ Sáu 2026-07-17
        tt.__setClock(atUTC(2026, 7, 19, 2, 0));
        expect(tt.lastTradingDay()).toBe('2026-07-17');
    });
});
