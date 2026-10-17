# Lay v2 — LazyHardWork LINE OA assistant

**Status: v2 in build; cut-over planned Tue 2026-10-20.** `main` is still v1 and live. Agents start at `AGENTS.md`.

## What Lay does

Lay is the assistant on LazyHardWork's own LINE OA. It greets, answers the six questions a lead asks (what it does,
fit, price, timeline, examples, how to start) from a knowledge pack generated out of the vault, finds the fit by
symptom, collects a short "homework" set without interrogating, and ends in one of two ways: an offer card with the
Fastwork price (short path) or a booking request that Mos confirms (long path). It hands over to Mos when asked, when
a discount is requested, or when it does not know — and it never pretends to know. It can also show a live demo of
what a shop bot feels like. Replies are Thai, short, buttons instead of lists, one card at most.

## The three identities

| Sender shown in LINE | When |
|---|---|
| `Lay · ผู้ช่วย AI` | everything Lay says |
| `มอส` | lines Mos types in the Discord thread, relayed by the bot |
| `ริมคลอง · ผู้ช่วย AI` / `ใสใส · ผู้ช่วย AI` | the two sample shops inside demo mode (labelled ตัวอย่าง in the text) |

LINE appends "from <OA name>" to custom senders; icons are served by the app under `/assets`.

## How Mos replies from Discord

A handoff or booking opens a thread in `#leads` (title `L-… · <card> · <symptom>`). In that thread:

- **plain text** → pushed to the customer as **มอส**; Lay goes quiet (`mos_active`) until `/lay` or 30 min idle.
- `/approve` → booking confirmed, the customer's summary card turns green "ยืนยันแล้ว" (the only way it does).
- `/propose พรุ่งนี้ 14:00 หรือ 16:00` → customer gets the windows as buttons; picking one comes back as pending.
- `/decline` → polite decline with the phone line.
- `/lay` → Lay takes over again ("Lay กลับมาดูแลต่อครับ…").

No customer personal data is posted in Discord — the lead id is the key; names, phones, LINE ids are scrubbed.

## `เรียก Lay`

After a handoff Lay acknowledges once and stays silent while Mos handles it. The customer can type **เรียก Lay**
(or tap the Rich Menu tile / quick reply) at any time to get Lay back — from quiet, from Mos mode, or out of a demo.

## Demo mode

ขอดูตัวอย่าง opens a carousel; "ลองเล่นร้านตัวอย่าง" lets the customer chat with a sample café or clinic that answers as
itself, takes a pretend order, shows a summary card and a simulated "ส่งให้เจ้าของร้าน (ตัวอย่าง) แล้ว". Nothing in demo
touches leads or notifications. Exit with กลับไปคุยกับ Lay; Lay recaps and asks which of the five symptoms fits.

## Updating knowledge

Offer, prices, FAQ, fit map, process, policies and demo shop facts come from the vault, never from this repo:

1. Edit the source in the vault (`Clients/000_lazyhardwork/PJ_lineOA_chatbot_v2/…`, the GTM ledger for prices).
2. `npm run kb:build -- --project-dir <that folder>` — fails if a card price disagrees with the ledger.
3. Commit `knowledge/` (generated files) → push the deployed branch → Railway redeploys.

## Environment variables (names only — values live in `.env` / Railway)

| Variable | Meaning |
|---|---|
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | the channel the app serves (test channel until cut-over) |
| `LINE_PROD_CHANNEL_SECRET`, `LINE_PROD_CHANNEL_ACCESS_TOKEN` | production channel (scripts with `--channel prod`) |
| `LINE_TEST_CHANNEL_ID`, `LINE_TEST_BOT_BASIC_ID`, `MOS_LINE_USER_ID` | test OA ids, Mos's LINE user id |
| `OPENAI_API_KEY` | model key (model name is in `src/agents.config.js`) |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_LEADS_CHANNEL_ID`, `DISCORD_CRM_CHANNEL_ID` | relay bot |
| `DISCORD_LEADS_WEBHOOK`, `DISCORD_CRM_WEBHOOK` | fallback when the bot cannot open a thread |
| `PUBLIC_BASE_URL`, `LAY_ICON_URL`, `MOS_ICON_URL` | public https base; icon URLs (derived from the base if unset) |
| `DB_PATH` | SQLite file (`/data/lay.sqlite` on Railway's volume) |
| `ADMIN_TOKEN` | bearer token for `GET/POST /admin/*` |
| `CONTACT_PHONE`, `CONTACT_PHONE_DISPLAY`, `FASTWORK_URL` | contact line and profile link |
| `BUSINESS_HOURS_START`, `BUSINESS_HOURS_END` | Bangkok hours shown as open/closed (13–22) |
| `QUIET_WINDOW_MINUTES`, `DEBOUNCE_MS`, `KNOWLEDGE_DIR`, `DISCORD_REGISTER_COMMANDS`, `PORT` | optional tuning |

## Run locally

```bash
cp .env.example .env && npm install
npm test && npm run scenarios
npm run dev                       # then: npx ngrok http 3000 → node scripts/set-webhook.js https://<ngrok>/webhook
```

## Deployment

`doc/deploy.md` — the Railway runbook (service `lay-v2`, volume at `/data`, variables, webhook, Rich Menu, smoke
checks, the Tuesday cut-over and rollback). Nothing is created on Railway yet.

## Where things are

`AGENTS.md` (agents) · `doc/feature-map.md` (every feature → module → test) · `doc/*.md` per module ·
vault `design-lay-v2.md` / `decisions.md` / `build-log.md` (the record).
