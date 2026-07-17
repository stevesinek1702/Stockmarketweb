# Dashboard "Phá Đỉnh / Phá Đáy" — Breadth Thị Trường

Tích hợp tab mới vào web hiện tại theo đúng pattern (Fiintrade proxy + Express cache + nav/section + Chart.js). Dashboard tự tính H/L ratio, vốn hóa, phân nhóm ngành/size, RSI — kèm **box nhận xét tổng thể** tự sinh bằng rule-based logic (replicate từ phân tích broker/CMT ở turn trước).

**Quyết định từ user:** Tab đặt sau "Phân Tích Ngành" · Verdict rule-based · Chỉ đúng 6 endpoint TopMover.

## 1. Backend

### 1a. `server/fiintrade.js` — thêm 2 hàm TopMover (sau line 115)
```js
async function getTopNewHigh(timeRange) { return getTopMover('GetTopNewHigh', timeRange); }
async function getTopNewLow(timeRange)  { return getTopMover('GetTopNewLow',  timeRange); }
```
Dùng `fiinGet()` có sẵn (đã spoof origin SSI iBoard — đã kiểm chứng 200 OK). `timeRange` whitelist `['ThreeMonths','SixMonths','OneYear']`. Normalize items: ticker, organCode, sectorName, price, value (GTGD phiên), marketCap (`financial.rtd11`), %1D/3M/6M/1Y/YTD (`performance.*`), rsi (`technical.rsi`), sma20/50/100. Export 2 hàm trong `module.exports`.

### 1b. `server/server.js` — thêm endpoint `GET /api/breadth-breakout` (~line 1148, cạnh industry-cumulative)
- Tự động login-gated (catch-all requireAuth line 220 — không cần thêm gì).
- Cache 60s qua `getCachedResponse`/`setCachedResponse` (giảm 6 API call/lần).
- `Promise.all` 6 combos (High/Low × 3T/6T/1Y). Mỗi call wrap try/catch riêng → nếu 1 fail trả mảng rỗng, không sập cả endpoint.
- **Tính insight server-side** (frontend chỉ render, logic tái dùng được):
  - `summary`: {tf: 'ThreeMonths', high: N, low: N, ratio, verdict:'Bullish'|'Bearish'|'Neutral'} × 3
  - `capSummary`: {tf, capHigh (tỷ), capLow (tỷ), lowOverHigh} × 3
  - `sizeBuckets`: {high:{Mega,Large,Mid,Small,Micro}, low:{...}} cho 3T (ngưỡng: ≥50K, 10-50K, 2-10K, 0.5-2K, <0.5K tỷ)
  - `sectorBreakdown`: {high:[{sector,count,cap}], low:[...]} cho 3T (sort count desc)
  - `topHighs3T`: list High 3T sort GTGD desc (lật "phá đỉnh ma")
  - `topLows1Y`: top 10 Low 1Y sort %1Y asc
  - `rsiSummary`: {high3T: avgRSI, low3T: avgRSI}
- Response: `{success, timestamp, source:'fiintrade', summary, capSummary, sizeBuckets, sectorBreakdown, topHighs3T, topLows1Y, rsiSummary, raw:{high3T,high6T,high1Y,low3T,low6T,low1Y}}`.

## 2. Frontend

### 2a. `index.html`
- Nav (line ~34): thêm `<button class="nav-btn" data-tab="breadth-hl">📈 Phá Đỉnh/Đáy</button>` ngay sau "Phân Tích Ngành".
- Section mới (line 789, sau `</section>` industry, trước `<!-- Breakout Tab -->`): `<section class="tab-content" id="breadth-hl">` gồm:
  1. **Header**: tiêu đề "📈 Phá Đỉnh / Phá Đáy — Sức mạnh thị trường" + nút "Cập nhật" + `<span>` thời gian.
  2. **Verdict box** (`.breadth-verdict`): badge Bullish/Bearish lớn + 2-3 câu luận giải rule-based (xem 2b).
  3. **4 stat cards** (`.breadth-stats`): H/L ratio 3T · 6T · 1N · Vốn hóa Low÷High (3T).
  4. **Chart 1 (bar nhóm)**: H vs L count theo 3 timeframe — grouped bar xanh/đỏ.
  5. **Chart 2 (bar nhóm)**: Vốn hóa H vs L theo 3 timeframe — cho thấy tiền chảy về đâu.
  6. **2 bảng song song** (`.breadth-tables`): Mã Phá Đỉnh 3T | Mã Phá Đáy 1N — cột: Mã, Ngành, Vốn hóa, %, GTGD, RSI. Tô xanh/đỏ theo %.
  7. **Bảng phân nhóm ngành** (`.breadth-sectors`): Ngành | # Phá Đỉnh (3T) | # Phá Đáy (3T) — sort theo tổng.
  8. **Box "Sức mạnh thị trường"** (`.breadth-insights`): 4 chỉ báo — Cap-weighted breadth / Quality of leadership / Liquidity trap count (mã High GTGD≈0) / RSI climax — mỗi cái 1 dòng đọc.

### 2b. `js/app.js`
- State: `const BreadthBreakoutState = { data:null, countChart:null, capChart:null, isLoading:false };`
- `loadBreadthBreakout()`: fetch `/api/breadth-breakout&_t=...` → gọi các `renderBreadth*`.
- `renderBreadthVerdict(data)`: **rule-based logic** sinh 2-3 câu luận giải:
  - Đếm số timeframe Bearish (ratio<0.8) → verdict tổng.
  - Nếu ratio 3T>6T>1N (đảo chiều bình thường) → "thị trường ngắn hạn đang khỏe hơn dài hạn, có thể sát đáy". Nếu ratio 1N>6T>3T → "xu hướng chưa có đáy, mỗi lần nới timeframe phe bán càng chiếm lợi".
  - Check Low/High cap multiplier: >3× → "tiền lớn đang chảy ra khỏi phe yếu".
  - Check leader: nếu sizeBuckets.high.Large+Mega==0 → "không có mã dẫn dắt lớn phá đỉnh → uptrend không bền".
  - Check RSI: low3T<25 → "phe phá đáy oversold cực mạnh → có thể có relief rally ngắn".
- Chart.js init clone pattern từ `renderIndustryFlowChart` (line 1370): `new Chart(ctx, {type:'bar', data:{datasets:[...]}})`, colors từ CSS vars `--accent-green`/`--accent-red`.
- Bảng render: template string + class `.pos`/`.neg` để CSS tô màu.
- Thêm `if (tabId === 'breadth-hl') loadBreadthBreakout();` vào switchTab override (sau line 3958).

### 2c. `js/api.js`
- Thêm `BREADTH_BREAKOUT: '/api/breadth-breakout'` vào `API.SERVER` (line ~27).

### 2d. `css/style.css`
- Block CSS `.breadth-*` mới (cuối file): verdict box (padding, border-left 4px theo verdict color), stat grid (4 cột), bảng song song (grid 2 cột), insights box. Reuse CSS vars (`--accent-green`, `--accent-red`, `--bg-card`, `--border-color`, `--text-secondary`) + class `.card`, `.data-table`, `.stat-card` có sẵn.

## 3. Lý do thiết kế
- **Insight tính server-side**: frontend gọn, tái dùng được cho Google Apps Script sau này, reload ra cùng kết quả.
- **Cache 60s**: 6 endpoint × user = 6 API call/lần; data 1 phiên không đổi liên tục.
- **Verdict rule-based**: deterministic, không cần LLM, đúng dữ liệu.
- **Tab `breadth-hl`**: tránh đụng `/api/ma-breadth` (MA technical) và `/api/market-breadth` (FireAnt A/D).

## 4. Phạm vi & rủi ro
- **Chỉ thêm mới**, không sửa tab/endpoint hiện có.
- 6 endpoint Fiintrade đã test 200 OK ở turn trước.
- Partial response nếu 1/6 call fail (try/catch từng cái).
- Không thêm test tự động (project không có test cho endpoint fiintrade — giữ nhất quán).
- Sau khi code xong sẽ smoke-test bằng `curl /api/breadth-breakout` (cần auth cookie — sẽ hướng dẫn user test bằng trình duyệt).