/**
 * Broker interface contract (JSDoc).
 * Mọi adapter (paper/ssi/dnse) implement các method này.
 *
 * @interface Broker
 */
class BrokerInterface {
  /** @returns {Promise<object>} {id, status, ...} */
  async placeOrder(input, ctx) { throw new Error('not implemented'); }
  /** @returns {Promise<{success, status}>} */
  async cancelOrder(orderId) { throw new Error('not implemented'); }
  /** @returns {Promise<{success, order}>} */
  async amendOrder(orderId, changes) { throw new Error('not implemented'); }
  /** @returns {Promise<object[]>} */
  async getOrders() { throw new Error('not implemented'); }
  /** @returns {Promise<{cash, positions, totalValue}>} */
  async getPortfolio(ctx) { throw new Error('not implemented'); }
  /** @returns {Promise<{cash, buyingPower}>} */
  async getBalance() { throw new Error('not implemented'); }
}

module.exports = { BrokerInterface };
