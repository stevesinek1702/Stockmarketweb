const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'price-history.json');

let _cache = null;   // in-process cache (load 1 lần)

function _load() {
  if (_cache) return _cache;
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      _cache = { meta: { version: 2, lastUpdated: null, symbols: 0 }, symbols: {} };
      return _cache;
    }
    _cache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    console.error('[price-history] load fail:', e.message);
    _cache = { meta: { version: 2, lastUpdated: null, symbols: 0 }, symbols: {} };
  }
  return _cache;
}

/**
 * Lấy history 1 symbol. Trả { dates, ohlc, volumes } hoặc null.
 */
function getHistory(symbol) {
  const data = _load();
  return data.symbols[symbol] || null;
}

/**
 * Lưu/upsert history 1 symbol. Ghi ngay ra file.
 */
function setHistory(symbol, history) {
  const data = _load();
  data.symbols[symbol] = history;
  data.meta.symbols = Object.keys(data.symbols).length;
  data.meta.lastUpdated = new Date().toISOString().slice(0, 10);
  _save(data);
}

function _save(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data), 'utf8');
    _cache = data;
  } catch (e) {
    console.error('[price-history] save fail:', e.message);
  }
}

function getMeta() {
  const data = _load();
  const symbols = Object.keys(data.symbols);
  const depths = symbols.map(s => {
    const h = data.symbols[s];
    return (h && (h.ohlc || h.closes || [])) ? (h.ohlc || h.closes).length : 0;
  });
  return {
    version: data.meta.version,
    lastUpdated: data.meta.lastUpdated,
    symbolCount: symbols.length,
    minDepth: depths.length ? Math.min(...depths) : 0,
    maxDepth: depths.length ? Math.max(...depths) : 0
  };
}

/** Liệt kê tất cả symbol có trong price-history. */
function listSymbols() {
  return Object.keys(_load().symbols);
}

module.exports = { getHistory, setHistory, getMeta, listSymbols, HISTORY_FILE };
