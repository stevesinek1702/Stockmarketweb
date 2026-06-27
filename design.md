# Thiết Kế Hệ Thống — VN Stock Market Dashboard

Tài liệu thiết kế cho web phân tích **dữ liệu thị trường chứng khoán Việt Nam**: bảng giá, dòng tiền ngành, phân tích lệnh theo nhóm nhà đầu tư, lực cầu intraday, cổ phiếu tiềm năng và tín hiệu breakout.

---

## 1. Tổng quan

| Hạng mục | Mô tả |
|---|---|
| Loại | Single-page dashboard (dark theme) + backend proxy |
| Frontend | HTML + CSS + Vanilla JS (Chart.js, TradingView Lightweight Charts, GridStack) |
| Backend | Node.js + Express (proxy API, gộp & cache dữ liệu, bypass CORS) |
| Cổng | `http://localhost:3000` (Express phục vụ cả static frontend lẫn API) |
| Ngôn ngữ giao diện | Tiếng Việt |

Lý do có backend: các API dữ liệu chứng khoán (FireAnt, Fiintrade, Fialda...) chặn CORS và/hoặc yêu cầu header đặc biệt, nên frontend gọi qua `server/server.js` để chuẩn hóa, cache và che giấu cookie/secret.

---

## 2. Kiến trúc

```
Browser (index.html)
  ├─ js/app.js          Điều phối tab, vòng auto-refresh 60s, render panel
  ├─ js/api.js          Lớp gọi API (ENDPOINTS) + MockData fallback
  ├─ js/charts.js       Chart.js (bubble, bar, mini, foreign flow)
  ├─ js/tv-*.js         TradingView Lightweight Charts (modal nến)
  ├─ js/grid-manager.js GridStack: kéo-thả / thu gọn / ẩn card dashboard
  └─ js/ui-state.js     Skeleton / Empty / Error state cho panel
        │  (fetch /api/*)
        ▼
server/server.js (Express)
  ├─ API_CONFIG         FireAnt / Fiintrade / Fialda
  ├─ getFireAntCookie() Lấy cookie FireAnt từ Google Sheet (cache 10')
  ├─ responseCache      Cache in-memory theo key + TTL
  ├─ fiintrade.js       getSectorFlow(), getMarketInvestorFlow()
  ├─ potential-scanner  Quét cổ phiếu tiềm năng + MACD/RSI (chạy nền)
  └─ cookie-sync.js     Tự đăng nhập FireAnt (Playwright) đồng bộ cookie 5h/lần
```

Trạng thái frontend giữ trong các object module-level: `AppState`, `PriceBoardState`, `IndustryFlowState`, `DashboardChartsState`.

---

## 3. Nguồn dữ liệu

| Nguồn | Base URL | Dùng cho | Xác thực |
|---|---|---|---|
| **FireAnt** | `www.fireant.vn/api/Data` | Bảng giá, intraday (lực cầu), TradingStatistic, lịch sử, dữ liệu ngành | Cookie (lấy từ Google Sheet) |
| **Fiintrade** | `wl-market.fiintrade.vn` | Dòng tiền ngành & phân tích lệnh theo 4 nhóm NĐT | Chỉ cần header `Origin: https://iboard.ssi.com.vn` |
| **Fialda** | `fwtapi2.fialda.com` | Mã tác động VNINDEX | Không |
| **Google Sheets** | `docs.google.com/.../pub` | Top mua/bán ròng, cookie FireAnt | Public sheet |

Nguồn cũ **Fitrade** (`apigw.fitrade.vn`) và **sstock** (`api-feature.sstock.vn`) đã ngừng hoạt động — đã được thay thế (xem mục 6).

### Endpoint chính (server)
- `/api/quotes`, `/api/all-stocks`, `/api/market-stats` — bảng giá & intraday.
- `/api/market-dashboard`, `/api/market-breadth` — số liệu VNINDEX/VN30, độ rộng, khối ngoại.
- `/api/vnindex-demand`, `/api/vn30-demand` — chuỗi **lực cầu** intraday (đã resample 3 phút).
- `/api/industry-stats` — bubble "Chuyển Động Ngành" (FireAnt).
- `/api/industry-flow?timeRange=1|5|20|0&level=2` — **dòng tiền ngành** theo nhóm NĐT (Fiintrade).
- `/api/investor-flow` — **phân tích lệnh** 4 nhóm NĐT toàn thị trường (Fiintrade).
- `/api/influential-stocks` — mã tác động (Fialda).
- `/api/top-net-stocks` — top mua/bán ròng (Google Sheets).
- `/api/potential-stocks` — cổ phiếu tiềm năng + MACD/RSI.

---

## 4. Hệ thống thiết kế (Design System)

Toàn bộ token định nghĩa trong `:root` của `css/style.css`.

- **Màu nền**: dark navy có tông (`--bg-primary #0a0a1a` → `--bg-card #1a1a35`), không dùng đen tuyền.
- **Màu dữ liệu (semantic)**: `--color-up` (xanh `#2ee68a`) / `--color-down` (đỏ `#ff5c78`); accent xanh dương, vàng, tím cho biểu đồ/badge.
- **Typography**: `Space Grotesk` cho tiêu đề & số lớn, `Inter` cho nội dung. Số liệu dùng `font-variant-numeric: tabular-nums` để các chữ số thẳng cột.
- **Spacing / radius / shadow / transition**: thang token nhất quán (`--spacing-*`, `--radius-*`, `--shadow-*`).
- **z-index**: thang rõ ràng (`--z-sticky` < `--z-dropdown` < `--z-modal` < `--z-toast`).
- **Trạng thái UI**: `js/ui-state.js` chuẩn hóa Loading (skeleton) / Empty / Error cho mọi panel.

Nguyên tắc trình bày kiểu các nền tảng dữ liệu CK chuyên nghiệp: mật độ thông tin cao, bảng gọn, số canh phải & thẳng cột, xanh/đỏ rõ ràng, header bảng dính (sticky) khi cuộn.

---

## 5. Thành phần giao diện chính

| Tab | Panel | Nguồn |
|---|---|---|
| Dashboard | VNINDEX / VN30 (giá, KLGD, GTGD, lực cầu) | market-dashboard |
| | Chuyển Động Ngành (bubble: lực cầu × %CP>MA10) | industry-stats |
| | Vốn Hóa (bubble) | marketcap-stats |
| | VNINDEX/VN30 & Lực Cầu (line dual-axis intraday) | vnindex/vn30-demand |
| | Khối Ngoại | market-breadth |
| | Top 5 Ngành Mua/Bán Ròng (dòng tiền lớn TC+TD+NN) | industry-flow |
| | Top Cổ Phiếu Mua/Bán Ròng | top-net-stocks |
| | Mã Tác Động Thị Trường | influential-stocks |
| | **Phân Tích Lệnh — Dòng Tiền 4 Nhóm NĐT** | investor-flow |
| Bảng giá | HSX/HNX/UPCOM, lọc, sắp xếp | all-stocks |
| Lọc CP | Bộ lọc tùy biến + preset | filter-presets |
| Ngành | **Phân Tích Dòng Tiền Theo Ngành** (1D/5D/20D/YTD, bar + bảng 4 nhóm) | industry-flow |
| Breakout | Tín hiệu breakout trendline | potential-scanner |
| CP tiềm năng | Quét tiềm năng + MACD/RSI | potential-stocks |
| Tin tức | RSS Vietstock/CafeF | /api/news |

Dashboard dùng GridStack: card có thể kéo-thả, thu gọn, ẩn; layout lưu ở `localStorage` (`vnstock_gridstack_layout_v1`, `..._state_v1`).

---

## 6. Tích hợp Fiintrade & sửa lỗi (cập nhật gần nhất)

- **Dòng tiền ngành**: thay nguồn Fitrade đã chết bằng Fiintrade `SectorIndepth/GetSectorStatisticbyInvestor`. Trả về dòng tiền ròng khớp lệnh theo 4 nhóm: Cá nhân / Tổ chức / Tự doanh / Nước ngoài (đơn vị tỷ đồng). `netSmart = Tổ chức + Tự doanh + Nước ngoài` (= −Cá nhân do khớp lệnh là zero-sum) — dùng để xếp hạng "dòng tiền lớn".
- **Phân tích lệnh**: `/api/investor-flow` tổng hợp 10 ngành cấp 1 để ra dòng tiền ròng 4 nhóm toàn thị trường cho mốc 1D/5D/20D.
- **Lực cầu (sửa lỗi buổi chiều)**: nguyên nhân là biểu đồ chỉ tải 1 lần lúc mở trang (`loadDashboardCharts` không nằm trong vòng auto-refresh). Đã đưa vào vòng refresh 60s; đồng thời server resample ~2.700 điểm tick của FireAnt về mốc 3 phút (09:00–15:00) và cache 30s.
- **Endpoint chết khác**: `/api/vnindex-history` chuyển sang FireAnt HistoricalQuotes; `/api/foreign-daily` trả thông báo gọn (nguồn sstock đã ngừng).

Module `server/fiintrade.js` chỉ cần header `Origin: https://iboard.ssi.com.vn` (không cần đăng nhập). Có thể mở rộng thêm dữ liệu Fiintrade khác (GetPriceData theo organCode, GetStatisticInvestor top mã theo nhóm).

---

## 7. Quy ước & kiểm thử

- **Đơn vị tiền**: tỷ đồng (chia `1e9`) ở toàn bộ UI.
- **Giờ**: dữ liệu intraday quy đổi UTC → giờ Việt Nam (UTC+7).
- **Cache**: in-memory theo key + TTL ở server; flag `window._*Loaded` ở client để không ghi đè dữ liệu tốt khi refresh lỗi.
- **Test**: Vitest + fast-check (`npm test`). Bộ `regression.preservation.test.js` khóa các "neo" cấu trúc (7 tab, GridStack, localStorage keys, handler lọc/sắp xếp) để mọi thay đổi không phá chức năng cũ.
