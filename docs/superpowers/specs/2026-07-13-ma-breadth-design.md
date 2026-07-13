# Design: MA Breadth — Độ Rộng Kỹ Thuật (Số CP trên MA10/20/50/100/200)

**Ngày:** 2026-07-13
**Trạng thái:** Đã duyệt (chờ review spec)
**Tab áp dụng:** Phân Tích Ngành (mở rộng)

---

## 1. Mục tiêu

Cho phép người dùng nhìn thấy **số lượng cổ phiếu nằm trên các đường trung bình động (MA10/20/50/100/200)** theo thời gian, với 2 phạm vi:

1. **Toàn thị trường** — 1 tập hợp 5 đường tổng hợp.
2. **Theo từng ngành ICB2** (18 ngành) — chọn 1 ngành để xem 5 đường của ngành đó.

Yêu cầu cốt lõi:
- **Xem được quá khứ tới 1.5 năm** (~370 ngày giao dịch) mà không cần load lại dữ liệu mỗi lần.
- **Chọn khoảng ngày cụ thể** (Từ ngày → Đến ngày) thay vì chỉ preset — vd xem 01/03/2026 → 01/06/2026. Có thêm preset nhanh (1T/3T/6T/1N/1.5N/Tất cả).
- **Mở web phải cực nhanh** — frontend chỉ đọc file cache, không tính toán nặng.
- **Load lần đầu có thể chậm**, nhưng các lần sau (và khi mở web) phải nhanh.
- Checkbox toggle từng MA (MA10/20/50/100/200) để tự chọn đường hiển thị.
- Lưu snapshot hằng ngày tự động (background job) để không thiếu ngày.

---

## 2. Bối cảnh & ràng buộc

### Nguồn dữ liệu hiện tại

- **FireAnt TradingStatistic** (`/Markets/TradingStatistic`): cho sẵn `AvgPrice10d`, `AvgPrice20d`, `AvgPrice45d` — **KHÔNG có MA50/100/200**.
- **FireAnt HistoricalQuotes** (`/Markets/HistoricalQuotes?symbol=X`): chuỗi OHLC lịch sử theo mã. Đây là nguồn để tự tính MA50/100/200. Đã được `potential-scanner.js` dùng (120 ngày/mã cho MACD/RSI).
- **FireAnt Quotes** (`/Markets/Quotes?symbols=A,B,...`): giá hiện tại + IndustryCode của nhiều mã trong 1 request (đã dùng trong `/api/industry-stats`, 20 batch × ~85 mã).

### Vì sao không thể tính MA breadth real-time mỗi lần mở web

~1700 mã × fetch riêng = quá nặng cho mỗi page load. Pattern cũ của `potential-scanner.js` (BATCH_SIZE=10, BATCH_DELAY=500ms) mất ~85s cho 1700 mã — không chấp nhận được cho UX "mở web".

→ **Giải pháp: tách bạch việc fetch/tính (background) khỏi việc xem (frontend đọc file).**

### Ràng buộc từ test regression

`js/__tests__/regression.preservation.test.js` khóa:
- 7 tab nav (`industry` đã có) — thiết kế **không thêm/xóa tab**, chỉ mở rộng nội dung tab industry. ✅
- 3 localStorage key (`vnstock_gridstack_layout_v1`, `..._state_v1`, price-board settings) — thiết kế **dùng key mới** riêng (`vnstock_ma_breadth_*`). ✅

---

## 3. Kiến trúc tổng thể

```
┌─────────────────────────────────────────────────────────────────────┐
│  BACKGROUND (tách khỏi UI)                                          │
│                                                                     │
│  [Job nền: mỗi ngày 15:15-22:00 VN]  ──buildToday()──┐             │
│  [Nút "Cập nhật hôm nay"]             ──buildToday()──┤             │
│  [Nút "Tải dữ liệu lịch sử"]          ──buildHistory()┤             │
│                                                       ▼             │
│  FireAnt HistoricalQuotes ──▶ server/breadth-history.js            │
│  FireAnt Quotes           ──▶ (tính MA, gom ngành ICB2)            │
│                                       │                             │
│                                       ▼                             │
│                       server/data/ma-breadth-history.json           │
│                       (~500KB, 370 ngày × 19 nhóm × 5 MA)           │
│                                                       │             │
│  ─────────────────────────────────────────────────────┼─────────── │
│  FOREGROUND (mở web)                                 │             │
│                                                       ▼             │
│  GET /api/ma-breadth  ──▶ fs.readFile + filter ──▶ Chart.js         │
│                          (< 100ms, KHÔNG fetch FireAnt)             │
└─────────────────────────────────────────────────────────────────────┘
```

**3 thành phần độc lập:**

| # | Thành phần | File mới/sửa | Trách nhiệm |
|---|---|---|---|
| 1 | Module MA breadth | **mới** `server/breadth-history.js` | Tính MA, gom ngành, lưu/đọc snapshot JSON |
| 2 | Endpoint + job nền | **sửa** `server/server.js` | `/api/ma-breadth`, `/refresh`, `/build-history`, setInterval job |
| 3 | UI | **sửa** `index.html` + `js/app.js` + `css/style.css` | Section mới trong tab Ngành, dropdown, checkbox, Chart.js |

**Lý do tách module riêng:** `industry-history.js` hiện chỉ lưu `percentAboveMA10` (1 giá trị/ngành/ngày). MA breadth cần 5 MA × 19 nhóm × 370 ngày + chuỗi close gốc để rolling update → cấu trúc khác hẳn. Module riêng tránh phá backward-compat của industry-history.

---

## 4. Cấu trúc dữ liệu

### 4.1. File cache chính: `server/data/ma-breadth-history.json`

```jsonc
{
  "meta": {
    "version": 1,
    "lastUpdated": "2026-07-13",
    "symbolsTracked": 1683,
    "historyDays": 370,
    "firstDate": "2025-01-02",
    "lastDate": "2026-07-13"
  },
  "history": {
    "2025-01-02": {
      "market": {
        "ma10": 742, "ma20": 698, "ma50": 612, "ma100": 489, "ma200": 401, "total": 1683
      },
      "industries": {
        "8300": { "name":"Ngân hàng", "ma10":18,"ma20":16,"ma50":14,"ma100":9,"ma200":5, "total":28 },
        "8500": { "name":"Bảo hiểm",  "ma10":4, "ma20":3, "ma50":2, "ma100":1,"ma200":0, "total":8 },
        // ... 18 ngành ICB2
      }
    },
    "2025-01-03": { ... }
    // ... ~370 ngày
  }
}
```

**Quy ước:**
- Key ngày = `YYYY-MM-DD` (chuỗi sortable).
- `market` = tổng hợp toàn thị trường.
- `industries[code]` = breakdown theo ICB2 (dùng `ICB2_MAP` từ `/api/industry-stats` line 1413-1434).
- Mỗi MA field = **số lượng CP** có `close > MA_n` tại ngày đó (MA_n > 0).
- `total` = **tổng số CP trong nhóm có giao dịch tại ngày đó** (bất kể có đủ lịch sử cho MA nào không). Dùng để tính % khi cần. Các field `ma_n` chỉ đếm CP đủ dữ liệu cho MA đó.
- Mã mới niêm yết chưa đủ N ngày cho MA_n → không tính vào `ma_n` (nhưng vẫn vào `total` và có thể vào `ma_m` nếu đủ cho MA m<N).

**Nguồn MA theo kỳ hạn:**
- **MA10, MA20**: dùng sẵn `AvgPrice10d` / `AvgPrice20d` từ FireAnt TradingStatistic khi build ngày mới nhất (chính xác, đã chuẩn hóa). Cho ngày quá khứ, tính từ chuỗi close cache (HistoricalQuotes).
- **MA50, MA100, MA200**: tự tính từ chuỗi close (HistoricalQuotes) vì FireAnt không cung cấp.

### 4.2. File close cache: `server/data/ma-breadth-close.json`

Lưu chuỗi close ~620 ngày/mã (đủ cho MA200 + window history 370) để rolling update nhanh + chính xác (Cách A).

```jsonc
{
  "meta": { "lastUpdated": "2026-07-13", "window": 620 },
  "symbols": {
    "ACB": { "dates": ["2024-10-01", ...], "closes": [24.5, 24.7, ...] },
    "BID": { ... },
    // ~1700 mã × 620 ngày × ~10 byte ≈ 10MB JSON
  }
}
```

**Lý do dùng Cách A (cache full close) thay vì rolling update (Cách B):**
- Chính xác tuyệt đối — không sai số tích lũy khi miss ngày giao dịch (lễ, nghỉ).
- Đơn giản, dễ debug — tính MA = `(prefix[i+1]-prefix[i+1-n])/n`.
- Kích thước chấp nhận được (~10MB JSON, ghi 1 lần/ngày khi buildToday; ~500KB history snapshot riêng).
- Khi `buildToday` incremental: chỉ cần append 1 close mới/mã (từ Quotes gộp) → tính lại MA cho ngày mới từ close cache.

### 4.3. Bỏ qua mã / ngày không hợp lệ

- Mã không có IndustryCode ICB2 hợp lệ → bỏ qua phần ngành (vẫn tính vào market).
- Mã mới, số ngày < N → MA_n tại ngày đó = "không đủ dữ liệu", không đếm.
- Ngày không giao dịch (T7/CN/lễ) → không có snapshot (dùng ngày giao dịch gần nhất trước đó).

---

## 5. Thuật toán tính MA

### 5.1. SMA (simple moving average) tại ngày T cho chuỗi close

```
MA_n(T) = (1/n) × Σ close[i]  với i từ T-n+1 đến T
         = NaN nếu số ngày có dữ liệu < n
```

Trên MA (đối với breadth), "CP nằm trên MA_n tại ngày T" ⇔ `close[T] > MA_n(T)` và `MA_n(T)` hợp lệ (≠ NaN, > 0).

### 5.2. `buildHistory(windowDays = 250)` — full build lần đầu

```
1. Lấy danh sách ~1700 mã từ /api/all-stocks (đã cache).
2. Với mỗi mã (batch 25 song song):
   a. Fetch HistoricalQuotes(symbol, startDate=T-(200+windowDays+50)d, endDate=T)
      (windowDays=370 → fetch ~620 ngày: MA200 cần 200 ngày buffer TRƯỚC ngày
       đầu tiên của history window để MA200 có giá trị từ ngày đầu)
   b. Parse → chuỗi {date, close}, filter close>0, sort cũ→mới.
   c. Lưu vào closeCache[symbol].
3. Với mỗi ngày giao dịch T trong window [T-windowDays+1, T]:
   a. Với mỗi mã có closeCache:
      - Tính MA10/20/50/100/200 tại T từ closeCache (prefix-sum).
      - aboveMA_n = close[T] > MA_n(T) và MA_n(T) hợp lệ.
      - Gom theo ICB2 của mã (IndustryCode từ all-stocks).
   b. Tổng hợp: market = tổng all mã, industries[code] = tổng theo ngành.
   c. Gán history[T].
4. Ghi 2 file: ma-breadth-history.json + ma-breadth-close.json.
5. Trả về {ok, days, symbolsTracked, lastDate}.
```

**Lý do window fetch = 200 + windowDays + 50:** MA200 tại ngày đầu tiên của history window cần 200 ngày close trước đó. windowDays=370 (1.5 năm) → fetch ≥570 ngày; +50 buffer cho lễ/nghỉ → ~620 ngày.

**Tối ưu tính toán:** bước 3 lặp qua ngày, mỗi ngày lặp qua ~1700 mã × tính 5 MA = ~8500 phép tính/ngày × 370 ngày = ~3.1M phép tính. Mỗi phép tính MA_n = `(prefix[i+1] - prefix[i+1-n])/n` (O(1) với prefix-sum). Tổng tính toán JS ~< 2s. Bottleneck là **network fetch** ở bước 2 (~30-90s với batch 25 song song cho ~1700 mã × 620 ngày).

### 5.3. `buildToday()` — incremental (cho ngày mới nhất)

```
1. Lấy close mới nhất/mã từ FireAnt Quotes (20 request gộp, ~85 mã/request).
   → Quotes trả về PriceCurrent (close ngày giao dịch).
2. Lấy MA10/MA20 mới nhất từ FireAnt TradingStatistic (AvgPrice10d/AvgPrice20d)
   → 1 request, đã có sẵn.
3. Với mỗi mã:
   a. Append close mới vào closeCache[symbol] (trim window 620 ngày).
   b. Tính MA50/100/200 tại ngày mới từ closeCache (prefix-sum).
   c. MA10/MA20: dùng giá trị từ TradingStatistic (bước 2) — chính xác hơn.
   d. aboveMA_n = close[today] > MA_n.
4. Tổng hợp market + industries (như bước 3 buildHistory, 1 ngày).
5. Append history[today] + ghi closeCache.
6. Trả về {ok, date, market, industries}.
```

**Thời gian:** 20 request Quotes (batch 5 song song) + 1 request TradingStatistic + tính toán < 1s = **3-5 giây tổng**.

### 5.4. Prefix-sum optimization cho MA

```js
// Với chuỗi closes[], prefix[i] = closes[0]+...+closes[i-1]
// MA_n(i) = (prefix[i+1] - prefix[i+1-n]) / n   với i >= n-1
function computeMAWithPrefix(closes, n) {
  const prefix = [0];
  for (let i = 0; i < closes.length; i++) prefix.push(prefix[i] + closes[i]);
  const ma = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    ma[i] = (prefix[i + 1] - prefix[i + 1 - n]) / n;
  }
  return ma;
}
```

---

## 6. API

### 6.1. `GET /api/ma-breadth` — đọc file cache (foreground, rất nhanh)

**Query params:**
- `scope` = `market` | `industry` (mặc định `market`)
- `industryCode` = ICB2 code (vd `8300`) — chỉ dùng khi `scope=industry`
- `fromDate` = `YYYY-MM-DD` (mặc định: ngầy đầu có dữ liệu trong cache)
- `toDate` = `YYYY-MM-DD` (mặc định: ngày cuối có dữ liệu trong cache)
- `days` = số ngày gần nhất (mặc định: tất cả; dùng thay cho `fromDate`/`toDate` khi chỉ cần "N ngày gần nhất" — mutually exclusive với fromDate/toDate)

Server tự clamp `fromDate`/`toDate` vào khoảng dữ liệu thực tế có trong cache (không lỗi nếu user chọn ngày ngoài phạm vi, chỉ trả phần giao).

**Response:**
```jsonc
{
  "success": true,
  "scope": "industry",
  "industryCode": "8300",
  "industryName": "Ngân hàng",
  "meta": { "lastUpdated": "2026-07-13", "historyDays": 370, "total": 28,
            "firstDate": "2025-01-02", "lastDate": "2026-07-13",
            "fromDate": "2026-03-01", "toDate": "2026-06-01" },  // echo lại range thực trả
  "series": [
    { "date": "2026-03-02", "ma10": 18, "ma20": 16, "ma50": 14, "ma100": 9, "ma200": 5 },
    // ... các ngày giao dịch trong [fromDate, toDate]
  ]
}
```

**Cache:** in-memory 60s (responseCache, như các endpoint khác). Nếu file chưa tồn tại → trả `{success:false, error:'no-data', needBuild:true}` để UI show nút "Tải dữ liệu lịch sử".

### 6.2. `POST /api/ma-breadth/refresh` — incremental build (nút "Cập nhật hôm nay")

- Không body.
- Gọi `breadthHistory.buildToday()`.
- Response: `{ok, date, market:{...}, industries:{...}}`.
- Timeout 30s.
- Nếu hôm nay đã build rồi → trả luôn cache (`{ok, already:true, ...}`).

### 6.3. `POST /api/ma-breadth/build-history` — full build (nút "Tải dữ liệu lịch sử")

- Body: `{windowDays?: 250}` (optional).
- Gọi `breadthHistory.buildHistory(windowDays)`.
- Response: `{ok, days, symbolsTracked, lastDate}`.
- Timeout 300s (job nặng). Frontend show modal progress.
- Nếu đã có history đầy đủ → confirm trước khi rebuild (UI confirm dialog, không phải API).

### 6.4. Job nền auto-save (trong `server.js`)

```js
// Kiểm tra mỗi 30 phút, trong khung giờ 15:15-22:00 VN, nếu chưa có snapshot hôm nay
const BREADTH_CHECK_INTERVAL = 30 * 60 * 1000;
setInterval(async () => {
  const vnNow = new Date(Date.now() + 7 * 3600 * 1000);
  const vnHour = vnNow.getUTCHours();
  // Chỉ chạy sau khi đóng phiên (~15:15 VN) và trước nửa đêm
  if (vnHour >= 15 && vnHour < 22) {
    try {
      if (!breadthHistory.hasToday()) {
        console.log('[MA Breadth] Auto-building today snapshot...');
        await breadthHistory.buildToday();
      }
    } catch (e) {
      console.error('[MA Breadth] auto-build error:', e.message);
    }
  }
}, BREADTH_CHECK_INTERVAL);
```

Pattern giống `cookie-sync.js` (background sync 5h/lần đã có).

---

## 7. UI — mở rộng tab Phân Tích Ngành

### 7.1. Vị trí trong `index.html`

Thêm 1 section mới trong `<section id="industry">` (line ~714, sau `industry-table-wrapper`, trước `</div>` đóng card):

```html
<!-- MA Breadth Section (mới) -->
<div class="ma-breadth-section">
  <div class="chart-controls">
    <div class="chart-title">📈 Độ Rộng Kỹ Thuật (Số CP trên MA)</div>
    <div class="ma-breadth-controls">
      <select id="ma-breadth-scope" class="filter-select">
        <option value="market">Toàn Thị Trường</option>
        <option value="8300">Ngân hàng</option>
        <option value="8500">Bảo hiểm</option>
        <!-- ... 18 ngành ICB2 -->
      </select>
      <div class="ma-checkbox-group">
        <label><input type="checkbox" id="ma-cb-10" checked> MA10</label>
        <label><input type="checkbox" id="ma-cb-20" checked> MA20</label>
        <label><input type="checkbox" id="ma-cb-50" checked> MA50</label>
        <label><input type="checkbox" id="ma-cb-100"> MA100</label>
        <label><input type="checkbox" id="ma-cb-200"> MA200</label>
      </div>
      <!-- Chọn khoảng ngày cụ thể (from/to) + phím tắt preset -->
      <div class="ma-date-range-group">
        <label>Từ <input type="date" id="ma-breadth-from"></label>
        <label>Đến <input type="date" id="ma-breadth-to"></label>
        <div class="ma-range-presets">
          <button type="button" class="ma-preset-btn" data-preset="1m">1T</button>
          <button type="button" class="ma-preset-btn" data-preset="3m">3T</button>
          <button type="button" class="ma-preset-btn" data-preset="6m">6T</button>
          <button type="button" class="ma-preset-btn" data-preset="1y">1N</button>
          <button type="button" class="ma-preset-btn" data-preset="1.5y">1.5N</button>
          <button type="button" class="ma-preset-btn" data-preset="all">Tất cả</button>
        </div>
      </div>
      <button id="ma-breadth-refresh" class="btn-secondary">↻ Cập nhật hôm nay</button>
      <button id="ma-breadth-build" class="btn-secondary">📅 Tải dữ liệu lịch sử</button>
    </div>
    <span class="ma-breadth-meta" id="ma-breadth-meta"></span>
  </div>
  <div class="ma-breadth-chart-container">
    <canvas id="ma-breadth-chart"></canvas>
  </div>
</div>
```

### 7.2. Trạng thái UI (`js/app.js`)

```js
const MABreadthState = {
  data: null,        // series từ /api/ma-breadth cho scope + range hiện tại
  chart: null,       // Chart.js instance
  scope: 'market',   // 'market' | ICB2 code
  fromDate: null,    // 'YYYY-MM-DD' hoặc null (= từ đầu cache)
  toDate: null,      // 'YYYY-MM-DD' hoặc null (= đến cuối cache)
  visibleMAs: { ma10: true, ma20: true, ma50: true, ma100: false, ma200: false },
  loaded: false
};
```

localStorage key: `vnstock_ma_breadth_prefs` — lưu `{scope, fromDate, toDate, visibleMAs}` để giữ tùy chọn giữa các session.

### 7.3. Hàm chính (`js/app.js`)

- `initMABreadth()` — bind events, load prefs từ localStorage, render dropdown ngành (lấy từ ICB2_MAP hoặc hardcode), set min/max cho 2 date input theo `meta.firstDate/lastDate` từ cache.
- `loadMABreadth()` — fetch `/api/ma-breadth?scope=...&fromDate=...&toDate=...` → `MABreadthState.data` → `renderMABreadthChart()`.
- `renderMABreadthChart()` — vẽ Chart.js line, dataset theo `visibleMAs` (lọc local, KHÔNG fetch lại).
- `onScopeChange()` → `loadMABreadth()`.
- `onDateChange()` — khi user sửa date input (from/to) → debounce 300ms → `loadMABreadth()`. Validate `fromDate <= toDate`, nếu sai → toast nhẹ + tự hoán đổi.
- `onPresetClick(preset)` — tính `fromDate`/`toDate` theo preset (1m/3m/6m/1y/1.5y = N tháng gần nhất / all = toàn bộ cache) → set 2 date input → `loadMABreadth()`.
- `onMAToggle(maKey)` → cập nhật `visibleMAs` → `renderMABreadthChart()` (re-render local, KHÔNG fetch).
- `onRefreshClick()` — POST `/refresh`, spinner, toast kết quả, reload chart.
- `onBuildClick()` — confirm dialog → modal progress → POST `/build-history` → reload chart.

**Khi nào load?** Khi user switch sang tab industry lần đầu (`initMABreadth` lazy-load, không load ở page load để không chậm dashboard). Có flag `MABreadthState.loaded` tránh gọi lại.

### 7.4. Chart.js config

- Type: `line`.
- Datasets: 5 MA (visible theo checkbox). Màu dùng design token:
  - MA10: `var(--color-up)` (xanh `#2ee68a`)
  - MA20: accent xanh dương `#3b82f6`
  - MA50: vàng `#facc15`
  - MA100: tím `#a855f7`
  - MA200: cam `#fb923c`
- Trục X: ngày (`YYYY-MM-DD`), định dạng `DD/MM/YY`.
- Trục Y: số CP, số nguyên, canh phải.
- Tooltip: `{date} · MA20: {value} CP ({pct}% của {total})`.
- Tương tác: hover crosshair, zoom (nếu có plugin sẵn).
- Responsive, maintainAspectRatio: false.

### 7.5. CSS (`css/style.css`)

Dùng token hiện có (`.chart-controls`, `.filter-select`, `.btn-secondary`, `.chart-title`). Thêm:
- `.ma-breadth-section` — margin-top, padding, border-top để tách section.
- `.ma-breadth-controls` — flex wrap, gap.
- `.ma-checkbox-group` — inline-flex, mỗi label có ô checkbox nhỏ.
- `.ma-date-range-group` — inline-flex, gap, chứa 2 date input + preset buttons.
- `.ma-date-range-group input[type="date"]` — styled theo dark theme (background `var(--bg-card)`, border, color picker icon invert).
- `.ma-range-presets` — inline-flex các nút preset nhỏ (`.ma-preset-btn`: padding nhỏ, font-size nhỏ, hover highlight).
- `.ma-breadth-chart-container` — height 400px (như các chart khác).
- `.ma-breadth-meta` — text nhỏ, muted.

### 7.6. Empty / loading state

- Chưa có data (file chưa build): show message "Chưa có dữ liệu MA breadth. Bấm 'Tải dữ liệu lịch sử' để bắt đầu (lần đầu ~1 phút)."
- Đang build: modal progress "Đang tải lịch sử giá... {n}/{total} mã".
- Đang refresh: spinner trên nút, disable.

---

## 8. Xử lý lỗi & edge case

| Trường hợp | Xử lý |
|---|---|
| File cache chưa tồn tại (lần đầu) | `/api/ma-breadth` trả `needBuild:true` → UI show nút build |
| Fetch FireAnt fail (cookie hết hạn) | Log + trả `{success:false, error}`. UI toast lỗi. Không xóa cache cũ. |
| Mã mới niêm yết giữa chừng | `buildToday` tự append. MA_n thiếu dữ liệu → không đếm (theo thiết kế 4.3) |
| Mã bị hủy niêm yết | Vẫn nằm trong closeCache nhưng không có quote mới → bị skip tự nhiên ở buildToday |
| Server restart | Đọc lại file cache khi `require('breadth-history.js')` (load-once). Không mất dữ liệu. |
| Ngày lễ / T7 CN | Không có snapshot (không có giao dịch). Chart tự gap (Chart.js skip null date). |
| User đổi scope khi đang load | Hủy request cũ (AbortController) nếu đang flight. |
| User chọn `fromDate > toDate` | UI tự hoán đổi 2 giá trị + toast nhẹ "Đã hoán đổi từ/đến". KHÔNG lỗi. |
| User chọn ngày ngoài phạm vi cache (vd `fromDate` trước `firstDate`) | Server clamp vào khoảng thực, trả phần giao. `meta.fromDate/toDate` echo lại range thực để UI hiển thị đúng. |
| User chọn `toDate` trong tương lai | Server clamp về `lastDate` trong cache. |
| Khoảng [from,to] không chứa ngày giao dịch nào | Trả `series: []` + UI show "Không có dữ liệu trong khoảng đã chọn". |
| Job nền chạy trùng với nút manual | Dùng flag lock trong module (`_building`) để tránh concurrent build. |
| File JSON quá lớn (> 1.5 năm) | Tự trim: giữ MAX_HISTORY_DAYS = 550 (~1.5 năm + buffer). Trim `history` khi save (như `industry-history.js`). Close cache giữ MAX_CLOSE_WINDOW = 620 ngày (đủ cho MA200 + history window). |

---

## 9. Kiểm thử

### 9.1. Unit test (`js/__tests__/ma-breadth.test.js` — mới)

Test pure function (không cần mock network):
- `computeMAWithPrefix(closes, n)`:
  - Input `[10,20,30,40,50]`, n=3 → `[null, null, 20, 30, 40]`.
  - Input rỗng / n > length → toàn null.
  - Input có giá 0 (mã mới) → null cho MA chưa đủ.
- `countAboveMA(closes, maArray)`:
  - Đếm đúng số `close[i] > maArray[i]` (ma != null).
- `aggregateByIndustry(stockResults, icb2Map)`:
  - Gom đúng theo ICB2, tổng market = tổng tất cả.

### 9.2. Regression (không phá test hiện có)

- `regression.preservation.test.js` vẫn pass: không thêm/xóa tab, không đổi localStorage key cũ, GridStack init nguyên vẹn.
- Thêm assertion trong `regression.preservation.test.js`: tab industry vẫn có `<section id="industry">`, vẫn 7 tab.

### 9.3. Smoke test thủ công

1. Start server → mở tab Ngành → section MA breadth xuất hiện với empty state.
2. Bấm "Tải dữ liệu lịch sử" → modal progress → xong → chart hiện 5 đường (nếu checkbox on).
3. Toggle từng MA checkbox → đường ẩn/hiện ngay.
4. Đổi dropdown ngành → chart cập nhật.
5. **Gõ ngày cụ thể** vào ô Từ (`01/03/2026`) và Đến (`01/06/2026`) → chart tự zoom đúng khoảng đó.
6. Bấm preset "3T" → 2 ô date tự fill khoảng 3 tháng gần nhất → chart zoom.
7. Bấm "Cập nhật hôm nay" → spinner → toast "Đã cập nhật 13/07/2026".
7. Reload page → vẫn còn prefs (localStorage) + data (file cache).

---

## 10. Tóm tắt file thay đổi

| File | Loại | Mô tả |
|---|---|---|
| `server/breadth-history.js` | **mới** | Module: getBreadth, buildToday, buildHistory, hasToday, getMeta + pure functions (computeMAWithPrefix, countAboveMA, aggregateByIndustry) |
| `server/data/ma-breadth-history.json` | **mới** (gen runtime) | Cache snapshot breadth |
| `server/data/ma-breadth-close.json` | **mới** (gen runtime) | Cache chuỗi close 250 ngày/mã |
| `server/server.js` | **sửa** | +3 endpoint (`/api/ma-breadth`, `/refresh`, `/build-history`), +job nền setInterval |
| `index.html` | **sửa** | +section MA breadth trong tab industry (~30 dòng HTML) |
| `js/app.js` | **sửa** | +MABreadthState, +initMABreadth, +loadMABreadth, +renderMABreadthChart, +event handlers |
| `css/style.css` | **sửa** | +`.ma-breadth-*` classes (~30 dòng) |
| `js/__tests__/ma-breadth.test.js` | **mới** | Unit test pure functions |
| `.gitignore` | **sửa** | +`server/data/ma-breadth-*.json` (cache không commit) |

---

## 11. Phạm vi KHÔNG làm (YAGNI)

- **KHÔNG** thêm RSI breadth / new highs-lows breadth (chỉ MA, theo yêu cầu).
- **KHÔNG** thêm tab mới (mở rộng tab industry hiện có).
- **KHÔNG** tính EMA / WMA (chỉ SMA — đơn giản, đủ nhu cầu breadth).
- **KHÔNG** realtime intraday MA breadth (chỉ end-of-day snapshot).
- **KHÔNG** SSE/WebSocket cho progress build (dùng modal đơn giản với polling hoặc 1 request dài).
- **KHÔNG** xuất Excel/CSV (có thể thêm sau nếu cần).
- **KHÔNG** đa thời gian (weekly/monthly MA breadth) — chỉ daily.
