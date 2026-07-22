# Subsystem #5: Broker Integration — Design Spec

> **Context:** Phần thứ 5. Kết nối broker (SSI/DNSE) để đặt lệnh. **Mặc định paper/simulated mode** — bạn test hệ thống bằng tay trước, bật live mode khi sẵn sàng.

**Ngày:** 2026-07-22
**Trạng thái:** Tự phê duyệt
**Phụ thuộc:** #4 (signal gen)

## 1. Mục tiêu
- **Broker interface abstract**: API chung cho mọi broker (placeOrder, cancelOrder, getPortfolio, getBalance).
- **3 adapters**: Paper (mock, default), SSI (FastConnect), DNSE (Lightspeed).
- **Safety**: mặc định paper mode; live mode cần env flag explicit + confirmation.
- Bạn test hệ thống giao dịch bằng tay (paper) trước khi tính live.

## 2. Kiến trúc

### 2.1 Module layout
```
server/
  broker/
    interface.js       abstract broker interface (JSDoc contract)
    paper.js           Paper/Mock adapter — simulate orders, log, no real broker
    ssi.js             SSI FastConnect adapter (Python SDK subprocess)
    dnse.js            DNSE Lightspeed adapter (HTTP)
    factory.js         getBroker() → trả adapter theo config (env BROKER_MODE)
    index.js           barrel
  trading/
    order.js           Order model (symbol, side, qty, price, type, status)
    portfolio.js       Portfolio state (positions, cash, P&L) — DB-backed (#6)
  __tests__/broker/
    paper.test.js
    factory.test.js
```

### 2.2 Broker interface (`interface.js`)

```js
// Abstract contract — mọi adapter implement:
{
  async placeOrder(order)   → { orderId, status, ... }
  async cancelOrder(orderId)→ { success, status }
  async amendOrder(orderId, changes) → { ... }
  async getOrders()         → [orders]
  async getPortfolio()      → { positions, cash, totalValue }
  async getBalance()        → { cash, buyingPower }
  async subscribeQuotes(symbols, cb)  // realtime quotes (optional)
  mode                      // 'paper' | 'live'
}
```

### 2.3 Paper adapter (`paper.js`) — DEFAULT
- Mô phỏng placeOrder: ghi vào DB table `paper_orders` + log. KHÔNG gọi broker thật.
- Mô phỏng fill: order LO/ATO/ATC → fill logic đơn giản (dùng giá close hiện tại).
- Portfolio state: track positions, cash, P&L từ paper orders.
- Mode = 'paper'. An toàn 100%.

### 2.4 SSI adapter (`ssi.js`) — LIVE
- Gọi SSI FastConnect Python SDK qua `child_process.spawn('python', ['-m', 'fctrading', ...])`.
- Auth: SSI account credentials (env `SSI_CONSUMER_ID`, `SSI_CONSUMER_SECRET`, account).
- **Chỉ active khi `BROKER_MODE=ssi`** (env explicit). Mặc định không active.
- Cần Python + fctrading SDK cài trong Docker image (thêm layer).

### 2.5 DNSE adapter (`dnse.js`) — LIVE
- Gọi DNSE Lightspeed HTTP API trực tiếp (axios).
- Auth: DNSE account token.
- **Chỉ active khi `BROKER_MODE=dnse`**.

### 2.6 Factory (`factory.js`)
```js
function getBroker() {
  const mode = process.env.BROKER_MODE || 'paper';
  switch (mode) {
    case 'ssi': return new SSIBroker();
    case 'dnse': return new DNSEBroker();
    case 'paper':
    default: return new PaperBroker();  // SAFE DEFAULT
  }
}
```

### 2.7 Endpoints
- `GET /api/broker/status` — broker mode, connection status.
- `POST /api/broker/place-order` — place order (paper/live tuỳ mode). Body: order.
- `POST /api/broker/cancel-order/:id`
- `GET /api/broker/portfolio` — paper portfolio state.
- `POST /api/admin/broker-mode` — switch mode (admin, cần confirm cho live).

### 2.8 DB tables (migrations)
- `paper_orders` — id, symbol, side, qty, price, type, status, created_at, filled_at, fill_price.
- `paper_positions` — symbol, qty, avg_cost, current_value, pnl.
- (SSI/DNSE live dùng portfolio thật từ broker API, không track local.)

## 3. Safety
- **Mặc định BROKER_MODE=paper.** Live cần env explicit + admin confirm endpoint.
- Paper mode: 0 rủi ro, full test.
- Live mode: log mọi order, kill-switch (#6) có thể dừng tức thì.
- Order validation: qty lô chẵn 100, price trong band giá HOSE, symbol hợp lệ.

## 4. Testing (TDD)
- `paper.test.js`: placeOrder → status pending→filled; portfolio update; cancel.
- `factory.test.js`: getBroker theo env trả đúng adapter.
- SSI/DNSE adapter: test với mock HTTP/subprocess (không test live trong CI).

## 5. Out of scope (#6)
- Auto-exec loop (polling signals → auto place orders) = #6.
- Kill-switch emergency stop = #6.
- Portfolio P&L realtime tracking + alerts = #6.

## 6. Success Criteria
1. Paper adapter fully functional (place/cancel/portfolio), tested.
2. SSI + DNSE adapter scaffold (interface đúng, auth stubbed — live test khi bạn có account).
3. Factory + endpoints hoạt động.
4. DB migration paper_orders/positions.
5. `npm test` pass.
