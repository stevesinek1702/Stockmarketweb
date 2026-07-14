/**
 * PM2 config — chạy Express ở cluster mode.
 *
 * Cluster mode: PM2 spawn N worker process (default = số CPU), share port.
 * Lợi ích: tận dụng multi-core, tự restart khi crash, zero-downtime reload.
 *
 * Cache layer (Redis+Postgres) + Refresh Scheduler hoạt động đúng trong cluster:
 *  - Redis/Postgres share giữa mọi worker ✓
 *  - Scheduler: mỗi worker đều có setInterval → gọi cùng lúc.
 *    Để tránh trùng, scheduler self-call vào endpoint, endpoint check cache
 *    (Redis lock ngầm qua SETEX) → worker nào cache hit sẽ skip FireAnt call.
 *  - Cookie FireAnt: share qua Redis (hoặc đồng bộ qua Google Sheet như cũ).
 */
module.exports = {
  apps: [{
    name: 'vnstock-server',
    script: 'server.js',
    instances: 'max',        // 1 process per CPU core
    exec_mode: 'cluster',
    autorestart: true,
    max_restarts: 10,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    // Scheduler chỉ chạy ở 1 worker (id=0) để tránh duplicate refresh khi cluster
    env_worker_0: {
      SCHEDULER_DISABLED: '0'
    },
    env_worker_1: {
      SCHEDULER_DISABLED: '1'
    },
    // PM2 không set env theo worker id tự động → dùng cách khác ở dưới.
    // Tạm để mặc định: tất cả worker đều chạy scheduler (Redis SETEX xử lý trùng).
  }]
};
