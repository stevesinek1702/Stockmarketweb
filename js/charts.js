/**
 * VN STOCK MARKET - CHARTS MODULE
 * Các hàm vẽ biểu đồ sử dụng Chart.js
 */

/**
 * Đọc giá trị một biến CSS (Theme_Token) từ :root để màu biểu đồ luôn đồng bộ
 * với Design_System. Trả về fallback nếu DOM/CSS chưa sẵn sàng hoặc token rỗng.
 * @param {string} name - tên biến CSS, ví dụ '--accent-green'
 * @param {string} fallback - giá trị dự phòng an toàn
 * @returns {string}
 */
function cssVar(name, fallback) {
    try {
        const value = getComputedStyle(document.documentElement)
            .getPropertyValue(name)
            .trim();
        return value || fallback;
    } catch (e) {
        return fallback;
    }
}

// Chart.js global configuration (đọc từ Theme_Token để đồng nhất với :root)
Chart.defaults.color = cssVar('--text-secondary', '#9999bb');
Chart.defaults.borderColor = cssVar('--border-color', '#2a2a55');
Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/**
 * Bảng màu biểu đồ — đọc động từ Theme_Token (CSS custom properties) trong :root
 * thay vì hằng số cứng, để màu nến/đường/cột luôn khớp với Design_System.
 * Dùng getter (lazy) nên giá trị được lấy tại thời điểm truy cập (sau khi CSS đã tải)
 * và tự cập nhật nếu token thay đổi. Mỗi getter có fallback khớp giá trị :root hiện tại.
 */
const CHART_COLORS = {
    get green() { return cssVar('--accent-green', '#2ee68a'); },
    get greenDark() { return cssVar('--accent-green-dark', '#1fc873'); },
    get greenBg() { return cssVar('--accent-green-bg', 'rgba(46, 230, 138, 0.1)'); },
    get red() { return cssVar('--accent-red', '#ff5c78'); },
    get redDark() { return cssVar('--accent-red-dark', '#d9415d'); },
    get redBg() { return cssVar('--accent-red-bg', 'rgba(255, 92, 120, 0.1)'); },
    get blue() { return cssVar('--accent-blue', '#2eaaff'); },
    get blueBg() { return cssVar('--accent-blue-bg', 'rgba(46, 170, 255, 0.1)'); },
    get purple() { return cssVar('--accent-purple', '#aa66ff'); },
    get purpleBg() { return cssVar('--accent-purple-bg', 'rgba(170, 102, 255, 0.1)'); },
    get yellow() { return cssVar('--accent-yellow', '#ffcc00'); },
    get yellowBg() { return cssVar('--accent-yellow-bg', 'rgba(255, 204, 0, 0.1)'); },
    get white() { return cssVar('--text-primary', '#ffffff'); },
    get gray() { return cssVar('--text-secondary', '#9999bb'); },
    get border() { return cssVar('--border-color', '#2a2a55'); },
    get bgPrimary() { return cssVar('--bg-primary', '#0a0a1a'); },
    get bgCard() { return cssVar('--bg-card', '#1a1a35'); }
};

// Store chart instances
const chartInstances = {};

/**
 * Destroy existing chart instance if exists
 */
function destroyChart(chartId) {
    if (chartInstances[chartId]) {
        chartInstances[chartId].destroy();
        delete chartInstances[chartId];
    }
}

/**
 * Create mini line chart for index cards
 */
function createMiniLineChart(canvasId, data, isPositive = true) {
    destroyChart(canvasId);

    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    const color = isPositive ? CHART_COLORS.green : CHART_COLORS.red;
    const bgColor = isPositive ? CHART_COLORS.greenBg : CHART_COLORS.redBg;

    chartInstances[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map((_, i) => i),
            datasets: [{
                data: data,
                borderColor: color,
                backgroundColor: bgColor,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false }
            },
            scales: {
                x: { display: false },
                y: { display: false }
            },
            animation: {
                duration: 1000,
                easing: 'easeOutQuart'
            }
        }
    });

    return chartInstances[canvasId];
}

/**
 * Create foreign flow bar chart
 */
function createForeignFlowChart(canvasId, data) {
    destroyChart(canvasId);

    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    const colors = data.map(v => v >= 0 ? CHART_COLORS.green : CHART_COLORS.red);
    const bgColors = data.map(v => v >= 0 ? CHART_COLORS.greenBg : CHART_COLORS.redBg);

    chartInstances[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['T2', 'T3', 'T4', 'T5', 'T6'],
            datasets: [{
                data: data,
                backgroundColor: colors,
                borderColor: colors,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: CHART_COLORS.bgCard,
                    titleColor: CHART_COLORS.white,
                    bodyColor: CHART_COLORS.gray,
                    borderColor: CHART_COLORS.border,
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function (context) {
                            const value = context.raw;
                            return (value >= 0 ? '+' : '') + value.toFixed(1) + ' tỷ';
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: CHART_COLORS.gray }
                },
                y: {
                    grid: { color: 'rgba(42, 42, 85, 0.5)' },
                    ticks: {
                        color: CHART_COLORS.gray,
                        callback: function (value) {
                            return value + ' tỷ';
                        }
                    }
                }
            },
            animation: {
                duration: 1000,
                easing: 'easeOutQuart'
            }
        }
    });

    return chartInstances[canvasId];
}

/**
 * Create investor pie chart
 */
function createInvestorPieChart(canvasId, data) {
    destroyChart(canvasId);

    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    const values = [
        Math.abs(data.foreign || 0),
        Math.abs(data.individual || 0),
        Math.abs(data.proprietary || 0),
        Math.abs(data.institution || 0)
    ];

    chartInstances[canvasId] = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['TC Nước Ngoài', 'Cá Nhân', 'Tự Doanh', 'TC Trong Nước'],
            datasets: [{
                data: values,
                backgroundColor: [
                    CHART_COLORS.blue,
                    CHART_COLORS.yellow,
                    CHART_COLORS.purple,
                    CHART_COLORS.green
                ],
                borderColor: CHART_COLORS.bgCard,
                borderWidth: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: CHART_COLORS.gray,
                        padding: 16,
                        usePointStyle: true,
                        pointStyle: 'circle'
                    }
                },
                tooltip: {
                    backgroundColor: CHART_COLORS.bgCard,
                    titleColor: CHART_COLORS.white,
                    bodyColor: CHART_COLORS.gray,
                    borderColor: CHART_COLORS.border,
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function (context) {
                            const value = context.raw;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((value / total) * 100).toFixed(1);
                            return `${context.label}: ${value.toFixed(1)} tỷ (${percentage}%)`;
                        }
                    }
                }
            },
            animation: {
                animateRotate: true,
                duration: 1000,
                easing: 'easeOutQuart'
            }
        }
    });

    return chartInstances[canvasId];
}

/**
 * Create money flow line chart
 */
function createMoneyFlowLineChart(canvasId, data) {
    destroyChart(canvasId);

    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    const labels = data.map(d => {
        const date = new Date(d.date);
        return `${date.getDate()}/${date.getMonth() + 1}`;
    });

    chartInstances[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Mua Ròng',
                    data: data.map(d => d.buyValue || Math.random() * 500),
                    borderColor: CHART_COLORS.green,
                    backgroundColor: CHART_COLORS.greenBg,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    borderWidth: 2
                },
                {
                    label: 'Bán Ròng',
                    data: data.map(d => -(d.sellValue || Math.random() * 300)),
                    borderColor: CHART_COLORS.red,
                    backgroundColor: CHART_COLORS.redBg,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    borderWidth: 2
                },
                {
                    label: 'Net Flow',
                    data: data.map(d => (d.buyValue || Math.random() * 500) - (d.sellValue || Math.random() * 300)),
                    borderColor: CHART_COLORS.blue,
                    backgroundColor: CHART_COLORS.blueBg,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    borderWidth: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: CHART_COLORS.gray,
                        padding: 20,
                        usePointStyle: true
                    }
                },
                tooltip: {
                    backgroundColor: CHART_COLORS.bgCard,
                    titleColor: CHART_COLORS.white,
                    bodyColor: CHART_COLORS.gray,
                    borderColor: CHART_COLORS.border,
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function (context) {
                            const value = context.raw;
                            return `${context.dataset.label}: ${value >= 0 ? '+' : ''}${value.toFixed(1)} tỷ`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: CHART_COLORS.gray }
                },
                y: {
                    grid: { color: 'rgba(42, 42, 85, 0.5)' },
                    ticks: {
                        color: CHART_COLORS.gray,
                        callback: function (value) {
                            return value + ' tỷ';
                        }
                    }
                }
            },
            animation: {
                duration: 1000,
                easing: 'easeOutQuart'
            }
        }
    });

    return chartInstances[canvasId];
}

/**
 * Create industry horizontal bar chart
 */
function createIndustryBarChart(canvasId, data) {
    destroyChart(canvasId);

    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    // Sort by net flow and take top 10 (hỗ trợ cả shape mới netSmart lẫn cũ value1D)
    const val = (d) => (typeof d.netSmart === 'number' ? d.netSmart : (d.value1D || 0));
    const sortedData = [...data].sort((a, b) => val(b) - val(a)).slice(0, 10);

    chartInstances[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sortedData.map(d => d.name),
            datasets: [{
                label: 'Dòng tiền ròng',
                data: sortedData.map(d => val(d)),
                backgroundColor: sortedData.map(d => val(d) >= 0 ? CHART_COLORS.green : CHART_COLORS.red),
                borderColor: sortedData.map(d => val(d) >= 0 ? CHART_COLORS.greenDark : CHART_COLORS.redDark),
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: CHART_COLORS.bgCard,
                    titleColor: CHART_COLORS.white,
                    bodyColor: CHART_COLORS.gray,
                    borderColor: CHART_COLORS.border,
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function (context) {
                            const value = context.raw;
                            return (value >= 0 ? '+' : '') + value.toFixed(1) + ' tỷ';
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(42, 42, 85, 0.5)' },
                    ticks: {
                        color: CHART_COLORS.gray,
                        callback: function (value) {
                            return value + ' tỷ';
                        }
                    }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: CHART_COLORS.gray }
                }
            },
            animation: {
                duration: 1000,
                easing: 'easeOutQuart'
            }
        }
    });

    return chartInstances[canvasId];
}

/**
 * Generate sample data for mini charts (30 points)
 */
function generateMiniChartData(isPositive = true) {
    const data = [];
    let value = 100;

    for (let i = 0; i < 30; i++) {
        value += (Math.random() - (isPositive ? 0.45 : 0.55)) * 3;
        data.push(value);
    }

    return data;
}

/**
 * Render REAL foreign-flow bar chart (Khối ngoại ròng theo phiên) từ /api/foreign-flow.
 * Khác với createForeignFlowChart (dữ liệu mock 5 ngày ngẫu nhiên): nhận trend thật
 * [{label, net}] và tô màu xanh/đỏ theo dấu của net. Bỏ qua các điểm net không hợp lệ.
 * @param {string} canvasId
 * @param {Array<{label:string, net:number|null}>} trend
 * @returns {Chart|null}
 */
function renderForeignFlowChart(canvasId, trend) {
    destroyChart(canvasId);

    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    // Guard: chỉ giữ điểm có net là số hợp lệ (bỏ null/undefined/NaN)
    const points = (Array.isArray(trend) ? trend : [])
        .filter(p => p && typeof p.net === 'number' && isFinite(p.net));
    if (points.length === 0) return null;

    const labels = points.map(p => p.label);
    const values = points.map(p => p.net);
    const colors = values.map(v => v >= 0 ? CHART_COLORS.green : CHART_COLORS.red);
    const fmtT = (v) => (v >= 0 ? '+' : '') + v.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tỷ';

    // Plugin vẽ giá trị trên đỉnh mỗi cột (không cần thư viện ngoài)
    const valueLabelPlugin = {
        id: 'ffValueLabels',
        afterDatasetsDraw(chart) {
            const { ctx, scales } = chart;
            const meta = chart.getDatasetMeta(0);
            ctx.save();
            ctx.font = '600 11px Inter, sans-serif';
            ctx.textAlign = 'center';
            meta.data.forEach((bar, i) => {
                const v = values[i];
                const color = v >= 0 ? CHART_COLORS.green : CHART_COLORS.red;
                ctx.fillStyle = color;
                // Vị trí: trên cột nếu dương, dưới cột nếu âm
                const x = bar.x;
                const y = v >= 0 ? bar.y - 8 : bar.y + 14;
                ctx.fillText(fmtT(v), x, y);
            });
            ctx.restore();
        }
    };

    chartInstances[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: colors.map(c => c + 'cc'),
                borderColor: colors,
                borderWidth: 1.5,
                borderRadius: 5,
                barPercentage: 0.55,
                categoryPercentage: 0.7
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 22 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: CHART_COLORS.bgCard,
                    titleColor: CHART_COLORS.white,
                    bodyColor: CHART_COLORS.gray,
                    borderColor: CHART_COLORS.border,
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function (context) {
                            const value = context.raw;
                            return fmtT(value);
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: CHART_COLORS.gray, font: { size: 11 } }
                },
                y: {
                    grid: { color: 'rgba(42, 42, 85, 0.4)', drawBorder: false },
                    ticks: {
                        color: CHART_COLORS.gray,
                        font: { size: 10 },
                        callback: function (value) {
                            if (value === 0) return '0';
                            return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k tỷ';
                        }
                    }
                }
            },
            animation: { duration: 600, easing: 'easeOutQuart' }
        },
        plugins: [valueLabelPlugin]
    });

    return chartInstances[canvasId];
}

/**
 * Generate sample foreign flow data (5 days)
 */
function generateForeignFlowData() {
    return Array.from({ length: 5 }, () => (Math.random() - 0.5) * 400);
}

/**
 * Render line chart dòng tiền khớp ròng theo 4 nhóm NĐT cho 1 mã.
 * points: [{date, caNhan, toChuc, tuDoanh, nuocNgoai}] (chronological).
 */
let _stockInvestorFlowChart = null;
function renderStockInvestorFlowChart(canvasId, points) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (_stockInvestorFlowChart) { _stockInvestorFlowChart.destroy(); _stockInvestorFlowChart = null; }
    if (!points || !points.length) return;
    const labels = points.map(p => p.date);
    const ds = (label, key, color) => ({
        label, data: points.map(p => p[key]),
        borderColor: color, backgroundColor: color,
        borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false
    });
    _stockInvestorFlowChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [
            ds('Cá nhân', 'caNhan', '#FFA500'),
            ds('Tổ chức', 'toChuc', '#7030A0'),
            ds('Tự doanh', 'tuDoanh', '#92D050'),
            ds('Nước ngoài', 'nuocNgoai', '#00B0F0')
        ]},
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#aaa', usePointStyle: true, boxWidth: 8 } },
                tooltip: {
                    backgroundColor: 'rgba(30,30,40,0.95)', titleColor: '#fff', bodyColor: '#ddd',
                    callbacks: { label: (c) => `${c.dataset.label}: ${(c.raw>=0?'+':'')+Number(c.raw).toFixed(1)} tỷ` }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#888', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
                y: { grid: { color: 'rgba(255,255,255,0.08)' }, ticks: { color: '#888', callback: (v)=> v + ' tỷ' } }
            }
        }
    });
}

// Export chart functions
window.StockCharts = {
    createMiniLineChart,
    createForeignFlowChart,
    renderForeignFlowChart,
    renderStockInvestorFlowChart,
    createInvestorPieChart,
    createMoneyFlowLineChart,
    createIndustryBarChart,
    generateMiniChartData,
    generateForeignFlowData,
    destroyChart,
    CHART_COLORS
};
