import { describe, it, expect } from 'vitest';
import { parseQuote } from '../../data/ohlcv-fetch.js';

describe('parseQuote', () => {
  it('parse OHLCV đầy đủ từ FireAnt PascalCase', () => {
    const q = parseQuote({ Date: '2026-07-17T00:00:00', Open: 95, High: 96, Low: 94, Close: 95.5, Volume: 1200000 });
    expect(q.date).toBe('2026-07-17');
    expect(q.o).toBe(95);
    expect(q.h).toBe(96);
    expect(q.l).toBe(94);
    expect(q.c).toBe(95.5);
    expect(q.v).toBe(1200000);
  });
  it('parse từ camelCase fallback', () => {
    const q = parseQuote({ date: '2026-07-17', open: 10, high: 11, low: 9, close: 10.5, volume: 500 });
    expect(q.c).toBe(10.5);
    expect(q.v).toBe(500);
  });
  it('thiếu Open/High/Low → fallback về Close (OHLC hợp lệ cho TA)', () => {
    const q = parseQuote({ Date: '2026-07-17', Close: 50, Volume: 1000 });
    expect(q.o).toBe(50);
    expect(q.h).toBe(50);
    expect(q.l).toBe(50);
    expect(q.c).toBe(50);
  });
  it('thiếu Close → null (không tính được TA)', () => {
    expect(parseQuote({ Date: '2026-07-17', Open: 50 })).toBeNull();
    expect(parseQuote({ Date: '2026-07-17', Close: 0 })).toBeNull();
  });
  it('thiếu date → null', () => {
    expect(parseQuote({ Close: 50 })).toBeNull();
  });
  it('Volume = 0 → vẫn hợp lệ (mã không giao dịch phiên đó)', () => {
    const q = parseQuote({ Date: '2026-07-17', Close: 50, Volume: 0 });
    expect(q).not.toBeNull();
    expect(q.v).toBe(0);
  });
  it('string numeric → parse', () => {
    const q = parseQuote({ Date: '2026-07-17', Close: '95.5', Volume: '1.2e6' });
    expect(q.c).toBe(95.5);
  });
});
