# Subsystem #1: Data + TA Engine — Design Spec

> **Context:** Đây là phần đầu tiên của lộ trình 6 bước xây dựng **Hệ thống Auto-Trade tại Việt Nam** (luật T+2.5). Spec này đặt nền móng: đảm bảo data đầy đủ (OHLC+volume) + module TA sạch, testable cho mọi subsystem sau.

**Ngày:** 2026-07-22
**Trạng thái:** Chờ phê duyệt
**Phụ thuộc:** Không (foundation)

---

## 1. Bối cảnh & Vấn đề

### 1.1 Mục tiêu dài hạn
Hệ thống Auto-Trade hoàn toàn trên thị trường chứng khoán Việt Nam:
- Pick danh mục tốt hơn theo phương pháp **SEPA** (Chris Kacher / Mark Minervini — Trend Template + VCP + Pocket Pivot).
- Lướt trading T+2 đến T+10 + sóng tăng 1 tháng.
- Kết nối broker, đặt lệnh tự động (xử lý luật T+2.5 settlement).
- "Tự học" (light learning): tối ưu factor weights dựa trên backtest outcome.

### 1.2 Vấn đề hiện tại
- **Scanner `potential-scanner.js`** dùng 5 ngưỡng cứng (RS≥55, giá>MA20>MA50, distMA20<8%, volume>200k, nến xanh). Không có đánh giá trend strength, không có VCP/Pocket Pivot.
- **Code TA bị vứt lẫn** trong business logic của scanner (`calculateMACD`/`RSI`/`EMA` inline, không có unit test).
- **Data thiếu**: `ma-breadth-close.json` (15MB, 1576 mã × ~423 ngày) chỉ lưu **close**, không có OHLC/volume → không tính được VCP/Pocket Pivot (cần volume), không có high/low cho ATR chính xác.

### 1.3 Giới hạn (out of scope cho #1)
- Stock scoring / ranking (= Subsystem #2).
- Backtest engine + label (= Subsystem #3).
- Signal generation + risk mgmt (= Subsystem #4).
- Broker API integration (= Subsystem #5).
- **Không xóa `potential-scanner.js`** — nó tiếp tục chạy cho tới khi #2 thay thế nó hoàn toàn.

---

## 2. Lộ trình Auto-Trade (6 Subsystems)

| # | Subsystem | Mô tả | Phụ thuộc | Độ khó |
|---|-----------|-------|-----------|--------|
| **1** | **Data + TA engine** ← *spec này* | Persist OHLC+volume, module TA sạch, 9 indicators | — | 🟢 Dễ |
| 2 | SEPA Scoring + Screener | Trend Template 8 rules + VCP score → stock ranking | #1 | 🟢 Dễ |
| 3 | Backtest + Label | Walk 1528 mã × ~400 ngày, forward return từ T+3 (T+2.5 constraint), light learning | #1,#2 | 🟡 Vừa |
| 4 | Signal Gen + Risk Mgmt | BUY/SELL/EXIT, ATR stop-loss, position sizing, T+2.5 settlement module | #2,#3 | 🟡 Vừa |
| 5 | Broker API | Kết nối broker đặt lệnh (chướng ngại VN retail API) | #4 | 🔴 Khó |
| 6 | Auto Execution Loop | Trade loop, state, safety kill-switch | #5 | 🔴 Khó |

---

## 3. Thiết kế

### 3.1 Module Layout (mới)

```
server/
  ta/                          ← NEW: module TA riêng, pure functions
    ma.js                      SMA(period), EMA(period)
    rsi.js                     RSI (Wilder smoothing)
    macd.js                    MACD line/signal/histogram
    adx.js                     ADX + DI+/DI- (trend strength)
    atr.js                     ATR (volatility, stop-loss)
    bollinger.js               Bollinger Bands (20, 2σ)
    trend-template.js          8 rules Minervini (Stage 2 filter)
    vcp.js                     Volatility Contraction Pattern detection
    pocket-pivot.js            Pocket Pivot (Kacher/Morales early entry)
    price-history.js           Load/save/build price-history.json
    index.js                   Barrel export + computeTA() composite
  __tests__/ta/
    ma.test.js
    rsi.test.js
    macd.test.js
    adx.test.js
    atr.test.js
    bollinger.test.js
    trend-template.test.js
    vcp.test.js
    pocket-pivot.test.js
  data/
    price-history.json         ← NEW: OHLC+volume (mở rộng từ close-only)
```

### 3.2 Migration Strategy
**Copy + delegate (gradual)** — không big-bang rewrite:
- `calculateMACD`/`RSI`/`EMA` trong `potential-scanner.js` được **copy** sang `server/ta/` + thêm unit test.
- `potential-scanner.js` đổi thành `require('./ta/...')` (single source of truth).
- Scanner tiếp tục chạy production, không break.
- Code TA cũ trong scanner có thể xóa sau khi #2 thay thế (defer).

### 3.3 Data Layer — `price-history.json`

**Format:**
```json
{
  "meta": { "version": 2, "lastUpdated": "2026-07-22", "symbols": 1576 },
  "symbols": {
    "HPG": {
      "dates":   ["2024-10-31", "2024-11-01", ...],
      "ohlc":    [{"o":20000,"h":20100,"l":19900,"c":20012}, ...],
      "volumes": [1230000, 980000, ...]
    },
    ...
  }
}
```

**Tạo data:**
- **Backfill 1 lần**: chạy qua 1576 mã, fetch FireAnt HistoricalQuotes (~1 năm) → ghi `price-history.json`.
  - Batch 10 mã/lần + delay 500ms (giống `potential-scanner` fetch pattern).
  - Số API call: ~1576 (1 call/mã cho 1 năm history).
  - Thời gian ước tính: ~10-15 phút (chạy 1 lần, log progress).
  - Dùng `getFireAntCookieWithHeal()` (đã build) cho auth + self-heal.
- **Daily incremental** (`buildPriceToday()`): fetch nến hôm nay → append. Tích hợp vào scheduler hiện có (dùng `trading-time`, chạy EOD 15-23h + morning catch-up).
- **Rate limit**: reuse cookie + cookie-heal. Cảnh giác FireAnt rate-limit; nếu 429 → backoff.

**Storage:**
- JSON file (chốt ở brainstorming). Dự kiến ~75MB (5x của 15MB close-only).
- Read pattern: load 1 lần vào memory (cache in-process), rebuild khi EOD.
- Nếu sau này chậm (>1s load) → migrate SQLite (defer, YAGNI lúc này).

### 3.4 Tập Indicators (9 module)

#### Migration (có sẵn, copy + test)
- **`ma.js`** — `sma(values, period)`, `ema(values, period)`. SMA dùng prefix-sum O(1) (giống breadth-history). EMA Wilder.
- **`rsi.js`** — `rsi(closes, period=14)`. Wilder smoothing (đã đúng trong scanner, copy verbatim + test).
- **`macd.js`** — `macd(closes)` → `{ macd, signal, histogram }`. EMA12-EMA26, signal=EMA9 (đã đúng, copy + test).

#### Mới (cho SEPA)
- **`adx.js`** — `adx(ohlc, period=14)` → `{ adx, diPlus, diMinus, trendStrength }`.
  - trendStrength: `adx >= 25 ? 'strong' : adx >= 20 ? 'weak' : 'ranging'`.
- **`atr.js`** — `atr(ohlc, period=14)` → `{ atr, atrPct }`. atrPct = atr/close × 100 (cho stop-loss % ).
- **`bollinger.js`** — `bollinger(closes, period=20, mult=2)` → `{ upper, middle, lower, squeeze }`. squeeze = bandwidth < **20th percentile** của bandwidth lịch sử (rolling window 120 ngày). Bandwidth = (upper-lower)/middle × 100.
- **`trend-template.js`** — `trendTemplate({ dates, closes })` → `{ pass: bool, rules: [8 booleans], details }`. 8 rules Minervini:
  1. Price > MA150
  2. Price > MA200
  3. MA150 > MA200
  4. MA50 > MA150 AND MA50 > MA200
  5. Price > MA50
  6. MA200 rising: MA200 hôm nay > MA200 tại **index = today - 22 phiên** (22 phiên ≈ 1 tháng giao dịch)
  7. Price ≥ 1.30 × 52-week low (30% trên low)
  8. Price ≤ 1.25 × 52-week high (trong 25% của high)
- **`vcp.js`** — `detectVCP({ dates, ohlc, volumes })` → `{ isVCP: bool, contractions: [{from,to,rangePct}], tightness }`.
  - Detect chuỗi contraction (vd 25%→12%→5%) trên volume giảm dần.
  - Algo: tìm local maxima trong N ngày, đo range (high-low)/high của mỗi pullback, kiểm tra chuỗi giảm dần + volume trend.
- **`pocket-pivot.js`** — `detectPocketPivot({ dates, ohlc, volumes })` → `{ detected: bool, date, volumeRatio }`.
  - Ngày tăng giá mà volume > **mọi ngày giảm** trong 10 ngày trước (Kacher/Morales).
  - Early entry signal (trước classic breakout).

#### Composite (`index.js`)
```js
// Sync API (data đã truyền vào)
computeTA(symbol, { dates, ohlc, volumes }) → {
  mas:       { ma10, ma20, ma50, ma150, ma200, ma200Rising },
  momentum:  { rsi, macd: { line, signal, hist } },
  trend:     { adx, diPlus, diMinus, trendStrength },
  volatility:{ atr, atrPct, bollinger: { upper, lower, squeeze } },
  sepa: {
    trendTemplate: { pass, rules: [8 bool], details },
    vcp:           { isVCP, contractions, tightness },
    pocketPivot:   { detected, date, volumeRatio }
  }
}

// Async (load từ price-history.json)
async loadHistory(symbol) → { dates, ohlc, volumes }
async getTA(symbol) → TA result (cached in-process, rebuild mỗi EOD)
```

### 3.5 Testing (TDD)
Mỗi indicator: pure-function test với crafted data (không cần DB), chạy <1s:
- **RSI**: giá tăng đều → 100; giá giảm đều → 0; giá random → biết trước kết quả.
- **MACD**: chuỗi tuyến tính → MACD line có sign/shape biết trước.
- **ADX**: chuỗi trend mạnh (ADXd phải cao) vs sideway (thấp).
- **ATR**: chuỗi nến với range biết trước → ATR chính xác.
- **Bollinger**: squeeze detect với crafted low-volatility window.
- **Trend Template**: test **từng rule trong 8 rule** với data vi phạm đúng 1 rule → `rules[i]=false`, các rule khác `true`.
- **VCP**: crafted price series co lại 25→12→5% trên volume giảm → `isVCP=true`.
- **Pocket Pivot**: crafted volume spike > mọi ngày giảm trong 10 ngày → `detected=true`.

### 3.6 Interface Contract (cho #2-#4 phụ thuộc)
Module `server/ta/` expose stable interface. #2-#6 **chỉ** dùng qua interface này, không đụng internals:
- `computeTA(symbol, history)` — sync, pure
- `trendTemplatePasses(history)` — shortcut cho screener
- `detectVCP(history)`, `detectPocketPivot(history)` — shortcut
- `loadHistory(symbol)`, `getTA(symbol)` — async, cached

---

## 4. Rủi ro & Mitigation

| Rủi ro | Mitigation |
|--------|-----------|
| Backfill 1576 mã chạm FireAnt rate-limit | Batch 10 + delay 500ms + backoff 429; log progress; có thể resume |
| File 75MB load chậm | Load 1 lần in-process cache; nếu vẫn chậm → SQLite (defer) |
| VCP/Pocket Pivot algo phức tạp, dễ sai | TDD với crafted data trước; reference implementation từ sách Minervini |
| FireAnt HistoricalQuotes format thay đổi | Defensive parsing (đã có pattern `item.Open \|\| item.PriceOpen`) |
| Migration phá potential-scanner | Copy+delegate (không xóa code cũ); scanner require từ module mới |

---

## 5. Success Criteria (Definition of Done)

1. `server/ta/` có 9 indicator module, mỗi cái có unit test pass.
2. `price-history.json` chứa OHLC+volume cho ≥1528 mã (≥200 ngày history).
3. `potential-scanner.js` delegate TA calc sang `server/ta/` (không còn code TA inline).
4. `computeTA(symbol)` trả đầy đủ object (mas/momentum/trend/volatility/sepa).
5. Daily `buildPriceToday()` chạy trong scheduler (trading-time aware).
6. Full test suite pass: `cd server && npm test`.

---

## 6. Tham khảo

- **SEPA / Trend Template**: Mark Minervini, *Trade Like a Stock Market Wizard*.
- **VCP (Volatility Contraction Pattern)**: Minervini — price contractions progressively tighter (25%→12%→5%) on shrinking volume.
- **Pocket Pivot**: Chris Kacher & Gil Morales — early entry, volume heavier than any down-day in prior 10 days.
- **Chris Kacher "18000% profit"**: phương pháp CAN SLIM mở rộng + pocket pivot + trend following.
- Nguồn 8 rules Trend Template: [ChartMill](https://www.chartmill.com/documentation/stock-screener/technical-analysis-trading-strategies/496), [Scribd (verbatim)](https://www.scribd.com/document/352063047).
