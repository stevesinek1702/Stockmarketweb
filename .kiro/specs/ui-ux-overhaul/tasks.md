# Implementation Plan: UI/UX Overhaul (Kế hoạch Triển khai)

## Overview

_(Tổng quan)_

Kế hoạch này chuyển thiết kế "Nâng cấp & Hoàn thiện Giao diện/Trải nghiệm người dùng" thành một chuỗi nhiệm vụ lập trình tăng tiến, không phá vỡ kiến trúc HTML/CSS/JS thuần hiện có. Thứ tự thực hiện đi từ nền tảng ra ngoài: trước hết là lớp Theme_Token trong `:root`, sau đó là lõi logic thuần (adapter `toCandles`/`toVolume`) cùng property test (fast-check), rồi tới module `TVChart`, module `UIState`, và cuối cùng là phần đánh bóng CSS (dark theme, micro-interaction) và responsive. Mỗi nhiệm vụ bám vào mã nguồn sẵn có và kết nối với các bước trước để không để lại mã mồ côi.

Lưu ý: dự án dùng Node.js nhưng frontend chưa có test runner. Nhiệm vụ 2.1 thiết lập một bộ test gọn nhẹ (fast-check + một test runner JS) phục vụ property test cho adapter.

## Tasks

- [x] 1. Mở rộng lớp Design System Token trong `:root`
  - Bổ sung thang typography dưới dạng biến (`--font-size-*`, `--font-weight-*`, `--line-height-*`) vào khối `:root` của `css/style.css`, giữ nguyên toàn bộ token màu/spacing/radius/shadow/transition/z-index hiện có
  - Thêm token semantic trạng thái tăng/giảm (`--color-up`, `--color-up-bg`, `--color-down`, `--color-down-bg`) ánh xạ lên token màu sẵn có
  - Thêm nhóm token màu cho TradingView (`--tv-bg`, `--tv-grid`, `--tv-text`, `--tv-up`, `--tv-down`, `--tv-volume-up`, `--tv-volume-down`) để JS đọc qua `getComputedStyle`
  - _Requirements: 2.1, 2.3, 2.6_

- [x] 2. Lõi logic thuần: adapter dữ liệu lịch sử + property test
  - [x] 2.1 Thiết lập bộ test gọn nhẹ cho frontend
    - Thêm `devDependencies` `fast-check` và một test runner JS gọn (ví dụ `vitest` hoặc `node --test`) vào `package.json` ở thư mục gốc frontend; thêm script `test`
    - Tạo cấu trúc thư mục test (ví dụ `js/__tests__/`) và một test khởi tạo ("smoke") để xác nhận runner chạy với lệnh chạy một lần (không watch)
    - _Requirements: 1.1, 1.2_

  - [x] 2.2 Hiện thực adapter thuần `toCandles` và `toVolume`
    - Tạo module adapter (đặt trong `js/tv-chart.js` hoặc tách thành hàm thuần export được để test) nhận dữ liệu thô FireAnt (`{ Date, Open|PriceOpen, High, Low, Close, Volume }`)
    - `toCandles(raw)`: parse thời gian, loại bản ghi thiếu OHLC, **sắp xếp tăng dần theo time**, **khử trùng timestamp** (giữ bản ghi cuối), trả mảng `{ time, open, high, low, close }`
    - `toVolume(raw)`: trả mảng `{ time, value, color }` khớp 1-1 timestamp với `toCandles`, màu xanh khi `close >= open`, đỏ khi `close < open`, dùng token màu volume
    - Mảng rỗng đầu vào → trả mảng rỗng (để caller chuyển Empty_State)
    - _Requirements: 1.1, 1.2, 1.7_

  - [x]* 2.3 Viết property test cho tính hợp lệ và canh trục thời gian của adapter
    - **Feature: ui-ux-overhaul, Property 1: Adapter sinh dữ liệu hợp lệ và canh trục thời gian cho Lightweight Charts**
    - Generator fast-check sinh mảng bản ghi gồm ngày trùng, ngày đảo thứ tự, trường OHLC thiếu/`null`, giá trị âm
    - Kiểm: time tăng dần nghiêm ngặt; không trùng timestamp; mọi nến `low <= open,close,high` và `high >= open,close`; volume khớp 1-1 timestamp với nến (cùng độ dài, cùng tập time theo thứ tự); tối thiểu 100 vòng
    - **Validates: Requirements 1.1, 1.2**

  - [x]* 2.4 Viết property test cho tính nhất quán màu volume với chiều nến
    - **Feature: ui-ux-overhaul, Property 2: Màu volume nhất quán với chiều nến**
    - Với mỗi chỉ số i: `toVolume(raw)[i].color` là token màu tăng khi `close[i] >= open[i]`, là token màu giảm khi `close[i] < open[i]`; tối thiểu 100 vòng
    - **Validates: Requirements 1.2, 1.7**

- [x] 3. Checkpoint — Bảo đảm test adapter chạy đạt
  - Bảo đảm tất cả test chạy đạt, hỏi người dùng nếu có vướng mắc.

- [x] 4. Module TVChart — tích hợp TradingView Lightweight Charts
  - [x] 4.1 Tạo bộ khung module `js/tv-chart.js` và nạp thư viện lazy
    - Tạo `js/tv-chart.js` expose `window.TVChart` với các phương thức `open`, `destroy`, `ensureLibrary`, dùng adapter `toCandles`/`toVolume` đã hiện thực
    - `ensureLibrary()`: nạp động `lightweight-charts.standalone.production.js` qua CDN lần đầu, cache promise (chỉ chèn 1 thẻ `<script>` dù gọi nhiều lần)
    - Khai báo `js/tv-chart.js` trong `index.html` cạnh các script hiện có
    - _Requirements: 1.1_

  - [ ]* 4.2 Viết unit test cho `ensureLibrary` cache promise
    - Gọi `ensureLibrary()` nhiều lần chỉ chèn đúng 1 thẻ script (mock DOM)
    - _Requirements: 1.1_

  - [x] 4.3 Vẽ biểu đồ nến + volume + trendline trong Chart_Modal
    - `open(symbol, exchange)`: hiện `#tv-modal`, hiển thị skeleton biểu đồ, gọi `dataFetcher` lấy OHLCV, tạo `createChart()` + `addCandlestickSeries()` + `addHistogramSeries()` (volume cùng trục thời gian, `priceScaleId: ''` + scaleMargins)
    - WHERE có dữ liệu trendline, vẽ bằng `addLineSeries()` chồng lên; nếu không có thì bỏ qua
    - Đọc màu qua `getComputedStyle` từ token `--tv-*` để cấu hình `layout.background`, `grid`, `upColor`, `downColor`
    - Chỉ thao tác trong `#tv-modal-container`, không đụng canvas Chart.js ở dashboard
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7_

  - [x] 4.4 Xử lý resize và dọn tài nguyên
    - Gắn `ResizeObserver` trên container + lắng nghe `resize` cửa sổ, gọi `chart.applyOptions({ width, height })`
    - `destroy()`: `chart.remove()`, `resizeObserver.disconnect()`, gỡ event listener, xoá `innerHTML` container; an toàn khi gọi nhiều lần (idempotent), bọc `try/catch`
    - Đóng modal qua nút ✕ / click nền / phím Esc bằng listener cục bộ (thay `window.onclick` toàn cục)
    - _Requirements: 1.6, 1.8, 5.7_

  - [x] 4.5 Xử lý lỗi CDN và lỗi/empty dữ liệu trong modal
    - IF `ensureLibrary()` reject → hiển thị Error_State tiếng Việt ("Không tải được thư viện biểu đồ. Vui lòng thử lại.") kèm nút thử lại
    - IF dữ liệu lịch sử lỗi hoặc rỗng → Error_State/Empty_State tiếng Việt trong modal
    - _Requirements: 1.5_

  - [x] 4.6 Đấu nối TVChart vào luồng mở biểu đồ hiện có
    - Thay phần dựng biểu đồ trong `openTradingViewModal()` của `app.js` bằng lời gọi `TVChart.open(...)`; giữ nguyên điểm gọi từ hàng cổ phiếu
    - _Requirements: 1.1, 6.3_

  - [ ]* 4.7 Viết unit test cho `destroy` idempotent
    - Gọi `destroy()` hai lần không ném lỗi và thực sự gọi `chart.remove()`/`resizeObserver.disconnect()` (mock)
    - _Requirements: 1.8_

- [x] 5. Module UIState — Skeleton / Content / Error / Empty
  - [x] 5.1 Hiện thực `js/ui-state.js` và CSS skeleton/error/empty
    - Tạo `js/ui-state.js` expose `window.UIState` với `showSkeleton(panelEl, variant, count)`, `showContent(panelEl)`, `showError(panelEl, message, onRetry)`, `showEmpty(panelEl, message)`
    - Dựng skeleton 4 variant (`table`/`list`/`card`/`chart`) từ class `.skeleton` sẵn có; thêm CSS `.skeleton-line`, `.skeleton-cell`, `.skeleton-chart`, `.ui-error`, `.ui-empty`, `.retry-btn` (vùng chạm ≥ 44px)
    - Khai báo `js/ui-state.js` trong `index.html`
    - _Requirements: 3.1, 3.3, 3.5, 3.6_

  - [ ]* 5.2 Viết test cho UIState (snapshot skeleton + hành vi retry)
    - Snapshot DOM của skeleton từng variant để chống hồi quy cấu trúc
    - `showError` render nút "Thử lại" và gọi `onRetry` khi click
    - _Requirements: 3.1, 3.5_

  - [x] 5.3 Tích hợp UIState vào các điểm tải dữ liệu trong `app.js`
    - Thay các chuỗi "Đang tải..."/"Đang tải dữ liệu..." trong `index.html` và `app.js` bằng `UIState.showSkeleton(...)` tại điểm bắt đầu fetch
    - Gọi `showContent`/`showEmpty`/`showError` tại điểm kết thúc trong khối `try/catch/finally` của `loadAllData()` và các hàm `load*`; giữ logic "không ghi đè dữ liệu cũ còn tốt"
    - _Requirements: 3.2, 3.4, 3.5, 3.6_

- [x] 6. Checkpoint — Bảo đảm test chạy đạt và modal hoạt động
  - Bảo đảm tất cả test chạy đạt, hỏi người dùng nếu có vướng mắc.

- [x] 7. Đồng bộ màu charts.js với Theme_Token
  - Thay `CHART_COLORS` cứng trong `js/charts.js` bằng giá trị đọc từ token CSS (`getComputedStyle`) để đồng nhất với `:root` (ví dụ `--accent-green`/`--accent-red`)
  - _Requirements: 2.2, 2.6_

- [x] 8. Chuẩn hóa Design System trên các thành phần
  - [x] 8.1 Thay hard-code màu/khoảng cách/chữ bằng `var(--token)`
    - Quét và thay các giá trị màu/khoảng cách cố định nội tuyến trong `css/style.css` bằng `var(--token)` tương ứng, làm theo từng nhóm thành phần
    - _Requirements: 2.2_

  - [x] 8.2 Áp typography và token tăng/giảm, đồng nhất card
    - Áp `--font-display` (Space Grotesk) cho heading, `--font-body` (Inter) cho nội dung; số liệu dùng `font-variant-numeric: tabular-nums`
    - Trỏ `.positive`/`.negative` về `--color-up`/`--color-down`; áp cùng bộ token padding/radius cho các card tương đương trên cả 7 tab
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7_

- [x] 9. Đánh bóng dark theme & micro-interaction
  - [x] 9.1 Chuẩn hóa hover, focus, chiều sâu và chỉ báo tiến trình
    - Chuẩn hóa transition phần tử tương tác trong dải 0.15–0.3s (`--transition-fast`/`--transition-normal`); giữ `fadeIn` cho `.tab-content.active`
    - Thêm quy tắc `:focus-visible` dùng `--accent-blue` cho input/select/nút; áp thang `--shadow-sm/md/lg` và phân lớp nền nhất quán; chuẩn hóa chỉ báo tiến trình cho thao tác quét tín hiệu
    - Rà soát cặp `--text-*`/nền đạt tương phản ≥ 4.5:1 cho nội dung
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 4.7_

  - [x] 9.2 Thêm khối `@media (prefers-reduced-motion: reduce)`
    - Tắt shimmer của `.skeleton` (để khối tĩnh) và vô hiệu hóa transition/animation không thiết yếu khi Reduced_Motion bật
    - _Requirements: 3.7, 4.5_

- [x] 10. Lớp responsive theo 3 Breakpoint
  - Viết lại phần `@media` cuối `css/style.css` theo 3 mốc (≤480px, 481–1024px, >1024px); dọn các `grid-template-columns` cũ thừa
  - Mobile 1 cột (`flex-basis: 100%`), tablet tối đa 2 cột (`calc(50% - gap)`) cho card overview và dashboard-grid; thêm `min-width: 0` cho flex item để tránh chồng lấp
  - Nav 7 tab trên mobile: `overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch`; bảng rộng giữ `overflow-x: auto`; vùng chạm `min-height/width: 44px` trên mobile
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

- [x] 11. Kiểm tra hồi quy bảo toàn chức năng (tự động hóa nơi có thể)
  - Viết test/kiểm tra xác nhận 7 tab và `data-tab` giữ nguyên, cấu trúc `.grid-stack-item` không đổi, handler lọc/sắp xếp/tìm kiếm còn nguyên, và các khóa localStorage (`vnstock_gridstack_layout_v1`, `vnstock_gridstack_state_v1`, `vnstock_priceboard_settings`) không bị động tới
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 12. Checkpoint cuối — Bảo đảm tất cả test chạy đạt
  - Bảo đảm tất cả test chạy đạt, hỏi người dùng nếu có vướng mắc.

## Notes

- Các nhiệm vụ con đánh dấu `*` là tùy chọn (test), có thể bỏ qua để có MVP nhanh hơn.
- Mỗi nhiệm vụ tham chiếu mệnh đề yêu cầu cụ thể để truy vết.
- Property test (Property 1, 2) dùng fast-check, tối thiểu 100 vòng, gắn nhãn "Feature: ui-ux-overhaul, Property {n}: ...", chỉ áp cho lõi adapter thuần.
- Phần UI/CSS/responsive/tích hợp dùng unit/snapshot/integration test và rà soát thủ công theo Testing Strategy của thiết kế.
- Checkpoint bảo đảm kiểm chứng tăng tiến tại các điểm dừng hợp lý.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2.1"] },
    { "id": 1, "tasks": ["2.2", "5.1"] },
    { "id": 2, "tasks": ["2.3", "2.4", "4.1", "7"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.2", "8.1"] },
    { "id": 4, "tasks": ["4.4", "4.5", "5.3", "8.2"] },
    { "id": 5, "tasks": ["4.6", "4.7", "9.1"] },
    { "id": 6, "tasks": ["9.2", "10"] },
    { "id": 7, "tasks": ["11"] }
  ]
}
```
