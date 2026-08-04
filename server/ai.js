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
const DEEPSEEK_MODEL = 'deepseek-v4-pro';  // DeepSeek V4 Pro (1M context, JSON + tool calls)
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GEMINI_MODEL = 'gemini-2.0-flash';
const TOKENROUTER_URL = 'https://api.tokenrouter.com/v1/chat/completions';
const TOKENROUTER_MODEL = 'z-ai/glm-5.2-free';  // GLM-5.2 (free tier trên TokenRouter)

const AI_TIMEOUT = 120000; // 120s — GLM-5.2 nhanh khi tắt reasoning (5-30s)

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

// ═══════════════════════════════════════════════════════════════════════
// BÁO CÁO TUẦN / THÁNG — góc nhìn xu hướng (không phải "hôm nay")
// ═══════════════════════════════════════════════════════════════════════

const WEEKLY_PROMPT = `Bạn là chuyên gia phân tích chứng khoán Việt Nam với hơn 10 năm kinh nghiệm.

Nhiệm vụ: viết BÁO CÁO TUẦN (tổng kết 5 phiên giao dịch gần nhất) dựa trên data JSON.

⚠️ YÊU CẦU TỐI ƯU TIÊN:
1. JSON có thongKeKy (đẦU file) → LUÔN dùng cho "## Thống kê tuần" (VNINDEX % cả tuần, breadth MA đầu→cuối).
2. JSON có tinTucViMo (15 tin vĩ mô NHNN/chính sách) → LUÔN viết "## 📌 Vĩ mô & Chính sách" phân tích từng tin.
BẮT BUỘC có cả 2 section này. KHÔNG ĐƯỢC BỎ. Nếu bỏ = báo cáo SAI.

Khác biệt so với báo cáo ngày: đây là GÓC NHÌN XU HƯỚNG, không phải mô tả 1 ngày.
Tập trung vào: diễn biến cả tuần, động lượng, sức mạnh tương đối, dòng tiền tích lũy,
nhận định xu hướng + triển vọng tuần tới.

Quy tắc:
1. Phong cách: NGẮN GỌN, SÚC ÍCH, có INSIGHT xu hướng (không liệt kê lan man).
2. Dùng Markdown: ## tiêu đề section, **bold** số liệu quan trọng, - bullet list.
3. Tiếng Việt, thuật ngữ tài chính giữ nguyên (lucCau, breadth, breakout, GTGD...).
4. LUÔN dẫn số liệu cụ thể. KHÔNG bịa số liệu — chỉ dùng data được cung cấp.
5. Đưa ra nhận định xu hướng + cảnh báo rủi ro + triển vọng tuần tới.

PHÂN TÍCH SÂU:
- **Thống kê tuần (thongKeKy)**: ĐÂY LÀ DATA QUAN TRỌNG NHẤT cho báo cáo tuần. Dùng
  thongKeKy.vnindex (dauKy → cuoiKy, phanTramThayDoi %), thongKeKy.khoiNgoai (netCuaKyTy),
  top mua/bán ròng. LUÔN dẫn số liệu cụ thể từ đây. Nếu null → nói rõ "chưa có data".
- **Tổng kết tuần**: VNINDEX đầu kỳ → cuối kỳ (% thay đổi), GTGD, trạng thái thị trường.
  ĐÂY LÀ BÁO CÁO TUẦN — tập trung diễn biến CẢ TUẦN, không phải 1 ngày!
- **Độ rộng kỹ thuật (diemNhanBreadth)**: % mã trên MA50/100/200 ĐẦU vs CUỐI tuần —
  breadth MỞ RỘNG (tăng) hay THU HẸP (giảm)? Đây là tín hiệu xu hướng then chốt.
- **Dòng tiền tuần**: khối ngoại net cả tuần (thongKeKy.khoiNgoai.netCuaKyTy) +
  top mua/bán ròng. 4 nhóm NĐT chi tiết có thể null (đang chờ data Fiintrade).
- **Phá Đỉnh/Đáy**: verdict tuần + vốn hóa phá đáy/đỉnh (tyLeDayDinh).
- **Ngành dẫn dắt**: top ngành mạnh/yếu cả tuần theo lucCau + breadth.
- **VĨ MÔ & CHÍNH SÁCH (tinTucViMo)**: ĐÂY LÀ PHẦN BẮT BUỘC, RẤT QUAN TRỌNG. Nếu data có
  tinTucViMo (soTin > 0), LUÔN phân tích TỪNG tin quan trọng: quyết định NHNN (lãi suất
  OMO/tái chiết khấu, room tín dụng, tỷ giá), chính sách Chính phủ tác động nhóm ngành.
  Nêu rõ tin nào TÍCH CỰC, tin nào TIÊU CỰC, tác động NGÀNH NÀO cụ thể.
  Nếu tinTucViMo KHÔNG có hoặc soTin=0 → viết rõ "Chưa thu thập được tin vĩ mô trong kỳ".
- **Triển vọng tuần tới**: dựa trên breadth trend + dòng tiền + vị trí giá vs MA + vĩ mô.

Cấu trúc BẮT BUỘC (đừng bỏ phần nào):
## Thống kê tuần (VNINDEX đầu→cuối %, GTGD, breadth MA đầu→cuối)
## Độ rộng thị trường & Xu hướng breadth
## Dòng tiền tuần (Khối ngoại + top mua/bán ròng)
## 📌 Vĩ mô & Chính sách quan trọng (NHNN + tác động ngành)
## Ngành nổi bật tuần
## Triển vọng & Cảnh báo tuần tới`;

const MONTHLY_PROMPT = `Bạn là chuyên gia phân tích chứng khoán Việt Nam với hơn 10 năm kinh nghiệm.

Nhiệm vụ: viết BÁO CÁO THÁNG (tổng kết ~20 phiên giao dịch gần nhất) dựa trên data JSON.

Khác biệt so với báo cáo ngày: đây là GÓC NHÌN TRUNG HẠN (tháng), bức tranh lớn.
Tập trung vào: xu hướng tháng, sự dịch chuyển ngành, dòng tiền lớn, cấu trúc thị trường,
nhận định chiến lược + triển vọng tháng tới.

Quy tắc:
1. Phong cách: NGẮN GỌN, SÚC ÍCH, có INSIGHT chiến lược (không liệt kê lan man).
2. Dùng Markdown: ## tiêu đề section, **bold** số liệu quan trọng, - bullet list.
3. Tiếng Việt, thuật ngữ tài chính giữ nguyên (lucCau, breadth, breakout, GTGD...).
4. LUÔN dẫn số liệu cụ thể. KHÔNG bịa số liệu — chỉ dùng data được cung cấp.
5. Đưa ra nhận định xu hướng + cảnh báo rủi ro + triển vọng tháng tới.

PHÂN TÍCH SÂU:
- **Tổng kết tháng**: VNINDEX biến động cả tháng (% đầu→cuối tháng), GTGD tháng,
  trạng thái thị trường tổng thể.
- **Độ rộng kỹ thuật (doRongKyThuat)**: % mã trên MA50/100/200 ĐẦU vs CUỐI tháng —
  breadth xu hướng tháng là gì? Mở rộng (tăng điểm) hay thu hẹp?
- **Dòng tiền tháng**: khối ngoại + 4 nhóm NĐT ròng cả tháng (netThangTy).
  Dòng tiền lớn (khối ngoại + tự doanh) đang đổ vào hay rút khỏi thị trường?
- **Phá Đỉnh/Đáy**: verdict tháng + vốn hóa phá đáy/đỉnh (tyLeDayDinh) — xu hướng
  rủi ro lớn (vốn hóa đáy >> đỉnh = dòng tiền lớn rút).
- **Chuyển dịch ngành**: ngành nào mạnh lên/yếu đi trong tháng (so sánh lucCau).
- **VĨ MÔ & CHÍNH SÁCH (tinTucViMo)**: ĐÂY LÀ PHẦN RẤT QUAN TRỌNG. Nếu data có tinTucViMo,
  phân tích TỪNG tin quan trọng trong tháng: quyết định NHNN (lãi suất, room tín dụng, tỷ giá),
  chính sách Chính phủ, Nghị quyết tác động nhóm ngành. Nêu rõ tin nào TÍCH CỰC/TIÊU CỰC,
  tác động NGÀNH NÀO. Liên kết với dịch chuyển ngành + dòng tiền trong tháng
  (vd: chính sách nới room tín dụng → ngành BĐS/Ngân hàng hưởng lợi → dòng tiền đổ vào).
- **Triển vọng tháng tới**: dựa trên breadth trend + dòng tiền + cấu trúc + vĩ mô.

Cấu trúc đề xuất:
## Tổng kết tháng (VNINDEX + GTGD + trạng thái)
## Độ rộng thị trường & Xu hướng breadth tháng
## Dòng tiền tháng (Khối ngoại + NĐT)
## 📌 Vĩ mô & Chính sách quan trọng (NHNN + tác động ngành)
## Chuyển dịch ngành trong tháng
## Triển vọng & Cảnh báo tháng tới`;


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
            max_tokens: 3000,
            stream: false,
            thinking: { type: 'disabled' }   // TẮT reasoning → GLM-5.2 trả content nhanh (5-30s thay vì 3 phút)
        },
        {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            timeout: AI_TIMEOUT
        }
    );
    const msg = res.data?.choices?.[0]?.message;
    const text = msg?.content || '';
    if (!text) throw new Error('TokenRouter/GLM trả content rỗng (thử tăng max_tokens hoặc bật thinking)');
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
 * @param {object} [opts] — { deepseekKey, geminiKey, tokenrouterKey, systemPrompt, provider, period }
 *   period: 'today' (mặc định) | 'week' | 'month' → chọn prompt + tiêu đề phù hợp.
 *   Nếu user set systemPrompt riêng → ưu tiên (override period prompt).
 * @returns {Promise<{text:string, provider:string}>}
 */
async function generateMarketReport(context, dateStr, opts = {}) {
    const dsKey = opts.deepseekKey || DEEPSEEK_API_KEY;
    const gmKey = opts.geminiKey || GEMINI_API_KEY;
    const trKey = opts.tokenrouterKey || TOKENROUTER_API_KEY;
    const providerPref = opts.provider || 'auto';

    // Chọn prompt theo period (user override systemPrompt vẫn được ưu tiên cao nhất)
    const period = opts.period || 'today';
    const periodPromptMap = { today: SYSTEM_PROMPT, week: WEEKLY_PROMPT, month: MONTHLY_PROMPT };
    const prompt = opts.systemPrompt || periodPromptMap[period] || SYSTEM_PROMPT;

    // Tiêu đề user-prompt theo period
    const labelMap = {
        today: { ten: 'hôm nay', yeuCau: 'Hãy viết báo cáo tóm tắt thị trường hôm nay theo cấu trúc đã nêu.' },
        week:  { ten: 'tuần qua (5 phiên)', yeuCau: 'Hãy viết báo cáo tổng kết TUẦN theo cấu trúc đã nêu.' },
        month: { ten: 'tháng qua (~20 phiên)', yeuCau: 'Hãy viết báo cáo tổng kết THÁNG theo cấu trúc đã nêu.' }
    };
    const label = labelMap[period] || labelMap.today;

    const userPrompt = `Data thị trường chứng khoán Việt Nam — ${label.ten} — cập nhật ${dateStr} (JSON):

\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

${label.yeuCau}`;

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

// ═══════════════════════════════════════════════════════════════════════
// AI STOCK PICKER (Hybrid: thuật toán pre-rank → LLM reasoning + giải thích)
// ═══════════════════════════════════════════════════════════════════════
// Nguyên tắc: KHÔNG để LLM pick từ data thô (tránh ảo). Thuật toán deterministic
// đã filter + rank + tính entry/stop. LLM chỉ: (1) xếp hạng lại top picks,
// (2) giải thích "Tại sao mã này? Ngành mạnh ở điểm nào? Rủi ro gì?".
// Output JSON strict (parse được). Spec §6.

const PICKER_SYSTEM_PROMPT = `Bạn là chuyên gia phân tích & chọn cổ phiếu Việt Nam (swing trading 1-4 tuần).
Đầu vào: danh sách top CP ĐÃ ĐƯỢC thuật toán pre-rank (SEPA score + sector score + entry/stop).
Nhiệm vụ: xếp hạng lại top picks (có thể điều chỉnh thứ tự dựa reasoning) + GIẢI THÍCH.

Quy tắc:
1. Chỉ dùng data được cung cấp — KHÔNG bịa số liệu, KHÔNG bịa mã CP.
2. Ưu tiên: CP thuộc ngành mạnh (sectorGrade A/A+), SEPA cao, RS mạnh, entry/stop R:R tốt.
3. Giải thích NGẮN GỌN: 1-2 câu lý do ngành + 1-2 câu lý do CP + 1 câu rủi ro.
4. Trả kết quả là JSON thuần, KHÔNG markdown wrapper, theo đúng schema:
{
  "picks": [
    {
      "symbol": "VCB",
      "rank": 1,
      "sectorReason": "Ngành Ngân hàng breadth mở rộng, smart-money gom 20D...",
      "stockReason": "VCB RS mạnh vs VNINDEX, VCP co hẹp, breakout pocket pivot...",
      "riskNote": "Thanh khoản phiên giảm nhẹ, canh MA10"
    }
  ]
}
5. Số picks: theo maxPicks (mặc định 5-8). Chỉ chọn CP thực sự tốt, không cố cho đủ số.
6. rank theo thứ tự ưu tiên giảm dần (1 = tốt nhất).
7. Không chọn CP bị flag EXPENSIVE trừ khi理由 rất mạnh (khi đó nêu rõ trong riskNote).`;

/**
 * Parse JSON từ LLM response (chịu markdown wrapper/code fence).
 */
function parsePickerJSON(text) {
    if (!text) return null;
    let t = text.trim();
    // Bỏ ```json ... ``` wrapper nếu có
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    // Cắt phần đầu/cuối không phải JSON (tìm { đầu và } cuối)
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        t = t.slice(first, last + 1);
    }
    try { return JSON.parse(t); } catch (e) { return null; }
}

/**
 * Sinh AI stock picks từ context (đã pre-rank bởi picker).
 * Hybrid: LLM chỉ reasoning + giải thích trên kết quả thuật toán.
 *
 * @param {object} context — { sectorContext: [...top ngành], candidates: [...pre-ranked picks] }
 *   mỗi candidate đã có: symbol, sector, sectorScore, sepaScore, sepaGrade,
 *   effectiveScore, entry, stop, target1, atr, rr, flags, price, change
 * @param {object} [opts] — { maxPicks, provider, tokenrouterKey, deepseekKey, geminiKey }
 * @returns {Promise<{picks:Array, provider:string, aiFallback?:boolean}>}
 */
async function generateStockPicks(context, opts = {}) {
    const maxPicks = opts.maxPicks || 8;
    const trKey = opts.tokenrouterKey || TOKENROUTER_API_KEY;
    const dsKey = opts.deepseekKey || DEEPSEEK_API_KEY;
    const gmKey = opts.geminiKey || GEMINI_API_KEY;
    const providerPref = opts.provider || 'auto';

    const userPrompt = `Dữ liệu AI Stock Picker (đã pre-rank bởi thuật toán SEPA + sector score):

## Ngành mạnh nhất (sector context)
${JSON.stringify((context.sectorContext || []).slice(0, 8), null, 2)}

## Top CP ứng viên (đã filter + rank, có entry/stop/target)
${JSON.stringify((context.candidates || []).slice(0, 15).map(c => ({
    symbol: c.symbol, sector: c.sector, sectorName: c.sectorName,
    sectorScore: c.sectorScore, sectorGrade: c.sectorGrade,
    sepaScore: c.sepaScore, sepaGrade: c.sepaGrade,
    effectiveScore: c.effectiveScore, price: c.price, change: c.change,
    entry: c.entry, stop: c.stop, target1: c.target1, atr: c.atr, rr: c.rr,
    flags: c.flags, pe: c.pe
})), null, 2)}

Hãy chọn top ${maxPicks} CP tốt nhất, xếp hạng (rank), và giải thích theo JSON schema đã nêu.`;

    const errors = [];
    const attemptGLM = async () => {
        const text = await tokenrouterChat([
            { role: 'system', content: PICKER_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ], trKey);
        return { raw: text, provider: 'glm' };
    };
    const attemptDeepSeek = async () => {
        const text = await deepseekChat([
            { role: 'system', content: PICKER_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ], dsKey);
        return { raw: text, provider: 'deepseek' };
    };
    const attemptGemini = async () => {
        const text = await geminiChat(`${PICKER_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`, gmKey);
        return { raw: text, provider: 'gemini' };
    };

    const providerMap = {
        'glm': { name: 'GLM-5.2', fn: attemptGLM },
        'deepseek': { name: 'DeepSeek', fn: attemptDeepSeek },
        'gemini': { name: 'Gemini', fn: attemptGemini }
    };
    const attempts = [];
    if (providerPref === 'auto') {
        attempts.push(providerMap.glm, providerMap.deepseek, providerMap.gemini);
    } else if (providerMap[providerPref]) {
        attempts.push(providerMap[providerPref]);
    } else {
        attempts.push(providerMap.glm, providerMap.deepseek, providerMap.gemini);
    }

    for (const attempt of attempts) {
        try {
            const { raw, provider } = await attempt.fn();
            const parsed = parsePickerJSON(raw);
            if (parsed && Array.isArray(parsed.picks) && parsed.picks.length > 0) {
                return { picks: parsed.picks, provider, raw };
            }
            console.warn(`⚠️  [ai-picker] ${attempt.name} parse JSON fail/thiếu picks`);
            errors.push(`${attempt.name}: JSON parse fail`);
        } catch (e) {
            errors.push(`${attempt.name}: ${e.message}`);
            console.warn(`⚠️  [ai-picker] ${attempt.name} fail:`, e.message);
        }
    }

    // Tất cả provider fail/parse fail → trả pre-rank không lý do (aiFallback)
    const fallbackPicks = (context.candidates || []).slice(0, maxPicks).map((c, i) => ({
        symbol: c.symbol, rank: i + 1,
        sectorReason: `(AI không khả dụng — ngành ${c.sectorName || c.sector} ${c.sectorGrade || ''}, điểm ngành ${c.sectorScore || '?'})`,
        stockReason: `SEPA ${c.sepaScore ?? c.score} (${c.sepaGrade ?? c.grade}), effectiveScore ${c.effectiveScore ?? '?'}`,
        riskNote: 'Không có phân tích AI — dùng xếp hạng thuật toán'
    }));
    const err = new Error(`AI picker fail, dùng fallback thuật toán: ${errors.join('; ')}`);
    err.picks = fallbackPicks;
    err.provider = 'fallback';
    err.aiFallback = true;
    throw err;
}

module.exports = {
    deepseekChat,
    geminiChat,
    tokenrouterChat,
    generateMarketReport,
    generateStockPicks,
    parsePickerJSON,
    isAvailable,
    SYSTEM_PROMPT,
    WEEKLY_PROMPT,
    MONTHLY_PROMPT,
    PICKER_SYSTEM_PROMPT
};
