/**
 * Backfill OHLC+volume history — AN TOÀN CHO QUOTA.
 *
 * FIX (sau khi user hết quota):
 *   1. RESUME: skip symbol đã có đủ data (≥ minDays) → chạy lại chỉ fetch symbol thiếu.
 *   2. RATE LIMIT: delay 1.5s/symbol (chậm nhưng không chết quota).
 *   3. BACKOFF 429: khi FireAnt trả 429 (quota) → dừng NGAY, không cố tiếp.
 *   4. DAILY CAP: giới hạn max N symbol/ngày (mặc định 300) → không bao giờ hết quota.
 *   5. CLI: node script.js [maxSymbols] [minDays]  vd: node script.js 200 200
 *
 * Chạy: docker compose exec express node scripts/backfill-price-history.js 200 200
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');
const ph = require('../ta/price-history');
const breadthBatches = require('../breadth-symbols');

const DELAY_MS = 1500;          // 1.5s/symbol — chậm nhưng an toàn quota
const DEFAULT_MAX = 300;        // giới hạn symbol/lần chạy (tránh quota)
const DEFAULT_MIN_DAYS = 200;   // skip symbol đã có ≥ 200 ngày

const args = process.argv.slice(2);
const MAX_SYMBOLS = parseInt(args[0]) || DEFAULT_MAX;
const MIN_DAYS = parseInt(args[1]) || DEFAULT_MIN_DAYS;

const ALL_SYMBOLS = breadthBatches.flatMap(s => String(s).split(',').map(x => x.trim()).filter(Boolean));

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let quotaHit = false; // flag: nếu true → dừng toàn bộ

async function fetchOne(symbol, cookie) {
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 400);
  const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${fmt(start)}&endDate=${fmt(end)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
  if (cookie) headers['Cookie'] = cookie;
  try {
    const res = await axios.get(url, { headers, timeout: 15000, validateStatus: s => s < 500 });
    if (res.status === 429) {
      console.error(`⛔ [${symbol}] FireAnt 429 — QUOTA HIT. Dừng backfill ngay.`);
      quotaHit = true;
      return null;
    }
    const items = Array.isArray(res.data) ? res.data.filter(d => d.Close > 0) : [];
    return {
      dates: items.map(d => String(d.Date).split('T')[0]),
      ohlc: items.map(d => ({ o: d.Open || 0, h: d.High || 0, l: d.Low || 0, c: d.Close || 0 })),
      volumes: items.map(d => d.Volume || 0)
    };
  } catch (e) {
    if (e.response && e.response.status === 429) {
      console.error(`⛔ [${symbol}] FireAnt 429 — QUOTA HIT. Dừng backfill ngay.`);
      quotaHit = true;
      return null;
    }
    throw e;
  }
}

async function main() {
  let cookie = '';
  try {
    const cookieManager = require('../cookie-manager');
    cookie = await cookieManager.getCookie().catch(() => '');
  } catch (e) { console.log('⚠️ no cookie:', e.message); }

  // RESUME: lọc symbol cần fetch (chưa đủ MIN_DAYS)
  const needFetch = [];
  let alreadyHave = 0;
  for (const sym of ALL_SYMBOLS) {
    const h = ph.getHistory(sym);
    const days = h ? (h.ohlc || h.closes || []).length : 0;
    if (days >= MIN_DAYS) { alreadyHave++; continue; }
    needFetch.push(sym);
  }
  const toFetch = needFetch.slice(0, MAX_SYMBOLS); // cap daily
  console.log(`Backfill: ${ALL_SYMBOLS.length} total, ${alreadyHave} đã có ≥${MIN_DAYS}d, ${needFetch.length} cần fetch, cap=${MAX_SYMBOLS}`);
  console.log(`Sẽ fetch ${toFetch.length} symbol (delay ${DELAY_MS}ms, cookie: ${cookie ? 'yes' : 'no'})`);

  let done = 0, fail = 0;
  for (let i = 0; i < toFetch.length; i++) {
    if (quotaHit) {
      console.log(`⛔ Quota hit — dừng sớm tại ${i}/${toFetch.length}`);
      break;
    }
    const sym = toFetch[i];
    try {
      const h = await fetchOne(sym, cookie);
      if (h === null) { fail++; break; } // quota hit
      if (h && h.dates.length > 0) {
        // MERGE với data cũ nếu có (không ghi đè)
        const existing = ph.getHistory(sym);
        if (existing && existing.dates) {
          const existingDates = new Set(existing.dates);
          for (let j = 0; j < h.dates.length; j++) {
            if (!existingDates.has(h.dates[j])) {
              existing.dates.push(h.dates[j]);
              existing.ohlc.push(h.ohlc[j]);
              existing.volumes.push(h.volumes[j]);
            }
          }
          ph.setHistory(sym, existing);
        } else {
          ph.setHistory(sym, h);
        }
        done++;
      } else fail++;
    } catch (e) {
      if (i < 5 || i % 50 === 0) console.warn(`  ${sym} fail: ${e.message}`);
      fail++;
    }
    if ((i + 1) % 50 === 0) console.log(`Progress: ${i + 1}/${toFetch.length} (ok=${done} fail=${fail})`);
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log(`\n✅ Done. ok=${done} fail=${fail}${quotaHit ? ' (QUOTA HIT)' : ''}. Meta:`, ph.getMeta());
  if (quotaHit) {
    console.log('⚠️ Quota bị hit. Chạy lại sau (script sẽ RESUME — skip symbol đã có data).');
    console.log('   Hoặc giảm MAX_SYMBOLS: node script.js 100 200');
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
