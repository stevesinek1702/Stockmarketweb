import { describe, it, expect, afterAll } from 'vitest';
import { redis, closeRedis } from '../redis-client.js';

afterAll(async () => { await closeRedis(); });

describe('redis connection', () => {
  it('sets and gets a value', async () => {
    await redis.set('test:k', 'v', 'EX', 10);
    const v = await redis.get('test:k');
    expect(v).toBe('v');
    await redis.del('test:k');
  });
});
