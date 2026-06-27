/**
 * Full Historical Backtest Service — Brute-force tim combo chi bao tot nhat
 * Universe: VN100 + top 10 HNX + top 10 UPCoM (~120 CP)
 * Sequential 5 nam OHLCV → entry/exit T+5..T+10 → tinh P&L sau phi 0.3% round-trip
 * Auto run daily 19:00 VN, ho tro manual trigger qua dashboard
 * Muc tieu: cai thien hieu suat dau tu moi ngay
 */

import { eq, desc } from 'drizzle-orm';
import { getDatabase } from '../../infrastructure/database/connection.js';
import {
  fullBacktestRuns,
  backtestComboResults,
  backtestComboTrades,
  type NewFullBacktestRun,
  type NewBacktestComboResult,
  type NewBacktestComboTrade,
} from '../../infrastructure/database/schema.js';
import {
  calcSMA,
  calcEMA,
  calcRSI,
  calcMACDHistogram,
  calcVolumeRatio,
} from './historical-backtester.service.js';
import { calcADX, calcDMI } from './blind-backtest.service.js';
import type { PriceData } from './strategy-tracker.types.js';

// ═══════════════════════════════════════════════════
// CONSTANTS — Cau hinh full backtest
// ═══════════════════════════════════════════════════

const PERIOD_YEARS = 5;
const MIN_AVG_VOLUME = 200_000;     // theo yeu cau anh Si: vol > 200k
const MIN_PRICE = 10_000;           // gia > 10k VND
const MIN_TRADING_DAYS = 250;       // toi thieu 1 nam data
const FETCH_BATCH_SIZE = 8;
const FETCH_BATCH_DELAY_MS = 600;
const HOLD_MIN = 5;                 // T+5
const HOLD_MAX = 10;                // T+10
const HOLD_DEFAULT = 7;             // T+7 default exit
const WIN_THRESHOLD_PCT = 0.5;      // pnl SAU PHI > 0.5% la win (chat hon vi tinh phi)
const LOW_CONF_THRESHOLD = 10;      // < 10 trades → low_confidence flag

// Phi giao dich VN: 0.15% mua + 0.15% ban = 0.3% round-trip
// (thuc te co the cao hon do thue ban 0.1% + phi spread, nhung 0.3% la conservative)
const FEE_BUY_PCT = 0.15;
const FEE_SELL_PCT = 0.15;
const FEE_ROUND_TRIP_PCT = FEE_BUY_PCT + FEE_SELL_PCT;  // 0.3%

// ═══════════════════════════════════════════════════
// STOCK UNIVERSE: VN100 (VN30 + VN70) + top 10 HNX + top 10 UPCoM
// Tong: ~120 CP — khop yeu cau anh Si
// ═══════════════════════════════════════════════════

// VN30 — bluechip HOSE
const VN30 = [
  'ACB', 'BCM', 'BID', 'BVH', 'CTG', 'FPT', 'GAS', 'GVR', 'HDB', 'HPG',
  'MBB', 'MSN', 'MWG', 'PLX', 'POW', 'SAB', 'SHB', 'SSB', 'SSI', 'STB',
  'TCB', 'TPB', 'VCB', 'VHM', 'VIB', 'VIC', 'VJC', 'VNM', 'VPB', 'VRE',
];

// VN70 — phan con lai cua VN100 (HOSE mid-cap thanh khoan)
const VN70 = [
  'AAA', 'ANV', 'ASM', 'BAF', 'BMP', 'BSI', 'BSR', 'BWE', 'CII', 'CMG',
  'CRE', 'CSV', 'CTD', 'CTR', 'CTS', 'DBC', 'DCM', 'DGC', 'DGW', 'DIG',
  'DPM', 'DPR', 'DXG', 'DXS', 'EIB', 'EVF', 'FCN', 'FRT', 'FTS', 'GEX',
  'GMD', 'HAG', 'HAH', 'HCM', 'HDC', 'HDG', 'HHV', 'HSG', 'HT1', 'IMP',
  'KBC', 'KDC', 'KDH', 'KOS', 'LPB', 'MSB', 'NKG', 'NLG', 'NT2', 'NVL',
  'OCB', 'PAN', 'PC1', 'PDR', 'PHR', 'PNJ', 'PVD', 'PVS', 'PVT', 'REE',
  'SBT', 'SIP', 'SJS', 'SZC', 'TCH', 'TLG', 'VCG', 'VCI', 'VHC', 'VIX',
];

// Top 10 HNX — thanh khoan cao nhat HNX (theo VND value)
const HNX_TOP10 = [
  'SHS', 'CEO', 'PVS', 'IDC', 'VCS', 'TNG', 'PVI', 'NVB', 'BVS', 'MBS',
];

// Top 10 UPCoM — thanh khoan cao nhat UPCoM
const UPCOM_TOP10 = [
  'BSR', 'OIL', 'MCH', 'ACV', 'VEA', 'VGI', 'MSR', 'VTP', 'GE2', 'BVB',
];

// Combine + dedupe (BSR co the trung VN70 vs UPCoM)
export const FULL_BACKTEST_UNIVERSE = Array.from(new Set([
  ...VN30, ...VN70, ...HNX_TOP10, ...UPCOM_TOP10,
])).sort();

// Stock groups — phan loai theo nganh + theo san
export const STOCK_GROUPS: Record<string, string[]> = {
  // Theo san
  vn30: VN30,
  vn70: VN70,
  hnx: HNX_TOP10,
  upcom: UPCOM_TOP10,
  // Theo nganh
  banking: ['ACB', 'BID', 'CTG', 'EIB', 'HDB', 'LPB', 'MBB', 'MSB', 'OCB', 'SHB', 'SSB', 'STB', 'TCB', 'TPB', 'VCB', 'VIB', 'VPB', 'NVB', 'BVB'],
  tech: ['FPT', 'CMG', 'CTR', 'VGI', 'VTP', 'DGW', 'ELC'],
  steel: ['HPG', 'HSG', 'NKG', 'SMC'],
  real_estate: ['VIC', 'VHM', 'VRE', 'KDH', 'NVL', 'DXG', 'DIG', 'PDR', 'NLG', 'KBC', 'CEO', 'IJC', 'AGG', 'BCG', 'CRE', 'HDC', 'HDG', 'IDC', 'KOS', 'SIP', 'SJS', 'SZC', 'DXS'],
  retail_consumer: ['MWG', 'FRT', 'PNJ', 'DGW', 'PET', 'VNM', 'SAB', 'MSN', 'MCH', 'KDC', 'BAF', 'DBC'],
  energy: ['GAS', 'PLX', 'BSR', 'PVD', 'PVS', 'POW', 'PVT', 'PVI', 'NT2', 'OIL'],
  finance_securities: ['SSI', 'VND', 'HCM', 'VCI', 'FTS', 'MBS', 'SHS', 'BSI', 'CTS', 'BVS', 'BVH'],
  industrial: ['BCM', 'KBC', 'IDC', 'SZC', 'GVR', 'GEX', 'PC1', 'VGC', 'BMP', 'DPM', 'DCM', 'DGC', 'CSV', 'PHR', 'DPR', 'GMD', 'HAH'],
  // Group tong hop
  all: Array.from(new Set([...VN30, ...VN70, ...HNX_TOP10, ...UPCOM_TOP10])),
};

// ═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════

export interface ComboCondition {
  indicator: string;
  operator: '>' | '<' | '>=' | '<=' | '==' | 'cross_up' | 'cross_down';
  value: number | string;
  period?: number;
}

export interface Combo {
  name: string;
  conditions: ComboCondition[];
}

export interface ComboTrade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  entryIndex: number;
  exitDate: string;
  exitPrice: number;
  pnlPercent: number;        // sau phi
  pnlGrossPercent: number;   // truoc phi
  bestPnlPercent: number;    // sau phi, trong T+5..T+10
  worstPnlPercent: number;   // sau phi
  optimalExitDay: number;
  isWin: boolean;            // pnl sau phi > 0.5%
  signalDetails: Record<string, number>;
}

export interface ComboMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgPnlPercent: number;
  avgPnlGrossPercent: number;
  bestAvgPnlPercent: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpeRatio: number;
  bestTrade: number;
  worstTrade: number;
  optimalAvgExitDay: number;
}

// In-memory progress tracking
interface RunProgress {
  runId: number;
  status: 'idle' | 'fetching' | 'computing' | 'completed' | 'failed';
  currentStep: string;
  progressPercent: number;
  totalSymbols: number;
  totalCombos: number;
  combosCompleted: number;
  startedAt: number;
}

let currentRunProgress: RunProgress = {
  runId: 0,
  status: 'idle',
  currentStep: '',
  progressPercent: 0,
  totalSymbols: 0,
  totalCombos: 0,
  combosCompleted: 0,
  startedAt: 0,
};

export function getCurrentProgress(): RunProgress {
  return { ...currentRunProgress };
}

// ═══════════════════════════════════════════════════
// FETCH HISTORICAL DATA — 5 NAM
// ═══════════════════════════════════════════════════

export async function fetchExtendedPrices(
  symbol: string,
  yearsBack: number = PERIOD_YEARS,
): Promise<PriceData[]> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - yearsBack);

    const fmt = (d: Date) => d.toISOString().split('T')[0];
    const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!response.ok) return [];
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('json')) return [];

    const raw = await response.json() as any[];
    if (!raw || raw.length === 0) return [];

    const data: PriceData[] = raw.map((item: any) => ({
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
    console.warn(`[FullBacktest] ⚠️ Fetch ${symbol} that bai: ${e.message}`);
    return [];
  }
}

/**
 * Fetch OHLCV cho VN100 + HNX + UPCoM, filter qua thanh khoan
 */
export async function fetchUniverseFiltered(): Promise<Map<string, PriceData[]>> {
  const priceMap = new Map<string, PriceData[]>();
  const total = FULL_BACKTEST_UNIVERSE.length;
  console.log(`[FullBacktest] 📊 Bat dau fetch ${total} CP (VN100 + HNX top + UPCoM top, 5 nam)...`);

  let processed = 0;
  let skipped = 0;

  for (let i = 0; i < total; i += FETCH_BATCH_SIZE) {
    const batch = FULL_BACKTEST_UNIVERSE.slice(i, i + FETCH_BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (symbol) => ({
        symbol,
        data: await fetchExtendedPrices(symbol, PERIOD_YEARS),
      })),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { symbol, data } = r.value;
      if (data.length < MIN_TRADING_DAYS) {
        skipped++;
        continue;
      }

      // Filter: avg vol 20 phien gan nhat >= 200k AND gia hien tai >= 10k
      const last20 = data.slice(-20);
      const avgVol = last20.reduce((s, d) => s + d.volume, 0) / Math.max(last20.length, 1);
      const lastClose = data[data.length - 1].close;

      if (avgVol >= MIN_AVG_VOLUME && lastClose >= MIN_PRICE) {
        priceMap.set(symbol, data);
      } else {
        skipped++;
      }
    }

    processed += batch.length;
    if (processed % 30 === 0 || processed >= total) {
      console.log(`[FullBacktest] ⏳ Fetch ${processed}/${total}, qua filter: ${priceMap.size}`);
      currentRunProgress.currentStep = `Fetching: ${processed}/${total} (${priceMap.size} qua filter)`;
      currentRunProgress.progressPercent = Math.floor((processed / total) * 30);
    }

    if (i + FETCH_BATCH_SIZE < total) {
      await new Promise((r) => setTimeout(r, FETCH_BATCH_DELAY_MS));
    }
  }

  console.log(`[FullBacktest] ✅ Fetch xong: ${priceMap.size} CP qua filter, ${skipped} bo qua`);
  return priceMap;
}

// ═══════════════════════════════════════════════════
// INDICATOR PRECOMPUTATION
// ═══════════════════════════════════════════════════

interface PrecomputedIndicators {
  closes: number[];
  volumes: number[];
  ma10: number[];
  ma20: number[];
  ma50: number[];
  ma100: number[];
  ma150: number[];
  ma200: number[];
  rsi: number[];
  macdHist: number[];
  macdLine: number[];
  macdSignal: number[];
  adx: number[];
  plusDI: number[];
  minusDI: number[];
  volumeRatio20: number[];
  high20: number[];
  high50: number[];
}

export function precomputeIndicators(data: PriceData[]): PrecomputedIndicators {
  const closes = data.map(d => d.close);
  const volumes = data.map(d => d.volume);

  const ma10 = calcSMA(closes, 10);
  const ma20 = calcSMA(closes, 20);
  const ma50 = calcSMA(closes, 50);
  const ma100 = calcSMA(closes, 100);
  const ma150 = calcSMA(closes, 150);
  const ma200 = calcSMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const macdHist = calcMACDHistogram(closes);

  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine: number[] = closes.map((_, i) => ema12[i] - ema26[i]);
  const macdSignal = calcEMA(macdLine, 9);

  const adx = calcADX(data, 14);
  const dmi = calcDMI(data, 14);

  const volumeRatio20: number[] = [];
  for (let i = 0; i < data.length; i++) {
    volumeRatio20.push(calcVolumeRatio(volumes, i));
  }

  const high20: number[] = [];
  const high50: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < 20) high20.push(0);
    else {
      let h = -Infinity;
      for (let j = i - 19; j <= i; j++) h = Math.max(h, closes[j]);
      high20.push(h);
    }
    if (i < 50) high50.push(0);
    else {
      let h = -Infinity;
      for (let j = i - 49; j <= i; j++) h = Math.max(h, closes[j]);
      high50.push(h);
    }
  }

  return {
    closes, volumes,
    ma10, ma20, ma50, ma100, ma150, ma200,
    rsi, macdHist, macdLine, macdSignal,
    adx, plusDI: dmi.plusDI, minusDI: dmi.minusDI,
    volumeRatio20, high20, high50,
  };
}

// ═══════════════════════════════════════════════════
// SIGNAL EVALUATION
// ═══════════════════════════════════════════════════

function getMa(ind: PrecomputedIndicators, period: number): number[] | null {
  switch (period) {
    case 10: return ind.ma10;
    case 20: return ind.ma20;
    case 50: return ind.ma50;
    case 100: return ind.ma100;
    case 150: return ind.ma150;
    case 200: return ind.ma200;
  }
  return null;
}

function compareNumber(a: number, op: ComboCondition['operator'], b: number): boolean {
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '==': return Math.abs(a - b) < 0.001;
  }
  return false;
}

function evalCondition(
  cond: ComboCondition,
  ind: PrecomputedIndicators,
  i: number,
): boolean {
  if (i < 1) return false;
  const close = ind.closes[i];

  switch (cond.indicator) {
    case 'rsi': {
      return compareNumber(ind.rsi[i], cond.operator, cond.value as number);
    }
    case 'macd_hist': {
      return compareNumber(ind.macdHist[i], cond.operator, cond.value as number);
    }
    case 'macd_cross_up': {
      return ind.macdLine[i - 1] <= ind.macdSignal[i - 1] && ind.macdLine[i] > ind.macdSignal[i];
    }
    case 'macd_hist_rising_3d': {
      if (i < 3) return false;
      return ind.macdHist[i] > ind.macdHist[i - 1] &&
             ind.macdHist[i - 1] > ind.macdHist[i - 2] &&
             ind.macdHist[i - 2] > ind.macdHist[i - 3];
    }
    case 'volume_ratio': {
      return compareNumber(ind.volumeRatio20[i], cond.operator, cond.value as number);
    }
    case 'volume_rising_3d': {
      if (i < 3) return false;
      return ind.volumes[i] > ind.volumes[i - 1] &&
             ind.volumes[i - 1] > ind.volumes[i - 2] &&
             ind.volumes[i - 2] > ind.volumes[i - 3];
    }
    case 'adx': {
      return compareNumber(ind.adx[i], cond.operator, cond.value as number);
    }
    case 'adx_rising_3d': {
      // ADX tang lien tiep 3 phien — xu huong dang manh dan
      if (i < 3) return false;
      return ind.adx[i] > ind.adx[i - 1] &&
             ind.adx[i - 1] > ind.adx[i - 2] &&
             ind.adx[i] > 20;
    }
    case 'di_plus_above_minus': {
      return ind.plusDI[i] > ind.minusDI[i];
    }
    case 'di_plus_strong': {
      // +DI > -DI VA +DI - (-DI) > value (do chenh lech buyer/seller)
      const diff = ind.plusDI[i] - ind.minusDI[i];
      return compareNumber(diff, cond.operator, cond.value as number);
    }
    case 'price_above_ma': {
      const ma = getMa(ind, cond.period || 50);
      if (!ma || ma[i] <= 0) return false;
      return close > ma[i];
    }
    case 'ma_cross_above': {
      const fastPeriod = cond.period || 10;
      const slowPeriod = (cond.value as number) || 50;
      const fast = getMa(ind, fastPeriod);
      const slow = getMa(ind, slowPeriod);
      if (!fast || !slow || fast[i] <= 0 || slow[i] <= 0) return false;
      return fast[i] > slow[i];
    }
    case 'ma_stack_perfect': {
      // Stage 2 Minervini: MA10>MA20>MA50>MA100>MA150>MA200
      if (ind.ma10[i] <= 0 || ind.ma200[i] <= 0) return false;
      return ind.ma10[i] > ind.ma20[i] &&
             ind.ma20[i] > ind.ma50[i] &&
             ind.ma50[i] > ind.ma100[i] &&
             ind.ma100[i] > ind.ma150[i] &&
             ind.ma150[i] > ind.ma200[i];
    }
    case 'breakout_20d_high': {
      if (ind.high20[i - 1] <= 0) return false;
      return close > ind.high20[i - 1];
    }
    case 'breakout_50d_high': {
      if (ind.high50[i - 1] <= 0) return false;
      return close > ind.high50[i - 1];
    }
    case 'gap_up_2pct': {
      if (i < 1) return false;
      return close >= ind.closes[i - 1] * 1.02;
    }
  }
  return false;
}

export function evalCombo(combo: Combo, ind: PrecomputedIndicators, i: number): boolean {
  for (const cond of combo.conditions) {
    if (!evalCondition(cond, ind, i)) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════
// SIGNAL → TRADE — Tinh P&L sau phi 0.3%
// ═══════════════════════════════════════════════════

function buildTrade(
  symbol: string,
  data: PriceData[],
  ind: PrecomputedIndicators,
  entryIndex: number,
): ComboTrade | null {
  const entryPrice = data[entryIndex].close;
  if (entryPrice <= 0) return null;

  let bestPnlGross = -Infinity;
  let worstPnlGross = Infinity;
  let optimalDay = HOLD_DEFAULT;
  let defaultExitPrice = 0;
  let defaultExitDate = '';

  for (let t = HOLD_MIN; t <= HOLD_MAX; t++) {
    const exitIdx = entryIndex + t;
    if (exitIdx >= data.length) break;
    const exitPrice = data[exitIdx].close;
    const pnlGross = ((exitPrice - entryPrice) / entryPrice) * 100;

    if (pnlGross > bestPnlGross) {
      bestPnlGross = pnlGross;
      optimalDay = t;
    }
    if (pnlGross < worstPnlGross) worstPnlGross = pnlGross;

    if (t === HOLD_DEFAULT) {
      defaultExitPrice = exitPrice;
      defaultExitDate = data[exitIdx].date;
    }
  }

  if (defaultExitPrice === 0) {
    const exitIdx = Math.min(entryIndex + HOLD_MAX, data.length - 1);
    if (exitIdx <= entryIndex) return null;
    defaultExitPrice = data[exitIdx].close;
    defaultExitDate = data[exitIdx].date;
  }

  const pnlGross = ((defaultExitPrice - entryPrice) / entryPrice) * 100;
  // P&L sau phi: tru 0.3% round-trip
  const pnlNet = pnlGross - FEE_ROUND_TRIP_PCT;
  const bestPnlNet = bestPnlGross === -Infinity ? -FEE_ROUND_TRIP_PCT : (bestPnlGross - FEE_ROUND_TRIP_PCT);
  const worstPnlNet = worstPnlGross === Infinity ? -FEE_ROUND_TRIP_PCT : (worstPnlGross - FEE_ROUND_TRIP_PCT);

  const signalDetails: Record<string, number> = {
    rsi: round2(ind.rsi[entryIndex]),
    macd_hist: round4(ind.macdHist[entryIndex]),
    vol_ratio: round2(ind.volumeRatio20[entryIndex]),
    adx: round2(ind.adx[entryIndex]),
    plus_di: round2(ind.plusDI[entryIndex]),
    minus_di: round2(ind.minusDI[entryIndex]),
    di_diff: round2(ind.plusDI[entryIndex] - ind.minusDI[entryIndex]),
    close: entryPrice,
    ma10: round2(ind.ma10[entryIndex]),
    ma50: round2(ind.ma50[entryIndex]),
    ma200: round2(ind.ma200[entryIndex]),
  };

  return {
    symbol,
    entryDate: data[entryIndex].date,
    entryPrice,
    entryIndex,
    exitDate: defaultExitDate,
    exitPrice: defaultExitPrice,
    pnlPercent: round2(pnlNet),
    pnlGrossPercent: round2(pnlGross),
    bestPnlPercent: round2(bestPnlNet),
    worstPnlPercent: round2(worstPnlNet),
    optimalExitDay: optimalDay,
    isWin: pnlNet > WIN_THRESHOLD_PCT,
    signalDetails,
  };
}

function round2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// ═══════════════════════════════════════════════════
// RUN BACKTEST 1 COMBO TREN 1 GROUP
// ═══════════════════════════════════════════════════

export function backtestComboOnGroup(
  combo: Combo,
  groupSymbols: string[],
  precomputedMap: Map<string, PrecomputedIndicators>,
  rawDataMap: Map<string, PriceData[]>,
): { trades: ComboTrade[]; metrics: ComboMetrics; symbolsTested: number } {
  const trades: ComboTrade[] = [];
  let symbolsTested = 0;

  for (const symbol of groupSymbols) {
    const ind = precomputedMap.get(symbol);
    const data = rawDataMap.get(symbol);
    if (!ind || !data) continue;
    symbolsTested++;

    const startIdx = Math.max(200, 30);
    const endIdx = data.length - HOLD_MAX - 1;

    for (let i = startIdx; i < endIdx; i++) {
      if (!evalCombo(combo, ind, i)) continue;

      const trade = buildTrade(symbol, data, ind, i);
      if (trade) {
        trades.push(trade);
        i += 5; // skip overlap
      }
    }
  }

  return { trades, metrics: computeMetrics(trades), symbolsTested };
}

export function computeMetrics(trades: ComboTrade[]): ComboMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0,
      avgPnlPercent: 0, avgPnlGrossPercent: 0, bestAvgPnlPercent: 0,
      maxDrawdown: 0, profitFactor: 0, sharpeRatio: 0,
      bestTrade: 0, worstTrade: 0, optimalAvgExitDay: HOLD_DEFAULT,
    };
  }

  const winCount = trades.filter(t => t.isWin).length;
  const lossCount = trades.length - winCount;
  const winRate = (winCount / trades.length) * 100;

  const pnls = trades.map(t => t.pnlPercent);          // sau phi
  const pnlsGross = trades.map(t => t.pnlGrossPercent); // truoc phi
  const bestPnls = trades.map(t => t.bestPnlPercent);

  const avgPnl = pnls.reduce((s, p) => s + p, 0) / pnls.length;
  const avgPnlGross = pnlsGross.reduce((s, p) => s + p, 0) / pnlsGross.length;
  const bestAvgPnl = bestPnls.reduce((s, p) => s + p, 0) / bestPnls.length;

  const totalProfit = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0);
  const totalLoss = Math.abs(pnls.filter(p => p < 0).reduce((s, p) => s + p, 0));
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 99.99 : 0);

  const mean = avgPnl;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
  const stddev = Math.sqrt(variance);
  const sharpe = stddev > 0 ? mean / stddev : 0;

  let equity = 100, peak = 100, maxDD = 0;
  for (const p of pnls) {
    equity *= (1 + p / 100);
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const bestTrade = Math.max(...pnls);
  const worstTrade = Math.min(...pnls);
  const avgOptimalDay = trades.reduce((s, t) => s + t.optimalExitDay, 0) / trades.length;

  return {
    totalTrades: trades.length,
    winCount, lossCount,
    winRate: round2(winRate),
    avgPnlPercent: round2(avgPnl),
    avgPnlGrossPercent: round2(avgPnlGross),
    bestAvgPnlPercent: round2(bestAvgPnl),
    maxDrawdown: round2(maxDD),
    profitFactor: round2(profitFactor),
    sharpeRatio: round2(sharpe),
    bestTrade: round2(bestTrade),
    worstTrade: round2(worstTrade),
    optimalAvgExitDay: round2(avgOptimalDay),
  };
}

// ═══════════════════════════════════════════════════
// FULL ORCHESTRATION
// ═══════════════════════════════════════════════════

export async function runFullBacktest(opts?: {
  storeTradesPerCombo?: number;
  triggerType?: 'manual' | 'scheduler';
}): Promise<number> {
  const storeTradesPerCombo = opts?.storeTradesPerCombo ?? 100;
  const triggerType = opts?.triggerType ?? 'manual';
  const startedAt = Date.now();
  const periodEnd = new Date().toISOString().split('T')[0];
  const periodStartDate = new Date();
  periodStartDate.setFullYear(periodStartDate.getFullYear() - PERIOD_YEARS);
  const periodStart = periodStartDate.toISOString().split('T')[0];

  const db = getDatabase();
  if (!db) throw new Error('Database not ready');

  const runRecord: NewFullBacktestRun = {
    triggerType,
    periodStart,
    periodEnd,
    totalSymbols: 0,
    totalCombos: 0,
    totalTrades: 0,
    totalResults: 0,
    status: 'running',
    progressPercent: 0,
    currentStep: 'starting',
    startedAt,
  };
  const inserted = db.insert(fullBacktestRuns).values(runRecord).returning({ id: fullBacktestRuns.id }).get();
  const runId = inserted?.id || 0;

  currentRunProgress = {
    runId,
    status: 'fetching',
    currentStep: 'Bat dau fetch 5 nam OHLCV (VN100 + HNX + UPCoM)...',
    progressPercent: 0,
    totalSymbols: 0,
    totalCombos: 0,
    combosCompleted: 0,
    startedAt,
  };

  const { generateCombos } = await import('./combo-finder.service.js');
  const combos = generateCombos();
  currentRunProgress.totalCombos = combos.length;
  console.log(`[FullBacktest] 🔬 Run ${runId}: ${combos.length} combos × ${Object.keys(STOCK_GROUPS).length} groups`);

  try {
    // Phase 1: Fetch
    const priceMap = await fetchUniverseFiltered();
    if (priceMap.size === 0) {
      throw new Error('Khong fetch duoc CP nao qua filter (vol > 200k, gia > 10k)');
    }
    currentRunProgress.totalSymbols = priceMap.size;
    db.update(fullBacktestRuns)
      .set({ totalSymbols: priceMap.size, totalCombos: combos.length, currentStep: 'Pre-computing indicators...' })
      .where(eq(fullBacktestRuns.id, runId))
      .run();

    // Phase 2: Precompute indicators
    currentRunProgress.status = 'computing';
    currentRunProgress.currentStep = 'Pre-computing indicators...';
    currentRunProgress.progressPercent = 30;
    const precomputedMap = new Map<string, PrecomputedIndicators>();
    let pcCount = 0;
    for (const [symbol, data] of priceMap) {
      try {
        precomputedMap.set(symbol, precomputeIndicators(data));
      } catch (e: any) {
        console.warn(`[FullBacktest] ⚠️ Precompute ${symbol} fail: ${e.message}`);
      }
      pcCount++;
      if (pcCount % 20 === 0) {
        currentRunProgress.currentStep = `Pre-computing: ${pcCount}/${priceMap.size}`;
        currentRunProgress.progressPercent = 30 + Math.floor((pcCount / priceMap.size) * 10);
      }
    }
    console.log(`[FullBacktest] ✅ Pre-computed indicators cho ${precomputedMap.size} CP`);

    // Phase 3: Loop combos × groups
    currentRunProgress.currentStep = 'Backtesting combos...';
    let totalTrades = 0;
    let totalResults = 0;
    let bestComboName = '';
    let bestWinRate = 0;
    let bestAvgPnl = -Infinity;

    const groupNames = Object.keys(STOCK_GROUPS);
    const totalIterations = combos.length * groupNames.length;
    let iterDone = 0;

    for (let cIdx = 0; cIdx < combos.length; cIdx++) {
      const combo = combos[cIdx];

      for (const groupName of groupNames) {
        const groupSymbols = STOCK_GROUPS[groupName].filter(s => precomputedMap.has(s));
        if (groupSymbols.length === 0) {
          iterDone++;
          continue;
        }

        try {
          const { trades, metrics, symbolsTested } = backtestComboOnGroup(
            combo, groupSymbols, precomputedMap, priceMap,
          );

          if (metrics.totalTrades === 0) {
            iterDone++;
            continue;
          }

          // Insert combo result (giu rieng ca low confidence theo yeu cau anh Si)
          const isLowConf = metrics.totalTrades < LOW_CONF_THRESHOLD;
          const resultRecord: NewBacktestComboResult = {
            runId,
            comboName: combo.name,
            comboConditions: JSON.stringify(combo.conditions),
            stockGroup: groupName,
            symbolsTested,
            totalTrades: metrics.totalTrades,
            winCount: metrics.winCount,
            lossCount: metrics.lossCount,
            winRate: metrics.winRate,
            avgPnlPercent: metrics.avgPnlPercent,
            avgPnlGrossPercent: metrics.avgPnlGrossPercent,
            bestAvgPnlPercent: metrics.bestAvgPnlPercent,
            maxDrawdown: metrics.maxDrawdown,
            profitFactor: metrics.profitFactor,
            sharpeRatio: metrics.sharpeRatio,
            bestTrade: metrics.bestTrade,
            worstTrade: metrics.worstTrade,
            optimalAvgExitDay: metrics.optimalAvgExitDay,
            isLowConfidence: isLowConf ? 1 : 0,
            computedAt: Date.now(),
          };
          const resInserted = db.insert(backtestComboResults).values(resultRecord)
            .returning({ id: backtestComboResults.id }).get();
          const resultId = resInserted?.id || 0;

          // Insert top N trades
          if (resultId > 0 && trades.length > 0) {
            const sortedByPnl = [...trades].sort((a, b) => b.pnlPercent - a.pnlPercent);
            const tradesToStore = sortedByPnl.slice(0, storeTradesPerCombo);

            for (const t of tradesToStore) {
              const tradeRecord: NewBacktestComboTrade = {
                resultId,
                symbol: t.symbol,
                entryDate: t.entryDate,
                entryPrice: t.entryPrice,
                exitDate: t.exitDate,
                exitPrice: t.exitPrice,
                pnlPercent: t.pnlPercent,
                pnlGrossPercent: t.pnlGrossPercent,
                bestPnlPercent: t.bestPnlPercent,
                worstPnlPercent: t.worstPnlPercent,
                optimalExitDay: t.optimalExitDay,
                isWin: t.isWin ? 1 : 0,
                signalDetails: JSON.stringify(t.signalDetails),
              };
              try {
                db.insert(backtestComboTrades).values(tradeRecord).run();
              } catch { /* ignore */ }
            }
          }

          totalTrades += metrics.totalTrades;
          totalResults++;

          // Track best combo: chi xet group=all VA khong phai low confidence
          if (groupName === 'all' && !isLowConf && metrics.avgPnlPercent > bestAvgPnl) {
            bestAvgPnl = metrics.avgPnlPercent;
            bestWinRate = metrics.winRate;
            bestComboName = combo.name;
          }
        } catch (e: any) {
          console.warn(`[FullBacktest] ⚠️ "${combo.name}" group ${groupName}: ${e.message}`);
        }

        iterDone++;
      }

      currentRunProgress.combosCompleted = cIdx + 1;
      const pct = 40 + Math.floor((iterDone / totalIterations) * 55);
      currentRunProgress.progressPercent = pct;
      currentRunProgress.currentStep = `Combo ${cIdx + 1}/${combos.length}: ${combo.name}`;
      if ((cIdx + 1) % 5 === 0 || cIdx === combos.length - 1) {
        db.update(fullBacktestRuns)
          .set({
            progressPercent: pct,
            currentStep: currentRunProgress.currentStep,
            totalTrades,
            totalResults,
          })
          .where(eq(fullBacktestRuns.id, runId))
          .run();
      }
    }

    // Phase 4: Finalize
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    db.update(fullBacktestRuns)
      .set({
        totalSymbols: priceMap.size,
        totalCombos: combos.length,
        totalTrades,
        totalResults,
        bestComboName: bestComboName || null,
        bestWinRate: bestWinRate || null,
        bestAvgPnl: Number.isFinite(bestAvgPnl) ? bestAvgPnl : null,
        status: 'completed',
        progressPercent: 100,
        currentStep: 'completed',
        completedAt,
        durationMs,
      })
      .where(eq(fullBacktestRuns.id, runId))
      .run();

    currentRunProgress.status = 'completed';
    currentRunProgress.progressPercent = 100;
    currentRunProgress.currentStep = `Hoan thanh: ${totalResults} ket qua, ${totalTrades} trades`;

    console.log(`[FullBacktest] ✅ Run ${runId} xong: ${totalResults} results, ${totalTrades} trades, ${Math.round(durationMs / 1000)}s`);

    // Notify admin via Zalo neu best combo dat win > 55% va avg P&L > 2% (sau phi)
    try {
      if (bestComboName && bestWinRate >= 55 && bestAvgPnl >= 2) {
        await notifyAdminBestCombo(runId, bestComboName, bestWinRate, bestAvgPnl);
      }
    } catch (e: any) {
      console.warn(`[FullBacktest] ⚠️ Notify admin fail: ${e.message}`);
    }

    return runId;
  } catch (e: any) {
    console.warn(`[FullBacktest] ⚠️ Run ${runId} fail: ${e.message}`);
    currentRunProgress.status = 'failed';
    currentRunProgress.currentStep = `Failed: ${e.message}`;

    db.update(fullBacktestRuns)
      .set({
        status: 'failed',
        errorMessage: e.message,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      })
      .where(eq(fullBacktestRuns.id, runId))
      .run();

    throw e;
  }
}

// ═══════════════════════════════════════════════════
// NOTIFICATION
// ═══════════════════════════════════════════════════

const ADMIN_UID = '7307295734920277074';

async function notifyAdminBestCombo(
  runId: number,
  comboName: string,
  winRate: number,
  avgPnl: number,
): Promise<void> {
  try {
    const { container, Services } = await import('../../core/index.js');
    const api: any = container.get(Services.ZALO_API);
    if (!api) return;

    const message = `🔬 Full Backtest #${runId} hoan thanh\n` +
      `🏆 Best combo: ${comboName}\n` +
      `📈 Win rate: ${winRate.toFixed(1)}%, Avg P&L (sau phi): +${avgPnl.toFixed(2)}%\n` +
      `📊 Xem matrix: /api/strategy/full-backtest/dashboard`;

    await api.sendMessage({ msg: message, mentions: [] }, ADMIN_UID, 0).catch(() => {});
    console.log(`[FullBacktest] 📢 Da notify admin: ${comboName}`);
  } catch (e: any) {
    console.warn(`[FullBacktest] ⚠️ notifyAdmin: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════
// SCHEDULER — Daily 19:00 VN
// ═══════════════════════════════════════════════════

let lastSchedulerRunDate = '';

export function startFullBacktestScheduler(): void {
  console.log('[FullBacktest] 🔬 Khoi dong Full Backtest scheduler (daily 19:00 VN, T2-T6)');

  setInterval(async () => {
    try {
      const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
      const vnHour = vnNow.getHours();
      const vnMinute = vnNow.getMinutes();
      const vnDay = vnNow.getDay(); // 0=Sun

      // Chay T2-T6 (1-5), 19:00-19:05
      if (vnDay < 1 || vnDay > 5) return;
      if (vnHour !== 19 || vnMinute < 0 || vnMinute > 5) return;

      const dateStr = vnNow.toISOString().split('T')[0];
      if (lastSchedulerRunDate === dateStr) return;
      lastSchedulerRunDate = dateStr;

      console.log('[FullBacktest] ⏰ 19:00 VN — bat dau daily full backtest');
      try {
        await runFullBacktest({ triggerType: 'scheduler' });
      } catch (e: any) {
        console.warn(`[FullBacktest] ⚠️ Daily run fail: ${e.message}`);
      }
    } catch (e: any) {
      console.warn(`[FullBacktest] ⚠️ Scheduler interval error: ${e.message}`);
    }
  }, 60 * 1000);
}

// ═══════════════════════════════════════════════════
// QUERY HELPERS — Cho API
// ═══════════════════════════════════════════════════

export async function getRunById(runId: number): Promise<any> {
  const db = getDatabase();
  if (!db) return null;
  return db.select().from(fullBacktestRuns).where(eq(fullBacktestRuns.id, runId)).get();
}

export async function getLatestRun(): Promise<any> {
  const db = getDatabase();
  if (!db) return null;
  return db.select().from(fullBacktestRuns).orderBy(desc(fullBacktestRuns.startedAt)).limit(1).get();
}

export async function getResultsByRun(runId: number): Promise<any[]> {
  const db = getDatabase();
  if (!db) return [];
  return db.select().from(backtestComboResults)
    .where(eq(backtestComboResults.runId, runId))
    .orderBy(desc(backtestComboResults.avgPnlPercent))
    .all();
}

export async function getTradesByResult(resultId: number, limit: number = 100): Promise<any[]> {
  const db = getDatabase();
  if (!db) return [];
  return db.select().from(backtestComboTrades)
    .where(eq(backtestComboTrades.resultId, resultId))
    .orderBy(desc(backtestComboTrades.pnlPercent))
    .limit(limit)
    .all();
}
