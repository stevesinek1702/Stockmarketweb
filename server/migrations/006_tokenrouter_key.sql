-- Thêm cột tokenrouter_api_key cho provider mới (GLM-5.2 qua TokenRouter).
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE user_ai_settings ADD COLUMN IF NOT EXISTS tokenrouter_api_key TEXT;
