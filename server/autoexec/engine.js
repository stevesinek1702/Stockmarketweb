/**
 * Auto-exec engine — poll signals → tự place orders (paper/live) + safety.
 *
 * Safety layers:
 *   1. Kill-switch: AUTOEXEC_ENABLED env + runtime toggle (DB/Redis flag).
 *   2. Max daily loss: dừng nếu P&L ngày <= -MAX_DAILY_LOSS_PCT.
 *   3. Max open positions: không mua mới nếu đã đạt MAX_OPEN_POSITIONS.
 *   4. Trading hours only: chỉ chạy trong phiên (9-15h VN, T2-T6).
 *   5. Paper default: BROKER_MODE=paper cho đến khi explicit live.
 *
 * Loop: mỗi AUTOEXEC_INTERVAL_MS (mặc định 5 phút) trong phiên:
 *   - Lấy signals BUY từ /api/signals
 *   - Cho mỗi signal: check safety → place order qua broker
 *   - Check positions hiện tại → SELL_SL/EXIT nếu signal đổi
 */
const tt = require('../trading-time'); // reuse từ #1 fix
const { getBroker, currentMode } = require('../broker');

const AUTOEXEC_INTERVAL_MS = parseInt(process.env.AUTOEXEC_INTERVAL_MS || '300000'); // 5 min
const MAX_DAILY_LOSS_PCT = parseFloat(process.env.MAX_DAILY_LOSS_PCT || '5'); // dừng nếu -5% ngày

// State lưu Redis (cluster-safe) — _enabled/_lastRunAt/_lastResult/_dayStartValue
// share giữa mọi PM2 worker. _running/_timer ở in-memory (per-worker).
let _running = false;
let _timer = null;
const STATE_KEY = 'autoexec:state';

function _getRedis() {
  if (!process.env.REDIS_URL) return null;
  try { return require('../redis-client').redis; } catch (e) { return null; }
}

async function _getState() {
  const redis = _getRedis();
  if (redis) {
    try {
      const raw = await redis.get(STATE_KEY);
      if (raw) return JSON.parse(raw);
      // Redis OK nhưng chưa có key → dùng _memState (fallback) + sync lên Redis
      return _memState;
    } catch (e) { return _memState; }
  }
  return _memState;
}

async function _setState(patch) {
  Object.assign(_memState, patch);
  const redis = _getRedis();
  if (redis) {
    try { await redis.set(STATE_KEY, JSON.stringify(_memState)); } catch (e) { /* keep in-memory */ }
  }
}
let _memState = { enabled: process.env.AUTOEXEC_ENABLED === '1', lastRunAt: null, lastResult: null, dayStartValue: null };

async function isEnabled() { return (await _getState()).enabled; }
async function enable() { await _setState({ enabled: true }); console.log('🟢 [autoexec] ENABLED'); }
async function disable() { await _setState({ enabled: false }); console.log('🔴 [autoexec] DISABLED (kill-switch)'); }

async function status() {
  const s = await _getState();
  return {
    enabled: s.enabled,
    running: _running,
    lastRunAt: s.lastRunAt,
    lastResult: s.lastResult,
    brokerMode: currentMode(),
    intervalMs: AUTOEXEC_INTERVAL_MS,
    maxDailyLossPct: MAX_DAILY_LOSS_PCT,
    dayStartValue: s.dayStartValue
  };
}

/**
 * Safety check trước khi đặt lệnh.
 * Trading-hours check tách riêng (chỉ trong loop startLoop) — checkSafety testable mọi lúc.
 * @returns {{ok:boolean, reason?:string}}
 */
async function checkSafety(broker) {
  const s = await _getState();
  if (!s.enabled) return { ok: false, reason: 'autoexec disabled (kill-switch)' };
  try {
    const pf = await broker.getPortfolio({});
    let dayStart = s.dayStartValue;
    if (dayStart == null) {
      dayStart = pf.totalValue;
      await _setState({ dayStartValue: dayStart });
    }
    const dayPnl = dayStart > 0 ? (pf.totalValue - dayStart) / dayStart * 100 : 0;
    if (dayPnl <= -MAX_DAILY_LOSS_PCT) {
      return { ok: false, reason: `max daily loss hit (${dayPnl.toFixed(1)}% <= -${MAX_DAILY_LOSS_PCT}%)` };
    }
    const cfg = require('../signals/config').loadConfig();
    if (pf.positions && pf.positions.length >= cfg.maxOpenPositions) {
      return { ok: false, reason: `max open positions (${pf.positions.length} >= ${cfg.maxOpenPositions})` };
    }
    return { ok: true, totalValue: pf.totalValue, cash: pf.cash, positions: pf.positions.length };
  } catch (e) {
    return { ok: false, reason: 'portfolio check fail: ' + e.message };
  }
}

async function resetDay() {
  await _setState({ dayStartValue: null });
  console.log('🔄 [autoexec] day-start value reset');
}

async function runOnce(signalFetcher) {
  if (_running) return { skipped: 'already running' };
  _running = true;
  const ts = new Date().toISOString();
  try {
    const broker = getBroker();
    const safety = await checkSafety(broker);
    if (!safety.ok) {
      const result = { skipped: safety.reason };
      await _setState({ lastRunAt: ts, lastResult: result });
      return result;
    }
    const account = (safety.totalValue || 100_000_000);
    const signalsData = await signalFetcher(account);
    const buySignals = (signalsData.results || []).filter(s => s.action === 'BUY');
    const { positionSize } = require('../signals');
    const orders = [];
    let skippedNoCash = 0;
    // Track cash còn đủ: lấy từ portfolio, giảm sau mỗi lệnh fill.
    let availableCash = safety.cash != null ? safety.cash : account;
    for (const sig of buySignals) {
      const size = positionSize(account, sig.signal.entry, sig.signal.stop, availableCash);
      if (size.shares <= 0) { skippedNoCash++; continue; }
      try {
        const order = await broker.placeOrder({
          symbol: sig.symbol, side: 'BUY', type: 'LO',
          qty: size.shares, price: sig.signal.entry
        }, { currentPrice: sig.price });
        // Trừ cash còn đủ (chỉ nếu fill thành công)
        if (order && order.status === 'filled') {
          availableCash -= (order.filledQty || size.shares) * (order.fillPrice || sig.signal.entry);
        }
        orders.push({ symbol: sig.symbol, order });
      } catch (e) {
        orders.push({ symbol: sig.symbol, error: e.message });
      }
    }
    const result = { placed: orders.length, orders, skippedNoCash, brokerMode: broker.mode };
    await _setState({ lastRunAt: ts, lastResult: result });
    console.log(`🤖 [autoexec] placed ${orders.length} orders (${broker.mode}), skipped ${skippedNoCash} (no cash)`);
    return result;
  } catch (e) {
    const result = { error: e.message };
    await _setState({ lastRunAt: ts, lastResult: result });
    console.error('[autoexec] runOnce error:', e.message);
    return result;
  } finally {
    _running = false;
  }
}

/**
 * Khởi động loop. signalFetcher = async (account) → { results }.
 */
function startLoop(signalFetcher) {
  if (_timer) return;
  if (process.env.AUTOEXEC_ENABLED !== '1') {
    console.log('⏸️  [autoexec] disabled (AUTOEXEC_ENABLED !== 1)');
    return;
  }
  console.log(`🤖 [autoexec] starting loop (interval ${AUTOEXEC_INTERVAL_MS}ms, broker=${currentMode()})`);
  _timer = setInterval(async () => {
    const s = await _getState();
    if (!s.enabled) return; // kill-switch off
    if (tt.isInTradingHours()) {
      if (s.dayStartValue == null) await resetDay();
      await runOnce(signalFetcher);
    }
  }, AUTOEXEC_INTERVAL_MS);
}

function stopLoop() {
  if (_timer) { clearInterval(_timer); _timer = null; console.log('⛔ [autoexec] loop stopped'); }
}

module.exports = { startLoop, stopLoop, runOnce, checkSafety, status, enable, disable, resetDay, isEnabled };
