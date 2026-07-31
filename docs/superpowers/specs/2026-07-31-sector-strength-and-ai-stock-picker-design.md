# Sector Strength Scoring + AI Stock Picker — Design

- **Ngày:** 2026-07-31
- **Branch:** `fix/realtime-refresh-and-mid-cap`
- **Trạng thái:** Design chờ review
- **Scope:** Đánh giá sức mạnh/tiềm năng từng ngành (ICB2) đa chiều + AI pick cổ phiếu từ ngành mạnh

---

## 1. Bối cảnh & Vấn đề

Web app hiện có feature "Chuyển Động Ngành" (`/api/industry-stats`) hiển thị bubble chart 2 chiều: `lucCau` (lực cầu phiên) × `percentAboveMA10`. Đây là góc nhìn **intraday, 2 chiều**, chưa đủ để đánh giá sức mạnh ngành thực sự:

- **Thiếu chiều trung/dài hạn** (trend breadth, RS ngành vs index, smart-money 20D).
- **Không có góc định giá** (rẻ/đắt, sinh lời tốt không) — app không lưu fundamentals.
- **Không có sector score thống nhất** (chỉ có `lucCau` lẻ tẻ, dễ bị "mạnh giả": lucCau cao phiên nhưng breadth thu hẹp + smart-money xả → sắp yếu).
- **Chưa có pipeline "từ ngành mạnh → pick CP"**: hệ thống SEPA chấm điểm từng CP độc lập, không xét xem CP thuộc ngành mạnh hay yếu.

Mục tiêu: biến các tín hiệu lẻ tẻ thành **1 score 0–100 đa chiều** cho từng ngành, rồi **lọc SEPA top picks theo ngành mạnh** → LLM giải thích. Khắc phục bẫy "mạnh giả" và bổ sung góc nhìn portfolio-level (diversify ngành qua `maxSectorPct`).

## 2. Quyết định thiết kế (đã chốt với user)

| Quyết định | Lựa chọn | Lý do |
|---|---|---|
| Phạm vi data | **Hybrid** — TA/flow/breadth + vài chỉ số định giá cốt lõi | Cân bằng độ sâu vs công sức; không phụ thuộc nguồn data lớn |
| Logic AI | **Hybrid** — thuật toán deterministic chấm điểm + LLM giải thích | Có số liệu nền (đáng tin, tái lập) + lý do tự nhiên (dễ hiểu) |
| Time horizon | **Swing 1–4 tuần** (default) | Khớp hệ thống SEPA/signal sẵn (`holdDays: 20`); tận dụng tối đa foundation |
| Approach | **Cách 1 — Mirror SEPA ở cấp ngành** | Đồng bộ pattern `score.js`, backtest được, reuse tối đa |
| Nguồn fundamentals | **FireAnt** (đã có cookie-auth) | Không thêm nguồn; verify xem endpoint đang dùng có trả fundamentals không |
| UI | **Tab mới "AI Đánh Giá Ngành"** | Không phá tab cũ; song song "Báo Cáo AI" |

## 3. Kiến trúc tổng thể

```
┌────────────────────────────────────────────────────────────────┐
│  DATA LAYER                                                     │
│  ┌────────────────┐ ┌───────────────┐ ┌───────────────────────┐ │
│  │ breadth-history│ │ fiintrade flow│ │ FireAnt fundamentals  │ │
│  │ (trend 372 ngày│ │ (smart-money  │ │ (P/E, P/B, ROE, EPS)  │ │
│  │  [CÓ SẴN]      │ │  [CÓ SẴN]     │ │  [MỚI — verify first] │ │
│  └───────┬────────┘ └───────┬───────┘ └───────────┬───────────┘ │
│          │ industry-stats   │                     │             │
│          │ (lucCau) [SẴN]   │                     │             │
└──────────┼──────────────────┼─────────────────────┼─────────────┘
           ▼                  ▼                     ▼
┌────────────────────────────────────────────────────────────────┐
│  SCORING LAYER                                                  │
│  server/scoring/sector-score.js  [MỚI]                          │
│    computeSectorScore(icb2Code) → {score 0-100, grade, breakdown}│
│  server/scoring/score.js         [CÓ SẴN — CP level]            │
└──────────────────────────────────┬──────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────┐
│  PICKER LAYER                                                   │
│  server/scoring/picker.js  [MỚI]                                │
│    - Phân loại ngành mạnh (A+) / yếu (D)                        │
│    - screener.screenAll() [CÓ SẴN] → SEPA top picks             │
│    - Valuation filter (P/E vs median ngành)                     │
│    - effectiveScore = SEPA × (sectorScore/100)^0.6              │
│    - generateSignal() [CÓ SẴN] → entry/stop/target              │
│    - positionSize() [CÓ SẴN] → size + sector cap (maxSectorPct) │
└──────────────────────────────────┬──────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────┐
│  AI LAYER                                                       │
│  server/ai.js  [mở rộng: assemblePickerContext + prompt]        │
│    - JSON context gọn (sector scores + top 15-20 candidates)    │
│    - LLM chỉ xếp hạng cuối + giải thích (không pick từ thô)     │
│    - Fallback chain: GLM-5.2 → DeepSeek → Gemini  [CÓ SẴN]      │
└──────────────────────────────────┬──────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────┐
│  API + UI LAYER                                                 │
│  /api/sector-strength  /api/ai/stock-picker  [MỚI]              │
│  Tab "AI Đánh Giá Ngành" trong index.html  [MỚI]                │
└─────────────────────────────────────────────────────────────────┘
```

## 4. Sector Score Formula — 9 yếu tố (mirror 9 yếu tố `computeSEPA`)

Trọng số thiên về swing (momentum + trend + flow = 67%, định giá nhẹ 5%). Grade: **A+ ≥85, A ≥70, B ≥55, C ≥40, D <40** (giống `score.js`).

| # | Yếu tố | Weight | Data source | Tương đương CP |
|---|---|---|---|---|
| 1 | Breadth Trend | 22% | ma-breadth-history | Trend Template (25%) |
| 2 | RS ngành vs VNINDEX | 18% | ma-breadth-close + VNINDEX | RS rating (15%) |
| 3 | Smart-money flow 20D | 15% | fiintrade `getSectorFlow(20)` | — (mới) |
| 4 | Momentum breadth | 12% | computeTA (MACD hist) | MACD hist (8%) |
| 5 | Breadth expansion | 10% | ma-breadth-history | VCP (15%) |
| 6 | lucCau hiện tại | 8% | industry-stats | Pocket Pivot (5%) |
| 7 | MA alignment breadth | 6% | ma-breadth-history | MA alignment (10%) |
| 8 | Valuation (P/E, P/B) | 5% | fundamentals (MỚI) | Distance MA20 (4%) |
| 9 | Liquidity | 4% | industry-stats | Bollinger squeeze (3%) |

### Công thức từng yếu tố (mỗi cái → 0–100, rồi nhân weight)

**1️⃣ Breadth Trend (22%)** — "trend lành mạnh" của Minervini ở cấp ngành
```
pctMA50_now      = %CP ngành trên MA50 (hiện tại)
pctMA50_20dAgo   = %CP ngành trên MA50 (20 phiên trước) — từ getBreadth({scope:'industry', industryCode, days:21})
base   = clamp((pctMA50_now - 20) / (70 - 20) × 100, 0, 100)   // <20%=0, ≥70%=100
slope  = clamp((pctMA50_now - pctMA50_20dAgo) × 4, -30, +30)   // đang mở rộng?
score  = clamp(base + slope, 0, 100)
```

**2️⃣ RS ngành vs VNINDEX (18%)** — outperform index?
```
sectorReturn_3m = trung bình return 3 tháng các CP ngành (cap-weight nếu có marketCap)
indexReturn_3m  = VNINDEX return 3 tháng — từ closes trong ma-breadth-close
outperformance  = sectorReturn_3m - indexReturn_3m
score = clamp(50 + outperformance × 25, 0, 100)   // reuse logic rsRating()
```

**3️⃣ Smart-money flow 20D (15%)** — tổ chức/TĐ/NĐTNN gom hay xả?
```
netFlow_20d = (Org + Prop + Foreign) net 20 ngày — từ getSectorFlow(20)
totalValue  = tổng giá trị GD ngành 20 ngày
netPct      = netFlow_20d / totalValue × 100        // chuẩn hóa quy mô
score = clamp(50 + netPct × 8, 0, 100)              // >0=gom(+), <0=xả(-)
```

**4️⃣ Momentum breadth (12%)** — đà tăng rộng?
```
pctMACDpos = %CP ngành có MACD histogram > 0 — reuse computeTA per symbol
score = pctMACDpos                                  // trực tiếp 0-100
```

**5️⃣ Breadth expansion (10%)** — sức mạnh lan rộng?
```
pctMA20_now    = %CP trên MA20 (hiện tại)
pctMA20_10dAgo = %CP trên MA20 (10 phiên trước)
delta = pctMA20_now - pctMA20_10dAgo
score = clamp(50 + delta × 5, 0, 100)
```

**6️⃣ lucCau hiện tại (8%)** — lực cầu phiên (đã có sẵn)
```
score = clamp((lucCau - 40) / (60 - 40) × 100, 0, 100)   // <40%=yếu, ≥60%=mạnh
```
Reuse logic `aggregateLucCauByValue` (`server.js:151-170`).

**7️⃣ MA alignment breadth (6%)** — cấu trúc MA xếp chồng khỏe?
```
healthy = (pctMA10 > pctMA20) AND (pctMA20 > pctMA50)   // stack bullish
score = healthy ? 100 : (pctMA10 > pctMA20 ? 60 : 30)
```

**8️⃣ Valuation (P/E, P/B) (5%)** — bị định giá quá cao không? (swing: chỉ filter)
```
pe_avg = P/E trung bình ngành (cap-weight) — từ fundamentals
pb_avg = P/B trung bình ngành
peScore = clamp((30 - pe_avg) / (30 - 10) × 100, 0, 100)   // 10=đẹp, 30=đắt
pbScore = clamp((3 - pb_avg) / (3 - 1) × 100, 0, 100)      // 1=đẹp, 3=đắt
score = (peScore + pbScore) / 2
HARD FILTER: P/E ngành > 40 → phạt nặng (−20 điểm composite)
```

**9️⃣ Liquidity (4%)** — đủ thanh khoản swing?
```
totalValue_20d = tổng giá trị GD ngành 20 ngày
score = percentileRank(totalValue_20d trong 20 ngành)      // rank tương đối
HARD FILTER: ngành thanh khoản dưới top-5% → floor điểm
```

**Composite:**
```
composite = Σ (factorScore_i × weight_i)   // clamp 0-100
grade     = gradeFor(composite)
breakdown = { breadthTrend, rsVsIndex, smartMoney20D, momentumBreadth,
              breadthExpansion, lucCau, maAlignment, valuation, liquidity }
```

### Đa chiều hơn hiện tại

| Chiều | Tín hiệu | Timeframe |
|---|---|---|
| Trend | breadth trend + MA alignment | trung hạn |
| Momentum | MACD breadth + expansion | ngắn-trung hạn |
| Dòng tiền | smart-money 20D + lucCau | ngắn hạn |
| RS | outperform index | 3 tháng |
| Định giá | P/E-P/B | dài hạn (filter) |
| Thanh khoản | giá trị GD | — (filter) |

**Ví dụ khắc phục "mạnh giả":** Ngân hàng `lucCau` cao (bubble sáng) nhưng breadth thu hẹp (#5 âm) + smart-money xả 20D (#3 âm) → composite thấp → tránh bẫy. Ngược lại, breadth mở rộng + smart-money gom âm thầm → phát hiện sớm trước khi giá nổ.

## 5. Picker Logic

```
[1] computeSectorScore() cho 20 ngành ICB2
        ↓
[2] Phân loại: MẠNH (score≥70, A/A+) / TRUNG BÌNH (55-69, B) / YẾU (<40, D)
        ↓
[3] screener.screenAll({minScore:70, grade:'A'})  [CÓ SẴN]
     → SEPA top picks (CP đã có điểm TA composite)
        ↓
[4] FILTER:
     - GIỮ CP thuộc ngành mạnh/trung bình
     - LOẠ CP thuộc ngành yếu (D)
     - Valuation: P/E_CP > 2× median(P/E ngành) → FLAG "đắt trong ngành", phạt điểm
       (P/E so median ngành chứ không absolute — Ngân hàng P/E 15 OK, Tech 25 OK)
        ↓
[5] RANK theo effectiveScore:
     effectiveScore = stockSEPA × (sectorScore / 100) ^ 0.6
     // boost nhẹ cho CP thuộc ngành A+, phạt ngành yếu
        ↓
[6] REUSE generateSignal() → action/entry/stop/target1/target2/atr/rr  [CÓ SẴN]
     REUSE positionSize() → size + sector cap (maxSectorPct 40)  [CÓ SẴN]
        ↓
[7] OUTPUT: top 15-20 candidates (pre-rank) cho LLM
```

**Portfolio-level:** `positionSize` đã có `maxSectorPct: 40` → picker tự nhiên diversify ngành (không cho 1 ngành chiếm >40% portfolio). Đây là tư duy portfolio-level, không chỉ pick rời rạc.

## 6. AI Layer (Hybrid)

**Nguyên tắc: không để LLM pick từ data thô (tránh ảo).** Thuật toán deterministic làm sạch + pre-rank, LLM chỉ reasoning trên kết quả đã chắt.

```
[Thuật toán đã làm]
  - sector scores (20 ngành + breakdown)
  - top 15-20 candidates (đã filter + rank + entry/stop/size)
  - valuation context (P/E median ngành)
        ↓  assemblePickerContext() → JSON gọn (~2-4K tokens)
[LLM chỉ làm 2 việc:]
  1. XẾP HẠNG lại top 5-10 cuối (có thể đảo thứ tự dựa reasoning)
  2. GIẢI THÍCH mỗi pick: "Tại sao mã này? Ngành mạnh ở điểm nào? Rủi ro gì?"
        ↓  output JSON strict (parse được)
  [{ symbol, rank, sectorReason, stockReason, entry, stop, target1,
     sizePct, riskNote }]
```

- Persona: analyst kỹ thuật + dòng tiền VN.
- Fallback chain: GLM-5.2 → DeepSeek → Gemini (reuse `ai.js`).
- **Cache kết quả 1 phiên** trong memory (LLM chậm, không gọi liên tục).

## 7. UI — Tab "AI Đánh Giá Ngành"

Trong `index.html`, tab mới song song "Báo Cáo AI":

```
┌───────────────────────────────────────────────────────┐
│  [XẾP HẠNG NGÀNH]                  [TOP CP AI CHỌN]   │
│ ┌─────────────────────────────────┐ ┌────────────────┐│
│ │ Ngành       Score  Grade  Trend │ │ Mã  Ngành SEPA ││
│ │ Ngân hàng   82    A+     ▲      │ │ VCB  BKG  78   ││
│ │ BĐS         74    A      ▲      │ │ TCB  BKG  76   ││
│ │ ...                              │ │ [lý do AI...]  ││
│ │ (mini breakdown bar 9 yếu tố)    │ │ entry/stop/size││
│ └─────────────────────────────────┘ └────────────────┘│
│              [Nút: Chạy AI Pick] (async)              │
└───────────────────────────────────────────────────────┘
```

- **Trái:** bảng 20 ngành sort by score, mỗi ngành grade + trend arrow + mini breakdown bar (9 yếu tố hover).
- **Phải:** top picks từ LLM, mỗi CP: ticker, ngành (kèm sector score), điểm SEPA, lý do AI, entry/stop/target, size.
- **Nút "Chạy AI Pick"** async (loading state), cache kết quả phiên.
- Reuse GridStack + Chart.js patterns hiện có.

## 8. Files — mới vs sửa

| File | Loại | Mục đích |
|---|---|---|
| `server/data/fundamentals.js` | MỚI | Fetch + cache P/E, P/B, ROE, EPS FireAnt → `server/data/fundamentals.json` |
| `server/scoring/sector-score.js` | MỚI | `computeSectorScore(icb2Code)` mirror `score.js` (9 yếu tố) |
| `server/scoring/sector-score.test.js` | MỚI | Unit test 9 yếu tố + composite + grade |
| `server/scoring/picker.js` | MỚI | Lọc SEPA picks theo ngành mạnh + valuation + rank |
| `server/scoring/picker.test.js` | MỚI | Unit test filter/rank logic |
| `server/ai.js` | SỬA | Thêm `assemblePickerContext()` + `generateStockPick()` + persona prompt |
| `server/server.js` | SỬA | Thêm 2 route `/api/sector-strength`, `/api/ai/stock-picker` |
| `server/scheduler.js` | SỬA | Thêm job refresh fundamentals 1 lần/ngày (sau đóng cửa) |
| `index.html` | SỬA | Thêm nav button + tab-content "AI Đánh Giá Ngành" |
| `js/app.js` | SỬA | Thêm render logic cho tab mới |

## 9. Data Layer — chi tiết

### 9.1 Fundamentals (MỚI) — verify-first

**Bước đầu tiên khi implement:** kiểm tra xem FireAnt `/Markets/TradingStatistic` (đã gọi ở 6+ nơi: `server.js:682,814,957,2191,2477,2741,2874`) **đã trả về P/E, P/B, MarketCap** chưa. Chỉ extract thêm field nếu đã có.

- Nếu TradingStatistic **đã có** → không cần endpoint mới, chỉ extract field + cache.
- Nếu **không có** → dùng FireAnt `/Companies/{symbol}/Metrics` (verify URL thực tế).

**Cache:** `server/data/fundamentals.json`, TTL 1 ngày (fundamentals đổi chậm, đỡ rate-limit/cookie).
Shape:
```json
{
  "meta": { "version": 1, "lastUpdated": "2026-07-31T..." },
  "symbols": {
    "VCB": { "pe": 14.2, "pb": 2.1, "roe": 24.0, "eps": 9800, "marketCap": 580e12, "updatedAt": "..." }
  }
}
```

**Refresh:** scheduler chạy 1 lần/ngày sau đóng cửa (tránh tốn quota phiên). Reuse scheduler pattern hiện có (`scheduler.js:46` warm lucCau mỗi 55s).

### 9.2 Data tái sử dụng (không rebuild)

| Hàm | File | Dùng cho yếu tố |
|---|---|---|
| `breadthHistory.getBreadth({scope:'industry', industryCode, days})` | `breadth-history.js:272` | #1, #5, #7 |
| `fiintrade.getSectorFlow(20, 2)` | `fiintrade.js:83` | #3 |
| `aggregateLucCauByValue` | `server.js:151` | #6 (trích ra helper) |
| `computeTA(history)` | `ta/index.js:19` | #4 |
| `rsRating(stockCloses, benchCloses)` | `scoring/rs.js` | #2 (aggregate trước) |
| `screenAll({minScore,grade,limit})` | `scoring/screener.js:24` | picker step 3 |
| `generateSignal(scoreResult, ta, price, position)` | `signals/signal.js:11` | picker step 6 |
| `positionSize(...)` | `signals/risk.js` | picker step 6 (maxSectorPct) |
| `ICB2_MAP` (20 ngành) | `breadth-history.js:38` | phân loại |

## 10. API Endpoints

### `GET /api/sector-strength`
Trả sector scores cho 20 ngành ICB2.
```json
{
  "success": true,
  "generatedAt": "...",
  "sectors": [
    { "code": "8300", "name": "Ngân hàng", "score": 82, "grade": "A+",
      "trend": "up", "stockCount": 25, "breakdown": { "breadthTrend": 78, "rsVsIndex": 85, ... } }
  ]
}
```

### `POST /api/ai/stock-picker`
Body: `{ account, maxPicks }`. Trả top picks + reasoning từ LLM.
```json
{
  "success": true,
  "generatedAt": "...",
  "sectorContext": [ ... top ngành ... ],
  "picks": [
    { "symbol": "VCB", "rank": 1, "sector": "8300", "sectorScore": 82,
      "sepaScore": 78, "sepaGrade": "A",
      "sectorReason": "Ngành Ngân hàng breadth mở rộng, smart-money gom 20D...",
      "stockReason": "VCB RS mạnh vs VNINDEX, VCP co hẹp, breakout pocket pivot...",
      "entry": 95000, "stop": 91000, "target1": 103000, "atr": 1800, "rr": 2.2,
      "sizePct": 8, "riskNote": "Thanh khoản phiên giảm nhẹ, canh MA10" }
  ]
}
```

## 11. Edge cases & Error handling

- **Thiếu fundamentals** (chưa backfill): valuation factor (5%) → skip, normalize weight còn lại (×1/0.95). Picker valuation filter → soft (warn thay vì hard reject).
- **Ngành < 3 CP đủ thanh khoản**: skip sector score (không đủ ý nghĩa thống kê), không hiển thị.
- **breadth history < 20 ngày**: yếu tố #1/#5 fallback dùng giá hiện tại (score neutral 50), đánh dấu `lowConfidence`.
- **fiintrade rate-limit/timeout**: yếu tố #3 → neutral 50 + flag `dataPartial`. Không crash.
- **LLM timeout/fail**: trả top picks từ thuật toán (pre-rank, không lý do) + flag `aiFallback=true`. Frontend hiện notice "AI không khả dụng, hiển thị xếp hạng thuật toán".
- **Market đóng cửa**: lucCau = giá phiên gần nhất (đã có logic). Sector score vẫn tính được (dùng breadth/flow/RS).
- **Cookie FireAnt hết hạn**: fundamentals fetch fail → reuse fundamentals.json cũ (stale nhưng vẫn dùng được) + flag `staleData`.

## 12. Testing

- **Unit (Vitest):**
  - `sector-score.test.js`: từng yếu tố → đúng 0-100, composite đúng weight, grade đúng ngưỡng, hard filter P/E>40 hoạt động.
  - `picker.test.js`: filter ngành yếu, valuation flag, effectiveScore đúng công thức, rank đúng thứ tự.
- **Property-based (fast-check):** composite luôn ∈ [0,100] với mọi input; breakdown factor luôn ∈ [0,100].
- **Integration:** `/api/sector-strength` trả 20 ngành; `/api/ai/stock-picker` với mock LLM trả đúng shape JSON.
- **Smoke:** chạy thật 1 lần trên data hiện có, verify không crash + output hợp lý (Ngân hàng/BĐS/Thép không bị điểm bất thường).

## 13. Out of scope (YAGNI)

- Fundamentals đầy đủ (ROA, doanh thu, biên, nợ/vốn, tăng trưởng QoQ/YoY) — chỉ P/E, P/B, ROE, EPS cốt lõi.
- Backtest sector score + optimize weights — để phase sau (như `optimize.js` cho CP). Phase 1 dùng weight cố định dựa lý thuyết swing.
- 3 mode horizon (swing/đầu tư/lướt sóng) — phase 1 chỉ swing.
- Auto-place order từ picks — picks chỉ là recommend, không auto-trade.
- Real-time refresh sector score — compute on-demand + cache phiên (đủ cho swing).
- Push notification/email khi sector đổi grade.

## 14. Thứ tự implement (gợi ý)

1. **Fundamentals fetcher** (`server/data/fundamentals.js`) + verify TradingStatistic có trả P/E/P/B không.
2. **Sector score** (`server/scoring/sector-score.js` + test) — core, test kỹ.
3. **Picker** (`server/scoring/picker.js` + test) — phụ thuộc sector score + screenAll.
4. **AI layer** (`server/ai.js` mở rộng) — assemblePickerContext + prompt + cache.
5. **API routes** (`server/server.js`) — `/api/section-strength`, `/api/ai/stock-picker`.
6. **Scheduler** — refresh fundamentals hằng ngày.
7. **UI** (`index.html` + `js/app.js`) — tab mới + render.
8. **Smoke test** trên data thật.
