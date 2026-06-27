/**
 * tv-chart.js — Stock chart modal powered by KLineCharts (v9), with a
 * FireAnt/TradingView-style drawing toolbar and indicator catalogue.
 *
 * Features
 *   - Candlestick + volume from our FireAnt OHLCV data (daily).
 *   - Left drawing toolbar with grouped fly-outs covering EVERY built-in
 *     KLineCharts overlay: lines / rays / segments (trend, horizontal,
 *     vertical), channels (parallel, price channel), price line, Fibonacci
 *     retracement, annotations (note / tag). Plus magnet, lock, hide and
 *     delete-all toggles (like FireAnt's left rail).
 *   - "Các chỉ báo" dialog: searchable list of ALL built-in indicators
 *     (MA/EMA/SMA/BBI/BOLL/SAR on the price pane; VOL/MACD/KDJ/RSI/CCI/DMI/...
 *     in sub-panes), toggled on/off.
 *   - PERSISTENCE: active indicators saved globally; drawings saved PER SYMBOL
 *     to localStorage and auto-restored on reopen.
 *   - Export the chart to PNG.
 *
 * Note: TradingView-exclusive tools (Gann, Pitchfork, Fibonacci circle/spiral/
 * fan, freehand brush, emoji) are NOT built into KLineCharts and are out of
 * scope here unless implemented as custom overlays.
 *
 * Public API: window.TVChart.open(symbol, exchange) / destroy() / ensureLibrary().
 */
(function () {
    'use strict';

    var LIB_URLS = [
        'https://cdn.jsdelivr.net/npm/klinecharts@9.8.10/dist/umd/klinecharts.min.js',
        'https://unpkg.com/klinecharts@9.8.10/dist/umd/klinecharts.min.js'
    ];
    var HISTORY_DAYS = 365;
    var INDICATOR_KEY = 'vnstock_kline_indicators_v1';
    var DRAW_KEY_PREFIX = 'vnstock_kline_draw_';
    var HANDLED = { handled: true };

    var libraryPromise = null;

    // Indicators that can stack on the candle (price) pane; everything else is
    // rendered in its own sub-pane.
    var MAIN_CAPABLE = ['MA', 'EMA', 'SMA', 'BBI', 'BOLL', 'SAR'];

    // Full built-in indicator catalogue with Vietnamese labels (FireAnt-style).
    var INDICATOR_CATALOG = [
        { name: 'MA', label: 'Moving Average — Trung bình trượt' },
        { name: 'EMA', label: 'EMA — Trung bình trượt lũy thừa' },
        { name: 'SMA', label: 'SMA — Trung bình trượt giản đơn' },
        { name: 'BBI', label: 'BBI — Bull and Bear Index' },
        { name: 'BOLL', label: 'Bollinger Bands — Dải Bollinger' },
        { name: 'SAR', label: 'SAR — Parabolic SAR' },
        { name: 'VOL', label: 'Volume — Khối lượng' },
        { name: 'MACD', label: 'MACD — Trung bình động hội tụ/phân kỳ' },
        { name: 'KDJ', label: 'KDJ — Stochastic' },
        { name: 'RSI', label: 'RSI — Chỉ số sức mạnh tương đối' },
        { name: 'BIAS', label: 'BIAS — Độ lệch' },
        { name: 'BRAR', label: 'BRAR — Tình hình mua/bán' },
        { name: 'CCI', label: 'CCI — Commodity Channel Index' },
        { name: 'DMI', label: 'DMI — Directional Movement Index' },
        { name: 'CR', label: 'CR — Energy Index' },
        { name: 'PSY', label: 'PSY — Psychological Line' },
        { name: 'DMA', label: 'DMA — Difference of MA' },
        { name: 'TRIX', label: 'TRIX — Triple EMA' },
        { name: 'OBV', label: 'OBV — On Balance Volume' },
        { name: 'VR', label: 'VR — Volume Ratio' },
        { name: 'WR', label: 'WR — Williams %R' },
        { name: 'MTM', label: 'MTM — Momentum' },
        { name: 'EMV', label: 'EMV — Ease of Movement' },
        { name: 'ROC', label: 'ROC — Rate of Change' },
        { name: 'PVT', label: 'PVT — Price Volume Trend' },
        { name: 'AO', label: 'AO — Awesome Oscillator' }
    ];

    // Drawing tool groups (fly-out menus) → built-in KLineCharts overlay names.
    var DRAW_GROUPS = [
        {
            icon: '╱', title: 'Đường / Tia / Đoạn', items: [
                { overlay: 'straightLine', label: 'Đường thẳng' },
                { overlay: 'rayLine', label: 'Tia' },
                { overlay: 'segment', label: 'Đoạn thẳng' },
                { overlay: 'horizontalStraightLine', label: 'Đường ngang' },
                { overlay: 'horizontalRayLine', label: 'Tia ngang' },
                { overlay: 'horizontalSegment', label: 'Đoạn ngang' },
                { overlay: 'verticalStraightLine', label: 'Đường dọc' },
                { overlay: 'verticalRayLine', label: 'Tia dọc' },
                { overlay: 'verticalSegment', label: 'Đoạn dọc' }
            ]
        },
        {
            icon: '⫽', title: 'Kênh', items: [
                { overlay: 'parallelStraightLine', label: 'Kênh song song' },
                { overlay: 'priceChannelLine', label: 'Kênh giá' }
            ]
        },
        {
            icon: '＄', title: 'Đường giá', items: [
                { overlay: 'priceLine', label: 'Đường giá' }
            ]
        },
        {
            icon: '𝑭', title: 'Fibonacci', items: [
                { overlay: 'fibonacciLine', label: 'Fibonacci thoái lui' }
            ]
        },
        {
            icon: 'T', title: 'Chú thích', items: [
                { overlay: 'simpleAnnotation', label: 'Ghi chú' },
                { overlay: 'simpleTag', label: 'Nhãn' }
            ]
        }
    ];

    var DEFAULT_CONFIG = { main: ['MA'], sub: ['VOL'] };

    var state = freshState();

    function freshState() {
        return {
            chart: null,
            container: null,
            modal: null,
            chartEl: null,
            topbarEl: null,
            leftbarEl: null,
            symbol: null,
            exchange: null,
            mainCreated: {},
            subPaneIds: {},
            overlayIds: null,
            magnet: false,
            locked: false,
            hidden: false,
            flyoutEl: null,
            dialogEl: null,
            resizeObserver: null,
            keydownHandler: null,
            docClickHandler: null,
            closeButton: null,
            closeHandler: null,
            backdropHandler: null
        };
    }

    // ---- persistence -------------------------------------------------------

    function loadConfig() {
        try {
            var raw = localStorage.getItem(INDICATOR_KEY);
            if (!raw) return clone(DEFAULT_CONFIG);
            var s = JSON.parse(raw);
            return {
                main: Array.isArray(s.main) ? s.main : DEFAULT_CONFIG.main.slice(),
                sub: Array.isArray(s.sub) ? s.sub : DEFAULT_CONFIG.sub.slice()
            };
        } catch (e) { return clone(DEFAULT_CONFIG); }
    }
    function saveConfig(cfg) {
        try { localStorage.setItem(INDICATOR_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
    }
    function drawKey(symbol) { return DRAW_KEY_PREFIX + (symbol || '_'); }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    // ---- library loading ---------------------------------------------------

    function ensureLibrary() {
        if (typeof window !== 'undefined' && window.klinecharts) return Promise.resolve(window.klinecharts);
        if (libraryPromise) return libraryPromise;
        var urls = LIB_URLS.slice();
        libraryPromise = new Promise(function (resolve, reject) {
            (function tryNext() {
                if (window.klinecharts) return resolve(window.klinecharts);
                if (!urls.length) { libraryPromise = null; return reject(new Error('Failed to load KLineCharts')); }
                var s = document.createElement('script');
                s.src = urls.shift();
                s.async = true;
                s.onload = function () { if (window.klinecharts) resolve(window.klinecharts); else tryNext(); };
                s.onerror = function () { tryNext(); };
                document.head.appendChild(s);
            })();
        });
        return libraryPromise;
    }

    // ---- helpers -----------------------------------------------------------

    function readToken(name, fb) {
        try {
            var v = getComputedStyle(document.documentElement).getPropertyValue(name);
            v = v ? v.trim() : '';
            return v || fb;
        } catch (e) { return fb; }
    }
    function dataFetcher() {
        return (typeof window !== 'undefined' && window.StockAPI && window.StockAPI.dataFetcher) ? window.StockAPI.dataFetcher : null;
    }
    function fetchHistorical(symbol) {
        var df = dataFetcher();
        if (!df) return Promise.resolve([]);
        if (typeof df.fetchHistoricalOHLC === 'function') return df.fetchHistoricalOHLC(symbol, HISTORY_DAYS);
        if (typeof df.fetchHistoricalData === 'function') return df.fetchHistoricalData(symbol, HISTORY_DAYS);
        return Promise.resolve([]);
    }
    function num(v) {
        if (v === null || v === undefined || v === '') return null;
        var x = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(x) ? x : null;
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
            var open = num(r.Open != null ? r.Open : (r.PriceOpen != null ? r.PriceOpen : r.open));
            var high = num(r.High != null ? r.High : (r.PriceHigh != null ? r.PriceHigh : r.high));
            var low = num(r.Low != null ? r.Low : (r.PriceLow != null ? r.PriceLow : r.low));
            var close = num(r.Close != null ? r.Close : (r.PriceClose != null ? r.PriceClose : r.close));
            if (open === null || high === null || low === null || close === null) continue;
            var vol = num(r.Volume != null ? r.Volume : (r.TotalVolume != null ? r.TotalVolume : r.volume));
            byTs.set(ts, {
                timestamp: ts, open: open,
                high: Math.max(open, high, low, close),
                low: Math.min(open, high, low, close),
                close: close, volume: vol === null ? 0 : vol
            });
        }
        return Array.from(byTs.values()).sort(function (a, b) { return a.timestamp - b.timestamp; });
    }
    function chartStyles() {
        var grid = readToken('--tv-grid', '#2a2a55');
        var text = readToken('--tv-text', '#9999bb');
        var up = readToken('--tv-up', '#2ee68a');
        var down = readToken('--tv-down', '#ff5c78');
        return {
            grid: { horizontal: { color: grid }, vertical: { color: grid } },
            candle: {
                bar: {
                    upColor: up, downColor: down, noChangeColor: '#888888',
                    upBorderColor: up, downBorderColor: down, noChangeBorderColor: '#888888',
                    upWickColor: up, downWickColor: down, noChangeWickColor: '#888888'
                },
                priceMark: { high: { color: text }, low: { color: text }, last: { line: { color: text }, text: { color: '#ffffff' } } },
                tooltip: { text: { color: text } }
            },
            indicator: { tooltip: { text: { color: text } }, lastValueMark: { text: { color: '#ffffff' } } },
            xAxis: { axisLine: { color: grid }, tickLine: { color: grid }, tickText: { color: text } },
            yAxis: { axisLine: { color: grid }, tickLine: { color: grid }, tickText: { color: text } },
            separator: { color: grid },
            crosshair: { horizontal: { line: { color: text }, text: { backgroundColor: down } }, vertical: { line: { color: text }, text: { backgroundColor: down } } }
        };
    }

    // ---- layout ------------------------------------------------------------

    function buildLayout(container) {
        container.innerHTML = '';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.height = '100%';
        container.style.minHeight = '0';
        container.style.position = 'relative';

        var topbar = document.createElement('div'); topbar.className = 'tvk-topbar';
        var body = document.createElement('div'); body.className = 'tvk-body';
        var leftbar = document.createElement('div'); leftbar.className = 'tvk-leftbar';
        var chartEl = document.createElement('div'); chartEl.className = 'tvk-chart';

        body.appendChild(leftbar);
        body.appendChild(chartEl);
        container.appendChild(topbar);
        container.appendChild(body);

        state.topbarEl = topbar;
        state.leftbarEl = leftbar;
        state.chartEl = chartEl;
    }

    function renderTopbar(cfg) {
        var bar = state.topbarEl;
        bar.innerHTML = '';

        var label = document.createElement('span');
        label.className = 'tvk-symbol';
        label.textContent = (state.symbol || '') + (state.exchange ? ' · ' + state.exchange : '') + ' · D';
        bar.appendChild(label);

        var indBtn = document.createElement('button');
        indBtn.type = 'button';
        indBtn.className = 'tvk-action tvk-ind-btn';
        indBtn.textContent = 'ƒ Các chỉ báo';
        indBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleIndicatorDialog(cfg); });
        bar.appendChild(indBtn);

        // Quick chips for the most-used indicators.
        ['MA', 'BOLL', 'VOL', 'MACD', 'RSI'].forEach(function (name) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'tvk-chip' + (isActive(cfg, name) ? ' active' : '');
            chip.textContent = name;
            chip.dataset.ind = name;
            chip.addEventListener('click', function () { toggleIndicator(cfg, name); syncChips(cfg); });
            bar.appendChild(chip);
        });

        var spacer = document.createElement('span'); spacer.className = 'tvk-spacer'; bar.appendChild(spacer);

        var clearBtn = document.createElement('button');
        clearBtn.type = 'button'; clearBtn.className = 'tvk-action';
        clearBtn.textContent = '🗑 Xóa vẽ';
        clearBtn.addEventListener('click', clearDrawings);
        bar.appendChild(clearBtn);

        var imgBtn = document.createElement('button');
        imgBtn.type = 'button'; imgBtn.className = 'tvk-action';
        imgBtn.textContent = '📷 Ảnh';
        imgBtn.addEventListener('click', exportImage);
        bar.appendChild(imgBtn);
    }

    function syncChips(cfg) {
        if (!state.topbarEl) return;
        Array.prototype.forEach.call(state.topbarEl.querySelectorAll('.tvk-chip'), function (chip) {
            chip.classList.toggle('active', isActive(cfg, chip.dataset.ind));
        });
    }

    function renderLeftbar() {
        var bar = state.leftbarEl;
        bar.innerHTML = '';

        // Cursor (clears active tool).
        addLeftButton(bar, '🮰', 'Con trỏ', function (btn) {
            clearActiveTool();
            closeFlyout();
        });

        // Drawing groups (each opens a fly-out).
        DRAW_GROUPS.forEach(function (group) {
            addLeftButton(bar, group.icon, group.title, function (btn, e) {
                openFlyout(btn, group);
            });
        });

        var divider = document.createElement('div'); divider.className = 'tvk-divider'; bar.appendChild(divider);

        // Magnet toggle.
        var magBtn = addLeftButton(bar, '🧲', 'Nam châm (hít vào nến)', function (btn) {
            state.magnet = !state.magnet;
            btn.classList.toggle('on', state.magnet);
        });
        magBtn.classList.toggle('on', state.magnet);

        // Lock toggle.
        var lockBtn = addLeftButton(bar, '🔒', 'Khóa bản vẽ', function (btn) {
            state.locked = !state.locked;
            btn.classList.toggle('on', state.locked);
            overrideAllOverlays({ lock: state.locked });
        });
        lockBtn.classList.toggle('on', state.locked);

        // Visibility toggle.
        var eyeBtn = addLeftButton(bar, '👁', 'Ẩn/hiện bản vẽ', function (btn) {
            state.hidden = !state.hidden;
            btn.classList.toggle('on', state.hidden);
            overrideAllOverlays({ visible: !state.hidden });
        });
        eyeBtn.classList.toggle('on', state.hidden);

        // Delete all.
        addLeftButton(bar, '🗑', 'Xóa tất cả bản vẽ', function () { clearDrawings(); });
    }

    function addLeftButton(bar, glyph, title, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tvk-tool';
        btn.title = title;
        btn.textContent = glyph;
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            onClick(btn, e);
        });
        bar.appendChild(btn);
        return btn;
    }

    function clearActiveTool() {
        if (!state.leftbarEl) return;
        Array.prototype.forEach.call(state.leftbarEl.querySelectorAll('.tvk-tool'), function (b) { b.classList.remove('active'); });
    }

    // ---- fly-out menu ------------------------------------------------------

    function openFlyout(anchorBtn, group) {
        closeFlyout();
        var fly = document.createElement('div');
        fly.className = 'tvk-flyout';

        group.items.forEach(function (item) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'tvk-flyout-item';
            row.textContent = item.label;
            row.addEventListener('click', function (e) {
                e.stopPropagation();
                clearActiveTool();
                anchorBtn.classList.add('active');
                startDraw(item.overlay);
                closeFlyout();
            });
            fly.appendChild(row);
        });

        state.container.appendChild(fly);
        // Position next to the anchor button.
        var br = anchorBtn.getBoundingClientRect();
        var cr = state.container.getBoundingClientRect();
        fly.style.left = (br.right - cr.left + 4) + 'px';
        fly.style.top = (br.top - cr.top) + 'px';
        state.flyoutEl = fly;
    }

    function closeFlyout() {
        if (state.flyoutEl && state.flyoutEl.parentNode) state.flyoutEl.parentNode.removeChild(state.flyoutEl);
        state.flyoutEl = null;
    }

    // ---- indicator dialog --------------------------------------------------

    function isActive(cfg, name) {
        return cfg.main.indexOf(name) !== -1 || cfg.sub.indexOf(name) !== -1;
    }

    function toggleIndicator(cfg, name) {
        var isMain = MAIN_CAPABLE.indexOf(name) !== -1;
        var list = isMain ? cfg.main : cfg.sub;
        var idx = list.indexOf(name);
        if (idx === -1) list.push(name); else list.splice(idx, 1);
        saveConfig(cfg);
        applyIndicators(cfg);
    }

    function toggleIndicatorDialog(cfg) {
        if (state.dialogEl) { closeDialog(); return; }
        var dlg = document.createElement('div');
        dlg.className = 'tvk-dialog';
        dlg.addEventListener('click', function (e) { e.stopPropagation(); });

        var header = document.createElement('div');
        header.className = 'tvk-dialog-header';
        header.innerHTML = '<span>Các chỉ báo</span>';
        var x = document.createElement('button');
        x.type = 'button'; x.className = 'tvk-dialog-close'; x.textContent = '✕';
        x.addEventListener('click', closeDialog);
        header.appendChild(x);
        dlg.appendChild(header);

        var search = document.createElement('input');
        search.type = 'text';
        search.className = 'tvk-dialog-search';
        search.placeholder = 'Tìm kiếm…';
        dlg.appendChild(search);

        var listEl = document.createElement('div');
        listEl.className = 'tvk-dialog-list';
        dlg.appendChild(listEl);

        function renderList(filter) {
            listEl.innerHTML = '';
            var f = (filter || '').trim().toLowerCase();
            INDICATOR_CATALOG.forEach(function (ind) {
                if (f && ind.label.toLowerCase().indexOf(f) === -1 && ind.name.toLowerCase().indexOf(f) === -1) return;
                var row = document.createElement('button');
                row.type = 'button';
                row.className = 'tvk-dialog-item' + (isActive(cfg, ind.name) ? ' active' : '');
                row.innerHTML = '<span class="tvk-star">' + (isActive(cfg, ind.name) ? '★' : '☆') + '</span>' +
                    '<span class="tvk-ind-label">' + ind.label + '</span>';
                row.addEventListener('click', function () {
                    toggleIndicator(cfg, ind.name);
                    row.classList.toggle('active', isActive(cfg, ind.name));
                    row.querySelector('.tvk-star').textContent = isActive(cfg, ind.name) ? '★' : '☆';
                    syncChips(cfg);
                });
                listEl.appendChild(row);
            });
        }
        search.addEventListener('input', function () { renderList(search.value); });
        renderList('');

        state.container.appendChild(dlg);
        state.dialogEl = dlg;
        setTimeout(function () { search.focus(); }, 0);
    }

    function closeDialog() {
        if (state.dialogEl && state.dialogEl.parentNode) state.dialogEl.parentNode.removeChild(state.dialogEl);
        state.dialogEl = null;
    }

    // ---- indicators apply --------------------------------------------------

    function applyIndicators(cfg) {
        if (!state.chart) return;
        // Main-pane overlays.
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
        // Sub-pane indicators (everything in cfg.sub that isn't main-capable).
        var subSet = {};
        cfg.sub.forEach(function (name) {
            subSet[name] = true;
            if (!state.subPaneIds[name]) {
                var paneId = state.chart.createIndicator(name, false, { height: 100 });
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

    // ---- drawings + persistence -------------------------------------------

    function overlayCallbacks() {
        return {
            onDrawEnd: function () { persistDrawings(); return true; },
            onPressedMoveEnd: function () { persistDrawings(); return true; },
            onRemoved: function () { persistDrawings(); return true; }
        };
    }

    function startDraw(overlayName) {
        if (!state.chart) return;
        var cb = overlayCallbacks();
        var id = state.chart.createOverlay({
            name: overlayName,
            lock: state.locked,
            visible: !state.hidden,
            mode: state.magnet ? 'weak_magnet' : 'normal',
            modeSensitivity: 8,
            onDrawEnd: cb.onDrawEnd,
            onPressedMoveEnd: cb.onPressedMoveEnd,
            onRemoved: cb.onRemoved
        });
        if (id) state.overlayIds.add(id);
    }

    function overrideAllOverlays(props) {
        if (!state.chart) return;
        state.overlayIds.forEach(function (id) {
            try { state.chart.overrideOverlay(Object.assign({ id: id }, props)); } catch (e) { /* ignore */ }
        });
    }

    function persistDrawings() {
        if (!state.chart) return;
        var arr = [];
        var dead = [];
        state.overlayIds.forEach(function (id) {
            var o = state.chart.getOverlayById(id);
            if (o && o.points && o.points.length) arr.push({ name: o.name, points: o.points });
            else dead.push(id);
        });
        dead.forEach(function (id) { state.overlayIds.delete(id); });
        try { localStorage.setItem(drawKey(state.symbol), JSON.stringify(arr)); } catch (e) { /* ignore */ }
    }

    function restoreDrawings() {
        if (!state.chart) return;
        var arr = [];
        try { var raw = localStorage.getItem(drawKey(state.symbol)); if (raw) arr = JSON.parse(raw) || []; } catch (e) { arr = []; }
        var cb = overlayCallbacks();
        arr.forEach(function (d) {
            if (!d || !d.name || !Array.isArray(d.points)) return;
            var id = state.chart.createOverlay({
                name: d.name, points: d.points,
                lock: state.locked, visible: !state.hidden,
                onDrawEnd: cb.onDrawEnd, onPressedMoveEnd: cb.onPressedMoveEnd, onRemoved: cb.onRemoved
            });
            if (id) state.overlayIds.add(id);
        });
    }

    function clearDrawings() {
        if (!state.chart) return;
        var ids = [];
        state.overlayIds.forEach(function (id) { ids.push(id); });
        ids.forEach(function (id) { try { state.chart.removeOverlay(id); } catch (e) { /* ignore */ } });
        state.overlayIds.clear();
        try { localStorage.removeItem(drawKey(state.symbol)); } catch (e) { /* ignore */ }
        clearActiveTool();
        closeFlyout();
    }

    function exportImage() {
        if (!state.chart || typeof state.chart.getConvertPictureUrl !== 'function') return;
        try {
            var url = state.chart.getConvertPictureUrl(true, 'png', readToken('--tv-bg', '#161b22'));
            var a = document.createElement('a');
            a.href = url; a.download = (state.symbol || 'chart') + '.png';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        } catch (e) { /* ignore */ }
    }

    // ---- open --------------------------------------------------------------

    function open(symbol, exchange) {
        var modal = document.getElementById('tv-modal');
        var container = document.getElementById('tv-modal-container');
        if (!modal || !container) return Promise.resolve();

        destroy();

        state.modal = modal;
        state.container = container;
        state.symbol = symbol;
        state.exchange = exchange;
        state.overlayIds = new Set();

        modal.style.display = 'block';
        container.innerHTML = '';
        container.style.height = '100%';
        if (window.UIState && typeof window.UIState.showSkeleton === 'function') window.UIState.showSkeleton(container, 'chart');
        attachCloseHandlers();

        var retry = function () { open(symbol, exchange); };

        return ensureLibrary()
            .catch(function (err) {
                console.error('TVChart.ensureLibrary failed:', err);
                showModalError(container, 'Không tải được thư viện biểu đồ. Vui lòng thử lại.', retry);
                throw HANDLED;
            })
            .then(function (klc) {
                return fetchHistorical(symbol)
                    .catch(function (err) {
                        console.error('TVChart fetchHistorical failed:', err);
                        showModalError(container, 'Không tải được dữ liệu biểu đồ. Vui lòng thử lại.', retry);
                        throw HANDLED;
                    })
                    .then(function (raw) {
                        var data = toKline(raw);
                        if (!data.length) { showModalEmpty(container, 'Không có dữ liệu biểu đồ cho mã này.'); return; }

                        if (window.UIState && typeof window.UIState.showContent === 'function') window.UIState.showContent(container);

                        var cfg = loadConfig();
                        buildLayout(container);
                        renderTopbar(cfg);
                        renderLeftbar();

                        var chart = klc.init(state.chartEl, { styles: chartStyles(), locale: 'en-US' });
                        state.chart = chart;
                        chart.applyNewData(data);

                        applyIndicators(cfg);
                        restoreDrawings();

                        if (typeof ResizeObserver !== 'undefined') {
                            var ro = new ResizeObserver(function () { if (state.chart) { try { state.chart.resize(); } catch (e) { /* ignore */ } } });
                            try { ro.observe(state.chartEl); state.resizeObserver = ro; } catch (e) { /* ignore */ }
                        }
                        // Close fly-out/dialog when clicking elsewhere in the chart.
                        state.docClickHandler = function () { closeFlyout(); };
                        state.chartEl.addEventListener('mousedown', state.docClickHandler);

                        setTimeout(function () { if (state.chart) { try { state.chart.resize(); } catch (e) { /* ignore */ } } }, 50);
                    });
            })
            .catch(function (err) {
                if (err === HANDLED) return;
                console.error('TVChart.open failed:', err);
                showModalError(container, 'Không tải được biểu đồ. Vui lòng thử lại.', retry);
            });
    }

    // ---- error / empty -----------------------------------------------------

    function showModalError(container, message, retry) {
        if (!container) return;
        resetContainer(container);
        if (window.UIState && typeof window.UIState.showError === 'function') window.UIState.showError(container, message, retry);
        else fallbackMessage(container, message);
    }
    function showModalEmpty(container, message) {
        if (!container) return;
        resetContainer(container);
        if (window.UIState && typeof window.UIState.showEmpty === 'function') window.UIState.showEmpty(container, message);
        else fallbackMessage(container, message);
    }
    function resetContainer(container) {
        container.style.display = '';
        container.style.flexDirection = '';
        container.style.position = '';
        container.innerHTML = '';
    }
    function fallbackMessage(container, message) {
        container.innerHTML = '';
        var box = document.createElement('div'); box.className = 'ui-state-overlay ui-empty';
        var msg = document.createElement('div'); msg.className = 'ui-empty-message'; msg.textContent = message;
        box.appendChild(msg); container.appendChild(box);
    }

    // ---- close + teardown --------------------------------------------------

    function close() {
        if (state.modal) state.modal.style.display = 'none';
        destroy();
    }
    function attachCloseHandlers() {
        var modal = state.modal;
        if (!modal) return;
        var closeBtn = modal.querySelector('.close-modal');
        if (closeBtn) {
            var closeHandler = function () { close(); };
            closeBtn.addEventListener('click', closeHandler);
            state.closeButton = closeBtn; state.closeHandler = closeHandler;
        }
        var backdropHandler = function (e) { if (e.target === modal) close(); };
        modal.addEventListener('click', backdropHandler);
        state.backdropHandler = backdropHandler;
        var keydownHandler = function (e) {
            if (e.key === 'Escape' || e.keyCode === 27) {
                if (state.dialogEl) { closeDialog(); return; }
                if (state.flyoutEl) { closeFlyout(); return; }
                close();
            }
        };
        document.addEventListener('keydown', keydownHandler);
        state.keydownHandler = keydownHandler;
    }
    function destroy() {
        if (state.keydownHandler) { try { document.removeEventListener('keydown', state.keydownHandler); } catch (e) { /* ignore */ } }
        if (state.closeButton && state.closeHandler) { try { state.closeButton.removeEventListener('click', state.closeHandler); } catch (e) { /* ignore */ } }
        if (state.modal && state.backdropHandler) { try { state.modal.removeEventListener('click', state.backdropHandler); } catch (e) { /* ignore */ } }
        if (state.chartEl && state.docClickHandler) { try { state.chartEl.removeEventListener('mousedown', state.docClickHandler); } catch (e) { /* ignore */ } }
        if (state.resizeObserver) { try { state.resizeObserver.disconnect(); } catch (e) { /* ignore */ } }
        if (state.chart && state.chartEl && window.klinecharts) { try { window.klinecharts.dispose(state.chartEl); } catch (e) { /* ignore */ } }
        var container = state.container;
        if (container) {
            try {
                container.innerHTML = '';
                container.style.display = '';
                container.style.flexDirection = '';
                container.style.position = '';
            } catch (e) { /* ignore */ }
        }
        state = freshState();
    }

    window.TVChart = { open: open, destroy: destroy, ensureLibrary: ensureLibrary };
})();
