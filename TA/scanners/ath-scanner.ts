/**
 * ATH Scanner - Logic quét CP ở vùng ATH (All-Time High)
 * 
 * Được dùng bởi:
 * 1. athStocks tool (chat tool - user gọi trực tiếp)
 * 2. ath-report service (scheduler - tự động gửi báo cáo)
 */

export interface StockData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ATHStock {
  symbol: string;
  currentPrice: number;
  currentHigh: number;
  athPrice: number;
  athDate: string;
  newATH: boolean;
  distancePercent: number;
  volume: number;
  avgVolume20d: number;
  volumeRatio: number;
  breakDays: number;
}

interface TradingStatItem {
  symbol: string;
  exchange: string;
  lastPriceClose: number;
  avgVolume20d: number;
}

// ═══════════════════════════════════════════════════
// FETCH DATA
// ═══════════════════════════════════════════════════

// Cache cookie để không phải fetch lại mỗi lần
let cachedCookie = '';
let cookieFetchTime = 0;
const COOKIE_TTL = 30 * 60 * 1000; // 30 phút

async function getFireantCookie(): Promise<string> {
  if (cachedCookie && Date.now() - cookieFetchTime < COOKIE_TTL) {
    return cachedCookie;
  }

  const cookieSheetUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQSIlfpp-orc4QSu-TOusAwsBc--AEIFLLQd9uELBuxg_c50a-2VjHEmRoOnP66VJRa-3W6O-t1JeTN/pub?output=csv&gid=0';
  
  try {
    const cookieResp = await fetch(cookieSheetUrl);
    const cookieCsv = await cookieResp.text();
    const lines = cookieCsv.split('\n');
    if (lines.length > 1) {
      const values = lines[1].split(',');
      cachedCookie = values[1]?.replace(/"/g, '').trim() || '';
      cookieFetchTime = Date.now();
      console.log(`[ATH] 🍪 Cookie fetched: ${cachedCookie.substring(0, 30)}...`);
    }
  } catch (error) {
    console.warn(`[ATH] ⚠️ Could not fetch cookie`);
  }

  return cachedCookie;
}

function getFireantHeaders(cookie: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

async function fetchAllStockSymbols(): Promise<TradingStatItem[]> {
  console.log(`[ATH] 📊 Fetching all stock symbols from TradingStatistic...`);

  const cookie = await getFireantCookie();
  const url = 'https://www.fireant.vn/api/Data/Markets/TradingStatistic';
  const headers = getFireantHeaders(cookie);

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`TradingStatistic API error: ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error(`TradingStatistic returned HTML instead of JSON. Cookie may be invalid.`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid TradingStatistic response');

  const stocks: TradingStatItem[] = [];
  for (const item of data) {
    if (!item.Symbol || item.Symbol.length !== 3) continue;
    // Chấp nhận cả HOSE (HOSTC) và HNX (HNX)
    if (item.Exchange !== 'HOSTC' && item.Exchange !== 'HNX') continue;
    const avgVol = item.AvgVolume20d || 0;
    if (avgVol < 100000) continue;
    const price = item.LastPriceClose || 0;
    if (price < 5) continue;

    stocks.push({
      symbol: item.Symbol,
      exchange: item.Exchange,
      lastPriceClose: price,
      avgVolume20d: avgVol,
    });
  }

  console.log(`[ATH] ✅ Found ${stocks.length} stocks (HOSE+HNX) with sufficient liquidity`);
  return stocks;
}

async function fetchHistoricalData(symbol: string): Promise<StockData[]> {
  const cookie = await getFireantCookie();
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 10);

  const fmt = (d: Date) => d.toISOString().split('T')[0];
  const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}`;

  const response = await fetch(url, {
    headers: getFireantHeaders(cookie),
  });

  if (!response.ok) return [];

  // Kiểm tra response có phải JSON không
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    console.warn(`[ATH] ⚠️ ${symbol}: API returned HTML, skipping`);
    return [];
  }

  const rawData = await response.json();
  if (!rawData || rawData.length === 0) return [];

  const data: StockData[] = rawData.map((item: any) => ({
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
// ATH DETECTION
// ═══════════════════════════════════════════════════

function analyzeATH(symbol: string, data: StockData[], avgVolume20d: number): ATHStock | null {
  if (data.length < 60) return null;

  const latestData = data[data.length - 1];
  if (!latestData || latestData.close <= 0) return null;

  // Tìm ATH trên TOÀN BỘ lịch sử (trừ phiên cuối cùng)
  let athPrice = 0;
  let athDate = '';
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i].high > athPrice) {
      athPrice = data[i].high;
      athDate = data[i].date;
    }
  }

  if (athPrice <= 0) return null;

  // Kiểm tra 5 phiên gần nhất có break ATH không
  const recentDays = Math.min(5, data.length);
  let newATH = false;
  let breakDays = -1;
  
  for (let i = data.length - 1; i >= data.length - recentDays; i--) {
    if (data[i].high >= athPrice) {
      newATH = true;
      breakDays = data.length - 1 - i;
      break;
    }
  }

  // Khoảng cách giá hiện tại so với ATH cũ
  const distancePercent = ((latestData.close - athPrice) / athPrice) * 100;
  
  // Chỉ lấy CP gần ATH (trong phạm vi -5%) hoặc đã break ATH
  if (!newATH && distancePercent < -5) return null;

  const volumeRatio = avgVolume20d > 0 ? latestData.volume / avgVolume20d : 0;

  return {
    symbol,
    currentPrice: latestData.close,
    currentHigh: latestData.high,
    athPrice,
    athDate,
    newATH,
    distancePercent,
    volume: latestData.volume,
    avgVolume20d,
    volumeRatio,
    breakDays: newATH ? breakDays : -1,
  };
}

// ═══════════════════════════════════════════════════
// SCAN
// ═══════════════════════════════════════════════════

export async function scanATHStocks(maxConcurrent: number = 10): Promise<ATHStock[]> {
  const allSymbols = await fetchAllStockSymbols();
  console.log(`[ATH] 🔍 Scanning ${allSymbols.length} stocks for ATH...`);

  const athStocks: ATHStock[] = [];
  let processed = 0;

  for (let i = 0; i < allSymbols.length; i += maxConcurrent) {
    const batch = allSymbols.slice(i, i + maxConcurrent);
    
    const results = await Promise.allSettled(
      batch.map(async (stock) => {
        const data = await fetchHistoricalData(stock.symbol);
        return analyzeATH(stock.symbol, data, stock.avgVolume20d);
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        athStocks.push(result.value);
      }
    }

    processed += batch.length;
    if (processed % 50 === 0) {
      console.log(`[ATH] ⏳ Processed ${processed}/${allSymbols.length}, found ${athStocks.length} near ATH`);
    }

    if (i + maxConcurrent < allSymbols.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  console.log(`[ATH] ✅ Scan complete: ${athStocks.length} stocks near/at ATH`);
  return athStocks;
}

// ═══════════════════════════════════════════════════
// FORMAT REPORT
// ═══════════════════════════════════════════════════

function formatPrice(price: number): string {
  // FireAnt trả giá đã chia 1000 (VD: 25.5 = 25,500 VNĐ)
  if (price < 1000) {
    // Giá đã chia 1000 → hiển thị dạng xx.xx
    return price.toFixed(2);
  }
  // Giá nguyên (chưa chia) → format bình thường
  return price.toLocaleString('vi-VN');
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(0)}K`;
  return vol.toString();
}

export function formatATHReport(athStocks: ATHStock[]): string {
  const newBreaks = athStocks
    .filter(s => s.newATH)
    .sort((a, b) => a.breakDays - b.breakDays || b.distancePercent - a.distancePercent);

  const nearATH = athStocks
    .filter(s => !s.newATH && s.distancePercent >= -5)
    .sort((a, b) => b.distancePercent - a.distancePercent);

  let report = `🏔️ BÁO CÁO CP ĐỈNH MỌI THỜI ĐẠI (ATH)\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `📊 Tổng quét: ${athStocks.length} CP gần/tại ATH\n`;
  report += `🔥 Mới break ATH: ${newBreaks.length} mã\n`;
  report += `⏳ Gần ATH (<5%): ${nearATH.length} mã\n\n`;

  // SECTION 1: CP MỚI BREAK ATH
  if (newBreaks.length > 0) {
    report += `🔥🔥🔥 CP MỚI VƯỢT ĐỈNH MỌI THỜI ĐẠI 🔥🔥🔥\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    const breakToday = newBreaks.filter(s => s.breakDays === 0);
    const breakRecent = newBreaks.filter(s => s.breakDays > 0);

    if (breakToday.length > 0) {
      report += `\n⚡ BREAK HÔM NAY (${breakToday.length} mã):\n`;
      for (const s of breakToday) {
        const volSignal = s.volumeRatio >= 2 ? '🔊' : s.volumeRatio >= 1.5 ? '📢' : '';
        report += `  🚀 ${s.symbol}: ${formatPrice(s.currentPrice)} (+${s.distancePercent.toFixed(1)}% vs đỉnh cũ ${formatPrice(s.athPrice)})`;
        report += ` | Vol: ${formatVolume(s.volume)} ${volSignal}`;
        report += ` | Đỉnh cũ: ${s.athDate}\n`;
      }
    }

    if (breakRecent.length > 0) {
      report += `\n📈 BREAK TRONG 5 PHIÊN GẦN NHẤT (${breakRecent.length} mã):\n`;
      for (const s of breakRecent) {
        const volSignal = s.volumeRatio >= 2 ? '🔊' : s.volumeRatio >= 1.5 ? '📢' : '';
        report += `  ✅ ${s.symbol}: ${formatPrice(s.currentPrice)} (+${s.distancePercent.toFixed(1)}% vs đỉnh cũ ${formatPrice(s.athPrice)})`;
        report += ` | Break cách đây ${s.breakDays} phiên`;
        report += ` | Vol: ${formatVolume(s.volume)} ${volSignal}\n`;
      }
    }

    report += `\n📋 Danh sách mã break ATH: ${newBreaks.map(s => s.symbol).join(', ')}\n`;
  } else {
    report += `ℹ️ Hiện tại chưa có CP nào mới break ATH trong 5 phiên gần nhất.\n`;
  }

  // SECTION 2: CP GẦN ATH
  if (nearATH.length > 0) {
    report += `\n\n⏳ CP GẦN ĐỈNH MỌI THỜI ĐẠI (chưa break)\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    for (const s of nearATH.slice(0, 15)) {
      const bar = s.distancePercent >= -1 ? '🟢' : s.distancePercent >= -3 ? '🟡' : '🟠';
      report += `  ${bar} ${s.symbol}: ${formatPrice(s.currentPrice)} (${s.distancePercent.toFixed(1)}% vs ATH ${formatPrice(s.athPrice)})`;
      report += ` | ATH ngày: ${s.athDate}\n`;
    }

    if (nearATH.length > 15) {
      report += `  ... và ${nearATH.length - 15} mã khác\n`;
    }
  }

  // SECTION 3: BẢNG TỔNG HỢP
  report += `\n\n📊 BẢNG KHOẢNG CÁCH GIÁ VS ATH CŨ\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `Mã    | Giá HT    | ATH cũ    | KC (%)  | Trạng thái\n`;
  report += `------|-----------|-----------|---------|----------\n`;

  const allSorted = [...athStocks].sort((a, b) => b.distancePercent - a.distancePercent);
  for (const s of allSorted.slice(0, 30)) {
    const status = s.newATH ? '🔥 NEW ATH' : `⏳ Gần ATH`;
    const dist = s.distancePercent >= 0 ? `+${s.distancePercent.toFixed(1)}%` : `${s.distancePercent.toFixed(1)}%`;
    report += `${s.symbol.padEnd(6)}| ${formatPrice(s.currentPrice).padEnd(10)}| ${formatPrice(s.athPrice).padEnd(10)}| ${dist.padEnd(8)}| ${status}\n`;
  }

  report += `\n💡 Ghi chú:\n`;
  report += `  🔥 NEW ATH = Mới vượt đỉnh mọi thời đại (trong 5 phiên gần nhất)\n`;
  report += `  🔊 = Volume gấp 2x trung bình 20 phiên\n`;
  report += `  📢 = Volume gấp 1.5x trung bình\n`;
  report += `  KC (%) = Khoảng cách giá hiện tại so với đỉnh cũ ATH\n`;
  report += `\n⚠️ CP break ATH với volume lớn là tín hiệu tích cực. Cần kết hợp phân tích kỹ thuật và cơ bản trước khi quyết định.`;

  return report;
}
