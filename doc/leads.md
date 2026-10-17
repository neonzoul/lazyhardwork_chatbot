# Leads — intake, export, sync (design §9, brief §6)

Code: `src/leads/intake.js` (pure), `src/leads/export.js` (`GET /admin/leads?since=`), `scripts/lead-sync.js`.
Vault procedure for every channel: `_agent/instructions/lead-intake.md` (vault). Store shape: `doc/store.md`.

## 1. Lead row (bot DB, `leads` table)

| field | written by | from |
|---|---|---|
| `id` | store | `L-YYYY-MM-DD-line_oa-{6 base36}` (date from the clock, UTC) |
| `user_id` | intake | session |
| `status` | intake + flows | `new` → `qualified` (intake: `business` + `problem_verbatim` known) → `booking_pending` / `booked` / `offer_shown` (flows pass `status`) → `closed`. **Never regresses** — `buildLeadRow` keeps the highest rank. |
| `card_id`, `symptom` | intake | `session.draft.card` / `.symptom`, else the existing row |
| `homework` | intake | `{...existing.homework, ...session.homework}` — a field, once known, never disappears |
| `customer_words_th` | intake | `homework.problem_verbatim` (verbatim; never paraphrased) |
| `wave_group` | intake | `waveGroup()` — only from the customer's own words (below), else the existing value, else null |
| `source` | intake | `line_oa` (channel map §3 values) |
| `created_at`, `updated_at` | intake/store | clock |

`buildLeadRow({ session, existing, now, status? })` returns the row for `store.leads.upsert()`; it is what
`turn.js → upsertLead` should call. Contact (display name, LINE user id) lives in the session and the DB only.

### Qualification — `qualify(session)` → `{ qualification, reasons[], score }`
Points: business 1 · problem_verbatim 1 · each other homework field 0.5 · urgent words +2 (`ด่วน`, `เดือนนี้`,
`asap`…) or not-urgent words −1 (`ยังไม่รีบ`, `แค่ดู`…) · preferred_contact +1 · booking in progress +3.
`hot ≥ 5` · `warm ≥ 2` (= the two core fields, i.e. status `qualified`) · else `cold`. Deterministic; reasons are English.

### Wave group — `waveGroup(session, customerTexts = [])`
Reads only `homework.problem_verbatim / where_work_lives / came_from / maintainer` plus any raw customer texts given.
`W3` says they never used AI · `W2` has an AI seat/subscription (AI Pass, Gemini, ChatGPT Plus, Copilot…) **and** says
they have no system / don't know how to use it · `W1` used AI but says it gave no result · otherwise `null`.
Never from the card, the symptom or the model's guess (ledger header: "from the chat's own words, never guessed").

### Redaction — `redactForDiscord(lead)` and `leadSummaryTh(lead, { reason })`
Drops `display_name`, `line_user_id`, `user_id`, `contact`, `phone`, `email`, `handle`, `line_id` keys at any depth and
replaces phone-like (`0x-xxx-xxxx`, `+66…`), email-like and LINE-user-id-like strings and the display name inside every
remaining string with `[phone]`, `[email]`, `[line_user_id]`, `[name]`. `leadSummaryTh` is the `#leads` thread body:
reason · id · card · symptom · status · the customer's words · homework n/9 · level + wave · next step. No emoji.

## 2. Export shape (`src/leads/export.js`)
`{ id, status, card_id, symptom, homework, customer_words_th, wave_group, source, created_at, updated_at,
contact: { display_name, line_user_id }, booking: { id, status, window_text, … } | null }`. Contact is included on
purpose (token-protected endpoint; the sync decides where it goes).

## 3. Sync — `scripts/lead-sync.js`
```
node scripts/lead-sync.js --vault <vault root> [--since <iso>] [--base-url <https://app>] [--token <ADMIN_TOKEN>]
                          [--from-file export.json] [--dry-run]
```
Defaults: `--base-url` ← `PUBLIC_BASE_URL`, `--token` ← `ADMIN_TOKEN`. `--from-file` skips the network (same JSON shape).
Writes by **text insertion** (comments and formatting survive; js-yaml only reads and verifies; nothing is written
unless both files re-parse with every synced id present). UTF-8, LF (a CRLF file stays CRLF). Idempotent by lead id —
a second run reports `skipped`. Exit 0 and a summary table (created / updated / skipped per file).

| target | mapping |
|---|---|
| `Clients/000_lazyhardwork/PJ_go_to_market/growth-ledger.yaml → leads[]` | `id` · `channel: line_oa` · `card_id` · `date` (created date, Asia/Bangkok) · `customer_words_th` · `qualification` (cold/warm/hot) · `state` · `outcome: null` · `source: line_oa` · `wave_group` · `mos_read: {}` on create only. **No contact.** On update only `card_id, customer_words_th, qualification, state, wave_group` lines move; `mos_read`, `outcome`, `date` are never touched. |
| ledger `state` | new → `inquiry` · qualified / booking_pending / booked → `discovery` · offer_shown → `proposed` · closed → `closed`. Sync only raises along inquiry < discovery < proposed < paid; an unknown hand-written state is kept. |
| `_agent/data/leads.yaml → leads[]` | `id` (the bot's id) · `date_added` · `contact: { channel: line, handle: <display_name>, line_user_id }` · `business_name` (homework.business or `TBD`) · `platform_source: line_oa` · `status` · `next_action` · `notes` (problem verbatim + booking window + lead id) · `converted: null` · `lost: null`. |
| leads.yaml `status` | new → `new` · qualified → `qualifying` · booking_pending / booked / offer_shown → `interested` · closed → `contacted`. Only raises along new < contacted < qualifying < interested < converted; `converted` / `lost` set by hand are terminal (facts such as business name still flow in). |
| `_agent/index.yaml` | the `last_updated:` header line only, when something changed. Both YAML files also get `last_updated` / `updated_by: lead-sync (Lay v2)`. |

## 4. Privacy rules
- Contact details (display name, LINE user id, phone, email) exist in the bot DB and `_agent/data/leads.yaml` only.
- Never in Discord (`redactForDiscord` before any notify), never in `growth-ledger.yaml`, never in logs beyond the id.
- `customer_words_th` is the customer's own problem statement; if a customer types a phone number into it, the
  Discord copy is scrubbed, the ledger copy is what the bot stored — the sync agent checks the summary before running
  without `--dry-run` on a new lead.
- Transcripts stay in the bot DB until the lead becomes a client (client-record standard), then move with it.

## 5. Hooks for the pipeline (owned by the head engineer / flow implementers)
- `turn.js → upsertLead`: replace the hand-built row with `intake.buildLeadRow({ session, existing, now })`; notify
  with `leadSummaryTh(saved, { reason })` on first create and on status change.
- Flows: `endings` passes `status: 'booking_pending'` when a window is proposed, `'booked'` when Mos confirms, and
  `'offer_shown'` after the offer card; `upsertLead(session, { status, reason })` forwards it to `buildLeadRow`.
