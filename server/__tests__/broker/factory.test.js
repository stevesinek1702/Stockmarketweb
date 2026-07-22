import { describe, it, expect, afterEach } from 'vitest';
import { _reset, getBroker, currentMode } from '../../broker/factory.js';

afterEach(() => {
  delete process.env.BROKER_MODE;
  _reset();
});

describe('broker factory', () => {
  it('mặc định paper', () => {
    _reset();
    const b = getBroker();
    expect(b.mode).toBe('paper');
    expect(currentMode()).toBe('paper');
  });

  it('BROKER_MODE=paper → PaperBroker', () => {
    process.env.BROKER_MODE = 'paper';
    _reset();
    expect(getBroker().mode).toBe('paper');
  });

  it('singleton (getBroker 2 lần = cùng instance)', () => {
    _reset();
    const b1 = getBroker();
    const b2 = getBroker();
    expect(b1).toBe(b2);
  });
});
