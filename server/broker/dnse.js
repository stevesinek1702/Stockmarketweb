/**
 * DNSE Lightspeed adapter — LIVE.
 * Gọi DNSE Lightspeed HTTP API.
 *
 * Auth (env): DNSE_TOKEN, DNSE_ACCOUNT.
 * Chỉ active khi BROKER_MODE=dnse (factory).
 *
 * NOTE: Live test cần account DNSE + token. Endpoint URLs cần confirm từ
 * docs DNSE Lightspeed khi implement live. Stub scaffold.
 */
const axios = require('axios');

class DNSEBroker {
  constructor() {
    this.mode = 'live';
    this.token = process.env.DNSE_TOKEN;
    this.account = process.env.DNSE_ACCOUNT;
    this.baseUrl = process.env.DNSE_API_URL || 'https://api.dnse.com.vn';
    if (!this.token || !this.account) {
      throw new Error('DNSE broker cần env: DNSE_TOKEN, DNSE_ACCOUNT');
    }
  }

  _headers() { return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }; }

  async placeOrder(input, ctx) {
    const { data } = await axios.post(`${this.baseUrl}/orders`, {
      symbol: input.symbol, side: input.side, orderType: input.type,
      quantity: input.qty, price: input.price, account: this.account
    }, { headers: this._headers(), timeout: 15000 });
    return data;
  }
  async cancelOrder(orderId) {
    const { data } = await axios.delete(`${this.baseUrl}/orders/${orderId}`,
      { headers: this._headers(), params: { account: this.account }, timeout: 15000 });
    return data;
  }
  async amendOrder(orderId, changes) {
    const { data } = await axios.put(`${this.baseUrl}/orders/${orderId}`, { ...changes, account: this.account },
      { headers: this._headers(), timeout: 15000 });
    return data;
  }
  async getOrders() {
    const { data } = await axios.get(`${this.baseUrl}/orders`, { headers: this._headers(), params: { account: this.account }, timeout: 15000 });
    return data;
  }
  async getPortfolio() {
    const { data } = await axios.get(`${this.baseUrl}/portfolio`, { headers: this._headers(), params: { account: this.account }, timeout: 15000 });
    return data;
  }
  async getBalance() {
    const { data } = await axios.get(`${this.baseUrl}/balance`, { headers: this._headers(), params: { account: this.account }, timeout: 15000 });
    return data;
  }
}

module.exports = { DNSEBroker };
