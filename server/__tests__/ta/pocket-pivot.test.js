import { describe, it, expect } from 'vitest';
import { detectPocketPivot } from '../../ta/pocket-pivot.js';

describe('detectPocketPivot', () => {
  it('detect pocket pivot: volume hôm nay > mọi ngày giảm trong 10 ngày trước', () => {
    const dates = [], ohlc = [], volumes = [];
    for (let i = 0; i < 12; i++) {
      // 10 ngày trước: vài ngày giảm volume 500
      const up = i % 3 !== 0;
      ohlc.push({ o: 100, h: 101, l: 99, c: up ? 100.5 : 99.5 });
      volumes.push(up ? 300 : 500);
      dates.push(`2025-01-${String(i + 1).padStart(2, '0')}`);
    }
    // hôm nay: tăng giá, volume 1000 (> mọi down-day 500 trong 10 ngày trước)
    ohlc.push({ o: 100, h: 102, l: 100, c: 101.5 });
    volumes.push(1000);
    dates.push('2025-01-13');
    const r = detectPocketPivot({ dates, ohlc, volumes });
    expect(r.detected).toBe(true);
    expect(r.date).toBe('2025-01-13');
  });
  it('không detect khi volume hôm nay nhỏ hơn 1 down-day trong 10 ngày trước', () => {
    const dates = [], ohlc = [], volumes = [];
    for (let i = 0; i < 12; i++) {
      ohlc.push({ o: 100, h: 101, l: 99, c: i % 2 ? 99.5 : 100.5 });
      volumes.push(i === 5 ? 2000 : 500); // down-day volume 2000
      dates.push(`2025-01-${String(i + 1).padStart(2, '0')}`);
    }
    ohlc.push({ o: 100, h: 102, l: 100, c: 101.5 });
    volumes.push(1000);
    dates.push('2025-01-13');
    expect(detectPocketPivot({ dates, ohlc, volumes }).detected).toBe(false);
  });
  it('không detect khi hôm nay giảm giá', () => {
    const dates = [], ohlc = [], volumes = [];
    for (let i = 0; i < 12; i++) {
      ohlc.push({ o: 100, h: 101, l: 99, c: 100 });
      volumes.push(500);
      dates.push(`2025-01-${String(i + 1).padStart(2, '0')}`);
    }
    ohlc.push({ o: 101, h: 102, l: 99, c: 99 }); // giảm
    volumes.push(1000);
    dates.push('2025-01-13');
    expect(detectPocketPivot({ dates, ohlc, volumes }).detected).toBe(false);
  });
});
