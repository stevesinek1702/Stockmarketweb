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
        // FIX Bug #1: Trước đây chỉ refresh khi currentTab === 'dashboard' → khi user
        // đang ở tab price-board / filter / potential / industry, data hiển thị cũ
        // vô thời hạn. Giờ loadAllData() chạy cho mọi tab (AppState.data nền tảng),
        // còn các loader phụ chỉ kích theo tab hiện tại để tránh gọi API thừa.
        if (AppState.isLoading) return;
        const tab = AppState.currentTab;
        loadAllData();
        if (tab === 'dashboard') {
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
        } else if (tab === 'price-board') {
            // Bảng giá 3 sàn phải re-fetch trong phiên, không chỉ lazy-load 1 lần đầu
            loadAllStocksFor3Exchanges();
        }
        // Tab 'filter': runStockFilter() sẽ tự re-run qua hook trong loadAllData()
        // (xem FIX Bug #2 ở cuối loadAllData).
    }, 60000);

    // Initialize Drag-and-Drop for dashboard cards
    if (window.DnD) {
        window.DnD.refresh();
    }

    // Bind nút "↻ Cập Nhật" thủ công trên các card dashboard (bypass cache server).
    // Mỗi nút → loader(force=true) cho đúng card. Auto-refresh 60s vẫn chạy song song.
    bindCardRefresh('refresh-vnindex-stat',   () => loadMarketDashboard(true));
    bindCardRefresh('refresh-vn30-stat',      () => loadMarketDashboard(true));   // cùng endpoint, refresh cả 2
    bindCardRefresh('refresh-industry',       () => loadDashboardCharts({ force: { industry: true } }));
    bindCardRefresh('refresh-marketcap',      () => loadDashboardCharts({ force: { marketcap: true } }));
    bindCardRefresh('refresh-vnindex-demand', () => loadDashboardCharts({ force: { vnindex: true } }));
    bindCardRefresh('refresh-vn30-demand',    () => loadDashboardCharts({ force: { vn30: true } }));
    bindCardRefresh('refresh-influential',    () => loadInfluentialStocks(true));

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
 *
 * FIX: Trước đây có 2 declaration trùng tên (dòng ~194 rút gọn + dòng ~4274 đầy đủ
 * với lazy-load price-board/news/AI/breadth). Trong strict mode JS throw SyntaxError
 * "Identifier 'switchTab' has already been declared". Đã gộp — giữ bản đầy đủ duy nhất
 * (định nghĩa sau trong file).
 */

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

        // FIX Bug #2: Sau khi data nền (all-stocks) được refresh, nếu user đang ở
        // Stock Filter Tab và đã từng chạy filter → tự re-run để kết quả không bị
        // stale (trước đây FilterTabState.results cũ hiển thị đến khi user bấm lại).
        // hasRun phân biệt "chưa chạy" vs "đã chạy ra 0 kết quả" → cả 2 case đều re-run.
        if (AppState.currentTab === 'filter' &&
            typeof FilterTabState.hasRun !== 'undefined' && FilterTabState.hasRun &&
            _filterHasConditions()) {
            // Chờ 1 tick để loadAllStocksFor3Exchanges() kịp populate allStocks
            setTimeout(() => { runStockFilter(); }, 0);
        }

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
        const result = await StockCache.swrDaily('top-net-stocks', async () => {
            const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/top-net-stocks`);
            return await response.json();
        });

        if (result && result.success && result.data) {
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
async function loadMarketDashboard(force) {
    try {
        console.log('📊 Loading market dashboard...');
        const qs = force ? '?refresh=1' : '';
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/market-dashboard${qs}`);
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
async function loadInfluentialStocks(force) {
    // Panel chứa 2 bảng Mã Tác Động (target container, không phải tbody)
    const panel = document.querySelector('#panel-influential .influential-stocks-grid');

    // Chỉ hiện skeleton ở lần tải đầu (chưa có dữ liệu tốt) để không phá dữ liệu cũ khi auto-refresh
    if (window.UIState && panel && !window._influentialLoaded) {
        window.UIState.showSkeleton(panel, 'table', 6);
    }

    try {
        console.log('📊 Loading influential stocks...');
        const qs = force ? '?refresh=1' : '';
        const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/influential-stocks${qs}`);
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
                <td class="${stock.demandStrength == null ? 'text-muted' : (stock.demandStrength > 50 ? 'text-green' : (stock.demandStrength < 50 ? 'text-red' : 'text-yellow'))}">${stock.demandStrength == null ? '—' : stock.demandStrength + '%'}</td>
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
    const cacheKey = 'industry-flow:' + timeRange;
    const hasCache = window.StockCache && StockCache.hasDaily(cacheKey);
    // Chỉ hiện spinner lần đầu (chưa có cache hôm nay)
    try {
        if (rangeEl && !hasCache) rangeEl.textContent = 'Đang tải dữ liệu...';

        const data = await StockCache.swrDaily(
            cacheKey,
            () => StockAPI.dataFetcher.fetchIndustryFlow(timeRange)
        );

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
    // spanGaps:true → nối line qua các điểm null (đầu series khi chưa đủ data MA,
    // và các ngày không giao dịch như T7/CN) → đường không bị cắt đứt đoạn.
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
            spanGaps: true,
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
            spanGaps: true,
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
                if (opts.showForce && dataset.forceValues?.[idx] != null) {
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
            StockCache.swrDaily('investor-detail', () => fetch(`${window.StockAPI.SERVER_BASE}/api/investor-detail`).then(r => r.json())).catch(() => null),
            StockCache.swrDaily('investor-flow', () => fetch(`${window.StockAPI.SERVER_BASE}/api/investor-flow`).then(r => r.json())).catch(() => null)
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
 * Load "Danh Mục Mua Bán Ròng Khớp Lệnh" — fetch /api/investor-detail?range=
 * Render bảng 16 cột (4 nhóm × 4 cột: Mã Mua|Giá Mua|Mã Bán|Giá Bán).
 * Tiêu đề động: rút fromDate/toDate từ data.
 * Range: today | oneWeek | oneMonth | yearToDate.
 */
async function loadInvestorTop(range) {
    range = range || AppState.investorTopRange || 'today';
    AppState.investorTopRange = range;

    // Highlight range button
    document.querySelectorAll('#investor-top-range .top-net-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.range === range);
    });

    const thead = document.getElementById('investor-top-thead');
    const tbody = document.getElementById('investor-top-tbody');
    const titleEl = document.getElementById('investor-top-title');
    if (!thead || !tbody) return;

    const GROUPS = [
        { key: 'foreign',     name: 'Nước ngoài' },
        { key: 'proprietary', name: 'Tự doanh' },
        { key: 'institution', name: 'Tổ chức' },
        { key: 'individual',  name: 'Cá nhân' }
    ];

    try {
        const res = await StockCache.swrDaily('investor-detail:' + range, () =>
            fetch(`${window.StockAPI.SERVER_BASE}/api/investor-detail?range=${range}`).then(r => r.json())
        );
        if (!res || !res.success || !Array.isArray(res.groups) || res.groups.length === 0) {
            tbody.innerHTML = '<tr><td colspan="17" style="text-align:center;color:var(--text-muted);padding:20px;">Không tải được dữ liệu</td></tr>';
            return;
        }
        const byKey = {};
        res.groups.forEach(g => { byKey[g.key] = g; });

        // Tiêu đề động: rút fromDate/toDate từ data
        const fmtDate = (iso) => {
            if (!iso) return '';
            const d = new Date(iso);
            return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        };
        const rangeLabels = { today: '1 Ngày', oneWeek: '1 Tuần', oneMonth: '1 Tháng', yearToDate: 'Từ Đầu Năm (YTD)' };
        if (titleEl) {
            let dateStr = '';
            if (res.fromDate && res.toDate) {
                dateStr = (res.fromDate === res.toDate)
                    ? fmtDate(res.toDate)
                    : `${fmtDate(res.fromDate)} → ${fmtDate(res.toDate)}`;
            }
            // Chỉ hiện range + date (tiêu đề đã ở h3, không lặp lại)
            titleEl.textContent = ` · ${rangeLabels[range] || range} · ${dateStr}`;
        }

        const fmt = (v) => (typeof v === 'number' && isFinite(v)) ? v.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) : '--';

        // ── HEADER 2 hàng ──
        // Border dày (ig-group-border) ở cột cuối mỗi nhóm → phân tách 4 nhóm rõ ràng.
        // Border dashed (ig-split-border) giữa khối Mua & Bán trong cùng nhóm.
        let h1 = '<th rowspan="2" class="ig-rank">#</th>';
        GROUPS.forEach(g => { h1 += `<th colspan="4" class="ig-group-header ig-group-border">${g.name}</th>`; });
        let h2 = '';
        GROUPS.forEach(g => {
            h2 += '<th class="ig-sub-header ig-sub-buy">Mã</th><th class="ig-sub-header ig-sub-buy ig-split-border">Giá</th>'
                + '<th class="ig-sub-header ig-sub-sell">Mã</th><th class="ig-sub-header ig-sub-sell ig-group-border">Giá</th>';
        });
        thead.innerHTML = `<tr class="ig-group-header">${h1}</tr><tr class="ig-sub-header">${h2}</tr>`;

        // ── BODY ──
        const MAX_ROWS = 10;
        let html = '';
        // extraCls: class border thêm vào ô (ig-split-border giữa Mua/Bán, ig-group-border giữa các nhóm)
        const tickerCell = (s, extraCls = '') => s
            ? `<td class="${extraCls}"><span class="ig-tk" onclick="openTradingViewModal('${s.ticker}')" title="${s.ticker}">${s.ticker}</span></td>`
            : `<td class="${extraCls}"><span style="color:var(--text-muted)">—</span></td>`;
        const valCell = (s, isBuy, extraCls = '') => {
            if (!s) return '<td class="ig-val-' + (isBuy?'pos':'neg') + ' ' + extraCls + '">—</td>';
            const sign = isBuy ? '+' : '';
            return `<td class="ig-val-${isBuy?'pos':'neg'} ${extraCls}">${sign}${fmt(s.net)}</td>`;
        };

        // ── Hàng tổng SUM (Ròng cho mỗi nhóm, theo range đang chọn) ──
        // range param → field name trong response (API trả tất cả range, chọn đúng field)
        const rangeFieldMap = { today: 'today', oneWeek: 'oneWeek', oneMonth: 'oneMonth', yearToDate: 'yearToDate' };
        const sumField = rangeFieldMap[range] || 'today';
        html += '<tr class="ig-sum-row"><td class="ig-rank" style="font-weight:700;color:var(--text-primary);">Σ</td>';
        GROUPS.forEach(g => {
            const t = byKey[g.key] && byKey[g.key][sumField];
            if (!t) {
                html += '<td colspan="4" class="ig-group-border" style="text-align:center;color:var(--text-muted);">—</td>';
                return;
            }
            const netCls = (typeof t.net === 'number' && isFinite(t.net)) ? (t.net >= 0 ? 'ig-val-pos' : 'ig-val-neg') : '';
            const netSign = (typeof t.net === 'number' && isFinite(t.net) && t.net >= 0) ? '+' : '';
            // Chỉ hiển thị Ròng (bỏ Mua/Bán theo yêu cầu user)
            html += `<td colspan="4" class="ig-group-border ${netCls}" style="text-align:center;font-weight:700;font-size:0.92rem;font-variant-numeric:tabular-nums;">${netSign}${fmt(t.net)}</td>`;
        });
        html += '</tr>';

        for (let i = 0; i < MAX_ROWS; i++) {
            html += '<tr><td class="ig-rank">' + (i+1) + '</td>';
            GROUPS.forEach(g => {
                const buy = byKey[g.key] && Array.isArray(byKey[g.key].topBuy) ? byKey[g.key].topBuy : [];
                const sell = byKey[g.key] && Array.isArray(byKey[g.key].topSell) ? byKey[g.key].topSell : [];
                // MãMua | GiáMua(split) | MãBán | GiáBán(group-end)
                html += tickerCell(buy[i]) + valCell(buy[i], true, 'ig-split-border');
                html += tickerCell(sell[i]) + valCell(sell[i], false, 'ig-group-border');
            });
            html += '</tr>';
        }

        tbody.innerHTML = html;
        console.log(`✅ Investor top (16 cột, range=${range}) updated`);
    } catch (error) {
        console.error('Failed to load investor top:', error);
        tbody.innerHTML = '<tr><td colspan="17" style="text-align:center;color:var(--text-muted);padding:20px;">Lỗi kết nối</td></tr>';
    }
}

// Backwards-compat
function renderInvestorTop(_groupKey) { loadInvestorTop(); }

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
            if (statusEl) statusEl.textContent = `Không có dữ liệu cho ${symbol} (${freq}).`;
            // Clear data cũ + render rỗng (tránh hiển thị data của freq trước khi không có data mới)
            window._stockFlowPoints = [];
            if (window._stockFlowView === 'table') {
                renderStockInvestorFlowTable([]);
            } else if (window.StockCharts) {
                window.StockCharts.renderStockInvestorFlowChart('stock-investor-flow-chart', []);
            }
            return;
        }
        // Lưu points để render lại table khi toggle view (không cần fetch lại)
        window._stockFlowPoints = res.points;
        if (window._stockFlowView === 'table') {
            renderStockInvestorFlowTable(res.points);
        } else if (window.StockCharts) {
            window.StockCharts.renderStockInvestorFlowChart('stock-investor-flow-chart', res.points);
        }
        if (statusEl) statusEl.textContent = `${symbol} · ${freq} · ${res.points.length} phiên · GT khớp ròng (tỷ) — Tổ chức = -(Cá nhân + Tự doanh + Nước ngoài)`;
    } catch (e) {
        console.error('loadStockInvestorFlow error:', e);
        if (statusEl) statusEl.textContent = 'Lỗi tải dữ liệu.';
    }
}

/**
 * Render bảng dòng tiền thông minh theo mã (data points từ Fiintrade).
 * Mỗi point: {date, close, percentChange, caNhan, toChuc, tuDoanh, nuocNgoai}
 * Hiển thị mới nhất trước (đảo ngược), values làm tròn 1 số lẻ, màu theo dấu.
 */
function renderStockInvestorFlowTable(points) {
    const wrap = document.getElementById('stock-flow-table-wrap');
    if (!wrap || !Array.isArray(points) || points.length === 0) {
        if (wrap) wrap.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">Không có dữ liệu</p>';
        return;
    }
    const fmt = (v) => {
        const n = Number(v) || 0;
        const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : '');
        return `<span class="${cls}">${n > 0 ? '+' : ''}${n.toFixed(1)}</span>`;
    };
    // Đảo ngược: ngày mới nhất trên cùng
    const rows = [...points].reverse().map(p => {
        const date = (p.date || '').slice(0, 10);
        const close = Number(p.close) || 0;
        const pct = Number(p.percentChange) || 0;
        const pctCls = pct > 0 ? 'pos' : (pct < 0 ? 'neg' : '');
        return `<tr>
            <td>${date}</td>
            <td>${close.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}</td>
            <td class="${pctCls}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</td>
            <td>${fmt(p.caNhan)}</td>
            <td>${fmt(p.toChuc)}</td>
            <td>${fmt(p.tuDoanh)}</td>
            <td>${fmt(p.nuocNgoai)}</td>
        </tr>`;
    }).join('');
    wrap.innerHTML = `
        <table class="data-table stock-flow-table" style="width:100%;border-collapse:collapse;font-size:0.78rem;">
            <thead><tr>
                <th>Ngày</th>
                <th>Giá đóng</th>
                <th>%</th>
                <th>Cá nhân</th>
                <th>Tổ chức</th>
                <th>Tự doanh</th>
                <th>Nước ngoài</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

/**
 * Toggle giữa Chart view và Table view cho Dòng tiền thông minh theo mã.
 */
function toggleStockFlowView(view) {
    window._stockFlowView = view;
    const chartWrap = document.getElementById('stock-flow-chart-wrap');
    const tableWrap = document.getElementById('stock-flow-table-wrap');
    if (!chartWrap || !tableWrap) return;
    if (view === 'table') {
        chartWrap.style.display = 'none';
        tableWrap.style.display = 'block';
        if (window._stockFlowPoints) renderStockInvestorFlowTable(window._stockFlowPoints);
    } else {
        tableWrap.style.display = 'none';
        chartWrap.style.display = '';
        if (window._stockFlowPoints && window.StockCharts) {
            window.StockCharts.renderStockInvestorFlowChart('stock-investor-flow-chart', window._stockFlowPoints);
        }
    }
}

function setupStockInvestorFlowControls() {
    const input = document.getElementById('stock-flow-symbol');
    const btn = document.getElementById('stock-flow-search-btn');
    const freqWrap = document.getElementById('stock-flow-freq');
    const viewWrap = document.getElementById('stock-flow-view');
    if (btn) btn.addEventListener('click', () => loadStockInvestorFlow(input ? input.value : 'HPG', window._stockFlowFreq));
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadStockInvestorFlow(input.value, window._stockFlowFreq); });
    if (freqWrap) freqWrap.querySelectorAll('.top-net-tab').forEach(b => {
        b.addEventListener('click', () => {
            freqWrap.querySelectorAll('.top-net-tab').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            loadStockInvestorFlow(input ? input.value : 'HPG', b.dataset.freq);
        });
    });
    if (viewWrap) viewWrap.querySelectorAll('.top-net-tab').forEach(b => {
        b.addEventListener('click', () => {
            viewWrap.querySelectorAll('.top-net-tab').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            toggleStockFlowView(b.dataset.view);
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
        const result = await StockCache.swrDaily('foreign-flow', async () => {
            const response = await fetch(`${window.StockAPI.SERVER_BASE}/api/foreign-flow`);
            return await response.json();
        });

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

        // Card Ròng: highlight border theo dấu (xanh nếu mua ròng, đỏ nếu bán ròng)
        const netCard = document.getElementById('ff-net-card');
        if (netCard) {
            netCard.classList.remove('is-positive', 'is-negative');
            if (typeof today.net === 'number' && isFinite(today.net)) {
                netCard.classList.add(today.net >= 0 ? 'is-positive' : 'is-negative');
            }
        }

        // Trend 1/5/20 phiên — render dạng text rows gọn (bỏ chart cột xấu)
        renderForeignTrend(trend);

        window._foreignFlowLoaded = true;
        console.log(`✅ Foreign flow (khối ngoại) updated [${result.source}]: Mua ${today.buy ?? '--'} / Bán ${today.sell ?? '--'} / Ròng ${today.net}`);
    } catch (error) {
        console.error('Failed to load foreign flow:', error);
        if (!window._foreignFlowLoaded) {
            if (buyEl) { buyEl.textContent = '--'; buyEl.className = 'flow-value'; }
            if (sellEl) { buyEl.textContent = '--'; buyEl.className = 'flow-value'; }
            if (netEl) { netEl.textContent = '--'; netEl.className = 'flow-value'; }
        }
    }
}

/**
 * Render trend khối ngoại (1/5/20 phiên) dạng text rows gọn.
 * Thay cho chart cột (cột 20 phiên quá lớn làm xấu panel).
 * @param {Array<{label:string, net:number|null}>} trend
 */
function renderForeignTrend(trend) {
    const wrap = document.getElementById('foreign-trend');
    if (!wrap || !Array.isArray(trend)) return;
    const fmt = (v) => (typeof v === 'number' && isFinite(v))
        ? (v >= 0 ? '+' : '') + v.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tỷ'
        : '--';
    const cls = (v) => (typeof v === 'number' && v >= 0) ? 'pos' : 'neg';
    wrap.innerHTML = trend.map(p => `
        <div class="ff-trend-row">
            <span class="ff-trend-label">${p.label}</span>
            <span class="ff-trend-val ${cls(p.net)}">${fmt(p.net)}</span>
        </div>`).join('');
}


/**
 * Load and render all dashboard charts
 */
/**
 * Tải dữ liệu cho 4 biểu đồ dashboard (industry/marketcap/vnindex/vn30).
 * @param {object} [opts] { force?: { industry?, marketcap?, vnindex?, vn30? } }
 *        force.<key>=true → fetch endpoint kèm ?refresh=1 để bypass cache server
 *        (user nhấn nút Cập Nhật trên card tương ứng).
 */
async function loadDashboardCharts(opts) {
    const force = (opts && opts.force) || {};
    const qs = (k) => force[k] ? '?refresh=1' : '';
    console.log('📊 Loading dashboard charts...', force);

    try {
        // industry-stats giờ là intraday (cache 60s) — KHÔNG dùng swrDaily nữa
        // (trước đây swrDaily cache localStorage 1 ngày → kìm data cả phiên).
        const [industryRes, marketCapRes, vnindexRes, vn30Res] = await Promise.all([
            fetch(`${window.StockAPI.SERVER_BASE}/api/industry-stats${qs('industry')}`).then(r => r.json()).catch(() => null),
            fetch(`${window.StockAPI.SERVER_BASE}/api/marketcap-stats${qs('marketcap')}`).then(r => r.json()).catch(() => null),
            fetch(`${window.StockAPI.SERVER_BASE}/api/vnindex-demand${qs('vnindex')}`).then(r => r.json()).catch(() => null),
            fetch(`${window.StockAPI.SERVER_BASE}/api/vn30-demand${qs('vn30')}`).then(r => r.json()).catch(() => null)
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
 * Bind nút "↻ Cập Nhật" trên một card dashboard → gọi loader(force=true) bypass cache server.
 * Toggle .is-loading (spinner) trong khi load. Guard AppState.isLoading tránh đụng auto-refresh.
 * @param {string} btnId  id của nút <button class="btn-card-refresh">
 * @param {function} loader  hàm loader nhận (force) — vd loadDashboardCharts, loadInfluentialStocks
 */
function bindCardRefresh(btnId, loader) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
        if (AppState.isLoading || btn.classList.contains('is-loading')) return;
        btn.classList.add('is-loading');
        try {
            await loader(true);
        } catch (e) {
            console.error(`[refresh ${btnId}] failed:`, e);
        } finally {
            btn.classList.remove('is-loading');
        }
    });
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
        // Nếu savedSel chưa chứa custom theme code nào (CT:xxx) → auto-add tất cả
        // custom themes. Lý do: savedSel được tạo trước khi có custom themes, nên
        // chỉ chứa ICB2 code → filter sẽ loại hết CT:xxx. Auto-add để custom themes
        // luôn hiện lần đầu, sau đó user có thể toggle ẩn trong dropdown.
        const hasCustomTheme = [...selectedSet].some(c => String(c).startsWith('CT:'));
        if (!hasCustomTheme) {
            data.forEach(ind => {
                if (ind.isCustomTheme) selectedSet.add(ind.code);
            });
        }
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
            x: industry.lucCau == null ? 50 : industry.lucCau, // null (không mã đủ ĐK) → 50 để bubble vẫn hiện giữa trục
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
                    <span class="industry-count">${ind.liquidCount != null ? ind.liquidCount + '/' + ind.stockCount : ind.stockCount} CP</span>
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
            x: group.lucCau == null ? 50 : group.lucCau, // null → 50 để bubble vẫn hiện giữa trục
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
/**
 * Toggle popup giải thích cách tính Lực Cầu (nút ⭐ trên dashboard).
 * Đóng khi click ra ngoài popup.
 */
function toggleLucCauInfo() {
    const popup = document.getElementById('lucCau-info-popup');
    if (!popup) return;
    const isOpen = popup.style.display !== 'none';
    popup.style.display = isOpen ? 'none' : 'flex';
    if (!isOpen) {
        // Bind close-on-outside-click lần đầu
        setTimeout(() => {
            document.addEventListener('click', function closeOnOutside(e) {
                if (!e.target.closest('.lucCau-info-card') && !e.target.closest('.lucCau-footnote-link')) {
                    popup.style.display = 'none';
                    document.removeEventListener('click', closeOnOutside);
                }
            });
        }, 0);
    }
}

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
        const forceColor = item.lucCau == null ? 'var(--text-muted)' : (item.lucCau >= 50 ? 'var(--accent-green)' : 'var(--accent-red)');
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
            <td class="force-cell" style="color:${item.lucCau == null ? 'var(--text-muted)' : forceColor}">${item.lucCau == null ? '—' : item.lucCau.toFixed(1) + '%'}</td>
            <td class="ma10-cell" style="color:${ma10Color}">${item.percentAboveMA10.toFixed(1)}%</td>
            <td>${item.liquidCount != null ? item.liquidCount + '/' + item.stockCount : item.stockCount}${item.filteredCount ? ` <span style="color:var(--text-muted);font-size:0.78em;" title="${item.filteredCount} mã GD dưới 100tr bị loại">(-${item.filteredCount})</span>` : ''}</td>
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

    const { industryCode, industryName, totalStocks, totalAboveMA10, stocks, liquidCount, filteredCount } = data;

    if (!stocks || stocks.length === 0) {
        body.innerHTML = `<p>Không có CP đủ thanh khoản (GD ≥ 100 triệu) trong ngành ${industryName}${filteredCount ? ` — ${filteredCount} mã bị loại do GD thấp` : ''}</p>`;
        return;
    }

    // Store data for re-render on sort
    _industryStocksData = { industryCode, industryName, totalStocks, totalAboveMA10, liquidCount, filteredCount, stocks: [...stocks] };
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

    const { industryCode, industryName, totalStocks, totalAboveMA10, liquidCount, filteredCount } = _industryStocksData;
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
            ${typeof liquidCount !== 'undefined' ? `<span class="summary-item" style="color: var(--accent-blue)"><strong>Đủ thanh khoản:</strong> ${liquidCount}${filteredCount ? ` <span style="color:var(--text-muted);font-size:0.85em;">(ẩn ${filteredCount} mã GD&lt;100tr)</span>` : ''}</span>` : ''}
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
        const lucCauColor = stock.lucCau == null ? 'var(--text-muted)' : (stock.lucCau >= 50 ? 'var(--accent-green)' : 'var(--accent-red)');
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
                <td class="force-cell" style="color:${lucCauColor}; font-weight: 600;">${stock.lucCau == null ? '—' : stock.lucCau.toFixed(1) + '%'}</td>
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
        const lucCauColor = stock.lucCau == null ? 'var(--text-muted)' : (stock.lucCau >= 50 ? 'var(--accent-green)' : 'var(--accent-red)');
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
                <td class="force-cell" style="color:${lucCauColor}; font-weight: 600;">${stock.lucCau == null ? '—' : stock.lucCau.toFixed(1) + '%'}</td>
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

// ═══════════════════════════════════════════════════════════════════
// AI MARKET REPORT — Tóm tắt thị trường hôm nay (DeepSeek + Gemini)
// ═══════════════════════════════════════════════════════════════════

const AIReportState = { loading: false };

/**
 * Load AI report từ server. force=true → regenerate (skip cache).
 * @param {boolean} force — true = "Tạo Báo Cáo" (refresh), false = switchTab (dùng cache)
 */
async function loadAIReport(force) {
    const body = document.getElementById('ai-report-body');
    const metaEl = document.getElementById('ai-report-meta');
    const genBtn = document.getElementById('ai-report-generate');
    if (!body) return;

    if (AIReportState.loading) return;
    AIReportState.loading = true;
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = '⏳ Đang phân tích...'; }
    if (metaEl) metaEl.textContent = '';

    // Loading state (chỉ khi force regenerate — LLM mất 10-30s)
    if (force) {
        body.innerHTML = `
            <div style="text-align:center;color:var(--text-muted);padding:60px 20px;">
                <div style="font-size:2.5rem;margin-bottom:16px;">🤖</div>
                <p style="font-size:1rem;">Đang phân tích dữ liệu thị trường...</p>
                <p style="font-size:0.8rem;margin-top:8px;opacity:0.7;">AI cần 10-30 giây để xử lý. Vui lòng chờ.</p>
            </div>`;
    }

    try {
        const url = `${window.StockAPI.SERVER_BASE}/api/ai/market-report${force ? '?refresh=true' : ''}`;
        const resp = await fetch(url, { method: 'POST', credentials: 'same-origin' });
        const data = await resp.json();

        if (!data || !data.success) {
            const errMsg = data?.error || 'Không tạo được báo cáo';
            const isConfigError = errMsg.includes('chưa cấu hình');
            body.innerHTML = `
                <div style="text-align:center;padding:40px 20px;">
                    <div style="font-size:2.5rem;margin-bottom:12px;">${isConfigError ? '🔑' : '⚠️'}</div>
                    <p style="color:var(--accent-red);font-size:0.95rem;margin-bottom:8px;">${errMsg}</p>
                    ${isConfigError ? '<p style="font-size:0.8rem;color:var(--text-muted);">Liên hệ admin để cấu hình API key.</p>' : ''}
                </div>`;
            return;
        }

        // Render markdown → HTML (dùng marked.js)
        const html = window.marked ? marked.parse(data.report) : `<pre>${data.report}</pre>`;
        body.innerHTML = `<div class="ai-report-content">${html}</div>`;

        // Lưu text gốc để nút Copy dùng
        window._aiReportText = data.report;
        // Hiện nút Copy
        const copyBtn = document.getElementById('ai-report-copy');
        if (copyBtn) copyBtn.style.display = '';

        // Meta: provider + generated time
        const providerName = data.provider === 'gemini' ? 'Google Gemini' : (data.provider === 'deepseek' ? 'DeepSeek' : data.provider);
        const genTime = new Date(data.generatedAt).toLocaleString('vi-VN');
        if (metaEl) metaEl.textContent = `⚡ ${providerName} · tạo lúc ${genTime}`;
    } catch (e) {
        console.error('loadAIReport error:', e);
        body.innerHTML = `
            <div style="text-align:center;padding:40px 20px;">
                <div style="font-size:2.5rem;margin-bottom:12px;">⚠️</div>
                <p style="color:var(--accent-red);">Lỗi kết nối: ${e.message}</p>
            </div>`;
    } finally {
        AIReportState.loading = false;
        if (genBtn) { genBtn.disabled = false; genBtn.textContent = '🤖 Tạo Báo Cáo'; }
    }
}

function setupAIReportEvents() {
    const genBtn = document.getElementById('ai-report-generate');
    if (genBtn) {
        genBtn.addEventListener('click', () => loadAIReport(true));  // force=true → regenerate
    }
    const copyBtn = document.getElementById('ai-report-copy');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const report = window._aiReportText || '';
            if (!report) return;
            try {
                await navigator.clipboard.writeText(report);
                copyBtn.textContent = '✅ Đã copy';
                setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
            } catch (e) {
                // Fallback: tạo textarea tạm + select + copy
                const ta = document.createElement('textarea');
                ta.value = report;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); copyBtn.textContent = '✅ Đã copy'; setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000); }
                catch (e2) { alert('Không copy được. Hãy copy thủ công.'); }
                document.body.removeChild(ta);
            }
        });
    }
    const saveBtn = document.getElementById('ai-save-settings');
    if (saveBtn) saveBtn.addEventListener('click', saveAISettings);
    const savePromptBtn = document.getElementById('ai-save-prompt');
    if (savePromptBtn) savePromptBtn.addEventListener('click', saveAIPrompt);
    const resetBtn = document.getElementById('ai-reset-prompt');
    if (resetBtn) resetBtn.addEventListener('click', resetAIPrompt);
}

// ═══════════════════════════════════════════════════════════════════════
// BÁO CÁO TUẦN / THÁNG — cùng cơ chế AI report, chỉ thêm ?period=week|month
// Tái dùng: cùng endpoint /api/ai/market-report, cùng prompt selector phía server.
// ═══════════════════════════════════════════════════════════════════════

const PeriodReportState = { week: { loading: false }, month: { loading: false } };

/**
 * Load báo cáo theo period (week/month). Generic — tránh duplicate loadAIReport 2 lần.
 * @param {'week'|'month'} period
 * @param {boolean} force — true = tạo mới (skip cache), false = dùng cache khi switchTab
 * @param {Object} ids — { body, meta, genBtn, copyBtn, genLabel, loadingText, errorText, placeholderText }
 */
async function loadPeriodReport(period, force, ids) {
    const body = document.getElementById(ids.body);
    const metaEl = document.getElementById(ids.meta);
    const genBtn = document.getElementById(ids.genBtn);
    if (!body) return;

    const st = PeriodReportState[period];
    if (st.loading) return;
    st.loading = true;
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = ids.loadingText; }
    if (metaEl) metaEl.textContent = '';

    if (force) {
        body.innerHTML = `
            <div style="text-align:center;color:var(--text-muted);padding:60px 20px;">
                <div style="font-size:2.5rem;margin-bottom:16px;">🤖</div>
                <p style="font-size:1rem;">${ids.placeholderText}</p>
                <p style="font-size:0.8rem;margin-top:8px;opacity:0.7;">AI cần 10-30 giây để xử lý. Vui lòng chờ.</p>
            </div>`;
    }

    try {
        const q = new URLSearchParams({ period });
        if (force) q.set('refresh', 'true');
        const url = `${window.StockAPI.SERVER_BASE}/api/ai/market-report?${q.toString()}`;
        const resp = await fetch(url, { method: 'POST', credentials: 'same-origin' });
        const data = await resp.json();

        if (!data || !data.success) {
            const errMsg = data?.error || 'Không tạo được báo cáo';
            const isConfigError = errMsg.includes('chưa cấu hình');
            body.innerHTML = `
                <div style="text-align:center;padding:40px 20px;">
                    <div style="font-size:2.5rem;margin-bottom:12px;">${isConfigError ? '🔑' : '⚠️'}</div>
                    <p style="color:var(--accent-red);font-size:0.95rem;margin-bottom:8px;">${errMsg}</p>
                    ${isConfigError ? '<p style="font-size:0.8rem;color:var(--text-muted);">Mở tab "🤖 Báo Cáo AI" → ⚙️ Cấu hình AI để nhập API key.</p>' : ''}
                </div>`;
            return;
        }

        const html = window.marked ? marked.parse(data.report) : `<pre>${data.report}</pre>`;
        body.innerHTML = `<div class="ai-report-content">${html}</div>`;

        st.text = data.report;
        const copyBtn = document.getElementById(ids.copyBtn);
        if (copyBtn) copyBtn.style.display = '';

        const providerName = data.provider === 'gemini' ? 'Google Gemini' : (data.provider === 'deepseek' ? 'DeepSeek' : (data.provider === 'glm' ? 'GLM-5.2' : data.provider));
        const genTime = new Date(data.generatedAt).toLocaleString('vi-VN');
        if (metaEl) metaEl.textContent = `⚡ ${providerName} · tạo lúc ${genTime}`;
    } catch (e) {
        console.error(`loadPeriodReport(${period}) error:`, e);
        body.innerHTML = `
            <div style="text-align:center;padding:40px 20px;">
                <div style="font-size:2.5rem;margin-bottom:12px;">⚠️</div>
                <p style="color:var(--accent-red);">Lỗi kết nối: ${e.message}</p>
            </div>`;
    } finally {
        st.loading = false;
        if (genBtn) { genBtn.disabled = false; genBtn.textContent = ids.genLabel; }
    }
}

function loadWeeklyReport(force) {
    return loadPeriodReport('week', force, {
        body: 'week-report-body', meta: 'week-report-meta',
        genBtn: 'week-report-generate', copyBtn: 'week-report-copy',
        genLabel: '🤖 Tạo Báo Cáo Tuần',
        loadingText: '⏳ Đang tổng kết tuần...',
        placeholderText: 'Đang tổng kết dữ liệu cả tuần...'
    });
}

function loadMonthlyReport(force) {
    return loadPeriodReport('month', force, {
        body: 'month-report-body', meta: 'month-report-meta',
        genBtn: 'month-report-generate', copyBtn: 'month-report-copy',
        genLabel: '🤖 Tạo Báo Cáo Tháng',
        loadingText: '⏳ Đang tổng kết tháng...',
        placeholderText: 'Đang tổng kết dữ liệu cả tháng...'
    });
}

/**
 * Setup nút cho báo cáo tuần/tháng (generate + copy). Dùng chung copy logic.
 */
function setupPeriodReportEvents(period, ids) {
    const genBtn = document.getElementById(ids.genBtn);
    if (genBtn) genBtn.addEventListener('click', () => loadPeriodReport(period, true, ids));
    const copyBtn = document.getElementById(ids.copyBtn);
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const report = PeriodReportState[period]?.text || '';
            if (!report) return;
            try {
                await navigator.clipboard.writeText(report);
                copyBtn.textContent = '✅ Đã copy';
                setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
            } catch (e) {
                const ta = document.createElement('textarea');
                ta.value = report;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); copyBtn.textContent = '✅ Đã copy'; setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000); }
                catch (e2) { alert('Không copy được. Hãy copy thủ công.'); }
                document.body.removeChild(ta);
            }
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 📊 TAB KỸ THUẬT — Ichimoku (Breadth + 1 mã) + Sóng Elliott
// ═══════════════════════════════════════════════════════════════════════

const TechState = {
    periods: [9, 26, 65, 129, 234],   // 5 đường Tenkan mặc định (user có thể edit)
    ichiChart: null,                   // Chart.js instance cho Ichimoku 1 mã
    elliottChart: null                 // Chart.js instance cho Elliott
};

const ICB2_NAMES = {
    '0500': 'Dầu khí', '1300': 'Hóa chất', '1700': 'Tài nguyên cơ bản',
    '2300': 'Xây dựng và VLXD', '2700': 'Sản phẩm & DV công nghiệp',
    '3300': 'Ôtô và linh kiện', '3500': 'Thực phẩm và đồ uống',
    '3700': 'Hàng tiêu dùng', '4500': 'Y tế', '5300': 'Bán lẻ',
    '5500': 'Truyền thông', '5700': 'Du lịch và giải trí', '6500': 'Viễn thông',
    '7500': 'Các dịch vụ hạ tầng', '8300': 'Ngân hàng', '8500': 'Bảo hiểm',
    '8600': 'Bất động sản', '8700': 'Dịch vụ tài chính', '8900': 'Quỹ', '9500': 'Công nghệ'
};

/** Khởi tạo tab Kỹ thuật lần đầu (gọi từ switchTab khi user vào tab). */
function initTechnicalTab() {
    if (window._technicalInit) return;
    window._technicalInit = true;

    // Sub-tab switcher
    document.querySelectorAll('.tech-subtabs .investor-sub-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tech-subtabs .investor-sub-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tech = btn.dataset.tech;
            document.querySelectorAll('#technical .investor-sub-panel').forEach(p => p.classList.remove('active'));
            const panelId = tech === 'ichi-breadth' ? 'tech-ichi-breadth'
                          : tech === 'ichi-stock' ? 'tech-ichi-stock' : 'tech-elliott';
            const panel = document.getElementById(panelId);
            if (panel) panel.classList.add('active');
        });
    });

    // Render input periods động (5 ô số + nút thêm đường)
    renderIchiPeriodInputs();

    // Populate dropdown ngành
    const indSel = document.getElementById('ichi-industry');
    if (indSel) {
        Object.entries(ICB2_NAMES).forEach(([code, name]) => {
            const o = document.createElement('option');
            o.value = code; o.textContent = name;
            indSel.appendChild(o);
        });
    }

    // Scope toggle: industry → hiện dropdown ngành
    const scopeSel = document.getElementById('ichi-scope');
    if (scopeSel) {
        scopeSel.addEventListener('change', () => {
            document.getElementById('ichi-industry-wrap').style.display =
                scopeSel.value === 'industry' ? '' : 'none';
        });
    }

    // Nút load breadth
    const loadBtn = document.getElementById('ichi-breadth-load');
    if (loadBtn) loadBtn.addEventListener('click', loadIchimokuBreadth);

    // Nút add period
    const addBtn = document.getElementById('ichi-add-period');
    if (addBtn) addBtn.addEventListener('click', () => {
        TechState.periods.push(52);
        renderIchiPeriodInputs();
    });

    // Ichimoku 1 mã
    const ichiStockBtn = document.getElementById('ichi-stock-load');
    if (ichiStockBtn) ichiStockBtn.addEventListener('click', loadIchimokuStock);
    const ichiSym = document.getElementById('ichi-symbol');
    if (ichiSym) ichiSym.addEventListener('keydown', e => { if (e.key === 'Enter') loadIchimokuStock(); });

    // Elliott
    const elliottBtn = document.getElementById('elliott-load');
    if (elliottBtn) elliottBtn.addEventListener('click', loadElliott);
    const ellSym = document.getElementById('elliott-symbol');
    if (ellSym) ellSym.addEventListener('keydown', e => { if (e.key === 'Enter') loadElliott(); });
}

/** Render ô nhập periods động (mỗi đường 1 input số, có nút xóa). */
function renderIchiPeriodInputs() {
    const wrap = document.getElementById('ichi-periods-input');
    if (!wrap) return;
    wrap.innerHTML = '';
    TechState.periods.forEach((p, idx) => {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '2'; inp.max = '500';
        inp.value = p;
        inp.style.cssText = 'width:64px;padding:4px 6px;text-align:center;';
        inp.title = `Đường ${idx + 1} (số phiên)`;
        inp.addEventListener('change', () => {
            const v = parseInt(inp.value, 10);
            TechState.periods[idx] = (Number.isInteger(v) && v >= 2 && v <= 500) ? v : p;
            inp.value = TechState.periods[idx];
        });
        const del = document.createElement('button');
        del.textContent = '✕';
        del.title = 'Xóa đường này';
        del.style.cssText = 'padding:4px 6px;font-size:0.7rem;background:var(--accent-red-bg, #3a1a1a);color:var(--accent-red);border:1px solid var(--accent-red);border-radius:4px;cursor:pointer;';
        del.addEventListener('click', () => {
            if (TechState.periods.length <= 1) return; // giữ ít nhất 1
            TechState.periods.splice(idx, 1);
            renderIchiPeriodInputs();
        });
        const cell = document.createElement('span');
        cell.style.cssText = 'display:flex;align-items:center;gap:2px;';
        cell.append(inp, del);
        wrap.appendChild(cell);
    });
}

/** Đọc periods hiện tại từ state (đã sync qua input change). */
function getIchiPeriods() {
    // Loại trùng + sort + đảm bảo hợp lệ
    const set = new Set(TechState.periods.filter(p => Number.isInteger(p) && p >= 2 && p <= 500));
    return set.size ? [...set].sort((a, b) => a - b) : [9];
}

/** Load Ichimoku breadth: số CP trên/dưới từng đường Tenkan. */
async function loadIchimokuBreadth() {
    const result = document.getElementById('ichi-breadth-result');
    const meta = document.getElementById('technical-meta');
    if (!result) return;
    const periods = getIchiPeriods();
    const scope = document.getElementById('ichi-scope')?.value || 'market';
    const industryCode = document.getElementById('ichi-industry')?.value || '';
    result.innerHTML = '<p style="color:var(--text-muted);">⏳ Đang tính breadth trên toàn thị trường...</p>';
    try {
        // withStocks=1 → include danh sách CP trên/dưới (cho click detail)
        const params = new URLSearchParams({ periods: periods.join(','), scope, withStocks: '1' });
        if (scope === 'industry') params.set('industryCode', industryCode);
        const resp = await fetch(`${window.StockAPI.SERVER_BASE}/api/ichimoku-breadth?${params}`, { credentials: 'same-origin' });
        const data = await resp.json();
        if (!data || !data.success) throw new Error(data?.error || 'Lỗi tính breadth');
        renderIchimokuBreadth(data, scope);
        if (meta) meta.textContent = `Cập nhật ${data.meta?.lastDate || ''} · ${data.meta?.symbolCount || 0} mã`;
    } catch (e) {
        console.error('loadIchimokuBreadth error:', e);
        result.innerHTML = `<p style="color:var(--accent-red);">⚠️ ${e.message}</p>`;
    }
}

/** Render bảng breadth: market + (nếu market) bảng ngành. */
function renderIchimokuBreadth(data, scope) {
    const result = document.getElementById('ichi-breadth-result');
    const periods = data.periods;
    const fmt = n => (n != null ? n.toLocaleString('vi-VN') : '—');
    // Click vào ô số → popup danh sách CP trên/dưới đường
    const clickable = (stocks, label) => stocks && stocks.length
        ? `<a href="#" onclick="showIchimokuStocks(${JSON.stringify(stocks).replace(/"/g,'&quot;')},'${label}');return false;" style="color:inherit;text-decoration:underline dotted;cursor:pointer;">`
        : '';
    const clickableEnd = stocks => stocks && stocks.length ? '</a>' : '';

    // Bảng market
    let html = '<h4 style="margin:8px 0;">🌐 Toàn Thị Trường <span style="font-size:0.75rem;color:var(--text-muted);font-weight:normal;">(click số để xem mã CP)</span></h4>';
    html += '<table class="data-table" style="width:100%;border-collapse:collapse;font-size:0.82rem;"><thead><tr style="text-align:left;">';
    html += '<th style="padding:6px 8px;">Đường Tenkan</th>';
    periods.forEach(p => html += `<th style="padding:6px 8px;text-align:center;">T${p}</th>`);
    html += '</tr></thead><tbody>';
    html += '<tr><td style="padding:6px 8px;">Số CP trên đường</td>';
    periods.forEach(p => {
        const s = data.market.byPeriod[p];
        html += `<td style="padding:6px 8px;text-align:center;color:var(--accent-green);">${clickable(s?.aboveStocks,'CP trên T'+p+' (Toàn TT)')}<b>${fmt(s?.above)}</b>${clickableEnd(s?.aboveStocks)}</td>`;
    });
    html += '</tr><tr><td style="padding:6px 8px;">Số CP dưới đường</td>';
    periods.forEach(p => {
        const s = data.market.byPeriod[p];
        html += `<td style="padding:6px 8px;text-align:center;color:var(--accent-red);">${clickable(s?.belowStocks,'CP dưới T'+p+' (Toàn TT)')}<b>${fmt(s?.below)}</b>${clickableEnd(s?.belowStocks)}</td>`;
    });
    html += '</tr><tr style="background:var(--bg-card-hover);"><td style="padding:6px 8px;"><b>% CP trên đường</b></td>';
    periods.forEach(p => {
        const pct = data.market.byPeriod[p]?.pctAbove;
        const color = pct >= 60 ? 'var(--accent-green)' : (pct <= 40 ? 'var(--accent-red)' : 'var(--text-primary)');
        html += `<td style="padding:6px 8px;text-align:center;"><b style="color:${color};">${pct ?? 0}%</b></td>`;
    });
    html += '</tr><tr><td style="padding:6px 8px;color:var(--text-muted);">Số mã đủ data</td>';
    periods.forEach(p => html += `<td style="padding:6px 8px;text-align:center;color:var(--text-muted);">${fmt(data.market.byPeriod[p]?.coverage)}</td>`);
    html += '</tr></tbody></table>';
    html += `<p style="font-size:0.78rem;color:var(--text-muted);margin-top:6px;">Tổng ${data.market.total} mã. ${data.meta?.note || ''}</p>`;

    // Bảng ngành (hiện tất cả, không collapse — theo yêu cầu user)
    const indSource = scope === 'industry' && data.industry
        ? { [data.industryCode]: data.industry }
        : (data.industries || {});
    if (Object.keys(indSource).length) {
        const inds = Object.entries(indSource)
            .map(([code, d]) => ({ code, ...d }))
            .sort((a, b) => (b.byPeriod[periods[0]]?.pctAbove || 0) - (a.byPeriod[periods[0]]?.pctAbove || 0));
        html += '<h4 style="margin:14px 0 6px;">📊 Breadth theo ngành <span style="font-size:0.75rem;color:var(--text-muted);font-weight:normal;">(xếp theo % trên T' + periods[0] + ' — click số xem mã)</span></h4>';
        html += '<table class="data-table" style="width:100%;border-collapse:collapse;font-size:0.8rem;"><thead><tr style="text-align:left;">';
        html += '<th style="padding:5px 8px;">Ngành</th><th style="padding:5px 8px;text-align:center;">Số mã</th>';
        periods.forEach(p => html += `<th style="padding:5px 8px;text-align:center;">T${p} trên/dưới</th>`);
        html += '</tr></thead><tbody>';
        inds.forEach(ind => {
            html += `<tr><td style="padding:5px 8px;">${ind.name}</td><td style="padding:5px 8px;text-align:center;color:var(--text-muted);">${ind.total}</td>`;
            periods.forEach(p => {
                const bp = ind.byPeriod[p] || {};
                const pct = bp.pctAbove ?? 0;
                const color = pct >= 60 ? 'var(--accent-green)' : (pct <= 40 ? 'var(--accent-red)' : 'var(--text-primary)');
                const aboveC = clickable(bp.aboveStocks, ind.name + ' trên T' + p);
                const belowC = clickable(bp.belowStocks, ind.name + ' dưới T' + p);
                html += `<td style="padding:5px 8px;text-align:center;">
                    <span style="color:var(--accent-green);">${aboveC}<b>${bp.above ?? 0}</b>${clickableEnd(bp.aboveStocks)}</span>
                    <span style="color:var(--text-muted);">/</span>
                    <span style="color:var(--accent-red);">${belowC}<b>${bp.below ?? 0}</b>${clickableEnd(bp.belowStocks)}</span>
                    <div style="font-size:0.72rem;color:${color};">${pct}%</div>
                </td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
    }
    result.innerHTML = html;
}

/**
 * Popup danh sách CP trên/dưới đường Tenkan (khi click vào ô số).
 */
function showIchimokuStocks(stocks, label) {
    const existing = document.getElementById('ichi-stocks-modal');
    if (existing) existing.remove();
    const fmt = n => (n != null ? Number(n).toLocaleString('vi-VN') : '—');
    const rows = stocks.slice(0, 50).map(s => `<tr>
        <td style="padding:3px 8px;"><b>${s.symbol}</b></td>
        <td style="padding:3px 8px;text-align:right;">${fmt(s.close)}</td>
        <td style="padding:3px 8px;text-align:right;color:var(--text-muted);">${fmt(s.line)}</td>
    </tr>`).join('');
    const modal = document.createElement('div');
    modal.id = 'ichi-stocks-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `<div style="background:var(--bg-card);border-radius:10px;padding:18px;max-width:480px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <h4 style="margin:0;">📋 ${label} <span style="font-size:0.8rem;color:var(--text-muted);">(${stocks.length} mã${stocks.length>50?', 50 đầu':''})</span></h4>
            <button onclick="this.closest('#ichi-stocks-modal').remove()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-muted);">×</button>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
            <thead><tr style="text-align:left;color:var(--text-muted);font-size:0.75rem;">
                <th style="padding:4px 8px;">Mã</th><th style="padding:4px 8px;text-align:right;">Giá</th><th style="padding:4px 8px;text-align:right;">Tenkan</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
    document.body.appendChild(modal);
}
window.showIchimokuStocks = showIchimokuStocks;

/** Load Ichimoku cho 1 mã: 5 đường + Kumo + nhận định. */
async function loadIchimokuStock() {
    const result = document.getElementById('ichi-stock-result');
    if (!result) return;
    const sym = (document.getElementById('ichi-symbol')?.value || '').toUpperCase().trim();
    if (!sym) { result.innerHTML = '<p style="color:var(--accent-red);">Vui lòng nhập mã cổ phiếu.</p>'; return; }
    result.innerHTML = '<p style="color:var(--text-muted);">⏳ Đang tính Ichimoku (lấy OHLCV thật)...</p>';
    try {
        const resp = await fetch(`${window.StockAPI.SERVER_BASE}/api/ichimoku/${encodeURIComponent(sym)}?tenkan=9&kijun=26&senkouB=52&displacement=26`, { credentials: 'same-origin' });
        const data = await resp.json();
        if (!data || !data.success) throw new Error(data?.error || 'Không tính được Ichimoku');
        renderIchimokuStock(data);
    } catch (e) {
        console.error('loadIchimokuStock error:', e);
        result.innerHTML = `<p style="color:var(--accent-red);">⚠️ ${e.message}</p>`;
    }
}

/** Render Ichimoku 1 mã: bảng giá trị + nhận định + chart. */
function renderIchimokuStock(data) {
    const result = document.getElementById('ichi-stock-result');
    const c = data.current;
    const interp = data.interpretation || {};
    const f2 = n => (n != null ? n.toLocaleString('vi-VN', { maximumFractionDigits: 2 }) : '—');
    const kumoColor = c.kumo?.state === 'green' ? 'var(--accent-green)' : (c.kumo?.state === 'red' ? 'var(--accent-red)' : 'var(--text-muted)');
    const kumoTxt = c.kumo?.state === 'green' ? 'Mây XANH (Bullish)' : (c.kumo?.state === 'red' ? 'Mây ĐỎ (Bearish)' : '—');

    let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px;">`;
    // Trái: bảng giá trị hiện tại
    html += `<div><h4 style="margin:0 0 8px;">${data.symbol} — Giá trị hiện tại (${data.lastDate})</h4>`;
    html += `<table class="data-table" style="width:100%;font-size:0.82rem;border-collapse:collapse;">
        <tr><td style="padding:4px 8px;">Giá đóng cửa</td><td style="padding:4px 8px;text-align:right;"><b>${f2(c.close)}</b></td></tr>
        <tr><td style="padding:4px 8px;">Tenkan-sen (9)</td><td style="padding:4px 8px;text-align:right;">${f2(c.tenkan)}</td></tr>
        <tr><td style="padding:4px 8px;">Kijun-sen (26)</td><td style="padding:4px 8px;text-align:right;">${f2(c.kijun)}</td></tr>
        <tr><td style="padding:4px 8px;">Senkou Span A</td><td style="padding:4px 8px;text-align:right;">${f2(c.spanA)}</td></tr>
        <tr><td style="padding:4px 8px;">Senkou Span B</td><td style="padding:4px 8px;text-align:right;">${f2(c.spanB)}</td></tr>
        <tr><td style="padding:4px 8px;">Chikou Span</td><td style="padding:4px 8px;text-align:right;">${f2(c.chikou)}</td></tr>
        <tr style="background:var(--bg-card-hover);"><td style="padding:4px 8px;">Trạng thái Kumo</td><td style="padding:4px 8px;text-align:right;color:${kumoColor};"><b>${kumoTxt}</b></td></tr>
    </table>`;
    if (c.kumo?.top != null) html += `<p style="font-size:0.78rem;color:var(--text-muted);margin-top:4px;">Mây Kumo: ${f2(c.kumo.bottom)} – ${f2(c.kumo.top)}</p>`;
    html += `</div>`;
    // Phải: nhận định
    html += `<div><h4 style="margin:0 0 8px;">🎯 Nhận định chuyên gia</h4>`;
    html += `<p style="font-size:1.1rem;margin-bottom:8px;"><b>${interp.verdict || ''}</b> <span style="color:var(--text-muted);">(score ${interp.score ?? '—'}/100)</span></p>`;
    if (Array.isArray(interp.signals)) {
        html += '<ul style="margin:4px 0 8px;padding-left:18px;font-size:0.82rem;">';
        interp.signals.forEach(s => html += `<li style="margin-bottom:3px;">${s}</li>`);
        html += '</ul>';
    }
    if (Array.isArray(interp.advice)) {
        html += '<p style="font-weight:600;margin:8px 0 4px;">💡 Gợi ý hành động:</p><ul style="margin:4px 0;padding-left:18px;font-size:0.82rem;">';
        interp.advice.forEach(a => html += `<li style="margin-bottom:3px;">${a}</li>`);
        html += '</ul>';
    }
    html += `</div></div>`;

    // Chart
    html += `<div style="margin-top:8px;"><h4 style="margin:0 0 8px;">📈 Biểu đồ Ichimoku</h4><div style="height:380px;"><canvas id="ichi-stock-chart"></canvas></div></div>`;

    // Education (collapse)
    if (Array.isArray(interp.education) && interp.education.length) {
        html += '<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:0.85rem;">📖 Giải thích chi tiết (học Ichimoku)</summary><ul style="margin-top:6px;padding-left:18px;font-size:0.8rem;">';
        interp.education.forEach(ed => html += `<li style="margin-bottom:4px;">${ed}</li>`);
        html += '</ul></details>';
    }
    result.innerHTML = html;

    // Vẽ chart
    drawIchimokuChart(data);
}

/** Vẽ chart Ichimoku bằng Chart.js (close + tenkan + kijun + Kumo fill). */
function drawIchimokuChart(data) {
    const canvas = document.getElementById('ichi-stock-chart');
    if (!canvas || !window.Chart) return;
    if (TechState.ichiChart) { TechState.ichiChart.destroy(); TechState.ichiChart = null; }
    const s = data.series;
    const n = s.close.length;
    const tail = Math.min(n, 120); // vẽ 120 phiên gần nhất cho gọn
    const labels = s.dates.slice(-tail);
    const close = s.close.slice(-tail);
    const tenkan = s.tenkan.slice(-tail);
    const kijun = s.kijun.slice(-tail);
    const spanA = s.spanA.slice(-tail);
    const spanB = s.spanB.slice(-tail);

    // Kumo fill: giữa spanA và spanB — dùng 2 dataset fill
    const ctx = canvas.getContext('2d');
    TechState.ichiChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Giá', data: close, borderColor: '#4dc9ff', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.1 },
                { label: 'Span A', data: spanA, borderColor: 'rgba(0,200,83,0.7)', backgroundColor: 'rgba(0,200,83,0.12)', fill: '+1', borderWidth: 1, pointRadius: 0, tension: 0.1 },
                { label: 'Span B', data: spanB, borderColor: 'rgba(255,99,132,0.7)', backgroundColor: 'rgba(255,99,132,0.12)', fill: false, borderWidth: 1, pointRadius: 0, tension: 0.1 },
                { label: 'Tenkan(9)', data: tenkan, borderColor: '#ffb74d', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.1 },
                { label: 'Kijun(26)', data: kijun, borderColor: '#ba68c8', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.1 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
            scales: { x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } }, y: { ticks: { font: { size: 10 } } } }
        }
    });
}

/** Load phân tích Elliott Wave. */
async function loadElliott() {
    const result = document.getElementById('elliott-result');
    if (!result) return;
    const sym = (document.getElementById('elliott-symbol')?.value || 'VNINDEX').toUpperCase().trim() || 'VNINDEX';
    result.innerHTML = '<p style="color:var(--text-muted);">⏳ Đang phân tích sóng Elliott...</p>';
    try {
        const resp = await fetch(`${window.StockAPI.SERVER_BASE}/api/elliott/${encodeURIComponent(sym)}`, { credentials: 'same-origin' });
        const data = await resp.json();
        if (!data || !data.success) throw new Error(data?.error || 'Không phân tích được Elliott');
        renderElliott(data);
    } catch (e) {
        console.error('loadElliott error:', e);
        result.innerHTML = `<p style="color:var(--accent-red);">⚠️ ${e.message}</p>`;
    }
}

/** Render kết quả Elliott. */
function renderElliott(data) {
    const result = document.getElementById('elliott-result');
    const f2 = n => (n != null ? n.toLocaleString('vi-VN', { maximumFractionDigits: 2 }) : '—');
    let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px;">`;
    // Trái: tóm tắt
    html += `<div><h4 style="margin:0 0 8px;">🌊 ${data.symbol} — Cấu trúc sóng (${data.lastDate})</h4>`;
    html += `<p style="font-size:0.95rem;margin-bottom:6px;"><b>${data.pattern || '—'}</b></p>`;
    html += `<p style="font-size:0.85rem;margin-bottom:6px;">Vị trí hiện tại: <b>${data.currentWave || '—'}</b></p>`;
    html += `<p style="font-size:0.82rem;color:var(--text-muted);">Giá hiện tại: ${f2(data.lastPrice)} · Xu hướng: <b>${data.trendDir === 'up' ? 'TĂNG' : 'GIẢM'}</b> (${Math.round((data.trendStrength || 0) * 100)}%)</p>`;
    // Fib levels
    if (data.fibLevels) {
        html += '<p style="font-weight:600;margin:10px 0 4px;">📐 Fibonacci Retracement:</p><ul style="margin:0;padding-left:18px;font-size:0.8rem;">';
        Object.entries(data.fibLevels).forEach(([r, lvl]) => html += `<li>${r}: <b>${f2(lvl)}</b></li>`);
        html += '</ul>';
    }
    html += `</div>`;
    // Phải: targets + notes
    html += `<div>`;
    if (Array.isArray(data.projectionTargets) && data.projectionTargets.length) {
        html += '<p style="font-weight:600;margin:0 0 4px;">🎯 Mục tiêu dự phóng (Fib Extension):</p><ul style="margin:0 0 8px;padding-left:18px;font-size:0.8rem;">';
        // Sắp xếp: trên trước
        data.projectionTargets.sort((a, b) => b.price - a.price).forEach(t => {
            const color = t.dir === 'trên' ? 'var(--accent-green)' : 'var(--accent-red)';
            html += `<li>${t.ext}× → <b style="color:${color};">${f2(t.price)}</b> (${t.dir} giá hiện tại)</li>`;
        });
        html += '</ul>';
    }
    if (Array.isArray(data.notes)) {
        html += '<p style="font-weight:600;margin:8px 0 4px;">📝 Phân tích:</p><ul style="margin:0;padding-left:18px;font-size:0.8rem;">';
        data.notes.forEach(n => html += `<li style="margin-bottom:3px;">${n}</li>`);
        html += '</ul>';
    }
    html += `</div></div>`;

    // 🏷️ Block nâng cấp: Nhãn sóng quá khứ + trọng số đo được
    const wl = data.waveLabels;
    const wr = data.waveRatios;
    if (wl && wr) {
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:8px 0 12px;">';
        // Trái: nhãn sóng
        html += '<div><h4 style="margin:0 0 6px;">🏷️ Nhãn sóng quá khứ</h4>';
        if (wl.labels && wl.labels.length) {
            html += `<p style="font-size:0.82rem;margin-bottom:4px;">${wl.pattern} · <span style="color:var(--text-muted);">điểm ${wl.score}/100</span></p>`;
            html += '<p style="font-size:0.8rem;margin-bottom:4px;">Trình tự sóng: ';
            html += wl.labels.map(l => {
                const imp = ['1','3','5'].includes(l.label);
                const corr = ['2','4'].includes(l.label);
                const abc = ['A','B','C'].includes(l.label);
                const color = imp ? 'var(--accent-green)' : (corr ? 'var(--accent-red)' : (abc ? '#ba68c8' : 'var(--text-muted)'));
                return `<b style="color:${color};">${l.label}</b>(${f2(l.price)})`;
            }).join(' → ');
            html += '</p>';
        } else {
            html += `<p style="font-size:0.82rem;color:var(--text-muted);">${wl.pattern || 'Không dán nhãn được (thiếu swings hợp lệ)'}</p>`;
        }
        html += '</div>';
        // Phải: trọng số đo được
        html += '<div><h4 style="margin:0 0 6px;">🔬 Trọng số thực tế (tính cách sóng)</h4>';
        if (wr.sampleCount > 0) {
            html += `<p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:4px;">Đo từ ${wr.sampleCount} chu kỳ quá khứ — so với Fibonacci chuẩn:</p>`;
            html += '<table style="width:100%;font-size:0.78rem;border-collapse:collapse;">';
            const row = (label, actual, std) => `<tr><td style="padding:2px 6px;">${label}</td><td style="padding:2px 6px;text-align:right;"><b>${actual ?? '—'}</b></td><td style="padding:2px 6px;text-align:right;color:var(--text-muted);">${std}</td></tr>`;
            html += `<tr style="background:var(--bg-card-hover);font-weight:600;font-size:0.72rem;"><td style="padding:2px 6px;">Tỷ lệ</td><td style="padding:2px 6px;text-align:right;">Thực tế</td><td style="padding:2px 6px;text-align:right;">Chuẩn</td></tr>`;
            html += row('Sóng 3 / Sóng 1', wr.wave3OverWave1, '1.618×');
            html += row('Sóng 5 / Sóng 1', wr.wave5OverWave1, '0.618×');
            html += row('Sóng 2 hồi (%)', wr.retrace2Pct != null ? wr.retrace2Pct + '%' : null, '50-62%');
            html += row('Sóng 4 hồi (%)', wr.retrace4Pct != null ? wr.retrace4Pct + '%' : null, '23-38%');
            html += row('Sóng C / Sóng A', wr.waveCOverWaveA, '1.0×');
            html += '</table>';
        } else {
            html += `<p style="font-size:0.8rem;color:var(--text-muted);">${wr.note || 'Chưa đủ mẫu — dùng Fibonacci chuẩn.'}</p>`;
        }
        html += '</div></div>';
    }

    // 🔮 Block dự phóng tương lai
    const fp = data.futureProjection;
    if (fp) {
        html += '<div style="margin:0 0 12px;padding:10px;background:var(--bg-card-hover);border-radius:8px;border-left:3px solid #ba68c8;">';
        html += `<h4 style="margin:0 0 6px;">🔮 Dự phóng tương lai</h4>`;
        html += `<p style="font-size:0.82rem;margin-bottom:4px;">Vị trí: <b>${fp.currentWave || '—'}</b></p>`;
        if (fp.note) html += `<p style="font-size:0.76rem;color:var(--text-muted);margin-bottom:6px;">${fp.note}</p>`;
        if (Array.isArray(fp.targets) && fp.targets.length) {
            html += '<p style="font-size:0.8rem;margin:4px 0;">Mục tiêu dự phóng:</p><ul style="margin:0;padding-left:18px;font-size:0.78rem;">';
            fp.targets.forEach(t => {
                const color = t.dir === 'trên' ? 'var(--accent-green)' : 'var(--accent-red)';
                html += `<li>${t.level}: <b style="color:${color};">${f2(t.price)}</b> (${t.dir} giá hiện tại)</li>`;
            });
            html += '</ul>';
        }
        html += '</div>';
    }

    // Disclaimer
    if (data.disclaimer) html += `<p style="font-size:0.78rem;color:var(--text-muted);padding:8px;background:var(--bg-card-hover);border-radius:6px;margin-bottom:8px;">${data.disclaimer}</p>`;
    // Chart
    html += `<div><h4 style="margin:0 0 8px;">📈 Biểu đồ giá + Nhãn sóng + Dự phóng (nét đứt)</h4><div style="height:400px;"><canvas id="elliott-chart"></canvas></div></div>`;
    result.innerHTML = html;
    drawElliottChart(data);
}

/** Vẽ chart Elliott: đường giá + nhãn sóng 1-5/ABC tại pivot + đường dự phóng nét đứt ra tương lai. */
function drawElliottChart(data) {
    const canvas = document.getElementById('elliott-chart');
    if (!canvas || !window.Chart || !Array.isArray(data.series?.close)) return;
    if (TechState.elliottChart) { TechState.elliottChart.destroy(); TechState.elliottChart = null; }
    const s = data.series;
    const n = s.close.length;
    const ctx = canvas.getContext('2d');

    // Mở rộng trục X ra tương lai: thêm các label ảo (→) cho dự phóng
    const futureBars = Math.max(20, Math.ceil(n * 0.15)); // ~15% thêm cho tương lai
    const labels = s.dates.slice();
    for (let i = 1; i <= futureBars; i++) labels.push(`→${i}`);

    // Dán nhãn sóng (1-5, A-C) tại các pivot — tạo dataset point + label text
    const wl = data.waveLabels;
    const labelPoints = []; // {index, price, label}
    if (wl && Array.isArray(wl.labels)) {
        const idxByI = {};
        (data.swings || []).forEach(sw => { idxByI[sw.i] = true; });
        // Map label.i (index trong chuỗi close) → vị trí pivot
        wl.labels.forEach(l => {
            // l.i là index trong chuỗi close gốc; chỉ dùng nếu hợp lệ
            if (l.i >= 0 && l.i < n) {
                labelPoints.push({ index: l.i, price: l.price, label: l.label });
            }
        });
    }
    const waveLabelData = s.close.map((v, i) => {
        const lp = labelPoints.find(p => p.index === i);
        return lp ? lp.price : null;
    });
    const waveLabelText = s.close.map((v, i) => {
        const lp = labelPoints.find(p => p.index === i);
        return lp ? lp.label : '';
    });

    // Đường dự phóng nét đứt ra tương lai: nối điểm cuối giá hiện tại → các target
    // futureSegments: [{fromPrice, toPrice, label, barsAhead}]
    const fp = data.futureProjection;
    const projData = new Array(labels.length).fill(null);
    const projBars = [];
    if (fp && Array.isArray(fp.futureSegments) && fp.futureSegments.length) {
        // Bắt đầu từ giá hiện tại (cuối chuỗi thật)
        projData[n - 1] = data.lastPrice;
        let cursor = n - 1;
        fp.futureSegments.forEach((seg, idx) => {
            // Mỗi đoạn chiếm ~seg.barsAhead / số đoạn bars, but đơn giản: đều nhau
            const stepBars = Math.max(2, Math.floor(futureBars / (fp.futureSegments.length + 1)));
            cursor += stepBars;
            if (cursor < labels.length) projData[cursor] = seg.toPrice;
        });
    } else if (fp && Array.isArray(fp.targets) && fp.targets.length) {
        // Fallback: chỉ vẽ target đầu/cuối trên trục tương lai
        projData[n - 1] = data.lastPrice;
        fp.targets.forEach((t, idx) => {
            const pos = n + Math.floor((idx + 1) * futureBars / (fp.targets.length + 1));
            if (pos < labels.length) projData[pos] = t.price;
        });
    }

    // Swing markers (giữ cũ)
    const swingHighIdx = new Set((data.swings || []).filter(x => x.type === 'high').map(x => x.i));
    const swingLowIdx = new Set((data.swings || []).filter(x => x.type === 'low').map(x => x.i));
    const highMarkers = s.close.map((v, i) => swingHighIdx.has(i) ? v : null).concat(new Array(futureBars).fill(null));
    const lowMarkers = s.close.map((v, i) => swingLowIdx.has(i) ? v : null).concat(new Array(futureBars).fill(null));
    const closeExt = s.close.concat(new Array(futureBars).fill(null));
    const waveLabelExt = waveLabelData.concat(new Array(futureBars).fill(null));
    const waveLabelTextExt = waveLabelText.concat(new Array(futureBars).fill(''));

    TechState.elliottChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Giá', data: closeExt, borderColor: '#4dc9ff', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.15 },
                { label: 'Dự phóng (tương lai)', data: projData, borderColor: '#ba68c8', backgroundColor: 'rgba(186,104,200,0.08)', borderWidth: 2, borderDash: [6, 4], pointRadius: 4, pointBackgroundColor: '#ba68c8', tension: 0.2, spanGaps: true },
                { label: 'Nhãn sóng', data: waveLabelExt, borderColor: 'transparent', backgroundColor: '#ffb74d', pointRadius: 5, showLine: false,
                  datalabels: { display: true } },
                { label: 'Swing High', data: highMarkers, borderColor: 'transparent', backgroundColor: '#00c853', pointStyle: 'triangle', pointRadius: 5, showLine: false },
                { label: 'Swing Low', data: lowMarkers, borderColor: 'transparent', backgroundColor: '#ff5252', pointStyle: 'crossRot', pointRadius: 5, showLine: false }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: {
                    callbacks: {
                        // Hiển thị nhãn sóng trong tooltip nếu có
                        afterBody: (items) => {
                            const idx = items[0]?.dataIndex;
                            if (idx == null) return '';
                            const lbl = waveLabelTextExt[idx];
                            return lbl ? `Sóng ${lbl}` : '';
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 8, font: { size: 10 }, autoSkip: true } },
                y: { ticks: { font: { size: 10 } } }
            },
            // Vẽ text nhãn sóng trực tiếp lên chart qua plugin onAnimationProgress không khả thi;
            // thay vào đó dùng callback afterDraw để vẽ label tại điểm.
            animation: { duration: 0 }
        },
        // Custom plugin inline: vẽ text nhãn sóng (1-5, A-C) tại các điểm pivot
        plugins: [{
            id: 'waveLabels',
            afterDatasetsDraw(chart) {
                const ds = chart.data.datasets[2]; // dataset 'Nhãn sóng'
                if (!ds) return;
                const meta = chart.getDatasetMeta(2);
                const ctx2 = chart.ctx;
                ctx2.save();
                ctx2.font = 'bold 11px sans-serif';
                ctx2.fillStyle = '#ffb74d';
                ctx2.textAlign = 'center';
                meta.data.forEach((pt, i) => {
                    const lbl = waveLabelTextExt[i];
                    if (!lbl || pt == null) return;
                    ctx2.fillText(lbl, pt.x, pt.y - 10);
                });
                ctx2.restore();
            }
        }]
    });
}

// ==========================================
// 🎯 AI ĐÁNH GIÁ NGÀNH & CHỌN CP (Spec 2026-07-31)
// ==========================================


const SectorAIState = { loadingSectors: false, loadingPicks: false, sectorData: null };

/**
 * Load bảng xếp hạng 20 ngành theo điểm 9 yếu tố.
 */
async function loadSectorStrength(force) {
    if (SectorAIState.loadingSectors) return;
    const tableEl = document.getElementById('sector-strength-table');
    const metaEl = document.getElementById('sector-ai-meta');
    const btn = document.getElementById('sector-strength-refresh');
    if (!tableEl) return;

    SectorAIState.loadingSectors = true;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang tính...'; }
    if (force) tableEl.innerHTML = '<p style="color:var(--text-muted);">⏳ Đang tính điểm 20 ngành...</p>';

    try {
        const url = `${window.StockAPI.SERVER_BASE}/api/sector-strength${force ? '?refresh=1' : ''}`;
        const resp = await fetch(url, { credentials: 'same-origin' });
        const data = await resp.json();
        if (!data || !data.success) throw new Error(data?.error || 'Lỗi không xác định');

        SectorAIState.sectorData = data;
        renderSectorStrengthTable(data.sectors || []);
        const genTime = new Date(data.generatedAt).toLocaleString('vi-VN');
        if (metaEl) metaEl.textContent = `· ${data.sectors.length} ngành · tính lúc ${genTime}`;
    } catch (e) {
        console.error('loadSectorStrength error:', e);
        tableEl.innerHTML = `<p style="color:var(--accent-red);">⚠️ ${e.message}</p>`;
    } finally {
        SectorAIState.loadingSectors = false;
        if (btn) { btn.disabled = false; btn.textContent = '📊 Tính Điểm Ngành'; }
    }
}

/**
 * Render bảng xếp hạng ngành (sort by score desc).
 */
function renderSectorStrengthTable(sectors) {
    const el = document.getElementById('sector-strength-table');
    if (!el) return;
    if (!sectors.length) { el.innerHTML = '<p style="color:var(--text-muted);">Không có dữ liệu.</p>'; return; }

    const gradeColor = (g) => ({
        'A+': 'var(--accent-green)', 'A': 'var(--accent-green)',
        'B': 'var(--accent-blue)', 'C': 'var(--text-muted)', 'D': 'var(--accent-red)'
    }[g] || 'var(--text-muted)');
    const trendIcon = (t) => ({ up: '▲', down: '▼', flat: '—' }[t] || '—');
    const trendColor = (t) => ({ up: 'var(--accent-green)', down: 'var(--accent-red)', flat: 'var(--text-muted)' }[t] || 'var(--text-muted)');

    const rows = sectors.map(s => {
        const score = Math.round(s.score);
        const bar = `<div style="background:var(--bg-secondary);height:4px;border-radius:2px;width:60px;overflow:hidden;margin-top:2px;">
            <div style="background:${gradeColor(s.grade)};height:100%;width:${score}%;"></div></div>`;
        return `<tr>
            <td style="padding:4px 8px;color:var(--text-muted);">${s.rank || ''}</td>
            <td style="padding:4px 8px;font-weight:600;">${s.name}</td>
            <td style="padding:4px 8px;text-align:center;font-weight:700;color:${gradeColor(s.grade)};">${score}</td>
            <td style="padding:4px 8px;text-align:center;color:${gradeColor(s.grade)};">${s.grade}</td>
            <td style="padding:4px 8px;text-align:center;color:${trendColor(s.trend)};">${trendIcon(s.trend)}</td>
            <td style="padding:4px 8px;">${bar}</td>
        </tr>`;
    }).join('');

    el.innerHTML = `
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="font-size:0.75rem;color:var(--text-muted);text-align:left;">
                <th style="padding:4px 8px;">#</th><th style="padding:4px 8px;">Ngành</th>
                <th style="padding:4px 8px;text-align:center;">Score</th>
                <th style="padding:4px 8px;text-align:center;">Grade</th>
                <th style="padding:4px 8px;text-align:center;">Xu hướng</th>
                <th style="padding:4px 8px;">Điểm</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

/**
 * Chạy AI pick CP từ ngành mạnh + giải thích.
 */
async function runAIPicker() {
    if (SectorAIState.loadingPicks) return;
    const resultsEl = document.getElementById('ai-picker-results');
    const metaEl = document.getElementById('sector-ai-meta');
    const btn = document.getElementById('ai-picker-run');
    if (!resultsEl) return;

    SectorAIState.loadingPicks = true;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ AI đang chọn...'; }
    resultsEl.innerHTML = `
        <div style="text-align:center;color:var(--text-muted);padding:40px 20px;">
            <div style="font-size:2rem;margin-bottom:12px;">🤖</div>
            <p>AI đang phân tích ngành mạnh + chọn CP...</p>
            <p style="font-size:0.75rem;opacity:0.7;margin-top:6px;">Cần 15-40 giây (LLM reasoning).</p>
        </div>`;

    try {
        const url = `${window.StockAPI.SERVER_BASE}/api/ai/stock-picker`;
        const resp = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxPicks: 8, provider: 'auto' })
        });
        const data = await resp.json();
        if (!data || !data.success) throw new Error(data?.error || 'Lỗi AI');

        renderAIPickerResults(data.picks || [], data);
        const providerName = ({ glm: 'GLM-5.2', deepseek: 'DeepSeek', gemini: 'Gemini', fallback: 'Thuật toán' })[data.provider] || data.provider;
        const fallbackNote = data.aiFallback ? ' (AI fail → fallback)' : '';
        const genTime = new Date(data.generatedAt).toLocaleString('vi-VN');
        if (metaEl) metaEl.textContent = `· ${data.picks.length} picks · ${providerName}${fallbackNote} · ${genTime}`;
    } catch (e) {
        console.error('runAIPicker error:', e);
        resultsEl.innerHTML = `<p style="color:var(--accent-red);">⚠️ ${e.message}</p>`;
    } finally {
        SectorAIState.loadingPicks = false;
        if (btn) { btn.disabled = false; btn.textContent = '🤖 Chạy AI Pick'; }
    }
}

/**
 * Render danh sách CP AI chọn kèm entry/stop/lý do.
 */
function renderAIPickerResults(picks, meta) {
    const el = document.getElementById('ai-picker-results');
    if (!el) return;
    if (!picks.length) { el.innerHTML = '<p style="color:var(--text-muted);">AI không chọn được CP nào (thiếu ứng viên hoặc ngành đều yếu).</p>'; return; }

    const fmt = (v) => (v != null && !isNaN(v)) ? Number(v).toLocaleString('vi-VN') : '—';
    const cards = picks.map(p => {
        const sectorTag = p.sectorName ? `<span style="font-size:0.7rem;background:var(--bg-secondary);padding:1px 6px;border-radius:8px;margin-left:6px;">${p.sectorName}</span>` : '';
        const sepaTag = (p.sepaScore != null) ? `<span style="font-size:0.7rem;color:var(--text-muted);">SEPA ${p.sepaScore}</span>` : '';
        const flagTag = (p.flags && p.flags.length) ? `<span style="color:var(--accent-red);font-size:0.7rem;">⚠️ ${p.flags.join(', ')}</span>` : '';
        return `<div style="border:1px solid var(--border-color);border-radius:8px;padding:10px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span style="font-weight:700;font-size:1rem;">#${p.rank || ''} ${p.symbol}</span>
                ${sectorTag}${sepaTag}${flagTag}
            </div>
            <div style="display:grid;grid-template-columns:auto auto auto;gap:8px;font-size:0.78rem;margin-bottom:8px;color:var(--text-secondary);">
                <span>📥 Entry: <b>${fmt(p.entry)}</b></span>
                <span>🛑 Stop: <b style="color:var(--accent-red);">${fmt(p.stop)}</b></span>
                <span>🎯 Target: <b style="color:var(--accent-green);">${fmt(p.target1)}</b></span>
            </div>
            <div style="font-size:0.78rem;line-height:1.4;">
                ${p.sectorReason ? `<p style="margin:0 0 4px;"><b>🏭 Ngành:</b> ${p.sectorReason}</p>` : ''}
                ${p.stockReason ? `<p style="margin:0 0 4px;"><b>📊 CP:</b> ${p.stockReason}</p>` : ''}
                ${p.riskNote ? `<p style="margin:0;color:var(--accent-red);"><b>⚠️ Rủi ro:</b> ${p.riskNote}</p>` : ''}
            </div>
        </div>`;
    }).join('');

    el.innerHTML = cards;
}

function setupSectorAIEvents() {
    const strengthBtn = document.getElementById('sector-strength-refresh');
    if (strengthBtn) strengthBtn.addEventListener('click', () => loadSectorStrength(true));
    const pickerBtn = document.getElementById('ai-picker-run');
    if (pickerBtn) pickerBtn.addEventListener('click', () => runAIPicker());
}

/**
 * Lưu CHỈ prompt lên hệ thống (giữ nguyên provider + keys hiện tại).
 * Dùng khi user sửa prompt xong muốn lưu ngay mà không đụng fields khác.
 */
async function saveAIPrompt() {
    const statusEl = document.getElementById('ai-settings-status');
    const promptEl = document.getElementById('ai-system-prompt');
    if (!promptEl) return;
    // Giữ provider + keys hiện tại (đọc từ form), chỉ update prompt
    const body = {
        provider: document.getElementById('ai-provider')?.value || 'auto',
        tokenrouterKey: document.getElementById('ai-key-tokenrouter')?.value || '',
        deepseekKey: document.getElementById('ai-key-deepseek')?.value || '',
        geminiKey: document.getElementById('ai-key-gemini')?.value || '',
        systemPrompt: promptEl.value || ''
    };
    if (statusEl) { statusEl.textContent = 'Đang lưu prompt...'; statusEl.style.color = 'var(--text-muted)'; }
    try {
        const res = await fetch(`${window.StockAPI.SERVER_BASE}/api/user/ai-settings`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data?.success) {
            if (statusEl) { statusEl.textContent = '✅ Đã lưu prompt'; statusEl.style.color = 'var(--accent-green)'; }
            // KHÔNG auto-regenerate báo cáo — lưu prompt là lưu, tạo báo cáo là action riêng
        } else {
            if (statusEl) { statusEl.textContent = '❌ ' + (data?.error || 'Lỗi'); statusEl.style.color = 'var(--accent-red)'; }
        }
    } catch (e) {
        if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = 'var(--accent-red)'; }
    }
}

/**
 * Load AI settings của user từ server → fill form.
 * Trả full key (user xem được key của họ) + default prompt.
 */
async function loadAISettings() {
    try {
        const res = await fetch(`${window.StockAPI.SERVER_BASE}/api/user/ai-settings`, { credentials: 'same-origin' });
        const data = await res.json();
        if (!data?.success || !data.settings) return;
        const s = data.settings;
        const provEl = document.getElementById('ai-provider');
        const trEl = document.getElementById('ai-key-tokenrouter');
        const dsEl = document.getElementById('ai-key-deepseek');
        const gmEl = document.getElementById('ai-key-gemini');
        const promptEl = document.getElementById('ai-system-prompt');
        if (provEl) provEl.value = s.provider || 'auto';
        if (trEl) trEl.value = s.tokenrouterKey || '';
        if (dsEl) dsEl.value = s.deepseekKey || '';
        if (gmEl) gmEl.value = s.geminiKey || '';
        // Prompt: nếu user có prompt riêng → hiện; không thì hiện default (để user dễ edit)
        if (promptEl) promptEl.value = s.systemPrompt || s.defaultPrompt || '';
        // Lưu default prompt để nút reset dùng
        window._aiDefaultPrompt = s.defaultPrompt || '';
    } catch (e) {
        console.error('loadAISettings error:', e);
    }
}

async function saveAISettings() {
    const statusEl = document.getElementById('ai-settings-status');
    const body = {
        provider: document.getElementById('ai-provider')?.value || 'auto',
        tokenrouterKey: document.getElementById('ai-key-tokenrouter')?.value || '',
        deepseekKey: document.getElementById('ai-key-deepseek')?.value || '',
        geminiKey: document.getElementById('ai-key-gemini')?.value || '',
        systemPrompt: document.getElementById('ai-system-prompt')?.value || ''
    };
    if (statusEl) { statusEl.textContent = 'Đang lưu...'; statusEl.style.color = 'var(--text-muted)'; }
    try {
        const res = await fetch(`${window.StockAPI.SERVER_BASE}/api/user/ai-settings`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data?.success) {
            if (statusEl) { statusEl.textContent = '✅ Đã lưu'; statusEl.style.color = 'var(--accent-green)'; }
            // KHÔNG auto-regenerate — lưu cấu hình là lưu, tạo báo cáo là action riêng
        } else {
            if (statusEl) { statusEl.textContent = '❌ ' + (data?.error || 'Lỗi'); statusEl.style.color = 'var(--accent-red)'; }
        }
    } catch (e) {
        if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = 'var(--accent-red)'; }
    }
}

function resetAIPrompt() {
    const promptEl = document.getElementById('ai-system-prompt');
    if (promptEl && window._aiDefaultPrompt) {
        promptEl.value = window._aiDefaultPrompt;
        const statusEl = document.getElementById('ai-settings-status');
        if (statusEl) { statusEl.textContent = '↺ Đã khôi phục mặc định (chưa lưu)'; statusEl.style.color = 'var(--text-muted)'; }
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

    // Load AI report khi switch sang tab ai-report (lazy-load, dùng cache nếu có)
    if (tabId === 'ai-report') {
        try { loadAISettings(); loadAIReport(false); } catch (e) { console.error('AI report load error:', e); }
    }

    // Load báo cáo tuần/tháng khi switch sang tab (lazy-load, dùng cache nếu có)
    if (tabId === 'week-report') {
        try { loadWeeklyReport(false); } catch (e) { console.error('Week report load error:', e); }
    }
    if (tabId === 'month-report') {
        try { loadMonthlyReport(false); } catch (e) { console.error('Month report load error:', e); }
    }

    // Init tab Kỹ thuật khi switch sang lần đầu
    if (tabId === 'technical') {
        try { if (!window._technicalInit) initTechnicalTab(); } catch (e) { console.error('Technical init error:', e); }
    }

    // Load bảng ngành khi switch sang tab sector-ai (lazy-load)
    if (tabId === 'sector-ai') {
        try { if (!SectorAIState.sectorData) loadSectorStrength(false); } catch (e) { console.error('Sector AI load error:', e); }
    }

    // Init MA breadth khi switch sang tab industry lần đầu (lazy-load)
    if (tabId === 'industry') {
        try { initMABreadth(); } catch (e) { console.error('MA breadth init error:', e); }
    }

    // Load Phá Đỉnh/Đáy breadth khi switch sang tab breadth-hl (lazy-load)
    if (tabId === 'breadth-hl') {
        try {
            if (!BreadthBreakoutState.data) setupBreadthBreakoutEvents();
            loadBreadthBreakout();
            loadBreadthSnapshot();
        } catch (e) { console.error('Breadth load error:', e); }
    }

    // Load SEPA ranking khi switch sang tab potential-stocks (lazy-load, không phá eager-load cũ)
    if (tabId === 'potential-stocks') {
        try { if (!window._sepaLoaded) loadSEPA(); } catch (e) { console.error('SEPA load error:', e); }
    }

    // Load Paper Trade khi switch sang tab paper-trade (lazy-load)
    if (tabId === 'paper-trade') {
        try { loadPaperTrade(); } catch (e) { console.error('Paper trade load error:', e); }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    // ── Phase 3: Auth gating — kiểm tra login trước khi khởi động app ──
    if (window.VNAuth) {
        const user = await VNAuth.currentUser();
        if (!user) {
            window.location.href = '/login.html';
            return;
        }
        // Hiển thị user info + logout button
        const userInfo = document.getElementById('userInfo');
        const adminLink = document.getElementById('adminLink');
        const portfolioLink = document.getElementById('portfolioLink');
        const changePwLink = document.getElementById('changePwLink');
        const logoutBtn = document.getElementById('logoutBtn');
        if (userInfo) { userInfo.style.display = 'inline'; userInfo.textContent = '👤 ' + user.username; }
        if (portfolioLink) portfolioLink.style.display = 'inline';
        if (changePwLink) changePwLink.style.display = 'inline';
        if (adminLink && user.role === 'admin') adminLink.style.display = 'inline';
        // Khởi tạo chuông thông báo admin (chỉ admin)
        if (user.role === 'admin' && window.adminNotif) {
            window.adminNotif.init();
        }
        if (logoutBtn) {
            logoutBtn.style.display = 'inline-block';
            logoutBtn.addEventListener('click', async () => {
                await VNAuth.logout();
                window.location.href = '/login.html';
            });
        }
        // Intercept 401 từ API → redirect login
        VNAuth.intercept401();
    }

    initApp();
    setupNewsEventListeners();
    setupAIReportEvents();
    setupPeriodReportEvents('week', {
        genBtn: 'week-report-generate', copyBtn: 'week-report-copy'
    });
    setupPeriodReportEvents('month', {
        genBtn: 'month-report-generate', copyBtn: 'month-report-copy'
    });
    setupSectorAIEvents();
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
    hasRun: false, // FIX Bug #2: flag phân biệt "chưa chạy" vs "đã chạy ra 0 kết quả"
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
    { key: 'ma50', label: 'MA50' },
    { key: 'ma100', label: 'MA100' },
    { key: 'ma200', label: 'MA200' },
    { key: 'demandStrength', label: 'Lực Cầu' },
    { key: 'rsi', label: 'RSI (14)' },
    { key: 'macdHist', label: 'MACD Histogram' },
    { key: 'macdRsiSignal', label: 'Tín hiệu MACD/RSI', type: 'text' },
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

async function runStockFilter() {
    console.log('🚀 Starting Stock Filter...');
    const list = document.getElementById('filter-conditions-list');
    const rows = list.querySelectorAll('.filter-condition-row');
    const conditions = [];

    rows.forEach(row => {
        const col = row.querySelector('.cond-column').value;
        const colDef = FILTER_COLUMNS.find(c => c.key === col);
        const isText = colDef && colDef.type === 'text';
        const rawVal = row.querySelector('.cond-value').value;
        conditions.push({
            column: col,
            operator: row.querySelector('.cond-operator').value,
            value: isText ? String(rawVal).trim().toUpperCase() : parseFloat(rawVal),
            isText
        });
    });

    console.log('📋 Filter Conditions:', conditions);

    // Aggregate all stocks — TỰ LOAD nếu chưa có (vào thẳng tab filter chưa qua Bảng Giá)
    let allStocks = [];
    const hasData = (PriceBoardState.allStocks.HSX && PriceBoardState.allStocks.HSX.length) ||
                    (PriceBoardState.allStocks.HNX && PriceBoardState.allStocks.HNX.length);
    if (!hasData) {
        const btn = document.getElementById('btn-run-filter');
        const oldText = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Đang tải dữ liệu...'; }
        try { await loadAllStocksFor3Exchanges(); } catch (e) { /* ignore */ }
        if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
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
        const prevPrice = stock.price - (stock.change || 0);
        const ma2 = (stock.price + prevPrice) / 2;
        const ma10 = stock.ma10 || 0;
        const ma2_trend = (ma10 > 0 && ma2 > ma10 && prevPrice < ma10) ? 1 : 0;
        const checkStock = { ...stock, ma2_trend };

        const pass = conditions.every(cond => {
            let stockVal = checkStock[cond.column];

            // Text comparison (MACD/RSI signal)
            if (cond.isText) {
                if (stockVal === undefined || stockVal === null) return cond.operator === 'ne';
                stockVal = String(stockVal).toUpperCase();
                const target = String(cond.value).toUpperCase();
                if (cond.operator === 'eq') return stockVal === target;
                if (cond.operator === 'ne') return stockVal !== target;
                if (cond.operator === 'contains') return stockVal.includes(target);
                return false;
            }

            // Number comparison
            if (stockVal === undefined || stockVal === null) stockVal = 0;
            else stockVal = parseFloat(stockVal);
            const targetVal = cond.value;
            if (isNaN(stockVal) || isNaN(targetVal)) return false;

            if (cond.operator === 'gt') return stockVal > targetVal;
            if (cond.operator === 'gte') return stockVal >= targetVal;
            if (cond.operator === 'lt') return stockVal < targetVal;
            if (cond.operator === 'lte') return stockVal <= targetVal;
            if (cond.operator === 'eq') return Math.abs(stockVal - targetVal) < 0.01;
            if (cond.operator === 'ne') return Math.abs(stockVal - targetVal) >= 0.01;
            return true;
        });

        return pass;
    });

    console.log(`✅ Filter Results: ${results.length} stocks found.`);
    FilterTabState.hasRun = true; // FIX Bug #2: đánh dấu đã chạy để auto re-run khi data update
    renderFilterResults(results);
}

/**
 * FIX Bug #2: Helper kiểm tra filter tab có conditions hợp lệ không (để auto re-run).
 */
function _filterHasConditions() {
    const list = document.getElementById('filter-conditions-list');
    if (!list) return false;
    const rows = list.querySelectorAll('.filter-condition-row');
    if (!rows || rows.length === 0) return false;
    // Phải có ít nhất 1 row có column + value nhập
    for (const row of rows) {
        const col = row.querySelector('.cond-column')?.value;
        const val = row.querySelector('.cond-value')?.value;
        if (col && val !== undefined && String(val).trim() !== '') return true;
    }
    return false;
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

    // Limit display để tránh lag DOM (18 cột × nhiều dòng = nặng)
    const MAX_DISPLAY = 150;
    const displayStocks = sortedStocks.slice(0, MAX_DISPLAY);
    const truncated = sortedStocks.length > MAX_DISPLAY;

    tbody.innerHTML = displayStocks.map(stock => {
        const change = stock.change || 0;
        const changePercent = stock.changePercent || 0;
        const isPositive = change > 0;
        const isNegative = change < 0;
        const changeClass = isPositive ? 'positive' : (isNegative ? 'negative' : '');
        const volRatio = stock.volRatio ? stock.volRatio.toFixed(0) : '--';

        // MA Color Logic: Green if Price > MA, Red if Price < MA
        const price = stock.price || 0;
        const maClass = (ma) => ma ? (price > ma ? 'text-green' : 'text-red') : '';
        const fmtMA = (ma) => (ma != null) ? ma : '--';

        // RSI coloring: >70 overbought (red), <30 oversold (green)
        const rsiVal = stock.rsi;
        const rsiClass = rsiVal != null ? (rsiVal > 70 ? 'text-red' : (rsiVal < 30 ? 'text-green' : '')) : '';
        const rsiCell = rsiVal != null ? rsiVal.toFixed(1) : '--';

        // MACD histogram coloring
        const macdVal = stock.macdHist;
        const macdClass = macdVal != null ? (macdVal > 0 ? 'text-green' : (macdVal < 0 ? 'text-red' : '')) : '';
        const macdCell = macdVal != null ? macdVal.toFixed(2) : '--';

        // Signal badge
        const sig = stock.macdRsiSignal;
        const sigCell = sig ? `<span class="badge ${sig === 'BUY' ? 'badge-active' : 'badge-disabled'}" style="font-size:0.6rem;">${sig}</span>` : '—';

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
                <td class="${maClass(stock.ma10)}">${fmtMA(stock.ma10)}</td>
                <td class="${maClass(stock.ma20)}">${fmtMA(stock.ma20)}</td>
                <td class="${maClass(stock.ma45)}">${fmtMA(stock.ma45)}</td>
                <td class="${maClass(stock.ma50)}">${fmtMA(stock.ma50)}</td>
                <td class="${maClass(stock.ma100)}">${fmtMA(stock.ma100)}</td>
                <td class="${maClass(stock.ma200)}">${fmtMA(stock.ma200)}</td>
                <td class="${rsiClass}">${rsiCell}</td>
                <td class="${macdClass}">${macdCell}</td>
                <td>${sigCell}</td>
                <td class="${stock.demandStrength == null ? 'text-muted' : (stock.demandStrength > 50 ? 'text-green' : (stock.demandStrength < 50 ? 'text-red' : 'text-yellow'))}">${stock.demandStrength == null ? '—' : stock.demandStrength + '%'}</td>
            </tr>
        `;
    }).join('');

    if (truncated) {
        tbody.innerHTML += `<tr><td colspan="18" style="text-align:center;color:var(--text-muted);font-size:0.78rem;padding:8px;">⚠️ Hiển thị ${MAX_DISPLAY}/${sortedStocks.length} kết quả. Thêm điều kiện để thu hẹp.</td></tr>`;
    }
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
        <select class="cond-column" onchange="updateCondValueInput(this)">
            ${colOptions}
        </select>
        <select class="cond-operator">
            <option value="gt">Lớn hơn (>)</option>
            <option value="gte">Lớn hơn hoặc bằng (≥)</option>
            <option value="lt">Nhỏ hơn (<)</option>
            <option value="lte">Nhỏ hơn hoặc bằng (≤)</option>
            <option value="eq">Bằng (=)</option>
            <option value="ne">Khác (≠)</option>
            <option value="contains">Tín hiệu</option>
        </select>
        <input type="text" class="cond-value" placeholder="Giá trị..." step="0.1">
        <button class="remove-condition-btn" onclick="removeFilterCondition('${id}')">×</button>
    `;

    list.appendChild(div);

    // Set values if provided (from preset)
    if (presetCondition) {
        div.querySelector('.cond-column').value = presetCondition.column;
        div.querySelector('.cond-operator').value = presetCondition.operator;
        div.querySelector('.cond-value').value = presetCondition.value;
    }
    // Set input type theo column
    updateCondValueInput(div.querySelector('.cond-column'));
}

// Đổi type input + placeholder tùy theo cột được chọn
function updateCondValueInput(colSelect) {
    const row = colSelect.closest('.filter-condition-row');
    if (!row) return;
    const input = row.querySelector('.cond-value');
    const opSelect = row.querySelector('.cond-operator');
    const col = FILTER_COLUMNS.find(c => c.key === colSelect.value);
    if (col && col.type === 'text') {
        input.type = 'text';
        input.placeholder = 'VD: BUY, SELL';
        // Hiện operator contains + eq, ẩn các operator số
        Array.from(opSelect.options).forEach(opt => {
            opt.style.display = (opt.value === 'contains' || opt.value === 'eq' || opt.value === 'ne') ? '' : 'none';
        });
        if (!['contains', 'eq', 'ne'].includes(opSelect.value)) opSelect.value = 'eq';
    } else {
        input.type = 'number';
        input.placeholder = 'Giá trị...';
        input.step = '0.1';
        Array.from(opSelect.options).forEach(opt => {
            opt.style.display = (opt.value === 'contains') ? 'none' : '';
        });
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

// ════════════════════════════════════════════════════════════════════════
// BREADTH HIGH/LOW — Phá Đỉnh / Phá Đáy (sức mạnh thị trường)
// Nguồn: /api/breadth-breakout (Fiintrade TopMover, insight tính sẵn server-side).
// ════════════════════════════════════════════════════════════════════════

const BreadthBreakoutState = {
    data: null,
    countChart: null,
    capChart: null,
    isLoading: false
};

const TF_LABELS = {
    ThreeMonths: '3 Tháng',
    SixMonths: '6 Tháng',
    OneYear: '1 Năm'
};

/** Đọc CSS var để dùng cho Chart.js (đồng bộ với theme). */
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Tải dữ liệu breadth + render tất cả thành phần. */
async function loadBreadthBreakout() {
    if (BreadthBreakoutState.isLoading) return;
    BreadthBreakoutState.isLoading = true;

    const meta = document.getElementById('breadth-meta');
    if (meta) meta.textContent = 'Đang tải...';

    try {
        const response = await fetch(`${SERVER_BASE}${API.SERVER.BREADTH_BREAKOUT}?_t=${Date.now()}`);
        const result = await response.json();

        if (!result.success) {
            if (meta) meta.textContent = 'Lỗi: ' + (result.error || 'không rõ');
            return;
        }

        BreadthBreakoutState.data = result;
        renderBreadthVerdict(result);
        renderBreadthStats(result);
        renderBreadthCountChart(result);
        renderBreadthCapChart(result);
        renderBreadthAllTable(result);
        renderBreadthSectorTable(result);
        renderBreadthInsights(result);

        if (meta) {
            const ts = new Date(result.timestamp);
            meta.textContent = 'Cập nhật: ' + ts.toLocaleTimeString('vi-VN');
        }
    } catch (e) {
        console.error('Breadth breakout load error:', e);
        if (meta) meta.textContent = 'Lỗi tải dữ liệu';
    } finally {
        BreadthBreakoutState.isLoading = false;
    }
}

/**
 * Verdict box — nhận xét tổng thể rule-based.
 * Sinh 2-3 câu luận giải dựa trên: ratio 3 timeframe, cap multiplier,
 * quality of leadership, RSI climax.
 */
function renderBreadthVerdict(data) {
    const badge = document.getElementById('breadth-verdict-badge');
    const text = document.getElementById('breadth-verdict-text');
    const box = document.getElementById('breadth-verdict');
    if (!badge || !text || !box) return;

    const s = data.summary; // [{tf,high,low,ratio,verdict}] 3 dòng
    const r3 = s[0].ratio, r6 = s[1].ratio, r1 = s[2].ratio;

    // Verdict tổng: ưu tiên chiều dài hạn (1N)
    const overall = s[2].verdict;
    badge.textContent = overall === 'Bullish' ? '🟢 BULLISH' : (overall === 'Bearish' ? '🔴 BEARISH' : '🟡 NEUTRAL');
    box.className = 'breadth-verdict ' + overall.toLowerCase();

    // Luận giải
    const lines = [];

    // (1) Cấu trúc xu hướng theo depth
    if (r3 > r6 && r6 > r1) {
        lines.push(`Thị trường ngắn hạn khỏe hơn dài hạn (ratio 3T ${r3} > 6T ${r6} > 1N ${r1}) — có thể đang sát vùng đỉnh ngắn hoặc pha phục hồi tạm, nhưng cấu trúc dài hạn vẫn yếu.`);
    } else if (r1 >= r6 && r6 >= r3) {
        lines.push(`Xu hướng chưa có đáy cấu trúc — mỗi lần nới timeframe phe phá đáy càng chiếm lợi thế (ratio 3T ${r3} ≤ 6T ${r6} ≤ 1N ${r1}).`);
    } else {
        lines.push(`Breadth đang lộn xộn giữa các timeframe (3T:${r3} · 6T:${r6} · 1N:${r1}) — thị trường thiếu hướng rõ, pha tích lũy/sideway.`);
    }

    // (2) Cap multiplier (3T)
    const cap3 = data.capSummary[0];
    if (cap3.lowOverHigh >= 3) {
        lines.push(`Vốn hóa nhóm phá đáy gấp ${cap3.lowOverHigh} lần nhóm phá đỉnh — tiền lớn đang chảy ra khỏi phe yếu chứ không đổ vào phe mạnh.`);
    } else if (cap3.lowOverHigh <= 0.5) {
        lines.push(`Vốn hóa nhóm phá đỉnh vượt trội (Low/High = ${cap3.lowOverHigh} lần) — dòng tiền lớn đang tích cực vào mã mạnh.`);
    }

    // (3) Quality of leadership
    const sb = data.sizeBuckets;
    const bigLeaders = sb.high.Mega + sb.high.Large;
    if (bigLeaders === 0) {
        lines.push(`Không có mã large/mega-cap nào lập đỉnh mới → uptrend (nếu có) thiếu "đầu tàu" dẫn dắt, sẽ hẹp và mong manh.`);
    } else {
        lines.push(`Có ${bigLeaders} mã large-cap+ lập đỉnh — leadership tốt cho một nhịp uptrend bền.`);
    }

    // (4) RSI climax
    if (data.rsiSummary.low3T > 0 && data.rsiSummary.low3T < 25) {
        lines.push(`RSI trung bình nhóm phá đáy chỉ ${data.rsiSummary.low3T} (oversold cực mạnh) → vùng capitulation, có thể mở ra relief rally ngắn hạn.`);
    } else if (data.rsiSummary.high3T > 75) {
        lines.push(`RSI trung bình nhóm phá đỉnh đã đạt ${data.rsiSummary.high3T} (overbought) → động lực đã mỏng, cẩn thận chốt lời.`);
    }

    text.innerHTML = lines.map(l => `<p>${l}</p>`).join('');
}

/** Box thống kê theo từng timeframe (3 cột: 3T/6T/1N). */
function renderBreadthStats(data) {
    const TF_KEYS = { ThreeMonths: '3M', SixMonths: '6M', OneYear: '1Y' };
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    data.summary.forEach((s, i) => {
        const k = TF_KEYS[s.tf];
        const cap = data.capSummary[i];
        set(`breadth-tf-high-${k}`, `${s.high} mã`);
        set(`breadth-tf-low-${k}`, `${s.low} mã`);
        set(`breadth-tf-ratio-${k}`, `${s.ratio.toFixed(2)} (${s.verdict})`);
        set(`breadth-tf-cap-${k}`, `${cap.capHigh.toLocaleString('vi-VN')} / ${cap.capLow.toLocaleString('vi-VN')} tỷ`);
    });
}

/** Helper: label trong cột (hiện số trên đỉnh bar). */
function barLabelPlugin() {
    return {
        id: 'barLabels',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            ctx.save();
            ctx.font = '600 11px Inter, sans-serif';
            ctx.textAlign = 'center';
            chart.data.datasets.forEach((ds, di) => {
                const meta = chart.getDatasetMeta(di);
                meta.data.forEach((bar, bi) => {
                    const val = ds.data[bi];
                    if (val == null) return;
                    const color = di === 0 ? '#2ee68a' : '#ff5c78';
                    ctx.fillStyle = color;
                    const txt = typeof val === 'number' && val >= 1000
                        ? val.toLocaleString('vi-VN')
                        : String(val);
                    ctx.fillText(txt, bar.x, bar.y - 6);
                });
            });
            ctx.restore();
        }
    };
}

/** Chart 1: grouped bar — H vs L count theo 3 timeframe (có data label + click để filter bảng). */
function renderBreadthCountChart(data) {
    const ctx = document.getElementById('breadth-count-chart');
    if (!ctx) return;
    if (BreadthBreakoutState.countChart) BreadthBreakoutState.countChart.destroy();

    const labels = data.summary.map(s => TF_LABELS[s.tf]);
    const highs = data.summary.map(s => s.high);
    const lows = data.summary.map(s => s.low);
    const green = cssVar('--accent-green') || '#26a65b';
    const red = cssVar('--accent-red') || '#e84142';
    const TF_TO_SHORT = { '3 Tháng': '3T', '6 Tháng': '6T', '1 Năm': '1N' };

    BreadthBreakoutState.countChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: '🟢 Phá Đỉnh (New High)', data: highs, backgroundColor: green, borderRadius: 4 },
                { label: '🔴 Phá Đáy (New Low)',  data: lows,  backgroundColor: red,   borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (e, els) => {
                if (!els.length) return;
                const el = els[0];
                const tfLabel = labels[el.index];
                const tfShort = TF_TO_SHORT[tfLabel];
                if (tfShort) setBreadthTfFilter(tfShort);
            },
            onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
            plugins: {
                legend: { position: 'top', labels: { color: cssVar('--text-secondary') } },
                tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw} mã (click để lọc bảng theo ${labels[c.dataIndex]})` } }
            },
            scales: {
                x: { ticks: { color: cssVar('--text-secondary') }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: cssVar('--text-secondary'), precision: 0 }, grid: { color: cssVar('--border-color') } }
            }
        },
        plugins: [barLabelPlugin()]
    });
}

/** Chart 2: grouped bar — Vốn hóa H vs L (tỷ VND) theo 3 timeframe (có data label + click filter). */
function renderBreadthCapChart(data) {
    const ctx = document.getElementById('breadth-cap-chart');
    if (!ctx) return;
    if (BreadthBreakoutState.capChart) BreadthBreakoutState.capChart.destroy();

    const labels = data.capSummary.map(c => TF_LABELS[c.tf]);
    const capsH = data.capSummary.map(c => c.capHigh);
    const capsL = data.capSummary.map(c => c.capLow);
    const green = cssVar('--accent-green') || '#26a65b';
    const red = cssVar('--accent-red') || '#e84142';
    const TF_TO_SHORT = { '3 Tháng': '3T', '6 Tháng': '6T', '1 Năm': '1N' };

    BreadthBreakoutState.capChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: '🟢 Vốn hóa Phá Đỉnh', data: capsH, backgroundColor: green, borderRadius: 4 },
                { label: '🔴 Vốn hóa Phá Đáy',  data: capsL, backgroundColor: red,   borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (e, els) => {
                if (!els.length) return;
                const tfLabel = labels[els[0].index];
                const tfShort = TF_TO_SHORT[tfLabel];
                if (tfShort) setBreadthTfFilter(tfShort);
            },
            onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
            plugins: {
                legend: { position: 'top', labels: { color: cssVar('--text-secondary') } },
                tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw.toLocaleString('vi-VN')} tỷ` } }
            },
            scales: {
                x: { ticks: { color: cssVar('--text-secondary') }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: cssVar('--text-secondary'), callback: (v) => v.toLocaleString('vi-VN') }, grid: { color: cssVar('--border-color') } }
            }
        },
        plugins: [barLabelPlugin()]
    });
}

/** Bảng mã Phá Đỉnh 3T (sort GTGD desc). */
// State cho bảng tổng hợp (filter + tfFilter + search + sort)
const BreadthAllTableState = {
    filter: 'all',      // 'all' | 'high' | 'low'
    tfFilter: 'all',    // 'all' | '3T' | '6T' | '1N'
    search: '',
    sortKey: null,      // null = dùng thứ tự server (type → marketCap)
    sortAsc: true
};

/** Set timeframe filter (từ click chart hoặc nút) + re-render. */
function setBreadthTfFilter(tfShort) {
    BreadthAllTableState.tfFilter = tfShort;
    // Sync nút
    document.querySelectorAll('#breadth-tf-btns .breadth-tf-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-tf') === tfShort);
    });
    if (BreadthBreakoutState.data) renderBreadthAllTable(BreadthBreakoutState.data);
}

/**
 * Bảng tổng hợp tất cả mã (gộp Phá Đỉnh + Phá Đáy vào 1 bảng).
 * Có filter (Tất cả/Đỉnh/Đáy), ô search, sort theo cột.
 */
function renderBreadthAllTable(data) {
    const tbody = document.getElementById('breadth-all-tbody');
    const countEl = document.getElementById('breadth-all-count');
    if (!tbody) return;

    let items = (data.allStocks || []).slice();

    // Lọc theo filter (Đỉnh/Đáy/Tất cả) + timeframe (3T/6T/1N) kết hợp.
    // Logic: nếu chọn cả 2 (vd Phá Đỉnh + 3T) → mã phải có badge 3T trong ĐỈNH.
    //        Nếu chỉ chọn Đỉnh/Đáy → bất kỳ tf nào của bên đó.
    //        Nếu chỉ chọn tf → tf đó xuất hiện ở Đỉnh HOẶC Đáy.
    const f = BreadthAllTableState.filter;       // 'all' | 'high' | 'low'
    const tf = BreadthAllTableState.tfFilter;     // 'all' | '3T' | '6T' | '1N'
    if (f !== 'all' && tf !== 'all') {
        // Cả 2 đều chọn: phải match đúng loại VÀ timeframe
        const arrKey = f === 'high' ? 'highTfs' : 'lowTfs';
        items = items.filter(it => (it[arrKey] || []).includes(tf));
    } else if (f !== 'all') {
        // Chỉ chọn loại
        const arrKey = f === 'high' ? 'highTfs' : 'lowTfs';
        items = items.filter(it => it[arrKey].length > 0);
    } else if (tf !== 'all') {
        // Chỉ chọn tf
        items = items.filter(it =>
            (it.highTfs || []).includes(tf) || (it.lowTfs || []).includes(tf)
        );
    }

    // Lọc theo search
    const q = BreadthAllTableState.search.trim().toLowerCase();
    if (q) {
        items = items.filter(it =>
            it.ticker.toLowerCase().includes(q) ||
            (it.sector || '').toLowerCase().includes(q)
        );
    }

    // Sort
    if (BreadthAllTableState.sortKey) {
        const k = BreadthAllTableState.sortKey;
        const dir = BreadthAllTableState.sortAsc ? 1 : -1;
        items.sort((a, b) => {
            let va = a[k], vb = b[k];
            if (typeof va === 'string') va = va.toLowerCase();
            if (typeof vb === 'string') vb = vb.toLowerCase();
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    }

    if (countEl) countEl.textContent = `${items.length} mã`;

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted);">Không có mã nào khớp bộ lọc.</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(it => {
        const pctClass = (it.pct1Y || 0) >= 0 ? 'pos' : 'neg';
        const pctYtdClass = (it.pctYTD || 0) >= 0 ? 'pos' : 'neg';
        const rsi = it.rsi || 0;
        const rsiClass = rsi > 70 ? 'neg' : (rsi < 30 ? 'pos' : '');
        const trap = (it.value || 0) < 0.5 && it.highTfs.length > 0
            ? '<span class="breadth-warn" title="GTGD rất thấp — bẫy thanh khoản">⚠️</span>' : '';
        // Turnaround: mã có trong danh sách phá đáy NHƯNG YTD vẫn dương
        // → đang phục hồi mạnh sau downtrend sâu (kiểu DNH: +5.6% YTD dù vừa lập đáy)
        const isTurnaround = it.lowTfs.length > 0 && (it.pctYTD || 0) > 0;
        const turnaround = isTurnaround
            ? '<span class="breadth-turnaround" title="Turnaround: đang phục hồi dù vừa lập đáy mới">🔄</span>' : '';
        const highBadges = (it.highTfs || []).map(tf => `<span class="breadth-tf-badge high">${tf}</span>`).join(' ') || '<span class="breadth-dash">—</span>';
        const lowBadges = (it.lowTfs || []).map(tf => `<span class="breadth-tf-badge low">${tf}</span>`).join(' ') || '<span class="breadth-dash">—</span>';
        // Format volume: số lớn → rút gọn (1.2 triệu, 350 nghìn)
        const fmtVol = (v) => {
            v = v || 0;
            if (v >= 1e6) return (v / 1e6).toFixed(2) + 'tr';
            if (v >= 1e3) return (v / 1e3).toFixed(0) + 'k';
            return v.toFixed(0);
        };
        return `<tr>
            <td class="stock-code"><strong>${it.ticker}</strong>${trap}${turnaround}</td>
            <td>${it.sector}</td>
            <td>${(it.marketCap || 0).toLocaleString('vi-VN')}</td>
            <td class="${pctClass}">${(it.pct1Y || 0) >= 0 ? '+' : ''}${(it.pct1Y || 0).toFixed(1)}%</td>
            <td class="${pctYtdClass}">${(it.pctYTD || 0) >= 0 ? '+' : ''}${(it.pctYTD || 0).toFixed(1)}%</td>
            <td>${(it.value || 0).toFixed(2)}</td>
            <td>${fmtVol(it.volume)}</td>
            <td class="${rsiClass}">${rsi.toFixed(1)}</td>
            <td>${highBadges}</td>
            <td>${lowBadges}</td>
        </tr>`;
    }).join('');
}

/** Bind sự kiện filter + search + sort cho bảng tổng hợp. */
function setupBreadthAllTableEvents() {
    // Filter buttons (Đỉnh/Đáy/Tất cả)
    document.querySelectorAll('#breadth-filter-btns .breadth-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#breadth-filter-btns .breadth-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            BreadthAllTableState.filter = btn.getAttribute('data-filter');
            if (BreadthBreakoutState.data) renderBreadthAllTable(BreadthBreakoutState.data);
        });
    });

    // Timeframe filter buttons (3T/6T/1N/Mọi TF)
    document.querySelectorAll('#breadth-tf-btns .breadth-tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#breadth-tf-btns .breadth-tf-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            BreadthAllTableState.tfFilter = btn.getAttribute('data-tf');
            if (BreadthBreakoutState.data) renderBreadthAllTable(BreadthBreakoutState.data);
        });
    });

    // Search input (debounce 200ms)
    const search = document.getElementById('breadth-search');
    let searchTimer = null;
    if (search) {
        search.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                BreadthAllTableState.search = search.value;
                if (BreadthBreakoutState.data) renderBreadthAllTable(BreadthBreakoutState.data);
            }, 200);
        });
    }

    // Sort theo cột (click header)
    document.querySelectorAll('#breadth-all-table th.sortable').forEach(th => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const key = th.getAttribute('data-sort');
            if (BreadthAllTableState.sortKey === key) {
                BreadthAllTableState.sortAsc = !BreadthAllTableState.sortAsc;
            } else {
                BreadthAllTableState.sortKey = key;
                BreadthAllTableState.sortAsc = true;
            }
            // Update icon
            document.querySelectorAll('#breadth-all-table th.sortable').forEach(t => {
                t.classList.remove('sort-asc', 'sort-desc');
            });
            th.classList.add(BreadthAllTableState.sortAsc ? 'sort-asc' : 'sort-desc');
            if (BreadthBreakoutState.data) renderBreadthAllTable(BreadthBreakoutState.data);
        });
    });
}

/** Bảng phân nhóm ngành: 3T/6T/1N × H/L count + vốn hóa tác động. */
function renderBreadthSectorTable(data) {
    const tbody = document.getElementById('breadth-sector-tbody');
    if (!tbody) return;

    const rows = data.sectorBreakdown || [];
    const TFS = ['ThreeMonths', 'SixMonths', 'OneYear'];
    const fmtCap = (c) => {
        c = c || 0;
        if (c >= 1000) return (c / 1000).toFixed(1) + 'K';
        return c.toLocaleString('vi-VN');
    };
    // Cell: hiện count + cap nhỏ bên dưới; nếu count=0 thì hiện "—"
    const cell = (p, type) => {
        const cnt = p ? (type === 'h' ? p.h : p.l) : 0;
        const cap = p ? (type === 'h' ? p.hCap : p.lCap) : 0;
        if (!cnt) return '<td class="breadth-dash">—</td>';
        return `<td class="${type === 'h' ? 'pos' : 'neg'}"><span class="breadth-sec-cnt">${cnt}</span><span class="breadth-sec-cap">${fmtCap(cap)} tỷ</span></td>`;
    };

    tbody.innerHTML = rows.map(r => {
        return `<tr>
            <td class="breadth-sec-name"><strong>${r.sector}</strong></td>
            ${cell(r.perTf.ThreeMonths, 'h')}
            ${cell(r.perTf.ThreeMonths, 'l')}
            ${cell(r.perTf.SixMonths, 'h')}
            ${cell(r.perTf.SixMonths, 'l')}
            ${cell(r.perTf.OneYear, 'h')}
            ${cell(r.perTf.OneYear, 'l')}
            <td class="neg breadth-sec-impact"><strong>${fmtCap(r.totalLowCap)} tỷ</strong></td>
            <td class="pos breadth-sec-impact"><strong>${fmtCap(r.totalHighCap)} tỷ</strong></td>
        </tr>`;
    }).join('');

    // Sort cho sector table
    document.querySelectorAll('#breadth-sector-table th.sortable').forEach(th => {
        th.style.cursor = 'pointer';
        th.onclick = () => {
            const key = th.getAttribute('data-sort');
            const sorted = [...rows].sort((a, b) => {
                if (key === 'sector') return a.sector.localeCompare(b.sector);
                return (b[key] || 0) - (a[key] || 0);
            });
            tbody.innerHTML = sorted.map(r => `<tr>
                <td class="breadth-sec-name"><strong>${r.sector}</strong></td>
                ${cell(r.perTf.ThreeMonths, 'h')}
                ${cell(r.perTf.ThreeMonths, 'l')}
                ${cell(r.perTf.SixMonths, 'h')}
                ${cell(r.perTf.SixMonths, 'l')}
                ${cell(r.perTf.OneYear, 'h')}
                ${cell(r.perTf.OneYear, 'l')}
                <td class="neg breadth-sec-impact"><strong>${fmtCap(r.totalLowCap)} tỷ</strong></td>
                <td class="pos breadth-sec-impact"><strong>${fmtCap(r.totalHighCap)} tỷ</strong></td>
            </tr>`).join('');
        };
    });
}

/** Box 4 chỉ báo sức mạnh thị trường. */
function renderBreadthInsights(data) {
    const el = document.getElementById('breadth-insights-list');
    if (!el) return;
    const sb = data.sizeBuckets;
    const cap3 = data.capSummary[0];
    const rsi = data.rsiSummary;
    const trapCount = (data.topHighs3T || []).filter(it => it.value < 0.5).length;
    const leaders = sb.high.Mega + sb.high.Large;

    const items = [
        {
            title: 'Cap-weighted breadth (breadth có trọng số vốn hóa)',
            val: cap3.lowOverHigh.toFixed(2) + ' lần',
            read: cap3.lowOverHigh >= 3
                ? 'Tiền lớn đang RỜI BỎ phe yếu, KHÔNG tham gia phe mạnh → breadth "giả mạnh".'
                : (cap3.lowOverHigh <= 0.5
                    ? 'Dòng tiền lớn đang TÍCH CỰC vào phe mạnh → breadth có chất.'
                    : 'Dòng tiền phân bổ tương đối cân bằng giữa 2 phe.')
        },
        {
            title: 'Quality of leadership (chất lượng dẫn dắt)',
            val: leaders + ' large-cap+',
            read: leaders === 0
                ? 'KHÔNG có mã large/mega-cap lập đỉnh → thiếu đầu tàu, uptrend sẽ hẹp và mong manh.'
                : `Có ${leaders} mã large-cap+ dẫn dắt — leadership tốt cho uptrend bền.`
        },
        {
            title: 'Liquidity trap (bẫy thanh khoản ở phe phá đỉnh)',
            val: trapCount + '/' + (data.topHighs3T || []).length + ' mã GTGD≈0',
            read: trapCount > (data.topHighs3T || []).length / 2
                ? `Nhiều mã phá đỉnh có GTGD≈0 (${trapCount} mã) — đỉnh "ma", mua dễ thoát khó.`
                : 'Phần lớn mã phá đỉnh có thanh khoản thật → đỉnh đáng tin.'
        },
        {
            title: 'RSI climax (điểm cực kỹ thuật)',
            val: `H:${rsi.high3T} · L:${rsi.low3T}`,
            read: rsi.low3T > 0 && rsi.low3T < 25
                ? `Phe phá đáy oversold cực mạnh (RSI ${rsi.low3T}) → vùng capitulation, có thể có relief rally.`
                : (rsi.high3T > 75
                    ? `Phe phá đỉnh đã overbought (RSI ${rsi.high3T}) → động lực mỏng, cẩn thận chốt lời.`
                    : 'RSI cả 2 phe chưa ở vùng cực — chưa có tín hiệu climax rõ.')
        }
    ];

    el.innerHTML = items.map(it => `<div class="breadth-insight-item">
        <div class="breadth-insight-head"><strong>${it.title}</strong> <span class="breadth-insight-val">${it.val}</span></div>
        <div class="breadth-insight-read">${it.read}</div>
    </div>`).join('');
}

/** Init: bind nút refresh + filter + search + sort cho bảng tổng hợp. */
function setupBreadthBreakoutEvents() {
    const btn = document.getElementById('breadth-refresh');
    if (btn) btn.addEventListener('click', () => {
        loadBreadthBreakout();
    });
    setupBreadthAllTableEvents();
    setupBreadthSnapshotEvents();
    setupBreadthCollapse();
}

/**
 * Inject nút thu gọn/mở rộng vào header mỗi section có class breadth-collapsible.
 * Click toggle → ẩn/hiện body của section (giữ header + nút).
 * Mặc định: mở hết (class .collapsed chỉ add khi user bấm).
 */
function setupBreadthCollapse() {
    const sections = document.querySelectorAll('#breadth-hl .breadth-collapsible');
    sections.forEach(section => {
        // Đã inject rồi thì skip (tránh duplicate khi re-init)
        if (section.querySelector('.breadth-collapse-btn')) return;

        // Tìm header container: ưu tiên .chart-controls, rồi .breadth-stat-header
        const header = section.querySelector('.chart-controls') || section.querySelector('.breadth-stat-header');
        if (!header) return; // verdict box không có chart-controls → xử lý riêng bên dưới

        // Tạo nút toggle
        const btn = document.createElement('button');
        btn.className = 'breadth-collapse-btn';
        btn.innerHTML = '<span class="collapse-icon">▼</span>';
        btn.title = 'Thu gọn / Mở rộng';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleBreadthSection(section, btn);
        });
        header.appendChild(btn);
    });

    // Verdict box đặc biệt: không có chart-controls, nút gắn vào badge
    const verdict = document.getElementById('breadth-verdict');
    if (verdict && !verdict.querySelector('.breadth-collapse-btn')) {
        const badge = verdict.querySelector('.breadth-verdict-badge');
        if (badge) {
            const btn = document.createElement('button');
            btn.className = 'breadth-collapse-btn verdict-toggle';
            btn.innerHTML = '<span class="collapse-icon">▼</span>';
            btn.title = 'Thu gọn / Mở rộng';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleBreadthSection(verdict, btn);
            });
            badge.appendChild(btn);
        }
    }
}

/** Toggle 1 section: đánh dấu collapsed + ẩn body. */
function toggleBreadthSection(section, btn) {
    const isCollapsed = section.classList.toggle('collapsed');
    const icon = btn.querySelector('.collapse-icon');
    if (icon) icon.textContent = isCollapsed ? '▶' : '▼';
}

// ════════════════════════════════════════════════════════════════════════
// BREADTH SNAPSHOT — Xu hướng breadth theo lịch sử (ratio line, area, calendar)
// ════════════════════════════════════════════════════════════════════════

const BreadthSnapshotState = {
    data: null,
    range: 90,
    ratioChart: null,
    areaChart: null,
    isLoading: false
};

/** Tải snapshot history + render 3 charts. */
async function loadBreadthSnapshot() {
    if (BreadthSnapshotState.isLoading) return;
    BreadthSnapshotState.isLoading = true;
    const metaEl = document.getElementById('breadth-snapshot-meta');
    if (metaEl) metaEl.textContent = 'Đang tải lịch sử breadth...';
    try {
        const resp = await fetch(`${SERVER_BASE}/api/breadth-snapshot?days=${BreadthSnapshotState.range}&_t=${Date.now()}`);
        const result = await resp.json();
        if (!result.success) {
            if (metaEl) metaEl.textContent = 'Lỗi: ' + (result.error || 'không rõ');
            return;
        }
        BreadthSnapshotState.data = result;
        renderBreadthSnapshotMeta(result);
        renderBreadthRatioChart(result.series);
        renderBreadthAreaChart(result.series);
        renderBreadthCalendar(result.series);
    } catch (e) {
        console.error('Breadth snapshot load error:', e);
        if (metaEl) metaEl.textContent = 'Lỗi tải dữ liệu lịch sử';
    } finally {
        BreadthSnapshotState.isLoading = false;
    }
}

/** Meta line: "X ngày · từ AAA → BBB · đã có hôm nay ✓/✗". */
function renderBreadthSnapshotMeta(result) {
    const el = document.getElementById('breadth-snapshot-meta');
    if (!el) return;
    const m = result.meta || {};
    const today = m.hasToday ? '✓ đã có hôm nay' : '⏳ chưa có hôm nay (sẽ tự chụp 15:00-22:00 VN)';
    if (!m.total) {
        el.innerHTML = `<span class="breadth-warn">⚠️ Chưa có dữ liệu lịch sử. Snapshot đầu tiên sẽ được tạo hôm nay (chạy capture thủ công hoặc đợi scheduler EOD).</span>`;
        return;
    }
    el.innerHTML = `<strong>${m.total}</strong> ngày · từ <strong>${m.firstDate}</strong> → <strong>${m.lastDate}</strong> · ${today}`;
}

/** Chart 1: Ratio line (3T/6T/1N) + đường tham chiếu 1.0. */
function renderBreadthRatioChart(series) {
    const ctx = document.getElementById('breadth-ratio-chart');
    if (!ctx) return;
    if (BreadthSnapshotState.ratioChart) BreadthSnapshotState.ratioChart.destroy();
    if (!series || !series.length) { ctx.parentElement.innerHTML = '<div class="breadth-empty">Chưa có data</div>'; return; }

    const labels = series.map(s => s.date);
    const ref1 = labels.map(() => 1.0);
    const green = cssVar('--accent-green') || '#2ee68a';
    const red = cssVar('--accent-red') || '#ff5c78';
    const blue = cssVar('--accent-blue') || '#4472C4';
    const purple = cssVar('--accent-purple') || '#9b59b6';

    BreadthSnapshotState.ratioChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Ratio 3T', data: series.map(s => s.ratio3T), borderColor: blue, backgroundColor: 'transparent', tension: 0.3, borderWidth: 2, pointRadius: 2 },
                { label: 'Ratio 6T', data: series.map(s => s.ratio6T), borderColor: purple, backgroundColor: 'transparent', tension: 0.3, borderWidth: 2, pointRadius: 2 },
                { label: 'Ratio 1N', data: series.map(s => s.ratio1Y), borderColor: green, backgroundColor: 'transparent', tension: 0.3, borderWidth: 2, pointRadius: 2 },
                { label: 'Bull/Bear (1.0)', data: ref1, borderColor: red, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, backgroundColor: 'transparent' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', labels: { color: cssVar('--text-secondary'), font: { size: 11 } } },
                tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw.toFixed(2)}` } }
            },
            scales: {
                x: { ticks: { color: cssVar('--text-secondary'), maxTicksLimit: 10, font: { size: 10 } }, grid: { display: false } },
                y: { ticks: { color: cssVar('--text-secondary'), font: { size: 10 } }, grid: { color: cssVar('--border-color') } }
            }
        }
    });
}

/** Chart 2: Count H/L area chart. */
function renderBreadthAreaChart(series) {
    const ctx = document.getElementById('breadth-count-area-chart');
    if (!ctx) return;
    if (BreadthSnapshotState.areaChart) BreadthSnapshotState.areaChart.destroy();
    if (!series || !series.length) { ctx.parentElement.innerHTML = '<div class="breadth-empty">Chưa có data</div>'; return; }

    const labels = series.map(s => s.date);
    const green = cssVar('--accent-green') || '#2ee68a';
    const red = cssVar('--accent-red') || '#ff5c78';
    // alpha helper
    const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

    BreadthSnapshotState.areaChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '🟢 Phá Đỉnh 3T', data: series.map(s => s.high3T), borderColor: green, backgroundColor: alpha(green, 0.3), fill: true, tension: 0.3, pointRadius: 1 },
                { label: '🔴 Phá Đáy 3T', data: series.map(s => s.low3T), borderColor: red, backgroundColor: alpha(red, 0.3), fill: true, tension: 0.3, pointRadius: 1 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', labels: { color: cssVar('--text-secondary'), font: { size: 11 } } },
                tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw} mã` } }
            },
            scales: {
                x: { ticks: { color: cssVar('--text-secondary'), maxTicksLimit: 10, font: { size: 10 } }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: cssVar('--text-secondary'), font: { size: 10 }, precision: 0 }, grid: { color: cssVar('--border-color') } }
            }
        }
    });
}

/** Chart 3: Calendar heatmap (GitHub-style) — custom CSS grid. */
function renderBreadthCalendar(series) {
    const el = document.getElementById('breadth-calendar');
    if (!el) return;
    if (!series || !series.length) { el.innerHTML = '<div class="breadth-empty">Chưa có data</div>'; return; }

    // Map date → snapshot để tra nhanh
    const map = new Map(series.map(s => [s.date, s]));

    // Tính range ngày: từ firstDate → today (để fill cả ngày trống = empty cell)
    const first = new Date(series[0].date + 'T00:00:00Z');
    const last = new Date(series[series.length - 1].date + 'T00:00:00Z');
    const days = [];
    for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
        const ds = d.toISOString().split('T')[0];
        days.push(ds);
    }

    // Đẩy về thứ 2 đầu (để canh lề lịch). weekday: 0=CN..6=T7. Muốn T2 làm đầu → lùi về T2.
    const firstDow = new Date(days[0] + 'T00:00:00Z').getUTCDay(); // 0=CN
    // Quy ước: T2=0 (đầu tuần). CN=6 → dời sang cuối. CN sẽ thành 6.
    const offset = (firstDow + 6) % 7;
    for (let i = 0; i < offset; i++) days.unshift(null);

    // Cell intensity: theo ratio1Y. bearish mạnh = đỏ đậm, bullish mạnh = xanh đậm.
    const cellHTML = days.map(ds => {
        if (!ds) return '<div class="breadth-cal-cell pad"></div>';
        const s = map.get(ds);
        if (!s) return `<div class="breadth-cal-cell empty" title="${ds}: chưa có data"></div>`;
        const ratio = s.ratio1Y;
        // opacity theo độ lệch khỏi 1.0 (xa 1 = đậm)
        const intensity = Math.min(Math.abs(ratio - 1.0) / 1.0, 1);
        const op = 0.3 + intensity * 0.7;
        const verdict = s.verdict.toLowerCase();
        const tooltip = `${ds}: ratio1N=${ratio.toFixed(2)} (${s.verdict}) · H3T=${s.high3T} L3T=${s.low3T}`;
        return `<div class="breadth-cal-cell ${verdict}" style="--intensity:${op.toFixed(2)}" title="${tooltip}"></div>`;
    }).join('');

    // Header weekday labels (T2-CN)
    const wdLabels = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
        .map(w => `<div class="breadth-cal-wd">${w}</div>`).join('');

    el.innerHTML = `<div class="breadth-cal-grid">${wdLabels}${cellHTML}</div>`;
}

/** Bind range selector. */
function setupBreadthSnapshotEvents() {
    document.querySelectorAll('#breadth-range-btns .breadth-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#breadth-range-btns .breadth-range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            BreadthSnapshotState.range = parseInt(btn.getAttribute('data-range'));
            loadBreadthSnapshot();
        });
    });
}

// =====================================================================
// SEPA SCORING UI (Subsystem #2) + PAPER TRADE UI (Subsystem #5/#6)
// Appended functions — loaded after main app.js
// =====================================================================

const SEPA_STATE = { loaded: false, loading: false, lastData: null };

async function loadSEPA() {
    if (SEPA_STATE.loading) return;
    SEPA_STATE.loading = true;
    const minScore = parseInt(document.getElementById('sepa-min-score') && document.getElementById('sepa-min-score').value || '55');
    const tbody = document.getElementById('sepa-ranking-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px;">Dang tai SEPA ranking...</td></tr>';
    try {
        const resp = await fetch(window.StockAPI.SERVER_BASE + window.StockAPI.SERVER.SEPA_SCAN + '?minScore=' + minScore + '&limit=50&_t=' + Date.now(), { credentials: 'same-origin' });
        const data = await resp.json();
        if (data.success) {
            SEPA_STATE.lastData = data;
            window._sepaLoaded = true;
            renderSEPARanking(data.results || []);
            const meta = document.getElementById('sepa-scan-meta');
            if (meta) meta.textContent = '(' + data.scanned + ' maquet, ' + data.filtered + ' dat)';
        } else {
            if (tbody) tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px;">' + (data.error || 'Loi tai') + '</td></tr>';
        }
    } catch (e) {
        console.error('loadSEPA error:', e);
        if (tbody) tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px;">Loi: ' + e.message + '</td></tr>';
    } finally {
        SEPA_STATE.loading = false;
    }
}

function gradeColor(grade) {
    return { 'A+': '#2e7d32', 'A': '#388e3c', 'B': '#f57f17', 'C': '#ef6c00', 'D': '#c62828' }[grade] || '#666';
}

function renderSEPARanking(results) {
    const tbody = document.getElementById('sepa-ranking-tbody');
    if (!tbody) return;
    if (!results.length) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px;">Khong co ma dat min score</td></tr>';
        return;
    }
    tbody.innerHTML = results.map(function(s, i) {
        const gc = gradeColor(s.grade);
        const changeClass = s.change >= 0 ? 'positive' : 'negative';
        const changePfx = s.change >= 0 ? '+' : '';
        const tt = (s.ta && s.ta.trendTemplatePass) ? 'PASS' : '--';
        const vcp = (s.ta && s.ta.vcp) ? 'VCP' : '--';
        const pp = (s.ta && s.ta.pocketPivot) ? 'PP' : '--';
        const bd = s.breakdown || {};
        const topF = Object.entries(bd).sort(function(a,b){return b[1]-a[1];}).slice(0,3).map(function(e){return e[0]+':'+e[1];}).join(' ');
        return '<tr style="cursor:pointer;" onclick="showSEPADetail(\'' + s.symbol + '\')">' +
            '<td>' + (i+1) + '</td>' +
            '<td class="stock-code"><strong>' + s.symbol + '</strong></td>' +
            '<td><strong style="color:' + gc + ';">' + s.score + '</strong></td>' +
            '<td><span style="background:' + gc + ';color:white;padding:1px 6px;border-radius:3px;font-size:0.75rem;font-weight:600;">' + s.grade + '</span></td>' +
            '<td>' + StockAPI.formatNumber(s.price) + '</td>' +
            '<td class="' + changeClass + '">' + changePfx + s.change + '%</td>' +
            '<td>' + ((s.ta && s.ta.adx) || '--') + '</td>' +
            '<td>' + tt + '</td><td>' + vcp + '</td><td>' + pp + '</td>' +
            '<td style="font-size:0.75rem;color:var(--text-muted);">' + topF + '</td>' +
            '</tr>';
    }).join('');
}

async function showSEPADetail(symbol) {
    const panel = document.getElementById('sepa-detail-panel');
    if (!panel) return;
    panel.style.display = 'block';
    panel.innerHTML = '<div style="color:var(--text-muted);">Dang tai chi tiet ' + symbol + '...</div>';
    try {
        const resp = await fetch(window.StockAPI.SERVER_BASE + window.StockAPI.SERVER.SEPA_SCORE + '/' + symbol + '?_t=' + Date.now(), { credentials: 'same-origin' });
        const data = await resp.json();
        if (!data.success) { panel.innerHTML = 'Loi: ' + data.error; return; }
        const bd = data.breakdown || {};
        const sig = data.signal || {};
        const bdRows = Object.entries(bd).map(function(entry) {
            const k = entry[0], v = entry[1];
            const pct = Math.min(100, v);
            const color = v >= 70 ? '#2e7d32' : v >= 40 ? '#f57f17' : '#c62828';
            return '<div style="display:flex;align-items:center;gap:8px;margin:2px 0;">' +
                '<span style="width:120px;font-size:0.8rem;">' + k + '</span>' +
                '<div style="flex:1;height:10px;background:var(--bg-primary);border-radius:5px;overflow:hidden;">' +
                '<div style="width:' + pct + '%;height:100%;background:' + color + ';"></div></div>' +
                '<span style="width:30px;text-align:right;font-size:0.8rem;">' + v + '</span></div>';
        }).join('');
        const sigHtml = sig.action ? '<div style="margin-top:8px;padding:8px;background:var(--bg-card);border-radius:4px;">' +
            '<strong>Tin hieu: ' + sig.action + '</strong>' +
            (sig.entry ? ' | Entry: ' + StockAPI.formatNumber(sig.entry) : '') +
            (sig.stop ? ' | Stop: ' + StockAPI.formatNumber(sig.stop) : '') +
            (sig.target1 ? ' | Target: ' + StockAPI.formatNumber(sig.target1) : '') +
            '<div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">' + (sig.reason || '') + '</div></div>' : '';
        panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<h4 style="margin:0;">' + symbol + ' - Score ' + data.score + ' (' + data.grade + ')</h4>' +
            '<button onclick="document.getElementById(\'sepa-detail-panel\').style.display=\'none\'" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1.2rem;">x</button>' +
            '</div><div style="margin-top:8px;">' + bdRows + '</div>' + sigHtml;
    } catch (e) {
        panel.innerHTML = 'Loi: ' + e.message;
    }
}

// =====================================================================
// PAPER TRADE UI (Subsystem #5/#6)
// =====================================================================

const PT_STATE = { pfInterval: null };

async function loadPaperTrade() {
    await Promise.all([loadPTStatus(), loadPTPortfolio()]);
    setupPTEvents();
    if (PT_STATE.pfInterval) clearInterval(PT_STATE.pfInterval);
    PT_STATE.pfInterval = setInterval(function() {
        if (AppState.currentTab === 'paper-trade') loadPTPortfolio();
    }, 30000);
}

async function loadPTStatus() {
    try {
        const resp = await fetch(window.StockAPI.SERVER_BASE + window.StockAPI.SERVER.BROKER_STATUS, { credentials: 'same-origin' });
        const data = await resp.json();
        const badge = document.getElementById('pt-mode-badge');
        if (badge) {
            if (data.mode === 'live') {
                badge.textContent = 'LIVE MODE';
                badge.style.background = '#c62828'; badge.style.color = '#ffcdd2';
            } else {
                badge.textContent = 'PAPER MODE';
                badge.style.background = '#1b5e20'; badge.style.color = '#a5d6a7';
            }
        }
        const bm = document.getElementById('pt-broker-mode'); if (bm) bm.textContent = data.mode;
        // NAV từ broker status (paper)
        if (data.nav) {
            const navEl = document.getElementById('pt-nav'); if (navEl) navEl.textContent = StockAPI.formatVND(data.nav.totalValue);
            const csEl = document.getElementById('pt-cash-status'); if (csEl) csEl.textContent = StockAPI.formatVND(data.nav.cash);
        }
        const resp2 = await fetch(window.StockAPI.SERVER_BASE + window.StockAPI.SERVER.AUTOEXEC_STATUS, { credentials: 'same-origin' });
        const ae = await resp2.json();
        const aes = document.getElementById('pt-autoexec-status');
        if (aes) aes.textContent = ae.enabled ? 'ON' : 'OFF';
        const lr = document.getElementById('pt-last-run');
        if (lr) lr.textContent = ae.lastRunAt ? new Date(ae.lastRunAt).toLocaleString('vi-VN') : '--';
    } catch (e) { console.error('loadPTStatus:', e); }
}

async function loadPTPortfolio() {
    try {
        const resp = await fetch(window.StockAPI.SERVER_BASE + window.StockAPI.SERVER.BROKER_PORTFOLIO + '?_t=' + Date.now(), { credentials: 'same-origin' });
        const pf = await resp.json();
        const cashEl = document.getElementById('pt-cash'); if (cashEl) cashEl.textContent = StockAPI.formatVND(pf.cash);
        const totEl = document.getElementById('pt-total'); if (totEl) totEl.textContent = StockAPI.formatVND(pf.totalValue);
        const pcEl = document.getElementById('pt-positions-count'); if (pcEl) pcEl.textContent = (pf.positions || []).length;
        const tbody = document.getElementById('pt-portfolio-tbody');
        if (!tbody) return;
        if (!pf.positions || !pf.positions.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:16px;">Chua co position</td></tr>';
            return;
        }
        tbody.innerHTML = pf.positions.map(function(p) {
            const pnlClass = p.pnl >= 0 ? 'positive' : 'negative';
            const pnlPfx = p.pnl >= 0 ? '+' : '';
            return '<tr><td class="stock-code"><strong>' + p.symbol + '</strong></td>' +
                '<td>' + p.qty + '</td>' +
                '<td>' + StockAPI.formatNumber(p.avgCost) + '</td>' +
                '<td class="' + pnlClass + '">' + pnlPfx + StockAPI.formatCurrency(p.pnl) + '</td>' +
                '<td>' + StockAPI.formatVND(p.value) + '</td></tr>';
        }).join('');
    } catch (e) { console.error('loadPTPortfolio:', e); }
}

async function placePaperOrder() {
    const order = {
        symbol: (document.getElementById('pt-symbol').value || '').toUpperCase().trim(),
        side: document.getElementById('pt-side').value,
        type: document.getElementById('pt-type').value,
        qty: parseInt(document.getElementById('pt-qty').value),
        price: parseFloat(document.getElementById('pt-price').value) || null
    };
    const resultEl = document.getElementById('pt-order-result');
    if (!order.symbol || !order.qty) { if (resultEl) { resultEl.textContent = 'Can ma + so luong'; resultEl.style.color = '#f57f17'; } return; }
    if (resultEl) { resultEl.textContent = 'Dang dat lenh...'; resultEl.style.color = 'var(--text-muted)'; }
    try {
        const resp = await fetch(window.StockAPI.SERVER_BASE + window.StockAPI.SERVER.BROKER_PLACE_ORDER, {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(order)
        });
        const data = await resp.json();
        if (data.success && data.order) {
            if (resultEl) { resultEl.innerHTML = 'OK ' + data.order.status + ' - ' + data.order.symbol + ' ' + data.order.side + ' ' + data.order.filledQty + '@' + StockAPI.formatNumber(data.order.fillPrice); resultEl.style.color = '#2e7d32'; }
            loadPTPortfolio();
        } else {
            if (resultEl) { resultEl.textContent = 'Loi ' + (data.error || (data.order && data.order.error) || ''); resultEl.style.color = '#c62828'; }
        }
    } catch (e) {
        if (resultEl) { resultEl.textContent = 'Loi ' + e.message; resultEl.style.color = '#c62828'; }
    }
}

async function fillFromSignal() {
    try {
        const resp = await fetch(window.StockAPI.SERVER_BASE + '/api/signals?limit=5&_t=' + Date.now(), { credentials: 'same-origin' });
        const data = await resp.json();
        const buy = (data.results || []).find(function(r){return r.action === 'BUY';});
        if (!buy) { const r = document.getElementById('pt-order-result'); if (r) r.textContent = 'Khong co BUY signal'; return; }
        document.getElementById('pt-symbol').value = buy.symbol;
        document.getElementById('pt-side').value = 'BUY';
        document.getElementById('pt-type').value = 'LO';
        document.getElementById('pt-price').value = (buy.signal && buy.signal.entry) || buy.price;
        const stop = buy.signal && buy.signal.stop;
        if (stop) {
            const riskPerShare = buy.signal.entry - stop;
            const shares = Math.floor((1000000 * 0.01 / riskPerShare) / 100) * 100;
            document.getElementById('pt-qty').value = Math.max(100, shares);
        }
        const r = document.getElementById('pt-order-result'); if (r) r.textContent = 'Da fill tu ' + buy.symbol + ' (score ' + buy.score + ')';
    } catch (e) { const r = document.getElementById('pt-order-result'); if (r) r.textContent = 'Loi: ' + e.message; }
}

async function autoexecAction(action) {
    const url = action === 'enable' ? window.StockAPI.SERVER.AUTOEXEC_ENABLE
              : action === 'disable' ? window.StockAPI.SERVER.AUTOEXEC_DISABLE
              : window.StockAPI.SERVER.AUTOEXEC_RUN_ONCE;
    const body = (action === 'enable') ? { confirm: 'I_UNDERSTAND_LIVE_TRADE' } : {};
    try {
        const resp = await fetch(window.StockAPI.SERVER_BASE + url, {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await resp.json();
        loadPTStatus();
        loadPTPortfolio();
        const notice = document.getElementById('pt-notice');
        if (action === 'run-once' && data.result) {
            const r = data.result;
            const msg = r.placed != null
                ? 'Run once: ' + r.placed + ' lệnh đặt (' + (r.brokerMode || 'paper') + ')'
                : 'Skip: ' + (r.skipped || 'không có lệnh');
            const rr = document.getElementById('pt-order-result');
            if (rr) { rr.textContent = msg; rr.style.color = r.placed > 0 ? '#2e7d32' : '#f57f17'; }
            if (notice) {
                if (r.skipped && r.skipped.indexOf('phiên') >= 0) {
                    notice.style.display = 'block';
                    notice.innerHTML = '⚠️ Ngoài phiên giao dịch (9-15h VN, T2-T6). Auto-exec chỉ đặt lệnh trong phiên. Lệnh sẽ chạy tự động khi vào phiên.';
                } else if (r.placed > 0) {
                    notice.style.display = 'block';
                    notice.innerHTML = '✅ Đã đặt ' + r.placed + ' lệnh. Xem portfolio bên phải.';
                } else { notice.style.display = 'none'; }
            }
        }
        if (action === 'enable') {
            if (notice) {
                notice.style.display = 'block';
                notice.innerHTML = data.enabled
                    ? '🟢 Auto-exec ĐÃ BẬT. Hệ thống sẽ tự quét signals và đặt lệnh (paper) mỗi 5 phút TRONG PHIÊN (9-15h VN). Ngoài phiên sẽ skip.'
                    : 'Auto-exec chưa bật được. Kiểm tra lại.';
            }
        }
        if (action === 'disable' && notice) {
            notice.style.display = 'block';
            notice.innerHTML = '🔴 Kill-switch ON. Auto-exec đã dừng.';
        }
    } catch (e) { console.error('autoexecAction:', e); }
}

async function resetPaperNav() {
    const capital = parseFloat(document.getElementById('pt-capital-input').value) || 1000000000;
    if (!confirm('Reset NAV về ' + StockAPI.formatCurrency(capital) + '? (Xóa toàn bộ positions/orders paper hiện tại)')) return;
    try {
        const resp = await fetch(window.StockAPI.SERVER_BASE + '/api/broker/reset-nav', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capital })
        });
        const data = await resp.json();
        if (data.success) {
            loadPTStatus(); loadPTPortfolio();
            const r = document.getElementById('pt-order-result');
            if (r) { r.textContent = 'NAV reset: ' + StockAPI.formatVND(data.cash); r.style.color = '#2e7d32'; }
        }
    } catch (e) { console.error('resetPaperNav:', e); }
}

function setupPTEvents() {
    if (window._ptEventsWired) return;
    window._ptEventsWired = true;
    const po = document.getElementById('pt-btn-place-order'); if (po) po.addEventListener('click', placePaperOrder);
    const fs = document.getElementById('pt-btn-from-signal'); if (fs) fs.addEventListener('click', fillFromSignal);
    const rp = document.getElementById('pt-btn-refresh-pf'); if (rp) rp.addEventListener('click', loadPTPortfolio);
    const rn = document.getElementById('pt-btn-reset-nav'); if (rn) rn.addEventListener('click', resetPaperNav);
    const ro = document.getElementById('pt-btn-run-once'); if (ro) ro.addEventListener('click', function(){autoexecAction('run-once');});
    const en = document.getElementById('pt-btn-enable'); if (en) en.addEventListener('click', function(){autoexecAction('enable');});
    const di = document.getElementById('pt-btn-disable');
    if (di) di.addEventListener('click', function(){ if (confirm('Kill-switch: dung auto-exec tuc thi?')) autoexecAction('disable'); });
    const sl = document.getElementById('btn-load-sepa'); if (sl) sl.addEventListener('click', function(){ window._sepaLoaded = false; loadSEPA(); });
}
