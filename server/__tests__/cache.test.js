import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getCached, setCached, getStale, invalidate } from '../cache.js';
import { redis, closeRedis } from '../redis-client.js';
import { query } from '../db.js';

afterAll(async () => { await closeRedis(); });

beforeEach(async () => {
    // Xoá key test trước mỗi case
    await invalidate('test:k');
});

describe('cache module', () => {
  it('returns null when key absent', async () => {
    const v = await getCached('test:k', 60000);
    expect(v).toBeNull();
  });

  it('set then get returns the data (Redis hit)', async () => {
    await setCached('test:k', { hello: 'world' }, 60000);
    const v = await getCached('test:k', 60000);
    expect(v).toEqual({ hello: 'world' });
  });

  it('persists to Postgres (survives Redis miss)', async () => {
    await setCached('test:k', { n: 42 }, 60000);
    // Giả lập Redis miss: xoá key Redis
    await redis.del('cache:test:k');
    const v = await getCached('test:k', 60000);
    expect(v).toEqual({ n: 42 });
    // Redis phải được repopulate
    const raw = await redis.get('cache:test:k');
    expect(raw).not.toBeNull();
  });

  it('getStale returns data even when TTL expired (within Postgres)', async () => {
    // Insert 1 row có fetched_at cũ (TTL đã hết)
    await query(
      `INSERT INTO api_cache (cache_key, data, fetched_at, ttl_seconds)
       VALUES ('test:k', '{"x":1}', now() - interval '1 hour', 60)
       ON CONFLICT (cache_key) DO UPDATE SET data=EXCLUDED.data, fetched_at=EXCLUDED.fetched_at, ttl_seconds=EXCLUDED.ttl_seconds`,
      []
    );
    await redis.del('cache:test:k');
    const stale = await getStale('test:k');
    expect(stale).toEqual({ x: 1 });
  });

  it('getStale returns null when key absent', async () => {
    const stale = await getStale('test:absent');
    expect(stale).toBeNull();
  });
});
