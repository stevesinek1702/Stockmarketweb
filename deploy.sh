#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# deploy.sh — 1-click deploy VNStock lên VPS Ubuntu
# ════════════════════════════════════════════════════════════════════════
#
# Cách dùng (chạy TRÊN VPS, KHÔNG chạy trên máy local):
#   cd /opt/vnstock
#   ./deploy.sh                  # pull + rebuild express + verify
#   ./deploy.sh --no-build       # chỉ pull + restart (khi chỉ đổi file tĩnh)
#   ./deploy.sh --rollback       # quay về commit trước nếu deploy fail
#   ./deploy.sh --logs           # xem log realtime (Ctrl+C để thoát)
#   ./deploy.sh --status         # xem trạng thái containers + commits
#
# Yêu cầu: git, docker, docker compose v2 đã cài trên VPS Ubuntu.
# ════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}ℹ️  $*${NC}"; }
ok()    { echo -e "${GREEN}✅ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }
err()   { echo -e "${RED}❌ $*${NC}"; }

# ── Locate repo root (chứa docker-compose.yml) ────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
if [[ ! -f docker-compose.yml ]]; then
    err "Không tìm thấy docker-compose.yml. Chạy script từ thư mục gốc repo (/opt/vnstock)."
    exit 1
fi

# ── Helper: ghi lại commit hiện tại trước khi pull (cho rollback) ──────
save_rollback_point() {
    git rev-parse HEAD > /tmp/vnstock_last_good_commit
    info "Rollback point: $(cat /tmp/vnstock_last_good_commit | cut -c1-7)"
}

# ── Mode: --logs ──────────────────────────────────────────────────────
if [[ "${1:-}" == "--logs" ]]; then
    info "Theo dõi log express (Ctrl+C để thoát)..."
    docker compose logs -f express
    exit 0
fi

# ── Mode: --status ────────────────────────────────────────────────────
if [[ "${1:-}" == "--status" ]]; then
    echo -e "\n${BLUE}═══ Container status ═══${NC}"
    docker compose ps
    echo -e "\n${BLUE}═══ Git log (3 commit gần nhất) ═══${NC}"
    git log --oneline -3
    echo -e "\n${BLUE}═══ Health check ═══${NC}"
    if curl -sf -m 5 http://localhost:8080/api/health >/dev/null 2>&1; then
        ok "API health: OK"
    else
        err "API health: FAIL (server chưa sẵn sàng)"
    fi
    exit 0
fi

# ── Mode: --rollback ──────────────────────────────────────────────────
if [[ "${1:-}" == "--rollback" ]]; then
    if [[ ! -f /tmp/vnstock_last_good_commit ]]; then
        err "Không có rollback point (/tmp/vnstock_last_good_commit). Không thể rollback."
        exit 1
    fi
    LAST=$(cat /tmp/vnstock_last_good_commit)
    warn "Rollback về commit $LAST..."
    git fetch origin
    git reset --hard "$LAST"
    docker compose up -d --build express
    ok "Rollback xong. Kiểm tra lại: ./deploy.sh --status"
    exit 0
fi

# ════════════════════════════════════════════════════════════════════════
# MODE DEPLOY MẶC ĐỊNH (hoặc --no-build)
# ════════════════════════════════════════════════════════════════════════
NO_BUILD=0
[[ "${1:-}" == "--no-build" ]] && NO_BUILD=1

echo -e "\n${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  🚀 VNStock Deploy                                          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}\n"

START_TIME=$(date +%s)

# ── Step 1: Pre-flight checks ─────────────────────────────────────────
info "Step 1/5: Pre-flight checks..."
command -v git >/dev/null        || { err "git chưa cài"; exit 1; }
command -v docker >/dev/null     || { err "docker chưa cài"; exit 1; }
docker compose version >/dev/null 2>&1 || { err "docker compose v2 chưa cài"; exit 1; }
ok "Dependencies OK"

# ── Step 2: Save rollback point + git pull ────────────────────────────
info "Step 2/5: Git pull..."
save_rollback_point
git fetch origin
BEFORE=$(git rev-parse --short HEAD)
git pull origin main
AFTER=$(git rev-parse --short HEAD)
if [[ "$BEFORE" == "$AFTER" ]] && [[ "$(git status --porcelain | wc -l)" -eq 0 ]]; then
    warn "Không có code mới (đã ở commit mới nhất $AFTER). Tiếp tục rebuild anyway để chắc chắn."
else
    ok "Cập nhật code: $BEFORE → $AFTER"
fi

# ── Step 3: Rebuild Docker ────────────────────────────────────────────
info "Step 3/5: Docker rebuild..."
if [[ $NO_BUILD -eq 1 ]]; then
    warn "--no-build: chỉ restart container, không rebuild image."
    docker compose up -d --no-build --force-recreate express
else
    docker compose up -d --build express
fi
ok "Container express đã recreate"

# ── Step 4: Đợi server healthy (max 60s) ──────────────────────────────
info "Step 4/5: Đợi server healthy (max 60s)..."
HEALTHY=0
for i in $(seq 1 30); do
    if curl -sf -m 3 http://localhost:8080/api/health >/dev/null 2>&1; then
        HEALTHY=1
        ok "Server healthy sau ${i}*2s"
        break
    fi
    sleep 2
    printf "."
done
echo ""

if [[ $HEALTHY -eq 0 ]]; then
    err "Server KHÔNG healthy sau 60s. Tự động rollback..."
    docker compose logs --tail=30 express 2>&1 | grep -v "redis\|level=warning" | tail -30
    warn "=== ROLLBACK ==="
    LAST=$(cat /tmp/vnstock_last_good_commit)
    git reset --hard "$LAST"
    docker compose up -d --build express
    sleep 8
    if curl -sf -m 5 http://localhost:8080/api/health >/dev/null 2>&1; then
        ok "Rollback thành công, server quay lại bình thường."
    else
        err "Rollback cũng fail! Cần kiểm tra thủ công: docker compose logs express"
    fi
    exit 1
fi

# ── Step 5: Summary ───────────────────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
echo ""
ok "═══ Deploy thành công trong ${DURATION}s ═══"
echo -e "  Commit:  ${GREEN}$(git rev-parse --short HEAD)${NC}"
echo -e "  Message: $(git log -1 --pretty=%s)"
echo -e "  Truy cập: http://$(hostname -I | awk '{print $1}')  hoặc  http://localhost:8080"
echo ""
info "Xem log:    ./deploy.sh --logs"
info "Trạng thái: ./deploy.sh --status"
info "Rollback:   ./deploy.sh --rollback  (quay về commit trước deploy này)"
