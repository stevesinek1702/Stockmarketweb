/**
 * VN STOCK MARKET - GRID MANAGER (powered by Gridstack.js)
 * ────────────────────────────────────────────────────────
 * Thay thế hệ thống drag-drop tự code bằng Gridstack:
 *  - Kéo thả panel tự do, auto-reflow (lấp khoảng trống)
 *  - Resize cả chiều ngang & dọc, không che dữ liệu
 *  - Thu gọn / Ẩn panel
 *  - Lưu / Reset layout (localStorage)
 */

(function () {
    'use strict';

    const LAYOUT_KEY = 'vnstock_gridstack_layout_v1';
    const STATE_KEY = 'vnstock_gridstack_state_v1';

    let grid = null;
    let panelStates = {};   // { panelId: { collapsed, prevH } }

    // ── Cấu hình panel mặc định (12-column grid) ───────────────────────────────
    // id: id của panel trong HTML | x,y: vị trí | w,h: kích thước (đơn vị grid)
    const DEFAULT_PANELS = [
        { id: 'panel-vnindex',         x: 0, y: 0,  w: 6,  h: 4, title: 'VNINDEX' },
        { id: 'panel-vn30',            x: 6, y: 0,  w: 6,  h: 4, title: 'VN30' },
        { id: 'card-industry-bubble',  x: 0, y: 4,  w: 6,  h: 6, title: 'Chuyển Động Ngành' },
        { id: 'card-marketcap-bubble', x: 6, y: 4,  w: 6,  h: 6, title: 'Vốn Hóa' },
        { id: 'card-vnindex-demand',   x: 0, y: 10, w: 6,  h: 5, title: 'VNINDEX & Lực Cầu' },
        { id: 'card-vn30-demand',      x: 6, y: 10, w: 6,  h: 5, title: 'VN30 & Lực Cầu' },
        { id: 'panel-foreign-flow',    x: 0, y: 15, w: 6,  h: 4, title: 'Khối Ngoại' },
        { id: 'panel-top-stocks',      x: 6, y: 15, w: 6,  h: 5, title: 'Top Cổ Phiếu' },
        { id: 'panel-top-industries',  x: 0, y: 19, w: 6,  h: 5, title: 'Top 5 Ngành' },
        { id: 'panel-influential',     x: 0, y: 24, w: 12, h: 5, title: 'Mã Tác Động' },
        { id: 'panel-breakout',        x: 0, y: 29, w: 12, h: 6, title: 'Breakout' }
    ];

    // ══════════════════════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════════════════════
    function init() {
        if (typeof GridStack === 'undefined') {
            console.error('[Grid] Gridstack chưa load!');
            return;
        }
        if (document.querySelector('#dashboard .grid-stack')) return; // đã init

        _loadState();
        _buildGrid();
        _createToolbar();
        console.log('[Grid] ✅ Gridstack initialized');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BUILD GRID - Di chuyển panel có sẵn vào grid-stack
    // ══════════════════════════════════════════════════════════════════════════
    function _buildGrid() {
        const dashboard = document.getElementById('dashboard');
        if (!dashboard) return;

        // Tạo container grid-stack
        const gridEl = document.createElement('div');
        gridEl.className = 'grid-stack';
        dashboard.appendChild(gridEl);

        // Lấy layout đã lưu (nếu có)
        const savedLayout = _loadLayout();

        // Tạo grid item cho từng panel
        DEFAULT_PANELS.forEach(cfg => {
            const panel = document.getElementById(cfg.id);
            if (!panel) {
                console.warn('[Grid] Không tìm thấy panel:', cfg.id);
                return;
            }

            // Vị trí: ưu tiên layout đã lưu
            const saved = savedLayout && savedLayout[cfg.id];
            const pos = saved || cfg;

            // Tạo cấu trúc grid-stack-item
            const item = document.createElement('div');
            item.className = 'grid-stack-item';
            item.setAttribute('gs-id', cfg.id);
            item.setAttribute('gs-x', pos.x);
            item.setAttribute('gs-y', pos.y);
            item.setAttribute('gs-w', pos.w);
            item.setAttribute('gs-h', pos.h);

            const content = document.createElement('div');
            content.className = 'grid-stack-item-content';

            // Thêm thanh điều khiển (drag handle + collapse + hide)
            content.appendChild(_makeControlBar(cfg.id, cfg.title));

            // Di chuyển panel vào content (giữ nguyên mọi nội dung + chart)
            content.appendChild(panel);

            item.appendChild(content);
            gridEl.appendChild(item);
        });

        // Khởi tạo Gridstack
        grid = GridStack.init({
            column: 12,
            cellHeight: 70,
            margin: 8,
            float: false,                       // auto-compact, lấp khoảng trống
            animate: true,
            draggable: { handle: '.panel-drag-handle' },
            resizable: { handles: 'e, se, s, sw, w' },
            minRow: 1,
            columnOpts: {
                breakpoints: [
                    { w: 768, c: 1 }            // màn nhỏ → 1 cột
                ]
            }
        }, gridEl);

        // Khôi phục trạng thái collapse
        DEFAULT_PANELS.forEach(cfg => {
            if (panelStates[cfg.id] && panelStates[cfg.id].collapsed) {
                const item = gridEl.querySelector(`[gs-id="${cfg.id}"]`);
                if (item) _applyCollapsed(item, true);
            }
        });

        // Resize chart khi thay đổi kích thước panel
        grid.on('resizestop', () => _resizeCharts());
        grid.on('change', () => _resizeCharts());

        // Dọn dẹp các container cũ giờ đã rỗng
        _cleanupOldContainers();

        // Resize charts lần đầu
        _resizeCharts();
    }

    // ── Thanh điều khiển trên mỗi panel ────────────────────────────────────────
    function _makeControlBar(panelId, title) {
        const bar = document.createElement('div');
        bar.className = 'panel-control-bar';
        bar.innerHTML = `
            <span class="panel-drag-handle" title="Kéo để di chuyển">⠿</span>
            <span class="panel-title-mini">${title || ''}</span>
            <span class="panel-btn panel-collapse-btn" title="Thu gọn / Mở rộng">▾</span>
            <span class="panel-btn panel-hide-btn" title="Ẩn panel">✕</span>
        `;

        bar.querySelector('.panel-collapse-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            _toggleCollapse(panelId);
        });

        bar.querySelector('.panel-hide-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            _hidePanel(panelId);
        });

        return bar;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // COLLAPSE / EXPAND
    // ══════════════════════════════════════════════════════════════════════════
    function _toggleCollapse(panelId) {
        const item = document.querySelector(`.grid-stack [gs-id="${panelId}"]`);
        if (!item) return;

        const isCollapsed = item.classList.contains('panel-collapsed');
        _applyCollapsed(item, !isCollapsed);

        if (!panelStates[panelId]) panelStates[panelId] = {};
        panelStates[panelId].collapsed = !isCollapsed;
        _saveState();
    }

    function _applyCollapsed(item, collapse) {
        const node = item.gridstackNode;
        const arrow = item.querySelector('.panel-collapse-btn');
        const panelId = item.getAttribute('gs-id');

        if (collapse) {
            // Lưu chiều cao hiện tại
            if (!panelStates[panelId]) panelStates[panelId] = {};
            panelStates[panelId].prevH = node ? node.h : 4;

            item.classList.add('panel-collapsed');
            if (arrow) arrow.textContent = '▸';
            grid.update(item, { h: 1, noResize: true });
        } else {
            item.classList.remove('panel-collapsed');
            if (arrow) arrow.textContent = '▾';
            const prevH = (panelStates[panelId] && panelStates[panelId].prevH) || 4;
            grid.update(item, { h: prevH, noResize: false });
        }
        _resizeCharts();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // HIDE PANEL
    // ══════════════════════════════════════════════════════════════════════════
    function _hidePanel(panelId) {
        const item = document.querySelector(`.grid-stack [gs-id="${panelId}"]`);
        if (!item || !grid) return;

        grid.removeWidget(item, false);  // false = không xóa DOM, chỉ gỡ khỏi grid
        item.style.display = 'none';

        if (!panelStates[panelId]) panelStates[panelId] = {};
        panelStates[panelId].hidden = true;
        _saveState();
        _showToast('Đã ẩn panel. Nhấn "Hiện tất cả" để khôi phục.');
    }

    function _showAllPanels() {
        document.querySelectorAll('.grid-stack-item').forEach(item => {
            const panelId = item.getAttribute('gs-id');
            if (item.style.display === 'none') {
                item.style.display = '';
                grid.makeWidget(item);
            }
            if (panelStates[panelId]) panelStates[panelId].hidden = false;
        });
        _saveState();
        _resizeCharts();
        _showToast('✅ Đã hiện tất cả panel');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TOOLBAR (Lưu / Reset / Hiện tất cả)
    // ══════════════════════════════════════════════════════════════════════════
    function _createToolbar() {
        if (document.getElementById('grid-toolbar')) return;

        const toolbar = document.createElement('div');
        toolbar.id = 'grid-toolbar';
        toolbar.className = 'grid-toolbar';
        toolbar.innerHTML = `
            <button class="grid-tb-btn grid-save-btn" title="Lưu layout hiện tại">💾 Lưu Layout</button>
            <button class="grid-tb-btn grid-showall-btn" title="Hiện tất cả panel đã ẩn">👁 Hiện tất cả</button>
            <button class="grid-tb-btn grid-reset-btn" title="Khôi phục layout mặc định">↺ Reset</button>
        `;

        const dashboard = document.getElementById('dashboard');
        dashboard.insertBefore(toolbar, dashboard.firstChild);

        toolbar.querySelector('.grid-save-btn').addEventListener('click', () => {
            _saveLayout();
            _saveState();
            _showToast('✅ Layout đã được lưu!');
        });

        toolbar.querySelector('.grid-showall-btn').addEventListener('click', _showAllPanels);

        toolbar.querySelector('.grid-reset-btn').addEventListener('click', () => {
            if (confirm('Khôi phục layout mặc định?')) {
                localStorage.removeItem(LAYOUT_KEY);
                localStorage.removeItem(STATE_KEY);
                location.reload();
            }
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SAVE / LOAD
    // ══════════════════════════════════════════════════════════════════════════
    function _saveLayout() {
        if (!grid) return;
        const layout = {};
        document.querySelectorAll('.grid-stack-item').forEach(item => {
            const id = item.getAttribute('gs-id');
            const node = item.gridstackNode;
            if (id && node) {
                layout[id] = { x: node.x, y: node.y, w: node.w, h: node.h };
            }
        });
        try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) { }
    }

    function _loadLayout() {
        try {
            const s = localStorage.getItem(LAYOUT_KEY);
            return s ? JSON.parse(s) : null;
        } catch (e) { return null; }
    }

    function _saveState() {
        try { localStorage.setItem(STATE_KEY, JSON.stringify(panelStates)); } catch (e) { }
    }

    function _loadState() {
        try {
            const s = localStorage.getItem(STATE_KEY);
            if (s) panelStates = JSON.parse(s);
        } catch (e) { panelStates = {}; }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CLEANUP - Xóa container cũ rỗng
    // ══════════════════════════════════════════════════════════════════════════
    function _cleanupOldContainers() {
        ['.market-overview', '.dashboard-charts-section', '.dashboard-grid'].forEach(sel => {
            document.querySelectorAll(`#dashboard ${sel}`).forEach(el => el.remove());
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // RESIZE CHARTS
    // ══════════════════════════════════════════════════════════════════════════
    function _resizeCharts() {
        clearTimeout(_resizeCharts._t);
        _resizeCharts._t = setTimeout(() => {
            if (window.chartInstances) {
                Object.values(window.chartInstances).forEach(c => { try { c.resize(); } catch (e) { } });
            }
            if (window.DashboardChartsState) {
                Object.values(window.DashboardChartsState).forEach(c => {
                    if (c && typeof c.resize === 'function') { try { c.resize(); } catch (e) { } }
                });
            }
            window.dispatchEvent(new Event('resize'));
        }, 200);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TOAST
    // ══════════════════════════════════════════════════════════════════════════
    function _showToast(msg) {
        let toast = document.getElementById('grid-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'grid-toast';
            toast.className = 'grid-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(_showToast._t);
        _showToast._t = setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BOOT
    // ══════════════════════════════════════════════════════════════════════════
    function _boot() {
        const run = () => setTimeout(init, 600);  // chờ app.js + charts init xong
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run);
        } else {
            run();
        }
    }

    _boot();

    // API tương thích với app.js (gọi window.DnD.refresh())
    window.DnD = {
        init,
        refresh: _resizeCharts,
        reset: () => { localStorage.removeItem(LAYOUT_KEY); localStorage.removeItem(STATE_KEY); location.reload(); }
    };
})();
