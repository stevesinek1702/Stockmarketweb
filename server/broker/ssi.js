/**
 * SSI FastConnect adapter — LIVE.
 * Gọi SSI FastConnect Python SDK qua subprocess.
 *
 * Auth (env): SSI_CONSUMER_ID, SSI_CONSUMER_SECRET, SSI_ACCOUNT.
 * Chỉ active khi BROKER_MODE=ssi (factory).
 *
 * NOTE: Live test cần account SSI FastConnect thật. Stub scaffold —
 * implement đầy đủ khi bạn có account + Python SDK cài.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class SSIBroker {
  constructor() {
    this.mode = 'live';
    this.consumerId = process.env.SSI_CONSUMER_ID;
    this.consumerSecret = process.env.SSI_CONSUMER_SECRET;
    this.account = process.env.SSI_ACCOUNT;
    if (!this.consumerId || !this.consumerSecret || !this.account) {
      throw new Error('SSI broker cần env: SSI_CONSUMER_ID, SSI_CONSUMER_SECRET, SSI_ACCOUNT');
    }
  }

  async _callPython(method, payload) {
    // Gọi Python SDK: python -m fctrading_cli <method> <json>
    // CLI wrapper cần viết riêng (scripts/fctrading_cli.py) — TODO khi live.
    const { stdout } = await execFileAsync('python', ['-m', 'fctrading_cli', method, JSON.stringify(payload)], {
      timeout: 30000,
      env: { ...process.env, SSI_CONSUMER_ID: this.consumerId, SSI_CONSUMER_SECRET: this.consumerSecret, SSI_ACCOUNT: this.account }
    });
    return JSON.parse(stdout);
  }

  async placeOrder(input, ctx) {
    return this._callPython('place_order', { ...input, account: this.account });
  }
  async cancelOrder(orderId) {
    return this._callPython('cancel_order', { orderId, account: this.account });
  }
  async amendOrder(orderId, changes) {
    return this._callPython('amend_order', { orderId, ...changes, account: this.account });
  }
  async getOrders() { return this._callPython('get_orders', { account: this.account }); }
  async getPortfolio() { return this._callPython('get_portfolio', { account: this.account }); }
  async getBalance() { return this._callPython('get_balance', { account: this.account }); }
}

module.exports = { SSIBroker };
