/**
 * AI MODULE — Báo cáo thị trường tự động
 * ─────────────────────────────────────────────────────────────────────────
 * Google Gemini (primary) + DeepSeek (fallback).
 *
 * Cả 2 đều dùng REST API (axios thuần, không cần SDK), OpenAI-compatible:
 *   - DeepSeek: POST https://api.deepseek.com/chat/completions
 *   - Gemini:   POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent
 *
 * API key đọc từ env (DEEPSEEK_API_KEY, GEMINI_API_KEY) — KHÔNG hardcode.
 * Pattern theo fiintrade.js: helper gọn + export đầy đủ.
 */

const axios = require('axios');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GEMINI_MODEL = 'gemini-2.0-flash';

const AI_TIMEOUT = 60000; // 60s — LLM cần thời gian suy nghĩ (báo cáo dài)

// ── System prompt: persona + format ─────────────────────────────────────────
const SYSTEM_PROMPT = `Bạn là chuyên gia phân tích chứng khoán Việt Nam với hơn 10 năm kinh nghiệm.

Nhiệm vụ: viết báo cáo tóm tắt thị trường hôm nay dựa trên data JSON được cung cấp.

Quy tắc:
1. Phong cách: NGẮN GỌN, SÚC ÍCH, có INSIGHT thực sự (không mô tả lan man).
2. Dùng Markdown: ## tiêu đề section, **bold** cho số liệu quan trọng, - bullet list.
3. Tiếng Việt, thuật ngữ tài chính giữ nguyên (lucCau, breadth, breakout, GTGD...).
4. LUÔN dẫn số liệu cụ thể (ví dụ: "VNINDEX +0.8% (1,245.6)", "lucCau BĐS 43.1%").
5. Đưa ra nhận định + cảnh báo rủi ro, không chỉ mô tả data.
6. KHÔNG bịa số liệu — chỉ dùng data được cung cấp. Nếu thiếu, nói "không có dữ liệu".

PHÂN TÍCH SÂU — phần quan trọng nhất:
- **Phá đỉnh/đáy (breadth breakout)**: Đây là chỉ báo RẤT QUAN TRỌNG. Luôn phân tích
  verdictTong (Bullish/Bearish/Neutral), tyLeDayDinh (vốn hóa phá đáy / phá đỉnh —
  >1 = dòng tiền lớn đang rút, Bearish mạnh). Nêu rõ ngành nào bị thủng đáy nhiều
  nhất (vonHoaPhaDay, soMaPhaDay).
- **Ngành**: top 5 ngành mạnh + top 5 yếu theo lucCau. So sánh với verdictTong breadth
  (lucCau cao nhưng breadth Bearish? → cảnh báo phân kỳ, rủi ro).
- **Dòng tiền**: khối ngoại + 4 nhóm NĐT. Nếu khối ngoại ròng âm + breadth Bearish
  → cảnh báo rủi ro giảm điểm mạnh.

Cấu trúc đề xuất (có thể điều chỉnh theo data):
## Tổng quan thị trường
## Lực cầu & Độ rộng thị trường
## Dòng tiền (Khối ngoại + 4 nhóm NĐT)
## Phá Đỉnh/Đáy (breadth breakout) — verdict + vốn hóa tác động
## Ngành nổi bật (mạnh + yếu + ngành thủng đáy)
## Tín hiệu kỹ thuật (RSI, mã tác động VNINDEX)
## Mã nổi bật (top mua/bán ròng, phá đỉnh/đáy)
## Nhận định & Cảnh báo`;

/**
 * Gọi DeepSeek chat completion (OpenAI-compatible API).
 * @param {Array<{role:string,content:string}>} messages
 * @returns {Promise<string>} text response
 */
async function deepseekChat(messages) {
    if (!DEEPSEEK_API_KEY) {
        throw new Error('DEEPSEEK_API_KEY chưa cấu hình');
    }
    try { require('./cache').apiCounter.bump('deepseek').catch(() => {}); } catch (e) {}
    const res = await axios.post(
        DEEPSEEK_URL,
        {
            model: DEEPSEEK_MODEL,
            messages,
            temperature: 0.3,       // thấp → output ổn định, ít sáng tạo thỡ
            max_tokens: 2000,       // đủ cho báo cáo ~1-2 trang
            stream: false
        },
        {
            headers: {
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: AI_TIMEOUT
        }
    );
    const text = res.data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('DeepSeek trả response rỗng');
    return text;
}

/**
 * Gọi Google Gemini generateContent.
 * @param {string} prompt — system + user prompt gộp (Gemini không có system role riêng)
 * @returns {Promise<string>} text response
 */
async function geminiChat(prompt) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY chưa cấu hình');
    }
    try { require('./cache').apiCounter.bump('gemini').catch(() => {}); } catch (e) {}
    const url = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
    const res = await axios.post(
        url,
        {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 2000
            }
        },
        {
            headers: { 'Content-Type': 'application/json' },
            timeout: AI_TIMEOUT
        }
    );
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini trả response rỗng');
    return text;
}

/**
 * Sinh báo cáo thị trường từ context JSON.
 * Gemini primary → nếu fail → DeepSeek fallback.
 * @param {object} context — data thị trường (đã được buildMarketContext gọn)
 * @param {string} dateStr — ngày báo cáo (YYYY-MM-DD) cho tiêu đề
 * @returns {Promise<{text:string, provider:'deepseek'|'gemini'}>}
 */
async function generateMarketReport(context, dateStr) {
    const userPrompt = `Data thị trường chứng khoán Việt Nam ngày ${dateStr} (JSON):

\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

Hãy viết báo cáo tóm tắt thị trường hôm nay theo cấu trúc đã nêu.`;

    const errors = [];

    // 1. Gemini (primary)
    try {
        const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;
        const text = await geminiChat(fullPrompt);
        return { text, provider: 'gemini' };
    } catch (e) {
        errors.push(`Gemini: ${e.message}`);
        console.warn('⚠️  [ai] Gemini fail, thử DeepSeek:', e.message);
    }

    // 2. DeepSeek (fallback)
    try {
        const text = await deepseekChat([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ]);
        return { text, provider: 'deepseek' };
    } catch (e) {
        errors.push(`DeepSeek: ${e.message}`);
        console.warn('⚠️  [ai] DeepSeek fail:', e.message);
    }

    // Cả 2 đều fail
    const err = new Error(`Tất cả AI provider đều lỗi: ${errors.join('; ')}`);
    err.providerErrors = errors;
    throw err;
}

/**
 * Kiểm tra AI có sẵn sàng không (ít nhất 1 key được cấu hình).
 */
function isAvailable() {
    return !!(DEEPSEEK_API_KEY || GEMINI_API_KEY);
}

module.exports = {
    deepseekChat,
    geminiChat,
    generateMarketReport,
    isAvailable,
    SYSTEM_PROMPT
};
