/**
 * Property test — TV adapter validity & time-axis alignment.
 *
 * Feature: ui-ux-overhaul, Property 1: Adapter sinh dữ liệu hợp lệ và canh trục
 * thời gian cho Lightweight Charts.
 *
 * Validates: Requirements 1.1, 1.2
 *
 * The generator deliberately produces DIRTY input: duplicate dates, out-of-order
 * dates, missing/null OHLC fields, and negative values. Regardless of the mess,
 * the pure adapters must yield series that satisfy Lightweight Charts' hard
 * constraints:
 *   (a) time strictly ascending
 *   (b) no duplicate timestamps
 *   (c) candle invariant: low <= open,close,high and high >= open,close
 *   (d) volume aligns 1-1 (by time, same order, same length) with candles
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { toCandles, toVolume } from '../tv-adapter.js';

// A pool of fixed calendar days so the generator naturally produces duplicate
// and out-of-order dates across records (same day collapses to one timestamp).
const DAY_POOL = [
  '2024-01-01', '2024-01-02', '2024-01-03',
  '2024-02-15', '2024-02-15', // intentional duplicate day
  '2023-12-31', '2024-03-10', '2024-01-02', // more duplicates / disorder
];

// An OHLC field value: a finite number (incl. negatives), null, undefined, or
// missing-via-empty-string. Returned wrapped so we can also drop the key.
const fieldArb = fc.oneof(
  fc.double({ min: -1000, max: 1000, noNaN: true }),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant('')
);

// Builds a single raw record with randomly present/absent OHLCV fields and a
// date drawn from the pool (driving duplicates + disorder). Field-name variants
// (Open vs PriceOpen) are also exercised.
const recordArb = fc.record({
  date: fc.constantFrom(...DAY_POOL),
  useAltOpen: fc.boolean(),
  open: fieldArb,
  high: fieldArb,
  low: fieldArb,
  close: fieldArb,
  volume: fc.oneof(fc.double({ min: -500, max: 5000, noNaN: true }), fc.constant(null)),
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

describe('Feature: ui-ux-overhaul, Property 1: Adapter sinh dữ liệu hợp lệ và canh trục thời gian cho Lightweight Charts', () => {
  it('produces strictly-ascending, deduped, valid candles aligned 1-1 with volume', () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const candles = toCandles(raw);
        const volume = toVolume(raw);

        // (a) strictly ascending time + (b) no duplicate timestamps.
        for (let i = 1; i < candles.length; i++) {
          if (!(candles[i].time > candles[i - 1].time)) return false;
        }

        // (c) candle invariant for every candle.
        for (const c of candles) {
          const lowOk = c.low <= c.open && c.low <= c.close && c.low <= c.high;
          const highOk = c.high >= c.open && c.high >= c.close && c.high >= c.low;
          if (!lowOk || !highOk) return false;
        }

        // (d) volume aligns 1-1 by timestamp: same length, same order of times.
        if (volume.length !== candles.length) return false;
        for (let i = 0; i < candles.length; i++) {
          if (volume[i].time !== candles[i].time) return false;
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });
});
