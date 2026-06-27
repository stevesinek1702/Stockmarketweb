/**
 * RS Breakout Scanner - Quét CP vừa cắt lên MA49 RS
 * 
 * Điều kiện:
 * 1. RS vừa cắt lên MA49 (1-2 phiên)
 * 2. Giá tăng (close > open, close > close hôm qua)
 * 3. Volume > avg 20 phiên (càng cao càng tốt)
 * 4. Thanh khoản tối thiểu 200K/phiên
 */

import { recordRecommendation } from '../strategy-tracker/strategy-tracker.service.js';

export interface RSSignal {
  symbol: string;
  price: number;
  change: number;
  rs: number;
  rsMA10: number;      // MA10 RS (signal nhanh T+)
  rsMA49: number;      // MA49 RS (signal trung hạn)
  rsPrev: number;
  rsMA10Prev: number;
  rsMA49Prev: number;
  crossType: string;   // 'ma10' | 'ma49' | 'both'
  rsTrend: string;
  rsAccel: number;     // RS acceleration
  rsNewHigh: boolean;  // RS new high 20 phiên
  volume: number;
  avgVolume20: number;
  volumeRatio: number;
  date: string;
}

// Dùng chung danh sách CP với MACD scanner
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

// Fetch RS data từ FireAnt
async function fetchRS(symbol: string): Promise<Array<{date: string; value: number}>> {
  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - 120); // 120 ngày cho MA49 + buffer
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

// Fetch price data
async function fetchPrice(symbol: string): Promise<Array<{date: string; open: number; close: number; volume: number}>> {
  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);
  var fmt = (d: Date) => d.toISOString().split('T')[0];
  var url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}`;
  try {
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    var raw = await res.json();
    if (!raw || !raw.length) return [];
    return raw.map((d: any) => ({
      date: d.Date?.split('T')[0] || '',
      open: d.Open || d.PriceOpen || 0,
      close: d.Close || d.PriceClose || 0,
      volume: d.Volume || d.TotalVolume || 0,
    })).filter((d: any) => d.close > 0).sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
  } catch { return []; }
}

function analyzeRS(symbol: string, rsData: Array<{date: string; value: number}>, priceData: Array<{date: string; open: number; close: number; volume: number}>): RSSignal | null {
  if (rsData.length < 50 || priceData.length < 5) return null;

  var rs = rsData[rsData.length - 1].value;
  var rsPrev = rsData[rsData.length - 2].value;

  // MA10
  var last10 = rsData.slice(-10);
  var rsMA10 = last10.reduce((s, d) => s + d.value, 0) / 10;
  var last10Prev = rsData.slice(-11, -1);
  var rsMA10Prev = last10Prev.length >= 10 ? last10Prev.reduce((s, d) => s + d.value, 0) / 10 : rsMA10;

  // MA49
  var last49 = rsData.slice(-49);
  var rsMA49 = last49.reduce((s, d) => s + d.value, 0) / 49;
  var last49Prev = rsData.slice(-50, -1);
  var rsMA49Prev = last49Prev.length >= 49 ? last49Prev.reduce((s, d) => s + d.value, 0) / 49 : rsMA49;

  // Check crossover MA10 (1-2 phiên)
  var crossMA10 = false;
  if (rsPrev <= rsMA10Prev && rs > rsMA10) crossMA10 = true;
  else if (rsData.length >= 3) {
    var rsPrev2 = rsData[rsData.length - 3].value;
    var last10Prev2 = rsData.slice(-12, -2);
    var ma10Prev2 = last10Prev2.length >= 10 ? last10Prev2.reduce((s, d) => s + d.value, 0) / 10 : rsMA10;
    if (rsPrev2 <= ma10Prev2 && rsPrev > rsMA10Prev && rs > rsMA10) crossMA10 = true;
  }

  // Check crossover MA49 (1-2 phiên)
  var crossMA49 = false;
  if (rsPrev <= rsMA49Prev && rs > rsMA49) crossMA49 = true;
  else if (rsData.length >= 3) {
    var rsPrev2b = rsData[rsData.length - 3].value;
    var last49Prev2 = rsData.slice(-51, -2);
    var ma49Prev2 = last49Prev2.length >= 49 ? last49Prev2.reduce((s, d) => s + d.value, 0) / 49 : rsMA49;
    if (rsPrev2b <= ma49Prev2 && rsPrev > rsMA49Prev && rs > rsMA49) crossMA49 = true;
  }

  // Cần ít nhất 1 crossover
  if (!crossMA10 && !crossMA49) return null;

  // Giá tăng
  var today = priceData[priceData.length - 1];
  var yesterday = priceData[priceData.length - 2];
  if (today.close <= today.open) return null;
  if (today.close <= yesterday.close) return null;

  // Thanh khoản
  var last20Vol = priceData.slice(-20);
  var avgVol20 = last20Vol.reduce((s, d) => s + d.volume, 0) / last20Vol.length;
  if (avgVol20 < MIN_AVG_VOLUME) return null;

  var volumeRatio = avgVol20 > 0 ? today.volume / avgVol20 : 0;

  // RS trend
  var rsTrend = 'sideways';
  if (rsData.length >= 10) {
    var first5 = rsData.slice(-10, -5).reduce((s, d) => s + d.value, 0) / 5;
    var last5 = rsData.slice(-5).reduce((s, d) => s + d.value, 0) / 5;
    if (last5 - first5 > 3) rsTrend = 'uptrend';
    else if (first5 - last5 > 3) rsTrend = 'downtrend';
  }

  // RS acceleration
  var rsAccel = 0;
  if (rsData.length >= 8) {
    var velOld = (rsData[rsData.length - 3].value - rsData[rsData.length - 6].value) / 3;
    var velNew = (rs - rsPrev) / 1;
    rsAccel = velNew - velOld;
  }

  // RS new high 20 phiên
  var rsNewHigh = false;
  if (rsData.length >= 20) {
    var max20 = Math.max(...rsData.slice(-21, -1).map(d => d.value));
    rsNewHigh = rs > max20;
  }

  var crossType = (crossMA10 && crossMA49) ? 'both' : (crossMA10 ? 'ma10' : 'ma49');
  var change = yesterday.close > 0 ? ((today.close - yesterday.close) / yesterday.close) * 100 : 0;

  return {
    symbol, price: today.close, change, rs, rsMA10, rsMA49, rsPrev,
    rsMA10Prev, rsMA49Prev, crossType, rsTrend, rsAccel, rsNewHigh,
    volume: today.volume, avgVolume20: avgVol20, volumeRatio, date: today.date,
  };
}

export async function scanRSBreakout(): Promise<RSSignal[]> {
  console.log(`[RS] 🔍 Starting RS breakout scan for ${SCAN_STOCKS.length} stocks...`);
  var startTime = Date.now();
  var signals: RSSignal[] = [];
  var processed = 0;

  for (var i = 0; i < SCAN_STOCKS.length; i += BATCH_SIZE) {
    var batch = SCAN_STOCKS.slice(i, i + BATCH_SIZE);
    var results = await Promise.allSettled(
      batch.map(async (sym) => {
        var [rsData, priceData] = await Promise.all([fetchRS(sym), fetchPrice(sym)]);
        return analyzeRS(sym, rsData, priceData);
      })
    );
    for (var r of results) {
      if (r.status === 'fulfilled' && r.value) signals.push(r.value);
    }
    processed += batch.length;
    if (processed % 50 === 0) console.log(`[RS] ⏳ ${processed}/${SCAN_STOCKS.length}, found ${signals.length}`);
    if (i + BATCH_SIZE < SCAN_STOCKS.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
  }

  // Sort: volume ratio cao nhất trước
  signals.sort((a, b) => b.volumeRatio - a.volumeRatio);
  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[RS] ✅ Scan done in ${elapsed}s: ${signals.length} RS breakout signals`);

  // Tich hop Strategy Tracker — ghi nhan khuyen nghi cho moi signal
  for (var sig of signals) {
    try {
      // Target dua tren RS strength: RS cao → target cao hon
      // RS > 80: +10%, RS 60-80: +8%, RS < 60: +6%
      var targetPct = sig.rs > 80 ? 1.10 : sig.rs > 60 ? 1.08 : 1.06;
      // Stop loss: -4% (R:R >= 2.0 voi target >= +8%)
      var stopPct = 0.96;

      await recordRecommendation({
        symbol: sig.symbol,
        entryPrice: Math.round(sig.price * 1000),
        targetPrice: Math.round(sig.price * 1000 * targetPct),
        stopLossPrice: Math.round(sig.price * 1000 * stopPct),
        reason: `RS breakout: RS ${sig.rs.toFixed(0)} > MA49 ${sig.rsMA49.toFixed(0)}, cross=${sig.crossType}, trend=${sig.rsTrend}, vol x${sig.volumeRatio.toFixed(1)}`,
        method: 'rs_breakout',
        source: 'scanner',
        confidenceScore: 60,
      });
    } catch (e: any) {
      // Non-fatal — khong anh huong scanner
      console.warn(`[RS] ⚠️ Strategy tracker ghi nhan ${sig.symbol} that bai: ${e.message}`);
    }
  }

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

export function formatRSReport(signals: RSSignal[]): string {
  var vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  var dateStr = vnNow.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  var report = `⚡ RS BREAKOUT SCAN\n`;
  report += `📅 ${dateStr}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (signals.length === 0) {
    report += `ℹ️ Hôm nay không có CP nào RS vừa cắt lên MA10/MA49 kèm giá + volume xác nhận.\n`;
    return report;
  }

  // Chia 3 nhóm: cắt cả MA10+MA49, chỉ MA10 (T+), chỉ MA49 (trung hạn)
  var both = signals.filter(s => s.crossType === 'both');
  var ma10Only = signals.filter(s => s.crossType === 'ma10');
  var ma49Only = signals.filter(s => s.crossType === 'ma49');

  var formatLine = (s: RSSignal, idx: number) => {
    var ch = s.change >= 0 ? `+${s.change.toFixed(1)}%` : `${s.change.toFixed(1)}%`;
    var volStr = s.volumeRatio >= 1.5 ? ` 🔥x${s.volumeRatio.toFixed(1)}` : '';
    var nhStr = s.rsNewHigh ? ' ⭐NH' : '';
    var accelStr = s.rsAccel > 1 ? ' 🚀' : '';
    return `${idx}. ${s.symbol} - ${formatPrice(s.price)} (${ch}) | RS: ${s.rs.toFixed(0)} > MA10: ${s.rsMA10.toFixed(0)} / MA49: ${s.rsMA49.toFixed(0)} | KL: ${formatVol(s.volume)}${volStr}${nhStr}${accelStr}\n`;
  };

  if (both.length > 0) {
    report += `🟢🔥 RS CẮT LÊN CẢ MA10 + MA49 (Signal mạnh nhất):\n\n`;
    for (var i = 0; i < both.length; i++) report += formatLine(both[i], i + 1);
    report += `\n`;
  }

  if (ma10Only.length > 0) {
    report += `🟢 RS CẮT LÊN MA10 (T+ nhanh):\n\n`;
    for (var j = 0; j < ma10Only.length; j++) report += formatLine(ma10Only[j], j + 1);
    report += `\n`;
  }

  if (ma49Only.length > 0) {
    report += `🟡 RS CẮT LÊN MA49 (Trung hạn):\n\n`;
    for (var k = 0; k < ma49Only.length; k++) report += formatLine(ma49Only[k], k + 1);
    report += `\n`;
  }

  report += `📋 Tổng: ${signals.length} CP (${both.length} cả 2, ${ma10Only.length} MA10, ${ma49Only.length} MA49)\n`;
  report += `\n💡 RS cắt MA10+MA49 + volume cao + RS tăng tốc = setup T+ mạnh nhất.`;
  return report;
}
