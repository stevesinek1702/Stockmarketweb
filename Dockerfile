# Dockerfile cho VN Stock Market app
# Node 20 + Chromium (cho Playwright cookie-sync)

FROM node:20-bookworm-slim

# Cài dependencies hệ thống cho Playwright (Chromium)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libdbus-1-3 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files trước (cache layer)
COPY server/package.json server/package-lock.json* ./server/

# Cài deps + Playwright Chromium
RUN cd server && npm ci --omit=dev || npm install --omit=dev
RUN cd server && npx playwright install chromium

# Copy source app (frontend + server)
COPY . .

WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Chạy bằng PM2 để hỗ trợ cluster mode
RUN npm install -g pm2
CMD ["pm2-runtime", "ecosystem.config.js"]
