/**
 * VN STOCK MARKET - MAIN APPLICATION
 * Logic chính của ứng dụng: Tab navigation, Data loading, UI updates
 */

// Application State
const AppState = {
    currentTab: 'dashboard',
    lastUpdate: null,
    isLoading: false,
    abortController: null,
    data: {
        indices: null,
        stockQuotes: null,
        investorFlow: null,
        industryFlow: null,
        breakoutSignals: null,
        potentialStocks: null
    }
};

// Load saved settings
const SAVED_SETTINGS_KEY = 'vnstock_priceboard_settings';
const savedSettings = localStorage.getItem(SAVED_SETTINGS_KEY) ? JSON.parse(localStorage.getItem(SAVED_SETTINGS_KEY)) : null;

// Price Board State - 3 Exchanges
const PriceBoardState = {
    currentExchange: 'HSX',
    allStocks: {
        HSX: [],
        HNX: [],
        UPCOM: []
    },
    isLoading: false,
    searchTerm: '',
    sortColumn: savedSettings?.sortColumn || 'value',
    sortDirection: savedSettings?.sortDirection || 'desc',
    filters: savedSettings?.filters || {}
};

// DOM Elements
const elements = {
    tabs: null,
    tabContents: null,
    refreshBtn: null,
    updateTime: null
};

/**
 * Initialize the application
 */
async function initApp() {
    console.log('🚀 Initializing VN Stock Market App...');

    // Cache DOM elements
    cacheElements();

    // Set up event listeners
    setupEventListeners();

    // Load initial data
    await loadAllData();

    // Initialize charts
    initializeCharts();

    // Setup industry flow controls (date picker, checkboxes, chart)
    setupIndustryFlowControls();

    // Load dashboard charts (bubble + line charts)
    loadDashboardCharts();

    // Initialize Stock Filter Tab
    initStockFilterTab();

    // Initialize Potential Stocks Tab
    initPotentialStocksTab();

    // Load Dashboard: Market stats and Influential stocks
    loadMarketDashboard();
    loadInfluentialStocks();
    loadInvestorFlow();
    loadForeignFlow();
    loadInvestorTop();
    setupStockInvestorFlowControls();
    loadStockInvestorFlow('HPG', 'Daily');

    // Update time display
    updateTimeDisplay();

    // Set up auto-refresh (every 60 seconds - reduced from 30s to lower API load)
    setInterval(() => {
        // Chỉ refresh khi đang xem dashboard để tránh gọi API nặng khi ở tab khác
        if (!AppState.isLoading && AppState.currentTab === 'dashboard') {
            loadAllData();
            // Refresh cả VNINDEX/VN30 stats và Mã Tác Động (trước đây bị bỏ sót)
            loadMarketDashboard();
            loadInfluentialStocks();
            loadInvestorFlow();
            loadForeignFlow();
            loadInvestorTop();
            // FIX (lực cầu chiều): các biểu đồ Lực Cầu / Chuyển Động Ngành / Vốn Hóa
            // trước đây chỉ tải 1 lần lúc mở trang nên buổi chiều không cập nhật.
            // Đưa vào vòng auto-refresh để dữ liệu intraday chạy đủ cả phiên.
            loadDashboardCharts();
        }
    }, 60000);

    // Initialize Drag-and-Drop for dashboard cards
    if (window.DnD) {
        window.DnD.refresh();
    }

    console.log('✅ App initialized successfully!');
}

/**
 * Cache frequently used DOM elements
 */
function cacheElements() {
    elements.tabs = document.querySelectorAll('.nav-btn');
    elements.tabContents = document.querySelectorAll('.tab-content');
    elements.refreshBtn = document.getElementById('refreshBtn');
    elements.updateTime = document.getElementById('updateTime');
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
    // Tab navigation
    elements.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.getAttribute('data-tab');
            switchTab(tabId);
        });
    });

    // Refresh button
    if (elements.refreshBtn) {
        elements.refreshBtn.addEventListener('click', async () => {
            if (!AppState.isLoading) {
                await loadAllData();
            }
        });
    }

    // Stock search
    const searchInput = document.getElementById('stock-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            PriceBoardState.searchTerm = e.target.value;
            filterStockTable(e.target.value);
        });
    }

    // Exchange tabs for price board
    const exchangeTabs = document.querySelectorAll('.exchange-tab');
    exchangeTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            exchangeTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const exchange = tab.getAttribute('data-exchange');
            PriceBoardState.currentExchange = exchange;
            renderPriceBoard();
        });
    });

    // Sort columns for price board
    setupPriceBoardSort();

    // Breakout period filter
    const breakoutPeriod = document.getElementById('breakout-period');
    if (breakoutPeriod) {
        breakoutPeriod.addEventListener('change', (e) => {
            filterBreakoutSignals(e.target.value);
        });
    }
}

/**
 * Switch between tabs
 */
function switchTab(tabId) {
    AppState.currentTab = tabId;

    // Update active tab button
    elements.tabs.forEach(tab => {
        if (tab.getAttribute('data-tab') === tabId) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // Update visible content
    elements.tabContents.forEach(content => {
        if (content.id === tabId) {
            content.classList.add('active');
        } else {
            content.classList.remove('active');
        }
    });

    // Trigger chart resize
    window.dispatchEvent(new Event('resize'));
}

/**
 * Load all market data
 */
async function loadAllData() {
    // Cancel any previous in-flight requests
    if (AppState.abortController) {
        AppState.abortController.abort();
    }
    AppState.abortController = new AbortController();
    const signal = AppState.abortController.signal;

    console.log('📊 Loading market data...');
    AppState.isLoading = true;

    // Hiện skeleton cho danh sách Top Mua/Bán Ròng ở lần tải đầu (chưa có dữ liệu)
    if (window.UIState && !AppState.topNetData) {
        const buyListEl = document.getElementById('top-buy-stocks');
        const sellListEl = document.getElementById('top-sell-stocks');
        if (buyListEl) window.UIState.showSkeleton(buyListEl, 'list', 6);
        if (sellListEl) window.UIState.showSkeleton(sellListEl, 'list', 6);
    }

    try {
        // Load all data in parallel
        const [indices, stockQuotes, industryFlow, breakoutSignals, marketBreadth, topNetStocks, potentialStocks] = await Promise.all([
            StockAPI.dataFetcher.fetchMarketIndices(),
            StockAPI.dataFetcher.fetchStockQuotes(),
            StockAPI.dataFetcher.fetchIndustryFlow(1),
            StockAPI.dataFetcher.fetchBreakoutSignals(),
            fetchMarketBreadth(),
            fetchTopNetStocks(),
            StockAPI.dataFetcher.fetchPotentialStocks()
        ]);

        // Check if request was aborted
        if (signal.aborted) {
            console.log('⚠️ Request aborted, skipping update');
            return;
        }

        // Store data in state
        AppState.data = {
            indices,
            stockQuotes,
            industryFlow,
            breakoutSignals,
            marketBreadth,
            topNetStocks,
            potentialStocks
        };

        // Update UI
        updateMarketOverview(indices, marketBreadth);
        updateIndustryLists(industryFlow);
        updateTopStocks(topNetStocks);
        updatePriceBoard(stockQuotes);
        updateBreakoutTable(breakoutSignals);
        updateIndustryTable(industryFlow);
        updatePotentialStocksUI(potentialStocks);

        // Refresh charts
        refreshCharts();

        // Update timestamp
        AppState.lastUpdate = new Date();
        updateTimeDisplay();

        console.log('✅ Data loaded successfully!');
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('⚠️ Request aborted');
        } else {
            console.error('❌ Error loading data:', error);
        }
    } finally {
        AppState.isLoading = false;
    }
}

/**
 * Fetch market breadth data from server API
 */
async function fetchMarketBreadth() {
    try {
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/market-breadth`);
        const data = await response.json();
        if (data.success && data.data) {
            console.log('📊 Market breadth:', data.data.hostc);
            return data.data;
        }
        return null;
    } catch (error) {
        console.error('Failed to fetch market breadth:', error);
        return null;
    }
}

/**
 * Fetch top mua/bán ròng from Google Sheets via server proxy
 */
async function fetchTopNetStocks() {
    try {
        console.log('📊 Fetching top net stocks from Google Sheets...');
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/top-net-stocks`);
        const result = await response.json();

        if (result.success && result.data) {
            console.log('✅ Top net stocks:', {
                dailyBuy: result.data.daily.buy.length,
                dailySell: result.data.daily.sell.length,
                monthlyBuy: result.data.monthly.buy.length,
                monthlySell: result.data.monthly.sell.length
            });
            return result.data;
        }
        return null;
    } catch (error) {
        console.error('Failed to fetch top net stocks:', error);
        return null;
    }
}

/**
 * Load Market Dashboard - VNINDEX/VN30 stats with Lực cầu
 */
async function loadMarketDashboard() {
    try {
        console.log('📊 Loading market dashboard...');
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/market-dashboard`);
        const result = await response.json();

        if (!result.success || !result.data) {
            console.error('Market dashboard API failed');
            return;
        }

        const { vnindex, vn30 } = result.data;

        // Update VNINDEX card
        const vnindexValue = document.getElementById('vnindex-value');
        const vnindexChange = document.getElementById('vnindex-change');
        const vnindexVolume = document.getElementById('vnindex-volume');
        const vnindexValueTraded = document.getElementById('vnindex-value-traded');
        const vnindexDemand = document.getElementById('vnindex-demand');

        if (vnindexValue) vnindexValue.textContent = vnindex.indexCurrent.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (vnindexChange) {
            const isPositive = parseFloat(vnindex.change) >= 0;
            vnindexChange.className = `index-change ${isPositive ? 'positive' : 'negative'}`;
            vnindexChange.innerHTML = `
                <span class="change-value">${isPositive ? '+' : ''}${vnindex.change}</span>
                <span class="change-percent">(${isPositive ? '+' : ''}${vnindex.percentChange}%)</span>
            `;
        }
        if (vnindexVolume) vnindexVolume.textContent = `${vnindex.totalVolume}M`;
        if (vnindexValueTraded) vnindexValueTraded.textContent = `${vnindex.totalValue.toLocaleString('vi-VN')} tỷ`;

        // % thay đổi KLGD vs phiên trước
        const vnVolChangeEl = document.getElementById('vnindex-volume-change');
        if (vnVolChangeEl && vnindex.prevTotalVolume) {
            const volPct = ((vnindex.totalVolume - vnindex.prevTotalVolume) / vnindex.prevTotalVolume * 100).toFixed(1);
            const volUp = volPct >= 0;
            vnVolChangeEl.textContent = `${volUp ? '▲' : '▼'} ${volUp ? '+' : ''}${volPct}%`;
            vnVolChangeEl.className = `stat-change ${volUp ? 'positive' : 'negative'}`;
        }
        // % thay đổi GTGD vs phiên trước
        const vnValChangeEl = document.getElementById('vnindex-value-change');
        if (vnValChangeEl && vnindex.prevTotalValue) {
            const valPct = ((vnindex.totalValue - vnindex.prevTotalValue) / vnindex.prevTotalValue * 100).toFixed(1);
            const valUp = valPct >= 0;
            vnValChangeEl.textContent = `${valUp ? '▲' : '▼'} ${valUp ? '+' : ''}${valPct}%`;
            vnValChangeEl.className = `stat-change ${valUp ? 'positive' : 'negative'}`;
        }
        if (vnindexDemand) {
            const demand = parseFloat(vnindex.demandStrength);
            vnindexDemand.textContent = `${demand}%`;
            vnindexDemand.className = `stat-value ${demand >= 50 ? 'positive' : 'negative'}`;
        }

        // Update VNINDEX breadth stats (Compact)
        const vnAdv = document.getElementById('vnindex-advance');
        const vnUnc = document.getElementById('vnindex-unchanged');
        const vnDec = document.getElementById('vnindex-decline');
        if (vnAdv) vnAdv.textContent = vnindex.advances || 0;
        if (vnUnc) vnUnc.textContent = vnindex.unchanged || 0;
        if (vnDec) vnDec.textContent = vnindex.declines || 0;

        const vnTotal = (vnindex.advances || 0) + (vnindex.declines || 0) + (vnindex.unchanged || 0);
        if (vnTotal > 0) {
            const bAdv = document.getElementById('vnindex-bar-advance');
            const bUnc = document.getElementById('vnindex-bar-unchanged');
            const bDec = document.getElementById('vnindex-bar-decline');
            if (bAdv) bAdv.style.width = (vnindex.advances / vnTotal * 100) + '%';
            if (bUnc) bUnc.style.width = (vnindex.unchanged / vnTotal * 100) + '%';
            if (bDec) bDec.style.width = (vnindex.declines / vnTotal * 100) + '%';
        }

        // Update VN30 card
        const vn30Value = document.getElementById('vn30-value');
        const vn30Change = document.getElementById('vn30-change');
        const vn30Volume = document.getElementById('vn30-volume');
        const vn30ValueTraded = document.getElementById('vn30-value-traded');
        const vn30Demand = document.getElementById('vn30-demand');

        if (vn30Value) vn30Value.textContent = vn30.indexCurrent.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (vn30Change) {
            const isPositive = parseFloat(vn30.change) >= 0;
            vn30Change.className = `index-change ${isPositive ? 'positive' : 'negative'}`;
            vn30Change.innerHTML = `
                <span class="change-value">${isPositive ? '+' : ''}${vn30.change}</span>
                <span class="change-percent">(${isPositive ? '+' : ''}${vn30.percentChange}%)</span>
            `;
        }
        if (vn30Volume) vn30Volume.textContent = `${vn30.totalVolume}M`;
        if (vn30ValueTraded) vn30ValueTraded.textContent = `${vn30.totalValue.toLocaleString('vi-VN')} tỷ`;

        // % thay đổi KLGD vs phiên trước
        const vn30VolChangeEl = document.getElementById('vn30-volume-change');
        if (vn30VolChangeEl && vn30.prevTotalVolume) {
            const volPct = ((vn30.totalVolume - vn30.prevTotalVolume) / vn30.prevTotalVolume * 100).toFixed(1);
            const volUp = volPct >= 0;
            vn30VolChangeEl.textContent = `${volUp ? '▲' : '▼'} ${volUp ? '+' : ''}${volPct}%`;
            vn30VolChangeEl.className = `stat-change ${volUp ? 'positive' : 'negative'}`;
        }
        // % thay đổi GTGD vs phiên trước
        const vn30ValChangeEl = document.getElementById('vn30-value-change');
        if (vn30ValChangeEl && vn30.prevTotalValue) {
            const valPct = ((vn30.totalValue - vn30.prevTotalValue) / vn30.prevTotalValue * 100).toFixed(1);
            const valUp = valPct >= 0;
            vn30ValChangeEl.textContent = `${valUp ? '▲' : '▼'} ${valUp ? '+' : ''}${valPct}%`;
            vn30ValChangeEl.className = `stat-change ${valUp ? 'positive' : 'negative'}`;
        }
        if (vn30Demand) {
            const demand = parseFloat(vn30.demandStrength);
            vn30Demand.textContent = `${demand}%`;
            vn30Demand.className = `stat-value ${demand >= 50 ? 'positive' : 'negative'}`;
        }

        // Update VN30 breadth stats (Compact)
        const vn30Adv = document.getElementById('vn30-advance');
        const vn30Unc = document.getElementById('vn30-unchanged');
        const vn30Dec = document.getElementById('vn30-decline');
        if (vn30Adv) vn30Adv.textContent = vn30.advances || 0;
        if (vn30Unc) vn30Unc.textContent = vn30.unchanged || 0;
        if (vn30Dec) vn30Dec.textContent = vn30.declines || 0;

        const vn30Total = (vn30.advances || 0) + (vn30.declines || 0) + (vn30.unchanged || 0);
        if (vn30Total > 0) {
            const bAdv = document.getElementById('vn30-bar-advance');
            const bUnc = document.getElementById('vn30-bar-unchanged');
            const bDec = document.getElementById('vn30-bar-decline');
            if (bAdv) bAdv.style.width = (vn30.advances / vn30Total * 100) + '%';
            if (bUnc) bUnc.style.width = (vn30.unchanged / vn30Total * 100) + '%';
            if (bDec) bDec.style.width = (vn30.declines / vn30Total * 100) + '%';
        }

        console.log('✅ Market dashboard updated:', vnindex.indexCurrent, vn30.indexCurrent);
        window._marketDashboardLoaded = true;
    } catch (error) {
        console.error('Failed to load market dashboard:', error);
        // Chỉ hiện lỗi nếu chưa từng load thành công (tránh ghi đè dữ liệu cũ còn tốt)
        if (!window._marketDashboardLoaded) {
            ['vnindex-value', 'vn30-value'].forEach(id => {
                const el = document.getElementById(id);
                if (el && (el.textContent === '--' || !el.textContent)) el.textContent = 'N/A';
            });
        }
    }
}

/**
 * Load Influential Stocks - Top stocks impacting VNINDEX
 */
async function loadInfluentialStocks() {
    // Panel chứa 2 bảng Mã Tác Động (target container, không phải tbody)
    const panel = document.querySelector('#panel-influential .influential-stocks-grid');

    // Chỉ hiện skeleton ở lần tải đầu (chưa có dữ liệu tốt) để không phá dữ liệu cũ khi auto-refresh
    if (window.UIState && panel && !window._influentialLoaded) {
        window.UIState.showSkeleton(panel, 'table', 6);
    }

    try {
        console.log('📊 Loading influential stocks...');
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/influential-stocks`);
        const result = await response.json();

        if (!result.success || !result.data) {
            console.error('Influential stocks API failed');
            // Chỉ chuyển sang Error_State khi chưa có dữ liệu tốt trước đó (Req 6.4)
            if (window.UIState && panel && !window._influentialLoaded) {
                window.UIState.showError(panel, 'Không tải được dữ liệu Mã Tác Động.', loadInfluentialStocks);
            } else {
                _setInfluentialError('Không tải được dữ liệu');
            }
            return;
        }

        const { positive, negative } = result.data;

        // Tải thành công nhưng không có dữ liệu -> Empty_State
        const hasData = (positive && positive.length) || (negative && negative.length);
        if (!hasData) {
            if (window.UIState && panel) {
                window.UIState.showEmpty(panel, 'Không có dữ liệu mã tác động.');
            }
            window._influentialLoaded = true;
            return;
        }

        // Có dữ liệu -> khôi phục nội dung thật trước khi render
        if (window.UIState && panel) {
            window.UIState.showContent(panel);
        }

        // Update positive stocks table
        const positiveTbody = document.getElementById('positive-stocks-tbody');
        if (positiveTbody && positive) {
            let html = '';
            positive.forEach(stock => {
                html += `<tr>
                    <td><strong>${stock.symbol}</strong></td>
                    <td class="positive">+${stock.value.toFixed(2)}</td>
                </tr>`;
            });
            positiveTbody.innerHTML = html || '<tr><td colspan="2">Không có dữ liệu</td></tr>';
        }

        // Update negative stocks table
        const negativeTbody = document.getElementById('negative-stocks-tbody');
        if (negativeTbody && negative) {
            let html = '';
            negative.forEach(stock => {
                html += `<tr>
                    <td><strong>${stock.symbol}</strong></td>
                    <td class="negative">${stock.value.toFixed(2)}</td>
                </tr>`;
            });
            negativeTbody.innerHTML = html || '<tr><td colspan="2">Không có dữ liệu</td></tr>';
        }

        console.log(`✅ Influential stocks: ${positive.length} positive, ${negative.length} negative`);
        window._influentialLoaded = true;
    } catch (error) {
        console.error('Failed to load influential stocks:', error);
        // Giữ dữ liệu cũ còn tốt; chỉ hiện Error_State khi chưa từng tải thành công (Req 6.4)
        if (window.UIState && panel && !window._influentialLoaded) {
            window.UIState.showError(panel, 'Lỗi kết nối, thử lại sau.', loadInfluentialStocks);
        } else {
            _setInfluentialError('Lỗi kết nối, thử lại sau');
        }
    }
}

/**
 * Hiển thị thông báo lỗi cho bảng Mã Tác Động (thay vì kẹt "Đang tải...")
 */
function _setInfluentialError(msg) {
    const pos = document.getElementById('positive-stocks-tbody');
    const neg = document.getElementById('negative-stocks-tbody');
    const errRow = `<tr><td colspan="2" style="color: var(--text-muted); text-align:center;">⚠️ ${msg}</td></tr>`;
    if (pos) pos.innerHTML = errRow;
    if (neg) neg.innerHTML = errRow;
}

/**
 * Update market overview cards
 */
function updateMarketOverview(indices, marketBreadth) {
    if (!indices) return;

    // VNINDEX
    if (indices.vnindex) {
        updateIndexCard('vnindex', indices.vnindex);
    }

    // VN30
    if (indices.vn30) {
        updateIndexCard('vn30', indices.vn30);
    }

    // HNX
    if (indices.hnx) {
        updateIndexCard('hnx', indices.hnx);
    }

    // Market Breadth - ưu tiên dữ liệu từ API market-breadth (chính xác hơn)
    let totalAdvances, totalDeclines, totalUnchanged;

    if (marketBreadth && marketBreadth.hostc) {
        // Dữ liệu thực từ API
        totalAdvances = marketBreadth.hostc.advances || 0;
        totalDeclines = marketBreadth.hostc.declines || 0;
        totalUnchanged = marketBreadth.hostc.unchanged || 0;
        console.log(`📊 Độ rộng TT thực: ${totalAdvances} tăng, ${totalDeclines} giảm, ${totalUnchanged} đứng`);

        // Cập nhật giá trị khối ngoại thực từ API
        updateForeignFlowFromAPI(marketBreadth);
    } else {
        // Fallback từ indices
        totalAdvances = indices.vnindex?.advances || 0;
        totalDeclines = indices.vnindex?.declines || 0;
        totalUnchanged = indices.vnindex?.unchanged || 0;
    }

    const total = totalAdvances + totalDeclines + totalUnchanged;

    const elAdvance = document.getElementById('advance-count');
    const elDecline = document.getElementById('decline-count');
    const elUnchanged = document.getElementById('unchanged-count');

    if (elAdvance) elAdvance.textContent = totalAdvances;
    if (elDecline) elDecline.textContent = totalDeclines;
    if (elUnchanged) elUnchanged.textContent = totalUnchanged;

    if (total > 0) {
        const barAdv = document.getElementById('breadth-advance-bar');
        const barUnc = document.getElementById('breadth-unchanged-bar');
        const barDec = document.getElementById('breadth-decline-bar');

        if (barAdv) barAdv.style.width = `${(totalAdvances / total) * 100}%`;
        if (barUnc) barUnc.style.width = `${(totalUnchanged / total) * 100}%`;
        if (barDec) barDec.style.width = `${(totalDeclines / total) * 100}%`;
    }
}

/**
 * Update foreign flow from real market-breadth API.
 *
 * LƯU Ý: Panel "🌍 Khối Ngoại Mua/Bán Ròng" giờ do loadForeignFlow() (nguồn
 * /api/foreign-flow — Fiintrade toàn thị trường) phụ trách. Hàm này KHÔNG còn
 * ghi vào panel đó nữa để tránh "đánh nhau" với loader (trước đây ghi net
 * chỉ-tính-HOSE của FireAnt vào #foreign-buy, gây sai số). Giữ lại side-effect
 * cập nhật #vnindex-value-traded (GTGD HOSE) cho card chỉ số.
 */
function updateForeignFlowFromAPI(marketBreadth) {
    if (!marketBreadth || !marketBreadth.hostc) return;

    const hostc = marketBreadth.hostc;

    // Log tham khảo (net chỉ-HOSE, phiên hiện tại) — KHÔNG hiển thị lên panel khối ngoại.
    const buyForeignValue = (hostc.buyForeignValue || 0) / 1e9;
    const sellForeignValue = (hostc.sellForeignValue || 0) / 1e9;
    const netForeignValue = buyForeignValue - sellForeignValue;
    console.log(`💰 (FireAnt HOSE) Mua ${buyForeignValue.toFixed(1)} tỷ, Bán ${sellForeignValue.toFixed(1)} tỷ, Net ${netForeignValue.toFixed(1)} tỷ — panel khối ngoại dùng /api/foreign-flow`);

    // Cập nhật totalValue (GTGD) cho card chỉ số (giữ nguyên hành vi cũ)
    const totalValueBillions = (hostc.totalValue || 0) / 1e9;
    const vnindexValueEl = document.getElementById('vnindex-value-traded');
    if (vnindexValueEl) {
        vnindexValueEl.textContent = StockAPI.formatNumber(totalValueBillions, 0) + ' tỷ';
    }
}

/**
 * Update individual index card
 * CHÚ Ý: Không ghi đè nếu loadMarketDashboard đã cập nhật (ưu tiên API market-dashboard)
 */
function updateIndexCard(indexId, data) {
    // Skip nếu loadMarketDashboard đã cập nhật (kiểm tra flag)
    if (window._marketDashboardLoaded) return;

    const valueEl = document.getElementById(`${indexId}-value`);
    const changeEl = document.getElementById(`${indexId}-change`);
    const volumeEl = document.getElementById(`${indexId}-volume`);
    const valueTradedEl = document.getElementById(`${indexId}-value-traded`);

    if (valueEl) {
        valueEl.textContent = StockAPI.formatNumber(data.value, 2);
    }

    if (changeEl) {
        const isPositive = data.change >= 0;
        changeEl.className = `index-change ${isPositive ? 'positive' : 'negative'}`;
        changeEl.innerHTML = `
            <span class="change-value">${isPositive ? '+' : ''}${StockAPI.formatNumber(data.change, 2)}</span>
            <span class="change-percent">(${isPositive ? '+' : ''}${(data.changePercent * 100).toFixed(2)}%)</span>
        `;
    }

    if (volumeEl) {
        volumeEl.textContent = StockAPI.formatVolume(data.volume);
    }

    if (valueTradedEl) {
        valueTradedEl.textContent = StockAPI.formatNumber(data.totalValue, 0) + ' tỷ';
    }
}

/**
 * Update industry lists
 */
function updateIndustryLists(industryFlow) {
    if (!industryFlow || industryFlow.length === 0) return;

    const buyList = document.getElementById('industry-buy-list');
    const sellList = document.getElementById('industry-sell-list');

    // Dòng tiền lớn (TC+TD+NN) ròng; fallback value1D nếu dùng dữ liệu cũ
    const metric = (i) => (typeof i.netSmart === 'number' ? i.netSmart : (i.value1D || 0));

    const sorted = [...industryFlow].sort((a, b) => metric(b) - metric(a));
    const topBuy = sorted.slice(0, 5).filter(i => metric(i) > 0);
    const topSell = sorted.slice(-5).filter(i => metric(i) < 0).reverse();

    if (buyList) {
        buyList.innerHTML = topBuy.map(item => `
            <li>
                <span class="industry-name">${item.name}</span>
                <span class="industry-value positive">+${metric(item).toFixed(1)} tỷ</span>
            </li>
        `).join('');
    }

    if (sellList) {
        sellList.innerHTML = topSell.map(item => `
            <li>
                <span class="industry-name">${item.name}</span>
                <span class="industry-value negative">${metric(item).toFixed(1)} tỷ</span>
            </li>
        `).join('');
    }
}

/**
 * Update top stocks lists
 */
function updateTopStocks(topNetData) {
    const buyList = document.getElementById('top-buy-stocks');
    const sellList = document.getElementById('top-sell-stocks');

    if (!topNetData || !topNetData.daily) {
        // Nếu đã có dữ liệu cũ thì giữ nguyên, chỉ báo trạng thái rỗng khi chưa có gì
        if (!AppState.topNetData) {
            if (window.UIState) {
                if (buyList) window.UIState.showEmpty(buyList, 'Chưa có dữ liệu');
                if (sellList) window.UIState.showEmpty(sellList, 'Chưa có dữ liệu');
            } else {
                const msg = '<li><span class="stock-code">--</span><span class="stock-value" style="color:var(--text-muted)">Chưa có dữ liệu</span></li>';
                if (buyList) buyList.innerHTML = msg;
                if (sellList) sellList.innerHTML = msg;
            }
        }
        return;
    }

    // Có dữ liệu -> khôi phục nội dung thật (gỡ skeleton) trước khi render
    if (window.UIState) {
        if (buyList) window.UIState.showContent(buyList);
        if (sellList) window.UIState.showContent(sellList);
    }

    AppState.topNetData = topNetData;
    renderTopNetStocksList('daily');
}

function renderTopNetStocksList(period) {
    const buyList = document.getElementById('top-buy-stocks');
    const sellList = document.getElementById('top-sell-stocks');
    const data = AppState.topNetData;
    if (!data) return;

    const periodData = data[period] || data.daily;

    if (buyList && periodData.buy) {
        buyList.innerHTML = periodData.buy.slice(0, 10).map(stock => `
            <li onclick="window.open('https://finance.vietstock.vn/${stock.symbol}.htm', '_blank')" style="cursor:pointer;">
                <span class="stock-code">${stock.symbol}</span>
                <span class="stock-value positive">+${stock.value.toFixed(1)} tỷ</span>
            </li>
        `).join('');
    }

    if (sellList && periodData.sell) {
        sellList.innerHTML = periodData.sell.slice(0, 10).map(stock => `
            <li onclick="window.open('https://finance.vietstock.vn/${stock.symbol}.htm', '_blank')" style="cursor:pointer;">
                <span class="stock-code">${stock.symbol}</span>
                <span class="stock-value negative">${stock.value.toFixed(1)} tỷ</span>
            </li>
        `).join('');
    }

    document.querySelectorAll('.top-net-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });
}

/**
 * Format giá gọn gàng: 61.900,00 -> 61.9 (bỏ ,00 và chia cho 1000)
 */
function formatPriceCompact(price) {
    if (price === null || price === undefined || isNaN(price)) return '--';
    // Giá đã chia 1000, chỉ cần format đẹp
    const val = parseFloat(price);
    if (val === 0) return '0';
    // Remove trailing zeros
    return val.toFixed(1).replace(/\.0$/, '');
}

/**
 * Load all stocks from 3 exchanges
 */
async function loadAllStocksFor3Exchanges() {
    const loadingEl = document.getElementById('price-loading');
    if (loadingEl) loadingEl.classList.add('loading');
    PriceBoardState.isLoading = true;

    // Fast path: if we have freshly cached stocks (< 2 min old), render from the
    // client cache instantly and skip the heavy /api/all-stocks call entirely.
    const cachedStocks = window.StockCache && window.StockCache.getFresh('all-stocks', 120000);
    if (cachedStocks && (cachedStocks.HSX || cachedStocks.HNX || cachedStocks.UPCOM)) {
        PriceBoardState.allStocks = cachedStocks;
        const c = {
            HSX: cachedStocks.HSX?.length || 0,
            HNX: cachedStocks.HNX?.length || 0,
            UPCOM: cachedStocks.UPCOM?.length || 0
        };
        const hsxEl = document.getElementById('hsx-count'); if (hsxEl) hsxEl.textContent = c.HSX;
        const hnxEl = document.getElementById('hnx-count'); if (hnxEl) hnxEl.textContent = c.HNX;
        const upEl = document.getElementById('upcom-count'); if (upEl) upEl.textContent = c.UPCOM;
        console.log(`⚡ Price board from cache: HSX ${c.HSX}, HNX ${c.HNX}, UPCOM ${c.UPCOM}`);
        renderPriceBoard();
        PriceBoardState.isLoading = false;
        if (loadingEl) loadingEl.classList.remove('loading');
        return;
    }

    try {
        console.log('📊 Loading all stocks from 3 exchanges...');
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/all-stocks?_t=${Date.now()}`);
        const result = await response.json();

        // API có thể trả về:
        // 1. Array trực tiếp: [{ symbol, exchange, ... }]
        // 2. Object với success: { success: true, stocks: { HSX: [...], HNX: [...], UPCOM: [...] } }
        // 3. Object với stocks field: { stocks: [...] }

        if (Array.isArray(result)) {
            // Trường hợp 1: Array trực tiếp - phân loại theo exchange field
            PriceBoardState.allStocks = {
                HSX: result.filter(s => s.exchange === 'HOSTC'),
                HNX: result.filter(s => s.exchange === 'HNX'),
                UPCOM: result.filter(s => s.exchange === 'UPCOM' || s.exchange === 'UPCoM')
            };
            console.log('✓ Parsed as direct array');
        } else if (result.stocks && typeof result.stocks === 'object') {
            if (Array.isArray(result.stocks)) {
                // Trường hợp 3: object với stocks array
                PriceBoardState.allStocks = {
                    HSX: result.stocks.filter(s => s.exchange === 'HOSTC'),
                    HNX: result.stocks.filter(s => s.exchange === 'HNX'),
                    UPCOM: result.stocks.filter(s => s.exchange === 'UPCOM' || s.exchange === 'UPCoM')
                };
                console.log('✓ Parsed as object with stocks array');
            } else {
                // Trường hợp 2: object với HSX, HNX, UPCOM keys
                PriceBoardState.allStocks = result.stocks;
                console.log('✓ Parsed as object with exchange keys');
            }
        } else {
            throw new Error('Unexpected API response format');
        }

        // Update counts
        const counts = {
            HSX: PriceBoardState.allStocks.HSX?.length || 0,
            HNX: PriceBoardState.allStocks.HNX?.length || 0,
            UPCOM: PriceBoardState.allStocks.UPCOM?.length || 0
        };

        document.getElementById('hsx-count')?.textContent && (document.getElementById('hsx-count').textContent = counts.HSX);
        document.getElementById('hnx-count')?.textContent && (document.getElementById('hnx-count').textContent = counts.HNX);
        document.getElementById('upcom-count')?.textContent && (document.getElementById('upcom-count').textContent = counts.UPCOM);

        console.log(`✅ Loaded: HSX ${counts.HSX}, HNX ${counts.HNX}, UPCOM ${counts.UPCOM}`);

        // Cache the parsed result so the next visit/reload is instant (SWR).
        if (window.StockCache) window.StockCache.set('all-stocks', PriceBoardState.allStocks);

        renderPriceBoard();
    } catch (error) {
        console.error('Error loading all stocks:', error);
        const tbody = document.getElementById('price-tbody');
        if (tbody && !(PriceBoardState.allStocks.HSX?.length > 0)) {
            tbody.innerHTML = '<tr><td colspan="11" style="text-align:center; color:var(--text-muted); padding:24px;">⚠️ Không tải được bảng giá. Vui lòng thử lại.</td></tr>';
        }
    } finally {
        PriceBoardState.isLoading = false;
        if (loadingEl) loadingEl.classList.remove('loading');
    }
}

/**
 * Render price board for current exchange
 */
function renderPriceBoard() {
    const tbody = document.getElementById('price-tbody');
    if (!tbody) return;

    let stocks = [...(PriceBoardState.allStocks[PriceBoardState.currentExchange] || [])];

    // DEBUG PERSISTENCE
    if (Object.keys(PriceBoardState.filters).length > 0) {
        console.log('🔍 Applying filters:', PriceBoardState.filters);
    }


    // Filter by search term
    if (PriceBoardState.searchTerm) {
        const term = PriceBoardState.searchTerm.toUpperCase();
        stocks = stocks.filter(s => s.symbol?.toUpperCase().includes(term) || s.name?.toUpperCase().includes(term));
    }

    // Apply column filters
    Object.keys(PriceBoardState.filters).forEach(key => {
        const filter = PriceBoardState.filters[key];
        const val = parseFloat(filter.value);
        if (!isNaN(val)) {
            stocks = stocks.filter(s => {
                const stockVal = parseFloat(s[key] || 0);
                if (filter.operator === 'gt') return stockVal > val;
                if (filter.operator === 'lt') return stockVal < val;
                if (filter.operator === 'eq') return stockVal === val;
                return true;
            });
        }
    });

    // Sort stocks
    const sortCol = PriceBoardState.sortColumn;
    const sortDir = PriceBoardState.sortDirection;

    stocks.sort((a, b) => {
        let valA = a[sortCol];
        let valB = b[sortCol];

        // Handle null/undefined
        if (valA === null || valA === undefined) valA = sortDir === 'asc' ? Infinity : -Infinity;
        if (valB === null || valB === undefined) valB = sortDir === 'asc' ? Infinity : -Infinity;

        // String sort for symbol
        if (sortCol === 'symbol') {
            return sortDir === 'asc'
                ? String(valA).localeCompare(String(valB))
                : String(valB).localeCompare(String(valA));
        }

        // Numeric sort
        return sortDir === 'asc' ? valA - valB : valB - valA;
    });

    // Highlight filtered columns & show/hide clear button
    const table = document.getElementById('price-table');
    const hasFilters = Object.keys(PriceBoardState.filters).length > 0;
    const clearBtn = document.getElementById('btn-clear-price-filters');
    if (clearBtn) clearBtn.style.display = hasFilters ? '' : 'none';
    if (table) {
        table.querySelectorAll('th.sortable').forEach(th => {
            const key = th.dataset.sort;
            if (PriceBoardState.filters[key]) {
                th.classList.add('filtered-column');
            } else {
                th.classList.remove('filtered-column');
            }
        });
    }

    tbody.innerHTML = stocks.map(stock => {
        const change = stock.change || 0;
        const changePercent = stock.changePercent || 0;
        const isPositive = change > 0;
        const isNegative = change < 0;
        const changeClass = isPositive ? 'positive' : (isNegative ? 'negative' : '');

        // Volume ratio: > 100 = cao hơn TB, < 100 = thấp hơn TB
        const volRatio = stock.volRatio || 0;
        const volRatioClass = volRatio > 100 ? 'positive' : (volRatio < 100 ? 'negative' : '');

        return `
            <tr onclick="openTradingViewModal('${stock.symbol}')" style="cursor: pointer;">
                <td class="stock-code">${stock.symbol || ''}</td>
                <td>${formatPriceCompact(stock.price)}</td>
                <td class="${changeClass}">${isPositive ? '+' : ''}${formatPriceCompact(change)}</td>
                <td class="${changeClass}">${isPositive ? '+' : ''}${changePercent.toFixed(2)}%</td>
                <td>${StockAPI.formatVolume(stock.volume)}</td>
                <td class="${volRatioClass}">${volRatio}%</td>
                <td>${stock.value ? stock.value.toFixed(1) : '--'} tỷ</td>
                <td>${stock.ma10 || '--'}</td>
                <td>${stock.ma20 || '--'}</td>
                <td>${stock.ma45 || '--'}</td>
                <td class="${stock.demandStrength > 50 ? 'text-green' : (stock.demandStrength < 50 ? 'text-red' : 'text-yellow')}">${stock.demandStrength}%</td>
            </tr>
        `;
    }).join('');
}

/**
/**
 * Setup sort and filter functionality for price board table headers
 */
function setupPriceBoardSort() {
    const table = document.getElementById('price-table');
    if (!table) return;

    const headers = table.querySelectorAll('th.sortable');
    headers.forEach(header => {
        // Prevent double binding
        if (header.dataset.bound) return;
        header.dataset.bound = true;

        header.addEventListener('click', (e) => {
            e.stopPropagation(); // Stop propagation to prevent immediate closing

            // Close any open popups first
            closeFilterPopup();

            const rect = header.getBoundingClientRect();
            const sortKey = header.getAttribute('data-sort');
            const headerText = header.textContent.trim().replace('⇅', '').trim();

            createFilterPopup(sortKey, headerText, rect.left + window.scrollX, rect.bottom + window.scrollY);
        });
    });

    // Close popup when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.filter-popup') && !e.target.closest('th.sortable')) {
            closeFilterPopup();
        }
    });
}

/**
 * Close existing filter popup
 */
function closeFilterPopup() {
    const existingPopup = document.querySelector('.filter-popup');
    if (existingPopup) {
        existingPopup.remove();
    }
}

/**
 * Create and show filter popup
 */
function createFilterPopup(key, title, left, top) {
    const popup = document.createElement('div');
    popup.className = 'filter-popup';
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    const currentFilter = PriceBoardState.filters[key] || { operator: 'gt', value: '' };

    popup.innerHTML = `
        <div class="filter-section">
            <div class="filter-title">Sắp xếp</div>
            <div class="filter-inputs">
                <div class="filter-option" id="sort-asc">
                    <span class="icon">⬆️</span> Tăng dần
                </div>
                <div class="filter-option" id="sort-desc">
                    <span class="icon">⬇️</span> Giảm dần
                </div>
            </div>
        </div>
        <div class="filter-section">
            <div class="filter-title">Lọc "${title}"</div>
            <div class="filter-inputs">
                <div class="filter-group">
                    <select id="filter-operator">
                        <option value="gt" ${currentFilter.operator === 'gt' ? 'selected' : ''}>Lớn hơn (>)</option>
                        <option value="lt" ${currentFilter.operator === 'lt' ? 'selected' : ''}>Nhỏ hơn (<)</option>
                        <option value="eq" ${currentFilter.operator === 'eq' ? 'selected' : ''}>Bằng (=)</option>
                    </select>
                </div>
                <div class="filter-group">
                    <input type="number" id="filter-value" placeholder="Giá trị..." value="${currentFilter.value}">
                </div>
                <div class="filter-actions">
                    <button class="btn-filter-clear" id="btn-clear-filter">Xóa</button>
                    <button class="btn-filter-apply" id="btn-apply-filter">Lọc</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(popup);

    // Bind events
    popup.querySelector('#sort-asc').addEventListener('click', () => {
        applySort(key, 'asc');
        closeFilterPopup();
    });

    popup.querySelector('#sort-desc').addEventListener('click', () => {
        applySort(key, 'desc');
        closeFilterPopup();
    });

    popup.querySelector('#btn-apply-filter').addEventListener('click', () => {
        const operator = popup.querySelector('#filter-operator').value;
        const value = popup.querySelector('#filter-value').value;
        applyFilter(key, operator, value);
        closeFilterPopup();
    });

    popup.querySelector('#btn-clear-filter').addEventListener('click', () => {
        clearFilter(key);
        closeFilterPopup();
    });

    // Auto focus input
    const input = popup.querySelector('#filter-value');
    if (input) input.focus();
}

function applySort(key, direction) {
    PriceBoardState.sortColumn = key;
    PriceBoardState.sortDirection = direction;
    savePriceBoardSettings();

    // Update header classes
    const headers = document.querySelectorAll('th.sortable');
    headers.forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
        if (h.getAttribute('data-sort') === key) {
            h.classList.add(direction === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });

    renderPriceBoard();
}

function applyFilter(key, operator, value) {
    if (value === '') {
        delete PriceBoardState.filters[key];
    } else {
        PriceBoardState.filters[key] = { operator, value: parseFloat(value) };
    }
    savePriceBoardSettings();
    renderPriceBoard();
}

function clearFilter(key) {
    delete PriceBoardState.filters[key];
    savePriceBoardSettings();
    renderPriceBoard();
}

function clearAllPriceFilters() {
    PriceBoardState.filters = {};
    savePriceBoardSettings();
    renderPriceBoard();
}

/**
 * Save Price Board settings to localStorage
 */
function savePriceBoardSettings() {
    const settings = {
        filters: PriceBoardState.filters,
        sortColumn: PriceBoardState.sortColumn,
        sortDirection: PriceBoardState.sortDirection
    };
    localStorage.setItem(SAVED_SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Update price board table (legacy - kept for compatibility)
 */
function updatePriceBoard(stockQuotes) {
    // Only load all stocks if user is on price board tab (lazy load)
    if (AppState.currentTab === 'price-board') {
        loadAllStocksFor3Exchanges();
    }
}

/**
 * Update breakout signals table
 */
let breakoutSignalsAll = [];

function _breakoutDaysAgo(signal) {
    if (typeof signal.daysAgo === 'number') return signal.daysAgo;
    return Math.round((Date.now() - new Date(signal.date).getTime()) / 86400000);
}

function applyBreakoutPeriod(signals, period) {
    const max = period === 'today' ? 1 : period === 'week' ? 7 : 31;
    return signals.filter(s => _breakoutDaysAgo(s) <= max);
}

function _renderBreakoutMini(signals) {
    const miniTbody = document.getElementById('breakout-tbody');
    if (!miniTbody) return;
    if (!signals.length) {
        miniTbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Chưa có tín hiệu break trendline</td></tr>';
        return;
    }
    miniTbody.innerHTML = signals.slice(0, 3).map(signal => {
        const profitClass = signal.profit >= 0 ? 'positive' : 'negative';
        const rocClass = (signal.roc || 0) >= 0 ? 'positive' : 'negative';
        const date = new Date(signal.date);
        return `
            <tr>
                <td>${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}</td>
                <td class="stock-code">${signal.symbol}</td>
                <td>${StockAPI.formatNumber(signal.breakPrice, 0)}</td>
                <td>${StockAPI.formatNumber(signal.currentClose, 0)}</td>
                <td>${StockAPI.formatVolume(signal.volume)}</td>
                <td class="${rocClass}">${(signal.roc || 0) >= 0 ? '+' : ''}${((signal.roc || 0) * 100).toFixed(2)}%</td>
                <td class="${profitClass}">${signal.profit >= 0 ? '+' : ''}${(signal.profit * 100).toFixed(2)}%</td>
                <td><span class="signal-badge">Break Trendline</span></td>
            </tr>`;
    }).join('');
}

function _renderBreakoutFull(signals) {
    const fullTbody = document.getElementById('breakout-full-tbody');
    if (fullTbody) {
        if (!signals.length) {
            fullTbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">Không có CP nào break trendline trong khoảng thời gian này</td></tr>';
        } else {
            fullTbody.innerHTML = signals.map(signal => {
                const profitClass = signal.profit >= 0 ? 'positive' : 'negative';
                const rocClass = (signal.roc || 0) >= 0 ? 'positive' : 'negative';
                const date = new Date(signal.date);
                return `
                    <tr>
                        <td>${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}</td>
                        <td class="stock-code">${signal.symbol}</td>
                        <td>${StockAPI.formatNumber(signal.breakDayClose, 0)}</td>
                        <td>${StockAPI.formatNumber(signal.currentClose, 0)}</td>
                        <td>${StockAPI.formatVolume(signal.volume)}</td>
                        <td class="${rocClass}">${(signal.roc || 0) >= 0 ? '+' : ''}${((signal.roc || 0) * 100).toFixed(2)}%</td>
                        <td>${StockAPI.formatNumber(signal.breakPrice, 0)}</td>
                        <td class="${profitClass}">${signal.profit >= 0 ? '+' : ''}${(signal.profit * 100).toFixed(2)}%</td>
                        <td><span class="signal-badge">${signal.signal || 'Break Trendline'}</span></td>
                    </tr>`;
            }).join('');
        }
    }
    const total = signals.length;
    const profitable = signals.filter(s => s.profit > 0).length;
    const winRate = total > 0 ? (profitable / total * 100).toFixed(0) : 0;
    const avgProfit = total > 0 ? signals.reduce((sum, s) => sum + s.profit, 0) / total * 100 : 0;
    const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setTxt('total-signals', total);
    setTxt('profitable-signals', profitable);
    setTxt('win-rate', winRate + '%');
    const avgEl = document.getElementById('avg-profit');
    if (avgEl) {
        avgEl.textContent = (avgProfit >= 0 ? '+' : '') + avgProfit.toFixed(2) + '%';
        avgEl.className = 'stat-number ' + (avgProfit >= 0 ? 'positive' : 'negative');
    }
}

function updateBreakoutTable(signals) {
    breakoutSignalsAll = Array.isArray(signals) ? signals.slice() : [];
    _renderBreakoutMini(breakoutSignalsAll);
    const periodEl = document.getElementById('breakout-period');
    const period = periodEl ? periodEl.value : 'today';
    _renderBreakoutFull(applyBreakoutPeriod(breakoutSignalsAll, period));
}

function filterBreakoutSignals(period) {
    _renderBreakoutFull(applyBreakoutPeriod(breakoutSignalsAll, period));
}

/**
 * Update industry analysis table
 */
function updateIndustryTable(industryFlow) {
    if (!industryFlow || industryFlow.length === 0) return;

    // Cache data for sorting
    cachedIndustryFlowData = industryFlow;

    renderIndustryTableRows(industryFlow);
}

// ==========================================
// INDUSTRY FLOW - DATE PICKER & CUMULATIVE CHART
// ==========================================

/**
 * State cho industry flow (dòng tiền ngành - Fiintrade)
 */
const IndustryFlowState = {
    timeRange: 1,   // 1 | 5 | 20 | 0 (YTD)
    data: null,
    chart: null
};

/**
 * Setup industry flow controls (timeRange selector) - Fiintrade
 */
function setupIndustryFlowControls() {
    const btns = document.querySelectorAll('.industry-timerange-btn');
    if (!btns.length) return;

    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            IndustryFlowState.timeRange = parseInt(btn.dataset.range);
            loadIndustryFlowTab(IndustryFlowState.timeRange);
        });
    });

    // Initial load
    loadIndustryFlowTab(IndustryFlowState.timeRange);
}

/**
 * Load dòng tiền ngành theo nhóm NĐT (Fiintrade) cho mốc thời gian chỉ định
 */
async function loadIndustryFlowTab(timeRange) {
    const rangeEl = document.getElementById('industry-date-range');
    try {
        if (rangeEl) rangeEl.textContent = 'Đang tải dữ liệu...';

        const data = await StockAPI.dataFetcher.fetchIndustryFlow(timeRange);

        if (!data || data.length === 0) {
            if (rangeEl) rangeEl.textContent = 'Không có dữ liệu';
            return;
        }

        IndustryFlowState.data = data;
        cachedIndustryFlowData = data;

        renderIndustryTableRows(data);
        renderIndustryFlowChart(data);
        renderIndustryHeatmap(data);

        const labelMap = { 1: 'Hôm nay', 5: '5 phiên gần nhất', 20: '20 phiên gần nhất', 0: 'Từ đầu năm' };
        if (rangeEl) rangeEl.textContent = `Dòng tiền ròng khớp lệnh theo nhóm NĐT · ${labelMap[timeRange] || ''} · đơn vị tỷ đồng`;

        // Preload ngầm top flow cho tất cả ngành (theo timeRange hiện tại) để click là ra ngay.
        // Trì hoãn 3s để không cạnh tranh request với industry-flow vừa load.
        setTimeout(() => { try { preloadIndustryTopFlow(); } catch (e) {} }, 3000);

        console.log(`✅ Industry flow tab loaded: ${data.length} ngành (timeRange=${timeRange})`);
    } catch (error) {
        console.error('Error loading industry flow tab:', error);
        if (rangeEl) rangeEl.textContent = 'Lỗi tải dữ liệu';
    }
}

/**
 * Render biểu đồ dòng tiền ròng theo ngành (thanh ngang, mỗi ngành 1 thanh = "dòng tiền lớn" TC+TD+NN).
 */
function renderIndustryFlowChart(data) {
    const canvas = document.getElementById('industry-cumulative-chart');
    if (!canvas) return;
    if (!data) data = IndustryFlowState.data;
    if (!data || !data.length) return;

    const ctx = canvas.getContext('2d');

    if (IndustryFlowState.chart) {
        IndustryFlowState.chart.destroy();
    }

    const sorted = [...data].sort((a, b) => (b.netSmart || 0) - (a.netSmart || 0));

    IndustryFlowState.chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sorted.map(d => d.name),
            datasets: [{
                label: 'Dòng tiền lớn (TC + TD + NN)',
                data: sorted.map(d => d.netSmart || 0),
                backgroundColor: sorted.map(d => (d.netSmart || 0) >= 0 ? 'rgba(38, 166, 91, 0.7)' : 'rgba(232, 65, 66, 0.7)'),
                borderColor: sorted.map(d => (d.netSmart || 0) >= 0 ? '#26a65b' : '#e84142'),
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            // Click vào bar ngành → mở modal top mã mua/bán ròng TC+TD+NN
            onClick: (evt, elements) => {
                if (elements.length === 0) return;
                const idx = elements[0].index;
                const d = sorted[idx];
                if (d && d.code) openIndustryTopFlowModal(d);
            },
            // Cursor pointer khi hover bar để báo "click được"
            onHover: (evt, elements) => {
                evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 40, 0.95)',
                    titleColor: '#fff',
                    bodyColor: '#ddd',
                    borderColor: '#444',
                    borderWidth: 1,
                    callbacks: {
                        title: (items) => items[0].label + '  (click để xem mã)',
                        label: function (context) {
                            const d = sorted[context.dataIndex] || {};
                            const f = (v) => (v >= 0 ? '+' : '') + (v || 0).toFixed(1);
                            return [
                                `Dòng tiền lớn: ${f(context.raw)} tỷ`,
                                `Nước ngoài: ${f(d.nuocNgoai)} · Tổ chức: ${f(d.toChuc)} · Tự doanh: ${f(d.tuDoanh)}`,
                                `Cá nhân: ${f(d.caNhan)} tỷ`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', callback: (v) => v.toLocaleString('vi-VN') + ' tỷ' }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#aaa', font: { size: 11 } }
                }
            }
        }
    });
}

/**
 * Cache cho modal top flow: key = `${code}|${days}` → { result, ts }.
 * Giữ 10 phút (600s). Click lại cùng ngành+cùng timeRange → dùng cache, không load lại.
 */
const IndustryTopFlowCache = new Map();
const TOPFLOW_CACHE_TTL = 10 * 60 * 1000; // 10 phút

/**
 * Mở modal top mã mua/bán ròng (TC+TD+NN) của 1 ngành.
 * Click vào bar ngành trong industry-cumulative-chart sẽ gọi hàm này.
 * @param {string} code ICB2 code (vd '8300')
 * @param {string} name tên ngành hiển thị
 */
async function openIndustryTopFlowModal(industry) {
    const modal = document.getElementById('industry-topflow-modal');
    const titleEl = document.getElementById('industry-topflow-title');
    const bodyEl = document.getElementById('industry-topflow-body');
    if (!modal || !titleEl || !bodyEl) return;

    const code = industry.code;
    const name = industry.name;
    // days = số phiên theo timeRange đang chọn (1/5/20/YTD→20)
    const tr = IndustryFlowState.timeRange || 1;
    const days = tr === 0 ? 20 : (tr === 1 ? 1 : tr); // 0=YTD → 20 cho gọn
    const cacheKey = `${code}|${days}`;

    // Tiêu đề có hiển thị con số dòng tiền lớn của ngành (màu xanh/đỏ) để dễ soi.
    // netSmart/nuocNgoai/toChuc/tuDoanh đã có trong data (tổng N phiên theo timeRange).
    const f = (v) => (v >= 0 ? '+' : '') + (v || 0).toFixed(1);
    const net = industry.netSmart;
    const netCls = (net || 0) >= 0 ? 'pos' : 'neg';
    const rangeWord = days === 1 ? 'Hôm nay' : (days === 5 ? '1 tuần' : (days === 20 ? '1 tháng' : `${days} phiên`));
    titleEl.innerHTML = `Top Mã Mua/Bán Ròng · ${name} <span class="topflow-title-net ${netCls}">(${f(net)} tỷ)</span> <span class="topflow-title-range">${rangeWord}</span>`;

    modal.style.display = 'block';

    // 1. Check cache trước — nếu còn hạn thì render ngay, không load lại
    const cached = IndustryTopFlowCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TOPFLOW_CACHE_TTL) {
        renderIndustryTopFlowModal(cached.result);
        return;
    }

    // 2. Không có cache → show loading + fetch
    bodyEl.innerHTML = `<div class="ma-breadth-empty" style="padding:30px;">⏳ Đang tải dòng tiền từng mã (${days} phiên)... ngành lớn có thể mất 10-30s</div>`;

    try {
        const res = await fetch(`${SERVER_BASE}/api/industry-top-flow?code=${code}&top=5&days=${days}`);
        const result = await res.json();
        if (!result.success) {
            bodyEl.innerHTML = `<div class="ma-breadth-empty">❌ ${result.error || 'Lỗi tải dữ liệu'}</div>`;
            return;
        }
        // Lưu cache
        IndustryTopFlowCache.set(cacheKey, { result, ts: Date.now() });
        renderIndustryTopFlowModal(result);
    } catch (err) {
        console.error('Industry top flow modal error:', err);
        bodyEl.innerHTML = '<div class="ma-breadth-empty">❌ Lỗi kết nối server</div>';
    }
}

/**
 * Preload ngầm tất cả ngành theo timeRange hiện tại, chạy nền sau khi tab load xong.
 * Mỗi ngành cách nhau 1s để tránh spike server. Bỏ qua ngành đã có cache còn hạn.
 * @param {number} days số phiên (mặc định theo IndustryFlowState.timeRange)
 */
function preloadIndustryTopFlow(days) {
    if (preloadIndustryTopFlow._running) return;
    const tr = IndustryFlowState.timeRange || 1;
    const d = days || (tr === 0 ? 20 : (tr === 1 ? 1 : tr));
    // Danh sách 18 ngành ICB2 (đồng bộ server)
    const codes = ['0500','1300','1700','2300','2700','3300','3500','3700','4500','5300','5500','5700','6500','7500','8300','8500','8600','8700','8900','9500'];

    preloadIndustryTopFlow._running = true;
    console.log(`[TopFlow] Bắt đầu preload ngầm ${codes.length} ngành (${d} phiên)...`);

    (async () => {
        for (const code of codes) {
            const cacheKey = `${code}|${d}`;
            // Bỏ qua nếu đã có cache còn hạn
            const cached = IndustryTopFlowCache.get(cacheKey);
            if (cached && Date.now() - cached.ts < TOPFLOW_CACHE_TTL) continue;

            try {
                const res = await fetch(`${SERVER_BASE}/api/industry-top-flow?code=${code}&top=5&days=${d}`);
                const result = await res.json();
                if (result.success) {
                    IndustryTopFlowCache.set(cacheKey, { result, ts: Date.now() });
                }
            } catch (e) {
                // Bỏ qua lỗi ngành nào đó, tiếp tục ngành khác
            }
            // Nghỉ 800ms giữa các ngành để không spike server
            await new Promise(r => setTimeout(r, 800));
        }
        preloadIndustryTopFlow._running = false;
        console.log(`[TopFlow] Preload xong. Cache có ${IndustryTopFlowCache.size} mục.`);
    })();
}

/** Đóng modal top flow. */
function closeIndustryTopFlowModal() {
    const modal = document.getElementById('industry-topflow-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * Render nội dung modal: 2 cột Top Mua Ròng / Top Bán Ròng.
 * Bảng đầy đủ: Mã | Giá | % | NN | TC | TD | Dòng tiền lớn (TC+TD+NN).
 * "Dòng tiền lớn" = tổng N phiên (Hôm nay / 1 tuần / 1 tháng).
 */
function renderIndustryTopFlowModal(result) {
    const bodyEl = document.getElementById('industry-topflow-body');
    const f = (v) => (v >= 0 ? '+' : '') + (v || 0).toFixed(1);
    const dates = result.dates || (result.date ? [result.date] : []);
    const shortDate = (iso) => { if (!iso) return '-'; const [y,m,d] = iso.split('-'); return `${d}/${m}`; };
    const rangeWord = result.days === 1 ? 'Hôm nay' : (result.days === 5 ? '1 tuần' : (result.days === 20 ? '1 tháng' : `${result.days} phiên`));

    // Bảng đầy đủ 7 cột: Mã | Giá | % | NN | TC | TD | Dòng tiền lớn
    const tableHead = `<tr>
        <th>Mã</th><th>Giá</th><th>%</th><th>NN</th><th>TC</th><th>TD</th><th>Dòng tiền lớn</th>
    </tr>`;

    // Lấy giá trị hiển thị cho từng cột tiền: dùng cum (tổng N phiên) khi multi-day, latest khi 1D
    const fmtRow = (s) => {
        const multi = result.days > 1;
        const nn = multi ? (s.nuocNgoaiCum != null ? s.nuocNgoaiCum : s.nuocNgoai) : s.nuocNgoai;
        const tc = multi ? (s.toChucCum != null ? s.toChucCum : s.toChuc) : s.toChuc;
        const td = multi ? (s.tuDoanhCum != null ? s.tuDoanhCum : s.tuDoanh) : s.tuDoanh;
        const net = multi ? s.netSmartCum : s.netSmart;
        return `
        <tr>
            <td><b>${s.ticker}</b></td>
            <td class="num">${(s.close||0).toLocaleString('vi-VN')}</td>
            <td class="num ${(s.percentChange||0) >= 0 ? 'pos' : 'neg'}">${f(s.percentChange)}%</td>
            <td class="num ${(nn||0) >= 0 ? 'pos' : 'neg'}">${f(nn)}</td>
            <td class="num ${(tc||0) >= 0 ? 'pos' : 'neg'}">${f(tc)}</td>
            <td class="num ${(td||0) >= 0 ? 'pos' : 'neg'}">${f(td)}</td>
            <td class="num ${(net||0) >= 0 ? 'pos' : 'neg'}"><b>${f(net)}</b></td>
        </tr>`;
    };

    const rangeLabel = dates.length > 1 ? `${rangeWord} (${shortDate(dates[0])} → ${shortDate(dates[dates.length-1])})` : `${rangeWord} ${result.date || '-'}`;

    bodyEl.innerHTML = `
        <div class="topflow-date">${rangeLabel} · ${result.stocksWithData}/${result.totalStocks} mã có dữ liệu</div>
        <div class="topflow-columns">
            <div class="topflow-col">
                <h4 class="topflow-h pos">🟢 Top ${result.topBuy.length} Mua Ròng</h4>
                <table class="data-table topflow-table"><thead>${tableHead}</thead>
                <tbody>${result.topBuy.map(fmtRow).join('') || '<tr><td colspan="99">Không có mã mua ròng</td></tr>'}</tbody></table>
            </div>
            <div class="topflow-col">
                <h4 class="topflow-h neg">🔴 Top ${result.topSell.length} Bán Ròng</h4>
                <table class="data-table topflow-table"><thead>${tableHead}</thead>
                <tbody>${result.topSell.map(fmtRow).join('') || '<tr><td colspan="99">Không có mã bán ròng</td></tr>'}</tbody></table>
            </div>
        </div>
        <button type="button" class="btn-secondary topflow-toggle-btn" id="topflow-toggle-btn">
            📋 Xem đầy đủ tất cả ${result.allStocks.length} mã
        </button>
        <div id="topflow-full-wrap" style="display:none; margin-top:10px;">
            <table class="data-table topflow-table"><thead>${tableHead}</thead>
            <tbody>${result.allStocks.map(fmtRow).join('')}</tbody></table>
        </div>`;

    // Toggle nút "Xem đầy đủ"
    const toggleBtn = document.getElementById('topflow-toggle-btn');
    const fullWrap = document.getElementById('topflow-full-wrap');
    if (toggleBtn && fullWrap) {
        toggleBtn.addEventListener('click', () => {
            const hidden = fullWrap.style.display === 'none';
            fullWrap.style.display = hidden ? 'block' : 'none';
            toggleBtn.textContent = hidden
                ? `▲ Ẩn bớt danh sách`
                : `📋 Xem đầy đủ tất cả ${result.allStocks.length} mã`;
        });
    }
}

// Click ra ngoài modal hoặc ESC → đóng
if (typeof window !== 'undefined') {
    window.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'industry-topflow-modal') closeIndustryTopFlowModal();
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeIndustryTopFlowModal();
    });
}

/**
 * Render heatmap hiệu suất ngành: mỗi ngành 1 ô, màu theo % thay đổi chỉ số.
 * Dữ liệu dùng closeIndex + percentChange sẵn có từ /api/industry-flow.
 */
function renderIndustryHeatmap(data) {
    const container = document.getElementById('industry-heatmap');
    if (!container) return;
    if (!data) data = IndustryFlowState.data;
    if (!data || !data.length) { container.innerHTML = ''; return; }

    // Sắp theo % thay đổi giảm dần
    const sorted = [...data].sort((a, b) => (b.percentChange || 0) - (a.percentChange || 0));

    // Màu nền theo % (xanh khi dương, đỏ khi âm), độ đậm theo |%| (giới hạn ~3%)
    const colorFor = (pct) => {
        const p = pct || 0;
        const intensity = Math.min(Math.abs(p) / 3, 1); // 0..1
        const alpha = (0.12 + intensity * 0.55).toFixed(2);
        return p >= 0
            ? `rgba(38, 166, 91, ${alpha})`   // green
            : `rgba(232, 65, 66, ${alpha})`;  // red
    };

    container.innerHTML = sorted.map(d => {
        const pct = d.percentChange || 0;
        const sign = pct >= 0 ? '+' : '';
        const cls = pct >= 0 ? 'positive' : 'negative';
        const idx = (typeof d.closeIndex === 'number') ? d.closeIndex.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) : '--';
        return `
            <div class="heatmap-tile" style="background:${colorFor(pct)}" title="${d.name}: ${sign}${pct.toFixed(2)}% · Chỉ số ${idx}">
                <div class="heatmap-name">${d.name}</div>
                <div class="heatmap-pct ${cls}">${sign}${pct.toFixed(2)}%</div>
                <div class="heatmap-idx">${idx}</div>
            </div>`;
    }).join('');
}

// (Đã gỡ bỏ: formatDisplayDate, renderIndustryCheckboxes, selectAllIndustries,
//  generateChartColor và renderIndustryChart bản cũ - thuộc luồng "dòng tiền lũy kế"
//  theo date-picker dùng Fitrade. Nay thay bằng renderIndustryFlowChart + timeRange (Fiintrade).)


// ==========================================
// MA BREADTH — Độ Rộng Kỹ Thuật (Số CP trên MA10/20/50/100/200)
// Xem docs/superpowers/specs/2026-07-13-ma-breadth-design.md
// ==========================================

const MA_BREADTH_PREFS_KEY = 'vnstock_ma_breadth_prefs';

// Màu mặc định cho 5 đường MA + VNINDEX overlay (user có thể đổi qua color picker)
const MA_COLORS_DEFAULT = {
    ma10: '#2ee68a',     // xanh (color-up)
    ma20: '#3b82f6',     // xanh dương
    ma50: '#facc15',     // vàng
    ma100: '#a855f7',    // tím
    ma200: '#fb923c',    // cam
    vnindex: '#ffffff'   // trắng đậm — nổi bật trên nền dark, trục Y phải
};
const MA_LABELS = { ma10: 'MA10', ma20: 'MA20', ma50: 'MA50', ma100: 'MA100', ma200: 'MA200', vnindex: 'VNINDEX' };
// Các key line theo thứ tự hiển thị
const MA_LINE_KEYS = ['ma10', 'ma20', 'ma50', 'ma100', 'ma200', 'vnindex'];

const MABreadthState = {
    data: null,        // series hiện tại từ /api/ma-breadth
    meta: null,        // meta từ API (firstDate, lastDate, historyDays...)
    chart: null,       // Chart.js instance
    scope: 'market',
    fromDate: null,
    toDate: null,
    visibleMAs: { ma10: true, ma20: true, ma50: true, ma100: false, ma200: false, vnindex: true },
    colors: { ...MA_COLORS_DEFAULT },  // màu hiện tại (user có thể đổi)
    loaded: false,
    initialized: false,
    dateDebounce: null
};

/** Load prefs từ localStorage. */
function loadMABreadthPrefs() {
    try {
        const raw = localStorage.getItem(MA_BREADTH_PREFS_KEY);
        if (!raw) return;
        const p = JSON.parse(raw);
        if (p.scope) MABreadthState.scope = p.scope;
        if (p.fromDate) MABreadthState.fromDate = p.fromDate;
        if (p.toDate) MABreadthState.toDate = p.toDate;
        if (p.visibleMAs) MABreadthState.visibleMAs = { ...MABreadthState.visibleMAs, ...p.visibleMAs };
        if (p.colors) MABreadthState.colors = { ...MA_COLORS_DEFAULT, ...p.colors };
    } catch (e) { /* ignore */ }
}

/** Lưu prefs vào localStorage. */
function saveMABreadthPrefs() {
    try {
        localStorage.setItem(MA_BREADTH_PREFS_KEY, JSON.stringify({
            scope: MABreadthState.scope,
            fromDate: MABreadthState.fromDate,
            toDate: MABreadthState.toDate,
            visibleMAs: MABreadthState.visibleMAs,
            colors: MABreadthState.colors
        }));
    } catch (e) { /* ignore */ }
}

/**
 * Render line controls: cho mỗi MA + VNINDEX, 1 ô chứa:
 *   [checkbox] [color picker] <label>
 * User tick để ẩn/hiện line, click màu để đổi màu (re-render local).
 */
function renderMALineControls() {
    const container = document.getElementById('ma-line-controls');
    if (!container) return;
    container.innerHTML = '';

    MA_LINE_KEYS.forEach(key => {
        const wrap = document.createElement('label');
        wrap.className = 'ma-line-item' + (key === 'vnindex' ? ' ma-line-vnindex' : '');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = MABreadthState.visibleMAs[key];
        cb.addEventListener('change', () => {
            MABreadthState.visibleMAs[key] = cb.checked;
            saveMABreadthPrefs();
            renderMABreadthChart();
        });

        const color = document.createElement('input');
        color.type = 'color';
        color.className = 'ma-color-picker';
        color.value = MABreadthState.colors[key];
        color.title = 'Đổi màu ' + MA_LABELS[key];
        color.addEventListener('input', () => {
            MABreadthState.colors[key] = color.value;
            saveMABreadthPrefs();
            renderMABreadthChart();
        });

        const text = document.createElement('span');
        text.className = 'ma-line-label';
        text.textContent = MA_LABELS[key];

        wrap.appendChild(cb);
        wrap.appendChild(color);
        wrap.appendChild(text);
        container.appendChild(wrap);
    });
}

/** Định dạng ngày YYYY-MM-DD → DD/MM/YY cho hiển thị. */
function formatMADate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y.slice(2)}`;
}

/** Khởi tạo MA breadth section (gọi khi switch sang tab industry lần đầu). */
function initMABreadth() {
    if (MABreadthState.initialized) return;
    MABreadthState.initialized = true;

    loadMABreadthPrefs();

    // Apply prefs lên UI controls
    const scopeEl = document.getElementById('ma-breadth-scope');
    if (scopeEl) scopeEl.value = MABreadthState.scope;
    const fromEl = document.getElementById('ma-breadth-from');
    const toEl = document.getElementById('ma-breadth-to');
    if (fromEl && MABreadthState.fromDate) fromEl.value = MABreadthState.fromDate;
    if (toEl && MABreadthState.toDate) toEl.value = MABreadthState.toDate;

    // Render line controls (checkbox + color picker) cho từng MA + VNINDEX
    renderMALineControls();

    // Bind events
    if (scopeEl) scopeEl.addEventListener('change', () => {
        MABreadthState.scope = scopeEl.value;
        saveMABreadthPrefs();
        loadMABreadth();
    });

    // Xử lý đổi ngày: cập nhật khi gõ (input, debounce 500ms) VÀ khi commit (change).
    // Chỉ trigger fetch khi cả from/to là ngày hợp lệ YYYY-MM-DD (hoặc rỗng).
    const isValidDate = (s) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
    const onDateInput = () => {
        clearTimeout(MABreadthState.dateDebounce);
        MABreadthState.dateDebounce = setTimeout(() => {
            let from = fromEl ? fromEl.value : '';
            let to = toEl ? toEl.value : '';
            // Chưa hợp lệ → chờ user gõ tiếp, không fetch
            if (!isValidDate(from) || !isValidDate(to)) return;
            // Validate from <= to, tự hoán đổi + toast nhẹ
            if (from && to && from > to) {
                if (fromEl) fromEl.value = to;
                if (toEl) toEl.value = from;
                const t = from; from = to; to = t;
                if (typeof showToast === 'function') showToast('Đã hoán đổi Từ/Đến', 'info');
            }
            MABreadthState.fromDate = from || null;
            MABreadthState.toDate = to || null;
            saveMABreadthPrefs();
            loadMABreadth();
        }, 500);
    };
    if (fromEl) fromEl.addEventListener('input', onDateInput);
    if (toEl) toEl.addEventListener('input', onDateInput);
    // change vẫn dùng cùng handler (khi chọn từ picker / blur) — input đã bao phủ
    if (fromEl) fromEl.addEventListener('change', onDateInput);
    if (toEl) toEl.addEventListener('change', onDateInput);

    // Preset buttons
    document.querySelectorAll('.ma-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => applyMAPreset(btn.dataset.preset));
    });

    // Refresh + Build buttons
    const refreshBtn = document.getElementById('ma-breadth-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', onMABreadthRefresh);
    const buildBtn = document.getElementById('ma-breadth-build');
    if (buildBtn) buildBtn.addEventListener('click', onMABreadthBuild);

    // Trigger load đầu tiên
    loadMABreadth();
}

/** Áp dụng preset (1m/3m/6m/1y/1.5y/all) → set 2 ô date → load. */
function applyMAPreset(preset) {
    const fromEl = document.getElementById('ma-breadth-from');
    const toEl = document.getElementById('ma-breadth-to');
    if (!fromEl || !toEl) return;

    const last = MABreadthState.meta && MABreadthState.meta.lastDate;
    const end = last ? new Date(last) : new Date();
    let start;

    if (preset === 'all') {
        const first = MABreadthState.meta && MABreadthState.meta.firstDate;
        if (!first) { loadMABreadth(); return; }
        start = new Date(first);
    } else {
        const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, '1.5y': 18 }[preset] || 6;
        start = new Date(end);
        start.setMonth(start.getMonth() - months);
    }
    const fmt = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };
    fromEl.value = fmt(start);
    toEl.value = fmt(end);
    MABreadthState.fromDate = fromEl.value;
    MABreadthState.toDate = toEl.value;
    saveMABreadthPrefs();
    loadMABreadth();
}

/** Fetch /api/ma-breadth + /meta, render. */
async function loadMABreadth() {
    const metaEl = document.getElementById('ma-breadth-meta');
    const emptyEl = document.getElementById('ma-breadth-empty');
    try {
        // Lấy meta đầu tiên để set min/max date input
        const metaRes = await fetch(`${SERVER_BASE}/api/ma-breadth/meta`);
        const meta = await metaRes.json();
        MABreadthState.meta = meta;

        const fromEl = document.getElementById('ma-breadth-from');
        const toEl = document.getElementById('ma-breadth-to');

        if (!meta.exists || meta.needBuild) {
            // Chưa có data → empty state với nút build
            if (MABreadthState.chart) { MABreadthState.chart.destroy(); MABreadthState.chart = null; }
            if (emptyEl) {
                emptyEl.style.display = 'block';
                emptyEl.innerHTML = `Chưa có dữ liệu MA breadth. Bấm <b>"Tải dữ liệu lịch sử"</b> để bắt đầu (lần đầu ~1 phút).`;
            }
            if (metaEl) metaEl.textContent = '';
            return;
        }

        // Set min/max cho date input
        if (fromEl) { fromEl.min = meta.firstDate; fromEl.max = meta.lastDate; }
        if (toEl) { toEl.min = meta.firstDate; toEl.max = meta.lastDate; }

        // Auto-fill "Đến" = ngày mới nhất có data nếu đang trống (mặc định hợp lý,
        // không để placeholder dd/mm/yyyy). User có thể sửa sau.
        if (meta.lastDate && (!MABreadthState.toDate || MABreadthState.toDate === '')) {
            MABreadthState.toDate = meta.lastDate;
            if (toEl) toEl.value = meta.lastDate;
            saveMABreadthPrefs();
        }
        // Nếu toDate đã lưu nhưng vượt quá lastDate (data cũ bị trim) → clamp lại
        if (meta.lastDate && MABreadthState.toDate && MABreadthState.toDate > meta.lastDate) {
            MABreadthState.toDate = meta.lastDate;
            if (toEl) toEl.value = meta.lastDate;
            saveMABreadthPrefs();
        }

        // Build query
        const params = new URLSearchParams();
        params.set('scope', MABreadthState.scope === 'market' ? 'market' : 'industry');
        if (MABreadthState.scope !== 'market') params.set('industryCode', MABreadthState.scope);
        if (MABreadthState.fromDate) params.set('fromDate', MABreadthState.fromDate);
        if (MABreadthState.toDate) params.set('toDate', MABreadthState.toDate);

        const res = await fetch(`${SERVER_BASE}/api/ma-breadth?${params}`);
        const result = await res.json();

        if (!result.success || !result.series) {
            if (emptyEl) {
                emptyEl.style.display = 'block';
                emptyEl.textContent = (result.error === 'no-data' ? 'Chưa có dữ liệu.' : 'Lỗi tải dữ liệu MA breadth.');
            }
            return;
        }

        if (result.series.length === 0) {
            if (MABreadthState.chart) { MABreadthState.chart.destroy(); MABreadthState.chart = null; }
            if (emptyEl) {
                emptyEl.style.display = 'block';
                emptyEl.textContent = 'Không có dữ liệu trong khoảng ngày đã chọn.';
            }
            if (metaEl) metaEl.textContent = '';
            return;
        }

        MABreadthState.data = result.series;
        if (emptyEl) emptyEl.style.display = 'none';

        // Hiển thị meta
        if (metaEl) {
            const total = result.series[result.series.length - 1].total;
            metaEl.textContent = `${result.industryName || 'Toàn Thị Trường'} · ${result.series.length} ngày · ${formatMADate(result.meta.fromDate)} → ${formatMADate(result.meta.toDate)} · ${total} CP`;
        }

        renderMABreadthChart();
        MABreadthState.loaded = true;
    } catch (err) {
        console.error('MA breadth load error:', err);
        const metaEl2 = document.getElementById('ma-breadth-meta');
        if (metaEl2) metaEl2.textContent = 'Lỗi tải dữ liệu';
    }
}

/** Vẽ Chart.js line cho MA breadth. Dual-axis: số CP (trái) + VNINDEX (phải). */
function renderMABreadthChart() {
    const canvas = document.getElementById('ma-breadth-chart');
    if (!canvas) return;
    const data = MABreadthState.data;
    if (!data || !data.length) return;

    const ctx = canvas.getContext('2d');
    if (MABreadthState.chart) MABreadthState.chart.destroy();

    const labels = data.map(d => d.date);
    const hasVNIndex = data.some(d => d.vnindex != null);
    const datasets = [];

    // Datasets MA (trục Y trái: số CP)
    ['ma10', 'ma20', 'ma50', 'ma100', 'ma200'].forEach(k => {
        if (!MABreadthState.visibleMAs[k]) return;
        datasets.push({
            label: MA_LABELS[k],
            data: data.map(d => d[k]),
            borderColor: MABreadthState.colors[k],
            backgroundColor: MABreadthState.colors[k] + '20',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
            fill: false,
            yAxisID: 'y'
        });
    });

    // VNINDEX overlay (trục Y phải) — chỉ khi có data vnindex và user tick
    if (hasVNIndex && MABreadthState.visibleMAs.vnindex) {
        datasets.push({
            label: MA_LABELS.vnindex,
            data: data.map(d => d.vnindex),
            borderColor: MABreadthState.colors.vnindex,
            backgroundColor: 'transparent',
            borderWidth: 2.5,
            borderDash: [6, 4],   // nét đứt để phân biệt với MA lines
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.2,
            fill: false,
            yAxisID: 'y1'
        });
    }

    MABreadthState.chart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#ccc', font: { size: 12 } } },
                tooltip: {
                    callbacks: {
                        title: (items) => formatMADate(items[0].label),
                        label: (ctx) => {
                            // VNINDEX: hiển thị giá điểm; MA: hiển thị số CP + %
                            if (ctx.dataset.yAxisID === 'y1') {
                                return `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`;
                            }
                            const total = data[ctx.dataIndex].total;
                            const pct = total > 0 ? ((ctx.parsed.y / total) * 100).toFixed(1) : '0';
                            return `${ctx.dataset.label}: ${ctx.parsed.y} CP (${pct}%)`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#888',
                        maxTicksLimit: 12,
                        callback: function(val, idx) {
                            const label = this.getLabelForValue(val);
                            return idx % Math.ceil(labels.length / 12) === 0 ? formatMADate(label) : '';
                        }
                    },
                    grid: { color: 'rgba(255,255,255,0.05)' }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    beginAtZero: true,
                    ticks: { color: '#888', precision: 0 },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    title: { display: true, text: 'Số lượng CP', color: '#aaa' }
                },
                y1: {
                    type: 'linear',
                    position: 'right',
                    // Chỉ hiện trục Y phải khi có dataset VNINDEX
                    display: datasets.some(d => d.yAxisID === 'y1'),
                    grid: { drawOnChartArea: false }, // không vẽ grid trùng với trục trái
                    ticks: { color: '#bbb' },
                    title: { display: true, text: 'VNINDEX', color: '#ddd' }
                }
            }
        }
    });
}

/** Nút "Cập nhật hôm nay" — POST /refresh. */
async function onMABreadthRefresh() {
    const btn = document.getElementById('ma-breadth-refresh');
    if (btn) btn.classList.add('is-loading');
    try {
        const res = await fetch(`${SERVER_BASE}/api/ma-breadth/refresh`, { method: 'POST' });
        const result = await res.json();
        if (result.ok) {
            const msg = result.already ? `Đã có dữ liệu ngày ${formatMADate(result.date)}` : `Đã cập nhật ${formatMADate(result.date)}`;
            if (typeof showToast === 'function') showToast(msg, 'success');
            await loadMABreadth();
        } else {
            if (typeof showToast === 'function') showToast('Lỗi: ' + (result.error || 'không xác định'), 'error');
        }
    } catch (err) {
        console.error('MA breadth refresh error:', err);
        if (typeof showToast === 'function') showToast('Lỗi kết nối server', 'error');
    } finally {
        if (btn) btn.classList.remove('is-loading');
    }
}

/** Nút "Tải dữ liệu lịch sử" — confirm + POST /build-history. */
async function onMABreadthBuild() {
    const meta = MABreadthState.meta;
    const hasData = meta && meta.exists && meta.historyDays > 10;
    if (hasData && !confirm(`Đã có ${meta.historyDays} ngày dữ liệu. Tải lại toàn bộ lịch sử (~1 phút)?`)) return;

    const btn = document.getElementById('ma-breadth-build');
    const metaEl = document.getElementById('ma-breadth-meta');
    if (btn) btn.classList.add('is-loading');
    if (metaEl) metaEl.textContent = 'Đang tải lịch sử giá... (có thể mất ~1 phút)';
    try {
        const res = await fetch(`${SERVER_BASE}/api/ma-breadth/build-history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowDays: 370 })
        });
        const result = await res.json();
        if (result.ok) {
            if (typeof showToast === 'function') showToast(`Hoàn tất: ${result.days} ngày, ${result.symbolsTracked} mã`, 'success');
            await loadMABreadth();
        } else {
            if (typeof showToast === 'function') showToast('Lỗi: ' + (result.error || 'không xác định'), 'error');
            if (metaEl) metaEl.textContent = 'Lỗi build lịch sử';
        }
    } catch (err) {
        console.error('MA breadth build error:', err);
        if (typeof showToast === 'function') showToast('Lỗi kết nối server', 'error');
        if (metaEl) metaEl.textContent = 'Lỗi build lịch sử';
    } finally {
        if (btn) btn.classList.remove('is-loading');
    }
}

// ==========================================
// DASHBOARD CHARTS - BUBBLE & LINE CHARTS
// ==========================================

/** Dashboard Charts State */
const DashboardChartsState = {
    industryBubbleChart: null,
    marketCapBubbleChart: null,
    vnindexDemandChart: null,
    vn30DemandChart: null,
    industryData: null,
    marketCapData: null,
    showIndustryLabels: false,
    showMarketCapLabels: false,
    showIndustryForce: false,
    showMarketCapForce: false,
    industrySortKey: 'lucCau',
    industrySortAsc: false,
    marketCapSortKey: 'lucCau',
    marketCapSortAsc: false
};

// Custom Chart.js plugin to draw labels on bubbles
const bubbleLabelPlugin = {
    id: 'bubbleLabels',
    afterDatasetsDraw(chart) {
        const opts = chart.config.options.plugins?.bubbleLabels;
        if (!opts?.showLabels && !opts?.showForce) return;
        const ctx = chart.ctx;
        ctx.save();
        chart.data.datasets.forEach((dataset, i) => {
            const meta = chart.getDatasetMeta(i);
            meta.data.forEach((element, idx) => {
                const { x, y } = element;
                const lines = [];
                if (opts.showLabels) lines.push(dataset.label);
                if (opts.showForce && dataset.forceValues?.[idx] !== undefined) {
                    lines.push(dataset.forceValues[idx].toFixed(1) + '%');
                }
                if (lines.length === 0) return;
                const fontSize = 10;
                ctx.font = `bold ${fontSize}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                // Measure max line width
                const maxWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
                const lineHeight = fontSize + 2;
                const totalHeight = lines.length * lineHeight;
                // Draw background
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.fillRect(x - maxWidth / 2 - 4, y - totalHeight / 2 - 2, maxWidth + 8, totalHeight + 4);
                // Draw text
                ctx.fillStyle = '#fff';
                lines.forEach((line, li) => {
                    ctx.fillText(line, x, y - totalHeight / 2 + li * lineHeight + lineHeight / 2);
                });
            });
        });
        ctx.restore();
    }
};
Chart.register(bubbleLabelPlugin);

/**
 * Load "Phân Tích Lệnh" - dòng tiền ròng 4 nhóm NĐT (Fiintrade)
 */
async function loadInvestorFlow() {
    const tbody = document.getElementById('investor-flow-tbody');
    if (!tbody) return;

    // Thứ tự cố định 4 nhóm + cách map key giữa 2 nguồn:
    //   investor-detail: individual/institution/proprietary/foreign (có Mua/Bán/Ròng hôm nay)
    //   investor-flow:   caNhan/toChuc/tuDoanh/nuocNgoai            (ròng 5/20 phiên chính xác)
    const ORDER = [
        { detailKey: 'individual',  flowKey: 'caNhan',    name: 'Cá nhân' },
        { detailKey: 'institution', flowKey: 'toChuc',    name: 'Tổ chức' },
        { detailKey: 'proprietary', flowKey: 'tuDoanh',   name: 'Tự doanh' },
        { detailKey: 'foreign',     flowKey: 'nuocNgoai', name: 'Nước ngoài' }
    ];

    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const fmt = (v) => v.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
    const muted = '<td style="color:var(--text-muted)">--</td>';
    // Mua/Bán: giá trị gộp (≥0) -> màu cố định, không kèm dấu.
    const grossCell = (v, cls) => isNum(v) ? `<td class="${cls}">${fmt(v)}</td>` : muted;
    // Ròng: có dấu -> kèm +/- và đổi màu theo dấu.
    const netCell = (v) => isNum(v) ? `<td class="${v >= 0 ? 'positive' : 'negative'}">${v >= 0 ? '+' : ''}${fmt(v)}</td>` : muted;

    try {
        const [detailRes, flowRes] = await Promise.all([
            fetch(`${window.StockAPI.SERVER_BASE}/api/investor-detail`).then(r => r.json()).catch(() => null),
            fetch(`${window.StockAPI.SERVER_BASE}/api/investor-flow`).then(r => r.json()).catch(() => null)
        ]);

        const detailByKey = {};
        if (detailRes && detailRes.success && Array.isArray(detailRes.groups)) {
            detailRes.groups.forEach(g => { detailByKey[g.key] = g; });
        }
        const flowByKey = {};
        if (flowRes && flowRes.success && Array.isArray(flowRes.groups)) {
            flowRes.groups.forEach(g => { flowByKey[g.key] = g; });
        }

        if (Object.keys(detailByKey).length === 0 && Object.keys(flowByKey).length === 0) {
            if (!window._investorFlowLoaded) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Không tải được dữ liệu</td></tr>';
            }
            return;
        }

        tbody.innerHTML = ORDER.map(o => {
            const d = detailByKey[o.detailKey];
            const f = flowByKey[o.flowKey];
            const today = d && d.today ? d.today : null;
            const buy = today ? today.buy : null;
            const sell = today ? today.sell : null;
            // Ròng hôm nay: ưu tiên investor-detail.today.net, fallback investor-flow.d1
            const net1 = today && isNum(today.net) ? today.net : (f ? f.d1 : null);
            // 5/20 phiên: ưu tiên investor-flow (đúng 5/20 phiên), fallback detail.oneWeek/oneMonth
            const net5 = f && isNum(f.d5) ? f.d5 : (d && d.oneWeek ? d.oneWeek.net : null);
            const net20 = f && isNum(f.d20) ? f.d20 : (d && d.oneMonth ? d.oneMonth.net : null);
            return `
            <tr>
                <td><strong>${o.name}</strong></td>
                ${grossCell(buy, 'positive')}
                ${grossCell(sell, 'negative')}
                ${netCell(net1)}
                ${netCell(net5)}
                ${netCell(net20)}
            </tr>`;
        }).join('');

        window._investorFlowLoaded = true;
        console.log('✅ Investor flow (phân tích lệnh) updated with Mua/Bán/Ròng');
    } catch (error) {
        console.error('Failed to load investor flow:', error);
        if (!window._investorFlowLoaded) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Lỗi kết nối</td></tr>';
        }
    }
}

/**
 * Load "Top CP Theo Dòng Tiền NĐT" — fetch /api/investor-detail MỘT LẦN, cache lại
 * theo nhóm, rồi render nhóm đang chọn. Toggle nhóm sẽ render lại từ cache (không fetch).
 */
async function loadInvestorTop() {
    const buyList = document.getElementById('investor-top-buy');
    const sellList = document.getElementById('investor-top-sell');
    if (!buyList && !sellList) return;

    try {
        const res = await fetch(`${window.StockAPI.SERVER_BASE}/api/investor-detail`).then(r => r.json());
        if (!res || !res.success || !Array.isArray(res.groups) || res.groups.length === 0) {
            if (!window._investorTopLoaded) {
                const msg = '<li><span class="stock-code">--</span><span class="stock-value" style="color:var(--text-muted)">Không tải được dữ liệu</span></li>';
                if (buyList) buyList.innerHTML = msg;
                if (sellList) sellList.innerHTML = msg;
            }
            return;
        }
        // Cache theo key nhóm (individual/institution/proprietary/foreign)
        const byKey = {};
        res.groups.forEach(g => { byKey[g.key] = g; });
        AppState.investorTopData = byKey;
        window._investorTopLoaded = true;

        // Render nhóm đang chọn (mặc định 'foreign' = Nước ngoài)
        renderInvestorTop(AppState.investorTopGroup || 'foreign');
        console.log('✅ Investor top (Top CP theo dòng tiền NĐT) updated');
    } catch (error) {
        console.error('Failed to load investor top:', error);
        if (!window._investorTopLoaded) {
            const msg = '<li><span class="stock-code">--</span><span class="stock-value" style="color:var(--text-muted)">Lỗi kết nối</span></li>';
            if (buyList) buyList.innerHTML = msg;
            if (sellList) sellList.innerHTML = msg;
        }
    }
}

/**
 * Render Top Mua/Bán ròng cho nhóm NĐT chỉ định từ cache client (KHÔNG fetch lại).
 * Gọi từ các nút toggle nhóm.
 */
function renderInvestorTop(groupKey) {
    AppState.investorTopGroup = groupKey;

    // Cập nhật trạng thái active của các nút toggle
    document.querySelectorAll('#investor-top-toggle .top-net-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.group === groupKey);
    });

    const buyList = document.getElementById('investor-top-buy');
    const sellList = document.getElementById('investor-top-sell');
    const data = AppState.investorTopData;
    if (!data) return; // chưa có cache -> chờ loadInvestorTop()

    const g = data[groupKey];
    const emptyMsg = '<li><span class="stock-code">--</span><span class="stock-value" style="color:var(--text-muted)">Chưa có dữ liệu</span></li>';

    const row = (s, cls, sign) => `
        <li onclick="window.open('https://finance.vietstock.vn/${s.ticker}.htm', '_blank')" style="cursor:pointer;">
            <span class="stock-code">${s.ticker}</span>
            <span class="stock-value ${cls}">${sign}${s.net.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ</span>
        </li>`;

    if (buyList) {
        const buy = (g && Array.isArray(g.topBuy)) ? g.topBuy : [];
        buyList.innerHTML = buy.length ? buy.map(s => row(s, 'positive', '+')).join('') : emptyMsg;
    }
    if (sellList) {
        const sell = (g && Array.isArray(g.topSell)) ? g.topSell : [];
        // net < 0 đã sẵn dấu '-', không thêm sign
        sellList.innerHTML = sell.length ? sell.map(s => row(s, 'negative', '')).join('') : emptyMsg;
    }
}

/**
 * Load dòng tiền thông minh theo mã (panel #panel-stock-investor-flow).
 */
async function loadStockInvestorFlow(symbol, freq) {
    const statusEl = document.getElementById('stock-flow-status');
    symbol = (symbol || (document.getElementById('stock-flow-symbol') || {}).value || 'HPG').trim().toUpperCase();
    freq = freq || window._stockFlowFreq || 'Daily';
    window._stockFlowSymbol = symbol;
    window._stockFlowFreq = freq;
    if (!symbol) { if (statusEl) statusEl.textContent = 'Nhập mã cổ phiếu để xem.'; return; }
    if (statusEl) statusEl.textContent = `Đang tải ${symbol} (${freq})...`;
    try {
        const res = await fetch(`${window.StockAPI.SERVER_BASE}/api/stock-investor-flow?symbol=${encodeURIComponent(symbol)}&freq=${encodeURIComponent(freq)}`).then(r => r.json());
        if (!res || !res.success || !Array.isArray(res.points) || res.points.length === 0) {
            if (statusEl) statusEl.textContent = `Không có dữ liệu cho ${symbol}.`;
            if (window.StockCharts) window.StockCharts.renderStockInvestorFlowChart('stock-investor-flow-chart', []);
            return;
        }
        if (window.StockCharts) window.StockCharts.renderStockInvestorFlowChart('stock-investor-flow-chart', res.points);
        const last = res.points[res.points.length - 1];
        if (statusEl) statusEl.textContent = `${symbol} · ${freq} · ${res.points.length} phiên · GT khớp ròng (tỷ) — Tổ chức = -(Cá nhân + Tự doanh + Nước ngoài)`;
    } catch (e) {
        console.error('loadStockInvestorFlow error:', e);
        if (statusEl) statusEl.textContent = 'Lỗi tải dữ liệu.';
    }
}

function setupStockInvestorFlowControls() {
    const input = document.getElementById('stock-flow-symbol');
    const btn = document.getElementById('stock-flow-search-btn');
    const freqWrap = document.getElementById('stock-flow-freq');
    if (btn) btn.addEventListener('click', () => loadStockInvestorFlow(input ? input.value : 'HPG', window._stockFlowFreq));
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadStockInvestorFlow(input.value, window._stockFlowFreq); });
    if (freqWrap) freqWrap.querySelectorAll('.top-net-tab').forEach(b => {
        b.addEventListener('click', () => {
            freqWrap.querySelectorAll('.top-net-tab').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            loadStockInvestorFlow(input ? input.value : 'HPG', b.dataset.freq);
        });
    });
}

/**
 * Load "Khối Ngoại Mua/Bán Ròng" - dữ liệu thực từ /api/foreign-flow (Fiintrade).
 * Điền Mua / Bán / Ròng (tỷ, 1 chữ số thập phân, xanh ≥0 / đỏ <0; '--' nếu null)
 * và vẽ biểu đồ cột THẬT theo xu hướng 1/5/20 phiên (thay cho dữ liệu mock).
 */
async function loadForeignFlow() {
    const buyEl = document.getElementById('foreign-buy-val');
    const sellEl = document.getElementById('foreign-sell-val');
    const netEl = document.getElementById('foreign-net-val');
    if (!buyEl && !sellEl && !netEl) return;

    const isNum = (v) => typeof v === 'number' && isFinite(v);
    // Mua/Bán là giá trị gộp (luôn ≥0) -> KHÔNG kèm dấu, màu cố định (Mua xanh, Bán đỏ).
    const fmtPlain = (v) => isNum(v) ? v.toFixed(1) + ' tỷ' : null;
    // Ròng là giá trị có dấu -> kèm +/- và đổi màu theo dấu.
    const fmtSigned = (v) => isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(1) + ' tỷ' : null;

    const setGross = (el, v, cls) => {
        if (!el) return;
        const t = fmtPlain(v);
        el.textContent = t === null ? '--' : t;
        el.className = t === null ? 'flow-value' : `flow-value ${cls}`;
    };
    const setNet = (el, v) => {
        if (!el) return;
        const t = fmtSigned(v);
        if (t === null) { el.textContent = '--'; el.className = 'flow-value'; return; }
        el.textContent = t;
        el.className = `flow-value ${v >= 0 ? 'positive' : 'negative'}`;
    };

    try {
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/foreign-flow`);
        const result = await response.json();

        if (!result || !result.success || !result.today) {
            if (!window._foreignFlowLoaded) {
                if (buyEl) { buyEl.textContent = '--'; buyEl.className = 'flow-value'; }
                if (sellEl) { sellEl.textContent = '--'; sellEl.className = 'flow-value'; }
                if (netEl) { netEl.textContent = '--'; netEl.className = 'flow-value'; }
            }
            return;
        }

        const { today, trend } = result;
        // Mua (xanh cố định) / Bán (đỏ cố định) / Ròng (màu theo dấu)
        setGross(buyEl, today.buy, 'positive');
        setGross(sellEl, today.sell, 'negative');
        setNet(netEl, today.net);

        // Vẽ biểu đồ cột THẬT từ trend (1/5/20 phiên). Guard nếu thiếu dữ liệu.
        if (window.StockCharts && Array.isArray(trend)) {
            window.StockCharts.renderForeignFlowChart('foreign-flow-chart', trend);
        }

        window._foreignFlowLoaded = true;
        console.log(`✅ Foreign flow (khối ngoại) updated [${result.source}]: Mua ${today.buy ?? '--'} / Bán ${today.sell ?? '--'} / Ròng ${today.net}`);
    } catch (error) {
        console.error('Failed to load foreign flow:', error);
        if (!window._foreignFlowLoaded) {
            if (buyEl) { buyEl.textContent = '--'; buyEl.className = 'flow-value'; }
            if (sellEl) { sellEl.textContent = '--'; sellEl.className = 'flow-value'; }
            if (netEl) { netEl.textContent = '--'; netEl.className = 'flow-value'; }
        }
    }
}

/**
 * Load and render all dashboard charts
 */
async function loadDashboardCharts() {
    console.log('📊 Loading dashboard charts...');

    try {
        // Fetch all chart data in parallel
        const [industryRes, marketCapRes, vnindexRes, vn30Res] = await Promise.all([
            fetch(`${window.StockAPI.SERVER_BASE}/api/industry-stats`).then(r => r.json()).catch(() => null),
            fetch(`${window.StockAPI.SERVER_BASE}/api/marketcap-stats`).then(r => r.json()).catch(() => null),
            fetch(`${window.StockAPI.SERVER_BASE}/api/vnindex-demand`).then(r => r.json()).catch(() => null),
            fetch(`${window.StockAPI.SERVER_BASE}/api/vn30-demand`).then(r => r.json()).catch(() => null)
        ]);

        // Render charts
        if (industryRes?.success && industryRes.data) {
            renderIndustryBubbleChart(industryRes.data);
            const dateEl = document.getElementById('industry-chart-date');
            if (dateEl) dateEl.innerText = new Date().toLocaleDateString('vi-VN');
        } else {
            // Fallback mock data for industry bubble chart
            const mockIndustryData = [
                { code: '8300', name: 'Ngân hàng', lucCau: 52.3, percentAboveMA10: 68, stockCount: 12 },
                { code: '8600', name: 'Bất động sản', lucCau: 45.1, percentAboveMA10: 42, stockCount: 15 },
                { code: '9500', name: 'Công nghệ', lucCau: 55.8, percentAboveMA10: 75, stockCount: 8 },
                { code: '1700', name: 'Tài nguyên cơ bản', lucCau: 48.2, percentAboveMA10: 55, stockCount: 6 },
                { code: '0500', name: 'Dầu khí', lucCau: 42.5, percentAboveMA10: 38, stockCount: 5 },
                { code: '8700', name: 'Dịch vụ tài chính', lucCau: 38.9, percentAboveMA10: 25, stockCount: 10 },
                { code: '3500', name: 'Thực phẩm và đồ uống', lucCau: 51.0, percentAboveMA10: 60, stockCount: 7 },
                { code: '2300', name: 'Xây dựng và VLXD', lucCau: 44.3, percentAboveMA10: 35, stockCount: 9 },
                { code: '5700', name: 'Du lịch và giải trí', lucCau: 40.0, percentAboveMA10: 30, stockCount: 4 },
                { code: '5300', name: 'Bán lẻ', lucCau: 46.0, percentAboveMA10: 50, stockCount: 6 },
                { code: '5500', name: 'Truyền thông', lucCau: 35.0, percentAboveMA10: 20, stockCount: 3 },
                { code: '4500', name: 'Y tế', lucCau: 43.0, percentAboveMA10: 40, stockCount: 5 }
            ];
            renderIndustryBubbleChart(mockIndustryData);
        }

        if (marketCapRes?.success && marketCapRes.data) {
            renderMarketCapBubbleChart(marketCapRes.data);
        } else {
            // Fallback mock data for market cap bubble chart
            const mockMarketCapData = [
                { name: 'Small', lucCau: 43.2, percentAboveMA10: 32, stockCount: 200 },
                { name: 'Mid', lucCau: 47.5, percentAboveMA10: 48, stockCount: 150 },
                { name: 'Large', lucCau: 51.8, percentAboveMA10: 62, stockCount: 50 },
                { name: 'Super Large', lucCau: 54.1, percentAboveMA10: 70, stockCount: 20 }
            ];
            renderMarketCapBubbleChart(mockMarketCapData);
        }

        if (vnindexRes?.success && vnindexRes.data) {
            renderVNIndexDemandChart(vnindexRes.data);
        }

        if (vn30Res?.success && vn30Res.data) {
            renderVN30DemandChart(vn30Res.data);
        }

        console.log('✅ Dashboard charts loaded');
    } catch (error) {
        console.error('Dashboard charts error:', error);
    }
}

/**
 * Render Industry Bubble Chart
 */
function renderIndustryBubbleChart(data) {
    const canvas = document.getElementById('industry-bubble-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    DashboardChartsState.industryData = data;

    // Filter by selected industries (localStorage)
    const savedSel = localStorage.getItem('vnstock_selected_industries');
    if (savedSel) {
        const selectedSet = new Set(JSON.parse(savedSel));
        data = data.filter(ind => selectedSet.has(ind.code));
    }

    // Destroy existing chart
    if (DashboardChartsState.industryBubbleChart) {
        DashboardChartsState.industryBubbleChart.destroy();
    }

    // Generate colors for bubbles
    const colors = [
        '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF',
        '#FF9F40', '#FF6B6B', '#4ECDC4', '#45B7D1', '#FED766',
        '#2AB7CA', '#FE4A49', '#DAD873', '#7D53DE', '#26547C',
        '#EF476F', '#FFD166', '#06D6A0', '#118AB2', '#073B4C'
    ];

    // Create datasets for bubble chart
    const datasets = data.map((industry, index) => ({
        label: industry.name,
        data: [{
            x: industry.lucCau,
            y: industry.percentAboveMA10,
            r: Math.max(8, Math.min(25, industry.stockCount * 2)), // Bubble size based on stock count
            industryCode: industry.code // Store industry code for click handler
        }],
        forceValues: [industry.lucCau],
        industryCode: industry.code, // Also store at dataset level
        backgroundColor: colors[index % colors.length] + '99',
        borderColor: colors[index % colors.length],
        borderWidth: 2
    }));

    DashboardChartsState.industryBubbleChart = new Chart(ctx, {
        type: 'bubble',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (event, elements) => {
                if (elements.length > 0) {
                    const el = elements[0];
                    const ds = DashboardChartsState.industryBubbleChart.data.datasets[el.datasetIndex];
                    showIndustryTopStocks(ds.industryCode, ds.label);
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const d = ctx.raw;
                            return `${ctx.dataset.label}: Lực Cầu ${d.x}%, CP>MA10 ${d.y}%`;
                        }
                    }
                },
                bubbleLabels: {
                    showLabels: DashboardChartsState.showIndustryLabels,
                    showForce: DashboardChartsState.showIndustryForce
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Lực Cầu (%)', color: '#888' },
                    min: 30, max: 70,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', callback: v => v + '%' }
                },
                y: {
                    title: { display: true, text: '% CP > MA10', color: '#888' },
                    min: 0, max: 100,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', callback: v => v + '%' }
                }
            },
            // Add reference line at 50%
            annotation: {
                annotations: {
                    line1: { type: 'line', xMin: 50, xMax: 50, borderColor: '#ffd93d', borderWidth: 2 }
                }
            }
        }
    });

    // Populate industry dropdown in header (use full data from state)
    const fullData = DashboardChartsState.industryData;
    const savedSel2 = localStorage.getItem('vnstock_selected_industries');
    const selSet = savedSel2 ? new Set(JSON.parse(savedSel2)) : null;
    const dropdownList = document.getElementById('industry-dropdown-list');
    if (dropdownList) {
        dropdownList.innerHTML = `
            <div class="industry-dropdown-item" style="border-bottom:1px solid rgba(255,255,255,0.08);padding:6px 14px;">
                <span style="font-size:11px;color:#888;cursor:pointer;" onclick="toggleAllIndustries(true)">Chọn tất cả</span>
                <span style="color:#444;margin:0 6px;">|</span>
                <span style="font-size:11px;color:#888;cursor:pointer;" onclick="toggleAllIndustries(false)">Bỏ tất cả</span>
            </div>
            ${fullData.map((ind, i) => {
                const color = colors[i % colors.length];
                const checked = !selSet || selSet.has(ind.code);
                return `<label class="industry-dropdown-item" style="--item-color:${color};cursor:pointer;">
                    <input type="checkbox" ${checked ? 'checked' : ''} data-code="${ind.code}"
                        onclick="event.stopPropagation();toggleIndustrySelect('${ind.code}',this.checked)"
                        style="accent-color:${color};width:14px;height:14px;cursor:pointer;">
                    <span class="industry-dot" style="background:${color}"></span>${ind.name}
                    <span class="industry-count">${ind.stockCount} CP</span>
                </label>`;
            }).join('')}
        `;
    }
    // Close dropdown when clicking outside
    if (!window._industryDropdownListener) {
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.industry-dropdown')) {
                document.querySelectorAll('.industry-dropdown.open').forEach(d => d.classList.remove('open'));
            }
        });
        window._industryDropdownListener = true;
    }
}

function toggleIndustrySelect(code, checked) {
    const savedSel = localStorage.getItem('vnstock_selected_industries');
    let sel;
    if (savedSel) {
        sel = JSON.parse(savedSel);
    } else {
        // No saved = all selected; build full list
        sel = DashboardChartsState.industryData.map(d => d.code);
    }
    if (checked) {
        if (!sel.includes(code)) sel.push(code);
    } else {
        sel = sel.filter(c => c !== code);
    }
    localStorage.setItem('vnstock_selected_industries', JSON.stringify(sel));
    renderIndustryBubbleChart(DashboardChartsState.industryData);
}

function toggleAllIndustries(selectAll) {
    if (selectAll) {
        localStorage.removeItem('vnstock_selected_industries');
    } else {
        localStorage.setItem('vnstock_selected_industries', JSON.stringify([]));
    }
    renderIndustryBubbleChart(DashboardChartsState.industryData);
}

/**
 * Render Market Cap Bubble Chart
 */
function renderMarketCapBubbleChart(data) {
    const canvas = document.getElementById('marketcap-bubble-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    DashboardChartsState.marketCapData = data;

    if (DashboardChartsState.marketCapBubbleChart) {
        DashboardChartsState.marketCapBubbleChart.destroy();
    }

    const colorMap = {
        'Small': '#9966FF',
        'Mid': '#4BC0C0',
        'Large': '#36A2EB',
        'Super Large': '#FFCE56'
    };

    const datasets = data.map(group => ({
        label: group.name,
        data: [{
            x: group.lucCau,
            y: group.percentAboveMA10,
            r: Math.max(15, Math.min(40, group.stockCount / 2))
        }],
        forceValues: [group.lucCau],
        groupName: group.name,
        backgroundColor: colorMap[group.name] + '99',
        borderColor: colorMap[group.name],
        borderWidth: 3
    }));

    DashboardChartsState.marketCapBubbleChart = new Chart(ctx, {
        type: 'bubble',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (event, elements) => {
                if (elements.length > 0) {
                    const el = elements[0];
                    const ds = DashboardChartsState.marketCapBubbleChart.data.datasets[el.datasetIndex];
                    showMarketcapTopStocks(ds.groupName);
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const d = ctx.raw;
                            return `${ctx.dataset.label}: Lực Cầu ${d.x}%, CP>MA10 ${d.y}%`;
                        }
                    }
                },
                bubbleLabels: {
                    showLabels: DashboardChartsState.showMarketCapLabels,
                    showForce: DashboardChartsState.showMarketCapForce
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Lực Cầu (%)', color: '#888' },
                    min: 30, max: 70,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', callback: v => v + '%' }
                },
                y: {
                    title: { display: true, text: '% CP > MA10', color: '#888' },
                    min: 0, max: 100,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', callback: v => v + '%' }
                }
            }
        }
    });
}

/**
 * Toggle bubble labels on/off
 */
function toggleBubbleLabels(chartType) {
    if (chartType === 'industry') {
        DashboardChartsState.showIndustryLabels = document.getElementById('industry-show-labels').checked;
        DashboardChartsState.showIndustryForce = document.getElementById('industry-show-force').checked;
        if (DashboardChartsState.industryData) {
            renderIndustryBubbleChart(DashboardChartsState.industryData);
        }
    } else if (chartType === 'marketcap') {
        DashboardChartsState.showMarketCapLabels = document.getElementById('marketcap-show-labels').checked;
        DashboardChartsState.showMarketCapForce = document.getElementById('marketcap-show-force').checked;
        if (DashboardChartsState.marketCapData) {
            renderMarketCapBubbleChart(DashboardChartsState.marketCapData);
        }
    }
}

/**
 * Toggle bubble data table
 */
function toggleBubbleTable(chartType) {
    const show = document.getElementById(`${chartType}-show-table`).checked;
    const container = document.getElementById(`${chartType}-table-container`);
    const chartContainer = container?.parentElement?.querySelector('.bubble-chart-container');
    const refLines = container?.parentElement?.querySelector('.chart-reference-lines');

    if (!container) return;

    if (show) {
        // Hiện bảng, ẩn chart
        container.style.display = 'block';
        if (chartContainer) chartContainer.style.display = 'none';
        if (refLines) refLines.style.display = 'none';

        const data = chartType === 'industry' ? DashboardChartsState.industryData : DashboardChartsState.marketCapData;
        if (data) renderBubbleTable(container, data, chartType);
    } else {
        // Ẩn bảng, hiện chart lại
        container.style.display = 'none';
        if (chartContainer) chartContainer.style.display = '';
        if (refLines) refLines.style.display = '';
    }
}

/**
 * Sort bubble data table dynamically
 */
window.sortBubbleTable = function(chartType, key) {
    const keyProp = `${chartType}SortKey`;
    const ascProp = `${chartType}SortAsc`;
    
    if (DashboardChartsState[keyProp] === key) {
        DashboardChartsState[ascProp] = !DashboardChartsState[ascProp];
    } else {
        DashboardChartsState[keyProp] = key;
        DashboardChartsState[ascProp] = false;
    }
    
    const container = document.getElementById(`${chartType}-table-container`);
    const data = chartType === 'industry' ? DashboardChartsState.industryData : DashboardChartsState.marketCapData;
    if (container && data) {
        renderBubbleTable(container, data, chartType);
    }
};

/**
 * Render data table for bubble chart
 */
function renderBubbleTable(container, data, chartType) {
    const isIndustry = chartType === 'industry';
    const sortKey = DashboardChartsState[`${chartType}SortKey`] || 'lucCau';
    const sortAsc = DashboardChartsState[`${chartType}SortAsc`] || false;
    const arrow = sortAsc ? ' ▲' : ' ▼';

    const sorted = [...data].sort((a, b) => {
        let valA = a[sortKey];
        let valB = b[sortKey];
        
        // Handle undefined or null
        if (valA === undefined || valA === null) valA = sortAsc ? Infinity : -Infinity;
        if (valB === undefined || valB === null) valB = sortAsc ? Infinity : -Infinity;
        
        if (typeof valA === 'string') {
            return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return sortAsc ? valA - valB : valB - valA;
    });

    const formatMarketCap = (val) => {
        if (!val) return '-';
        if (val >= 1e12) return (val / 1e12).toFixed(1) + ' nghìn tỷ';
        return Math.round(val / 1e9).toLocaleString('vi-VN') + ' tỷ';
    };

    let html = `<table>
        <thead><tr>
            <th>#</th>
            <th onclick="sortBubbleTable('${chartType}', 'name')" style="cursor:pointer; user-select:none;">${isIndustry ? 'Ngành' : 'Nhóm'}${sortKey === 'name' ? arrow : ''}</th>
            <th onclick="sortBubbleTable('${chartType}', 'lucCau')" style="cursor:pointer; user-select:none;">Lực Cầu (%)${sortKey === 'lucCau' ? arrow : ''}</th>
            <th onclick="sortBubbleTable('${chartType}', 'percentAboveMA10')" style="cursor:pointer; user-select:none;">% CP > MA10${sortKey === 'percentAboveMA10' ? arrow : ''}</th>
            <th onclick="sortBubbleTable('${chartType}', 'stockCount')" style="cursor:pointer; user-select:none;">Số CP${sortKey === 'stockCount' ? arrow : ''}</th>
            ${isIndustry ? `<th onclick="sortBubbleTable('${chartType}', 'marketCap')" style="cursor:pointer; user-select:none;">Vốn Hóa${sortKey === 'marketCap' ? arrow : ''}</th>` : ''}
            ${isIndustry ? `<th onclick="sortBubbleTable('${chartType}', 'upCount')" style="cursor:pointer; user-select:none; min-width: 220px;">Phân bổ giá (Tăng/Đứng/Giảm)${sortKey === 'upCount' ? arrow : ''}</th>` : ''}
        </tr></thead><tbody>`;

    sorted.forEach((item, i) => {
        const forceColor = item.lucCau >= 50 ? 'var(--accent-green)' : 'var(--accent-red)';
        const ma10Color = item.percentAboveMA10 >= 50 ? 'var(--accent-green)' : 'var(--accent-red)';
        
        let breadthCell = '';
        if (isIndustry && item.upCount !== undefined) {
            const up = item.upCount || 0;
            const down = item.downCount || 0;
            const flat = item.flatCount || 0;
            const total = item.stockCount || 1;
            
            const upPct = ((up / total) * 100).toFixed(1);
            const flatPct = ((flat / total) * 100).toFixed(1);
            const downPct = ((down / total) * 100).toFixed(1);
            
            breadthCell = `
                <td style="min-width: 220px; vertical-align: middle;">
                    <div style="display: flex; flex-direction: column; width: 100%; gap: 4px; padding: 4px 0;">
                        <div style="display: flex; justify-content: space-between; font-size: 11px; font-family: monospace; opacity: 0.95;">
                            <span>Tăng: <strong style="color: var(--accent-green)">${up}</strong></span>
                            <span>Đứng: <strong style="color: var(--accent-yellow)">${flat}</strong></span>
                            <span>Giảm: <strong style="color: var(--accent-red)">${down}</strong></span>
                        </div>
                        <div class="modal-breadth-bar" style="height: 8px; border-radius: 4px; margin: 0; width: 100%; display: flex; overflow: hidden; background: rgba(255,255,255,0.08);">
                            ${up > 0 ? `<div class="bar-seg positive" style="width: ${upPct}%; height: 100%; background: var(--accent-green);" title="Tăng: ${up} (${upPct}%)"></div>` : ''}
                            ${flat > 0 ? `<div class="bar-seg warning" style="width: ${flatPct}%; height: 100%; background: var(--accent-yellow);" title="Không đổi: ${flat} (${flatPct}%)"></div>` : ''}
                            ${down > 0 ? `<div class="bar-seg negative" style="width: ${downPct}%; height: 100%; background: var(--accent-red);" title="Giảm: ${down} (${downPct}%)"></div>` : ''}
                        </div>
                    </div>
                </td>
            `;
        }
        
        let rowClickAttr = '';
        if (isIndustry && item.code) {
            rowClickAttr = `onclick="showIndustryTopStocks('${item.code}', '${(item.name || '').replace(/'/g, "\\'")}')" style="cursor:pointer;" title="Click để xem danh sách CP trong ngành"`;
        } else if (!isIndustry && item.name) {
            rowClickAttr = `onclick="showMarketcapTopStocks('${(item.name || '').replace(/'/g, "\\'")}')" style="cursor:pointer;" title="Click để xem danh sách CP trong nhóm"`;
        }

        html += `<tr ${rowClickAttr}>
            <td>${i + 1}</td>
            <td style="font-weight: 600; color: var(--accent-blue);">${item.name} <span style="opacity:0.5; font-size:11px;">▸</span></td>
            <td class="force-cell" style="color:${forceColor}">${item.lucCau.toFixed(1)}%</td>
            <td class="ma10-cell" style="color:${ma10Color}">${item.percentAboveMA10.toFixed(1)}%</td>
            <td>${item.stockCount}</td>
            ${isIndustry ? `<td>${formatMarketCap(item.marketCap)}</td>` : ''}
            ${breadthCell}
        </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

/**
 * Show top stocks for an industry when clicking on bubble chart
 */
async function showIndustryTopStocks(industryCode, industryName) {
    console.log('showIndustryTopStocks called:', industryCode, industryName);
    // Create or get modal
    let modal = document.getElementById('industry-top-stocks-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'industry-top-stocks-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content industry-modal">
                <div class="modal-header">
                    <h3 id="industry-modal-title">Top CP Mạnh Nhất Ngành</h3>
                    <button class="close-modal" onclick="closeIndustryModal()">&times;</button>
                </div>
                <div class="modal-body" id="industry-modal-body">
                    <div class="loading-spinner">Đang tải dữ liệu...</div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Close on click outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeIndustryModal();
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeIndustryModal();
        });
    }

    // Show modal with loading state
    document.getElementById('industry-modal-title').textContent = `Top CP Mạnh Nhất: ${industryName}`;
    document.getElementById('industry-modal-body').innerHTML = '<div class="loading-spinner">Đang tải dữ liệu...</div>';
    modal.style.display = 'flex';
    console.log('Modal displayed, fetching data...');

    try {
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/industry-top-stocks?code=${industryCode}`);
        const result = await response.json();

        if (!result.success) {
            document.getElementById('industry-modal-body').innerHTML = `<p class="error-text">Lỗi: ${result.error}</p>`;
            return;
        }

        renderIndustryTopStocks(result);
    } catch (error) {
        document.getElementById('industry-modal-body').innerHTML = `<p class="error-text">Lỗi kết nối: ${error.message}</p>`;
    }
}

/**
 * Close industry top stocks modal
 */
function closeIndustryModal() {
    const modal = document.getElementById('industry-top-stocks-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * Render industry top stocks table in modal
 */
// Store industry data for sorting
let _industryStocksData = null;
let _industrySortKey = 'lucCau';
let _industrySortAsc = false;

function renderIndustryTopStocks(data) {
    const body = document.getElementById('industry-modal-body');
    if (!body) return;

    const { industryCode, industryName, totalStocks, totalAboveMA10, stocks } = data;

    if (!stocks || stocks.length === 0) {
        body.innerHTML = `<p>Không có CP nào trong ngành ${industryName}</p>`;
        return;
    }

    // Store data for re-render on sort
    _industryStocksData = { industryCode, industryName, totalStocks, totalAboveMA10, stocks: [...stocks] };
    _industrySortKey = 'lucCau';
    _industrySortAsc = false;

    _renderIndustryTable();
}

function _sortIndustryStocks(key) {
    if (_industrySortKey === key) {
        _industrySortAsc = !_industrySortAsc;
    } else {
        _industrySortKey = key;
        _industrySortAsc = false;
    }
    _renderIndustryTable();
}

function _renderIndustryTable() {
    const body = document.getElementById('industry-modal-body');
    if (!body || !_industryStocksData) return;

    const { industryCode, industryName, totalStocks, totalAboveMA10 } = _industryStocksData;
    const stocks = [..._industryStocksData.stocks];
    const key = _industrySortKey;
    const asc = _industrySortAsc;
    const arrow = asc ? ' ▲' : ' ▼';

    // Compute derived values for sorting
    stocks.sort((a, b) => {
        let va, vb;
        if (key === 'vsMA10') {
            va = a.ma10 > 0 ? (a.price - a.ma10) / a.ma10 * 100 : 0;
            vb = b.ma10 > 0 ? (b.price - b.ma10) / b.ma10 * 100 : 0;
        } else {
            va = a[key] ?? 0;
            vb = b[key] ?? 0;
        }
        if (typeof va === 'string') return asc ? va.localeCompare(vb) : vb.localeCompare(va);
        return asc ? va - vb : vb - va;
    });

    const sortCols = [
        { key: 'symbol', label: 'Mã CP' },
        { key: 'price', label: 'Giá' },
        { key: 'ma10', label: 'MA10' },
        { key: 'vsMA10', label: '% vs MA10' },
        { key: 'lucCau', label: 'Lực cầu (%)' },
        { key: 'totalVolume', label: 'KL' },
        { key: 'percentChange', label: '% Thay đổi' }
    ];

    // Calculate advances/declines/unchanged stats
    const totalCount = stocks.length;
    let upCount = 0;
    let downCount = 0;
    let flatCount = 0;

    stocks.forEach(s => {
        const change = s.percentChange || 0;
        if (change > 0) {
            upCount++;
        } else if (change < 0) {
            downCount++;
        } else {
            flatCount++;
        }
    });

    const upPct = totalCount > 0 ? parseFloat(((upCount / totalCount) * 100).toFixed(1)) : 0;
    const flatPct = totalCount > 0 ? parseFloat(((flatCount / totalCount) * 100).toFixed(1)) : 0;
    const downPct = totalCount > 0 ? parseFloat(((downCount / totalCount) * 100).toFixed(1)) : 0;

    const breadthHtml = `
        <div class="modal-breadth-container">
            <div class="modal-breadth-title">
                <span>📈 Phân bổ số mã Tăng / Giảm / Không đổi</span>
                <span style="font-size: 12px; color: var(--text-secondary); font-weight: normal;">Tổng số: ${totalCount} mã</span>
            </div>
            <div class="modal-breadth-bar">
                ${upCount > 0 ? `<div class="bar-seg positive" style="width: ${upPct}%" title="Tăng: ${upCount} mã (${upPct}%)"></div>` : ''}
                ${flatCount > 0 ? `<div class="bar-seg warning" style="width: ${flatPct}%" title="Không đổi: ${flatCount} mã (${flatPct}%)"></div>` : ''}
                ${downCount > 0 ? `<div class="bar-seg negative" style="width: ${downPct}%" title="Giảm: ${downCount} mã (${downPct}%)"></div>` : ''}
            </div>
            <div class="modal-breadth-stats" style="margin-top: 10px; justify-content: space-between;">
                <div class="modal-breadth-stat positive">
                    <span class="dot"></span>
                    <span>Tăng: <strong>${upCount}</strong> (${upPct}%)</span>
                </div>
                <div class="modal-breadth-stat warning">
                    <span class="dot"></span>
                    <span>Không đổi: <strong>${flatCount}</strong> (${flatPct}%)</span>
                </div>
                <div class="modal-breadth-stat negative">
                    <span class="dot"></span>
                    <span>Giảm: <strong>${downCount}</strong> (${downPct}%)</span>
                </div>
            </div>
        </div>
    `;

    let html = `
        <div class="industry-summary">
            <span class="summary-item"><strong>Ngành:</strong> ${industryName} (${industryCode})</span>
            <span class="summary-item"><strong>Tổng CP:</strong> ${totalStocks} mã</span>
            <span class="summary-item" style="color: var(--accent-green)"><strong>Trên MA10:</strong> ${totalAboveMA10} mã</span>
            <span class="summary-item" style="color: var(--accent-red)"><strong>Dưới MA10:</strong> ${totalStocks - totalAboveMA10} mã</span>
        </div>
        ${breadthHtml}
        <table class="industry-stocks-table">
            <thead>
                <tr>
                    <th>#</th>
                    ${sortCols.map(c => `<th style="cursor:pointer; user-select:none;" onclick="_sortIndustryStocks('${c.key}')">${c.label}${key === c.key ? arrow : ''}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
    `;

    stocks.forEach((stock, index) => {
        const vsMA10 = stock.ma10 > 0 ? ((stock.price - stock.ma10) / stock.ma10 * 100).toFixed(2) : 0;
        const lucCauColor = stock.lucCau >= 50 ? 'var(--accent-green)' : 'var(--accent-red)';
        const changeColor = stock.percentChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        const rowBg = stock.aboveMA10 ? 'rgba(0, 255, 136, 0.05)' : 'rgba(255, 68, 102, 0.03)';
        const ma10Status = stock.aboveMA10
            ? '<span style="color: var(--accent-green); font-size: 11px;">✓ Trên</span>'
            : '<span style="color: var(--accent-red); font-size: 11px;">✗ Dưới</span>';

        html += `
            <tr onclick="window.open('https://finance.vietstock.vn/${stock.symbol}.htm', '_blank')" style="cursor: pointer; background: ${rowBg};">
                <td>${index + 1}</td>
                <td class="stock-code">${stock.symbol} ${ma10Status}</td>
                <td>${formatPriceVN(stock.price)}</td>
                <td>${formatPriceVN(stock.ma10)}</td>
                <td style="color:${vsMA10 >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${vsMA10 >= 0 ? '+' : ''}${vsMA10}%</td>
                <td class="force-cell" style="color:${lucCauColor}; font-weight: 600;">${stock.lucCau.toFixed(1)}%</td>
                <td>${formatVolume(stock.totalVolume)}</td>
                <td style="color:${changeColor}">${stock.percentChange >= 0 ? '+' : ''}${stock.percentChange}%</td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    body.innerHTML = html;
}

/**
 * Format price in Vietnamese style (divide by 1000)
 */
function formatPriceVN(price) {
    if (!price) return '-';
    return (price / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
}

/**
 * Format volume
 */
function formatVolume(vol) {
    if (!vol) return '-';
    if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
    if (vol >= 1e3) return (vol / 1e3).toFixed(1) + 'K';
    return vol.toLocaleString('vi-VN');
}

/**
 * Show top stocks for a market cap group when clicking on bubble chart
 */
async function showMarketcapTopStocks(groupName) {
    console.log('showMarketcapTopStocks called:', groupName);
    let modal = document.getElementById('marketcap-top-stocks-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'marketcap-top-stocks-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content industry-modal">
                <div class="modal-header">
                    <h3 id="marketcap-modal-title">Danh Sách CP Nhóm Vốn Hóa</h3>
                    <button class="close-modal" onclick="closeMarketcapModal()">&times;</button>
                </div>
                <div class="modal-body" id="marketcap-modal-body">
                    <div class="loading-spinner">Đang tải dữ liệu...</div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeMarketcapModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMarketcapModal();
        });
    }

    const groupLabels = {
        'Super Large': 'Super Large Cap',
        'Large': 'Large Cap',
        'Mid': 'Mid Cap',
        'Small': 'Small Cap'
    };

    document.getElementById('marketcap-modal-title').textContent = `Danh Sách CP: ${groupLabels[groupName] || groupName}`;
    document.getElementById('marketcap-modal-body').innerHTML = '<div class="loading-spinner">Đang tải dữ liệu...</div>';
    modal.style.display = 'flex';

    try {
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/marketcap-top-stocks?group=${encodeURIComponent(groupName)}`);
        const result = await response.json();

        if (!result.success) {
            document.getElementById('marketcap-modal-body').innerHTML = `<p class="error-text">Lỗi: ${result.error}</p>`;
            return;
        }

        renderMarketcapTopStocks(result);
    } catch (error) {
        document.getElementById('marketcap-modal-body').innerHTML = `<p class="error-text">Lỗi kết nối: ${error.message}</p>`;
    }
}

/**
 * Close market cap top stocks modal
 */
function closeMarketcapModal() {
    const modal = document.getElementById('marketcap-top-stocks-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * Render market cap top stocks table in modal
 */
let _marketcapStocksData = null;
let _marketcapSortKey = 'lucCau';
let _marketcapSortAsc = false;

function renderMarketcapTopStocks(data) {
    const body = document.getElementById('marketcap-modal-body');
    if (!body) return;

    const { groupName, totalStocks, totalAboveMA10, stocks } = data;

    if (!stocks || stocks.length === 0) {
        body.innerHTML = `<p>Không có CP nào trong nhóm ${groupName}</p>`;
        return;
    }

    _marketcapStocksData = { groupName, totalStocks, totalAboveMA10, stocks: [...stocks] };
    _marketcapSortKey = 'lucCau';
    _marketcapSortAsc = false;

    _renderMarketcapTable();
}

function _sortMarketcapStocks(key) {
    if (_marketcapSortKey === key) {
        _marketcapSortAsc = !_marketcapSortAsc;
    } else {
        _marketcapSortKey = key;
        _marketcapSortAsc = false;
    }
    _renderMarketcapTable();
}

function _renderMarketcapTable() {
    const body = document.getElementById('marketcap-modal-body');
    if (!body || !_marketcapStocksData) return;

    const { groupName, totalStocks, totalAboveMA10 } = _marketcapStocksData;
    const stocks = [..._marketcapStocksData.stocks];
    const key = _marketcapSortKey;
    const asc = _marketcapSortAsc;
    const arrow = asc ? ' ▲' : ' ▼';

    stocks.sort((a, b) => {
        let va, vb;
        if (key === 'vsMA10') {
            va = a.ma10 > 0 ? (a.price - a.ma10) / a.ma10 * 100 : 0;
            vb = b.ma10 > 0 ? (b.price - b.ma10) / b.ma10 * 100 : 0;
        } else if (key === 'marketCap') {
            va = a.marketCap || 0;
            vb = b.marketCap || 0;
        } else {
            va = a[key] ?? 0;
            vb = b[key] ?? 0;
        }
        if (typeof va === 'string') return asc ? va.localeCompare(vb) : vb.localeCompare(va);
        return asc ? va - vb : vb - va;
    });

    const sortCols = [
        { key: 'symbol', label: 'Mã CP' },
        { key: 'price', label: 'Giá' },
        { key: 'ma10', label: 'MA10' },
        { key: 'vsMA10', label: '% vs MA10' },
        { key: 'lucCau', label: 'Lực cầu (%)' },
        { key: 'totalVolume', label: 'KL' },
        { key: 'percentChange', label: '% Thay đổi' },
        { key: 'marketCap', label: 'Vốn hóa' }
    ];

    const groupLabels = {
        'Super Large': 'Super Large Cap',
        'Large': 'Large Cap',
        'Mid': 'Mid Cap',
        'Small': 'Small Cap'
    };

    // Calculate advances/declines/unchanged stats
    const totalCount = stocks.length;
    let upCount = 0;
    let downCount = 0;
    let flatCount = 0;

    stocks.forEach(s => {
        const change = s.percentChange || 0;
        if (change > 0) {
            upCount++;
        } else if (change < 0) {
            downCount++;
        } else {
            flatCount++;
        }
    });

    const upPct = totalCount > 0 ? parseFloat(((upCount / totalCount) * 100).toFixed(1)) : 0;
    const flatPct = totalCount > 0 ? parseFloat(((flatCount / totalCount) * 100).toFixed(1)) : 0;
    const downPct = totalCount > 0 ? parseFloat(((downCount / totalCount) * 100).toFixed(1)) : 0;

    const breadthHtml = `
        <div class="modal-breadth-container">
            <div class="modal-breadth-title">
                <span>📈 Phân bổ số mã Tăng / Giảm / Không đổi</span>
                <span style="font-size: 12px; color: var(--text-secondary); font-weight: normal;">Tổng số: ${totalCount} mã</span>
            </div>
            <div class="modal-breadth-bar">
                ${upCount > 0 ? `<div class="bar-seg positive" style="width: ${upPct}%" title="Tăng: ${upCount} mã (${upPct}%)"></div>` : ''}
                ${flatCount > 0 ? `<div class="bar-seg warning" style="width: ${flatPct}%" title="Không đổi: ${flatCount} mã (${flatPct}%)"></div>` : ''}
                ${downCount > 0 ? `<div class="bar-seg negative" style="width: ${downPct}%" title="Giảm: ${downCount} mã (${downPct}%)"></div>` : ''}
            </div>
            <div class="modal-breadth-stats" style="margin-top: 10px; justify-content: space-between;">
                <div class="modal-breadth-stat positive">
                    <span class="dot"></span>
                    <span>Tăng: <strong>${upCount}</strong> (${upPct}%)</span>
                </div>
                <div class="modal-breadth-stat warning">
                    <span class="dot"></span>
                    <span>Không đổi: <strong>${flatCount}</strong> (${flatPct}%)</span>
                </div>
                <div class="modal-breadth-stat negative">
                    <span class="dot"></span>
                    <span>Giảm: <strong>${downCount}</strong> (${downPct}%)</span>
                </div>
            </div>
        </div>
    `;

    let html = `
        <div class="industry-summary">
            <span class="summary-item"><strong>Nhóm:</strong> ${groupLabels[groupName] || groupName}</span>
            <span class="summary-item"><strong>Tổng CP:</strong> ${totalStocks} mã</span>
            <span class="summary-item" style="color: var(--accent-green)"><strong>Trên MA10:</strong> ${totalAboveMA10} mã</span>
            <span class="summary-item" style="color: var(--accent-red)"><strong>Dưới MA10:</strong> ${totalStocks - totalAboveMA10} mã</span>
        </div>
        ${breadthHtml}
        <table class="industry-stocks-table">
            <thead>
                <tr>
                    <th>#</th>
                    ${sortCols.map(c => `<th style="cursor:pointer; user-select:none;" onclick="_sortMarketcapStocks('${c.key}')">${c.label}${key === c.key ? arrow : ''}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
    `;

    stocks.forEach((stock, index) => {
        const vsMA10 = stock.ma10 > 0 ? ((stock.price - stock.ma10) / stock.ma10 * 100).toFixed(2) : 0;
        const lucCauColor = stock.lucCau >= 50 ? 'var(--accent-green)' : 'var(--accent-red)';
        const changeColor = stock.percentChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        const rowBg = stock.aboveMA10 ? 'rgba(0, 255, 136, 0.05)' : 'rgba(255, 68, 102, 0.03)';
        const ma10Status = stock.aboveMA10
            ? '<span style="color: var(--accent-green); font-size: 11px;">✓ Trên</span>'
            : '<span style="color: var(--accent-red); font-size: 11px;">✗ Dưới</span>';

        const marketCapDisplay = stock.marketCap >= 1e12
            ? (stock.marketCap / 1e12).toFixed(1) + 'N'
            : (stock.marketCap / 1e9).toFixed(0) + 'T';

        html += `
            <tr onclick="window.open('https://finance.vietstock.vn/${stock.symbol}.htm', '_blank')" style="cursor: pointer; background: ${rowBg};">
                <td>${index + 1}</td>
                <td class="stock-code">${stock.symbol} ${ma10Status}</td>
                <td>${formatPriceVN(stock.price)}</td>
                <td>${formatPriceVN(stock.ma10)}</td>
                <td style="color:${vsMA10 >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${vsMA10 >= 0 ? '+' : ''}${vsMA10}%</td>
                <td class="force-cell" style="color:${lucCauColor}; font-weight: 600;">${stock.lucCau.toFixed(1)}%</td>
                <td>${formatVolume(stock.totalVolume)}</td>
                <td style="color:${changeColor}">${stock.percentChange >= 0 ? '+' : ''}${stock.percentChange}%</td>
                <td>${marketCapDisplay}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    body.innerHTML = html;
}

/**
 * Render VNINDEX + Lực Cầu dual-axis line chart
 */
function renderVNIndexDemandChart(data) {
    const canvas = document.getElementById('vnindex-demand-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (DashboardChartsState.vnindexDemandChart) {
        DashboardChartsState.vnindexDemandChart.destroy();
    }

    const labels = data.map(d => d.time || d.date?.slice(5) || ''); // HH:MM time format for intraday
    const vnindexData = data.map(d => d.vnindex);
    const lucCauData = data.map(d => d.lucCau);

    DashboardChartsState.vnindexDemandChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'VNINDEX',
                    data: vnindexData,
                    borderColor: '#90EE90',
                    backgroundColor: 'rgba(144, 238, 144, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    yAxisID: 'y',
                    pointRadius: 0,
                    fill: true
                },
                {
                    label: 'Lực Cầu',
                    data: lucCauData,
                    borderColor: '#FFB6C1',
                    backgroundColor: 'rgba(255, 182, 193, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    yAxisID: 'y1',
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                annotation: {
                    annotations: {
                        line35: {
                            type: 'line', yMin: 35, yMax: 35, yScaleID: 'y1',
                            borderColor: 'rgba(255, 107, 107, 0.8)', borderWidth: 1, borderDash: [4, 4],
                            label: {
                                display: true,
                                content: '35%',
                                position: 'start',
                                backgroundColor: 'rgba(255, 107, 107, 0.7)',
                                color: '#fff',
                                font: { size: 10 }
                            }
                        },
                        line50: {
                            type: 'line', yMin: 50, yMax: 50, yScaleID: 'y1',
                            borderColor: 'rgba(255, 217, 61, 0.8)', borderWidth: 1, borderDash: [4, 4],
                            label: {
                                display: true,
                                content: '50%',
                                position: 'start',
                                backgroundColor: 'rgba(255, 217, 61, 0.7)',
                                color: '#000',
                                font: { size: 10 }
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: { display: true, text: 'VNINDEX', color: '#90EE90' },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#90EE90' }
                },
                y1: {
                    type: 'linear',
                    position: 'right',
                    title: { display: true, text: 'Lực Cầu (%)', color: '#FFB6C1' },
                    min: 30, max: 70,
                    grid: { drawOnChartArea: false },
                    ticks: { color: '#FFB6C1' }
                }
            }
        }
    });
}

/**
 * Render VN30 + Lực Cầu dual-axis line chart
 */
function renderVN30DemandChart(data) {
    const canvas = document.getElementById('vn30-demand-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (DashboardChartsState.vn30DemandChart) {
        DashboardChartsState.vn30DemandChart.destroy();
    }

    const labels = data.map(d => d.time || d.date?.slice(5) || ''); // HH:MM time format for intraday
    const vn30Data = data.map(d => d.vn30);
    const lucCauData = data.map(d => d.lucCauVN30);

    DashboardChartsState.vn30DemandChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'VN30',
                    data: vn30Data,
                    borderColor: '#00BFFF',
                    backgroundColor: 'rgba(0, 191, 255, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    yAxisID: 'y',
                    pointRadius: 0,
                    fill: true
                },
                {
                    label: 'Lực Cầu',
                    data: lucCauData,
                    borderColor: '#FFB6C1',
                    backgroundColor: 'rgba(255, 182, 193, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    yAxisID: 'y1',
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                annotation: {
                    annotations: {
                        line35: {
                            type: 'line', yMin: 35, yMax: 35, yScaleID: 'y1',
                            borderColor: 'rgba(255, 107, 107, 0.8)', borderWidth: 1, borderDash: [4, 4],
                            label: {
                                display: true,
                                content: '35%',
                                position: 'start',
                                backgroundColor: 'rgba(255, 107, 107, 0.7)',
                                color: '#fff',
                                font: { size: 10 }
                            }
                        },
                        line50: {
                            type: 'line', yMin: 50, yMax: 50, yScaleID: 'y1',
                            borderColor: 'rgba(255, 217, 61, 0.8)', borderWidth: 1, borderDash: [4, 4],
                            label: {
                                display: true,
                                content: '50%',
                                position: 'start',
                                backgroundColor: 'rgba(255, 217, 61, 0.7)',
                                color: '#000',
                                font: { size: 10 }
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#888', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: { display: true, text: 'VN30', color: '#00BFFF' },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#00BFFF' }
                },
                y1: {
                    type: 'linear',
                    position: 'right',
                    title: { display: true, text: 'Lực Cầu (%)', color: '#FFB6C1' },
                    min: 30, max: 70,
                    grid: { drawOnChartArea: false },
                    ticks: { color: '#FFB6C1' }
                }
            }
        }
    });
}

/**
 * Initialize all charts
 */
function initializeCharts() {
    // Mini charts for index cards
    StockCharts.createMiniLineChart('vnindex-chart', StockCharts.generateMiniChartData(true), true);
    StockCharts.createMiniLineChart('vn30-chart', StockCharts.generateMiniChartData(true), true);

    // Foreign flow chart: dữ liệu THẬT do loadForeignFlow() vẽ từ /api/foreign-flow.
    // (Trước đây dùng StockCharts.createForeignFlowChart với generateForeignFlowData()
    //  = 5 giá trị NGẪU NHIÊN — đã bỏ để không hiển thị dữ liệu giả.)

    // Investor pie chart
    const investorData = AppState.data.investorFlow || {
        foreign: 245.8,
        individual: 567.2,
        proprietary: 123.4,
        institution: 198.0
    };

    StockCharts.createInvestorPieChart('investor-pie-chart', {
        foreign: Math.abs(investorData.foreign?.net || investorData.foreign || 245.8),
        individual: Math.abs(investorData.individual?.net || investorData.individual || 567.2),
        proprietary: Math.abs(investorData.proprietary?.net || investorData.proprietary || 123.4),
        institution: Math.abs(investorData.institution?.net || investorData.institution || 198.0)
    });

    // Money flow line chart
    const historicalData = StockAPI.MockData.generateHistoricalData(30);
    StockCharts.createMoneyFlowLineChart('money-flow-line-chart', historicalData);

    // Industry bar chart
    const industryData = AppState.data.industryFlow || StockAPI.MockData.generateIndustryFlow();
    StockCharts.createIndustryBarChart('industry-bar-chart', industryData);
}

/**
 * Refresh all charts
 */
function refreshCharts() {
    const { indices, investorFlow, industryFlow } = AppState.data;

    // Refresh mini charts
    if (indices) {
        StockCharts.createMiniLineChart('vnindex-chart',
            StockCharts.generateMiniChartData(indices.vnindex?.change >= 0),
            indices.vnindex?.change >= 0
        );
        StockCharts.createMiniLineChart('vn30-chart',
            StockCharts.generateMiniChartData(indices.vn30?.change >= 0),
            indices.vn30?.change >= 0
        );
        StockCharts.createMiniLineChart('hnx-chart',
            StockCharts.generateMiniChartData(indices.hnx?.change >= 0),
            indices.hnx?.change >= 0
        );
    }

    // Refresh investor pie chart
    if (investorFlow) {
        StockCharts.createInvestorPieChart('investor-pie-chart', {
            foreign: Math.abs(investorFlow.foreign?.net || 0),
            individual: Math.abs(investorFlow.individual?.net || 0),
            proprietary: Math.abs(investorFlow.proprietary?.net || 0),
            institution: Math.abs(investorFlow.institution?.net || 0)
        });
    }

    // Refresh industry chart
    if (industryFlow) {
        StockCharts.createIndustryBarChart('industry-bar-chart', industryFlow);
    }
}

/**
 * Filter stock table by search term
 */
function filterStockTable(searchTerm) {
    const tbody = document.getElementById('price-tbody');
    if (!tbody) return;

    const rows = tbody.querySelectorAll('tr');
    const term = searchTerm.toLowerCase();

    rows.forEach(row => {
        const symbol = row.cells[0]?.textContent.toLowerCase() || '';
        const name = row.cells[1]?.textContent.toLowerCase() || '';

        if (symbol.includes(term) || name.includes(term)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

/**
 * Update time display
 */
function updateTimeDisplay() {
    if (AppState.lastUpdate) {
        const hours = String(AppState.lastUpdate.getHours()).padStart(2, '0');
        const minutes = String(AppState.lastUpdate.getMinutes()).padStart(2, '0');
        const seconds = String(AppState.lastUpdate.getSeconds()).padStart(2, '0');

        elements.updateTime.textContent = `${hours}:${minutes}:${seconds}`;
    }
}

// ==========================================
// NEWS SECTION
// ==========================================

/**
 * Load news from RSS API
 */
/** Render the news grid from an array of news items. */
function renderNewsItems(news) {
    const newsGrid = document.getElementById('news-grid');
    if (!newsGrid) return;
    if (news && news.length > 0) {
        newsGrid.innerHTML = news.map(item => `
                <div class="news-item">
                    <div class="news-category">${item.category}</div>
                    <h4 class="news-title">
                        <a href="${item.link}" target="_blank" rel="noopener noreferrer">
                            ${item.title}
                        </a>
                    </h4>
                    <div class="news-meta">
                        <span class="news-source">${item.source}</span>
                        <span class="news-time">${item.timeAgo}</span>
                    </div>
                </div>
            `).join('');
    } else {
        newsGrid.innerHTML = '<p style="text-align: center; padding: 2rem; color: var(--text-muted);">Không có tin tức mới.</p>';
    }
}

async function loadNews(category = 'all') {
    console.log(`📰 Loading news (category: ${category})...`);

    const newsGrid = document.getElementById('news-grid');
    if (!newsGrid) return;

    const cacheKey = 'news-' + category;
    const hasCache = window.StockCache && window.StockCache.getStale(cacheKey);

    // Fallback path if the cache module is unavailable for some reason.
    if (!window.StockCache) {
        newsGrid.innerHTML = '<div class="loading"></div>';
        try {
            const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/news?category=${category}&limit=30`);
            const data = await response.json();
            renderNewsItems(data.success && data.news ? data.news : []);
        } catch (error) {
            console.error('❌ Error loading news:', error);
            newsGrid.innerHTML = '<p style="text-align: center; padding: 2rem; color: var(--accent-red);">Lỗi tải tin tức. Vui lòng thử lại.</p>';
        }
        return;
    }

    // Only show the spinner when there is nothing cached to paint yet; otherwise
    // the cached news shows instantly and refreshes in the background (SWR).
    if (!hasCache) {
        newsGrid.innerHTML = '<div class="loading"></div>';
    }

    try {
        await window.StockCache.swr(cacheKey, async () => {
            const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/news?category=${category}&limit=30`);
            const data = await response.json();
            return (data.success && data.news) ? data.news : [];
        }, 120000, (news) => renderNewsItems(news));
    } catch (error) {
        console.error('❌ Error loading news:', error);
        if (!hasCache) {
            newsGrid.innerHTML = '<p style="text-align: center; padding: 2rem; color: var(--accent-red);">Lỗi tải tin tức. Vui lòng thử lại.</p>';
        }
    }
}

/**
 * Setup news event listeners
 */
function setupNewsEventListeners() {
    // News refresh button
    const refreshNewsBtn = document.getElementById('refreshNewsBtn');
    if (refreshNewsBtn) {
        refreshNewsBtn.addEventListener('click', () => {
            const category = document.getElementById('news-category')?.value || 'all';
            loadNews(category);
        });
    }

    // News category filter
    const newsCategory = document.getElementById('news-category');
    if (newsCategory) {
        newsCategory.addEventListener('change', (e) => {
            loadNews(e.target.value);
        });
    }
}

// Override switchTab to load news when switching to news tab
function switchTab(tabId) {
    // Call original switch tab function
    AppState.currentTab = tabId;

    // Update active tab button
    elements.tabs.forEach(tab => {
        if (tab.getAttribute('data-tab') === tabId) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // Update visible content
    elements.tabContents.forEach(content => {
        if (content.id === tabId) {
            content.classList.add('active');
        } else {
            content.classList.remove('active');
        }
    });

    // Trigger chart resize
    window.dispatchEvent(new Event('resize'));

    // Load price board data when switching to price-board tab
    if (tabId === 'price-board' && !PriceBoardState.isLoading && 
        !(PriceBoardState.allStocks.HSX?.length > 0)) {
        console.log('💰 Loading price board data...');
        loadAllStocksFor3Exchanges();
    }

    // Load news when switching to news tab
    if (tabId === 'news') {
        loadNews();
    }

    // Init MA breadth khi switch sang tab industry lần đầu (lazy-load)
    if (tabId === 'industry') {
        try { initMABreadth(); } catch (e) { console.error('MA breadth init error:', e); }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initApp();
    setupNewsEventListeners();
    setupIndustryTableSort();
});

// ==========================================
// INDUSTRY TABLE SORT FUNCTIONALITY
// ==========================================

/** Store industry flow data for sorting */
let cachedIndustryFlowData = [];

/**
 * Setup sort event listeners for industry table
 */
function setupIndustryTableSort() {
    const table = document.getElementById('industry-table');
    if (!table) return;

    const headers = table.querySelectorAll('th.sortable');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const sortKey = header.dataset.sort;
            const currentOrder = header.classList.contains('sort-asc') ? 'asc' :
                header.classList.contains('sort-desc') ? 'desc' : 'none';

            // Remove sort classes from all headers
            headers.forEach(h => {
                h.classList.remove('sort-asc', 'sort-desc');
            });

            // Toggle sort order
            let newOrder;
            if (currentOrder === 'none' || currentOrder === 'asc') {
                newOrder = 'desc';
                header.classList.add('sort-desc');
            } else {
                newOrder = 'asc';
                header.classList.add('sort-asc');
            }

            // Sort and re-render
            sortIndustryTable(sortKey, newOrder);
        });
    });
}

/**
 * Sort industry table by specified key and order
 */
function sortIndustryTable(sortKey, order) {
    if (!cachedIndustryFlowData || cachedIndustryFlowData.length === 0) return;

    const sortedData = [...cachedIndustryFlowData].sort((a, b) => {
        let valA, valB;

        switch (sortKey) {
            case 'name':
                valA = a.name.toLowerCase();
                valB = b.name.toLowerCase();
                return order === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            case 'closeIndex':
                valA = a.closeIndex || 0;
                valB = b.closeIndex || 0;
                break;
            case 'percentChange':
                valA = a.percentChange || 0;
                valB = b.percentChange || 0;
                break;
            case 'caNhan':
                valA = a.caNhan || 0;
                valB = b.caNhan || 0;
                break;
            case 'toChuc':
                valA = a.toChuc || 0;
                valB = b.toChuc || 0;
                break;
            case 'tuDoanh':
                valA = a.tuDoanh || 0;
                valB = b.tuDoanh || 0;
                break;
            case 'nuocNgoai':
                valA = a.nuocNgoai || 0;
                valB = b.nuocNgoai || 0;
                break;
            default:
                return 0;
        }

        if (order === 'asc') {
            return valA - valB;
        } else {
            return valB - valA;
        }
    });

    renderIndustryTableRows(sortedData);
}

/**
 * Render industry table rows
 */
function renderIndustryTableRows(data) {
    const tbody = document.getElementById('industry-tbody');
    if (!tbody) return;

    const money = (value) => {
        const v = value || 0;
        const cls = v >= 0 ? 'positive' : 'negative';
        return `<td class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(1)}</td>`;
    };

    tbody.innerHTML = data.map(ind => {
        const pct = ind.percentChange || 0;
        const pctCls = pct >= 0 ? 'positive' : 'negative';
        return `
            <tr>
                <td>${ind.name}</td>
                <td>${(ind.closeIndex || 0).toLocaleString('vi-VN')}</td>
                <td class="${pctCls}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</td>
                ${money(ind.caNhan)}
                ${money(ind.toChuc)}
                ${money(ind.tuDoanh)}
                ${money(ind.nuocNgoai)}
            </tr>
        `;
    }).join('');
}

// ==========================================
// TRADINGVIEW MODAL LOGIC
// ==========================================

function openTradingViewModal(symbol) {
    // Map exchange from the in-memory price board so TVChart can label/route
    // the symbol. HOSE is the default; internal data may use HSX for HOSE.
    let exchange = 'HOSE';
    if (PriceBoardState.allStocks.HSX && PriceBoardState.allStocks.HSX.find(s => s.symbol === symbol)) exchange = 'HOSE';
    else if (PriceBoardState.allStocks.HNX && PriceBoardState.allStocks.HNX.find(s => s.symbol === symbol)) exchange = 'HNX';
    else if (PriceBoardState.allStocks.UPCOM && PriceBoardState.allStocks.UPCOM.find(s => s.symbol === symbol)) exchange = 'UPCOM';

    // Delegate to the TVChart module (Lightweight Charts). It owns showing the
    // #tv-modal, drawing candle/volume/trendline, resize handling, error/empty
    // states and close affordances (✕ / backdrop / Esc) via LOCAL listeners —
    // so no global window.onclick wiring is needed here anymore.
    if (window.TVChart && typeof window.TVChart.open === 'function') {
        window.TVChart.open(symbol, exchange);
    } else {
        console.error('TVChart is not available; cannot open chart for', symbol);
    }
}

// ==========================================
// STOCK FILTER TAB LOGIC
// ==========================================

const FilterTabState = {
    conditions: [], // Array of { id, column, operator, value }
    presets: {}, // Will be loaded from server
    results: [],
    sortColumn: 'symbol',
    sortDirection: 'asc'
};

// ==========================================
// FILTER PRESETS SERVER API
// ==========================================

/**
 * Load filter presets from server
 */
async function loadPresetsFromServer() {
    try {
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/filter-presets`);
        const data = await response.json();
        if (data.success && data.presets) {
            FilterTabState.presets = data.presets;
            console.log(`✅ Loaded ${Object.keys(data.presets).length} presets from server`);

            // Also update localStorage as backup
            localStorage.setItem('vnstock_filter_presets', JSON.stringify(data.presets));

            updatePresetSelect();
            return true;
        }
    } catch (error) {
        console.error('❌ Error loading presets from server:', error);
        // Fallback to localStorage
        const localPresets = localStorage.getItem('vnstock_filter_presets');
        if (localPresets) {
            FilterTabState.presets = JSON.parse(localPresets);
            console.log('⚠️ Using localStorage fallback');
            updatePresetSelect();
        }
    }
    return false;
}

/**
 * Save a filter preset to server
 */
async function savePresetToServer(name, conditions) {
    try {
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/filter-presets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, conditions })
        });
        const data = await response.json();
        if (data.success) {
            console.log(`✅ Preset "${name}" saved to server`);
            // Update local state
            FilterTabState.presets[name] = conditions;
            localStorage.setItem('vnstock_filter_presets', JSON.stringify(FilterTabState.presets));
            return true;
        }
    } catch (error) {
        console.error('❌ Error saving preset to server:', error);
        // Fallback: save to localStorage only
        FilterTabState.presets[name] = conditions;
        localStorage.setItem('vnstock_filter_presets', JSON.stringify(FilterTabState.presets));
    }
    return false;
}

/**
 * Delete a filter preset from server
 */
async function deletePresetFromServer(name) {
    try {
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/filter-presets/${encodeURIComponent(name)}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (data.success) {
            console.log(`✅ Preset "${name}" deleted from server`);
            // Update local state
            delete FilterTabState.presets[name];
            localStorage.setItem('vnstock_filter_presets', JSON.stringify(FilterTabState.presets));
            return true;
        }
    } catch (error) {
        console.error('❌ Error deleting preset from server:', error);
        // Fallback: delete from localStorage only
        delete FilterTabState.presets[name];
        localStorage.setItem('vnstock_filter_presets', JSON.stringify(FilterTabState.presets));
    }
    return false;
}

const FILTER_COLUMNS = [
    { key: 'price', label: 'Giá' },
    { key: 'changePercent', label: '% Thay Đổi' },
    { key: 'volume', label: 'Khối Lượng' },
    { key: 'volRatio', label: '% KL/TB' },
    { key: 'value', label: 'GTGD (Tỷ)' },
    { key: 'ma10', label: 'MA10' },
    { key: 'ma20', label: 'MA20' },
    { key: 'ma45', label: 'MA45' },
    { key: 'demandStrength', label: 'Lực Cầu' },
    { key: 'ma2_trend', label: 'MA2 Cắt Lên MA10 (1=Có)' }
];

/**
 * Initialize Stock Filter Tab
 */
async function initStockFilterTab() {
    const btnAdd = document.getElementById('btn-add-condition');
    const btnRun = document.getElementById('btn-run-filter');
    const btnClear = document.getElementById('btn-clear-all-filters');
    const btnSave = document.getElementById('btn-save-preset');
    const btnRename = document.getElementById('btn-rename-preset');
    const btnDelete = document.getElementById('btn-delete-preset');
    const presetSelect = document.getElementById('filter-preset-select');

    if (btnAdd) btnAdd.addEventListener('click', () => addFilterCondition());
    if (btnRun) btnRun.addEventListener('click', runStockFilter);
    if (btnClear) btnClear.addEventListener('click', clearAllConditions);
    if (btnSave) btnSave.addEventListener('click', saveFilterPreset);
    if (btnRename) btnRename.addEventListener('click', renameFilterPreset);
    if (btnDelete) btnDelete.addEventListener('click', deleteFilterPreset);
    if (presetSelect) presetSelect.addEventListener('change', loadFilterPreset);

    // Setup sort handlers for filter results table
    setupFilterResultsSort();

    // Load presets from server (with localStorage fallback)
    await loadPresetsFromServer();

    // Migration: if server has no presets but localStorage has, migrate them
    const localPresets = JSON.parse(localStorage.getItem('vnstock_filter_presets') || '{}');
    if (Object.keys(FilterTabState.presets).length === 0 && Object.keys(localPresets).length > 0) {
        console.log('📦 Migrating presets from localStorage to server...');
        for (const [name, conditions] of Object.entries(localPresets)) {
            await savePresetToServer(name, conditions);
        }
        await loadPresetsFromServer();
    }
}

// ... (rest of functions)

function runStockFilter() {
    console.log('🚀 Starting Stock Filter...');
    const list = document.getElementById('filter-conditions-list');
    const rows = list.querySelectorAll('.filter-condition-row');
    const conditions = [];

    rows.forEach(row => {
        conditions.push({
            column: row.querySelector('.cond-column').value,
            operator: row.querySelector('.cond-operator').value,
            value: parseFloat(row.querySelector('.cond-value').value)
        });
    });

    console.log('📋 Filter Conditions:', conditions);

    // Aggregate all stocks
    let allStocks = [];
    if (PriceBoardState.allStocks.HSX && Array.isArray(PriceBoardState.allStocks.HSX))
        allStocks = allStocks.concat(PriceBoardState.allStocks.HSX);
    if (PriceBoardState.allStocks.HNX && Array.isArray(PriceBoardState.allStocks.HNX))
        allStocks = allStocks.concat(PriceBoardState.allStocks.HNX);
    if (PriceBoardState.allStocks.UPCOM && Array.isArray(PriceBoardState.allStocks.UPCOM))
        allStocks = allStocks.concat(PriceBoardState.allStocks.UPCOM);

    console.log(`📊 Total Stocks to Filter: ${allStocks.length}`);

    if (allStocks.length === 0) {
        alert('⚠️ Dữ liệu cổ phiếu chưa được tải. Vui lòng đợi hoặc tải lại trang.');
        return;
    }

    const results = allStocks.filter(stock => {
        // Prepare specialized derived values for filtering
        const prevPrice = stock.price - (stock.change || 0);
        const ma2 = (stock.price + prevPrice) / 2; // SMA2
        const ma10 = stock.ma10 || 0;

        // Cross Up: Currently MA2 > MA10, but previously (approx yesterday) it was likely below.
        // We use prevPrice < ma10 as a proxy since we don't have prevMA10
        const ma2_trend = (ma10 > 0 && ma2 > ma10 && prevPrice < ma10) ? 1 : 0;

        // Extended Stock Object for Check
        const checkStock = { ...stock, ma2_trend };

        const pass = conditions.every(cond => {
            let stockVal = checkStock[cond.column];

            // Handle potentially undefined values safely
            if (stockVal === undefined || stockVal === null) stockVal = 0;
            else stockVal = parseFloat(stockVal);

            const targetVal = cond.value;

            if (isNaN(stockVal)) return false;

            if (cond.operator === 'gt') return stockVal > targetVal;
            if (cond.operator === 'lt') return stockVal < targetVal;
            if (cond.operator === 'eq') return stockVal === targetVal;
            return true;
        });

        return pass;
    });

    console.log(`✅ Filter Results: ${results.length} stocks found.`);
    if (results.length === 0 && allStocks.length > 0) {
        console.log('⚠️ No stocks matched. Converting one sample stock for debugging:');
        const sample = allStocks.find(s => s.symbol === 'HPG') || allStocks[0];
        console.log('Sample Stock:', sample);
    }

    renderFilterResults(results);
}

function setupFilterResultsSort() {
    const table = document.getElementById('filter-results-table');
    if (!table) return;

    const headers = table.querySelectorAll('th.sortable');
    headers.forEach(header => {
        header.style.cursor = 'pointer';
        header.addEventListener('click', () => {
            const column = header.getAttribute('data-sort');

            // Toggle direction if same column
            if (FilterTabState.sortColumn === column) {
                FilterTabState.sortDirection = FilterTabState.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                FilterTabState.sortColumn = column;
                FilterTabState.sortDirection = 'asc';
            }

            // Update header indicators
            headers.forEach(h => {
                const baseText = h.textContent.replace(/[↑↓↕]/g, '').trim();
                if (h.getAttribute('data-sort') === column) {
                    h.textContent = `${baseText} ${FilterTabState.sortDirection === 'asc' ? '↑' : '↓'}`;
                } else {
                    h.textContent = `${baseText} ↕`;
                }
            });

            // Re-render with current results
            if (FilterTabState.results && FilterTabState.results.length > 0) {
                renderFilterResults(FilterTabState.results);
            }
        });
    });
}

function renderFilterResults(stocks) {
    const tbody = document.getElementById('filter-results-tbody');
    const countEl = document.getElementById('filter-result-count');
    if (!tbody) return;

    // Store results for re-sorting
    FilterTabState.results = stocks;

    if (countEl) countEl.textContent = stocks.length;

    // Sort the stocks
    const sortedStocks = [...stocks].sort((a, b) => {
        const col = FilterTabState.sortColumn;
        let valA = a[col];
        let valB = b[col];

        // Handle string vs number
        if (typeof valA === 'string') {
            valA = valA || '';
            valB = valB || '';
            return FilterTabState.sortDirection === 'asc'
                ? valA.localeCompare(valB)
                : valB.localeCompare(valA);
        } else {
            valA = valA || 0;
            valB = valB || 0;
            return FilterTabState.sortDirection === 'asc' ? valA - valB : valB - valA;
        }
    });

    // Limit display to 100 to avoid lag if too many
    const displayStocks = sortedStocks.slice(0, 100);

    tbody.innerHTML = displayStocks.map(stock => {
        const change = stock.change || 0;
        const changePercent = stock.changePercent || 0;
        const isPositive = change > 0;
        const isNegative = change < 0;
        const changeClass = isPositive ? 'positive' : (isNegative ? 'negative' : '');
        const volRatio = stock.volRatio ? stock.volRatio.toFixed(0) : '--';

        // MA Color Logic: Green if Price > MA, Red if Price < MA
        const price = stock.price || 0;
        const ma10Class = stock.ma10 ? (price > stock.ma10 ? 'text-green' : 'text-red') : '';
        const ma20Class = stock.ma20 ? (price > stock.ma20 ? 'text-green' : 'text-red') : '';
        const ma45Class = stock.ma45 ? (price > stock.ma45 ? 'text-green' : 'text-red') : '';

        return `
            <tr onclick="openTradingViewModal('${stock.symbol}')" style="cursor: pointer;">
                <td class="stock-code">${stock.symbol}</td>
                <td>${stock.exchange || ''}</td>
                <td>${formatPriceCompact(stock.price)}</td>
                <td class="${changeClass}">${isPositive ? '+' : ''}${formatPriceCompact(change)}</td>
                <td class="${changeClass}">${isPositive ? '+' : ''}${changePercent.toFixed(2)}%</td>
                <td>${StockAPI.formatVolume(stock.volume)}</td>
                <td>${volRatio}%</td>
                <td>${stock.value ? stock.value.toFixed(1) : '--'}</td>
                <td class="${ma10Class}">${stock.ma10 || '--'}</td>
                <td class="${ma20Class}">${stock.ma20 || '--'}</td>
                <td class="${ma45Class}">${stock.ma45 || '--'}</td>
                <td class="${stock.demandStrength > 50 ? 'text-green' : (stock.demandStrength < 50 ? 'text-red' : 'text-yellow')}">${stock.demandStrength}%</td>
            </tr>
        `;
    }).join('');
}

// Call init on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    initStockFilterTab();
});

function addFilterCondition(presetCondition = null) {
    const list = document.getElementById('filter-conditions-list');
    if (!list) return;

    const id = 'cond-' + Date.now() + Math.random().toString(36).substr(2, 5);
    const div = document.createElement('div');
    div.className = 'filter-condition-row';
    div.id = id;

    const colOptions = FILTER_COLUMNS.map(c => `<option value="${c.key}">${c.label}</option>`).join('');

    div.innerHTML = `
        <select class="cond-column">
            ${colOptions}
        </select>
        <select class="cond-operator">
            <option value="gt">Lớn hơn (>)</option>
            <option value="lt">Nhỏ hơn (<)</option>
            <option value="eq">Bằng (=)</option>
        </select>
        <input type="number" class="cond-value" placeholder="Giá trị..." step="0.1">
        <button class="remove-condition-btn" onclick="removeFilterCondition('${id}')">×</button>
    `;

    list.appendChild(div);

    // Set values if provided (from preset)
    if (presetCondition) {
        div.querySelector('.cond-column').value = presetCondition.column;
        div.querySelector('.cond-operator').value = presetCondition.operator;
        div.querySelector('.cond-value').value = presetCondition.value;
    }
}

function removeFilterCondition(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}
// Expose to window for onclick
// Expose functions to global scope for HTML onclick attributes
window.openTradingViewModal = openTradingViewModal;
window.runStockFilter = runStockFilter;
window.addFilterCondition = addFilterCondition;
window.removeFilterCondition = removeFilterCondition;
window.clearAllConditions = clearAllConditions;
window.saveFilterPreset = saveFilterPreset;
window.deleteFilterPreset = deleteFilterPreset;
window.loadFilterPreset = loadFilterPreset;

// Fix Persistence Case Sensitivity in Filter Logic (Update renderPriceBoard logic if needed, but handled by correct key usage)

function clearAllConditions() {

    const list = document.getElementById('filter-conditions-list');
    if (list) list.innerHTML = '';
    document.getElementById('filter-results-tbody').innerHTML = '';
    document.getElementById('filter-result-count').textContent = '0';
    document.getElementById('filter-preset-select').value = '';
}



// Preset Management functions moved to end of file

// Preset Management
async function saveFilterPreset() {
    const btnSave = document.getElementById('btn-save-preset');
    const select = document.getElementById('filter-preset-select');
    let input = document.getElementById('save-preset-input');

    // Check if we are in saving mode
    const isSaving = input && input.style.display !== 'none';

    if (!isSaving) {
        // --- ENTER SAVE MODE ---
        // Create input if it doesn't exist
        if (!input) {
            input = document.createElement('input');
            input.type = 'text';
            input.id = 'save-preset-input';
            input.placeholder = 'Nhập tên bộ lọc...';
            // Inline styles for matching theme
            input.style.padding = '8px 12px';
            input.style.border = '1px solid #444';
            input.style.borderRadius = '4px';
            input.style.backgroundColor = '#1e1e2d';
            input.style.color = '#fff';
            input.style.width = '250px';
            input.style.marginRight = '10px';

            // Insert after select
            select.parentNode.insertBefore(input, select.nextSibling);
        }

        // Pre-fill with current selection if any, or empty for new
        input.value = select.value || '';

        // Toggle visibility
        select.style.display = 'none';
        input.style.display = 'inline-block';
        input.focus();
        input.select();

        // Update Button to Confirm state
        btnSave.innerHTML = '✅ OK';
        btnSave.style.backgroundColor = '#4caf50'; // Green

    } else {
        // --- CONFIRM SAVE ---
        const name = input.value.trim();

        if (!name) {
            // Show inline error or just shake?
            input.style.borderColor = '#f44336';
            input.focus();
            setTimeout(() => { input.style.borderColor = '#444'; }, 1000);
            return;
        }

        const list = document.getElementById('filter-conditions-list');
        const rows = list.querySelectorAll('.filter-condition-row');
        const conditions = [];

        rows.forEach(row => {
            conditions.push({
                column: row.querySelector('.cond-column').value,
                operator: row.querySelector('.cond-operator').value,
                value: row.querySelector('.cond-value').value
            });
        });

        // Save to server
        await savePresetToServer(name, conditions);

        // Restore UI
        updatePresetSelect();

        // Select new name
        setTimeout(() => {
            const select = document.getElementById('filter-preset-select');
            if (select) select.value = name;
        }, 50);

        select.style.display = 'inline-block';
        input.style.display = 'none';

        btnSave.innerHTML = '💾 Lưu';
        btnSave.style.backgroundColor = ''; // Restore default
    }
}

function loadFilterPreset() {
    const name = document.getElementById('filter-preset-select').value;
    if (!name || !FilterTabState.presets[name]) return;

    const conditions = FilterTabState.presets[name];

    // Clear current
    document.getElementById('filter-conditions-list').innerHTML = '';

    // Add saved conditions
    conditions.forEach(cond => {
        addFilterCondition(cond);
    });
}

async function deleteFilterPreset() {
    const select = document.getElementById('filter-preset-select');
    const name = select.value;

    if (!name) {
        alert('Vui lòng chọn bộ lọc để xóa');
        return;
    }

    if (confirm(`Bạn có chắc muốn xóa bộ lọc "${name}" không?`)) {
        await deletePresetFromServer(name);
        updatePresetSelect();
        document.getElementById('filter-conditions-list').innerHTML = ''; // Clear inputs check
    }
}

async function renameFilterPreset() {
    const btnRename = document.getElementById('btn-rename-preset');
    const select = document.getElementById('filter-preset-select');
    let input = document.getElementById('rename-preset-input');

    // Check if we are in renaming mode
    const isRenaming = input && input.style.display !== 'none';

    if (!isRenaming) {
        // --- ENTER RENAME MODE ---
        const oldName = select.value;
        if (!oldName) {
            alert('Vui lòng chọn bộ lọc để đổi tên');
            return;
        }

        // Create input if it doesn't exist
        if (!input) {
            input = document.createElement('input');
            input.type = 'text';
            input.id = 'rename-preset-input';
            input.className = 'form-control'; // Reuse existing class if available
            // Inline styles for matching theme
            input.style.padding = '8px 12px';
            input.style.border = '1px solid #444';
            input.style.borderRadius = '4px';
            input.style.backgroundColor = '#1e1e2d';
            input.style.color = '#fff';
            input.style.width = '250px';
            input.style.marginRight = '10px';

            // Insert after select
            select.parentNode.insertBefore(input, select.nextSibling);
        }

        input.value = oldName;

        // Toggle visibility
        select.style.display = 'none';
        input.style.display = 'inline-block';
        input.focus();

        // Update Button to Confirm state
        btnRename.innerHTML = '✅ OK';
        btnRename.style.backgroundColor = '#4caf50'; // Green

    } else {
        // --- CONFIRM RENAME ---
        const oldName = select.value;
        const newName = input.value.trim();

        if (!newName) {
            alert('Tên không được để trống');
            return;
        }

        let success = true;

        if (newName !== oldName) {
            if (FilterTabState.presets[newName]) {
                if (!confirm(`Bộ lọc "${newName}" đã tồn tại. Bạn có muốn ghi đè không?`)) {
                    success = false;
                }
            }

            if (success) {
                // Perform Rename via server: save with new name, then delete old
                const conditions = FilterTabState.presets[oldName];
                await savePresetToServer(newName, conditions);
                if (newName !== oldName) {
                    await deletePresetFromServer(oldName);
                }
            }
        }

        if (success) {
            // Restore UI
            updatePresetSelect();

            // Select new name
            setTimeout(() => {
                const select = document.getElementById('filter-preset-select');
                if (select) select.value = newName;
            }, 50);

            select.style.display = 'inline-block';
            input.style.display = 'none';

            btnRename.innerHTML = '✏️ Sửa tên';
            btnRename.style.backgroundColor = ''; // Restore default (CSS handles it via class)
            // Or force restore if inline style was set?
            // Original has inline style: style="background-color: #ff9800; color: white;" in HTML
            btnRename.style.backgroundColor = '#ff9800';
        }
    }
}

function updatePresetSelect() {
    const select = document.getElementById('filter-preset-select');
    if (!select) return;

    select.innerHTML = '<option value="">-- Chọn bộ lọc đã lưu --</option>';
    Object.keys(FilterTabState.presets).forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
}

/**
 * Capture investor flow table and download as image
 */
window.captureInvestorFlow = function (containerId, typeName) {
    const element = document.getElementById(containerId);
    if (!element) {
        console.error(`Element not found: ${containerId}`);
        return;
    }

    // Find the button inside the active panel's tabs to update text
    let btn = null;
    const activePanel = element.closest('.investor-sub-panel');
    if (activePanel) {
        btn = activePanel.querySelector('.export-img-btn');
    }

    const originalText = btn ? btn.innerText : '📷 Xuất ảnh';
    if (btn) btn.innerText = '⏳ Đang xử lý...';

    // Optimize for capture
    const originalOverflow = element.style.overflow;
    const originalMaxHeight = element.style.maxHeight;
    element.style.overflow = 'visible'; // Ensure all content is visible for capture
    element.style.maxHeight = 'none';

    html2canvas(element, {
        backgroundColor: '#0F172A', // Match theme background
        scale: 2, // High resolution
        useCORS: true,
        logging: false,
        onclone: (clonedDoc) => {
            // Additional styling adjustments for the clone if needed
            const clonedEl = clonedDoc.getElementById(containerId);
            if (clonedEl) {
                clonedEl.style.maxHeight = 'none';
                clonedEl.style.overflow = 'visible';
                clonedEl.style.padding = '10px'; // Add some padding around
            }
        }
    }).then(canvas => {
        // Restore original style
        element.style.overflow = originalOverflow;
        element.style.maxHeight = originalMaxHeight;

        // Create download link
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
        link.download = `DongTien_${typeName}_${timestamp}.png`;
        link.href = canvas.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        if (btn) btn.innerText = '✅ Đã lưu ảnh';
        setTimeout(() => { if (btn) btn.innerText = originalText; }, 3000);

        console.log(`✅ Captured ${typeName} flow image`);
    }).catch(err => {
        console.error('Capture failed:', err);
        if (btn) btn.innerText = '❌ Lỗi';
        // Restore original style in case of error
        element.style.overflow = originalOverflow;
        element.style.maxHeight = originalMaxHeight;
        setTimeout(() => { if (btn) btn.innerText = originalText; }, 2000);
    });
};

/**
 * Initialize Potential Stocks Tab
 */
function initPotentialStocksTab() {
    const btnScan = document.getElementById('btn-scan-potential');
    if (btnScan) {
        btnScan.addEventListener('click', async () => {
            if (AppState.isLoading) return;
            
            console.log('⚡ Starting manual potential stocks scan...');
            
            // Set loading state on button
            btnScan.disabled = true;
            btnScan.innerHTML = '🔄 Đang quét...';
            btnScan.style.opacity = '0.7';

            // Hiện skeleton cho 4 bảng tín hiệu trong lúc quét
            if (window.UIState) {
                ['potential-uptrend-tbody', 'potential-sideways-tbody', 'macd-signals-tbody', 'rsi-signals-tbody'].forEach(id => {
                    const tb = document.getElementById(id);
                    const wrap = tb ? tb.closest('.breakout-table-wrapper') : null;
                    if (wrap) window.UIState.showSkeleton(wrap, 'table', 6);
                });
            }

            try {
                const result = await StockAPI.dataFetcher.triggerPotentialScan();
                if (result && result.success) {
                    console.log('✅ Scan completed successfully!');
                    // Save to State
                    AppState.data.potentialStocks = result;
                    // Update UI
                    updatePotentialStocksUI(result);
                } else {
                    alert('Lỗi khi quét cổ phiếu tiềm năng: ' + (result?.error || 'Không rõ nguyên nhân'));
                }
            } catch (err) {
                console.error('Manual scan failed:', err);
                alert('Không thể kết nối với server để quét: ' + err.message);
            } finally {
                btnScan.disabled = false;
                btnScan.innerHTML = '⚡ Quét Tín Hiệu Mới';
                btnScan.style.opacity = '1';
            }
        });
    }
}

/**
 * Update the Potential Stocks Tab UI
 */
function updatePotentialStocksUI(result) {
    if (!result || !result.signals) return;

    const signals = result.signals;
    
    // 1. Separate into Uptrend vs Sideways/Other
    const uptrendSignals = signals.filter(s => s.rsTrend === 'uptrend');
    const sidewaysSignals = signals.filter(s => s.rsTrend !== 'uptrend');

    // 2. Update summary cards
    const uptrendCountEl = document.getElementById('potential-uptrend-count');
    const sidewaysCountEl = document.getElementById('potential-sideways-count');
    const totalCountEl = document.getElementById('potential-total-count');
    const lastUpdateEl = document.getElementById('potential-last-update');

    if (uptrendCountEl) uptrendCountEl.textContent = uptrendSignals.length;
    if (sidewaysCountEl) sidewaysCountEl.textContent = sidewaysSignals.length;
    if (totalCountEl) totalCountEl.textContent = signals.length;
    
    if (lastUpdateEl && result.timestamp) {
        const date = new Date(result.timestamp);
        const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
        lastUpdateEl.textContent = `Cập nhật: ${timeStr}`;
    }

    // 3. Render Uptrend Table
    renderPotentialTable('potential-uptrend-tbody', uptrendSignals);

    // 4. Render Sideways Table
    renderPotentialTable('potential-sideways-tbody', sidewaysSignals);

    // 5. Render MACD & RSI Signals Tables (Separated)
    const macdSignals = (result.macdRsiSignals || []).filter(s => s.indicator === 'MACD' || s.indicator === 'BOTH');
    const rsiSignals = (result.macdRsiSignals || []).filter(s => s.indicator === 'RSI' || s.indicator === 'BOTH');

    renderMACDRSITable('macd-signals-tbody', macdSignals);
    renderMACDRSITable('rsi-signals-tbody', rsiSignals);
}

/**
 * Helper to render potential stocks table rows
 */
function renderPotentialTable(tbodyId, list) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    // Gỡ skeleton (nếu có) để hiển thị lại bảng thật
    const wrap = tbody.closest('.breakout-table-wrapper');
    if (window.UIState && wrap) window.UIState.showContent(wrap);

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 30px;">Không có cổ phiếu nào đạt tiêu chí</td></tr>`;
        return;
    }

    let html = '';
    list.forEach(s => {
        const changeClass = s.change >= 0 ? 'positive' : 'negative';
        const changePrefix = s.change >= 0 ? '+' : '';
        const volStr = StockAPI.formatVolume(s.volume);
        
        // Highlight close to MA20 (distMA20 < 4%) as safe buy zone
        const isSafeZone = s.distMA20 < 4.0;
        const distColor = isSafeZone ? 'color: #4caf50; font-weight: 600;' : '';
        const distSuffix = isSafeZone ? ' 🔥' : '';
        
        // Highlight high volume ratio (> 1.5x)
        const isHighVol = s.volumeRatio >= 1.5;
        const volRatioClass = isHighVol ? 'positive' : '';
        const volRatioStyle = isHighVol ? 'font-weight: 600;' : '';
        const volRatioSuffix = isHighVol ? ' ⚡' : '';

        // Formatted prices
        const formatPrice = (p) => {
            if (p === null || p === undefined) return '--';
            const val = p > 1000 ? p / 1000 : p;
            return val.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };

        // Calculate absolute change
        const absChange = s.price - (s.price / (1 + s.change / 100));

        html += `<tr>
            <td class="stock-code"><strong>${s.symbol}</strong></td>
            <td>${formatPrice(s.price)}</td>
            <td class="${changeClass}">${changePrefix}${formatPrice(absChange)}</td>
            <td class="${changeClass}">${changePrefix}${s.change.toFixed(2)}%</td>
            <td style="font-weight: 500;">${s.rs.toFixed(0)}</td>
            <td>${formatPrice(s.ma20)}</td>
            <td style="${distColor}">${s.distMA20.toFixed(2)}%${distSuffix}</td>
            <td>${formatPrice(s.ma50)}</td>
            <td>${volStr}</td>
            <td class="${volRatioClass}" style="${volRatioStyle}">${s.volumeRatio.toFixed(2)}x${volRatioSuffix}</td>
        </tr>`;
    });

    tbody.innerHTML = html;
}

/**
 * Helper to render MACD & RSI signals table rows
 */
function renderMACDRSITable(tbodyId, list) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    // Gỡ skeleton (nếu có) để hiển thị lại bảng thật
    const wrap = tbody.closest('.breakout-table-wrapper');
    if (window.UIState && wrap) window.UIState.showContent(wrap);

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">Không có tín hiệu Mua/Bán mới trong hôm nay</td></tr>`;
        return;
    }

    let html = '';
    list.forEach(s => {
        const changeClass = s.change >= 0 ? 'positive' : 'negative';
        const changePrefix = s.change >= 0 ? '+' : '';
        const volStr = StockAPI.formatVolume(s.volume);
        
        // Signal Badge: Green for BUY, Red for SELL
        const isBuy = s.signalType === 'BUY';
        const badgeStyle = isBuy 
            ? 'background-color: rgba(76, 175, 80, 0.15); color: #4caf50; border: 1px solid rgba(76, 175, 80, 0.3); padding: 4px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; display: inline-block;' 
            : 'background-color: rgba(244, 67, 54, 0.15); color: #f44336; border: 1px solid rgba(244, 67, 54, 0.3); padding: 4px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; display: inline-block;';
        const badgeText = isBuy ? 'MUA (BUY)' : 'BÁN (SELL)';

        // Formatted prices
        const formatPrice = (p) => {
            if (p === null || p === undefined) return '--';
            const val = p > 1000 ? p / 1000 : p;
            return val.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };

        // Calculate absolute change
        const absChange = s.price - (s.price / (1 + s.change / 100));

        html += `<tr>
            <td class="stock-code"><strong>${s.symbol}</strong></td>
            <td>${formatPrice(s.price)}</td>
            <td class="${changeClass}">${changePrefix}${formatPrice(absChange)}</td>
            <td class="${changeClass}">${changePrefix}${s.change.toFixed(2)}%</td>
            <td><span style="${badgeStyle}">${badgeText}</span></td>
            <td style="text-align: left; padding-left: 15px; color: var(--text-main);">${s.description}</td>
            <td>${volStr}</td>
        </tr>`;
    });

    tbody.innerHTML = html;
}
