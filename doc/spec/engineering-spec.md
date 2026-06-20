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

```
system prompt structure:
  [persona + sign-off rule: "[Agent Lay]" on every response]
  [contact info from config — never hard-coded]
  [KB: identity · services · pricing · proof · FAQ · handoff flow · voice samples]
  [rules: KB-only · no hallucination · no custom quote · escalate unknowns]
  [if out-of-hours: append notice]

messages: history (last ≤10) + current user message
model: claude-haiku-4-5-20251001
max_tokens: 1024
```

**KB gap detection:** heuristic — if reply contains `ไม่มีข้อมูล` or `ไม่ทราบ`, post the user's question to Discord #crm as a feedback item for Mos to update the KB later.

**Lead detection:** currently manual trigger (user says buying-signal phrases). Phase 2: structured extraction via a follow-up LLM call when handoff is triggered.

---

## 6. File Structure

```
lazyhardwork_chatbot/
├── AGENTS.md                  # Coding agent orientation (read first)
├── .env.example               # All required env vars with descriptions
├── .gitignore                 # node_modules, .env
├── package.json
└── src/
    ├── index.js               # Express server, /webhook POST, /health GET
    ├── bot.js                 # State machine + debounce + handoff logic
    ├── llm.js                 # Anthropic SDK call, system prompt builder
    ├── kb.js                  # KB content injected into system prompt
    ├── state.js               # In-memory session store (Map)
    ├── discord.js             # #leads and #crm webhook POSTs
    └── config.js              # All config from process.env
```

---

## 7. Configuration (all from `.env`)

```env
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
ANTHROPIC_API_KEY=
LLM_MODEL=claude-haiku-4-5-20251001
DISCORD_LEADS_WEBHOOK=
DISCORD_CRM_WEBHOOK=
CONTACT_PHONE=
CONTACT_EMAIL=
BUSINESS_HOURS_START=13
BUSINESS_HOURS_END=22
PORT=3000
```

**Rule:** nothing above is ever hard-coded in source. To change contact info or switch LLM model → edit `.env` only.

---

## 8. Build Order

1. `GET /health` returns `{status:"ok"}` — verify server starts and LINE can reach it (ngrok)
2. `/webhook` receives LINE event, verifies signature, echoes text back — verify the full round-trip
3. Add debounce (6.5s timer per userId) — verify with rapid multi-message burst
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

## 11. Pricing (authoritative — `00-START-HERE.md §5` floor)

| แพ็ก | ราคาเริ่มต้น |
|---|---|
| Starter | ฿15,000 |
| Advanced | ฿20,000 |
| Operation | ฿30,000 |

KB and requirement spec have stale numbers — **use these**.
