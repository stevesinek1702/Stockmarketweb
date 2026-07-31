/**
 * Fundamentals cache — P/E, P/B, ROE, EPS từ FireAnt, cache 1 ngày.
 *
 * VERIFICATION-FIRST: FireAnt Quotes / TradingStatistic thường đã trả về các
 * field định giá (PriceToEarning, PriceToBook, RoE, Eps) mà codebase chưa
 * extract. extractFundamentals thử nhiều field name có thể → không phụ thuộc
 * endpoint mới. Nếu nguồn thiếu → trả null (score factors fallback neutral).
 *
 * Fundamentals đổi chậm → cache 1 ngày (đỡ rate-limit/cookie). Refresh bởi
 * scheduler EOD. Spec §9.1.
 *
 * @module data/fundamentals
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname);
const CACHE_FILE = path.join(DATA_DIR, 'fundamentals.json');
const TTL_MS = 24 * 3600 * 1000; // 1 ngày

// Các field name FireAnt có thể dùng (defensive — thử từng).
const PE_FIELDS = ['PriceToEarning', 'PriceToEarnings', 'PE', 'pe', 'priceToEarning'];
const PB_FIELDS = ['PriceToBook', 'PB', 'pb', 'priceToBook'];
const ROE_FIELDS = ['RoE', 'ROE', 'roe', 'ReturnOnEquity'];
const EPS_FIELDS = ['Eps', 'EPS', 'eps', 'EarningsPerShare'];

/**
 * Extract 1 metric từ object với list field name có thể.
 * @param {object} obj
 * @param {string[]} fields  candidate field names (thử theo thứ tự)
 * @returns {number|null}  null nếu không có / âm / NaN (P/E âm vô nghĩa)
 */
function pickField(obj, fields) {
  if (!obj) return null;
  for (const k of fields) {
    const v = obj[k];
    if (typeof v === 'number' && !isNaN(v)) {
      return v; // kể cả 0 vẫn trả (P/E=0 hiếm nhưng hợp lệ)
    }
    // string → parse
    if (typeof v === 'string' && v.trim() !== '') {
      const n = parseFloat(v);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

/**
 * Sanitize: P/E âm (lỗ) vô nghĩa → null. Các metric khác giữ nguyên (ROE âm OK).
 */
function sanitizePe(pe) {
  return (typeof pe === 'number' && pe > 0 && !isNaN(pe)) ? pe : null;
}

/**
 * Từ 1 FireAnt quote → {pe, pb, roe, eps} (mỗi cái number|null).
 * @param {object} quote  FireAnt quote (Quotes hoặc TradingStatistic item)
 * @returns {{pe:number|null, pb:number|null, roe:number|null, eps:number|null}}
 */
function extractFundamentals(quote) {
  return {
    pe: sanitizePe(pickField(quote, PE_FIELDS)),
    pb: pickField(quote, PB_FIELDS),
    roe: pickField(quote, ROE_FIELDS),
    eps: pickField(quote, EPS_FIELDS)
  };
}

/**
 * Cache stale check (TTL 1 ngày).
 * @param {object} data  loaded cache {meta:{lastUpdated}, symbols:{...}}
 * @param {number} now   Date.now()
 */
function isStale(data, now) {
  if (!data || !data.symbols || Object.keys(data.symbols).length === 0) return true;
  const last = data.meta && data.meta.lastUpdated ? Date.parse(data.meta.lastUpdated) : NaN;
  if (isNaN(last)) return true;
  return (now - last) > TTL_MS;
}

/**
 * Median của 1 mảng số (loại null/NaN). Trả null nếu rỗng.
 */
function median(arr) {
  const nums = arr.filter(v => typeof v === 'number' && !isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Median P/E của list fundamentals (mỗi cái {pe}).
 * @param {Array<object>} funds
 * @returns {number|null}
 */
function medianPE(funds) {
  return median(funds.map(f => f.pe));
}

/**
 * Median P/B của list fundamentals.
 */
function medianPB(funds) {
  return median(funds.map(f => f.pb));
}

/**
 * Gộp valuation cho 1 ngành: {peAvg, pbAvg} = median P/E, P/B.
 * Yêu cầu ≥ 3 sample để có ý nghĩa thống kê, nếu không → null.
 * @param {Array<object>} funds  list fundamentals thuộc ngành
 * @returns {{peAvg:number|null, pbAvg:number|null, count:number}}
 */
function sectorValuation(funds) {
  funds = (funds || []).filter(f => f && f.pe != null || (f && f.pb != null));
  const count = funds.length;
  if (count < 3) {
    return { peAvg: null, pbAvg: null, count };
  }
  return {
    peAvg: medianPE(funds),
    pbAvg: medianPB(funds),
    count
  };
}

// ═══════════════════════════════════════════════════════════════════════
// FILE I/O
// ═══════════════════════════════════════════════════════════════════════

function load() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return { meta: { version: 1 }, symbols: {} };
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.error('[fundamentals] load error:', e.message);
    return { meta: { version: 1 }, symbols: {} };
  }
}

function save(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    data.meta = data.meta || {};
    data.meta.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
    return true;
  } catch (e) {
    console.error('[fundamentals] save error:', e.message);
    return false;
  }
}

/**
 * Lưu fundamentals cho nhiều symbol (từ batch quotes).
 * @param {Array<object>} quotes  FireAnt quotes (có Symbol + fields định giá)
 */
function storeFromQuotes(quotes) {
  const data = load();
  let added = 0;
  quotes.forEach(q => {
    if (!q || !q.Symbol) return;
    const f = extractFundamentals(q);
    data.symbols[q.Symbol] = { ...f, updatedAt: new Date().toISOString() };
    added++;
  });
  save(data);
  return added;
}

/**
 * Đọc fundamentals của 1 symbol (null nếu không có).
 */
function get(symbol) {
  const data = load();
  const s = data.symbols[symbol];
  if (!s) return null;
  return { pe: s.pe, pb: s.pb, roe: s.roe, eps: s.eps };
}

/**
 * Đọc fundamentals tất cả symbols.
 */
function getAll() {
  const data = load();
  const out = {};
  for (const [sym, s] of Object.entries(data.symbols)) {
    out[sym] = { pe: s.pe, pb: s.pb, roe: s.roe, eps: s.eps };
  }
  return out;
}

module.exports = {
  // pure (test)
  pickField,
  extractFundamentals,
  isStale,
  median,
  medianPE,
  medianPB,
  sectorValuation,
  // I/O
  load,
  save,
  storeFromQuotes,
  get,
  getAll,
  CACHE_FILE,
  TTL_MS,
  PE_FIELDS,
  PB_FIELDS,
  ROE_FIELDS,
  EPS_FIELDS
};
