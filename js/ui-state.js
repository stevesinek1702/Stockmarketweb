/* ============================================
   UIState — Skeleton / Content / Error / Empty
   Module thuần, không phụ thuộc, gắn vào window.UIState.
   Quản lý 4 trạng thái trực quan cho mỗi Data_Panel.
   Requirements: 3.1, 3.3, 3.5, 3.6
   ============================================ */
(function () {
    'use strict';

    // Class đánh dấu lớp phủ trạng thái do UIState chèn vào panel.
    var STATE_CLASS = 'ui-state-overlay';
    // Thuộc tính lưu nội dung thật bị ẩn khi hiển thị skeleton/error/empty.
    var HIDDEN_FLAG = 'data-ui-state-hidden';

    /**
     * Gỡ mọi lớp phủ trạng thái do UIState tạo ra trong panel.
     */
    function clearStateOverlays(panelEl) {
        if (!panelEl) return;
        var overlays = panelEl.querySelectorAll('.' + STATE_CLASS);
        for (var i = 0; i < overlays.length; i++) {
            var node = overlays[i];
            if (node.parentNode) {
                node.parentNode.removeChild(node);
            }
        }
    }

    /**
     * Ẩn các phần tử con "nội dung thật" để nhường chỗ cho skeleton/error/empty.
     */
    function hideRealContent(panelEl) {
        if (!panelEl) return;
        var children = panelEl.children;
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.classList && child.classList.contains(STATE_CLASS)) continue;
            if (child.getAttribute(HIDDEN_FLAG) === 'true') continue;
            // Lưu lại display gốc để khôi phục chính xác sau này.
            child.setAttribute(HIDDEN_FLAG, 'true');
            child.setAttribute('data-ui-state-display', child.style.display || '');
            child.style.display = 'none';
        }
    }

    /**
     * Hiện lại các phần tử con "nội dung thật" đã bị ẩn trước đó.
     */
    function restoreRealContent(panelEl) {
        if (!panelEl) return;
        var hidden = panelEl.querySelectorAll('[' + HIDDEN_FLAG + '="true"]');
        for (var i = 0; i < hidden.length; i++) {
            var node = hidden[i];
            node.style.display = node.getAttribute('data-ui-state-display') || '';
            node.removeAttribute(HIDDEN_FLAG);
            node.removeAttribute('data-ui-state-display');
        }
    }

    /**
     * Tạo một khối skeleton dùng class .skeleton sẵn có + class phụ.
     */
    function makeSkeletonBlock(extraClass, styleText) {
        var el = document.createElement('div');
        el.className = 'skeleton ' + extraClass;
        if (styleText) el.style.cssText = styleText;
        return el;
    }

    /**
     * Dựng skeleton biến thể 'table': N hàng × M ô.
     */
    function buildTableSkeleton(count) {
        var rows = count && count > 0 ? count : 5;
        var cols = 4;
        var wrap = document.createElement('div');
        wrap.className = 'skeleton-table';
        for (var r = 0; r < rows; r++) {
            var row = document.createElement('div');
            row.className = 'skeleton-row';
            for (var c = 0; c < cols; c++) {
                row.appendChild(makeSkeletonBlock('skeleton-cell'));
            }
            wrap.appendChild(row);
        }
        return wrap;
    }

    /**
     * Dựng skeleton biến thể 'list': N dòng với độ rộng xen kẽ.
     */
    function buildListSkeleton(count) {
        var lines = count && count > 0 ? count : 5;
        var wrap = document.createElement('div');
        wrap.className = 'skeleton-list';
        // Độ rộng xen kẽ để giống danh sách thật.
        var widths = ['90%', '70%', '85%', '60%', '80%'];
        for (var i = 0; i < lines; i++) {
            wrap.appendChild(makeSkeletonBlock('skeleton-line', 'width:' + widths[i % widths.length] + ';'));
        }
        return wrap;
    }

    /**
     * Dựng skeleton biến thể 'card': khối tiêu đề + vài dòng, lặp count lần.
     */
    function buildCardSkeleton(count) {
        var cards = count && count > 0 ? count : 1;
        var wrap = document.createElement('div');
        wrap.className = 'skeleton-card-group';
        for (var k = 0; k < cards; k++) {
            var card = document.createElement('div');
            card.className = 'skeleton-card';
            // Khối tiêu đề.
            card.appendChild(makeSkeletonBlock('skeleton-line skeleton-title', 'width:50%;height:20px;'));
            // Vài dòng nội dung.
            card.appendChild(makeSkeletonBlock('skeleton-line', 'width:95%;'));
            card.appendChild(makeSkeletonBlock('skeleton-line', 'width:80%;'));
            card.appendChild(makeSkeletonBlock('skeleton-line', 'width:65%;'));
            wrap.appendChild(card);
        }
        return wrap;
    }

    /**
     * Dựng skeleton biến thể 'chart': một khối chữ nhật cao.
     */
    function buildChartSkeleton() {
        var wrap = document.createElement('div');
        wrap.className = 'skeleton-chart-wrap';
        wrap.appendChild(makeSkeletonBlock('skeleton-chart'));
        return wrap;
    }

    /**
     * Hiển thị Skeleton_Loader có hình dạng tương ứng nội dung.
     * @param {HTMLElement} panelEl - vùng Data_Panel.
     * @param {('table'|'list'|'card'|'chart')} variant - kiểu khung xương.
     * @param {number} [count] - số hàng/dòng/thẻ.
     */
    function showSkeleton(panelEl, variant, count) {
        if (!panelEl) return;
        clearStateOverlays(panelEl);
        hideRealContent(panelEl);

        var overlay = document.createElement('div');
        overlay.className = STATE_CLASS + ' ui-skeleton';
        overlay.setAttribute('aria-busy', 'true');

        var content;
        switch (variant) {
            case 'list':
                content = buildListSkeleton(count);
                break;
            case 'card':
                content = buildCardSkeleton(count);
                break;
            case 'chart':
                content = buildChartSkeleton();
                break;
            case 'table':
            default:
                content = buildTableSkeleton(count);
                break;
        }
        overlay.appendChild(content);
        panelEl.appendChild(overlay);
    }

    /**
     * Xoá skeleton/error/empty và cho nội dung thật hiển thị lại.
     */
    function showContent(panelEl) {
        if (!panelEl) return;
        clearStateOverlays(panelEl);
        restoreRealContent(panelEl);
    }

    /**
     * Hiển thị Error_State tiếng Việt + nút "Thử lại" gọi onRetry.
     * @param {HTMLElement} panelEl
     * @param {string} message - thông báo tiếng Việt do caller cung cấp.
     * @param {Function} [onRetry] - callback khi nhấn "Thử lại".
     */
    function showError(panelEl, message, onRetry) {
        if (!panelEl) return;
        clearStateOverlays(panelEl);
        hideRealContent(panelEl);

        var overlay = document.createElement('div');
        overlay.className = STATE_CLASS + ' ui-error';
        overlay.setAttribute('role', 'alert');

        var msg = document.createElement('div');
        msg.className = 'ui-error-message';
        msg.textContent = message || 'Đã xảy ra lỗi khi tải dữ liệu.';
        overlay.appendChild(msg);

        if (typeof onRetry === 'function') {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'retry-btn';
            btn.textContent = 'Thử lại';
            btn.addEventListener('click', function () {
                onRetry();
            });
            overlay.appendChild(btn);
        }

        panelEl.appendChild(overlay);
    }

    /**
     * Hiển thị Empty_State với thông báo tiếng Việt.
     */
    function showEmpty(panelEl, message) {
        if (!panelEl) return;
        clearStateOverlays(panelEl);
        hideRealContent(panelEl);

        var overlay = document.createElement('div');
        overlay.className = STATE_CLASS + ' ui-empty';

        var msg = document.createElement('div');
        msg.className = 'ui-empty-message';
        msg.textContent = message || 'Không có dữ liệu để hiển thị.';
        overlay.appendChild(msg);

        panelEl.appendChild(overlay);
    }

    window.UIState = {
        showSkeleton: showSkeleton,
        showContent: showContent,
        showError: showError,
        showEmpty: showEmpty
    };
})();
