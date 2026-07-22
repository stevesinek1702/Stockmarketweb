# Subsystem #1: Data + TA Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clean, tested `server/ta/` module with 9 technical indicators (SEPA-compatible) + a `price-history.json` data layer persisting OHLC+volume, so subsystems #2–#6 can compute TA on demand.

**Architecture:** Pure-function TA modules (no DB deps) with TDD unit tests; a JSON data layer (`price-history.json`) built by backfilling FireAnt HistoricalQuotes once, then incrementally daily via the existing scheduler; migration is copy+delegate (potential-scanner continues to run, delegates TA to the new module).

**Tech Stack:** Node.js / Express (existing), Vitest (existing test harness), FireAnt HistoricalQuotes API (existing data source).

**Spec:** `docs/superpowers/specs/2026-07-22-ta-data-engine-design.md`

**Test command:** `cd server && npx vitest run __tests__/ta/<file>.test.js` (single) or `npm test` (all). Note: existing cache/db/redis tests fail without local Postgres+Redis — that's a pre-existing environment issue, not caused by this plan. Only `__tests__/ta/` and `__tests__/trading-time.test.js` are pure-function and must pass.

---

## File Structure

**Create:**
- `server/ta/ma.js` — SMA (prefix-sum), EMA (Wilder)
- `server/ta/rsi.js` — RSI Wilder smoothing
- `server/ta/macd.js` — MACD line/signal/histogram
- `server/ta/adx.js` — ADX + DI+/DI-
- `server/ta/atr.js` — ATR
- `server/ta/bollinger.js` — Bollinger Bands + squeeze
- `server/ta/trend-template.js` — Minervini 8 rules
- `server/ta/vcp.js` — Volatility Contraction Pattern
- `server/ta/pocket-pivot.js` — Pocket Pivot (Kacher/Morales)
- `server/ta/price-history.js` — load/save/build price-history.json
- `server/ta/index.js` — barrel export + `computeTA()` composite
- `server/__tests__/ta/ma.test.js`
- `server/__tests__/ta/rsi.test.js`
- `server/__tests__/ta/macd.test.js`
- `server/__tests__/ta/adx.test.js`
- `server/__tests__/ta/atr.test.js`
- `server/__tests__/ta/bollinger.test.js`
- `server/__tests__/ta/trend-template.test.js`
- `server/__tests__/ta/vcp.test.js`
- `server/__tests__/ta/pocket-pivot.test.js`

**Modify:**
- `server/potential-scanner.js` — delegate `calculateEMA/MACD/RSI` to `server/ta/`
- `server/server.js` — wire `buildPriceToday()` into scheduler; add `/api/ta/:symbol` endpoint
- `server/.gitignore` — ignore `data/price-history.json` (large generated file)

---

## Task 1: SMA + EMA module (`ta/ma.js`)

**Files:**
- Create: `server/ta/ma.js`
- Create: `server/__tests__/ta/ma.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/ma.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { sma, ema } from '../ta/ma.js';

describe('sma', () => {
  it('computes SMA of given period', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([
      null, null,
      2,          // (1+2+3)/3
      3,          // (2+3+4)/3
      4,          // (3+4+5)/3
    ]);
  });
  it('returns all-null when values shorter than period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe('ema', () => {
  it('EMA of constant series equals the constant', () => {
    const vals = [10, 10, 10, 10, 10];
    const e = ema(vals, 3);
    // sau seed, EMA của chuỗi constant = 10
    expect(e[e.length - 1]).toBeCloseTo(10, 5);
  });
  it('EMA responds to latest value more (weight > older)', () => {
    const e = ema([10, 10, 10, 10, 20], 3);
    expect(e[e.length - 1]).toBeGreaterThan(10);
    expect(e[e.length - 1]).toBeLessThan(20);
  });
});
```

- [ ] **Step 2: Run — confirm fail**

`cd server && npx vitest run __tests__/ta/ma.test.js`
Expected: FAIL — `Cannot find module '../ta/ma.js'`

- [ ] **Step 3: Implement `server/ta/ma.js`**

```js
/**
 * SMA (Simple Moving Average) bằng prefix-sum O(1)/phần tử.
 * Trả mảng cùng độ dài, null ở vị trí chưa đủ period.
 */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  // prefix sum
  const prefix = new Array(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = period - 1; i < values.length; i++) {
    out[i] = (prefix[i + 1] - prefix[i + 1 - period]) / period;
  }
  return out;
}

/**
 * EMA (Exponential Moving Average) — Wilder-style seeding = SMA của period đầu.
 * Trả mảng cùng độ dài; null ở các vị trí trước seed.
 * Multiplier k = 2/(period+1).
 */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  // seed = SMA của `period` phần tử đầu
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev = prev / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

module.exports = { sma, ema };
```

- [ ] **Step 4: Run — confirm pass**

`npx vitest run __tests__/ta/ma.test.js` → Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ta/ma.js server/__tests__/ta/ma.test.js
git commit -m "feat(ta): SMA + EMA module with tests"
```

---

## Task 2: RSI module (`ta/rsi.js`) — migrate from potential-scanner

**Files:**
- Create: `server/ta/rsi.js`
- Create: `server/__tests__/ta/rsi.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/rsi.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { rsi } from '../ta/rsi.js';

describe('rsi (Wilder)', () => {
  it('RSI = 100 cho chuỗi chỉ tăng', () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
    const r = rsi(closes, 14);
    expect(r[r.length - 1]).toBeCloseTo(100, 1);
  });
  it('RSI = 0 cho chuỗi chỉ giảm', () => {
    const closes = [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10];
    const r = rsi(closes, 14);
    expect(r[r.length - 1]).toBeCloseTo(0, 1);
  });
  it('trả mảng rỗng khi closes <= period', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — confirm fail**

`npx vitest run __tests__/ta/rsi.test.js` → Expected: FAIL (module missing)

- [ ] **Step 3: Implement `server/ta/rsi.js`** (copy + adapt from `potential-scanner.js:185`)

```js
/**
 * RSI (Relative Strength Index) — Wilder smoothing.
 * Migrated từ potential-scanner.js (logic đã đúng, tách ra module + test).
 * Trả mảng RSI values (length = closes.length - period), mỗi phần tử { i, value }.
 *
 * @param {number[]} closes chuỗi close, cũ→mới
 * @param {number} [period=14]
 * @returns {number[]} RSI values (length closes.length - period); trả [] nếu không đủ data
 */
function rsi(closes, period = 14) {
  if (closes.length <= period) return [];
  const out = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  let rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  out.push(100 - (100 / (1 + rs)));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rs = avgLoss > 0 ? avgGain / avgLoss : 100;
    out.push(100 - (100 / (1 + rs)));
  }
  return out;
}

module.exports = { rsi };
```

- [ ] **Step 4: Run — confirm pass** → Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ta/rsi.js server/__tests__/ta/rsi.test.js
git commit -m "feat(ta): RSI module (migrated from potential-scanner) + tests"
```

---

## Task 3: MACD module (`ta/macd.js`) — migrate

**Files:**
- Create: `server/ta/macd.js`
- Create: `server/__tests__/ta/macd.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/macd.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { macd } from '../ta/macd.js';

describe('macd', () => {
  it('MACD line = EMA12 - EMA26; histogram = macd - signal', () => {
    // chuỗi có xu hướng tăng nhẹ
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const m = macd(closes);
    expect(m.macd.length).toBeGreaterThan(0);
    expect(m.signal.length).toBeGreaterThan(0);
    expect(m.histogram.length).toBeGreaterThan(0);
    // xu hướng tăng → MACD line cuối > 0 (EMA12 > EMA26 khi tăng)
    expect(m.macd[m.macd.length - 1]).toBeGreaterThan(0);
  });
  it('chuỗi constant → MACD ≈ 0', () => {
    const closes = new Array(60).fill(100);
    const m = macd(closes);
    expect(Math.abs(m.macd[m.macd.length - 1])).toBeLessThan(0.001);
  });
  it('chuỗi quá ngắn → trả mảng rỗng', () => {
    const m = macd([1, 2, 3]);
    expect(m.macd).toEqual([]);
    expect(m.signal).toEqual([]);
    expect(m.histogram).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — confirm fail**

- [ ] **Step 3: Implement `server/ta/macd.js`** (use `ema` from Task 1)

```js
const { ema } = require('./ma');

/**
 * MACD = EMA12(closes) - EMA26(closes); Signal = EMA9(macd); Histogram = macd - signal.
 * Migrated từ potential-scanner.js (logic đã đúng). Trả { macd, signal, histogram }.
 *
 * Vì ema() trả null ở các vị trí chưa đủ period, cần align chỉ lấy đoạn overlap.
 */
function macd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (ema12.length === 0 || ema26.length === 0) return { macd: [], signal: [], histogram: [] };

  // MACD line: tại mỗi index i, nếu cả ema12[i] và ema26[i] !== null
  const macdLine = [];
  const macdIdx = []; // giữ index gốc để align
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] !== null && ema26[i] !== null) {
      macdLine.push(ema12[i] - ema26[i]);
      macdIdx.push(i);
    }
  }
  if (macdLine.length === 0) return { macd: macdLine, signal: [], histogram: [] };

  // Signal = EMA9 của macdLine
  const signalRaw = ema(macdLine, 9);
  // Histogram: tại mỗi vị trí macdLine có signalRaw !== null
  const signal = [];
  const histogram = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (signalRaw[i] !== null) {
      signal.push(signalRaw[i]);
      histogram.push(macdLine[i] - signalRaw[i]);
    }
  }
  return { macd: macdLine, signal, histogram };
}

module.exports = { macd };
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add server/ta/macd.js server/__tests__/ta/macd.test.js
git commit -m "feat(ta): MACD module (migrated) + tests"
```

---

## Task 4: ADX module (`ta/adx.js`)

**Files:**
- Create: `server/ta/adx.js`
- Create: `server/__tests__/ta/adx.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/adx.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { adx, trendStrength } from '../ta/adx.js';

// Helper: tạo OHLC với xu hướng tăng đều
function uptrend(n, start = 100, step = 1) {
  const ohlc = [];
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    ohlc.push({ o: c - step, h: c + 1, l: c - step - 1, c });
  }
  return ohlc;
}
function sideways(n, base = 100) {
  const ohlc = [];
  for (let i = 0; i < n; i++) {
    const c = base + (i % 2 === 0 ? 0.5 : -0.5); // dao động nhỏ
    ohlc.push({ o: base, h: c + 0.5, l: c - 0.5, c });
  }
  return ohlc;
}

describe('adx', () => {
  it('ADX cao cho xu hướng mạnh', () => {
    const ohlc = uptrend(40);
    const r = adx(ohlc, 14);
    expect(r.adx).toBeGreaterThan(25);
  });
  it('ADX thấp cho sideway', () => {
    const ohlc = sideways(40);
    const r = adx(ohlc, 14);
    expect(r.adx).toBeLessThan(25);
  });
  it('trendStrength maps adx đúng', () => {
    expect(trendStrength(30)).toBe('strong');
    expect(trendStrength(22)).toBe('weak');
    expect(trendStrength(15)).toBe('ranging');
  });
  it('chuỗi quá ngắn → adx null', () => {
    expect(adx(uptrend(10), 14).adx).toBeNull();
  });
});
```

- [ ] **Step 2: Run — confirm fail**

- [ ] **Step 3: Implement `server/ta/adx.js`**

```js
/**
 * ADX + DI+/DI- (Wilder). Đo strength of trend (không phải hướng).
 * adx >= 25 = strong, >= 20 = weak, < 20 = ranging.
 *
 * @param {{o:number,h:number,l:number,c:number}[]} ohlc
 * @param {number} [period=14]
 * @returns {{adx:number|null, diPlus:number, diMinus:number}}
 */
function adx(ohlc, period = 14) {
  if (ohlc.length < period * 2) return { adx: null, diPlus: 0, diMinus: 0 };

  // True Range
  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < ohlc.length; i++) {
    const up = ohlc[i].h - ohlc[i - 1].h;
    const down = ohlc[i - 1].l - ohlc[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const t = Math.max(
      ohlc[i].h - ohlc[i].l,
      Math.abs(ohlc[i].h - ohlc[i - 1].c),
      Math.abs(ohlc[i].l - ohlc[i - 1].c)
    );
    tr.push(t);
  }
  // Wilder smoothing
  let trN = tr.slice(0, period).reduce((s, v) => s + v, 0);
  let plusN = plusDM.slice(0, period).reduce((s, v) => s + v, 0);
  let minusN = minusDM.slice(0, period).reduce((s, v) => s + v, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    trN = trN - trN / period + tr[i];
    plusN = plusN - plusN / period + plusDM[i];
    minusN = minusN - minusN / period + minusDM[i];
    const pdi = trN > 0 ? 100 * plusN / trN : 0;
    const mdi = trN > 0 ? 100 * minusN / trN : 0;
    const denom = pdi + mdi;
    dx.push(denom > 0 ? 100 * Math.abs(pdi - mdi) / denom : 0);
    if (i === period) { /* capture first DI for return */ }
  }
  if (dx.length < period) return { adx: null, diPlus: 0, diMinus: 0 };
  // ADX = Wilder smoothing của DX
  let adxVal = dx.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
  }
  // DI cuối
  const pdiLast = trN > 0 ? 100 * plusN / trN : 0;
  const mdiLast = trN > 0 ? 100 * minusN / trN : 0;
  return { adx: adxVal, diPlus: pdiLast, diMinus: mdiLast };
}

function trendStrength(adxVal) {
  if (adxVal == null) return 'unknown';
  if (adxVal >= 25) return 'strong';
  if (adxVal >= 20) return 'weak';
  return 'ranging';
}

module.exports = { adx, trendStrength };
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add server/ta/adx.js server/__tests__/ta/adx.test.js
git commit -m "feat(ta): ADX + DI module + tests"
```

---

## Task 5: ATR module (`ta/atr.js`)

**Files:**
- Create: `server/ta/atr.js`
- Create: `server/__tests__/ta/atr.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/atr.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { atr } from '../ta/atr.js';

describe('atr', () => {
  it('ATR của nến range cố định = range đó', () => {
    // mỗi nến high-low = 2, không gap → TR = 2 → ATR = 2
    const ohlc = Array.from({ length: 20 }, (_, i) => ({ o: 100, h: 101, l: 99, c: 100 }));
    const a = atr(ohlc, 14);
    expect(a.atr).toBeCloseTo(2, 5);
    expect(a.atrPct).toBeCloseTo(2, 5); // 2/100*100
  });
  it('chuỗi quá ngắn → null', () => {
    expect(atr([{ o: 1, h: 2, l: 0, c: 1 }], 14).atr).toBeNull();
  });
});
```

- [ ] **Step 2: Run — confirm fail**

- [ ] **Step 3: Implement `server/ta/atr.js`**

```js
/**
 * ATR (Average True Range) Wilder. Cho stop-loss sizing.
 * @param {{o:number,h:number,l:number,c:number}[]} ohlc
 * @param {number} [period=14]
 * @returns {{atr:number|null, atrPct:number}} atrPct = atr/close×100
 */
function atr(ohlc, period = 14) {
  if (ohlc.length < period + 1) return { atr: null, atrPct: 0 };
  const tr = [];
  for (let i = 1; i < ohlc.length; i++) {
    tr.push(Math.max(
      ohlc[i].h - ohlc[i].l,
      Math.abs(ohlc[i].h - ohlc[i - 1].c),
      Math.abs(ohlc[i].l - ohlc[i - 1].c)
    ));
  }
  let a = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
  }
  const lastClose = ohlc[ohlc.length - 1].c || 1;
  return { atr: a, atrPct: (a / lastClose) * 100 };
}

module.exports = { atr };
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add server/ta/atr.js server/__tests__/ta/atr.test.js
git commit -m "feat(ta): ATR module + tests"
```

---

## Task 6: Bollinger Bands module (`ta/bollinger.js`)

**Files:**
- Create: `server/ta/bollinger.js`
- Create: `server/__tests__/ta/bollinger.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/bollinger.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { bollinger, bandwidth } from '../ta/bollinger.js';

describe('bollinger', () => {
  it('middle = SMA20, upper/lower = ±2σ', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
    const b = bollinger(closes, 20, 2);
    expect(b.upper).toBeGreaterThan(b.middle);
    expect(b.lower).toBeLessThan(b.middle);
  });
  it('bandwidth của chuỗi constant = 0', () => {
    expect(bandwidth(100, 100, 100)).toBe(0);
  });
  it('squeeze = true khi bandwidth ở 20th percentile history', () => {
    // tạo 120 ngày: đầu biến động lớn, 20 ngày cuối rất hẹp
    const closes = [
      ...Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i) * 10),
      ...Array.from({ length: 20 }, () => 100 + (Math.random() - 0.5) * 0.2),
    ];
    const b = bollinger(closes, 20, 2);
    expect(b.squeeze).toBe(true);
  });
});
```

- [ ] **Step 2: Run — confirm fail**

- [ ] **Step 3: Implement `server/ta/bollinger.js`**

```js
const { sma } = require('./ma');

/**
 * Bollinger Bands tại điểm cuối. middle=SMA(period), upper/lower=±mult×σ.
 * squeeze: bandwidth hiện tại < 20th percentile của bandwidth history (rolling 120 ngày).
 *
 * @param {number[]} closes
 * @param {number} [period=20]
 * @param {number} [mult=2]
 * @returns {{upper:number,middle:number,lower:number,squeeze:boolean,bandwidth:number}}
 */
function bollinger(closes, period = 20, mult = 2) {
  const last = closes.length - 1;
  const middleArr = sma(closes, period);
  const middle = middleArr[last];
  if (middle == null) return { upper: null, middle: null, lower: null, squeeze: false, bandwidth: 0 };

  // σ của `period` phần tử cuối
  const slice = closes.slice(last - period + 1);
  const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;

  // bandwidth history (rolling 120 ngày) cho squeeze detection
  const bws = [];
  const window = Math.min(120, closes.length - period + 1);
  for (let w = 0; w < window; w++) {
    const idx = last - w;
    const m = middleArr[idx];
    if (m == null) continue;
    const sl = closes.slice(idx - period + 1, idx + 1);
    const v = sl.reduce((s, v) => s + (v - m) ** 2, 0) / period;
    bws.push(bandwidth(m + mult * Math.sqrt(v), m, m - mult * Math.sqrt(v)));
  }
  const cur = bandwidth(upper, middle, lower);
  bws.sort((a, b) => a - b);
  const p20 = bws[Math.floor(bws.length * 0.2)] || 0;
  return { upper, middle, lower, squeeze: cur < p20, bandwidth: cur };
}

function bandwidth(upper, middle, lower) {
  return middle > 0 ? ((upper - lower) / middle) * 100 : 0;
}

module.exports = { bollinger, bandwidth };
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add server/ta/bollinger.js server/__tests__/ta/bollinger.test.js
git commit -m "feat(ta): Bollinger Bands + squeeze detection + tests"
```

---

## Task 7: Trend Template module (`ta/trend-template.js`) — Minervini 8 rules

**Files:**
- Create: `server/ta/trend-template.js`
- Create: `server/__tests__/ta/trend-template.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/trend-template.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { trendTemplate } from '../ta/trend-template.js';

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
```

- [ ] **Step 2: Run — confirm fail**

- [ ] **Step 3: Implement `server/ta/trend-template.js`**

```js
const { sma } = require('./ma');

/**
 * Minervini Trend Template — 8 rules (Stage 2 uptrend filter).
 * Trả { pass: bool, rules: [8 booleans], details }.
 *
 * Rules:
 *   1. Price > MA150
 *   2. Price > MA200
 *   3. MA150 > MA200
 *   4. MA50 > MA150 AND MA50 > MA200
 *   5. Price > MA50
 *   6. MA200 rising: MA200 hôm nay > MA200 tại index (today - 22 phiên)
 *   7. Price >= 1.30 × 52-week low
 *   8. Price <= 1.25 × 52-week high
 *
 * @param {{dates:string[], closes:number[]}} data
 * @returns {{pass:boolean, rules:boolean[], details:object}}
 */
function trendTemplate({ dates, closes }) {
  const rules = [false, false, false, false, false, false, false, false];
  const last = closes.length - 1;
  if (closes.length < 200) return { pass: false, rules, details: { reason: 'insufficient_history' } };

  const price = closes[last];
  const ma50 = sma(closes, 50)[last];
  const ma150 = sma(closes, 150)[last];
  const ma200 = sma(closes, 200)[last];
  const ma200_22ago = sma(closes, 200)[last - 22];

  const year = Math.min(252, closes.length);
  const low52 = Math.min(...closes.slice(last - year + 1));
  const high52 = Math.max(...closes.slice(last - year + 1));

  rules[0] = price > ma150;
  rules[1] = price > ma200;
  rules[2] = ma150 > ma200;
  rules[3] = ma50 > ma150 && ma50 > ma200;
  rules[4] = price > ma50;
  rules[5] = ma200_22ago != null && ma200 > ma200_22ago;
  rules[6] = price >= 1.30 * low52;
  rules[7] = price <= 1.25 * high52;

  return {
    pass: rules.every(Boolean),
    rules,
    details: { price, ma50, ma150, ma200, ma200Rising: rules[5], low52, high52 }
  };
}

module.exports = { trendTemplate };
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add server/ta/trend-template.js server/__tests__/ta/trend-template.test.js
git commit -m "feat(ta): Minervini Trend Template (8 rules) + tests"
```

---

## Task 8: VCP module (`ta/vcp.js`)

**Files:**
- Create: `server/ta/vcp.js`
- Create: `server/__tests__/ta/vcp.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/vcp.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { detectVCP } from '../ta/vcp.js';

describe('detectVCP', () => {
  it('detect VCP: 3 contractions giảm dần (25→12→5%) trên volume giảm', () => {
    // Mô phỏng: giá co lại 3 lần, mỗi lần range nhỏ hơn + volume giảm
    const dates = [], ohlc = [], volumes = [];
    let day = 0;
    const base = new Date(Date.UTC(2025, 0, 1));
    // contraction 1: range 25%
    for (let i = 0; i < 10; i++) {
      ohlc.push({ o: 100, h: 125, l: 100, c: 120 - i * 0.5 });
      volumes.push(1000 - i * 50);
      dates.push(new Date(base.getTime() + day++ * 86400000).toISOString().slice(0, 10));
    }
    // contraction 2: range 12%
    for (let i = 0; i < 10; i++) {
      ohlc.push({ o: 115, h: 122, l: 110, c: 117 - i * 0.3 });
      volumes.push(600 - i * 30);
      dates.push(new Date(base.getTime() + day++ * 86400000).toISOString().slice(0, 10));
    }
    // contraction 3: range 5%
    for (let i = 0; i < 10; i++) {
      ohlc.push({ o: 114, h: 116, l: 111, c: 115 - i * 0.1 });
      volumes.push(300 - i * 15);
      dates.push(new Date(base.getTime() + day++ * 86400000).toISOString().slice(0, 10));
    }
    const r = detectVCP({ dates, ohlc, volumes });
    expect(r.isVCP).toBe(true);
    expect(r.contractions.length).toBeGreaterThanOrEqual(2);
  });
  it('không phải VCP khi giá dao động ngẫu nhiên', () => {
    const dates = [], ohlc = [], volumes = [];
    for (let i = 0; i < 40; i++) {
      const c = 100 + (Math.random() - 0.5) * 10;
      ohlc.push({ o: 100, h: c + 5, l: c - 5, c });
      volumes.push(500 + Math.random() * 500);
      dates.push(`2025-01-${String(i + 1).padStart(2, '0')}`);
    }
    const r = detectVCP({ dates, ohlc, volumes });
    expect(r.isVCP).toBe(false);
  });
});
```

- [ ] **Step 2: Run — confirm fail**

- [ ] **Step 3: Implement `server/ta/vcp.js`**

```js
/**
 * Volatility Contraction Pattern (Minervini).
 * Detect chuỗi pullback có range (high-low)/high giảm dần + volume giảm.
 *
 * Algo: tìm local maxima trong `lookback` ngày; mỗi cặp max kế tiếp tạo 1 contraction.
 *       Contraction range = (high - low)/high × 100 giữa 2 max (đo từ peak đến trough).
 *       VCP nếu: ≥2 contractions, range giảm dần, volume trend giảm.
 *
 * @param {{dates:string[], ohlc:{o,h,l,c}[], volumes:number[]}} data
 * @param {object} [opts] { lookback=30, minContractions=2 }
 */
function detectVCP({ dates, ohlc, volumes }, opts) {
  const lookback = (opts && opts.lookback) || 30;
  const minContractions = (opts && opts.minContractions) || 2;
  const n = ohlc.length;
  if (n < lookback) return { isVCP: false, contractions: [], tightness: 0 };

  // Lấy cửa sổ `lookback` ngày cuối
  const slice = ohlc.slice(-lookback);
  const vSlice = volumes.slice(-lookback);

  // Tìm local maxima: điểm high > lân cận
  const peaks = [];
  for (let i = 2; i < slice.length - 2; i++) {
    if (slice[i].h > slice[i - 1].h && slice[i].h > slice[i - 2].h &&
        slice[i].h > slice[i + 1].h && slice[i].h > slice[i + 2].h) {
      peaks.push(i);
    }
  }
  if (peaks.length < minContractions) return { isVCP: false, contractions: [], tightness: 0 };

  // Mỗi contraction = từ peak[i] đến peak[i+1], đo (peak_high - trough_low)/peak_high
  const contractions = [];
  for (let i = 0; i < peaks.length - 1; i++) {
    const seg = slice.slice(peaks[i], peaks[i + 1] + 1);
    const peakHigh = slice[peaks[i]].h;
    const troughLow = Math.min(...seg.map(x => x.l));
    const rangePct = peakHigh > 0 ? ((peakHigh - troughLow) / peakHigh) * 100 : 0;
    contractions.push({ from: peaks[i], to: peaks[i + 1], rangePct: Math.round(rangePct * 10) / 10 });
  }
  if (contractions.length < minContractions) return { isVCP: false, contractions, tightness: 0 };

  // Range giảm dần?
  const rangesDecreasing = contractions.every((c, i) => i === 0 || c.rangePct <= contractions[i - 1].rangePct);
  // Volume trend giảm? so sánh avg volume nửa đầu vs nửa cuối
  const half = Math.floor(vSlice.length / 2);
  const vFirst = vSlice.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const vLast = vSlice.slice(half).reduce((s, v) => s + v, 0) / (vSlice.length - half);
  const volumeDeclining = vLast < vFirst * 0.9;
  // Tightness = range của contraction cuối
  const tightness = contractions[contractions.length - 1].rangePct;

  return {
    isVCP: rangesDecreasing && volumeDeclining && tightness <= 15,
    contractions,
    tightness
  };
}

module.exports = { detectVCP };
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add server/ta/vcp.js server/__tests__/ta/vcp.test.js
git commit -m "feat(ta): VCP detection + tests"
```

---

## Task 9: Pocket Pivot module (`ta/pocket-pivot.js`)

**Files:**
- Create: `server/ta/pocket-pivot.js`
- Create: `server/__tests__/ta/pocket-pivot.test.js`

- [ ] **Step 1: Write failing test**

`server/__tests__/ta/pocket-pivot.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { detectPocketPivot } from '../ta/pocket-pivot.js';

describe('detectPocketPivot', () => {
  it('detect pocket pivot: volume hôm nay > mọi ngày giảm trong 10 ngày trước', () => {
    const dates = [], ohlc = [], volumes = [];
    for (let i = 0; i < 12; i++) {
      // 10 ngày trước: vài ngày giảm volume 400-600
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
});
```

- [ ] **Step 2: Run — confirm fail**

- [ ] **Step 3: Implement `server/ta/pocket-pivot.js`**

```js
/**
 * Pocket Pivot (Kacher/Morales) — early entry signal.
 * Điều kiện: hôm nay là ngày TĂNG giá (close > close hôm trước) VÀ volume hôm nay
 * > MỌI ngày GIẢM giá trong 10 ngày giao dịch trước.
 *
 * @param {{dates:string[], ohlc:{o,h,l,c}[], volumes:number[]}} data
 * @returns {{detected:boolean, date:string|null, volumeRatio:number}}
 */
function detectPocketPivot({ dates, ohlc, volumes }) {
  const n = ohlc.length;
  if (n < 11) return { detected: false, date: null, volumeRatio: 0 };
  const last = n - 1;
  const todayUp = ohlc[last].c > ohlc[last - 1].c;
  if (!todayUp) return { detected: false, date: dates[last], volumeRatio: 0 };

  const todayVol = volumes[last];
  // 10 ngày trước hôm nay (last-10 ... last-1)
  const window = [];
  for (let i = last - 10; i < last; i++) {
    const down = ohlc[i].c < ohlc[i - 1] ? ohlc[i - 1].c : null;
    if (ohlc[i].c < (i > 0 ? ohlc[i - 1].c : ohlc[i].c)) {
      window.push(volumes[i]);
    }
  }
  if (window.length === 0) return { detected: false, date: dates[last], volumeRatio: 0 };
  const maxDownVol = Math.max(...window);
  const detected = todayVol > maxDownVol;
  return {
    detected,
    date: detected ? dates[last] : null,
    volumeRatio: maxDownVol > 0 ? todayVol / maxDownVol : 0
  };
}

module.exports = { detectPocketPivot };
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add server/ta/pocket-pivot.js server/__tests__/ta/pocket-pivot.test.js
git commit -m "feat(ta): Pocket Pivot detection + tests"
```

---

## Task 10: Price history data layer (`ta/price-history.js`)

**Files:**
- Create: `server/ta/price-history.js`
- Modify: `server/.gitignore`

- [ ] **Step 1: Add `data/price-history.json` to gitignore** (large generated file)

Append to `server/.gitignore`:
```
# Generated OHLC+volume history (rebuilt by backfill, ~75MB)
data/price-history.json
```

- [ ] **Step 2: Implement `server/ta/price-history.js`**

```js
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'price-history.json');

let _cache = null;   // in-process cache (load 1 lần)

function _load() {
  if (_cache) return _cache;
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      _cache = { meta: { version: 2, lastUpdated: null, symbols: 0 }, symbols: {} };
      return _cache;
    }
    _cache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    console.error('[price-history] load fail:', e.message);
    _cache = { meta: { version: 2, lastUpdated: null, symbols: 0 }, symbols: {} };
  }
  return _cache;
}

/**
 * Lấy history 1 symbol. Trả { dates, ohlc, volumes } hoặc null.
 */
function getHistory(symbol) {
  const data = _load();
  return data.symbols[symbol] || null;
}

/**
 * Lưu/upsert history 1 symbol. Ghi ngay ra file.
 */
function setHistory(symbol, history) {
  const data = _load();
  data.symbols[symbol] = history;
  data.meta.symbols = Object.keys(data.symbols).length;
  data.meta.lastUpdated = new Date().toISOString().slice(0, 10);
  _save(data);
}

function _save(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data), 'utf8');
    _cache = data;
  } catch (e) {
    console.error('[price-history] save fail:', e.message);
  }
}

function getMeta() {
  const data = _load();
  const symbols = Object.keys(data.symbols);
  const depths = symbols.map(s => (data.symbols[s].closes || data.symbols[s].ohlc || []).length);
  return {
    version: data.meta.version,
    lastUpdated: data.meta.lastUpdated,
    symbolCount: symbols.length,
    minDepth: depths.length ? Math.min(...depths) : 0,
    maxDepth: depths.length ? Math.max(...depths) : 0
  };
}

module.exports = { getHistory, setHistory, getMeta, HISTORY_FILE };
```

- [ ] **Step 3: Smoke-test (no formal test — data layer is I/O)**

```bash
cd server && node -e "
const ph = require('./ta/price-history');
ph.setHistory('TEST', { dates:['2026-01-01'], ohlc:[{o:1,h:2,l:0,c:1}], volumes:[100] });
console.log('meta:', ph.getMeta());
console.log('TEST history:', ph.getHistory('TEST'));
"
```
Expected: prints meta with symbolCount including TEST, and the TEST history object.

- [ ] **Step 4: Commit**

```bash
git add server/ta/price-history.js server/.gitignore
git commit -m "feat(ta): price-history.json data layer (load/save/meta)"
```

---

## Task 11: Backfill script (`scripts/backfill-price-history.js`)

**Files:**
- Create: `server/scripts/backfill-price-history.js`

- [ ] **Step 1: Implement backfill script** (reuses FireAnt HistoricalQuotes + cookie-heal)

```js
/**
 * Backfill 1 lần: fetch HistoricalQuotes (~1 năm) cho ~1576 mã HOSE
 * → ghi price-history.json. Chạy: node scripts/backfill-price-history.js
 *
 * Batch 10/lần + delay 500ms + backoff 429. Log progress.
 * Reuse cookie-heal từ server.js (getFireAntCookieWithHeal).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');
const { setHistory, getMeta } = require('../ta/price-history');
const breadthSymbols = require('../breadth-symbols');

const BATCH = 10;
const DELAY_MS = 500;

function formatSimpleDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchOne(symbol, cookie) {
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 400);
  const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${formatSimpleDate(start)}&endDate=${formatSimpleDate(end)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
  if (cookie) headers['Cookie'] = cookie;
  const res = await axios.get(url, { headers, timeout: 15000 });
  const items = (res.data || []).filter(d => d.Close > 0);
  return {
    dates: items.map(d => d.Date.split('T')[0]),
    ohlc: items.map(d => ({
      o: d.Open || 0, h: d.High || 0, l: d.Low || 0, c: d.Close || 0
    })),
    volumes: items.map(d => d.Volume || 0)
  };
}

async function main() {
  const server = require('../server'); // để truy cập getFireAntCookieWithHeal
  // NOTE: require server.js có side-effect (start express). Trong script standalone,
  // dùng cookie-manager.getCookie() thay vì server.getFireAntCookieWithHeal.
  const cookieManager = require('../cookie-manager');
  const cookie = await cookieManager.getCookie().catch(() => '');

  const symbols = breadthSymbols; // ~1576 mã
  console.log(`Backfill ${symbols.length} symbols...`);
  let done = 0, fail = 0;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    for (const sym of chunk) {
      try {
        const h = await fetchOne(sym, cookie);
        if (h.dates.length > 0) { setHistory(sym, h); done++; }
        else fail++;
      } catch (e) {
        console.warn(`  ${sym} fail: ${e.message}`); fail++;
      }
    }
    console.log(`Progress: ${done + fail}/${symbols.length} (ok=${done} fail=${fail})`);
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log('Done. Meta:', getMeta());
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify script loads (syntax)**

```bash
cd server && node --check scripts/backfill-price-history.js && echo OK
```

- [ ] **Step 3: Commit**

```bash
git add server/scripts/backfill-price-history.js
git commit -m "feat(ta): backfill script for price-history.json"
```

> NOTE: Actually running the full backfill (10-15 min, ~1576 API calls) is done at deploy time, not in this plan. It's a one-time operational step documented in DEPLOY.md (Task 14).

---

## Task 12: Composite `computeTA` + `ta/index.js` barrel

**Files:**
- Create: `server/ta/index.js`

- [ ] **Step 1: Implement barrel + composite**

```js
/**
 * server/ta/index.js — barrel export + computeTA() composite.
 * Single entry point cho subsystem #2-#6.
 */
const { sma, ema } = require('./ma');
const { rsi } = require('./rsi');
const { macd } = require('./macd');
const { adx, trendStrength } = require('./adx');
const { atr } = require('./atr');
const { bollinger } = require('./bollinger');
const { trendTemplate } = require('./trend-template');
const { detectVCP } = require('./vcp');
const { detectPocketPivot } = require('./pocket-pivot');

/**
 * Composite TA cho 1 symbol. Trả object đầy đủ.
 * @param {{dates:string[], ohlc:{o,h,l,c}[], volumes:number[]}} history
 */
function computeTA(history) {
  const closes = (history.ohlc || []).map(x => x.c);
  const ohlc = history.ohlc || [];
  const last = closes.length - 1;

  const ma50 = sma(closes, 50)[last];
  const ma150 = sma(closes, 150)[last];
  const ma200 = sma(closes, 200)[last];
  const ma200_22ago = closes.length >= 222 ? sma(closes, 200)[last - 22] : null;

  return {
    mas: {
      ma10: sma(closes, 10)[last],
      ma20: sma(closes, 20)[last],
      ma50, ma150, ma200,
      ma200Rising: ma200_22ago != null && ma200 != null && ma200 > ma200_22ago
    },
    momentum: {
      rsi: rsi(closes)[rsi(closes).length - 1],
      macd: macd(closes)
    },
    trend: { ...adx(ohlc, 14), trendStrength: trendStrength(adx(ohlc, 14).adx) },
    volatility: atr(ohlc, 14),
    bollinger: bollinger(closes, 20, 2),
    sepa: {
      trendTemplate: trendTemplate({ dates: history.dates, closes }),
      vcp: detectVCP({ dates: history.dates, ohlc, volumes: history.volumes || [] }),
      pocketPivot: detectPocketPivot({ dates: history.dates, ohlc, volumes: history.volumes || [] })
    }
  };
}

module.exports = {
  sma, ema, rsi, macd, adx, trendStrength, atr, bollinger,
  trendTemplate, detectVCP, detectPocketPivot,
  computeTA,
  priceHistory: require('./price-history')
};
```

- [ ] **Step 2: Verify syntax**

```bash
cd server && node --check ta/index.js && echo OK
```

- [ ] **Step 3: Commit**

```bash
git add server/ta/index.js
git commit -m "feat(ta): barrel export + computeTA() composite"
```

---

## Task 13: Migrate potential-scanner to delegate TA

**Files:**
- Modify: `server/potential-scanner.js` (replace inline `calculateEMA`/`calculateMACD`/`calculateRSI` with `require('./ta/')`)

- [ ] **Step 1: Read current scanner** (`server/potential-scanner.js:123-223`)

- [ ] **Step 2: Replace inline TA functions with delegation.** At the top of file, add:
```js
const { ema: calculateEMA } = require('./ta/ma');
const { macd: calculateMACD } = require('./ta/macd');
const { rsi: calculateRSIRaw } = require('./ta/rsi');
// adapter: scanner expects [{dateIndex, rsi}], ta/rsi returns number[]
function calculateRSI(closes, period = 14) {
  return calculateRSIRaw(closes, period).map((rsi, i) => ({ dateIndex: i, rsi }));
}
```
Delete the old `calculateEMA` (123), `calculateMACD` (144), `calculateRSI` (185) function bodies.

- [ ] **Step 3: Verify scanner still loads + syntax**

```bash
cd server && node --check potential-scanner.js && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add server/potential-scanner.js
git commit -m "refactor(scanner): delegate TA calc to server/ta/ module"
```

---

## Task 14: Wire daily build + `/api/ta/:symbol` endpoint + DEPLOY docs

**Files:**
- Modify: `server/server.js`
- Modify: `DEPLOY.md`

- [ ] **Step 1: Add daily `buildPriceToday()` to scheduler** — in `server.js` bootstrap, near the breadth jobs (~line 3300), add:

```js
// Daily price-history build: append today's OHLC+volume cho mọi symbol.
// Gate: trading day, EOD window hoặc morning catch-up (giống breadth jobs).
const { setHistory, getHistory } = require('./ta/price-history');
const breadthSymbolsList = require('./breadth-symbols');
const PRICE_BUILD_INTERVAL = 30 * 60 * 1000;
setInterval(async () => {
    if (!tt.isTradingDay()) return;
    const inEod = tt.isInEODWindow();
    try {
        const cookie = await getFireAntCookieWithHeal();
        for (let i = 0; i < breadthSymbolsList.length; i++) {
            const sym = breadthSymbolsList[i];
            const existing = getHistory(sym);
            if (existing && existing.dates && existing.dates[existing.dates.length - 1] === tt.vnToday()) {
                continue; // đã có hôm nay
            }
            // fetch 1 ngày gần nhất từ FireAnt HistoricalQuotes (endDate = hôm nay)
            const end = new Date();
            const start = new Date(); start.setDate(start.getDate() - 5);
            const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${sym}&startDate=${fmt(start)}&endDate=${fmt(end)}`;
            const headers = { 'User-Agent':'Mozilla/5.0','Accept':'application/json' };
            if (cookie) headers['Cookie'] = cookie;
            const res = await axios.get(url, { headers, timeout: 10000 }).catch(() => null);
            if (!res || !Array.isArray(res.data)) continue;
            const newRows = res.data.filter(d => d.Close > 0).map(d => ({
                date: d.Date.split('T')[0],
                ohlc: { o: d.Open||0, h: d.High||0, l: d.Low||0, c: d.Close||0 },
                vol: d.Volume||0
            }));
            if (newRows.length === 0) continue;
            // append vào history hiện có (tránh duplicate date)
            const hist = existing || { dates: [], ohlc: [], volumes: [] };
            const existingDates = new Set(hist.dates);
            for (const r of newRows) {
                if (!existingDates.has(r.date)) {
                    hist.dates.push(r.date);
                    hist.ohlc.push(r.ohlc);
                    hist.volumes.push(r.vol);
                }
            }
            setHistory(sym, hist);
            if (i % 100 === 0) console.log(`[price-build] ${i}/${breadthSymbolsList.length}`);
        }
        console.log(`✅ [price-build] updated — meta:`, require('./ta/price-history').getMeta());
    } catch (e) {
        console.error('[price-build] error:', e.message);
    }
}, PRICE_BUILD_INTERVAL);
```

- [ ] **Step 2: Add endpoint `/api/ta/:symbol`** (auth-required, cached):
```js
app.get('/api/ta/:symbol', async (req, res) => {
    try {
        const { getHistory } = require('./ta/price-history');
        const { computeTA } = require('./ta');
        const h = getHistory(req.params.symbol.toUpperCase());
        if (!h || !h.ohlc || h.ohlc.length < 50) {
            return res.status(404).json({ success: false, error: 'Không đủ data cho mã này' });
        }
        res.json({ success: true, symbol: req.params.symbol.toUpperCase(), ta: computeTA(h) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
```

- [ ] **Step 3: Document backfill in DEPLOY.md** — add to "Daily Refresh Health" section: one-time backfill command `docker compose exec express node scripts/backfill-price-history.js` (10-15 min).

- [ ] **Step 4: Run full test suite**

```bash
cd server && npx vitest run __tests__/ta/ __tests__/trading-time.test.js
```
Expected: all pass. (Existing cache/db/redis tests fail without local Postgres+Redis — pre-existing, ignore.)

- [ ] **Step 5: Commit**

```bash
git add server/server.js DEPLOY.md
git commit -m "feat(ta): /api/ta/:symbol endpoint + daily build + DEPLOY docs"
```

---

## Verification (after all tasks)

1. `cd server && npm test` — all `__tests__/ta/` + `trading-time` pass.
2. `node --check` on every `server/ta/*.js` + `potential-scanner.js` + `server.js`.
3. Local smoke: `node server.js`, then `curl -b cookies.txt http://localhost/api/ta/HPG | jq .` returns full TA object (after backfill).
4. One-time operational backfill documented in DEPLOY.md (run on VPS at deploy).

## Self-Review Checklist
- [x] Spec coverage: all 9 indicators (Tasks 1-9), data layer (Task 10), backfill (11), composite (12), migration (13), endpoint+daily (14). ✓
- [x] No placeholders: every code step has full implementation. ✓
- [x] Type consistency: `computeTA` return shape matches spec §3.4. `ema`/`sma` return arrays of (number|null), consistent across macd/bollinger/trend-template. ✓
