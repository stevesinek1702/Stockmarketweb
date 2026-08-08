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
let _last409Logged = 0;
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
        if (e.response && e.response.status === 409) {
            // 409 = có process khác đang polling. Backoff 30s rồi thử lại.
            // Không spam log — chỉ log 1 lần rồi im.
            if (!_last409Logged || Date.now() - _last409Logged > 60000) {
                console.warn('[Telegram] 409 conflict — process khác đang polling, backoff 30s...');
                _last409Logged = Date.now();
            }
            await new Promise(function (r) { setTimeout(r, 30000); });
        } else if (e.code !== 'ECONNABORTED') {
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
            '<b>Phân tích AI:</b>\n' +
            '/ai <b>FPT</b> — AI phân tích toàn diện (Hermes)\n' +
            '/ai <b>FPT</b> có nên mua không? — AI trả lời câu hỏi\n\n' +
            '<b>Dữ liệu nhanh:</b>\n' +
            '/check <b>FPT</b> — SEPA score + TA nhanh\n' +
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

    // /ai FPT [câu hỏi] — AI phân tích toàn diện bằng Hermes/Nemotron
    onCommand('ai', async function (args, chatId) {
        var symbol = (args[0] || '').toUpperCase().trim();
        if (!symbol) return 'Cú pháp: <code>/ai FPT</code> hoặc <code>/ai FPT có nên mua không?</code>';
        var question = args.length > 1 ? args.slice(1).join(' ') : 'Đánh giá tổng quan cổ phiếu này';

        // Thông báo đang phân tích
        await sendMessage('🤖 <b>Hermes AI đang phân tích ' + esc(symbol) + '...</b>\n⏳ Vui lòng đợi 15-30s', { chatId: chatId });

        try {
            // Gọi trading-agent endpoint qua internal POST
            var axios = require('axios');
            var port = process.env.PORT || 3000;
            var resp = await axios.post('http://localhost:' + port + '/api/ai/trading-agent', {
                symbol: symbol,
                question: question
            }, {
                headers: { 'X-Internal-Secret': process.env.INTERNAL_SECRET || '', 'Content-Type': 'application/json' },
                timeout: 120000
            });
            var data = resp.data;
            if (data && data.success && data.analysis) {
                await sendLongMessage(data.analysis, chatId);
                return null; // đã gửi qua sendLongMessage
            }
            return '❌ AI không trả được kết quả: ' + esc(data ? data.error : 'unknown');
        } catch (e) {
            return '❌ Lỗi AI: ' + esc(e.response ? (e.response.data ? e.response.data.error : e.response.status) : e.message);
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

/**
 * Convert Markdown → Telegram HTML (đơn giản: strip ##, **bold**, - bullets).
 * Telegram chỉ hỗ trợ subset HTML (b,i,code,pre — không có h1/h2/ul/li).
 */
function mdToTelegramHtml(md) {
    if (!md) return '';
    var html = esc(md);
    // **bold** → <b>bold</b>
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // ## heading → <b>heading</b>
    html = html.replace(/^##\s+(.+)$/gm, '\n<b>$1</b>');
    // ### heading → <b>heading</b>
    html = html.replace(/^###\s+(.+)$/gm, '<b>$1</b>');
    // `code` → <code>code</code>
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    // Bullet lines starting with - → keep as-is (Telegram shows plain)
    return html;
}

/**
 * Gửi phân tích AI dài — chia thành nhiều tin nhắn nếu quá 4000 ký tự.
 */
async function sendLongMessage(text, chatId) {
    var html = mdToTelegramHtml(text);
    // Telegram giới hạn 4096 ký tự/message
    var MAX = 3500;
    if (html.length <= MAX) {
        return sendMessage(html, { chatId: chatId });
    }
    // Chia theo paragraph
    var parts = [];
    var current = '';
    var paragraphs = html.split('\n');
    for (var i = 0; i < paragraphs.length; i++) {
        if ((current + '\n' + paragraphs[i]).length > MAX) {
            if (current) parts.push(current);
            current = paragraphs[i];
        } else {
            current = current ? current + '\n' + paragraphs[i] : paragraphs[i];
        }
    }
    if (current) parts.push(current);
    for (var j = 0; j < parts.length; j++) {
        await sendMessage(parts[j], { chatId: chatId });
        if (j < parts.length - 1) await new Promise(function (r) { setTimeout(r, 300); });
    }
}

module.exports = {
    isEnabled: isEnabled,
    sendMessage: sendMessage,
    sendHTML: sendHTML,
    sendLongMessage: sendLongMessage,
    onCommand: onCommand,
    startPolling: startPolling,
    stopPolling: stopPolling,
    registerDefaultCommands: registerDefaultCommands,
    esc: esc,
    mdToTelegramHtml: mdToTelegramHtml
};
