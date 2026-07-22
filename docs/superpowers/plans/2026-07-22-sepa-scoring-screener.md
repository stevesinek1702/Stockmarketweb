# Subsystem #2: SEPA Scoring + Screener — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** Composite SEPA score (0-100) per stock + ranked screener endpoint, replacing the 5-threshold binary scanner.

**Architecture:** `server/scoring/` module with pure `computeSEPA(ta)` + `screenAll()`; depends on `server/ta/` (#1). TDD with crafted TA fixtures.

**Spec:** `docs/superpowers/specs/2026-07-22-sepa-scoring-screener-design.md`

**Test command:** `cd server && npx vitest run __tests__/scoring/` (pure, no DB).

---

## Task 1: `computeSEPA` scoring module (TDD)

**Files:**
- Create: `server/scoring/score.js`
- Create: `server/__tests__/scoring/score.test.js`

- [ ] **Step 1: Write failing test** with crafted TA fixtures:

```js
import { describe, it, expect } from 'vitest';
import { computeSEPA, gradeFor } from '../../scoring/score.js';

// TA fixture "perfect setup" — all factors maxed
const perfectTA = {
  mas: { ma50: 100, ma150: 99, ma200: 98, ma200Rising: true },
  momentum: { macd: { histogram: [0.5] } },
  trend: { adx: 40, diPlus: 30, diMinus: 10, trendStrength: 'strong' },
  bollinger: { squeeze: true },
  sepa: {
    trendTemplate: { pass: true, rules: [true,true,true,true,true,true,true,true] },
    vcp: { isVCP: true, tightness: 3 },
    pocketPivot: { detected: true, volumeRatio: 2.5 }
  }
};
// TA fixture "weak setup"
const weakTA = {
  mas: { ma50: 90, ma150: 100, ma200: 105, ma200Rising: false },
  momentum: { macd: { histogram: [-0.5] } },
  trend: { adx: 12, diPlus: 15, diMinus: 25, trendStrength: 'ranging' },
  bollinger: { squeeze: false },
  sepa: {
    trendTemplate: { pass: false, rules: [false,false,false,false,false,false,false,true] },
    vcp: { isVCP: false, tightness: 30 },
    pocketPivot: { detected: false, volumeRatio: 0.8 }
  }
};

describe('computeSEPA', () => {
  it('perfect setup → high score (≥85, grade A+)', () => {
    const r = computeSEPA(perfectTA, { rsRating: 95 });
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.grade).toBe('A+');
    expect(r.breakdown.trendTemplate).toBe(100);
    expect(r.breakdown.adx).toBe(100);
  });
  it('weak setup → low score (<40, grade D)', () => {
    const r = computeSEPA(weakTA, { rsRating: 30 });
    expect(r.score).toBeLessThan(40);
    expect(r.grade).toBe('D');
    expect(r.breakdown.trendTemplate).toBeLessThan(30);
  });
  it('score in [0,100]', () => {
    const r1 = computeSEPA(perfectTA, { rsRating: 100 });
    const r2 = computeSEPA(weakTA, { rsRating: 0 });
    expect(r1.score).toBeLessThanOrEqual(100);
    expect(r2.score).toBeGreaterThanOrEqual(0);
  });
  it('gradeFor maps correctly', () => {
    expect(gradeFor(90)).toBe('A+');
    expect(gradeFor(75)).toBe('A');
    expect(gradeFor(60)).toBe('B');
    expect(gradeFor(45)).toBe('C');
    expect(gradeFor(20)).toBe('D');
  });
  it('RS rating weighted 15%', () => {
    const hi = computeSEPA(perfectTA, { rsRating: 100 });
    const lo = computeSEPA(perfectTA, { rsRating: 0 });
    // RS diff = 100 points * 15% = 15 score points
    expect(hi.score - lo.score).toBeCloseTo(15, 0);
  });
});
```

- [ ] **Step 2: Run — confirm FAIL** (`npx vitest run __tests__/scoring/score.test.js`).

- [ ] **Step 3: Implement `server/scoring/score.js`**:

```js
/**
 * SEPA Composite Score (0-100) from TA output (computeTA from server/ta/).
 * 9 factors weighted per spec §2.2.
 * @param {object} ta output of computeTA()
 * @param {object} [opts] { rsRating?: 0-100 }  (RS computed by caller/screener)
 * @returns {{score:number, grade:string, breakdown:object}}
 */
function computeSEPA(ta, opts) {
  const rs = (opts && typeof opts.rsRating === 'number') ? opts.rsRating : 50;

  // Factor 1: Trend Template (25%)
  const tt = ta.sepa.trendTemplate;
  const fTT = tt.pass ? 100 : (tt.rules.filter(Boolean).length / 8) * 100;

  // Factor 2: Trend Strength ADX (15%): adx*2.5 capped 100
  const fADX = Math.min(100, (ta.trend.adx || 0) * 2.5);

  // Factor 3: VCP tightness (15%)
  const vcp = ta.sepa.vcp;
  let fVCP = 0;
  if (vcp.isVCP) fVCP = 100;
  else if (vcp.tightness != null && vcp.tightness <= 15) fVCP = 100 - vcp.tightness * 4;

  // Factor 4: RS rating (15%) — direct
  const fRS = Math.max(0, Math.min(100, rs));

  // Factor 5: MA alignment (10%)
  const m = ta.mas;
  let fMA = 0;
  if (m.ma50 != null && m.ma150 != null && m.ma200 != null) {
    if (m.ma50 > m.ma150 && m.ma150 > m.ma200) fMA = 100;
    else if (m.ma50 > m.ma150 || m.ma150 > m.ma200) fMA = 50;
  }

  // Factor 6: Momentum MACD hist (8%)
  const histArr = ta.momentum.macd.histogram;
  const hist = Array.isArray(histArr) && histArr.length ? histArr[histArr.length - 1] : 0;
  const fMACD = hist > 0 ? 100 : Math.max(0, 50 + hist * 50); // negative hist reduces

  // Factor 7: Pocket pivot volume (5%)
  const pp = ta.sepa.pocketPivot;
  const fPP = pp.detected ? 100 : Math.min(100, (pp.volumeRatio || 0) * 50);

  // Factor 8: Distance to MA20 (4%) — caller must pass distMA20 if wants; default neutral
  const fDist = (opts && typeof opts.distMA20 === 'number')
    ? (opts.distMA20 >= 0 && opts.distMA20 <= 8 ? 100 - opts.distMA20 * 5 : Math.max(0, 60 - opts.distMA20 * 3))
    : 50;

  // Factor 9: Bollinger squeeze (3%)
  const fSq = ta.bollinger.squeeze ? 100 : 0;

  const breakdown = {
    trendTemplate: Math.round(fTT), adx: Math.round(fADX), vcp: Math.round(fVCP),
    rs: Math.round(fRS), maAlignment: Math.round(fMA), macd: Math.round(fMACD),
    pocketPivot: Math.round(fPP), distMA20: Math.round(fDist), squeeze: Math.round(fSq)
  };

  const score = Math.round(
    fTT * 0.25 + fADX * 0.15 + fVCP * 0.15 + fRS * 0.15 + fMA * 0.10 +
    fMACD * 0.08 + fPP * 0.05 + fDist * 0.04 + fSq * 0.03
  );

  return { score: Math.max(0, Math.min(100, score)), grade: gradeFor(score), breakdown };
}

function gradeFor(score) {
  if (score >= 85) return 'A+';
  if (score >= 70) return 'A';
  if (score >= 55) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

module.exports = { computeSEPA, gradeFor };
```

- [ ] **Step 4: Run — confirm PASS.**

- [ ] **Step 5: Commit**
```bash
git add server/scoring/score.js server/__tests__/scoring/score.test.js
git commit -m "feat(scoring): computeSEPA composite score (0-100) + grade + tests"
```

---

## Task 2: RS rating helper (`scoring/rs.js`)

**Files:**
- Create: `server/scoring/rs.js`
- Create: `server/__tests__/scoring/rs.test.js`

- [ ] **Step 1: Write failing test**:

```js
import { describe, it, expect } from 'vitest';
import { rsRating } from '../../scoring/rs.js';

describe('rsRating', () => {
  it('mã outperform VNINDEX → RS > 50', () => {
    // mã tăng 10% 50 phiên, VNINDEX tăng 2% → RS cao
    const stock = Array.from({ length: 60 }, (_, i) => 100 + i * 0.2);
    const bench = Array.from({ length: 60 }, (_, i) => 100 + i * 0.04);
    const r = rsRating(stock, bench);
    expect(r).toBeGreaterThan(60);
  });
  it('mã underperform → RS < 50', () => {
    const stock = Array.from({ length: 60 }, (_, i) => 100 - i * 0.1);
    const bench = Array.from({ length: 60 }, (_, i) => 100 + i * 0.1);
    expect(rsRating(stock, bench)).toBeLessThan(40);
  });
  it('thiếu benchmark → fallback momentum percentile (không crash)', () => {
    const stock = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const r = rsRating(stock, null);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run — confirm FAIL.**

- [ ] **Step 3: Implement `server/scoring/rs.js`**:

```js
/**
 * Relative Strength rating 0-100 (Mansfield-style simplified).
 * RS = percentile rank của (stock 50-session return / benchmark 50-session return).
 * Benchmark = VNINDEX closes; nếu thiếu → fallback = stock return percentile.
 *
 * @param {number[]} stockCloses
 * @param {number[]|null} benchCloses  VNINDEX closes (same length)
 * @returns {number} 0-100
 */
function rsRating(stockCloses, benchCloses) {
  const period = Math.min(50, stockCloses.length - 1);
  if (period < 10) return 50;
  const stockRet = (stockCloses[stockCloses.length - 1] / stockCloses[stockCloses.length - 1 - period] - 1) * 100;
  if (!benchCloses || benchCloses.length < period + 1) {
    // Fallback: stock return mapped to 0-100 (0%→50, +20%→100, -20%→0)
    return Math.max(0, Math.min(100, 50 + stockRet * 2.5));
  }
  const benchRet = (benchCloses[benchCloses.length - 1] / benchCloses[benchCloses.length - 1 - period] - 1) * 100;
  // RS = outperformance; 0% outperform→50, +10%→100, -10%→0
  const out = stockRet - benchRet;
  return Math.max(0, Math.min(100, 50 + out * 5));
}

module.exports = { rsRating };
```

- [ ] **Step 4: Run — confirm PASS.**

- [ ] **Step 5: Commit**
```bash
git add server/scoring/rs.js server/__tests__/scoring/rs.test.js
git commit -m "feat(scoring): RS rating helper (Mansfield-simplified) + tests"
```

---

## Task 3: Screener + barrel + endpoints

**Files:**
- Create: `server/scoring/screener.js`
- Create: `server/scoring/index.js`
- Create: `server/__tests__/scoring/screener.test.js`
- Modify: `server/server.js` (add 2 endpoints)

- [ ] **Step 1: Write failing test for screener**:

```js
import { describe, it, expect } from 'vitest';
import { screenList } from '../../scoring/screener.js';

describe('screenList', () => {
  // Fake scored list
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
```

- [ ] **Step 2: Run — confirm FAIL.**

- [ ] **Step 3: Implement `server/scoring/screener.js`**:

```js
const { computeTA } = require('../ta');
const { computeSEPA } = require('./score');
const { rsRating } = require('./rs');
const { getHistory } = require('../ta/price-history');

/**
 * Screen + rank danh sách symbol đã chấm điểm.
 * Pure filter/sort — testable without DB.
 */
function screenList(scored, opts) {
  const minScore = (opts && opts.minScore) || 0;
  const limit = (opts && opts.limit) || 50;
  const grade = opts && opts.grade;
  let r = scored.filter(s => s.score >= minScore);
  if (grade) r = r.filter(s => s.grade === grade);
  r.sort((a, b) => b.score - a.score);
  return r.slice(0, limit);
}

/**
 * Scan toàn bộ symbol trong price-history → score → rank.
 * Heavy: lặp qua ~1500 mã. Cache 5 phút ở endpoint.
 */
async function screenAll(opts) {
  const minScore = (opts && opts.minScore) || 55;
  const limit = (opts && opts.limit) || 50;
  const grade = opts && opts.grade;
  const { getMeta } = require('../ta/price-history');
  const meta = getMeta();
  // Lấy benchmark VNINDEX cho RS
  const vnindex = getHistory('VNINDEX') || getHistory('VNINDEX');
  const benchCloses = vnindex ? vnindex.closes || (vnindex.ohlc || []).map(x => x.c) : null;

  const symbols = Object.keys(require('../ta/price-history')._loadSymbols ? 
    require('../ta/price-history')._loadSymbols() : {});
  const scored = [];
  for (const symbol of symbols) {
    if (symbol === 'VNINDEX') continue;
    const h = getHistory(symbol);
    if (!h || !h.ohlc || h.ohlc.length < 60) continue;
    try {
      const ta = computeTA(h);
      if (!ta) continue;
      const closes = h.ohlc.map(x => x.c);
      const rs = rsRating(closes, benchCloses);
      const last = h.ohlc.length - 1;
      const ma20 = closes.slice(-20).reduce((s,v)=>s+v,0)/20;
      const distMA20 = ((closes[last] - ma20)/ma20)*100;
      const change = last > 0 ? ((closes[last]-closes[last-1])/closes[last-1])*100 : 0;
      const r = computeSEPA(ta, { rsRating: rs, distMA20 });
      scored.push({
        symbol, score: r.score, grade: r.grade, price: closes[last],
        change: Math.round(change*100)/100, breakdown: r.breakdown,
        ta: {
          trendTemplatePass: ta.sepa.trendTemplate.pass,
          vcp: ta.sepa.vcp.isVCP,
          pocketPivot: ta.sepa.pocketPivot.detected,
          adx: Math.round(ta.trend.adx||0)
        }
      });
    } catch (e) { /* skip symbol on error */ }
  }
  const filtered = screenList(scored, { minScore, limit, grade });
  return {
    success: true,
    timestamp: new Date().toISOString(),
    source: 'sepa-scoring',
    scanned: scored.length,
    filtered: filtered.length,
    results: filtered
  };
}

module.exports = { screenList, screenAll };
```

- [ ] **Step 4: Implement barrel `server/scoring/index.js`**:

```js
const { computeSEPA, gradeFor } = require('./score');
const { rsRating } = require('./rs');
const { screenList, screenAll } = require('./screener');
module.exports = { computeSEPA, gradeFor, rsRating, screenList, screenAll };
```

- [ ] **Step 5: Implement endpoints in `server/server.js`** (insert near `/api/ta/:symbol`, ~line 3260):

```js
const { computeSEPA } = require('./scoring');
const { screenAll } = require('./scoring/screener');

app.get('/api/sepa-score/:symbol', (req, res) => {
    try {
        const symbol = String(req.params.symbol||'').toUpperCase().trim();
        const { getHistory } = require('./ta/price-history');
        const { computeTA } = require('./ta');
        const { rsRating } = require('./scoring/rs');
        const h = getHistory(symbol);
        if (!h || !h.ohlc || h.ohlc.length < 60)
            return res.status(404).json({ success:false, error:'Chưa đủ data' });
        const ta = computeTA(h);
        const closes = h.ohlc.map(x=>x.c);
        const vnindex = getHistory('VNINDEX');
        const bench = vnindex ? (vnindex.closes||vnindex.ohlc.map(x=>x.c)) : null;
        const rs = rsRating(closes, bench);
        const r = computeSEPA(ta, { rsRating: rs });
        res.json({ success:true, symbol, ...r, ta });
    } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/sepa-scan', async (req, res) => {
    try {
        const minScore = parseInt(req.query.minScore) || 55;
        const limit = parseInt(req.query.limit) || 50;
        const grade = req.query.grade;
        const r = await screenAll({ minScore, limit, grade });
        res.json(r);
    } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
```

- [ ] **Step 6: Run screener test — confirm PASS.**

- [ ] **Step 7: Verify server.js syntax** (`node --check server/server.js`).

- [ ] **Step 8: Commit**
```bash
git add server/scoring/ server/__tests__/scoring/ server/server.js
git commit -m "feat(scoring): screener + endpoints /api/sepa-scan + /api/sepa-score/:symbol"
```

---

## Verification
1. `npx vitest run __tests__/scoring/` — all pass.
2. `node --check server/server.js` OK.
3. After backfill (VPS): `curl /api/sepa-scan?minScore=70 | jq '.results[0]'` returns top-ranked stock.

## Self-Review
- [x] Spec coverage: score (Task 1), RS (Task 2), screener+endpoints (Task 3). ✓
- [x] No placeholders. ✓
- [x] computeSEPA return shape consistent across tasks. ✓
- [x] screenAll reuses #1 computeTA + price-history. ✓
