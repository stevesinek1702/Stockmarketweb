import { describe, it, expect } from 'vitest';
import { detectVCP } from '../../ta/vcp.js';

describe('detectVCP', () => {
  it('detect VCP: contractions giảm dần trên volume giảm', () => {
    // VCP thật: PEEK → pullback XUỐNG → RALLY LÊN peek thấp hơn → pullback hời hơn → ...
    // Highs phải xen kẽ lên-xuống (không phải monotonic).
    const dates = [], ohlc = [], volumes = [];
    const base = new Date(Date.UTC(2025, 0, 1));
    // Wave 1: peek1 h=130, dip1 ~101 (pullback 22%)
    ohlc.push({ o: 128, h: 130, l: 127, c: 129 });  // peek 1 (h=130)
    ohlc.push({ o: 129, h: 105, l: 101, c: 102 });  // dip 1  (l=101)
    // Wave 2: rally lên peek2 h=122 (< peek1), dip2 ~110 (pullback 10%)
    ohlc.push({ o: 102, h: 122, l: 101, c: 120 });  // peek 2 (h=122)
    ohlc.push({ o: 120, h: 112, l: 110, c: 111 });  // dip 2  (l=110)
    // Wave 3: rally lên peek3 h=116, dip3 ~114 (pullback 1.7% — tight)
    ohlc.push({ o: 111, h: 116, l: 110, c: 115 });  // peek 3 (h=116)
    ohlc.push({ o: 115, h: 115, l: 114, c: 114.2 }); // dip 3  (l=114)
    volumes.push(1500, 1300, 1000, 900, 600, 500);
    for (let i = 0; i < ohlc.length; i++) {
      dates.push(new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10));
    }
    const r = detectVCP({ dates, ohlc, volumes });
    expect(r.isVCP).toBe(true);
    expect(r.contractions.length).toBeGreaterThanOrEqual(2);
  });
  it('không phải VCP khi giá dao động ngẫu nhiên', () => {
    const dates = [], ohlc = [], volumes = [];
    for (let i = 0; i < 40; i++) {
      const c = 100 + (Math.sin(i) * 5);
      ohlc.push({ o: 100, h: c + 5, l: c - 5, c });
      volumes.push(500 + (i % 3) * 100);
      dates.push(`2025-01-${String(i + 1).padStart(2, '0')}`);
    }
    const r = detectVCP({ dates, ohlc, volumes });
    expect(r.isVCP).toBe(false);
  });
});
