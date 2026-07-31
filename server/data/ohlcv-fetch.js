/**
 * OHLCV Fetcher — lấy dữ liệu OHLCV thật từ FireAnt HistoricalQuotes.
 *
 * Endpoint CÔNG KHAI (không cần cookie — đã verify breadth-history.js:422).
 * Trả về OHLCV đầy đủ cho computeTA (ADX/ATR cần high/low, VCP/pocketPivot
 * cần volumes). Chỉ fetch cho ứng viên top picks (vài chục mã), KHÔNG scan
 * toàn bộ 1576 mã → nhanh + chính xác.
 *
 * Cache in-memory (session) + file để tránh re-fetch.
 *
 * @module data/ohlcv-fetch
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'ohlcv-cache.json');
const FA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json'
};
const DEFAULT_DAYS = 250; // ~1 năm giao dịch (đủ MA200, VCP, trend template)

let _memCache = {}; // symbol → {dates, ohlc, volumes, fetchedAt}

/**
 * Parse 1 HistoricalQuotes item → {date, o, h, l, c, v}.
 * FireAnt field names: Date/Open/High/Low/Close/Volume hoặc camelCase.
 */
function parseQuote(it) {
  if (!it) return null;
  const date = (it.Date || it.date || '').toString().split('T')[0];
  const c = num(it.Close ?? it.PriceClose ?? it.close);
  const o = num(it.Open ?? it.PriceOpen ?? it.open) || c;
  const h = num(it.High ?? it.PriceHigh ?? it.high) || c;
  const l = num(it.Low ?? it.PriceLow ?? it.low) || c;
  const v = num(it.Volume ?? it.TradingVolume ?? it.volume) || 0;
  if (!date || !c || c <= 0) return null;
  return { date, o, h, l, c, v };
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return (typeof n === 'number' && !isNaN(n)) ? n : 0;
}

/**
 * Fetch OHLCV 1 symbol từ FireAnt HistoricalQuotes (công khai).
 * @param {string} symbol
 * @param {number} [days=250]
 * @returns {Promise<{dates, ohlc, volumes}|null>}
 */
async function fetchOHLCV(symbol, days = DEFAULT_DAYS) {
  if (!symbol) return null;
  // Memory cache (session)
  const cached = _memCache[symbol];
  if (cached && (Date.now() - cached.fetchedAt < 6 * 3600 * 1000)) {
    return stripCacheMeta(cached);
  }

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${encodeURIComponent(symbol)}`
    + `&startDate=${fmt(start)}&endDate=${fmt(end)}`;
  try {
    const res = await axios.get(url, { headers: FA_HEADERS, timeout: 10000 });
    const raw = Array.isArray(res.data) ? res.data : [];
    if (!raw.length) return null;
    const points = raw.map(parseQuote).filter(Boolean);
    if (points.length < 60) return null; // quá ít data cho TA
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const result = {
      dates: points.map(p => p.date),
      ohlc: points.map(p => ({ o: p.o, h: p.h, l: p.l, c: p.c })),
      volumes: points.map(p => p.v)
    };
    _memCache[symbol] = { ...result, fetchedAt: Date.now() };
    return result;
  } catch (e) {
    return null;
  }
}

/**
 * Fetch OHLCV batch (song song, có concurrency limit để tránh rate-limit).
 * @param {string[]} symbols
 * @returns {Promise<object>} map symbol → {dates, ohlc, volumes}
 */
async function fetchOHLCVBatch(symbols, concurrency = 5) {
  const result = {};
  const queue = [...symbols];
  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) continue;
      const h = await fetchOHLCV(sym);
      if (h) result[sym] = h;
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker());
  await Promise.all(workers);
  return result;
}

function stripCacheMeta(entry) {
  const { dates, ohlc, volumes } = entry;
  return { dates, ohlc, volumes };
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Clear memory cache (cho test / force-refresh).
 */
function clearCache() { _memCache = {}; }

module.exports = {
  fetchOHLCV,
  fetchOHLCVBatch,
  parseQuote,
  clearCache,
  DEFAULT_DAYS
};
