import { describe, it, expect } from 'vitest';
import { query } from '../db.js';

describe('db connection', () => {
  it('connects and returns 1', async () => {
    const res = await query('SELECT 1 AS n');
    expect(res.rows[0].n).toBe(1);
  });
});
