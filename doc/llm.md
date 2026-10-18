# Lay v2 — LLM platform (OpenRouter, routing, tracking, budget, exhaustion)

Decided by Mos 2026-10-18: the provider is **OpenRouter** (one key with a daily USD limit, spare keys optional), every
LLM use is a **deliberate per-task routing decision**, every call is **tracked** (task, model, tokens, cost) and the
**"key limit exhausted"** case is designed, tested and tells Mos in Discord immediately.

Code: `src/agents.config.js` (task table) · `src/brain/router.js` · `src/brain/respond.js` (provider) ·
`src/brain/keys.js` · `src/brain/budget.js` (budget + tracker) · `src/core/degraded.js` · `src/discord/alerts.js` ·
`src/store/repo/llmCalls.js` (+ migration `002-llm-calls.sql`) · `/admin/llm/*` in `src/admin.js` ·
`scripts/llm-report.js` · `scripts/model-probe.js`. Tests: `tests/unit/llm.*.test.js`, scenario `42-llm-exhausted.yaml`.

## 1. Routing table (src/agents.config.js)

Every LLM call names a task. The table decides model, fallback, caps and whether the output is a strict schema.
Model ids are OpenRouter ids (`provider/model`). Prices: USD per 1M tokens in/out, 2026-10-18.

| task | agent | model (default) | fallback | max_tokens | temp | why this model |
|---|---|---|---|---|---|---|
| `lay.reply` | lay | `openai/gpt-4o-mini` (0.15/0.60) | `openai/gpt-4.1-mini` (0.40/1.60) | 1024 | 0.4 | Cheapest model with json_schema and acceptable Thai; the prompt is ~22k tokens, so input price is the lever. 4.1-mini is the fallback for provider 5xx/timeouts and the candidate if voice/validity falls short (probe §7). |
| `lay.repair` | lay | same model as the turn | — | 600 | 0.4 | The repair quotes the model's own output; a corrected object is never longer than the original. |
| `demo.reply` | demo_shop | `openai/gpt-4o-mini` | `openai/gpt-4.1-mini` | 768 | 0.5 | Sales prop, smaller prompt; warmth over precision. |
| `qa.judge` | qa | `openai/gpt-4.1` (2.00/8.00) | `anthropic/claude-sonnet-4.5` (3.00/15.00) | 1024 | 0 | Scripts only. A judge should be stronger than what it grades; Sonnet 4.5 is the second opinion on Thai register. |
| `qa.probe` | qa | set per run | — | 1024 | 0.4 | Tracking label for `scripts/model-probe.js` so probe rows never mix with customer turns. |
| `kb.rewrite` | document | `anthropic/claude-sonnet-4.5` | — | 2048 | 0.3 | **disabled** — Mos curates the vault; enable only with a review step. |

Env override per task: `LLM_MODEL_<TASK>` with the id upper-cased and dots → underscores
(`LLM_MODEL_LAY_REPLY=openai/gpt-4.1-mini`). `router.resolve(taskId)` returns the effective row with
`source: 'config' | 'env'`; `/admin/llm/status` shows the live table. Changing a model = one line in
`agents.config.js` (version-controlled, with the reason) or one env var on Railway (no deploy). Note: `openai/gpt-5-*`
reject `temperature ≠ 1` — set the task temperature to 1 before routing to them.

### NO_LLM — deterministic on purpose (`router.NO_LLM`)

Opening · Rich Menu + quick replies · fit choice (five symptoms → card) · booking state machine · handoff detection
(ask-human / special price / scope) · quiet window, เรียก Lay, Mos relay identity · lint and policy · demo carousel /
examples picker · lead extraction (rides in the structured output; code merges) · lead sync · the degraded reply itself.
The model proposes words; code decides prices, URLs, actions, state and buttons.

## 2. Provider (src/brain/respond.js)

`createModel({ task, keyring, tracker, log })` → `respond({ system, messages, schema, meta })`. The `openai` SDK with
`baseURL: https://openrouter.ai/api/v1`, headers `HTTP-Referer` (PUBLIC_BASE_URL) + `X-Title: Lay v2 (LazyHardWork)`,
body `usage: { include: true }` (OpenRouter then returns `usage.cost` in USD and `cached_tokens`), `max_tokens` from the
task, `maxRetries: 0` (we do our own recovery).

- **Structured output.** `response_format: { type: 'json_schema', json_schema }`. OpenAI strict mode requires
  `additionalProperties: false` on every object; `lay_turn`'s card `data` is a free-form object, so the provider sends
  the schema with `strict: false` (JSON mode guided by the schema) and logs `llm.schema_not_strict` once. Validity is
  held by `validateResponse` + one repair call, exactly as before. Live 2026-10-18: 14/14 valid with one repair.
  Follow-up for the schema owner: type the card `data` per template to get strict mode back.
- **Repair.** Invalid output → one `lay.repair` call on the same model and key (600 tokens) quoting the errors; still
  invalid → `ModelOutputError('invalid')`.
- **Key rotation.** HTTP 402, or a 429/403 whose body talks about credits / key limits → the key is marked exhausted
  and the same request is retried on the next key. None left → `ModelError('exhausted')`. While the keyring says
  exhausted, `respond()` makes **no HTTP call** (one tracked row, `attempts: 0`).
- **Model fallback.** Provider 5xx / network / timeout on the first call → one try on `fallback_models[0]`
  (tracked as `fallback_model`). 4xx never switches.
- **`_meta`** (non-enumerable): `usage` (prompt/completion/total/cached tokens, `cost_usd`), `latencyMs`, `model`
  actually used, `requestedModel`, `attempts`, `repaired`, `key_index`, `fallback_model`, `task`.

Error kinds: `invalid` · `refusal` · `length` · `empty` · `timeout` · `provider` · `exhausted` · `disabled` · `invalid_request`.

## 3. Keys and budget

**Keyring** (`src/brain/keys.js`): `OPENROUTER_API_KEY`, `_2`, `_3` in that order (`config.llm.openrouterKeys`).
`current()` → first usable key; `markExhausted(i, reason, { limitReset, resetAt })` → retry after the limit reset:
`daily` ⇒ next **00:00 UTC** (OpenRouter's key-limit reset), else 60 min; `rotate()`; `status()` (masked labels only,
`exhausted` = every key out, `next_retry_at`). Hooks `onExhausted` / `onRecovered` fire once per episode.

**Budget** (`src/brain/budget.js`): sums today's `usage.cost` per key (UTC day); `refresh()` reads
`GET /api/v1/auth/key` per key at most every 10 min (limit, `limit_remaining`, `limit_reset`, `resets_at`,
`usage_daily`) and marks a key exhausted when the server says `limit_remaining ≤ 0`; `remaining()`; warns **once per
UTC day per key at 80 %** of the key's limit (`alerts.warn`, kind `llm_budget_80`). `src/app.js` refreshes at start
and every 10 min.

Key status on 2026-10-18 (`/auth/key`): `limit 15 USD · limit_reset daily · resets_at 2026-10-19T00:00:00Z ·
limit_remaining 14.96 · usage_daily 0.035` (after the probe). One key configured; no spares yet.

## 4. Tracking

Table `llm_calls` (migration 002): `ts, task, agent, model, key_index, user_id, prompt_tokens, completion_tokens,
cached_tokens, total_tokens, cost_usd, latency_ms, outcome, error, request_id, attempts`. One row **per attempt**:
`ok` · `repaired` · `invalid` (first output failed) · `error` · `exhausted` · `fallback_model` (succeeded on the
fallback). The provider calls `tracker.record(row)` fire-and-forget: a tracking failure is logged, never raised,
never delays the reply. No customer text, ever.

Read it:
- `GET /admin/llm/calls?since=<iso>&task=lay.reply&limit=200` — rows, newest first (bearer `ADMIN_TOKEN`).
- `GET /admin/llm/summary?days=7` — day × task × model: calls, ok/repaired/invalid/errors/exhausted/fallback,
  tokens, cost, avg latency + totals.
- `GET /admin/llm/status` — keyring, budget, status line, the resolved routing table, NO_LLM.
- `node scripts/llm-report.js [--days 7] [--db /data/lay.sqlite]` — the same summary as a table + per-task cost per
  100 successful calls + per-day cost (for the daily status).

## 5. Exhaustion flow

```
customer text ──► turn.askModel
                    │ keyring.status().exhausted?  ──yes──► (no call) ─┐
                    │ no                                              │
                    ▼                                                 │
                 model.respond ── 402/credit 429 ──► markExhausted ──► next key? ──yes──► retry same request
                    │                                                  │ no
                    │ ok                                               ▼
                    ▼                                    throw kind 'exhausted'
                 policy → send                                         │
                                                                       ▼
                                                      degradedTurn (turn.js, inside askModel)
                                                        1. log llm_exhausted_turn + events row
                                                        2. alerts.critical('llm_exhausted')  → #crm "@here 🔴 …" (15-min throttle per kind)
                                                        3. intent fit & no symptom yet? → fit choice card (code, no model)
                                                        4. upsertLead + notifier.handoff(kind handoff_unknown, question)
                                                             │ throws → degradedNotifyFailedReply (phone only, no promise)
                                                        5. degradedReply: "ระบบตอบอัตโนมัติขัดข้องชั่วคราว … ส่งคำถามของคุณให้มอสแล้ว … โทร <phone>"
                                                           quick replies: เรียก Lay · ราคาเท่าไหร่ · เริ่มยังไง · mode stays lay
keys back (reset time passed / current() restores) ──► keyring.onRecovered ──► alerts.recovered('llm_exhausted') → "🟢 …"
```

Deterministic paths (opening, Rich Menu, FIT_* symptom storage, booking machine, demo carousel, handoff, เรียก Lay)
run untouched while exhausted — `tests/unit/llm.degraded.test.js` and scenario 42 prove it. The session keeps what
was chosen while degraded (a symptom picked during the outage still drives the offer card afterwards).

## 6. Alerts (src/discord/alerts.js)

Posts to `#crm` (`DISCORD_CRM_CHANNEL_ID` via the bot; else `DISCORD_CRM_WEBHOOK`); reuses the notifier transport.
- `critical({ kind, detail })` → `@here 🔴 LAY v2 CRITICAL — <kind>` + detail + **key status line** (limit, remaining,
  reset) + timestamp; `allowed_mentions: { parse: ['everyone'] }`; once per **15 min per kind**.
- `recovered({ kind })` → `🟢 LAY v2 recovered — <kind>` + key status; clears the throttle.
- `warn({ kind, detail })` → `🟠 LAY v2 warning — <kind>`; once per UTC day per kind; no mention (budget 80 %).
Never throws; never carries customer data (ids, names, text).

## 7. Cost expectations and the probe (2026-10-18)

`node scripts/model-probe.js --env <path to .env> --models openai/gpt-4o-mini,openai/gpt-4.1-mini` — the six Rich Menu
questions + "คุยกับคนหรือบอท" through the real `lay.reply` prompt and schema, recorded as `qa.probe`.

| model | valid | sendable (policy fix only) | repaired | p50 / max latency | prompt tokens per call (cached) | out per call | USD per call | ≈ USD per 100 turns |
|---|---|---|---|---|---|---|---|---|
| `openai/gpt-4o-mini` | 7/7 | 7/7 | 0 | 4.5 s / 6.0 s | ~22.8k (40 % cached) | ~270 | 0.0029 | **0.29** |
| `openai/gpt-4.1-mini` | 7/7 | 7/7 | 1 | 2.7 s / 7.6 s | ~22.8k (55 % cached) | ~350 | 0.0067 | **0.67** |

Observations: both answered in-voice (ครับ, short bubbles, no markdown); 4.1-mini cited more refs and gave fuller
pricing/timeline answers, 4o-mini had two `unknown_kb_ref` fixes (dropped by policy) and lower latency variance; neither
model returned the `choice` card for "เหมาะกับงานผมไหม" on a cold session (both asked a question with buttons) — the
Rich Menu path should keep rendering that card in code. Pick stays `gpt-4o-mini` (≈ 2.3× cheaper, same validity);
switch per task via `LLM_MODEL_LAY_REPLY` if voice is judged short.

**The prompt is the cost.** ~22k prompt tokens per turn means ≈ 0.29 USD / 100 turns on 4o-mini — the 15 USD daily
key covers ≈ 5,000 turns/day. Two pre-existing issues found during the probe (outside this branch's files):
1. `src/brain/select.js` matches `section.file` against bare names (`about`) while `src/brain/kb.js` stores `about.md`
   → **production turns currently get 0 KB sections in the prompt**. The probe works around it with a bare-name view.
2. With the names fixed, `selectSections` picks 64–100 sections (the whole pack ≈ 55–65k chars) for every intent —
   the "3–4 sections" intent of design §1.2 step 5 is not what the selector does; trimming it is the single biggest
   cost lever (and latency: 22k tokens ≈ 2–6 s on mini models).

## 8. Operations checklist

- `.env`: `OPENROUTER_API_KEY` (+ `_2`, `_3` spares), optional `LLM_MODEL_*`. The old `OPENAI_API_KEY` is unused.
- Daily: `scripts/llm-report.js --days 1` (or `/admin/llm/summary?days=1`) → cost + not-ok attempts.
- On `🔴 llm_exhausted`: top up / add a spare key (`OPENROUTER_API_KEY_2`) and restart, or wait for 00:00 UTC; Lay
  keeps forwarding questions to Mos meanwhile. `🟢 recovered` confirms the keys are back.
- Scenario `tests/scenarios/42-llm-exhausted.yaml` and `fault: { model: exhausted }` are the regression gate.
