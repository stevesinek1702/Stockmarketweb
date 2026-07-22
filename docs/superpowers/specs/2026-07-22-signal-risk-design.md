# Subsystem #4: Signal Generation + Risk Management — Design Spec

> **Context:** Phần thứ 4. Lấy SEPA score (#2) + TA (#1) → tạo tín hiệu MUA/BÁN/THOÁT cụ thể + quản trị rủi ro (stop-loss ATR, position sizing). Cầu nối tới broker (#5).

**Ngày:** 2026-07-22
**Trạng thái:** Tự phê duyệt
**Phụ thuộc:** #1, #2, #3

## 1. Mục tiêu
- **Signal gen**: khi nào MUA (entry), BÁN (exit tp/sl), HOLD, WATCH.
- **Risk mgmt**: stop-loss ATR-based, position sizing theo % vốn, max positions, max sector exposure.
- Output: mỗi mã có 1 "trade plan" cụ thể (entry, stop, target, size, risk/reward).

## 2. Kiến trúc

### 2.1 Module layout
```
server/
  signals/
    signal.js     generateSignal(symbol, score, ta) → {action, entry, stop, targets, reason}
    risk.js       positionSize(account, entry, stop) → shares + risk$
    config.js     risk config (defaults, override qua env)
    index.js      barrel
  __tests__/signals/
    signal.test.js
    risk.test.js
  trading/
    vn-settlement.js  (đã có ở #3)
```

### 2.2 Signal rules (`signal.js`)

`generateSignal(score, ta, price)`:
- **BUY**: `score >= 70 (grade A/A+)` AND `trendTemplate.pass=true` AND (`vcp.isVCP` OR `pocketPivot.detected`). Entry = giá hiện tại.
- **WATCH**: `score >= 55 (grade B)` — theo dõi, chưa mua (đợi confirm).
- **HOLD**: đang giữ + `score >= 50` AND price > MA50 → giữ.
- **SELL (TP)**: price >= target (target = entry + 2×risk, R:R=2:1).
- **SELL (SL)**: price <= stop (stop = entry - 2×ATR).
- **EXIT (signal weaken)**: đang giữ + `score < 40` OR `price < MA50` → thoát.

Trả: `{ action, entry, stop, target1, target2, atr, rr (risk/reward), reason }`.

### 2.3 Risk mgmt (`risk.js`)

`positionSize(accountValue, entry, stop, riskPct=1.0)`:
- risk$ = accountValue × riskPct/100 (mặc định 1% vốn / trade).
- shares = floor(risk$ / (entry - stop)).
- Cap: max 25% vốn / 1 position (tránh over-concentrate).

Config (env-overridable):
- `RISK_PER_TRADE_PCT=1.0` (% vốn rủi ro/trade)
- `MAX_POSITION_PCT=25` (max % vốn/position)
- `MAX_OPEN_POSITIONS=10`
- `MAX_SECTOR_PCT=40` (max % vốn/ngành)

### 2.4 Endpoints
- `GET /api/signals` — danh sách signal hiện tại (BUY/WATCH) cho tất cả symbol có score cao. Cache 5 phút.
- `GET /api/signal/:symbol` — trade plan chi tiết 1 mã (entry/stop/target/size).
- `POST /api/admin/risk-config` — get/set risk config (admin).

## 3. Testing (TDD)
- `signal.test.js`: BUY khi score 75 + TT pass + VCP; SELL SL khi price<stop; EXIT khi score<40.
- `risk.test.js`: positionSize 10M vốn, entry 100, stop 95 (ATR 2.5) → shares đúng; cap 25%.

## 4. Out of scope (#5/#6)
- Broker order placement = #5.
- Auto-exec loop + kill-switch = #6.
- Portfolio state tracking (đang giữ gì, P&L) = #6 (cần DB table).

## 5. Success Criteria
1. `generateSignal` + `positionSize` tested.
2. `/api/signals` + `/api/signal/:symbol` hoạt động.
3. Risk config env-overridable.
4. `npm test` pass.
