/**
 * tv-indicators.js — Pure technical-analysis indicator math for the chart modal.
 *
 * All functions are PURE: they take an array of numbers (typically candle close
 * prices) and return an array of the SAME length, where the warm-up positions
 * (before enough data exists) are `null`. Keeping the output index-aligned with
 * the input lets the caller map each value straight onto the candle at the same
 * index (and therefore the same timestamp) for Lightweight Charts.
 *
 * Mirrors the algorithms used by the project's TA library (calcSMA / calcEMA /
 * calcRSI / calcMACDHistogram / calcBollingerBands) but rewritten as dependency
 * free browser JS. Attached to window.TVIndicators and also exported as ESM so
 * it can be unit-tested under vitest.
 *
 * Indicators provided:
 *   - sma(values, period)
 *   - ema(values, period)
 *   - rsi(values, period = 14)          (Wilder smoothing)
 *   - macd(values, fast=12, slow=26, signal=9) -> { macd, signal, histogram }
 *   - bollinger(values, period=20, mult=2)     -> { upper, middle, lower }
 *   - toLineData(times, valueArray)     map index-aligned values to LWC points
 */
(function () {
    'use strict';

    /** Coerce to a finite number or null. */
    function n(v) {
        if (v === null || v === undefined || v === '') return null;
        var x = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(x) ? x : null;
    }

    /**
     * Simple Moving Average. Returns an array aligned with `values`; positions
     * before `period` samples are available are null.
     * @param {number[]} values
     * @param {number} period
     * @returns {(number|null)[]}
     */
    function sma(values, period) {
        var out = new Array(values.length).fill(null);
        if (!(period > 0)) return out;
        var sum = 0;
        var count = 0;
        var window = [];
        for (var i = 0; i < values.length; i++) {
            var v = n(values[i]);
            window.push(v);
            if (v !== null) { sum += v; count++; }
            if (window.length > period) {
                var removed = window.shift();
                if (removed !== null) { sum -= removed; count--; }
            }
            if (window.length === period && count === period) {
                out[i] = sum / period;
            }
        }
        return out;
    }

    /**
     * Exponential Moving Average. Seeded with the SMA of the first `period`
     * values; positions before that are null.
     * @param {number[]} values
     * @param {number} period
     * @returns {(number|null)[]}
     */
    function ema(values, period) {
        var out = new Array(values.length).fill(null);
        if (!(period > 0)) return out;
        var k = 2 / (period + 1);
        var prev = null;
        var seedSum = 0;
        var seedCount = 0;
        for (var i = 0; i < values.length; i++) {
            var v = n(values[i]);
            if (v === null) { out[i] = prev; continue; }
            if (prev === null) {
                // Build the SMA seed over the first `period` valid samples.
                seedSum += v;
                seedCount++;
                if (seedCount === period) {
                    prev = seedSum / period;
                    out[i] = prev;
                }
            } else {
                prev = v * k + prev * (1 - k);
                out[i] = prev;
            }
        }
        return out;
    }

    /**
     * Relative Strength Index using Wilder's smoothing.
     * @param {number[]} values
     * @param {number} [period=14]
     * @returns {(number|null)[]}
     */
    function rsi(values, period) {
        period = period || 14;
        var out = new Array(values.length).fill(null);
        if (values.length <= period) return out;

        var gainSum = 0;
        var lossSum = 0;
        // First averages over the initial `period` changes.
        for (var i = 1; i <= period; i++) {
            var change = n(values[i]) - n(values[i - 1]);
            if (change >= 0) gainSum += change; else lossSum -= change;
        }
        var avgGain = gainSum / period;
        var avgLoss = lossSum / period;
        out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

        for (var j = period + 1; j < values.length; j++) {
            var ch = n(values[j]) - n(values[j - 1]);
            var gain = ch > 0 ? ch : 0;
            var loss = ch < 0 ? -ch : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            out[j] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
        return out;
    }

    /**
     * MACD(fast, slow, signal). Returns three index-aligned arrays.
     * @returns {{ macd:(number|null)[], signal:(number|null)[], histogram:(number|null)[] }}
     */
    function macd(values, fast, slow, signal) {
        fast = fast || 12;
        slow = slow || 26;
        signal = signal || 9;

        var emaFast = ema(values, fast);
        var emaSlow = ema(values, slow);

        var macdLine = values.map(function (_, i) {
            return (emaFast[i] === null || emaSlow[i] === null) ? null : emaFast[i] - emaSlow[i];
        });

        // Signal = EMA of the macd line over its non-null span.
        var firstIdx = macdLine.findIndex(function (v) { return v !== null; });
        var signalLine = new Array(values.length).fill(null);
        if (firstIdx !== -1) {
            var slice = macdLine.slice(firstIdx).map(function (v) { return v === null ? 0 : v; });
            var sig = ema(slice, signal);
            for (var i = 0; i < sig.length; i++) {
                signalLine[firstIdx + i] = sig[i];
            }
        }

        var histogram = values.map(function (_, i) {
            return (macdLine[i] === null || signalLine[i] === null) ? null : macdLine[i] - signalLine[i];
        });

        return { macd: macdLine, signal: signalLine, histogram: histogram };
    }

    /**
     * Bollinger Bands. Returns three index-aligned arrays (upper/middle/lower).
     * @returns {{ upper:(number|null)[], middle:(number|null)[], lower:(number|null)[] }}
     */
    function bollinger(values, period, mult) {
        period = period || 20;
        mult = mult || 2;
        var middle = sma(values, period);
        var upper = new Array(values.length).fill(null);
        var lower = new Array(values.length).fill(null);

        for (var i = period - 1; i < values.length; i++) {
            if (middle[i] === null) continue;
            var sumSq = 0;
            var ok = true;
            for (var j = i - period + 1; j <= i; j++) {
                var v = n(values[j]);
                if (v === null) { ok = false; break; }
                var diff = v - middle[i];
                sumSq += diff * diff;
            }
            if (!ok) continue;
            var sd = Math.sqrt(sumSq / period);
            upper[i] = middle[i] + mult * sd;
            lower[i] = middle[i] - mult * sd;
        }
        return { upper: upper, middle: middle, lower: lower };
    }

    /**
     * Map an index-aligned value array onto Lightweight Charts line points using
     * the matching candle times. Null values are skipped (LWC requires gaps be
     * omitted, and the time axis stays ascending because candles are sorted).
     * @param {number[]} times  candle times (UNIX seconds), ascending & unique
     * @param {(number|null)[]} valueArray
     * @returns {{time:number, value:number}[]}
     */
    function toLineData(times, valueArray) {
        var out = [];
        for (var i = 0; i < times.length; i++) {
            var v = valueArray[i];
            if (v === null || v === undefined || !Number.isFinite(v)) continue;
            out.push({ time: times[i], value: v });
        }
        return out;
    }

    /**
     * Map an index-aligned value array onto histogram points with per-bar color.
     * @param {number[]} times
     * @param {(number|null)[]} valueArray
     * @param {string} upColor   color when value >= 0
     * @param {string} downColor color when value < 0
     */
    function toHistogramData(times, valueArray, upColor, downColor) {
        var out = [];
        for (var i = 0; i < times.length; i++) {
            var v = valueArray[i];
            if (v === null || v === undefined || !Number.isFinite(v)) continue;
            out.push({ time: times[i], value: v, color: v >= 0 ? upColor : downColor });
        }
        return out;
    }

    var api = {
        sma: sma,
        ema: ema,
        rsi: rsi,
        macd: macd,
        bollinger: bollinger,
        toLineData: toLineData,
        toHistogramData: toHistogramData
    };

    if (typeof window !== 'undefined') {
        window.TVIndicators = api;
    }
    // ESM export for unit tests (ignored by the browser <script> include).
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
