import { describe, it, expect } from 'vitest';
import { screenList } from '../../scoring/screener.js';

describe('screenList', () => {
  const scored = [
    { symbol: 'AAA', score: 90, grade: 'A+', price: 100 },
    { symbol: 'BBB', score: 60, grade: 'B', price: 50 },
    { symbol: 'CCC', score: 30, grade: 'D', price: 10 },
    { symbol: 'DDD', score: 75, grade: 'A', price: 200 },
  ];
  it('filter minScore', () => {
    const r = screenList(scored, { minScore: 55 });
    expect(r.length).toBe(3);
    expect(r.find(x => x.symbol === 'CCC')).toBeUndefined();
  });
  it('sort by score desc', () => {
    const r = screenList(scored, {});
    expect(r[0].symbol).toBe('AAA');
    expect(r[1].symbol).toBe('DDD');
    expect(r[2].symbol).toBe('BBB');
  });
  it('limit', () => {
    const r = screenList(scored, { limit: 2 });
    expect(r.length).toBe(2);
  });
  it('filter grade', () => {
    const r = screenList(scored, { grade: 'A+' });
    expect(r.length).toBe(1);
    expect(r[0].symbol).toBe('AAA');
  });
});
