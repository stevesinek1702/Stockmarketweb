/**
 * CP Tiềm Năng & MACD/RSI Scanner - Quét CP đạt tiêu chuẩn kỹ thuật
 * 
 * 1. Cổ phiếu tiềm năng: Giá > MA20 > MA50, RS >= 55, thanh khoản tốt.
 * 2. Tín hiệu giao dịch MACD/RSI:
 *    - RSI cắt lên 30 (BUY) / RSI cắt xuống 70 (SELL)
 *    - MACD Histogram cắt lên 0 (BUY) / MACD Histogram cắt xuống 0 (SELL)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SCAN_STOCKS = [
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
const MIN_AVG_VOLUME = 200000;
const CACHE_FILE = path.join(__dirname, 'data', 'potential-signals.json');

// Helper to format date as yyyy-mm-dd
function formatSimpleDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Helper to format date for RS endpoint (no padding)
function formatRSDate(d) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Fetch price data from Fireant
 */
async function fetchPriceData(symbol, cookie = '') {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 120);

    const url = `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=${symbol}&startDate=${formatSimpleDate(startDate)}&endDate=${formatSimpleDate(endDate)}`;
    
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        };
        if (cookie) {
            headers['Cookie'] = cookie;
        }

        const res = await axios.get(url, { headers, timeout: 10000 });
        const raw = res.data;
        if (!raw || !Array.isArray(raw) || !raw.length) return [];

        const data = raw.map((item) => ({
            date: item.Date?.split('T')[0] || item.date?.split('T')[0],
            open: item.Open || item.PriceOpen || item.open || 0,
            high: item.High || item.PriceHigh || item.high || 0,
            low: item.Low || item.PriceLow || item.low || 0,
            close: item.Close || item.PriceClose || item.close || 0,
            volume: item.Volume || item.TotalVolume || item.volume || 0,
        })).filter((d) => d.close > 0);

        data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        return data;
    } catch (err) {
        return [];
    }
}

/**
 * Fetch Custom RS Indicator data from Fireant
 */
async function fetchRS(symbol, cookie = '') {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 120);

    const url = `https://www.fireant.vn/api/Data/Markets/CustomIndicatorHistoricalData?symbol=${symbol}%23RS&startDate=${formatRSDate(startDate)}&endDate=${formatRSDate(endDate)}`;
    
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        };
        if (cookie) {
            headers['Cookie'] = cookie;
        }

        const res = await axios.get(url, { headers, timeout: 10000 });
        const raw = res.data;
        if (!raw || !Array.isArray(raw) || !raw.length) return [];

        const data = raw.map((d) => ({
            date: d.Date?.split('T')[0] || '',
            value: d.Open || d.Close || d.Value || 0,
        })).filter((d) => d.value > 0);

        data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        return data;
    } catch (err) {
        return [];
    }
}

// ═══════════════════════════════════════════════════
// TECHNICAL INDICATOR CALCULATORS
// ═══════════════════════════════════════════════════

function calculateEMA(prices, period) {
    if (prices.length < period) return [];

    const multiplier = 2 / (period + 1);
    const emaValues = [];

    // SMA cho period đầu tiên
    let sma = 0;
    for (let i = 0; i < period; i++) sma += prices[i];
    sma /= period;
    emaValues.push(sma);

    // EMA từ period trở đi
    for (let i = period; i < prices.length; i++) {
        const ema = (prices[i] - emaValues[emaValues.length - 1]) * multiplier + emaValues[emaValues.length - 1];
        emaValues.push(ema);
    }

    return emaValues;
}

function calculateMACD(closes) {
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);

    if (ema12.length === 0 || ema26.length === 0) {
        return { macd: [], signal: [], histogram: [] };
    }

    // MACD line = EMA12 - EMA26
    const macdLine = [];
    const ema12Offset = 12;
    const ema26Offset = 26;

    for (let i = 0; i < ema26.length; i++) {
        const closesIdx = ema26Offset + i;
        const ema12Idx = closesIdx - ema12Offset;
        if (ema12Idx >= 0 && ema12Idx < ema12.length) {
            macdLine.push(ema12[ema12Idx] - ema26[i]);
        }
    }

    // Signal line = EMA9 của MACD line
    const signalLine = calculateEMA(macdLine, 9);

    if (signalLine.length === 0) {
        return { macd: macdLine, signal: [], histogram: [] };
    }

    // Histogram = MACD - Signal
    const histogramArr = [];
    const signalOffset = 9;
    for (let i = 0; i < signalLine.length; i++) {
        const macdIdx = signalOffset + i;
        if (macdIdx < macdLine.length) {
            histogramArr.push(macdLine[macdIdx] - signalLine[i]);
        }
    }

    return { macd: macdLine, signal: signalLine, histogram: histogramArr };
}

function calculateRSI(closes, period = 14) {
    if (closes.length <= period) return [];

    const rsiValues = [];
    let gains = 0;
    let losses = 0;

    // Thay đổi ban đầu
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    let rs = avgLoss > 0 ? avgGain / avgLoss : 100;
    let rsi = 100 - (100 / (1 + rs));
    rsiValues.push({ dateIndex: period, rsi });

    // Wilders smoothing
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        let gain = 0;
        let loss = 0;
        if (diff > 0) gain = diff;
        else loss = -diff;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        rs = avgLoss > 0 ? avgGain / avgLoss : 100;
        rsi = 100 - (100 / (1 + rs));
        rsiValues.push({ dateIndex: i, rsi });
    }

    return rsiValues;
}

// ═══════════════════════════════════════════════════
// SCANNERS
// ═══════════════════════════════════════════════════

/**
 * Run technical analysis rules on a stock's data
 */
function analyzeStock(symbol, priceData, rsData) {
    if (priceData.length < 55 || rsData.length < 15) return null;

    const closes = priceData.map(d => d.close);
    const today = priceData[priceData.length - 1];
    const yesterday = priceData[priceData.length - 2];

    // Check data freshness (must be within last 5 days)
    const lastDate = new Date(today.date);
    if ((Date.now() - lastDate.getTime()) / 86400000 > 5) return null;

    // MA20
    const last20 = closes.slice(-20);
    const ma20 = last20.reduce((s, v) => s + v, 0) / 20;

    // MA50
    const last50 = closes.slice(-50);
    const ma50 = last50.reduce((s, v) => s + v, 0) / 50;

    // Điều kiện 1: Giá trên MA20 và MA50
    if (today.close < ma20 || today.close < ma50) return null;

    // Điều kiện 2: MA20 > MA50 (golden cross structure)
    if (ma20 < ma50) return null;

    // Điều kiện 3: Giá không quá xa MA20 (< 8%) - tránh mua đuổi
    const distMA20 = ((today.close - ma20) / ma20) * 100;
    if (distMA20 > 8) return null;

    // Điều kiện 4: RS > 55
    const rs = rsData[rsData.length - 1].value;
    if (rs < 55) return null;

    // RS MA10
    const rsLast10 = rsData.slice(-10);
    const rsMA10 = rsLast10.reduce((s, d) => s + d.value, 0) / rsLast10.length;

    // Điều kiện 5: Nến xanh hoặc giá tăng so hôm qua
    if (today.close <= today.open && today.close <= yesterday.close) return null;

    // Điều kiện 6: Thanh khoản
    const volumes = priceData.map(d => d.volume);
    const last20Vol = volumes.slice(-20);
    const avgVol20 = last20Vol.reduce((s, v) => s + v, 0) / 20;
    if (avgVol20 < MIN_AVG_VOLUME) return null;

    const volumeRatio = avgVol20 > 0 ? today.volume / avgVol20 : 0;
    const change = yesterday.close > 0 ? ((today.close - yesterday.close) / yesterday.close) * 100 : 0;

    // RS trend
    let rsTrend = 'sideways';
    if (rsData.length >= 10) {
        const first5 = rsData.slice(-10, -5).reduce((s, d) => s + d.value, 0) / 5;
        const last5 = rsData.slice(-5).reduce((s, d) => s + d.value, 0) / 5;
        if (last5 - first5 > 3) rsTrend = 'uptrend';
        else if (first5 - last5 > 3) rsTrend = 'downtrend';
    }

    return {
        symbol,
        price: today.close,
        change,
        ma20,
        ma50,
        distMA20,
        rs,
        rsMA10,
        volume: today.volume,
        avgVolume20: avgVol20,
        volumeRatio,
        rsTrend,
        date: today.date,
    };
}

/**
 * Scan MACD & RSI BUY/SELL signals
 */
function getMACDRSISignal(symbol, priceData) {
    if (priceData.length < 40) return null;

    const closes = priceData.map(d => d.close);
    const today = priceData[priceData.length - 1];
    const yesterday = priceData[priceData.length - 2];
    
    // Check data freshness
    const lastDate = new Date(today.date);
    if ((Date.now() - lastDate.getTime()) / 86400000 > 5) return null;

    // Calculate MACD & RSI
    const { histogram } = calculateMACD(closes);
    const rsiList = calculateRSI(closes, 14);

    if (histogram.length < 2 || rsiList.length < 2) return null;

    const histToday = histogram[histogram.length - 1];
    const histYesterday = histogram[histogram.length - 2];

    const rsiToday = rsiList[rsiList.length - 1].rsi;
    const rsiYesterday = rsiList[rsiList.length - 2].rsi;

    let signalType = null; // 'BUY' or 'SELL'
    let indicator = null; // 'MACD' or 'RSI' or 'BOTH'
    let description = '';

    // 1. Check RSI Crossover signals
    if (rsiYesterday < 30 && rsiToday >= 30) {
        signalType = 'BUY';
        indicator = 'RSI';
        description = `RSI cắt lên trên 30 (RSI: ${rsiYesterday.toFixed(1)} -> ${rsiToday.toFixed(1)}) - Tín hiệu quá bán hồi lên`;
    } else if (rsiYesterday > 70 && rsiToday <= 70) {
        signalType = 'SELL';
        indicator = 'RSI';
        description = `RSI cắt xuống dưới 70 (RSI: ${rsiYesterday.toFixed(1)} -> ${rsiToday.toFixed(1)}) - Tín hiệu quá mua đi xuống`;
    }

    // 2. Check MACD Crossover signals
    if (histYesterday < 0 && histToday > 0) {
        if (signalType === 'BUY') {
            indicator = 'BOTH';
            description += ' & MACD Histogram cắt lên 0';
        } else {
            signalType = 'BUY';
            indicator = 'MACD';
            description = `MACD Histogram cắt lên trên 0 (${histYesterday.toFixed(2)} -> ${histToday.toFixed(2)}) - Hội tụ đi lên`;
        }
    } else if (histYesterday > 0 && histToday < 0) {
        if (signalType === 'SELL') {
            indicator = 'BOTH';
            description += ' & MACD Histogram cắt xuống 0';
        } else {
            signalType = 'SELL';
            indicator = 'MACD';
            description = `MACD Histogram cắt xuống dưới 0 (${histYesterday.toFixed(2)} -> ${histToday.toFixed(2)}) - Phân kỳ đi xuống`;
        }
    }

    if (!signalType) return null;

    return {
        symbol,
        price: today.close,
        change: yesterday.close > 0 ? ((today.close - yesterday.close) / yesterday.close) * 100 : 0,
        volume: today.volume,
        signalType,
        indicator,
        description,
        rsi: rsiToday,
        histogram: histToday,
        date: today.date
    };
}

/**
 * Phát hiện BREAK TRENDLINE. Quét tối đa maxLookback phiên gần nhất, trả về lần
 * break GẦN NHẤT thoả: TB20 vol >= MIN_AVG_VOLUME; nến xanh & tăng >=+1.5%;
 * vol break >1.3x TB20 trước đó; >=6/14 phiên giảm trước đó; close > High 5 phiên trước.
 */
function detectTrendlineBreak(symbol, priceData, maxLookback = 30) {
    if (!priceData || priceData.length < 25) return null;
    const n = priceData.length;
    const latest = priceData[n - 1];
    if ((Date.now() - new Date(latest.date).getTime()) / 86400000 > 5) return null;
    const avgVol20Latest = priceData.slice(-20).reduce((s, d) => s + d.volume, 0) / 20;
    if (avgVol20Latest < MIN_AVG_VOLUME) return null;

    const start = Math.max(20, n - maxLookback);
    for (let k = n - 1; k >= start; k--) {
        const breakBar = priceData[k];
        const prevBar = priceData[k - 1];
        const change = prevBar.close > 0 ? ((breakBar.close - prevBar.close) / prevBar.close) * 100 : 0;
        if (breakBar.close <= breakBar.open) continue;
        if (change < 1.5) continue;
        const prior20 = priceData.slice(k - 20, k);
        if (prior20.length < 20) continue;
        const avgVol20 = prior20.reduce((s, d) => s + d.volume, 0) / 20;
        const volumeRatio = avgVol20 > 0 ? breakBar.volume / avgVol20 : 0;
        if (volumeRatio < 1.3) continue;
        const prev15 = priceData.slice(k - 15, k);
        if (prev15.length < 15) continue;
        let downDays = 0;
        for (let i = 1; i < prev15.length; i++) if (prev15[i].close < prev15[i - 1].close) downDays++;
        if (downDays < 6) continue;
        const prev5 = priceData.slice(k - 5, k);
        const prevHigh5 = Math.max(...prev5.map(d => d.high));
        if (breakBar.close <= prevHigh5) continue;
        const breakStrength = ((breakBar.close - prevHigh5) / prevHigh5) * 100;
        const prev10 = priceData.slice(k - 10, k);
        const prevHigh10 = Math.max(...prev10.map(d => d.high));
        const prevLow10 = Math.min(...prev10.map(d => d.low));
        const rangeWidth = prevLow10 > 0 ? ((prevHigh10 - prevLow10) / prevLow10) * 100 : 0;
        const currentClose = latest.close;
        const profit = breakBar.close > 0 ? (currentClose - breakBar.close) / breakBar.close : 0;
        const daysAgo = Math.round((new Date(latest.date).getTime() - new Date(breakBar.date).getTime()) / 86400000);
        return {
            symbol, date: breakBar.date, breakDayClose: breakBar.close, breakPrice: prevHigh5,
            currentClose, volume: breakBar.volume, avgVolume20: avgVol20,
            volumeRatio: parseFloat(volumeRatio.toFixed(2)), roc: change / 100, profit,
            breakStrength: parseFloat(breakStrength.toFixed(2)), rangeWidth: parseFloat(rangeWidth.toFixed(2)),
            downDays, daysAgo, signal: `Break Trendline (x${volumeRatio.toFixed(1)})`
        };
    }
    return null;
}

/**
 * Scan all potential stocks and cache results
 */
async function scanPotential(cookie = '') {
    console.log(`[POTENTIAL] 🔍 Starting potential stock & MACD/RSI scan for ${SCAN_STOCKS.length} stocks...`);
    const startTime = Date.now();
    const signals = [];
    const macdRsiSignals = [];
    const trendlineSignals = [];
    let processed = 0;

    for (let i = 0; i < SCAN_STOCKS.length; i += BATCH_SIZE) {
        const batch = SCAN_STOCKS.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(async (sym) => {
                const [priceData, rsData] = await Promise.all([
                    fetchPriceData(sym, cookie),
                    fetchRS(sym, cookie)
                ]);
                
                const potentialSig = analyzeStock(sym, priceData, rsData);
                const macdRsiSig = getMACDRSISignal(sym, priceData);
                const trendlineSig = detectTrendlineBreak(sym, priceData);
                
                return { potentialSig, macdRsiSig, trendlineSig };
            })
        );
        
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                if (r.value.potentialSig) signals.push(r.value.potentialSig);
                if (r.value.macdRsiSig) macdRsiSignals.push(r.value.macdRsiSig);
                if (r.value.trendlineSig) trendlineSignals.push(r.value.trendlineSig);
            }
        }
        
        processed += batch.length;
        if (processed % 50 === 0 || processed === SCAN_STOCKS.length) {
            console.log(`[POTENTIAL] ⏳ ${processed}/${SCAN_STOCKS.length}, found ${signals.length} potential, ${macdRsiSignals.length} MACD/RSI signals`);
        }
        
        if (i + BATCH_SIZE < SCAN_STOCKS.length) {
            await new Promise(r => setTimeout(r, BATCH_DELAY));
        }
    }

    // Sắp xếp theo RS giảm dần
    signals.sort((a, b) => b.rs - a.rs);

    // Sắp xếp tín hiệu MACD/RSI (BUY lên trước)
    macdRsiSignals.sort((a, b) => {
        if (a.signalType === b.signalType) {
            return b.volume - a.volume;
        }
        return a.signalType === 'BUY' ? -1 : 1;
    });

    trendlineSignals.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.volumeRatio - a.volumeRatio));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[POTENTIAL] ✅ Scan done in ${elapsed}s: ${signals.length} potential, ${macdRsiSignals.length} MACD/RSI signals, ${trendlineSignals.length} trendline`);

    // Ghi cache
    const cacheData = {
        success: true,
        timestamp: new Date().toISOString(),
        elapsedSeconds: parseFloat(elapsed),
        signals: signals,
        macdRsiSignals: macdRsiSignals,
        trendlineSignals: trendlineSignals
    };

    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf-8');
        console.log(`[POTENTIAL] 💾 Cached results to ${CACHE_FILE}`);
    } catch (e) {
        console.error(`[POTENTIAL] ⚠️ Failed to save cache:`, e.message);
    }

    return cacheData;
}

/**
 * Load cached signals
 */
function getCachedSignals() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const dataStr = fs.readFileSync(CACHE_FILE, 'utf-8');
            return JSON.parse(dataStr);
        }
    } catch (e) {
        console.error(`[POTENTIAL] ⚠️ Failed to read cache:`, e.message);
    }
    return null;
}

module.exports = {
    scanPotential,
    getCachedSignals,
    SCAN_STOCKS
};
