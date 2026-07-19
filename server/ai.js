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
- **Độ rộng kỹ thuật (doRongKyThuat)**: Tóm tắt NGẮN 1-2 câu về xu hướng dài hạn qua
  MA50/MA100/MA200. VD: "MA50=35% thị trường yếu, MA200=34% xu hướng dài hạn xấu".
  So sánh xuHuong (phiên trước → hôm nay) để xác nhận đang cải thiện hay xấu đi.
- **Ngành**: top 5 ngành mạnh + top 5 yếu theo lucCau. So sánh với verdictTong breadth
  (lucCau cao nhưng breadth Bearish? → cảnh báo phân kỳ, rủi ro). ĐƯA RA NHẬN ĐỊNH
  2-3 ngành tiềm năng có thể ĐỠ thị trường (lucCau cao + breadth tốt + không thủng đáy)
  kèm lý do cụ thể.
- **Dòng tiền**: khối ngoại + 4 nhóm NĐT. Nếu khối ngoại ròng âm + breadth Bearish
  → cảnh báo rủi ro giảm điểm mạnh.
- **Mã tiềm năng (maTiemNang)**: Nếu có data MACD/RSI crossover signals, phân tích
  TÍN HIỆU cụ thể (MACD cắt lên, RSI quá bán đảo chiều...) — không chỉ thống kê RSI.
  Kết hợp với lucCau, dòng tiền NĐT để chọn 3-5 mã đáng theo dõi nhất + lý do.
  Ưu tiên mã: lucCau cao, giá trên MA50, RSI 40-65 (không quá mua/bán), MACD dương,
  dòng tiền NĐT mua ròng.

Cấu trúc đề xuất (có thể điều chỉnh theo data):
## Tổng quan thị trường
## Lực cầu & Độ rộng thị trường (kèm MA50/100/200 xu hướng)
## Dòng tiền (Khối ngoại + 4 nhóm NĐT)
## Phá Đỉnh/Đáy (breadth breakout) — verdict + vốn hóa tác động
## Ngành nổi bật (mạnh + yếu + ngành thủng đáy + NGÀNH TIỀM NĂNG đỡ thị trường)
## Tín hiệu kỹ thuật & Mã tiềm năng (MACD/RSI crossover + lọc kỹ thuật)
## Mã nổi bật (tác động VNINDEX, top dòng tiền)
## Nhận định & Cảnh báo`;


/**
 * Gọi DeepSeek chat completion (OpenAI-compatible API).
 * @param {Array<{role:string,content:string}>} messages
 * @param {string} [apiKey] — override env key (cho per-user settings)
 * @returns {Promise<string>} text response
 */
async function deepseekChat(messages, apiKey) {
    const key = apiKey || DEEPSEEK_API_KEY;
    if (!key) {
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
                'Authorization': `Bearer ${key}`,
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
 * @param {string} [apiKey] — override env key (cho per-user settings)
 * @returns {Promise<string>} text response
 */
async function geminiChat(prompt, apiKey) {
    const key = apiKey || GEMINI_API_KEY;
    if (!key) {
        throw new Error('GEMINI_API_KEY chưa cấu hình');
    }
    try { require('./cache').apiCounter.bump('gemini').catch(() => {}); } catch (e) {}
    const url = `${GEMINI_URL}?key=${key}`;
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
 * Provider preference: 'auto' = Gemini primary → DeepSeek fallback.
 *                      'gemini' = chỉ Gemini. 'deepseek' = chỉ DeepSeek.
 * @param {object} context — data thị trường (đã được buildMarketContext gọn)
 * @param {string} dateStr — ngày báo cáo (YYYY-MM-DD) cho tiêu đề
 * @param {object} [opts] — { deepseekKey, geminiKey, systemPrompt, provider }
 * @returns {Promise<{text:string, provider:'deepseek'|'gemini'}>}
 */
async function generateMarketReport(context, dateStr, opts = {}) {
    const dsKey = opts.deepseekKey || DEEPSEEK_API_KEY;
    const gmKey = opts.geminiKey || GEMINI_API_KEY;
    const prompt = opts.systemPrompt || SYSTEM_PROMPT;
    const providerPref = opts.provider || 'auto';

    const userPrompt = `Data thị trường chứng khoán Việt Nam ngày ${dateStr} (JSON):

\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

Hãy viết báo cáo tóm tắt thị trường hôm nay theo cấu trúc đã nêu.`;

    const errors = [];

    // Provider order theo preference
    const tryGeminiFirst = providerPref !== 'deepseek';  // 'auto' và 'gemini' → Gemini trước
    const tryDeepSeekFirst = providerPref === 'deepseek';

    const attemptGemini = async () => {
        const fullPrompt = `${prompt}\n\n---\n\n${userPrompt}`;
        const text = await geminiChat(fullPrompt, gmKey);
        return { text, provider: 'gemini' };
    };
    const attemptDeepSeek = async () => {
        const text = await deepseekChat([
            { role: 'system', content: prompt },
            { role: 'user', content: userPrompt }
        ], dsKey);
        return { text, provider: 'deepseek' };
    };

    // Build danh sách provider theo thứ tự preference
    const attempts = [];
    if (tryDeepSeekFirst) {
        attempts.push({ name: 'DeepSeek', fn: attemptDeepSeek });
        if (providerPref === 'auto') attempts.push({ name: 'Gemini', fn: attemptGemini });
    } else {
        attempts.push({ name: 'Gemini', fn: attemptGemini });
        if (providerPref === 'auto') attempts.push({ name: 'DeepSeek', fn: attemptDeepSeek });
    }

    for (const attempt of attempts) {
        try {
            return await attempt.fn();
        } catch (e) {
            errors.push(`${attempt.name}: ${e.message}`);
            console.warn(`⚠️  [ai] ${attempt.name} fail:`, e.message);
        }
    }

    // Tất cả provider đều fail
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
