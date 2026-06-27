/**
 * Historical Backtester Service — Backtest Strategy_Rules tren du lieu lich su
 * Chay 3 lan/ngay: 15:30, 17:00, 19:00 VN
 * Fetch du lieu gia tu Fireant API, simulate entry signals, tinh P&L T+5-T+10
 * Tao Signal_Variations (max 30/rule), phat hien noise, auto-promote variations tot
 */

import { eq, desc } from 'drizzle-orm';
import { getDatabase } from '../../infrastructure/database/connection.js';
import { getAI } from '../../infrastructure/ai/providers/gemini/geminiConfig.js';
import {
  strategyRules,
  strategyBacktestResults,
  strategySignalVariations,
  strategyNoiseDetections,
  strategyPracticalRules,
  type StrategyRule,
  type NewStrategyBacktestResult,
  type NewStrategySignalVariation,
  type NewStrategyNoiseDetection,
  type NewStrategyPracticalRule,
  type NewStrategyRule,
} from '../../infrastructure/database/schema.js';
import type { PriceData, BacktestSummary, ClusterType } from './strategy-tracker.types.js';
import { calculateCompositeFitness, calculateSharpeRatio } from './strategy-tracker.service.js';
import { validateStrategy, generateWindows } from './walk-forward.service.js';

// ═══════════════════════════════════════════════════
// TYPES NOI BO
// ═══════════════════════════════════════════════════

/** Tin hieu entry tu backtest */
interface BacktestSignal {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  entryIndex: number;
  exitPrices: { day: number; price: number }[];  // T+5 den T+10
  pnlPercent: number;       // P&L tai T+7 (default exit)
  bestPnlPercent: number;   // P&L cao nhat trong T+5-T+10
  worstPnlPercent: number;  // P&L thap nhat
  optimalExitDay: number;   // Ngay T+ co P&L cao nhat
  isWin: boolean;           // pnlPercent > 1.0
}

/** Ket qua noise detection */
interface NoiseResult {
  signalCondition: string;
  firstWinRate: number;
  firstAvgPnl: number;
  secondWinRate: number;
  secondAvgPnl: number;
  thirdWinRate: number;
  thirdAvgPnl: number;
  isFirstNoise: boolean;
  recommendedAction: string;
  sampleSize: number;
}

// Danh sach CP thanh khoan cao de backtest (giong MACD/RS scanner)
const BACKTEST_STOCKS = [
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

const BATCH_SIZE = 10;
const BATCH_DELAY = 500;
const MIN_AVG_VOLUME = 100_000;   // Tieu chi thanh khoan toi thieu
const MIN_TRADING_DAYS = 60;      // Toi thieu 60 phien de backtest
const MAX_VARIATIONS_PER_RULE = 30;


// ═══════════════════════════════════════════════════
// FETCH DU LIEU GIA LICH SU TU FIREANT API
// ═══════════════════════════════════════════════════

/**
 * Fetch du lieu gia lich su 6 thang tu Fireant API cho 1 CP
 * Dung legacy API (restv2 da chet 401 Unauthorized)
 */
export async function fetchHistoricalPrices(symbol: string): Promise<PriceData[]> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 180); // 6 thang

    const fmt = (d: Date) => d.toISOString().split('T')[0];
    const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });

    if (!response.ok) return [];

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) return [];

    const rawData = await response.json() as any[];
    if (!rawData || rawData.length === 0) return [];

    const data: PriceData[] = rawData.map((item: any) => ({
      date: (item.Date || item.date || '').split('T')[0],
      open: item.Open ?? item.priceOpen ?? item.PriceOpen ?? item.open ?? 0,
      high: item.High ?? item.priceHigh ?? item.PriceHigh ?? item.high ?? 0,
      low: item.Low ?? item.priceLow ?? item.PriceLow ?? item.low ?? 0,
      close: item.Close ?? item.priceClose ?? item.PriceClose ?? item.close ?? 0,
      volume: item.Volume ?? item.totalVolume ?? item.TotalVolume ?? item.volume ?? 0,
    })).filter((d: PriceData) => d.close > 0 && d.date);

    data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return data;
  } catch (e: any) {
    console.warn(`[Backtester] ⚠️ Fetch gia ${symbol} that bai: ${e.message}`);
    return [];
  }
}

/**
 * Batch fetch du lieu gia cho tat ca CP thoa dieu kien thanh khoan
 * Tra ve Map<symbol, PriceData[]>
 */
async function fetchAllHistoricalPrices(): Promise<Map<string, PriceData[]>> {
  console.log(`[Backtester] 📊 Bat dau fetch du lieu gia cho ${BACKTEST_STOCKS.length} CP...`);
  const priceMap = new Map<string, PriceData[]>();
  let processed = 0;
  let skipped = 0;

  for (let i = 0; i < BACKTEST_STOCKS.length; i += BATCH_SIZE) {
    const batch = BACKTEST_STOCKS.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        const data = await fetchHistoricalPrices(symbol);
        return { symbol, data };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.data.length > 0) {
        const { symbol, data } = result.value;

        // Check thanh khoan trung binh >= 100K
        const last20 = data.slice(-20);
        const avgVol = last20.reduce((s, d) => s + d.volume, 0) / Math.max(last20.length, 1);

        if (avgVol >= MIN_AVG_VOLUME && data.length >= MIN_TRADING_DAYS) {
          priceMap.set(symbol, data);
        } else {
          skipped++;
          if (data.length < MIN_TRADING_DAYS) {
            console.warn(`[Backtester] ⚠️ ${symbol}: chi co ${data.length} phien (< ${MIN_TRADING_DAYS}), bo qua`);
          }
        }
      }
    }

    processed += batch.length;
    if (processed % 50 === 0) {
      console.log(`[Backtester] ⏳ Fetch ${processed}/${BACKTEST_STOCKS.length}, co ${priceMap.size} CP hop le`);
    }

    // Delay giua cac batch de tranh rate limit
    if (i + BATCH_SIZE < BACKTEST_STOCKS.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY));
    }
  }

  console.log(`[Backtester] ✅ Fetch xong: ${priceMap.size} CP hop le, ${skipped} CP bo qua`);
  return priceMap;
}


// ═══════════════════════════════════════════════════
// TECHNICAL INDICATORS — Tinh toan chi bao ky thuat
// ═══════════════════════════════════════════════════

/** Tinh Simple Moving Average */
export function calcSMA(prices: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(0);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j];
    result.push(sum / period);
  }
  return result;
}

/** Tinh EMA */
export function calcEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return new Array(prices.length).fill(0);
  const multiplier = 2 / (period + 1);
  const result: number[] = new Array(period - 1).fill(0);

  // SMA cho period dau tien
  let sma = 0;
  for (let i = 0; i < period; i++) sma += prices[i];
  sma /= period;
  result.push(sma);

  // EMA tu period tro di
  for (let i = period; i < prices.length; i++) {
    const ema = (prices[i] - result[result.length - 1]) * multiplier + result[result.length - 1];
    result.push(ema);
  }
  return result;
}

/** Tinh RSI */
export function calcRSI(prices: number[], period: number = 14): number[] {
  const result: number[] = new Array(prices.length).fill(50);
  if (prices.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  // Tinh avg gain/loss cho period dau
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Smoothed RSI
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

/** Tinh MACD histogram */
export function calcMACDHistogram(prices: number[]): number[] {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    macdLine.push(ema12[i] - ema26[i]);
  }
  const signalLine = calcEMA(macdLine, 9);
  const histogram: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    histogram.push(macdLine[i] - signalLine[i]);
  }
  return histogram;
}

/** Tinh volume ratio so voi trung binh 20 phien */
export function calcVolumeRatio(volumes: number[], index: number): number {
  if (index < 20) return 1;
  let sum = 0;
  for (let j = index - 20; j < index; j++) sum += volumes[j];
  const avg = sum / 20;
  return avg > 0 ? volumes[index] / avg : 1;
}


// ═══════════════════════════════════════════════════
// TASK 3.1: CORE BACKTEST FUNCTIONS
// ═══════════════════════════════════════════════════

/**
 * Parse filter_criteria JSON tu Strategy_Rule
 * Tra ve object voi cac dieu kien loc
 */
function parseFilterCriteria(rule: StrategyRule): Record<string, any> {
  try {
    if (!rule.filterCriteria) return {};
    return JSON.parse(rule.filterCriteria);
  } catch {
    return {};
  }
}

/**
 * Kiem tra 1 ngay co thoa dieu kien entry cua rule khong
 * Dua tren filter_criteria va du lieu gia
 */
function checkEntryCondition(
  data: PriceData[],
  index: number,
  criteria: Record<string, any>,
  maPeriod: number = 50,
  consecutiveDays: number = 1,
  threshold: number = 0,
): boolean {
  if (index < maPeriod + 10) return false; // Can du du lieu cho MA

  const closes = data.map((d) => d.close);
  const volumes = data.map((d) => d.volume);
  const currentClose = closes[index];
  const currentVolume = volumes[index];

  // Check min volume
  const minVol = criteria.min_volume_20d || criteria.min_volume || MIN_AVG_VOLUME;
  let avgVol20 = 0;
  for (let j = index - 20; j < index; j++) avgVol20 += volumes[j];
  avgVol20 /= 20;
  if (avgVol20 < minVol) return false;

  // Check min price
  const minPrice = criteria.min_price || 10000;
  if (currentClose < minPrice) return false;

  // Check gia tren MA (dieu kien co ban cho hau het rules)
  const ma = calcSMA(closes.slice(0, index + 1), maPeriod);
  const currentMA = ma[ma.length - 1];
  if (currentMA <= 0) return false;

  // Threshold: gia phai tren MA - threshold%
  const thresholdPrice = currentMA * (1 - threshold / 100);
  if (currentClose < thresholdPrice) return false;

  // Check consecutive days: gia phai tren MA lien tiep N ngay
  if (consecutiveDays > 1) {
    for (let d = 1; d < consecutiveDays; d++) {
      const prevIdx = index - d;
      if (prevIdx < maPeriod) return false;
      const prevMA = calcSMA(closes.slice(0, prevIdx + 1), maPeriod);
      if (closes[prevIdx] < prevMA[prevMA.length - 1]) return false;
    }
  }

  // Check breakout volume (neu co)
  if (criteria.breakout_volume_ratio) {
    const volRatio = calcVolumeRatio(volumes, index);
    if (volRatio < criteria.breakout_volume_ratio) return false;
  }

  // Check MACD crossover (neu rule yeu cau)
  if (criteria.macd_crossover) {
    const histogram = calcMACDHistogram(closes.slice(0, index + 1));
    const currHist = histogram[histogram.length - 1];
    const prevHist = histogram[histogram.length - 2];
    // MACD vua cat len (histogram tu am sang duong)
    if (!(prevHist < 0 && currHist > 0)) return false;
  }

  // Check RS above MA49 (neu rule yeu cau)
  if (criteria.rs_above_ma49) {
    // Simplified: dung price relative strength so voi index
    const rsi = calcRSI(closes.slice(0, index + 1));
    if (rsi[rsi.length - 1] < (criteria.min_rs_rating || 60)) return false;
  }

  // Check price above MA150/MA200 (Minervini Trend Template)
  if (criteria.price_above_ma150) {
    if (index < 150) return false;
    const ma150 = calcSMA(closes.slice(0, index + 1), 150);
    if (currentClose < ma150[ma150.length - 1]) return false;
  }
  if (criteria.price_above_ma200) {
    if (index < 200) return false;
    const ma200 = calcSMA(closes.slice(0, index + 1), 200);
    if (currentClose < ma200[ma200.length - 1]) return false;
  }

  // Check MA50 above MA150 (Minervini)
  if (criteria.ma50_above_ma150) {
    if (index < 150) return false;
    const ma50 = calcSMA(closes.slice(0, index + 1), 50);
    const ma150 = calcSMA(closes.slice(0, index + 1), 150);
    if (ma50[ma50.length - 1] < ma150[ma150.length - 1]) return false;
  }

  // Check price above MA50
  if (criteria.price_above_ma50) {
    const ma50 = calcSMA(closes.slice(0, index + 1), 50);
    if (currentClose < ma50[ma50.length - 1]) return false;
  }

  return true;
}

/**
 * Tinh P&L cho 1 entry signal voi exit windows T+5 den T+10
 */
function calculateSignalPnL(data: PriceData[], entryIndex: number, entryPrice: number): BacktestSignal | null {
  const exitPrices: { day: number; price: number }[] = [];
  let bestPnl = -Infinity;
  let worstPnl = Infinity;
  let optimalDay = 7;

  // Tinh P&L cho T+5 den T+10
  for (let t = 5; t <= 10; t++) {
    const exitIdx = entryIndex + t;
    if (exitIdx >= data.length) break;

    const exitPrice = data[exitIdx].close;
    const pnl = ((exitPrice - entryPrice) / entryPrice) * 100;
    exitPrices.push({ day: t, price: exitPrice });

    if (pnl > bestPnl) {
      bestPnl = pnl;
      optimalDay = t;
    }
    if (pnl < worstPnl) {
      worstPnl = pnl;
    }
  }

  if (exitPrices.length === 0) return null;

  // Default exit tai T+7 (giua T+5 va T+10)
  const defaultExit = exitPrices.find((e) => e.day === 7) || exitPrices[Math.floor(exitPrices.length / 2)];
  const pnlPercent = ((defaultExit.price - entryPrice) / entryPrice) * 100;

  return {
    symbol: data[entryIndex]?.date ? '' : '', // Se duoc set ben ngoai
    entryDate: data[entryIndex].date,
    entryPrice,
    entryIndex,
    exitPrices,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    bestPnlPercent: bestPnl === -Infinity ? 0 : Math.round(bestPnl * 100) / 100,
    worstPnlPercent: worstPnl === Infinity ? 0 : Math.round(worstPnl * 100) / 100,
    optimalExitDay: optimalDay,
    isWin: pnlPercent > 1.0,
  };
}

/**
 * Backtest 1 Strategy_Rule tren du lieu gia lich su
 * Simulate entry conditions, tinh P&L cho T+5-T+10
 */
export async function backtestRule(
  rule: StrategyRule,
  priceData: Map<string, PriceData[]>,
  options?: { maPeriod?: number; consecutiveDays?: number; threshold?: number },
  clusterAssignments?: Map<string, ClusterType>,
): Promise<{
  signals: BacktestSignal[];
  totalSignals: number;
  winCount: number;
  lossCount: number;
  avgPnlPercent: number;
  bestPnlPercent: number;
  worstPnlPercent: number;
  winRate: number;
  profitFactor: number;
  stocksTested: number;
}> {
  const criteria = parseFilterCriteria(rule);
  const maPeriod = options?.maPeriod || criteria.ma_period || 50;
  const consecutiveDays = options?.consecutiveDays || 1;
  const threshold = options?.threshold || 0;

  const allSignals: BacktestSignal[] = [];
  let stocksTested = 0;

  // Parse target_clusters tu rule (neu co)
  let targetClusters: string[] = [];
  try {
    if ((rule as any).targetClusters) {
      targetClusters = JSON.parse((rule as any).targetClusters);
    }
  } catch { /* ignore */ }

  for (const [symbol, data] of priceData) {
    // Filter: chi backtest stocks trong target_clusters cua rule
    if (clusterAssignments && targetClusters.length > 0) {
      const stockCluster = clusterAssignments.get(symbol);
      if (stockCluster && !targetClusters.includes(stockCluster)) continue;
    }

    stocksTested++;

    // Scan tung ngay de tim entry signals
    // Bat dau tu ngay du du lieu cho MA, ket thuc truoc 10 ngay (can exit window)
    const startIdx = Math.max(maPeriod + 10, 50);
    const endIdx = data.length - 11; // Can it nhat T+10 de tinh P&L

    for (let i = startIdx; i < endIdx; i++) {
      const isEntry = checkEntryCondition(data, i, criteria, maPeriod, consecutiveDays, threshold);
      if (!isEntry) continue;

      const signal = calculateSignalPnL(data, i, data[i].close);
      if (signal) {
        signal.symbol = symbol;
        allSignals.push(signal);
        // Skip 10 ngay sau entry de tranh overlap
        i += 10;
      }
    }
  }

  // Tinh metrics tong hop
  const totalSignals = allSignals.length;
  const winCount = allSignals.filter((s) => s.isWin).length;
  const lossCount = totalSignals - winCount;
  const winRate = totalSignals > 0 ? Math.round((winCount / totalSignals) * 10000) / 100 : 0;

  const avgPnl = totalSignals > 0
    ? Math.round((allSignals.reduce((s, sig) => s + sig.pnlPercent, 0) / totalSignals) * 100) / 100
    : 0;

  const bestPnl = totalSignals > 0
    ? Math.max(...allSignals.map((s) => s.bestPnlPercent))
    : 0;

  const worstPnl = totalSignals > 0
    ? Math.min(...allSignals.map((s) => s.worstPnlPercent))
    : 0;

  // Profit factor = tong loi / tong lo
  const totalProfit = allSignals.filter((s) => s.pnlPercent > 0).reduce((s, sig) => s + sig.pnlPercent, 0);
  const totalLoss = Math.abs(allSignals.filter((s) => s.pnlPercent < 0).reduce((s, sig) => s + sig.pnlPercent, 0));
  const profitFactor = totalLoss > 0 ? Math.round((totalProfit / totalLoss) * 100) / 100 : totalProfit > 0 ? 99.99 : 0;

  return {
    signals: allSignals,
    totalSignals,
    winCount,
    lossCount,
    avgPnlPercent: avgPnl,
    bestPnlPercent: bestPnl,
    worstPnlPercent: worstPnl,
    winRate,
    profitFactor,
    stocksTested,
  };
}


// ═══════════════════════════════════════════════════
// TASK 3.2: SIGNAL VARIATION GENERATION & TESTING
// ═══════════════════════════════════════════════════

/** Cac loai variation co the tao */
interface VariationConfig {
  type: 'ma_period' | 'consecutive_days' | 'threshold' | 'cross_indicator' | 'noise_filter';
  description: string;
  params: Record<string, any>;
  maPeriod?: number;
  consecutiveDays?: number;
  threshold?: number;
}

/**
 * Tao danh sach variations cho 1 rule (max 10 per run)
 */
function buildVariationConfigs(rule: StrategyRule): VariationConfig[] {
  const criteria = parseFilterCriteria(rule);
  const baseMa = criteria.ma_period || 50;
  const variations: VariationConfig[] = [];

  // 1. MA period variations (thay doi chu ky MA)
  const maPeriods = [5, 10, 20, 50].filter((p) => p !== baseMa);
  for (const period of maPeriods.slice(0, 2)) {
    variations.push({
      type: 'ma_period',
      description: `Thay doi MA period tu ${baseMa} sang MA${period}`,
      params: { original_ma: baseMa, new_ma: period },
      maPeriod: period,
    });
  }

  // 2. Consecutive days variations (yeu cau dieu kien giu lien tiep N ngay)
  for (const days of [2, 3]) {
    variations.push({
      type: 'consecutive_days',
      description: `Yeu cau dieu kien giu ${days} ngay lien tiep`,
      params: { consecutive_days: days },
      consecutiveDays: days,
    });
  }

  // 3. Threshold variations (gia duoi MA bao nhieu %)
  for (const pct of [1, 2, 3]) {
    variations.push({
      type: 'threshold',
      description: `Gia duoi MA ${pct}% (mua khi pullback)`,
      params: { threshold_percent: pct },
      threshold: pct,
    });
  }

  // 4. Cross indicator: ket hop MACD crossover
  if (!criteria.macd_crossover) {
    variations.push({
      type: 'cross_indicator',
      description: 'Ket hop them MACD crossover bullish',
      params: { add_macd_crossover: true },
    });
  }

  // 5. Noise filter: yeu cau volume spike
  if (!criteria.breakout_volume_ratio) {
    variations.push({
      type: 'noise_filter',
      description: 'Them bo loc volume spike >= 1.5x trung binh',
      params: { add_volume_filter: true, volume_ratio: 1.5 },
    });
  }

  // Gioi han max 10 variations
  return variations.slice(0, MAX_VARIATIONS_PER_RULE);
}

/**
 * Tao va test Signal_Variations cho 1 rule
 * So sanh performance voi original, auto-promote neu tot hon >= 2 percentage points
 */
export async function generateVariations(
  rule: StrategyRule,
  priceData: Map<string, PriceData[]>,
): Promise<NewStrategySignalVariation[]> {
  const variationConfigs = buildVariationConfigs(rule);
  const results: NewStrategySignalVariation[] = [];

  // Backtest original rule truoc de co baseline
  const originalResult = await backtestRule(rule, priceData);

  for (const config of variationConfigs) {
    try {
      // Tao modified criteria cho variation
      const modifiedCriteria = { ...parseFilterCriteria(rule) };

      if (config.type === 'cross_indicator' && config.params.add_macd_crossover) {
        modifiedCriteria.macd_crossover = true;
      }
      if (config.type === 'noise_filter' && config.params.add_volume_filter) {
        modifiedCriteria.breakout_volume_ratio = config.params.volume_ratio || 1.5;
      }

      // Tao temporary rule voi modified criteria
      const tempRule: StrategyRule = {
        ...rule,
        filterCriteria: JSON.stringify(modifiedCriteria),
      };

      // Backtest variation
      const varResult = await backtestRule(tempRule, priceData, {
        maPeriod: config.maPeriod,
        consecutiveDays: config.consecutiveDays,
        threshold: config.threshold,
      });

      const improvement = varResult.avgPnlPercent - originalResult.avgPnlPercent;

      const variation: NewStrategySignalVariation = {
        backtestResultId: 0, // Se duoc set sau khi insert backtest result
        originalRuleId: rule.id,
        variationType: config.type,
        variationDescription: config.description,
        parameterChanges: JSON.stringify(config.params),
        totalSignals: varResult.totalSignals,
        winCount: varResult.winCount,
        lossCount: varResult.lossCount,
        avgPnlPercent: varResult.avgPnlPercent,
        winRate: varResult.winRate,
        profitFactor: varResult.profitFactor,
        pnlImprovementVsOriginal: Math.round(improvement * 100) / 100,
        isPromoted: 0,
        promotedRuleId: null,
      };

      results.push(variation);
    } catch (e: any) {
      console.warn(`[Backtester] ⚠️ Variation ${config.type} cho rule ${rule.name} that bai: ${e.message}`);
    }
  }

  return results;
}

/**
 * Auto-promote variation thanh Strategy_Rule moi
 * Dieu kien: avg P&L cao hon original >= 2 percentage points, min 20 signals
 */
async function promoteVariation(
  variation: NewStrategySignalVariation,
  originalRule: StrategyRule,
  variationId: number,
): Promise<number | null> {
  try {
    const db = getDatabase();
    if (!db) return null;

    // Check dieu kien promote
    if (
      (variation.pnlImprovementVsOriginal ?? 0) < 2.0 ||
      (variation.totalSignals ?? 0) < 20
    ) {
      return null;
    }

    const now = Date.now();
    const newRule: NewStrategyRule = {
      name: `${originalRule.name} — ${variation.variationDescription}`,
      description: `Bien the tu "${originalRule.name}": ${variation.variationDescription}. Avg P&L cai thien +${variation.pnlImprovementVsOriginal}% so voi original.`,
      promptTemplate: originalRule.promptTemplate,
      filterCriteria: variation.parameterChanges || originalRule.filterCriteria,
      isActive: 1,
      generation: (originalRule.generation ?? 1) + 1,
      parentRuleId: originalRule.id,
      knowledgeSources: originalRule.knowledgeSources,
      totalRecommendations: 0,
      winCount: 0,
      lossCount: 0,
      avgPnlPercent: variation.avgPnlPercent ?? 0,
      bestPnlPercent: 0,
      winRate: variation.winRate ?? 0,
      profitFactor: variation.profitFactor ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    const inserted = db.insert(strategyRules).values(newRule).returning({ id: strategyRules.id }).get();

    // Cap nhat variation la da promote
    if (inserted?.id) {
      db.update(strategySignalVariations)
        .set({ isPromoted: 1, promotedRuleId: inserted.id })
        .where(eq(strategySignalVariations.id, variationId))
        .run();

      console.log(`[Backtester] 🚀 Promote variation "${variation.variationDescription}" thanh rule moi (ID: ${inserted.id})`);
      return inserted.id;
    }

    return null;
  } catch (e: any) {
    console.warn(`[Backtester] ⚠️ Promote variation that bai: ${e.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════
// TASK 3.3: NOISE DETECTION
// ═══════════════════════════════════════════════════

/**
 * Phat hien nhieu trong tin hieu: phan tich 1st/2nd/3rd occurrence win rates
 * Trong 1 window N ngay, tin hieu lan 1 co the la nhieu (false signal),
 * lan 2 hoac 3 moi la tin hieu thuc su
 */
export function detectNoise(
  signals: BacktestSignal[],
  windowDays: number = 20,
): NoiseResult[] {
  if (signals.length < 5) return []; // Can du sample size

  // Nhom signals theo symbol
  const bySymbol = new Map<string, BacktestSignal[]>();
  for (const sig of signals) {
    const existing = bySymbol.get(sig.symbol) || [];
    existing.push(sig);
    bySymbol.set(sig.symbol, existing);
  }

  // Phan tich occurrence patterns cho tung symbol
  const firstOccurrences: BacktestSignal[] = [];
  const secondOccurrences: BacktestSignal[] = [];
  const thirdOccurrences: BacktestSignal[] = [];

  for (const [_symbol, symbolSignals] of bySymbol) {
    // Sort theo entryIndex
    const sorted = [...symbolSignals].sort((a, b) => a.entryIndex - b.entryIndex);

    let occurrenceCount = 0;
    let windowStart = -Infinity;

    for (const sig of sorted) {
      // Reset window neu da qua windowDays
      if (sig.entryIndex - windowStart > windowDays) {
        occurrenceCount = 0;
        windowStart = sig.entryIndex;
      }

      occurrenceCount++;

      if (occurrenceCount === 1) {
        firstOccurrences.push(sig);
      } else if (occurrenceCount === 2) {
        secondOccurrences.push(sig);
      } else if (occurrenceCount === 3) {
        thirdOccurrences.push(sig);
      }
      // Lan 4+ bo qua
    }
  }

  // Tinh win rate va avg P&L cho moi occurrence
  const calcStats = (sigs: BacktestSignal[]) => {
    if (sigs.length === 0) return { winRate: 0, avgPnl: 0 };
    const wins = sigs.filter((s) => s.isWin).length;
    const avgPnl = sigs.reduce((s, sig) => s + sig.pnlPercent, 0) / sigs.length;
    return {
      winRate: Math.round((wins / sigs.length) * 10000) / 100,
      avgPnl: Math.round(avgPnl * 100) / 100,
    };
  };

  const firstStats = calcStats(firstOccurrences);
  const secondStats = calcStats(secondOccurrences);
  const thirdStats = calcStats(thirdOccurrences);

  const totalSample = firstOccurrences.length + secondOccurrences.length + thirdOccurrences.length;

  // Check dieu kien noise: 1st win rate < 40% va 2nd hoac 3rd > 60%
  const isFirstNoise =
    firstStats.winRate < 40 &&
    (secondStats.winRate > 60 || thirdStats.winRate > 60);

  let recommendedAction = 'use_as_is';
  if (isFirstNoise) {
    if (secondStats.winRate > thirdStats.winRate) {
      recommendedAction = 'act_on_second';
    } else {
      recommendedAction = 'act_on_third';
    }
  }

  const result: NoiseResult = {
    signalCondition: 'Entry signal occurrence pattern',
    firstWinRate: firstStats.winRate,
    firstAvgPnl: firstStats.avgPnl,
    secondWinRate: secondStats.winRate,
    secondAvgPnl: secondStats.avgPnl,
    thirdWinRate: thirdStats.winRate,
    thirdAvgPnl: thirdStats.avgPnl,
    isFirstNoise,
    recommendedAction,
    sampleSize: totalSample,
  };

  return [result];
}

/**
 * Tao Practical_Rule "skip first occurrence" khi phat hien noise
 */
async function createNoisePracticalRule(noiseResult: NoiseResult): Promise<void> {
  try {
    if (!noiseResult.isFirstNoise) return;

    const db = getDatabase();
    if (!db) return;

    // Check xem da co rule tuong tu chua
    const existing = db.select().from(strategyPracticalRules).all();
    const hasSimilar = existing.some(
      (r) => r.condition.includes('skip first occurrence') && r.learnedFrom === 'backtest',
    );
    if (hasSimilar) return;

    const now = Date.now();
    const newRule: NewStrategyPracticalRule = {
      ruleType: 'filter',
      condition: `Skip first occurrence cua tin hieu trong window 20 ngay, act on 2nd or 3rd occurrence (1st win rate: ${noiseResult.firstWinRate}%, 2nd: ${noiseResult.secondWinRate}%, 3rd: ${noiseResult.thirdWinRate}%)`,
      learnedFrom: 'backtest',
      evidenceCount: noiseResult.sampleSize,
      counterCount: 0,
      confidence: 0.6,
      isActive: 0, // Chua active — can them evidence
      createdAt: now,
      updatedAt: now,
    };

    db.insert(strategyPracticalRules).values(newRule).run();
    console.log('[Backtester] 📝 Tao Practical_Rule: skip first occurrence');
  } catch (e: any) {
    console.warn(`[Backtester] ⚠️ Tao noise practical rule that bai: ${e.message}`);
  }
}


// ═══════════════════════════════════════════════════
// TASK 3.1 (cont): getBacktestSummary
// ═══════════════════════════════════════════════════

/**
 * Lay tom tat backtest cho 1 rule
 * Tra ve latest backtest metrics + best variation + noise count
 */
export async function getBacktestSummary(ruleId: number): Promise<BacktestSummary> {
  const summary: BacktestSummary = {
    ruleId,
    latestBacktest: null,
    bestVariation: null,
    noiseDetected: 0,
  };

  try {
    const db = getDatabase();
    if (!db) return summary;

    // Lay latest backtest result
    const latestResults = db
      .select()
      .from(strategyBacktestResults)
      .where(eq(strategyBacktestResults.strategyRuleId, ruleId))
      .orderBy(desc(strategyBacktestResults.backtestedAt))
      .limit(1)
      .all();

    if (latestResults.length === 0) return summary;

    const latest = latestResults[0];
    summary.latestBacktest = {
      totalSignals: latest.totalSignals ?? 0,
      winRate: latest.winRate ?? 0,
      avgPnlPercent: latest.avgPnlPercent ?? 0,
      profitFactor: latest.profitFactor ?? 0,
    };

    // Lay best variation cho backtest nay
    const variations = db
      .select()
      .from(strategySignalVariations)
      .where(eq(strategySignalVariations.backtestResultId, latest.id))
      .orderBy(desc(strategySignalVariations.avgPnlPercent))
      .limit(1)
      .all();

    if (variations.length > 0) {
      const bestVar = variations[0];
      summary.bestVariation = {
        description: bestVar.variationDescription,
        avgPnlPercent: bestVar.avgPnlPercent ?? 0,
        improvement: bestVar.pnlImprovementVsOriginal ?? 0,
      };
    }

    // Dem noise detections
    const noiseCount = db
      .select()
      .from(strategyNoiseDetections)
      .where(eq(strategyNoiseDetections.backtestResultId, latest.id))
      .all();

    summary.noiseDetected = noiseCount.filter((n) => n.isFirstNoise === 1).length;
  } catch (e: any) {
    console.warn(`[Backtester] ⚠️ getBacktestSummary(${ruleId}) that bai: ${e.message}`);
  }

  return summary;
}


// ═══════════════════════════════════════════════════
// TASK 3.4: BACKTESTER SCHEDULER
// ═══════════════════════════════════════════════════

/**
 * Chay backtest cho tat ca active rules
 * Goi boi scheduler hang ngay 17:00 VN
 */
async function runDailyBacktest(): Promise<void> {
  console.log('[Backtester] 🔄 Bat dau backtest hang ngay...');
  const startTime = Date.now();

  try {
    const db = getDatabase();
    if (!db) {
      console.warn('[Backtester] ⚠️ Database chua san sang, bo qua backtest');
      return;
    }

    // Lay tat ca active rules
    const activeRules = db
      .select()
      .from(strategyRules)
      .where(eq(strategyRules.isActive, 1))
      .all();

    if (activeRules.length === 0) {
      console.log('[Backtester] ℹ️ Khong co active rules de backtest');
      return;
    }

    console.log(`[Backtester] 📋 Co ${activeRules.length} active rules de backtest`);

    // Batch fetch du lieu gia 1 lan cho tat ca CP
    const priceData = await fetchAllHistoricalPrices();
    if (priceData.size === 0) {
      console.warn('[Backtester] ⚠️ Khong fetch duoc du lieu gia, bo qua backtest');
      return;
    }

    const now = Date.now();
    const periodEnd = now;
    const periodStart = now - 180 * 24 * 60 * 60 * 1000; // 6 thang truoc

    // Backtest tung rule
    for (const rule of activeRules) {
      try {
        console.log(`[Backtester] 🧪 Backtest rule: ${rule.name} (ID: ${rule.id})`);

        // 1. Backtest original rule
        const result = await backtestRule(rule, priceData);

        // 2. Tao va test variations
        const variations = await generateVariations(rule, priceData);

        // 3. Detect noise
        const noiseResults = detectNoise(result.signals);
        const noiseCount = noiseResults.filter((n) => n.isFirstNoise).length;

        // 4. Flag low_confidence neu total_signals < 5
        let aiSummary = '';
        if (result.totalSignals < 5) {
          aiSummary = '[low_confidence] Khong du tin hieu de danh gia (< 5 signals). ';
        }

        // 5. Luu backtest result vao DB
        const backtestRecord: NewStrategyBacktestResult = {
          strategyRuleId: rule.id,
          backtestedAt: now,
          periodStart,
          periodEnd,
          totalSignals: result.totalSignals,
          winCount: result.winCount,
          lossCount: result.lossCount,
          avgPnlPercent: result.avgPnlPercent,
          bestPnlPercent: result.bestPnlPercent,
          worstPnlPercent: result.worstPnlPercent,
          winRate: result.winRate,
          profitFactor: result.profitFactor,
          noiseSignalsDetected: noiseCount,
          aiAnalysisSummary: aiSummary || null,
          stocksTested: result.stocksTested,
        };

        const inserted = db
          .insert(strategyBacktestResults)
          .values(backtestRecord)
          .returning({ id: strategyBacktestResults.id })
          .get();

        const backtestId = inserted?.id;
        if (!backtestId) continue;

        // 6. Luu variations vao DB
        for (const variation of variations) {
          try {
            variation.backtestResultId = backtestId;
            const insertedVar = db
              .insert(strategySignalVariations)
              .values(variation)
              .returning({ id: strategySignalVariations.id })
              .get();

            // Auto-promote neu du dieu kien
            if (insertedVar?.id) {
              await promoteVariation(variation, rule, insertedVar.id);
            }
          } catch (e: any) {
            console.warn(`[Backtester] ⚠️ Luu variation that bai: ${e.message}`);
          }
        }

        // 7. Luu noise detections vao DB
        for (const noise of noiseResults) {
          try {
            const noiseRecord: NewStrategyNoiseDetection = {
              backtestResultId: backtestId,
              signalCondition: noise.signalCondition,
              firstOccurrenceWinRate: noise.firstWinRate,
              firstOccurrenceAvgPnl: noise.firstAvgPnl,
              secondOccurrenceWinRate: noise.secondWinRate,
              secondOccurrenceAvgPnl: noise.secondAvgPnl,
              thirdOccurrenceWinRate: noise.thirdWinRate,
              thirdOccurrenceAvgPnl: noise.thirdAvgPnl,
              isFirstNoise: noise.isFirstNoise ? 1 : 0,
              recommendedAction: noise.recommendedAction,
              sampleSize: noise.sampleSize,
            };

            db.insert(strategyNoiseDetections).values(noiseRecord).run();

            // Tao Practical_Rule neu phat hien noise
            await createNoisePracticalRule(noise);
          } catch (e: any) {
            console.warn(`[Backtester] ⚠️ Luu noise detection that bai: ${e.message}`);
          }
        }

        // 8. Dung Gemini AI phan tich ket qua (neu chua co summary)
        if (!aiSummary) {
          try {
            aiSummary = await analyzeBacktestWithAI(rule, result, variations, noiseResults);
            if (aiSummary) {
              // Flag low_confidence trong AI summary neu can
              if (result.totalSignals < 5 && !aiSummary.includes('low_confidence')) {
                aiSummary = `[low_confidence] ${aiSummary}`;
              }
              db.update(strategyBacktestResults)
                .set({ aiAnalysisSummary: aiSummary })
                .where(eq(strategyBacktestResults.id, backtestId))
                .run();
            }
          } catch (e: any) {
            console.warn(`[Backtester] ⚠️ AI analysis that bai (non-fatal): ${e.message}`);
          }
        }

        console.log(
          `[Backtester] ✅ Rule "${rule.name}": ${result.totalSignals} signals, ` +
          `win rate ${result.winRate}%, avg P&L ${result.avgPnlPercent}%, ` +
          `${variations.length} variations, ${noiseCount} noise`,
        );
      } catch (e: any) {
        console.warn(`[Backtester] ⚠️ Backtest rule ${rule.name} that bai (non-fatal): ${e.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Backtester] ✅ Backtest hang ngay hoan thanh trong ${elapsed}s`);
  } catch (error: any) {
    console.warn(`[Backtester] ⚠️ runDailyBacktest that bai (non-fatal): ${error.message}`);
  }
}

/**
 * Dung Gemini AI phan tich va tom tat ket qua backtest
 */
async function analyzeBacktestWithAI(
  rule: StrategyRule,
  result: { totalSignals: number; winRate: number; avgPnlPercent: number; profitFactor: number; bestPnlPercent: number; worstPnlPercent: number },
  variations: NewStrategySignalVariation[],
  noiseResults: NoiseResult[],
): Promise<string> {
  try {
    const ai = getAI();

    const variationSummary = variations
      .map((v) => `- ${v.variationDescription}: ${v.totalSignals} signals, avg P&L ${v.avgPnlPercent}%, improvement ${v.pnlImprovementVsOriginal}%`)
      .join('\n');

    const noiseSummary = noiseResults
      .map((n) => `- ${n.signalCondition}: 1st win ${n.firstWinRate}%, 2nd win ${n.secondWinRate}%, 3rd win ${n.thirdWinRate}%, noise: ${n.isFirstNoise}`)
      .join('\n');

    const prompt = `Phan tich ket qua backtest cua Strategy Rule "${rule.name}":

KET QUA ORIGINAL:
- Tong tin hieu: ${result.totalSignals}
- Win rate: ${result.winRate}%
- Avg P&L: ${result.avgPnlPercent}%
- Profit factor: ${result.profitFactor}
- Best P&L: ${result.bestPnlPercent}%
- Worst P&L: ${result.worstPnlPercent}%

VARIATIONS:
${variationSummary || 'Khong co variation'}

NOISE DETECTION:
${noiseSummary || 'Khong phat hien noise'}

Hay tom tat ngan gon (3-5 cau):
1. Rule nay hieu qua khong?
2. Variation nao tot nhat?
3. Co noise khong va nen xu ly the nao?
4. Khuyen nghi cai thien?

Tra loi bang tieng Viet (khong dau), ngan gon.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-lite',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.3, maxOutputTokens: 500 },
    });

    return response.text || '';
  } catch (e: any) {
    console.warn(`[Backtester] ⚠️ AI analysis that bai: ${e.message}`);
    return '';
  }
}

/**
 * Lay gio VN hien tai
 */
function getVNTime(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
}

/**
 * Check co phai ngay giao dich (T2-T6) khong
 */
function isTradingDay(): boolean {
  const vnNow = getVNTime();
  const day = vnNow.getDay();
  return day >= 1 && day <= 5; // T2 = 1, T6 = 5
}

/**
 * Backtest 1 rule voi walk-forward validation
 * Dung walk-forward windows thay vi single-period
 */
export async function runBacktestWithWalkForward(
  rule: StrategyRule,
  priceData: Map<string, PriceData[]>,
  clusterAssignments?: Map<string, ClusterType>,
): Promise<void> {
  try {
    // Tim date range tu price data
    let minDate = Infinity;
    let maxDate = 0;
    for (const [, data] of priceData) {
      if (data.length > 0) {
        const first = new Date(data[0].date).getTime();
        const last = new Date(data[data.length - 1].date).getTime();
        if (first < minDate) minDate = first;
        if (last > maxDate) maxDate = last;
      }
    }

    if (minDate >= maxDate) return;

    // Generate walk-forward windows
    const windows = generateWindows(minDate, maxDate);
    if (windows.length < 3) {
      console.log(`[Backtester] ⏳ Rule #${rule.id}: chi co ${windows.length} windows, skip walk-forward`);
      return;
    }

    // Validate strategy qua cac windows
    await validateStrategy(rule.id, priceData, windows);
  } catch (e: any) {
    console.warn(`[Backtester] ⚠️ Walk-forward rule #${rule.id} that bai: ${e.message}`);
  }
}

/**
 * Start Historical Backtester scheduler
 * V2: Chay 1 lan/ngay luc 15:30 VN (T2-T6) — phan cua daily cycle
 * Giu lai de backward compat, nhung daily cycle se goi runDailyBacktest() truc tiep
 */
export function startHistoricalBacktester(): void {
  console.log('[Backtester] 🚀 Khoi dong Historical Backtester (1x/ngay, goi tu daily cycle)');
  // V2: Khong tu chay scheduler rieng nua — daily cycle se goi runDailyBacktest()
  // Giu function nay de khong break import cu
}

/**
 * Export runDailyBacktest de daily cycle goi truc tiep
 */
export { runDailyBacktest };
