import { describe, it, expect, beforeEach } from 'vitest';
import { PaperBroker } from '../../broker/paper.js';

describe('PaperBroker', () => {
  let b;
  beforeEach(() => { b = new PaperBroker(); });

  it('placeOrder BUY → filled, portfolio update', async () => {
    const o = await b.placeOrder({ symbol: 'HPG', side: 'BUY', type: 'LO', qty: 1000, price: 25000 }, {});
    expect(o.status).toBe('filled');
    expect(o.fillPrice).toBe(25000);
    const pf = await b.getPortfolio({});
    const hpg = pf.positions.find(p => p.symbol === 'HPG');
    expect(hpg.qty).toBe(1000);
    expect(hpg.avgCost).toBe(25000);
  });

  it('BUY giảm cash, SELL tăng cash', async () => {
    const cash0 = (await b.getBalance()).cash;
    await b.placeOrder({ symbol: 'FPT', side: 'BUY', type: 'LO', qty: 500, price: 100000 }, {});
    const cash1 = (await b.getBalance()).cash;
    expect(cash1).toBeLessThan(cash0);
    await b.placeOrder({ symbol: 'FPT', side: 'SELL', type: 'LO', qty: 500, price: 102000 }, {});
    const cash2 = (await b.getBalance()).cash;
    expect(cash2).toBeGreaterThan(cash1);
  });

  it('reject qty không lô 100', async () => {
    const o = await b.placeOrder({ symbol: 'HPG', side: 'BUY', type: 'LO', qty: 150, price: 25000 }, {});
    expect(o.status).toBe('rejected');
  });

  it('reject LO thiếu price', async () => {
    const o = await b.placeOrder({ symbol: 'HPG', side: 'BUY', type: 'LO', qty: 1000 }, {});
    expect(o.status).toBe('rejected');
  });

  it('getPortfolio totalValue = cash + positions', async () => {
    await b.placeOrder({ symbol: 'HPG', side: 'BUY', type: 'LO', qty: 1000, price: 25000 }, {});
    const pf = await b.getPortfolio({});
    expect(pf.totalValue).toBe(pf.cash + pf.positionsValue);
  });

  it('ATO fill ở currentPrice (ctx)', async () => {
    const o = await b.placeOrder({ symbol: 'MSN', side: 'BUY', type: 'ATO', qty: 200 }, { currentPrice: 80000 });
    expect(o.status).toBe('filled');
    expect(o.fillPrice).toBe(80000);
  });

  it('mode = paper', () => {
    expect(b.mode).toBe('paper');
  });
});
