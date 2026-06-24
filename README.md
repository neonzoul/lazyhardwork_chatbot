# Agent Lay — LazyHardWork LINE OA Chatbot

LINE OA chatbot for LazyHardWork's own channel. Answers leads from a knowledge base, captures contact on buying signal, and hands off to Mos via Discord.

## Features

- **KB-only answers** — LLM answers strictly from `knowledge/kb.md`, never hallucinating
- **Typing debounce** — 6.5 s burst accumulator so multi-message bursts arrive as one block
- **Lead capture** — detects buying signals, extracts structured lead fields, posts to Discord `#leads`
- **Human handoff** — `คุยกับคนจริง` → `WAITING_HUMAN` → Discord `#crm` notify → bot goes silent
- **Rich Menu** — 5 buttons: บริการ / ผลงาน / ราคา / คุยกับคนจริง / ติดต่อ
- **Out-of-hours notice** — bot stays active in KB scope and informs the user
- **Admin resume** — HTTP endpoint to bring bot back to `BOT_ACTIVE` after human handoff

## Stack

Node.js 18+ · Express · `@line/bot-sdk` v9 · OpenAI `gpt-4o-mini` · axios (Discord webhooks)

## Quick Start

```bash
cp .env.example .env      # fill in credentials
npm install
npm run dev               # nodemon auto-reload
```

Expose locally with ngrok:

```bash
npx ngrok http 3000
# paste the HTTPS URL → LINE Developers console → Messaging API → Webhook URL
# append /webhook  e.g. https://xxxx.ngrok-free.app/webhook
```

Smoke test: `GET /health` → `{"status":"ok"}`

## Environment Variables

| Variable | Description |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE channel access token |
| `OPENAI_API_KEY` | OpenAI API key (model set in `src/agents.config.js`) |
| `DISCORD_LEADS_WEBHOOK` | Discord webhook URL for `#leads` |
| `DISCORD_CRM_WEBHOOK` | Discord webhook URL for `#crm` |
| `CONTACT_PHONE` | Business phone injected into system prompt |
| `CONTACT_EMAIL` | Business email injected into system prompt |
| `FASTWORK_URL` | Fastwork profile URL |
| `BUSINESS_HOURS_START` | Hour bot is "in hours" (24h, Bangkok) — default `13` |
| `BUSINESS_HOURS_END` | Hour bot goes "out of hours" — default `22` |
| `ADMIN_SECRET` | Secret token for admin endpoints |

## Project Structure

```
knowledge/kb.md          ← bot's brain — edit to change what Agent Lay knows
src/
  index.js               Express server + admin endpoints
  bot.js                 State machine, debounce, Rich Menu postback, handoff
  llm.js                 OpenAI call, system prompt builder, lead extraction
  state.js               In-memory session store per userId
  discord.js             #leads and #crm Discord webhook posts
  kb.js                  Loads knowledge/kb.md at startup
  config.js              All config from process.env
  agents.config.js       Model selection (version-controlled, not in .env)
doc/spec/                Requirement + engineering specs
scripts/
  setup-rich-menu.js     One-time LINE Rich Menu setup
```

## Updating the Knowledge Base

Edit `knowledge/kb.md` and restart the server. No code changes needed.

## Rich Menu Setup

1. Create a 2500×843 px image with 5 equal columns and save as `scripts/rich-menu.png`
2. Run `node scripts/setup-rich-menu.js`

## Admin Endpoints

All admin endpoints require `?secret=<ADMIN_SECRET>`.

**Resume bot after human handoff:**
```
GET /admin/resume?secret=xxx&userId=U<lineUserId>
```
Sets the user's status back to `BOT_ACTIVE`. The `userId` is in the Discord `#crm` notification.

**Check current status:**
```
GET /admin/status?secret=xxx&userId=U<lineUserId>
```

## Bot State Machine

```
BOT_ACTIVE  ──(handoff trigger)──►  WAITING_HUMAN  ──(Mos sets manually)──►  HUMAN_ACTIVE
                                                                                    │
                                    BOT_ACTIVE  ◄────────(admin /resume)───────────┘
```

Handoff triggers: `คุยกับคนจริง` · `ขอคุยกับมอส` · `อยากนัดคุย` · `คุยกับคน` · Rich Menu button

## Deployment

**Render (recommended):**
1. Connect GitHub repo → auto-deploy on push to branch
2. Set all env vars in Render dashboard
3. Update LINE webhook URL to the Render HTTPS URL + `/webhook`

> Free tier sleeps after 15 min — upgrade to Starter ($7/mo) for always-on.
