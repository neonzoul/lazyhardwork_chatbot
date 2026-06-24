# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

`AGENTS.md` is the authoritative entry point: persona, hard rules, file map, spec locations, and the
9 acceptance criteria. Read it first. Specs live in `doc/spec/` (requirement + engineering). This
file covers commands, the runtime flow, and gotchas not visible from a single-file read.

## Commands

```bash
npm install        # installs all deps including openai SDK
npm start          # node src/index.js
npm run dev        # nodemon (auto-reload)
node scripts/setup-rich-menu.js   # one-time LINE Rich Menu setup (needs scripts/rich-menu.png)
```

No test suite, linter, or build step. Verification is manual against `doc/spec/lhw-bot-requirement-spec.md §11`. Quick smoke test: `GET /health` → `{status:"ok"}`.

Local dev tunnel: `npx ngrok http 3000` → paste HTTPS URL into LINE Developers console webhook field.

## Architecture

Single Express process, one inbound surface (`POST /webhook` from LINE), in-memory state. Request flow:

```
LINE webhook → index.js (signature-verified by line.middleware)
  → bot.handleEvent
       ├─ postback  → processPostback (Rich Menu: MENU_SERVICES/PORTFOLIO/PRICING/CONTACT/HANDOFF)
       ├─ follow    → send greeting message
       └─ message   → accumulate into pendingMessages, reset 6.5s debounce timer
                       showLoadingAnimation (typing indicator — best-effort)
  → (after 6.5s quiet) bot.processMessage
       ├─ HUMAN_ACTIVE  → silent
       ├─ WAITING_HUMAN → "still waiting" reply
       └─ BOT_ACTIVE    → handoff check → LLM call → push reply
                          if buying signal in message → extractLead + discord.postLead (#leads)
                          if KB gap in reply → discord.postCrmFeedback (#crm)
  → lineClient.pushMessage
```

Module roles (each `src/*.js` is single-purpose; see AGENTS.md file map):
- **state.js** — `Map<userId, session>`; status FSM `BOT_ACTIVE → WAITING_HUMAN → HUMAN_ACTIVE`,
  history capped at 10, lossless `pendingMessages` burst accumulator. In-memory — restarts wipe sessions.
- **llm.js** — builds system prompt fresh each call (KB + contact config + business-hours notice),
  full KB injected (no retrieval). Exports `chat()`, `hasBuyingSignal()`, `extractLead()`.
- **agents.config.js** — model selection per agent role (`agentLay` uses `gpt-4o-mini`). Models are
  version-controlled here; secrets go in `.env` only.

## Key conventions

- **Config split:** `agents.config.js` = model choices (committed); `config.js` = secrets from `process.env`.
- **KB is content, not code:** edit `knowledge/kb.md` to change what the bot knows.
- **`[Agent Lay]`** must end every bot reply — the LLM is instructed to do this, and the hard-coded
  strings in `bot.js` (handoff / waiting / Rich Menu replies) all include it manually.
- **LLM provider:** OpenAI (`gpt-4o-mini`) via `openai` npm package. Key is `OPENAI_API_KEY` in `.env`.

## Notes

- **Replies use `pushMessage`** (not reply token) — consumes push quota but allows async delivery.
- **Rich Menu image required:** `scripts/setup-rich-menu.js` sets up the 5-button menu structure but
  needs `scripts/rich-menu.png` (2500×843 px). Create in Canva and place it before running the script.
- **Typing indicator** calls `showLoadingAnimation` — best-effort, errors are silently swallowed.
- **Lead extraction** fires a second LLM call asynchronously when a buying signal is detected, then
  posts structured lead data to Discord `#leads`.
