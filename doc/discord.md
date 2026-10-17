# Discord relay (Lay v2) — `src/discord/`

Design of record: design §6.2, brief §3.8, addendum A1; Discord workspace brief §1 (no client personal/business data in
Discord). Mos answers customers from a thread in `#leads`; the bot relays his words to LINE as "มอส".

## Modules
| file | role |
|---|---|
| `format.js` | pure Thai formatters: thread title, opening message, KB-gap line, lead line, mirror line; scrubs phone/email/LINE id |
| `notify.js` | `createNotifier(...)` → the production `deps.notifier` (threads via bot REST, webhook fallback, throw last) |
| `relay.js` | `createRelay(...)` → `{start, stop}`: discord.js Client listening in the threads we opened |
| `commands.js` | `parseCommand`, reference `handleCommand` (maps `/approve /propose /decline /lay` onto the pipeline), slash definitions |

## Setup
Env (via `src/config.js → config.discord`): `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_LEADS_CHANNEL_ID`,
`DISCORD_CRM_CHANNEL_ID`, `DISCORD_LEADS_WEBHOOK`. Optional `DISCORD_REGISTER_COMMANDS=1` registers the four guild slash
commands on start (plain `/` lines in the thread always work regardless).

Bot permissions in `#leads`: **View Channel · Send Messages · Create Public Threads · Send Messages in Threads · Read Message
History**. Developer portal → Bot → Privileged Gateway Intents: **Message Content Intent ON** (the relay reads thread text).
Without it the gateway connects but `message.content` is empty and nothing relays.

Wiring (in app start, after `store` exists):
```js
const notifier = createNotifier({ ...config.discord, log, store });
const relay = createRelay({ ...config.discord, store, log,
  onMosMessage: ({ userId, text }) => runTurn({ kind: 'mos_relay', userId, text, timestamp: Date.now() }, deps),
  onCommand: (c) => handleCommand(c, { deps, config }) });
await relay.start();   // no token → logs discord.relay_disabled and returns null (webhook-only mode)
```

## Thread lifecycle
1. **Open** — `notifier.handoff({kind, session, lead, question, draft})` or `notifier.booking({lead, booking, session})`:
   `POST /channels/{leads}/threads` (PublicThread, auto-archive 1 day, title `L-… · <card or ?> · <symptom or kind>` ≤ 90
   chars), then the opening message into the thread. Returns `{threadId}`; `flows/handoff` stores it as
   `session.discord_thread_id`; if `store.relayThreads` exists (T1) a row `{discord_thread_id, user_id, lead_id, opened_for}`
   is recorded too. Only after this resolves does the customer hear "ส่งให้มอสแล้ว" (notify before promise).
2. **Mos types** plain text in the thread → `onMosMessage({threadId, userId, lead_id, text})` → `runTurn({kind:'mos_relay'})`
   pushes it to LINE as "มอส" with the `เรียก Lay` quick reply; mode → `mos_active`. The bot reacts ✅ on his message. Failure →
   a `❌ ส่งไม่สำเร็จ: …` line in the thread.
3. **Customer replies while `mos_active`** → the pipeline should call `notifier.relayToMos({threadId, text})` so Mos sees it in
   the same thread (`💬 ลูกค้า: …`, contact-scrubbed). *(hook needed in turn.js — see below.)*
4. **Commands** (`/approve`, `/propose <ช่วงเวลา>`, `/decline`, `/lay`) → `onCommand` → one-line ack `✅ …` / `❌ …` in the thread.
   `/lay` hands back to Lay (mode `lay`, Lay says "Lay กลับมาดูแลต่อครับ…"). Unknown `/x` → `❌ ไม่รู้จักคำสั่ง …`.
5. **End** — Discord auto-archives after a day of silence; the pipeline drops `mos_active` after 30 min without a Mos message.

Thread → customer lookup order: `store.relayThreads.byThread(id)` → a session with `discord_thread_id === id` → (thread owned by
our bot under `#leads`) lead id parsed from the title with no userId: text then answers "เธรดนี้ไม่ได้ผูกกับลูกค้า".

## Fallback rules
| situation | handoff / booking | kbGap / lead | relayToMos |
|---|---|---|---|
| bot + channel configured, thread created | `{threadId}` | bot message in `#leads` | message in thread |
| bot missing or thread creation fails | webhook plain message, `{threadId:null, fallback:'webhook'}` (no inbound relay) | webhook | no-op |
| bot and webhook both fail | **throws** → `flows/handoff` tells the customer "ระบบส่งเรื่องขัดข้อง โทร …" | logged, never throws | logged, never throws |

Every call has an 8 s timeout and no automatic retries. Mentions are disabled on everything we post.

## What is never posted
Phone numbers, emails, LINE userIds, LINE display names (personal data: the lead id is the only key), anything from
`lead.contact`. Free text from the customer (`question`, `problem_verbatim`, `preferred_contact`, mirrored messages) is
scrubbed with regexes (`[phone]`, `[email]`, `[line-user]`, `[line-id]`) before posting and clipped to 300 chars. Tests in
`tests/unit/discord.format.test.js` assert this against sample data that contains all of them.

## > **Status 2026-10-17 evening:** the hooks listed below are implemented in `src/core/turn.js` / `src/app.js` / `tests/run-scenarios.js` (head engineer). Kept as the record of the contract.

Hooks this module needs elsewhere (not in `src/discord`)
- `src/core/turn.js`: input kind `mos_release` (set mode `lay`, push `quiet.strings.back` as Lay, `resumed_by: 'mos_release'`) and
  export `INPUT_KINDS` so `commands.releaseToLay` can detect it; until then `/lay` does the same directly through `deps`.
- `src/core/turn.js`: when `s.mode === 'mos_active' && s.discord_thread_id`, fire-and-forget
  `deps.notifier.relayToMos({threadId: s.discord_thread_id, text}).catch(() => {})` before the silent return.
- `src/flows/endings.js` (Implementer E): `applyMosDecision({decision:'approve'|'propose'|'decline', text, userId, leadId, threadId, deps, config})`.
- `src/store` (T1): `relayThreads.create(row)` and `relayThreads.byThread(discord_thread_id)`.

## Tests
`tests/unit/discord.format.test.js`, `discord.notify.test.js`, `discord.relay.test.js` — node:test, no network (fake transport,
fake EventEmitter client). Live smoke (not committed): login, one test thread in `#leads`, read back — 4 API calls; result in the branch report.
