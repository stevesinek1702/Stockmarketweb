# Dockerfile cho VN Stock Market app
# Node 20 slim (KHÔNG có Playwright/Chromium — cookie FireAnt đọc từ Google Sheet,
# giảm image size ~1.5GB. Nếu cần Playwright autologin, chạy cookie-sync.js
# ở máy khác rồi đẩy cookie lên Sheet qua Apps Script.)

FROM node:20-bookworm-slim

WORKDIR /app

# Copy package files trước (cache layer)
COPY server/package.json server/package-lock.json* ./server/

# Cài production deps
RUN cd server && (npm ci --omit=dev || npm install --omit=dev)

# Copy source app (frontend + server)
COPY . .

WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Chạy bằng PM2 cluster mode
RUN npm install -g pm2
CMD ["pm2-runtime", "ecosystem.config.js"]
