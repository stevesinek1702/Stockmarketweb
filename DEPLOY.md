# Hướng dẫn Deploy lên VPS

## Yêu cầu VPS
- Linux (Ubuntu/Debian), 2 vCPU / 2GB RAM tối thiểu
- Docker + Docker Compose đã cài
- Domain (nếu muốn HTTPS) trỏ IP về VPS

## Bước 1: Chuẩn bị code

```bash
git clone <repo-url> /opt/vnstock
cd /opt/vnstock
```

## Bước 2: Tạo `.env` ở root dự án (KHÔNG commit!)

Tạo file `.env` (bên ngoài `server/`) với các biến cho docker-compose:

```env
# Postgres
POSTGRES_USER=vnstock
POSTGRES_PASSWORD=đổi-thành-mật-khẩu-mạnh
POSTGRES_DB=vnstock

# Auth
JWT_SECRET=chạy-openssl-rand-hex-32-để-tạo
ADMIN_USERNAME=admin
ADMIN_PASSWORD=đổi-thành-mật-khẩu-mạnh
ADMIN_EMAIL=admin@example.com

# FireAnt cookie sync
FIREANT_EMAIL=your-fireant-account@email.com
FIREANT_PASSWORD=your-fireant-password
APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
COOKIE_TTL_HOURS=6
COOKIE_SYNC_HOURS=5

# Google Sheet sync (tùy chọn)
GSHEET_SYNC_URL=
GSHEET_SYNC_TOKEN=
```

> Quan trọng: `JWT_SECRET`, `POSTGRES_PASSWORD`, `ADMIN_PASSWORD` **phải đổi** thành giá trị mạnh.

## Bước 3: Khởi động services

```bash
docker compose up -d --build
```

Lần đầu sẽ mất ~5-10 phút (build image + cài Playwright Chromium).

Kiểm tra:
```bash
docker compose ps     # tất cả phải "healthy" / "running"
docker compose logs express | tail -30   # xem log app
```

Log thành công sẽ có:
```
✅ [db] connected
✅ [redis] ready
🚀 VN STOCK MARKET SERVER
```

## Bước 4: Chạy migration + tạo admin (chỉ lần đầu)

```bash
# Chạy migration trong container express
docker compose exec express node scripts/migrate.js

# Tạo admin đầu tiên
docker compose exec express node scripts/seed-admin.js

# (Tùy chọn) Import filter-presets cũ cho admin
docker compose exec express node scripts/import-presets.js
```

## Bước 5: Truy cập

- Mở `http://<IP-VPS>/` → sẽ redirect `/login.html`
- Login bằng `ADMIN_USERNAME` / `ADMIN_PASSWORD` từ `.env`
- Vào `/admin.html` để duyệt user đăng ký hoặc tạo account mới
- User thường vào `/register.html` → admin duyệt → login

## HTTPS (Let's Encrypt) — tùy chọn nhưng nên có

```bash
# Cài certbot trên VPS
sudo apt install certbot

# Lấy cert (thay example.com bằng domain của bạn)
sudo certbot certonly --standalone -d example.com -d www.example.com

# Copy cert vào nginx/certs/
sudo cp /etc/letsencrypt/live/example.com/fullchain.pem nginx/certs/
sudo cp /etc/letsencrypt/live/example.com/privkey.pem nginx/certs/

# Bật block SSL trong nginx/nginx.conf (bỏ comment các dòng listen 443, ssl_certificate)

# Restart nginx
docker compose restart nginx
```

## Các lệnh vận hành

```bash
# Xem log realtime
docker compose logs -f express

# Restart 1 service
docker compose restart express

# Cập nhật code mới
git pull
docker compose up -d --build express

# Backup database
docker compose exec postgres pg_dump -U vnstock vnstock > backup.sql

# Restore
cat backup.sql | docker compose exec -T postgres psql -U vnstock vnstock

# Dừng toàn bộ
docker compose down
```

## Kiến trúc triển khai

```
Internet → Nginx (port 80/443) → Express (PM2 cluster, port 3000)
                                      ↓
                              Postgres + Redis
                                      ↓
                              FireAnt/Fiintrade (qua scheduler)
```

- **Nginx**: TLS termination, rate-limit 30 req/phút, serve static qua proxy
- **Express**: cluster mode (1 worker/CPU), cookie httpOnly auth
- **Postgres**: user data + cache bền
- **Redis**: hot cache + refresh scheduler chống trùng
- **Refresh Scheduler**: pre-warm cache nền → 2000 user request đều cache hit

## Troubleshooting

**Login fail (401):** Kiểm tra đã chạy `npm run seed-admin` chưa. Xem `docker compose logs express | grep -i login`.

**Dashboard trắng:** Cookie httpOnly cần same-origin. Nếu chạy qua reverse proxy, đảm bảo `X-Forwarded-Proto` được set (đã có trong nginx.conf). Test `curl http://localhost/api/health` trong container.

**FireAnt timeout:** Cookie FireAnt cần Playwright Chromium trong container. Verify: `docker compose exec express npx playwright --version`. Nếu lỗi, rebuild: `docker compose build --no-cache express`.

**Redis connection refused:** Đảm bảo `REDIS_URL=redis://redis:6379` (hostname = tên service trong docker-compose, KHÔNG phải localhost).

## Daily Refresh Health (fix 2026-07-22)

Hệ thống tự động refresh data mỗi ngày giao dịch (T2-T6). Nếu thấy dashboard
"stuck" ở data hôm trước (vd hôm nay T4 mà vẫn hiện data T2), kiểm tra theo thứ tự:

### 1. Kiểm tra trạng thái tổng qua endpoint

```bash
# Login admin trước để lấy cookie (or dùng browser đã login)
curl -s -b cookies.txt http://localhost/api/admin/system-status | jq .
```

Endpoint trả:
- `time`: ngày VN hiện tại, `isTradingDay`, `isInEODWindow`, `lastTradingDay`
- `scheduler.running`, `scheduler.lastTickAt` — scheduler có chạy không
- `cookie.lastRefresh` — cookie-sync lần refresh gần nhất (at/status)
- `cache.<key>.hasLastTradingDay` — data phiên gần nhất đã có chưa
- `breadth.ma.hasToday`, `breadth.breakout.hasToday`
- `apiCalls` — counter FireAnt/Fiintrade hôm nay

**Tình huốngHealthy:** `scheduler.running=true`, `lastTickAt` < 30 phút trước,
`cookie.lastRefresh.status=ok`, mọi `hasLastTradingDay=true`.

### 2. Hành vi theo lịch (trading-day aware)

- **Ngày giao dịch (T2-T6), 9-15h VN**: refresh intraday (FireAnt realtime) mỗi 25-55s
- **Ngày giao dịch, 15-23h VN**: refresh EOD (Fiintrade) mỗi 30 phút + build breadth
- **Ngày giao dịch, ngoài 2 window trên**: **MORNING CATCH-UP** mỗi 30 phút — nếu
  EOD/breadth của `lastTradingDay` còn thiếu thì fetch (fix bug "stuck hôm trước"
  khi container restart đêm hoặc lỡ window 15-23h)
- **Cuối tuần (T7/CN)**: SKIP hoàn toàn — giữ data phiên Thứ 6 gần nhất

### 3. Cookie FireAnt tự heal

Cookie FireAnt lấy từ Google Sheet (refresh bởi cookie-sync mỗi 5h qua Playwright).
Khi FireAnt trả 401/403 (cookie hết hạn), endpoint tự trigger `cookie-sync.refreshNow()`
(login lại Playwright → push Sheet) rồi retry. Throttle 5 phút tránh hammer.

**Điều kiện bắt buộc** (nếu thiếu → cookie sẽ tự heal nhưng không có gì để heal):
- `.env` có `FIREANT_EMAIL`, `FIREANT_PASSWORD`, `APPS_SCRIPT_URL`
- Playwright Chromium đã cài trong container (verify: `docker compose exec express npx playwright --version`)

### 4. Debug thủ công

```bash
# Xem log scheduler (tìm 🔄/🌅/✅/⚠️ scheduler)
docker compose logs express | grep -E "scheduler|cookie-heal|MA Breadth|breadth-snapshot"

# Force rebuild + redeploy sau khi pull code mới
git pull
docker compose up -d --build express
```

### 5. Lưu ý holiday

Hệ thống CHƯA hỗ trợ lịch nghỉ lễ VN (Tết, Quốc khánh...). Vào ngày lễ, scheduler
vẫn coi là "trading day" → gọi FireAnt/Fiintrade, nhưng nguồn sẽ trả data phiên
trước → cache `toDate` validation tự xử lý (serve data phiên gần nhất, không crash).
TODO: thêm holiday list trong `trading-time.js` khi cần chính xác hơn.

