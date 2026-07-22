import { describe, it, expect } from 'vitest';
import { trendTemplate } from '../../ta/trend-template.js';

// Data "sạch" thỏa cả 8 rules: giá tăng đều, MA thẳng hàng
function cleanStage2(days = 250) {
  const closes = [], dates = [];
  const base = new Date(Date.UTC(2024, 0, 1));
  for (let i = 0; i < days; i++) {
    closes.push(100 + i * 0.3);   // tăng chậm đều
    const d = new Date(base.getTime() + i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }
  return { dates, closes };
}

describe('trendTemplate (8 rules Minervini)', () => {
  it('pass=true cho Stage 2 sạch', () => {
    const r = trendTemplate(cleanStage2(250));
    expect(r.pass).toBe(true);
    expect(r.rules.every(Boolean)).toBe(true);
  });
  it('rule 7 fail khi giá gần 52w low (dưới 30%)', () => {
    const data = cleanStage2(250);
    // ép giá cuối = 52w low + 10% (vi phạm rule 7: cần ≥30%)
    data.closes[data.closes.length - 1] = data.closes[0] * 1.10;
    const r = trendTemplate(data);
    expect(r.rules[6]).toBe(false); // rule index 6 = rule số 7
    expect(r.pass).toBe(false);
  });
  it('chuỗi quá ngắn (<200) → pass=false', () => {
    const r = trendTemplate(cleanStage2(150));
    expect(r.pass).toBe(false);
  });
});
