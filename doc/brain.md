# Lay v2 — the brain (`src/brain`) and the policy lint (`src/core/policy.js`)

What this covers: how the system prompt is laid out and why, how the structured-output call behaves when things go
wrong, what the policy lint does with a model response, and how to add a worked example. Design of record:
`design-lay-v2.md` §1.2 steps 5–7, §2, §4. Conventions: `doc/v2-conventions.md`.

## 1. Files

| File | Owns |
|---|---|
| `src/brain/schema.js` | the response contract (`responseSchema`, `validateResponse`, `emptyResponse`) — shared, change by review |
| `src/brain/examples.js` | the few-shot examples (`EXAMPLES`) that ride in the static prefix |
| `src/brain/prompt.js` | `buildSystemPrompt`, `buildDemoSystemPrompt`, `buildMessages` |
| `src/brain/respond.js` | `createModel` → `{ respond }`: the OpenAI call, repair retry, error kinds, `_meta` |
| `src/core/policy.js` | `applyPolicy` (what the model may not say) and `fallbackReply` |
| `src/agents.config.js` | model, max tokens, temperature, timeout, candidates and the reason for the pick |

The turn pipeline (`src/core/turn.js`, T6) is the only caller. It selects KB sections from the pack, builds the
prompt, calls the model, applies the policy, and decides what to do with the severity. Nothing in `src/brain`
requires the LINE SDK, the store, or Discord; only `respond.js` requires `openai`.

## 2. Prompt layout and the caching rationale

```
┌ STATIC PREFIX (identical every call) ──────────────────────────────┐
│ persona · voice rules · emoji policy · behaviour by situation       │
│ "what Lay does not do" · output contract · 8 worked examples        │
├ KB sections  (`kbSelection`: [{id, text}] chosen by the caller) ────┤
├ Session facts (mode, topics_covered, draft, homework, questions_asked,│
│               intent hint, tell-me-more anchor, booking confirmed)  │
└ Now (Bangkok date/time, business-hours state) ──────────────────────┘
```

OpenAI prompt caching keys on the **exact leading bytes** of the prompt (prefix ≥ 1024 tokens, cache hits are
billed at a discount and return faster). So everything that varies per turn — KB choice, session, the clock, the
phone number from config — sits *after* the static block. `STATIC_PREFIX` is a module constant built once; the
unit test asserts two calls with different sessions share it byte-for-byte and that no dynamic marker leaks into
it. If you edit the prefix, every live conversation pays one cache miss and then warms again; that is fine. Do
not put `config` values or `Date` output in the prefix.

The prefix explains what code owns (prices, URLs, actions, buttons, the sender, booking status) only so the model
proposes instead of fighting the pipeline. The model never decides those; the policy and the flows do (design §4).

Rules for the model are in Thai: the model answers in Thai and Thai rules keep the register of the examples and the
rules consistent. Comments and docs stay English.

### Dynamic blocks in detail

- **KB**: `### [section.id]` + text. The model is told to cite ids verbatim in `kb_refs`; the policy drops ids that
  are not in the pack. An empty selection renders a line that says the model may only say it does not know.
- **Session**: `topics_covered` (so the model does not re-offer a covered topic as a button), `draft` and `homework`
  (only filled fields, so it never asks again), `questions_asked`, `intentHint`. With `intentHint === 'tell_me_more'`
  the block names the previous answer's `kb_refs` (`session.last_kb_refs`, or `session.last_response.kb_refs`) and
  instructs: expand, do not restart, never answer "no data". The caller should include those sections in
  `kbSelection` in full.
- **Now**: Bangkok local time via `Intl` and open/closed against `config.contact.hoursStart/End` (defaults 13–22).

### Demo prompt

`buildDemoSystemPrompt({ shop, shopKb })` — `shop` is `'cafe' | 'clinic'` or `{ key, name }`; `shopKb` is
`[{id, text}]` or a string. Same response schema; the prompt fixes `intent: "demo"`, `topics: []`, all
`lead_updates` null, `action` null or `demo_exit`. The shop always labels itself ร้านตัวอย่าง, never claims to be
real, takes no real money or data, and defers money and confirmations to "เจ้าของร้าน (ตัวอย่าง)".

### Messages

`buildMessages({ systemPrompt, history, userText })` → `[system, …last 12 history turns, user]`. History roles
`customer → user`, `lay | demo_shop → assistant`, `mos → assistant` prefixed `(ข้อความจากมอส)` so the model neither
imitates nor contradicts what Mos typed. Blank history entries are dropped; a turn without customer text (postback)
produces no trailing user message — the caller adds its own instruction in that case.

## 3. The call (`respond.js`)

`createModel({ apiKey, model, maxTokens, temperature, timeoutMs, client, log })` reads defaults from
`agents.config.agentLay`; `client` is injectable (tests pass a scripted `chat.completions.create`). The SDK is
required lazily, so `npm test` never touches it and a missing key only matters on a real call.

`respond({ system, messages, schema })`:

1. `chat.completions.create` with `response_format: { type: 'json_schema', json_schema: schema }` (strict),
   `max_completion_tokens`, per-request `timeout` (20 s default).
2. Parse JSON → `validateResponse`. On failure **one repair call** that replays the bad output and says what failed
   ("return a corrected JSON object only"). Still bad → throw.
3. The parsed object gets a non-enumerable `_meta = { usage (summed over both calls, incl. cached_tokens),
   latencyMs, model, repaired, attempts }` so it never leaks into persistence or the LINE payload.

Thrown errors carry `kind`:

| kind | class | when |
|---|---|---|
| `invalid` | `ModelOutputError` | schema failed twice (`errors`, `usage`, `attempts` attached) |
| `refusal` | `ModelOutputError` | `message.refusal` set or `finish_reason: content_filter` |
| `length` | `ModelOutputError` | `finish_reason: length` |
| `empty` | `ModelOutputError` | no choice / no message |
| `timeout` | `ModelError` | SDK timeout / abort |
| `provider` | `ModelError` | anything else from the SDK (`status`, `cause` attached) |

The turn treats every kind the same way (fallback reply + one `model_error` log line with `kind`); the kinds exist
so the log tells Mos what actually happened.

## 4. Policy severities (`applyPolicy`)

`applyPolicy(response, { session, pack, allow, userText })` → `{ response, violations, fixed, severity }`.
The input is cloned, never mutated.

| Step | What happens | Recorded as |
|---|---|---|
| markdown in a text / card alt | stripped | `fixed` |
| trailing whitespace | trimmed | `fixed` |
| emoji in a card title | removed | `fixed` |
| quick replies | list cut to 4; empty or > 20-code-point labels dropped (labels are never truncated) | `fixed` |
| `kb_refs` not in `pack.sections` | dropped | violation `unknown_kb_ref` (fix) |
| `problem_verbatim` not a substring of the customer text (whitespace-normalised; also compared with all whitespace removed) | nulled | `fixed` |
| `lint.lintText` on every text (`explain` from the message, `allow` for `booking_confirmed`) | — | violation `banned:<id>` / `emoji` / `prose_list` / `too_long` (regenerate) |
| banned phrase in a card alt | — | `banned:<id>` (regenerate) |
| price pattern `\d{1,3}(,\d{3})+\s*บาท` in a text and no grounding ref | — | `price_without_ref` (regenerate) |
| topic/intent `benefits` without the caveat frame | — | `benefits_without_caveat` (regenerate) |
| response fails `validateResponse` after fixes | — | `invalid_after_policy` (fallback) |

A price is *grounded* when a remaining ref matches `^offer\.` or `^faq\.[^\s]*price`, **or** the cited section's
own text contains a price (so `faq.care-fee` grounds a care-fee answer). The benefits caveat accepts the generic
"ตรวจสอบกับหน่วยงาน" and the agency names the FAQ draft uses (สสว., depa, กรมสรรพากร).

`severity` is the worst violation:

- **`fix`** — send it (possibly after mechanical fixes). Also the value when nothing was wrong.
- **`regenerate`** — call the model once more with the violation named in the prompt; if the second attempt is not
  `fix`, send `fallbackReply` and log `policy_violation`.
- **`fallback`** — unusable; send `fallbackReply` now.

`pack.sections` may be an array of `{id, text}`, an object map, or a `Map`. With no `pack`, refs are not checked
(unit tests and the scenario runner's scripted mode).

`fallbackReply({ reason, config })` → schema-valid: "ตอนนี้ระบบขัดข้องชั่วคราวครับ ถ้ารีบ โทร <config.contact.phone>
(มอส) ได้เลย" + quick reply `เรียก Lay`. Without a phone in config the line drops the phone clause rather than
inventing one. `reason` rides in `_meta`.

## 5. How to add a worked example

1. Add an entry to `EXAMPLES` in `src/brain/examples.js`: `{ id, note, user, response }`. Build `response` with
   `emptyResponse({...})` so every field exists; use `noLead()` and fill `lead_updates` only with words the `user`
   line actually contains.
2. Facts: only what the FAQ draft / KB pack states. A price needs the FAQ's own number and an `offer.*` or
   `faq.*price*` ref. No job counts, no email, no guarantees, no "ลดคน".
3. Voice: ครับ, 1–3 short lines per bubble, one question, no list in prose, no emoji in a plain reply, end on a
   question or a button. Banter/abuse/disclosure examples have no CTA and no card.
4. Run `node --test tests/unit/brain.examples.test.js` — it asserts every example is schema-valid, passes
   `lintText`, and comes through `applyPolicy` with `severity: 'fix'` and no fixes. The prompt test checks every
   example appears in `STATIC_PREFIX`.
5. Keep the count at 6–8. More examples cost prompt tokens on every cache miss and dilute the voice; replace a weak
   one rather than appending.

## 6. Smoke check against the real API

`tests/run-scenarios.js --model real` is the full check once T6 lands. Until then a short script that builds a
prompt with three fake sections, calls `createModel().respond`, and runs `applyPolicy` is enough to judge voice
and validity; it needs `OPENAI_API_KEY` in `.env` (never commit it) and should stay under ~20 calls.
