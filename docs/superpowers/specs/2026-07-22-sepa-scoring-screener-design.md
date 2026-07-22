# Subsystem #2: SEPA Scoring + Screener — Design Spec

> **Context:** Phần thứ 2 của lộ trình 6 bước Auto-Trade VN. Dùng TA engine (#1) để chấm điểm composite cho mỗi mã → bảng xếp hạng → thay thế scanner 5-ngưỡng cứng hiện tại.

**Ngày:** 2026-07-22
**Trạng thái:** Tự phê duyệt (user ủy quyền "auto 100%")
**Phụ thuộc:** Subsystem #1 (`server/ta/` + `price-history.json`)

---

## 1. Mục tiêu

Thay thế `analyzeStock()` (5 ngưỡng cứng binary: pass/fail) bằng **hệ thống điểm tổng hợp (composite score) 0-100** theo phương pháp SEPA. Mỗi mã có điểm số → xếp hạng → user thấy "top pick" thay vì danh sách pass/fail. Là nền cho #3 (backtest) và #4 (signal gen).

## 2. Kiến trúc

### 2.1 Module layout (mới)
```
server/
  scoring/                        ← NEW
    score.js                      computeSEPA(ta) → { score, grade, breakdown }
    screener.js                   screenAll(opts) → ranked list + filter
    index.js                      barrel
  __tests__/scoring/
    score.test.js                 TDD từng factor weight
    screener.test.js              TDD ranking + filter
```

### 2.2 Scoring formula (composite 0-100)

`computeSEPA(ta)` nhận output `computeTA()` (#1) và trả điểm. **9 factors**, mỗi cái 0-100, weighted:

| Factor | Weight | Source | Logic |
|--------|--------|--------|-------|
| **Trend Template** | 25% | `ta.sepa.trendTemplate` | `pass ? 100 : (rules.filter(true).length/8)*100` |
| **Trend Strength (ADX)** | 15% | `ta.trend.adx` | `min(100, adx×2.5)` (ADX=40→100, =25→62, =0→0) |
| **VCP tightness** | 15% | `ta.sepa.vcp` | `isVCP ? 100 : tightness≤15?(100-tightness*4):0` |
| **Relative Strength** | 15% | RS rating (tính riêng, xem 2.3) | `RS value trực tiếp` (0-100) |
| **MA alignment** | 10% | `ta.mas` | price>MA50>MA150>MA200 ? 100 : partial |
| **Momentum (MACD hist)** | 8% | `ta.momentum.macd.histogram` | hist>0 ? 100 : 50-|hist|×k |
| **Volume surge (Pocket Pivot)** | 5% | `ta.sepa.pocketPivot` | detected? 100 : volumeRatio×k |
| **Distance to MA20** | 4% | calc từ closes+ma20 | dist trong [0,8%] → 100; >8% giảm |
| **Bollinger squeeze** | 3% | `ta.bollinger.squeeze` | squeeze? 100 : 0 (sắp nổ biến động) |

**Grade mapping:**
- A+ (≥85): setup hoàn hảo — mạnh candidate mua
- A (70-84): tốt
- B (55-69): khá
- C (40-54): trung bình — theo dõi
- D (<40): yếu — bỏ qua

### 2.3 Relative Strength (RS) rating

Scanner hiện tại lấy RS từ FireAnt (mã ~55+). #2 sẽ **tính RS rating 0-100** từ `price-history.json` (relative to VNINDEX hoặc HOSE average):
- RS = 1-phiên return của mã / 1-phiên return của VNINDEX benchmark × 100
- Lấy trung bình trailing 50 phiên (Mansfield-style đơn giản hóa)
- Cần benchmark VNINDEX history (đã có trong price-history sau backfill)

> **Mặc định:** nếu VNINDEX data thiếu → fallback RS = momentum gần (10-phiên return rank percentile). Đủ tốt cho v1; #3 backtest sẽ tối ưu weight thực tế.

### 2.4 Screener (`screener.js`)

`screenAll({ minScore, limit, grade, sector })`:
- Lặp qua tất cả symbol trong `price-history.json`
- `computeTA` → `computeSEPA` → collect `{ symbol, score, grade, breakdown }`
- Filter: `minScore` (mặc định 55 = grade B+), `grade`, `sector` (optional)
- Sort theo score giảm dần → trả top `limit` (mặc định 50)

**Output shape** (tương thích frontend hiện tại):
```js
{
  success: true,
  timestamp, source: 'sepa-scoring',
  scanned: 1528, filtered: 87,
  results: [
    { symbol, score: 87, grade: 'A+', price, change,
      breakdown: { trendTemplate:100, adx:62, vcp:100, ... },
      ta: { /* shortcut: trendTemplate.pass, vcp.isVCP, pocketPivot.detected */ }
    }, ...
  ]
}
```

### 2.5 Endpoints
- `GET /api/sepa-scan?minScore=55&limit=50&grade=A` — screener ranked (auth required, cached 5 phút)
- `GET /api/sepa-score/:symbol` — điểm 1 mã + breakdown chi tiết
- Endpoint cũ `/api/potential-signals` **vẫn giữ** (back-compat) nhưng delegate sang scoring module (output shape giữ nguyên cho frontend).

## 3. Testing (TDD)
- `score.test.js`: từng factor — Trend Template pass=100, ADX=40→100, VCP tightness=5→80, etc. Composite sum check.
- `screener.test.js`: filter minScore, sort giảm dần, limit, grade filter.

## 4. Out of scope (để #3/#4)
- Backtest + label (đo "score cao có thật sự thắng") = #3
- Signal BUY/SELL/EXIT cụ thể + position sizing = #4
- "Tự học" weight optimization = #3 (grid search sau khi có backtest)

## 5. Success Criteria
1. `computeSEPA(ta)` trả { score: 0-100, grade, breakdown } — tested.
2. `screenAll()` trả ranked list, filter + sort đúng — tested.
3. `/api/sepa-scan` + `/api/sepa-score/:symbol` hoạt động.
4. Scanner cũ delegate, không break frontend.
5. `npm test` pass (thêm __tests__/scoring/).
