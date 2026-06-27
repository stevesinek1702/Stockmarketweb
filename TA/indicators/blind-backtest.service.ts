/**
 * Blind Backtest Service — Bot tu hoc tu du lieu lich su (no future data leakage)
 * Pipeline: OHLCV Data → Cutoff Selection → Indicator Snapshot → Pattern Recording
 *           → Verification → Pattern Discovery (Gemini AI) → Rule Generation
 * Chay daily 17:30 VN (T2-T6), rotating 5 batches/week
 * Ho tro manual API trigger cho admin
 */

import { eq, desc, and, sql } from 'drizzle-orm';
import { getDatabase } from '../../infrastructure/database/connection.js';
import {
  blindBacktestRuns,
  blindBacktestSessions,
  blindBacktestPatterns,
  strategyRules,
  type NewBlindBacktestRun,
  type NewBlindBacktestSession,
  type NewBlindBacktestPattern,
} from '../../infrastructure/database/schema.js';
import {
  fetchHistoricalPrices,
  calcSMA,
  calcEMA,
  calcRSI,
  calcMACDHistogram,
  calcVolumeRatio,
} from './historical-backtester.service.js';
import { addToPool } from './strategy-pool.service.js';
import { getStockCluster } from './stock-cluster.service.js';
import { getAI } from '../../infrastructure/ai/providers/gemini/geminiConfig.js';
import type {
  PriceData,
  IndicatorSnapshot,
  EnrichedSnapshot,
  SignalEvent,
  SignalEventType,
  CutoffPoint,
  VerificationResult,
  BollingerBandsResult,
  DMIResult,
  PatternCondition,
  BlindBacktestRunRecord,
  BlindBacktestSessionRecord,
  DiscoveredPatternRecord,
  BlindBacktestSummary,
  SelfTuningConfig,
  ClusterType,
} from './strategy-tracker.types.js';

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════

const MAX_CUTOFFS_PER_SYMBOL = 5;
const MAX_RULES_PER_RUN = 3;
const BATCH_SIZE = 5;
const API_DELAY_MS = 1000;
const RUN_TIMEOUT_MS = 20 * 60 * 1000; // 20 phut
const ADMIN_UID = '7307295734920277074';
const GEMINI_MODEL = 'gemini-2.0-flash';

// Danh sach CP thanh khoan cao de blind backtest (giong historical-backtester)
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

// ═══════════════════════════════════════════════════
// TASK 4.1: NEW INDICATOR FUNCTIONS
// ═══════════════════════════════════════════════════

/**
 * Tinh Bollinger Bands (default: 20-period, 2 standard deviations)
 * middle = SMA(period), upper = middle + mult*stddev, lower = middle - mult*stddev
 * bandwidth = (upper - lower) / middle
 */
export function calcBollingerBands(
  closes: number[],
  period: number = 20,
  stddevMult: number = 2,
): BollingerBandsResult {
  const middle = calcSMA(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1 || middle[i] === 0) {
      upper.push(0);
      lower.push(0);
      bandwidth.push(0);
      continue;
    }

    // Tinh standard deviation
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += (closes[j] - middle[i]) ** 2;
    }
    const stddev = Math.sqrt(sumSq / period);

    const u = middle[i] + stddevMult * stddev;
    const l = middle[i] - stddevMult * stddev;
    upper.push(u);
    lower.push(l);
    bandwidth.push(middle[i] > 0 ? (u - l) / middle[i] : 0);
  }

  return { upper, middle, lower, bandwidth };
}

/**
 * Tinh ADX (Average Directional Index)
 * Buoc: +DM, -DM, TR → smooth → +DI, -DI → DX → ADX (EMA cua DX)
 */
export function calcADX(data: PriceData[], period: number = 14): number[] {
  const len = data.length;
  if (len < period + 1) return new Array(len).fill(0);

  // Buoc 1: Tinh +DM, -DM, TR cho tung ngay
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [0];

  for (let i = 1; i < len; i++) {
    const highDiff = data[i].high - data[i - 1].high;
    const lowDiff = data[i - 1].low - data[i].low;

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    const trVal = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low - data[i - 1].close),
    );
    tr.push(trVal);
  }

  // Buoc 2: Smooth bang Wilder's method (sum period dau, roi smoothing)
  const result: number[] = new Array(len).fill(0);

  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  let smoothTR = 0;

  // Sum period dau tien
  for (let i = 1; i <= period; i++) {
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
    smoothTR += tr[i];
  }

  // Tinh DX cho cac ngay tiep theo
  const dxValues: number[] = [];

  for (let i = period; i < len; i++) {
    if (i > period) {
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
      smoothTR = smoothTR - smoothTR / period + tr[i];
    }

    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  // Buoc 3: ADX = EMA cua DX (Wilder's smoothing)
  if (dxValues.length < period) return result;

  // ADX dau tien = trung binh period DX dau
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxValues[i];
  adx /= period;
  result[period * 2 - 1] = Math.min(100, Math.max(0, adx));

  // Smooth ADX
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
    const idx = i + period;
    if (idx < len) {
      result[idx] = Math.min(100, Math.max(0, adx));
    }
  }

  return result;
}

/**
 * Tinh DMI (Directional Movement Index) — tra ve +DI va -DI arrays
 */
export function calcDMI(data: PriceData[], period: number = 14): DMIResult {
  const len = data.length;
  const plusDIArr: number[] = new Array(len).fill(0);
  const minusDIArr: number[] = new Array(len).fill(0);

  if (len < period + 1) return { plusDI: plusDIArr, minusDI: minusDIArr };

  // Tinh +DM, -DM, TR
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [0];

  for (let i = 1; i < len; i++) {
    const highDiff = data[i].high - data[i - 1].high;
    const lowDiff = data[i - 1].low - data[i].low;

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    const trVal = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low - data[i - 1].close),
    );
    tr.push(trVal);
  }

  // Smooth bang Wilder's method
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  let smoothTR = 0;

  for (let i = 1; i <= period; i++) {
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
    smoothTR += tr[i];
  }

  for (let i = period; i < len; i++) {
    if (i > period) {
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
      smoothTR = smoothTR - smoothTR / period + tr[i];
    }

    plusDIArr[i] = smoothTR > 0 ? Math.min(100, Math.max(0, (smoothPlusDM / smoothTR) * 100)) : 0;
    minusDIArr[i] = smoothTR > 0 ? Math.min(100, Math.max(0, (smoothMinusDM / smoothTR) * 100)) : 0;
  }

  return { plusDI: plusDIArr, minusDI: minusDIArr };
}


// ═══════════════════════════════════════════════════
// TASK 5.1: COMPUTE INDICATOR SNAPSHOT
// ═══════════════════════════════════════════════════

/**
 * Tinh toan indicator snapshot tai cutoff point
 * Chi dung truncated data (KHONG co future data) — dam bao no leakage
 * Tra ve 19 fields indicator
 */
function computeIndicatorSnapshot(
  truncatedData: PriceData[],
  cutoffIndex: number,
): IndicatorSnapshot {
  const closes = truncatedData.map(d => d.close);
  const volumes = truncatedData.map(d => d.volume);
  const closePrice = closes[cutoffIndex];

  // RSI(14)
  let rsi: number | null = null;
  if (cutoffIndex >= 14) {
    const rsiArr = calcRSI(closes.slice(0, cutoffIndex + 1), 14);
    rsi = rsiArr[rsiArr.length - 1];
    if (rsi === 50 && cutoffIndex < 15) rsi = null; // default value = khong du data
  }

  // MACD(12,26,9)
  let macd_line: number | null = null;
  let macd_signal: number | null = null;
  let macd_histogram: number | null = null;
  if (cutoffIndex >= 33) { // Can it nhat 26 + 9 - 1 = 34 ngay
    const slicedCloses = closes.slice(0, cutoffIndex + 1);
    const ema12 = calcEMA(slicedCloses, 12);
    const ema26 = calcEMA(slicedCloses, 26);
    const macdLineArr: number[] = [];
    for (let i = 0; i < slicedCloses.length; i++) {
      macdLineArr.push(ema12[i] - ema26[i]);
    }
    const signalLineArr = calcEMA(macdLineArr, 9);
    macd_line = macdLineArr[macdLineArr.length - 1];
    macd_signal = signalLineArr[signalLineArr.length - 1];
    macd_histogram = macd_line - macd_signal;
  }

  // MA10, MA20, MA50
  const ma10 = cutoffIndex >= 9 ? calcSMA(closes.slice(0, cutoffIndex + 1), 10).pop() ?? null : null;
  const ma20 = cutoffIndex >= 19 ? calcSMA(closes.slice(0, cutoffIndex + 1), 20).pop() ?? null : null;
  const ma50 = cutoffIndex >= 49 ? calcSMA(closes.slice(0, cutoffIndex + 1), 50).pop() ?? null : null;

  // Bollinger Bands(20, 2)
  let bb_upper: number | null = null;
  let bb_middle: number | null = null;
  let bb_lower: number | null = null;
  let bb_bandwidth: number | null = null;
  if (cutoffIndex >= 19) {
    const bb = calcBollingerBands(closes.slice(0, cutoffIndex + 1), 20, 2);
    bb_upper = bb.upper[bb.upper.length - 1];
    bb_middle = bb.middle[bb.middle.length - 1];
    bb_lower = bb.lower[bb.lower.length - 1];
    bb_bandwidth = bb.bandwidth[bb.bandwidth.length - 1];
  }

  // ADX(14) va DMI(+DI, -DI)
  let adx: number | null = null;
  let plus_di: number | null = null;
  let minus_di: number | null = null;
  if (cutoffIndex >= 27) { // Can 2*period - 1 = 27 ngay cho ADX
    const slicedData = truncatedData.slice(0, cutoffIndex + 1);
    const adxArr = calcADX(slicedData, 14);
    adx = adxArr[adxArr.length - 1];
    const dmi = calcDMI(slicedData, 14);
    plus_di = dmi.plusDI[dmi.plusDI.length - 1];
    minus_di = dmi.minusDI[dmi.minusDI.length - 1];
  }

  // Volume ratio (current / avg 20 ngay)
  let volume_ratio: number | null = null;
  if (cutoffIndex >= 20) {
    volume_ratio = calcVolumeRatio(volumes, cutoffIndex);
  }

  // Close vs MA percentages
  const close_vs_ma10_pct = ma10 && ma10 > 0 ? ((closePrice - ma10) / ma10) * 100 : null;
  const close_vs_ma20_pct = ma20 && ma20 > 0 ? ((closePrice - ma20) / ma20) * 100 : null;
  const close_vs_ma50_pct = ma50 && ma50 > 0 ? ((closePrice - ma50) / ma50) * 100 : null;

  return {
    rsi,
    macd_line,
    macd_signal,
    macd_histogram,
    ma10,
    ma20,
    ma50,
    bb_upper,
    bb_middle,
    bb_lower,
    bb_bandwidth,
    adx,
    plus_di,
    minus_di,
    volume_ratio,
    close_price: closePrice,
    close_vs_ma10_pct: close_vs_ma10_pct !== null ? Math.round(close_vs_ma10_pct * 100) / 100 : null,
    close_vs_ma20_pct: close_vs_ma20_pct !== null ? Math.round(close_vs_ma20_pct * 100) / 100 : null,
    close_vs_ma50_pct: close_vs_ma50_pct !== null ? Math.round(close_vs_ma50_pct * 100) / 100 : null,
  };
}


// ═══════════════════════════════════════════════════
// TASK 5.2: FIND SIGNAL EVENTS + SELECT CUTOFF POINTS
// ═══════════════════════════════════════════════════

/**
 * Scan du lieu de tim 5 loai Signal Events:
 * (a) Gia cat xuong MA10 lan thu 2 trong 10 phien
 * (b) RSI vuot 70 roi quay dau giam
 * (c) MACD histogram chuyen tu duong sang am
 * (d) ADX giam tu tren 25 xuong duoi 20
 * (e) Volume giam 3 phien lien tiep sau khi tang dot bien (>2x avg)
 */
function findSignalEvents(data: PriceData[]): SignalEvent[] {
  const events: SignalEvent[] = [];
  const closes = data.map(d => d.close);
  const volumes = data.map(d => d.volume);

  // Can du du lieu cho indicators
  if (data.length < 50) return events;

  const ma10 = calcSMA(closes, 10);
  const rsiArr = calcRSI(closes, 14);
  const macdHist = calcMACDHistogram(closes);
  const adxArr = calcADX(data, 14);

  // Scan tu ngay 30 tro di (can du data cho indicators)
  for (let i = 30; i < data.length - 12; i++) {
    // (a) MA10 break 2x: gia cat xuong MA10 lan thu 2 trong 10 phien
    if (ma10[i] > 0 && closes[i] < ma10[i] && closes[i - 1] >= ma10[i - 1]) {
      // Dem so lan cat xuong MA10 trong 10 phien truoc
      let breakCount = 0;
      for (let j = Math.max(i - 10, 1); j < i; j++) {
        if (ma10[j] > 0 && closes[j] < ma10[j] && closes[j - 1] >= ma10[j - 1]) {
          breakCount++;
        }
      }
      if (breakCount >= 1) {
        events.push({
          type: 'ma10_break_2x',
          date: data[i].date,
          dateIndex: i,
          description: `Gia cat xuong MA10 lan thu 2 trong 10 phien, close=${closes[i].toFixed(0)}`,
        });
      }
    }

    // (b) RSI reversal: RSI vuot 70 roi quay dau giam
    if (i >= 2 && rsiArr[i - 1] > 70 && rsiArr[i] < rsiArr[i - 1] && rsiArr[i - 1] >= rsiArr[i - 2]) {
      events.push({
        type: 'rsi_reversal',
        date: data[i].date,
        dateIndex: i,
        description: `RSI vuot 70 (${rsiArr[i - 1].toFixed(1)}) roi quay dau giam (${rsiArr[i].toFixed(1)})`,
      });
    }

    // (c) MACD histogram chuyen tu duong sang am
    if (i >= 1 && macdHist[i - 1] > 0 && macdHist[i] < 0) {
      events.push({
        type: 'macd_cross_negative',
        date: data[i].date,
        dateIndex: i,
        description: `MACD histogram chuyen am, tu ${macdHist[i - 1].toFixed(2)} sang ${macdHist[i].toFixed(2)}`,
      });
    }

    // (d) ADX giam tu tren 25 xuong duoi 20
    if (i >= 1 && adxArr[i - 1] > 25 && adxArr[i] < 20 && adxArr[i] > 0) {
      events.push({
        type: 'adx_decline',
        date: data[i].date,
        dateIndex: i,
        description: `ADX giam tu ${adxArr[i - 1].toFixed(1)} xuong ${adxArr[i].toFixed(1)} (duoi 20)`,
      });
    }

    // (e) Volume giam 3 phien lien tiep sau khi tang dot bien (>2x avg)
    if (i >= 24) {
      // Tinh avg volume 20 phien truoc
      let avgVol = 0;
      for (let j = i - 23; j < i - 3; j++) avgVol += volumes[j];
      avgVol /= 20;

      // Check spike truoc 3 phien
      const hasSpike = volumes[i - 3] > avgVol * 2;
      // Check 3 phien giam lien tiep
      const declining = volumes[i - 2] < volumes[i - 3] &&
                        volumes[i - 1] < volumes[i - 2] &&
                        volumes[i] < volumes[i - 1];

      if (hasSpike && declining) {
        events.push({
          type: 'volume_decline_3d',
          date: data[i].date,
          dateIndex: i,
          description: `Volume giam 3 phien lien tiep sau spike (${(volumes[i - 3] / avgVol).toFixed(1)}x avg)`,
        });
      }
    }
  }

  return events;
}

/**
 * Chon cutoff points tu Signal Events
 * cutoff_date = signal_date + 2 trading days
 * Max maxCutoffs per symbol (default 5)
 */
function selectCutoffPoints(
  data: PriceData[],
  signalEvents: SignalEvent[],
  maxCutoffs: number = MAX_CUTOFFS_PER_SYMBOL,
): CutoffPoint[] {
  const cutoffs: CutoffPoint[] = [];
  const usedDates = new Set<string>();

  for (const event of signalEvents) {
    if (cutoffs.length >= maxCutoffs) break;

    // cutoff = signal + 2 trading days
    const cutoffIndex = event.dateIndex + 2;
    if (cutoffIndex >= data.length - 10) continue; // Can 10 ngay sau de verify

    const cutoffDate = data[cutoffIndex].date;
    if (usedDates.has(cutoffDate)) continue; // Tranh trung cutoff date
    usedDates.add(cutoffDate);

    // Classify cutoff
    const patternType = classifyCutoff(data, cutoffIndex);

    cutoffs.push({
      date: cutoffDate,
      dateIndex: cutoffIndex,
      signalEvent: event,
      patternType,
    });
  }

  return cutoffs;
}


// ═══════════════════════════════════════════════════
// TASK 5.3: CLASSIFY CUTOFF + VERIFY PATTERN
// ═══════════════════════════════════════════════════

/**
 * Classify cutoff la peak hay trough
 * Check 10 ngay sau cutoff: drop > 5% = peak, rise > 5% = trough, else null
 */
function classifyCutoff(
  fullData: PriceData[],
  cutoffIndex: number,
): 'peak' | 'trough' | null {
  const cutoffClose = fullData[cutoffIndex].close;
  if (cutoffClose <= 0) return null;

  // Check 10 ngay sau cutoff
  let minPrice = cutoffClose;
  let maxPrice = cutoffClose;

  for (let i = cutoffIndex + 1; i <= Math.min(cutoffIndex + 10, fullData.length - 1); i++) {
    minPrice = Math.min(minPrice, fullData[i].close);
    maxPrice = Math.max(maxPrice, fullData[i].close);
  }

  const dropPct = ((cutoffClose - minPrice) / cutoffClose) * 100;
  const risePct = ((maxPrice - cutoffClose) / cutoffClose) * 100;

  if (dropPct > 5) return 'peak';
  if (risePct > 5) return 'trough';
  return null; // Inconclusive
}

/**
 * Verify pattern — mo du lieu tuong lai de kiem chung
 * Peak confirmed neu gia giam > 3% trong 10 ngay
 * Trough confirmed neu gia tang > 3% trong 10 ngay
 */
function verifyPattern(
  fullData: PriceData[],
  cutoffIndex: number,
  patternType: 'peak' | 'trough',
): VerificationResult {
  const cutoffClose = fullData[cutoffIndex].close;
  const verificationDays = 10;

  // Tinh P&L va max price change trong 10 ngay
  let maxPriceChange = 0;
  let endClose = cutoffClose;

  for (let i = cutoffIndex + 1; i <= Math.min(cutoffIndex + verificationDays, fullData.length - 1); i++) {
    const change = ((fullData[i].close - cutoffClose) / cutoffClose) * 100;
    if (Math.abs(change) > Math.abs(maxPriceChange)) {
      maxPriceChange = change;
    }
    if (i === cutoffIndex + verificationDays || i === fullData.length - 1) {
      endClose = fullData[i].close;
    }
  }

  const pnlPercent = cutoffClose > 0
    ? ((endClose - cutoffClose) / cutoffClose) * 100
    : 0;

  // Xac nhan pattern
  let isConfirmed = false;
  if (patternType === 'peak') {
    // Peak confirmed neu gia giam > 3%
    isConfirmed = maxPriceChange < -3;
  } else {
    // Trough confirmed neu gia tang > 3%
    isConfirmed = maxPriceChange > 3;
  }

  return {
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    verificationDays,
    isConfirmed,
    maxPriceChange: Math.round(maxPriceChange * 100) / 100,
  };
}


// ═══════════════════════════════════════════════════
// TASK 5.4: ENRICH SNAPSHOT
// ═══════════════════════════════════════════════════

/**
 * Enrich indicator snapshot voi derived features:
 * - rsi_trend: rising/falling/flat trong 5 phien
 * - macd_divergence: gia tang nhung MACD giam (hoac nguoc lai)
 * - adx_trend: rising/falling/flat trong 5 phien
 * - volume_trend: rising/falling/flat trong 5 phien
 * - bb_position: above_upper/middle/below_lower
 */
function enrichSnapshot(
  snapshot: IndicatorSnapshot,
  truncatedData: PriceData[],
  cutoffIndex: number,
): EnrichedSnapshot {
  const closes = truncatedData.map(d => d.close);
  const volumes = truncatedData.map(d => d.volume);

  // RSI trend (5 phien)
  let rsi_trend: 'rising' | 'falling' | 'flat' = 'flat';
  if (cutoffIndex >= 18) { // Can 14 + 5 = 19 ngay cho RSI trend
    const rsiArr = calcRSI(closes.slice(0, cutoffIndex + 1), 14);
    const rsiNow = rsiArr[rsiArr.length - 1];
    const rsi5Ago = rsiArr[rsiArr.length - 6] ?? rsiNow;
    const diff = rsiNow - rsi5Ago;
    if (diff > 3) rsi_trend = 'rising';
    else if (diff < -3) rsi_trend = 'falling';
  }

  // MACD divergence: gia tang nhung MACD giam (bearish) hoac nguoc lai (bullish)
  let macd_divergence = false;
  if (cutoffIndex >= 38) {
    const slicedCloses = closes.slice(0, cutoffIndex + 1);
    const macdHist = calcMACDHistogram(slicedCloses);
    const priceChange = closes[cutoffIndex] - closes[cutoffIndex - 5];
    const macdChange = macdHist[macdHist.length - 1] - macdHist[macdHist.length - 6];
    // Divergence: gia tang nhung MACD giam, hoac gia giam nhung MACD tang
    if ((priceChange > 0 && macdChange < 0) || (priceChange < 0 && macdChange > 0)) {
      macd_divergence = true;
    }
  }

  // ADX trend (5 phien)
  let adx_trend: 'rising' | 'falling' | 'flat' = 'flat';
  if (cutoffIndex >= 32) {
    const adxArr = calcADX(truncatedData.slice(0, cutoffIndex + 1), 14);
    const adxNow = adxArr[adxArr.length - 1];
    const adx5Ago = adxArr[adxArr.length - 6] ?? adxNow;
    const diff = adxNow - adx5Ago;
    if (diff > 2) adx_trend = 'rising';
    else if (diff < -2) adx_trend = 'falling';
  }

  // Volume trend (5 phien)
  let volume_trend: 'rising' | 'falling' | 'flat' = 'flat';
  if (cutoffIndex >= 5) {
    const volNow = volumes[cutoffIndex];
    const vol5Ago = volumes[cutoffIndex - 5];
    if (vol5Ago > 0) {
      const ratio = volNow / vol5Ago;
      if (ratio > 1.2) volume_trend = 'rising';
      else if (ratio < 0.8) volume_trend = 'falling';
    }
  }

  // Bollinger Bands position
  let bb_position: 'above_upper' | 'middle' | 'below_lower' = 'middle';
  if (snapshot.bb_upper !== null && snapshot.bb_lower !== null) {
    if (snapshot.close_price > snapshot.bb_upper) bb_position = 'above_upper';
    else if (snapshot.close_price < snapshot.bb_lower) bb_position = 'below_lower';
  }

  return {
    ...snapshot,
    rsi_trend,
    macd_divergence,
    adx_trend,
    volume_trend,
    bb_position,
  };
}


// ═══════════════════════════════════════════════════
// TASK 7.1: PATTERN DISCOVERY (Gemini AI)
// ═══════════════════════════════════════════════════

/**
 * Phan tich confirmed sessions bang Gemini AI
 * Tim dac diem chung xuat hien >= 60% cac dinh/day
 * Retry 1 lan sau 5 giay neu that bai
 */
async function discoverPatterns(
  confirmedSessions: Array<{ indicatorSnapshot: string | null; enrichedFeatures: string | null; symbol: string; cutoffDate: string }>,
  patternType: 'peak' | 'trough',
): Promise<DiscoveredPatternRecord[]> {
  if (confirmedSessions.length < 3) return []; // Can it nhat 3 sessions de tim pattern

  // Chuan bi data cho Gemini
  const sessionData = confirmedSessions.map(s => {
    try {
      const snapshot = s.indicatorSnapshot ? JSON.parse(s.indicatorSnapshot) : {};
      const enriched = s.enrichedFeatures ? JSON.parse(s.enrichedFeatures) : {};
      return { symbol: s.symbol, cutoffDate: s.cutoffDate, ...snapshot, ...enriched };
    } catch {
      return { symbol: s.symbol, cutoffDate: s.cutoffDate };
    }
  });

  const prompt = `Ban la chuyen gia phan tich ky thuat chung khoan Viet Nam.
Duoi day la ${confirmedSessions.length} phien phan tich da xac nhan la "${patternType === 'peak' ? 'dinh gia' : 'day gia'}".
Moi phien co cac indicator values tai thoi diem cutoff (truoc khi ${patternType === 'peak' ? 'gia giam' : 'gia tang'}).

Du lieu:
${JSON.stringify(sessionData, null, 2)}

Hay tim cac dieu kien indicator CHUNG xuat hien trong it nhat 60% cac phien.
Tra loi BANG JSON theo format:
{
  "patterns": [
    {
      "description": "Mo ta pattern bang tieng Viet khong dau",
      "conditions": [
        {"indicator": "rsi", "operator": ">", "value": 70},
        {"indicator": "adx_trend", "operator": "==", "value": "declining"}
      ],
      "occurrence_pct": 80
    }
  ],
  "analysis_summary": "Tom tat phan tich ngan gon"
}

Chi tra ve JSON, khong them text ngoai JSON.`;

  // Goi Gemini AI voi retry
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ai = getAI();
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
      });

      const responseText = response?.text || '';
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[BlindBacktest] ⚠️ Gemini response khong co JSON');
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const now = Date.now();
      const patterns: DiscoveredPatternRecord[] = [];

      if (parsed.patterns && Array.isArray(parsed.patterns)) {
        for (const p of parsed.patterns) {
          if (!p.conditions || !Array.isArray(p.conditions)) continue;
          if ((p.occurrence_pct || 0) < 60) continue;

          patterns.push({
            id: 0, // Se duoc set khi insert DB
            patternType,
            description: p.description || `${patternType} pattern`,
            conditions: p.conditions as PatternCondition[],
            occurrenceCount: confirmedSessions.length,
            confirmationRate: (p.occurrence_pct || 60) / 100,
            avgPnlAfter: 0,
            sampleSessions: confirmedSessions.map((_, idx) => idx),
            isActive: false, // Se duoc set dua tren occurrence_count va confirmation_rate
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      return patterns;
    } catch (e: any) {
      console.warn(`[BlindBacktest] ⚠️ Gemini AI attempt ${attempt + 1} that bai: ${e.message}`);
      if (attempt === 0) {
        console.log('[BlindBacktest] 🔄 Gemini AI retry sau 5 giay...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  console.warn('[BlindBacktest] ⚠️ Gemini AI that bai — luu sessions khong co AI analysis');
  return [];
}


// ═══════════════════════════════════════════════════
// TASK 7.2: MERGE OR CREATE PATTERN
// ═══════════════════════════════════════════════════

/**
 * Merge pattern moi voi existing patterns
 * Neu 80%+ overlap (cung indicator, cung operator, threshold diff < 10%) → update existing
 * Neu overlap < 80% → tao moi
 */
function mergeOrCreatePattern(
  newPattern: DiscoveredPatternRecord,
  existingPatterns: DiscoveredPatternRecord[],
): DiscoveredPatternRecord {
  for (const existing of existingPatterns) {
    if (existing.patternType !== newPattern.patternType) continue;

    // Tinh overlap
    const newConditions = newPattern.conditions;
    const existingConditions = existing.conditions;
    if (newConditions.length === 0) continue;

    let matchCount = 0;
    for (const nc of newConditions) {
      for (const ec of existingConditions) {
        if (nc.indicator !== ec.indicator) continue;
        if (nc.operator !== ec.operator) continue;

        // So sanh value: neu la so, check diff < 10%
        const ncVal = typeof nc.value === 'number' ? nc.value : 0;
        const ecVal = typeof ec.value === 'number' ? ec.value : 0;

        if (typeof nc.value === 'string' && typeof ec.value === 'string') {
          if (nc.value === ec.value) matchCount++;
        } else if (ecVal !== 0) {
          const diff = Math.abs(ncVal - ecVal) / Math.abs(ecVal);
          if (diff < 0.1) matchCount++;
        } else if (ncVal === 0 && ecVal === 0) {
          matchCount++;
        }
      }
    }

    const overlapPct = matchCount / newConditions.length;
    if (overlapPct >= 0.8) {
      // Merge: update existing pattern
      const totalOccurrences = existing.occurrenceCount + newPattern.occurrenceCount;
      const mergedRate = (
        existing.confirmationRate * existing.occurrenceCount +
        newPattern.confirmationRate * newPattern.occurrenceCount
      ) / totalOccurrences;

      return {
        ...existing,
        occurrenceCount: totalOccurrences,
        confirmationRate: Math.round(mergedRate * 100) / 100,
        avgPnlAfter: (existing.avgPnlAfter + newPattern.avgPnlAfter) / 2,
        sampleSessions: [...existing.sampleSessions, ...newPattern.sampleSessions].slice(0, 50),
        updatedAt: Date.now(),
        isActive: totalOccurrences >= 5 && mergedRate >= 0.6,
      };
    }
  }

  // Khong co overlap >= 80% → tao moi
  return {
    ...newPattern,
    isActive: newPattern.occurrenceCount >= 5 && newPattern.confirmationRate >= 0.6,
  };
}


// ═══════════════════════════════════════════════════
// TASK 7.3: GENERATE RULES FROM PATTERNS
// ═══════════════════════════════════════════════════

/**
 * Tao Strategy_Rule tu active patterns (occurrence_count >= 5, confirmation_rate >= 0.6)
 * Max 3 rules per run, skip neu tuong tu rule da co
 * Peak → all clusters, Trough → matching cluster via getStockCluster()
 */
async function generateRulesFromPatterns(
  activePatterns: DiscoveredPatternRecord[],
  runId: number,
): Promise<number[]> {
  const createdRuleIds: number[] = [];

  try {
    const db = getDatabase();
    if (!db) return createdRuleIds;

    // Lay existing rules de check trung lap
    const existingRules = db.select().from(strategyRules).all();

    for (const pattern of activePatterns) {
      if (createdRuleIds.length >= MAX_RULES_PER_RUN) break;
      if (pattern.occurrenceCount < 5 || pattern.confirmationRate < 0.6) continue;

      // Check tuong tu rule da co (cung indicator conditions, threshold diff < 10%)
      const isSimilar = existingRules.some(rule => {
        try {
          const ruleCriteria = rule.filterCriteria ? JSON.parse(rule.filterCriteria) : {};
          let matchCount = 0;
          for (const cond of pattern.conditions) {
            const ruleVal = ruleCriteria[cond.indicator];
            if (ruleVal !== undefined) {
              const condVal = typeof cond.value === 'number' ? cond.value : 0;
              if (typeof ruleVal === 'number' && condVal > 0) {
                const diff = Math.abs(ruleVal - condVal) / condVal;
                if (diff < 0.1) matchCount++;
              }
            }
          }
          return pattern.conditions.length > 0 && matchCount / pattern.conditions.length >= 0.8;
        } catch {
          return false;
        }
      });

      if (isSimilar) {
        console.log(`[BlindBacktest] ⏭️ Rule tuong tu da ton tai cho pattern: ${pattern.description}`);
        continue;
      }

      // Tao filter_criteria tu pattern conditions
      const filterCriteria: Record<string, any> = {};
      for (const cond of pattern.conditions) {
        filterCriteria[cond.indicator] = cond.value;
        filterCriteria[`${cond.indicator}_op`] = cond.operator;
      }

      // Xac dinh target_clusters
      let targetClusters: ClusterType[];
      if (pattern.patternType === 'peak') {
        // Peak patterns → exit/risk rules cho tat ca clusters
        targetClusters = ['strong_momentum', 'stable_trend', 'sideway', 'mean_reversion'];
      } else {
        // Trough patterns → entry rules cho matching cluster
        // Lay cluster tu sample sessions (dung symbol dau tien)
        const sampleCluster = getStockCluster(
          activePatterns[0]?.description?.match(/[A-Z]{3,4}/)?.[0] || 'FPT',
        );
        targetClusters = sampleCluster ? [sampleCluster] : ['sideway'];
      }

      const now = Date.now();
      const promptTemplate = `Ap dung pattern blind backtest: ${pattern.description}. Dieu kien: ${JSON.stringify(pattern.conditions)}`;

      const result = db.insert(strategyRules).values({
        name: `BlindBT: ${pattern.description}`.slice(0, 200),
        description: `Pattern ${pattern.patternType} tu blind backtest. Conditions: ${JSON.stringify(pattern.conditions)}. Confirmation rate: ${(pattern.confirmationRate * 100).toFixed(0)}%`,
        promptTemplate,
        filterCriteria: JSON.stringify(filterCriteria),
        isActive: 1,
        generation: 1,
        parentRuleId: null,
        knowledgeSources: '["blind_backtest"]',
        targetClusters: JSON.stringify(targetClusters),
        compositeFitness: 0.0,
        totalRecommendations: 0,
        winCount: 0,
        lossCount: 0,
        avgPnlPercent: 0,
        bestPnlPercent: 0,
        winRate: 0,
        profitFactor: 0,
        createdAt: now,
        updatedAt: now,
      }).returning({ id: strategyRules.id }).get();

      if (result?.id) {
        createdRuleIds.push(result.id);

        // Them vao Strategy Pool
        try {
          addToPool(result.id, targetClusters[0], 0.0);
        } catch (e: any) {
          console.warn(`[BlindBacktest] ⚠️ addToPool failed for rule ${result.id}: ${e.message}`);
        }

        console.log(`[BlindBacktest] 🆕 Tao rule moi #${result.id}: BlindBT: ${pattern.description}`);
      }
    }
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ generateRulesFromPatterns that bai: ${e.message}`);
  }

  return createdRuleIds;
}


// ═══════════════════════════════════════════════════
// TASK 8.1: SELF-HEALING
// ═══════════════════════════════════════════════════

// In-memory self-tuning config — reset khi bot restart (chap nhan duoc)
const selfTuningConfig: SelfTuningConfig = {
  thresholds: {
    ma10_break_2x: 1.0,    // He so nhan cho threshold
    rsi_reversal: 1.0,
    macd_cross_negative: 1.0,
    adx_decline: 1.0,
    volume_decline_3d: 1.0,
  },
  lastSuccessDate: null,
  consecutiveZeroDays: 0,
  adjustmentHistory: [],
};

// Track retry — max 1 retry/day
let lastRetryDate = '';

/**
 * Auto-deactivate patterns co confirmation_rate < 0.4 sau 10+ occurrences
 * Dong thoi deactivate Strategy_Rule tuong ung
 */
function checkAndDeactivatePatterns(): void {
  try {
    const db = getDatabase();
    if (!db) return;

    const patterns = db.select()
      .from(blindBacktestPatterns)
      .where(eq(blindBacktestPatterns.isActive, 1))
      .all();

    for (const pattern of patterns) {
      if ((pattern.occurrenceCount ?? 0) >= 10 && (pattern.confirmationRate ?? 0) < 0.4) {
        // Deactivate pattern
        db.update(blindBacktestPatterns)
          .set({ isActive: 0, updatedAt: Date.now() })
          .where(eq(blindBacktestPatterns.id, pattern.id))
          .run();

        // Deactivate tuong ung Strategy_Rule (tim theo name prefix "BlindBT:")
        const desc = pattern.description || '';
        const matchingRules = db.select()
          .from(strategyRules)
          .all()
          .filter(r => r.name?.includes('BlindBT:') && r.name?.includes(desc.slice(0, 50)));

        for (const rule of matchingRules) {
          db.update(strategyRules)
            .set({ isActive: 0, updatedAt: Date.now() })
            .where(eq(strategyRules.id, rule.id))
            .run();
        }

        console.log(`[BlindBacktest] 🔄 Pattern #${pattern.id} tu dong deactivate — confirmation_rate ${pattern.confirmationRate} qua thap`);
      }
    }
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ checkAndDeactivatePatterns that bai: ${e.message}`);
  }
}

/**
 * Auto-adjust thresholds khi Signal_Event type co < 40% confirmation over 20+ sessions
 * Tang threshold 5% cho signal type do
 */
function autoAdjustThresholds(
  sessions: Array<{ signalEvent: string; isPatternConfirmed: number | null }>,
): void {
  try {
    // Nhom sessions theo signal event type
    const byType: Record<string, { total: number; confirmed: number }> = {};

    for (const s of sessions) {
      // Extract signal type tu signalEvent description
      let signalType: SignalEventType = 'ma10_break_2x';
      const desc = (s.signalEvent || '').toLowerCase();
      if (desc.includes('ma10')) signalType = 'ma10_break_2x';
      else if (desc.includes('rsi')) signalType = 'rsi_reversal';
      else if (desc.includes('macd')) signalType = 'macd_cross_negative';
      else if (desc.includes('adx')) signalType = 'adx_decline';
      else if (desc.includes('volume')) signalType = 'volume_decline_3d';

      if (!byType[signalType]) byType[signalType] = { total: 0, confirmed: 0 };
      byType[signalType].total++;
      if (s.isPatternConfirmed === 1) byType[signalType].confirmed++;
    }

    // Check tung signal type
    for (const [type, stats] of Object.entries(byType)) {
      if (stats.total < 20) continue;

      const confirmRate = stats.confirmed / stats.total;
      if (confirmRate < 0.4) {
        const oldThreshold = selfTuningConfig.thresholds[type] || 1.0;
        const newThreshold = Math.min(oldThreshold * 1.05, 2.0); // Tang 5%, cap tai 2x

        if (newThreshold !== oldThreshold) {
          selfTuningConfig.thresholds[type] = newThreshold;
          selfTuningConfig.adjustmentHistory.push({
            date: new Date().toISOString().split('T')[0],
            event: `${type}: threshold tang 5%`,
            oldValue: oldThreshold,
            newValue: newThreshold,
          });

          console.log(`[BlindBacktest] 🔧 Tu dieu chinh threshold ${type}: ${oldThreshold.toFixed(2)} → ${newThreshold.toFixed(2)} (confirmation ${(confirmRate * 100).toFixed(0)}% < 40%)`);
        }
      }
    }
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ autoAdjustThresholds that bai: ${e.message}`);
  }
}

/**
 * Auto-expand criteria khi 3 ngay lien tiep 0 confirmed patterns
 * Giam tat ca thresholds 10%, restore khi tim duoc patterns
 */
function autoExpandCriteria(): void {
  try {
    if (selfTuningConfig.consecutiveZeroDays >= 3) {
      // Giam tat ca thresholds 10%
      for (const type of Object.keys(selfTuningConfig.thresholds)) {
        const oldVal = selfTuningConfig.thresholds[type];
        const newVal = Math.max(oldVal * 0.9, 0.5); // Giam 10%, floor tai 0.5x
        selfTuningConfig.thresholds[type] = newVal;
      }

      selfTuningConfig.adjustmentHistory.push({
        date: new Date().toISOString().split('T')[0],
        event: 'Auto-expand: giam tat ca thresholds 10%',
        oldValue: 1.0,
        newValue: 0.9,
      });

      console.log(`[BlindBacktest] 🔧 Auto-expand criteria: giam tat ca thresholds 10% (${selfTuningConfig.consecutiveZeroDays} ngay lien tiep 0 patterns)`);
      selfTuningConfig.consecutiveZeroDays = 0; // Reset counter
    }
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ autoExpandCriteria that bai: ${e.message}`);
  }
}

/**
 * Schedule retry cho failed run sau 30 phut, max 1 retry/day
 */
function scheduleRetry(symbols: string[], batchIndex: number): void {
  try {
    const today = new Date().toISOString().split('T')[0];
    if (lastRetryDate === today) {
      console.log('[BlindBacktest] ⏭️ Da retry 1 lan hom nay, khong retry nua');
      return;
    }

    lastRetryDate = today;
    console.log(`[BlindBacktest] 🔄 Schedule retry sau 30 phut cho batch ${batchIndex} (${symbols.length} symbols)`);

    setTimeout(async () => {
      try {
        console.log(`[BlindBacktest] 🔄 Retry batch ${batchIndex}...`);
        await runBlindBacktest(symbols, 'scheduler');
      } catch (e: any) {
        console.warn(`[BlindBacktest] ⚠️ Retry that bai: ${e.message}`);
      }
    }, 30 * 60 * 1000); // 30 phut
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ scheduleRetry that bai: ${e.message}`);
  }
}


// ═══════════════════════════════════════════════════
// TASK 10.1: RUN SESSION FOR SYMBOL
// ═══════════════════════════════════════════════════

/**
 * Chay blind backtest cho 1 symbol tai 1 cutoff point
 * Full flow: split data → compute indicators (truncated only) → enrich → store session → verify → update
 */
async function runSessionForSymbol(
  symbol: string,
  fullData: PriceData[],
  cutoffPoint: CutoffPoint,
  runId: number,
): Promise<BlindBacktestSessionRecord | null> {
  try {
    const cutoffIndex = cutoffPoint.dateIndex;
    const patternType = cutoffPoint.patternType;

    // Skip neu khong phai peak/trough
    if (!patternType) return null;

    // CRITICAL: Split data — truncated chi chua data truoc va tai cutoff
    const truncatedData = fullData.slice(0, cutoffIndex + 1);

    // Validate du lieu du
    if (truncatedData.length < 120) {
      console.warn(`[BlindBacktest] ⚠️ Du lieu khong du de phan tich blind backtest: ${symbol} (${truncatedData.length} ngay)`);
      return null;
    }

    // Compute indicator snapshot (chi dung truncated data — NO LEAKAGE)
    const snapshot = computeIndicatorSnapshot(truncatedData, cutoffIndex);

    // Enrich snapshot voi derived features
    const enriched = enrichSnapshot(snapshot, truncatedData, cutoffIndex);

    // Store session (chua verify)
    const db = getDatabase();
    if (!db) return null;

    const now = Date.now();
    const sessionData: NewBlindBacktestSession = {
      runId,
      symbol,
      cutoffDate: cutoffPoint.date,
      signalEvent: cutoffPoint.signalEvent.description,
      patternType,
      indicatorSnapshot: JSON.stringify(snapshot),
      enrichedFeatures: JSON.stringify(enriched),
      verificationPnlPercent: null,
      verificationDays: 10,
      isPatternConfirmed: 0,
      createdAt: now,
    };

    const inserted = db.insert(blindBacktestSessions).values(sessionData).returning({ id: blindBacktestSessions.id }).get();
    if (!inserted?.id) return null;

    // VERIFICATION: Mo du lieu tuong lai de kiem chung
    const verification = verifyPattern(fullData, cutoffIndex, patternType);

    // Update session voi verification results
    db.update(blindBacktestSessions)
      .set({
        verificationPnlPercent: verification.pnlPercent,
        verificationDays: verification.verificationDays,
        isPatternConfirmed: verification.isConfirmed ? 1 : 0,
      })
      .where(eq(blindBacktestSessions.id, inserted.id))
      .run();

    // Log ket qua
    if (verification.isConfirmed) {
      console.log(`[BlindBacktest] ✅ Pattern confirmed: ${symbol} ${patternType} tai ${cutoffPoint.date}, P&L=${verification.pnlPercent}%`);
    } else {
      console.log(`[BlindBacktest] ❌ Pattern not confirmed: ${symbol} ${patternType} tai ${cutoffPoint.date}, P&L=${verification.pnlPercent}%`);
    }

    return {
      id: inserted.id,
      runId,
      symbol,
      cutoffDate: cutoffPoint.date,
      signalEvent: cutoffPoint.signalEvent.description,
      patternType,
      indicatorSnapshot: snapshot,
      enrichedFeatures: enriched,
      verificationPnlPercent: verification.pnlPercent,
      verificationDays: verification.verificationDays,
      isPatternConfirmed: verification.isConfirmed,
      createdAt: now,
    };
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ runSessionForSymbol ${symbol} that bai: ${e.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════
// TASK 10.2: RUN BLIND BACKTEST (MAIN ORCHESTRATION)
// ═══════════════════════════════════════════════════

/**
 * Chay blind backtest cho 1 batch symbols
 * Full flow: create run → process symbols → find cutoffs → run sessions → discover patterns → generate rules
 * Timeout 20 phut, memory efficient (release data sau moi symbol)
 */
export async function runBlindBacktest(
  symbols: string[],
  triggerType: 'scheduler' | 'manual',
  options?: { startDate?: string; endDate?: string },
): Promise<BlindBacktestRunRecord> {
  const startTime = Date.now();
  console.log(`[BlindBacktest] 🔬 Bat dau blind backtest: ${symbols.length} symbols, trigger=${triggerType}`);

  // Tao run record
  const db = getDatabase();
  const runData: NewBlindBacktestRun = {
    triggerType,
    symbols: JSON.stringify(symbols),
    totalSessions: 0,
    totalPeaksFound: 0,
    totalTroughsFound: 0,
    patternsDiscovered: 0,
    rulesCreated: 0,
    aiAnalysisSummary: null,
    startedAt: startTime,
    completedAt: null,
    status: 'running',
  };

  const runInserted = db.insert(blindBacktestRuns).values(runData).returning({ id: blindBacktestRuns.id }).get();
  const runId = runInserted?.id || 0;

  let totalSessions = 0;
  let totalPeaks = 0;
  let totalTroughs = 0;
  let allConfirmedSessions: Array<{ indicatorSnapshot: string | null; enrichedFeatures: string | null; symbol: string; cutoffDate: string; patternType: string }> = [];

  try {
    // Process symbols in batches of BATCH_SIZE
    for (let batchStart = 0; batchStart < symbols.length; batchStart += BATCH_SIZE) {
      // Check timeout
      if (Date.now() - startTime > RUN_TIMEOUT_MS) {
        console.log(`[BlindBacktest] ⏰ Timeout sau ${Math.round((Date.now() - startTime) / 60000)} phut — partial results saved`);
        break;
      }

      const batch = symbols.slice(batchStart, batchStart + BATCH_SIZE);

      for (const symbol of batch) {
        try {
          // Check timeout per symbol
          if (Date.now() - startTime > RUN_TIMEOUT_MS) break;

          // Fetch du lieu gia (reuse tu historical-backtester)
          const fullData = await fetchHistoricalPrices(symbol);
          if (fullData.length < 120) {
            console.warn(`[BlindBacktest] ⚠️ Du lieu khong du de phan tich blind backtest: ${symbol} (${fullData.length} ngay)`);
            continue;
          }

          // Tim signal events
          const signalEvents = findSignalEvents(fullData);
          if (signalEvents.length === 0) continue;

          // Chon cutoff points
          const cutoffPoints = selectCutoffPoints(fullData, signalEvents, MAX_CUTOFFS_PER_SYMBOL);

          // Chay session cho tung cutoff
          for (const cutoff of cutoffPoints) {
            if (!cutoff.patternType) continue;

            const session = await runSessionForSymbol(symbol, fullData, cutoff, runId);
            if (session) {
              totalSessions++;
              if (session.patternType === 'peak') totalPeaks++;
              if (session.patternType === 'trough') totalTroughs++;

              if (session.isPatternConfirmed) {
                allConfirmedSessions.push({
                  indicatorSnapshot: JSON.stringify(session.indicatorSnapshot),
                  enrichedFeatures: JSON.stringify(session.enrichedFeatures),
                  symbol: session.symbol,
                  cutoffDate: session.cutoffDate,
                  patternType: session.patternType || 'peak',
                });
              }
            }
          }

          // Delay giua cac API calls
          await new Promise(r => setTimeout(r, API_DELAY_MS));
        } catch (e: any) {
          console.warn(`[BlindBacktest] ⚠️ Symbol ${symbol} that bai: ${e.message}`);
        }
      }
    }

    // Pattern Discovery (Gemini AI)
    let patternsDiscovered = 0;
    let rulesCreated = 0;
    let aiSummary = '';

    // Discover peak patterns
    const confirmedPeaks = allConfirmedSessions.filter(s => s.patternType === 'peak');
    const confirmedTroughs = allConfirmedSessions.filter(s => s.patternType === 'trough');

    const existingPatterns = db.select().from(blindBacktestPatterns).all();
    const existingParsed: DiscoveredPatternRecord[] = existingPatterns.map(p => ({
      id: p.id,
      patternType: p.patternType as 'peak' | 'trough',
      description: p.description,
      conditions: p.conditions ? JSON.parse(p.conditions) : [],
      occurrenceCount: p.occurrenceCount ?? 0,
      confirmationRate: p.confirmationRate ?? 0,
      avgPnlAfter: p.avgPnlAfter ?? 0,
      sampleSessions: p.sampleSessions ? JSON.parse(p.sampleSessions) : [],
      isActive: p.isActive === 1,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

    const newPatterns: DiscoveredPatternRecord[] = [];

    if (confirmedPeaks.length >= 3) {
      const peakPatterns = await discoverPatterns(confirmedPeaks, 'peak');
      for (const p of peakPatterns) {
        const merged = mergeOrCreatePattern(p, existingParsed);
        newPatterns.push(merged);
      }
    }

    if (confirmedTroughs.length >= 3) {
      const troughPatterns = await discoverPatterns(confirmedTroughs, 'trough');
      for (const p of troughPatterns) {
        const merged = mergeOrCreatePattern(p, existingParsed);
        newPatterns.push(merged);
      }
    }

    // Luu patterns vao DB
    for (const pattern of newPatterns) {
      try {
        if (pattern.id > 0) {
          // Update existing pattern
          db.update(blindBacktestPatterns)
            .set({
              occurrenceCount: pattern.occurrenceCount,
              confirmationRate: pattern.confirmationRate,
              avgPnlAfter: pattern.avgPnlAfter,
              sampleSessions: JSON.stringify(pattern.sampleSessions),
              isActive: pattern.isActive ? 1 : 0,
              updatedAt: Date.now(),
            })
            .where(eq(blindBacktestPatterns.id, pattern.id))
            .run();
        } else {
          // Insert new pattern
          db.insert(blindBacktestPatterns).values({
            patternType: pattern.patternType,
            description: pattern.description,
            conditions: JSON.stringify(pattern.conditions),
            occurrenceCount: pattern.occurrenceCount,
            confirmationRate: pattern.confirmationRate,
            avgPnlAfter: pattern.avgPnlAfter,
            sampleSessions: JSON.stringify(pattern.sampleSessions),
            isActive: pattern.isActive ? 1 : 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }).run();
        }
        patternsDiscovered++;
      } catch (e: any) {
        console.warn(`[BlindBacktest] ⚠️ Luu pattern that bai: ${e.message}`);
      }
    }

    // Generate rules tu active patterns
    const activeNewPatterns = newPatterns.filter(p => p.isActive);
    if (activeNewPatterns.length > 0) {
      const ruleIds = await generateRulesFromPatterns(activeNewPatterns, runId);
      rulesCreated = ruleIds.length;
    }

    // Self-healing: check va deactivate patterns yeu
    checkAndDeactivatePatterns();

    // Self-healing: auto-adjust thresholds
    const recentSessions = db.select({
      signalEvent: blindBacktestSessions.signalEvent,
      isPatternConfirmed: blindBacktestSessions.isPatternConfirmed,
    }).from(blindBacktestSessions).all();
    autoAdjustThresholds(recentSessions);

    // Self-healing: track consecutive zero-pattern days
    if (patternsDiscovered === 0 && triggerType === 'scheduler') {
      selfTuningConfig.consecutiveZeroDays++;
      autoExpandCriteria();
    } else if (patternsDiscovered > 0) {
      selfTuningConfig.consecutiveZeroDays = 0;
      selfTuningConfig.lastSuccessDate = new Date().toISOString().split('T')[0];
    }

    // AI summary
    aiSummary = `Blind backtest ${triggerType}: ${totalSessions} sessions, ${totalPeaks} peaks, ${totalTroughs} troughs, ${allConfirmedSessions.length} confirmed, ${patternsDiscovered} patterns, ${rulesCreated} rules`;

    // Update run record
    const completedAt = Date.now();
    db.update(blindBacktestRuns)
      .set({
        totalSessions,
        totalPeaksFound: totalPeaks,
        totalTroughsFound: totalTroughs,
        patternsDiscovered,
        rulesCreated,
        aiAnalysisSummary: aiSummary,
        completedAt,
        status: 'completed',
      })
      .where(eq(blindBacktestRuns.id, runId))
      .run();

    const elapsed = Math.round((completedAt - startTime) / 1000);
    console.log(`[BlindBacktest] ✅ Hoan thanh: ${totalSessions} sessions, ${patternsDiscovered} patterns, ${rulesCreated} rules, ${elapsed}s`);

    // Notification
    await sendBlindBacktestNotification(
      { patternsDiscovered, rulesCreated, totalSessions, symbols, triggerType },
      newPatterns,
      triggerType,
    );

    return {
      id: runId,
      triggerType: triggerType as 'scheduler' | 'manual',
      symbols,
      totalSessions,
      totalPeaksFound: totalPeaks,
      totalTroughsFound: totalTroughs,
      patternsDiscovered,
      rulesCreated,
      aiAnalysisSummary: aiSummary,
      startedAt: startTime,
      completedAt,
      status: 'completed',
    };
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ Blind Backtest failed (non-fatal): ${e.message}`);

    // Mark run as failed
    try {
      db.update(blindBacktestRuns)
        .set({ status: 'failed', completedAt: Date.now() })
        .where(eq(blindBacktestRuns.id, runId))
        .run();
    } catch { /* ignore */ }

    // Schedule retry
    scheduleRetry(symbols, 0);

    return {
      id: runId,
      triggerType: triggerType as 'scheduler' | 'manual',
      symbols,
      totalSessions,
      totalPeaksFound: totalPeaks,
      totalTroughsFound: totalTroughs,
      patternsDiscovered: 0,
      rulesCreated: 0,
      aiAnalysisSummary: null,
      startedAt: startTime,
      completedAt: Date.now(),
      status: 'failed',
    };
  }
}


// ═══════════════════════════════════════════════════
// TASK 10.3: SCHEDULER — Daily 17:30 VN (T2-T6)
// ═══════════════════════════════════════════════════

// Track last processed date va symbols
let lastSchedulerRunDate = '';
const lastProcessedSymbols = new Map<string, string>(); // symbol → last_processed_date

/**
 * Chia BACKTEST_STOCKS thanh 5 batches (Mon=0, Tue=1, ..., Fri=4)
 * Moi batch co so luong tuong duong (chenh lech toi da 1)
 */
function getRotatingBatch(dayOfWeek: number): string[] {
  // dayOfWeek: 1=Mon, 2=Tue, ..., 5=Fri → index 0-4
  const batchIndex = dayOfWeek - 1;
  if (batchIndex < 0 || batchIndex > 4) return [];

  const batchSize = Math.ceil(BACKTEST_STOCKS.length / 5);
  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, BACKTEST_STOCKS.length);
  return BACKTEST_STOCKS.slice(start, end);
}

/**
 * Start blind backtest scheduler — chay moi ngay 17:30 VN (T2-T6)
 * Rotating batch: Mon=batch1, Tue=batch2, ..., Fri=batch5
 */
export function startBlindBacktestScheduler(): void {
  console.log('[BlindBacktest] 🔬 Bat dau Blind Backtest scheduler (17:30 VN, T2-T6)');

  setInterval(async () => {
    try {
      const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
      const vnHour = vnNow.getHours();
      const vnMinute = vnNow.getMinutes();
      const vnDay = vnNow.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

      // Chay T2-T6 (day 1-5), luc 17:30
      if (vnDay < 1 || vnDay > 5) return;
      if (vnHour !== 17 || vnMinute < 30 || vnMinute > 35) return;

      const dateStr = vnNow.toISOString().split('T')[0];
      if (lastSchedulerRunDate === dateStr) return;

      lastSchedulerRunDate = dateStr;

      // Lay batch cho ngay hom nay
      const batch = getRotatingBatch(vnDay);
      if (batch.length === 0) return;

      console.log(`[BlindBacktest] ⏰ 17:30 VN — bat dau blind backtest batch ${vnDay} (${batch.length} symbols)`);

      try {
        await runBlindBacktest(batch, 'scheduler');

        // Track last processed
        const now = new Date().toISOString().split('T')[0];
        for (const symbol of batch) {
          lastProcessedSymbols.set(symbol, now);
        }
      } catch (e: any) {
        console.warn(`[BlindBacktest] ⚠️ Scheduler run that bai: ${e.message}`);
        scheduleRetry(batch, vnDay - 1);
      }
    } catch (e: any) {
      console.warn(`[BlindBacktest] ⚠️ Scheduler interval error (non-fatal): ${e.message}`);
    }
  }, 60 * 1000); // Check moi phut
}


// ═══════════════════════════════════════════════════
// TASK 10.4: GET BLIND BACKTEST SUMMARY
// ═══════════════════════════════════════════════════

/**
 * Tra ve summary cho Darwinian V2 integration
 * totalRuns, totalPatternsDiscovered, activePatternsCount, rulesCreated, rulesStillActive
 */
export async function getBlindBacktestSummary(): Promise<BlindBacktestSummary> {
  try {
    const db = getDatabase();
    if (!db) {
      return { totalRuns: 0, totalPatternsDiscovered: 0, activePatternsCount: 0, rulesCreated: 0, rulesStillActive: 0 };
    }

    // Tong so runs
    const runs = db.select({ id: blindBacktestRuns.id }).from(blindBacktestRuns).all();
    const totalRuns = runs.length;

    // Tong so patterns
    const patterns = db.select({
      id: blindBacktestPatterns.id,
      isActive: blindBacktestPatterns.isActive,
    }).from(blindBacktestPatterns).all();
    const totalPatternsDiscovered = patterns.length;
    const activePatternsCount = patterns.filter(p => p.isActive === 1).length;

    // Rules tao boi blind backtest
    const allRules = db.select({
      id: strategyRules.id,
      isActive: strategyRules.isActive,
      knowledgeSources: strategyRules.knowledgeSources,
    }).from(strategyRules).all();

    const blindBtRules = allRules.filter(r =>
      r.knowledgeSources && r.knowledgeSources.includes('blind_backtest'),
    );
    const rulesCreated = blindBtRules.length;
    const rulesStillActive = blindBtRules.filter(r => r.isActive === 1).length;

    return {
      totalRuns,
      totalPatternsDiscovered,
      activePatternsCount,
      rulesCreated,
      rulesStillActive,
    };
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ getBlindBacktestSummary that bai: ${e.message}`);
    return { totalRuns: 0, totalPatternsDiscovered: 0, activePatternsCount: 0, rulesCreated: 0, rulesStillActive: 0 };
  }
}


// ═══════════════════════════════════════════════════
// TASK 11.1: NOTIFICATION — Gui Zalo cho admin
// ═══════════════════════════════════════════════════

/**
 * Gui thong bao ket qua blind backtest qua Zalo cho admin
 * Scheduler: chi gui khi co patterns moi (tranh spam)
 * Manual: luon gui ket qua
 * Bao gom self-tuning summary neu co thay doi
 */
async function sendBlindBacktestNotification(
  run: { patternsDiscovered: number; rulesCreated: number; totalSessions: number; symbols: string[]; triggerType: string },
  newPatterns: DiscoveredPatternRecord[],
  triggerType: 'scheduler' | 'manual',
): Promise<void> {
  try {
    // Scheduler: chi gui khi co patterns moi
    if (triggerType === 'scheduler' && run.patternsDiscovered === 0) return;

    // Lay Zalo API tu container
    const { container, Services } = await import('../../core/index.js');
    const api: any = container.get(Services.ZALO_API);
    if (!api) {
      console.warn('[BlindBacktest] ⚠️ Zalo API khong kha dung, khong gui notification');
      return;
    }

    // Build message
    let message = `🔬 Blind Backtest ${triggerType === 'scheduler' ? 'Daily' : 'Manual'}\n`;
    message += `📊 ${run.totalSessions} sessions | ${run.symbols.length} symbols\n`;

    if (run.patternsDiscovered > 0) {
      message += `✨ ${run.patternsDiscovered} patterns moi phat hien\n`;
      // Mo ta ngan gon tung pattern
      for (const p of newPatterns.slice(0, 3)) {
        message += `  • ${p.patternType}: ${p.description.slice(0, 80)}\n`;
      }
    } else {
      message += `📭 Khong phat hien pattern moi\n`;
    }

    if (run.rulesCreated > 0) {
      message += `🆕 ${run.rulesCreated} rules moi da tao\n`;
    }

    // Self-tuning summary (neu co thay doi gan day)
    const recentAdjustments = selfTuningConfig.adjustmentHistory.filter(a => {
      const today = new Date().toISOString().split('T')[0];
      return a.date === today;
    });
    if (recentAdjustments.length > 0) {
      message += `\n🔧 Tu dieu chinh:\n`;
      for (const adj of recentAdjustments.slice(0, 3)) {
        message += `  • ${adj.event}\n`;
      }
    }

    // Gui qua Zalo
    const { sendTextMessage, setThreadType } = await import('../../shared/utils/message/messageSender.js');
    const { ThreadType } = await import('../../infrastructure/messaging/zalo/zalo.service.js');
    setThreadType(ADMIN_UID, ThreadType.User);
    await sendTextMessage(api, message.trim(), ADMIN_UID, { source: 'blind-backtest' });

    console.log('[BlindBacktest] 📨 Da gui notification qua Zalo cho admin');
  } catch (e: any) {
    console.warn(`[BlindBacktest] ⚠️ Zalo notification failed (non-fatal): ${e.message}`);
  }
}
