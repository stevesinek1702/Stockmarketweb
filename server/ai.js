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
const TOKENROUTER_API_KEY = process.env.TOKENROUTER_API_KEY || '';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GEMINI_MODEL = 'gemini-2.0-flash';
const TOKENROUTER_URL = 'https://api.tokenrouter.com/v1/chat/completions';
const TOKENROUTER_MODEL = 'z-ai/glm-5.2-free';  // GLM-5.2 (free tier trên TokenRouter)

const AI_TIMEOUT = 180000; // 180s — GLM-5.2 free tier chậm (có reasoning), cần timeout dài

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
  trangThaiThiTruong (Bullish/Bearish/Neutral), tyLeDayDinh (vốn hóa phá đáy / phá đỉnh —
  >1 = dòng tiền lớn đang rút, Bearish mạnh). Nêu rõ ngành nào bị thủng đáy nhiều
  nhất (vonHoaPhaDay, soMaPhaDay).
- **Độ rộng kỹ thuật (doRongKyThuat)**: Đây là BREADTH = SỐ MÃ CỔ PHIẾU trên MA
  (không phải giá trị điểm). VD: "530/1576 mã trên MA200 (33.6%)" nghĩa là chỉ 33.6%
  mã đang giá trên MA200 → thị trường yếu. So sánh xuHuongMA50 (phiên trước → hôm nay).
  TÓM TẮT NGẮN 1-2 câu.
- **MA VNINDEX (vnindexMA)**: Đây là GIÁ TRỊ ĐIỂM VNINDEX + MA50/100/200 (~1771 điểm).
  KHÁC HOÀN TOÀN với breadth. VD: "VNINDEX 1787 đang TRÊN MA200 1771 (+0.9%) → xu hướng
  dài hạn tích cực". Luôn phân tích vị trí giá so với MA200 (trên/dưới, cách bao nhiêu %).
- **Ngành**: top 5 ngành mạnh + top 5 yếu theo lucCau. So sánh với trangThaiThiTruong
  (lucCau cao nhưng trạng thái Bearish? → cảnh báo phân kỳ, rủi ro). ĐƯA RA NHẬN ĐỊNH
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
## Lực cầu & Độ rộng thị trường (breadth số mã + MA VNINDEX điểm)
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
 * Gọi TokenRouter (GLM-5.2) — OpenAI-compatible API.
 * Free tier chậm (có reasoning) → timeout 180s.
 * @param {Array<{role:string,content:string}>} messages
 * @param {string} [apiKey] — override env key
 * @returns {Promise<string>} text response
 */
async function tokenrouterChat(messages, apiKey) {
    const key = apiKey || TOKENROUTER_API_KEY;
    if (!key) {
        throw new Error('TOKENROUTER_API_KEY chưa cấu hình');
    }
    try { require('./cache').apiCounter.bump('tokenrouter').catch(() => {}); } catch (e) {}
    const res = await axios.post(
        TOKENROUTER_URL,
        {
            model: TOKENROUTER_MODEL,
            messages,
            temperature: 0.3,
            max_tokens: 3000,        // GLM-5.2 tốn nhiều tokens cho reasoning
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
    // GLM-5.2 có thể trả content rỗng + reasoning_content (nếu max_tokens thấp)
    // Ưu tiên content, fallback reasoning_content nếu content rỗng
    const msg = res.data?.choices?.[0]?.message;
    let text = msg?.content || '';
    if (!text && msg?.reasoning_content) {
        text = msg.reasoning_content;  // fallback: dùng reasoning nếu content rỗng
    }
    if (!text) throw new Error('TokenRouter/GLM trả response rỗng');
    return text;
}

/**
 * Sinh báo cáo thị trường từ context JSON.
 * Provider preference:
 *   'auto'  = GLM-5.2 → DeepSeek → Gemini (fallback chain)
 *   'glm'   = chỉ GLM-5.2 (TokenRouter)
 *   'deepseek' = chỉ DeepSeek
 *   'gemini' = chỉ Gemini
 * @param {object} context — data thị trường (đã được buildMarketContext gọn)
 * @param {string} dateStr — ngày báo cáo (YYYY-MM-DD) cho tiêu đề
 * @param {object} [opts] — { deepseekKey, geminiKey, tokenrouterKey, systemPrompt, provider }
 * @returns {Promise<{text:string, provider:string}>}
 */
async function generateMarketReport(context, dateStr, opts = {}) {
    const dsKey = opts.deepseekKey || DEEPSEEK_API_KEY;
    const gmKey = opts.geminiKey || GEMINI_API_KEY;
    const trKey = opts.tokenrouterKey || TOKENROUTER_API_KEY;
    const prompt = opts.systemPrompt || SYSTEM_PROMPT;
    const providerPref = opts.provider || 'auto';

    const userPrompt = `Data thị trường chứng khoán Việt Nam ngày ${dateStr} (JSON):

\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

Hãy viết báo cáo tóm tắt thị trường hôm nay theo cấu trúc đã nêu.`;

    const errors = [];

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
    const attemptGLM = async () => {
        const text = await tokenrouterChat([
            { role: 'system', content: prompt },
            { role: 'user', content: userPrompt }
        ], trKey);
        return { text, provider: 'glm' };
    };

    // Build danh sách provider theo thứ tự preference
    const providerMap = {
        'glm':      { name: 'GLM-5.2', fn: attemptGLM },
        'deepseek': { name: 'DeepSeek', fn: attemptDeepSeek },
        'gemini':   { name: 'Gemini', fn: attemptGemini }
    };
    const attempts = [];
    if (providerPref === 'auto') {
        // Auto: GLM-5.2 → DeepSeek → Gemini (GLM free chậm nhưng mạnh)
        attempts.push(providerMap.glm, providerMap.deepseek, providerMap.gemini);
    } else if (providerMap[providerPref]) {
        // Single provider
        attempts.push(providerMap[providerPref]);
    } else {
        // Fallback auto
        attempts.push(providerMap.glm, providerMap.deepseek, providerMap.gemini);
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
    return !!(TOKENROUTER_API_KEY || DEEPSEEK_API_KEY || GEMINI_API_KEY);
}

module.exports = {
    deepseekChat,
    geminiChat,
    tokenrouterChat,
    generateMarketReport,
    isAvailable,
    SYSTEM_PROMPT
};
