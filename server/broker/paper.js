/**
 * Paper/Mock broker — mô phỏng đặt lệnh, KHÔNG gọi broker thật.
 *
 * State lưu trong Redis (cluster-safe: mọi PM2 worker share cùng state).
 * Key: paper:state → { cash, positions, orders, log }
 *
 * Fill logic:
 *   - LO: fill ngay ở price
 *   - ATO/ATC/MP: fill ở giá tham chiếu (currentPrice)
 */
const { createOrder } = require('../trading/order');

const STATE_KEY = 'paper:state';
const DEFAULT_CAPITAL = 1_000_000_000;

// Fallback in-memory (khi Redis không khả dụng — vd test không có Redis).
let _memStore = null;

function _getRedis() {
  // Chỉ dùng Redis khi có REDIS_URL (tránh timeout kết nối trong test/dev không Redis).
  if (!process.env.REDIS_URL) return null;
  try { return require('../redis-client').redis; } catch (e) { return null; }
}

async function _loadState() {
  const redis = _getRedis();
  if (redis) {
    try {
      const raw = await redis.get(STATE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to default */ }
  }
  if (_memStore) return _memStore;
  return { cash: DEFAULT_CAPITAL, positions: {}, orders: [], log: [] };
}

async function _saveState(state) {
  const redis = _getRedis();
  if (redis) {
    try {
      if (state.log.length > 500) state.log = state.log.slice(-500);
      if (state.orders.length > 500) state.orders = state.orders.slice(-500);
      await redis.set(STATE_KEY, JSON.stringify(state));
      return;
    } catch (e) { /* fall back to memory */ }
  }
  _memStore = state;
}

class PaperBroker {
  constructor() {
    this.mode = 'paper';
  }

  async placeOrder(input, ctx = {}) {
    try {
      const order = createOrder(input);
      const fillPrice = order.price || (ctx && ctx.currentPrice) || 0;
      if (fillPrice <= 0) {
        order.status = 'rejected';
        return order;
      }
      order.status = 'filled';
      order.filledQty = order.qty;
      order.fillPrice = fillPrice;
      order.filledAt = new Date().toISOString();

      const state = await _loadState();
      // Apply fill
      const value = order.qty * fillPrice;
      if (order.side === 'BUY') {
        state.cash -= value;
        const pos = state.positions[order.symbol] || { qty: 0, avgCost: 0 };
        const newQty = pos.qty + order.qty;
        pos.avgCost = (pos.qty * pos.avgCost + value) / newQty;
        pos.qty = newQty;
        state.positions[order.symbol] = pos;
      } else {
        state.cash += value;
        const pos = state.positions[order.symbol];
        if (pos) pos.qty -= order.qty;
      }
      state.orders.push(order);
      state.log.push({ ts: new Date().toISOString(), action: 'FILL', orderId: order.id,
                       symbol: order.symbol, side: order.side, qty: order.qty, price: fillPrice });
      await _saveState(state);
      return order;
    } catch (e) {
      return { status: 'rejected', error: e.message };
    }
  }

  async cancelOrder(orderId) {
    const state = await _loadState();
    const o = state.orders.find(x => x.id === orderId);
    if (o && o.status === 'open') {
      o.status = 'cancelled';
      await _saveState(state);
      return { success: true, status: 'cancelled' };
    }
    return { success: false, status: o ? o.status : 'not_found' };
  }

  async amendOrder(orderId, changes) {
    const state = await _loadState();
    const o = state.orders.find(x => x.id === orderId);
    if (!o || o.status !== 'open') return { success: false, error: 'cannot amend' };
    Object.assign(o, changes);
    await _saveState(state);
    return { success: true, order: o };
  }

  async getOrders() { return (await _loadState()).orders; }

  async getPortfolio(ctx = {}) {
    const state = await _loadState();
    const positions = Object.entries(state.positions)
      .filter(([_, p]) => p.qty !== 0)
      .map(([symbol, p]) => {
        const px = (ctx.prices && ctx.prices[symbol]) || p.avgCost;
        const value = p.qty * px;
        const pnl = p.qty > 0 ? (px - p.avgCost) * p.qty : 0;
        return { symbol, qty: p.qty, avgCost: p.avgCost, currentPrice: px, value, pnl };
      });
    const positionsValue = positions.reduce((s, p) => s + p.value, 0);
    return {
      cash: state.cash,
      positionsValue,
      totalValue: state.cash + positionsValue,
      positions,
      mode: this.mode
    };
  }

  async getBalance() {
    const state = await _loadState();
    return { cash: state.cash, buyingPower: state.cash, mode: this.mode };
  }

  async resetNav(capital) {
    const c = parseFloat(capital) || DEFAULT_CAPITAL;
    const state = { cash: c, positions: {}, orders: [], log: [{ ts: new Date().toISOString(), action: 'RESET_NAV', note: 'NAV=' + c }] };
    await _saveState(state);
    return { success: true, cash: c, mode: this.mode };
  }
}

module.exports = { PaperBroker };
