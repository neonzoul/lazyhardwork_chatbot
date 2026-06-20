# AGENTS.md — lazyhardwork_chatbot

> Entry point for any coding agent opening this repo. Read this before touching any file.

## What this repo builds

**Agent Lay** — the LINE OA chatbot for LazyHardWork's own channel (client zero).
- Persona: service-minded admin, natural Thai, signs off every reply with `[Agent Lay]`
- Core job: answer leads from KB only, capture contact on buying signal, hand off to Mos via Discord
- No tool-calling. No rule-based menus. LLM answers directly from the injected knowledge base.

## This repo is self-contained

This is a **development repository in the Coding Area — intentionally separate from the LhW
workspace/vault.** Everything a coding agent needs has been copied in: specs (`doc/spec/`), the
knowledge base (`knowledge/`), and the scaffold (`src/`). You do **not** need access to the vault
to implement. The vault is the source of truth for these docs; this repo holds working copies.

## Spec documents (read before implementing — all local to this repo)

| What | Where |
|---|---|
| **Requirement spec** (WHAT to build) | `doc/spec/lhw-bot-requirement-spec.md` |
| **Engineering spec** (HOW — architecture, data models, build order) | `doc/spec/engineering-spec.md` |
| **Knowledge base** (Agent Lay's brain — what the bot loads) | `knowledge/kb.md` |
| **KB loader** (reads `knowledge/kb.md`) | `src/kb.js` |

> Vault source of truth (for maintainers syncing back): `LazyHardWork/Clients/000_lazyhardwork/`

## Stack

Node.js ≥ 18 · Express · `@line/bot-sdk` v9 · Anthropic SDK · axios (Discord webhooks)

## File map

```
├── doc/spec/                Specs copied from the vault (requirement + engineering)
├── knowledge/
│   └── kb.md                The bot's brain — edit this to change what Agent Lay knows
└── src/
    ├── index.js     Express server — /webhook POST + /health GET
    ├── bot.js       State machine (BOT_ACTIVE/WAITING_HUMAN/HUMAN_ACTIVE) + 6.5s debounce + handoff
    ├── llm.js       Anthropic call — system prompt builder (KB + rules + hours), KB-gap detection
    ├── kb.js        Loads knowledge/kb.md (engine ≠ content — no KB text lives in code)
    ├── state.js     In-memory session store per userId (history capped at 10, status, timer)
    ├── discord.js   #leads (new lead) + #crm (handoff + KB gap feedback) Discord webhooks
    └── config.js    All config read from process.env — nothing hard-coded
```

## Cold-start checklist (before writing code)

1. Read `AGENTS.md` (this file)
2. Read `engineering-spec.md` — architecture, data models, build order
3. Read `lhw-bot-requirement-spec.md` — what must be true for the bot to be done
4. Copy `.env.example` → `.env`, fill in credentials (never commit `.env`)
5. `npm install`
6. Start with `GET /health` → add LINE round-trip → then layer features per engineering spec §8

## Hard rules

- **`[Agent Lay]` on every bot response.** No exception — it's the identity marker.
- **KB-only answers.** Bot must not invent services, prices, or proof numbers not in `knowledge/kb.md`.
- **KB is content, not code.** To change what the bot knows, edit `knowledge/kb.md` — never hard-code KB text in `src/`.
- **All config from `.env`.** Phone, email, hours, tokens, webhook URLs — never in source.
- **State before reply.** Check `state.getStatus(userId)` before calling the LLM. If `HUMAN_ACTIVE`, return silently.
- **Debounce always.** Every incoming message resets the 6.5s timer — never process immediately.
- **Pricing:** Starter ฿15,000 · Advanced ฿20,000 · Operation ฿30,000. These are the authoritative floor prices; `knowledge/kb.md` must use these.

## Branch plan

| Branch | Implementer | Purpose |
|---|---|---|
| `main` | — | Shared scaffold + spec; both branches start here |
| `feature/antigravity` | Antigravity | First implementation attempt |
| `feature/claude-code` | Claude Code | Parallel implementation for comparison |

After both are complete: compare against the 9 acceptance criteria in `lhw-bot-requirement-spec.md §11`. Winner merges to `main`.

## Acceptance criteria (summary — full list in req spec §11)

- [ ] Every reply ends with `[Agent Lay]`
- [ ] Answers from KB only — zero hallucination
- [ ] Lead delivered to Discord #leads with all fields
- [ ] Human handoff: WAITING_HUMAN → #crm notify → bot goes silent
- [ ] Out-of-hours: bot stays active in KB scope + informs user
- [ ] Rich Menu 5 buttons work
- [ ] Contact info from config — change without touching code
- [ ] Typing debounce 6–7 s works
- [ ] No Thai typos in bot messages
