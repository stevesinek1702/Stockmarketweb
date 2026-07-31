import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock env trước khi import module
describe('fiintrade proxy', () => {
  let origEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = origEnv;
    vi.resetModules();
  });

  it('buildFiinUrl: không có FIINTRADE_PROXY_URL → trả url gốc (gọi trực tiếp)', async () => {
    delete process.env.FIINTRADE_PROXY_URL;
    const { buildFiinUrl } = await import('../fiintrade.js');
    const url = 'https://wl-market.fiintrade.vn/test?x=1';
    expect(buildFiinUrl(url)).toBe(url);
  });

  it('buildFiinUrl: có FIINTRADE_PROXY_URL → encode url gốc vào path', async () => {
    process.env.FIINTRADE_PROXY_URL = 'https://my-proxy.workers.dev';
    const { buildFiinUrl } = await import('../fiintrade.js');
    const url = 'https://wl-market.fiintrade.vn/test?x=1&y=2';
    expect(buildFiinUrl(url)).toBe('https://my-proxy.workers.dev/' + encodeURIComponent(url));
  });

  it('buildFiinUrl: strip trailing slash của proxy URL', async () => {
    process.env.FIINTRADE_PROXY_URL = 'https://my-proxy.workers.dev/';
    const { buildFiinUrl } = await import('../fiintrade.js');
    const url = 'https://wl-market.fiintrade.vn/x';
    expect(buildFiinUrl(url)).not.toContain('.dev//');
    expect(buildFiinUrl(url)).toBe('https://my-proxy.workers.dev/' + encodeURIComponent(url));
  });
});
