/**
 * Property test — TV adapter volume colour consistency with candle direction.
 *
 * Feature: ui-ux-overhaul, Property 2: Màu volume nhất quán với chiều nến.
 *
 * Validates: Requirements 1.2, 1.7
 *
 * The volume histogram must colour each bar to match the direction of the
 * candle at the SAME timestamp: the up token when close >= open, the down
 * token when close < open. Because the adapter recomputes high/low as
 * max/min of OHLC but keeps open/close exactly as supplied, the close-vs-open
 * direction is preserved through normalisation. We align each volume entry to
 * its candle by timestamp (via toCandles) and assert the colour rule holds.
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  toCandles,
  toVolume,
  VOLUME_UP_COLOR,
  VOLUME_DOWN_COLOR,
} from '../tv-adapter.js';

// A pool of fixed calendar days so the generator naturally produces duplicate
// and out-of-order dates across records (same day collapses to one timestamp,
// last record wins — matching toCandles' dedupe rule).
const DAY_POOL = [
  '2024-01-01', '2024-01-02', '2024-01-03',
  '2024-02-15', '2024-02-15', // intentional duplicate day
  '2023-12-31', '2024-03-10', '2024-01-02', // more duplicates / disorder
];

// Well-formed numeric OHLC fields. We include edge cases (zero, negatives,
// equal open/close to exercise the >= boundary) so the colour rule is tested
// right at the up/down threshold.
const priceArb = fc.oneof(
  fc.double({ min: -1000, max: 1000, noNaN: true }),
  fc.constantFrom(0, -0, 100, -100)
);

const recordArb = fc.record({
  date: fc.constantFrom(...DAY_POOL),
  useAltOpen: fc.boolean(),
  open: priceArb,
  high: priceArb,
  low: priceArb,
  close: priceArb,
  volume: fc.double({ min: 0, max: 5000, noNaN: true }),
}).map(({ date, useAltOpen, open, high, low, close, volume }) => {
  const rec = { Date: date };
  if (useAltOpen) rec.PriceOpen = open; else rec.Open = open;
  rec.High = high;
  rec.Low = low;
  rec.Close = close;
  rec.Volume = volume;
  return rec;
});

const rawArb = fc.array(recordArb, { maxLength: 30 });

describe('Feature: ui-ux-overhaul, Property 2: Màu volume nhất quán với chiều nến', () => {
  it('colours each volume bar by candle direction (up when close >= open, down otherwise)', () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const candles = toCandles(raw);
        const volume = toVolume(raw, VOLUME_UP_COLOR, VOLUME_DOWN_COLOR);

        // Index candles by timestamp so we can align each volume entry.
        const candleByTime = new Map(candles.map((c) => [c.time, c]));

        // Volume and candles align 1-1; verify each colour against its candle.
        if (volume.length !== candles.length) return false;

        for (const v of volume) {
          const candle = candleByTime.get(v.time);
          if (!candle) return false; // every volume bar must map to a candle

          const expected =
            candle.close >= candle.open ? VOLUME_UP_COLOR : VOLUME_DOWN_COLOR;
          if (v.color !== expected) return false;
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });
});
