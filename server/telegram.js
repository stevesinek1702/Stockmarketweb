/**
 * telegram.js — Telegram Bot cho VN Stock Market
 *
 * Tính năng:
 * 1. sendMessage() — gửi tin nhắn tới chat (cho thông báo tín hiệu, autoexec)
 * 2. Webhook/polling — nhận lệnh từ user: /check FPT, /signals, /top, /help
 * 3. Signal notifier — gọi từ scheduler để push tín hiệu mới
 *
 * Config (.env):
 *   TELEGRAM_BOT_TOKEN  — token từ @BotFather
 *   TELEGRAM_CHAT_ID    — chat ID nhận thông báo (group hoặc personal)
 *
 * Không cần thêm dependency — dùng axios (đã có) gọi Telegram Bot HTTP API.
 */

const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const BASE_URL = BOT_TOKEN ? 'https://api.telegram.org/bot' + BOT_TOKEN : '';

let _lastUpdateId = 0;
let _pollingInterval = null;
let _commandHandlers = {}; // có thể register từ server.js

/**
 * Kiểm tra bot đã được cấu hình chưa.
 */
function isEnabled() {
    return !!(BOT_TOKEN && CHAT_ID);
}

/**
 * Gửi tin nhắn text tới chat mặc định hoặc chatId chỉ định.
 * @param {string} text
 * @param {object} [opts] { chatId, parseMode, disablePreview }
 */
async function sendMessage(text, opts) {
    if (!BASE_URL) {
        console.warn('⚠️ [Telegram] BOT_TOKEN chưa cấu hình — bỏ qua sendMessage');
        return null;
    }
    var chatId = (opts && opts.chatId) || CHAT_ID;
    try {
        var resp = await axios.post(BASE_URL + '/sendMessage', {
            chat_id: chatId,
            text: text,
            parse_mode: (opts && opts.parseMode) || 'HTML',
            disable_web_page_preview: opts && opts.disablePreview != null ? opts.disablePreview : true
        }, { timeout: 10000 });
        return resp.data;
    } catch (e) {
        console.error('❌ [Telegram] sendMessage error:', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data) : e.message);
        return null;
    }
}

/**
 * Gửi tin nhắn dạng HTML (shortcut).
 */
async function sendHTML(html, chatId) {
    return sendMessage(html, { chatId: chatId, parseMode: 'HTML' });
}

// ── Command handlers ───────────────────────────────────────────────────────

/**
 * Register command handler.
 * @param {string} cmd  Tên lệnh không có / (VD: 'check', 'signals')
 * @param {function} handler  async (args, chatId) => trả về text HTML
 */
function onCommand(cmd, handler) {
    _commandHandlers[cmd.toLowerCase()] = handler;
}

async function handleUpdate(update) {
    if (!update.message || !update.message.text) return;
    var text = update.message.text.trim();
    var chatId = update.message.chat.id;

    // Parse command: /cmd arg1 arg2
    if (!text.startsWith('/')) return;
    var parts = text.substring(1).split(/\s+/);
    var cmd = parts[0].toLowerCase().split('@')[0]; // strip @botname
    var args = parts.slice(1);

    var handler = _commandHandlers[cmd];
    if (handler) {
        try {
            var reply = await handler(args, chatId);
            if (reply) await sendMessage(reply, { chatId: chatId });
        } catch (e) {
            console.error('[Telegram] Command /' + cmd + ' error:', e.message);
            await sendMessage('❌ Lỗi xử lý lệnh /' + cmd + ': ' + esc(e.message), { chatId: chatId });
        }
    }
}

// ── Polling (long-poll getUpdates) ─────────────────────────────────────────

async function pollOnce() {
    if (!BASE_URL) return;
    try {
        var resp = await axios.post(BASE_URL + '/getUpdates', {
            offset: _lastUpdateId + 1,
            timeout: 30,
            limit: 10
        }, { timeout: 35000 });

        var updates = resp.data && resp.data.result;
        if (Array.isArray(updates)) {
            for (var i = 0; i < updates.length; i++) {
                if (updates[i].update_id > _lastUpdateId) {
                    _lastUpdateId = updates[i].update_id;
                }
                await handleUpdate(updates[i]);
            }
        }
    } catch (e) {
        if (e.code !== 'ECONNABORTED') {
            console.error('[Telegram] poll error:', e.message);
        }
    }
}

/**
 * Bắt đầu polling loop (long-poll). Chỉ chạy nếu bot đã được cấu hình.
 * @param {number} intervalMs  Khoảng thời gian giữa các poll (default 2000)
 */
function startPolling(intervalMs) {
    if (!isEnabled()) {
        console.log('ℹ️ [Telegram] Bot chưa cấu hình (TELEGRAM_BOT_TOKEN/CHAT_ID) — bỏ qua polling');
        return;
    }
    if (_pollingInterval) return;
    intervalMs = intervalMs || 2000;

    // Poll ngay lần đầu
    pollOnce();

    _pollingInterval = setInterval(pollOnce, intervalMs);
    console.log('🤖 [Telegram] Bot polling started (interval=' + intervalMs + 'ms)');
}

function stopPolling() {
    if (_pollingInterval) {
        clearInterval(_pollingInterval);
        _pollingInterval = null;
        console.log('🤖 [Telegram] Bot polling stopped');
    }
}

// ── Escaping & formatting helpers ──────────────────────────────────────────

function esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Đăng ký các lệnh mặc định. Cần truyền app (Express) để gọi internal API.
 */
function registerDefaultCommands(internalFetch) {
    // /help — danh sách lệnh
    onCommand('help', async function () {
        return '<b>🤖 VN Stock Bot — Lệnh</b>\n\n' +
            '/check <b>FPT</b> — Phân tích nhanh 1 cổ phiếu\n' +
            '/signals — Tín hiệu SEPA (BUY/WATCH)\n' +
            '/top — Top cổ phiếu tiềm năng\n' +
            '/breakout — Cổ phiếu phá đỉnh/đáy\n' +
            '/status — Trạng thái server\n' +
            '/help — Danh sách lệnh này';
    });

    // /start — welcome
    onCommand('start', async function () {
        return '<b>👋 Chào bạn!</b>\n\nĐây là bot phân tích chứng khoán VN. Gõ /help để xem danh sách lệnh.';
    });

    // /check FPT — phân tích nhanh
    onCommand('check', async function (args) {
        var symbol = (args[0] || '').toUpperCase().trim();
        if (!symbol) return 'Cú pháp: <code>/check FPT</code>';
        try {
            var data = await internalFetch('/api/sepa-score/' + symbol);
            if (!data || !data.success) return '❌ Không có dữ liệu cho <b>' + esc(symbol) + '</b>';
            var score = data.score || 0;
            var grade = data.grade || '--';
            var ta = data.ta || {};
            var rsi = ta.rsi ? Number(ta.rsi).toFixed(0) : '--';
            var adx = ta.adx ? Number(ta.adx).toFixed(0) : '--';
            var emoji = score >= 80 ? '🟢' : score >= 60 ? '🟡' : score >= 40 ? '🟠' : '🔴';
            return '<b>' + esc(symbol) + '</b> ' + emoji + '\n\n' +
                '<b>SEPA Score:</b> ' + score + '/100 (Grade ' + esc(grade) + ')\n' +
                '<b>RSI:</b> ' + rsi + ' | <b>ADX:</b> ' + adx + '\n' +
                '<b>Xu hướng:</b> ' + esc(ta.trendTemplate || ta.maAlignment || '--');
        } catch (e) {
            return '❌ Lỗi: ' + esc(e.message);
        }
    });

    // /signals — tín hiệu SEPA
    onCommand('signals', async function () {
        try {
            var data = await internalFetch('/api/signals?limit=10');
            if (!data || !Array.isArray(data.signals) || !data.signals.length) {
                return '📭 Chưa có tín hiệu BUY/WATCH nào';
            }
            var lines = data.signals.slice(0, 10).map(function (s) {
                var action = s.signal && s.signal.action ? s.signal.action : s.action || '--';
                var price = s.price || (s.signal && s.signal.entry) || 0;
                var emoji = action === 'BUY' ? '🟢' : '🟡';
                return emoji + ' <b>' + esc(s.symbol) + '</b> — ' + esc(action) + ' @ ' + formatNum(price) + ' (Score: ' + (s.score || '--') + ')';
            });
            return '<b>📡 Tín hiệu giao dịch</b>\n\n' + lines.join('\n');
        } catch (e) {
            return '❌ Lỗi: ' + esc(e.message);
        }
    });

    // /top — top potential stocks
    onCommand('top', async function () {
        try {
            var data = await internalFetch('/api/potential-stocks?limit=8');
            var stocks = (data && data.stocks) || (Array.isArray(data) ? data : []);
            if (!stocks.length) return '📭 Chưa có cổ phiếu tiềm năng';
            var lines = stocks.slice(0, 8).map(function (s, i) {
                var change = s.change || s.priceChange || 0;
                var arrow = change >= 0 ? '📈' : '📉';
                return (i + 1) + '. <b>' + esc(s.symbol) + '</b> ' + arrow + ' ' + (change >= 0 ? '+' : '') + formatNum(change) + '%';
            });
            return '<b>⭐ Top cổ phiếu tiềm năng</b>\n\n' + lines.join('\n');
        } catch (e) {
            return '❌ Lỗi: ' + esc(e.message);
        }
    });

    // /breakout — phá đỉnh/đáy
    onCommand('breakout', async function () {
        try {
            var data = await internalFetch('/api/breadth-breakout');
            if (!data) return '📭 Không có dữ liệu';
            var newHighs = (data.newHighs || []).slice(0, 5);
            var newLows = (data.newLows || []).slice(0, 5);
            var highLines = newHighs.map(function (s) { return '🟢 <b>' + esc(s.symbol || s) + '</b>'; });
            var lowLines = newLows.map(function (s) { return '🔴 <b>' + esc(s.symbol || s) + '</b>'; });
            return '<b>📈 Phá đỉnh / Phá đáy (1 năm)</b>\n\n' +
                '<b>Vượt đỉnh:</b>\n' + (highLines.join('\n') || '—') + '\n\n' +
                '<b>Thủng đáy:</b>\n' + (lowLines.join('\n') || '—');
        } catch (e) {
            return '❌ Lỗi: ' + esc(e.message);
        }
    });

    // /status — server status
    onCommand('status', async function () {
        try {
            var data = await internalFetch('/api/system-status');
            if (!data) return '❌ Không lấy được status';
            var uptime = data.uptime ? Math.round(data.uptime / 60) + ' phút' : '--';
            return '<b>🖥 Server Status</b>\n\n' +
                '<b>Uptime:</b> ' + esc(uptime) + '\n' +
                '<b>Cached responses:</b> ' + (data.cacheSize || '--') + '\n' +
                '<b>Price history symbols:</b> ' + (data.priceHistorySymbols || '--');
        } catch (e) {
            return '❌ Lỗi: ' + esc(e.message);
        }
    });
}

function formatNum(v) {
    if (v == null) return '--';
    var n = Number(v);
    if (!Number.isFinite(n)) return '--';
    return n.toLocaleString('vi-VN');
}

module.exports = {
    isEnabled: isEnabled,
    sendMessage: sendMessage,
    sendHTML: sendHTML,
    onCommand: onCommand,
    startPolling: startPolling,
    stopPolling: stopPolling,
    registerDefaultCommands: registerDefaultCommands,
    esc: esc
};
