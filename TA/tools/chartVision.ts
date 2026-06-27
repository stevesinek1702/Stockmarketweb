/**
 * Chart Vision Analysis - Phân tích chart bằng AI Vision
 * 
 * Features:
 * - Tự vẽ candlestick chart với @napi-rs/canvas
 * - Multi-timeframe: 1H, 4H, D, W
 * - Đỉnh 52W & ATH (All-Time High)
 * - VCP Pattern (Volatility Contraction Pattern) - Mark Minervini
 * - Gemini 2.0 Flash Vision để phân tích
 */

import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';

// ═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════

export interface OHLCV {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '1H' | '4H' | 'D' | 'W';

export interface ChartAnalysisResult {
  chartImage: Buffer;
  priceData: {
    current: number;
    high52W: number;
    low52W: number;
    ath: number;
    atl: number;
    distanceFrom52WH: number; // % từ đỉnh 52W
    distanceFromATH: number;  // % từ ATH
  };
  vcpAnalysis: VCPResult;
  timeframe: Timeframe;
}

export interface VCPResult {
  isVCP: boolean;
  contractions: number;        // Số lần co hẹp
  volatilityReduction: number; // % giảm biên độ
  pivotPoint: number;          // Điểm pivot (breakout)
  stage: 'forming' | 'ready' | 'breakout' | 'none';
  description: string;
}

// ═══════════════════════════════════════════════════
// CHART DRAWING
// ═══════════════════════════════════════════════════

const CHART_WIDTH = 1200;
const CHART_HEIGHT = 800;
const PADDING = { top: 60, right: 80, bottom: 100, left: 80 };
const VOLUME_HEIGHT = 120;

// Colors
const COLORS = {
  background: '#1a1a2e',
  grid: '#2d2d44',
  text: '#e0e0e0',
  textMuted: '#888888',
  bullish: '#00c853',    // Xanh lá - tăng
  bearish: '#ff1744',    // Đỏ - giảm
  volume: '#4a4a6a',
  ma10: '#ffeb3b',       // Vàng
  ma20: '#2196f3',       // Xanh dương
  ma50: '#ff9800',       // Cam
  ma200: '#e91e63',      // Hồng
  pivot: '#00bcd4',      // Cyan - pivot point
  ath: '#ffd700',        // Vàng gold - ATH
  high52w: '#ff6b6b',    // Đỏ nhạt - 52W High
};

/**
 * Vẽ candlestick chart
 */
export function drawCandlestickChart(
  data: OHLCV[],
  symbol: string,
  timeframe: Timeframe,
  priceInfo: ChartAnalysisResult['priceData'],
  vcpResult: VCPResult
): Buffer {
  const canvas = createCanvas(CHART_WIDTH, CHART_HEIGHT);
  const ctx = canvas.getContext('2d');
  
  // Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);
  
  // Chart area dimensions
  const chartArea = {
    x: PADDING.left,
    y: PADDING.top,
    width: CHART_WIDTH - PADDING.left - PADDING.right,
    height: CHART_HEIGHT - PADDING.top - PADDING.bottom - VOLUME_HEIGHT,
  };
  
  const volumeArea = {
    x: PADDING.left,
    y: chartArea.y + chartArea.height + 20,
    width: chartArea.width,
    height: VOLUME_HEIGHT - 20,
  };
  
  // Calculate price range
  const prices = data.flatMap(d => [d.high, d.low]);
  const minPrice = Math.min(...prices) * 0.98;
  const maxPrice = Math.max(...prices) * 1.02;
  const priceRange = maxPrice - minPrice;
  
  // Calculate volume range
  const volumes = data.map(d => d.volume);
  const maxVolume = Math.max(...volumes);
  
  // Draw grid
  drawGrid(ctx, chartArea, minPrice, maxPrice);
  
  // Calculate MA values
  const ma10 = calculateMA(data, 10);
  const ma20 = calculateMA(data, 20);
  const ma50 = calculateMA(data, 50);
  
  // Draw MA lines
  drawMALine(ctx, data, ma10, chartArea, minPrice, priceRange, COLORS.ma10, 'MA10');
  drawMALine(ctx, data, ma20, chartArea, minPrice, priceRange, COLORS.ma20, 'MA20');
  if (data.length >= 50) {
    drawMALine(ctx, data, ma50, chartArea, minPrice, priceRange, COLORS.ma50, 'MA50');
  }
  
  // Draw price levels (52W High, ATH)
  drawPriceLevel(ctx, chartArea, priceInfo.high52W, minPrice, priceRange, COLORS.high52w, '52W High');
  if (priceInfo.ath > priceInfo.high52W * 1.01) {
    drawPriceLevel(ctx, chartArea, priceInfo.ath, minPrice, priceRange, COLORS.ath, 'ATH');
  }
  
  // Draw VCP pivot if applicable
  if (vcpResult.isVCP && vcpResult.pivotPoint > 0) {
    drawPriceLevel(ctx, chartArea, vcpResult.pivotPoint, minPrice, priceRange, COLORS.pivot, 'Pivot');
  }
  
  // Draw candlesticks
  const candleWidth = Math.max(2, (chartArea.width / data.length) * 0.7);
  const gap = chartArea.width / data.length;
  
  data.forEach((candle, i) => {
    const x = chartArea.x + i * gap + gap / 2;
    const isBullish = candle.close >= candle.open;
    const color = isBullish ? COLORS.bullish : COLORS.bearish;
    
    // Wick (bóng nến)
    const highY = chartArea.y + chartArea.height - ((candle.high - minPrice) / priceRange) * chartArea.height;
    const lowY = chartArea.y + chartArea.height - ((candle.low - minPrice) / priceRange) * chartArea.height;
    
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();
    
    // Body (thân nến)
    const openY = chartArea.y + chartArea.height - ((candle.open - minPrice) / priceRange) * chartArea.height;
    const closeY = chartArea.y + chartArea.height - ((candle.close - minPrice) / priceRange) * chartArea.height;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(closeY - openY));
    
    ctx.fillStyle = color;
    ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
  });
  
  // Draw volume bars
  data.forEach((candle, i) => {
    const x = chartArea.x + i * gap + gap / 2;
    const isBullish = candle.close >= candle.open;
    const color = isBullish ? COLORS.bullish + '80' : COLORS.bearish + '80';
    
    const volHeight = (candle.volume / maxVolume) * volumeArea.height;
    const volY = volumeArea.y + volumeArea.height - volHeight;
    
    ctx.fillStyle = color;
    ctx.fillRect(x - candleWidth / 2, volY, candleWidth, volHeight);
  });
  
  // Draw title and info
  drawTitle(ctx, symbol, timeframe, priceInfo, vcpResult);
  
  // Draw legend
  drawLegend(ctx);
  
  // Draw Y-axis labels (prices)
  drawYAxisLabels(ctx, chartArea, minPrice, maxPrice);
  
  // Draw X-axis labels (dates)
  drawXAxisLabels(ctx, data, chartArea);
  
  return canvas.toBuffer('image/png');
}

function drawGrid(ctx: SKRSContext2D, area: { x: number; y: number; width: number; height: number }, minPrice: number, maxPrice: number) {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 0.5;
  
  // Horizontal lines
  const priceSteps = 5;
  for (let i = 0; i <= priceSteps; i++) {
    const y = area.y + (i / priceSteps) * area.height;
    ctx.beginPath();
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.width, y);
    ctx.stroke();
  }
  
  // Vertical lines
  const timeSteps = 10;
  for (let i = 0; i <= timeSteps; i++) {
    const x = area.x + (i / timeSteps) * area.width;
    ctx.beginPath();
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.height);
    ctx.stroke();
  }
}

function calculateMA(data: OHLCV[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      const sum = data.slice(i - period + 1, i + 1).reduce((acc, d) => acc + d.close, 0);
      result.push(sum / period);
    }
  }
  return result;
}

function drawMALine(
  ctx: SKRSContext2D,
  data: OHLCV[],
  maValues: number[],
  area: { x: number; y: number; width: number; height: number },
  minPrice: number,
  priceRange: number,
  color: string,
  _label: string
) {
  const gap = area.width / data.length;
  
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  
  let started = false;
  maValues.forEach((ma, i) => {
    if (isNaN(ma)) return;
    
    const x = area.x + i * gap + gap / 2;
    const y = area.y + area.height - ((ma - minPrice) / priceRange) * area.height;
    
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  ctx.stroke();
}

function drawPriceLevel(
  ctx: SKRSContext2D,
  area: { x: number; y: number; width: number; height: number },
  price: number,
  minPrice: number,
  priceRange: number,
  color: string,
  label: string
) {
  const y = area.y + area.height - ((price - minPrice) / priceRange) * area.height;
  
  // Check if price is within visible range
  if (y < area.y || y > area.y + area.height) return;
  
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(area.x, y);
  ctx.lineTo(area.x + area.width, y);
  ctx.stroke();
  ctx.setLineDash([]);
  
  // Label
  ctx.fillStyle = color;
  ctx.font = '11px Arial';
  ctx.fillText(`${label}: ${formatPrice(price)}`, area.x + area.width + 5, y + 4);
}

function drawTitle(
  ctx: SKRSContext2D,
  symbol: string,
  timeframe: Timeframe,
  priceInfo: ChartAnalysisResult['priceData'],
  vcpResult: VCPResult
) {
  // Symbol and timeframe
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 24px Arial';
  ctx.fillText(`${symbol} - ${timeframe}`, PADDING.left, 35);
  
  // Current price
  ctx.font = '16px Arial';
  ctx.fillText(`Giá: ${formatPrice(priceInfo.current)}`, PADDING.left + 200, 35);
  
  // Distance from highs
  const dist52W = priceInfo.distanceFrom52WH.toFixed(1);
  const distATH = priceInfo.distanceFromATH.toFixed(1);
  ctx.fillStyle = COLORS.textMuted;
  ctx.font = '12px Arial';
  ctx.fillText(`52W High: -${dist52W}% | ATH: -${distATH}%`, PADDING.left + 350, 35);
  
  // VCP status
  if (vcpResult.isVCP) {
    ctx.fillStyle = COLORS.pivot;
    ctx.font = 'bold 12px Arial';
    const vcpText = `VCP: ${vcpResult.stage.toUpperCase()} (${vcpResult.contractions} contractions)`;
    ctx.fillText(vcpText, PADDING.left + 550, 35);
  }
}

function drawLegend(ctx: SKRSContext2D) {
  const legendY = CHART_HEIGHT - 25;
  const items = [
    { color: COLORS.ma10, label: 'MA10' },
    { color: COLORS.ma20, label: 'MA20' },
    { color: COLORS.ma50, label: 'MA50' },
    { color: COLORS.high52w, label: '52W High' },
    { color: COLORS.pivot, label: 'Pivot' },
  ];
  
  let x = PADDING.left;
  ctx.font = '11px Arial';
  
  items.forEach(item => {
    ctx.fillStyle = item.color;
    ctx.fillRect(x, legendY - 8, 15, 3);
    ctx.fillStyle = COLORS.textMuted;
    ctx.fillText(item.label, x + 20, legendY);
    x += 80;
  });
}

function drawYAxisLabels(
  ctx: SKRSContext2D,
  area: { x: number; y: number; width: number; height: number },
  minPrice: number,
  maxPrice: number
) {
  ctx.fillStyle = COLORS.textMuted;
  ctx.font = '10px Arial';
  
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const price = maxPrice - (i / steps) * (maxPrice - minPrice);
    const y = area.y + (i / steps) * area.height;
    ctx.fillText(formatPrice(price), 5, y + 4);
  }
}

function drawXAxisLabels(
  ctx: SKRSContext2D,
  data: OHLCV[],
  area: { x: number; y: number; width: number; height: number }
) {
  ctx.fillStyle = COLORS.textMuted;
  ctx.font = '10px Arial';
  
  const labelCount = Math.min(10, data.length);
  const step = Math.floor(data.length / labelCount);
  
  for (let i = 0; i < data.length; i += step) {
    const x = area.x + (i / data.length) * area.width;
    const date = data[i].date.split('T')[0];
    const shortDate = date.substring(5); // MM-DD
    ctx.fillText(shortDate, x - 15, area.y + area.height + VOLUME_HEIGHT + 15);
  }
}

function formatPrice(price: number): string {
  if (price >= 1000) {
    return price.toLocaleString('vi-VN', { maximumFractionDigits: 0 });
  }
  return price.toFixed(2);
}

// ═══════════════════════════════════════════════════
// DARVAS BOX DETECTION
// ═══════════════════════════════════════════════════

export interface DarvasBoxResult {
  isInBox: boolean;
  boxTop: number;
  boxBottom: number;
  boxWidth: number;        // Số phiên trong box
  breakoutStatus: 'inside' | 'breakout_up' | 'breakout_down' | 'testing_top' | 'testing_bottom';
  boxStrength: 'weak' | 'moderate' | 'strong';
  description: string;
}

/**
 * Detect Darvas Box Pattern - IMPROVED VERSION
 * 
 * Nguyên tắc Darvas Box:
 * 1. Tìm đỉnh cao nhất trong N phiên gần đây
 * 2. Tìm đáy thấp nhất sau đỉnh đó
 * 3. Kiểm tra giá có vận động trong box không (ít nhất 70% thời gian)
 * 4. Box hợp lệ khi biên độ < 20% và có nhiều lần test đỉnh/đáy
 */
export function detectDarvasBox(data: OHLCV[]): DarvasBoxResult {
  if (data.length < 50) {
    return { isInBox: false, boxTop: 0, boxBottom: 0, boxWidth: 0, breakoutStatus: 'inside', boxStrength: 'weak', description: 'Không đủ dữ liệu' };
  }
  
  const current = data[data.length - 1];
  
  // Tìm box trong nhiều timeframe khác nhau
  const boxes = [
    findBoxInRange(data, 120), // 6 tháng
    findBoxInRange(data, 90),  // ~4.5 tháng
    findBoxInRange(data, 60),  // 3 tháng
    findBoxInRange(data, 40),  // 2 tháng
  ].filter(b => b !== null) as DarvasBoxResult[];
  
  // Chọn box tốt nhất (box mạnh nhất hoặc box lớn nhất)
  if (boxes.length === 0) {
    return { isInBox: false, boxTop: 0, boxBottom: 0, boxWidth: 0, breakoutStatus: 'inside', boxStrength: 'weak', description: 'Không tìm thấy Darvas Box' };
  }
  
  // Ưu tiên box strong > moderate > weak, sau đó ưu tiên box rộng hơn
  boxes.sort((a, b) => {
    const strengthOrder = { strong: 3, moderate: 2, weak: 1 };
    const strengthDiff = strengthOrder[b.boxStrength] - strengthOrder[a.boxStrength];
    if (strengthDiff !== 0) return strengthDiff;
    return b.boxWidth - a.boxWidth;
  });
  
  return boxes[0];
}

function findBoxInRange(data: OHLCV[], lookbackPeriod: number): DarvasBoxResult | null {
  const period = Math.min(lookbackPeriod, data.length);
  const recent = data.slice(-period);
  const current = data[data.length - 1];
  
  // Tính percentile để loại bỏ spike đột biến
  const highs = recent.map(d => d.high).sort((a, b) => a - b);
  const lows = recent.map(d => d.low).sort((a, b) => a - b);
  
  // Lấy percentile 95 cho đỉnh (loại bỏ 5% spike cao nhất)
  const p95Index = Math.floor(highs.length * 0.95);
  const boxTop = highs[p95Index] || highs[highs.length - 1];
  
  // Lấy percentile 5 cho đáy (loại bỏ 5% spike thấp nhất)
  const p5Index = Math.floor(lows.length * 0.05);
  const boxBottom = lows[p5Index] || lows[0];
  
  // Tính biên độ box
  const boxRange = ((boxTop - boxBottom) / boxBottom) * 100;
  
  // Box hợp lệ: biên độ < 20%
  if (boxRange > 20) {
    return null;
  }
  
  // Đếm số phiên giá nằm trong box
  const boxTopThreshold = boxTop * 1.02;
  const boxBottomThreshold = boxBottom * 0.98;
  let candlesInBox = 0;
  let testsAtTop = 0;
  let testsAtBottom = 0;
  
  for (const candle of recent) {
    // Kiểm tra nến có nằm trong box không (body nằm trong box)
    const bodyHigh = Math.max(candle.open, candle.close);
    const bodyLow = Math.min(candle.open, candle.close);
    
    if (bodyHigh <= boxTopThreshold && bodyLow >= boxBottomThreshold) {
      candlesInBox++;
    }
    // Đếm số lần test đỉnh (high >= 98% đỉnh box)
    if (candle.high >= boxTop * 0.98) {
      testsAtTop++;
    }
    // Đếm số lần test đáy (low <= 102% đáy box)
    if (candle.low <= boxBottom * 1.02) {
      testsAtBottom++;
    }
  }
  
  const percentInBox = (candlesInBox / recent.length) * 100;
  
  // Box hợp lệ: ít nhất 65% nến nằm trong box
  if (percentInBox < 65) {
    return null;
  }
  
  const boxWidth = recent.length;
  
  // Xác định breakout status
  let breakoutStatus: DarvasBoxResult['breakoutStatus'] = 'inside';
  const tolerance = (boxTop - boxBottom) * 0.02;
  
  if (current.close > boxTop + tolerance) {
    breakoutStatus = 'breakout_up';
  } else if (current.close < boxBottom - tolerance) {
    breakoutStatus = 'breakout_down';
  } else if (current.high >= boxTop * 0.98) {
    breakoutStatus = 'testing_top';
  } else if (current.low <= boxBottom * 1.02) {
    breakoutStatus = 'testing_bottom';
  }
  
  // Đánh giá độ mạnh của box
  let boxStrength: DarvasBoxResult['boxStrength'] = 'weak';
  
  // Box mạnh: biên độ hẹp (< 10%), nhiều lần test đỉnh/đáy, thời gian dài
  if (boxRange < 10 && testsAtTop >= 4 && testsAtBottom >= 4 && boxWidth >= 60) {
    boxStrength = 'strong';
  } else if (boxRange < 15 && testsAtTop >= 2 && testsAtBottom >= 2 && boxWidth >= 30) {
    boxStrength = 'moderate';
  }
  
  const isInBox = breakoutStatus === 'inside' || breakoutStatus === 'testing_top' || breakoutStatus === 'testing_bottom';
  
  const statusText: Record<string, string> = {
    'inside': 'đang trong box',
    'breakout_up': '🚀 BREAKOUT LÊN',
    'breakout_down': '⚠️ BREAKDOWN',
    'testing_top': 'đang test đỉnh box',
    'testing_bottom': 'đang test đáy box',
  };
  
  const description = `Darvas Box: ${formatPrice(boxBottom)} - ${formatPrice(boxTop)} (${boxRange.toFixed(1)}%), ${boxWidth} phiên, ${statusText[breakoutStatus]}, độ mạnh: ${boxStrength}`;
  
  return { isInBox, boxTop, boxBottom, boxWidth, breakoutStatus, boxStrength, description };
}

// ═══════════════════════════════════════════════════
// PRICE PEAK ANALYSIS (Đỉnh theo timeframe)
// ═══════════════════════════════════════════════════

export interface PricePeakAnalysis {
  current: number;
  peak1M: { price: number; date: string; isAtPeak: boolean };
  peak3M: { price: number; date: string; isAtPeak: boolean };
  peak6M: { price: number; date: string; isAtPeak: boolean };
  peak1Y: { price: number; date: string; isAtPeak: boolean };
  ath: { price: number; date: string; isAtPeak: boolean };
  momentum: 'strong_up' | 'up' | 'neutral' | 'down' | 'strong_down';
  description: string;
}

/**
 * Phân tích đỉnh giá theo các timeframe
 */
export function analyzePricePeaks(data: OHLCV[]): PricePeakAnalysis {
  const current = data[data.length - 1].close;
  const tolerance = 0.02; // 2% tolerance để coi là "tại đỉnh"
  
  // Helper function
  const findPeak = (slice: OHLCV[]) => {
    let maxPrice = 0;
    let maxDate = '';
    slice.forEach(d => {
      if (d.high > maxPrice) {
        maxPrice = d.high;
        maxDate = d.date;
      }
    });
    return { price: maxPrice, date: maxDate, isAtPeak: current >= maxPrice * (1 - tolerance) };
  };
  
  // 1 tháng = ~22 phiên
  const peak1M = findPeak(data.slice(-22));
  // 3 tháng = ~66 phiên
  const peak3M = findPeak(data.slice(-66));
  // 6 tháng = ~132 phiên
  const peak6M = findPeak(data.slice(-132));
  // 1 năm = ~252 phiên
  const peak1Y = findPeak(data.slice(-252));
  // ATH
  const ath = findPeak(data);
  
  // Đánh giá momentum
  let momentum: PricePeakAnalysis['momentum'] = 'neutral';
  const peaksAtHigh = [peak1M.isAtPeak, peak3M.isAtPeak, peak6M.isAtPeak, peak1Y.isAtPeak, ath.isAtPeak].filter(Boolean).length;
  
  if (peaksAtHigh >= 4) {
    momentum = 'strong_up';
  } else if (peaksAtHigh >= 2) {
    momentum = 'up';
  } else if (peak1M.isAtPeak) {
    momentum = 'up';
  } else {
    // Check downtrend
    const dist1M = ((peak1M.price - current) / peak1M.price) * 100;
    const dist3M = ((peak3M.price - current) / peak3M.price) * 100;
    
    if (dist1M > 15 && dist3M > 25) {
      momentum = 'strong_down';
    } else if (dist1M > 10 || dist3M > 15) {
      momentum = 'down';
    }
  }
  
  // Build description
  const peakLabels: string[] = [];
  if (ath.isAtPeak) peakLabels.push('ATH 🏆');
  else if (peak1Y.isAtPeak) peakLabels.push('Đỉnh 1 năm');
  else if (peak6M.isAtPeak) peakLabels.push('Đỉnh 6 tháng');
  else if (peak3M.isAtPeak) peakLabels.push('Đỉnh 3 tháng');
  else if (peak1M.isAtPeak) peakLabels.push('Đỉnh 1 tháng');
  
  const momentumText: Record<string, string> = {
    'strong_up': '🚀 Đà tăng RẤT MẠNH',
    'up': '📈 Đà tăng tốt',
    'neutral': '➡️ Đi ngang',
    'down': '📉 Đà giảm',
    'strong_down': '⚠️ Đà giảm MẠNH',
  };
  
  const description = peakLabels.length > 0 
    ? `Giá đang ở ${peakLabels.join(', ')} - ${momentumText[momentum]}`
    : `Cách đỉnh 1M: ${((peak1M.price - current) / peak1M.price * 100).toFixed(1)}%, ATH: ${((ath.price - current) / ath.price * 100).toFixed(1)}% - ${momentumText[momentum]}`;
  
  return { current, peak1M, peak3M, peak6M, peak1Y, ath, momentum, description };
}

// ═══════════════════════════════════════════════════
// PRICE-VOLUME ANALYSIS
// ═══════════════════════════════════════════════════

export interface PriceVolumeAnalysis {
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
  priceVolCorrelation: 'positive' | 'negative' | 'neutral'; // Giá tăng + Vol tăng = positive
  accumulation: boolean;      // Tích lũy (giá sideway + vol giảm)
  distribution: boolean;      // Phân phối (giá sideway + vol tăng)
  climaxVolume: boolean;      // Volume đột biến
  volumeBreakout: boolean;    // Volume breakout (> 2x avg)
  avgVolume20: number;
  currentVolume: number;
  volumeRatio: number;        // Current / Avg
  description: string;
}

/**
 * Phân tích mối quan hệ Giá - Volume
 */
export function analyzePriceVolume(data: OHLCV[]): PriceVolumeAnalysis {
  if (data.length < 20) {
    return {
      volumeTrend: 'stable',
      priceVolCorrelation: 'neutral',
      accumulation: false,
      distribution: false,
      climaxVolume: false,
      volumeBreakout: false,
      avgVolume20: 0,
      currentVolume: 0,
      volumeRatio: 1,
      description: 'Không đủ dữ liệu',
    };
  }
  
  const recent20 = data.slice(-20);
  const recent5 = data.slice(-5);
  const current = data[data.length - 1];
  
  // Volume trung bình
  const avgVolume20 = recent20.reduce((sum, d) => sum + d.volume, 0) / 20;
  const avgVolume5 = recent5.reduce((sum, d) => sum + d.volume, 0) / 5;
  const currentVolume = current.volume;
  const volumeRatio = currentVolume / avgVolume20;
  
  // Volume trend
  let volumeTrend: PriceVolumeAnalysis['volumeTrend'] = 'stable';
  if (avgVolume5 > avgVolume20 * 1.2) {
    volumeTrend = 'increasing';
  } else if (avgVolume5 < avgVolume20 * 0.8) {
    volumeTrend = 'decreasing';
  }
  
  // Price change
  const priceChange5 = (recent5[recent5.length - 1].close - recent5[0].open) / recent5[0].open;
  
  // Price-Volume correlation
  let priceVolCorrelation: PriceVolumeAnalysis['priceVolCorrelation'] = 'neutral';
  if (priceChange5 > 0.02 && volumeTrend === 'increasing') {
    priceVolCorrelation = 'positive'; // Giá tăng + Vol tăng = BULLISH
  } else if (priceChange5 < -0.02 && volumeTrend === 'increasing') {
    priceVolCorrelation = 'negative'; // Giá giảm + Vol tăng = BEARISH
  } else if (priceChange5 > 0.02 && volumeTrend === 'decreasing') {
    priceVolCorrelation = 'negative'; // Giá tăng + Vol giảm = Weak rally
  }
  
  // Accumulation: Giá sideway + Vol giảm dần
  const priceRange5 = Math.abs(priceChange5);
  const accumulation = priceRange5 < 0.03 && volumeTrend === 'decreasing';
  
  // Distribution: Giá sideway/giảm nhẹ + Vol tăng
  const distribution = priceRange5 < 0.05 && priceChange5 <= 0 && volumeTrend === 'increasing';
  
  // Climax volume: Volume > 3x average
  const climaxVolume = volumeRatio > 3;
  
  // Volume breakout: Volume > 2x average
  const volumeBreakout = volumeRatio > 2;
  
  // Build description
  const parts: string[] = [];
  
  if (climaxVolume) {
    parts.push(`🔥 CLIMAX VOLUME (${volumeRatio.toFixed(1)}x avg)`);
  } else if (volumeBreakout) {
    parts.push(`📊 Volume breakout (${volumeRatio.toFixed(1)}x avg)`);
  }
  
  if (priceVolCorrelation === 'positive') {
    parts.push('✅ Giá tăng + Vol tăng = XÁC NHẬN xu hướng');
  } else if (priceVolCorrelation === 'negative' && priceChange5 > 0) {
    parts.push('⚠️ Giá tăng + Vol giảm = Đà tăng YẾU');
  } else if (priceVolCorrelation === 'negative' && priceChange5 < 0) {
    parts.push('⚠️ Giá giảm + Vol tăng = Áp lực BÁN');
  }
  
  if (accumulation) {
    parts.push('📦 Đang TÍCH LŨY (sideway + vol giảm)');
  }
  if (distribution) {
    parts.push('⚠️ Có dấu hiệu PHÂN PHỐI');
  }
  
  const description = parts.length > 0 ? parts.join(' | ') : `Volume ${volumeTrend}, ratio: ${volumeRatio.toFixed(1)}x`;
  
  return {
    volumeTrend,
    priceVolCorrelation,
    accumulation,
    distribution,
    climaxVolume,
    volumeBreakout,
    avgVolume20,
    currentVolume,
    volumeRatio,
    description,
  };
}

// ═══════════════════════════════════════════════════
// SUPPORT/RESISTANCE ANALYSIS
// ═══════════════════════════════════════════════════

export interface SupportResistance {
  supports: { price: number; strength: 'weak' | 'moderate' | 'strong'; touches: number }[];
  resistances: { price: number; strength: 'weak' | 'moderate' | 'strong'; touches: number }[];
  nearestSupport: number;
  nearestResistance: number;
  description: string;
}

/**
 * Phân tích vùng hỗ trợ/kháng cự
 */
export function analyzeSupportResistance(data: OHLCV[]): SupportResistance {
  if (data.length < 20) {
    return { supports: [], resistances: [], nearestSupport: 0, nearestResistance: 0, description: 'Không đủ dữ liệu' };
  }
  
  const current = data[data.length - 1].close;
  
  // Tìm swing points
  const swings = findSwingPoints(data.slice(-100));
  
  // Group swing highs thành resistance zones
  const resistanceZones: Map<number, number> = new Map();
  swings.highs.forEach(h => {
    // Round to nearest 0.5%
    const roundedPrice = Math.round(h.price / (current * 0.005)) * (current * 0.005);
    resistanceZones.set(roundedPrice, (resistanceZones.get(roundedPrice) || 0) + 1);
  });
  
  // Group swing lows thành support zones
  const supportZones: Map<number, number> = new Map();
  swings.lows.forEach(l => {
    const roundedPrice = Math.round(l.price / (current * 0.005)) * (current * 0.005);
    supportZones.set(roundedPrice, (supportZones.get(roundedPrice) || 0) + 1);
  });
  
  // Convert to arrays with strength
  const getStrength = (touches: number): 'weak' | 'moderate' | 'strong' => {
    if (touches >= 3) return 'strong';
    if (touches >= 2) return 'moderate';
    return 'weak';
  };
  
  const resistances = Array.from(resistanceZones.entries())
    .filter(([price]) => price > current)
    .map(([price, touches]) => ({ price, strength: getStrength(touches), touches }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);
  
  const supports = Array.from(supportZones.entries())
    .filter(([price]) => price < current)
    .map(([price, touches]) => ({ price, strength: getStrength(touches), touches }))
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  
  const nearestResistance = resistances[0]?.price || 0;
  const nearestSupport = supports[0]?.price || 0;
  
  // Build description
  const parts: string[] = [];
  if (nearestSupport > 0) {
    const distSupport = ((current - nearestSupport) / current * 100).toFixed(1);
    parts.push(`Hỗ trợ gần: ${formatPrice(nearestSupport)} (-${distSupport}%, ${supports[0]?.strength})`);
  }
  if (nearestResistance > 0) {
    const distResist = ((nearestResistance - current) / current * 100).toFixed(1);
    parts.push(`Kháng cự gần: ${formatPrice(nearestResistance)} (+${distResist}%, ${resistances[0]?.strength})`);
  }
  
  const description = parts.join(' | ') || 'Không xác định được vùng hỗ trợ/kháng cự rõ ràng';
  
  return { supports, resistances, nearestSupport, nearestResistance, description };
}

// ═══════════════════════════════════════════════════
// VCP PATTERN DETECTION (Mark Minervini)
// ═══════════════════════════════════════════════════

/**
 * Detect VCP (Volatility Contraction Pattern) - Mark Minervini
 * 
 * Đặc điểm VCP:
 * 1. Giá trong uptrend (trên MA50, MA200)
 * 2. Có ít nhất 2-4 lần co hẹp (contractions)
 * 3. Mỗi lần co hẹp, biên độ giảm dần (volatility reduction)
 * 4. Volume giảm dần trong quá trình co hẹp
 * 5. Pivot point là đỉnh của contraction cuối
 */
export function detectVCPPattern(data: OHLCV[]): VCPResult {
  if (data.length < 50) {
    return { isVCP: false, contractions: 0, volatilityReduction: 0, pivotPoint: 0, stage: 'none', description: 'Không đủ dữ liệu' };
  }
  
  const recent = data.slice(-60); // 60 phiên gần nhất
  const current = recent[recent.length - 1];
  
  // 1. Check uptrend (giá trên MA50)
  const ma50 = calculateMA(data, 50);
  const currentMA50 = ma50[ma50.length - 1];
  
  if (current.close < currentMA50 * 0.95) {
    return { isVCP: false, contractions: 0, volatilityReduction: 0, pivotPoint: 0, stage: 'none', description: 'Không trong uptrend (dưới MA50)' };
  }
  
  // 2. Tìm các đỉnh và đáy (swing highs/lows)
  const swings = findSwingPoints(recent);
  
  if (swings.highs.length < 2 || swings.lows.length < 2) {
    return { isVCP: false, contractions: 0, volatilityReduction: 0, pivotPoint: 0, stage: 'none', description: 'Không đủ swing points' };
  }
  
  // 3. Tính biên độ của mỗi contraction
  const contractions: { range: number; volume: number }[] = [];
  
  for (let i = 0; i < Math.min(swings.highs.length, swings.lows.length); i++) {
    const high = swings.highs[i];
    const low = swings.lows[i];
    const range = ((high.price - low.price) / low.price) * 100;
    
    // Tính volume trung bình trong khoảng này
    const startIdx = Math.min(high.index, low.index);
    const endIdx = Math.max(high.index, low.index);
    const avgVolume = recent.slice(startIdx, endIdx + 1).reduce((sum, d) => sum + d.volume, 0) / (endIdx - startIdx + 1);
    
    contractions.push({ range, volume: avgVolume });
  }
  
  // 4. Check volatility reduction (biên độ giảm dần)
  let isVolatilityReducing = true;
  let totalReduction = 0;
  
  for (let i = 1; i < contractions.length; i++) {
    if (contractions[i].range >= contractions[i - 1].range * 0.95) {
      isVolatilityReducing = false;
      break;
    }
    totalReduction += (contractions[i - 1].range - contractions[i].range);
  }
  
  if (!isVolatilityReducing || contractions.length < 2) {
    return { isVCP: false, contractions: contractions.length, volatilityReduction: 0, pivotPoint: 0, stage: 'none', description: 'Biên độ không co hẹp dần' };
  }
  
  // 5. Xác định pivot point (đỉnh của contraction cuối)
  const lastHigh = swings.highs[swings.highs.length - 1];
  const pivotPoint = lastHigh.price;
  
  // 6. Xác định stage
  let stage: VCPResult['stage'] = 'forming';
  const lastClose = current.close;
  
  if (lastClose > pivotPoint) {
    stage = 'breakout';
  } else if (lastClose > pivotPoint * 0.97) {
    stage = 'ready';
  }
  
  // 7. Tính volatility reduction %
  const volatilityReduction = contractions.length > 1 
    ? ((contractions[0].range - contractions[contractions.length - 1].range) / contractions[0].range) * 100
    : 0;
  
  const description = `VCP ${stage}: ${contractions.length} contractions, biên độ giảm ${volatilityReduction.toFixed(0)}%, pivot ${formatPrice(pivotPoint)}`;
  
  return {
    isVCP: true,
    contractions: contractions.length,
    volatilityReduction,
    pivotPoint,
    stage,
    description,
  };
}

interface SwingPoint {
  index: number;
  price: number;
  date: string;
}

function findSwingPoints(data: OHLCV[]): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  const lookback = 5;
  
  for (let i = lookback; i < data.length - lookback; i++) {
    const current = data[i];
    
    // Check swing high
    let isSwingHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && data[j].high >= current.high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      highs.push({ index: i, price: current.high, date: current.date });
    }
    
    // Check swing low
    let isSwingLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && data[j].low <= current.low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      lows.push({ index: i, price: current.low, date: current.date });
    }
  }
  
  return { highs, lows };
}


// ═══════════════════════════════════════════════════
// PRICE DATA & ANALYSIS
// ═══════════════════════════════════════════════════

/**
 * Tính toán thông tin giá (52W High, ATH, etc.)
 */
export function calculatePriceInfo(data: OHLCV[], allTimeData?: OHLCV[]): ChartAnalysisResult['priceData'] {
  const current = data[data.length - 1].close;
  
  // 52 Week High/Low (khoảng 252 phiên giao dịch)
  const last52W = data.slice(-252);
  const high52W = Math.max(...last52W.map(d => d.high));
  const low52W = Math.min(...last52W.map(d => d.low));
  
  // All-Time High/Low
  const allData = allTimeData || data;
  const ath = Math.max(...allData.map(d => d.high));
  const atl = Math.min(...allData.map(d => d.low));
  
  // Distance calculations
  const distanceFrom52WH = ((high52W - current) / high52W) * 100;
  const distanceFromATH = ((ath - current) / ath) * 100;
  
  return {
    current,
    high52W,
    low52W,
    ath,
    atl,
    distanceFrom52WH,
    distanceFromATH,
  };
}

/**
 * Resample data to different timeframes
 */
export function resampleToTimeframe(dailyData: OHLCV[], timeframe: Timeframe): OHLCV[] {
  if (timeframe === 'D') return dailyData;
  
  const result: OHLCV[] = [];
  
  if (timeframe === 'W') {
    // Weekly: group by week
    let weekData: OHLCV[] = [];
    let currentWeek = -1;
    
    dailyData.forEach(d => {
      const date = new Date(d.date);
      const week = getWeekNumber(date);
      
      if (week !== currentWeek && weekData.length > 0) {
        result.push(aggregateOHLCV(weekData));
        weekData = [];
      }
      
      currentWeek = week;
      weekData.push(d);
    });
    
    if (weekData.length > 0) {
      result.push(aggregateOHLCV(weekData));
    }
  } else if (timeframe === '4H' || timeframe === '1H') {
    // For intraday, we'd need intraday data
    // Since we only have daily, return daily with note
    console.log(`[ChartVision] ⚠️ Intraday timeframe ${timeframe} requires intraday data, using daily`);
    return dailyData;
  }
  
  return result;
}

function getWeekNumber(date: Date): number {
  const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

function aggregateOHLCV(data: OHLCV[]): OHLCV {
  return {
    date: data[0].date,
    open: data[0].open,
    high: Math.max(...data.map(d => d.high)),
    low: Math.min(...data.map(d => d.low)),
    close: data[data.length - 1].close,
    volume: data.reduce((sum, d) => sum + d.volume, 0),
  };
}

// ═══════════════════════════════════════════════════
// GEMINI VISION ANALYSIS
// ═══════════════════════════════════════════════════

/**
 * Gửi chart image cho Gemini Vision để phân tích
 */
export async function analyzeChartWithVision(
  chartImage: Buffer,
  symbol: string,
  priceInfo: ChartAnalysisResult['priceData'],
  vcpResult: VCPResult,
  timeframe: Timeframe
): Promise<string> {
  // Get API keys (may be comma-separated or numbered)
  const rawKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
  const keys = rawKey.split(',').map(k => k.trim().replace(/['"]/g, '')).filter(k => k);
  
  // Also check numbered keys
  for (let i = 1; i <= 10; i++) {
    const numberedKey = process.env[`GEMINI_API_KEY_${i}`];
    if (numberedKey) {
      keys.push(numberedKey.trim().replace(/['"]/g, ''));
    }
  }
  
  if (keys.length === 0) {
    console.log('[ChartVision] ⚠️ No GEMINI_API_KEY configured');
    return '';
  }
  
  // Try each key until one works
  for (const GEMINI_API_KEY of keys) {
    console.log(`[ChartVision] 🔑 Trying API key: ${GEMINI_API_KEY.substring(0, 10)}...`);
    
    const result = await tryVisionAnalysis(chartImage, symbol, priceInfo, vcpResult, timeframe, GEMINI_API_KEY);
    if (result) return result;
  }
  
  console.log('[ChartVision] ❌ All API keys failed');
  return '';
}

async function tryVisionAnalysis(
  chartImage: Buffer,
  symbol: string,
  priceInfo: ChartAnalysisResult['priceData'],
  vcpResult: VCPResult,
  timeframe: Timeframe,
  GEMINI_API_KEY: string
): Promise<string> {
  
  const base64Image = chartImage.toString('base64');
  
  const prompt = `Bạn là chuyên gia phân tích kỹ thuật chứng khoán Việt Nam với 20 năm kinh nghiệm.

THÔNG TIN CỔ PHIẾU: ${symbol}
- Timeframe: ${timeframe}
- Giá hiện tại: ${priceInfo.current.toLocaleString('vi-VN')}
- Đỉnh 52 tuần: ${priceInfo.high52W.toLocaleString('vi-VN')} (cách ${priceInfo.distanceFrom52WH.toFixed(1)}%)
- Đỉnh mọi thời đại (ATH): ${priceInfo.ath.toLocaleString('vi-VN')} (cách ${priceInfo.distanceFromATH.toFixed(1)}%)
- VCP Pattern: ${vcpResult.isVCP ? vcpResult.description : 'Không phát hiện'}

Hãy phân tích chart này và đưa ra nhận định:

1. **XU HƯỚNG**: Uptrend/Downtrend/Sideway? Sức mạnh xu hướng?

2. **MÔ HÌNH GIÁ**: Có nhận diện được pattern nào không? (Head & Shoulders, Double Bottom, Cup & Handle, Triangle, Flag, VCP...)

3. **HỖ TRỢ/KHÁNG CỰ**: Các vùng giá quan trọng?

4. **VOLUME**: Volume có xác nhận xu hướng không? Có dấu hiệu tích lũy/phân phối?

5. **ĐÁNH GIÁ VCP** (nếu có): Đây có phải setup VCP chuẩn của Mark Minervini không? Pivot point có hợp lý?

6. **KHUYẾN NGHỊ**: 
   - Điểm mua lý tưởng?
   - Stoploss đặt ở đâu?
   - Target price?
   - Risk/Reward ratio?

Trả lời ngắn gọn, súc tích như một broker đang tư vấn khách VIP. Dùng emoji phù hợp.`;

  try {
    console.log(`[ChartVision] 🤖 Calling Gemini Vision for ${symbol}...`);
    
    // Use Google GenAI SDK format - gemini-2.0-flash for Vision (best quality)
    // Fallback: gemini-1.5-flash-8b nếu 2.0 không khả dụng
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: base64Image,
                },
              },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1500,
          },
        }),
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[ChartVision] ❌ Gemini Vision error: ${response.status} - ${errorText.substring(0, 200)}`);
      return '';
    }
    
    const data = await response.json();
    const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    console.log(`[ChartVision] ✅ Vision analysis complete for ${symbol}`);
    return analysis.trim();
    
  } catch (error: any) {
    console.log(`[ChartVision] ❌ Vision error: ${error.message}`);
    return '';
  }
}

// ═══════════════════════════════════════════════════
// MAIN ANALYSIS FUNCTION
// ═══════════════════════════════════════════════════

/**
 * Phân tích chart toàn diện với Vision AI
 */
export async function analyzeChartVision(
  symbol: string,
  dailyData: OHLCV[],
  timeframe: Timeframe = 'D',
  allTimeData?: OHLCV[]
): Promise<{ 
  chartAnalysis: string; 
  priceInfo: ChartAnalysisResult['priceData']; 
  vcpResult: VCPResult;
  darvasBox: DarvasBoxResult;
  pricePeaks: PricePeakAnalysis;
  priceVolume: PriceVolumeAnalysis;
  supportResistance: SupportResistance;
}> {
  console.log(`[ChartVision] 📊 Analyzing ${symbol} on ${timeframe} timeframe...`);
  
  // Resample data if needed
  const data = resampleToTimeframe(dailyData, timeframe);
  
  // Calculate price info
  const priceInfo = calculatePriceInfo(dailyData, allTimeData);
  
  // Detect VCP pattern
  const vcpResult = detectVCPPattern(dailyData);
  
  // Detect Darvas Box
  const darvasBox = detectDarvasBox(dailyData);
  
  // Analyze price peaks
  const pricePeaks = analyzePricePeaks(dailyData);
  
  // Analyze price-volume relationship
  const priceVolume = analyzePriceVolume(dailyData);
  
  // Analyze support/resistance
  const supportResistance = analyzeSupportResistance(dailyData);
  
  // Draw chart
  const chartImage = drawCandlestickChart(data.slice(-100), symbol, timeframe, priceInfo, vcpResult);
  
  // Analyze with Vision AI
  const chartAnalysis = await analyzeChartWithVision(chartImage, symbol, priceInfo, vcpResult, timeframe);
  
  return { chartAnalysis, priceInfo, vcpResult, darvasBox, pricePeaks, priceVolume, supportResistance };
}

/**
 * Tự động đưa ra khuyến nghị giao dịch dựa trên phân tích thuật toán
 * Không cần Vision AI - tính toán hoàn toàn từ dữ liệu OHLCV
 */
function generateTradingRecommendation(
  priceInfo: ChartAnalysisResult['priceData'],
  darvasBox?: DarvasBoxResult,
  pricePeaks?: PricePeakAnalysis,
  priceVolume?: PriceVolumeAnalysis,
  supportResistance?: SupportResistance,
  vcpResult?: VCPResult
): string {
  const current = priceInfo.current;
  const parts: string[] = [];
  
  // 1. Xác định xu hướng chính
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  let trendStrength = 0;
  
  // Dựa vào momentum
  if (pricePeaks?.momentum === 'strong_up') {
    trend = 'bullish';
    trendStrength = 2;
  } else if (pricePeaks?.momentum === 'up') {
    trend = 'bullish';
    trendStrength = 1;
  } else if (pricePeaks?.momentum === 'strong_down') {
    trend = 'bearish';
    trendStrength = 2;
  } else if (pricePeaks?.momentum === 'down') {
    trend = 'bearish';
    trendStrength = 1;
  }
  
  // Dựa vào Darvas Box
  if (darvasBox?.breakoutStatus === 'breakout_up') {
    trend = 'bullish';
    trendStrength += 2;
  } else if (darvasBox?.breakoutStatus === 'breakout_down') {
    trend = 'bearish';
    trendStrength += 2;
  }
  
  // Dựa vào Volume
  if (priceVolume?.priceVolCorrelation === 'positive') {
    trendStrength += 1;
  } else if (priceVolume?.priceVolCorrelation === 'negative') {
    trendStrength -= 1;
  }
  
  // 2. Xác định điểm mua/bán
  let buyPoint = 0;
  let sellTarget = 0;
  let stoploss = 0;
  
  if (darvasBox && darvasBox.boxTop > 0) {
    if (darvasBox.breakoutStatus === 'breakout_up') {
      // Đã breakout → mua khi retest đỉnh box
      buyPoint = darvasBox.boxTop;
      stoploss = darvasBox.boxBottom;
      sellTarget = darvasBox.boxTop + (darvasBox.boxTop - darvasBox.boxBottom); // Target = box range
    } else if (darvasBox.isInBox) {
      // Trong box → mua gần đáy box, bán gần đỉnh box
      buyPoint = darvasBox.boxBottom * 1.02; // +2% từ đáy
      stoploss = darvasBox.boxBottom * 0.97; // -3% từ đáy
      sellTarget = darvasBox.boxTop * 0.98; // -2% từ đỉnh
    } else if (darvasBox.breakoutStatus === 'testing_top') {
      // Test đỉnh → chờ breakout
      buyPoint = darvasBox.boxTop * 1.01; // Mua khi vượt đỉnh 1%
      stoploss = darvasBox.boxBottom;
      sellTarget = darvasBox.boxTop * 1.1; // Target +10%
    }
  }
  
  // Fallback to support/resistance
  if (buyPoint === 0 && supportResistance) {
    if (supportResistance.nearestSupport > 0) {
      buyPoint = supportResistance.nearestSupport;
      stoploss = supportResistance.nearestSupport * 0.95;
    }
    if (supportResistance.nearestResistance > 0) {
      sellTarget = supportResistance.nearestResistance;
    }
  }
  
  // 3. Tính Risk/Reward
  let riskReward = 0;
  if (buyPoint > 0 && stoploss > 0 && sellTarget > 0) {
    const risk = buyPoint - stoploss;
    const reward = sellTarget - buyPoint;
    riskReward = risk > 0 ? reward / risk : 0;
  }
  
  // 4. Build recommendation
  if (trend === 'bullish' && trendStrength >= 2) {
    parts.push(`📈 **XU HƯỚNG TĂNG** (sức mạnh: ${trendStrength}/5)`);
    
    if (darvasBox?.breakoutStatus === 'breakout_up') {
      parts.push(`🚀 Đã BREAKOUT khỏi Darvas Box! Momentum mạnh.`);
    } else if (darvasBox?.breakoutStatus === 'testing_top') {
      parts.push(`⚡ Đang test đỉnh box ${formatPrice(darvasBox.boxTop)} - Chuẩn bị breakout?`);
    }
    
    if (pricePeaks?.ath.isAtPeak) {
      parts.push(`🏆 Đang ở ATH - Đà tăng rất mạnh, không có kháng cự phía trên!`);
    } else if (pricePeaks?.peak1Y.isAtPeak) {
      parts.push(`📊 Đang ở đỉnh 1 năm - Momentum tốt`);
    }
    
    if (priceVolume?.volumeBreakout) {
      parts.push(`📊 Volume breakout (${priceVolume.volumeRatio.toFixed(1)}x) - Xác nhận xu hướng`);
    }
    
  } else if (trend === 'bearish' && trendStrength >= 2) {
    parts.push(`📉 **XU HƯỚNG GIẢM** (sức mạnh: ${trendStrength}/5)`);
    
    if (darvasBox?.breakoutStatus === 'breakout_down') {
      parts.push(`⚠️ Đã BREAKDOWN khỏi Darvas Box! Cẩn thận.`);
    }
    
    if (priceVolume?.distribution) {
      parts.push(`⚠️ Có dấu hiệu phân phối - Smart money đang bán?`);
    }
    
  } else {
    parts.push(`➡️ **SIDEWAY/TÍCH LŨY**`);
    
    if (darvasBox?.isInBox) {
      parts.push(`📦 Đang trong Darvas Box ${formatPrice(darvasBox.boxBottom)} - ${formatPrice(darvasBox.boxTop)}`);
    }
    
    if (priceVolume?.accumulation) {
      parts.push(`📦 Đang tích lũy - Chờ breakout`);
    }
  }
  
  // 5. Trading levels
  if (buyPoint > 0 || sellTarget > 0 || stoploss > 0) {
    parts.push(`\n**🎯 MỨC GIÁ QUAN TRỌNG:**`);
    if (buyPoint > 0) parts.push(`• Điểm mua: ${formatPrice(buyPoint)}`);
    if (stoploss > 0) parts.push(`• Stoploss: ${formatPrice(stoploss)}`);
    if (sellTarget > 0) parts.push(`• Target: ${formatPrice(sellTarget)}`);
    if (riskReward > 0) {
      const rrText = riskReward >= 2 ? '✅ Tốt' : riskReward >= 1.5 ? '🟡 Chấp nhận được' : '⚠️ Thấp';
      parts.push(`• R/R: 1:${riskReward.toFixed(1)} ${rrText}`);
    }
  }
  
  return parts.join('\n');
}

/**
 * Format kết quả phân tích để hiển thị
 */
export function formatChartAnalysisResult(
  symbol: string,
  priceInfo: ChartAnalysisResult['priceData'],
  vcpResult: VCPResult,
  visionAnalysis: string,
  darvasBox?: DarvasBoxResult,
  pricePeaks?: PricePeakAnalysis,
  priceVolume?: PriceVolumeAnalysis,
  supportResistance?: SupportResistance
): string {
  let result = `\n\n═══ 📈 PHÂN TÍCH CHART ${symbol} ═══\n\n`;
  
  // Price levels
  result += `**📊 MỨC GIÁ QUAN TRỌNG:**\n`;
  result += `• Giá hiện tại: ${priceInfo.current.toLocaleString('vi-VN')}\n`;
  result += `• Đỉnh 52 tuần: ${priceInfo.high52W.toLocaleString('vi-VN')} (cách ${priceInfo.distanceFrom52WH.toFixed(1)}%)\n`;
  result += `• Đáy 52 tuần: ${priceInfo.low52W.toLocaleString('vi-VN')}\n`;
  result += `• ATH: ${priceInfo.ath.toLocaleString('vi-VN')} (cách ${priceInfo.distanceFromATH.toFixed(1)}%)\n`;
  
  // Price Peaks Analysis
  if (pricePeaks) {
    result += `\n**🎯 PHÂN TÍCH ĐỈNH GIÁ:**\n`;
    result += `• ${pricePeaks.description}\n`;
    if (pricePeaks.peak1M.isAtPeak) result += `  → Đang ở đỉnh 1 tháng ✅\n`;
    if (pricePeaks.peak3M.isAtPeak) result += `  → Đang ở đỉnh 3 tháng ✅\n`;
    if (pricePeaks.peak6M.isAtPeak) result += `  → Đang ở đỉnh 6 tháng ✅\n`;
    if (pricePeaks.peak1Y.isAtPeak) result += `  → Đang ở đỉnh 1 năm ✅\n`;
    if (pricePeaks.ath.isAtPeak) result += `  → 🏆 ĐANG Ở ATH - Đỉnh mọi thời đại!\n`;
  }
  
  // NOTE: Darvas Box đã được hiển thị trong patternSection (chartPatterns.ts)
  // Không hiển thị lại ở đây để tránh duplicate
  
  // Price-Volume Analysis
  if (priceVolume) {
    result += `\n**📊 PHÂN TÍCH GIÁ-VOLUME:**\n`;
    result += `• ${priceVolume.description}\n`;
    if (priceVolume.climaxVolume) {
      result += `  → 🔥 CLIMAX VOLUME - Có thể là đỉnh/đáy ngắn hạn\n`;
    }
    if (priceVolume.accumulation) {
      result += `  → 📦 Đang TÍCH LŨY - Chuẩn bị cho sóng tiếp theo\n`;
    }
    if (priceVolume.distribution) {
      result += `  → ⚠️ Có dấu hiệu PHÂN PHỐI - Cẩn thận!\n`;
    }
  }
  
  // Support/Resistance
  if (supportResistance && (supportResistance.nearestSupport > 0 || supportResistance.nearestResistance > 0)) {
    result += `\n**🎯 HỖ TRỢ/KHÁNG CỰ:**\n`;
    result += `• ${supportResistance.description}\n`;
    
    // Chi tiết các vùng
    if (supportResistance.resistances.length > 0) {
      result += `• Kháng cự: `;
      result += supportResistance.resistances.map(r => `${formatPrice(r.price)} (${r.strength})`).join(' → ');
      result += `\n`;
    }
    if (supportResistance.supports.length > 0) {
      result += `• Hỗ trợ: `;
      result += supportResistance.supports.map(s => `${formatPrice(s.price)} (${s.strength})`).join(' → ');
      result += `\n`;
    }
  }
  
  // NOTE: VCP Pattern đã được hiển thị trong patternSection (chartPatterns.ts)
  // Không hiển thị lại ở đây để tránh duplicate
  
  // Vision Analysis (optional - fallback to algorithmic analysis if Vision fails)
  if (visionAnalysis) {
    result += `\n**🤖 PHÂN TÍCH AI:**\n${visionAnalysis}\n`;
  }
  
  // Trading Conclusion
  result += `\n**💡 KẾT LUẬN:**\n`;
  
  // Generate trading recommendation based on algorithmic analysis
  const tradingRec = generateTradingRecommendation(priceInfo, darvasBox, pricePeaks, priceVolume, supportResistance, vcpResult);
  if (tradingRec && !visionAnalysis) {
    result += `${tradingRec}\n`;
  }
  
  // Build conclusion based on all analyses
  const bullishSignals: string[] = [];
  const bearishSignals: string[] = [];
  
  if (pricePeaks?.momentum === 'strong_up' || pricePeaks?.momentum === 'up') {
    bullishSignals.push('Đà tăng tốt');
  } else if (pricePeaks?.momentum === 'strong_down' || pricePeaks?.momentum === 'down') {
    bearishSignals.push('Đà giảm');
  }
  
  if (darvasBox?.breakoutStatus === 'breakout_up') {
    bullishSignals.push('Breakout Darvas Box');
  } else if (darvasBox?.breakoutStatus === 'breakout_down') {
    bearishSignals.push('Breakdown Darvas Box');
  }
  
  if (priceVolume?.priceVolCorrelation === 'positive') {
    bullishSignals.push('Vol xác nhận xu hướng tăng');
  } else if (priceVolume?.priceVolCorrelation === 'negative') {
    bearishSignals.push('Vol không xác nhận');
  }
  
  if (priceVolume?.accumulation) {
    bullishSignals.push('Đang tích lũy');
  }
  if (priceVolume?.distribution) {
    bearishSignals.push('Có dấu hiệu phân phối');
  }
  
  // NOTE: VCP và Darvas Box signals đã được hiển thị trong patternSection
  // Chỉ giữ lại các signals từ price-volume analysis
  
  if (bullishSignals.length > bearishSignals.length) {
    result += `✅ TÍCH CỰC: ${bullishSignals.join(', ')}\n`;
    if (bearishSignals.length > 0) {
      result += `⚠️ Lưu ý: ${bearishSignals.join(', ')}\n`;
    }
  } else if (bearishSignals.length > bullishSignals.length) {
    result += `⚠️ THẬN TRỌNG: ${bearishSignals.join(', ')}\n`;
    if (bullishSignals.length > 0) {
      result += `✅ Điểm tích cực: ${bullishSignals.join(', ')}\n`;
    }
  } else {
    result += `➡️ TRUNG LẬP - Chờ tín hiệu rõ ràng hơn\n`;
  }
  
  return result;
}
