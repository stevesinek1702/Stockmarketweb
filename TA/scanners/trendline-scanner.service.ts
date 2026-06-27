/**
 * Break Trendline Scanner - Quét CP vừa break khỏi trendline giảm
 *
 * Điều kiện:
 * 1. CP có chuỗi giảm/tích lũy trước đó (giá giảm hoặc đi ngang 10-30 phiên)
 * 2. Phiên gần nhất giá tăng mạnh (> +2%) hoặc breakout khỏi range
 * 3. Volume phiên break > 1.3x avg 20 phiên (xác nhận breakout)
 * 4. Giá close > high của 5 phiên trước (break resistance)
 * 5. Thanh khoản tối thiểu 200K/phiên
 */

export interface TrendlineSignal {
  symbol: string;
  price: number;
  change: number;
  breakStrength: number;  // % vượt resistance
  prevHigh5: number;      // High 5 phiên trước
  prevLow10: number;      // Low 10 phiên trước
  rangeWidth: number;     // % range tích lũy
  volume: number;
  avgVolume20: number;
  volumeRatio: number;
  downDays: number;       // Số phiên giảm trong 15 phiên trước
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

async function fetchPriceData(symbol: string): Promise<StockData[]> {
  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - 60);
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

function analyzeStock(symbol: string, data: StockData[]): TrendlineSignal | null {
  if (data.length < 20) return null;

  var today = data[data.length - 1];
  var yesterday = data[data.length - 2];

  // Check data freshness
  if ((Date.now() - new Date(today.date).getTime()) / 86400000 > 5) return null;

  // Thanh khoản
  var volumes = data.map(d => d.volume);
  var last20Vol = volumes.slice(-20);
  var avgVol20 = last20Vol.reduce((s, v) => s + v, 0) / 20;
  if (avgVol20 < MIN_AVG_VOLUME) return null;

  var volumeRatio = avgVol20 > 0 ? today.volume / avgVol20 : 0;

  // Điều kiện 1: Volume phiên break > 1.3x avg (xác nhận breakout)
  if (volumeRatio < 1.3) return null;

  // Điều kiện 2: Nến xanh mạnh (close > open, change > +1.5%)
  var change = yesterday.close > 0 ? ((today.close - yesterday.close) / yesterday.close) * 100 : 0;
  if (today.close <= today.open) return null;
  if (change < 1.5) return null;

  // Lấy 15 phiên trước (không tính hôm nay) để check xu hướng giảm/tích lũy
  var prev15 = data.slice(-16, -1);
  if (prev15.length < 10) return null;

  // Đếm số phiên giảm trong 15 phiên trước
  var downDays = 0;
  for (var i = 1; i < prev15.length; i++) {
    if (prev15[i].close < prev15[i - 1].close) downDays++;
  }

  // Cần ít nhất 6/14 phiên giảm (xu hướng giảm hoặc tích lũy)
  if (downDays < 6) return null;

  // Điều kiện 3: Giá close hôm nay > high của 5 phiên trước (break resistance)
  var prev5 = data.slice(-6, -1);
  var prevHigh5 = Math.max(...prev5.map(d => d.high));
  if (today.close <= prevHigh5) return null;

  // Break strength: % vượt resistance
  var breakStrength = ((today.close - prevHigh5) / prevHigh5) * 100;

  // Range tích lũy: high-low của 10 phiên trước
  var prev10 = data.slice(-11, -1);
  var prevHigh10 = Math.max(...prev10.map(d => d.high));
  var prevLow10 = Math.min(...prev10.map(d => d.low));
  var rangeWidth = prevLow10 > 0 ? ((prevHigh10 - prevLow10) / prevLow10) * 100 : 0;

  return {
    symbol, price: today.close, change, breakStrength, prevHigh5, prevLow10,
    rangeWidth, volume: today.volume, avgVolume20: avgVol20, volumeRatio,
    downDays, date: today.date,
  };
}

export async function scanTrendlineBreak(): Promise<TrendlineSignal[]> {
  console.log(`[TRENDLINE] 🔍 Starting trendline break scan for ${SCAN_STOCKS.length} stocks...`);
  var startTime = Date.now();
  var signals: TrendlineSignal[] = [];
  var processed = 0;

  for (var i = 0; i < SCAN_STOCKS.length; i += BATCH_SIZE) {
    var batch = SCAN_STOCKS.slice(i, i + BATCH_SIZE);
    var results = await Promise.allSettled(
      batch.map(async (sym) => {
        var data = await fetchPriceData(sym);
        return analyzeStock(sym, data);
      })
    );
    for (var r of results) {
      if (r.status === 'fulfilled' && r.value) signals.push(r.value);
    }
    processed += batch.length;
    if (processed % 50 === 0) console.log(`[TRENDLINE] ⏳ ${processed}/${SCAN_STOCKS.length}, found ${signals.length}`);
    if (i + BATCH_SIZE < SCAN_STOCKS.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
  }

  // Sort: volume ratio cao nhất trước
  signals.sort((a, b) => b.volumeRatio - a.volumeRatio);
  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[TRENDLINE] ✅ Scan done in ${elapsed}s: ${signals.length} trendline break signals`);
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

export function formatTrendlineReport(signals: TrendlineSignal[]): string {
  var vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  var dateStr = vnNow.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  var report = `📈 BREAK TRENDLINE SCAN\n`;
  report += `📅 ${dateStr}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (signals.length === 0) {
    report += `ℹ️ Hôm nay không có CP nào break trendline giảm kèm volume xác nhận.\n`;
    report += `\n💡 Tiêu chí: Break high 5 phiên, volume > 1.3x avg, sau chuỗi giảm/tích lũy.`;
    return report;
  }

  // Chia 2 nhóm: volume đột biến (>2x) vs bình thường (1.3-2x)
  var highVol = signals.filter(s => s.volumeRatio >= 2);
  var normalVol = signals.filter(s => s.volumeRatio < 2);

  var formatLine = (s: TrendlineSignal, idx: number) => {
    var ch = `+${s.change.toFixed(1)}%`;
    return `${idx}. ${s.symbol} - ${formatPrice(s.price)} (${ch}) | Break: +${s.breakStrength.toFixed(1)}% | KL: ${formatVol(s.volume)} (x${s.volumeRatio.toFixed(1)}) | Range: ${s.rangeWidth.toFixed(1)}%\n`;
  };

  if (highVol.length > 0) {
    report += `🔥 BREAK + VOLUME ĐỘT BIẾN (>2x avg):\n\n`;
    for (var i = 0; i < highVol.length; i++) report += formatLine(highVol[i], i + 1);
    report += `\n`;
  }

  if (normalVol.length > 0) {
    report += `🟢 BREAK TRENDLINE (Volume 1.3-2x):\n\n`;
    for (var j = 0; j < normalVol.length; j++) report += formatLine(normalVol[j], j + 1);
    report += `\n`;
  }

  report += `📋 Tổng: ${signals.length} CP (${highVol.length} vol đột biến, ${normalVol.length} vol bình thường)\n`;
  report += `\n💡 Break trendline + volume cao = tín hiệu đảo chiều mạnh. Chú ý quản lý vốn.`;
  return report;
}
