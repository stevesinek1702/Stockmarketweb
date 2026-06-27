# VN Stock Market Dashboard

Web phân tích **dữ liệu thị trường chứng khoán Việt Nam**: bảng giá HSX/HNX/UPCOM, dòng tiền ngành & phân tích lệnh theo 4 nhóm nhà đầu tư (Fiintrade), lực cầu intraday, mã tác động, cổ phiếu tiềm năng và tín hiệu breakout.

> Chi tiết kiến trúc & hệ thống thiết kế: xem [`design.md`](./design.md).

## Tính năng

- 📊 **Dashboard**: VNINDEX/VN30 (giá, KLGD, GTGD, lực cầu), độ rộng thị trường, khối ngoại.
- 🏢 **Dòng tiền ngành** (Fiintrade): net khớp lệnh theo Cá nhân / Tổ chức / Tự doanh / Nước ngoài, mốc 1D/5D/20D/YTD.
- 🧮 **Phân tích lệnh**: dòng tiền ròng 4 nhóm NĐT toàn thị trường.
- 📈 **Lực cầu intraday** VNINDEX/VN30 (resample 3 phút, chạy đủ cả phiên).
- 📋 **Bảng giá** đầy đủ + bộ lọc tùy biến (lưu preset).
- ⚡ **Breakout** & **Cổ phiếu tiềm năng** (quét MACD/RSI nền).

## Yêu cầu

- Node.js 18+ (khuyến nghị 20+)
- npm

## Cài đặt & chạy

```bash
# 1. Cài dependency cho server
cd server
npm install

# 2. Tạo file cấu hình từ mẫu rồi điền giá trị
copy .env.example .env        # Windows
# cp .env.example .env        # macOS/Linux

# 3. Chạy server (phục vụ cả API lẫn frontend)
npm start
```

Mở trình duyệt: **http://localhost:3000**

> Trên Windows có thể chạy nhanh bằng `Start_VNStock.bat`.

### Test (frontend)

```bash
# tại thư mục gốc
npm install
npm test          # vitest run
```

## Cấu trúc

```
├─ index.html              # Trang dashboard
├─ css/style.css           # Design system (dark theme)
├─ js/                     # app.js, api.js, charts.js, tv-*.js, grid-manager.js, ui-state.js
├─ server/                 # Express backend (proxy API + cache)
│  ├─ server.js            # Hub endpoint /api/*
│  ├─ fiintrade.js         # Dòng tiền ngành & phân tích lệnh (Fiintrade)
│  └─ potential-scanner.js # Quét cổ phiếu tiềm năng
├─ design.md               # Tài liệu thiết kế
└─ Thu thap du lieu/       # Script Python thu thập dữ liệu (tham khảo)
```

## Nguồn dữ liệu

FireAnt (bảng giá, intraday), Fiintrade (dòng tiền ngành/NĐT), Fialda (mã tác động), Google Sheets (top mua/bán ròng + cookie).

## ⚠️ Bảo mật

- **KHÔNG commit** `server/.env` và `Thu thap du lieu/api_keys.txt` — chúng chứa secret thật và đã được `.gitignore` loại trừ.
- Server hiện chạy nội bộ (localhost), **không có xác thực**. Nếu deploy ra mạng công khai, hãy thêm lớp xác thực/hạn chế truy cập trước.
