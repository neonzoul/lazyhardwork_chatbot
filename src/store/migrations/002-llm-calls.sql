-- LLM call tracking (doc/llm.md §4): one row per provider attempt — which task/agent, which model, which key,
-- tokens, cost (USD from OpenRouter usage.cost), latency, outcome. No customer text, ever.

CREATE TABLE IF NOT EXISTS llm_calls (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 TEXT NOT NULL,                     -- ISO-8601 UTC, start of the attempt
  task               TEXT NOT NULL,                     -- lay.reply | lay.repair | demo.reply | qa.judge | qa.probe | ...
  agent              TEXT,                              -- lay | demo_shop | qa | ...
  model              TEXT NOT NULL,                     -- OpenRouter id actually requested (provider/model)
  key_index          INTEGER,                           -- position in the keyring (0 = OPENROUTER_API_KEY); NULL when skipped
  user_id            TEXT,                              -- LINE user id (join to sessions); NULL for scripts
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  latency_ms         INTEGER NOT NULL DEFAULT 0,
  outcome            TEXT NOT NULL,                     -- ok | repaired | invalid | error | exhausted | fallback_model
  error              TEXT,                              -- short error text (≤ 300 chars), NULL when ok
  request_id         TEXT,                              -- provider generation id
  attempts           INTEGER NOT NULL DEFAULT 1         -- attempt number inside the respond() call (1 = first, 2 = repair/fallback)
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls (ts);
CREATE INDEX IF NOT EXISTS idx_llm_calls_task_ts ON llm_calls (task, ts);
CREATE INDEX IF NOT EXISTS idx_llm_calls_outcome ON llm_calls (outcome);
