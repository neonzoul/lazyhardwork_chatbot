---
type: spec
status: active
tags: [engineering, architecture, bot, line-oa, agent-lay]
owner: both
lang: en
links:
  - "Clients/000_lazyhardwork/spec/lhw-bot-requirement-spec.md"
  - "Clients/000_lazyhardwork/resources/lhw-bot-knowledge-base.md"
---

# Engineering Spec — LhW Agent Lay LINE OA Bot v1.0

**What to build:** LINE OA chatbot for LazyHardWork's own channel (client zero).
**Requirement source:** `lhw-bot-requirement-spec.md` — read it first for WHAT; this doc is HOW.
**Repo:** `github.com/neonzoul/lazyhardwork_chatbot`
**Branches:** `feature/antigravity` (Antigravity), `feature/claude-code` (Claude Code)
**Timeline:** →2026-07-07

---

## 1. Architecture

```
LINE User
   │ text message
   ▼
LINE Messaging API ──webhook──► Express /webhook
                                    │
                              Signature verify
                              (LINE middleware)
                                    │
                              Debounce 6.5 s
                              (per userId timer)
                                    │
                              State check
                         ┌──────────┴──────────┐
                    BOT_ACTIVE           WAITING_HUMAN
                         │               HUMAN_ACTIVE
                  Handoff trigger?    ──► fixed reply / silent
                   │          │
                  YES         NO
                   │          │
            handleHandoff   LLM call
            setStatus →     (Anthropic SDK)
            WAITING_HUMAN   system prompt = KB + rules
            notify #crm     history = last 10 msgs
                   │          │
                   └────┬─────┘
                        ▼
                 LINE pushMessage (text)
                        │
              lead signal detected?
                   YES → notify #leads (Discord)
               KB gap signal → notify #crm (Discord)
```

**Key principle:** no tool-calling. The LLM answers directly from the KB injected in the system prompt. Business logic (state machine, handoff, lead detection) lives in `bot.js`, not in the LLM.

---

## 2. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js ≥ 18 | LINE SDK is best supported; Mos has prior debounce logic |
| Framework | Express | Minimal, well-understood |
| LINE SDK | `@line/bot-sdk` v9 | Official; handles signature verification |
| LLM | Anthropic Claude (claude-haiku-4-5-20251001) | Fast, cheap for Thai, KB-only (no tool-calling needed) |
| Discord notify | `axios` POST to webhook URL | Stateless, no library needed |
| Session store | In-memory `Map` | Demo/phase-1; swap to Redis for multi-instance production |
| Tunnel (dev) | ngrok | Expose localhost to LINE webhook |
| Deploy | Render free tier (or Railway) | Zero-ops for now; VPS migration later |

---

## 3. Data Models

### Session (per userId, in-memory)
```js
{
  status: 'BOT_ACTIVE' | 'WAITING_HUMAN' | 'HUMAN_ACTIVE',
  history: [{ role: 'user'|'assistant', content: string }],  // capped at 10
  pendingTimer: TimerHandle | null,   // debounce timer
  pendingMessages: string[],          // message accumulator — drained on debounce fire
}
```

### Lead object (sent to Discord #leads)
```js
{
  name: string,       // extracted from conversation or LINE display name
  business: string,
  problem: string,
  budget: string,
  contact: string,
  keyRemark: string,  // bot-generated summary
}
```

### Discord #crm handoff payload
```
🔴 Human Required
ลูกค้า: {displayName}
เรื่อง: {summary}
เวลา: {Bangkok timestamp}
สถานะ: WAITING_HUMAN
```

### Discord #leads payload
```
🟢 New Lead
ชื่อ: / ธุรกิจ: / ปัญหา: / งบ: / ติดต่อ: / ช่องทาง: LINE OA / เวลา: / สรุป:
```

---

## 4. State Machine

```
       ┌──────────────────────────────────────────────────────┐
       │                   BOT_ACTIVE (default)               │
       │  Bot answers from KB. Debounce applies.              │
       └──────────────────┬───────────────────────────────────┘
                          │ handoff trigger
                          │ (button / keyword / bot can't answer + user confirms)
                          ▼
       ┌──────────────────────────────────────────────────────┐
       │                  WAITING_HUMAN                       │
       │  Bot sends handoff message + notifies #crm.          │
       │  Responds only: "กำลังรอคุณมอสมาดูแลอยู่นะครับ [Agent Lay]"│
       └──────────────────┬───────────────────────────────────┘
                          │ Mos manually sets → HUMAN_ACTIVE
                          ▼
       ┌──────────────────────────────────────────────────────┐
       │                  HUMAN_ACTIVE                        │
       │  Bot fully silent. Mos handles directly.             │
       │  Returns to BOT_ACTIVE only via manual reset.        │
       └──────────────────────────────────────────────────────┘
```

**Handoff trigger phrases** (Thai regex):
`คุยกับคนจริง` · `ขอคุยกับมอส` · `อยากนัดคุย` · `คุยกับคน`

**Outside business hours** (before 13:00 / after 22:00 Bangkok):
- Bot stays `BOT_ACTIVE` in KB scope
- Adds out-of-hours notice to WAITING_HUMAN message
- Still notifies #crm; Mos closes to `HUMAN_ACTIVE` manually

---

## 5. LLM Integration

No tool-calling. System prompt = KB content + hard rules + business-hours flag.

### 5.1 KB Injection — full-context strategy

`kb.js` reads `knowledge/kb.md` **once at server startup** via `fs.readFileSync` (Node module cache ensures a single load). On every LLM call, `buildSystemPrompt()` injects the entire KB string into the system prompt:

```
system prompt (every call):
  [persona + sign-off rule: "[Agent Lay]" on every response]
  [contact info from config — never hard-coded]
  [FULL KB string — all blocks: identity · services · pricing · proof · FAQ · handoff · voice]
  [rules: KB-only · no hallucination · no custom quote · escalate unknowns]
  [if out-of-hours: append notice]

messages: history (last ≤10) + joined burst from pendingMessages
model: see src/agents.config.js → agentLay.model
max_tokens: see src/agents.config.js → agentLay.maxTokens
```

**Why full injection is correct at this scale:**

The KB is intentionally bounded (~10 topic blocks, ~800–1,500 tokens). Cost at Haiku pricing ($0.25/MTok input): ~฿0.01 per 1,000 calls for the KB portion — negligible. The simplicity benefit is large: no vector DB, no embedding pipeline, no chunking decisions, no retrieval misses.

**When full injection breaks down:**

| KB size | Est. tokens | Problem |
|---|---|---|
| Current (~5 KB) | ~1,500 | None. Correct choice. |
| ~20 pages | ~10,000 | Cost grows, still manageable |
| ~100 pages | ~50,000 | "Lost in the middle" quality degradation; meaningful cost |
| ~500 pages | ~250,000 | Exceeds practical context window; impossible |

**"Lost in the middle":** at large context sizes, LLMs reliably attend to beginning and end of the prompt and lose accuracy on content buried in the middle. Full injection does not scale to a large KB even if it fits in the context window.

**Graduation signal — switch to RAG when:**
- KB exceeds ~30 pages (~15K tokens)
- KB gap alerts spike despite the KB containing the answer (retrieval failure symptom)
- Input token cost becomes meaningful relative to revenue per conversation

**RAG architecture (for future reference):**
```
Startup: chunk KB into ~300-token semantic sections
         → embed each chunk (Anthropic Embeddings or text-embedding-3-small)
         → store in in-memory or Chroma/Pinecone vector index

Per message:
  1. Embed the user's query
  2. Cosine-similarity search → top-3 relevant chunks (~1,500 tokens)
  3. Inject only those chunks into the system prompt
  4. LLM answers from a targeted excerpt, not the whole library
```
Tradeoff: lower cost + better needle-in-haystack quality vs infrastructure complexity.

### 5.2 Multi-message burst — lossless accumulator

LINE users frequently send several short messages in quick succession. The debounce window (12 s) **accumulates all messages** from a user into `session.pendingMessages[]`. When the timer fires, all pending messages are joined with a newline and processed as a single input block.

```
User: "สวัสดี"           → push to pendingMessages, reset 12s timer
User: "ผมสนใจบอท"        → push to pendingMessages, reset 12s timer
User: "ราคาเท่าไหร่"      → push to pendingMessages, reset 12s timer
                           12s silence → drain: "สวัสดี\nผมสนใจบอท\nราคาเท่าไหร่"
                           → processMessage(joined burst)
```

This means the LLM sees the user's full intent, not just the last message. The 12 s window is tunable via `DEBOUNCE_MS` in `bot.js` — increase if users need more typing time, decrease if latency matters more.

### 5.3 KB gap and lead detection

**KB gap:** heuristic — if reply contains `ไม่มีข้อมูล` or `ไม่ทราบ`, post the user's question to Discord #crm for Mos to update the KB.

**Lead detection:** currently manual trigger (buying-signal phrases). Phase 2: structured extraction via a follow-up LLM call when handoff fires.

---

## 6. File Structure

```
lazyhardwork_chatbot/
├── AGENTS.md                  # Coding agent orientation (read first)
├── .env.example               # All required env vars with descriptions
├── .gitignore                 # node_modules, .env
├── package.json
├── knowledge/
│   └── kb.md                  # Bot knowledge base (content file — edit to update KB)
└── src/
    ├── index.js               # Express server, /webhook POST, /health GET
    ├── bot.js                 # State machine + lossless debounce + handoff logic
    ├── llm.js                 # Anthropic SDK call, system prompt builder
    ├── kb.js                  # Loads knowledge/kb.md at startup
    ├── state.js               # In-memory session store (Map) + pendingMessages accumulator
    ├── discord.js             # #leads and #crm webhook POSTs
    ├── config.js              # Env-based config (secrets + infra only)
    └── agents.config.js       # Agent model definitions (model, maxTokens per agent role)
```

---

## 7. Configuration

Two separate config concerns, two separate files:

### 7.1 `.env` — secrets + infrastructure only
```env
# LINE OA
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=

# LLM API key (model selection is NOT here — see agents.config.js)
ANTHROPIC_API_KEY=

# Discord webhooks
DISCORD_LEADS_WEBHOOK=
DISCORD_CRM_WEBHOOK=

# Contact info (injected into system prompt — never hard-code)
CONTACT_PHONE=
CONTACT_EMAIL=

# Business hours (24h, Asia/Bangkok)
BUSINESS_HOURS_START=13
BUSINESS_HOURS_END=22

# Server
PORT=3000
```

### 7.2 `src/agents.config.js` — model definitions (version-controlled, not in env)
```js
module.exports = {
  agentLay: {
    model: 'claude-haiku-4-5-20251001',   // LINE OA reply — fast, cheap, Thai
    maxTokens: 1024,
    description: 'KB-only sales/FAQ bot',
  },
  // Add future sub-agents here:
  // crmSummarizer: { model: 'claude-haiku-4-5-20251001', maxTokens: 512, ... }
  // reportAgent:   { model: 'claude-sonnet-4-6',          maxTokens: 4096, ... }
};
```

**Rationale for the split:** secrets (API keys, tokens, webhook URLs) belong in `.env` and never in the repo. Model selection is not a secret — it's an engineering decision that should be version-controlled, reviewable in PRs, and editable without redeploying or touching the env file. Changing a model for one agent must not affect another.

---

## 8. Build Order

1. `GET /health` returns `{status:"ok"}` — verify server starts and LINE can reach it (ngrok)
2. `/webhook` receives LINE event, verifies signature, echoes text back — verify the full round-trip
3. Add lossless debounce (12 s timer per userId, message accumulator) — verify with rapid multi-message burst; LLM should receive joined text, not just last message
4. Add state store (`state.js`) — verify status transitions manually
5. Wire LLM (`llm.js` + `kb.js`) for `BOT_ACTIVE` replies — verify KB-only answers, no hallucination
6. Add handoff trigger detection → `WAITING_HUMAN` flow + `discord.js` #crm notify
7. Add lead detection heuristic + #leads Discord notify
8. Verify out-of-hours behavior (mock the hour or temporarily change `BUSINESS_HOURS_START`)
9. Run full acceptance criteria checklist from `lhw-bot-requirement-spec.md §11`
10. Set LINE Developers webhook URL to production host → smoke test live

---

## 9. Deployment (Phase 1)

**Render free tier** (zero-config):
- Connect GitHub repo → auto-deploy on push to `main`
- Set env vars in Render dashboard (never in repo)
- Free tier sleeps after 15 min inactivity — for production upgrade to Starter ($7/mo) or self-host on VPS

**Webhook URL pattern:** `https://{render-subdomain}.onrender.com/webhook`

**Local dev:** `npm run dev` (nodemon) + `ngrok http 3000` → paste ngrok HTTPS URL to LINE Developers console webhook field. Disable LINE's default auto-reply in the console.

---

## 10. Branch Comparison Plan

Both `feature/antigravity` and `feature/claude-code` implement from the **same spec** (this doc + `lhw-bot-requirement-spec.md`). After each is complete, compare on:

| Dimension | What to check |
|---|---|
| Acceptance criteria | All 9 items in req spec §11 — pass/fail |
| KB fidelity | Does it hallucinate? Answer from KB only? |
| Handoff correctness | State transitions, Discord payloads |
| Code clarity | How easy to update KB / change tone |
| Deploy friction | Steps to go live |

Winner becomes `main`. Both implementations are kept as branches for reference.

---

## 11. Scaffold Reusability — Starting a New Client Project

The `scaffold/src/` files in the vault are designed so future LINE OA bot projects can reuse the engine and only replace the client-specific layer.

### Reuse classification

| File | For a new LINE OA client | Notes |
|---|---|---|
| `index.js` | Copy verbatim | Identical for any LINE OA webhook |
| `state.js` | Copy verbatim | Generic session store |
| `kb.js` | Copy verbatim | Always loads `knowledge/kb.md` |
| `agents.config.js` | Copy, update model per project needs | Add/rename agent slots |
| `config.js` | Copy verbatim | Env-driven; no client-specific content |
| `discord.js` | Copy verbatim | Webhook URLs come from env, not code |
| `bot.js` | Copy, update handoff phrases + persona replies | Business logic is client-specific |
| `llm.js` | Rewrite system prompt | Persona, rules, voice are client-specific |
| `knowledge/kb.md` | Rewrite entirely | Client's KB content |

**For a non-LINE OA channel** (web chat, Discord bot, etc.): `state.js`, `kb.js`, `agents.config.js`, and the config pattern transfer conceptually. `index.js` and `bot.js` need significant changes (different event shape).

### Starting a new client project (checklist)

1. In the vault: run through Pre-Implement — discovery → requirement-spec → engineering-spec → scaffold/src/
2. Create the dev repo, copy `scaffold/src/` → `src/`
3. Rewrite `llm.js` system prompt for the new client's persona
4. Rewrite `knowledge/kb.md` with the client's KB content
5. Update `agents.config.js` if the model needs differ
6. Set new env vars in `.env` (LINE credentials, Discord webhooks, contact info)
7. Implement per that project's engineering-spec build order

---

## 12. Pricing (authoritative — `00-START-HERE.md §5` floor)

| แพ็ก | ราคาเริ่มต้น |
|---|---|
| Starter | ฿15,000 |
| Advanced | ฿20,000 |
| Operation | ฿30,000 |

KB and requirement spec have stale numbers — **use these**.
