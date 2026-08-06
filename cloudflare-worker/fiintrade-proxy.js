/**
 * Cloudflare Worker: Fiintrade Proxy
 * ─────────────────────────────────────────────────────────────────────────
 * Mục đích: Fiintrade (wl-*.fiintrade.vn) chặn IP datacenter VPS Vietnix.
 * Worker này forward request fiintrade — IP Cloudflare không bị block (CDN lớn).
 *
 * Cách dùng:
 *   GET https://<worker>.workers.dev/<encoded-fiintrade-url>
 *   VD: https://fiintrade-proxy.xxx.workers.dev/https%3A%2F%2Fwl-market.fiintrade.vn%2F...
 *
 * Worker forward tới URL thật + thêm Origin/Referer iBoard (yêu cầu của fiintrade).
 *
 * Deploy (1 lần, free):
 *   1. Tạo tài khoản Cloudflare (free) tại https://dash.cloudflare.com/sign-up
 *   2. Vào Workers & Pages → Create Worker → đặt tên "fiintrade-proxy"
 *   3. Paste toàn bộ file này vào editor → Deploy
 *   4. Copy Worker URL (vd https://fiintrade-proxy.abc.workers.dev)
 *   5. Set env trên VPS: FIINTRADE_PROXY_URL=https://fiintrade-proxy.abc.workers.dev
 *
 * Free tier: 100,000 requests/ngày (đủ dư cho app cron mỗi phút).
 */

const FII_HEADERS = {
  'accept': 'application/json',
  'origin': 'https://iboard.ssi.com.vn',
  'referer': 'https://iboard.ssi.com.vn/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
};

// Chỉ cho phép forward tới fiintrade (chống open proxy abuse)
// wl-market: dòng tiền ngành, GetStatisticInvestor, TopMover
// wl-core:   master data (organCode map)
// wl-technical: GetPriceData (dòng tiền per-mã) — BỔ SUNG fix 403 bảng Dòng Tiền Thông Minh
const ALLOWED_HOSTS = ['wl-market.fiintrade.vn', 'wl-core.fiintrade.vn', 'wl-technical.fiintrade.vn'];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Path sau worker = URL gốc đã encode
    const targetEnc = url.pathname.slice(1); // bỏ leading /
    let targetUrl;
    try {
      targetUrl = decodeURIComponent(targetEnc);
    } catch (e) {
      return new Response('Invalid encoded URL', { status: 400 });
    }

    // Validate: chỉ forward tới fiintrade
    let target;
    try {
      target = new URL(targetUrl);
    } catch (e) {
      return new Response('Invalid target URL', { status: 400 });
    }
    if (!ALLOWED_HOSTS.includes(target.hostname)) {
      return new Response('Host not allowed. Only wl-*.fiintrade.vn', { status: 403 });
    }

    // Forward request (giữ query string)
    target.search = url.search;
    try {
      const resp = await fetch(target.toString(), {
        method: request.method,
        headers: FII_HEADERS,
        redirect: 'follow'
      });
      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: {
          'content-type': resp.headers.get('content-type') || 'application/json',
          'access-control-allow-origin': '*'
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { 'content-type': 'application/json' }
      });
    }
  }
};
