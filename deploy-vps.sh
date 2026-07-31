#!/bin/bash
# Deploy 1-lệnh lên VPS (chạy TRÊN VPS).
# Usage: bash deploy-vps.sh
set -e
cd "$(dirname "$0")"
echo "=== Git pull code mới ==="
git pull origin main
echo "=== Rebuild + restart express container (postgres/redis giữ nguyên, không mất data) ==="
docker compose up -d --build express
echo "=== Trạng thái container ==="
docker compose ps
echo "=== ✅ Deploy xong. Reload web để thấy feature mới. ==="
