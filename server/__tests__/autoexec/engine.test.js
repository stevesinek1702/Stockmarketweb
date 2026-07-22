import { describe, it, expect, beforeEach } from 'vitest';
import { enable, disable, isEnabled, checkSafety, runOnce } from '../../autoexec/engine.js';

// Fake broker for testing
function fakeBroker(overrides = {}) {
  return {
    mode: 'paper',
    async getPortfolio() { return { totalValue: 1_000_000_000, positions: [], cash: 1e9, ...overrides }; },
    async placeOrder(input) { return { ...input, status: 'filled', id: 'test_' + input.symbol }; },
    ...overrides
  };
}

describe('autoexec kill-switch', () => {
  beforeEach(async () => { await disable(); });
  it('enable/disable toggle', async () => {
    expect(await isEnabled()).toBe(false);
    await enable();
    expect(await isEnabled()).toBe(true);
    await disable();
    expect(await isEnabled()).toBe(false);
  });
});

describe('checkSafety', () => {
  beforeEach(async () => { await enable(); });
  it('disabled -> not ok', async () => {
    await disable();
    const r = await checkSafety(fakeBroker());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('disabled');
  });
  it('enabled + portfolio OK -> ok', async () => {
    await enable();
    const r = await checkSafety(fakeBroker());
    expect(r.ok).toBe(true);
  });
});

describe('runOnce', () => {
  beforeEach(async () => { await enable(); });
  it('skip khi disabled', async () => {
    await disable();
    const r = await runOnce(async () => ({ results: [] }));
    expect(r.skipped).toBeTruthy();
  });
  it('place orders tu buy signals', async () => {
    await enable();
    const fetcher = async () => ({
      results: [
        { symbol: 'HPG', price: 25000, action: 'BUY', signal: { entry: 25000, stop: 24000 } },
        { symbol: 'FPT', price: 100000, action: 'WATCH', signal: { entry: 100000, stop: null } }
      ]
    });
    const r = await runOnce(fetcher);
    expect(r.placed).toBe(1);
    expect(r.orders[0].symbol).toBe('HPG');
  });
  it('0 buy signals -> placed 0', async () => {
    await enable();
    const r = await runOnce(async () => ({ results: [] }));
    expect(r.placed).toBe(0);
  });
});
