/**
 * Tool: analyzeStock - Phân tích cổ phiếu từ FireAnt API
 * Phân tích kỹ thuật VSA, chỉ số tài chính, xác định điểm mua/bán
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../../shared/types/tools.types.js';
import { fetchMacroNews24h, analyzeMacroNewsWithDeepSeek, type MacroNewsItem } from './marketAnalysis.js';
import { getBreakoutStocksTool } from './googleSheet.js';
import { analyzeChartVision, formatChartAnalysisResult, type OHLCV } from './chartVision.js';
import { compareWithIndustry, formatIndustryComparisonSection, type IndustryComparison } from './industryData.js';
import { detectAllPatterns, formatPatternAnalysis, analyzeStage, type PatternAnalysisResult } from './chartPatterns.js';
import { fetchInvestmentThesisForStock, type AnalysisContext } from './investmentThesis.js';
import { updateAskCount } from '../../alerts/services/watchlist.service.js';
import { getCompanyInfo } from './companyInfo.js';
import { getStockPressure, getMarketPressure } from '../../supply-demand/supply-demand.service.js';

interface StockData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface FinancialData {
  year: number;
  quarter: number;
  eps: number;
  roe: number;
  roa: number;
  profitMargin: number;
  salesGrowth: number;
  profitGrowth: number;
  debtToEquity: number;
  pe: number; // P/E ratio
  pb: number; // P/B ratio
}

interface TimelineMark {
  date: string;
  title: string;
  type: string; // F = Financial, D = Dividend, S = Stock dividend
}

// RS (Relative Strength) - So sánh sức mạnh CP với thị trường
interface RSData {
  date: string;
  value: number; // Giá trị RS (0-100)
}

// Smart Money Flow - Dòng tiền 4 nhóm NDT (Multi-timeframe)
interface FlowSums {
  foreign: number;      // Khối ngoại
  individual: number;   // Cá nhân
  proprietary: number;  // Tự doanh
  institution: number;  // TCTN
}

interface SmartMoneyFlow {
  symbol: string;
  daily?: { sums: FlowSums; total: number };
  weekly?: { sums: FlowSums; total: number };
  monthly?: { sums: FlowSums; total: number };
  // Legacy single frequency format
  sums?: FlowSums;
}

export const analyzeStockTool: ToolDefinition = {
  name: 'analyzeStock',
  description: `Phân tích cổ phiếu Việt Nam toàn diện - kỹ thuật và cơ bản.
⛔ QUAN TRỌNG: KHÔNG gọi tool này ngay khi user nhắc mã CP!
→ Hãy TRẢ LỜI câu hỏi bằng kiến thức trước, rồi HỎI user có muốn phân tích chi tiết không.
→ CHỈ gọi tool này KHI user ĐÃ XÁC NHẬN muốn phân tích (ừ, ok, đi, phân tích đi...)
→ HOẶC khi user yêu cầu RÕ RÀNG: "phân tích chi tiết X", "report X", "target X", "báo cáo X"
📊 Phân tích: VSA, RSI, MACD, MA, Bollinger Bands, Perfect Buy Signal, RS, Smart Money Flow
💰 Tài chính: EPS, ROE, ROA, P/E, P/B, tăng trưởng doanh thu/lợi nhuận, định giá ngành
🎯 Target: Vùng hỗ trợ, kháng cự, mục tiêu giá, điểm mua/bán`,
  parameters: [
    {
      name: 'symbol',
      type: 'string',
      description: 'Mã cổ phiếu (VD: STB, VNM, FPT, HPG, MBB, TCB...)',
      required: true,
    },
  ],
  execute: async (params: Record<string, any>, _context: ToolContext): Promise<ToolResult> => {
    const symbol = (params.symbol as string).toUpperCase().trim();
    const userId = _context.userId;
    
    // Track user stock interest for watchlist auto-add
    if (userId) {
      updateAskCount(userId, symbol).catch((e) => console.log('[Stock] Track error:', e));
    }
    
    try {
      // Fetch song song cả 7 API. Dung Promise.allSettled de 1 nguon fail khong lam fail toan bo.
      // (Da bo Smart Money Flow — Apps Script da chet)
      const settled = await Promise.allSettled([
        fetchPriceData(symbol),
        fetchFinancialData(symbol),
        fetchTimelineData(symbol),
        fetchRSData(symbol),
        fetchNewsWithContent(symbol),
        fetchLongTermPriceData(symbol),
        fetchRealtimePrice(symbol),
      ]);
      
      const getResult = <T>(idx: number, fallback: T): T => {
        const r = settled[idx];
        return r.status === 'fulfilled' ? (r.value as T) : fallback;
      };
      
      const priceData = getResult<StockData[]>(0, []);
      const financialData = getResult<FinancialData[]>(1, []);
      const timelineData = getResult<TimelineMark[]>(2, []);
      const rsData = getResult<RSData[]>(3, []);
      const companyNews = getResult<any[]>(4, []);
      const longTermData = getResult<StockData[]>(5, []);
      const realtimePrice = getResult<number | null>(6, null);
      
      // Log neu co fetch fail
      settled.forEach((r, i) => {
        if (r.status === 'rejected') {
          const names = ['priceData', 'financialData', 'timelineData', 'rsData', 'companyNews', 'longTermData', 'realtimePrice'];
          console.warn(`[Stock] ⚠️ ${symbol} ${names[i]} fetch failed: ${r.reason?.message || r.reason}`);
        }
      });

      if (!priceData || priceData.length < 20) {
        return {
          success: false,
          data: `Không đủ dữ liệu giá để phân tích ${symbol}. Vui lòng kiểm tra lại mã cổ phiếu.`,
        };
      }

      // Nếu có giá realtime và khác giá đóng cửa cuối cùng → cập nhật/thêm vào priceData
      const eodPrice = priceData[priceData.length - 1]?.close || 0;
      if (realtimePrice && realtimePrice > 0) {
        const lastRecord = priceData[priceData.length - 1];
        const today = new Date().toISOString().split('T')[0];
        const priceDiff = Math.abs(realtimePrice - eodPrice) / Math.max(eodPrice, 1) * 100;
        
        if (lastRecord.date === today) {
          // Cùng ngày → cập nhật giá close bằng giá realtime
          lastRecord.close = realtimePrice;
          lastRecord.high = Math.max(lastRecord.high, realtimePrice);
          lastRecord.low = Math.min(lastRecord.low, realtimePrice);
          console.log(`[Stock] 📡 ${symbol} | EOD=${eodPrice} → Realtime=${realtimePrice} (${priceDiff.toFixed(2)}% diff, same day update)`);
        } else {
          // Khác ngày (thị trường đang giao dịch nhưng HistoricalQuotes chưa cập nhật)
          priceData.push({
            date: today,
            open: realtimePrice,
            high: realtimePrice,
            low: realtimePrice,
            close: realtimePrice,
            volume: 0, // Volume realtime không chính xác, bỏ qua
          });
          console.log(`[Stock] 📡 ${symbol} | EOD ${lastRecord.date}=${eodPrice} → Realtime today=${realtimePrice} (${priceDiff.toFixed(2)}% diff, new bar appended)`);
        }
      } else {
        console.log(`[Stock] ⚠️ ${symbol} | No realtime price, using EOD=${eodPrice} from ${priceData[priceData.length - 1]?.date}`);
      }

      // Phân tích kỹ thuật (thêm RS data + long-term data cho trendline)
      const technicalAnalysis = analyzeTechnical(priceData, rsData, longTermData);
      
      // Phân tích tài chính
      const fundamentalAnalysis = analyzeFinancial(financialData, timelineData);
      
      // Tổng hợp đánh giá
      const overallScore = calculateOverallScore(technicalAnalysis, fundamentalAnalysis);

      // So sánh với ngành (Industry Comparison)
      let industryComparison = null;
      if (symbol !== 'VNINDEX' && fundamentalAnalysis.pe > 0) {
        const currentPrice = technicalAnalysis.currentPrice;
        const eps = fundamentalAnalysis.latestEPS;
        // Tính bookValuePerShare từ P/B và giá
        const bookValuePerShare = fundamentalAnalysis.pb > 0 ? currentPrice / fundamentalAnalysis.pb : 0;
        
        industryComparison = await compareWithIndustry(
          symbol,
          fundamentalAnalysis.pe,
          fundamentalAnalysis.pb,
          fundamentalAnalysis.roe,
          currentPrice,
          eps,
          bookValuePerShare
        );
      }

      // Phân tích mô hình chart (O'Neil, Minervini, Kacher) - TRƯỚC khi tạo báo cáo
      let patternAnalysis: PatternAnalysisResult | null = null;
      let patternSection = '';
      if (symbol !== 'VNINDEX') {
        try {
          // Convert StockData to OHLCV format
          const ohlcvData: OHLCV[] = priceData.map(d => ({
            date: d.date,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.volume,
          }));
          
          patternAnalysis = detectAllPatterns(ohlcvData);
          patternSection = formatPatternAnalysis(patternAnalysis);
        } catch (e) {
          console.log(`[Stock] ⚠️ Pattern analysis error:`, e);
        }
      }

      // Stage Analysis cho VNINDEX (xac dinh thi truong dang o giai doan nao)
      var vnindexStage = null;
      if (symbol === 'VNINDEX' && priceData.length >= 200) {
        try {
          var ohlcvForStage = priceData.map(function(d) {
            return { date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume };
          });
          vnindexStage = analyzeStage(ohlcvForStage as any);
        } catch (_e) {}
      }

      // Tạo báo cáo (truyền thêm industryComparison và patternAnalysis)
      const report = generateReport(symbol, priceData, technicalAnalysis, fundamentalAnalysis, timelineData, overallScore, undefined, undefined, undefined, industryComparison, patternAnalysis, vnindexStage);
      
      // (Da bo Smart Money Flow section — Apps Script da chet, tra rong)
      
      // Tạo section tin tức doanh nghiệp
      let newsSection = '';
      if (companyNews && companyNews.length > 0) {
        newsSection = `\n\n📰 **TIN TỨC DOANH NGHIỆP:**\n`;
        const newsToShow = companyNews.slice(0, 3); // Chỉ lấy 3 tin mới nhất
        
        for (const news of newsToShow) {
          if (news.title) {
            // Hiển thị tiêu đề và tóm tắt ngắn gọn
            const summaryShort = news.summary 
              ? news.summary.substring(0, 100) + (news.summary.length > 100 ? '...' : '')
              : '';
            newsSection += `• ${news.title}${summaryShort ? ` → ${summaryShort}` : ''}\n`;
          }
        }
        
        // Đánh giá xu hướng tin tức
        const summaries = companyNews.map(n => (n.summary || '').toLowerCase()).join(' ');
        const positiveWords = ['tích cực', 'tăng trưởng', 'lợi nhuận tăng', 'triển vọng', 'kỳ vọng', 'mở rộng', 'phát triển', 'thành công', 'đột phá', 'kỷ lục'];
        const negativeWords = ['giảm', 'lỗ', 'khó khăn', 'rủi ro', 'sụt giảm', 'cho thuê', 'nợ xấu', 'thiệt hại', 'cảnh báo', 'dừng'];
        
        const posCount = positiveWords.filter(w => summaries.includes(w)).length;
        const negCount = negativeWords.filter(w => summaries.includes(w)).length;
        
        if (posCount > negCount + 1) {
          newsSection += `→ Xu hướng tin: **Tích cực** 🟢\n`;
        } else if (negCount > posCount + 1) {
          newsSection += `→ Xu hướng tin: **Tiêu cực** 🔴\n`;
        } else {
          newsSection += `→ Xu hướng tin: Trung tính\n`;
        }
      }
      
      // Tạo section so sánh ngành
      const industrySection = formatIndustryComparisonSection(industryComparison);
      
      return {
        success: true,
        data: report.text + patternSection + industrySection,
      };
      
    } catch (error: any) {
      return {
        success: false,
        data: `Lỗi khi phân tích ${symbol}: ${error.message}`,
      };
    }
  },
};

// ═══════════════════════════════════════════════════
// FETCH DATA FUNCTIONS
// ═══════════════════════════════════════════════════

export async function fetchPriceData(symbol: string): Promise<StockData[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 14); // 14 tháng để có đủ dữ liệu cho MA200
  
  const formatDate = (d: Date) => d.toISOString().split('T')[0];
  const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${formatDate(startDate)}&endDate=${formatDate(endDate)}`;
  
  console.log(`[Stock] 🔍 Fetching price data: ${url}`);
  
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  
  if (!response.ok) {
    console.log(`[Stock] ❌ Price API failed: ${response.status}`);
    return [];
  }
  
  const rawData = await response.json();
  console.log(`[Stock] 📊 Got ${rawData?.length || 0} price records`);
  
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
  console.log(`[Stock] ✅ Parsed ${data.length} valid records`);
  return data;
}

/**
 * Fetch gia realtime tu FireAnt Quotes API (intraday)
 * Tra ve gia hien tai hoac null neu khong lay duoc
 */
async function fetchRealtimePrice(symbol: string): Promise<number | null> {
  const upperSymbol = symbol.toUpperCase();
  
  // VNINDEX/HNX/UPCOM: FireAnt Quotes khong support → dung CafeF API
  if (['VNINDEX', 'HNX', 'HNXINDEX', 'UPCOM', 'UPCOMINDEX', 'VN30'].includes(upperSymbol)) {
    return await fetchIndexPriceFromCafeF(upperSymbol);
  }
  
  try {
    const url = `https://www.fireant.vn/api/Data/Markets/Quotes?symbols=${upperSymbol}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!response.ok) {
      // Fallback: thử SSI API cho CP
      return await fetchPriceFromSSI(upperSymbol);
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return await fetchPriceFromSSI(upperSymbol);
    }
    const quote = data[0];
    const price = quote.PriceCurrent || quote.PriceClose || null;
    if (price && price > 0) {
      console.log(`[Stock] 📡 Realtime ${upperSymbol}: ${price}`);
      return price;
    }
    // Fallback SSI
    return await fetchPriceFromSSI(upperSymbol);
  } catch (e) {
    console.warn(`[Stock] ⚠️ Realtime price fetch failed for ${upperSymbol}, trying SSI...`);
    return await fetchPriceFromSSI(upperSymbol);
  }
}

/**
 * Fetch gia VNINDEX/HNX/UPCOM realtime
 * Strategy: dùng FireAnt HistoricalQuotes lấy data ngày hôm nay (intraday cập nhật)
 */
async function fetchIndexPriceFromCafeF(indexSymbol: string): Promise<number | null> {
  try {
    // Map symbol → FireAnt format
    const fireAntMap: Record<string, string> = {
      'VNINDEX': 'VNINDEX',
      'VN30': 'VN30',
      'HNX': 'HNXINDEX',
      'HNXINDEX': 'HNXINDEX',
      'UPCOM': 'UPCOMINDEX',
      'UPCOMINDEX': 'UPCOMINDEX',
    };
    const symbol = fireAntMap[indexSymbol] || indexSymbol;
    
    // Lấy data 3 ngày gần nhất → record cuối cùng = realtime intraday
    const today = new Date().toISOString().split('T')[0];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 3);
    const startDateStr = startDate.toISOString().split('T')[0];
    
    const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${startDateStr}&endDate=${today}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    
    // Sort by date desc, lấy record có ngày = today nếu có
    data.sort((a: any, b: any) => new Date(b.Date).getTime() - new Date(a.Date).getTime());
    const todayRecord = data.find((r: any) => r.Date?.split('T')[0] === today);
    const latest = todayRecord || data[0];
    
    const price = latest?.Close || latest?.PriceClose || null;
    if (price && price > 0) {
      const isToday = latest?.Date?.split('T')[0] === today;
      console.log(`[Stock] 📡 FireAnt HQ ${indexSymbol}: ${price} (${isToday ? 'today realtime' : 'last trading day'})`);
      return price;
    }
    return null;
  } catch (e: any) {
    console.warn(`[Stock] ⚠️ Index fetch fail for ${indexSymbol}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch gia CP tu SSI iBoard API (fallback khi FireAnt fail)
 */
async function fetchPriceFromSSI(symbol: string): Promise<number | null> {
  try {
    const url = `https://iboard-api.ssi.com.vn/statistics/charts/history?resolution=1D&symbol=${symbol}&from=${Math.floor(Date.now() / 1000) - 86400 * 5}&to=${Math.floor(Date.now() / 1000)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const closes = data?.data?.c || data?.c;
    if (Array.isArray(closes) && closes.length > 0) {
      const last = closes[closes.length - 1];
      // SSI tra gia x1000 cho CP, neu so qua nho thi nhan 1000
      const price = last < 1000 ? last * 1000 : last;
      if (price > 0) {
        console.log(`[Stock] 📡 SSI realtime ${symbol}: ${price}`);
        return price;
      }
    }
    return null;
  } catch (e: any) {
    console.warn(`[Stock] ⚠️ SSI fetch fail for ${symbol}: ${e.message}`);
    return null;
  }
}

export async function fetchFinancialData(symbol: string): Promise<FinancialData[]> {
  const currentYear = new Date().getFullYear();
  const quarterlyUrl = `https://www.fireant.vn/api/Data/Finance/QuarterlyFinancialInfo?symbol=${symbol}&fromYear=${currentYear - 2}&fromQuarter=1&toYear=${currentYear + 1}&toQuarter=4`;
  const latestUrl = `https://www.fireant.vn/api/Data/Finance/LastestFinancialInfo?symbol=${symbol}`;
  
  try {
    // Fetch cả 2 API song song
    const [quarterlyRes, latestRes] = await Promise.all([
      fetch(quarterlyUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }),
      fetch(latestUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }),
    ]);
    
    if (!quarterlyRes.ok) return [];
    
    const quarterlyData = await quarterlyRes.json();
    const items = quarterlyData.value || quarterlyData || [];
    
    // Lấy P/E, P/B từ LastestFinancialInfo (chính xác hơn)
    let latestPE = 0;
    let latestPB = 0;
    if (latestRes.ok) {
      const latestData = await latestRes.json();
      latestPE = latestData.PE || latestData.BasicPE || 0;
      latestPB = latestData.PB || 0;
      console.log(`[Stock] 📊 Got P/E=${latestPE.toFixed(1)}, P/B=${latestPB.toFixed(2)} from LastestFinancialInfo`);
    }
    
    return items.map((item: any, index: number) => ({
      year: item.Year,
      quarter: item.Quarter,
      eps: item.BasicEPS_TTM || 0,
      roe: (item.ROE_TTM || 0) * 100,
      roa: (item.ROA_TTM || 0) * 100,
      profitMargin: (item.NetProfitMargin_TTM || 0) * 100,
      salesGrowth: (item.SalesGrowth_TTM || 0) * 100,
      profitGrowth: (item.ProfitGrowth_TTM || 0) * 100,
      debtToEquity: item.TotalDebtToEquity_MRQ || 0,
      // Dùng P/E, P/B từ LastestFinancialInfo cho item cuối cùng (mới nhất)
      pe: index === items.length - 1 ? latestPE : (item.PE_TTM || 0),
      pb: index === items.length - 1 ? latestPB : (item.PB_MRQ || 0),
    }));
  } catch {
    return [];
  }
}

export async function fetchTimelineData(symbol: string): Promise<TimelineMark[]> {
  const url = `https://www.fireant.vn/api/Data/Companies/TimescaleMarks?symbol=${symbol}&startDate=2023-1-1&endDate=2030-1-1`;
  
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
    const items = data.value || data || [];
    
    return items.map((item: any) => ({
      date: item.Date?.split('T')[0] || '',
      title: item.Title || '',
      type: item.Label || '',
    })).filter((m: TimelineMark) => m.type === 'F'); // Chỉ lấy báo cáo tài chính
  } catch {
    return [];
  }
}

/**
 * Fetch RS (Relative Strength) data - So sánh sức mạnh CP với thị trường
 * RS > 70: CP mạnh hơn thị trường
 * RS tăng nhanh: CP đang có momentum tốt
 */
export async function fetchRSData(symbol: string): Promise<RSData[]> {
  // Không fetch RS cho VNINDEX
  if (symbol === 'VNINDEX') return [];
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 3); // Lấy 3 tháng
  
  const formatDate = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const url = `https://www.fireant.vn/api/Data/Markets/CustomIndicatorHistoricalData?symbol=${symbol}%23RS&startDate=${formatDate(startDate)}&endDate=${formatDate(endDate)}`;
  
  try {
    console.log(`[Stock] 🔍 Fetching RS data: ${url}`);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      console.log(`[Stock] ❌ RS API failed: ${response.status}`);
      return [];
    }
    
    const rawData = await response.json();
    console.log(`[Stock] 📊 Got ${rawData?.length || 0} RS records`);
    
    if (!rawData || rawData.length === 0) return [];
    
    // RS value nằm trong field Open (hoặc Close) - API trả về dạng OHLC
    const data: RSData[] = rawData.map((item: any) => ({
      date: item.Date?.split('T')[0] || '',
      value: item.Open || item.Close || item.Value || item.value || 0,
    })).filter((d: RSData) => d.value > 0);
    
    data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    console.log(`[Stock] ✅ Parsed ${data.length} RS records, latest RS=${data[data.length - 1]?.value || 0}`);
    return data;
  } catch (error) {
    console.log(`[Stock] ❌ RS fetch error:`, error);
    return [];
  }
}

/**
 * Fetch Smart Money Flow data - Dòng tiền 4 nhóm NDT từng mã CP
 * Gọi qua Google Apps Script Web App
 */
async function fetchSmartMoneyFlow(symbol: string): Promise<SmartMoneyFlow | null> {
  // Skip for index
  if (symbol === 'VNINDEX' || symbol === 'VN30') return null;
  
  const WEBAPP_URL = process.env.GOOGLE_SHEET_WEBAPP_URL;
  if (!WEBAPP_URL) {
    console.log(`[Stock] ⚠️ GOOGLE_SHEET_WEBAPP_URL not configured`);
    return null;
  }
  
  try {
    const url = `${WEBAPP_URL}?action=stock-flow&symbol=${symbol}&frequency=Daily`;
    console.log(`[Stock] 🔍 Fetching Smart Money: ${url}`);
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'HieuSiMBS-Bot/1.0' },
    });
    
    if (!response.ok) {
      console.log(`[Stock] ❌ Smart Money API failed: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    if (data.error) {
      console.log(`[Stock] ⚠️ Smart Money error: ${data.error}`);
      return null;
    }
    
    // API returns data array - calculate sums from it
    // Format: { data: [{ foreign, individual, proprietary, institution, ... }] }
    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      // Calculate sums from data array (last 20 days)
      const sums: FlowSums = { foreign: 0, individual: 0, proprietary: 0, institution: 0 };
      const recentData = data.data.slice(0, 20);
      
      recentData.forEach((d: any) => {
        sums.foreign += d.foreign || 0;
        sums.individual += d.individual || 0;
        sums.proprietary += d.proprietary || 0;
        sums.institution += d.institution || d.institutional || 0;
      });
      
      console.log(`[Stock] ✅ Got Smart Money (20d): Foreign=${sums.foreign.toFixed(1)}, Prop=${sums.proprietary.toFixed(1)}, Inst=${sums.institution.toFixed(1)}, Indiv=${sums.individual.toFixed(1)}`);
      
      return {
        symbol,
        sums,
        daily: { sums, total: recentData.length },
      } as SmartMoneyFlow;
    }
    
    // Legacy format with sums directly
    if (data.sums) {
      console.log(`[Stock] ✅ Got Smart Money (legacy): Foreign=${data.sums.foreign}, Prop=${data.sums.proprietary}`);
      return data as SmartMoneyFlow;
    }
    
    console.log(`[Stock] ⚠️ Smart Money: No valid data format`);
    return null;
    
  } catch (error) {
    console.log(`[Stock] ❌ Smart Money fetch error:`, error);
    return null;
  }
}

// ═══════════════════════════════════════════════════
// HOT STOCKS - Lấy CP tiềm năng từ AI Dashboard
// ═══════════════════════════════════════════════════

interface HotStock {
  symbol: string;
  volume: number;
  volumeBreakoutPercent: number;
}

async function fetchHotStocks(): Promise<HotStock[]> {
  const WEBAPP_URL = process.env.GOOGLE_SHEET_WEBAPP_URL;
  if (!WEBAPP_URL) {
    console.log(`[Stock] ⚠️ GOOGLE_SHEET_WEBAPP_URL not configured`);
    return [];
  }
  
  try {
    const url = `${WEBAPP_URL}?action=ai-dashboard`;
    console.log(`[Stock] 🔍 Fetching hot stocks from AI Dashboard`);
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'HieuSiMBS-Bot/1.0' },
    });
    
    if (!response.ok) {
      console.log(`[Stock] ❌ AI Dashboard API failed: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    if (data.error) {
      console.log(`[Stock] ⚠️ AI Dashboard error: ${data.error}`);
      return [];
    }
    
    // Extract hot stocks from dashboard
    if (data.hotStocks && Array.isArray(data.hotStocks)) {
      console.log(`[Stock] ✅ Got ${data.hotStocks.length} hot stocks`);
      return data.hotStocks.filter((s: HotStock) => s.symbol && s.volumeBreakoutPercent > 50);
    }
    
    console.log(`[Stock] ⚠️ No hot stocks data`);
    return [];
    
  } catch (error) {
    console.log(`[Stock] ❌ Hot stocks fetch error:`, error);
    return [];
  }
}

// ═══════════════════════════════════════════════════
// COMPANY NEWS - Tin tức doanh nghiệp từ CafeF
// ═══════════════════════════════════════════════════

interface CompanyNewsItem {
  title: string;
  date: string;
  summary: string;
  category: string;
  link?: string;
}

/**
 * Fetch tin tức cổ phiếu từ CafeF API
 * API: https://cafef.vn/du-lieu//Ajax/Events_RelatedNews_New.aspx
 * Trả về HTML cần parse
 */
async function fetchCompanyNews(symbol: string): Promise<CompanyNewsItem[]> {
  try {
    const url = `https://cafef.vn/du-lieu//Ajax/Events_RelatedNews_New.aspx?symbol=${symbol}&floorID=0&configID=0&PageIndex=1&PageSize=10&Type=2`;
    console.log(`[Stock] 📰 Fetching CafeF news for ${symbol}`);
    
    const response = await fetch(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://cafef.vn/'
      },
    });
    
    if (!response.ok) {
      console.log(`[Stock] ❌ CafeF API failed: ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    
    if (!html || html.length < 50) {
      console.log(`[Stock] ⚠️ Empty response from CafeF`);
      return [];
    }
    
    // Parse HTML để lấy tin tức
    // Format: <li>...<a class='docnhanh' href='URL'>TITLE</a>...<span>DATE</span>...</li>
    const newsItems: CompanyNewsItem[] = [];
    
    // Regex để match từng <li> item
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    
    while ((liMatch = liRegex.exec(html)) !== null) {
      const liContent = liMatch[1];
      
      // Lấy link và title
      const linkMatch = /<a[^>]*href=['"]([^'"]+)['"][^>]*class=['"]?docnhanh['"]?[^>]*>([^<]+)<\/a>/i.exec(liContent) 
        || /<a[^>]*class=['"]?docnhanh['"]?[^>]*href=['"]([^'"]+)['"][^>]*>([^<]+)<\/a>/i.exec(liContent);
      
      // Lấy ngày
      const dateMatch = /<span[^>]*>(\d{2}\/\d{2}\/\d{4})<\/span>/i.exec(liContent);
      
      if (linkMatch && linkMatch[2]) {
        const rawUrl = linkMatch[1];
        const title = linkMatch[2].trim();
        const date = dateMatch ? dateMatch[1] : '';
        
        // Skip nếu title quá ngắn
        if (title.length < 20) continue;
        
        // Tạo URL đầy đủ
        const fullUrl = rawUrl.startsWith('http') ? rawUrl : `https://cafef.vn${rawUrl}`;
        
        newsItems.push({
          title,
          date,
          summary: '',
          category: 'news',
          link: fullUrl,
        });
      }
    }
    
    console.log(`[Stock] ✅ Got ${newsItems.length} news from CafeF for ${symbol}`);
    return newsItems.slice(0, 10); // Lấy tối đa 10 tin
    
  } catch (error: any) {
    console.log(`[Stock] ❌ CafeF news fetch error:`, error.message);
    return [];
  }
}

/**
 * Fetch nội dung bài báo từ CafeF link
 * Trích xuất đoạn đầu của bài viết làm summary
 */
async function fetchArticleContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://cafef.vn/'
      },
    });
    
    if (!response.ok) return '';
    
    const html = await response.text();
    
    // Tìm thẻ <p> đầu tiên trong nội dung bài viết (class="sapo" hoặc trong div content)
    // Thường sapo là đoạn mở đầu tóm tắt
    const sapoMatch = /<p[^>]*class=['"]?sapo['"]?[^>]*>([^<]+)<\/p>/i.exec(html)
      || /<h2[^>]*class=['"]?sapo['"]?[^>]*>([^<]+)<\/h2>/i.exec(html);
    
    if (sapoMatch && sapoMatch[1]) {
      return sapoMatch[1].trim().substring(0, 300);
    }
    
    // Fallback: tìm meta description
    const metaMatch = /<meta[^>]*name=['"]?description['"]?[^>]*content=['"]([^'"]+)['"][^>]*>/i.exec(html)
      || /<meta[^>]*content=['"]([^'"]+)['"][^>]*name=['"]?description['"]?[^>]*>/i.exec(html);
    
    if (metaMatch && metaMatch[1]) {
      return metaMatch[1].trim().substring(0, 300);
    }
    
    // Fallback 2: lấy đoạn p đầu tiên trong div content
    const pMatch = /<div[^>]*class=['"]?[^'"]*content[^'"]*['"]?[^>]*>[\s\S]*?<p[^>]*>([^<]{50,})<\/p>/i.exec(html);
    if (pMatch && pMatch[1]) {
      return pMatch[1].trim().substring(0, 300);
    }
    
    return '';
  } catch {
    return '';
  }
}

/**
 * Fetch tin tức VÀ nội dung bài viết (top 3-5 bài)
 * Để có summary cho DeepSeek phân tích
 */
async function fetchNewsWithContent(symbol: string): Promise<CompanyNewsItem[]> {
  // Fetch song song: CafeF HTML + Google Sheet news (36+ nguon bao)
  const [cafefNews, sheetNews] = await Promise.allSettled([
    fetchCompanyNews(symbol),
    (async () => {
      try {
        const { searchNewsForSymbol } = await import('./googleSheet.js');
        return await searchNewsForSymbol(symbol, 7, 10);
      } catch {
        return [];
      }
    })(),
  ]);
  
  const cafefList = cafefNews.status === 'fulfilled' ? cafefNews.value : [];
  const sheetList = sheetNews.status === 'fulfilled' ? sheetNews.value : [];
  
  // Convert sheet news → CompanyNewsItem format
  const sheetAsCompany: CompanyNewsItem[] = sheetList.map(n => ({
    title: n.title,
    date: n.date,
    summary: n.summary || '',
    category: n.category || 'news',
    link: n.link,
  }));
  
  // Dedupe theo title (CafeF + Sheet co the trung)
  const seen = new Set<string>();
  const merged: CompanyNewsItem[] = [];
  for (const n of [...sheetAsCompany, ...cafefList]) {
    const key = (n.title || '').trim().toLowerCase().substring(0, 80);
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(n);
    }
  }
  
  if (merged.length === 0) return [];
  
  // Chỉ lấy 3 bài đầu để fetch nội dung CafeF (tránh chậm); sheet news đã có summary san
  const topNews = merged.slice(0, 5);
  
  console.log(`[Stock] 📖 News merged: CafeF=${cafefList.length} + Sheet=${sheetList.length} → ${merged.length} unique. Fetching content for top ${topNews.length}...`);
  
  // Fetch noi dung CafeF song song (chi nhung tin chua co summary)
  const contentPromises = topNews.map(async (item) => {
    if (item.summary && item.summary.length > 30) return item; // Sheet news da co summary
    if (item.link && item.link.includes('cafef')) {
      const content = await fetchArticleContent(item.link);
      return { ...item, summary: content };
    }
    return item;
  });
  
  const newsWithContent = await Promise.all(contentPromises);
  
  const withSummary = newsWithContent.filter(n => n.summary.length > 30);
  console.log(`[Stock] ✅ Got ${withSummary.length} articles with content`);
  
  // Trả về news with content + các tin còn lại chỉ có title
  return [...newsWithContent, ...merged.slice(5)];
}

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

/**
 * Phân tích tin tức doanh nghiệp và ngành bằng DeepSeek
 * @param symbol Mã cổ phiếu
 * @param news Danh sách tin tức
 * @param priceChange % thay đổi giá hôm nay
 * @returns Phân tích tác động
 */
async function analyzeCompanyNewsWithDeepSeek(
  symbol: string,
  news: CompanyNewsItem[],
  priceChange: number
): Promise<string> {
  if (!DEEPSEEK_API_KEY || news.length === 0) {
    return '';
  }
  
  // Tạo danh sách tin (title + summary)
  const newsList = news.map((n, i) => {
    const summary = n.summary ? ` - ${n.summary.substring(0, 150)}` : '';
    return `${i + 1}. ${n.title}${summary}`;
  }).join('\n');
  
  const direction = priceChange >= 0 ? 'tăng' : 'giảm';
  
  const prompt = `Bạn là chuyên gia phân tích cổ phiếu Việt Nam.

Mã: ${symbol}
Giá hôm nay ${direction} ${Math.abs(priceChange).toFixed(2)}%

TIN TỨC LIÊN QUAN (24H GẦN NHẤT):
${newsList}

Phân tích ngắn gọn (3-4 câu):
1. Tác động của các tin tức này đến ${symbol} và ngành trong 1-5 phiên tới
2. Triển vọng ngắn hạn của CP dựa trên tin tức
3. Có điểm nào cần lưu ý đặc biệt không?

Trả lời bằng tiếng Việt, súc tích như một broker đang tư vấn khách. Không dùng bullet points.`;

  try {
    console.log(`[Stock] 🤖 Calling DeepSeek for ${symbol} news analysis...`);
    
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.5,
      }),
    });
    
    if (!response.ok) {
      console.log(`[Stock] ⚠️ DeepSeek error: ${response.status}`);
      return '';
    }
    
    const data = await response.json();
    const analysis = data.choices?.[0]?.message?.content || '';
    console.log(`[Stock] ✅ DeepSeek analysis received for ${symbol}`);
    
    return analysis.trim();
  } catch (e: any) {
    console.log(`[Stock] ⚠️ DeepSeek error: ${e.message}`);
    return '';
  }
}

// ═══════════════════════════════════════════════════

// ANALYSIS FUNCTIONS
// ═══════════════════════════════════════════════════

interface TechnicalResult {
  currentPrice: number;
  priceChange: number;
  ma10: number;  // MA10 - hỗ trợ ngắn hạn
  ma20: number;
  ma50: number;
  ma100: number; // MA100 - hỗ trợ trung hạn
  ma200: number; // MA200 - hỗ trợ dài hạn
  ema12: number;
  ema26: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  macdTrend: string; // Xu hướng MACD: Bullish/Bearish + Cross
  macdPrevHistogram: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerMiddle: number;
  rsi: number;
  rsiTrend: string;
  rsiPrev3: number;
  rsiPeak10d: number;       // Đỉnh RSI 10 ngày
  rsiTrough10d: number;     // Đáy RSI 10 ngày  
  rsiBreakdownFromOB: boolean; // Breakdown từ overbought
  rsiBreakoutFromOS: boolean;  // Breakout từ oversold
  rsiSignal: string;        // Tín hiệu RSI chi tiết

  mfi: number;
  mfiPrev: number;
  mfiTrend: 'rising' | 'falling' | 'flat';
  mfiZone: string;
  mfiSignal: string;
  mfiDivergence: string;
  mfiMoneyFlowStrength: string;
  volumeRatio: number;       // Volume hôm nay / MA50 volume
  avgVolume50: number;       // Khối lượng trung bình 50 phiên
  volumeAboveMA50Count: number; // Số phiên có volume > MA50 trong 10 phiên gần nhất
  volumeInflowSignal: string;   // Tín hiệu dòng tiền vào
  trend: string;
  support: number;
  resistance: number;
  nearestSupport: number;    // MA hỗ trợ gần nhất dưới giá
  nearestResistance: number; // MA kháng cự gần nhất trên giá
  supportLabel: string;      // Tên của MA hỗ trợ
  resistanceLabel: string;   // Tên của MA kháng cự
  vsaSignals: string[];
  score: number;
  pricePosition: string;
  shortTermMomentum: string;
  shortTermScore: number;
  priceChange3d: number;
  priceChange5d: number;
  volumeTrend: string;
  // RS (Relative Strength) - So sánh sức mạnh với thị trường
  rs: number; // Giá trị RS hiện tại (0-100)
  rsChange: number; // Thay đổi RS so với 2 ngày trước (hôm kia) - do API delay 1 ngày
  rsChange5d: number; // Thay đổi RS so với 5 ngày trước
  rsVelocity: number; // Tốc độ tăng RS (điểm/ngày trong 2 ngày)
  rsTrend: string; // Xu hướng RS
  rsSignal: string; // Tín hiệu RS
  rsCategory: string; // 'TĂNG TỐC' hoặc 'NỀN CAO' hoặc 'THƯỜNG'
  rsMA49: number; // MA49 của RS
  rsCrossMA49: string; // 'above' | 'below' | 'cross_up' | 'cross_down'
  rsMA10: number; // MA10 của RS (signal nhanh cho T+)
  rsCrossMA10: string; // 'above' | 'below' | 'cross_up' | 'cross_down'
  rsAcceleration: number; // Tốc độ thay đổi của velocity (dương = tăng tốc)
  rsNewHigh: boolean; // RS tạo đỉnh mới 20 phiên
  rsTrendDirection: string; // 'uptrend' | 'downtrend' | 'sideways'
  rsDivergence: string; // 'bullish' | 'bearish' | 'none'
  // ADX/DMI - Đo sức mạnh và hướng xu hướng
  adx: number; // ADX (0-100): <20 sideway, 20-40 xu hướng TB, >40 xu hướng mạnh
  plusDI: number; // +DI: Lực mua
  minusDI: number; // -DI: Lực bán
  adxTrend: string; // Mô tả xu hướng ADX
  dmiSignal: string; // Tín hiệu DMI crossover
  adxPrev: number; // ADX phiên trước
  adxDirection: 'rising' | 'falling' | 'flat'; // ADX đang tăng hay giảm
  adxReversalZone: string; // Nhận diện vùng đảo chiều
  adxReversalWarning: string; // Cảnh báo đảo chiều xu hướng
  // PERFECT BUY SIGNAL: RS tăng tốc + Giá cắt lên MA10
  ma10Crossover: boolean; // Giá vừa cắt lên MA10
  perfectBuySignal: boolean; // Điểm mua hoàn hảo: RS tăng tốc + Price > MA10
  perfectBuyMessage: string; // Thông báo chi tiết
  // Candlestick Patterns
  candlestickPatterns: CandlestickPattern[];
  // Fibonacci Levels
  fibonacci: FibonacciResult | null;
  // Divergence Detection
  divergence: DivergenceResult;
  // Price Momentum - So sánh giá với các mốc thời gian
  price1WAgo: number; // Giá 1 tuần trước
  price1MAgo: number; // Giá 1 tháng trước (20 ngày)
  price3MAgo: number; // Giá 3 tháng trước (60 ngày)
  price6MAgo: number; // Giá 6 tháng trước (120 ngày)
  priceVs1W: number; // % so với 1W
  priceVs1M: number; // % so với 1M
  priceVs3M: number; // % so với 3M
  priceVs6M: number; // % so với 6M
  priceMomentumScore: number; // 0-4: số timeframes giá đang cao hơn
  priceMomentumTrend: string; // Xu hướng giá dựa trên momentum
  // Đỉnh/Đáy 52 tuần - Vùng kháng cự/hỗ trợ quan trọng
  high52Week: number;        // Đỉnh 52 tuần
  low52Week: number;         // Đáy 52 tuần
  distanceFromHigh52W: number; // % cách đỉnh 52 tuần
  distanceFromLow52W: number;  // % cách đáy 52 tuần
  // Trendline Detection - Đường xu hướng dài hạn
  trendlineResult: TrendlineResult | null; // Kết quả phân tích trendline
  // Luc cung cau chu dong
  activeBuyPercent: number;    // % cau chu dong CP (-1 neu khong co data)
  activeBuyRating: string;     // PressureRating hoac 'N/A'
}

export function analyzeTechnical(data: StockData[], rsData: RSData[] = [], longTermData?: StockData[]): TechnicalResult {
  const latest = data[data.length - 1];
  const prev = data[data.length - 2];
  const data10 = data.slice(-10);
  const data20 = data.slice(-20);
  const data50 = data.slice(-50);
  const data100 = data.slice(-100);
  const data200 = data.slice(-200);
  
  const currentPrice = latest.close;
  const priceChange = ((latest.close - prev.close) / prev.close * 100);
  
  // ═══════════════════════════════════════════════════
  // VOLUME ANALYSIS - So sánh với MA50 volume
  // ═══════════════════════════════════════════════════
  const avgVolume50 = data50.length >= 50 
    ? data50.reduce((sum, d) => sum + d.volume, 0) / data50.length 
    : data20.reduce((sum, d) => sum + d.volume, 0) / data20.length;
  const volumeRatio = latest.volume / avgVolume50;
  
  // Đếm số phiên có volume > MA50 trong 10 phiên gần nhất
  let volumeAboveMA50Count = 0;
  for (const d of data10) {
    if (d.volume > avgVolume50) {
      volumeAboveMA50Count++;
    }
  }
  
  // Tín hiệu dòng tiền vào
  let volumeInflowSignal = '';
  if (volumeAboveMA50Count >= 7) {
    volumeInflowSignal = '🟢 DÒNG TIỀN VÀO MẠNH: ' + volumeAboveMA50Count + '/10 phiên có volume > MA50 → CP có khả năng tăng mạnh!';
  } else if (volumeAboveMA50Count >= 5) {
    volumeInflowSignal = '🟡 Dòng tiền vào khá: ' + volumeAboveMA50Count + '/10 phiên có volume > MA50 → Có sự quan tâm';
  } else if (volumeAboveMA50Count >= 3) {
    volumeInflowSignal = '⚪ Dòng tiền trung bình: ' + volumeAboveMA50Count + '/10 phiên có volume > MA50';
  } else {
    volumeInflowSignal = '🔴 Dòng tiền yếu: Chỉ ' + volumeAboveMA50Count + '/10 phiên có volume > MA50 → Thiếu lực mua';
  }
  
  // MA - Tính tất cả các MA cần thiết
  const ma10 = data10.reduce((sum, d) => sum + d.close, 0) / data10.length;
  const ma20 = data20.reduce((sum, d) => sum + d.close, 0) / data20.length;
  const ma50 = data50.length >= 50 
    ? data50.reduce((sum, d) => sum + d.close, 0) / data50.length 
    : ma20;
  const ma100 = data100.length >= 100
    ? data100.reduce((sum, d) => sum + d.close, 0) / data100.length
    : ma50;
  const ma200 = data200.length >= 200
    ? data200.reduce((sum, d) => sum + d.close, 0) / data200.length
    : ma100;
  
  // EMA & MACD (dùng hàm chuẩn)
  const ema12 = calculateEMA(data, 12);
  const ema26 = calculateEMA(data, 26);
  const macdData = calculateMACD(data);
  const macd = macdData.macd;
  const macdSignal = macdData.signal;
  const macdHistogram = macdData.histogram;
  const macdTrend = macdData.trend;
  const macdPrevHistogram = macdData.prevHistogram;
  
  // Bollinger Bands (20, 2)
  const stdDev = Math.sqrt(data20.reduce((sum, d) => sum + Math.pow(d.close - ma20, 2), 0) / data20.length);
  const bollingerUpper = ma20 + 2 * stdDev;
  const bollingerLower = ma20 - 2 * stdDev;
  const bollingerMiddle = ma20;
  
  // Vị trí giá trong Bollinger
  let pricePosition = 'Giữa band';
  if (currentPrice >= bollingerUpper * 0.98) pricePosition = 'Gần band trên (quá mua)';
  else if (currentPrice <= bollingerLower * 1.02) pricePosition = 'Gần band dưới (quá bán)';
  
  // RSI với xu hướng nâng cao (detect đỉnh/đáy, breakdown/breakout)
  const rsiData = calculateRSIWithTrend(data);
  const rsi = rsiData.current;
  const rsiTrend = rsiData.trend;
  const rsiPrev3 = rsiData.prev3;
  const rsiPeak10d = rsiData.peak10d;
  const rsiTrough10d = rsiData.trough10d;
  const rsiBreakdownFromOB = rsiData.breakdownFromOB;
  const rsiBreakoutFromOS = rsiData.breakoutFromOS;
  const rsiSignal = rsiData.signal;

  
  const mfiResult = calculateMFI(data.slice(-20));
  const mfi = mfiResult.value;
  
  let trend = 'Sideway';
  if (currentPrice > ma20 && ma20 > ma50) trend = 'Uptrend';
  else if (currentPrice < ma20 && ma20 < ma50) trend = 'Downtrend';
  
  const support = Math.min(...data20.map(d => d.low));
  const resistance = Math.max(...data20.map(d => d.high));
  
  // ═══════════════════════════════════════════════════
  // TÌM HỖ TRỢ/KHÁNG CỰ ĐỘNG DỰA TRÊN MA GẦN NHẤT
  // ═══════════════════════════════════════════════════
  const maLevels = [
    { name: 'MA10', value: ma10 },
    { name: 'MA20', value: ma20 },
    { name: 'MA50', value: ma50 },
    { name: 'MA100', value: ma100 },
    { name: 'MA200', value: ma200 },
  ];
  
  // Tìm MA hỗ trợ gần nhất (MA lớn nhất DƯỚI giá hiện tại)
  const supportMAs = maLevels.filter(m => m.value < currentPrice).sort((a, b) => b.value - a.value);
  const nearestSupportMA = supportMAs[0] || { name: 'Low 20d', value: support };
  
  // Tìm MA kháng cự gần nhất (MA nhỏ nhất TRÊN giá hiện tại)
  const resistMAs = maLevels.filter(m => m.value > currentPrice).sort((a, b) => a.value - b.value);
  const nearestResistMA = resistMAs[0] || { name: 'High 20d', value: resistance };
  
  const nearestSupport = nearestSupportMA.value;
  const nearestResistance = nearestResistMA.value;
  const supportLabel = nearestSupportMA.name;
  const resistanceLabel = nearestResistMA.name;

  
  const vsaSignals = analyzeVSA(data.slice(-10));
  
  // ═══════════════════════════════════════════════════
  // PHÂN TÍCH NGẮN HẠN T+2.5 (3-5 ngày)
  // ═══════════════════════════════════════════════════
  
  // Thay đổi giá 3 ngày và 5 ngày
  const price3dAgo = data.length >= 4 ? data[data.length - 4].close : currentPrice;
  const price5dAgo = data.length >= 6 ? data[data.length - 6].close : currentPrice;
  const priceChange3d = ((currentPrice - price3dAgo) / price3dAgo) * 100;
  const priceChange5d = ((currentPrice - price5dAgo) / price5dAgo) * 100;
  
  // Xu hướng volume 3 ngày gần nhất
  const vol3d = data.slice(-3);
  const avgVol3d = vol3d.reduce((sum, d) => sum + d.volume, 0) / 3;
  const volPrev3d = data.slice(-6, -3);
  const avgVolPrev3d = volPrev3d.length > 0 ? volPrev3d.reduce((sum, d) => sum + d.volume, 0) / volPrev3d.length : avgVol3d;
  let volumeTrend = 'Ổn định';
  if (avgVol3d > avgVolPrev3d * 1.3) volumeTrend = 'Tăng mạnh ↑';
  else if (avgVol3d > avgVolPrev3d * 1.1) volumeTrend = 'Tăng nhẹ ↗';
  else if (avgVol3d < avgVolPrev3d * 0.7) volumeTrend = 'Giảm mạnh ↓';
  else if (avgVol3d < avgVolPrev3d * 0.9) volumeTrend = 'Giảm nhẹ ↘';
  
  // Tính điểm ngắn hạn (momentum)
  let shortTermScore = 50;
  
  // Giá 3 ngày
  if (priceChange3d > 3) shortTermScore += 15;
  else if (priceChange3d > 1) shortTermScore += 8;
  else if (priceChange3d < -3) shortTermScore -= 15;
  else if (priceChange3d < -1) shortTermScore -= 8;
  
  // RSI trend
  if (rsiTrend === 'Tăng ↑') shortTermScore += 10;
  else if (rsiTrend === 'Giảm ↓') shortTermScore -= 10;
  
  // MACD histogram đang tăng hay giảm
  const macdHist3dAgo = data.length >= 4 ? (() => {
    const d = data.slice(0, -3);
    const e12 = calculateEMA(d.slice(-26), 12);
    const e26 = calculateEMA(d.slice(-26), 26);
    return e12 - e26;
  })() : macd;
  if (macdHistogram > macdHist3dAgo) shortTermScore += 8;
  else if (macdHistogram < macdHist3dAgo) shortTermScore -= 8;
  
  // Volume trend
  if (volumeTrend.includes('Tăng') && priceChange3d > 0) shortTermScore += 10;
  else if (volumeTrend.includes('Giảm') && priceChange3d < 0) shortTermScore += 5; // Giảm giá + giảm vol = áp lực bán yếu
  else if (volumeTrend.includes('Tăng') && priceChange3d < 0) shortTermScore -= 12; // Tăng vol + giảm giá = bán tháo
  
  shortTermScore = Math.min(100, Math.max(0, shortTermScore));
  
  // Xác định momentum ngắn hạn
  let shortTermMomentum = 'Sideway';
  if (shortTermScore >= 65) shortTermMomentum = 'Tích cực ↑';
  else if (shortTermScore >= 55) shortTermMomentum = 'Hơi tích cực ↗';
  else if (shortTermScore <= 35) shortTermMomentum = 'Tiêu cực ↓';
  else if (shortTermScore <= 45) shortTermMomentum = 'Hơi tiêu cực ↘';
  
  // Tính điểm kỹ thuật tổng
  let score = 50;
  if (trend === 'Uptrend') score += 15;
  else if (trend === 'Downtrend') score -= 15;
  if (rsi < 30) score += 10;
  else if (rsi > 70) score -= 10;
  if (mfi < 20) score += 8;
  else if (mfi > 80) score -= 8;
  if (volumeRatio > 1.5 && priceChange > 0) score += 10;
  if (currentPrice > ma20) score += 5;
  if (macdHistogram > 0 && macd > macdSignal) score += 10;
  else if (macdHistogram < 0 && macd < macdSignal) score -= 10;
  // Thêm điểm cho MACD trend
  if (macdTrend.includes('BULLISH CROSS')) score += 8;
  else if (macdTrend.includes('BEARISH CROSS')) score -= 8;
  else if (macdTrend === 'Bullish giảm') score -= 3; // Sắp cắt xuống
  else if (macdTrend === 'Bearish giảm') score += 3; // Sắp cắt lên
  if (currentPrice <= bollingerLower * 1.02) score += 8;
  else if (currentPrice >= bollingerUpper * 0.98) score -= 8;
  // Thêm điểm từ ngắn hạn
  score += (shortTermScore - 50) * 0.3;
  
  // ═══════════════════════════════════════════════════
  // PHÂN TÍCH RS (Relative Strength)
  // So sánh với HÔM KIA (2 ngày trước) vì API có độ trễ 1 ngày
  // ═══════════════════════════════════════════════════
  let rs = 0;
  let rsChange = 0;
  let rsChange5d = 0;
  let rsTrend = 'N/A';
  let rsSignal = '⚪ Không có dữ liệu RS';
  let rsVelocity = 0;
  let rsCategory = 'THƯỜNG';
  let rsMA10 = 0;
  let rsCrossMA10 = 'below';
  let rsMA49 = 0;
  let rsCrossMA49 = 'below';
  let rsTrendDirection = 'sideways';
  let rsDivergence = 'none';
  let rsAcceleration = 0; // Tốc độ thay đổi của velocity
  let rsNewHigh = false; // RS tạo đỉnh mới (20 phiên)
  
  if (rsData.length >= 3) {
    rs = rsData[rsData.length - 1].value;
    
    const rs2dAgo = rsData.length >= 3 ? rsData[rsData.length - 3]?.value || rs : rs;
    rsChange = rs - rs2dAgo;
    rsVelocity = rsChange / 2;
    
    const rs5dAgo = rsData.length >= 6 ? rsData[rsData.length - 6]?.value || rs : rs;
    rsChange5d = rs - rs5dAgo;
    
    // === RS MA10 (signal nhanh cho T+) ===
    if (rsData.length >= 10) {
      var last10rs = rsData.slice(-10);
      rsMA10 = last10rs.reduce((s, d) => s + d.value, 0) / 10;
      var rsPrevVal = rsData[rsData.length - 2].value;
      var last10rsPrev = rsData.slice(-11, -1);
      var ma10Prev = last10rsPrev.length >= 10 ? last10rsPrev.reduce((s, d) => s + d.value, 0) / 10 : rsMA10;
      if (rsPrevVal <= ma10Prev && rs > rsMA10) rsCrossMA10 = 'cross_up';
      else if (rsPrevVal >= ma10Prev && rs < rsMA10) rsCrossMA10 = 'cross_down';
      else if (rs > rsMA10) rsCrossMA10 = 'above';
      else rsCrossMA10 = 'below';
    }
    
    // === RS MA49 ===
    if (rsData.length >= 49) {
      const last49 = rsData.slice(-49);
      rsMA49 = last49.reduce((s, d) => s + d.value, 0) / 49;
      
      // Check crossover: RS hôm qua vs MA49 hôm qua
      const rsPrev = rsData[rsData.length - 2].value;
      const last49Prev = rsData.slice(-50, -1);
      const ma49Prev = last49Prev.length >= 49 ? last49Prev.reduce((s, d) => s + d.value, 0) / 49 : rsMA49;
      
      if (rsPrev < ma49Prev && rs > rsMA49) rsCrossMA49 = 'cross_up';
      else if (rsPrev > ma49Prev && rs < rsMA49) rsCrossMA49 = 'cross_down';
      else if (rs > rsMA49) rsCrossMA49 = 'above';
      else rsCrossMA49 = 'below';
    } else if (rsData.length >= 20) {
      // Fallback: dùng MA của data có sẵn
      rsMA49 = rsData.reduce((s, d) => s + d.value, 0) / rsData.length;
      rsCrossMA49 = rs > rsMA49 ? 'above' : 'below';
    }
    
    // === RS TREND DIRECTION (dùng 10 phiên gần nhất) ===
    if (rsData.length >= 10) {
      const recent10 = rsData.slice(-10);
      const firstHalf = recent10.slice(0, 5).reduce((s, d) => s + d.value, 0) / 5;
      const secondHalf = recent10.slice(5).reduce((s, d) => s + d.value, 0) / 5;
      if (secondHalf - firstHalf > 3) rsTrendDirection = 'uptrend';
      else if (firstHalf - secondHalf > 3) rsTrendDirection = 'downtrend';
      else rsTrendDirection = 'sideways';
    }
    
    // === RS DIVERGENCE vs PRICE ===
    if (rsData.length >= 10 && data.length >= 10) {
      const price5dAgo = data[data.length - 6]?.close || latest.close;
      const priceChange5dPct = ((latest.close - price5dAgo) / price5dAgo) * 100;
      if (priceChange5dPct < -1 && rsChange5d > 2) rsDivergence = 'bullish';
      else if (priceChange5dPct > 1 && rsChange5d < -2) rsDivergence = 'bearish';
    }
    
    // === RS ACCELERATION (tốc độ thay đổi của velocity) ===
    if (rsData.length >= 8) {
      var vel5dAgo = (rsData[rsData.length - 3].value - rsData[rsData.length - 6].value) / 3;
      var velNow = rsVelocity;
      rsAcceleration = velNow - vel5dAgo; // Dương = đang tăng tốc, Âm = đang giảm tốc
    }
    
    // === RS NEW HIGH (20 phiên) ===
    if (rsData.length >= 20) {
      var max20 = Math.max(...rsData.slice(-21, -1).map(d => d.value)); // Max 20 phiên trước (không tính hôm nay)
      rsNewHigh = rs > max20;
    }
    
    // Xu hướng RS
    if (rsChange >= 5) rsTrend = 'Tăng mạnh ↑↑';
    else if (rsChange >= 2) rsTrend = 'Tăng ↑';
    else if (rsChange <= -5) rsTrend = 'Giảm mạnh ↓↓';
    else if (rsChange <= -2) rsTrend = 'Giảm ↓';
    else rsTrend = 'Sideway →';
    
    // Phân loại cổ phiếu theo RS
    // - TĂNG TỐC: RS tăng nhanh trong 2-3 ngày (velocity > 2 điểm/ngày)
    // - NỀN CAO: RS >= 70 nhưng không tăng mạnh (đã ổn định ở mức cao)
    // - THƯỜNG: Còn lại
    if (rsVelocity >= 2 || rsChange >= 4) {
      rsCategory = 'TĂNG TỐC';
    } else if (rs >= 70 && rsChange >= -3) {
      rsCategory = 'NỀN CAO';
    } else {
      rsCategory = 'THƯỜNG';
    }
    
    // Xác định tín hiệu RS với chi tiết
    const rsDetail = `RS=${rs.toFixed(0)} | Hôm kia: ${rs2dAgo.toFixed(0)}→${rs.toFixed(0)} (${rsChange >= 0 ? '+' : ''}${rsChange.toFixed(0)}) | 5d: ${rs5dAgo.toFixed(0)}→${rs.toFixed(0)} (${rsChange5d >= 0 ? '+' : ''}${rsChange5d.toFixed(0)}) | Tốc độ: ${rsVelocity >= 0 ? '+' : ''}${rsVelocity.toFixed(1)}/ngày`;
    
    // Logic tín hiệu theo phân loại + MA49 + Divergence
    const ma49Info = rsMA49 > 0 ? ` | MA49: ${rsMA49.toFixed(0)}` : '';
    const ma10Info = rsMA10 > 0 ? ` | MA10: ${rsMA10.toFixed(0)}` : '';
    const crossInfo = rsCrossMA49 === 'cross_up' ? ' 🔺CẮT LÊN MA49' : (rsCrossMA49 === 'cross_down' ? ' 🔻CẮT XUỐNG MA49' : '');
    const divInfo = rsDivergence === 'bullish' ? ' | 📈 PHÂN KỲ DƯƠNG' : (rsDivergence === 'bearish' ? ' | 📉 PHÂN KỲ ÂM' : '');
    const accelInfo = rsAcceleration > 1 ? ' | 🚀 TĂNG TỐC' : (rsAcceleration < -1 ? ' | 🔻 GIẢM TỐC' : '');
    const newHighInfo = rsNewHigh ? ' | ⭐ RS NEW HIGH' : '';
    
    // === SIGNAL PRIORITY (từ mạnh → yếu) ===
    
    // 1. RS New High + giá chưa new high = tín hiệu cực mạnh (Kacher/O'Neil)
    if (rsNewHigh && rsAcceleration > 0) {
      rsSignal = `🟢🔥⭐ RS NEW HIGH + TĂNG TỐC: ${rsDetail}${ma10Info}${ma49Info}${accelInfo} → CP sắp bứt phá mạnh!`;
      score += 22;
      shortTermScore += 20;
      rsCategory = 'TĂNG TỐC';
    }
    // 2. RS cắt lên MA10 + trên MA49 = setup T+ đẹp nhất
    else if (rsCrossMA10 === 'cross_up' && rs > rsMA49 && rsMA49 > 0) {
      rsSignal = `🟢🔥 RS CẮT LÊN MA10 + TRÊN MA49: ${rsDetail}${ma10Info}${ma49Info}${accelInfo}${divInfo} → T+ setup đẹp!`;
      score += 20;
      shortTermScore += 18;
      rsCategory = 'TĂNG TỐC';
    }
    // 3. RS cắt lên MA10 nhưng dưới MA49 = T+ lướt nhanh, rủi ro hơn
    else if (rsCrossMA10 === 'cross_up') {
      rsSignal = `🟢 RS CẮT LÊN MA10 (dưới MA49): ${rsDetail}${ma10Info}${ma49Info}${accelInfo}${divInfo} → T+ lướt nhanh`;
      score += 12;
      shortTermScore += 14;
      rsCategory = 'TĂNG TỐC';
    }
    // 4. RS cắt lên MA49 = xác nhận trend trung hạn
    else if (rsCrossMA49 === 'cross_up' && rsTrendDirection === 'uptrend') {
      rsSignal = `🟢🔥 RS CẮT LÊN MA49 + XU HƯỚNG TĂNG: ${rsDetail}${ma49Info}${divInfo} → Tín hiệu mua mạnh!`;
      score += 20;
      shortTermScore += 18;
      rsCategory = 'TĂNG TỐC';
    } else if (rsCrossMA49 === 'cross_up') {
      rsSignal = `🟢 RS CẮT LÊN MA49: ${rsDetail}${ma49Info}${divInfo} → Momentum cải thiện`;
      score += 15;
      shortTermScore += 12;
      rsCategory = 'TĂNG TỐC';
    } else if (rsDivergence === 'bearish' && rs >= 70) {
      rsSignal = `🟠⚠️ RS CAO NHƯNG PHÂN KỲ ÂM: ${rsDetail}${ma49Info}${divInfo} → Cẩn thận phân phối!`;
      score += 2;
      shortTermScore -= 5;
      rsCategory = 'PHÂN PHỐI';
    } else if (rsDivergence === 'bullish' && rs >= 40 && rs <= 70) {
      rsSignal = `🟢 PHÂN KỲ DƯƠNG (RS 50-70): ${rsDetail}${ma49Info}${divInfo} → Cơ hội mua khi RS hồi`;
      score += 14;
      shortTermScore += 10;
      rsCategory = 'TĂNG TỐC';
    } else if (rsCategory === 'TĂNG TỐC' && rs >= 70) {
      rsSignal = `🟢🔥 RS TĂNG TỐC + CAO: ${rsDetail} → CP dẫn dắt thị trường!`;
      score += 18;
      shortTermScore += 15;
    } else if (rsCategory === 'TĂNG TỐC') {
      rsSignal = `🟢 RS TĂNG TỐC: ${rsDetail} → Momentum đang bùng nổ!`;
      score += 12;
      shortTermScore += 12;
    } else if (rsCategory === 'NỀN CAO' && rs >= 80) {
      rsSignal = `🟢 RS NỀN CAO (${rs.toFixed(0)}): ${rsDetail} → CP mạnh ổn định`;
      score += 10;
      shortTermScore += 5;
    } else if (rsCategory === 'NỀN CAO') {
      rsSignal = `🟡 RS NỀN CAO (${rs.toFixed(0)}): ${rsDetail} → Theo dõi khi RS tăng tốc`;
      score += 6;
      shortTermScore += 3;
    } else if (rs < 30) {
      rsSignal = `🔴 RS THẤP (${rs.toFixed(0)}): ${rsDetail} → CP yếu hơn thị trường`;
      score -= 8;
      shortTermScore -= 5;
    } else if (rs < 50) {
      rsSignal = `🟠 RS DƯỚI TB (${rs.toFixed(0)}): ${rsDetail} → Chưa nổi bật`;
      score -= 3;
    } else {
      rsSignal = `⚪ RS (${rs.toFixed(0)}): ${rsDetail}`;
    }
  }
  
  // Cập nhật lại shortTermScore và score sau khi thêm RS
  shortTermScore = Math.min(100, Math.max(0, shortTermScore));
  
  // Cập nhật lại momentum ngắn hạn
  if (shortTermScore >= 65) shortTermMomentum = 'Tích cực ↑';
  else if (shortTermScore >= 55) shortTermMomentum = 'Hơi tích cực ↗';
  else if (shortTermScore <= 35) shortTermMomentum = 'Tiêu cực ↓';
  else if (shortTermScore <= 45) shortTermMomentum = 'Hơi tiêu cực ↘';
  else shortTermMomentum = 'Sideway';
  
  // ═══════════════════════════════════════════════════
  // PERFECT BUY SIGNAL: RS TĂNG TỐC + GIÁ CẮT LÊN MA10
  // ═══════════════════════════════════════════════════
  
  // Xác định MA10 crossover: Giá hôm nay > MA10 VÀ Giá hôm qua <= MA10
  const prevClose = prev.close;
  const prevMa10 = data.length >= 11 
    ? data.slice(-11, -1).reduce((sum, d) => sum + d.close, 0) / 10 
    : ma10;
  const ma10Crossover = currentPrice > ma10 && prevClose <= prevMa10;
  
  // Perfect Buy Signal: RS tăng tốc + Giá cắt lên hoặc ở trên MA10
  // Điều kiện:
  // 1. RS Category = TĂNG TỐC (velocity >= 2 hoặc rsChange >= 4)
  // 2. Giá hiện tại > MA10
  // 3. Bonus: Nếu vừa cắt lên MA10 thì càng hoàn hảo
  const isPerfectBuy = rsCategory === 'TĂNG TỐC' && currentPrice > ma10;
  const isGoldenCross = isPerfectBuy && ma10Crossover; // Điểm vàng: vừa cắt lên
  
  let perfectBuyMessage = '';
  if (isGoldenCross) {
    perfectBuyMessage = `🔥🔥🔥 **ĐIỂM MUA HOÀN HẢO!** RS TĂNG TỐC (+${rsVelocity.toFixed(1)}/ngày) + Giá VỪA CẮT LÊN MA10! Đây là cơ hội tốt nhất!`;
    score += 15;
    shortTermScore += 15;
  } else if (isPerfectBuy) {
    perfectBuyMessage = `🔥 **TÍN HIỆU MUA TỐT:** RS TĂNG TỐC (+${rsVelocity.toFixed(1)}/ngày) + Giá > MA10. Momentum đang bùng nổ!`;
    score += 10;
    shortTermScore += 10;
  } else if (rsCategory === 'TĂNG TỐC' && currentPrice < ma10) {
    perfectBuyMessage = `⏳ RS đang TĂNG TỐC nhưng giá còn dưới MA10 (${formatVND(ma10)}). Chờ giá cắt lên MA10 để có điểm mua hoàn hảo!`;
  } else if (rsCategory === 'NỀN CAO' && currentPrice > ma10) {
    perfectBuyMessage = `🟡 CP nền RS cao (${rs.toFixed(0)}) + Đang trên MA10. Theo dõi khi RS tăng tốc để xác nhận điểm mua.`;
  }
  
  // Cập nhật score final
  score = Math.min(100, Math.max(0, score));
  shortTermScore = Math.min(100, Math.max(0, shortTermScore));
  
  // ═══ PRICE MOMENTUM - So sánh giá với các mốc thời gian ═══
  // 1W = 5 ngày, 1M = 20 ngày, 3M = 60 ngày, 6M = 120 ngày
  const price1WAgo = data.length >= 5 ? data[data.length - 5].close : currentPrice;
  const price1MAgo = data.length >= 20 ? data[data.length - 20].close : currentPrice;
  const price3MAgo = data.length >= 60 ? data[data.length - 60].close : currentPrice;
  const price6MAgo = data.length >= 120 ? data[data.length - 120].close : currentPrice;
  
  const priceVs1W = ((currentPrice - price1WAgo) / price1WAgo) * 100;
  const priceVs1M = ((currentPrice - price1MAgo) / price1MAgo) * 100;
  const priceVs3M = ((currentPrice - price3MAgo) / price3MAgo) * 100;
  const priceVs6M = ((currentPrice - price6MAgo) / price6MAgo) * 100;
  
  // Đếm số timeframes giá cao hơn → momentum score
  let priceMomentumScore = 0;
  if (currentPrice > price1WAgo) priceMomentumScore++;
  if (currentPrice > price1MAgo) priceMomentumScore++;
  if (currentPrice > price3MAgo) priceMomentumScore++;
  if (currentPrice > price6MAgo) priceMomentumScore++;
  
  // Xác định xu hướng dựa trên momentum
  let priceMomentumTrend = '';
  if (priceMomentumScore === 4) {
    priceMomentumTrend = '🚀 **XU HƯỚNG TĂNG MẠNH** - Giá cao hơn mọi mốc thời gian, có thể tiếp tục tăng!';
    score += 5;
  } else if (priceMomentumScore === 3) {
    priceMomentumTrend = '🟢 Xu hướng tăng tốt - Giá cao hơn 3/4 mốc thời gian';
    score += 3;
  } else if (priceMomentumScore === 2) {
    priceMomentumTrend = '🟡 Xu hướng trung lập - Giá cao hơn 2/4 mốc';
  } else if (priceMomentumScore === 1) {
    priceMomentumTrend = '🟠 Xu hướng yếu - Chỉ cao hơn 1/4 mốc thời gian';
    score -= 3;
  } else {
    priceMomentumTrend = '🔴 Xu hướng giảm - Giá thấp hơn mọi mốc thời gian, cẩn thận!';
    score -= 5;
  }
  
  // Tính ADX/DMI
  const adxResult = calculateADX(data);
  
  // ADX Reversal Zone → Điều chỉnh score
  // ADX vùng đỉnh (>=44) + đang giảm → xu hướng sắp đảo chiều
  if (adxResult.adx >= 44 && adxResult.adxDirection === 'falling') {
    if (adxResult.plusDI > adxResult.minusDI) {
      // Xu hướng tăng đang kiệt sức → giảm score
      score -= 8;
    } else {
      // Xu hướng giảm đang kiệt sức → tăng score (sắp hồi)
      score += 6;
    }
  }
  // ADX vùng thấp (<=15) + bắt đầu tăng → xu hướng mới sắp bùng nổ
  if (adxResult.adx <= 15 && adxResult.adxDirection === 'rising') {
    if (adxResult.plusDI > adxResult.minusDI) {
      score += 8; // Xu hướng tăng mới
    } else {
      score -= 6; // Xu hướng giảm mới
    }
  }
  
  // ═══ ĐỈNH/ĐÁY 52 TUẦN - Vùng kháng cự/hỗ trợ quan trọng ═══
  // 52 tuần ≈ 250 ngày giao dịch
  const data52W = data.slice(-250);
  const high52Week = Math.max(...data52W.map(d => d.high));
  const low52Week = Math.min(...data52W.map(d => d.low));
  const distanceFromHigh52W = ((high52Week - currentPrice) / currentPrice) * 100;
  const distanceFromLow52W = ((currentPrice - low52Week) / low52Week) * 100;
  
  const returnObj: TechnicalResult = {
    currentPrice,
    priceChange,
    ma10,
    ma20,
    ma50,
    ma100,
    ma200,
    ema12,
    ema26,
    macd,
    macdSignal,
    macdHistogram,
    macdTrend,
    macdPrevHistogram,
    bollingerUpper,
    bollingerLower,
    bollingerMiddle,
    rsi,
    rsiTrend,
    rsiPrev3,
    rsiPeak10d,
    rsiTrough10d,
    rsiBreakdownFromOB,
    rsiBreakoutFromOS,
    rsiSignal,
    mfi: mfiResult.value,
    mfiPrev: mfiResult.prev,
    mfiTrend: mfiResult.trend,
    mfiZone: mfiResult.zone,
    mfiSignal: mfiResult.signal,
    mfiDivergence: mfiResult.divergence,
    mfiMoneyFlowStrength: mfiResult.moneyFlowStrength,

    volumeRatio,
    avgVolume50,
    volumeAboveMA50Count,
    volumeInflowSignal,
    trend,
    support,
    resistance,
    nearestSupport,
    nearestResistance,
    supportLabel,
    resistanceLabel,
    vsaSignals,
    score,
    pricePosition,
    shortTermMomentum,
    shortTermScore,
    priceChange3d,
    priceChange5d,
    volumeTrend,
    // RS với so sánh 2 ngày (hôm kia)
    rs,
    rsChange,
    rsChange5d,
    rsVelocity,
    rsTrend,
    rsSignal,
    rsCategory,
    rsMA49,
    rsCrossMA49,
    rsMA10,
    rsCrossMA10,
    rsAcceleration,
    rsNewHigh,
    rsTrendDirection,
    rsDivergence,
    // ADX/DMI
    adx: adxResult.adx,
    plusDI: adxResult.plusDI,
    minusDI: adxResult.minusDI,
    adxTrend: adxResult.adxTrend,
    dmiSignal: adxResult.dmiSignal,
    adxPrev: adxResult.adxPrev,
    adxDirection: adxResult.adxDirection,
    adxReversalZone: adxResult.adxReversalZone,
    adxReversalWarning: adxResult.adxReversalWarning,
    // Perfect Buy Signal
    ma10Crossover,
    perfectBuySignal: isPerfectBuy,
    perfectBuyMessage,
    // Candlestick Patterns
    candlestickPatterns: analyzeCandlestickPatterns(data),
    // Fibonacci Levels
    fibonacci: calculateFibonacciLevels(data),
    // Divergence Detection
    divergence: detectDivergence(data),
    // Price Momentum
    price1WAgo,
    price1MAgo,
    price3MAgo,
    price6MAgo,
    priceVs1W,
    priceVs1M,
    priceVs3M,
    priceVs6M,
    priceMomentumScore,
    priceMomentumTrend,
    // Đỉnh/Đáy 52 tuần
    high52Week,
    low52Week,
    distanceFromHigh52W,
    distanceFromLow52W,
    // Trendline Detection
    trendlineResult: null as TrendlineResult | null,
    // Luc cung cau chu dong
    activeBuyPercent: -1,
    activeBuyRating: 'N/A',
  };

  // ═══ TRENDLINE DETECTION - Phát hiện đường xu hướng dài hạn ═══
  const trendlineData = longTermData && longTermData.length > 200 ? longTermData : data;
  if (trendlineData.length >= 100) {
    try {
      const tlResult = detectTrendlines(trendlineData);
      returnObj.trendlineResult = tlResult;
      
      // Điều chỉnh score nếu giá gần trendline kháng cự mạnh
      if (tlResult.nearestResistanceTrendline?.isApproaching) {
        const tl = tlResult.nearestResistanceTrendline;
        if (tl.strength >= 70) {
          returnObj.score = Math.max(0, returnObj.score - 10);
        } else if (tl.strength >= 50) {
          returnObj.score = Math.max(0, returnObj.score - 5);
        }
      }
      // Tăng điểm nếu giá gần trendline hỗ trợ mạnh
      if (tlResult.nearestSupportTrendline?.isApproaching) {
        const tl = tlResult.nearestSupportTrendline;
        if (tl.strength >= 70) {
          returnObj.score = Math.min(100, returnObj.score + 8);
        } else if (tl.strength >= 50) {
          returnObj.score = Math.min(100, returnObj.score + 4);
        }
      }
    } catch (e) {
      console.log('[Trendline] ⚠️ Detection error:', e);
    }
  }
  
  return returnObj;
}

interface FundamentalResult {
  latestEPS: number;
  roe: number;
  roa: number;
  profitMargin: number;
  salesGrowth: number;
  profitGrowth: number;
  debtToEquity: number;
  pe: number;
  pb: number;
  score: number;
  // Thêm dữ liệu 4 quý
  quarterlyData: {
    quarter: string;  // e.g., "Q3/2025"
    revenue: number;  // Doanh thu (tỷ đồng)
    profit: number;   // LNST (tỷ đồng)
    eps: number;
  }[];
}

interface QuarterlyFinancialRaw {
  Year: number;
  Quarter: number;
  Revenue?: number;
  NetSales?: number;
  NetProfit?: number;
  ProfitAfterTax?: number;
  BasicEPS_TTM?: number;
  ROE_TTM?: number;
  ROA_TTM?: number;
  NetProfitMargin_TTM?: number;
  SalesGrowth_TTM?: number;
  ProfitGrowth_TTM?: number;
  TotalDebtToEquity_MRQ?: number;
  PE_TTM?: number;
  PB_MRQ?: number;
}

export function analyzeFinancial(financial: FinancialData[], _timeline: TimelineMark[]): FundamentalResult {
  if (financial.length === 0) {
    return {
      latestEPS: 0, roe: 0, roa: 0, profitMargin: 0,
      salesGrowth: 0, profitGrowth: 0, debtToEquity: 0, pe: 0, pb: 0, score: 50,
      quarterlyData: [],
    };
  }
  
  const latest = financial[financial.length - 1];
  
  // Tính điểm cơ bản
  let score = 50;
  if (latest.roe > 15) score += 15;
  else if (latest.roe > 10) score += 10;
  if (latest.profitGrowth > 20) score += 15;
  else if (latest.profitGrowth > 10) score += 10;
  if (latest.salesGrowth > 15) score += 10;
  if (latest.debtToEquity < 1) score += 5;
  else if (latest.debtToEquity > 2) score -= 10;
  // P/E scoring
  if (latest.pe > 0 && latest.pe < 10) score += 10; // Rẻ
  else if (latest.pe > 0 && latest.pe < 15) score += 5;
  else if (latest.pe > 25) score -= 5; // Đắt
  // P/B scoring
  if (latest.pb > 0 && latest.pb < 1.5) score += 5;
  else if (latest.pb > 3) score -= 5;
  
  // Lấy 4 quý gần nhất (đã có trong financial array)
  const quarterlyData = financial.slice(-4).reverse().map(q => ({
    quarter: `Q${q.quarter}/${q.year}`,
    revenue: 0, // Sẽ được fetch riêng nếu cần
    profit: 0,  // Sẽ được fetch riêng nếu cần
    eps: q.eps,
  }));
  
  return {
    latestEPS: latest.eps,
    roe: latest.roe,
    roa: latest.roa,
    profitMargin: latest.profitMargin,
    salesGrowth: latest.salesGrowth,
    profitGrowth: latest.profitGrowth,
    debtToEquity: latest.debtToEquity,
    pe: latest.pe,
    pb: latest.pb,
    score: Math.min(100, Math.max(0, score)),
    quarterlyData,
  };
}

export function calculateOverallScore(tech: TechnicalResult, fund: FundamentalResult): { score: number; rating: string } {
  const score = Math.round(tech.score * 0.4 + fund.score * 0.6);
  
  let rating = 'Trung bình';
  if (score >= 75) rating = 'Rất tích cực 🟢';
  else if (score >= 60) rating = 'Tích cực 🟡';
  else if (score >= 40) rating = 'Trung bình ⚪';
  else if (score >= 25) rating = 'Tiêu cực 🟠';
  else rating = 'Rất tiêu cực 🔴';
  
  return { score, rating };
}

// ═══════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════

/**
 * Tính RSI với phân tích xu hướng nâng cao
 * - Tìm đỉnh/đáy RSI trong 10 ngày
 * - Detect breakdown từ overbought (>70) hoặc breakout từ oversold (<30)
 * - Đưa cảnh báo phù hợp dựa trên context
 */
function calculateRSIWithTrend(data: StockData[]): { 
  current: number; 
  prev3: number; 
  trend: string;
  peak10d: number;      // Đỉnh RSI 10 ngày
  trough10d: number;    // Đáy RSI 10 ngày
  breakdownFromOB: boolean;  // Đang breakdown từ overbought
  breakoutFromOS: boolean;   // Đang breakout từ oversold
  signal: string;       // Tín hiệu RSI chi tiết
} {
  const period = 14;
  if (data.length < period + 12) return { 
    current: 50, prev3: 50, trend: 'Sideway',
    peak10d: 50, trough10d: 50, 
    breakdownFromOB: false, breakoutFromOS: false,
    signal: '⚪ Không đủ dữ liệu RSI'
  };
  
  // Tính RSI với Wilder smoothing
  function calcRSI(prices: StockData[]): number {
    if (prices.length < period + 1) return 50;
    
    let avgGain = 0;
    let avgLoss = 0;
    
    // First average
    for (let i = 1; i <= period; i++) {
      const change = prices[i].close - prices[i - 1].close;
      if (change > 0) avgGain += change;
      else avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;
    
    // Wilder smoothing cho các ngày tiếp theo
    for (let i = period + 1; i < prices.length; i++) {
      const change = prices[i].close - prices[i - 1].close;
      if (change > 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
      }
    }
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
  
  // Tính RSI cho 10 ngày gần nhất
  const rsiHistory: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const sliceEnd = data.length - i;
    if (sliceEnd > period) {
      rsiHistory.push(calcRSI(data.slice(0, sliceEnd)));
    }
  }
  
  const current = rsiHistory[0] || 50;
  const prev3 = rsiHistory[3] || current;
  const peak10d = Math.max(...rsiHistory);
  const trough10d = Math.min(...rsiHistory);
  
  // Tính xu hướng cơ bản
  let trend = 'Sideway →';
  const diff = current - prev3;
  if (diff > 3) trend = 'Tăng ↑';
  else if (diff < -3) trend = 'Giảm ↓';
  
  // Detect breakdown từ overbought (đỉnh > 70, hiện tại đang giảm và xuống dưới 70)
  const breakdownFromOB = peak10d > 70 && current < 70 && current < peak10d - 3;
  
  // Detect breakout từ oversold (đáy < 30, hiện tại đang tăng và lên trên 30)
  const breakoutFromOS = trough10d < 30 && current > 30 && current > trough10d + 3;
  
  // Tạo signal chi tiết dựa trên context
  let signal = '';
  
  if (breakdownFromOB) {
    // Breakdown từ overbought - TÍN HIỆU CẢNH BÁO
    signal = `⚠️ **BREAKDOWN từ quá mua!** Đỉnh ${peak10d.toFixed(0)} → Hiện tại ${current.toFixed(0)} → Momentum suy yếu, cẩn thận!`;
  } else if (breakoutFromOS) {
    // Breakout từ oversold - TÍN HIỆU TÍCH CỰC
    signal = `🟢 **BREAKOUT từ quá bán!** Đáy ${trough10d.toFixed(0)} → Hiện tại ${current.toFixed(0)} → Momentum phục hồi!`;
  } else if (current > 70) {
    // Đang ở vùng overbought
    if (trend === 'Giảm ↓') {
      signal = `🔴 Quá mua (${current.toFixed(0)}) \u0026 đang giảm → Có thể sắp breakdown, cẩn thận!`;
    } else {
      signal = `🟡 Quá mua (${current.toFixed(0)}) → Momentum mạnh nhưng có thể điều chỉnh`;
    }
  } else if (current < 30) {
    // Đang ở vùng oversold
    if (trend === 'Tăng ↑') {
      signal = `🟢 Quá bán (${current.toFixed(0)}) \u0026 đang tăng → Có thể sắp breakout, cơ hội!`;
    } else {
      signal = `🔴 Quá bán (${current.toFixed(0)}) → Áp lực bán mạnh, chờ đáy`;
    }
  } else if (current >= 50 && current <= 70) {
    // Vùng trung tính cao
    if (peak10d > 70 && trend === 'Giảm ↓') {
      signal = `🟡 RSI ${current.toFixed(0)} (đỉnh 10d: ${peak10d.toFixed(0)}) → Giảm từ vùng cao, momentum suy yếu`;
    } else if (trend === 'Tăng ↑') {
      signal = `🟢 RSI ${current.toFixed(0)} → Tăng, momentum tích cực`;
    } else {
      signal = `⚪ RSI ${current.toFixed(0)} → Trung tính, chờ tín hiệu`;
    }
  } else {
    // Vùng trung tính thấp (30-50)
    if (trough10d < 30 && trend === 'Tăng ↑') {
      signal = `🟢 RSI ${current.toFixed(0)} (đáy 10d: ${trough10d.toFixed(0)}) → Phục hồi từ vùng thấp`;
    } else if (trend === 'Giảm ↓') {
      signal = `🟠 RSI ${current.toFixed(0)} → Giảm, có thể về vùng quá bán`;
    } else {
      signal = `⚪ RSI ${current.toFixed(0)} → Trung tính thấp`;
    }
  }
  
  return { 
    current, 
    prev3, 
    trend,
    peak10d,
    trough10d,
    breakdownFromOB,
    breakoutFromOS,
    signal
  };
}


/**
 * Tính EMA (Exponential Moving Average)
 */
function calculateEMA(data: StockData[], period: number): number {
  if (data.length < period) return data[data.length - 1]?.close || 0;
  
  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, d) => sum + d.close, 0) / period;
  
  for (let i = period; i < data.length; i++) {
    ema = (data[i].close - ema) * multiplier + ema;
  }
  
  return ema;
}

/**
 * Tính MACD chuẩn (12, 26, 9)
 * Trả về MACD line, Signal line, Histogram và xu hướng
 */
function calculateMACD(data: StockData[]): { macd: number; signal: number; histogram: number; trend: string; prevHistogram: number } {
  if (data.length < 35) return { macd: 0, signal: 0, histogram: 0, trend: 'Neutral', prevHistogram: 0 };
  
  // Tính EMA 12 và EMA 26 cho mỗi ngày để có đủ data cho Signal line
  const macdLine: number[] = [];
  
  for (let i = 25; i < data.length; i++) {
    const slice = data.slice(0, i + 1);
    const ema12 = calculateEMA(slice, 12);
    const ema26 = calculateEMA(slice, 26);
    macdLine.push(ema12 - ema26);
  }
  
  // Signal line = EMA 9 của MACD line
  if (macdLine.length < 9) return { macd: 0, signal: 0, histogram: 0, trend: 'Neutral', prevHistogram: 0 };
  
  const multiplier = 2 / (9 + 1);
  let signal = macdLine.slice(0, 9).reduce((sum, v) => sum + v, 0) / 9;
  
  for (let i = 9; i < macdLine.length; i++) {
    signal = (macdLine[i] - signal) * multiplier + signal;
  }
  
  const macd = macdLine[macdLine.length - 1];
  const histogram = macd - signal;
  
  // Histogram 1 ngày trước
  const prevMacd = macdLine[macdLine.length - 2] || macd;
  let prevSignal = macdLine.slice(0, 9).reduce((sum, v) => sum + v, 0) / 9;
  for (let i = 9; i < macdLine.length - 1; i++) {
    prevSignal = (macdLine[i] - prevSignal) * multiplier + prevSignal;
  }
  const prevHistogram = prevMacd - prevSignal;
  
  // Xác định xu hướng
  let trend = 'Neutral';
  if (histogram > 0 && histogram > prevHistogram) {
    trend = 'Bullish tăng'; // Histogram dương và đang tăng
  } else if (histogram > 0 && histogram < prevHistogram) {
    trend = 'Bullish giảm'; // Histogram dương nhưng đang giảm (sắp cắt xuống)
  } else if (histogram < 0 && histogram < prevHistogram) {
    trend = 'Bearish tăng'; // Histogram âm và đang giảm sâu hơn
  } else if (histogram < 0 && histogram > prevHistogram) {
    trend = 'Bearish giảm'; // Histogram âm nhưng đang hồi (sắp cắt lên)
  }
  
  // Phát hiện crossover
  if (prevHistogram > 0 && histogram < 0) {
    trend = 'BEARISH CROSS ↓'; // Vừa cắt xuống
  } else if (prevHistogram < 0 && histogram > 0) {
    trend = 'BULLISH CROSS ↑'; // Vừa cắt lên
  }
  
  return { macd, signal, histogram, trend, prevHistogram };
}

/**
 * Tính Money Flow Index (MFI) - kết hợp giá và volume
 * MFI > 80: Overbought (quá mua)
 * MFI < 20: Oversold (quá bán)
 */
interface MFIResult {
  value: number;           // MFI hiện tại (0-100)
  prev: number;            // MFI phiên trước
  trend: 'rising' | 'falling' | 'flat'; // MFI đang tăng hay giảm
  zone: string;            // Vùng MFI: overbought/oversold/neutral
  signal: string;          // Tín hiệu MFI chi tiết
  divergence: string;      // Phân kỳ MFI vs giá
  moneyFlowStrength: string; // Đánh giá sức mạnh dòng tiền
}

function calculateMFI(data: StockData[]): MFIResult {
  const defaultResult: MFIResult = {
    value: 50, prev: 50, trend: 'flat', zone: 'neutral',
    signal: '⚪ Không đủ dữ liệu', divergence: '', moneyFlowStrength: '',
  };
  if (data.length < 15) return defaultResult;
  
  // Tính MFI cho 14 phiên gần nhất
  const calcMFIValue = (slice: StockData[]): number => {
    let positiveFlow = 0;
    let negativeFlow = 0;
    for (let i = 1; i < slice.length; i++) {
      const typicalPrice = (slice[i].high + slice[i].low + slice[i].close) / 3;
      const prevTypicalPrice = (slice[i-1].high + slice[i-1].low + slice[i-1].close) / 3;
      const rawMoneyFlow = typicalPrice * slice[i].volume;
      if (typicalPrice > prevTypicalPrice) positiveFlow += rawMoneyFlow;
      else if (typicalPrice < prevTypicalPrice) negativeFlow += rawMoneyFlow;
    }
    if (negativeFlow === 0) return 100;
    const ratio = positiveFlow / negativeFlow;
    return 100 - (100 / (1 + ratio));
  };
  
  // MFI hiện tại (14 phiên gần nhất)
  const current = calcMFIValue(data.slice(-15));
  // MFI phiên trước (bỏ phiên cuối)
  const prev = data.length >= 16 ? calcMFIValue(data.slice(-16, -1)) : current;
  // MFI 5 phiên trước (để detect divergence)
  const prev5 = data.length >= 20 ? calcMFIValue(data.slice(-20, -5)) : current;
  
  // Trend: MFI đang tăng hay giảm
  const delta = current - prev;
  let trend: 'rising' | 'falling' | 'flat' = 'flat';
  if (delta > 2) trend = 'rising';
  else if (delta < -2) trend = 'falling';
  
  // Zone
  let zone = 'neutral';
  if (current >= 80) zone = 'overbought';
  else if (current >= 70) zone = 'high';
  else if (current <= 20) zone = 'oversold';
  else if (current <= 30) zone = 'low';
  
  // Signal chi tiết
  let signal = '';
  if (current >= 80) {
    if (trend === 'falling') {
      signal = `🔴 MFI=${current.toFixed(0)} QUÁ MUA + đang quay đầu giảm → Dòng tiền bắt đầu RÚT, cẩn thận chốt lời!`;
    } else {
      signal = `🔴 MFI=${current.toFixed(0)} QUÁ MUA → Dòng tiền vào quá mạnh, có thể điều chỉnh bất cứ lúc nào`;
    }
  } else if (current >= 70) {
    signal = `🟠 MFI=${current.toFixed(0)} vùng cao → Dòng tiền mạnh nhưng đang tiến gần vùng quá mua`;
  } else if (current <= 20) {
    if (trend === 'rising') {
      signal = `🟢 MFI=${current.toFixed(0)} QUÁ BÁN + đang hồi → Dòng tiền bắt đầu QUAY LẠI, cơ hội tích lũy!`;
    } else {
      signal = `🟢 MFI=${current.toFixed(0)} QUÁ BÁN → Dòng tiền cạn kiệt, thường sẽ hồi phục`;
    }
  } else if (current <= 30) {
    signal = `🟡 MFI=${current.toFixed(0)} vùng thấp → Dòng tiền yếu, có thể đang tích lũy`;
  } else if (current >= 50 && trend === 'rising') {
    signal = `🟢 MFI=${current.toFixed(0)} + đang tăng → Dòng tiền đang chảy vào`;
  } else if (current < 50 && trend === 'falling') {
    signal = `🔴 MFI=${current.toFixed(0)} + đang giảm → Dòng tiền đang rút ra`;
  } else {
    signal = `⚪ MFI=${current.toFixed(0)} trung tính`;
  }
  
  // Divergence: Giá tăng nhưng MFI giảm (bearish) hoặc Giá giảm nhưng MFI tăng (bullish)
  let divergence = '';
  if (data.length >= 20) {
    const priceNow = data[data.length - 1].close;
    const price5Ago = data[data.length - 6].close;
    const priceUp = priceNow > price5Ago;
    const mfiUp = current > prev5;
    
    if (priceUp && !mfiUp && current > 60) {
      divergence = `⚠️ PHÂN KỲ ÂM: Giá tăng nhưng MFI giảm (${prev5.toFixed(0)}→${current.toFixed(0)}) → Dòng tiền KHÔNG xác nhận đà tăng, cẩn thận!`;
    } else if (!priceUp && mfiUp && current < 40) {
      divergence = `🟢 PHÂN KỲ DƯƠNG: Giá giảm nhưng MFI tăng (${prev5.toFixed(0)}→${current.toFixed(0)}) → Dòng tiền đang TÍCH LŨY ngầm, có thể sắp hồi!`;
    }
  }
  
  // Money Flow Strength - Đánh giá tổng quan sức mạnh dòng tiền
  let moneyFlowStrength = '';
  if (current >= 60 && trend === 'rising') {
    moneyFlowStrength = '💰 DÒNG TIỀN MẠNH: MFI cao + đang tăng → Tiền đang đổ vào mạnh';
  } else if (current >= 50 && trend === 'rising') {
    moneyFlowStrength = '💰 Dòng tiền tích cực: MFI trên 50 + đang tăng';
  } else if (current <= 40 && trend === 'falling') {
    moneyFlowStrength = '🏃 DÒNG TIỀN RÚT: MFI thấp + đang giảm → Tiền đang rời đi';
  } else if (current <= 50 && trend === 'falling') {
    moneyFlowStrength = '🏃 Dòng tiền suy yếu: MFI dưới 50 + đang giảm';
  } else if (current >= 50) {
    moneyFlowStrength = '⚪ Dòng tiền ổn định: MFI trên 50';
  } else {
    moneyFlowStrength = '⚪ Dòng tiền trung bình';
  }
  
  return {
    value: Math.round(current * 10) / 10,
    prev: Math.round(prev * 10) / 10,
    trend,
    zone,
    signal,
    divergence,
    moneyFlowStrength,
  };
}

/**
 * Tính ADX (Average Directional Index) và DMI (Directional Movement Index)
 * ADX: Đo sức mạnh xu hướng (0-100)
 *   - ADX < 20: Không có xu hướng / sideway
 *   - ADX 20-40: Xu hướng trung bình
 *   - ADX > 40: Xu hướng mạnh
 *   - ADX > 60: Xu hướng rất mạnh
 * DMI: Xác định hướng xu hướng
 *   - +DI > -DI: Xu hướng tăng
 *   - -DI > +DI: Xu hướng giảm
 */
interface ADXResult {
  adx: number;
  plusDI: number;
  minusDI: number;
  adxTrend: string;
  dmiSignal: string;
  // ADX reversal zone detection
  adxPrev: number;           // ADX phiên trước (để biết đang tăng/giảm)
  adxDirection: 'rising' | 'falling' | 'flat'; // ADX đang tăng hay giảm
  adxReversalZone: string;   // Nhận diện vùng đảo chiều
  adxReversalWarning: string; // Cảnh báo đảo chiều xu hướng
}

function calculateADX(data: StockData[], period: number = 14): ADXResult {
  if (data.length < period + 10) {
    return { adx: 0, plusDI: 0, minusDI: 0, adxTrend: 'N/A', dmiSignal: 'Không đủ dữ liệu', adxPrev: 0, adxDirection: 'flat', adxReversalZone: '', adxReversalWarning: '' };
  }
  
  // Tính True Range, +DM, -DM cho mỗi ngày
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  
  for (let i = 1; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i - 1].close;
    const prevHigh = data[i - 1].high;
    const prevLow = data[i - 1].low;
    
    // True Range = max(H-L, |H-prevC|, |L-prevC|)
    const trVal = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    tr.push(trVal);
    
    // +DM = max(H-prevH, 0) if (H-prevH) > (prevL-L), else 0
    // -DM = max(prevL-L, 0) if (prevL-L) > (H-prevH), else 0
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    
    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
      minusDM.push(0);
    } else if (downMove > upMove && downMove > 0) {
      plusDM.push(0);
      minusDM.push(downMove);
    } else {
      plusDM.push(0);
      minusDM.push(0);
    }
  }
  
  if (tr.length < period) {
    return { adx: 0, plusDI: 0, minusDI: 0, adxTrend: 'N/A', dmiSignal: 'Không đủ dữ liệu', adxPrev: 0, adxDirection: 'flat', adxReversalZone: '', adxReversalWarning: '' };
  }
  
  // Wilder's smoothing cho ATR, +DM14, -DM14
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  
  const plusDIHistory: number[] = [];
  const minusDIHistory: number[] = [];
  const dxHistory: number[] = [];
  
  for (let i = period; i < tr.length; i++) {
    // Wilder smoothing: New = Prior - (Prior/period) + Current
    atr = atr - (atr / period) + tr[i];
    smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
    smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];
    
    // +DI và -DI
    const plusDI = atr > 0 ? (smoothPlusDM / atr) * 100 : 0;
    const minusDI = atr > 0 ? (smoothMinusDM / atr) * 100 : 0;
    
    plusDIHistory.push(plusDI);
    minusDIHistory.push(minusDI);
    
    // DX = |+DI - -DI| / (+DI + -DI) * 100
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxHistory.push(dx);
  }
  
  if (dxHistory.length < period) {
    return { adx: 0, plusDI: 0, minusDI: 0, adxTrend: 'N/A', dmiSignal: 'Không đủ dữ liệu', adxPrev: 0, adxDirection: 'flat', adxReversalZone: '', adxReversalWarning: '' };
  }
  
  // ADX = Wilder's smoothing of DX over period
  // Lưu lại ADX history để detect hướng ADX
  const adxHistory: number[] = [];
  let adx = dxHistory.slice(0, period).reduce((a, b) => a + b, 0) / period;
  adxHistory.push(adx);
  for (let i = period; i < dxHistory.length; i++) {
    adx = ((adx * (period - 1)) + dxHistory[i]) / period;
    adxHistory.push(adx);
  }
  
  const currentPlusDI = plusDIHistory[plusDIHistory.length - 1] || 0;
  const currentMinusDI = minusDIHistory[minusDIHistory.length - 1] || 0;
  const prevPlusDI = plusDIHistory[plusDIHistory.length - 2] || currentPlusDI;
  const prevMinusDI = minusDIHistory[minusDIHistory.length - 2] || currentMinusDI;
  
  // ADX hiện tại và phiên trước
  const currentADX = adxHistory[adxHistory.length - 1] || 0;
  const prevADX = adxHistory.length >= 2 ? adxHistory[adxHistory.length - 2] : currentADX;
  const prev3ADX = adxHistory.length >= 4 ? adxHistory[adxHistory.length - 4] : prevADX;
  
  // Xác định ADX đang tăng hay giảm (dùng 3 phiên để tránh noise)
  let adxDirection: 'rising' | 'falling' | 'flat' = 'flat';
  const adxDelta = currentADX - prev3ADX;
  if (adxDelta > 1.5) adxDirection = 'rising';
  else if (adxDelta < -1.5) adxDirection = 'falling';
  
  // Xác định xu hướng ADX
  let adxTrend = '⚪ Sideway / Không rõ xu hướng';
  if (adx >= 60) {
    adxTrend = currentPlusDI > currentMinusDI 
      ? '🟢🔥 Xu hướng TĂNG RẤT MẠNH' 
      : '🔴🔥 Xu hướng GIẢM RẤT MẠNH';
  } else if (adx >= 40) {
    adxTrend = currentPlusDI > currentMinusDI 
      ? '🟢 Xu hướng TĂNG MẠNH' 
      : '🔴 Xu hướng GIẢM MẠNH';
  } else if (adx >= 25) {
    adxTrend = currentPlusDI > currentMinusDI 
      ? '🟢 Xu hướng tăng' 
      : '🔴 Xu hướng giảm';
  } else if (adx >= 20) {
    // ADX 20-25: Xu hướng đang hình thành - xét +DI vs -DI để biết hướng
    adxTrend = currentPlusDI > currentMinusDI 
      ? '🟡 Xu hướng TĂNG đang hình thành' 
      : '🟡 Xu hướng GIẢM đang hình thành';
  }
  
  // Xác định DMI crossover signal
  let dmiSignal = '⚪ Không có tín hiệu';
  const crossedUp = prevPlusDI <= prevMinusDI && currentPlusDI > currentMinusDI;
  const crossedDown = prevPlusDI >= prevMinusDI && currentPlusDI < currentMinusDI;
  
  if (crossedUp && adx >= 20) {
    dmiSignal = '🟢 +DI vừa CẮT LÊN -DI → Tín hiệu MUA';
  } else if (crossedDown && adx >= 20) {
    dmiSignal = '🔴 +DI vừa CẮT XUỐNG -DI → Tín hiệu BÁN';
  } else if (currentPlusDI > currentMinusDI && adx >= 25) {
    dmiSignal = `🟢 +DI(${currentPlusDI.toFixed(1)}) > -DI(${currentMinusDI.toFixed(1)}) → Lực mua mạnh hơn`;
  } else if (currentMinusDI > currentPlusDI && adx >= 25) {
    dmiSignal = `🔴 -DI(${currentMinusDI.toFixed(1)}) > +DI(${currentPlusDI.toFixed(1)}) → Lực bán mạnh hơn`;
  }
  
  // ═══════════════════════════════════════════════════
  // ADX REVERSAL ZONE DETECTION
  // Vùng ADX thấp (10-15): xu hướng kiệt sức, sắp bùng nổ/đảo chiều
  // Vùng ADX cao (44-45+): xu hướng quá mạnh, sắp tạo đỉnh/đáy rồi đảo chiều
  // ═══════════════════════════════════════════════════
  let adxReversalZone = '';
  let adxReversalWarning = '';
  
  // VÙNG THẤP: ADX 10-15 → Thị trường nén chặt, sắp bùng nổ
  if (currentADX <= 15) {
    adxReversalZone = '🔵 VÙNG NÉN (ADX ≤ 15)';
    if (adxDirection === 'falling') {
      adxReversalWarning = `⚡ ADX đang giảm về vùng cực thấp (${currentADX.toFixed(1)}). Thị trường NÉN CHẶT, biên độ rất hẹp. Đây thường là giai đoạn TÍCH LŨY trước khi bùng nổ xu hướng mới. Theo dõi DI+ và DI- để xác định hướng breakout!`;
    } else if (adxDirection === 'rising') {
      adxReversalWarning = `⚡ ADX bắt đầu TĂNG TRỞ LẠI từ vùng thấp (${currentADX.toFixed(1)}). Xu hướng mới đang hình thành! ${currentPlusDI > currentMinusDI ? 'DI+ > DI- → Khả năng TĂNG' : 'DI- > DI+ → Khả năng GIẢM'}.`;
    } else {
      adxReversalWarning = `⚡ ADX ở vùng rất thấp (${currentADX.toFixed(1)}), thị trường đang sideway/nén. Chờ ADX bật tăng + DI crossover để xác nhận xu hướng mới.`;
    }
  }
  // VÙNG THẤP MỞ RỘNG: ADX 15-20 + đang giảm → đang tiến về vùng nén
  else if (currentADX <= 20 && adxDirection === 'falling') {
    adxReversalZone = '🟡 ADX ĐANG GIẢM VỀ VÙNG NÉN';
    adxReversalWarning = `ADX giảm từ ${prev3ADX.toFixed(1)} → ${currentADX.toFixed(1)}, xu hướng hiện tại đang suy yếu dần. Nếu ADX tiếp tục giảm về 10-15, thị trường sẽ vào giai đoạn tích lũy/nén trước khi có xu hướng mới.`;
  }
  // VÙNG CAO: ADX >= 44 → Xu hướng quá mạnh, sắp kiệt sức
  else if (currentADX >= 44) {
    adxReversalZone = '🔴 VÙNG ĐỈNH (ADX ≥ 44)';
    if (adxDirection === 'falling') {
      const trendDir = currentPlusDI > currentMinusDI ? 'TĂNG' : 'GIẢM';
      adxReversalWarning = `⚠️ ADX đã TẠO ĐỈNH và đang quay đầu giảm (${prev3ADX.toFixed(1)} → ${currentADX.toFixed(1)}). Xu hướng ${trendDir} hiện tại đang KIỆT SỨC, khả năng cao sẽ đảo chiều hoặc chuyển sang sideway. ${trendDir === 'TĂNG' ? 'Cẩn thận chốt lời, không mua đuổi!' : 'Có thể sắp hồi phục, theo dõi DI+ cắt lên DI-.'}`;
    } else {
      const trendDir = currentPlusDI > currentMinusDI ? 'TĂNG' : 'GIẢM';
      adxReversalWarning = `⚠️ ADX ở vùng rất cao (${currentADX.toFixed(1)}), xu hướng ${trendDir} đang CỰC MẠNH nhưng thường sẽ TẠO ĐỈNH ADX quanh 44-50 rồi đảo chiều. ${trendDir === 'TĂNG' ? 'Cẩn thận, không nên mua đuổi ở vùng này!' : 'Áp lực bán có thể sắp giảm bớt.'}`;
    }
  }
  // VÙNG CẢNH BÁO CAO: ADX 38-44 + đang tăng → sắp vào vùng đỉnh
  else if (currentADX >= 38 && adxDirection === 'rising') {
    adxReversalZone = '🟠 ADX ĐANG TIẾN VỀ VÙNG ĐỈNH';
    const trendDir = currentPlusDI > currentMinusDI ? 'tăng' : 'giảm';
    adxReversalWarning = `ADX tăng từ ${prev3ADX.toFixed(1)} → ${currentADX.toFixed(1)}, xu hướng ${trendDir} đang rất mạnh. Nhưng khi ADX vượt 44-45 thường sẽ tạo đỉnh rồi quay đầu. Chuẩn bị kịch bản xu hướng suy yếu.`;
  }
  // ADX CAO + đang giảm: xu hướng đang suy yếu
  else if (currentADX >= 30 && adxDirection === 'falling') {
    adxReversalZone = '🟡 XU HƯỚNG ĐANG SUY YẾU';
    const trendDir = currentPlusDI > currentMinusDI ? 'tăng' : 'giảm';
    adxReversalWarning = `ADX giảm từ ${prev3ADX.toFixed(1)} → ${currentADX.toFixed(1)}, xu hướng ${trendDir} đang mất dần sức mạnh. Có thể chuyển sang sideway hoặc đảo chiều.`;
  }
  
  return {
    adx: Math.round(adx * 10) / 10,
    plusDI: Math.round(currentPlusDI * 10) / 10,
    minusDI: Math.round(currentMinusDI * 10) / 10,
    adxTrend,
    dmiSignal,
    adxPrev: Math.round(prevADX * 10) / 10,
    adxDirection,
    adxReversalZone,
    adxReversalWarning,
  };
}

function analyzeVSA(data: StockData[]): string[] {
  if (data.length < 5) return ['⚪ Không đủ dữ liệu VSA'];
  
  const signals: string[] = [];
  
  // Lấy data gần nhất
  const latest = data[data.length - 1];
  const prev = data[data.length - 2];
  const prev2 = data[data.length - 3];
  
  // Tính trung bình
  const avgVolume = data.reduce((sum, d) => sum + d.volume, 0) / data.length;
  const avgSpread = data.reduce((sum, d) => sum + (d.high - d.low), 0) / data.length;
  
  // Các chỉ số của nến hiện tại
  const spread = latest.high - latest.low;
  const body = Math.abs(latest.close - latest.open);
  const upperWick = latest.high - Math.max(latest.close, latest.open);
  const lowerWick = Math.min(latest.close, latest.open) - latest.low;
  const volumeRatio = latest.volume / avgVolume;
  const spreadRatio = spread / avgSpread;
  const closePosition = spread > 0 ? (latest.close - latest.low) / spread : 0.5; // 0 = đóng ở đáy, 1 = đóng ở đỉnh
  
  // Nến tăng hay giảm
  const isBullish = latest.close > latest.open;
  const isBearish = latest.close < latest.open;
  const priceChange = latest.close - prev.close;
  const priceChangePercent = (priceChange / prev.close) * 100;
  
  // ═══════════════════════════════════════════════════
  // PHÂN TÍCH VSA CHI TIẾT - NGƯỠNG ĐÃ ĐIỀU CHỈNH
  // ═══════════════════════════════════════════════════
  
  // 1. CLIMAX VOLUME - Volume đột biến (nới lỏng từ 2x xuống 1.8x)
  if (volumeRatio > 1.8) {
    if (isBullish && closePosition > 0.55) {
      signals.push(`🟢 BUYING CLIMAX: Vol ${volumeRatio.toFixed(1)}x TB + Nến tăng ${priceChangePercent.toFixed(1)}% → Cầu áp đảo`);
    } else if (isBearish && closePosition < 0.45) {
      signals.push(`🔴 SELLING CLIMAX: Vol ${volumeRatio.toFixed(1)}x TB + Nến giảm ${Math.abs(priceChangePercent).toFixed(1)}% → Cung áp đảo`);
    } else if (upperWick > body * 0.8 && closePosition < 0.5) {
      signals.push(`🔴 UPTHRUST: Vol ${volumeRatio.toFixed(1)}x + Bóng trên dài + Đóng thấp → Phân phối`);
    } else if (lowerWick > body * 0.8 && closePosition > 0.5) {
      signals.push(`🟢 SPRING: Vol ${volumeRatio.toFixed(1)}x + Bóng dưới dài + Đóng cao → Tích lũy`);
    } else {
      signals.push(`🟡 HIGH VOLUME: Vol ${volumeRatio.toFixed(1)}x TB nhưng nến không rõ hướng → Chờ xác nhận`);
    }
  }
  // Volume cao vừa (1.3x - 1.8x)
  else if (volumeRatio > 1.3) {
    if (isBullish && closePosition > 0.6) {
      signals.push(`🟢 DEMAND RISING: Vol ${volumeRatio.toFixed(1)}x + Nến tăng đóng cao → Cầu đang tăng`);
    } else if (isBearish && closePosition < 0.4) {
      signals.push(`🔴 SUPPLY RISING: Vol ${volumeRatio.toFixed(1)}x + Nến giảm đóng thấp → Cung đang tăng`);
    } else if (spreadRatio < 0.7) {
      // STOPPING VOLUME
      if (priceChange < 0 && closePosition > 0.5) {
        signals.push(`🟢 STOPPING VOLUME: Vol ${volumeRatio.toFixed(1)}x + Spread hẹp + Đóng cao → Có thể đảo chiều tăng`);
      } else if (priceChange > 0 && closePosition < 0.5) {
        signals.push(`🔴 STOPPING VOLUME: Vol ${volumeRatio.toFixed(1)}x + Spread hẹp + Đóng thấp → Có thể đảo chiều giảm`);
      }
    }
  }
  
  // 2. NO DEMAND / NO SUPPLY - Volume thấp (nới lỏng từ 0.6 lên 0.7)
  if (volumeRatio < 0.7 && signals.length === 0) {
    if (isBullish && spreadRatio < 0.9) {
      signals.push(`🟡 NO DEMAND: Vol ${volumeRatio.toFixed(1)}x TB + Nến tăng nhỏ → Thiếu lực mua, cẩn thận`);
    } else if (isBearish && spreadRatio < 0.9) {
      signals.push(`🟢 NO SUPPLY: Vol ${volumeRatio.toFixed(1)}x TB + Nến giảm nhỏ → Áp lực bán yếu, có thể hồi`);
    } else if (spreadRatio < 0.5) {
      signals.push(`⚪ LOW ACTIVITY: Vol ${volumeRatio.toFixed(1)}x + Spread hẹp → Thị trường yên tĩnh, chờ breakout`);
    }
  }
  
  // 3. TEST - Kiểm tra cung/cầu (nới lỏng điều kiện)
  if (volumeRatio < 0.9 && lowerWick > body && closePosition > 0.55 && signals.length === 0) {
    signals.push(`🟢 TEST: Vol ${volumeRatio.toFixed(1)}x + Bóng dưới dài + Đóng cao → Test thành công, có thể tăng`);
  }
  
  // 4. EFFORT vs RESULT (nới lỏng)
  if (volumeRatio > 1.3 && spreadRatio < 0.7 && signals.length === 0) {
    signals.push(`🟡 EFFORT > RESULT: Vol ${volumeRatio.toFixed(1)}x nhưng Spread ${spreadRatio.toFixed(1)}x → Có lực cản`);
  }
  
  // 5. WIDE SPREAD - Spread rộng (nới lỏng từ 1.5 xuống 1.3)
  if (spreadRatio > 1.3 && signals.length === 0) {
    if (isBullish && volumeRatio > 1.1) {
      signals.push(`🟢 WIDE SPREAD UP: Spread ${spreadRatio.toFixed(1)}x + Vol ${volumeRatio.toFixed(1)}x → Cầu mạnh`);
    } else if (isBearish && volumeRatio > 1.1) {
      signals.push(`🔴 WIDE SPREAD DOWN: Spread ${spreadRatio.toFixed(1)}x + Vol ${volumeRatio.toFixed(1)}x → Cung mạnh`);
    } else if (isBullish && volumeRatio < 0.8) {
      signals.push(`🟡 WIDE SPREAD + LOW VOL: Nến tăng mạnh nhưng Vol thấp → Cẩn thận, có thể trap`);
    } else if (isBearish && volumeRatio < 0.8) {
      signals.push(`🟡 WIDE SPREAD DOWN + LOW VOL: Nến giảm mạnh nhưng Vol thấp → Có thể hồi`);
    }
  }
  
  // 6. NARROW SPREAD - Spread hẹp (tích lũy/phân phối)
  if (spreadRatio < 0.6 && volumeRatio > 0.7 && volumeRatio < 1.4 && signals.length === 0) {
    signals.push(`⚪ NARROW RANGE: Spread ${spreadRatio.toFixed(1)}x + Vol ${volumeRatio.toFixed(1)}x → Đang tích lũy/chờ breakout`);
  }
  
  // 7. So sánh với phiên trước
  const prevSpread = prev.high - prev.low;
  const prevVolume = prev.volume;
  
  if (spread > prevSpread * 1.4 && latest.volume > prevVolume * 1.2 && signals.length === 0) {
    if (isBullish) {
      signals.push(`🟢 BREAKOUT: Spread & Vol tăng mạnh so với hôm qua → Có thể bứt phá`);
    } else {
      signals.push(`🔴 BREAKDOWN: Spread & Vol tăng mạnh + Giảm giá → Có thể phá vỡ`);
    }
  }
  
  // 8. Doji / Spinning Top (nới lỏng)
  if (body < spread * 0.25 && spread > avgSpread * 0.4 && signals.length === 0) {
    if (volumeRatio > 1.1) {
      signals.push(`🟡 DOJI + HIGH VOL: Nến do dự + Vol ${volumeRatio.toFixed(1)}x → Có thể đảo chiều`);
    } else {
      signals.push(`⚪ DOJI: Nến do dự (body ${(body/spread*100).toFixed(0)}% spread) → Chờ xác nhận`);
    }
  }
  
  // 9. Close at Low/High - Đóng cửa ở đáy/đỉnh (nới lỏng)
  if (signals.length === 0) {
    if (closePosition <= 0.15 && spreadRatio > 0.7) {
      signals.push(`🔴 CLOSE AT LOW: Đóng cửa ở ${(closePosition*100).toFixed(0)}% nến → Áp lực bán mạnh cuối phiên`);
    } else if (closePosition >= 0.85 && spreadRatio > 0.7) {
      signals.push(`🟢 CLOSE AT HIGH: Đóng cửa ở ${(closePosition*100).toFixed(0)}% nến → Lực mua mạnh cuối phiên`);
    }
  }
  
  // 10. Phân tích 3 nến gần nhất
  const trend3d = latest.close - prev2.close;
  const vol3dAvg = (latest.volume + prev.volume + prev2.volume) / 3;
  const vol3dRatio = vol3dAvg / avgVolume;
  
  if (signals.length === 0) {
    if (trend3d > 0 && vol3dRatio > 1.1) {
      signals.push(`🟢 3-DAY ACCUMULATION: 3 phiên tăng + Vol ${vol3dRatio.toFixed(1)}x TB → Đang tích lũy`);
    } else if (trend3d < 0 && vol3dRatio > 1.1) {
      signals.push(`🔴 3-DAY DISTRIBUTION: 3 phiên giảm + Vol ${vol3dRatio.toFixed(1)}x TB → Đang phân phối`);
    }
  }
  
  // 11. ABSORPTION - Hấp thụ (tín hiệu mới)
  if (signals.length === 0 && volumeRatio > 1.1 && Math.abs(priceChangePercent) < 0.5) {
    if (prev.close < prev.open && isBullish) {
      signals.push(`🟢 ABSORPTION: Vol ${volumeRatio.toFixed(1)}x + Giá không giảm tiếp → Có lực mua hấp thụ`);
    } else if (prev.close > prev.open && isBearish) {
      signals.push(`🔴 ABSORPTION: Vol ${volumeRatio.toFixed(1)}x + Giá không tăng tiếp → Có lực bán hấp thụ`);
    }
  }
  
  // 12. Nếu vẫn không có tín hiệu, đưa ra nhận xét chi tiết hơn
  if (signals.length === 0) {
    // Phân tích chi tiết hơn thay vì chỉ nói "không rõ ràng"
    const volDesc = volumeRatio > 1.1 ? 'cao hơn TB' : volumeRatio < 0.9 ? 'thấp hơn TB' : 'bình thường';
    const spreadDesc = spreadRatio > 1.1 ? 'rộng' : spreadRatio < 0.9 ? 'hẹp' : 'bình thường';
    const closeDesc = closePosition > 0.6 ? 'đóng cao' : closePosition < 0.4 ? 'đóng thấp' : 'đóng giữa';
    
    if (isBullish) {
      signals.push(`⚪ NEUTRAL BULLISH: Nến tăng ${priceChangePercent.toFixed(1)}% | Vol ${volumeRatio.toFixed(1)}x (${volDesc}) | Spread ${spreadRatio.toFixed(1)}x (${spreadDesc}) | ${closeDesc}`);
    } else if (isBearish) {
      signals.push(`⚪ NEUTRAL BEARISH: Nến giảm ${Math.abs(priceChangePercent).toFixed(1)}% | Vol ${volumeRatio.toFixed(1)}x (${volDesc}) | Spread ${spreadRatio.toFixed(1)}x (${spreadDesc}) | ${closeDesc}`);
    } else {
      signals.push(`⚪ NEUTRAL: Nến Doji | Vol ${volumeRatio.toFixed(1)}x (${volDesc}) | Spread ${spreadRatio.toFixed(1)}x (${spreadDesc})`);
    }
  }
  
  return signals;
}

// ═══════════════════════════════════════════════════
// CANDLESTICK PATTERN RECOGNITION
// Nhận diện các mẫu hình nến đảo chiều/tiếp diễn
// ═══════════════════════════════════════════════════

interface CandlestickPattern {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  signal: string;
  confidence: number; // 1-3 (1=yếu, 2=trung bình, 3=mạnh)
}

function analyzeCandlestickPatterns(data: StockData[]): CandlestickPattern[] {
  if (data.length < 5) return [];
  
  const patterns: CandlestickPattern[] = [];
  
  // Lấy 5 nến gần nhất
  const c0 = data[data.length - 1]; // Nến hiện tại
  const c1 = data[data.length - 2]; // Nến trước
  const c2 = data[data.length - 3]; // 2 nến trước
  const c3 = data[data.length - 4]; // 3 nến trước
  
  // Helper functions
  const body = (c: StockData) => Math.abs(c.close - c.open);
  const spread = (c: StockData) => c.high - c.low;
  const upperWick = (c: StockData) => c.high - Math.max(c.close, c.open);
  const lowerWick = (c: StockData) => Math.min(c.close, c.open) - c.low;
  const isBullish = (c: StockData) => c.close > c.open;
  const isBearish = (c: StockData) => c.close < c.open;
  const midPoint = (c: StockData) => (c.high + c.low) / 2;
  
  // Trung bình body và spread gần đây
  const avgBody = data.slice(-20).reduce((sum, d) => sum + body(d), 0) / 20;
  const avgSpread = data.slice(-20).reduce((sum, d) => sum + spread(d), 0) / 20;
  
  // ═══════════════════════════════════════════════════
  // 1. HAMMER (Búa) - Bullish reversal
  // Body nhỏ ở trên, bóng dưới dài >= 2x body, bóng trên nhỏ
  // ═══════════════════════════════════════════════════
  const isHammer = () => {
    const b = body(c0);
    const s = spread(c0);
    const lw = lowerWick(c0);
    const uw = upperWick(c0);
    
    return (
      s > 0 &&
      b > 0 &&
      lw >= b * 2 && // Bóng dưới >= 2x body
      uw < b * 0.5 && // Bóng trên nhỏ
      c0.close > c0.low + s * 0.6 // Đóng cửa ở phần trên nến
    );
  };
  
  if (isHammer()) {
    // Kiểm tra context - cần trong downtrend
    const downtrend = c1.close < c2.close && c2.close < c3.close;
    if (downtrend || c0.low === Math.min(...data.slice(-10).map(d => d.low))) {
      patterns.push({
        name: 'HAMMER 🔨',
        type: 'bullish',
        signal: 'Nến Búa xuất hiện sau nhịp giảm → Tín hiệu đảo chiều tăng tiềm năng',
        confidence: 2,
      });
    }
  }
  
  // ═══════════════════════════════════════════════════
  // 2. INVERTED HAMMER (Búa ngược) - Bullish reversal
  // Body nhỏ ở dưới, bóng trên dài >= 2x body, bóng dưới nhỏ
  // ═══════════════════════════════════════════════════
  const isInvertedHammer = () => {
    const b = body(c0);
    const s = spread(c0);
    const lw = lowerWick(c0);
    const uw = upperWick(c0);
    
    return (
      s > 0 &&
      b > 0 &&
      uw >= b * 2 && // Bóng trên >= 2x body
      lw < b * 0.5 && // Bóng dưới nhỏ
      c0.close < c0.high - s * 0.6 // Đóng cửa ở phần dưới nến
    );
  };
  
  if (isInvertedHammer() && !patterns.some(p => p.name.includes('HAMMER'))) {
    const downtrend = c1.close < c2.close && c2.close < c3.close;
    if (downtrend) {
      patterns.push({
        name: 'INVERTED HAMMER 🔨',
        type: 'bullish',
        signal: 'Búa ngược sau nhịp giảm → Có thể hồi phục, cần xác nhận phiên sau',
        confidence: 1,
      });
    }
  }
  
  // ═══════════════════════════════════════════════════
  // 3. SHOOTING STAR (Sao băng) - Bearish reversal
  // Giống inverted hammer nhưng sau uptrend
  // ═══════════════════════════════════════════════════
  if (isInvertedHammer() && !patterns.some(p => p.name.includes('HAMMER'))) {
    const uptrend = c1.close > c2.close && c2.close > c3.close;
    if (uptrend) {
      patterns.push({
        name: 'SHOOTING STAR ⭐',
        type: 'bearish',
        signal: 'Sao băng sau nhịp tăng → Tín hiệu đảo chiều giảm, cẩn thận!',
        confidence: 2,
      });
    }
  }
  
  // ═══════════════════════════════════════════════════
  // 4. DOJI - Indecision
  // Body rất nhỏ so với spread
  // ═══════════════════════════════════════════════════
  const isDoji = () => body(c0) < spread(c0) * 0.1 && spread(c0) > avgSpread * 0.5;
  
  if (isDoji()) {
    const uw = upperWick(c0);
    const lw = lowerWick(c0);
    
    if (lw > uw * 2 && lw > spread(c0) * 0.6) {
      // Dragonfly Doji - Bullish
      patterns.push({
        name: 'DRAGONFLY DOJI 🪷',
        type: 'bullish',
        signal: 'Doji Chuồn chuồn → Lực mua đẩy giá lên từ đáy, có thể hồi',
        confidence: 2,
      });
    } else if (uw > lw * 2 && uw > spread(c0) * 0.6) {
      // Gravestone Doji - Bearish
      patterns.push({
        name: 'GRAVESTONE DOJI 🪦',
        type: 'bearish',
        signal: 'Doji Bia mộ → Lực bán đẩy giá xuống từ đỉnh, cẩn thận!',
        confidence: 2,
      });
    } else {
      // Regular Doji
      patterns.push({
        name: 'DOJI ✚',
        type: 'neutral',
        signal: 'Nến Doji → Thị trường do dự, chờ tín hiệu xác nhận phiên sau',
        confidence: 1,
      });
    }
  }
  
  // ═══════════════════════════════════════════════════
  // 5. BULLISH ENGULFING - Strong bullish reversal
  // Nến tăng nuốt hoàn toàn nến giảm trước đó
  // ═══════════════════════════════════════════════════
  const isBullishEngulfing = () => {
    return (
      isBearish(c1) && // Nến trước giảm
      isBullish(c0) && // Nến hiện tại tăng
      c0.open <= c1.close && // Mở thấp hơn hoặc bằng close nến trước
      c0.close > c1.open && // Đóng cao hơn open nến trước
      body(c0) > body(c1) * 1.2 // Body lớn hơn 20%
    );
  };
  
  if (isBullishEngulfing()) {
    patterns.push({
      name: 'BULLISH ENGULFING 🟢',
      type: 'bullish',
      signal: 'Nến Nhấn chìm Tăng → Tín hiệu đảo chiều MẠNH, lực mua áp đảo!',
      confidence: 3,
    });
  }
  
  // ═══════════════════════════════════════════════════
  // 6. BEARISH ENGULFING - Strong bearish reversal
  // Nến giảm nuốt hoàn toàn nến tăng trước đó
  // ═══════════════════════════════════════════════════
  const isBearishEngulfing = () => {
    return (
      isBullish(c1) && // Nến trước tăng
      isBearish(c0) && // Nến hiện tại giảm
      c0.open >= c1.close && // Mở cao hơn hoặc bằng close nến trước
      c0.close < c1.open && // Đóng thấp hơn open nến trước
      body(c0) > body(c1) * 1.2 // Body lớn hơn 20%
    );
  };
  
  if (isBearishEngulfing()) {
    patterns.push({
      name: 'BEARISH ENGULFING 🔴',
      type: 'bearish',
      signal: 'Nến Nhấn chìm Giảm → Tín hiệu đảo chiều MẠNH, lực bán áp đảo!',
      confidence: 3,
    });
  }
  
  // ═══════════════════════════════════════════════════
  // 7. MORNING STAR - Bullish reversal (3 nến)
  // Nến giảm lớn → Nến nhỏ (gap) → Nến tăng lớn
  // ═══════════════════════════════════════════════════
  const isMorningStar = () => {
    return (
      isBearish(c2) && body(c2) > avgBody && // Nến 1: giảm lớn
      body(c1) < avgBody * 0.5 && // Nến 2: body nhỏ (Star)
      c1.high < c2.close && // Gap down
      isBullish(c0) && body(c0) > avgBody && // Nến 3: tăng lớn
      c0.close > (c2.open + c2.close) / 2 // Đóng trên 50% nến 1
    );
  };
  
  if (isMorningStar()) {
    patterns.push({
      name: 'MORNING STAR 🌟',
      type: 'bullish',
      signal: 'Sao Mai (3 nến) → Tín hiệu đảo chiều tăng RẤT MẠNH!',
      confidence: 3,
    });
  }
  
  // ═══════════════════════════════════════════════════
  // 8. EVENING STAR - Bearish reversal (3 nến)
  // Nến tăng lớn → Nến nhỏ (gap) → Nến giảm lớn
  // ═══════════════════════════════════════════════════
  const isEveningStar = () => {
    return (
      isBullish(c2) && body(c2) > avgBody && // Nến 1: tăng lớn
      body(c1) < avgBody * 0.5 && // Nến 2: body nhỏ (Star)
      c1.low > c2.close && // Gap up
      isBearish(c0) && body(c0) > avgBody && // Nến 3: giảm lớn
      c0.close < (c2.open + c2.close) / 2 // Đóng dưới 50% nến 1
    );
  };
  
  if (isEveningStar()) {
    patterns.push({
      name: 'EVENING STAR 🌙',
      type: 'bearish',
      signal: 'Sao Hôm (3 nến) → Tín hiệu đảo chiều giảm RẤT MẠNH!',
      confidence: 3,
    });
  }
  
  // ═══════════════════════════════════════════════════
  // 9. THREE WHITE SOLDIERS - Strong bullish continuation
  // 3 nến tăng liên tiếp, mỗi nến đóng gần high
  // ═══════════════════════════════════════════════════
  const isThreeWhiteSoldiers = () => {
    return (
      isBullish(c0) && isBullish(c1) && isBullish(c2) && // 3 nến tăng
      body(c0) > avgBody * 0.7 && body(c1) > avgBody * 0.7 && body(c2) > avgBody * 0.7 && // Body đủ lớn
      c0.close > c1.close && c1.close > c2.close && // Đóng cao hơn
      upperWick(c0) < body(c0) * 0.3 && upperWick(c1) < body(c1) * 0.3 // Bóng trên nhỏ
    );
  };
  
  if (isThreeWhiteSoldiers()) {
    patterns.push({
      name: 'THREE WHITE SOLDIERS 🪖🪖🪖',
      type: 'bullish',
      signal: 'Ba chiến binh trắng → Xu hướng tăng MẠNH, dòng tiền vào mạnh!',
      confidence: 3,
    });
  }
  
  // ═══════════════════════════════════════════════════
  // 10. THREE BLACK CROWS - Strong bearish continuation
  // 3 nến giảm liên tiếp, mỗi nến đóng gần low
  // ═══════════════════════════════════════════════════
  const isThreeBlackCrows = () => {
    return (
      isBearish(c0) && isBearish(c1) && isBearish(c2) && // 3 nến giảm
      body(c0) > avgBody * 0.7 && body(c1) > avgBody * 0.7 && body(c2) > avgBody * 0.7 && // Body đủ lớn
      c0.close < c1.close && c1.close < c2.close && // Đóng thấp hơn
      lowerWick(c0) < body(c0) * 0.3 && lowerWick(c1) < body(c1) * 0.3 // Bóng dưới nhỏ
    );
  };
  
  if (isThreeBlackCrows()) {
    patterns.push({
      name: 'THREE BLACK CROWS 🐦‍⬛🐦‍⬛🐦‍⬛',
      type: 'bearish',
      signal: 'Ba con quạ đen → Xu hướng giảm MẠNH, dòng tiền tháo chạy!',
      confidence: 3,
    });
  }
  
  return patterns;
}

// ═══════════════════════════════════════════════════
// FIBONACCI RETRACEMENT LEVELS
// Xác định các vùng hỗ trợ/kháng cự Fibonacci
// ═══════════════════════════════════════════════════

interface FibonacciLevel {
  name: string;
  value: number;
  percentage: number;
}

interface FibonacciResult {
  swingHigh: number;
  swingHighDate: string;
  swingLow: number;
  swingLowDate: string;
  isUpswing: boolean; // true = đang trong nhịp tăng (tính từ low đến high)
  levels: FibonacciLevel[];
  nearestSupport: FibonacciLevel | null;
  nearestResistance: FibonacciLevel | null;
  currentZone: string;
  // Fibonacci Extension - Dự phóng target
  extensions: FibonacciLevel[];
  targetByFib: number;        // Target dự phóng từ Fibonacci Extension
  targetDescription: string;  // Mô tả target
}

function calculateFibonacciLevels(data: StockData[]): FibonacciResult | null {
  if (data.length < 30) return null;
  
  // Lấy 60-90 ngày gần nhất để tìm swing points
  const lookback = Math.min(90, data.length);
  const recentData = data.slice(-lookback);
  const currentPrice = data[data.length - 1].close;
  
  // Tìm swing high và swing low
  let swingHigh = recentData[0].high;
  let swingHighDate = recentData[0].date;
  let swingHighIdx = 0;
  let swingLow = recentData[0].low;
  let swingLowDate = recentData[0].date;
  let swingLowIdx = 0;
  
  for (let i = 0; i < recentData.length; i++) {
    if (recentData[i].high > swingHigh) {
      swingHigh = recentData[i].high;
      swingHighDate = recentData[i].date;
      swingHighIdx = i;
    }
    if (recentData[i].low < swingLow) {
      swingLow = recentData[i].low;
      swingLowDate = recentData[i].date;
      swingLowIdx = i;
    }
  }
  
  // Xác định upswing hay downswing (dựa vào swing nào xảy ra sau)
  const isUpswing = swingHighIdx > swingLowIdx;
  
  // Tính các mức Fibonacci Retracement
  const range = swingHigh - swingLow;
  const fibRatios = [
    { name: 'Fib 0%', percentage: 0 },
    { name: 'Fib 23.6%', percentage: 0.236 },
    { name: 'Fib 38.2%', percentage: 0.382 },
    { name: 'Fib 50%', percentage: 0.5 },
    { name: 'Fib 61.8%', percentage: 0.618 },
    { name: 'Fib 78.6%', percentage: 0.786 },
    { name: 'Fib 100%', percentage: 1 },
  ];
  
  let levels: FibonacciLevel[];
  
  if (isUpswing) {
    // Đang trong upswing → Fibonacci retracement từ high xuống
    // 0% = swingHigh, 100% = swingLow
    levels = fibRatios.map(fib => ({
      name: fib.name,
      value: swingHigh - range * fib.percentage,
      percentage: fib.percentage,
    }));
  } else {
    // Đang trong downswing → Fibonacci retracement từ low lên
    // 0% = swingLow, 100% = swingHigh
    levels = fibRatios.map(fib => ({
      name: fib.name,
      value: swingLow + range * fib.percentage,
      percentage: fib.percentage,
    }));
  }
  
  // ═══════════════════════════════════════════════════
  // FIBONACCI EXTENSION - Dự phóng target
  // Dùng khi giá đang trong upswing và có khả năng breakout
  // ═══════════════════════════════════════════════════
  const fibExtRatios = [
    { name: 'Fib Ext 100%', percentage: 1.0 },
    { name: 'Fib Ext 127.2%', percentage: 1.272 },
    { name: 'Fib Ext 161.8%', percentage: 1.618 },
    { name: 'Fib Ext 200%', percentage: 2.0 },
    { name: 'Fib Ext 261.8%', percentage: 2.618 },
  ];
  
  // Tính Fibonacci Extension từ swing low
  // Target = swingLow + range * extension_ratio
  const extensions: FibonacciLevel[] = fibExtRatios.map(fib => ({
    name: fib.name,
    value: swingLow + range * fib.percentage,
    percentage: fib.percentage,
  }));
  
  // Tìm target gần nhất từ Fibonacci Extension (target > currentPrice)
  let targetByFib = 0;
  let targetDescription = '';
  
  for (const ext of extensions) {
    if (ext.value > currentPrice && targetByFib === 0) {
      targetByFib = ext.value;
      const upside = ((ext.value - currentPrice) / currentPrice * 100).toFixed(1);
      targetDescription = `🎯 Target theo ${ext.name}: ${ext.value.toLocaleString('vi-VN')} (+${upside}%)`;
      break;
    }
  }
  
  // Nếu giá đã vượt tất cả extension, dùng extension cao nhất
  if (targetByFib === 0 && extensions.length > 0) {
    const highestExt = extensions[extensions.length - 1];
    targetByFib = highestExt.value;
    targetDescription = `🚀 Giá đã vượt các mức Fib Extension! Target tiếp theo: ${highestExt.name}`;
  }
  
  // Tìm vùng Fib gần nhất với giá hiện tại
  let nearestSupport: FibonacciLevel | null = null;
  let nearestResistance: FibonacciLevel | null = null;
  
  // Sắp xếp theo value
  const sortedLevels = [...levels].sort((a, b) => a.value - b.value);
  
  for (let i = 0; i < sortedLevels.length; i++) {
    if (sortedLevels[i].value < currentPrice) {
      nearestSupport = sortedLevels[i];
    }
    if (sortedLevels[i].value > currentPrice && !nearestResistance) {
      nearestResistance = sortedLevels[i];
    }
  }
  
  // Xác định vùng giá hiện tại
  let currentZone = 'Chưa xác định';
  if (nearestSupport && nearestResistance) {
    const supportDist = currentPrice - nearestSupport.value;
    const resistDist = nearestResistance.value - currentPrice;
    
    if (supportDist < range * 0.03) {
      currentZone = `Gần hỗ trợ ${nearestSupport.name}`;
    } else if (resistDist < range * 0.03) {
      currentZone = `Gần kháng cự ${nearestResistance.name}`;
    } else {
      currentZone = `Giữa ${nearestSupport.name} và ${nearestResistance.name}`;
    }
  }
  
  return {
    swingHigh,
    swingHighDate,
    swingLow,
    swingLowDate,
    isUpswing,
    levels,
    nearestSupport,
    nearestResistance,
    currentZone,
    extensions,
    targetByFib,
    targetDescription,
  };
}

// ═══════════════════════════════════════════════════
// DIVERGENCE DETECTION
// Phát hiện phân kỳ giữa giá và RSI/MACD
// ═══════════════════════════════════════════════════

interface DivergenceSignal {
  type: 'bullish' | 'bearish' | null;
  indicator: string;
  signal: string;
  confidence: number; // 1-3
}

interface DivergenceResult {
  rsiDivergence: DivergenceSignal;
  macdDivergence: DivergenceSignal;
  hasDivergence: boolean;
}

function detectDivergence(data: StockData[]): DivergenceResult {
  const result: DivergenceResult = {
    rsiDivergence: { type: null, indicator: 'RSI', signal: '', confidence: 0 },
    macdDivergence: { type: null, indicator: 'MACD', signal: '', confidence: 0 },
    hasDivergence: false,
  };
  
  if (data.length < 30) return result;
  
  // Tính RSI cho 20 ngày gần nhất
  const rsiValues: number[] = [];
  for (let i = 14; i <= 20; i++) {
    const slice = data.slice(0, data.length - 20 + i);
    if (slice.length >= 15) {
      rsiValues.push(calculateRSIValue(slice));
    }
  }
  
  if (rsiValues.length < 5) return result;
  
  // Lấy dữ liệu giá tương ứng
  const priceData = data.slice(-rsiValues.length);
  
  // Tìm local peaks và troughs trong giá
  const pricePeaks: { idx: number; value: number }[] = [];
  const priceTroughs: { idx: number; value: number }[] = [];
  
  for (let i = 1; i < priceData.length - 1; i++) {
    if (priceData[i].high > priceData[i - 1].high && priceData[i].high > priceData[i + 1].high) {
      pricePeaks.push({ idx: i, value: priceData[i].high });
    }
    if (priceData[i].low < priceData[i - 1].low && priceData[i].low < priceData[i + 1].low) {
      priceTroughs.push({ idx: i, value: priceData[i].low });
    }
  }
  
  // Tìm local peaks và troughs trong RSI
  const rsiPeaks: { idx: number; value: number }[] = [];
  const rsiTroughs: { idx: number; value: number }[] = [];
  
  for (let i = 1; i < rsiValues.length - 1; i++) {
    if (rsiValues[i] > rsiValues[i - 1] && rsiValues[i] > rsiValues[i + 1]) {
      rsiPeaks.push({ idx: i, value: rsiValues[i] });
    }
    if (rsiValues[i] < rsiValues[i - 1] && rsiValues[i] < rsiValues[i + 1]) {
      rsiTroughs.push({ idx: i, value: rsiValues[i] });
    }
  }
  
  // ═══════════════════════════════════════════════════
  // Phát hiện BULLISH DIVERGENCE (RSI)
  // Giá tạo đáy thấp hơn, RSI tạo đáy cao hơn
  // ═══════════════════════════════════════════════════
  if (priceTroughs.length >= 2 && rsiTroughs.length >= 2) {
    const lastPriceTrough = priceTroughs[priceTroughs.length - 1];
    const prevPriceTrough = priceTroughs[priceTroughs.length - 2];
    const lastRsiTrough = rsiTroughs[rsiTroughs.length - 1];
    const prevRsiTrough = rsiTroughs[rsiTroughs.length - 2];
    
    // Kiểm tra đáy giá thấp hơn nhưng đáy RSI cao hơn
    if (
      lastPriceTrough.value < prevPriceTrough.value &&
      lastRsiTrough.value > prevRsiTrough.value &&
      Math.abs(lastPriceTrough.idx - lastRsiTrough.idx) <= 2 // Xảy ra gần nhau
    ) {
      result.rsiDivergence = {
        type: 'bullish',
        indicator: 'RSI',
        signal: '🟢 PHÂN KỲ TĂNG RSI: Giá tạo đáy thấp hơn nhưng RSI tạo đáy cao hơn → Momentum đang cải thiện, có thể hồi!',
        confidence: 2,
      };
      result.hasDivergence = true;
    }
  }
  
  // ═══════════════════════════════════════════════════
  // Phát hiện BEARISH DIVERGENCE (RSI)
  // Giá tạo đỉnh cao hơn, RSI tạo đỉnh thấp hơn
  // ═══════════════════════════════════════════════════
  if (pricePeaks.length >= 2 && rsiPeaks.length >= 2 && !result.rsiDivergence.type) {
    const lastPricePeak = pricePeaks[pricePeaks.length - 1];
    const prevPricePeak = pricePeaks[pricePeaks.length - 2];
    const lastRsiPeak = rsiPeaks[rsiPeaks.length - 1];
    const prevRsiPeak = rsiPeaks[rsiPeaks.length - 2];
    
    // Kiểm tra đỉnh giá cao hơn nhưng đỉnh RSI thấp hơn
    if (
      lastPricePeak.value > prevPricePeak.value &&
      lastRsiPeak.value < prevRsiPeak.value &&
      Math.abs(lastPricePeak.idx - lastRsiPeak.idx) <= 2
    ) {
      result.rsiDivergence = {
        type: 'bearish',
        indicator: 'RSI',
        signal: '🔴 PHÂN KỲ GIẢM RSI: Giá tạo đỉnh cao hơn nhưng RSI tạo đỉnh thấp hơn → Momentum suy yếu, cẩn thận!',
        confidence: 2,
      };
      result.hasDivergence = true;
    }
  }
  
  // ═══════════════════════════════════════════════════
  // MACD Divergence theo Alexander Elder
  // Phuong phap: Tim cum histogram (A-B-C) qua zero-line crossings
  // So sanh dinh/day cum voi dinh/day gia tuong ung
  // ═══════════════════════════════════════════════════
  const lookback = Math.min(60, data.length);
  const histSeries: number[] = [];
  const histPrices: StockData[] = data.slice(-lookback);

  // Tinh full histogram series
  for (let i = 0; i < lookback; i++) {
    const slice = data.slice(0, data.length - lookback + i + 1);
    if (slice.length >= 35) {
      const m = calculateMACD(slice);
      histSeries.push(m.histogram);
    } else {
      histSeries.push(0);
    }
  }

  if (histSeries.length >= 20) {
    // Tim cac cum histogram bang zero-line crossings
    // Moi cum la 1 doan histogram lien tuc cung dau (+ hoac -)
    interface HistCluster {
      startIdx: number;
      endIdx: number;
      peak: number;       // Gia tri cuc tri (dinh neu +, day neu -)
      peakIdx: number;     // Vi tri cuc tri trong histSeries
      isPositive: boolean; // Cum duong hay am
      priceAtPeak: number; // Gia tai vi tri cuc tri
      priceLow: number;    // Gia thap nhat trong cum
      priceHigh: number;   // Gia cao nhat trong cum
    }

    const clusters: HistCluster[] = [];
    let clusterStart = 0;

    for (let i = 1; i <= histSeries.length; i++) {
      // Detect zero-line crossing hoac het data
      const prev = histSeries[i - 1];
      const curr = i < histSeries.length ? histSeries[i] : -prev; // Force close last cluster
      const crossed = (prev >= 0 && curr < 0) || (prev < 0 && curr >= 0) || i === histSeries.length;

      if (crossed && i - clusterStart >= 2) {
        const segment = histSeries.slice(clusterStart, i);
        const isPositive = segment[0] >= 0;

        // Tim cuc tri trong cum
        let peak = segment[0];
        let peakLocalIdx = 0;
        for (let j = 1; j < segment.length; j++) {
          if (isPositive ? segment[j] > peak : segment[j] < peak) {
            peak = segment[j];
            peakLocalIdx = j;
          }
        }

        const peakIdx = clusterStart + peakLocalIdx;
        const priceSlice = histPrices.slice(clusterStart, i);
        const priceLow = Math.min(...priceSlice.map(p => p.low));
        const priceHigh = Math.max(...priceSlice.map(p => p.high));

        clusters.push({
          startIdx: clusterStart,
          endIdx: i - 1,
          peak,
          peakIdx,
          isPositive,
          priceAtPeak: histPrices[peakIdx]?.close || 0,
          priceLow,
          priceHigh,
        });
      }

      if (crossed) clusterStart = i;
    }

    // Tim 2 cum am gan nhat de detect bullish divergence (Elder)
    // Gia tao day thap hon nhung histogram day nong hon (cao hon) = phan ky duong
    const negClusters = clusters.filter(c => !c.isPositive);
    if (negClusters.length >= 2) {
      const clusterC = negClusters[negClusters.length - 1]; // Cum gan nhat
      const clusterA = negClusters[negClusters.length - 2]; // Cum truoc do

      // Elder: day histogram C nong hon day A (gan zero hon) = luc ban yeu di
      // Dong thoi gia tao day thap hon = phan ky duong (bullish divergence)
      if (clusterC.peak > clusterA.peak && clusterC.priceLow < clusterA.priceLow) {
        const confidence = clusterC.endIdx >= histSeries.length - 5 ? 3 : 2; // Manh hon neu gan hien tai
        result.macdDivergence = {
          type: 'bullish',
          indicator: 'MACD-Histogram (Elder)',
          signal: `🟢 PHÂN KỲ DƯƠNG (Elder): Giá tạo đáy thấp hơn nhưng MACD-H đáy nông hơn (${clusterA.peak.toFixed(2)} → ${clusterC.peak.toFixed(2)}) → Lực bán suy yếu, tín hiệu đảo chiều tăng!`,
          confidence,
        };
        result.hasDivergence = true;
      }
    }

    // Tim 2 cum duong gan nhat de detect bearish divergence (Elder)
    // Gia tao dinh cao hon nhung histogram dinh thap hon = phan ky am
    if (!result.macdDivergence.type) {
      const posClusters = clusters.filter(c => c.isPositive);
      if (posClusters.length >= 2) {
        const clusterC = posClusters[posClusters.length - 1];
        const clusterA = posClusters[posClusters.length - 2];

        if (clusterC.peak < clusterA.peak && clusterC.priceHigh > clusterA.priceHigh) {
          const confidence = clusterC.endIdx >= histSeries.length - 5 ? 3 : 2;
          result.macdDivergence = {
            type: 'bearish',
            indicator: 'MACD-Histogram (Elder)',
            signal: `🔴 PHÂN KỲ ÂM (Elder): Giá tạo đỉnh cao hơn nhưng MACD-H đỉnh thấp hơn (${clusterA.peak.toFixed(2)} → ${clusterC.peak.toFixed(2)}) → Lực mua suy yếu, cẩn thận đảo chiều giảm!`,
            confidence,
          };
          result.hasDivergence = true;
        }
      }
    }

    // ═══════════════════════════════════════════════════
    // Elder ABC Pattern — Xac lap day CP
    // Cum A (am sau) → Cum B (duong ngan) → Cum C (am nong hon A)
    // Neu cum C day nong hon cum A + gia thap hon = day dang xac lap
    // ═══════════════════════════════════════════════════
    if (clusters.length >= 3 && !result.macdDivergence.type) {
      // Tim pattern: am → duong → am (A-B-C) trong 3 cum cuoi
      for (let i = clusters.length - 1; i >= 2; i--) {
        const cC = clusters[i];
        const cB = clusters[i - 1];
        const cA = clusters[i - 2];

        // A am, B duong, C am
        if (!cA.isPositive && cB.isPositive && !cC.isPositive) {
          // Cum C day nong hon cum A (it am hon = luc ban yeu di)
          if (cC.peak > cA.peak) {
            const hasPriceDivergence = cC.priceLow < cA.priceLow; // Gia thap hon = phan ky
            const confidence = cC.endIdx >= histSeries.length - 5 ? 3 : 2;

            if (hasPriceDivergence) {
              // ABC + phan ky duong = tin hieu manh nhat
              result.macdDivergence = {
                type: 'bullish',
                indicator: 'MACD-Histogram (Elder ABC)',
                signal: `🟢 ELDER ABC + PHÂN KỲ DƯƠNG: Cụm C đáy nông hơn A (${cA.peak.toFixed(2)} → ${cC.peak.toFixed(2)}) + giá đáy thấp hơn → Lực bán cạn kiệt, đáy đang xác lập!`,
                confidence: 3,
              };
            } else {
              // ABC khong co phan ky — van la tin hieu day nhung yeu hon
              result.macdDivergence = {
                type: 'bullish',
                indicator: 'MACD-Histogram (Elder ABC)',
                signal: `🟡 ELDER ABC: Cụm C đáy nông hơn A (${cA.peak.toFixed(2)} → ${cC.peak.toFixed(2)}) → Lực bán suy yếu, có khả năng xác lập đáy. Chờ MACD cắt lên Signal để xác nhận.`,
                confidence,
              };
            }
            result.hasDivergence = true;
            break;
          }
        }
      }
    }
  }
  
  return result;
}

// Helper: Tính RSI value cho divergence detection
function calculateRSIValue(data: StockData[]): number {
  const period = 14;
  if (data.length < period + 1) return 50;
  
  let avgGain = 0;
  let avgLoss = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = data[i].close - data[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  
  for (let i = period + 1; i < data.length; i++) {
    const change = data[i].close - data[i - 1].close;
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ═══════════════════════════════════════════════════
// TRENDLINE DETECTION - Phát hiện đường xu hướng dài hạn
// Kết nối các pivot highs/lows trên dữ liệu weekly để tìm
// đường kháng cự/hỗ trợ dài hạn (như trendline từ 2009)
// ═══════════════════════════════════════════════════

interface Trendline {
  type: 'support' | 'resistance'; // Loại trendline
  startDate: string;              // Ngày bắt đầu
  endDate: string;                // Ngày kết thúc (pivot cuối)
  startPrice: number;             // Giá tại điểm bắt đầu
  endPrice: number;               // Giá tại điểm kết thúc
  currentValue: number;           // Giá trị trendline tại thời điểm hiện tại
  slope: number;                  // Độ dốc (điểm/tuần)
  touchCount: number;             // Số lần giá chạm trendline
  strength: number;               // Độ mạnh (0-100): dựa trên touchCount, thời gian, độ chính xác
  distancePercent: number;        // % khoảng cách từ giá hiện tại đến trendline
  isApproaching: boolean;         // Giá đang tiến gần trendline (< 3%)
  label: string;                  // Mô tả ngắn gọn
}

interface TrendlineResult {
  trendlines: Trendline[];                    // Tất cả trendlines phát hiện được
  nearestResistanceTrendline: Trendline | null; // Trendline kháng cự gần nhất
  nearestSupportTrendline: Trendline | null;    // Trendline hỗ trợ gần nhất
  warning: string;                             // Cảnh báo nếu giá gần trendline quan trọng
  weeklyDataPoints: number;                    // Số tuần dữ liệu
}

/**
 * Chuyển dữ liệu daily sang weekly (OHLCV tuần)
 */
function convertToWeekly(dailyData: StockData[]): StockData[] {
  if (dailyData.length === 0) return [];
  
  const weeks: StockData[] = [];
  let weekOpen = dailyData[0].open;
  let weekHigh = dailyData[0].high;
  let weekLow = dailyData[0].low;
  let weekClose = dailyData[0].close;
  let weekVolume = dailyData[0].volume;
  let weekDate = dailyData[0].date;
  let currentWeek = getWeekNumber(dailyData[0].date);
  
  for (let i = 1; i < dailyData.length; i++) {
    const d = dailyData[i];
    const week = getWeekNumber(d.date);
    
    if (week !== currentWeek) {
      // Lưu tuần trước
      weeks.push({
        date: weekDate,
        open: weekOpen,
        high: weekHigh,
        low: weekLow,
        close: weekClose,
        volume: weekVolume,
      });
      // Bắt đầu tuần mới
      weekOpen = d.open;
      weekHigh = d.high;
      weekLow = d.low;
      weekClose = d.close;
      weekVolume = d.volume;
      weekDate = d.date;
      currentWeek = week;
    } else {
      weekHigh = Math.max(weekHigh, d.high);
      weekLow = Math.min(weekLow, d.low);
      weekClose = d.close;
      weekVolume += d.volume;
    }
  }
  // Tuần cuối
  weeks.push({
    date: weekDate,
    open: weekOpen,
    high: weekHigh,
    low: weekLow,
    close: weekClose,
    volume: weekVolume,
  });
  
  return weeks;
}

function getWeekNumber(dateStr: string): string {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${year}-W${weekNum}`;
}

/**
 * Tìm các pivot points (đỉnh/đáy cục bộ) trên dữ liệu weekly
 * @param data Dữ liệu weekly
 * @param lookback Số tuần nhìn trước/sau để xác định pivot (mặc định 5)
 */
function findPivotPoints(data: StockData[], lookback: number = 5): {
  pivotHighs: { index: number; price: number; date: string }[];
  pivotLows: { index: number; price: number; date: string }[];
} {
  const pivotHighs: { index: number; price: number; date: string }[] = [];
  const pivotLows: { index: number; price: number; date: string }[] = [];
  
  for (let i = lookback; i < data.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    
    for (let j = 1; j <= lookback; j++) {
      if (data[i].high <= data[i - j].high || data[i].high <= data[i + j].high) {
        isHigh = false;
      }
      if (data[i].low >= data[i - j].low || data[i].low >= data[i + j].low) {
        isLow = false;
      }
    }
    
    if (isHigh) {
      pivotHighs.push({ index: i, price: data[i].high, date: data[i].date });
    }
    if (isLow) {
      pivotLows.push({ index: i, price: data[i].low, date: data[i].date });
    }
  }
  
  return { pivotHighs, pivotLows };
}

/**
 * Tính giá trị trendline tại một index cho trước
 * Trendline đi qua 2 điểm (idx1, price1) và (idx2, price2)
 */
function trendlineValueAt(idx1: number, price1: number, idx2: number, price2: number, targetIdx: number): number {
  const slope = (price2 - price1) / (idx2 - idx1);
  return price1 + slope * (targetIdx - idx1);
}

/**
 * Phát hiện trendlines dài hạn bằng cách kết nối các pivot points
 * và kiểm tra xem có bao nhiêu pivot khác nằm gần đường thẳng đó
 */
function detectTrendlines(dailyData: StockData[]): TrendlineResult {
  const emptyResult: TrendlineResult = {
    trendlines: [],
    nearestResistanceTrendline: null,
    nearestSupportTrendline: null,
    warning: '',
    weeklyDataPoints: 0,
  };
  
  if (dailyData.length < 100) return emptyResult; // Cần ít nhất ~6 tháng data
  
  const weeklyData = convertToWeekly(dailyData);
  if (weeklyData.length < 30) return emptyResult; // Cần ít nhất 30 tuần
  
  const currentPrice = weeklyData[weeklyData.length - 1].close;
  const currentIdx = weeklyData.length - 1;
  
  // Tìm pivot points với lookback = 5 tuần (đỉnh/đáy cục bộ rõ ràng)
  const { pivotHighs, pivotLows } = findPivotPoints(weeklyData, 5);
  
  // Tolerance: giá chạm trendline nếu cách < 2% giá trị trendline
  const tolerance = 0.02;
  // Khoảng cách tối thiểu giữa 2 pivot để tạo trendline (20 tuần ~ 5 tháng)
  const minPivotDistance = 20;
  
  const allTrendlines: Trendline[] = [];
  
  // ═══ TÌM TRENDLINE KHÁNG CỰ (nối các pivot highs) ═══
  for (let i = 0; i < pivotHighs.length - 1; i++) {
    for (let j = i + 1; j < pivotHighs.length; j++) {
      const p1 = pivotHighs[i];
      const p2 = pivotHighs[j];
      
      // Khoảng cách tối thiểu
      if (p2.index - p1.index < minPivotDistance) continue;
      
      // Tính slope
      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      
      // Đếm số pivot khác nằm gần trendline này
      let touchCount = 2; // Đã có 2 điểm gốc
      let violations = 0; // Số lần giá vượt qua trendline quá nhiều
      
      for (let k = 0; k < pivotHighs.length; k++) {
        if (k === i || k === j) continue;
        const pk = pivotHighs[k];
        if (pk.index < p1.index || pk.index > currentIdx) continue;
        
        const trendValue = trendlineValueAt(p1.index, p1.price, p2.index, p2.price, pk.index);
        const diff = Math.abs(pk.price - trendValue) / trendValue;
        
        if (diff < tolerance) {
          touchCount++;
        }
        // Nếu giá vượt trendline quá 5% → trendline bị phá
        if (pk.price > trendValue * 1.05) {
          violations++;
        }
      }
      
      // Chỉ giữ trendline có ít nhất 2 touches và ít violations
      if (touchCount >= 2 && violations <= 1) {
        const currentTrendValue = trendlineValueAt(p1.index, p1.price, p2.index, p2.price, currentIdx);
        
        // Chỉ quan tâm trendline kháng cự NẰM TRÊN giá hiện tại (hoặc rất gần)
        if (currentTrendValue > currentPrice * 0.95) {
          const distPct = ((currentTrendValue - currentPrice) / currentPrice) * 100;
          const timeSpanWeeks = p2.index - p1.index;
          
          // Tính strength: dựa trên touchCount, timeSpan, và slope consistency
          const touchScore = Math.min(touchCount * 20, 60);
          const timeScore = Math.min(timeSpanWeeks / 2, 30);
          const violationPenalty = violations * 15;
          const strength = Math.min(100, Math.max(0, touchScore + timeScore - violationPenalty));
          
          allTrendlines.push({
            type: 'resistance',
            startDate: p1.date,
            endDate: p2.date,
            startPrice: p1.price,
            endPrice: p2.price,
            currentValue: currentTrendValue,
            slope: slope,
            touchCount,
            strength,
            distancePercent: distPct,
            isApproaching: distPct < 3 && distPct > -1,
            label: `Kháng cự trendline (${p1.date.substring(0, 7)} → ${p2.date.substring(0, 7)}, ${touchCount} lần chạm)`,
          });
        }
      }
    }
  }
  
  // ═══ TÌM TRENDLINE HỖ TRỢ (nối các pivot lows) ═══
  for (let i = 0; i < pivotLows.length - 1; i++) {
    for (let j = i + 1; j < pivotLows.length; j++) {
      const p1 = pivotLows[i];
      const p2 = pivotLows[j];
      
      if (p2.index - p1.index < minPivotDistance) continue;
      
      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      
      let touchCount = 2;
      let violations = 0;
      
      for (let k = 0; k < pivotLows.length; k++) {
        if (k === i || k === j) continue;
        const pk = pivotLows[k];
        if (pk.index < p1.index || pk.index > currentIdx) continue;
        
        const trendValue = trendlineValueAt(p1.index, p1.price, p2.index, p2.price, pk.index);
        const diff = Math.abs(pk.price - trendValue) / trendValue;
        
        if (diff < tolerance) {
          touchCount++;
        }
        if (pk.price < trendValue * 0.95) {
          violations++;
        }
      }
      
      if (touchCount >= 2 && violations <= 1) {
        const currentTrendValue = trendlineValueAt(p1.index, p1.price, p2.index, p2.price, currentIdx);
        
        // Chỉ quan tâm trendline hỗ trợ NẰM DƯỚI giá hiện tại (hoặc rất gần)
        if (currentTrendValue < currentPrice * 1.05) {
          const distPct = ((currentPrice - currentTrendValue) / currentPrice) * 100;
          const timeSpanWeeks = p2.index - p1.index;
          
          const touchScore = Math.min(touchCount * 20, 60);
          const timeScore = Math.min(timeSpanWeeks / 2, 30);
          const violationPenalty = violations * 15;
          const strength = Math.min(100, Math.max(0, touchScore + timeScore - violationPenalty));
          
          allTrendlines.push({
            type: 'support',
            startDate: p1.date,
            endDate: p2.date,
            startPrice: p1.price,
            endPrice: p2.price,
            currentValue: currentTrendValue,
            slope: slope,
            touchCount,
            strength,
            distancePercent: distPct,
            isApproaching: distPct < 3 && distPct > -1,
            label: `Hỗ trợ trendline (${p1.date.substring(0, 7)} → ${p2.date.substring(0, 7)}, ${touchCount} lần chạm)`,
          });
        }
      }
    }
  }
  
  // Sắp xếp theo strength giảm dần
  allTrendlines.sort((a, b) => b.strength - a.strength);
  
  // Lọc top trendlines (tránh trùng lặp - chỉ giữ trendline mạnh nhất cho mỗi vùng giá)
  const filteredTrendlines: Trendline[] = [];
  for (const tl of allTrendlines) {
    const isDuplicate = filteredTrendlines.some(
      existing => existing.type === tl.type && 
      Math.abs(existing.currentValue - tl.currentValue) / tl.currentValue < 0.03
    );
    if (!isDuplicate) {
      filteredTrendlines.push(tl);
    }
  }
  
  // Tìm trendline kháng cự gần nhất (mạnh nhất trong các trendline gần)
  const resistanceTrendlines = filteredTrendlines
    .filter(t => t.type === 'resistance')
    .sort((a, b) => a.distancePercent - b.distancePercent);
  const nearestResistance = resistanceTrendlines.length > 0 ? resistanceTrendlines[0] : null;
  
  // Tìm trendline hỗ trợ gần nhất
  const supportTrendlines = filteredTrendlines
    .filter(t => t.type === 'support')
    .sort((a, b) => a.distancePercent - b.distancePercent);
  const nearestSupport = supportTrendlines.length > 0 ? supportTrendlines[0] : null;
  
  // Tạo cảnh báo
  let warning = '';
  if (nearestResistance && nearestResistance.isApproaching) {
    const strengthLabel = nearestResistance.strength >= 70 ? 'RẤT MẠNH' : nearestResistance.strength >= 50 ? 'MẠNH' : 'TRUNG BÌNH';
    warning = `⚠️ CẢNH BÁO: Giá đang tiến gần TRENDLINE KHÁNG CỰ ${strengthLabel} tại ~${nearestResistance.currentValue.toFixed(0)} điểm ` +
      `(cách ${nearestResistance.distancePercent.toFixed(1)}%). ` +
      `Trendline này kéo dài từ ${nearestResistance.startDate.substring(0, 7)} đến ${nearestResistance.endDate.substring(0, 7)}, ` +
      `đã được test ${nearestResistance.touchCount} lần. Khả năng điều chỉnh khi chạm vùng này là cao!`;
  }
  if (nearestSupport && nearestSupport.isApproaching) {
    const strengthLabel = nearestSupport.strength >= 70 ? 'RẤT MẠNH' : nearestSupport.strength >= 50 ? 'MẠNH' : 'TRUNG BÌNH';
    const supportWarning = `📍 Giá đang tiến gần TRENDLINE HỖ TRỢ ${strengthLabel} tại ~${nearestSupport.currentValue.toFixed(0)} điểm ` +
      `(cách ${nearestSupport.distancePercent.toFixed(1)}%). ` +
      `Trendline từ ${nearestSupport.startDate.substring(0, 7)} đến ${nearestSupport.endDate.substring(0, 7)}, ` +
      `${nearestSupport.touchCount} lần chạm. Vùng hỗ trợ tốt để cân nhắc mua!`;
    warning = warning ? warning + '\n' + supportWarning : supportWarning;
  }
  
  return {
    trendlines: filteredTrendlines.slice(0, 6), // Top 6 trendlines
    nearestResistanceTrendline: nearestResistance,
    nearestSupportTrendline: nearestSupport,
    warning,
    weeklyDataPoints: weeklyData.length,
  };
}

/**
 * Fetch dữ liệu giá dài hạn (5 năm) cho phân tích trendline
 */
async function fetchLongTermPriceData(symbol: string): Promise<StockData[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 5); // 5 năm dữ liệu
  
  const formatDate = (d: Date) => d.toISOString().split('T')[0];
  const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${formatDate(startDate)}&endDate=${formatDate(endDate)}`;
  
  console.log(`[Trendline] 🔍 Fetching long-term data: ${url}`);
  
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  
  if (!response.ok) {
    console.log(`[Trendline] ❌ Long-term API failed: ${response.status}`);
    return [];
  }
  
  const rawData = await response.json();
  console.log(`[Trendline] 📊 Got ${rawData?.length || 0} long-term records`);
  
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
  console.log(`[Trendline] ✅ Parsed ${data.length} long-term records (${convertToWeekly(data).length} weeks)`);
  return data;
}

function formatVND(value: number): string {
  // Giá cổ phiếu VN từ API là đơn vị VNĐ (VD: 51800 = 51,800 VNĐ)
  // Hiển thị dạng nghìn đồng: 51.8 (nghìn)
  const priceInK = value / 1000; // Chuyển sang nghìn đồng
  if (priceInK >= 100) {
    // Giá >= 100 nghìn: hiển thị số nguyên (VD: 125)
    return priceInK.toFixed(1).replace(/\.0$/, '');
  }
  // Giá < 100 nghìn: hiển thị 2 số thập phân (VD: 51.8, 45.95)
  return priceInK.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
}

// ═══════════════════════════════════════════════════
// INVESTMENT DECISION ENGINE - Đưa ra quyết định MUA/BÁN/GIỮ
// ═══════════════════════════════════════════════════

interface ScoreBreakdown {
  techScore: number;
  fundScore: number;
  moneyFlowScore: number;
  totalScore: number;
  techDetails: string[];
  fundDetails: string[];
  moneyFlowDetails: string[];
}

interface InvestmentDecision {
  action: 'MUA' | 'BÁN' | 'GIỮ' | 'CHỜ';
  confidence: number;
  riskReward: number;
  winRate: number;
  stopLoss: number;
  takeProfit: number;
  reasoning: string[];
  actionPlan: string;
  scoreBreakdown: ScoreBreakdown;
}

export function calculateInvestmentDecision(
  tech: TechnicalResult,
  fund: FundamentalResult,
  _overall: { score: number; rating: string },
): InvestmentDecision {
  const currentPrice = tech.currentPrice;
  
  // Tính Stop Loss và Take Profit
  const stopLoss = tech.support * 0.98;
  
  // Fix: Target phải > giá hiện tại
  // Nếu resistance < giá hiện tại, dùng giá hiện tại + 10%
  let takeProfit = tech.resistance * 1.02;
  if (takeProfit <= currentPrice) {
    // Resistance đã bị vượt qua, tính target mới
    takeProfit = currentPrice * 1.10; // Target +10% từ giá hiện tại
  }
  
  // Tính Risk:Reward
  const risk = currentPrice - stopLoss;
  const reward = takeProfit - currentPrice;
  const riskReward = risk > 0 ? reward / risk : 0;
  
  // === ĐIỂM KỸ THUẬT (max 100) ===
  let techScore = 50;
  const techDetails: string[] = [];
  
  // Xu hướng (±20)
  if (tech.trend === 'Uptrend') {
    techScore += 20;
    techDetails.push(`✅ Xu hướng TĂNG: Giá > MA20 > MA50 (+20đ)`);
  } else if (tech.trend === 'Sideway') {
    techScore += 5;
    techDetails.push(`⚪ Xu hướng SIDEWAY: Đang tích lũy (+5đ)`);
  } else {
    techScore -= 15;
    techDetails.push(`⚠️ Xu hướng GIẢM: Giá < MA20 < MA50 (-15đ)`);
  }
  
  // RSI (±15)
  if (tech.rsi < 30) {
    techScore += 15;
    techDetails.push(`✅ RSI=${tech.rsi.toFixed(1)} OVERSOLD: Cơ hội mua (+15đ)`);
  } else if (tech.rsi < 40) {
    techScore += 8;
    techDetails.push(`✅ RSI=${tech.rsi.toFixed(1)} thấp: Vùng tích lũy (+8đ)`);
  } else if (tech.rsi > 70) {
    techScore -= 15;
    techDetails.push(`⚠️ RSI=${tech.rsi.toFixed(1)} OVERBOUGHT: Cẩn thận (-15đ)`);
  } else if (tech.rsi > 60) {
    techScore -= 5;
    techDetails.push(`⚪ RSI=${tech.rsi.toFixed(1)} cao: Có thể điều chỉnh (-5đ)`);
  } else {
    techScore += 3;
    techDetails.push(`⚪ RSI=${tech.rsi.toFixed(1)} trung tính (+3đ)`);
  }
  
  // RSI Trend (±8)
  if (tech.rsiTrend === 'Tăng ↑') {
    techScore += 8;
    techDetails.push(`✅ RSI đang TĂNG: Momentum tích cực (+8đ)`);
  } else if (tech.rsiTrend === 'Giảm ↓') {
    techScore -= 8;
    techDetails.push(`⚠️ RSI đang GIẢM: Momentum suy yếu (-8đ)`);
  }
  
  // MACD (±15)
  if (tech.macdTrend.includes('BULLISH CROSS')) {
    techScore += 18;
    techDetails.push(`✅ MACD vừa CẮT LÊN Signal: Tín hiệu MUA mạnh (+18đ)`);
  } else if (tech.macdTrend.includes('BEARISH CROSS')) {
    techScore -= 18;
    techDetails.push(`⚠️ MACD vừa CẮT XUỐNG Signal: Tín hiệu BÁN mạnh (-18đ)`);
  } else if (tech.macdHistogram > 0 && tech.macdTrend === 'Bullish tăng') {
    techScore += 12;
    techDetails.push(`✅ MACD Bullish tăng: Histogram dương và đang tăng (+12đ)`);
  } else if (tech.macdHistogram > 0 && tech.macdTrend === 'Bullish giảm') {
    techScore += 3;
    techDetails.push(`🟡 MACD Bullish giảm: Histogram dương nhưng đang yếu dần (+3đ)`);
  } else if (tech.macdHistogram < 0 && tech.macdTrend === 'Bearish tăng') {
    techScore -= 12;
    techDetails.push(`⚠️ MACD Bearish tăng: Histogram âm và đang giảm sâu (-12đ)`);
  } else if (tech.macdHistogram < 0 && tech.macdTrend === 'Bearish giảm') {
    techScore -= 3;
    techDetails.push(`🟡 MACD Bearish giảm: Histogram âm nhưng đang hồi (-3đ)`);
  } else {
    techDetails.push(`⚪ MACD trung tính (0đ)`);
  }
  
  // Bollinger Bands (±10)
  if (tech.currentPrice <= tech.bollingerLower * 1.02) {
    techScore += 10;
    techDetails.push(`✅ Giá gần BAND DƯỚI: Có thể hồi phục (+10đ)`);
  } else if (tech.currentPrice >= tech.bollingerUpper * 0.98) {
    techScore -= 10;
    techDetails.push(`⚠️ Giá gần BAND TRÊN: Có thể điều chỉnh (-10đ)`);
  }
  
  // Volume (±10)
  if (tech.volumeRatio > 1.5 && tech.priceChange > 0) {
    techScore += 10;
    techDetails.push(`✅ Volume ${tech.volumeRatio.toFixed(1)}x TB + Giá tăng: Dòng tiền vào (+10đ)`);
  } else if (tech.volumeRatio > 1.5 && tech.priceChange < 0) {
    techScore -= 8;
    techDetails.push(`⚠️ Volume ${tech.volumeRatio.toFixed(1)}x TB + Giá giảm: Bán tháo (-8đ)`);
  } else if (tech.volumeRatio < 0.7) {
    techDetails.push(`⚪ Volume thấp ${tech.volumeRatio.toFixed(1)}x: Thanh khoản yếu (0đ)`);
  }
  
  // === ĐIỂM CƠ BẢN (max 100) ===
  let fundScore = 50;
  const fundDetails: string[] = [];
  
  // ROE (±20)
  if (fund.roe > 20) {
    fundScore += 20;
    fundDetails.push(`✅ ROE=${fund.roe.toFixed(1)}% XUẤT SẮC: Sử dụng vốn hiệu quả (+20đ)`);
  } else if (fund.roe > 15) {
    fundScore += 15;
    fundDetails.push(`✅ ROE=${fund.roe.toFixed(1)}% TỐT (+15đ)`);
  } else if (fund.roe > 10) {
    fundScore += 8;
    fundDetails.push(`⚪ ROE=${fund.roe.toFixed(1)}% trung bình (+8đ)`);
  } else {
    fundScore -= 10;
    fundDetails.push(`⚠️ ROE=${fund.roe.toFixed(1)}% THẤP: Hiệu quả vốn kém (-10đ)`);
  }
  
  // Tăng trưởng LN (±20)
  if (fund.profitGrowth > 30) {
    fundScore += 20;
    fundDetails.push(`✅ LN tăng ${fund.profitGrowth.toFixed(1)}% MẠNH (+20đ)`);
  } else if (fund.profitGrowth > 15) {
    fundScore += 12;
    fundDetails.push(`✅ LN tăng ${fund.profitGrowth.toFixed(1)}% tốt (+12đ)`);
  } else if (fund.profitGrowth > 0) {
    fundScore += 5;
    fundDetails.push(`⚪ LN tăng ${fund.profitGrowth.toFixed(1)}% (+5đ)`);
  } else {
    fundScore -= 15;
    fundDetails.push(`⚠️ LN GIẢM ${fund.profitGrowth.toFixed(1)}%: Kinh doanh suy yếu (-15đ)`);
  }
  
  // P/E (±10)
  if (fund.pe > 0) {
    if (fund.pe < 10) {
      fundScore += 10;
      fundDetails.push(`✅ P/E=${fund.pe.toFixed(1)} RẺ: Định giá hấp dẫn (+10đ)`);
    } else if (fund.pe < 15) {
      fundScore += 5;
      fundDetails.push(`✅ P/E=${fund.pe.toFixed(1)} hợp lý (+5đ)`);
    } else if (fund.pe > 25) {
      fundScore -= 8;
      fundDetails.push(`⚠️ P/E=${fund.pe.toFixed(1)} CAO: Định giá đắt (-8đ)`);
    } else {
      fundDetails.push(`⚪ P/E=${fund.pe.toFixed(1)} trung bình (0đ)`);
    }
  }
  
  // P/B (±8)
  if (fund.pb > 0) {
    if (fund.pb < 1.5) {
      fundScore += 8;
      fundDetails.push(`✅ P/B=${fund.pb.toFixed(2)} RẺ: Dưới giá trị sổ sách (+8đ)`);
    } else if (fund.pb > 3) {
      fundScore -= 5;
      fundDetails.push(`⚠️ P/B=${fund.pb.toFixed(2)} CAO (-5đ)`);
    }
  }
  
  // Nợ/Vốn (±10)
  if (fund.debtToEquity < 0.5) {
    fundScore += 10;
    fundDetails.push(`✅ Nợ/Vốn=${fund.debtToEquity.toFixed(2)}x THẤP: Tài chính lành mạnh (+10đ)`);
  } else if (fund.debtToEquity < 1) {
    fundScore += 5;
    fundDetails.push(`⚪ Nợ/Vốn=${fund.debtToEquity.toFixed(2)}x ổn (+5đ)`);
  } else if (fund.debtToEquity > 2) {
    fundScore -= 12;
    fundDetails.push(`⚠️ Nợ/Vốn=${fund.debtToEquity.toFixed(2)}x CAO: Rủi ro tài chính (-12đ)`);
  }
  
  // === ĐIỂM DÒNG TIỀN (max 100) ===
  let moneyFlowScore = 50;
  const moneyFlowDetails: string[] = [];
  
  // MFI (±20) + MFI trend & divergence
  if (tech.mfi < 20) {
    moneyFlowScore += 20;
    moneyFlowDetails.push(`✅ MFI=${tech.mfi.toFixed(0)} OVERSOLD: Dòng tiền cạn, cơ hội tích lũy (+20đ)`);
  } else if (tech.mfi < 35) {
    moneyFlowScore += 10;
    moneyFlowDetails.push(`✅ MFI=${tech.mfi.toFixed(0)} thấp: Dòng tiền yếu, có thể hồi (+10đ)`);
  } else if (tech.mfi > 80) {
    moneyFlowScore -= 18;
    moneyFlowDetails.push(`⚠️ MFI=${tech.mfi.toFixed(0)} OVERBOUGHT: Dòng tiền quá mạnh, cẩn thận (-18đ)`);
  } else if (tech.mfi > 65) {
    moneyFlowScore -= 5;
    moneyFlowDetails.push(`⚪ MFI=${tech.mfi.toFixed(0)} cao: Có thể điều chỉnh (-5đ)`);
  } else {
    moneyFlowScore += 5;
    moneyFlowDetails.push(`⚪ MFI=${tech.mfi.toFixed(0)} trung tính (+5đ)`);
  }
  
  // MFI Trend bonus/penalty
  if (tech.mfiTrend === 'rising' && tech.mfi >= 40 && tech.mfi <= 70) {
    moneyFlowScore += 8;
    moneyFlowDetails.push(`💰 MFI đang TĂNG (${tech.mfiPrev.toFixed(0)}→${tech.mfi.toFixed(0)}): Dòng tiền đang chảy vào (+8đ)`);
  } else if (tech.mfiTrend === 'falling' && tech.mfi <= 60 && tech.mfi >= 30) {
    moneyFlowScore -= 8;
    moneyFlowDetails.push(`🏃 MFI đang GIẢM (${tech.mfiPrev.toFixed(0)}→${tech.mfi.toFixed(0)}): Dòng tiền đang rút (-8đ)`);
  }
  
  // MFI Divergence bonus
  if (tech.mfiDivergence) {
    if (tech.mfiDivergence.includes('PHÂN KỲ DƯƠNG')) {
      moneyFlowScore += 12;
      moneyFlowDetails.push(`🟢 MFI phân kỳ dương: Dòng tiền tích lũy ngầm (+12đ)`);
    } else if (tech.mfiDivergence.includes('PHÂN KỲ ÂM')) {
      moneyFlowScore -= 12;
      moneyFlowDetails.push(`🔴 MFI phân kỳ âm: Dòng tiền không xác nhận đà tăng (-12đ)`);
    }
  }
  
  // VSA Signal
  if (tech.vsaSignals[0].includes('DEMAND')) {
    moneyFlowScore += 15;
    moneyFlowDetails.push(`✅ VSA: ${tech.vsaSignals[0]} (+15đ)`);
  } else if (tech.vsaSignals[0].includes('SUPPLY')) {
    moneyFlowScore -= 12;
    moneyFlowDetails.push(`⚠️ VSA: ${tech.vsaSignals[0]} (-12đ)`);
  }
  
  // Giới hạn điểm
  techScore = Math.min(100, Math.max(0, techScore));
  fundScore = Math.min(100, Math.max(0, fundScore));
  moneyFlowScore = Math.min(100, Math.max(0, moneyFlowScore));
  
  // === TỔNG HỢP ===
  const totalScore = techScore * 0.35 + fundScore * 0.40 + moneyFlowScore * 0.25;
  
  // Tính xác suất thắng
  let winRate = 35 + totalScore * 0.5;
  if (riskReward >= 2) winRate += 8;
  else if (riskReward >= 1.5) winRate += 4;
  else if (riskReward < 1) winRate -= 12;
  winRate = Math.min(85, Math.max(15, winRate));
  
  // === QUYẾT ĐỊNH ===
  let action: 'MUA' | 'BÁN' | 'GIỮ' | 'CHỜ';
  let confidence: number;
  const reasoning: string[] = [];
  let actionPlan: string;
  
  // Thêm điểm số vào reasoning
  reasoning.push(`📊 ĐIỂM TỔNG HỢP: ${totalScore.toFixed(0)}/100`);
  reasoning.push(`   • Kỹ thuật: ${techScore.toFixed(0)}/100 (35%)`);
  reasoning.push(`   • Cơ bản: ${fundScore.toFixed(0)}/100 (40%)`);
  reasoning.push(`   • Dòng tiền: ${moneyFlowScore.toFixed(0)}/100 (25%)`);
  reasoning.push('');
  
  // Logic quyết định
  if (totalScore >= 65 && riskReward >= 1.0 && winRate >= 55 && tech.shortTermScore >= 40) {
    action = 'MUA';
    confidence = Math.min(90, 55 + totalScore * 0.4);
    reasoning.push('🟢 **KẾT LUẬN: NÊN MUA**');
    reasoning.push('');
    reasoning.push('📈 **Lý do Kỹ thuật:**');
    techDetails.slice(0, 4).forEach(d => reasoning.push(`   ${d}`));
    reasoning.push('');
    reasoning.push('💼 **Lý do Cơ bản:**');
    fundDetails.slice(0, 3).forEach(d => reasoning.push(`   ${d}`));
    reasoning.push('');
    reasoning.push('💰 **Lý do Dòng tiền:**');
    moneyFlowDetails.forEach(d => reasoning.push(`   ${d}`));
    actionPlan = `🟢 MUA tại ${formatVND(currentPrice)} | SL: ${formatVND(stopLoss)} | TP: ${formatVND(takeProfit)}`;
  } else if (totalScore >= 65 && tech.shortTermScore < 40) {
    // Cơ bản tốt nhưng ngắn hạn tiêu cực → CHỜ
    action = 'CHỜ';
    confidence = 50;
    reasoning.push('⏳ **KẾT LUẬN: CHỜ - Cơ bản tốt nhưng ngắn hạn tiêu cực**');
    reasoning.push('');
    reasoning.push('✅ **Điểm tích cực (trung/dài hạn):**');
    [...techDetails, ...fundDetails].filter(d => d.includes('✅')).slice(0, 4).forEach(d => reasoning.push(`   ${d}`));
    reasoning.push('');
    reasoning.push('⚠️ **Vấn đề ngắn hạn (T+2.5):**');
    reasoning.push(`   ⚠️ Momentum ngắn hạn: ${tech.shortTermScore}/100 - ${tech.shortTermMomentum}`);
    reasoning.push(`   ⚠️ Giá 3 ngày: ${tech.priceChange3d >= 0 ? '+' : ''}${tech.priceChange3d.toFixed(2)}%`);
    if (tech.rsiTrend === 'Giảm ↓') reasoning.push(`   ⚠️ RSI đang giảm: ${tech.rsiPrev3.toFixed(1)} → ${tech.rsi.toFixed(1)}`);
    reasoning.push('');
    reasoning.push('📌 **Khuyến nghị:**');
    reasoning.push(`   • Chờ giá ổn định hoặc RSI ngừng giảm`);
    reasoning.push(`   • Mua khi giá về hỗ trợ ${formatVND(tech.support)}`);
    actionPlan = `⏳ CHỜ | Mua khi về ${formatVND(tech.support)} hoặc RSI hồi phục`;
  } else if (totalScore <= 35 || (tech.rsi > 70 && tech.trend === 'Downtrend') || (fundScore < 40 && techScore < 40)) {
    action = 'BÁN';
    confidence = Math.min(90, 55 + (100 - totalScore) * 0.4);
    reasoning.push('🔴 **KẾT LUẬN: NÊN BÁN/TRÁNH**');
    reasoning.push('');
    reasoning.push('📈 **Vấn đề Kỹ thuật:**');
    techDetails.filter(d => d.includes('⚠️')).forEach(d => reasoning.push(`   ${d}`));
    reasoning.push('');
    reasoning.push('💼 **Vấn đề Cơ bản:**');
    fundDetails.filter(d => d.includes('⚠️')).forEach(d => reasoning.push(`   ${d}`));
    reasoning.push('');
    reasoning.push('💰 **Vấn đề Dòng tiền:**');
    moneyFlowDetails.filter(d => d.includes('⚠️')).forEach(d => reasoning.push(`   ${d}`));
    actionPlan = `🔴 BÁN/CẮT LỖ nếu thủng ${formatVND(stopLoss)}`;
  } else if (totalScore >= 50 && totalScore < 65) {
    action = 'GIỮ';
    confidence = 45 + totalScore * 0.3;
    reasoning.push('🟡 **KẾT LUẬN: GIỮ & QUAN SÁT**');
    reasoning.push('');
    reasoning.push('📈 **Điểm tích cực:**');
    [...techDetails, ...fundDetails].filter(d => d.includes('✅')).slice(0, 3).forEach(d => reasoning.push(`   ${d}`));
    reasoning.push('');
    reasoning.push('⚠️ **Điểm cần lưu ý:**');
    [...techDetails, ...fundDetails].filter(d => d.includes('⚠️')).slice(0, 2).forEach(d => reasoning.push(`   ${d}`));
    actionPlan = `🟡 GIỮ | Mua thêm nếu về ${formatVND(tech.support)} | Bán nếu thủng ${formatVND(stopLoss)}`;
  } else {
    action = 'CHỜ';
    confidence = 35;
    reasoning.push('⏳ **KẾT LUẬN: CHỜ TÍN HIỆU RÕ HƠN**');
    reasoning.push('');
    reasoning.push('📌 **Điều kiện MUA:**');
    reasoning.push(`   • Giá về vùng hỗ trợ ${formatVND(tech.support)}`);
    reasoning.push(`   • RSI < 35 (hiện tại: ${tech.rsi.toFixed(0)})`);
    reasoning.push(`   • MACD cắt lên Signal line`);
    reasoning.push('');
    reasoning.push('📌 **Điều kiện BÁN:**');
    reasoning.push(`   • Giá thủng hỗ trợ ${formatVND(stopLoss)}`);
    reasoning.push(`   • RSI > 70 + Volume tăng đột biến`);
    actionPlan = `⏳ CHỜ | Mua khi về ${formatVND(tech.support)} | Hoặc breakout ${formatVND(tech.resistance)}`;
  }
  
  // Cảnh báo R:R
  reasoning.push('');
  if (riskReward < 1) {
    reasoning.push(`⚠️ **CẢNH BÁO:** R:R = ${riskReward.toFixed(2)}:1 < 1 → Rủi ro > Lợi nhuận kỳ vọng!`);
  } else if (riskReward >= 2) {
    reasoning.push(`✅ **R:R HẤP DẪN:** ${riskReward.toFixed(2)}:1 → Lợi nhuận kỳ vọng gấp ${riskReward.toFixed(1)}x rủi ro`);
  }
  
  return {
    action,
    confidence: Math.round(confidence),
    riskReward: Math.round(riskReward * 100) / 100,
    winRate: Math.round(winRate),
    stopLoss,
    takeProfit,
    reasoning,
    actionPlan,
    scoreBreakdown: { techScore, fundScore, moneyFlowScore, totalScore, techDetails, fundDetails, moneyFlowDetails },
  };
}

// ═══════════════════════════════════════════════════
// REPORT GENERATOR
// ═══════════════════════════════════════════════════

function generateReport(
  symbol: string,
  _priceData: StockData[],
  tech: TechnicalResult,
  fund: FundamentalResult,
  _timeline: TimelineMark[],
  overall: { score: number; rating: string },
  macroNews?: MacroNewsItem[],
  macroAnalysis?: string,
  potentialStocks?: string,
  industryComparison?: IndustryComparison | null,
  patternAnalysis?: PatternAnalysisResult | null,
  vnindexStage?: any,
  marketPressure?: any,
): StockAnalysisResult {
  // Kiểm tra nếu là VNINDEX thì dùng format riêng
  if (symbol === 'VNINDEX') {
    return generateVNIndexReport(symbol, tech, overall, macroNews, macroAnalysis, potentialStocks, vnindexStage);
  }
  
  // Tính quyết định đầu tư
  const decision = calculateInvestmentDecision(tech, fund, overall);
  
  // Lấy 4 quý gần nhất từ timeline
  const recentQuarters = _timeline.slice(-4).reverse();
  const quarterSummary = recentQuarters.length > 0
    ? recentQuarters.map((q: TimelineMark) => `• ${q.title.replace(/\|/g, ' - ')}`).join('\n')
    : '• Chưa có dữ liệu';

  // Icon cho quyết định
  const actionIcon = {
    'MUA': '🟢',
    'BÁN': '🔴',
    'GIỮ': '🟡',
    'CHỜ': '⏳',
  }[decision.action];

  // MACD status với trend chi tiết
  let macdIcon = '⚪';
  if (tech.macdTrend.includes('BULLISH')) macdIcon = '🟢';
  else if (tech.macdTrend.includes('BEARISH')) macdIcon = '🔴';
  else if (tech.macdTrend === 'Bullish giảm') macdIcon = '🟡';
  else if (tech.macdTrend === 'Bearish giảm') macdIcon = '🟡';

  // RSI status với xu hướng
  let rsiStatusSimple = '';
  if (tech.rsi < 30) rsiStatusSimple = '(Oversold)';
  else if (tech.rsi > 70) rsiStatusSimple = '(Overbought)';

  // Đánh giá T+2.5
  let t25Verdict = '⚪ Trung tính';
  let t25Action = 'Chờ thêm tín hiệu';
  if (tech.shortTermScore >= 65) {
    t25Verdict = '🟢 Tích cực';
    t25Action = 'Có thể MUA T+2.5';
  } else if (tech.shortTermScore >= 55) {
    t25Verdict = '🟡 Hơi tích cực';
    t25Action = 'Cân nhắc MUA nhẹ';
  } else if (tech.shortTermScore <= 35) {
    t25Verdict = '🔴 Tiêu cực';
    t25Action = 'KHÔNG nên MUA, chờ hồi';
  } else if (tech.shortTermScore <= 45) {
    t25Verdict = '🟠 Hơi tiêu cực';
    t25Action = 'Cẩn thận, có thể giảm tiếp';
  }

  // ═══════════════════════════════════════════════════
  // BROKER STYLE REPORT - Không nhắc chỉ báo kỹ thuật
  // ═══════════════════════════════════════════════════
  
  const formatPrice = (p: number) => (p / 1000).toFixed(1);
  
  // Xác định trạng thái cổ phiếu bằng ngôn ngữ broker
  let stockState = '';
  if (tech.priceChange > 2) {
    stockState = 'đang tăng khá mạnh trong phiên';
  } else if (tech.priceChange > 0.5) {
    stockState = 'đang tăng điểm tích cực';
  } else if (tech.priceChange > 0) {
    stockState = 'đang tăng nhẹ';
  } else if (tech.priceChange > -0.5) {
    stockState = 'đang đi ngang, rung lắc nhẹ';
  } else if (tech.priceChange > -2) {
    stockState = 'đang điều chỉnh nhẹ';
  } else {
    stockState = 'đang có áp lực bán';
  }
  
  // Nhận định xu hướng theo broker style
  let trendComment = '';
  if (tech.trend === 'Uptrend') {
    if (tech.rsiBreakdownFromOB) {
      trendComment = `Về cấu trúc thì ${symbol} vẫn đang trong xu hướng tích cực, nhưng động lượng tăng đang có dấu hiệu chậm lại. Đây là giai đoạn cổ phiếu cần thời gian nghỉ ngơi trước khi có bước đi tiếp.`;
    } else {
      trendComment = `${symbol} đang giữ được cấu trúc tích cực. Miễn giá vẫn nằm trên vùng hỗ trợ quan trọng thì xu hướng vẫn còn.`;
    }
  } else if (tech.trend === 'Downtrend') {
    trendComment = `${symbol} đang trong giai đoạn điều chỉnh. Cấu trúc có phần suy yếu, nên chiến lược lúc này là thận trọng hơn.`;
  } else {
    trendComment = `${symbol} đang đi ngang, tích lũy trong vùng giá. Chưa có xu hướng rõ ràng, cần chờ tín hiệu xác nhận.`;
  }
  
  // Động lượng & thanh khoản - So sánh với MA50 volume
  let volumeComment = '';
  if (tech.volumeAboveMA50Count >= 7) {
    volumeComment = `🟢 **DÒNG TIỀN VÀO MẠNH:** ${tech.volumeAboveMA50Count}/10 phiên gần đây có volume > MA50 (${(tech.avgVolume50/1000000).toFixed(1)}M). Đây là tín hiệu tích cực cho thấy CP có khả năng tăng mạnh!`;
  } else if (tech.volumeAboveMA50Count >= 5) {
    volumeComment = `🟡 Dòng tiền vào khá: ${tech.volumeAboveMA50Count}/10 phiên có volume > MA50. Có sự quan tâm của dòng tiền.`;
  } else if (tech.volumeAboveMA50Count >= 3) {
    volumeComment = `⚪ Dòng tiền trung bình: ${tech.volumeAboveMA50Count}/10 phiên có volume > MA50. Thanh khoản ổn định.`;
  } else {
    volumeComment = `🔴 Dòng tiền yếu: Chỉ ${tech.volumeAboveMA50Count}/10 phiên có volume > MA50. Thiếu lực mua, cần thận trọng.`;
  }
  
  // Thêm thông tin volume hôm nay
  if (tech.volumeRatio > 1.5) {
    volumeComment += ` Volume hôm nay ${tech.volumeRatio.toFixed(1)}x MA50 - tăng mạnh!`;
  } else if (tech.volumeRatio < 0.7) {
    volumeComment += ` Volume hôm nay chỉ ${tech.volumeRatio.toFixed(1)}x MA50 - khá thấp.`;
  }
  
  // Vùng giá quan trọng - gần price hiện tại
  const supportNear = tech.nearestSupport;
  const resistNear = tech.nearestResistance;
  const supportDeep = Math.min(tech.ma50, tech.support);
  
  // Chiến lược theo 2 nhóm
  let strategyHolding = '';
  let strategyWaiting = '';
  
  if (tech.trend === 'Uptrend' && tech.shortTermScore >= 55) {
    strategyHolding = `**Anh/chị đang có hàng ${symbol}:** Có thể tiếp tục nắm giữ, theo dõi phản ứng giá tại vùng ${formatVND(supportNear)}. Miễn vùng này còn giữ được thì chưa cần lo.`;
    strategyWaiting = `**Anh/chị đang cầm tiền:** Nếu muốn vào có thể chờ những nhịp rung về vùng ${formatVND(supportNear)}, không nên mua đuổi giá.`;
  } else if (tech.trend === 'Downtrend' || tech.shortTermScore <= 45) {
    strategyHolding = `**Anh/chị đang có hàng ${symbol}:** Ưu tiên quản trị rủi ro. Nếu cổ phiếu mất vùng ${formatVND(supportNear)}, nên cân nhắc cắt giảm để bảo toàn vốn.`;
    strategyWaiting = `**Anh/chị đang cầm tiền:** Em khuyến khích quan sát thêm. Chờ tín hiệu rõ ràng hơn, không cần vội.`;
  } else {
    strategyHolding = `**Anh/chị đang có hàng ${symbol}:** Có thể giữ và theo dõi. Giai đoạn này cần kiên nhẫn.`;
    strategyWaiting = `**Anh/chị đang cầm tiền:** Thị trường chưa quá rõ, em gợi ý chờ thêm tín hiệu xác nhận.`;
  }
  
  // Kịch bản điều kiện
  const breakoutLevel = resistNear;
  const breakdownLevel = supportNear;
  
  let scenarioPositive = `✅ **Nếu ${symbol} vượt ${formatVND(breakoutLevel)}** và giữ giá ổn định phía trên, điều đó cho thấy áp lực bán đã được hấp thụ. Khi đó cổ phiếu có thể bước vào nhịp tăng tiếp, anh/chị đang có hàng có thể tiếp tục giữ.`;
  
  let scenarioNegative = `⚠️ **Nếu ${symbol} mất vùng ${formatVND(breakdownLevel)}**, cổ phiếu có thể điều chỉnh sâu hơn để kiểm tra lực cầu. Khi đó em ưu tiên chiến lược phòng thủ, giảm tỷ trọng để bảo toàn thành quả.`;
  
  // Câu chốt broker style
  let closingLine = '';
  if (tech.shortTermScore >= 55) {
    closingLine = 'Cơ hội vẫn còn, quan trọng là kỷ luật và không mua đuổi.';
  } else if (tech.shortTermScore <= 45) {
    closingLine = 'Giai đoạn này ưu tiên an toàn. Đôi khi đứng ngoài cũng là một chiến lược.';
  } else {
    closingLine = 'Kiên nhẫn và kỷ luật sẽ giúp anh/chị có kết quả tốt hơn.';
  }
  
  // Thông tin cơ bản ngắn gọn (không liệt kê nhiều số liệu)
  let fundamentalNote = '';
  if (fund.roe > 15 && fund.profitGrowth > 10) {
    fundamentalNote = 'Về nền tảng, doanh nghiệp có hiệu quả kinh doanh khá tốt, tăng trưởng lợi nhuận tích cực.';
  } else if (fund.roe > 10) {
    fundamentalNote = 'Nền tảng cơ bản ở mức ổn, không có vấn đề gì đáng lo.';
  } else if (fund.roe < 5 || fund.profitGrowth < -10) {
    fundamentalNote = 'Cần lưu ý nền tảng cơ bản chưa thực sự nổi bật, nên cần thận trọng hơn.';
  } else {
    fundamentalNote = '';
  }

  // ═══════════════════════════════════════════════════
  // NEW: Tạo section cho Patterns, Fibonacci, Divergence
  // ═══════════════════════════════════════════════════
  
  // ═══════════════════════════════════════════════════
  // TECHNICAL INDICATORS SECTION - Chi tiết các chỉ báo
  // ═══════════════════════════════════════════════════
  let technicalSection = '\n**📊 CHỈ BÁO KỸ THUẬT:**\n';
  
  // RSI
  let rsiStatus = '⚪ Trung lập';
  if (tech.rsi > 70) rsiStatus = '🔴 Quá mua - Cẩn thận!';
  else if (tech.rsi > 60) rsiStatus = '🟡 Hơi cao';
  else if (tech.rsi < 30) rsiStatus = '🟢 Quá bán - Cơ hội!';
  else if (tech.rsi < 40) rsiStatus = '🟡 Hơi thấp';
  technicalSection += `• **RSI(14):** ${tech.rsi.toFixed(1)} - ${rsiStatus}\n`;
  if (tech.rsiTrend) {
    technicalSection += `   Xu hướng RSI: ${tech.rsiTrend}\n`;
  }
  
  // MACD
  let macdStatus = '⚪';
  if (tech.macdTrend.includes('BULLISH')) macdStatus = '🟢';
  else if (tech.macdTrend.includes('BEARISH')) macdStatus = '🔴';
  technicalSection += `• **MACD:** ${macdStatus} ${tech.macdTrend}\n`;
  technicalSection += `   MACD: ${tech.macd.toFixed(2)} | Signal: ${tech.macdSignal.toFixed(2)} | Hist: ${tech.macdHistogram >= 0 ? '+' : ''}${tech.macdHistogram.toFixed(2)}\n`;
  
  // Bollinger Bands
  let bbPosition = 'Trong biên độ bình thường';
  const bbWidth = ((tech.bollingerUpper - tech.bollingerLower) / tech.bollingerMiddle * 100).toFixed(1);
  if (tech.currentPrice >= tech.bollingerUpper * 0.98) {
    bbPosition = '🔴 Chạm/vượt dải trên - có thể điều chỉnh';
  } else if (tech.currentPrice <= tech.bollingerLower * 1.02) {
    bbPosition = '🟢 Chạm dải dưới - có thể hồi';
  } else if (tech.currentPrice > tech.bollingerMiddle) {
    bbPosition = '🟡 Trên dải giữa (MA20)';
  } else {
    bbPosition = '🟡 Dưới dải giữa (MA20)';
  }
  technicalSection += `• **Bollinger Bands:** ${bbPosition}\n`;
  technicalSection += `   Trên: ${formatVND(tech.bollingerUpper)} | Giữa: ${formatVND(tech.bollingerMiddle)} | Dưới: ${formatVND(tech.bollingerLower)} | Độ rộng: ${bbWidth}%\n`;
  
  // RS (Relative Strength) - Chi tiết
  if (tech.rs > 0) {
    technicalSection += `\n**⚡ CHỈ SỐ RS (Sức mạnh tương đối):**\n`;
    technicalSection += `${tech.rsSignal}\n`;
    
    // Đánh giá RS chi tiết
    if (tech.rs >= 80) {
      technicalSection += `📌 RS > 80: Cổ phiếu đang DẪN DẮT thị trường mạnh mẽ!\n`;
    } else if (tech.rs >= 70) {
      technicalSection += `📌 RS 70-80: Cổ phiếu MẠNH HƠN đa số, đáng chú ý!\n`;
    } else if (tech.rs >= 60) {
      technicalSection += `📌 RS 60-70: Cổ phiếu trên trung bình, đang được quan tâm.\n`;
    } else if (tech.rs >= 40) {
      technicalSection += `📌 RS 40-60: Cổ phiếu diễn biến NGANG thị trường.\n`;
    } else {
      technicalSection += `📌 RS < 40: Cổ phiếu YẾU HƠN thị trường, nên cẩn thận.\n`;
    }
    
    // Tốc độ RS - dùng % thay đổi thay vì số tuyệt đối để công bằng hơn
    // VD: -2/89 = 2.2% → nhỏ, không đáng kể; nhưng -2/20 = 10% → lớn
    const rsVelocityPercent = tech.rs > 0 ? (tech.rsVelocity / tech.rs) * 100 : 0;
    
    if (rsVelocityPercent >= 3) {
      technicalSection += `🚀 RS TĂNG TỐC: +${rsVelocityPercent.toFixed(1)}%/ngày (${tech.rsVelocity > 0 ? '+' : ''}${tech.rsVelocity.toFixed(1)} điểm) - Dòng tiền đổ vào!\n`;
    } else if (rsVelocityPercent >= 1) {
      technicalSection += `📈 RS tăng nhẹ: +${rsVelocityPercent.toFixed(1)}%/ngày\n`;
    } else if (rsVelocityPercent <= -5) {
      technicalSection += `📉 RS GIẢM MẠNH: ${rsVelocityPercent.toFixed(1)}%/ngày - Dòng tiền rút nhanh!\n`;
    } else if (rsVelocityPercent <= -3) {
      technicalSection += `📉 RS giảm đáng chú ý: ${rsVelocityPercent.toFixed(1)}%/ngày\n`;
    } else if (Math.abs(rsVelocityPercent) < 3) {
      // Ổn định, không cần cảnh báo gì đặc biệt
      if (tech.rs >= 70) {
        technicalSection += `📊 RS cao và ổn định - CP đang DẪN DẮT thị trường\n`;
      }
    }
    
    // Phân loại CP theo RS
    if (tech.rsCategory === 'TĂNG TỐC') {
      technicalSection += `🏆 Phân loại: **CP TĂNG TỐC** - Momentum bùng nổ, cơ hội tốt!\n`;
    } else if (tech.rsCategory === 'NỀN CAO') {
      technicalSection += `🏆 Phân loại: **CP NỀN RS CAO** - Theo dõi khi RS tăng tốc\n`;
    }
    
    // Khuyến nghị dựa trên RS + vị trí giá
    // RS cao + giá > MA10 và MA50 → setup tốt để quan sát đầu tư
    if (tech.rs >= 70 && tech.currentPrice > tech.ma10 && tech.currentPrice > tech.ma50) {
      technicalSection += `💡 **ĐÁNG QUAN SÁT:** RS cao + Giá trên MA10 & MA50 → Cấu trúc tốt để đầu tư!\n`;
    } else if (tech.rs >= 70 && tech.currentPrice > tech.ma10 && tech.currentPrice < tech.ma50) {
      technicalSection += `💡 RS cao nhưng giá dưới MA50 → Chờ breakout MA50 để xác nhận\n`;
    } else if (tech.rs >= 60 && tech.currentPrice > tech.ma10 && tech.currentPrice > tech.ma50 && Math.abs(rsVelocityPercent) < 3) {
      technicalSection += `💡 RS khá + ổn định + Giá trên các MA → Theo dõi nếu RS tiếp tục cải thiện\n`;
    }
    
    // MA10 + MA49 của RS
    if (tech.rsMA10 > 0 || tech.rsMA49 > 0) {
      var rsPos10 = tech.rs > tech.rsMA10 ? 'TRÊN' : 'DƯỚI';
      var rsPos49 = tech.rsMA49 > 0 ? (tech.rs > tech.rsMA49 ? 'TRÊN' : 'DƯỚI') : '';
      technicalSection += `\n📏 **RS Signal Lines:** RS=${tech.rs.toFixed(0)}`;
      if (tech.rsMA10 > 0) technicalSection += ` | MA10=${tech.rsMA10.toFixed(0)} (${rsPos10})`;
      if (tech.rsMA49 > 0) technicalSection += ` | MA49=${tech.rsMA49.toFixed(0)} (${rsPos49})`;
      technicalSection += `\n`;
      if (tech.rsCrossMA10 === 'cross_up') {
        technicalSection += `🔺 **RS VỪA CẮT LÊN MA10** → Signal T+ nhanh!\n`;
      }
      if (tech.rsCrossMA49 === 'cross_up') {
        technicalSection += `🔺 **RS VỪA CẮT LÊN MA49** → Xác nhận trend trung hạn!\n`;
      } else if (tech.rsCrossMA49 === 'cross_down') {
        technicalSection += `🔻 RS cắt xuống MA49 → Momentum suy yếu\n`;
      }
    }
    
    // RS Acceleration
    if (tech.rsAcceleration > 1) {
      technicalSection += `🚀 RS đang TĂNG TỐC (accel: +${tech.rsAcceleration.toFixed(1)})\n`;
    } else if (tech.rsAcceleration < -1) {
      technicalSection += `⚠️ RS đang GIẢM TỐC (accel: ${tech.rsAcceleration.toFixed(1)})\n`;
    }
    
    // RS New High
    if (tech.rsNewHigh) {
      technicalSection += `⭐ **RS NEW HIGH 20 PHIÊN** → CP outperform thị trường mạnh, giá có thể theo sau!\n`;
    }
    
    // Xu hướng RS
    const trendLabel = tech.rsTrendDirection === 'uptrend' ? '↑ TĂNG' : (tech.rsTrendDirection === 'downtrend' ? '↓ GIẢM' : '→ ĐI NGANG');
    technicalSection += `📊 Xu hướng RS (10 phiên): ${trendLabel}\n`;
    
    // Phân kỳ RS vs Giá
    if (tech.rsDivergence === 'bullish') {
      technicalSection += `📈 **PHÂN KỲ DƯƠNG:** Giá giảm nhưng RS tăng → Sắp hồi phục, cơ hội mua!\n`;
    } else if (tech.rsDivergence === 'bearish') {
      technicalSection += `📉 **PHÂN KỲ ÂM:** Giá tăng nhưng RS giảm → Cẩn thận giai đoạn phân phối!\n`;
    }
  }

  
  // ADX/DMI section - Đánh giá sức mạnh xu hướng
  if (tech.adx > 0) {
    technicalSection += `\n**📊 ADX/DMI (Sức mạnh xu hướng):**\n`;
    technicalSection += `• **ADX:** ${tech.adx.toFixed(1)} (phiên trước: ${tech.adxPrev.toFixed(1)}, ${tech.adxDirection === 'rising' ? '↑ đang tăng' : tech.adxDirection === 'falling' ? '↓ đang giảm' : '→ đi ngang'}) - ${tech.adxTrend}\n`;
    technicalSection += `• **+DI:** ${tech.plusDI.toFixed(1)} | **-DI:** ${tech.minusDI.toFixed(1)}\n`;
    technicalSection += `• ${tech.dmiSignal}\n`;
    
    // Đánh giá ADX chi tiết
    if (tech.adx < 20) {
      technicalSection += `📣 ADX < 20: Thị trường SIDEWAY, không có xu hướng rõ ràng\n`;
    } else if (tech.adx >= 44) {
      technicalSection += `📣 ADX >= 44: Xu hướng CỰC MẠNH nhưng thường sẽ tạo đỉnh ADX rồi đảo chiều!\n`;
    } else if (tech.adx >= 40) {
      technicalSection += `📣 ADX >= 40: Xu hướng RẤT MẠNH, có thể giao dịch theo trend\n`;
    } else if (tech.adx >= 25) {
      technicalSection += `📣 ADX 25-40: Xu hướng đã hình thành, có thể tham gia\n`;
    }
    
    // Cảnh báo vùng đảo chiều ADX
    if (tech.adxReversalZone) {
      technicalSection += `\n🔔 **${tech.adxReversalZone}**\n`;
      technicalSection += `${tech.adxReversalWarning}\n`;
    }
  }
  
  // ═══════════════════════════════════════════════════
  // PERFECT BUY SIGNAL - RS TĂNG TỐC + MA10 CROSSOVER
  // ═══════════════════════════════════════════════════
  if (tech.perfectBuyMessage) {
    technicalSection += `\n**🎯 TÍN HIỆU RS + MA10:**\n`;
    technicalSection += `${tech.perfectBuyMessage}\n`;
    
    // Thêm chi tiết về MA10
    if (tech.ma10Crossover) {
      technicalSection += `✅ Giá vừa CẮT LÊN MA10 (${formatVND(tech.ma10)}) → Điểm vào lý tưởng!\n`;
    } else if (tech.currentPrice > tech.ma10) {
      technicalSection += `✅ Giá đang trên MA10 (${formatVND(tech.ma10)})\n`;
    } else {
      technicalSection += `⏳ Giá còn dưới MA10 (${formatVND(tech.ma10)}) - Chờ breakout\n`;
    }
  }
  
  // MFI (Money Flow Index) - Đánh giá dòng tiền chi tiết
  if (tech.mfi) {
    technicalSection += `\n**💰 MFI - DÒNG TIỀN (Money Flow Index):**\n`;
    technicalSection += `• **MFI(14):** ${tech.mfi.toFixed(1)} (phiên trước: ${tech.mfiPrev.toFixed(1)}, ${tech.mfiTrend === 'rising' ? '↑ tăng' : tech.mfiTrend === 'falling' ? '↓ giảm' : '→ ngang'})\n`;
    technicalSection += `• ${tech.mfiSignal}\n`;
    if (tech.mfiDivergence) {
      technicalSection += `• ${tech.mfiDivergence}\n`;
    }
    if (tech.mfiMoneyFlowStrength) {
      technicalSection += `• ${tech.mfiMoneyFlowStrength}\n`;
    }
  }
  
  // Candlestick Patterns Section
  let patternSection = '';
  if (tech.candlestickPatterns.length > 0) {
    const strongPatterns = tech.candlestickPatterns.filter(p => p.confidence >= 2);
    if (strongPatterns.length > 0) {
      patternSection = '\n**🕯️ TÍN HIỆU NẾN:**\n';
      strongPatterns.slice(0, 2).forEach(p => {
        patternSection += `• **${p.name}**: ${p.signal}\n`;
      });
    }
  }
  
  // Fibonacci Section - Bao gồm cả Extension để dự phóng target
  let fibSection = '';
  if (tech.fibonacci) {
    const fib = tech.fibonacci;
    fibSection = '\n**📐 FIBONACCI:**\n';
    
    // Retracement levels - chỉ hiển thị hỗ trợ/kháng cự gần nhất
    if (fib.nearestSupport && fib.nearestResistance) {
      fibSection += `• Hỗ trợ Fib: **${formatVND(fib.nearestSupport.value)}**\n`;
      fibSection += `• Kháng cự Fib: **${formatVND(fib.nearestResistance.value)}**\n`;
    }
    
    // Fibonacci Extension - Chỉ hiển thị target chính, không liệt kê các mức
    if (fib.targetByFib > 0 && fib.isUpswing) {
      const upside = ((fib.targetByFib - tech.currentPrice) / tech.currentPrice * 100).toFixed(1);
      fibSection += `• 🎯 Target Fib Extension: **${formatVND(fib.targetByFib)}** (+${upside}%)\n`;
    }
  }
  
  // Divergence Section
  let divergenceSection = '';
  if (tech.divergence.hasDivergence) {
    divergenceSection = '\n**⚡ PHÂN KỲ:**\n';
    if (tech.divergence.rsiDivergence.type) {
      divergenceSection += `${tech.divergence.rsiDivergence.signal}\n`;
    }
    if (tech.divergence.macdDivergence.type) {
      divergenceSection += `${tech.divergence.macdDivergence.signal}\n`;
    }
  }

  // ═══════════════════════════════════════════════════
  // FUNDAMENTAL ANALYSIS SECTION - Phân tích cơ bản
  // ═══════════════════════════════════════════════════
  let fundamentalSection = '';
  if (fund.latestEPS !== 0 || fund.roe !== 0 || fund.pe !== 0) {
    fundamentalSection = '\n**💼 PHÂN TÍCH CƠ BẢN:**\n';
    
    // EPS hiện tại
    if (fund.latestEPS !== 0) {
      const epsIcon = fund.latestEPS > 2000 ? '🟢' : fund.latestEPS > 1000 ? '🟡' : fund.latestEPS > 0 ? '⚪' : '🔴';
      fundamentalSection += `• **EPS TTM:** ${fund.latestEPS.toLocaleString('vi-VN')} đ ${epsIcon}\n`;
    }
    
    // EPS 4 quý gần nhất
    if (fund.quarterlyData && fund.quarterlyData.length > 0) {
      fundamentalSection += `• **EPS 4 quý:** `;
      const epsQuarters = fund.quarterlyData.map(q => `${q.quarter}: ${q.eps.toLocaleString('vi-VN')}`).join(' | ');
      fundamentalSection += `${epsQuarters}\n`;
    }
    
    // ROE
    if (fund.roe !== 0) {
      let roeIcon = '⚪';
      let roeComment = '';
      if (fund.roe > 20) { roeIcon = '🟢'; roeComment = 'Xuất sắc'; }
      else if (fund.roe > 15) { roeIcon = '🟢'; roeComment = 'Tốt'; }
      else if (fund.roe > 10) { roeIcon = '🟡'; roeComment = 'Khá'; }
      else if (fund.roe > 5) { roeIcon = '⚪'; roeComment = 'Trung bình'; }
      else { roeIcon = '🔴'; roeComment = 'Yếu'; }
      fundamentalSection += `• **ROE:** ${fund.roe.toFixed(1)}% ${roeIcon} ${roeComment}\n`;
    }
    
    // ROA
    if (fund.roa !== 0) {
      const roaIcon = fund.roa > 10 ? '🟢' : fund.roa > 5 ? '🟡' : '⚪';
      fundamentalSection += `• **ROA:** ${fund.roa.toFixed(1)}% ${roaIcon}\n`;
    }
    
    // P/E
    if (fund.pe !== 0 && fund.pe > 0) {
      let peIcon = '⚪';
      let peComment = '';
      if (fund.pe < 10) { peIcon = '🟢'; peComment = 'Rẻ'; }
      else if (fund.pe < 15) { peIcon = '🟢'; peComment = 'Hợp lý'; }
      else if (fund.pe < 20) { peIcon = '🟡'; peComment = 'Trung bình'; }
      else if (fund.pe < 30) { peIcon = '🟠'; peComment = 'Hơi cao'; }
      else { peIcon = '🔴'; peComment = 'Đắt'; }
      fundamentalSection += `• **P/E:** ${fund.pe.toFixed(1)}x ${peIcon} ${peComment}\n`;
    }
    
    // P/B
    if (fund.pb !== 0 && fund.pb > 0) {
      let pbIcon = '⚪';
      let pbComment = '';
      if (fund.pb < 1) { pbIcon = '🟢'; pbComment = 'Dưới giá trị sổ sách'; }
      else if (fund.pb < 1.5) { pbIcon = '🟢'; pbComment = 'Hợp lý'; }
      else if (fund.pb < 2.5) { pbIcon = '🟡'; pbComment = 'Trung bình'; }
      else if (fund.pb < 4) { pbIcon = '🟠'; pbComment = 'Hơi cao'; }
      else { pbIcon = '🔴'; pbComment = 'Cao'; }
      fundamentalSection += `• **P/B:** ${fund.pb.toFixed(2)}x ${pbIcon} ${pbComment}\n`;
    }
    
    // Tăng trưởng doanh thu
    if (fund.salesGrowth !== 0) {
      const salesIcon = fund.salesGrowth > 20 ? '🟢' : fund.salesGrowth > 10 ? '🟡' : fund.salesGrowth > 0 ? '⚪' : '🔴';
      fundamentalSection += `• **Tăng trưởng DT:** ${fund.salesGrowth > 0 ? '+' : ''}${fund.salesGrowth.toFixed(1)}% ${salesIcon}\n`;
    }
    
    // Tăng trưởng lợi nhuận
    if (fund.profitGrowth !== 0) {
      const profitIcon = fund.profitGrowth > 20 ? '🟢' : fund.profitGrowth > 10 ? '🟡' : fund.profitGrowth > 0 ? '⚪' : '🔴';
      fundamentalSection += `• **Tăng trưởng LN:** ${fund.profitGrowth > 0 ? '+' : ''}${fund.profitGrowth.toFixed(1)}% ${profitIcon}\n`;
    }
    
    // Nợ/Vốn
    if (fund.debtToEquity !== 0) {
      let debtIcon = '⚪';
      let debtComment = '';
      if (fund.debtToEquity < 0.5) { debtIcon = '🟢'; debtComment = 'Rất an toàn'; }
      else if (fund.debtToEquity < 1) { debtIcon = '🟢'; debtComment = 'An toàn'; }
      else if (fund.debtToEquity < 1.5) { debtIcon = '🟡'; debtComment = 'Trung bình'; }
      else if (fund.debtToEquity < 2) { debtIcon = '🟠'; debtComment = 'Hơi cao'; }
      else { debtIcon = '🔴'; debtComment = 'Cao - Rủi ro'; }
      fundamentalSection += `• **Nợ/Vốn:** ${fund.debtToEquity.toFixed(2)}x ${debtIcon} ${debtComment}\n`;
    }
    
    // Đánh giá tổng quan cơ bản
    fundamentalSection += '\n**📊 ĐÁNH GIÁ CƠ BẢN:**\n';
    const fundScore = fund.score;
    if (fundScore >= 75) {
      fundamentalSection += `🟢 **NỀN TẢNG TỐT** (${fundScore}/100): Doanh nghiệp có hiệu quả kinh doanh cao, tài chính lành mạnh.\n`;
    } else if (fundScore >= 60) {
      fundamentalSection += `🟡 **NỀN TẢNG KHÁ** (${fundScore}/100): Doanh nghiệp hoạt động ổn định, không có vấn đề lớn.\n`;
    } else if (fundScore >= 45) {
      fundamentalSection += `⚪ **NỀN TẢNG TRUNG BÌNH** (${fundScore}/100): Cần theo dõi thêm các chỉ số tài chính.\n`;
    } else {
      fundamentalSection += `🔴 **NỀN TẢNG YẾU** (${fundScore}/100): Cần thận trọng, doanh nghiệp có một số vấn đề cần lưu ý.\n`;
    }
  }

  // ═══════════════════════════════════════════════════
  // EXECUTIVE SUMMARY - Tóm tắt TOÀN DIỆN từ các phân tích
  // ═══════════════════════════════════════════════════
  const summaryIcon = {
    'MUA': '🟢',
    'BÁN': '🔴',
    'GIỮ': '🟡',
    'CHỜ': '⏳',
  }[decision.action] || '⚪';
  
  let trendShort = 'đi ngang';
  if (tech.trend === 'Uptrend') trendShort = 'tăng';
  else if (tech.trend === 'Downtrend') trendShort = 'giảm';
  
  // Momentum assessment
  let momentumShort = '';
  if (tech.shortTermScore >= 65) momentumShort = 'Động lượng tích cực.';
  else if (tech.shortTermScore >= 55) momentumShort = 'Động lượng hơi tích cực.';
  else if (tech.shortTermScore <= 35) momentumShort = 'Động lượng yếu, cần thận trọng.';
  else if (tech.shortTermScore <= 45) momentumShort = 'Động lượng hơi tiêu cực.';
  else momentumShort = 'Động lượng trung lập.';
  
  // RS assessment
  let rsShort = '';
  if (tech.rs >= 80) rsShort = `RS ${tech.rs.toFixed(0)} - Mạnh hơn 80% thị trường.`;
  else if (tech.rs >= 70) rsShort = `RS ${tech.rs.toFixed(0)} - Sức mạnh tương đối tốt.`;
  else if (tech.rs >= 50) rsShort = `RS ${tech.rs.toFixed(0)} - Trung bình.`;
  else if (tech.rs > 0) rsShort = `RS ${tech.rs.toFixed(0)} - Yếu hơn thị trường.`;
  
  // Fundamental assessment
  let fundShort = '';
  if (fund.score >= 70) fundShort = 'Nền tảng cơ bản tốt.';
  else if (fund.score >= 55) fundShort = 'Nền tảng cơ bản khá.';
  else if (fund.score >= 40) fundShort = 'Nền tảng cơ bản trung bình.';
  else if (fund.score > 0) fundShort = 'Nền tảng cơ bản yếu.';
  
  // Volume assessment - So sánh với MA50
  let volShort = '';
  if (tech.volumeAboveMA50Count >= 7) {
    volShort = `🟢 DÒNG TIỀN VÀO MẠNH (${tech.volumeAboveMA50Count}/10 phiên > MA50).`;
  } else if (tech.volumeAboveMA50Count >= 5) {
    volShort = `Dòng tiền vào khá (${tech.volumeAboveMA50Count}/10 phiên > MA50).`;
  } else if (tech.volumeAboveMA50Count >= 3) {
    volShort = `Dòng tiền trung bình.`;
  } else {
    volShort = `🔴 Dòng tiền yếu (${tech.volumeAboveMA50Count}/10 phiên > MA50).`;
  }
  
  // ═══════════════════════════════════════════════════
  // PATTERN ANALYSIS SUMMARY - Tóm tắt mô hình
  // ═══════════════════════════════════════════════════
  let patternSummary = '';
  if (patternAnalysis) {
    const parts: string[] = [];
    
    // VCP Pattern
    if (patternAnalysis.vcp.isVCP) {
      if (patternAnalysis.vcp.stage === 'ready') {
        parts.push(`🎯 VCP SẴN SÀNG BREAKOUT (${patternAnalysis.vcp.contractions} contractions)`);
      } else if (patternAnalysis.vcp.stage === 'breakout') {
        parts.push(`🚀 VCP ĐÃ BREAKOUT!`);
      } else if (patternAnalysis.vcp.stage === 'forming') {
        parts.push(`📊 VCP đang hình thành`);
      }
    }
    
    // 3C Pattern
    if (patternAnalysis.threeC.detected) {
      if (patternAnalysis.threeC.breakoutReady) {
        parts.push(`🎯 3C Pattern sẵn sàng breakout`);
      } else {
        parts.push(`📊 3C Pattern phase: ${patternAnalysis.threeC.phase}`);
      }
    }
    
    // Other patterns
    const bullishPatterns = patternAnalysis.patterns.filter(p => p.type === 'bullish' && p.confidence >= 60);
    const bearishPatterns = patternAnalysis.patterns.filter(p => p.type === 'bearish' && p.confidence >= 60);
    
    if (bullishPatterns.length > 0) {
      parts.push(`🟢 Mô hình tăng: ${bullishPatterns.map(p => p.name).join(', ')}`);
    }
    if (bearishPatterns.length > 0) {
      parts.push(`🔴 Mô hình giảm: ${bearishPatterns.map(p => p.name).join(', ')}`);
    }
    
    // Multi-timeframe
    if (patternAnalysis.multiTimeframe) {
      const mtf = patternAnalysis.multiTimeframe;
      if (mtf.alignment === 'strong_bullish') {
        parts.push(`📈 Multi-TF: ĐỒNG THUẬN TĂNG MẠNH (ngày + tuần)`);
      } else if (mtf.alignment === 'strong_bearish') {
        parts.push(`📉 Multi-TF: ĐỒNG THUẬN GIẢM MẠNH`);
      } else if (mtf.explosivePotential) {
        parts.push(`🚀 TIỀM NĂNG TĂNG MẠNH: Vol bùng nổ + trên MA10 tuần`);
      }
    }
    
    // Fibonacci targets for ATH breakout
    if (patternAnalysis.fibonacci.isATHBreakout && patternAnalysis.fibonacci.nearestTarget > 0) {
      parts.push(`🎯 ATH Breakout - Target Fib: ${formatVND(patternAnalysis.fibonacci.nearestTarget)}`);
    }
    
    if (parts.length > 0) {
      patternSummary = parts.join(' | ');
    }
  }
  
  // ═══════════════════════════════════════════════════
  // INDUSTRY VALUATION SUMMARY - Tóm tắt định giá ngành
  // ═══════════════════════════════════════════════════
  let industrySummary = '';
  if (industryComparison) {
    const ic = industryComparison;
    if (ic.overallVerdict === 'undervalued') {
      industrySummary = `💰 ĐỊNH GIÁ HẤP DẪN so với ngành ${ic.industryName} (P/E ${ic.stockPE.toFixed(1)}x vs ${ic.industryPE.toFixed(1)}x, upside ${ic.upside > 0 ? '+' : ''}${ic.upside.toFixed(0)}%)`;
    } else if (ic.overallVerdict === 'overvalued') {
      industrySummary = `⚠️ ĐỊNH GIÁ CAO so với ngành ${ic.industryName} (P/E ${ic.stockPE.toFixed(1)}x vs ${ic.industryPE.toFixed(1)}x)`;
    } else {
      industrySummary = `📊 Định giá hợp lý so với ngành ${ic.industryName}`;
    }
  }
  
  // ═══════════════════════════════════════════════════
  // TARGET CALCULATION - Tính target từ nhiều nguồn
  // Logic: Pattern target > Đỉnh 52 tuần > Fibonacci > Industry
  // ═══════════════════════════════════════════════════
  let primaryTarget = tech.nearestResistance;
  let targetSource = 'Kháng cự kỹ thuật';
  
  // 1. Đỉnh 52 tuần - Target ngắn hạn (kháng cự đầu tiên)
  if (tech.high52Week > tech.currentPrice && tech.distanceFromHigh52W >= 5 && tech.distanceFromHigh52W <= 30) {
    primaryTarget = tech.high52Week;
    targetSource = 'Đỉnh 52 tuần';
  }
  
  // 2. Fibonacci Extension từ technical analysis
  if (tech.fibonacci && tech.fibonacci.targetByFib > tech.currentPrice && tech.fibonacci.isUpswing) {
    if (tech.fibonacci.targetByFib > primaryTarget) {
      primaryTarget = tech.fibonacci.targetByFib;
      targetSource = 'Fibonacci Extension';
    }
  }
  
  // 3. Nếu có Fibonacci extension từ pattern analysis (ATH breakout)
  if (patternAnalysis?.fibonacci.isATHBreakout && patternAnalysis.fibonacci.nearestTarget > tech.currentPrice) {
    if (patternAnalysis.fibonacci.nearestTarget > primaryTarget) {
      primaryTarget = patternAnalysis.fibonacci.nearestTarget;
      targetSource = 'Fib Extension (ATH Breakout)';
    }
  }
  
  // 4. Target từ pattern analysis (Cup & Handle, VCP, etc.) - ƯU TIÊN CAO NHẤT
  // Pattern target thường là target dài hạn, cao hơn đỉnh 52 tuần
  if (patternAnalysis && patternAnalysis.primaryTarget > tech.currentPrice) {
    // Chỉ dùng pattern target nếu có pattern mạnh (confidence >= 70%)
    const bestPattern = patternAnalysis.patterns[0];
    if (bestPattern && bestPattern.confidence >= 70 && patternAnalysis.primaryTarget > primaryTarget) {
      primaryTarget = patternAnalysis.primaryTarget;
      targetSource = bestPattern.name;
    }
  }
  
  // 5. Nếu chưa có target hợp lý, dùng fair price từ industry comparison
  if (primaryTarget <= tech.nearestResistance && industryComparison && industryComparison.fairPriceByPE > tech.currentPrice) {
    primaryTarget = industryComparison.fairPriceByPE;
    targetSource = 'Định giá ngành';
  }
  
  // Đảm bảo target > giá hiện tại
  if (primaryTarget <= tech.currentPrice) {
    primaryTarget = tech.currentPrice * 1.10;
    targetSource = 'Ước tính +10%';
  }
  
  const targetUpside = ((primaryTarget - tech.currentPrice) / tech.currentPrice * 100).toFixed(1);
  const downsidePercent = tech.nearestSupport > 0 ? ((tech.currentPrice - tech.nearestSupport) / tech.currentPrice * 100).toFixed(1) : '0';
  
  // Build comprehensive executive summary
  let executiveSummary = `${summaryIcon} **TÓM TẮT NHANH:** ${decision.action} | Giá: ${formatVND(tech.currentPrice)} | Xu hướng: ${trendShort.toUpperCase()}

**📊 TỔNG QUAN:**
${symbol} đang giao dịch quanh vùng ${formatVND(tech.currentPrice)}, xu hướng ngắn hạn ${trendShort}. ${momentumShort}${rsShort ? ` ${rsShort}` : ''}${fundShort ? ` ${fundShort}` : ''}${volShort ? ` ${volShort}` : ''}
${patternSummary ? `\n**📈 MÔ HÌNH:** ${patternSummary}` : ''}
${industrySummary ? `\n**${industrySummary}**` : ''}

**🎯 VÙNG GIÁ & MỤC TIÊU:**
• Hỗ trợ: ${formatVND(tech.nearestSupport)} (-${downsidePercent}%)
• Kháng cự: ${formatVND(tech.nearestResistance)}
• **Target: ${formatVND(primaryTarget)} (+${targetUpside}%)** ← ${targetSource}
• Stop Loss: ${formatVND(decision.stopLoss)}

**💡 KHUYẾN NGHỊ:**
${decision.action === 'MUA' ? `Có thể cân nhắc vào lệnh tại vùng giá hiện tại hoặc chờ rung về ${formatVND(tech.nearestSupport)}. Target ${formatVND(primaryTarget)}. Cắt lỗ nếu mất ${formatVND(decision.stopLoss)}.` : decision.action === 'BÁN' ? `Nên cắt giảm vị thế hoặc bảo vệ lợi nhuận. Cổ phiếu có dấu hiệu suy yếu.` : decision.action === 'GIỮ' ? `Giữ và theo dõi. Chờ tín hiệu rõ hơn trước khi hành động.` : `Chờ điểm vào tốt hơn. Không mua đuổi giá, ưu tiên chờ rung về vùng hỗ trợ.`}

---

`;

  return {
    text: executiveSummary + `**📈 PHÂN TÍCH KỸ THUẬT ${symbol}**

${symbol} đang giao dịch quanh vùng **${formatVND(tech.currentPrice)}**, ${stockState}.

${trendComment}

${volumeComment}

**📍 VÙNG GIÁ QUAN TRỌNG:**
• Vùng hỗ trợ gần: **${formatVND(supportNear)}** (${tech.supportLabel})
• Vùng kháng cự gần: **${formatVND(resistNear)}** (${tech.resistanceLabel})

**📊 CÁC ĐƯỜNG MA:**
• MA10: ${formatVND(tech.ma10)} | MA20: ${formatVND(tech.ma20)} | MA50: ${formatVND(tech.ma50)}
• MA100: ${formatVND(tech.ma100)} | MA200: ${formatVND(tech.ma200)}

${tech.distanceFromHigh52W > 5 ? `• 🎯 Đỉnh 52 tuần: **${formatVND(tech.high52Week)}** (cách ${tech.distanceFromHigh52W.toFixed(1)}%)` : ''}
${tech.distanceFromLow52W > 20 ? `• Đáy 52 tuần: **${formatVND(tech.low52Week)}** (+${tech.distanceFromLow52W.toFixed(1)}% từ đáy)` : ''}
${supportDeep < supportNear * 0.97 ? `• Nếu rung mạnh hơn, vùng **${formatVND(supportDeep)}** sẽ đóng vai trò nâng đỡ` : ''}
${formatTrendlineSection(tech)}${patternSection}${fibSection}${divergenceSection}${technicalSection}${fundamentalSection}
${tech.activeBuyPercent >= 0 ? `**📊 LỰC CUNG CẦU CHỦ ĐỘNG:**\n• ${symbol}: ${tech.activeBuyPercent.toFixed(1)}% (${tech.activeBuyRating})${marketPressure ? `\n• VNINDEX: ${marketPressure.vnindexBuyPercent.toFixed(1)}% (${marketPressure.vnindexRating})\n→ ${symbol} ${tech.activeBuyPercent > marketPressure.vnindexBuyPercent ? 'MẠNH HƠN' : tech.activeBuyPercent < marketPressure.vnindexBuyPercent ? 'YẾU HƠN' : 'TƯƠNG ĐƯƠNG'} thị trường` : ''}\n` : ''}
**💼 CHIẾN LƯỢC:**
${strategyHolding}

${strategyWaiting}

**📌 KỊCH BẢN:**
${scenarioPositive}

${scenarioNegative}

---
*${closingLine}*`,
    chartUrl: '',
  };
}


// ═══════════════════════════════════════════════════
// VNINDEX REPORT - Báo cáo riêng cho chỉ số thị trường
// ═══════════════════════════════════════════════════

/**
 * Format trendline section cho báo cáo (VNINDEX hoặc CP thường)
 */
function formatTrendlineSection(tech: TechnicalResult): string {
  const tl = tech.trendlineResult;
  if (!tl || tl.trendlines.length === 0) return '';
  
  let section = '\n**📐 PHÂN TÍCH TRENDLINE DÀI HẠN:**\n';
  
  // Hiển thị trendline kháng cự gần nhất
  if (tl.nearestResistanceTrendline) {
    const rt = tl.nearestResistanceTrendline;
    const strengthIcon = rt.strength >= 70 ? '🔴🔴🔴' : rt.strength >= 50 ? '🔴🔴' : '🔴';
    const strengthLabel = rt.strength >= 70 ? 'RẤT MẠNH' : rt.strength >= 50 ? 'MẠNH' : 'TRUNG BÌNH';
    
    // Format giá trị trendline (cho VNINDEX dùng điểm, cho CP dùng VNĐ)
    const isIndex = tech.currentPrice > 100 && tech.currentPrice < 5000; // VNINDEX range
    const formatVal = isIndex ? (v: number) => v.toFixed(0) : (v: number) => formatVND(v);
    const unit = isIndex ? ' điểm' : '';
    
    section += `${strengthIcon} **Kháng cự trendline ${strengthLabel}:** ~**${formatVal(rt.currentValue)}**${unit}`;
    section += ` (cách ${rt.distancePercent.toFixed(1)}%)\n`;
    section += `  → Từ ${rt.startDate.substring(0, 7)} đến ${rt.endDate.substring(0, 7)}, ${rt.touchCount} lần test\n`;
    
    if (rt.isApproaching) {
      section += `  ⚠️ **GIÁ ĐANG TIẾN GẦN TRENDLINE NÀY!** Khả năng điều chỉnh khi chạm vùng này là cao.\n`;
    }
  }
  
  // Hiển thị trendline hỗ trợ gần nhất
  if (tl.nearestSupportTrendline) {
    const st = tl.nearestSupportTrendline;
    const strengthIcon = st.strength >= 70 ? '🟢🟢🟢' : st.strength >= 50 ? '🟢🟢' : '🟢';
    const strengthLabel = st.strength >= 70 ? 'RẤT MẠNH' : st.strength >= 50 ? 'MẠNH' : 'TRUNG BÌNH';
    
    const isIndex = tech.currentPrice > 100 && tech.currentPrice < 5000;
    const formatVal = isIndex ? (v: number) => v.toFixed(0) : (v: number) => formatVND(v);
    const unit = isIndex ? ' điểm' : '';
    
    section += `${strengthIcon} **Hỗ trợ trendline ${strengthLabel}:** ~**${formatVal(st.currentValue)}**${unit}`;
    section += ` (cách ${st.distancePercent.toFixed(1)}%)\n`;
    section += `  → Từ ${st.startDate.substring(0, 7)} đến ${st.endDate.substring(0, 7)}, ${st.touchCount} lần test\n`;
    
    if (st.isApproaching) {
      section += `  📍 **Giá đang gần vùng hỗ trợ trendline!** Có thể là cơ hội mua tốt.\n`;
    }
  }
  
  // Cảnh báo tổng hợp
  if (tl.warning) {
    section += `\n${tl.warning}\n`;
  }
  
  section += `_(Phân tích trên ${tl.weeklyDataPoints} tuần dữ liệu)_\n`;
  
  return section;
}

function generateVNIndexReport(
  symbol: string,
  tech: TechnicalResult,
  overall: { score: number; rating: string },
  macroNews?: MacroNewsItem[],
  macroAnalysis?: string,
  potentialStocks?: string,
  vnindexStage?: any,
): StockAnalysisResult {
  // MACD status
  let macdIcon = '⚪';
  if (tech.macdTrend.includes('BULLISH')) macdIcon = '🟢';
  else if (tech.macdTrend.includes('BEARISH')) macdIcon = '🔴';
  else if (tech.macdTrend === 'Bullish giảm') macdIcon = '🟡';
  else if (tech.macdTrend === 'Bearish giảm') macdIcon = '🟡';

  // RSI status
  let rsiStatus = '';
  if (tech.rsi < 30) rsiStatus = '(Oversold)';
  else if (tech.rsi > 70) rsiStatus = '(Overbought)';

  // Đánh giá xu hướng ngắn hạn
  let shortTermVerdict = '⚪ Sideway';
  let marketSentiment = 'Thận trọng';
  if (tech.shortTermScore >= 65) {
    shortTermVerdict = '🟢 Tích cực';
    marketSentiment = 'Tích cực, có thể giải ngân';
  } else if (tech.shortTermScore >= 55) {
    shortTermVerdict = '🟡 Hơi tích cực';
    marketSentiment = 'Cân nhắc mua từ từ';
  } else if (tech.shortTermScore <= 35) {
    shortTermVerdict = '🔴 Tiêu cực';
    marketSentiment = 'Hạn chế giải ngân, chờ hồi';
  } else if (tech.shortTermScore <= 45) {
    shortTermVerdict = '🟠 Hơi tiêu cực';
    marketSentiment = 'Thận trọng, có thể điều chỉnh';
  }

  // Đánh giá tổng quan
  let overallVerdict = '⚪ Trung tính';
  if (overall.score >= 65) overallVerdict = '🟢 Tích cực';
  else if (overall.score >= 55) overallVerdict = '🟡 Hơi tích cực';
  else if (overall.score <= 35) overallVerdict = '🔴 Tiêu cực';
  else if (overall.score <= 45) overallVerdict = '🟠 Hơi tiêu cực';

  // Khuyến nghị hành động
  let recommendation = '';
  if (tech.trend === 'Uptrend' && tech.shortTermScore >= 55) {
    recommendation = '✅ Thị trường đang UPTREND, có thể giải ngân vào các CP cơ bản tốt';
  } else if (tech.trend === 'Downtrend' && tech.shortTermScore <= 45) {
    recommendation = '⚠️ Thị trường đang DOWNTREND, hạn chế mua mới, ưu tiên giữ tiền mặt';
  } else if (tech.trend === 'Sideway') {
    recommendation = '⏳ Thị trường SIDEWAY, chọn lọc CP có câu chuyện riêng, tránh đuổi giá';
  } else {
    recommendation = '🔍 Thị trường chưa rõ xu hướng, theo dõi thêm vài phiên';
  }

  // Format giá cho VNINDEX (đơn vị điểm, không chia 1000)
  const formatIndex = (value: number) => value.toFixed(0);
  
  // Xác định trạng thái thị trường bằng ngôn ngữ broker
  let marketState = '';
  if (tech.priceChange > 0.5) {
    marketState = 'đang tăng điểm khá tích cực';
  } else if (tech.priceChange > 0) {
    marketState = 'đang tăng nhẹ, đi ngang trong phiên';
  } else if (tech.priceChange > -0.5) {
    marketState = 'đang rung lắc nhẹ, đi ngang';
  } else if (tech.priceChange > -1.5) {
    marketState = 'đang điều chỉnh nhẹ';
  } else {
    marketState = 'đang có áp lực điều chỉnh';
  }
  
  // Nhận định xu hướng theo broker style (ket hop Stage Analysis)
  let trendComment = '';
  if (vnindexStage && vnindexStage.stage === 4) {
    trendComment = 'Thi truong dang o GIAI DOAN 4 (Declining) - xu huong giam ro rang. Gia duoi MA200, cau truc suy yeu. Chien luoc luc nay la DUNG NGOAI, giu tien mat, cho thi truong tao day.';
  } else if (vnindexStage && vnindexStage.stage === 3) {
    trendComment = 'Thi truong co dau hieu GIAI DOAN 3 (Distribution) - phan phoi. MA50 bat dau di ngang/giam, dong luc tang yeu dan. Can than voi cac nhip tang gia, co the la "bull trap".';
  } else if (tech.trend === 'Uptrend') {
    if (tech.rsiBreakdownFromOB) {
      trendComment = 'Ve tong the, xu huong hien tai van chua co van de gi lon, nhung dong luong tang dang co dau hieu cham lai mot chut. Nhung nhip rung nay chu yeu la rung trong xu huong, chua phai gay.';
    } else {
      trendComment = 'Ve tong the, cau truc thi truong van dang kha on. Xu huong tich cuc van con giu duoc, chua co dau hieu doi chieu.';
    }
  } else if (tech.trend === 'Downtrend') {
    trendComment = 'Thi truong dang trong giai doan dieu chinh. Em thay cau truc co phan suy yeu, nen chien luoc luc nay la uu tien phong thu hon la mo vi the moi.';
  } else {
    trendComment = 'Thi truong dang di ngang, tich luy. Chua co xu huong ro rang nen can cho tin hieu xac nhan them truoc khi co hanh dong.';
  }
  
  // Động lượng & tâm lý
  let momentumComment = '';
  if (tech.volumeRatio > 1.2) {
    momentumComment = 'Thanh khoản hôm nay khá tốt, cho thấy dòng tiền vẫn đang quan tâm.';
  } else if (tech.volumeRatio < 0.8) {
    momentumComment = 'Thanh khoản có phần nhẹ, bên mua lúc này không còn quá vội, giá cần thêm thời gian cân bằng.';
  } else {
    momentumComment = 'Thanh khoản ở mức trung bình, thị trường đang cân bằng giữa cung và cầu.';
  }
  
  // Chiến lược cho 2 nhóm
  let strategyHolding = '';
  let strategyWaiting = '';
  
  // Override chien luoc theo Stage Analysis (uu tien cao nhat)
  if (vnindexStage && vnindexStage.stage === 4) {
    strategyHolding = '**Anh/chi dang co hang:** 🔴 Thi truong Stage 4 (giam gia). Uu tien CAT LO va GIAM TY TRONG manh. Khong trung binh gia xuong. Bao toan von la so 1.';
    strategyWaiting = '**Anh/chi dang cam tien:** 🛡️ DUNG NGOAI. Tien mat la vi the tot nhat luc nay. Cho thi truong tao day va xuat hien Follow-through Day moi hanh dong.';
  } else if (vnindexStage && vnindexStage.stage === 3) {
    strategyHolding = '**Anh/chi dang co hang:** 🟠 Thi truong co dau hieu PHAN PHOI (Stage 3). Nen giam dan ty trong, siet chat stop loss, bao ve loi nhuan.';
    strategyWaiting = '**Anh/chi dang cam tien:** ⏳ Chua nen giai ngan moi. Cho xac nhan thi truong co tiep tuc tang (quay lai Stage 2) hay chuyen sang Stage 4.';
  } else if (tech.trend === 'Uptrend' && tech.shortTermScore >= 55) {
    strategyHolding = '**Anh/chi dang co hang:** Co the tiep tuc giu, theo doi phan ung gia. Mien vung ho tro gan van giu duoc thi chua can lo.';
    strategyWaiting = '**Anh/chi dang cam tien:** Co the can nhac tung phan, nhung khong nen mua duoi. Cho nhung nhip rung ve vung ho tro se an toan hon.';
  } else if (tech.trend === 'Downtrend' || tech.shortTermScore <= 45) {
    strategyHolding = '**Anh/chi dang co hang:** Uu tien quan tri rui ro, co the giam bot ty trong neu thay ap luc ban tang. Khong nen trung binh gia xuong luc nay.';
    strategyWaiting = '**Anh/chi dang cam tien:** Em khuyen khich tiep tuc quan sat, cho tin hieu ro rang hon. Khong can voi, co hoi se con.';
  } else {
    strategyHolding = '**Anh/chi dang co hang:** Co the giu va quan sat. Giai doan nay can kien nhan, khong nen hanh dong voi.';
    strategyWaiting = '**Anh/chi dang cam tien:** Thi truong chua qua ro rang, em goi y cho them vai phien de co tin hieu xac nhan.';
  }
  
  // Câu chốt broker style
  let closingLine = '';
  if (vnindexStage && vnindexStage.stage === 4) {
    closingLine = 'Thi truong dang o Stage 4. Khong can phai co hang moi luc, tien mat la vi the manh nhat. Cho co hoi moi se den.';
  } else if (vnindexStage && vnindexStage.stage === 3) {
    closingLine = 'Thi truong co dau hieu phan phoi. Bao ve loi nhuan la uu tien, ky luat la chia khoa.';
  } else if (tech.shortTermScore >= 55) {
    closingLine = 'Co hoi van con, nhung quan trong nhat la ky luat. Minh di cham ma chac se tot hon.';
  } else if (tech.shortTermScore <= 45) {
    closingLine = 'Giai doan nay uu tien an toan. Khong can phai co hang moi luc, doi khi tien mat cung la mot vi the.';
  } else {
    closingLine = 'Thi truong can them thoi gian. Kien nhan va ky luat se giup anh/chi vuot qua giai doan nay.';
  }

  // Tạo section tin tức vĩ mô nếu có
  let macroNewsSection = '';
  if (macroNews && macroNews.length > 0) {
    macroNewsSection = `\n**📰 TIN TỨC VĨ MÔ (24H):**\n`;
    macroNews.slice(0, 5).forEach((news) => {
      macroNewsSection += `• ${news.title}\n`;
    });
    
    if (macroAnalysis) {
      macroNewsSection += `\n**🤖 NHẬN ĐỊNH:**\n${macroAnalysis}`;
    }
    macroNewsSection += '\n';
  }

  // Tạo section cổ phiếu tiềm năng (Breakout)
  let potentialStocksSection = '';
  if (potentialStocks) {
    potentialStocksSection = `\n🚀 **CỔ PHIẾU TIỀM NĂNG (Breakout):**\n${potentialStocks}\n`;
  }

  // ═══════════════════════════════════════════════════
  // ADX/DMI + MFI SECTION FOR VNINDEX
  // ═══════════════════════════════════════════════════
  let vnindexADXSection = '';
  if (tech.adx > 0) {
    vnindexADXSection = `\n**📊 ADX/DMI (Sức mạnh xu hướng):**\n`;
    vnindexADXSection += `• **ADX:** ${tech.adx.toFixed(1)} (${tech.adxDirection === 'rising' ? '↑ tăng' : tech.adxDirection === 'falling' ? '↓ giảm' : '→ ngang'}) - ${tech.adxTrend}\n`;
    vnindexADXSection += `• **+DI:** ${tech.plusDI.toFixed(1)} | **-DI:** ${tech.minusDI.toFixed(1)} → ${tech.dmiSignal}\n`;
    
    if (tech.adxReversalZone) {
      vnindexADXSection += `\n🔔 **${tech.adxReversalZone}**\n`;
      vnindexADXSection += `${tech.adxReversalWarning}\n`;
    }
  }
  
  // MFI section cho VNINDEX
  let vnindexMFISection = '';
  if (tech.mfi > 0) {
    vnindexMFISection = `\n**💰 MFI - DÒNG TIỀN THỊ TRƯỜNG:**\n`;
    vnindexMFISection += `• **MFI(14):** ${tech.mfi.toFixed(1)} (${tech.mfiTrend === 'rising' ? '↑ tăng' : tech.mfiTrend === 'falling' ? '↓ giảm' : '→ ngang'})\n`;
    vnindexMFISection += `• ${tech.mfiSignal}\n`;
    if (tech.mfiDivergence) {
      vnindexMFISection += `• ${tech.mfiDivergence}\n`;
    }
    if (tech.mfiMoneyFlowStrength) {
      vnindexMFISection += `• ${tech.mfiMoneyFlowStrength}\n`;
    }
  }

  // ═══════════════════════════════════════════════════
  // EXECUTIVE SUMMARY FOR VNINDEX
  // ═══════════════════════════════════════════════════
  let marketTrendShort = 'đi ngang';
  if (tech.trend === 'Uptrend') marketTrendShort = 'tăng';
  else if (tech.trend === 'Downtrend') marketTrendShort = 'giảm';
  
  // Trendline warning cho summary
  const trendlineWarningShort = tech.trendlineResult?.nearestResistanceTrendline?.isApproaching
    ? ` ⚠️ Gần trendline kháng cự dài hạn ~${formatIndex(tech.trendlineResult.nearestResistanceTrendline.currentValue)} điểm!`
    : '';
  
  // ADX reversal warning cho summary
  const adxWarningShort = tech.adxReversalZone
    ? ` ${tech.adxReversalZone.split(' ')[0]} ADX=${tech.adx.toFixed(0)} - ${tech.adxDirection === 'rising' ? 'đang tăng' : tech.adxDirection === 'falling' ? 'đang giảm' : 'đi ngang'}.`
    : '';
  
  // Stage info cho summary
  var stageShort = vnindexStage ? ' | ' + vnindexStage.stageName : '';
  
  const vnindexSummary = `${shortTermVerdict.split(' ')[0]} **TOM TAT NHANH:** Xu huong ${marketTrendShort.toUpperCase()}${stageShort} | VN-Index: ${formatIndex(tech.currentPrice)} diem

Thi truong dang ${marketState}. ${marketSentiment}. Vung ho tro gan tai ${formatIndex(tech.nearestSupport)} diem, khang cu ${formatIndex(tech.nearestResistance)} diem.${trendlineWarningShort}${adxWarningShort}

---

`;

  // Stage Analysis section cho VNINDEX
  var stageSection = '';
  if (vnindexStage) {
    var stageIcon = vnindexStage.stage === 2 ? '🟢' : vnindexStage.stage === 4 ? '🔴' : vnindexStage.stage === 3 ? '🟠' : '🟡';
    var stageAction = '';
    if (vnindexStage.stage === 2) {
      stageAction = 'Day la giai doan TOT NHAT de giao dich. Co the giai ngan vao CP co ban tot, dang Stage 2.';
    } else if (vnindexStage.stage === 4) {
      stageAction = 'DUNG NGOAI! Khong nen mo vi the moi. Uu tien giu tien mat, cho thi truong tao day va chuyen sang Stage 1.';
    } else if (vnindexStage.stage === 3) {
      stageAction = 'Can than! Thi truong co the dang phan phoi. Giam ty trong, bao ve loi nhuan, san sang rut lui.';
    } else {
      stageAction = 'Thi truong dang tich luy. Theo doi tin hieu breakout len tren MA200 de xac nhan chuyen Stage 2.';
    }
    stageSection = '\n**' + stageIcon + ' GIAI DOAN THI TRUONG (Stage Analysis - Minervini):**\n'
      + '• **' + vnindexStage.stageName + '**\n'
      + '• ' + vnindexStage.description + '\n'
      + '• **Hanh dong:** ' + stageAction + '\n';
  }

  return {
    text: vnindexSummary + `**CẬP NHẬT THỊ TRƯỜNG**

VN-Index đang quanh vùng **${formatIndex(tech.currentPrice)} điểm**, ${marketState}.

${trendComment}

${momentumComment}
${stageSection}
**📍 VÙNG GIÁ QUAN TRỌNG:**
• Vùng hỗ trợ gần: **${formatIndex(tech.nearestSupport)}** điểm
• Vùng kháng cự gần: **${formatIndex(tech.nearestResistance)}** điểm

**📊 CÁC ĐƯỜNG MA:**
• MA10: ${formatIndex(tech.ma10)} | MA20: ${formatIndex(tech.ma20)} | MA50: ${formatIndex(tech.ma50)}
• MA100: ${formatIndex(tech.ma100)} | MA200: ${formatIndex(tech.ma200)}

${tech.nearestSupport < tech.currentPrice * 0.97 ? `• Nếu rung mạnh hơn, vùng **${formatIndex(tech.ma50)}** sẽ đóng vai trò nâng đỡ` : ''}
${formatTrendlineSection(tech)}${vnindexADXSection}${vnindexMFISection}
**💼 CHIẾN LƯỢC:**
${strategyHolding}

${strategyWaiting}

**📌 KỊCH BẢN:**
✅ Nếu Index vượt **${formatIndex(tech.nearestResistance)}** và giữ được → xu hướng sẽ được củng cố, có thể kỳ vọng nhịp tăng tiếp.
⚠️ Nếu Index mất vùng **${formatIndex(tech.nearestSupport)}** → cần thận trọng hơn, ưu tiên bảo toàn vốn.
${macroNewsSection}
${potentialStocksSection}
---
*${closingLine}*`,
    chartUrl: '',
  };
}




// ═══════════════════════════════════════════════════
// EXPORT FUNCTION - Gọi trực tiếp không qua tool
// ═══════════════════════════════════════════════════

export interface StockAnalysisResult {
  text: string;
  chartUrl: string;
}

/**
 * Phân tích cổ phiếu trực tiếp - không cần qua AI tool call
 * @param symbol Mã cổ phiếu (VD: STB, FPT, VNM)
 * @returns Báo cáo phân tích hoặc null nếu lỗi
 */
export async function analyzeStockDirect(symbol: string): Promise<StockAnalysisResult | null> {
  const upperSymbol = symbol.toUpperCase().trim();
  
  try {
    // Fetch song song tat ca data + realtime price. Dung Promise.allSettled de 1 nguon fail khong lam fail toan bo.
    const settled = await Promise.allSettled([
      fetchPriceData(upperSymbol),
      fetchFinancialData(upperSymbol),
      fetchTimelineData(upperSymbol),
      fetchRSData(upperSymbol),
      upperSymbol !== 'VNINDEX' ? fetchCompanyNews(upperSymbol) : Promise.resolve([]),
      fetchLongTermPriceData(upperSymbol),
      upperSymbol !== 'VNINDEX' ? getStockPressure(upperSymbol).catch(() => null) : Promise.resolve(null),
      upperSymbol !== 'VNINDEX' ? getMarketPressure().catch(() => null) : Promise.resolve(null),
      upperSymbol !== 'VNINDEX' ? fetchRealtimePrice(upperSymbol) : Promise.resolve(null),
    ]);
    
    const getResult = <T>(idx: number, fallback: T): T => {
      const r = settled[idx];
      return r.status === 'fulfilled' ? (r.value as T) : fallback;
    };
    
    const priceData = getResult<StockData[]>(0, []);
    const financialData = getResult<FinancialData[]>(1, []);
    const timelineData = getResult<TimelineMark[]>(2, []);
    const rsData = getResult<RSData[]>(3, []);
    const companyNews = getResult<any[]>(4, []);
    const longTermData = getResult<StockData[]>(5, []);
    const stockPressure = getResult<any>(6, null);
    const marketPressureData = getResult<any>(7, null);
    const realtimePrice = getResult<number | null>(8, null);
    
    // Log fetch failures
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        const names = ['priceData', 'financialData', 'timelineData', 'rsData', 'companyNews', 'longTermData', 'stockPressure', 'marketPressure', 'realtimePrice'];
        console.warn(`[Stock] ⚠️ ${upperSymbol} ${names[i]} fetch failed: ${r.reason?.message || r.reason}`);
      }
    });

    if (!priceData || priceData.length < 20) {
      // Mã mới niêm yết - ít data, trả về thông tin cơ bản thay vì null
      const companyInfo = await getCompanyInfo(upperSymbol);
      const companyName = companyInfo?.name || upperSymbol;
      const exchange = companyInfo?.exchange || 'HOSE';
      const industry = companyInfo?.industry || 'Chứng khoán';
      
      const dataCount = priceData?.length || 0;
      const latestPrice = dataCount > 0 ? priceData[dataCount - 1].close : 0;
      const priceStr = latestPrice > 0 ? `${(latestPrice / 1000).toFixed(1)}k` : 'N/A';
      
      const newListingReport = `📊 **${upperSymbol} - ${companyName}**\n` +
        `🏢 Sàn: ${exchange} | Ngành: ${industry}\n\n` +
        `⚠️ **Mã mới niêm yết** - Chưa đủ dữ liệu lịch sử để phân tích kỹ thuật đầy đủ (${dataCount} phiên).\n` +
        (latestPrice > 0 ? `💰 Giá hiện tại: ~${priceStr}\n\n` : '\n') +
        `📌 **Lưu ý khi giao dịch mã mới:**\n` +
        `• Thanh khoản thường thấp trong giai đoạn đầu\n` +
        `• Biến động giá lớn, spread rộng\n` +
        `• Cần theo dõi thêm ít nhất 20-30 phiên để có tín hiệu kỹ thuật rõ ràng\n` +
        `• Nên chờ giá ổn định và volume tăng trước khi vào lệnh\n\n` +
        `💡 Em sẽ có thể phân tích đầy đủ hơn khi mã có thêm dữ liệu giao dịch ạ!`;
      
      return { text: newListingReport, chartUrl: '' };
    }

    // Cap nhat priceData voi gia realtime (Fireant HistoricalQuotes lag 1 ngay trong gio GD)
    if (realtimePrice && realtimePrice > 0) {
      const lastRecord = priceData[priceData.length - 1];
      const today = new Date().toISOString().split('T')[0];
      const eodPrice = lastRecord?.close || 0;
      const priceDiff = eodPrice > 0 ? Math.abs(realtimePrice - eodPrice) / eodPrice * 100 : 0;
      
      if (lastRecord.date === today) {
        lastRecord.close = realtimePrice;
        lastRecord.high = Math.max(lastRecord.high, realtimePrice);
        lastRecord.low = Math.min(lastRecord.low, realtimePrice);
        console.log(`[Stock] 📡 ${upperSymbol} realtime updated: EOD=${eodPrice} → ${realtimePrice} (${priceDiff.toFixed(2)}% diff)`);
      } else {
        priceData.push({
          date: today,
          open: realtimePrice,
          high: realtimePrice,
          low: realtimePrice,
          close: realtimePrice,
          volume: 0,
        });
        console.log(`[Stock] 📡 ${upperSymbol} realtime appended: ${lastRecord.date} EOD=${eodPrice} → today=${realtimePrice}`);
      }
    } else {
      console.log(`[Stock] ⚠️ ${upperSymbol} no realtime price, using EOD ${priceData[priceData.length - 1]?.date}=${priceData[priceData.length - 1]?.close}`);
    }

    const technicalAnalysis = analyzeTechnical(priceData, rsData, longTermData);

    // Luc cung cau chu dong
    try {
      if (stockPressure) {
        technicalAnalysis.activeBuyPercent = stockPressure.activeBuyPercent;
        technicalAnalysis.activeBuyRating = stockPressure.rating;
      }
    } catch (e: any) {
      console.log(`[AnalyzeStock] ⚠️ Supply-demand populate error (non-fatal): ${e.message}`);
    }

    // Dieu chinh score theo luc cung cau
    if (technicalAnalysis.activeBuyPercent >= 47) {
      technicalAnalysis.score += 5;
    } else if (technicalAnalysis.activeBuyPercent >= 0 && technicalAnalysis.activeBuyPercent < 35) {
      technicalAnalysis.score -= 5;
    }
    // activeBuyPercent = -1 → khong co data, bo qua

    const fundamentalAnalysis = analyzeFinancial(financialData, timelineData);
    const overallScore = calculateOverallScore(technicalAnalysis, fundamentalAnalysis);

    // Nếu là VNINDEX, fetch tin tức vĩ mô 24h
    let macroNews: MacroNewsItem[] = [];
    let macroAnalysis = '';
    
    if (upperSymbol === 'VNINDEX') {
      try {
        console.log('[VNINDEX] 📰 Fetching macro news...');
        macroNews = await fetchMacroNews24h();
        
        if (macroNews.length > 0) {
          console.log(`[VNINDEX] 📰 Got ${macroNews.length} macro news, analyzing...`);
          macroAnalysis = await analyzeMacroNewsWithDeepSeek(macroNews, technicalAnalysis.priceChange);
        }
      } catch (e: any) {
        console.log(`[VNINDEX] ⚠️ Macro news error: ${e.message}`);
      }
    }


    // Nếu là VNINDEX, fetch thêm Breakout Stocks (Potential)
    let potentialStocks = '';
    if (upperSymbol === 'VNINDEX') {
      try {
        console.log('[VNINDEX] 🚀 Fetching breakout stocks...');
        const breakoutResult = await getBreakoutStocksTool.execute({}, {} as any);
        if (breakoutResult.success && typeof breakoutResult.data === 'string') {
           // Clean up the message a bit if needed, or just take the list part
           // Remove the intro "Anh/Chị ơi..." if present to make it cleaner, or keep it friendly.
           // User wants "Potential Stocks", so let's keep the list formatting.
           potentialStocks = breakoutResult.data;
           
           // Optional: Extract just the list if the tool returns chatty text
           // For now, use as is.
        }
      } catch (e: any) {
        console.log(`[VNINDEX] ⚠️ Breakout stocks error: ${e.message}`);
      }
    }

    // Generate report
    // Thêm industry comparison và pattern analysis cho analyzeStockDirect
    let industryComparison: IndustryComparison | null = null;
    let patternAnalysis: PatternAnalysisResult | null = null;
    
    if (upperSymbol !== 'VNINDEX') {
      try {
        // Industry comparison
        if (fundamentalAnalysis.pe > 0) {
          const bookValuePerShare = fundamentalAnalysis.pb > 0 ? technicalAnalysis.currentPrice / fundamentalAnalysis.pb : 0;
          industryComparison = await compareWithIndustry(
            upperSymbol,
            fundamentalAnalysis.pe,
            fundamentalAnalysis.pb,
            fundamentalAnalysis.roe,
            technicalAnalysis.currentPrice,
            fundamentalAnalysis.latestEPS,
            bookValuePerShare
          );
        }
        
        // Pattern analysis
        const ohlcvData: OHLCV[] = priceData.map(d => ({
          date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
        }));
        patternAnalysis = detectAllPatterns(ohlcvData);
      } catch (e: any) {
        console.log(`[Stock] ⚠️ Industry/Pattern analysis error: ${e.message}`);
      }
    }
    
    const report = generateReport(upperSymbol, priceData, technicalAnalysis, fundamentalAnalysis, timelineData, overallScore, macroNews, macroAnalysis, potentialStocks, industryComparison, patternAnalysis, undefined, marketPressureData);
    
    // Thêm section tin tức doanh nghiệp VỚI PHÂN TÍCH AI (cho mã CP thường, không phải VNINDEX)
    let newsSection = '';
    if (upperSymbol !== 'VNINDEX' && companyNews && companyNews.length > 0) {
      // Gọi DeepSeek để phân tích tin tức
      const newsAnalysis = await analyzeCompanyNewsWithDeepSeek(
        upperSymbol,
        companyNews,
        technicalAnalysis.priceChange
      );
      
      if (newsAnalysis) {
        newsSection = `\n\n📰 **TIN TỨC & TRIỂN VỌNG:**\n${newsAnalysis}\n`;
      } else {
        // Fallback: hiển thị tin nếu DeepSeek lỗi
        newsSection = `\n\n📰 **TIN TỨC DOANH NGHIỆP:**\n`;
        const newsToShow = companyNews.slice(0, 3);
        for (const news of newsToShow) {
          if (news.title) {
            newsSection += `• ${news.title}\n`;
          }
        }
      }
    }
    
    // ═══════════════════════════════════════════════════
    // INVESTMENT THESIS - Luận điểm đầu tư từ báo cáo phân tích + dữ liệu kỹ thuật/cơ bản
    // ═══════════════════════════════════════════════════
    let investmentThesisSection = '';
    if (upperSymbol !== 'VNINDEX') {
      try {
        console.log(`[Stock] 📊 Generating investment thesis for ${upperSymbol}...`);
        
        // Tính decision để lấy thông tin chiến lược
        const decision = calculateInvestmentDecision(technicalAnalysis, fundamentalAnalysis, overallScore);
        
        // Build analysis context cho AI thesis
        const analysisContext: AnalysisContext = {
          symbol: upperSymbol,
          currentPrice: technicalAnalysis.currentPrice,
          priceChange: technicalAnalysis.priceChange,
          trend: technicalAnalysis.trend,
          shortTermScore: technicalAnalysis.shortTermScore,
          rs: technicalAnalysis.rs,
          rsi: technicalAnalysis.rsi,
          macdTrend: technicalAnalysis.macdTrend,
          volumeAboveMA50Count: technicalAnalysis.volumeAboveMA50Count,
          // Fundamental
          roe: fundamentalAnalysis.roe,
          pe: fundamentalAnalysis.pe,
          pb: fundamentalAnalysis.pb,
          profitGrowth: fundamentalAnalysis.profitGrowth,
          salesGrowth: fundamentalAnalysis.salesGrowth,
          debtToEquity: fundamentalAnalysis.debtToEquity,
          fundScore: fundamentalAnalysis.score,
          latestEPS: fundamentalAnalysis.latestEPS,
          // Decision
          action: decision.action,
          totalScore: decision.scoreBreakdown.totalScore,
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit,
          riskReward: decision.riskReward,
          // Support/Resistance
          nearestSupport: technicalAnalysis.nearestSupport,
          nearestResistance: technicalAnalysis.nearestResistance,
          high52Week: technicalAnalysis.high52Week,
          distanceFromHigh52W: technicalAnalysis.distanceFromHigh52W,
          // Pattern & Industry context (nếu có)
          patternSummary: patternAnalysis ? buildPatternSummaryForThesis(patternAnalysis) : undefined,
          industrySummary: industryComparison ? buildIndustrySummaryForThesis(industryComparison) : undefined,
          newsAnalysis: newsSection ? newsSection.replace(/\n\n📰.*?\n/g, '').trim() : undefined,
        };
        
        const thesis = await fetchInvestmentThesisForStock(upperSymbol, 2, analysisContext);
        
        if (thesis) {
          investmentThesisSection = `\n\n📊 **LUẬN ĐIỂM ĐẦU TƯ:**\n${thesis}\n`;
        }
      } catch (e: any) {
        console.log(`[Stock] ⚠️ Investment thesis error: ${e.message}`);
      }
    }
    
    // ═══════════════════════════════════════════════════
    // CHART VISION ANALYSIS (AI nhìn chart) - DISABLED
    // Đã tắt để tiết kiệm Gemini API quota
    // Bot phân tích dựa trên dữ liệu kỹ thuật (MA, RSI, MACD, ADX, MFI, trendline, patterns...)
    // ═══════════════════════════════════════════════════
    const chartVisionSection = '';
    
    return {
      text: report.text + newsSection + investmentThesisSection + chartVisionSection,
      chartUrl: report.chartUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Detect mã cổ phiếu trong tin nhắn
 * 
 * LOGIC MỚI (mở rộng):
 * 1. Có @bot + mã CP → phân tích ngay
 * 2. Có @bot + từ khóa thị trường → phân tích VNINDEX
 * 3. KHÔNG có @bot + mã CP + TỪ KHÓA HỎI VỀ CP → phân tích
 *    (để tránh false positive khi người ta chỉ nhắc tên mã mà không hỏi về CP)
 * 
 * @param text Tin nhắn của user
 * @returns Mã cổ phiếu tìm được hoặc null
 */
export function detectStockSymbol(text: string, isDirectMessage: boolean = false): string | null {
  const lowerText = text.toLowerCase();
  
  // Skip hoàn toàn nếu đây là reaction event
  if (text.startsWith('[REACTION]')) {
    console.log(`[Stock] ⏭️ detectStockSymbol: Skipping - REACTION event`);
    return null;
  }
  
  // Bỏ qua nếu tin nhắn quá ngắn
  if (text.length < 4) {
    return null;
  }
  
  // ═══════════════════════════════════════════════════
  // FIX 2: TÌM SYMBOL TRƯỚC - nếu có symbol cụ thể trong câu thì skip vague check
  // VD: "Con vnd hôm nay thế nào" → có "vnd" → KHÔNG vague, luôn analyze
  // ═══════════════════════════════════════════════════
  const cleanedTextForEarlyDetect = text.replace(/\b(VNINDEX|VN-?INDEX|VN30|HNX|HNXINDEX|UPCOM)\b/gi, '');
  const earlyStockMatch = findStockInText(cleanedTextForEarlyDetect);
  if (earlyStockMatch) {
    // Có symbol cụ thể → bỏ qua vague check, return luôn
    console.log(`[Stock] 🎯 Early detection: ${earlyStockMatch} (skip vague check)`);
    return earlyStockMatch;
  }
  
  // ═══════════════════════════════════════════════════
  // LOẠI TRỪ CÁC CÂU HỎI CHUNG CHUNG (chỉ áp dụng khi KHÔNG có symbol)
  // ═══════════════════════════════════════════════════
  const vaguePhrases = [
    // Chào hỏi
    'alo', 'hello', 'hi ', 'hey ', 'xin chào', 'chào',
    // Hỏi thăm chung chung
    'hôm nay em thế nào', 'hom nay em the nao',
    'hôm nay thế nào', 'hom nay the nao',
    'em thế nào rồi', 'em the nao roi',
    'em sao rồi', 'em sao roi',
    'em ổn không', 'em on khong',
    'em khỏe không', 'em khoe khong',
    'em đang làm gì', 'em dang lam gi',
    
    // Hỏi về bot
    'bot thế nào', 'bot the nao',
    'ai đó', 'ai do',
    'có ai', 'co ai',
    'có gì', 'co gi',
    'làm gì', 'lam gi',
    'đang làm', 'dang lam',
    
    // Câu hỏi mơ hồ
    'thế nào rồi', 'the nao roi',
    'sao rồi', 'sao roi',
    'ra sao', 'ra sao',
    'như thế nào', 'nhu the nao',
  ];
  
  // Nếu câu hỏi quá mơ hồ → KHÔNG phân tích, để AI hỏi lại
  const isVague = vaguePhrases.some(phrase => lowerText.includes(phrase));
  if (isVague) {
    console.log(`[Stock] ⏭️ Vague question detected, skip auto-analysis`);
    return null;
  }
  
  // ═══════════════════════════════════════════════════
  // TỪ KHÓA CHO THẤY NGƯỜI DÙNG ĐANG HỎI VỀ CỔ PHIẾU
  // ═══════════════════════════════════════════════════
  const stockIntentKeywords = [
    // Hỏi mua/bán
    'mua', 'bán', 'ban', 'mua được', 'mua dc', 'mua đc', 'bán được', 'bán dc', 'bán đc',
    'có mua', 'nên mua', 'nen mua', 'có nên', 'co nen',
    'vào', 'vao', 'vào được', 'vao dc', 'vào đc',
    'chốt', 'chot', 'cắt', 'cat', 'cắt lỗ', 'cat lo',
    
    // Hỏi về giá/phân tích (CHỈ khi có mã CP rõ ràng)
    'giá', 'gia', 'phân tích', 'phan tich', 'soi', 'nhận định', 'nhan dinh',
    'điểm vào', 'diem vao', 'điểm mua', 'diem mua', 'điểm bán', 'diem ban',
    
    // Hỏi xu hướng
    'tăng', 'tang', 'giảm', 'giam', 'sideway', 'đi ngang',
    'có lên', 'co len', 'có xuống', 'lên không', 'len khong', 'xuống không',
    
    // Hỏi ý kiến (CHỈ khi có mã CP)
    'nghĩ gì', 'nghi gi', 'thấy sao', 'thay sao', 'ý kiến', 'y kien',
    'đánh giá', 'danh gia', 'nhận xét', 'nhan xet',
    
    // Hỏi ngắn hạn/dài hạn
    't+', 'ngắn hạn', 'ngan han', 'dài hạn', 'dai han', 'swing',
    
    // Các câu hỏi phổ biến (CHỈ khi có mã CP)
    'ổn không', 'on khong', 'ok không', 'ok khong', 'được không', 'duoc khong',
    'còn hold', 'con hold', 'còn giữ', 'con giu', 'cầm tiếp', 'cam tiep',
    'đang có', 'dang co', 'đang cầm', 'dang cam',
    'có thể lên', 'co the len', 'target', 'mục tiêu', 'muc tieu',
    
    // Emoji/keyword mua bán
    '📈', '📉', '💰', '🚀', 'all in', 'vô hàng', 'vo hang',
    
    // Câu hỏi so sánh
    'hay', 'hoặc', 'hoac', 'nào tốt', 'nao tot', 'chọn', 'chon',
  ];
  
  // ═══════════════════════════════════════════════════
  // CHECK 1: Có mention bot không?
  // ═══════════════════════════════════════════════════
  // Dùng @ + tên bất kỳ (Zalo mention structure sẽ handle chính xác hơn ở classifier)
  const botMentionPattern = /@\S+/i;
  const hasBotMention = botMentionPattern.test(text);
  
  // ═══════════════════════════════════════════════════
  // CASE 0: Tin nhắn trực tiếp 1-1 (không cần @mention)
  // ═══════════════════════════════════════════════════
  if (isDirectMessage) {
    // ⚠️ QUAN TRỌNG: Kiểm tra TIN TỨC trước - nếu có thì KHÔNG trigger VNINDEX
    const newsKeywords = [
      'tin tức', 'tin gì', 'có tin', 'news', 'tin mới', 'tin nổi bật',
      'tin nóng', 'tin hôm nay', 'bài báo', 'tin doanh nghiệp',
    ];
    const hasNewsKeyword = newsKeywords.some(kw => lowerText.includes(kw));
    if (hasNewsKeyword) {
      console.log(`[Stock] 📰 News keyword detected, skip VNINDEX analysis`);
      return null;
    }
    
    // ⚠️ QUAN TRỌNG: Loại bỏ VNINDEX/VN30/HNX khỏi text trước khi tìm mã CP
    // Để tránh regex fallback match "VNI" từ "VNINDEX"
    const cleanedText = text.replace(/\b(VNINDEX|VN-?INDEX|VN30|HNX|HNXINDEX|UPCOM)\b/gi, '');
    
    // ⚠️ QUAN TRỌNG: Tìm mã CP cụ thể TRƯỚC - ưu tiên mã CP nếu có
    // VD: "VNINDEX xấu, có nên mua VSC ko" → VSC (VNINDEX chỉ là context)
    const stockMatch = findStockInText(cleanedText);
    if (stockMatch) {
      console.log(`[Stock] 🎯 Direct message detected stock: ${stockMatch}`);
      return stockMatch;
    }
    
    // Check từ khóa VNINDEX/thị trường - CHỈ khi không có mã CP cụ thể
    const marketKeywords = [
      'vnindex', 'vn-index', 'vn index',
      'thị trường thế nào', 'thị trường đang', 'thị trường hôm nay',
      'điểm số', 'bao nhiêu điểm',
      // Loại bỏ 'kháng cự', 'hỗ trợ' vì hay bị nhầm với CP
    ];
    
    const hasMarketKeyword = marketKeywords.some(kw => lowerText.includes(kw));
    if (hasMarketKeyword) {
      console.log(`[Stock] 🎯 Direct message with market keyword: VNINDEX`);
      return 'VNINDEX';
    }
    
    // Nếu không có mã CP cụ thể và không có market keyword
    return null;
  }
  
  // ═══════════════════════════════════════════════════
  // CASE 1: Có @mention (Group chat)
  // ═══════════════════════════════════════════════════
  if (hasBotMention) {
    // ⚠️ Check TIN TỨC trước cho group chat
    const newsKeywords = [
      'tin tức', 'tin gì', 'có tin', 'news', 'tin mới', 'tin nổi bật',
      'tin nóng', 'tin hôm nay', 'bài báo', 'tin doanh nghiệp',
    ];
    const hasNewsKeyword = newsKeywords.some(kw => lowerText.includes(kw));
    if (hasNewsKeyword) {
      console.log(`[Stock] 📰 Group chat: News keyword detected, skip VNINDEX`);
      return null;
    }
    
    // ⚠️ QUAN TRỌNG: Loại bỏ VNINDEX/VN30/HNX khỏi text trước khi tìm mã CP
    const cleanedTextGroup = text.replace(/\b(VNINDEX|VN-?INDEX|VN30|HNX|HNXINDEX|UPCOM)\b/gi, '');
    
    // ⚠️ QUAN TRỌNG: Tìm mã CP cụ thể TRƯỚC - ưu tiên mã CP nếu có
    // VD: "@bot VNINDEX xấu, có nên mua VSC ko" → VSC
    const stockMatch = findStockInText(cleanedTextGroup);
    if (stockMatch) {
      console.log(`[Stock] 🎯 Group chat detected stock with @mention: ${stockMatch}`);
      return stockMatch;
    }
    
    // Check từ khóa VNINDEX/thị trường - CHỈ khi không có mã CP cụ thể
    const marketKeywords = [
      'vnindex', 'vn-index', 'vn index',
      'thị trường thế nào', 'thị trường đang', 'thị trường hôm nay',
      'điểm số', 'bao nhiêu điểm',
      // Loại bỏ 'kháng cự', 'hỗ trợ' vì hay bị nhầm với CP
    ];
    
    const hasMarketKeyword = marketKeywords.some(kw => lowerText.includes(kw));
    if (hasMarketKeyword) {
      console.log(`[Stock] 🎯 Group chat market keyword with @mention: VNINDEX`);
      return 'VNINDEX';
    }
    
    // Có @mention nhưng không có mã CP/market keyword → không phân tích
    return null;
  }
  
  // ═══════════════════════════════════════════════════
  // CASE 3: KHÔNG có @mention, nhưng có mã CP + từ khóa hỏi về CP
  // VD: "FTS mua được không?", "STB thế nào rồi?"
  // ═══════════════════════════════════════════════════
  const cleanedTextCase3 = text.replace(/\b(VNINDEX|VN-?INDEX|VN30|HNX|HNXINDEX|UPCOM)\b/gi, '');
  const stockMatchCase3 = findStockInText(cleanedTextCase3);
  if (stockMatchCase3) {
    // Phải có ít nhất 1 từ khóa cho thấy đang hỏi về CP
    const hasStockIntent = stockIntentKeywords.some(kw => lowerText.includes(kw));
    
    if (hasStockIntent) {
      console.log(`[Stock] 🎯 Detected without @mention (has intent): ${stockMatchCase3}`);
      return stockMatchCase3;
    }
    
    // Có mã CP nhưng không có từ khóa hỏi → không phân tích
    // (tránh phân tích khi người ta chỉ nhắc tên mã, VD: "FPT là công ty lớn")
    console.log(`[Stock] ⏭️ Found ${stockMatchCase3} but no intent keywords, skipping`);
    return null;
  }
  
  // Không có mã CP → không phân tích
  return null;
}

/**
 * Tìm mã CP trong text
 */
function findStockInText(text: string): string | null {
  const upperText = text.toUpperCase();
  
  // ═══════════════════════════════════════════════════
  // DANH SÁCH MÃ CP (~150 mã quan trọng nhất)
  // VN30 + VN100 + HNX30 phổ biến
  // LOẠI BỎ: TRA, CAN, HAI, BAO, NAM, THE... (dễ nhầm với tiếng Việt)
  // ═══════════════════════════════════════════════════
  const commonStocks = [
    // ═══════ VN30 - Bluechips ═══════
    'ACB', 'BCM', 'BID', 'BVH', 'CTG', 'FPT', 'GAS', 'GVR', 'HDB', 'HPG',
    'MBB', 'MSN', 'MWG', 'PLX', 'POW', 'SAB', 'SHB', 'SSB', 'SSI', 'STB',
    'TCB', 'TPB', 'VCB', 'VHM', 'VIB', 'VIC', 'VJC', 'VNM', 'VPB', 'VRE',
    
    // ═══════ VN100 (MIDCAP) ═══════
    'ANV', 'ASM', 'BWE', 'CII', 'CMG', 'CTD', 'DCM', 'DGC', 'DGW', 'DIG',
    'DPM', 'DXG', 'DXS', 'EIB', 'EVF', 'FRT', 'GEX', 'GMD', 'HAG', 'HAH',
    'HCM', 'HDC', 'HDG', 'HNG', 'HSG', 'HT1', 'IJC', 'KBC', 'KDC', 'KDH',
    'KOS', 'LPB', 'MSB', 'NKG', 'NLG', 'NT2', 'NVL', 'OCB', 'PC1', 'PDR',
    'PET', 'PHR', 'PNJ', 'PPC', 'PVD', 'PVS', 'PVT', 'REE', 'SCS', 'SIP',
    'SJS', 'SSC', 'SZC', 'TCH', 'TLG', 'VCG', 'VCI', 'VGC', 'VHC', 'VND',
    'VOS', 'VPI', 'VPG', 'VTO', 'YEG', 'AGG', 'APH', 'BSI', 'CSV', 'CTS',
    
    // ═══════ HOSE phổ biến khác ═══════
    'AAA', 'ABB', 'ACV', 'AGR', 'BCG', 'BFC', 'BMP', 'BSR', 'DBC', 'DBD',
    'DHG', 'DMC', 'FLC', 'FTS', 'HBC', 'HHS', 'HUT', 'HVN', 'IMP', 'ITA',
    'LAS', 'LCG', 'MIG', 'MVN', 'OPC', 'PAN', 'PME', 'QCG', 'SAM', 'SBT',
    'SCR', 'SMC', 'TCM', 'TLH', 'VDS', 'VFS', 'VNR', 'VSC', 'VSH', 'VTP',
    
    // ═══════ HNX30 phổ biến ═══════
    'SHS', 'IDC', 'PVB', 'BVS', 'PLC', 'PVC', 'CEO', 'DTD', 'NTP',
    'VIX', 'TNG', 'THD', 'NVB', 'PVI', 'SHN', 'VCS', 'VGS', 'L14', 'LHC',
    'VC3', 'NDN', 'NRC', 'PVE', 'TDN', 'TVC', 'VC9', 'DDG', 'DHT', 'DL1',
    
    // ═══════ UPCOM nổi bật ═══════
    'ABI', 'OIL', 'QNS', 'MCH', 'DVN', 'LTG', 'GEG', 'VEA', 'WCS',
    
    // ═══════ CTCK & Mã mới phổ biến ═══════
    'TCX', 'VCK', 'GEL', 'VPX', 'TVS', 'APS', 'DSE', 'HFT', 'WSS', 'EVS', 'KIS',
    'ORS', 'VFS', 'PSI', 'AGM', 'BCC', 'BMI', 'CRE', 'DAH', 'DHA', 'DRC',
    'DVP', 'FCN', 'GIL', 'GTN', 'HAX', 'HMC', 'HTN', 'HVH', 'IDI', 'KSB',
    'LSS', 'NAF', 'NET', 'NHH', 'NSC', 'PGC', 'PGD', 'PGV', 'PHC', 'PTB',
    'RAL', 'RDP', 'SBA', 'SFC', 'SGN', 'SKG', 'SMA', 'SPM', 'SRC', 'SVI',
    'TBC', 'TDC', 'TDM', 'TIP', 'TMP', 'TNH', 'TNT', 'TRA', 'TSC', 'TTF',
    'TV2', 'TYA', 'VCA', 'VDP', 'VFG', 'VGI', 'VIR', 'VMD', 'VNE', 'VRC',
  ];
  
  // Tìm mã CP ưu tiên - phải là từ riêng biệt
  for (const stock of commonStocks) {
    const regex = new RegExp(`(?:^|[\\s,.:;!?()\\[\\]"'])${stock}(?:[\\s,.:;!?()\\[\\]"']|$)`, 'i');
    if (regex.test(upperText)) {
      return stock;
    }
  }
  
  // KHÔNG dùng fallback regex - chỉ nhận diện mã trong commonStocks
  // Tránh nhầm từ tiếng Việt (MAI, ROI, MUA...) thành mã CP
  // Nếu khách hỏi mã lạ, AI sẽ hỏi lại "Anh muốn em soi mã nào ạ?"
  
  return null;
}

/**
 * Tìm TẤT CẢ mã cổ phiếu trong text (cho chức năng so sánh)
 */
export function findAllStocksInText(text: string): string[] {
  const upperText = text.toUpperCase();
  const foundStocks: string[] = [];
  
  // Danh sách ưu tiên (giống findStockInText)
  const commonStocks = [
    'ACB', 'BCM', 'BID', 'BVH', 'CTG', 'FPT', 'GAS', 'GVR', 'HDB', 'HPG',
    'MBB', 'MSN', 'MWG', 'PLX', 'POW', 'SAB', 'SHB', 'SSB', 'SSI', 'STB',
    'TCB', 'TPB', 'VCB', 'VHM', 'VIB', 'VIC', 'VJC', 'VNM', 'VPB', 'VRE',
    'ANV', 'ASM', 'BWE', 'CII', 'CMG', 'CTD', 'DCM', 'DGC', 'DGW', 'DIG',
    'DPM', 'DXG', 'DXS', 'EIB', 'EVF', 'FRT', 'GEX', 'GMD', 'HAG', 'HAH',
    'HCM', 'HDC', 'HDG', 'HNG', 'HSG', 'HT1', 'IJC', 'KBC', 'KDC', 'KDH',
    'KOS', 'LPB', 'MSB', 'NKG', 'NLG', 'NT2', 'NVL', 'OCB', 'PC1', 'PDR',
    'PET', 'PHR', 'PNJ', 'PPC', 'PVD', 'PVS', 'PVT', 'REE', 'SCS', 'SIP',
    'SJS', 'SSC', 'SZC', 'TCH', 'TLG', 'VCG', 'VCI', 'VGC', 'VHC', 'VND',
    'VOS', 'VPI', 'VPG', 'VTO', 'YEG', 'AGG', 'APH', 'BSI', 'CSV', 'CTS',
    'AAA', 'ABB', 'ACV', 'AGR', 'BCG', 'BFC', 'BMP', 'BSR', 'DBC', 'DBD',
    'DHG', 'DMC', 'FLC', 'FTS', 'HBC', 'HHS', 'HUT', 'HVN', 'IMP', 'ITA',
    'LAS', 'LCG', 'MIG', 'MVN', 'OPC', 'PAN', 'PME', 'QCG', 'SAM', 'SBT',
    'SCR', 'SMC', 'TCM', 'TLH', 'VDS', 'VFS', 'VNR', 'VSC', 'VSH', 'VTP',
    'SHS', 'IDC', 'PVB', 'BVS', 'PLC', 'PVC', 'CEO', 'DTD', 'NTP',
    'VIX', 'TNG', 'THD', 'NVB', 'PVI', 'SHN', 'VCS', 'VGS', 'L14', 'LHC',
    'VC3', 'NDN', 'NRC', 'PVE', 'TDN', 'TVC', 'VC9', 'DDG', 'DHT', 'DL1',
    'ABI', 'OIL', 'QNS', 'MCH', 'DVN', 'LTG', 'GEG', 'VEA', 'WCS',
    'TCX', 'VCK', 'GEL', 'VPX', 'TVS', 'APS', 'DSE', 'HFT', 'WSS', 'EVS', 'KIS',
    'ORS', 'VFS', 'PSI', 'AGM', 'BCC', 'BMI', 'CRE', 'DAH', 'DHA', 'DRC',
    'DVP', 'FCN', 'GIL', 'GTN', 'HAX', 'HMC', 'HTN', 'HVH', 'IDI', 'KSB',
    'LSS', 'NAF', 'NET', 'NHH', 'NSC', 'PGC', 'PGD', 'PGV', 'PHC', 'PTB',
    'RAL', 'RDP', 'SBA', 'SFC', 'SGN', 'SKG', 'SMA', 'SPM', 'SRC', 'SVI',
    'TBC', 'TDC', 'TDM', 'TIP', 'TMP', 'TNH', 'TNT', 'TRA', 'TSC', 'TTF',
    'TV2', 'TYA', 'VCA', 'VDP', 'VFG', 'VGI', 'VIR', 'VMD', 'VNE', 'VRC',
  ];
  
  // Tìm trong danh sách ưu tiên trước
  for (const stock of commonStocks) {
    const regex = new RegExp(`(?:^|[\\s,.:;!?()\\[\\]"'])${stock}(?:[\\s,.:;!?()\\[\\]"']|$)`, 'i');
    if (regex.test(upperText) && !foundStocks.includes(stock)) {
      foundStocks.push(stock);
    }
  }
  
  // KHÔNG dùng fallback regex cho findAllStocks - chỉ dùng commonStocks list
  
  return foundStocks;
}

/**
 * Detect nhiều mã cổ phiếu để so sánh
 * @returns Mảng các mã CP được tìm thấy (tối đa 3)
 */
export function detectStockSymbols(text: string, isDirectMessage: boolean = false): string[] {
  const lowerText = text.toLowerCase();
  
  // Skip hoàn toàn nếu đây là reaction event
  if (text.startsWith('[REACTION]')) {
    return [];
  }
  
  // ═══════════════════════════════════════════════════
  // LOẠI TRỪ CÂU HỎI GỢI Ý MÃ (không phải so sánh)
  // VD: "mua đc mã nào", "có mã nào mua được không", "gợi ý mã"
  // Những câu này KHÔNG CÓ MÃ CP CỤ THỂ, nên không nên trigger comparison
  // ═══════════════════════════════════════════════════
  const recommendationPatterns = [
    // Hỏi gợi ý mã chung chung (không có mã cụ thể)
    'mua đc mã nào', 'mua dc mã nào', 'mua được mã nào',
    'mua mã nào', 'có mã nào', 'có con nào',
    'gợi ý mã', 'goi y ma', 'mã nào mua được', 'mã nào mua dc',
    'hôm nay mua gì', 'hom nay mua gi', 'nay mua gì', 'nay mua gi',
    'mua gì hôm nay', 'mua gi hom nay', 'mua gì nay', 'mua gi nay',
    'mã nào tiềm năng', 'ma nao tiem nang', 'mã tiềm năng',
    'mã nào đáng chú ý', 'ma nao dang chu y',
    'có cp nào', 'có cổ phiếu nào', 'cp nào mua',
    'breakout', 'break out', 'tín hiệu mua',
  ];
  
  const isRecommendationQuery = recommendationPatterns.some(pattern => 
    lowerText.includes(pattern)
  );
  
  if (isRecommendationQuery) {
    console.log(`[Stock] ⏭️ Skipping comparison - this is a recommendation query`);
    return []; // Không trigger comparison, để AI xử lý và gọi getBreakoutStocks tool
  }
  
  // Từ khóa cho thấy đang hỏi SO SÁNH
  // LƯU Ý: Các từ khóa này phải đi kèm với ít nhất 2 mã CP mới trigger comparison
  // Tránh các từ quá generic như 'hay' đơn lẻ (có thể là "VIX hay quá" - khen ngợi)
  const comparisonKeywords = [
    // Từ khóa so sánh rõ ràng
    'hay là', 'hay la', 'hoặc', 'hoac', 'hoặc là',
    'nào tốt', 'nao tot', 'nào hơn', 'nao hon', 
    'chọn cái nào', 'chon cai nao', 'chọn con nào', 'chon con nao',
    'pick', 'lựa chọn', 'lua chon',
    'so sánh', 'so sanh', 'so với', 'so voi',
    'giữa', 'giua', 'trong số', 'trong so',
    'ưu tiên', 'uu tien', 'đầu tư vào cái nào', 'dau tu vao cai nao',
    'mua cái nào', 'mua cai nao', 'mua con nào', 'mua con nao',
    ' vs ', ' và ', ' va ', // Dấu cách để tránh match từ trong từ khác
  ];
  
  // Từ khóa "hay" chỉ trigger khi đi kèm với pattern so sánh
  // VD: "VIX hay VNM" (so sánh) vs "VIX hay quá" (khen ngợi)
  const hayComparisonPattern = /\b[A-Z]{3}\s+hay\s+[A-Z]{3}\b/i;
  const hasHayComparison = hayComparisonPattern.test(text);
  
  // Tu khoa "gia" + nhieu ma → user muon lay gia nhieu CP cung luc
  // VD: "gia BSR, SSI, VND", "cho gia HPG VNM FPT"
  const priceMultiKeywords = [
    'giá', 'gia', 'price', 'bao nhiêu', 'bao nhieu',
    'đóng cửa', 'dong cua', 'closing', 'close',
    'hiện tại', 'hien tai', 'current',
    'mở cửa', 'mo cua', 'open',
  ];
  const hasPriceIntent = priceMultiKeywords.some(kw => lowerText.includes(kw));
  
  const hasComparisonIntent = comparisonKeywords.some(kw => lowerText.includes(kw)) || hasHayComparison || hasPriceIntent;
  
  if (!hasComparisonIntent) {
    // Không có ý định so sánh, trả về mảng rỗng (để dùng detectStockSymbol đơn lẻ)
    return [];
  }
  
  // Tìm tất cả mã CP
  const stocks = findAllStocksInText(text);
  
  // CHỈ trả về nếu tìm thấy ít nhất 2 mã CP hợp lệ
  // Tránh trường hợp detect sai các từ 3 chữ ngẫu nhiên
  if (stocks.length < 2) {
    console.log(`[Stock] ⏭️ Skipping comparison - not enough valid stocks found (${stocks.length})`);
    return [];
  }
  
  // Giới hạn tối đa 3 mã để so sánh
  return stocks.slice(0, 3);
}

/**
 * So sánh nhiều mã cổ phiếu và đưa ra khuyến nghị
 */
export async function compareStocks(symbols: string[]): Promise<string> {
  if (symbols.length < 2) {
    return '';
  }

  console.log('[Stock] So sanh co phieu: ' + symbols.join(' vs '));

  // Fetch data truc tiep cho tung ma (khong parse text)
  const fetchPromises = symbols.map(async (sym) => {
    const upperSym = sym.toUpperCase().trim();
    try {
      const [priceData, financialData, timelineData, rsData] = await Promise.all([
        fetchPriceData(upperSym),
        fetchFinancialData(upperSym),
        fetchTimelineData(upperSym),
        fetchRSData(upperSym),
      ]);

      if (!priceData || priceData.length < 20) return null;

      const tech = analyzeTechnical(priceData, rsData);
      const fund = analyzeFinancial(financialData, timelineData);
      const overall = calculateOverallScore(tech, fund);

      return { symbol: upperSym, tech, fund, overall };
    } catch (e) {
      console.log('[Stock] Loi fetch ' + upperSym + ': ' + e);
      return null;
    }
  });

  const results = await Promise.all(fetchPromises);
  const valid = results.filter((r): r is NonNullable<typeof r> => r !== null);

  if (valid.length < 1) {
    return '⚠️ Khong co du lieu cho cac ma ' + symbols.join(', ') + '. Vui long kiem tra lai ma co phieu.';
  }

  if (valid.length === 1) {
    // Chi 1 ma co data -> goi analyzeStockDirect de tra ve bao cao day du
    const singleResult = await analyzeStockDirect(valid[0].symbol);
    return singleResult ? singleResult.text : '⚠️ Khong the phan tich ' + valid[0].symbol;
  }

  // Sap xep theo diem tong hop tu cao -> thap
  valid.sort((a, b) => b.overall.score - a.overall.score);

  // === TAO BANG SO SANH ===
  let out = '📊 **SO SANH ' + valid.map(v => v.symbol).join(' vs ') + '**\n\n';

  // Chi tiet tung ma
  for (let i = 0; i < valid.length; i++) {
    const d = valid[i];
    const t = d.tech;
    const f = d.fund;
    const emoji = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';

    out += emoji + ' **' + d.symbol + '** - ' + d.overall.rating + ' (' + d.overall.score + '/100)\n';
    out += '   Gia: ' + formatVND(t.currentPrice) + ' | Thay doi: ' + (t.priceChange > 0 ? '+' : '') + t.priceChange.toFixed(2) + '%\n';
    out += '   Xu huong: ' + t.trend + ' | RSI: ' + t.rsi.toFixed(0) + ' | RS: ' + (t.rs > 0 ? t.rs.toFixed(0) : 'N/A') + '\n';
    out += '   MACD: ' + t.macdTrend + ' | ADX: ' + t.adx.toFixed(0) + '\n';
    out += '   Ngan han: ' + t.shortTermMomentum + ' (' + t.shortTermScore + '/100)\n';

    // Diem ky thuat vs co ban
    out += '   Diem KT: ' + t.score.toFixed(0) + '/100 | Diem CB: ' + f.score.toFixed(0) + '/100\n';

    // Co ban
    if (f.pe > 0 || f.roe > 0) {
      out += '   P/E: ' + (f.pe > 0 ? f.pe.toFixed(1) : 'N/A');
      out += ' | P/B: ' + (f.pb > 0 ? f.pb.toFixed(1) : 'N/A');
      out += ' | ROE: ' + (f.roe > 0 ? f.roe.toFixed(1) + '%' : 'N/A');
      out += ' | EPS: ' + (f.latestEPS > 0 ? f.latestEPS.toFixed(0) : 'N/A') + '\n';
    }

    // Tang truong
    if (f.salesGrowth !== 0 || f.profitGrowth !== 0) {
      out += '   DT tang: ' + (f.salesGrowth > 0 ? '+' : '') + f.salesGrowth.toFixed(1) + '%';
      out += ' | LN tang: ' + (f.profitGrowth > 0 ? '+' : '') + f.profitGrowth.toFixed(1) + '%\n';
    }

    // Ho tro / Khang cu
    out += '   Ho tro: ' + formatVND(t.nearestSupport) + ' (' + t.supportLabel + ')';
    out += ' | Khang cu: ' + formatVND(t.nearestResistance) + ' (' + t.resistanceLabel + ')\n';

    // 52 tuan
    out += '   52W: ' + formatVND(t.low52Week) + ' - ' + formatVND(t.high52Week);
    out += ' (cach dinh ' + t.distanceFromHigh52W.toFixed(1) + '%)\n';

    // Perfect buy signal
    if (t.perfectBuyMessage) {
      out += '   ' + t.perfectBuyMessage + '\n';
    }

    out += '\n';
  }

  // === BANG SO SANH NHANH ===
  out += '━━━━━━━━━━━━━━━━━━━━━\n';
  out += '📋 **BANG SO SANH NHANH:**\n\n';

  // Header
  out += 'Chi tieu';
  for (const d of valid) {
    out += ' | ' + d.symbol;
  }
  out += '\n';

  // Gia
  out += 'Gia';
  for (const d of valid) {
    out += ' | ' + formatVND(d.tech.currentPrice);
  }
  out += '\n';

  // % thay doi
  out += '% 1D';
  for (const d of valid) {
    out += ' | ' + (d.tech.priceChange > 0 ? '+' : '') + d.tech.priceChange.toFixed(2) + '%';
  }
  out += '\n';

  // Diem tong
  out += 'Diem';
  for (const d of valid) {
    out += ' | ' + d.overall.score + '/100';
  }
  out += '\n';

  // RSI
  out += 'RSI';
  for (const d of valid) {
    out += ' | ' + d.tech.rsi.toFixed(0);
  }
  out += '\n';

  // RS
  out += 'RS';
  for (const d of valid) {
    out += ' | ' + (d.tech.rs > 0 ? d.tech.rs.toFixed(0) : 'N/A');
  }
  out += '\n';

  // P/E
  out += 'P/E';
  for (const d of valid) {
    out += ' | ' + (d.fund.pe > 0 ? d.fund.pe.toFixed(1) : 'N/A');
  }
  out += '\n';

  // ROE
  out += 'ROE';
  for (const d of valid) {
    out += ' | ' + (d.fund.roe > 0 ? d.fund.roe.toFixed(1) + '%' : 'N/A');
  }
  out += '\n';

  // === KHUYEN NGHI ===
  out += '\n━━━━━━━━━━━━━━━━━━━━━\n';
  out += '💡 **KHUYEN NGHI:**\n';

  const best = valid[0];
  const second = valid[1];
  const diff = best.overall.score - second.overall.score;

  if (best.overall.score >= 70) {
    out += '✅ **' + best.symbol + '** la lua chon TICH CUC nhat voi diem ' + best.overall.score + '/100';
    out += ' (' + best.overall.rating + ').\n';
    if (best.tech.trend === 'Uptrend') {
      out += '   Dang trong xu huong tang, gia tren MA20 va MA50.\n';
    }
    if (best.tech.rs >= 70) {
      out += '   RS = ' + best.tech.rs.toFixed(0) + ' → Manh hon phan lon thi truong.\n';
    }
  } else if (best.overall.score >= 50) {
    out += '⚡ **' + best.symbol + '** co trien vong TOT HON (' + best.overall.score + '/100) so voi ';
    out += valid.slice(1).map(d => d.symbol + ' (' + d.overall.score + ')').join(', ') + '.\n';
    out += '   Tuy nhien nen theo doi them vi chua co tin hieu ro rang.\n';
  } else {
    out += '⚠️ Ca ' + valid.map(v => v.symbol).join(' va ') + ' deu chua co tin hieu tich cuc ro rang.\n';
    out += '   **' + best.symbol + '** (' + best.overall.score + '/100) van kha quan hon tuong doi.\n';
    out += '   Khuyen nghi: Cho doi tin hieu tot hon truoc khi vao hang.\n';
  }

  if (diff > 20) {
    out += '\n📌 Chenh lech diem dang ke (' + diff + ' diem) → ' + best.symbol + ' ro rang hon.\n';
  } else if (diff <= 10) {
    out += '\n📌 Chenh lech nho (' + diff + ' diem) → Ca hai kha ngang nhau, chon theo so thich/chien luoc rieng.\n';
  }

  out += '\n⚠️ *Day la phan tich tham khao dua tren du lieu ky thuat va co ban. Quyet dinh dau tu cuoi cung phu thuoc vao ban.*';

  return out;
}



// ═══════════════════════════════════════════════════
// PHÂN TÍCH THEO LOẠI: KỸ THUẬT / CƠ BẢN
// ═══════════════════════════════════════════════════

export type AnalysisType = 'technical' | 'fundamental' | 'both' | 'news' | 'target' | 'price';

/**
 * Detect loại phân tích user yêu cầu
 */
export function detectAnalysisType(text: string): AnalysisType {
  const lowerText = text.toLowerCase();
  
  // ═══ PRIORITY 1: PRICE INTENT — kiem tra dau tien ═══
  // Khi user hoi gia, dong cua, hien tai → tra ve 'price' de dung quickPrice
  // CHI nhan dien khi co tu khoa "gia" + KHONG co tu khoa phan tich sau
  const priceKeywords = [
    'giá đóng cửa', 'gia dong cua', 'closing price',
    'giá mở cửa', 'gia mo cua', 'opening price',
    'giá hiện tại', 'gia hien tai', 'current price',
    'cho giá', 'cho gia', 'lấy giá', 'lay gia', 'check giá', 'check gia',
    'bao nhiêu', 'bao nhieu',
    'lên chưa', 'len chua', 'xuống chưa', 'xuong chua',
    'giờ giá', 'gio gia', 'giá giờ', 'gia gio',
  ];
  // Tu khoa loai tru — neu co thi KHONG phai chi hoi gia (la phan tich)
  const exclusionKeywords = [
    'phân tích', 'phan tich', 'analyze', 'soi', 'check', 'đánh giá', 'danh gia',
    'nên mua', 'nen mua', 'có nên', 'co nen', 'mua được', 'mua duoc',
    'target', 'mục tiêu', 'muc tieu', 'kháng cự', 'khang cu', 'hỗ trợ', 'ho tro',
    'điểm mua', 'diem mua', 'điểm bán', 'diem ban',
    'thế nào', 'the nao', 'ra sao', 'đáng', 'dang',
    'cắt lỗ', 'cat lo', 'chốt lời', 'chot loi', 'giữ', 'giu', 'bán', 'ban',
    'ổn không', 'on khong', 'có gì', 'co gi',
  ];
  const hasPriceIntent = priceKeywords.some(kw => lowerText.includes(kw));
  const hasExclusion = exclusionKeywords.some(kw => lowerText.includes(kw));
  if (hasPriceIntent && !hasExclusion) {
    return 'price';
  }
  
  const technicalKeywords = [
    // Viết tắt
    'ptkt',
    // Đầy đủ
    'kỹ thuật', 'ky thuat', 'kĩ thuật', 'ki thuat',
    'phân tích kỹ thuật', 'phan tich ky thuat',
    'technical', 'chart', 'biểu đồ', 'bieu do',
    'ma5', 'ma10', 'ma20', 'ma50', 'ma200', 'ema', 'sma',
    'rsi', 'macd', 'bollinger', 'stochastic',
    'xu hướng', 'xu huong', 'trend', 'uptrend', 'downtrend',
    'hỗ trợ', 'ho tro', 'support', 'kháng cự', 'khang cu', 'resistance',
    'breakout', 'breakdown', 'golden cross', 'death cross',
    'điểm mua', 'điểm bán', 'diem mua', 'diem ban',
    'nến', 'nen', 'candlestick', 'pattern',
    // Câu hỏi về mua/bán - NÊN phân tích kỹ thuật
    'mua được', 'mua dc', 'mua đc', 'có mua được', 'co mua duoc',
    'nên mua', 'nen mua', 'có nên mua', 'co nen mua',
    'mua vào', 'mua vao', 'vào được', 'vao duoc', 'vào dc', 'vao dc',
    'bán được', 'ban duoc', 'nên bán', 'nen ban',
    'giá này', 'gia nay', 'giá hiện tại', 'gia hien tai',
    'thế nào', 'the nao', 'như thế nào', 'nhu the nao',
    'có tốt', 'co tot', 'có ổn', 'co on', 'có ok', 'co ok',
    'đáng mua', 'dang mua', 'đáng vào', 'dang vao',
  ];
  
  const fundamentalKeywords = [
    // Viết tắt
    'ptcb',
    // Đầy đủ
    'cơ bản', 'co ban', 'fundamental',
    'phân tích cơ bản', 'phan tich co ban',
    'tài chính', 'tai chinh', 'financial',
    'p/e', 'pe', 'eps', 'p/b', 'pb', 'roe', 'roa',
    'doanh thu', 'doanh', 'revenue', 'profit', 'lợi nhuận', 'loi nhuan',
    'cổ tức', 'co tuc', 'dividend',
    'nợ', 'no', 'debt', 'vốn', 'von', 'capital',
    'tăng trưởng', 'tang truong', 'growth',
    'báo cáo', 'bao cao', 'report', 'quý', 'quy', 'quarter',
    'biên lợi nhuận', 'bien loi nhuan', 'margin',
    'book value', 'giá trị sổ sách',
  ];

  const newsKeywords = [
    'tin tức', 'tin tuc', 'news', 'bản tin',
    'thông tin', 'thong tin', 'sự kiện', 'su kien',
    'có biến', 'co bien', 'tin đồn', 'tin don',
    'có gì mới', 'co gi moi', 'tin gì', 'tin gi',
    'lùm xùm', 'lum xum', 'phốt',
    'sắp tới', 'sap toi', 'triển vọng', 'trien vong',
  ];

  const targetKeywords = [
    'target', 'mục tiêu', 'muc tieu',
    'giá mục tiêu', 'gia muc tieu',
    'kháng cự bao nhiêu', 'khang cu bao nhieu',
    'hỗ trợ bao nhiêu', 'ho tro bao nhieu',
    'lên bao nhiêu', 'len bao nhieu',
    'xuống bao nhiêu', 'xuong bao nhieu',
    'vùng giá', 'vung gia',
    'đi đâu', 'di dau', 'về đâu', 've dau',
    'lên được bao', 'len duoc bao',
    'chạy về đâu', 'chay ve dau',
    'target của', 'target cua',  // "Target của VIX"
    'mục tiêu của', 'muc tieu cua',
    'giá target', 'gia target',
    'tp', 'take profit', 'chốt lời', 'chot loi',
    'sl', 'stop loss', 'cắt lỗ', 'cat lo',
    'điểm chốt', 'diem chot',
  ];
  
  const hasTechnical = technicalKeywords.some(kw => lowerText.includes(kw));
  const hasFundamental = fundamentalKeywords.some(kw => lowerText.includes(kw));
  const hasNews = newsKeywords.some(kw => lowerText.includes(kw));
  const hasTarget = targetKeywords.some(kw => lowerText.includes(kw));
  
  // Ưu tiên Target (hỏi về giá) nếu có keywords rõ ràng
  if (hasTarget && !hasNews && !hasFundamental) return 'target';
  
  // Ưu tiên News nếu có keywords rõ ràng và KHÔNG có keywords phân tích kỹ thuật/cơ bản
  if (hasNews && !hasTechnical && !hasFundamental) return 'news';
  
  if (hasTechnical && !hasFundamental) return 'technical';
  if (hasFundamental && !hasTechnical) return 'fundamental';
  
  return 'both';
}



// 
// NEWS ONLY ANALYSIS
// 

export async function analyzeNewsDirect(symbol: string): Promise<string> {
  const upperSymbol = symbol.toUpperCase().trim();
  
  try {
    // 1. TRƯỜNG HỢP VNINDEX - TIN VĨ MÔ
    if (upperSymbol === 'VNINDEX' || upperSymbol === 'VN-INDEX') {
      console.log('[News]  Fetching macro news for VNINDEX...');
      const macroNews = await fetchMacroNews24h();
      
      if (!macroNews || macroNews.length === 0) {
        return ' **TIN TỨC VĨ MÔ**\n\nHiện chưa có tin tức vĩ mô mới trong 24h qua.';
      }
      
      // Analyze with AI (pass dummy price change 0)
      const analysis = await analyzeMacroNewsWithDeepSeek(macroNews, 0);
      
      let report = ' **ĐIỂM TIN VĨ MÔ 24H**\n\n';
      
      // List news
      const newsToShow = macroNews.slice(0, 5);
      for (const news of newsToShow) {
        report += ' ' + news.title + '\n';
      }
      
      // Add Analysis
      if (analysis) {
        report += '\n **GÓC NHÌN AI:**\n' + analysis + '\n';
      }
      
      return report;
    }
    
    // 2. TRƯỜNG HỢP CỔ PHIẾU - TIN DOANH NGHIỆP
    console.log('[News]  Fetching company news for ' + upperSymbol + '...');
    const companyNews = await fetchCompanyNews(upperSymbol);
    
    if (!companyNews || companyNews.length === 0) {
      return ' **TIN TỨC ' + upperSymbol + '**\n\nHiện chưa có tin tức nào mới về ' + upperSymbol + '.';
    }
    
    const analysis = await analyzeCompanyNewsWithDeepSeek(upperSymbol, companyNews, 0);
    
    let report = ' **ĐIỂM TIN ' + upperSymbol + '**\n\n';
    
    // List news
    const newsToShow = companyNews.slice(0, 5);
    for (const news of newsToShow) {
      if (news.title) {
        // Chỉ hiển thị ngày nếu có
        const dateStr = news.date ? ` (${news.date})` : '';
        report += `${upperSymbol}: ${news.title}${dateStr}\n`;
      }
    }
    
    // Add Analysis
    if (analysis) {
      report += '\n **GÓC NHÌN AI:**\n' + analysis + '\n';
    }
    
    return report;
    
  } catch (error: any) {
    console.error('[News]  Error analyzing news for ' + symbol + ':', error);
    return ' Có lỗi khi lấy tin tức cho ' + symbol + ': ' + error.message;
  }
}



// ═══════════════════════════════════════════════════
// HELPER: Build summary strings for investment thesis context
// ═══════════════════════════════════════════════════

function buildPatternSummaryForThesis(pa: PatternAnalysisResult): string {
  const parts: string[] = [];
  if (pa.vcp.isVCP) parts.push(`VCP ${pa.vcp.stage} (${pa.vcp.contractions} contractions)`);
  if (pa.threeC.detected) parts.push(`3C Pattern phase: ${pa.threeC.phase}`);
  const bullish = pa.patterns.filter(p => p.type === 'bullish' && p.confidence >= 60);
  const bearish = pa.patterns.filter(p => p.type === 'bearish' && p.confidence >= 60);
  if (bullish.length > 0) parts.push(`Mô hình tăng: ${bullish.map(p => p.name).join(', ')}`);
  if (bearish.length > 0) parts.push(`Mô hình giảm: ${bearish.map(p => p.name).join(', ')}`);
  if (pa.multiTimeframe?.alignment === 'strong_bullish') parts.push('Multi-TF đồng thuận tăng mạnh');
  if (pa.multiTimeframe?.alignment === 'strong_bearish') parts.push('Multi-TF đồng thuận giảm mạnh');
  return parts.join(' | ') || '';
}

function buildIndustrySummaryForThesis(ic: IndustryComparison): string {
  if (ic.overallVerdict === 'undervalued') {
    return `Định giá hấp dẫn so với ngành ${ic.industryName} (P/E ${ic.stockPE.toFixed(1)}x vs ngành ${ic.industryPE.toFixed(1)}x, upside ${ic.upside > 0 ? '+' : ''}${ic.upside.toFixed(0)}%)`;
  } else if (ic.overallVerdict === 'overvalued') {
    return `Định giá cao so với ngành ${ic.industryName} (P/E ${ic.stockPE.toFixed(1)}x vs ngành ${ic.industryPE.toFixed(1)}x)`;
  }
  return `Định giá hợp lý so với ngành ${ic.industryName}`;
}

// 
// TARGET PRICE ANALYSIS (Focused on price levels)
// Trả về phần TÓM TẮT NHANH từ báo cáo phân tích
// 

export async function analyzeTargetDirect(symbol: string): Promise<string> {
  const upperSymbol = symbol.toUpperCase().trim();
  
  try {
    console.log('[Target] 🎯 Fetching price target for ' + upperSymbol + '...');
    
    const result = await analyzeStockDirect(upperSymbol);
    
    if (!result) {
      return '❌ Không có dữ liệu cho ' + upperSymbol + '. Vui lòng thử lại sau.';
    }
    
    // Lấy phần TÓM TẮT NHANH từ báo cáo (từ đầu đến hết phần KHUYẾN NGHỊ)
    const text = result.text;
    
    // Tìm vị trí kết thúc phần tóm tắt (trước phần PHÂN TÍCH KỸ THUẬT chi tiết)
    const endMarkers = ['---\n\n**📈 PHÂN TÍCH KỸ THUẬT', '---\n**📈 PHÂN TÍCH', '═══ 📈 PHÂN TÍCH'];
    let endIndex = text.length;
    
    for (const marker of endMarkers) {
      const idx = text.indexOf(marker);
      if (idx > 0 && idx < endIndex) {
        endIndex = idx;
      }
    }
    
    // Lấy phần tóm tắt
    let summary = text.substring(0, endIndex).trim();
    
    // Thêm gợi ý nếu cần phân tích chi tiết
    summary += '\n\n💡 *Cần phân tích chi tiết hơn? Hỏi "phân tích ' + upperSymbol + '" nhé!*';
    
    return summary;
    
  } catch (error: any) {
    console.error('[Target] ❌ Error:', error);
    return '❌ Có lỗi khi phân tích giá mục tiêu cho ' + symbol + ': ' + error.message;
  }
}

