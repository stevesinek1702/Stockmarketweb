/**
 * VN STOCK MARKET - API MODULE
 * Các hàm gọi API lấy dữ liệu thị trường chứng khoán
 */

// Server Base URL - Dynamic base depending on how it is accessed
const SERVER_BASE = window.location.protocol.startsWith('http')
    ? window.location.origin
    : 'http://localhost:3000';

const API = {
    // Server API endpoints (proxy qua Node.js server)
    SERVER: {
        QUOTES: '/api/quotes',
        MARKET_STATS: '/api/market-stats',
        HISTORICAL: '/api/historical',
        TRADING_STATS: '/api/trading-stats',
        INVESTOR_STATS: '/api/investor-stats',
        INVESTOR_ALL: '/api/investor-all',
        INDUSTRY_FLOW: '/api/industry-flow',
        BREADTH_BREAKOUT: '/api/breadth-breakout',
        SECURITIES_FLOW: '/api/securities-flow',
        DASHBOARD: '/api/dashboard',
        VNINDEX_HISTORY: '/api/vnindex-history',
        FOREIGN_DAILY: '/api/foreign-daily',
        POTENTIAL_STOCKS: '/api/potential-stocks',
        POTENTIAL_SCAN: '/api/potential-stocks/scan',
        BREAKOUT_TRENDLINE: '/api/breakout-trendline',
        // SEPA scoring + TA engine (Subsystem #1/#2)
        SEPA_SCAN: '/api/sepa-scan',
        SEPA_SCORE: '/api/sepa-score',
        TA_DETAIL: '/api/ta',
        TA_META: '/api/ta-meta',
        // Signal + per-stock analysis
        SIGNAL: '/api/signal',
        SIGNALS: '/api/signals',
        ICHIMOKU: '/api/ichimoku',
        ELLIOTT: '/api/elliott',
        SECTOR_STRENGTH: '/api/sector-strength',
        STOCK_INVESTOR_FLOW: '/api/stock-investor-flow',
        ALL_STOCKS: '/api/all-stocks',
        AI_STOCK_PICKER: '/api/ai/stock-picker',
        // Broker + autoexec (Subsystem #5/#6)
        BROKER_STATUS: '/api/broker/status',
        BROKER_PORTFOLIO: '/api/broker/portfolio',
        BROKER_PLACE_ORDER: '/api/broker/place-order',
        BROKER_CANCEL_ORDER: '/api/broker/cancel-order',
        AUTOEXEC_STATUS: '/api/admin/autoexec/status',
        AUTOEXEC_ENABLE: '/api/admin/autoexec/enable',
        AUTOEXEC_DISABLE: '/api/admin/autoexec/disable',
        AUTOEXEC_RUN_ONCE: '/api/admin/autoexec/run-once'
    },

    // Original FireAnt API endpoints (for reference)
    FIREANT: {
        BASE: 'https://www.fireant.vn/api/Data',
        QUOTES: '/Markets/Quotes',
        INTRADAY_STATS: '/Markets/IntradayMarketStatistic',
        HISTORICAL: '/Markets/HistoricalQuotes',
        TRADING_STATS: '/Markets/TradingStatistic'
    },


    // Fitrade API endpoints
    FITRADE: {
        BASE: 'https://apigw.fitrade.vn/pbapi/api',
        INDUSTRY_FLOW: '/indActiveBuySell',
        SECURITIES_FLOW: '/MW/ActiveBuyTradingSec'
    },

    // Fialda API endpoints
    FIALDA: {
        BASE: 'https://fwtapi2.fialda.com/api/services/app/Derivative',
        TOP_INFLUENTIAL: '/GetTopInfluentialStocks'
    }
};


// Industry Codes for Fitrade
const INDUSTRY_CODES = "8350,8630,8770,2350,1750,9530,3350,6570,8980,3720,2710,1350,5370,4570,2770,3780,3530,2730,3570,2720,7570,2750,3760,2790,5550,6530,4530,1730,1770,5330,0530,0570,3740";

// Sample Stock Symbols
const STOCK_SYMBOLS = [
    'VNM', 'VHM', 'VIC', 'HPG', 'TCB', 'VCB', 'BID', 'CTG', 'MBB', 'VPB',
    'FPT', 'MWG', 'MSN', 'GAS', 'PLX', 'SAB', 'VNM', 'VRE', 'POW', 'REE',
    'SSI', 'VCI', 'VND', 'HCM', 'SHS', 'DIG', 'PDR', 'NVL', 'DXG', 'KDH'
];

// ICB Industry Mapping
const ICB_CODE_TO_NAME = {
    "500": "Dầu khí",
    "1300": "Hóa chất",
    "1700": "Tài nguyên Cơ bản",
    "2300": "Xây dựng & Vật liệu",
    "2700": "Hàng & Dịch vụ Công nghiệp",
    "3300": "Ô tô & Phụ tùng",
    "3500": "Thực phẩm & Đồ uống",
    "3700": "Hàng cá nhân & Gia dụng",
    "4500": "Y tế",
    "5300": "Bán lẻ",
    "5500": "Truyền thông",
    "5700": "Du lịch & Giải trí",
    "6500": "Viễn thông",
    "7500": "Điện, nước & xăng dầu khí đốt",
    "8300": "Ngân hàng",
    "8500": "Bảo hiểm",
    "8600": "Bất động sản",
    "8700": "Dịch vụ tài chính",
    "9500": "Công nghệ"
};

/**
 * Utility function to format date for API calls
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Utility function to format number as Vietnamese currency
 */
function formatCurrency(value) {
    if (value === null || value === undefined) return '--';

    const absValue = Math.abs(value);
    const sign = value >= 0 ? '+' : '-';

    if (absValue >= 1e12) {
        return sign + (absValue / 1e12).toFixed(1) + ' nghìn tỷ';
    } else if (absValue >= 1e9) {
        return sign + (absValue / 1e9).toFixed(1) + ' tỷ';
    } else if (absValue >= 1e6) {
        return sign + (absValue / 1e6).toFixed(1) + ' triệu';
    }
    return sign + absValue.toLocaleString('vi-VN');
}

/**
 * Format VND với dấu phân cách hàng nghìn đầy đủ (vd 1.000.000.000 ₫).
 * Dùng cho NAV/cash/portfolio — dễ đọc hơn formatCurrency (rút gọn).
 */
function formatVND(value) {
    if (value === null || value === undefined || isNaN(value)) return '--';
    return Math.round(value).toLocaleString('vi-VN') + ' ₫';
}

/**
 * Utility function to format number with Vietnamese locale
 */
function formatNumber(value, decimals = 0) {
    if (value === null || value === undefined) return '--';
    return value.toLocaleString('vi-VN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

/**
 * Utility function to format percentage
 */
function formatPercent(value, withSign = true) {
    if (value === null || value === undefined) return '--';
    const sign = withSign && value >= 0 ? '+' : '';
    return sign + (value * 100).toFixed(2) + '%';
}

/**
 * Utility function to format volume
 */
function formatVolume(value) {
    if (value === null || value === undefined) return '--';

    if (value >= 1e9) {
        return (value / 1e9).toFixed(1) + 'B';
    } else if (value >= 1e6) {
        return (value / 1e6).toFixed(1) + 'M';
    } else if (value >= 1e3) {
        return (value / 1e3).toFixed(1) + 'K';
    }
    return value.toLocaleString('vi-VN');
}

/**
 * Sample/Mock Data Generator
 * Used when APIs are blocked by CORS or not available
 */
const MockData = {
    // Generate random stock data
    generateStockData(symbol) {
        const basePrice = Math.random() * 100 + 10;
        const change = (Math.random() - 0.5) * 5;
        const volume = Math.floor(Math.random() * 10000000);

        return {
            symbol: symbol,
            name: `Công ty ${symbol}`,
            price: basePrice,
            change: change,
            changePercent: change / basePrice,
            volume: volume,
            value: volume * basePrice * 1000,
            open: basePrice - change / 2,
            high: basePrice + Math.abs(change),
            low: basePrice - Math.abs(change)
        };
    },

    // Generate index data
    generateIndexData(indexName, baseValue) {
        const change = (Math.random() - 0.5) * 20;
        const volume = Math.floor(Math.random() * 1e9);
        const value = Math.floor(Math.random() * 30000);

        return {
            name: indexName,
            value: baseValue + change,
            change: change,
            changePercent: change / baseValue,
            volume: volume,
            totalValue: value,
            advances: Math.floor(Math.random() * 300),
            declines: Math.floor(Math.random() * 200),
            unchanged: Math.floor(Math.random() * 100),
            demandStrength: 50
        };
    },

    // Generate investor flow data
    generateInvestorFlow() {
        return {
            foreign: {
                net: (Math.random() - 0.3) * 500,
                topBuy: [
                    { symbol: 'VNM', value: Math.random() * 100 },
                    { symbol: 'VHM', value: Math.random() * 80 },
                    { symbol: 'HPG', value: Math.random() * 60 },
                    { symbol: 'VIC', value: Math.random() * 50 },
                    { symbol: 'TCB', value: Math.random() * 40 }
                ],
                topSell: [
                    { symbol: 'SSI', value: -Math.random() * 70 },
                    { symbol: 'VCI', value: -Math.random() * 55 },
                    { symbol: 'MBB', value: -Math.random() * 45 },
                    { symbol: 'FPT', value: -Math.random() * 35 },
                    { symbol: 'VND', value: -Math.random() * 30 }
                ]
            },
            individual: {
                net: (Math.random() - 0.7) * 800,
                topBuy: [
                    { symbol: 'TCB', value: Math.random() * 80 },
                    { symbol: 'MBB', value: Math.random() * 65 },
                    { symbol: 'VPB', value: Math.random() * 55 }
                ],
                topSell: [
                    { symbol: 'VNM', value: -Math.random() * 90 },
                    { symbol: 'VHM', value: -Math.random() * 80 },
                    { symbol: 'VIC', value: -Math.random() * 70 }
                ]
            },
            proprietary: {
                net: (Math.random() - 0.4) * 200,
                topBuy: [
                    { symbol: 'FPT', value: Math.random() * 40 },
                    { symbol: 'MWG', value: Math.random() * 35 },
                    { symbol: 'VRE', value: Math.random() * 25 }
                ],
                topSell: [
                    { symbol: 'DIG', value: -Math.random() * 25 },
                    { symbol: 'PDR', value: -Math.random() * 18 },
                    { symbol: 'NVL', value: -Math.random() * 15 }
                ]
            },
            institution: {
                net: (Math.random() - 0.3) * 300,
                topBuy: [
                    { symbol: 'VCB', value: Math.random() * 50 },
                    { symbol: 'BID', value: Math.random() * 40 },
                    { symbol: 'CTG', value: Math.random() * 35 }
                ],
                topSell: [
                    { symbol: 'PLX', value: -Math.random() * 15 },
                    { symbol: 'GAS', value: -Math.random() * 12 },
                    { symbol: 'POW', value: -Math.random() * 10 }
                ]
            }
        };
    },

    // Generate industry flow data (Fiintrade shape: net flow by investor group, tỷ)
    generateIndustryFlow() {
        const industries = [
            { code: '8300', name: 'Ngân hàng' }, { code: '8600', name: 'Bất động sản' },
            { code: '9500', name: 'Công nghệ' }, { code: '1700', name: 'Tài nguyên Cơ bản' },
            { code: '0500', name: 'Dầu khí' }, { code: '8700', name: 'Dịch vụ tài chính' },
            { code: '3500', name: 'Thực phẩm và đồ uống' }, { code: '2300', name: 'Xây dựng và VLXD' },
            { code: '5300', name: 'Bán lẻ' }, { code: '4500', name: 'Y tế' },
            { code: '1300', name: 'Hóa chất' }, { code: '7500', name: 'Tiện ích' }
        ];
        const r = () => Math.round((Math.random() - 0.5) * 400 * 10) / 10;

        return industries.map(ind => {
            const toChuc = r(), tuDoanh = r(), nuocNgoai = r();
            const netSmart = Math.round((toChuc + tuDoanh + nuocNgoai) * 10) / 10;
            return {
                code: ind.code,
                name: ind.name,
                closeIndex: Math.round(Math.random() * 1000),
                percentChange: Math.round((Math.random() - 0.5) * 40) / 10,
                caNhan: -netSmart,
                toChuc, tuDoanh, nuocNgoai, netSmart
            };
        }).sort((a, b) => b.netSmart - a.netSmart);
    },

    // Generate breakout signals
    generateBreakoutSignals() {
        const signals = [];
        const symbols = ['HPG', 'VNM', 'FPT', 'MWG', 'TCB', 'VCB', 'VHM', 'VIC', 'MBB', 'VPB'];
        const today = new Date();

        for (let i = 0; i < 10; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - Math.floor(Math.random() * 7));

            const breakPrice = Math.random() * 100 + 20;
            const currentPrice = breakPrice * (1 + (Math.random() * 0.1 - 0.02));
            const profit = (currentPrice - breakPrice) / breakPrice;

            signals.push({
                date: date,
                symbol: symbols[i % symbols.length],
                breakDayClose: breakPrice * (1 + Math.random() * 0.03),
                currentClose: currentPrice,
                volume: Math.floor(Math.random() * 15000000),
                roc: Math.random() * 0.05,
                breakPrice: breakPrice,
                profit: profit,
                signal: 'Break Trendline (18000%)'
            });
        }

        return signals.sort((a, b) => b.date - a.date);
    },

    // Generate price board data
    generatePriceBoard() {
        return STOCK_SYMBOLS.map(symbol => this.generateStockData(symbol));
    },

    // Generate historical index data for charts
    generateHistoricalData(days = 30) {
        const data = [];
        const today = new Date();
        let baseValue = 1200;

        for (let i = days; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);

            baseValue += (Math.random() - 0.48) * 15;

            data.push({
                date: date,
                value: baseValue,
                volume: Math.floor(Math.random() * 1e9)
            });
        }

        return data;
    },

    // Generate raw historical OHLCV records (FireAnt-like shape) for candlestick charts.
    generateHistoricalOHLC(days = 365) {
        const data = [];
        const today = new Date();
        let prevClose = 1200;

        for (let i = days; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);

            const open = prevClose;
            const close = Math.max(1, open + (Math.random() - 0.48) * 15);
            const high = Math.max(open, close) + Math.random() * 5;
            const low = Math.min(open, close) - Math.random() * 5;

            data.push({
                Date: date.toISOString(),
                Open: open,
                High: high,
                Low: low,
                Close: close,
                Volume: Math.floor(Math.random() * 1e9)
            });

            prevClose = close;
        }

        return data;
    }
};

/**
 * API Data Fetcher Class
 * Gọi API qua server proxy, fallback về mock data nếu server không available
 */
class StockDataFetcher {
    constructor() {
        this.useMockData = false; // Thử gọi server trước
        this.serverAvailable = null; // null = chưa check, true/false = đã check
    }

    /**
     * Check if server is available
     */
    async checkServerAvailable() {
        if (this.serverAvailable !== null) return this.serverAvailable;

        try {
            const response = await fetch(`${SERVER_BASE}/api/health`, {
                method: 'GET',
                timeout: 3000
            });
            this.serverAvailable = response.ok;
            console.log(`🔌 Server status: ${this.serverAvailable ? '✅ Available' : '❌ Not available'}`);
        } catch (error) {
            this.serverAvailable = false;
            console.log('🔌 Server not available, using mock data');
        }

        this.useMockData = !this.serverAvailable;
        return this.serverAvailable;
    }

    /**
     * Fetch with fallback to mock data
     */
    async fetchWithFallback(url, mockDataFn) {
        await this.checkServerAvailable();

        if (this.useMockData) {
            return mockDataFn();
        }

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (error) {
            console.warn(`API Error: ${url}`, error.message);
            return mockDataFn();
        }
    }

    /**
     * Fetch market indices (VNINDEX, VN30, HNX)
     */
    async fetchMarketIndices() {
        await this.checkServerAvailable();

        if (this.useMockData) {
            return {
                vnindex: MockData.generateIndexData('VNINDEX', 1240),
                vn30: MockData.generateIndexData('VN30', 1280),
                hnx: MockData.generateIndexData('HNX', 230)
            };
        }

        try {
            // Fetch all indices in parallel
            const [vnindexRes, vn30Res, hnxRes] = await Promise.all([
                fetch(`${SERVER_BASE}/api/market-stats?symbol=HOSTC&_t=${Date.now()}`),
                fetch(`${SERVER_BASE}/api/market-stats?symbol=VN30&_t=${Date.now()}`),
                fetch(`${SERVER_BASE}/api/market-stats?symbol=HNX&_t=${Date.now()}`)
            ]);

            const vnindexData = await vnindexRes.json();
            const vn30Data = await vn30Res.json();
            const hnxData = await hnxRes.json();

            // Transform API response to our format
            return {
                vnindex: this.transformIndexData(vnindexData, 'VNINDEX'),
                vn30: this.transformIndexData(vn30Data, 'VN30'),
                hnx: this.transformIndexData(hnxData, 'HNX')
            };
        } catch (error) {
            console.error('Error fetching market indices:', error);
            return {
                vnindex: MockData.generateIndexData('VNINDEX', 1240),
                vn30: MockData.generateIndexData('VN30', 1280),
                hnx: MockData.generateIndexData('HNX', 230)
            };
        }
    }

    /**
     * Transform API index data to our format
     */
    transformIndexData(data, indexName) {
        if (!data || data.error) {
            return MockData.generateIndexData(indexName, indexName === 'HNX' ? 230 : 1240);
        }

        // Handle array response (FireAnt returns array) - Get LATEST data point (last item)
        const item = Array.isArray(data) ? data[data.length - 1] : data;

        if (!item) {
            return MockData.generateIndexData(indexName, indexName === 'HNX' ? 230 : 1240);
        }

        // Calculate demand strength
        const activeBuy = item.TotalActiveBuyVolume || 0;
        const activeSell = item.TotalActiveSellVolume || 0;
        const totalActive = activeBuy + activeSell;
        const demandStrength = totalActive > 0 ? ((activeBuy / totalActive) * 100).toFixed(1) : 50;

        return {
            name: indexName,
            value: item.IndexCurrent || item.Close || 0,
            change: item.PriceChange || 0,
            changePercent: item.PricePercentChange || 0,
            volume: item.TotalVolume || 0,
            totalValue: (item.TotalValue || 0) / 1e9, // Convert to tỷ
            advances: item.Advances || 0,
            declines: item.Declines || 0,
            unchanged: item.Unchange || 0,
            demandStrength: demandStrength
        };
    }

    /**
     * Fetch stock quotes
     */
    async fetchStockQuotes(symbols = STOCK_SYMBOLS) {
        await this.checkServerAvailable();

        if (this.useMockData) {
            return MockData.generatePriceBoard();
        }

        try {
            const symbolsStr = symbols.join(',');
            const response = await fetch(`${SERVER_BASE}/api/quotes?symbols=${symbolsStr}&_t=${Date.now()}`);
            const data = await response.json();

            if (data.error || !Array.isArray(data)) {
                return MockData.generatePriceBoard();
            }

            // Transform to our format
            return data.map(item => ({
                symbol: item.Symbol,
                name: item.Name || `Công ty ${item.Symbol}`,
                price: item.PriceCurrent || item.PriceClose || 0,
                change: item.PriceChange || 0,
                changePercent: item.PricePercentChange || 0,
                volume: item.TotalVolume || item.Volume || 0,
                value: item.TotalValue || 0,
                open: item.PriceOpen || 0,
                high: item.PriceHigh || 0,
                low: item.PriceLow || 0
            }));
        } catch (error) {
            console.error('Error fetching stock quotes:', error);
            return MockData.generatePriceBoard();
        }
    }

    /**
     * Transform investor data
     */
    transformInvestorData(data, type) {
        if (!data || !data.items) {
            const mockFlow = MockData.generateInvestorFlow();
            return mockFlow[type];
        }

        const items = data.items || [];
        const topBuy = items.filter(i => i.netVal > 0).slice(0, 5).map(i => ({
            symbol: i.ticker,
            value: i.netVal / 1e9 // Convert to tỷ
        }));

        const topSell = items.filter(i => i.netVal < 0).slice(0, 5).map(i => ({
            symbol: i.ticker,
            value: i.netVal / 1e9
        }));

        const totalNet = items.reduce((sum, i) => sum + (i.netVal || 0), 0) / 1e9;

        return {
            net: totalNet,
            topBuy: topBuy,
            topSell: topSell
        };
    }

    /**
     * Fetch industry flow data
     * Response từ Fiintrade: { code, name, closeIndex, percentChange, caNhan, toChuc, tuDoanh, nuocNgoai, netSmart }
     * @param {number} timeRange 1 (1 ngày) | 5 (5 ngày) | 20 (20 ngày) | 0 (từ đầu năm)
     */
    async fetchIndustryFlow(timeRange = 1) {
        await this.checkServerAvailable();

        if (this.useMockData) {
            return MockData.generateIndustryFlow();
        }

        try {
            // Server endpoint (Fiintrade) đã xử lý logic và trả về data đúng format
            const response = await fetch(`${SERVER_BASE}/api/industry-flow?timeRange=${timeRange}&level=2`);
            const result = await response.json();

            if (!result.success || !result.data) {
                console.warn('Industry flow API error, using mock data');
                return MockData.generateIndustryFlow();
            }

            console.log(`✅ Industry flow (Fiintrade): ${result.data.length} ngành, timeRange=${result.timeRange}`);

            // Data đã được server xử lý đúng format, chỉ cần return
            return result.data;
        } catch (error) {
            console.error('Error fetching industry flow:', error);
            return MockData.generateIndustryFlow();
        }
    }

    /**
     * Fetch breakout signals
     */
    async fetchBreakoutSignals() {
        await this.checkServerAvailable();
        if (this.useMockData) {
            return MockData.generateBreakoutSignals();
        }
        try {
            const response = await fetch(`${SERVER_BASE}${API.SERVER.BREAKOUT_TRENDLINE}?_t=${Date.now()}`);
            const result = await response.json();
            if (result && result.success && Array.isArray(result.data)) {
                console.log(`✅ Break trendline: ${result.data.length} tín hiệu (real)`);
                return result.data;
            }
            return [];
        } catch (error) {
            console.error('Error fetching breakout signals:', error);
            return MockData.generateBreakoutSignals();
        }
    }

    /**
     * Fetch potential stock signals from server cache
     */
    async fetchPotentialStocks() {
        await this.checkServerAvailable();

        if (this.useMockData) {
            // Generate mock potential stocks if server is not available
            return {
                success: true,
                timestamp: new Date().toISOString(),
                signals: MockData.generateBreakoutSignals().map(s => ({
                    symbol: s.symbol,
                    price: s.currentClose,
                    change: s.profit * 100,
                    ma20: s.breakPrice * 0.95,
                    ma50: s.breakPrice * 0.90,
                    distMA20: 5.0,
                    rs: Math.random() * 30 + 60, // 60 - 90
                    rsMA10: 70.0,
                    volume: s.volume,
                    avgVolume20: s.volume * 0.8,
                    volumeRatio: 1.2,
                    rsTrend: Math.random() > 0.5 ? 'uptrend' : 'sideways',
                    date: s.date.toISOString().split('T')[0]
                }))
            };
        }

        try {
            const response = await fetch(`${SERVER_BASE}${API.SERVER.POTENTIAL_STOCKS}?_t=${Date.now()}`);
            return await response.json();
        } catch (error) {
            console.error('Error fetching potential stocks:', error);
            return { success: false, error: error.message, signals: [] };
        }
    }

    /**
     * Trigger a new potential stock scan on the server
     */
    async triggerPotentialScan() {
        await this.checkServerAvailable();

        if (this.useMockData) {
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve(this.fetchPotentialStocks());
                }, 2000); // Simulate 2 seconds scan in mock mode
            });
        }

        try {
            const response = await fetch(`${SERVER_BASE}${API.SERVER.POTENTIAL_SCAN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            return await response.json();
        } catch (error) {
            console.error('Error triggering potential scan:', error);
            return { success: false, error: error.message, signals: [] };
        }
    }

    /**
     * Fetch historical data for charts
     */
    async fetchHistoricalData(symbol = 'VNINDEX', days = 30) {
        await this.checkServerAvailable();

        if (this.useMockData) {
            return MockData.generateHistoricalData(days);
        }

        try {
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            const response = await fetch(
                `${SERVER_BASE}/api/historical?symbol=${symbol}&startDate=${formatDate(startDate)}&endDate=${formatDate(endDate)}`
            );
            const data = await response.json();

            if (data.error || !Array.isArray(data)) {
                return MockData.generateHistoricalData(days);
            }

            // Transform to our format
            return data.map(item => ({
                date: new Date(item.Date),
                value: item.Close || item.PriceClose || 0,
                volume: item.Volume || item.TotalVolume || 0
            }));
        } catch (error) {
            console.error('Error fetching historical data:', error);
            return MockData.generateHistoricalData(days);
        }
    }

    /**
     * Fetch raw historical OHLCV records for candlestick charts.
     *
     * Unlike fetchHistoricalData() (which reshapes to keep only Close+Volume),
     * this returns the raw FireAnt HistoricalQuotes array containing the full
     * Open/High/Low/Close/Volume fields, so chart adapters (TVAdapter) can map
     * complete candlesticks. Falls back to mock OHLCV when the server is
     * unavailable or returns an error.
     *
     * @param {string} symbol
     * @param {number} days - lookback window in days
     * @returns {Promise<Array<object>>} raw OHLCV records
     */
    async fetchHistoricalOHLC(symbol = 'VNINDEX', days = 365) {
        await this.checkServerAvailable();

        if (this.useMockData) {
            return MockData.generateHistoricalOHLC(days);
        }

        try {
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            const response = await fetch(
                `${SERVER_BASE}/api/historical?symbol=${symbol}&startDate=${formatDate(startDate)}&endDate=${formatDate(endDate)}`
            );
            const data = await response.json();

            if (data.error || !Array.isArray(data)) {
                return MockData.generateHistoricalOHLC(days);
            }

            // Return raw records untouched; adapters pick the OHLCV fields.
            return data;
        } catch (error) {
            console.error('Error fetching historical OHLC data:', error);
            return MockData.generateHistoricalOHLC(days);
        }
    }
}

// Export the data fetcher instance
const dataFetcher = new StockDataFetcher();

// Export utility functions
window.StockAPI = {
    SERVER_BASE,
    SERVER: API.SERVER,
    dataFetcher,
    MockData,
    formatCurrency,
    formatVND,
    formatNumber,
    formatPercent,
    formatVolume,
    formatDate,
    ICB_CODE_TO_NAME,
    STOCK_SYMBOLS
};
