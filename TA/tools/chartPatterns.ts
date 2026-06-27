/**
 * Chart Pattern Detection - Phân tích mô hình giá
 * 
 * Dựa trên phương pháp của:
 * - William O'Neil (CANSLIM, Cup & Handle)
 * - Mark Minervini (VCP, Stage Analysis)
 * - Chris Kacher (Pocket Pivot, Follow-through Day)
 * - 3C Pattern (Contraction, Consolidation, Continuation)
 * 
 * Features:
 * - Chart Patterns: Cup & Handle, Double Bottom, Head & Shoulders, Triangle, Flag
 * - VCP (Volatility Contraction Pattern)
 * - 3C Pattern
 * - Fibonacci Extension for ATH breakout
 * - Target Price calculation
 */

import type { OHLCV } from './chartVision.js';

// ═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════

export interface ChartPattern {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  confidence: number;        // 0-100
  pivotPoint: number;        // Điểm breakout
  targetPrice: number;       // Mục tiêu giá
  stopLoss: number;          // Cắt lỗ
  description: string;
  methodology: string;       // O'Neil, Minervini, etc.
}

export interface VCPAnalysis {
  isVCP: boolean;
  contractions: number;
  volatilityReduction: number;
  pivotPoint: number;
  stage: 'forming' | 'ready' | 'breakout' | 'failed' | 'none';
  tightness: number;         // Độ chặt của pattern (0-100)
  volumeDryUp: boolean;      // Volume cạn kiệt
  description: string;
}

export interface ThreeCPattern {
  detected: boolean;
  phase: 'contraction' | 'consolidation' | 'continuation' | 'none';
  contractionDepth: number;  // % co hẹp
  consolidationDays: number; // Số ngày tích lũy
  breakoutReady: boolean;
  description: string;
}

export interface FibonacciExtension {
  isATHBreakout: boolean;
  currentPrice: number;
  ath: number;
  extensions: {
    level: string;
    price: number;
    description: string;
  }[];
  nearestTarget: number;
  description: string;
}

export interface CANSLIMScore {
  total: number;             // 0-100
  c: number;                 // Current earnings
  a: number;                 // Annual earnings
  n: number;                 // New products/management/highs
  s: number;                 // Supply & demand
  l: number;                 // Leader or laggard
  i: number;                 // Institutional sponsorship
  m: number;                 // Market direction
  description: string;
}

export interface PatternAnalysisResult {
  patterns: ChartPattern[];
  vcp: VCPAnalysis;
  threeC: ThreeCPattern;
  fibonacci: FibonacciExtension;
  multiTimeframe: MultiTimeframeAnalysis;  // NEW: Multi-timeframe analysis
  primaryTarget: number;
  secondaryTarget: number;
  stopLoss: number;
  riskReward: number;
  summary: string;
}

// ═══════════════════════════════════════════════════
// MULTI-TIMEFRAME TYPES
// ═══════════════════════════════════════════════════

export interface MultiTimeframeAnalysis {
  daily: TimeframeSignals;
  weekly: TimeframeSignals;
  alignment: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
  explosivePotential: boolean;  // Volume bùng nổ + trên MA10 tuần
  description: string;
}

export interface TimeframeSignals {
  // Volume Analysis
  volumeStatus: 'explosive' | 'high' | 'normal' | 'dry_up' | 'very_dry';
  volumeRatio: number;           // Current vs Avg20
  volumeDryUpDays: number;       // Số ngày volume thấp liên tiếp
  
  // MA Position
  priceAboveMA10: boolean;
  priceAboveMA20: boolean;
  priceAboveMA50: boolean;
  
  // MA Crossovers (trong 5 nến gần nhất)
  maCrossovers: MACrossover[];
  
  // Trend
  trend: 'up' | 'down' | 'sideways';
  trendStrength: number;         // 0-100
}

export interface MACrossover {
  type: 'golden_cross' | 'death_cross';
  fastMA: number;    // e.g., 5, 10
  slowMA: number;    // e.g., 10, 20, 50
  daysAgo: number;   // Bao nhiêu nến trước
  description: string;
}

// ═══════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════

function findSwingHighs(data: OHLCV[], lookback: number = 5): { index: number; price: number; date: string }[] {
  const swings: { index: number; price: number; date: string }[] = [];
  
  for (let i = lookback; i < data.length - lookback; i++) {
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i].high <= data[i - j].high || data[i].high <= data[i + j].high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      swings.push({ index: i, price: data[i].high, date: data[i].date });
    }
  }
  
  return swings;
}

function findSwingLows(data: OHLCV[], lookback: number = 5): { index: number; price: number; date: string }[] {
  const swings: { index: number; price: number; date: string }[] = [];
  
  for (let i = lookback; i < data.length - lookback; i++) {
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i].low >= data[i - j].low || data[i].low >= data[i + j].low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      swings.push({ index: i, price: data[i].low, date: data[i].date });
    }
  }
  
  return swings;
}

function calculateATR(data: OHLCV[], period: number = 14): number {
  if (data.length < period + 1) return 0;
  
  let atrSum = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i - 1]?.close || data[i].open;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  
  return atrSum / period;
}

function calculateSMA(data: OHLCV[], period: number): number {
  if (data.length < period) return 0;
  const slice = data.slice(-period);
  return slice.reduce((sum, d) => sum + d.close, 0) / period;
}

function calculateAvgVolume(data: OHLCV[], period: number): number {
  if (data.length < period) return 0;
  const slice = data.slice(-period);
  return slice.reduce((sum, d) => sum + d.volume, 0) / period;
}

// ═══════════════════════════════════════════════════
// MULTI-TIMEFRAME ANALYSIS
// ═══════════════════════════════════════════════════

/**
 * Convert daily OHLCV data to weekly OHLCV
 * Mỗi tuần = 5 phiên giao dịch
 */
function convertToWeekly(dailyData: OHLCV[]): OHLCV[] {
  if (dailyData.length < 5) return [];
  
  const weeklyData: OHLCV[] = [];
  
  // Group by week (5 trading days)
  for (let i = 0; i < dailyData.length; i += 5) {
    const weekCandles = dailyData.slice(i, Math.min(i + 5, dailyData.length));
    if (weekCandles.length < 3) continue; // Need at least 3 days for valid week
    
    const weekOpen = weekCandles[0].open;
    const weekClose = weekCandles[weekCandles.length - 1].close;
    const weekHigh = Math.max(...weekCandles.map(c => c.high));
    const weekLow = Math.min(...weekCandles.map(c => c.low));
    const weekVolume = weekCandles.reduce((sum, c) => sum + c.volume, 0);
    
    weeklyData.push({
      date: weekCandles[0].date,
      open: weekOpen,
      high: weekHigh,
      low: weekLow,
      close: weekClose,
      volume: weekVolume,
    });
  }
  
  return weeklyData;
}

/**
 * Calculate MA values for a specific period
 */
function calculateMAValues(data: OHLCV[], periods: number[]): Map<number, number[]> {
  const maValues = new Map<number, number[]>();
  
  for (const period of periods) {
    const values: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        values.push(0);
      } else {
        const slice = data.slice(i - period + 1, i + 1);
        const ma = slice.reduce((sum, d) => sum + d.close, 0) / period;
        values.push(ma);
      }
    }
    maValues.set(period, values);
  }
  
  return maValues;
}

/**
 * Detect MA crossovers in recent candles
 * Golden Cross: Fast MA crosses above Slow MA
 * Death Cross: Fast MA crosses below Slow MA
 */
function detectMACrossovers(data: OHLCV[], lookbackCandles: number = 5): MACrossover[] {
  const crossovers: MACrossover[] = [];
  
  // MA pairs to check: [fast, slow]
  const maPairs = [
    [5, 10],
    [5, 20],
    [10, 20],
    [10, 50],
    [20, 50],
  ];
  
  const allPeriods = [...new Set(maPairs.flat())];
  const maValues = calculateMAValues(data, allPeriods);
  
  for (const [fast, slow] of maPairs) {
    const fastMA = maValues.get(fast) || [];
    const slowMA = maValues.get(slow) || [];
    
    if (fastMA.length < lookbackCandles + 1 || slowMA.length < lookbackCandles + 1) continue;
    
    // Check last N candles for crossover
    for (let i = 1; i <= lookbackCandles; i++) {
      const idx = data.length - i;
      const prevIdx = idx - 1;
      
      if (prevIdx < 0) continue;
      
      const fastNow = fastMA[idx];
      const fastPrev = fastMA[prevIdx];
      const slowNow = slowMA[idx];
      const slowPrev = slowMA[prevIdx];
      
      if (fastNow === 0 || slowNow === 0 || fastPrev === 0 || slowPrev === 0) continue;
      
      // Golden Cross: Fast crosses above Slow
      if (fastPrev <= slowPrev && fastNow > slowNow) {
        crossovers.push({
          type: 'golden_cross',
          fastMA: fast,
          slowMA: slow,
          daysAgo: i,
          description: `🟢 Golden Cross MA${fast}xMA${slow} (${i} nến trước)`,
        });
      }
      
      // Death Cross: Fast crosses below Slow
      if (fastPrev >= slowPrev && fastNow < slowNow) {
        crossovers.push({
          type: 'death_cross',
          fastMA: fast,
          slowMA: slow,
          daysAgo: i,
          description: `🔴 Death Cross MA${fast}xMA${slow} (${i} nến trước)`,
        });
      }
    }
  }
  
  return crossovers;
}

/**
 * Analyze volume status
 */
function analyzeVolumeStatus(data: OHLCV[]): { status: TimeframeSignals['volumeStatus']; ratio: number; dryUpDays: number } {
  if (data.length < 20) {
    return { status: 'normal', ratio: 1, dryUpDays: 0 };
  }
  
  const avgVolume20 = calculateAvgVolume(data, 20);
  const currentVolume = data[data.length - 1].volume;
  const ratio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;
  
  // Count consecutive dry up days (volume < 70% avg)
  let dryUpDays = 0;
  for (let i = data.length - 1; i >= Math.max(0, data.length - 10); i--) {
    if (data[i].volume < avgVolume20 * 0.7) {
      dryUpDays++;
    } else {
      break;
    }
  }
  
  let status: TimeframeSignals['volumeStatus'] = 'normal';
  if (ratio >= 2.5) status = 'explosive';
  else if (ratio >= 1.5) status = 'high';
  else if (ratio <= 0.5) status = 'very_dry';
  else if (ratio <= 0.7) status = 'dry_up';
  
  return { status, ratio, dryUpDays };
}

/**
 * Analyze a single timeframe (daily or weekly)
 */
function analyzeTimeframe(data: OHLCV[]): TimeframeSignals {
  if (data.length < 20) {
    return {
      volumeStatus: 'normal',
      volumeRatio: 1,
      volumeDryUpDays: 0,
      priceAboveMA10: false,
      priceAboveMA20: false,
      priceAboveMA50: false,
      maCrossovers: [],
      trend: 'sideways',
      trendStrength: 50,
    };
  }
  
  const current = data[data.length - 1];
  
  // Volume analysis
  const volumeAnalysis = analyzeVolumeStatus(data);
  
  // MA positions
  const ma10 = calculateSMA(data, 10);
  const ma20 = calculateSMA(data, 20);
  const ma50 = data.length >= 50 ? calculateSMA(data, 50) : 0;
  
  // MA crossovers
  const maCrossovers = detectMACrossovers(data, 5);
  
  // Trend analysis
  let trend: TimeframeSignals['trend'] = 'sideways';
  let trendStrength = 50;
  
  if (current.close > ma10 && ma10 > ma20) {
    trend = 'up';
    trendStrength = 70;
    if (ma50 > 0 && ma20 > ma50) trendStrength = 85;
  } else if (current.close < ma10 && ma10 < ma20) {
    trend = 'down';
    trendStrength = 30;
    if (ma50 > 0 && ma20 < ma50) trendStrength = 15;
  }
  
  return {
    volumeStatus: volumeAnalysis.status,
    volumeRatio: volumeAnalysis.ratio,
    volumeDryUpDays: volumeAnalysis.dryUpDays,
    priceAboveMA10: current.close > ma10,
    priceAboveMA20: current.close > ma20,
    priceAboveMA50: ma50 > 0 && current.close > ma50,
    maCrossovers,
    trend,
    trendStrength,
  };
}

/**
 * Multi-timeframe analysis - Daily + Weekly
 * Phân tích đồng thời chart ngày và chart tuần
 */
export function analyzeMultiTimeframe(dailyData: OHLCV[]): MultiTimeframeAnalysis {
  // Analyze daily
  const daily = analyzeTimeframe(dailyData);
  
  // Convert to weekly and analyze
  const weeklyData = convertToWeekly(dailyData);
  const weekly = analyzeTimeframe(weeklyData);
  
  // Determine alignment
  let alignment: MultiTimeframeAnalysis['alignment'] = 'neutral';
  
  const dailyBullish = daily.trend === 'up' && daily.priceAboveMA10;
  const dailyBearish = daily.trend === 'down' && !daily.priceAboveMA10;
  const weeklyBullish = weekly.trend === 'up' && weekly.priceAboveMA10;
  const weeklyBearish = weekly.trend === 'down' && !weekly.priceAboveMA10;
  
  if (dailyBullish && weeklyBullish) {
    alignment = 'strong_bullish';
  } else if (dailyBullish || weeklyBullish) {
    alignment = 'bullish';
  } else if (dailyBearish && weeklyBearish) {
    alignment = 'strong_bearish';
  } else if (dailyBearish || weeklyBearish) {
    alignment = 'bearish';
  }
  
  // Check explosive potential
  // Volume bùng nổ (>2x) + trên MA10 tuần = tiềm năng tăng mạnh
  const explosivePotential = 
    (weekly.volumeStatus === 'explosive' || weekly.volumeStatus === 'high') &&
    weekly.priceAboveMA10 &&
    weekly.trend === 'up';
  
  // Build description
  const parts: string[] = [];
  
  // Daily signals
  parts.push(`📅 **CHART NGÀY:**`);
  parts.push(`• Xu hướng: ${daily.trend === 'up' ? '🟢 TĂNG' : daily.trend === 'down' ? '🔴 GIẢM' : '⚪ SIDEWAY'}`);
  parts.push(`• Volume: ${getVolumeStatusText(daily.volumeStatus)} (${daily.volumeRatio.toFixed(1)}x avg)`);
  if (daily.volumeDryUpDays >= 3) {
    parts.push(`• 🔥 Volume kiệt cung ${daily.volumeDryUpDays} phiên liên tiếp`);
  }
  parts.push(`• Vị trí: ${daily.priceAboveMA10 ? '✓ Trên MA10' : '✗ Dưới MA10'} | ${daily.priceAboveMA20 ? '✓ Trên MA20' : '✗ Dưới MA20'} | ${daily.priceAboveMA50 ? '✓ Trên MA50' : '✗ Dưới MA50'}`);
  
  if (daily.maCrossovers.length > 0) {
    parts.push(`• MA Crossover:`);
    daily.maCrossovers.forEach(c => parts.push(`  ${c.description}`));
  }
  
  // Weekly signals
  parts.push(`\n📆 **CHART TUẦN:**`);
  parts.push(`• Xu hướng: ${weekly.trend === 'up' ? '🟢 TĂNG' : weekly.trend === 'down' ? '🔴 GIẢM' : '⚪ SIDEWAY'}`);
  parts.push(`• Volume: ${getVolumeStatusText(weekly.volumeStatus)} (${weekly.volumeRatio.toFixed(1)}x avg)`);
  if (weekly.volumeDryUpDays >= 2) {
    parts.push(`• 🔥 Volume kiệt cung ${weekly.volumeDryUpDays} tuần liên tiếp`);
  }
  parts.push(`• Vị trí: ${weekly.priceAboveMA10 ? '✓ Trên MA10W' : '✗ Dưới MA10W'} | ${weekly.priceAboveMA20 ? '✓ Trên MA20W' : '✗ Dưới MA20W'}`);
  
  if (weekly.maCrossovers.length > 0) {
    parts.push(`• MA Crossover (tuần):`);
    weekly.maCrossovers.forEach(c => parts.push(`  ${c.description}`));
  }
  
  // Alignment verdict
  parts.push(`\n**🎯 ĐÁNH GIÁ MULTI-TIMEFRAME:**`);
  
  if (alignment === 'strong_bullish') {
    parts.push(`🟢 **ĐỒNG THUẬN TĂNG MẠNH** - Cả chart ngày và tuần đều bullish!`);
  } else if (alignment === 'bullish') {
    parts.push(`🟡 **THIÊN HƯỚNG TĂNG** - Có tín hiệu tích cực nhưng chưa đồng thuận hoàn toàn`);
  } else if (alignment === 'strong_bearish') {
    parts.push(`🔴 **ĐỒNG THUẬN GIẢM MẠNH** - Cả chart ngày và tuần đều bearish!`);
  } else if (alignment === 'bearish') {
    parts.push(`🟠 **THIÊN HƯỚNG GIẢM** - Có tín hiệu tiêu cực`);
  } else {
    parts.push(`⚪ **TRUNG TÍNH** - Chưa có xu hướng rõ ràng`);
  }
  
  // Explosive potential
  if (explosivePotential) {
    parts.push(`\n🚀 **TIỀM NĂNG TĂNG MẠNH!**`);
    parts.push(`Volume bùng nổ trên chart tuần + Giá trên MA10 tuần → Điều kiện lý tưởng cho sóng tăng!`);
  }
  
  // Check for ideal setup: Volume dry up → Volume explosion
  if (daily.volumeDryUpDays >= 3 && (daily.volumeStatus === 'explosive' || daily.volumeStatus === 'high')) {
    parts.push(`\n⚡ **TÍN HIỆU KIỆT CUNG → BÙNG NỔ!**`);
    parts.push(`Sau ${daily.volumeDryUpDays} phiên volume kiệt cung, volume đang bùng nổ → Có thể là điểm breakout!`);
  }
  
  return {
    daily,
    weekly,
    alignment,
    explosivePotential,
    description: parts.join('\n'),
  };
}

function getVolumeStatusText(status: TimeframeSignals['volumeStatus']): string {
  switch (status) {
    case 'explosive': return '🔥 BÙNG NỔ';
    case 'high': return '📈 Cao';
    case 'normal': return '⚪ Bình thường';
    case 'dry_up': return '📉 Kiệt cung';
    case 'very_dry': return '🏜️ Rất kiệt cung';
    default: return '⚪ Bình thường';
  }
}

// ═══════════════════════════════════════════════════
// VCP PATTERN DETECTION (Mark Minervini)
// ═══════════════════════════════════════════════════

/**
 * Detect VCP (Volatility Contraction Pattern) - Mark Minervini
 * 
 * Criteria:
 * 1. Uptrend trước đó (giá > MA50 > MA200)
 * 2. Có ít nhất 2-4 lần co hẹp (contractions)
 * 3. Mỗi lần co hẹp có biên độ nhỏ hơn lần trước
 * 4. Volume giảm dần (dry up)
 * 5. Pivot point rõ ràng
 */
export function detectVCP(data: OHLCV[]): VCPAnalysis {
  if (data.length < 60) {
    return { isVCP: false, contractions: 0, volatilityReduction: 0, pivotPoint: 0, stage: 'none', tightness: 0, volumeDryUp: false, description: 'Không đủ dữ liệu' };
  }
  
  const recent = data.slice(-60);
  const current = recent[recent.length - 1];
  const ma50 = calculateSMA(data, 50);
  const ma200 = calculateSMA(data, 200);
  
  // Check uptrend: Price > MA50 > MA200
  const isUptrend = current.close > ma50 && ma50 > ma200;
  if (!isUptrend) {
    return { isVCP: false, contractions: 0, volatilityReduction: 0, pivotPoint: 0, stage: 'none', tightness: 0, volumeDryUp: false, description: 'Không có uptrend (cần Price > MA50 > MA200)' };
  }
  
  // Find contractions (swing highs and lows)
  const swingHighs = findSwingHighs(recent, 3);
  const swingLows = findSwingLows(recent, 3);
  
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { isVCP: false, contractions: 0, volatilityReduction: 0, pivotPoint: 0, stage: 'none', tightness: 0, volumeDryUp: false, description: 'Không đủ swing points' };
  }
  
  // Calculate contractions
  const contractions: { range: number; high: number; low: number }[] = [];
  
  for (let i = 0; i < Math.min(swingHighs.length, swingLows.length); i++) {
    const high = swingHighs[i]?.price || 0;
    const low = swingLows[i]?.price || 0;
    if (high > 0 && low > 0) {
      contractions.push({ range: (high - low) / low * 100, high, low });
    }
  }
  
  // Check if volatility is decreasing
  let volatilityDecreasing = true;
  let totalReduction = 0;
  
  for (let i = 1; i < contractions.length; i++) {
    if (contractions[i].range >= contractions[i - 1].range) {
      volatilityDecreasing = false;
    }
    totalReduction += (contractions[i - 1].range - contractions[i].range);
  }
  
  const volatilityReduction = contractions.length > 1 
    ? (contractions[0].range - contractions[contractions.length - 1].range) / contractions[0].range * 100 
    : 0;
  
  // Check volume dry up
  const avgVolume20 = calculateAvgVolume(data, 20);
  const avgVolume50 = calculateAvgVolume(data, 50);
  const recentVolume = calculateAvgVolume(data.slice(-5), 5);
  const volumeDryUp = recentVolume < avgVolume50 * 0.7;
  
  // Calculate pivot point (highest high in recent contractions)
  const pivotPoint = Math.max(...swingHighs.slice(-3).map(s => s.price));
  
  // Calculate tightness (how tight the pattern is)
  const recentRange = (Math.max(...recent.slice(-10).map(d => d.high)) - Math.min(...recent.slice(-10).map(d => d.low))) / current.close * 100;
  const tightness = Math.max(0, 100 - recentRange * 10);
  
  // Determine stage
  let stage: VCPAnalysis['stage'] = 'none';
  const distanceFromPivot = (pivotPoint - current.close) / current.close * 100;
  
  if (contractions.length >= 2 && volatilityReduction > 30) {
    if (current.close > pivotPoint) {
      stage = 'breakout';
    } else if (distanceFromPivot < 3 && volumeDryUp) {
      stage = 'ready';
    } else if (volatilityDecreasing) {
      stage = 'forming';
    }
  }
  
  const isVCP = stage !== 'none' && contractions.length >= 2 && volatilityReduction > 20;
  
  // Build description
  let description = '';
  if (isVCP) {
    description = `VCP ${stage.toUpperCase()}: ${contractions.length} contractions, biên độ giảm ${volatilityReduction.toFixed(0)}%`;
    if (stage === 'ready') {
      description += `. Pivot: ${pivotPoint.toLocaleString('vi-VN')} - SẴN SÀNG BREAKOUT!`;
    } else if (stage === 'breakout') {
      description += `. ĐÃ BREAKOUT pivot ${pivotPoint.toLocaleString('vi-VN')}!`;
    }
    if (volumeDryUp) {
      description += ' Volume cạn kiệt ✓';
    }
  } else {
    description = 'Không phát hiện VCP pattern';
  }
  
  return {
    isVCP,
    contractions: contractions.length,
    volatilityReduction,
    pivotPoint,
    stage,
    tightness,
    volumeDryUp,
    description,
  };
}


// ═══════════════════════════════════════════════════
// 3C PATTERN DETECTION
// ═══════════════════════════════════════════════════

/**
 * Detect 3C Pattern (Contraction, Consolidation, Continuation)
 * 
 * Phase 1: Contraction - Giá co hẹp sau uptrend
 * Phase 2: Consolidation - Tích lũy sideway với volume giảm
 * Phase 3: Continuation - Breakout tiếp tục xu hướng
 */
export function detect3CPattern(data: OHLCV[]): ThreeCPattern {
  if (data.length < 40) {
    return { detected: false, phase: 'none', contractionDepth: 0, consolidationDays: 0, breakoutReady: false, description: 'Không đủ dữ liệu' };
  }
  
  const recent = data.slice(-40);
  const current = recent[recent.length - 1];
  
  // Find the highest point in last 40 days
  let highestIdx = 0;
  let highestPrice = 0;
  for (let i = 0; i < recent.length - 5; i++) {
    if (recent[i].high > highestPrice) {
      highestPrice = recent[i].high;
      highestIdx = i;
    }
  }
  
  // Find the lowest point after the high
  let lowestPrice = Infinity;
  let lowestIdx = highestIdx;
  for (let i = highestIdx; i < recent.length; i++) {
    if (recent[i].low < lowestPrice) {
      lowestPrice = recent[i].low;
      lowestIdx = i;
    }
  }
  
  const contractionDepth = (highestPrice - lowestPrice) / highestPrice * 100;
  
  // Check consolidation (sideway after contraction)
  const consolidationStart = lowestIdx;
  const consolidationData = recent.slice(consolidationStart);
  const consolidationDays = consolidationData.length;
  
  // Calculate consolidation range
  const consHigh = Math.max(...consolidationData.map(d => d.high));
  const consLow = Math.min(...consolidationData.map(d => d.low));
  const consRange = (consHigh - consLow) / consLow * 100;
  
  // Check volume dry up during consolidation
  const avgVolBefore = calculateAvgVolume(recent.slice(0, consolidationStart), Math.min(20, consolidationStart));
  const avgVolDuring = calculateAvgVolume(consolidationData, consolidationDays);
  const volumeDryUp = avgVolDuring < avgVolBefore * 0.6;
  
  // Determine phase
  let phase: ThreeCPattern['phase'] = 'none';
  let detected = false;
  let breakoutReady = false;
  
  if (contractionDepth >= 10 && contractionDepth <= 35) {
    if (consolidationDays >= 5 && consRange < 10) {
      phase = 'consolidation';
      detected = true;
      
      // Check if ready for continuation
      if (volumeDryUp && current.close > (consHigh + consLow) / 2) {
        breakoutReady = true;
        if (current.close > consHigh * 0.98) {
          phase = 'continuation';
        }
      }
    } else if (consolidationDays < 5) {
      phase = 'contraction';
      detected = true;
    }
  }
  
  // Build description
  let description = '';
  if (detected) {
    description = `3C Pattern - Phase: ${phase.toUpperCase()}`;
    description += `. Contraction: ${contractionDepth.toFixed(1)}%, Consolidation: ${consolidationDays} ngày`;
    if (breakoutReady) {
      description += '. SẴN SÀNG BREAKOUT!';
    }
  } else {
    description = 'Không phát hiện 3C pattern';
  }
  
  return {
    detected,
    phase,
    contractionDepth,
    consolidationDays,
    breakoutReady,
    description,
  };
}

// ═══════════════════════════════════════════════════
// CHART PATTERN DETECTION
// ═══════════════════════════════════════════════════

/**
 * Detect Cup & Handle Pattern (William O'Neil)
 * Cải thiện: Dùng 250 ngày để detect pattern dài hạn
 * Target = Đỉnh cốc + Chiều cao cốc
 * 
 * Thêm logic detect dựa trên đỉnh/đáy 52 tuần khi data không đủ
 */
function detectCupAndHandle(data: OHLCV[]): ChartPattern | null {
  // Cần ít nhất 50 data points
  if (data.length < 50) return null;
  
  const current = data[data.length - 1];
  
  // Tính đỉnh/đáy trong toàn bộ data
  const allHighs = data.map(d => d.high);
  const allLows = data.map(d => d.low);
  const highestHigh = Math.max(...allHighs);
  const lowestLow = Math.min(...allLows);
  
  // Tìm index của đỉnh và đáy
  const highIdx = allHighs.indexOf(highestHigh);
  const lowIdx = allLows.indexOf(lowestLow);
  
  // Cup & Handle pattern: Đáy phải nằm TRƯỚC đỉnh (cốc hình thành trước, rồi lên đỉnh)
  // Hoặc đỉnh ở đầu, đáy ở giữa, rồi lên lại gần đỉnh
  
  // Tính các metrics
  const cupDepth = (highestHigh - lowestLow) / highestHigh * 100;
  const distanceFromHigh = (highestHigh - current.close) / highestHigh * 100;
  const distanceFromLow = (current.close - lowestLow) / lowestLow * 100;
  
  // Điều kiện Cup & Handle:
  // 1. Cup depth >= 30% (cốc đủ sâu)
  // 2. Giá hiện tại gần đỉnh (< 20% từ đỉnh) - đang ở vùng tay cầm
  // 3. Đáy nằm ở giữa data (không phải đầu hoặc cuối)
  
  if (cupDepth < 30 || distanceFromHigh > 25) return null;
  
  // Kiểm tra đáy nằm ở giữa (không phải 20% đầu hoặc 20% cuối)
  const dataLen = data.length;
  if (lowIdx < dataLen * 0.15 || lowIdx > dataLen * 0.85) return null;
  
  // Kiểm tra tay cầm: 20 ngày gần nhất có pullback nhỏ
  const handleData = data.slice(-20);
  const handleHigh = Math.max(...handleData.map(d => d.high));
  const handleLow = Math.min(...handleData.map(d => d.low));
  const handleDepth = (handleHigh - handleLow) / handleHigh * 100;
  
  // Tay cầm phải nông (< 15%)
  if (handleDepth > 20) return null;
  
  // Calculate target = Đỉnh cốc + Chiều cao cốc (O'Neil method)
  const cupHeight = highestHigh - lowestLow;
  const pivotPoint = highestHigh;
  const targetPrice = pivotPoint + cupHeight;
  const stopLoss = handleLow * 0.95;
  
  // Confidence based on pattern quality
  let confidence = 60;
  if (cupDepth >= 40 && cupDepth <= 60) confidence += 15;
  else if (cupDepth >= 30) confidence += 10;
  if (handleDepth < 10) confidence += 10;
  if (distanceFromHigh < 10) confidence += 10;
  if (current.close > handleLow * 1.05) confidence += 5;
  
  // Tính upside
  const upside = ((targetPrice - current.close) / current.close * 100).toFixed(1);
  
  return {
    name: 'Cup & Handle',
    type: 'bullish',
    confidence: Math.min(confidence, 95),
    pivotPoint,
    targetPrice,
    stopLoss,
    description: `Cốc sâu ${cupDepth.toFixed(0)}%, tay cầm ${handleDepth.toFixed(0)}%. Pivot: ${(pivotPoint/1000).toFixed(1)}k → Target: ${(targetPrice/1000).toFixed(1)}k (+${upside}%)`,
    methodology: "William O'Neil",
  };
}

/**
 * Detect Double Bottom Pattern
 */
function detectDoubleBottom(data: OHLCV[]): ChartPattern | null {
  if (data.length < 40) return null;
  
  const recent = data.slice(-40);
  const current = recent[recent.length - 1];
  
  const swingLows = findSwingLows(recent, 3);
  const swingHighs = findSwingHighs(recent, 3);
  
  if (swingLows.length < 2 || swingHighs.length < 1) return null;
  
  // Find two bottoms at similar level
  const bottom1 = swingLows[0];
  const bottom2 = swingLows[swingLows.length - 1];
  
  // Bottoms should be at similar level (within 3%)
  const bottomDiff = Math.abs(bottom1.price - bottom2.price) / bottom1.price * 100;
  if (bottomDiff > 3) return null;
  
  // Find neckline (high between bottoms)
  const neckline = swingHighs.find(h => h.index > bottom1.index && h.index < bottom2.index);
  if (!neckline) return null;
  
  // Calculate pattern metrics
  const patternDepth = (neckline.price - Math.min(bottom1.price, bottom2.price)) / neckline.price * 100;
  if (patternDepth < 10 || patternDepth > 40) return null;
  
  const pivotPoint = neckline.price;
  const targetPrice = pivotPoint + (pivotPoint - Math.min(bottom1.price, bottom2.price));
  const stopLoss = Math.min(bottom1.price, bottom2.price) * 0.97;
  
  let confidence = 60;
  if (bottomDiff < 1.5) confidence += 15;
  if (patternDepth >= 15 && patternDepth <= 30) confidence += 10;
  if (current.close > pivotPoint * 0.95) confidence += 15;
  
  return {
    name: 'Double Bottom',
    type: 'bullish',
    confidence: Math.min(confidence, 95),
    pivotPoint,
    targetPrice,
    stopLoss,
    description: `W Pattern với 2 đáy tại ${Math.min(bottom1.price, bottom2.price).toLocaleString('vi-VN')}. Neckline: ${pivotPoint.toLocaleString('vi-VN')}, Target: ${targetPrice.toLocaleString('vi-VN')}`,
    methodology: 'Classic Technical Analysis',
  };
}

/**
 * Detect Ascending Triangle
 */
function detectAscendingTriangle(data: OHLCV[]): ChartPattern | null {
  if (data.length < 30) return null;
  
  const recent = data.slice(-30);
  const current = recent[recent.length - 1];
  
  const swingHighs = findSwingHighs(recent, 3);
  const swingLows = findSwingLows(recent, 3);
  
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  
  // Check flat resistance (highs at similar level)
  const highPrices = swingHighs.map(h => h.price);
  const avgHigh = highPrices.reduce((a, b) => a + b, 0) / highPrices.length;
  const highVariance = highPrices.reduce((sum, h) => sum + Math.abs(h - avgHigh) / avgHigh * 100, 0) / highPrices.length;
  
  if (highVariance > 2) return null; // Resistance not flat enough
  
  // Check rising lows
  const lowPrices = swingLows.map(l => l.price);
  let risingLows = true;
  for (let i = 1; i < lowPrices.length; i++) {
    if (lowPrices[i] <= lowPrices[i - 1]) {
      risingLows = false;
      break;
    }
  }
  
  if (!risingLows) return null;
  
  const pivotPoint = avgHigh;
  const patternHeight = avgHigh - lowPrices[0];
  const targetPrice = pivotPoint + patternHeight;
  const stopLoss = lowPrices[lowPrices.length - 1] * 0.97;
  
  let confidence = 65;
  if (highVariance < 1) confidence += 10;
  if (swingHighs.length >= 3) confidence += 10;
  if (current.close > pivotPoint * 0.97) confidence += 15;
  
  return {
    name: 'Ascending Triangle',
    type: 'bullish',
    confidence: Math.min(confidence, 95),
    pivotPoint,
    targetPrice,
    stopLoss,
    description: `Tam giác tăng với kháng cự phẳng tại ${pivotPoint.toLocaleString('vi-VN')}. Target: ${targetPrice.toLocaleString('vi-VN')}`,
    methodology: 'Classic Technical Analysis',
  };
}

/**
 * Detect Bull Flag Pattern
 */
function detectBullFlag(data: OHLCV[]): ChartPattern | null {
  if (data.length < 30) return null;
  
  const recent = data.slice(-30);
  const current = recent[recent.length - 1];
  
  // Find flagpole (strong upward move)
  let poleStart = 0;
  let poleEnd = 0;
  let maxGain = 0;
  
  for (let i = 0; i < recent.length - 10; i++) {
    for (let j = i + 5; j < recent.length - 5; j++) {
      const gain = (recent[j].high - recent[i].low) / recent[i].low * 100;
      if (gain > maxGain && gain >= 15) {
        maxGain = gain;
        poleStart = i;
        poleEnd = j;
      }
    }
  }
  
  if (maxGain < 15) return null;
  
  // Check flag (consolidation after pole)
  const flagData = recent.slice(poleEnd);
  if (flagData.length < 5) return null;
  
  const flagHigh = Math.max(...flagData.map(d => d.high));
  const flagLow = Math.min(...flagData.map(d => d.low));
  const flagRange = (flagHigh - flagLow) / flagHigh * 100;
  
  // Flag should be tight (< 10% range) and slightly downward
  if (flagRange > 12) return null;
  
  const poleHeight = recent[poleEnd].high - recent[poleStart].low;
  const pivotPoint = flagHigh;
  const targetPrice = pivotPoint + poleHeight;
  const stopLoss = flagLow * 0.97;
  
  let confidence = 60;
  if (maxGain >= 20) confidence += 10;
  if (flagRange < 8) confidence += 10;
  if (flagData.length >= 5 && flagData.length <= 15) confidence += 10;
  if (current.close > pivotPoint * 0.97) confidence += 10;
  
  return {
    name: 'Bull Flag',
    type: 'bullish',
    confidence: Math.min(confidence, 95),
    pivotPoint,
    targetPrice,
    stopLoss,
    description: `Cờ tăng với cột cờ ${maxGain.toFixed(1)}%. Pivot: ${pivotPoint.toLocaleString('vi-VN')}, Target: ${targetPrice.toLocaleString('vi-VN')}`,
    methodology: 'Classic Technical Analysis',
  };
}



// ═══════════════════════════════════════════════════
// HEAD & SHOULDERS PATTERN (Bearish Reversal)
// ═══════════════════════════════════════════════════

/**
 * Detect Head & Shoulders Pattern (Bearish)
 * Also detects Inverse Head & Shoulders (Bullish)
 */
function detectHeadAndShoulders(data: OHLCV[]): ChartPattern | null {
  if (data.length < 50) return null;
  
  const recent = data.slice(-50);
  const current = recent[recent.length - 1];
  
  const swingHighs = findSwingHighs(recent, 4);
  const swingLows = findSwingLows(recent, 4);
  
  // Need at least 3 highs for H&S
  if (swingHighs.length < 3 || swingLows.length < 2) return null;
  
  // Try to find H&S pattern (bearish)
  for (let i = 0; i < swingHighs.length - 2; i++) {
    const leftShoulder = swingHighs[i];
    const head = swingHighs[i + 1];
    const rightShoulder = swingHighs[i + 2];
    
    // Head must be higher than both shoulders
    if (head.price <= leftShoulder.price || head.price <= rightShoulder.price) continue;
    
    // Shoulders should be at similar level (within 5%)
    const shoulderDiff = Math.abs(leftShoulder.price - rightShoulder.price) / leftShoulder.price * 100;
    if (shoulderDiff > 5) continue;
    
    // Find neckline (lows between shoulders)
    const necklineLows = swingLows.filter(l => 
      l.index > leftShoulder.index && l.index < rightShoulder.index
    );
    if (necklineLows.length < 1) continue;
    
    const neckline = necklineLows.reduce((sum, l) => sum + l.price, 0) / necklineLows.length;
    const patternHeight = head.price - neckline;
    
    // Pattern should have meaningful height (> 10%)
    if (patternHeight / neckline * 100 < 10) continue;
    
    const pivotPoint = neckline;
    const targetPrice = neckline - patternHeight; // Bearish target
    const stopLoss = head.price * 1.02;
    
    let confidence = 60;
    if (shoulderDiff < 3) confidence += 10;
    if (current.close < neckline) confidence += 15; // Already breaking down
    if (rightShoulder.index > recent.length - 10) confidence += 10; // Recent pattern
    
    return {
      name: 'Head & Shoulders',
      type: 'bearish',
      confidence: Math.min(confidence, 95),
      pivotPoint,
      targetPrice,
      stopLoss,
      description: `⚠️ H&S Pattern - Neckline: ${neckline.toLocaleString('vi-VN')}. Nếu breakdown, target: ${targetPrice.toLocaleString('vi-VN')}`,
      methodology: 'Classic Technical Analysis',
    };
  }
  
  // Try to find Inverse H&S (bullish)
  if (swingLows.length >= 3) {
    for (let i = 0; i < swingLows.length - 2; i++) {
      const leftShoulder = swingLows[i];
      const head = swingLows[i + 1];
      const rightShoulder = swingLows[i + 2];
      
      // Head must be lower than both shoulders
      if (head.price >= leftShoulder.price || head.price >= rightShoulder.price) continue;
      
      // Shoulders should be at similar level
      const shoulderDiff = Math.abs(leftShoulder.price - rightShoulder.price) / leftShoulder.price * 100;
      if (shoulderDiff > 5) continue;
      
      // Find neckline (highs between shoulders)
      const necklineHighs = swingHighs.filter(h => 
        h.index > leftShoulder.index && h.index < rightShoulder.index
      );
      if (necklineHighs.length < 1) continue;
      
      const neckline = necklineHighs.reduce((sum, h) => sum + h.price, 0) / necklineHighs.length;
      const patternHeight = neckline - head.price;
      
      if (patternHeight / head.price * 100 < 10) continue;
      
      const pivotPoint = neckline;
      const targetPrice = neckline + patternHeight; // Bullish target
      const stopLoss = head.price * 0.97;
      
      let confidence = 60;
      if (shoulderDiff < 3) confidence += 10;
      if (current.close > neckline * 0.98) confidence += 15;
      if (rightShoulder.index > recent.length - 10) confidence += 10;
      
      return {
        name: 'Inverse Head & Shoulders',
        type: 'bullish',
        confidence: Math.min(confidence, 95),
        pivotPoint,
        targetPrice,
        stopLoss,
        description: `🎯 Inverse H&S - Neckline: ${neckline.toLocaleString('vi-VN')}. Nếu breakout, target: ${targetPrice.toLocaleString('vi-VN')}`,
        methodology: 'Classic Technical Analysis',
      };
    }
  }
  
  return null;
}

// ═══════════════════════════════════════════════════
// FIBONACCI EXTENSION (For ATH Breakout)
// ═══════════════════════════════════════════════════

/**
 * Calculate Fibonacci Extension for ATH breakout stocks
 * Khi CP vượt đỉnh mọi thời đại, không có kháng cự lịch sử
 * → Dùng Fibonacci Extension để xác định target
 * 
 * Fibonacci Extension levels: 1.272, 1.414, 1.618, 2.0, 2.618
 */
export function calculateFibonacciExtension(data: OHLCV[]): FibonacciExtension {
  if (data.length < 50) {
    return {
      isATHBreakout: false,
      currentPrice: 0,
      ath: 0,
      extensions: [],
      nearestTarget: 0,
      description: 'Không đủ dữ liệu',
    };
  }
  
  const current = data[data.length - 1];
  const currentPrice = current.close;
  
  // Find ATH (All-Time High)
  let ath = 0;
  let athIndex = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i].high > ath) {
      ath = data[i].high;
      athIndex = i;
    }
  }
  
  // Check if current price is at or above ATH (within 2%)
  const isATHBreakout = currentPrice >= ath * 0.98;
  
  if (!isATHBreakout) {
    const distanceFromATH = ((ath - currentPrice) / ath * 100).toFixed(1);
    return {
      isATHBreakout: false,
      currentPrice,
      ath,
      extensions: [],
      nearestTarget: ath,
      description: `Cách ATH ${distanceFromATH}%. Target gần nhất: ATH ${ath.toLocaleString('vi-VN')}`,
    };
  }
  
  // Find the swing low before ATH (for Fibonacci calculation)
  // Look back from ATH to find significant low
  let swingLow = ath;
  let swingLowIndex = athIndex;
  
  // Find lowest point in the 60 sessions before ATH
  const lookbackStart = Math.max(0, athIndex - 60);
  for (let i = lookbackStart; i < athIndex; i++) {
    if (data[i].low < swingLow) {
      swingLow = data[i].low;
      swingLowIndex = i;
    }
  }
  
  // If swing low is too close to ATH, look further back
  if ((ath - swingLow) / swingLow * 100 < 10) {
    const extendedLookback = Math.max(0, athIndex - 120);
    for (let i = extendedLookback; i < athIndex; i++) {
      if (data[i].low < swingLow) {
        swingLow = data[i].low;
        swingLowIndex = i;
      }
    }
  }
  
  // Calculate Fibonacci Extension levels
  const range = ath - swingLow;
  
  const fibLevels = [
    { ratio: 1.272, name: 'Fib 127.2%' },
    { ratio: 1.414, name: 'Fib 141.4%' },
    { ratio: 1.618, name: 'Fib 161.8% (Golden)' },
    { ratio: 2.0, name: 'Fib 200%' },
    { ratio: 2.618, name: 'Fib 261.8%' },
  ];
  
  const extensions = fibLevels.map(fib => {
    const price = swingLow + range * fib.ratio;
    const upside = ((price - currentPrice) / currentPrice * 100).toFixed(1);
    return {
      level: fib.name,
      price: Math.round(price),
      description: `${fib.name}: ${price.toLocaleString('vi-VN')} (+${upside}%)`,
    };
  });
  
  // Find nearest target above current price
  const nearestTarget = extensions.find(e => e.price > currentPrice)?.price || extensions[0].price;
  
  // Build description
  const upsideToNearest = ((nearestTarget - currentPrice) / currentPrice * 100).toFixed(1);
  const description = `🏆 ATH BREAKOUT! Swing: ${swingLow.toLocaleString('vi-VN')} → ATH: ${ath.toLocaleString('vi-VN')}
Target gần nhất: ${nearestTarget.toLocaleString('vi-VN')} (+${upsideToNearest}%)
${extensions.map(e => `• ${e.description}`).join('\n')}`;
  
  return {
    isATHBreakout,
    currentPrice,
    ath,
    extensions,
    nearestTarget,
    description,
  };
}

// ═══════════════════════════════════════════════════
// POCKET PIVOT (Chris Kacher)
// ═══════════════════════════════════════════════════

interface PocketPivotResult {
  detected: boolean;
  date: string;
  price: number;
  volumeRatio: number;
  description: string;
}

/**
 * Detect Pocket Pivot - Chris Kacher
 * 
 * Criteria:
 * 1. Volume hôm nay > Volume cao nhất của các phiên giảm trong 10 ngày
 * 2. Giá đóng cửa tăng so với hôm trước
 * 3. Giá đóng cửa gần high của ngày (> 50% range)
 * 4. Giá trên MA50 hoặc đang hồi về MA50
 */
function detectPocketPivot(data: OHLCV[]): PocketPivotResult {
  if (data.length < 15) {
    return { detected: false, date: '', price: 0, volumeRatio: 0, description: 'Không đủ dữ liệu' };
  }
  
  const recent = data.slice(-15);
  const today = recent[recent.length - 1];
  const yesterday = recent[recent.length - 2];
  
  // Check if today is an up day
  if (today.close <= yesterday.close) {
    return { detected: false, date: '', price: 0, volumeRatio: 0, description: 'Không phải phiên tăng' };
  }
  
  // Find highest volume of down days in last 10 days
  const last10 = recent.slice(-11, -1); // Exclude today
  let maxDownVolume = 0;
  
  for (let i = 1; i < last10.length; i++) {
    if (last10[i].close < last10[i - 1].close) {
      maxDownVolume = Math.max(maxDownVolume, last10[i].volume);
    }
  }
  
  // Pocket Pivot: Today's volume > max down volume
  if (today.volume <= maxDownVolume) {
    return { detected: false, date: '', price: 0, volumeRatio: 0, description: 'Volume chưa đủ mạnh' };
  }
  
  // Check close position (should be in upper half of range)
  const range = today.high - today.low;
  const closePosition = range > 0 ? (today.close - today.low) / range : 0;
  
  if (closePosition < 0.5) {
    return { detected: false, date: '', price: 0, volumeRatio: 0, description: 'Giá đóng cửa không đủ mạnh' };
  }
  
  // Calculate MA50
  const ma50 = data.length >= 50 ? calculateSMA(data, 50) : 0;
  const nearMA50 = ma50 > 0 && today.close >= ma50 * 0.95;
  
  const volumeRatio = maxDownVolume > 0 ? today.volume / maxDownVolume : 0;
  
  return {
    detected: true,
    date: today.date,
    price: today.close,
    volumeRatio,
    description: `🎯 POCKET PIVOT! Volume ${volumeRatio.toFixed(1)}x so với phiên giảm mạnh nhất. ${nearMA50 ? 'Gần MA50 - Điểm mua tốt!' : ''}`,
  };
}

// ═══════════════════════════════════════════════════
// STAGE ANALYSIS (Mark Minervini)
// ═══════════════════════════════════════════════════

interface StageAnalysis {
  stage: 1 | 2 | 3 | 4;
  stageName: string;
  description: string;
  tradeable: boolean;
}

/**
 * Determine stock stage based on Mark Minervini's Stage Analysis
 * 
 * Stage 1: Accumulation (Tích lũy) - Sideway sau downtrend
 * Stage 2: Advancing (Tăng giá) - Uptrend, TRADEABLE
 * Stage 3: Distribution (Phân phối) - Sideway sau uptrend
 * Stage 4: Declining (Giảm giá) - Downtrend
 */
function analyzeStage(data: OHLCV[]): StageAnalysis {
  if (data.length < 200) {
    return { stage: 1, stageName: 'Không xác định', description: 'Không đủ dữ liệu', tradeable: false };
  }
  
  const current = data[data.length - 1];
  const ma50 = calculateSMA(data, 50);
  const ma150 = calculateSMA(data, 150);
  const ma200 = calculateSMA(data, 200);
  
  // Calculate MA trends
  const ma50_30dAgo = calculateSMA(data.slice(0, -30), 50);
  const ma200_30dAgo = calculateSMA(data.slice(0, -30), 200);
  
  const ma50Rising = ma50 > ma50_30dAgo;
  const ma200Rising = ma200 > ma200_30dAgo;
  
  // Find 52-week high/low
  const last252 = data.slice(-252);
  const high52W = Math.max(...last252.map(d => d.high));
  const low52W = Math.min(...last252.map(d => d.low));
  
  const distFromHigh = (high52W - current.close) / high52W * 100;
  const distFromLow = (current.close - low52W) / low52W * 100;
  
  // Stage 2 criteria (Mark Minervini's template)
  const stage2Criteria = {
    priceAboveMA150: current.close > ma150,
    priceAboveMA200: current.close > ma200,
    ma150AboveMA200: ma150 > ma200,
    ma50AboveMA150: ma50 > ma150,
    ma50Rising: ma50Rising,
    ma200Rising: ma200Rising,
    within25OfHigh: distFromHigh <= 25,
    above30FromLow: distFromLow >= 30,
  };
  
  const stage2Score = Object.values(stage2Criteria).filter(Boolean).length;
  
  // Determine stage
  if (stage2Score >= 6) {
    return {
      stage: 2,
      stageName: 'Stage 2 - Advancing',
      description: `🟢 STAGE 2 (${stage2Score}/8 criteria): Cổ phiếu trong giai đoạn TĂNG GIÁ. Đây là giai đoạn TỐT NHẤT để giao dịch theo Minervini.`,
      tradeable: true,
    };
  }
  
  if (current.close < ma200 && !ma200Rising && distFromHigh > 30) {
    return {
      stage: 4,
      stageName: 'Stage 4 - Declining',
      description: `🔴 STAGE 4: Cổ phiếu trong giai đoạn GIẢM GIÁ. KHÔNG NÊN MUA, chờ tạo đáy và chuyển sang Stage 1.`,
      tradeable: false,
    };
  }
  
  if (current.close < ma200 && distFromLow < 20) {
    return {
      stage: 1,
      stageName: 'Stage 1 - Accumulation',
      description: `🟡 STAGE 1: Cổ phiếu đang TÍCH LŨY sau downtrend. Chờ breakout lên trên MA200 để xác nhận chuyển Stage 2.`,
      tradeable: false,
    };
  }
  
  // Stage 3: Price above MA200 but MA50 starting to flatten/decline
  if (current.close > ma200 && !ma50Rising && distFromHigh < 15) {
    return {
      stage: 3,
      stageName: 'Stage 3 - Distribution',
      description: `🟠 STAGE 3: Cổ phiếu có thể đang PHÂN PHỐI. Cẩn thận, có thể chuyển sang Stage 4. Nên bảo vệ lợi nhuận.`,
      tradeable: false,
    };
  }
  
  // Default to Stage 1 if unclear
  return {
    stage: 1,
    stageName: 'Stage 1/2 - Chuyển tiếp',
    description: `🟡 Cổ phiếu đang trong giai đoạn chuyển tiếp. Theo dõi thêm để xác định xu hướng.`,
    tradeable: false,
  };
}

// ═══════════════════════════════════════════════════
// MAIN PATTERN DETECTION FUNCTION
// ═══════════════════════════════════════════════════

/**
 * Detect all chart patterns and return comprehensive analysis
 */
export function detectAllPatterns(data: OHLCV[]): PatternAnalysisResult {
  const patterns: ChartPattern[] = [];
  
  // Detect patterns on DAILY data
  const cupHandleDaily = detectCupAndHandle(data);
  if (cupHandleDaily) patterns.push(cupHandleDaily);
  
  // Detect patterns on WEEKLY data (for long-term patterns like Cup & Handle)
  const weeklyData = convertToWeekly(data);
  if (weeklyData.length >= 50) {
    const cupHandleWeekly = detectCupAndHandle(weeklyData);
    if (cupHandleWeekly) {
      // Đánh dấu là pattern tuần và tăng confidence
      cupHandleWeekly.name = 'Cup & Handle (Tuần)';
      cupHandleWeekly.confidence = Math.min(cupHandleWeekly.confidence + 10, 95);
      patterns.push(cupHandleWeekly);
    }
  }
  
  const doubleBottom = detectDoubleBottom(data);
  if (doubleBottom) patterns.push(doubleBottom);
  
  const ascTriangle = detectAscendingTriangle(data);
  if (ascTriangle) patterns.push(ascTriangle);
  
  const bullFlag = detectBullFlag(data);
  if (bullFlag) patterns.push(bullFlag);
  
  const headShoulders = detectHeadAndShoulders(data);
  if (headShoulders) patterns.push(headShoulders);
  
  // VCP Analysis
  const vcp = detectVCP(data);
  
  // 3C Pattern
  const threeC = detect3CPattern(data);
  
  // Fibonacci Extension (for ATH breakout)
  const fibonacci = calculateFibonacciExtension(data);
  
  // Pocket Pivot
  const pocketPivot = detectPocketPivot(data);
  
  // Stage Analysis
  const stage = analyzeStage(data);
  
  // Sort patterns by confidence
  patterns.sort((a, b) => b.confidence - a.confidence);
  
  // Calculate primary and secondary targets
  let primaryTarget = 0;
  let secondaryTarget = 0;
  let stopLoss = 0;
  
  // Priority: Fibonacci (ATH) > VCP > Best Pattern
  if (fibonacci.isATHBreakout && fibonacci.nearestTarget > 0) {
    primaryTarget = fibonacci.nearestTarget;
    secondaryTarget = fibonacci.extensions[1]?.price || primaryTarget * 1.1;
  } else if (vcp.isVCP && vcp.pivotPoint > 0) {
    const current = data[data.length - 1].close;
    primaryTarget = vcp.pivotPoint * 1.15; // 15% above pivot
    secondaryTarget = vcp.pivotPoint * 1.25; // 25% above pivot
    stopLoss = vcp.pivotPoint * 0.93; // 7% below pivot
  } else if (patterns.length > 0) {
    primaryTarget = patterns[0].targetPrice;
    secondaryTarget = patterns[1]?.targetPrice || primaryTarget * 1.1;
    stopLoss = patterns[0].stopLoss;
  }
  
  // Calculate risk/reward
  const current = data[data.length - 1].close;
  const reward = primaryTarget > 0 ? (primaryTarget - current) / current * 100 : 0;
  const risk = stopLoss > 0 ? (current - stopLoss) / current * 100 : 5; // Default 5% risk
  const riskReward = risk > 0 ? reward / risk : 0;
  
  // Build summary - NGẮN GỌN, SÚC TÍCH
  const summaryParts: string[] = [];
  
  // Stage - chỉ 1 dòng
  summaryParts.push(stage.description);
  
  // Patterns - chỉ hiển thị pattern quan trọng nhất với target
  if (patterns.length > 0) {
    const bestPattern = patterns[0];
    const upside = ((bestPattern.targetPrice - current) / current * 100).toFixed(1);
    summaryParts.push(`🎯 **${bestPattern.name}** (${bestPattern.confidence}%): ${bestPattern.description}`);
  }
  
  // VCP - ngắn gọn
  if (vcp.isVCP && vcp.stage !== 'none') {
    const vcpStatus = vcp.stage === 'breakout' ? '🚀 BREAKOUT!' : vcp.stage === 'ready' ? '⚡ Sẵn sàng breakout' : '📊 Đang hình thành';
    summaryParts.push(`${vcpStatus} VCP ${vcp.contractions} contractions, pivot ${(vcp.pivotPoint/1000).toFixed(1)}k`);
  }
  
  // 3C - ngắn gọn
  if (threeC.detected && threeC.breakoutReady) {
    summaryParts.push(`⚡ 3C Pattern sẵn sàng breakout`);
  }
  
  // Fibonacci ATH - ngắn gọn
  if (fibonacci.isATHBreakout && fibonacci.nearestTarget > 0) {
    const upside = ((fibonacci.nearestTarget - current) / current * 100).toFixed(1);
    summaryParts.push(`🚀 ATH Breakout → Target Fib: ${(fibonacci.nearestTarget/1000).toFixed(1)}k (+${upside}%)`);
  }
  
  // Multi-timeframe - chỉ hiển thị nếu có tín hiệu quan trọng
  const multiTimeframe = analyzeMultiTimeframe(data);
  if (multiTimeframe.alignment === 'strong_bullish' || multiTimeframe.alignment === 'strong_bearish' || multiTimeframe.explosivePotential) {
    summaryParts.push(multiTimeframe.description);
  } else {
    // Chỉ hiển thị chart ngày/tuần ngắn gọn
    summaryParts.push(multiTimeframe.description);
  }
  
  return {
    patterns,
    vcp,
    threeC,
    fibonacci,
    multiTimeframe,
    primaryTarget,
    secondaryTarget,
    stopLoss,
    riskReward,
    summary: summaryParts.join('\n'),
  };
}

// ═══════════════════════════════════════════════════
// FORMAT PATTERN ANALYSIS FOR REPORT
// ═══════════════════════════════════════════════════

/**
 * Format pattern analysis result for inclusion in stock report
 */
export function formatPatternAnalysis(result: PatternAnalysisResult): string {
  if (!result) return '';
  
  // Check if there's anything meaningful to show
  const hasPatterns = result.patterns.length > 0;
  const hasVCP = result.vcp.isVCP;
  const has3C = result.threeC.detected;
  const hasFib = result.fibonacci.isATHBreakout;
  const hasMultiTF = result.multiTimeframe && (
    result.multiTimeframe.explosivePotential ||
    result.multiTimeframe.alignment === 'strong_bullish' ||
    result.multiTimeframe.alignment === 'strong_bearish' ||
    result.multiTimeframe.daily.maCrossovers.length > 0 ||
    result.multiTimeframe.weekly.maCrossovers.length > 0
  );
  
  if (!hasPatterns && !hasVCP && !has3C && !hasFib && !hasMultiTF) {
    return '';
  }
  
  let output = '\n\n═══ 📐 PHÂN TÍCH MÔ HÌNH (O\'Neil, Minervini, Kacher) ═══\n';
  output += result.summary;
  
  return output;
}

// Export all functions
export {
  detectCupAndHandle,
  detectDoubleBottom,
  detectAscendingTriangle,
  detectBullFlag,
  detectHeadAndShoulders,
  detectPocketPivot,
  analyzeStage,
};
