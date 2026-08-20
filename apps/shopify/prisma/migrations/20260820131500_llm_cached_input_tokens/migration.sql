-- Track provider prompt-cache hits separately so OpenAI cached input is priced
-- correctly without rewriting historical usage rows.

ALTER TABLE "llm_usage_event"
ADD COLUMN "cached_input_tokens" INTEGER NOT NULL DEFAULT 0;
