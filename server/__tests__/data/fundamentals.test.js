import { describe, it, expect, beforeEach } from 'vitest';
import {
  isStale,
  extractFundamentals,
  medianPE,
  sectorValuation,
  pickField
} from '../../data/fundamentals.js';
import { netSmartToNetPctByRank } from '../../scoring/sector-assembly.js';

// ═══════════════════════════════════════════════════════════════════════
// pickField — extract 1 metric từ FireAnt quote với nhiều field name có thể
// (FireAnt có thể dùng PriceToEarning | P/E | priceToEarning | pe)
// ═══════════════════════════════════════════════════════════════════════
describe('pickField', () => {
  it('tìm thấy field theo tên chính', () => {
    expect(pickField({ PriceToEarning: 14.2 }, ['PriceToEarning', 'pe'])).toBe(14.2);
  });
  it('fallback sang field name thứ 2', () => {
    expect(pickField({ pe: 14.2 }, ['PriceToEarning', 'pe'])).toBe(14.2);
  });
  it('không có field nào → null', () => {
    expect(pickField({ foo: 1 }, ['PriceToEarning', 'pe'])).toBeNull();
  });
  it('field = 0 → vẫn trả 0 (không bị nhầm null)', () => {
    expect(pickField({ PriceToEarning: 0 }, ['PriceToEarning'])).toBe(0);
  });
  it('field âm → vẫn trả (lọc âm là trách nhiệm sanitize, không phải generic extractor)', () => {
    // ROE âm là hợp lệ; chỉ P/E âm vô nghĩa → extractFundamentals + sanitizePe lo.
    expect(pickField({ RoE: -5 }, ['RoE'])).toBe(-5);
  });
  it('field string numeric → parse sang số', () => {
    expect(pickField({ PriceToEarning: '14.2' }, ['PriceToEarning'])).toBe(14.2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// extractFundamentals — từ 1 FireAnt quote → {pe, pb, roe, eps}
// ═══════════════════════════════════════════════════════════════════════
describe('extractFundamentals', () => {
  it('extract đầy đủ 4 metric', () => {
    const q = { Symbol: 'VCB', PriceToEarning: 14.2, PriceToBook: 2.1, RoE: 24, Eps: 9800 };
    const f = extractFundamentals(q);
    expect(f.pe).toBe(14.2);
    expect(f.pb).toBe(2.1);
    expect(f.roe).toBe(24);
    expect(f.eps).toBe(9800);
  });
  it('thiếu metric → null (không crash)', () => {
    const f = extractFundamentals({ Symbol: 'XXX' });
    expect(f.pe).toBeNull();
    expect(f.pb).toBeNull();
  });
  it('P/E âm (lỗ) → null', () => {
    const f = extractFundamentals({ Symbol: 'LOSS', PriceToEarning: -3 });
    expect(f.pe).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isStale — cache TTL check (1 ngày)
// ═══════════════════════════════════════════════════════════════════════
describe('isStale', () => {
  it('cache rỗng → stale', () => {
    expect(isStale({ symbols: {} }, Date.now())).toBe(true);
  });
  it('cache mới (< 1 ngày) → không stale', () => {
    const now = Date.now();
    const data = { meta: { lastUpdated: new Date(now).toISOString() }, symbols: { VCB: {} } };
    expect(isStale(data, now)).toBe(false);
  });
  it('cache cũ (> 1 ngày) → stale', () => {
    const now = Date.now();
    const old = now - 26 * 3600 * 1000; // 26h trước
    const data = { meta: { lastUpdated: new Date(old).toISOString() }, symbols: { VCB: {} } };
    expect(isStale(data, now)).toBe(true);
  });
  it('lastUpdated thiếu → stale', () => {
    expect(isStale({ symbols: { VCB: {} } }, Date.now())).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// medianPE — median P/E của 1 list fundamentals (loại null)
// ═══════════════════════════════════════════════════════════════════════
describe('medianPE', () => {
  it('median đúng (lẻ)', () => {
    // [10, 14, 20] → 14
    const list = [
      { pe: 10 }, { pe: 14 }, { pe: 20 }
    ];
    expect(medianPE(list)).toBe(14);
  });
  it('median đúng (chẵn) → trung bình 2 số giữa', () => {
    // [10, 14, 20, 30] → (14+20)/2 = 17
    const list = [{ pe: 10 }, { pe: 14 }, { pe: 20 }, { pe: 30 }];
    expect(medianPE(list)).toBe(17);
  });
  it('loại null/undefined', () => {
    const list = [{ pe: 10 }, { pe: null }, { pe: 20 }, {}];
    expect(medianPE(list)).toBe(15); // [10,20] → 15
  });
  it('toàn null → null', () => {
    expect(medianPE([{ pe: null }, {}])).toBeNull();
  });
  it('rỗng → null', () => {
    expect(medianPE([])).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// sectorValuation — gộp {peAvg, pbAvg} cho 1 ngành từ list fundamentals
// ═══════════════════════════════════════════════════════════════════════
describe('sectorValuation', () => {
  it('compute median P/E + P/B ngành', () => {
    const funds = [
      { pe: 10, pb: 1 }, { pe: 14, pb: 2 }, { pe: 20, pb: 3 }
    ];
    const v = sectorValuation(funds);
    expect(v.peAvg).toBe(14);
    expect(v.pbAvg).toBe(2);
  });
  it('thiếu sample (< 3 CP) → null (không đủ ý nghĩa)', () => {
    const v = sectorValuation([{ pe: 10 }, { pe: 20 }]);
    expect(v.peAvg).toBeNull();
    expect(v.pbAvg).toBeNull();
  });
  it('toàn null → null', () => {
    expect(sectorValuation([{ pe: null }, { pe: null }, { pe: null }]).peAvg).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// netSmartToNetPctByRank — convert dòng tiền smart (tỷ VND) → netPct tương đối
// ═══════════════════════════════════════════════════════════════════════
describe('netSmartToNetPctByRank', () => {
  it('ngành gom nhiều nhất → netPct dương cao', () => {
    const out = netSmartToNetPctByRank({ '8300': 500, '1700': 100, '8600': -200 });
    expect(out['8300']).toBeGreaterThan(0);   // rank 1
    expect(out['8600']).toBeLessThan(0);      // rank 3 (xả nhiều)
  });
  it('median → gần 0', () => {
    const out = netSmartToNetPctByRank({ '8300': 500, '1700': 100, '8600': -200 });
    expect(Math.abs(out['1700'])).toBeLessThan(1); // rank 2/3 ≈ median
  });
  it('1 ngành → empty (không đủ để rank)', () => {
    expect(Object.keys(netSmartToNetPctByRank({ '8300': 500 })).length).toBe(0);
  });
  it('loại giá trị không hợp lệ (lọc xong < 2 ngành → empty)', () => {
    const out = netSmartToNetPctByRank({ '8300': 500, '1700': null, '8600': 'abc' });
    // chỉ 1 giá trị hợp lệ còn lại → không đủ rank → empty
    expect(Object.keys(out).length).toBe(0);
  });
  it('lọc giá trị không hợp lệ nhưng vẫn đủ ngành để rank', () => {
    const out = netSmartToNetPctByRank({ '8300': 500, '1700': 100, '8600': null });
    expect(out).toHaveProperty('8300');
    expect(out).toHaveProperty('1700');
    expect(out).not.toHaveProperty('8600');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// computeSectorRSFromBreadth — breadth RS (count→pct, delta scale ×2)
// ═══════════════════════════════════════════════════════════════════════
import { computeSectorRSFromBreadth as breadthRS } from '../../scoring/sector-assembly.js';

describe('computeSectorRSFromBreadth', () => {
  it('ngành breadth vượt thị trường → sectorReturn3m dương', () => {
    // 8300 (Ngân hàng) có %MA50 cao hơn market → return dương
    const r = breadthRS('8300');
    if (r) {
      expect(r.sectorReturn3m).toBeGreaterThan(0);
      expect(r.indexReturn3m).toBe(0); // baseline market
    }
  });
  it('sectorReturn3m đã scale 0.12 (delta breadth ±15 → return ±1.8)', () => {
    const r = breadthRS('8300');
    if (r) {
      // breadth delta thực ~±15% → scale 0.12 → return ±1.8 (→ RS 50±45)
      expect(Math.abs(r.sectorReturn3m)).toBeLessThanOrEqual(3);
    }
  });
  it('industry code không tồn tại → null hoặc return hợp lệ', () => {
    const r = breadthRS('9999');
    expect(r === null || typeof r.sectorReturn3m === 'number').toBe(true);
  });
});
