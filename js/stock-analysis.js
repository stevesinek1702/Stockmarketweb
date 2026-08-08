/**
 * stock-analysis.js — Tab "Phân Tích Cổ Phiếu"
 *
 * Features:
 *   - Autocomplete search (lazy-load from /api/all-stocks, recent symbols, fuzzy match)
 *   - Inline KLineCharts candlestick chart (reuse KLineCharts library from CDN)
 *   - SEPA score card, Signal card, TA detail card
 *   - Ichimoku & Elliott Wave summary cards
 *   - Investor flow chart (reuses StockCharts.renderStockInvestorFlowChart)
 *   - Real-time quote strip
 *
 * Public API: window.StockAnalysis.init()
 */
(function () {
    'use strict';

    // ── Constants ────────────────────────────────────────────────────────────
    var RECENT_KEY = 'sa_recent_symbols';
    var MAX_RECENT = 5;
    var DEBOUNCE_MS = 300;
    var HISTORY_DAYS = 365;
    var ALL_STOCKS_CACHE_TTL = 5 * 60 * 1000; // 5 phút

    var INDICATOR_CATALOG = [
        { name: 'MA', label: 'Moving Average' },
        { name: 'EMA', label: 'EMA' },
        { name: 'SMA', label: 'SMA' },
        { name: 'BBI', label: 'BBI' },
        { name: 'BOLL', label: 'Bollinger Bands' },
        { name: 'SAR', label: 'Parabolic SAR' },
        { name: 'VOL', label: 'Volume' },
        { name: 'MACD', label: 'MACD' },
        { name: 'KDJ', label: 'KDJ' },
        { name: 'RSI', label: 'RSI' },
        { name: 'BIAS', label: 'BIAS' },
        { name: 'BRAR', label: 'BRAR' },
        { name: 'CCI', label: 'CCI' },
        { name: 'DMI', label: 'DMI' },
        { name: 'CR', label: 'CR' },
        { name: 'PSY', label: 'PSY' },
        { name: 'DMA', label: 'DMA' },
        { name: 'TRIX', label: 'TRIX' },
        { name: 'OBV', label: 'OBV' },
        { name: 'VR', label: 'VR' },
        { name: 'WR', label: 'Williams %R' },
        { name: 'MTM', label: 'Momentum' },
        { name: 'EMV', label: 'EMV' },
        { name: 'ROC', label: 'ROC' },
        { name: 'PVT', label: 'PVT' },
        { name: 'AO', label: 'AO' }
    ];

    var MAIN_CAPABLE = ['MA', 'EMA', 'SMA', 'BBI', 'BOLL', 'SAR'];

    // ── State ────────────────────────────────────────────────────────────────
    var state = {
        currentSymbol: null,
        isLoading: false,
        allStocks: null,
        allStocksTimestamp: 0,
        acHighlightIdx: -1,
        acItems: [],
        debounceTimer: null,
        chart: null,
        chartEl: null,
        mainCreated: {},
        subPaneIds: {},
        indicators: { main: ['MA'], sub: ['VOL', 'MACD'] },
        finQuarters: 8
    };

    // ── Helpers ─────────────────────────────────────────────────────────────
    function $(sel) { return document.querySelector(sel); }
    function $$(sel) { return document.querySelectorAll(sel); }

    function formatNumber(v) {
        if (v === null || v === undefined || v === '') return '--';
        var n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n.toLocaleString('vi-VN') : '--';
    }

    function formatVND(v) {
        if (v === null || v === undefined) return '--';
        var n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) return '--';
        if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + ' tỷ';
        if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + ' triệu';
        return n.toLocaleString('vi-VN');
    }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // Trung bình volume từ KLine data bars
    function avgVol(bars) {
        if (!Array.isArray(bars) || !bars.length) return null;
        var sum = 0, n = 0;
        for (var i = 0; i < bars.length; i++) {
            var v = bars[i] && bars[i].volume;
            if (typeof v === 'number' && Number.isFinite(v)) { sum += v; n++; }
        }
        return n ? sum / n : null;
    }

    function gradeColor(grade) {
        if (!grade) return '#666';
        var g = grade.toUpperCase();
        if (g.startsWith('A+')) return '#00e676';
        if (g.startsWith('A')) return '#2ee68a';
        if (g.startsWith('B+')) return '#66bb6a';
        if (g.startsWith('B')) return '#ffcc00';
        if (g.startsWith('C+')) return '#ffa726';
        if (g.startsWith('C')) return '#ff9800';
        if (g.startsWith('D')) return '#ff5c78';
        return '#666';
    }

    function actionClass(action) {
        if (!action) return 'none';
        var a = action.toUpperCase();
        if (a === 'BUY' || a === 'MUA' || a === 'STRONG BUY') return 'buy';
        if (a === 'SELL' || a === 'BÁN' || a === 'STRONG SELL') return 'sell';
        if (a === 'WATCH' || a === 'GIÁM SÁT' || a === 'HOLD') return 'watch';
        return 'none';
    }

    function verdictClass(v) {
        if (!v) return 'neutral';
        var x = v.toLowerCase();
        if (x.indexOf('bullish') !== -1 || x.indexOf('tăng') !== -1) return 'bullish';
        if (x.indexOf('bearish') !== -1 || x.indexOf('giảm') !== -1) return 'bearish';
        return 'neutral';
    }

    function tagClass(val) {
        var n = typeof val === 'number' ? val : Number(val);
        if (!Number.isFinite(n)) return 'neutral';
        if (n >= 1) return 'pass';
        if (n <= -1) return 'fail';
        return 'neutral';
    }

    function barColor(v) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '#555';
        if (v >= 70) return '#2ee68a';
        if (v >= 40) return '#ffcc00';
        return '#ff5c78';
    }

    // ── Recent Symbols (localStorage) ───────────────────────────────────────
    function getRecent() {
        try {
            var raw = localStorage.getItem(RECENT_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    function addRecent(symbol) {
        var list = getRecent().filter(function (s) { return s !== symbol; });
        list.unshift(symbol);
        if (list.length > MAX_RECENT) list = list.slice(0, MAX_RECENT);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
    }

    function renderRecentTags() {
        var wrap = $('#sa-recent-tags');
        if (!wrap) return;
        var list = getRecent();
        if (!list.length) { wrap.innerHTML = ''; return; }
        wrap.innerHTML = list.map(function (s) {
            return '<button class="sa-recent-tag" data-symbol="' + esc(s) + '">' + esc(s) + '</button>';
        }).join('');
    }

    // ── All Stocks (lazy-load + cache) ───────────────────────────────────────
    function loadAllStocks() {
        var now = Date.now();
        if (state.allStocks && (now - state.allStocksTimestamp) < ALL_STOCKS_CACHE_TTL) {
            return Promise.resolve(state.allStocks);
        }
        return fetch(window.StockAPI.SERVER_BASE + window.StockAPI.SERVER.ALL_STOCKS + '?_t=' + now, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var stocks = [];
                if (Array.isArray(data)) stocks = data;
                else if (data && Array.isArray(data.stocks)) stocks = data.stocks;
                else if (data && data.success && Array.isArray(data.data)) stocks = data.data;
                // Normalize: { symbol, name } or just strings
                state.allStocks = stocks.map(function (s) {
                    if (typeof s === 'string') return { symbol: s, name: '' };
                    return { symbol: s.symbol || s.code || '', name: s.name || s.companyName || '' };
                }).filter(function (s) { return s.symbol; });
                state.allStocksTimestamp = now;
                return state.allStocks;
            })
            .catch(function () { return state.allStocks || []; });
    }

    // ── Autocomplete ────────────────────────────────────────────────────────
    function fuzzyMatch(query, symbol, name) {
        var q = query.toLowerCase();
        var sym = symbol.toLowerCase();
        var nm = name.toLowerCase();
        // Exact symbol prefix → highest
        if (sym.indexOf(q) === 0) return 3;
        // Symbol contains
        if (sym.indexOf(q) !== -1) return 2;
        // Name contains
        if (nm.indexOf(q) !== -1) return 1;
        return 0;
    }

    function showAC(items) {
        var dd = $('#sa-ac-dropdown');
        if (!dd) return;
        state.acItems = items;
        state.acHighlightIdx = -1;
        if (!items.length) { dd.style.display = 'none'; return; }
        dd.innerHTML = items.slice(0, 10).map(function (s, i) {
            return '<div class="sa-ac-item" data-idx="' + i + '" data-symbol="' + esc(s.symbol) + '">' +
                '<span class="sa-ac-sym">' + esc(s.symbol) + '</span>' +
                (s.name ? '<span class="sa-ac-name">' + esc(s.name) + '</span>' : '') +
                '</div>';
        }).join('');
        dd.style.display = 'block';
    }

    function hideAC() {
        var dd = $('#sa-ac-dropdown');
        if (dd) dd.style.display = 'none';
        state.acItems = [];
        state.acHighlightIdx = -1;
    }

    function highlightAC(idx) {
        var dd = $('#sa-ac-dropdown');
        if (!dd) return;
        var items = dd.querySelectorAll('.sa-ac-item');
        items.forEach(function (el, i) {
            el.classList.toggle('sa-ac-highlight', i === idx);
        });
    }

    function onSearchInput(e) {
        var val = (e.target.value || '').trim();
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        if (!val) { hideAC(); return; }
        state.debounceTimer = setTimeout(function () {
            loadAllStocks().then(function (stocks) {
                var scored = stocks.map(function (s) {
                    return { stock: s, score: fuzzyMatch(val, s.symbol, s.name) };
                }).filter(function (x) { return x.score > 0; })
                  .sort(function (a, b) { return b.score - a.score || a.stock.symbol.localeCompare(b.stock.symbol); })
                  .map(function (x) { return x.stock; });
                showAC(scored);
            });
        }, DEBOUNCE_MS);
    }

    function onSearchKeydown(e) {
        var dd = $('#sa-ac-dropdown');
        if (!dd || dd.style.display === 'none') {
            if (e.key === 'Enter') {
                e.preventDefault();
                analyzeFromInput();
            }
            return;
        }
        var count = Math.min(state.acItems.length, 10);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            state.acHighlightIdx = (state.acHighlightIdx + 1) % count;
            highlightAC(state.acHighlightIdx);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            state.acHighlightIdx = (state.acHighlightIdx - 1 + count) % count;
            highlightAC(state.acHighlightIdx);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (state.acHighlightIdx >= 0 && state.acHighlightIdx < state.acItems.length) {
                selectSymbol(state.acItems[state.acHighlightIdx].symbol);
            } else {
                analyzeFromInput();
            }
        } else if (e.key === 'Escape') {
            hideAC();
        }
    }

    function onACClick(e) {
        var item = e.target.closest('.sa-ac-item');
        if (!item) return;
        var sym = item.dataset.symbol;
        if (sym) selectSymbol(sym);
    }

    function onRecentClick(e) {
        var tag = e.target.closest('.sa-recent-tag');
        if (!tag) return;
        var sym = tag.dataset.symbol;
        if (sym) selectSymbol(sym);
    }

    function analyzeFromInput() {
        var input = $('#sa-search-input');
        if (!input) return;
        var sym = (input.value || '').trim().toUpperCase();
        if (sym) selectSymbol(sym);
    }

    function selectSymbol(symbol) {
        var input = $('#sa-search-input');
        if (input) input.value = symbol;
        hideAC();
        addRecent(symbol);
        renderRecentTags();
        loadAnalysis(symbol);
    }

    // ── Inline KLineChart ───────────────────────────────────────────────────
    function ensureKLineCharts() {
        if (window.klinecharts) return Promise.resolve(window.klinecharts);
        return new Promise(function (resolve, reject) {
            var urls = [
                'https://cdn.jsdelivr.net/npm/klinecharts@9.8.10/dist/umd/klinecharts.min.js',
                'https://unpkg.com/klinecharts@9.8.10/dist/umd/klinecharts.min.js'
            ];
            (function tryNext() {
                if (window.klinecharts) return resolve(window.klinecharts);
                if (!urls.length) { reject(new Error('Failed to load KLineCharts')); return; }
                var s = document.createElement('script');
                s.src = urls.shift();
                s.async = true;
                s.onload = function () { if (window.klinecharts) resolve(window.klinecharts); else tryNext(); };
                s.onerror = function () { tryNext(); };
                document.head.appendChild(s);
            })();
        });
    }

    function toKline(raw) {
        if (!Array.isArray(raw)) return [];
        var byTs = new Map();
        for (var i = 0; i < raw.length; i++) {
            var r = raw[i];
            if (!r || typeof r !== 'object') continue;
            var d = r.Date || r.date || r.time;
            if (!d) continue;
            var ts = (d instanceof Date) ? d.getTime() : Date.parse(d);
            if (isNaN(ts)) continue;
            var open = r.Open != null ? Number(r.Open) : (r.PriceOpen != null ? Number(r.PriceOpen) : Number(r.open));
            var high = r.High != null ? Number(r.High) : (r.PriceHigh != null ? Number(r.PriceHigh) : Number(r.high));
            var low = r.Low != null ? Number(r.Low) : (r.PriceLow != null ? Number(r.PriceLow) : Number(r.low));
            var close = r.Close != null ? Number(r.Close) : (r.PriceClose != null ? Number(r.PriceClose) : Number(r.close));
            if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
            var vol = r.Volume != null ? Number(r.Volume) : (r.TotalVolume != null ? Number(r.TotalVolume) : Number(r.volume));
            byTs.set(ts, {
                timestamp: ts, open: open,
                high: Math.max(open, high, low, close),
                low: Math.min(open, high, low, close),
                close: close, volume: Number.isFinite(vol) ? vol : 0
            });
        }
        return Array.from(byTs.values()).sort(function (a, b) { return a.timestamp - b.timestamp; });
    }

    function chartStyles() {
        var cs = getComputedStyle(document.documentElement);
        function v(name, fb) { var x = cs.getPropertyValue(name).trim(); return x || fb; }
        var grid = v('--border-color', '#2a2a55');
        var text = v('--text-secondary', '#9999bb');
        var up = v('--accent-green', '#2ee68a');
        var down = v('--accent-red', '#ff5c78');
        return {
            grid: { horizontal: { color: grid }, vertical: { color: grid } },
            candle: {
                type: 'candle_solid',
                bar: {
                    upColor: up, downColor: down, noChangeColor: '#888',
                    upBorderColor: up, downBorderColor: down, noChangeBorderColor: '#888',
                    upWickColor: up, downWickColor: down, noChangeWickColor: '#888'
                },
                priceMark: { high: { color: text }, low: { color: text }, last: { line: { color: text }, text: { color: '#fff' } } },
                tooltip: { text: { color: text } }
            },
            indicator: { tooltip: { text: { color: text } }, lastValueMark: { text: { color: '#fff' } } },
            xAxis: { axisLine: { color: grid }, tickLine: { color: grid }, tickText: { color: text } },
            yAxis: { axisLine: { color: grid }, tickLine: { color: grid }, tickText: { color: text } },
            separator: { color: grid },
            crosshair: { horizontal: { line: { color: text }, text: { backgroundColor: down } }, vertical: { line: { color: text }, text: { backgroundColor: down } } }
        };
    }

    function destroyChart() {
        if (state.chart) {
            try { state.chart.dispose(); } catch (e) { /* ignore */ }
            state.chart = null;
        }
        state.chartEl = null;
        state.mainCreated = {};
        state.subPaneIds = {};
    }

    function applyChartIndicators() {
        if (!state.chart) return;
        var cfg = state.indicators;
        // Main-pane overlays
        MAIN_CAPABLE.forEach(function (name) {
            var on = cfg.main.indexOf(name) !== -1;
            if (on && !state.mainCreated[name]) {
                state.chart.createIndicator(name, true, { id: 'candle_pane' });
                state.mainCreated[name] = true;
            } else if (!on && state.mainCreated[name]) {
                try { state.chart.removeIndicator('candle_pane', name); } catch (e) { /* ignore */ }
                state.mainCreated[name] = false;
            }
        });
        // Sub-pane indicators
        var subSet = {};
        cfg.sub.forEach(function (name) {
            subSet[name] = true;
            if (!state.subPaneIds[name]) {
                var paneId = state.chart.createIndicator(name, false, { height: 80 });
                if (paneId) state.subPaneIds[name] = paneId;
            }
        });
        Object.keys(state.subPaneIds).forEach(function (name) {
            if (!subSet[name]) {
                try { state.chart.removeIndicator(state.subPaneIds[name], name); } catch (e) { /* ignore */ }
                delete state.subPaneIds[name];
            }
        });
    }

    function renderChartTopbar(symbol) {
        var bar = $('#sa-chart-topbar');
        if (!bar) return;
        bar.innerHTML = '<span class="sa-chart-symbol">' + esc(symbol) + ' · Daily</span>' +
            '<span class="sa-chart-indicators">' +
            INDICATOR_CATALOG.map(function (ind) {
                var isActive = state.indicators.main.indexOf(ind.name) !== -1 || state.indicators.sub.indexOf(ind.name) !== -1;
                return '<button class="sa-ind-chip' + (isActive ? ' active' : '') + '" data-ind="' + ind.name + '" title="' + esc(ind.label) + '">' + esc(ind.name) + '</button>';
            }).join('') +
            '</span>';
    }

    function onChartTopbarClick(e) {
        var chip = e.target.closest('.sa-ind-chip');
        if (!chip) return;
        var name = chip.dataset.ind;
        if (!name) return;
        var isMain = MAIN_CAPABLE.indexOf(name) !== -1;
        var list = isMain ? state.indicators.main : state.indicators.sub;
        var idx = list.indexOf(name);
        if (idx === -1) list.push(name); else list.splice(idx, 1);
        chip.classList.toggle('active', list.indexOf(name) !== -1);
        applyChartIndicators();
    }

    async function renderInlineChart(symbol) {
        var container = $('#sa-chart-container');
        if (!container) return;
        // Destroy previous chart
        destroyChart();
        container.innerHTML = '<div class="sa-chart-skeleton"></div>';

        try {
            var klc = await ensureKLineCharts();
            var df = window.StockAPI && window.StockAPI.dataFetcher;
            var raw = [];
            if (df && typeof df.fetchHistoricalOHLC === 'function') {
                raw = await df.fetchHistoricalOHLC(symbol, HISTORY_DAYS);
            } else if (df && typeof df.fetchHistoricalData === 'function') {
                raw = await df.fetchHistoricalData(symbol, HISTORY_DAYS);
            }
            var data = toKline(raw);
            if (!data.length) {
                container.innerHTML = '<div class="sa-chart-skeleton" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);">Không có dữ liệu biểu đồ cho ' + esc(symbol) + '</div>';
                return null;
            }

            container.innerHTML = '';
            renderChartTopbar(symbol);

            // Bind chip clicks
            var topbar = $('#sa-chart-topbar');
            if (topbar) topbar.addEventListener('click', onChartTopbarClick);

            // Create chart element
            var chartEl = document.createElement('div');
            chartEl.style.width = '100%';
            chartEl.style.height = '420px';
            container.appendChild(chartEl);
            state.chartEl = chartEl;

            var chart = klc.init(chartEl, { styles: chartStyles(), locale: 'en-US' });
            state.chart = chart;
            chart.applyNewData(data);
            applyChartIndicators();

            // Resize observer
            if (typeof ResizeObserver !== 'undefined') {
                var ro = new ResizeObserver(function () {
                    if (state.chart) try { state.chart.resize(); } catch (e) { /* ignore */ }
                });
                try { ro.observe(chartEl); } catch (e) { /* ignore */ }
            }
            setTimeout(function () { if (state.chart) try { state.chart.resize(); } catch (e) { /* ignore */ } }, 100);

            // Tính 52-week high/low từ historical data để hiển thị ở fundamentals card
            var yearBars = data.slice(-252);
            if (yearBars.length) {
                var yearHigh = Math.max.apply(null, yearBars.map(function (d) { return d.high; }));
                var yearLow = Math.min.apply(null, yearBars.map(function (d) { return d.low; }));
                return { yearHigh: yearHigh, yearLow: yearLow, avgVol: avgVol(yearBars) };
            }
            return null;
        } catch (err) {
            console.error('renderInlineChart error:', err);
            container.innerHTML = '<div class="sa-chart-skeleton" style="display:flex;align-items:center;justify-content:center;color:var(--accent-red);">Lỗi tải biểu đồ: ' + esc(err.message) + '</div>';
            return null;
        }
        return null;
    }

    // ── Data Loading Orchestrator ───────────────────────────────────────────
    async function loadAnalysis(symbol) {
        if (state.isLoading) return;
        state.isLoading = true;
        state.currentSymbol = symbol;

        // Show skeleton
        showLoadingState(symbol);

        // Fetch chart in parallel with analysis data
        var chartPromise = renderInlineChart(symbol);

        var base = window.StockAPI.SERVER_BASE;
        var endpoints = [
            base + window.StockAPI.SERVER.SEPA_SCORE + '/' + symbol + '?_t=' + Date.now(),
            base + window.StockAPI.SERVER.SIGNAL + '/' + symbol + '?_t=' + Date.now(),
            base + window.StockAPI.SERVER.ICHIMOKU + '/' + symbol + '?_t=' + Date.now(),
            base + window.StockAPI.SERVER.ELLIOTT + '/' + symbol + '?_t=' + Date.now()
        ];

        try {
            var results = await Promise.allSettled(endpoints.map(function (url) {
                return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
            }));

            var sepaData = results[0].status === 'fulfilled' ? results[0].value : null;
            var signalData = results[1].status === 'fulfilled' ? results[1].value : null;
            var ichimokuData = results[2].status === 'fulfilled' ? results[2].value : null;
            var elliottData = results[3].status === 'fulfilled' ? results[3].value : null;

            // Render main cards
            renderScoreCard(sepaData, symbol);
            renderSignalCard(signalData);
            renderTADetail(sepaData);
            renderIchimokuSummary(ichimokuData);
            renderElliottSummary(elliottData);

            var chartStats = await chartPromise; // {yearHigh, yearLow, avgVol} | null

            // Serial fetches: quote → header strip + fundamentals, then investor flow + intraday
            var quoteData = null;
            try {
                var quoteResp = await fetch(base + window.StockAPI.SERVER.QUOTES + '?symbols=' + symbol + '&_t=' + Date.now(), { credentials: 'same-origin' });
                quoteData = await quoteResp.json();
            } catch (e) { console.warn('Quote fetch failed:', e); }

            renderHeaderStrip(quoteData, symbol);
            renderFundamentals(quoteData, chartStats);

            // Fetch investor flow + intraday + financials in parallel
            var flowPromise = (function () {
                return fetch(base + window.StockAPI.SERVER.STOCK_INVESTOR_FLOW + '?symbol=' + symbol + '&_t=' + Date.now(), { credentials: 'same-origin' })
                    .then(function (r) { return r.json(); })
                    .then(function (d) { renderInvestorFlowChart(d); })
                    .catch(function (e) { console.warn('Investor flow fetch failed:', e); });
            })();

            var intradayPromise = (function () {
                return fetch(base + window.StockAPI.SERVER.INTRADAY + '?symbol=' + symbol + '&_t=' + Date.now(), { credentials: 'same-origin' })
                    .then(function (r) { return r.json(); })
                    .then(function (d) { renderIntradayChart(d, symbol); })
                    .catch(function (e) { console.warn('Intraday fetch failed:', e); });
            })();

            var finPromise = fetchFinancials(symbol, state.finQuarters);

            await Promise.all([flowPromise, intradayPromise, finPromise]);

        } catch (err) {
            console.error('loadAnalysis error:', err);
        } finally {
            state.isLoading = false;
        }
    }

    // ── Loading / Empty State ────────────────────────────────────────────────
    function showLoadingState(symbol) {
        state._lastFinancials = null; // reset financials cache for new symbol
        // Info column skeletons
        var infoCol = $('#sa-info-col');
        if (infoCol) {
            infoCol.innerHTML =
                '<div class="sa-card-skeleton"></div>' +
                '<div class="sa-card-skeleton"></div>' +
                '<div class="sa-card-skeleton"></div>';
        }
        // Middle row skeletons
        var midRow = $('#sa-middle-row');
        if (midRow) {
            midRow.innerHTML = '<div class="sa-card-skeleton"></div><div class="sa-card-skeleton"></div>';
        }
        // Flow chart skeleton
        var flowCard = $('#sa-flow-card');
        if (flowCard) flowCard.innerHTML = '<div class="sa-card-skeleton" style="height:200px;"></div>';
        // Header strip skeleton
        var headerStrip = $('#sa-header-strip');
        if (headerStrip) headerStrip.innerHTML = '<div class="sa-card-skeleton" style="height:60px;flex:1;"></div>';
        // Fundamentals skeleton
        var fund = $('#sa-fundamentals');
        if (fund) fund.innerHTML = Array(6).fill('<div class="sa-card-skeleton" style="height:62px;"></div>').join('');
        // Intraday skeleton
        var intra = $('#sa-intraday-card');
        if (intra) intra.innerHTML = '<div class="sa-card-skeleton" style="height:180px;"></div>';
        // Financials skeleton
        var finCard = $('#sa-financials-card');
        if (finCard) finCard.innerHTML = '<div class="sa-card-skeleton" style="height:200px;"></div>';
    }

    function showEmptyState() {
        var layout = $('#sa-layout');
        if (!layout) return;
        layout.innerHTML = '<div class="sa-empty-state">' +
            '<div class="sa-empty-icon">🔍</div>' +
            '<div class="sa-empty-text">Nhập mã cổ phiếu để bắt đầu phân tích</div>' +
            '<div class="sa-empty-sub">Gõ mã (VD: FPT, VCB, HPG) vào ô tìm kiếm phía trên</div>' +
            '</div>';
        var hs = $('#sa-header-strip'); if (hs) hs.innerHTML = '';
        var fund = $('#sa-fundamentals'); if (fund) fund.innerHTML = '';
        var intra = $('#sa-intraday-card'); if (intra) intra.innerHTML = '';
        var finCard = $('#sa-financials-card'); if (finCard) finCard.innerHTML = '';
        var midRow = $('#sa-middle-row'); if (midRow) midRow.innerHTML = '';
        var flow = $('#sa-flow-card'); if (flow) flow.innerHTML = '';
    }

    // ── Render: SEPA Score Card ─────────────────────────────────────────────
    function renderScoreCard(data, symbol) {
        var card = $('#sa-score-card');
        if (!card) return;
        if (!data || !data.success) {
            card.innerHTML = '<div class="sa-card-title">📊 SEPA Score</div><div style="color:var(--text-muted);padding:12px;">Không có dữ liệu</div>';
            return;
        }

        var score = data.score || 0;
        var grade = data.grade || '--';
        var gc = gradeColor(grade);
        var bd = data.breakdown || {};
        var pct = Math.min(100, Math.max(0, score));

        var bdHtml = Object.keys(bd).map(function (k) {
            var v = bd[k];
            var vNum = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(vNum)) vNum = 0;
            var p = Math.min(100, Math.max(0, vNum));
            var c = barColor(vNum);
            return '<div class="sa-bd-row">' +
                '<span class="sa-bd-label">' + esc(k) + '</span>' +
                '<div class="sa-bd-bar"><div class="sa-bd-fill" style="width:' + p + '%;background:' + c + ';"></div></div>' +
                '<span class="sa-bd-value">' + vNum + '</span>' +
                '</div>';
        }).join('');

        card.innerHTML = '<div class="sa-card-title">📊 SEPA Score — ' + esc(symbol) + '</div>' +
            '<div class="sa-score-row">' +
            '<div class="sa-score-circle" style="background:conic-gradient(' + gc + ' 0% ' + pct + '%, rgba(255,255,255,0.08) ' + pct + '% 100%);">' +
            '<div class="sa-score-inner">' +
            '<div class="sa-score-num" style="color:' + gc + ';">' + score + '</div>' +
            '</div></div>' +
            '<span class="sa-grade-badge" style="background:' + gc + ';color:#000;">' + esc(grade) + '</span>' +
            '</div>' +
            '<div class="sa-breakdown">' + bdHtml + '</div>';
    }

    // ── Render: Signal Card ─────────────────────────────────────────────────
    function renderSignalCard(data) {
        var card = $('#sa-signal-card');
        if (!card) return;
        if (!data || !data.success) {
            card.innerHTML = '<div class="sa-card-title">📡 Tín Hiệu</div><div style="color:var(--text-muted);padding:12px;">Không có dữ liệu</div>';
            return;
        }

        var sig = data.signal || data;
        var action = sig.action || '--';
        var cls = actionClass(action);
        var entry = sig.entry || sig.Entry;
        var stop = sig.stop || sig.Stop;
        var target1 = sig.target1 || sig.target1Price || sig.Target1;
        var target2 = sig.target2 || sig.target2Price || sig.Target2;
        var target3 = sig.target3 || sig.target3Price || sig.Target3;
        var reason = sig.reason || sig.Reason || '';
        var positionSize = sig.positionSize || sig.position_size || '';
        var riskReward = '';
        if (entry && stop && target1) {
            var rr = (Math.abs(Number(target1) - Number(entry)) / Math.abs(Number(entry) - Number(stop))).toFixed(1);
            riskReward = rr;
        }

        var gridHtml = '';
        if (entry != null) gridHtml += '<div class="sa-signal-grid"><span class="sa-sg-label">Entry</span><span class="sa-sg-value">' + formatNumber(entry) + '</span></div>';
        if (target1 != null) gridHtml += '<div class="sa-signal-grid"><span class="sa-sg-label">TP1</span><span class="sa-sg-value" style="color:var(--accent-green);">' + formatNumber(target1) + '</span></div>';
        if (target2 != null) gridHtml += '<div class="sa-signal-grid"><span class="sa-sg-label">TP2</span><span class="sa-sg-value" style="color:var(--accent-green);">' + formatNumber(target2) + '</span></div>';
        if (target3 != null) gridHtml += '<div class="sa-signal-grid"><span class="sa-sg-label">TP3</span><span class="sa-sg-value" style="color:var(--accent-green);">' + formatNumber(target3) + '</span></div>';
        if (stop != null) gridHtml += '<div class="sa-signal-grid"><span class="sa-sg-label">Stop Loss</span><span class="sa-sg-value" style="color:var(--accent-red);">' + formatNumber(stop) + '</span></div>';
        if (riskReward) gridHtml += '<div class="sa-signal-grid"><span class="sa-sg-label">R:R</span><span class="sa-sg-value">' + esc(riskReward) + '</span></div>';
        if (positionSize) gridHtml += '<div class="sa-signal-grid"><span class="sa-sg-label">Pos Size</span><span class="sa-sg-value">' + esc(String(positionSize)) + '</span></div>';

        card.innerHTML = '<div class="sa-card-title">📡 Tín Hiệu Giao Dịch</div>' +
            '<div class="sa-signal-action ' + cls + '">' + esc(action) + '</div>' +
            '<div class="sa-signal-body">' + gridHtml + '</div>' +
            (reason ? '<div class="sa-signal-reason">' + esc(reason) + '</div>' : '');
    }

    // ── Render: TA Detail Card ──────────────────────────────────────────────
    function renderTADetail(data) {
        var card = $('#sa-ta-card');
        if (!card) return;
        if (!data || !data.success || !data.ta) {
            card.innerHTML = '<div class="sa-card-title">📋 TA Chi Tiết</div><div style="color:var(--text-muted);padding:12px;">Không có dữ liệu</div>';
            return;
        }

        var ta = data.ta;
        var items = [
            { label: 'RSI (14)', value: ta.rsi, range: [0, 100] },
            { label: 'MACD Signal', value: ta.macdSignal || ta.macd_signal },
            { label: 'MACD Histogram', value: ta.macdHist || ta.macd_hist },
            { label: 'ADX', value: ta.adx, range: [0, 100] },
            { label: 'MA Alignment', value: ta.maAlignment || ta.ma_alignment },
            { label: 'Bollinger', value: ta.bollinger },
            { label: 'VCP', value: ta.vcp },
            { label: 'Pocket Pivot', value: ta.pocketPivot || ta.pocket_pivot },
            { label: 'Squeeze', value: ta.squeeze },
            { label: 'Volume', value: ta.volume }
        ];

        var tagsHtml = items.map(function (item) {
            var v = item.value;
            var display;
            var cls;

            if (typeof v === 'boolean') {
                display = v ? '✓' : '✗';
                cls = v ? 'pass' : 'fail';
            } else if (typeof v === 'string') {
                display = v;
                cls = tagClass(v);
            } else if (typeof v === 'number' && Number.isFinite(v)) {
                if (item.range) {
                    display = v.toFixed(1);
                    // Determine pass/fail based on context
                    if (item.label.indexOf('RSI') !== -1) {
                        cls = v < 30 ? 'pass' : v > 70 ? 'fail' : 'neutral';
                    } else if (item.label.indexOf('ADX') !== -1) {
                        cls = v > 25 ? 'pass' : v < 20 ? 'fail' : 'neutral';
                    } else {
                        cls = 'neutral';
                    }
                } else {
                    display = v > 0 ? '+' + v.toFixed(2) : v.toFixed(2);
                    cls = v > 0 ? 'pass' : v < 0 ? 'fail' : 'neutral';
                }
            } else {
                display = '--';
                cls = 'neutral';
            }

            return '<div class="ta-tag ' + cls + '">' +
                '<span class="ta-tag-label">' + esc(item.label) + '</span>' +
                '<span class="ta-tag-value">' + esc(display) + '</span>' +
                '</div>';
        }).join('');

        card.innerHTML = '<div class="sa-card-title">📋 TA Chi Tiết</div>' +
            '<div class="sa-ta-grid">' + tagsHtml + '</div>';
    }

    // ── Render: Ichimoku Summary ─────────────────────────────────────────────
    function renderIchimokuSummary(data) {
        var card = $('#sa-ichimoku-card');
        if (!card) return;
        if (!data || !data.success) {
            card.innerHTML = '<div class="sa-card-title">🎐 Ichimoku</div><div style="color:var(--text-muted);padding:12px;">Không có dữ liệu</div>';
            return;
        }

        var d = data.ichimoku || data.data || data;
        var verdict = d.verdict || d.signal || '--';
        var score = d.score || '--';
        var vc = verdictClass(verdict);
        var signals = d.signals || d.keySignals || [];

        var sigHtml = '';
        if (Array.isArray(signals) && signals.length) {
            sigHtml = signals.map(function (s) {
                var text = typeof s === 'string' ? s : (s.signal || s.name || JSON.stringify(s));
                return '<div class="sa-signal-item">• ' + esc(text) + '</div>';
            }).join('');
        } else {
            // Fallback: list all non-standard keys
            sigHtml = Object.keys(d).filter(function (k) {
                return !['verdict', 'score', 'signals', 'keySignals', 'symbol', 'timestamp'].indexOf(k) !== -1;
            }).map(function (k) {
                return '<div class="sa-signal-item"><span style="color:var(--text-muted);">' + esc(k) + ':</span> ' + esc(String(d[k])) + '</div>';
            }).join('');
        }

        card.innerHTML = '<div class="sa-card-title">🎐 Ichimoku Cloud</div>' +
            '<div class="sa-summary-row">' +
            '<span class="sa-verdict-badge ' + vc + '">' + esc(verdict) + '</span>' +
            '<span class="sa-summary-score">Score: ' + esc(String(score)) + '</span>' +
            '</div>' +
            '<div class="sa-signals-list">' + sigHtml + '</div>';
    }

    // ── Render: Elliott Wave Summary ─────────────────────────────────────────
    function renderElliottSummary(data) {
        var card = $('#sa-elliott-card');
        if (!card) return;
        if (!data || !data.success) {
            card.innerHTML = '<div class="sa-card-title">🌊 Elliott Wave</div><div style="color:var(--text-muted);padding:12px;">Không có dữ liệu</div>';
            return;
        }

        var d = data.elliott || data.data || data;
        var pattern = d.pattern || d.wavePattern || '--';
        var currentWave = d.currentWave || d.wave || '--';
        var verdict = d.verdict || d.bias || '--';
        var vc = verdictClass(verdict);
        var targets = d.targets || d.priceTargets || [];

        var targetHtml = '';
        if (Array.isArray(targets) && targets.length) {
            targetHtml = '<div class="sa-targets">' + targets.map(function (t, i) {
                var price = typeof t === 'object' ? (t.price || t.target) : t;
                var label = typeof t === 'object' && t.label ? t.label : 'Target ' + (i + 1);
                return '<span class="sa-target-chip">' + esc(label) + ': ' + formatNumber(price) + '</span>';
            }).join('') + '</div>';
        }

        // Key signals / info
        var infoKeys = Object.keys(d).filter(function (k) {
            return ['pattern', 'wavePattern', 'currentWave', 'wave', 'verdict', 'bias', 'targets', 'priceTargets', 'symbol', 'timestamp'].indexOf(k) === -1;
        });
        var infoHtml = infoKeys.map(function (k) {
            return '<div class="sa-signal-item"><span style="color:var(--text-muted);">' + esc(k) + ':</span> ' + esc(String(d[k])) + '</div>';
        }).join('');

        card.innerHTML = '<div class="sa-card-title">🌊 Elliott Wave</div>' +
            '<div class="sa-summary-row">' +
            '<span class="sa-verdict-badge ' + vc + '">' + esc(verdict) + '</span>' +
            '<span class="sa-summary-score">Pattern: ' + esc(pattern) + '</span>' +
            '</div>' +
            '<div class="sa-wave-info">' +
            '<span class="sa-wave-current">Sóng hiện tại: <strong>' + esc(String(currentWave)) + '</strong></span>' +
            '</div>' +
            targetHtml +
            '<div class="sa-signals-list">' + infoHtml + '</div>';
    }

    // ── Render: Investor Flow Chart ───────────────────────────────────────────
    function renderInvestorFlowChart(data) {
        var card = $('#sa-flow-card');
        if (!card) return;

        var points = null;
        if (data && data.success && Array.isArray(data.data)) points = data.data;
        else if (data && Array.isArray(data.points)) points = data.points;
        else if (Array.isArray(data)) points = data;

        if (!points || !points.length) {
            card.innerHTML = '<div class="sa-card-title">💰 Dòng Tiền Nhà Đầu Tư</div><div style="color:var(--text-muted);padding:12px;">Không có dữ liệu</div>';
            return;
        }

        card.innerHTML = '<div class="sa-card-title">💰 Dòng Tiền Nhà Đầu Tư</div>' +
            '<div class="sa-flow-canvas-wrap"><canvas id="sa-flow-canvas"></canvas></div>';

        // Reuse StockCharts.renderStockInvestorFlowChart
        if (window.StockCharts && typeof window.StockCharts.renderStockInvestorFlowChart === 'function') {
            window.StockCharts.renderStockInvestorFlowChart('sa-flow-canvas', points);
        }
    }

    // ── Render: Header Strip (Fiintrade-style identity + price) ──────────────
    function extractQuote(data, symbol) {
        if (!data) return null;
        if (Array.isArray(data)) {
            return data.find(function (s) { return s.Symbol === symbol || s.symbol === symbol; }) || data[0];
        }
        if (data && data.success && Array.isArray(data.data)) {
            return data.data.find(function (s) { return s.Symbol === symbol || s.symbol === symbol; }) || data.data[0];
        }
        if (data && (data.symbol || data.Symbol)) return data;
        return null;
    }

    function renderHeaderStrip(data, symbol) {
        var strip = $('#sa-header-strip');
        if (!strip) return;
        var q = extractQuote(data, symbol);

        if (!q) {
            strip.innerHTML = '<div class="sa-hs-left"><span class="sa-hs-symbol">' + esc(symbol) + '</span></div>' +
                '<span style="color:var(--text-muted);font-size:0.85rem;">Không có dữ liệu giá</span>';
            return;
        }

        var name = q.Name || q.name || q.CompanyName || q.companyName || '';
        var exchange = q.Exchange || q.exchange || (q.Symbol && q.Symbol.length <= 3 ? 'HOSE' : '');
        var price = q.PriceCurrent || q.price || q.matchPrice || q.lastPrice || q.PriceClose || '--';
        var change = q.PriceChange != null ? q.PriceChange : (q.change || q.priceChange || 0);
        var changeP = q.PricePercentChange != null ? q.PricePercentChange : (q.changeP || q.pctChange || q.percentChange || 0);
        var refPrice = q.PriceReference || q.refPrice || 0;
        var isUp = Number(change) > 0;
        var isDown = Number(change) < 0;
        var colorClass = isUp ? 'sa-hs-up' : isDown ? 'sa-hs-down' : 'sa-hs-flat';
        var pfx = isUp ? '+' : '';
        var arrow = isUp ? '▲' : isDown ? '▼' : '—';

        var nameHtml = name ? '<div class="sa-hs-name">' + esc(name) + '</div>' : '';
        var exHtml = exchange ? '<span class="sa-hs-exchange">' + esc(exchange) + '</span>' : '';

        strip.innerHTML =
            '<div class="sa-hs-left">' +
                '<div>' +
                    '<div class="sa-hs-symbol">' + esc(symbol) + '</div>' +
                    nameHtml +
                    exHtml +
                '</div>' +
            '</div>' +
            '<div class="sa-hs-right">' +
                '<span class="sa-hs-price ' + colorClass + '">' + formatNumber(price) + '</span>' +
                '<span class="sa-hs-change ' + colorClass + '">' +
                    arrow + ' ' + pfx + formatNumber(change) + ' (' + pfx + Number(changeP).toFixed(2) + '%)' +
                '</span>' +
            '</div>';
    }

    // ── Render: Fundamentals Grid (P/E, P/B, ROE, EPS, 52w Hi/Lo) ────────────
    function renderFundamentals(data, chartStats) {
        var grid = $('#sa-fundamentals');
        if (!grid) return;
        var q = extractQuote(data, state.currentSymbol);

        var pe = q ? (q.PriceToEarning || q.PriceToEarnings || q.pe) : null;
        var pb = q ? (q.PriceToBook || q.pb) : null;
        var roe = q ? (q.RoE || q.ROE || q.roe) : null;
        var eps = q ? (q.Eps || q.EPS || q.eps) : null;
        var yearHigh = chartStats ? chartStats.yearHigh : null;
        var yearLow = chartStats ? chartStats.yearLow : null;

        function statCard(label, value, sub) {
            return '<div class="sa-fund-card">' +
                '<span class="sa-fund-label">' + esc(label) + '</span>' +
                '<span class="sa-fund-value">' + (value != null && value !== '--' ? esc(String(value)) : '--') + '</span>' +
                (sub ? '<span class="sa-fund-sub">' + esc(String(sub)) + '</span>' : '') +
                '</div>';
        }

        var roeDisp = roe != null ? (Number(roe).toFixed(1) + '%') : '--';
        var epsDisp = eps != null ? formatNumber(eps) : '--';

        grid.innerHTML =
            statCard('P/E', pe != null ? Number(pe).toFixed(1) : '--', 'Lợi nhuận / giá') +
            statCard('P/B', pb != null ? Number(pb).toFixed(2) : '--', 'Giá / giá trị sổ') +
            statCard('ROE', roeDisp, 'Tỷ suất VCSH') +
            statCard('EPS', epsDisp, 'VND / cổ phiếu') +
            statCard('Đỉnh 52T', yearHigh != null ? formatNumber(yearHigh) : '--', '52 tuần') +
            statCard('Đáy 52T', yearLow != null ? formatNumber(yearLow) : '--', '52 tuần');
    }

    // ── Render: Intraday Chart ───────────────────────────────────────────────
    function renderIntradayChart(data, symbol) {
        var card = $('#sa-intraday-card');
        if (!card) return;

        var ticks = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);

        if (!ticks || !ticks.length) {
            card.innerHTML = '<div class="card-header"><h4>⏱ Diễn biến phiên</h4></div>' +
                '<div style="color:var(--text-muted);padding:12px;text-align:center;">Không có dữ liệu intraday</div>';
            return;
        }

        card.innerHTML = '<div class="card-header"><h4>⏱ Diễn biến phiên — ' + esc(symbol) + '</h4></div>' +
            '<div class="sa-intraday-canvas-wrap"><canvas id="sa-intraday-canvas"></canvas></div>';

        // Render simple line chart trên canvas (intraday price tick)
        var canvas = document.getElementById('sa-intraday-canvas');
        if (!canvas || !canvas.getContext) return;
        var ctx = canvas.getContext('2d');
        var wrap = canvas.parentElement;

        function draw() {
            var w = wrap.clientWidth || 600;
            var h = 180;
            // HiDPI
            var dpr = window.devicePixelRatio || 1;
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            var prices = ticks.map(function (t) { return Number(t.Price != null ? t.Price : t.price); }).filter(function (v) { return Number.isFinite(v); });
            if (prices.length < 2) return;

            var minP = Math.min.apply(null, prices);
            var maxP = Math.max.apply(null, prices);
            var range = maxP - minP || 1;
            var padX = 8, padY = 14;
            var stepX = (w - padX * 2) / (prices.length - 1);

            // Determine color by first vs last
            var isUp = prices[prices.length - 1] >= prices[0];
            var lineColor = isUp ? '#2ee68a' : '#ff5c78';
            var fillColor = isUp ? 'rgba(46,230,138,0.12)' : 'rgba(255,92,120,0.12)';

            // Fill area
            ctx.beginPath();
            ctx.moveTo(padX, h - padY);
            for (var i = 0; i < prices.length; i++) {
                var x = padX + i * stepX;
                var y = padY + (1 - (prices[i] - minP) / range) * (h - padY * 2);
                if (i === 0) ctx.lineTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.lineTo(padX + (prices.length - 1) * stepX, h - padY);
            ctx.closePath();
            ctx.fillStyle = fillColor;
            ctx.fill();

            // Line
            ctx.beginPath();
            for (var j = 0; j < prices.length; j++) {
                var x2 = padX + j * stepX;
                var y2 = padY + (1 - (prices[j] - minP) / range) * (h - padY * 2);
                if (j === 0) ctx.moveTo(x2, y2);
                else ctx.lineTo(x2, y2);
            }
            ctx.strokeStyle = lineColor;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Last price label
            var lastPrice = prices[prices.length - 1];
            ctx.fillStyle = lineColor;
            ctx.font = '600 11px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(formatNumber(lastPrice), w - padX, padY + 4);
        }

        draw();
        // Redraw on resize
        if (!state._intradayRO || !state._intradayRO._el || state._intradayRO._el !== canvas.parentElement) {
            if (state._intradayRO && state._intradayRO.disconnect) state._intradayRO.disconnect();
            if (typeof ResizeObserver !== 'undefined') {
                var ro = new ResizeObserver(function () { draw(); });
                try { ro.observe(canvas.parentElement); state._intradayRO = ro; state._intradayRO._el = canvas.parentElement; } catch (e) { /* ignore */ }
            }
        }
    }

    // ── Render: Financial Statements Table (quarterly revenue/profit/EPS) ────
    function formatBillion(v) {
        if (v == null || !Number.isFinite(Number(v))) return '--';
        var n = Number(v);
        if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + ' tỷ';
        if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(0) + ' tr';
        return n.toLocaleString('vi-VN');
    }

    function formatMargin(v) {
        if (v == null || !Number.isFinite(Number(v))) return '--';
        return Number(v).toFixed(1) + '%';
    }

    function renderFinancials(data) {
        var card = $('#sa-financials-card');
        if (!card) return;

        var metrics = data && data.metrics;
        if (!metrics || !metrics.length) {
            card.innerHTML = '<div class="sa-fin-header"><h4>📊 Báo cáo tài chính</h4></div>' +
                '<div class="sa-fin-loading">Không có dữ liệu tài chính</div>';
            return;
        }

        // Periods as columns (most recent first)
        var periods = metrics.map(function (m) { return m.period; }).slice(0, state.finQuarters);

        // Toggle buttons for quarter count
        var toggleHtml = '<div class="sa-fin-controls">' +
            [4, 8, 16].map(function (n) {
                return '<button class="sa-fin-tab' + (state.finQuarters === n ? ' active' : '') + '" data-quarters="' + n + '">' + n + ' quý</button>';
            }).join('') +
            '</div>';

        var cacheNote = data.cached ? '' : ' <span style="color:var(--text-muted);font-size:0.7rem;">(vừa cập nhật)</span>';

        // Build table: rows = metrics, columns = periods
        var rows = [
            { label: 'Doanh thu', key: 'netSale', fmt: formatBillion },
            { label: 'LN gộp', key: 'grossProfit', fmt: formatBillion },
            { label: 'Biên LN gộp', key: 'grossMargin', fmt: formatMargin },
            { label: 'LNST', key: 'profitAfterTax', fmt: formatBillion },
            { label: 'Biên ròng', key: 'netMargin', fmt: formatMargin },
            { label: 'EPS', key: 'eps', fmt: function (v) { return v != null ? formatNumber(v) : '--'; } },
            { label: 'EBITDA', key: 'ebitda', fmt: formatBillion }
        ];

        var headerHtml = '<tr><th>Chỉ tiêu</th>' +
            periods.map(function (p) { return '<th>' + esc(p) + '</th>'; }).join('') + '</tr>';

        var bodyHtml = rows.map(function (row) {
            var cells = periods.map(function (p, i) {
                var m = metrics[i];
                if (!m) return '<td>--</td>';
                var val = m[row.key];
                var cls = '';
                if (row.key === 'profitAfterTax' || row.key === 'grossProfit' || row.key === 'netSale' || row.key === 'ebitda') {
                    cls = val > 0 ? 'sa-fin-pos' : val < 0 ? 'sa-fin-neg' : '';
                }
                return '<td class="' + cls + '">' + row.fmt(val) + '</td>';
            }).join('');
            return '<tr><td>' + esc(row.label) + '</td>' + cells + '</tr>';
        }).join('');

        card.innerHTML = '<div class="sa-fin-header">' +
            '<h4>📊 Báo cáo KQKD theo quý' + cacheNote + '</h4>' +
            toggleHtml +
            '</div>' +
            '<div class="sa-fin-table-wrap"><table class="sa-fin-table"><thead>' + headerHtml + '</thead><tbody>' + bodyHtml + '</tbody></table></div>';

        // Wire toggle buttons
        var controls = card.querySelector('.sa-fin-controls');
        if (controls) {
            controls.addEventListener('click', function (e) {
                var btn = e.target.closest('.sa-fin-tab');
                if (!btn) return;
                var n = parseInt(btn.dataset.quarters);
                if (n === state.finQuarters) return;
                state.finQuarters = n;
                // Re-render with stored data if available, else fetch
                if (state._lastFinancials && state._lastFinancials.metrics && state._lastFinancials.metrics.length >= n) {
                    renderFinancials(state._lastFinancials);
                } else {
                    fetchFinancials(state.currentSymbol, n);
                }
            });
        }
    }

    async function fetchFinancials(symbol, quarters) {
        quarters = quarters || state.finQuarters;
        var card = $('#sa-financials-card');
        if (card && !state._lastFinancials) {
            card.innerHTML = '<div class="sa-fin-header"><h4>📊 Báo cáo tài chính</h4></div>' +
                '<div class="sa-fin-loading">⏳ Đang tải dữ liệu tài chính (lần đầu có thể mất 20-30s)...</div>';
        }
        try {
            var base = window.StockAPI.SERVER_BASE;
            var resp = await fetch(base + window.StockAPI.SERVER.FINANCIALS + '/' + symbol + '?count=' + quarters + '&_t=' + Date.now(), { credentials: 'same-origin' });
            var data = await resp.json();
            if (data && data.success) {
                state._lastFinancials = data;
                renderFinancials(data);
            } else {
                if (card) card.innerHTML = '<div class="sa-fin-header"><h4>📊 Báo cáo tài chính</h4></div>' +
                    '<div class="sa-fin-loading">Không có dữ liệu tài chính cho ' + esc(symbol) + '</div>';
            }
        } catch (e) {
            console.warn('Financials fetch failed:', e);
            if (card) card.innerHTML = '<div class="sa-fin-header"><h4>📊 Báo cáo tài chính</h4></div>' +
                '<div class="sa-fin-loading">Lỗi tải dữ liệu tài chính</div>';
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function init() {
        var searchInput = $('#sa-search-input');
        var acDropdown = $('#sa-ac-dropdown');
        var recentTags = $('#sa-recent-tags');
        var analyzeBtn = $('#sa-analyze-btn');
        var refreshBtn = $('#sa-refresh-btn');

        if (searchInput) {
            searchInput.addEventListener('input', onSearchInput);
            searchInput.addEventListener('keydown', onSearchKeydown);
            searchInput.addEventListener('focus', function () {
                if (!state.acItems.length && !searchInput.value) {
                    // Show recent as suggestions
                    var recent = getRecent();
                    if (recent.length) {
                        showAC(recent.map(function (s) { return { symbol: s, name: '' }; }));
                    }
                }
            });
        }

        if (acDropdown) {
            acDropdown.addEventListener('click', onACClick);
        }

        if (recentTags) {
            recentTags.addEventListener('click', onRecentClick);
        }

        if (analyzeBtn) {
            analyzeBtn.addEventListener('click', function () {
                analyzeFromInput();
            });
        }

        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                if (state.currentSymbol) loadAnalysis(state.currentSymbol);
            });
        }

        // Click outside autocomplete to close
        document.addEventListener('click', function (e) {
            var searchWrapper = $('#sa-search-wrapper');
            if (searchWrapper && !searchWrapper.contains(e.target)) {
                hideAC();
            }
        });

        renderRecentTags();
        showEmptyState();
    }

    // ── Export ───────────────────────────────────────────────────────────────
    window.StockAnalysis = { init: init };
})();
