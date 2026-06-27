/**
 * CP Tiềm Năng Scanner - Quét CP có nền tảng kỹ thuật tốt
 *
 * Điều kiện:
 * 1. Giá trên MA20 (uptrend ngắn hạn)
 * 2. Giá trên MA50 (uptrend trung hạn)
 * 3. MA20 > MA50 (golden cross structure)
 * 4. RS > 55 (mạnh hơn thị trường)
 * 5. Volume avg 20 phiên >= 200K
 * 6. Giá không quá xa MA20 (< 8%) - tránh mua đuổi
 * 7. Nến xanh hoặc giá tăng so hôm qua
 */

export interface PotentialSignal {
  symbol: string;
  price: number;
  change: number;
  ma20: number;
  ma50: number;
  distMA20: number;   // % distance from MA20
  rs: number;
  rsMA10: number;
  volume: number;
  avgVolume20: number;
  volumeRatio: number;
  rsTrend: string;
  date: string;
}

var SCAN_STOCKS = [
  'ACB', 'BCM', 'BID', 'BVH', 'CTG', 'FPT', 'GAS', 'GVR', 'HDB', 'HPG',
  'MBB', 'MSN', 'MWG', 'PLX', 'POW', 'SAB', 'SHB', 'SSB', 'SSI', 'STB',
  'TCB', 'TPB', 'VCB', 'VHM', 'VIB', 'VIC', 'VJC', 'VNM', 'VPB', 'VRE',
  'ANV', 'BWE', 'CII', 'CTD', 'DCM', 'DGC', 'DIG', 'DPM', 'DXG', 'EIB',
  'FRT', 'GEX', 'GMD', 'HAG', 'HCM', 'HDG', 'HSG', 'KBC', 'KDH', 'LPB',
  'MSB', 'NKG', 'NLG', 'NVL', 'OCB', 'PC1', 'PDR', 'PNJ', 'PVD', 'PVS',
  'REE', 'SJS', 'TCH', 'VCI', 'VHC', 'VND', 'BSR', 'DBC', 'FLC', 'FTS',
  'HBC', 'ITA', 'PAN', 'SBT', 'SCR', 'SMC', 'TCM', 'VSC', 'SHS', 'VIX',
  'TNG', 'CEO', 'PVI', 'AAA', 'DGW', 'GEG', 'IJC', 'KOS', 'NT2', 'PHR',
  'PVT', 'SIP', 'SZC', 'VGC', 'AGG', 'APH', 'CSV', 'CTS', 'TCX', 'VCK',
];

var BATCH_SIZE = 10;
var BATCH_DELAY = 500;
var MIN_AVG_VOLUME = 200_000;

interface StockData {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

interface RSData {
  date: string; value: number;
}

async function fetchPriceData(symbol: string): Promise<StockData[]> {
  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - 120);
  var fmt = (d: Date) => d.toISOString().split('T')[0];
  var url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}`;
  try {
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    var ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return [];
    var raw = await res.json();
    if (!raw || !raw.length) return [];
    var data: StockData[] = raw.map((item: any) => ({
      date: item.Date?.split('T')[0] || item.date?.split('T')[0],
      open: item.Open || item.PriceOpen || item.open || 0,
      high: item.High || item.PriceHigh || item.high || 0,
      low: item.Low || item.PriceLow || item.low || 0,
      close: item.Close || item.PriceClose || item.close || 0,
      volume: item.Volume || item.TotalVolume || item.volume || 0,
    })).filter((d: StockData) => d.close > 0);
    data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return data;
  } catch { return []; }
}

async function fetchRS(symbol: string): Promise<RSData[]> {
  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - 120);
  var fmt = (d: Date) => `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  var url = `https://www.fireant.vn/api/Data/Markets/CustomIndicatorHistoricalData?symbol=${symbol}%23RS&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}`;
  try {
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    var raw = await res.json();
    if (!raw || !raw.length) return [];
    return raw.map((d: any) => ({
      date: d.Date?.split('T')[0] || '',
      value: d.Open || d.Close || d.Value || 0,
    })).filter((d: any) => d.value > 0).sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
  } catch { return []; }
}

function analyzeStock(symbol: string, priceData: StockData[], rsData: RSData[]): PotentialSignal | null {
  if (priceData.length < 55 || rsData.length < 15) return null;

  var closes = priceData.map(d => d.close);
  var today = priceData[priceData.length - 1];
  var yesterday = priceData[priceData.length - 2];

  // Check data freshness
  var lastDate = new Date(today.date);
  if ((Date.now() - lastDate.getTime()) / 86400000 > 5) return null;

  // MA20
  var last20 = closes.slice(-20);
  var ma20 = last20.reduce((s, v) => s + v, 0) / 20;

  // MA50
  var last50 = closes.slice(-50);
  var ma50 = last50.reduce((s, v) => s + v, 0) / 50;

  // Điều kiện 1: Giá trên MA20 và MA50
  if (today.close < ma20 || today.close < ma50) return null;

  // Điều kiện 2: MA20 > MA50 (golden cross structure)
  if (ma20 < ma50) return null;

  // Điều kiện 3: Giá không quá xa MA20 (< 8%) - tránh mua đuổi
  var distMA20 = ((today.close - ma20) / ma20) * 100;
  if (distMA20 > 8) return null;

  // Điều kiện 4: RS > 55
  var rs = rsData[rsData.length - 1].value;
  if (rs < 55) return null;

  // RS MA10
  var rsLast10 = rsData.slice(-10);
  var rsMA10 = rsLast10.reduce((s, d) => s + d.value, 0) / rsLast10.length;

  // Điều kiện 5: Nến xanh hoặc giá tăng so hôm qua
  if (today.close <= today.open && today.close <= yesterday.close) return null;

  // Điều kiện 6: Thanh khoản
  var volumes = priceData.map(d => d.volume);
  var last20Vol = volumes.slice(-20);
  var avgVol20 = last20Vol.reduce((s, v) => s + v, 0) / 20;
  if (avgVol20 < MIN_AVG_VOLUME) return null;

  var volumeRatio = avgVol20 > 0 ? today.volume / avgVol20 : 0;
  var change = yesterday.close > 0 ? ((today.close - yesterday.close) / yesterday.close) * 100 : 0;

  // RS trend
  var rsTrend = 'sideways';
  if (rsData.length >= 10) {
    var first5 = rsData.slice(-10, -5).reduce((s, d) => s + d.value, 0) / 5;
    var last5 = rsData.slice(-5).reduce((s, d) => s + d.value, 0) / 5;
    if (last5 - first5 > 3) rsTrend = 'uptrend';
    else if (first5 - last5 > 3) rsTrend = 'downtrend';
  }

  return {
    symbol, price: today.close, change, ma20, ma50, distMA20, rs, rsMA10,
    volume: today.volume, avgVolume20: avgVol20, volumeRatio, rsTrend, date: today.date,
  };
}

export async function scanPotential(): Promise<PotentialSignal[]> {
  console.log(`[POTENTIAL] 🔍 Starting potential stock scan for ${SCAN_STOCKS.length} stocks...`);
  var startTime = Date.now();
  var signals: PotentialSignal[] = [];
  var processed = 0;

  for (var i = 0; i < SCAN_STOCKS.length; i += BATCH_SIZE) {
    var batch = SCAN_STOCKS.slice(i, i + BATCH_SIZE);
    var results = await Promise.allSettled(
      batch.map(async (sym) => {
        var [priceData, rsData] = await Promise.all([fetchPriceData(sym), fetchRS(sym)]);
        return analyzeStock(sym, priceData, rsData);
      })
    );
    for (var r of results) {
      if (r.status === 'fulfilled' && r.value) signals.push(r.value);
    }
    processed += batch.length;
    if (processed % 50 === 0) console.log(`[POTENTIAL] ⏳ ${processed}/${SCAN_STOCKS.length}, found ${signals.length}`);
    if (i + BATCH_SIZE < SCAN_STOCKS.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
  }

  // Sort: RS cao nhất trước
  signals.sort((a, b) => b.rs - a.rs);
  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[POTENTIAL] ✅ Scan done in ${elapsed}s: ${signals.length} potential signals`);
  return signals;
}

function formatVol(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return v.toString();
}

function formatPrice(p: number): string {
  if (p < 1000) return p.toFixed(2);
  return p.toLocaleString('vi-VN');
}

export function formatPotentialReport(signals: PotentialSignal[]): string {
  var vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  var dateStr = vnNow.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  var report = `🌟 CP TIỀM NĂNG SCAN\n`;
  report += `📅 ${dateStr}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (signals.length === 0) {
    report += `ℹ️ Hôm nay không có CP nào đạt đủ tiêu chí tiềm năng.\n`;
    report += `\n💡 Tiêu chí: Giá > MA20 > MA50, RS > 55, không quá xa MA20.`;
    return report;
  }

  // Chia 2 nhóm: RS uptrend vs sideways/downtrend
  var rsUp = signals.filter(s => s.rsTrend === 'uptrend');
  var rsOther = signals.filter(s => s.rsTrend !== 'uptrend');

  var formatLine = (s: PotentialSignal, idx: number) => {
    var ch = s.change >= 0 ? `+${s.change.toFixed(1)}%` : `${s.change.toFixed(1)}%`;
    var volStr = s.volumeRatio >= 1.5 ? ` 🔥x${s.volumeRatio.toFixed(1)}` : '';
    return `${idx}. ${s.symbol} - ${formatPrice(s.price)} (${ch}) | RS: ${s.rs.toFixed(0)} | MA20: ${formatPrice(s.ma20)} (+${s.distMA20.toFixed(1)}%) | KL: ${formatVol(s.volume)}${volStr}\n`;
  };

  if (rsUp.length > 0) {
    report += `🟢 RS ĐANG UPTREND (Tiềm năng cao):\n\n`;
    for (var i = 0; i < rsUp.length; i++) report += formatLine(rsUp[i], i + 1);
    report += `\n`;
  }

  if (rsOther.length > 0) {
    report += `🟡 RS SIDEWAYS/TÍCH LŨY:\n\n`;
    for (var j = 0; j < rsOther.length; j++) report += formatLine(rsOther[j], j + 1);
    report += `\n`;
  }

  report += `📋 Tổng: ${signals.length} CP (${rsUp.length} RS uptrend, ${rsOther.length} khác)\n`;
  report += `\n💡 CP tiềm năng: Giá > MA20 > MA50, RS mạnh, gần MA20 = điểm mua an toàn.`;
  return report;
}
