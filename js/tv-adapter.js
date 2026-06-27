/**
 * tv-adapter.js — Pure data adapters for TradingView Lightweight Charts.
 *
 * Converts raw FireAnt historical records into the shapes Lightweight Charts
 * requires for candlestick and volume series.
 *
 * These functions are PURE and DETERMINISTIC so they can be exercised by
 * property-based tests (vitest + fast-check). The module is dual-mode:
 *   (a) ESM `export` for the test runner.
 *   (b) attached to `window.TVAdapter` for the browser scripts (tv-chart.js
 *       consumes these at runtime). The window attachment is guarded so the
 *       module is safe to import in a non-browser (Node/vitest) environment.
 *
 * Lightweight Charts hard constraints honoured here:
 *   - series data MUST be sorted strictly ascending by time
 *   - timestamps MUST be unique (no duplicate `time`)
 *   - candle high must be >= open/close/low and low must be <= open/close/high
 *   - volume bars must align 1-1 (by time) with candles
 *
 * Time representation: UNIX seconds (UTC), normalised to UTC midnight so that
 * daily bars on the same calendar day collapse to a single timestamp. This is
 * one of the two representations permitted by Lightweight Charts (the other
 * being a 'yyyy-mm-dd' string); we use it consistently across both adapters.
 */

// Volume colour tokens mirroring the Design System CSS variables
// (--tv-volume-up / --tv-volume-down in css/style.css). Provided as defaults
// so the adapter stays pure (no DOM reads); callers may override.
export const VOLUME_UP_COLOR = 'rgba(46, 230, 138, 0.5)';
export const VOLUME_DOWN_COLOR = 'rgba(255, 92, 120, 0.5)';

const MS_PER_DAY = 86400000;

/**
 * Parse a raw Date-like value into UNIX seconds at UTC midnight.
 * Accepts Date instances, ISO/date strings, or numeric (ms) timestamps.
 * Returns null when the value is missing or unparseable.
 */
function parseTime(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    const ms = d.getTime();
    if (Number.isNaN(ms)) return null;
    // Normalise to UTC midnight so same-day records share one timestamp.
    return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY / 1000;
}

/**
 * Coerce a raw numeric field to a finite number, or null when missing/invalid.
 * Explicitly rejects null/undefined/'' (which Number() would coerce to 0).
 */
function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

// Field-name fallbacks: FireAnt payloads vary (Open vs PriceOpen, etc.).
function pickOpen(r) { return r.Open ?? r.PriceOpen ?? r.open; }
function pickHigh(r) { return r.High ?? r.PriceHigh ?? r.high; }
function pickLow(r) { return r.Low ?? r.PriceLow ?? r.low; }
function pickClose(r) { return r.Close ?? r.PriceClose ?? r.close; }
function pickVolume(r) { return r.Volume ?? r.TotalVolume ?? r.volume; }
function pickDate(r) { return r.Date ?? r.date ?? r.time; }

/**
 * Shared normalisation pipeline used by both adapters so their outputs always
 * align 1-1 by timestamp.
 *
 * Steps: parse time -> drop records missing any OHLC -> dedupe timestamps
 * (keeping the LAST record seen for a duplicate time) -> sort ascending.
 * High/low are recomputed as max/min of OHLC to guarantee the candle
 * invariant regardless of dirty input.
 *
 * @param {Array<object>} raw
 * @returns {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>}
 */
function normalize(raw) {
    if (!Array.isArray(raw)) return [];

    // Map keyed by time => later entries overwrite earlier ones, so the last
    // record for a duplicate timestamp wins.
    const byTime = new Map();

    for (const rec of raw) {
        if (rec === null || typeof rec !== 'object') continue;

        const time = parseTime(pickDate(rec));
        if (time === null) continue;

        const open = num(pickOpen(rec));
        const high = num(pickHigh(rec));
        const low = num(pickLow(rec));
        const close = num(pickClose(rec));

        // Drop records missing any OHLC component.
        if (open === null || high === null || low === null || close === null) continue;

        const volRaw = num(pickVolume(rec));
        const volume = volRaw === null ? 0 : volRaw;

        // Enforce candle invariant: high is the max, low is the min of OHLC.
        const normHigh = Math.max(open, high, low, close);
        const normLow = Math.min(open, high, low, close);

        byTime.set(time, { time, open, high: normHigh, low: normLow, close, volume });
    }

    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/**
 * Convert raw historical records into Lightweight Charts candlestick data.
 * Empty / non-array input yields an empty array (so callers can show an
 * Empty_State).
 *
 * @param {Array<object>} raw
 * @returns {Array<{time:number, open:number, high:number, low:number, close:number}>}
 */
export function toCandles(raw) {
    return normalize(raw).map(({ time, open, high, low, close }) => ({
        time, open, high, low, close
    }));
}

/**
 * Convert raw historical records into Lightweight Charts volume-histogram data,
 * aligned 1-1 (by time, same order, same length) with `toCandles(raw)`.
 * Colour reflects candle direction: up token when close >= open, down token
 * when close < open.
 *
 * @param {Array<object>} raw
 * @param {string} [upColor]   colour for up bars (defaults to volume-up token)
 * @param {string} [downColor] colour for down bars (defaults to volume-down token)
 * @returns {Array<{time:number, value:number, color:string}>}
 */
export function toVolume(raw, upColor = VOLUME_UP_COLOR, downColor = VOLUME_DOWN_COLOR) {
    return normalize(raw).map(({ time, open, close, volume }) => ({
        time,
        value: volume,
        color: close >= open ? upColor : downColor
    }));
}

// Browser attachment (guarded so importing under Node/vitest is safe).
if (typeof window !== 'undefined') {
    window.TVAdapter = { toCandles, toVolume, VOLUME_UP_COLOR, VOLUME_DOWN_COLOR };
}
