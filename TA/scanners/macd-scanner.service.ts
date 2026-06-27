/**
 * MACD Crossover Scanner - Quét tín hiệu MACD cắt lên cho T+ trading
 *
 * Quét ~100 CP thanh khoản cao, tìm CP có MACD histogram vừa chuyển từ âm sang dương
 * (bearish → bullish crossover) - tín hiệu mua ngắn hạn T+
 */

import { recordRecommendation } from '../strategy-tracker/strategy-tracker.service.js';

interface StockData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MACDSignal {
  symbol: string;
  price: number;
  change: number;
  volume: number;
  avgVolume20: number;
  volumeRatio: number;
  macd: number;
  macdLine: number;  // MACD line value (EMA12 - EMA26) - dương = uptrend, âm = downtrend
  signal: number;
  histogram: number;
  prevHistogram: number;
  date: string;
}

// Top 100 CP thanh khoản cao (VN30 + midcap)
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

// ═══════════════════════════════════════════════════
// FETCH DATA
// ═══════════════════════════════════════════════════

async function fetchPriceData(symbol: string): Promise<StockData[]> {
  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(startDate.getDate() - 120); // 120 ngày để đủ data cho EMA26 + Signal9

  var fmt = (d: Date) => d.toISOString().split('T')[0];
  var url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}`;

  var response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!response.ok) return [];

  var contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) return [];

  var rawData = await response.json();
  if (!rawData || rawData.length === 0) return [];

  var data: StockData[] = rawData.map((item: any) => ({
    date: item.Date?.split('T')[0] || item.date?.split('T')[0],
    open: item.Open || item.priceOpen || item.PriceOpen || item.open || 0,
    high: item.High || item.priceHigh || item.PriceHigh || item.high || 0,
    low: item.Low || item.priceLow || item.PriceLow || item.low || 0,
    close: item.Close || item.priceClose || item.PriceClose || item.close || 0,
    volume: item.Volume || item.totalVolume || item.TotalVolume || item.volume || 0,
  })).filter((d: StockData) => d.close > 0);

  data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return data;
}

// ═══════════════════════════════════════════════════
// MACD CALCULATION
// ═══════════════════════════════════════════════════

function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  var multiplier = 2 / (period + 1);
  var emaValues: number[] = [];

  // SMA cho period đầu tiên
  var sma = 0;
  for (var i = 0; i < period; i++) sma += prices[i];
  sma /= period;
  emaValues.push(sma);

  // EMA từ period trở đi
  for (var i = period; i < prices.length; i++) {
    var ema = (prices[i] - emaValues[emaValues.length - 1]) * multiplier + emaValues[emaValues.length - 1];
    emaValues.push(ema);
  }

  return emaValues;
}

function calculateMACD(closes: number[]): { macd: number[]; signal: number[]; histogram: number[] } {
  var ema12 = calculateEMA(closes, 12);
  var ema26 = calculateEMA(closes, 26);

  if (ema12.length === 0 || ema26.length === 0) {
    return { macd: [], signal: [], histogram: [] };
  }

  // MACD line = EMA12 - EMA26 (align từ index 26)
  // ema12 bắt đầu từ index 12, ema26 từ index 26
  // Offset: ema12[i] tương ứng closes[12 + i], ema26[j] tương ứng closes[26 + j]
  var macdLine: number[] = [];
  var ema12Offset = 12; // ema12[0] = closes[12]
  var ema26Offset = 26; // ema26[0] = closes[26]

  for (var i = 0; i < ema26.length; i++) {
    var closesIdx = ema26Offset + i;
    var ema12Idx = closesIdx - ema12Offset;
    if (ema12Idx >= 0 && ema12Idx < ema12.length) {
      macdLine.push(ema12[ema12Idx] - ema26[i]);
    }
  }

  // Signal line = EMA9 của MACD line
  var signalLine = calculateEMA(macdLine, 9);

  if (signalLine.length === 0) {
    return { macd: macdLine, signal: [], histogram: [] };
  }

  // Histogram = MACD - Signal (align cuối)
  var histogramArr: number[] = [];
  var signalOffset = 9; // signalLine[0] = macdLine[9]
  for (var i = 0; i < signalLine.length; i++) {
    var macdIdx = signalOffset + i;
    if (macdIdx < macdLine.length) {
      histogramArr.push(macdLine[macdIdx] - signalLine[i]);
    }
  }

  return { macd: macdLine, signal: signalLine, histogram: histogramArr };
}

// ═══════════════════════════════════════════════════
// SCANNER
// ═══════════════════════════════════════════════════

function analyzeStock(symbol: string, data: StockData[]): MACDSignal | null {
  if (data.length < 40) return null; // Cần ít nhất 40 ngày cho MACD (26+9+buffer)

  var closes = data.map(d => d.close);
  var { macd, signal, histogram } = calculateMACD(closes);

  if (histogram.length < 3) return null;

  var currentHist = histogram[histogram.length - 1];
  var prevHist = histogram[histogram.length - 2];
  var prev2Hist = histogram[histogram.length - 3];

  // ═══ ĐIỀU KIỆN 1: MACD Bullish Crossover MỚI (trong 1-2 phiên) ═══
  // Case A: Histogram hôm qua âm, hôm nay dương (crossover hôm nay)
  // Case B: Histogram 2 phiên trước âm, hôm qua dương, hôm nay vẫn dương (crossover hôm qua)
  //         → chấp nhận nếu histogram đang tăng (momentum đang mạnh lên)
  var isFreshCrossover = false;
  
  if (prevHist < 0 && currentHist > 0) {
    // Case A: crossover ngay hôm nay
    isFreshCrossover = true;
  } else if (prev2Hist < 0 && prevHist > 0 && currentHist > 0 && currentHist > prevHist) {
    // Case B: crossover hôm qua, hôm nay histogram vẫn tăng (momentum mạnh)
    isFreshCrossover = true;
  }
  
  if (!isFreshCrossover) return null;
  
  // Check data freshness: phiên cuối phải trong 5 ngày gần nhất (tránh data cũ)
  var lastDate = new Date(data[data.length - 1].date);
  var daysSinceLastData = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceLastData > 5) return null;

  var todayClose = data[data.length - 1].close;
  var todayOpen = data[data.length - 1].open;
  var yesterdayClose = data[data.length - 2].close;

  // ═══ ĐIỀU KIỆN 2: RSI 30-75 (nới rộng cho T+ trading) ═══
  // Cho phép CP oversold hồi lại (RSI 30-40) - đây là cơ hội T+ tốt
  // Không quá mua (>75)
  var gains = 0, losses = 0;
  var rsiPeriod = 14;
  var rsiData = closes.slice(-rsiPeriod - 1);
  for (var r = 1; r < rsiData.length; r++) {
    var diff = rsiData[r] - rsiData[r - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  var avgGain = gains / rsiPeriod;
  var avgLoss = losses / rsiPeriod;
  var rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  var rsi = 100 - (100 / (1 + rs));
  if (rsi < 30 || rsi > 75) return null;

  // ═══ ĐIỀU KIỆN 3: Nến xanh (close > open) ═══
  // Xác nhận lực mua trong phiên crossover
  if (todayClose <= todayOpen) return null;

  // ═══ ĐIỀU KIỆN 4: Thanh khoản tối thiểu ═══
  // Chỉ cần avg volume >= 200K (đủ thanh khoản cho T+)
  // KHÔNG yêu cầu volume hôm nay > avg (T+ không cần volume đột biến)
  var volumes = data.map(d => d.volume);
  var last20Volumes = volumes.slice(-20);
  var avgVolume20 = last20Volumes.reduce((s, v) => s + v, 0) / last20Volumes.length;

  if (avgVolume20 < MIN_AVG_VOLUME) return null;

  var todayVolume = data[data.length - 1].volume;
  var volumeRatio = avgVolume20 > 0 ? todayVolume / avgVolume20 : 0;

  var change = yesterdayClose > 0 ? ((todayClose - yesterdayClose) / yesterdayClose) * 100 : 0;

  return {
    symbol,
    price: todayClose,
    change,
    volume: todayVolume,
    avgVolume20,
    volumeRatio,
    macd: macd[macd.length - 1],
    macdLine: macd[macd.length - 1],
    signal: signal[signal.length - 1],
    histogram: currentHist,
    prevHistogram: prevHist,
    date: data[data.length - 1].date,
  };
}

export async function scanMACDCrossover(): Promise<MACDSignal[]> {
  console.log(`[MACD] 🔍 Starting MACD crossover scan for ${SCAN_STOCKS.length} stocks...`);
  var startTime = Date.now();

  var signals: MACDSignal[] = [];
  var processed = 0;
  var errors = 0;

  for (var i = 0; i < SCAN_STOCKS.length; i += BATCH_SIZE) {
    var batch = SCAN_STOCKS.slice(i, i + BATCH_SIZE);

    var results = await Promise.allSettled(
      batch.map(async (symbol) => {
        var data = await fetchPriceData(symbol);
        return analyzeStock(symbol, data);
      })
    );

    for (var result of results) {
      if (result.status === 'fulfilled' && result.value) {
        signals.push(result.value);
      } else if (result.status === 'rejected') {
        errors++;
      }
    }

    processed += batch.length;
    if (processed % 50 === 0) {
      console.log(`[MACD] ⏳ Processed ${processed}/${SCAN_STOCKS.length}, found ${signals.length} signals`);
    }

    // Delay giữa các batch để tránh rate limit
    if (i + BATCH_SIZE < SCAN_STOCKS.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }

  // Sắp xếp theo volumeRatio giảm dần (ưu tiên CP có volume đột biến)
  signals.sort((a, b) => b.volumeRatio - a.volumeRatio);

  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[MACD] ✅ Scan complete in ${elapsed}s: ${signals.length} crossover signals (${errors} errors)`);

  // Tich hop Strategy Tracker — ghi nhan khuyen nghi cho moi signal
  for (var sig of signals) {
    try {
      // Target dua tren MACD momentum: MACD line > 0 (uptrend) → target cao hon
      // MACD > 0: +10%, MACD <= 0 (hoi tu day): +7%
      var targetPct = sig.macdLine > 0 ? 1.10 : 1.07;
      // Stop loss: -4% (dam bao R:R >= 2.0)
      var stopPct = 0.96;

      await recordRecommendation({
        symbol: sig.symbol,
        entryPrice: Math.round(sig.price * 1000),
        targetPrice: Math.round(sig.price * 1000 * targetPct),
        stopLossPrice: Math.round(sig.price * 1000 * stopPct),
        reason: `MACD crossover: histogram ${sig.prevHistogram.toFixed(3)} → ${sig.histogram.toFixed(3)}, MACD line=${sig.macdLine.toFixed(3)}, vol x${sig.volumeRatio.toFixed(1)}`,
        method: 'macd_crossover',
        source: 'scanner',
        confidenceScore: 60,
      });
    } catch (e: any) {
      // Non-fatal — khong anh huong scanner
      console.warn(`[MACD] ⚠️ Strategy tracker ghi nhan ${sig.symbol} that bai: ${e.message}`);
    }
  }

  return signals;
}

// ═══════════════════════════════════════════════════
// FORMAT REPORT
// ═══════════════════════════════════════════════════

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(0)}K`;
  return vol.toString();
}

function formatPrice(price: number): string {
  if (price < 1000) return price.toFixed(2);
  return price.toLocaleString('vi-VN');
}

export function formatMACDReport(signals: MACDSignal[]): string {
  var vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  var dateStr = vnNow.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  var report = `📊 MACD CROSSOVER SCAN - T+ TRADING\n`;
  report += `📅 ${dateStr}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (signals.length === 0) {
    report += `ℹ️ Hôm nay không có CP nào có tín hiệu MACD crossover bullish.\n`;
    report += `\n💡 Thị trường có thể đang trong giai đoạn tích lũy hoặc điều chỉnh.`;
    return report;
  }

  // Chia thành 2 nhóm: MACD line > 0 (uptrend) và MACD line < 0 (hồi từ đáy)
  var aboveZero = signals.filter(s => s.macdLine > 0);
  var belowZero = signals.filter(s => s.macdLine <= 0);

  var formatLine = (s: MACDSignal, idx: number) => {
    var changeStr = s.change >= 0 ? `+${s.change.toFixed(1)}%` : `${s.change.toFixed(1)}%`;
    return `${idx}. ${s.symbol} - ${formatPrice(s.price)} (${changeStr}) | KL: ${formatVolume(s.volume)} (x${s.volumeRatio.toFixed(1)})\n`;
  };

  // Nhóm 1: MACD > 0 - Uptrend, an toàn hơn
  if (aboveZero.length > 0) {
    report += `🟢 MACD CẮT LÊN + TRÊN 0 (Uptrend mạnh):\n\n`;
    for (var i = 0; i < aboveZero.length; i++) {
      report += formatLine(aboveZero[i], i + 1);
    }
    report += `\n`;
  }

  // Nhóm 2: MACD < 0 - Hồi từ đáy, biên lợi nhuận lớn hơn
  if (belowZero.length > 0) {
    report += `🟡 MACD CẮT LÊN + DƯỚI 0 (Hồi từ đáy, T+ ngắn):\n\n`;
    for (var j = 0; j < belowZero.length; j++) {
      report += formatLine(belowZero[j], j + 1);
    }
    report += `\n`;
  }

  report += `📋 Tổng: ${signals.length} CP (${aboveZero.length} trên 0, ${belowZero.length} dưới 0)\n`;
  report += `\n💡 MACD > 0: xu hướng tăng rõ, an toàn hơn. MACD < 0: hồi kỹ thuật, lướt nhanh.`;

  return report;
}
