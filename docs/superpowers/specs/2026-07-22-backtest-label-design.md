# Subsystem #3: Backtest + Label — Design Spec

> **Context:** Phần thứ 3 của lộ trình Auto-Trade VN. Đo lường "pick theo SEPA score có thật sự thắng không" + tối ưu trọng số yếu tố (light learning) dựa trên kết quả回测.

**Ngày:** 2026-07-22
**Trạng thái:** Tự phê duyệt (user ủy quyền "auto 100%")
**Phụ thuộc:** #1 (ta engine + price-history), #2 (computeSEPA)

---

## 1. Mục tiêu

1. **Label outcome**: cho mỗi điểm (symbol, ngày), đo forward return từ **T+3** (T+2.5 settlement VN) → biết pick đó thắng/thua.
2. **Backtest engine**: chạy score trên lịch sử, so sánh với outcome → baseline metrics (win rate, avg return, risk-adjusted).
3. **Light learning**: tối ưu trọng số (weights) yếu tố bằng grid search / regression để max risk-adjusted return. "Tự học" = tính lại trọng số định kỳ.

## 2. Kiến trúc

### 2.1 Module layout
```
server/
  backtest/
    label.js        forwardReturn(history, entryIdx, holdDays) → metrics
    engine.js       backtest({fromDate,toDate,minScore}) → aggregate metrics
    optimize.js     optimizeWeights(history) → optimal weights
    index.js        barrel
  __tests__/backtest/
    label.test.js
    engine.test.js
  data/
    backtest-results.json   snapshot回测 gần nhất (auto-ignore)
```

### 2.2 Label (`label.js`)

`forwardReturn(history, entryIdx, holdDays)`:
- **Entry = close tại entryIdx.** Exit = close tại `entryIdx + holdDays` (skip T+1, T+2 do T+2.5 settlement → holdDays tính từ T+3).
- Trả: `{ return: %, maxDrawdown: %, maxGain: %, holdDays }`.
- holdDays options: 5 (lướt sóng), 10 (T+2-T+10), 20 (swing/trend 1 tháng).
- Mặc định holdDays = 10 (theo yêu cầu user: lướt T+2-T+10).

**Label binary** (cho learning): `return >= threshold` → "win" (threshold mặc định +5%).

### 2.3 Engine (`engine.js`)

`backtest({ fromDate, toDate, minScore, holdDays })`:
- Lặp qua mỗi ngày giao dịch trong [fromDate, toDate].
- Mỗi ngày: tính computeSEPA cho tất cả symbol (snapshot tại ngày đó), filter minScore → "pick list".
- Cho mỗi pick: tính forwardReturn từ entry = ngày đó.
- Aggregate:
  - `winRate` = % pick có return ≥ threshold
  - `avgReturn`, `medianReturn`
  - `avgMaxDrawdown` (risk)
  - `riskAdjusted` = avgReturn / avgMaxDrawdown
  - `totalPicks`, `perGrade` breakdown (A+/A/B/C winRate)
- Trả object metrics + sample picks.

### 2.4 Optimize (`optimize.js`)

`optimizeWeights(history)`:
- Test ~5-10 tổ hợp trọng số (grid search coarse) — vd: variations nhấn strong-trend vs value vs momentum.
- Mỗi tổ hợp → chạy回测 ngắn (90 ngày gần) → so riskAdjusted.
- Trả trọng số tốt nhất + metrics so sánh.
- **Output**: ghi vào `config/scoring-weights.json` (computeSEPA đọc weight từ đây thay vì hardcode).
- Chạy định kỳ: endpoint `/api/admin/optimize-weights` (admin trigger) hoặc weekly cron.

### 2.5 Endpoints
- `POST /api/admin/backtest` — chạy回测 (body: fromDate, toDate, minScore, holdDays). Trả metrics. Cache result vào backtest-results.json.
- `GET /api/backtest/last` — xem snapshot回测 gần nhất.
- `POST /api/admin/optimize-weights` — chạy optimize, lưu trọng số mới.

## 3. Ràng buộc T+2.5 (luật VN)

- Mua T0 → tiền+hàng về T+2.5 → **bán sớm nhất T+3**.
- Backtest: holdDays đếm từ entry, nhưng **forwardReturn skip 2 ngày đầu** (T+1, T+2 không bán được) → exit = entry + 2 + holdDays thực. Giá trị mặc định holdDays=10 → exit thực ~ngày 12.
- Module `server/trading/vn-settlement.js` (tách riêng, tái dùng cho #4/#5): `earliestExitDay(entryIdx) = entryIdx + 3`.

## 4. Testing (TDD)
- `label.test.js`: forwardReturn crafted — entry 100, exit 110 → return 10%; maxDrawdown chuỗi dip 95 rồi lên 110.
- `engine.test.js`: backtest trên data giả (3 symbol × 30 ngày) → winRate/avgReturn đúng.

## 5. Success Criteria
1. `forwardReturn` + `backtest` + `optimizeWeights` tested.
2. `/api/admin/backtest` trả metrics đầy đủ.
3. computeSEPA đọc trọng số từ config (có thể optimize).
4. `npm test` pass.

## 6. Out of scope (#4)
- Signal BUY/SELL/EXIT cụ thể + position sizing + stop-loss = #4.
