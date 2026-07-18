-- AI Settings per-user — API key (DeepSeek/Gemini) + system prompt + provider preference.
--
-- Mỗi user tự cấu hình API key riêng (plaintext, admin thấy full) + override system prompt.
-- Khi user chưa set (row không tồn tại) → fallback env DEEPSEEK_API_KEY/GEMINI_API_KEY.
--
-- provider: 'auto' (Gemini→DeepSeek fallback) | 'gemini' | 'deepseek'
-- system_prompt: null = dùng global default (SYSTEM_PROMPT trong ai.js)

CREATE TABLE IF NOT EXISTS user_ai_settings (
    user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    provider         TEXT NOT NULL DEFAULT 'auto',
    deepseek_api_key TEXT,
    gemini_api_key   TEXT,
    system_prompt    TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
