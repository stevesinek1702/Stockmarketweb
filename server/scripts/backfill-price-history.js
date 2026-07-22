/**
 * Backfill 1 lần: fetch HistoricalQuotes (~1 năm) cho ~1576 mã HOSE
 * → ghi price-history.json. Chạy: node scripts/backfill-price-history.js
 *
 * Batch delay 500ms + backoff khi lỗi. Log progress.
 * Dùng cookie-manager (Playwright login) cho auth — chạy được trong Docker
 * (image có Playwright; nếu local thiếu FIREANT_EMAIL/PASSWORD → fetch không auth,
 * nhiều endpoint FireAnt vẫn trả data công khai).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');
const { setHistory, getMeta } = require('../ta/price-history');
const breadthBatches = require('../breadth-symbols');

const DELAY_MS = 400;

// breadth-symbols là array của 20 chuỗi "SYM1,SYM2,...". Flatten thành mảng symbol.
const ALL_SYMBOLS = breadthBatches.flatMap(s => String(s).split(',').map(x => x.trim()).filter(Boolean));

function formatSimpleDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchOne(symbol, cookie) {
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 400);
  const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${formatSimpleDate(start)}&endDate=${formatSimpleDate(end)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
  if (cookie) headers['Cookie'] = cookie;
  const res = await axios.get(url, { headers, timeout: 15000 });
  const items = Array.isArray(res.data) ? res.data.filter(d => d.Close > 0) : [];
  return {
    dates: items.map(d => String(d.Date).split('T')[0]),
    ohlc: items.map(d => ({
      o: d.Open || 0, h: d.High || 0, l: d.Low || 0, c: d.Close || 0
    })),
    volumes: items.map(d => d.Volume || 0)
  };
}

async function main() {
  let cookie = '';
  try {
    const cookieManager = require('../cookie-manager');
    cookie = await cookieManager.getCookie().catch(() => '');
  } catch (e) {
    console.log('⚠️ cookie-manager không khả dụng, fetch không auth:', e.message);
  }

  console.log(`Backfill ${ALL_SYMBOLS.length} symbols (cookie: ${cookie ? 'yes' : 'no'})...`);
  let done = 0, fail = 0;
  for (let i = 0; i < ALL_SYMBOLS.length; i++) {
    const sym = ALL_SYMBOLS[i];
    try {
      const h = await fetchOne(sym, cookie);
      if (h.dates.length > 0) { setHistory(sym, h); done++; }
      else fail++;
    } catch (e) {
      if (i < 5 || i % 100 === 0) console.warn(`  ${sym} fail: ${e.message}`);
      fail++;
    }
    if ((i + 1) % 100 === 0) {
      console.log(`Progress: ${i + 1}/${ALL_SYMBOLS.length} (ok=${done} fail=${fail})`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log(`\n✅ Done. ok=${done} fail=${fail}. Meta:`, getMeta());
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
