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
