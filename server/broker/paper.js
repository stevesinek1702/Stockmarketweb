/**
 * Paper/Mock broker — mô phỏng đặt lệnh, KHÔNG gọi broker thật.
 * Mặc định an toàn 100%. Track portfolio state in-memory (DB-backed ở #6).
 *
 * Fill logic đơn giản:
 *   - LO: fill ngay ở price (giả định market hit)
 *   - ATO/ATC/MP: fill ở giá tham chiếu (currentPrice truyền vào)
 */
const { createOrder } = require('../trading/order');

class PaperBroker {
  constructor() {
    this.mode = 'paper';
    this.orders = [];
    this.positions = {};  // symbol → { qty, avgCost }
    this.cash = 1_000_000_000; // 1 tỷ VND starting capital
    this.log = [];
  }

  async placeOrder(input, ctx = {}) {
    try {
      const order = createOrder(input);
      order.status = 'open';
      // Fill ngay (paper = không có latency)
      const fillPrice = order.price || ctx.currentPrice || 0;
      if (fillPrice <= 0) {
        order.status = 'rejected';
        this._log('REJECT', order, 'no price');
        return order;
      }
      order.status = 'filled';
      order.filledQty = order.qty;
      order.fillPrice = fillPrice;
      order.filledAt = new Date().toISOString();
      this._applyFill(order);
      this.orders.push(order);
      this._log('FILL', order);
      return order;
    } catch (e) {
      return { status: 'rejected', error: e.message };
    }
  }

  _applyFill(order) {
    const value = order.qty * order.fillPrice;
    if (order.side === 'BUY') {
      this.cash -= value;
      const pos = this.positions[order.symbol] || { qty: 0, avgCost: 0 };
      const newQty = pos.qty + order.qty;
      pos.avgCost = (pos.qty * pos.avgCost + value) / newQty;
      pos.qty = newQty;
      this.positions[order.symbol] = pos;
    } else { // SELL
      this.cash += value;
      const pos = this.positions[order.symbol];
      if (pos) pos.qty -= order.qty;
    }
  }

  async cancelOrder(orderId) {
    const o = this.orders.find(x => x.id === orderId);
    if (o && o.status === 'open') {
      o.status = 'cancelled';
      this._log('CANCEL', o);
      return { success: true, status: 'cancelled' };
    }
    return { success: false, status: o ? o.status : 'not_found' };
  }

  async amendOrder(orderId, changes) {
    const o = this.orders.find(x => x.id === orderId);
    if (!o || o.status !== 'open') return { success: false, error: 'cannot amend' };
    Object.assign(o, changes);
    return { success: true, order: o };
  }

  async getOrders() { return this.orders; }

  async getPortfolio(ctx = {}) {
    const positions = Object.entries(this.positions)
      .filter(([_, p]) => p.qty !== 0)
      .map(([symbol, p]) => {
        const px = (ctx.prices && ctx.prices[symbol]) || p.avgCost;
        const value = p.qty * px;
        const pnl = p.qty > 0 ? (px - p.avgCost) * p.qty : 0;
        return { symbol, qty: p.qty, avgCost: p.avgCost, currentPrice: px, value, pnl };
      });
    const positionsValue = positions.reduce((s, p) => s + p.value, 0);
    return {
      cash: this.cash,
      positionsValue,
      totalValue: this.cash + positionsValue,
      positions,
      mode: this.mode
    };
  }

  async getBalance() { return { cash: this.cash, buyingPower: this.cash, mode: this.mode }; }

  _log(action, order, note) {
    this.log.push({ ts: new Date().toISOString(), action, orderId: order.id,
                    symbol: order.symbol, side: order.side, qty: order.qty,
                    price: order.fillPrice || order.price, note });
    if (this.log.length > 1000) this.log.shift();
  }
}

module.exports = { PaperBroker };
