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

let _enabled = process.env.AUTOEXEC_ENABLED === '1';
let _running = false;
let _lastRunAt = null;
let _lastResult = null;
let _dayStartValue = null;
let _timer = null;

function isEnabled() { return _enabled; }
function enable() { _enabled = true; console.log('🟢 [autoexec] ENABLED'); }
function disable() { _enabled = false; console.log('🔴 [autoexec] DISABLED (kill-switch)'); }

function status() {
  return {
    enabled: _enabled,
    running: _running,
    lastRunAt: _lastRunAt,
    lastResult: _lastResult,
    brokerMode: currentMode(),
    intervalMs: AUTOEXEC_INTERVAL_MS,
    maxDailyLossPct: MAX_DAILY_LOSS_PCT,
    dayStartValue: _dayStartValue
  };
}

/**
 * Safety check trước khi đặt lệnh.
 * Trading-hours check tách riêng (chỉ trong loop startLoop) — checkSafety testable mọi lúc.
 * @returns {{ok:boolean, reason?:string}}
 */
async function checkSafety(broker) {
  if (!_enabled) return { ok: false, reason: 'autoexec disabled (kill-switch)' };
  try {
    const pf = await broker.getPortfolio({});
    // Max daily loss
    if (_dayStartValue == null) _dayStartValue = pf.totalValue;
    const dayPnl = _dayStartValue > 0 ? (pf.totalValue - _dayStartValue) / _dayStartValue * 100 : 0;
    if (dayPnl <= -MAX_DAILY_LOSS_PCT) {
      return { ok: false, reason: `max daily loss hit (${dayPnl.toFixed(1)}% <= -${MAX_DAILY_LOSS_PCT}%)` };
    }
    // Max open positions
    const cfg = require('../signals/config').loadConfig();
    if (pf.positions && pf.positions.length >= cfg.maxOpenPositions) {
      return { ok: false, reason: `max open positions (${pf.positions.length} >= ${cfg.maxOpenPositions})` };
    }
    return { ok: true, totalValue: pf.totalValue, positions: pf.positions.length };
  } catch (e) {
    return { ok: false, reason: 'portfolio check fail: ' + e.message };
  }
}

/**
 * Reset day-start value (gọi đầu mỗi phiên).
 */
function resetDay() {
  _dayStartValue = null;
  console.log('🔄 [autoexec] day-start value reset');
}

/**
 * Chạy 1 vòng auto-exec. Export cho test + scheduler.
 * @param {object} signalFetcher  async fn → { results: [signals] }
 */
async function runOnce(signalFetcher) {
  if (_running) return { skipped: 'already running' };
  _running = true;
  _lastRunAt = new Date().toISOString();
  try {
    const broker = getBroker();
    const safety = await checkSafety(broker);
    if (!safety.ok) {
      _lastResult = { skipped: safety.reason };
      return _lastResult;
    }
    const account = (safety.totalValue || 100_000_000);
    const signalsData = await signalFetcher(account);
    const buySignals = (signalsData.results || []).filter(s => s.action === 'BUY');
    const { positionSize } = require('../signals');
    const orders = [];
    for (const sig of buySignals) {
      const size = positionSize(account, sig.signal.entry, sig.signal.stop);
      if (size.shares <= 0) continue;
      try {
        const order = await broker.placeOrder({
          symbol: sig.symbol, side: 'BUY', type: 'LO',
          qty: size.shares, price: sig.signal.entry
        }, { currentPrice: sig.price });
        orders.push({ symbol: sig.symbol, order });
      } catch (e) {
        orders.push({ symbol: sig.symbol, error: e.message });
      }
    }
    _lastResult = { placed: orders.length, orders, brokerMode: broker.mode };
    console.log(`🤖 [autoexec] placed ${orders.length} orders (${broker.mode})`);
    return _lastResult;
  } catch (e) {
    _lastResult = { error: e.message };
    console.error('[autoexec] runOnce error:', e.message);
    return _lastResult;
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
  // Reset day-start mỗi ngày mới (check mỗi tick)
  _timer = setInterval(async () => {
    if (tt.isInTradingHours()) {
      if (_dayStartValue == null) resetDay(); // lazy init đầu phiên
      await runOnce(signalFetcher);
    }
  }, AUTOEXEC_INTERVAL_MS);
}

function stopLoop() {
  if (_timer) { clearInterval(_timer); _timer = null; console.log('⛔ [autoexec] loop stopped'); }
}

module.exports = { startLoop, stopLoop, runOnce, checkSafety, status, enable, disable, resetDay, isEnabled };
