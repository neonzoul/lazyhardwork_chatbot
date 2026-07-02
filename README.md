# Agent Lay — LazyHardWork LINE OA Chatbot

LINE OA chatbot for LazyHardWork's own channel. Answers leads from a knowledge base, captures contact on buying signal, and hands off to Mos via Discord.

## Features

- **KB-only answers** — LLM answers strictly from `knowledge/kb.md`, never hallucinating
- **Typing debounce** — 6.5 s burst accumulator so multi-message bursts arrive as one block
- **Lead capture** — detects buying signals, extracts structured lead fields, posts to Discord `#leads`
- **Human handoff** — `คุยกับคนจริง` → `WAITING_HUMAN` → Discord `#crm` notify → bot goes silent
- **Rich Menu** — 5 buttons: บริการ / ผลงาน / ราคา / คุยกับคนจริง / ติดต่อ
- **Out-of-hours notice** — bot stays active in KB scope and informs the user
- **Admin dashboard** — web UI to monitor sessions, change bot status per user, auto-refreshes every 30s
- **Thai admin guide** — `/admin/docs` explains the system in plain Thai for non-technical admins

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

| Endpoint | Description |
|---|---|
| `GET /admin` | HTML dashboard — session table with live status dropdowns |
| `GET /admin/docs` | Thai admin guide for non-technical admins |
| `GET /admin/set-status` | Set a user's bot status (`userId` + `status` params) |
| `GET /admin/resume` | Legacy shortcut — sets userId to `BOT_ACTIVE` |
| `GET /admin/status` | JSON status check for a single userId |

**Change a user's status (e.g. resume bot after handoff):**
```
GET /admin/set-status?secret=xxx&userId=U<lineUserId>&status=BOT_ACTIVE
```
Valid values: `BOT_ACTIVE`, `WAITING_HUMAN`, `HUMAN_ACTIVE`. Returns `{ userId, displayName, prev, now }`.

The `userId` appears in every Discord `#crm` notification. The dashboard also lists all active sessions with a dropdown to change status without touching the URL.

## Bot State Machine

```
BOT_ACTIVE  ──(handoff trigger)──►  WAITING_HUMAN  ──(Mos sets manually)──►  HUMAN_ACTIVE
                                                                                    │
                                    BOT_ACTIVE  ◄────────(admin /resume)───────────┘
```

Handoff triggers: `คุยกับคนจริง` · `ขอคุยกับ Mos` · `อยากนัดคุย` · `ขอคุยกับคน` · Rich Menu button · complaint detected in reply

## Deployment (Railway)

### 1. Create project

Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select this repo.

Railway auto-detects Node.js and runs `npm start`. No Dockerfile needed.

### 2. Set environment variables

Railway → your service → **Variables** → add each key:

| Variable | Description |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE Developers → Messaging API → Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers → Messaging API → Channel access token (long-lived) |
| `OPENAI_API_KEY` | OpenAI API key |
| `DISCORD_LEADS_WEBHOOK` | Discord webhook URL for `#leads` |
| `DISCORD_CRM_WEBHOOK` | Discord webhook URL for `#crm` |
| `CONTACT_PHONE` | Business phone number shown to customers |
| `CONTACT_EMAIL` | Business email shown to customers |
| `FASTWORK_URL` | Fastwork profile URL |
| `BUSINESS_HOURS_START` | Hour business opens (24h, Bangkok TZ) — default `13` |
| `BUSINESS_HOURS_END` | Hour business closes — default `22` |
| `ADMIN_SECRET` | Any random string for admin endpoints |

`PORT` is injected automatically by Railway — do not add it.

### 3. Get public URL

Railway → your service → **Settings** → **Networking** → **Generate Domain**

This gives you `https://your-app.up.railway.app`.

### 4. Set LINE webhook

1. [LINE Developers Console](https://developers.line.biz) → your channel → **Messaging API**
2. Webhook URL → `https://your-app.up.railway.app/webhook`
3. **Use webhook** ON · **Auto-reply messages** OFF · **Greeting messages** OFF
4. Click **Verify** → should return 200 OK

### 5. Smoke test

```
GET https://your-app.up.railway.app/health
→ { "status": "ok" }
```

### Redeploys

Railway auto-deploys on every push to the connected branch. Environment variable changes take effect on the next deploy (trigger manually from the Railway dashboard if needed).
