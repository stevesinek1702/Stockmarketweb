const Redis = require('ioredis');

// REDIS_URL ví dụ: redis://localhost:6379
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
        return Math.min(times * 500, 3000);  // backoff 500ms..3s
    }
});

redis.on('error', (err) => {
    console.error('❌ [redis] error:', err.message);
});

redis.on('connect', () => {
    console.log('✅ [redis] connected');
});

/**
 * Đóng connection khi shutdown (cho test/graceful shutdown).
 */
async function closeRedis() {
    await redis.quit();
}

module.exports = { redis, closeRedis };
