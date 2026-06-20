# AGENTS.md — lazyhardwork_chatbot

> Entry point for any coding agent opening this repo. Read this before touching any file.

## What this repo builds

**Agent Lay** — the LINE OA chatbot for LazyHardWork's own channel (client zero).
- Persona: service-minded admin, natural Thai, signs off every reply with `[Agent Lay]`
- Core job: answer leads from KB only, capture contact on buying signal, hand off to Mos via Discord
- No tool-calling. No rule-based menus. LLM answers directly from the injected knowledge base.

## Spec documents (read before implementing)

| What | Where |
|---|---|
| **Requirement spec** (WHAT to build) | `Clients/000_lazyhardwork/spec/lhw-bot-requirement-spec.md` in the vault |
| **Engineering spec** (HOW — architecture, data models, build order) | `Clients/000_lazyhardwork/spec/engineering-spec.md` in the vault |
| **Knowledge base** (Agent Lay's brain — source copy) | `Clients/000_lazyhardwork/resources/lhw-bot-knowledge-base.md` in the vault |
| **KB runtime copy** (what the bot actually loads) | `src/kb.js` in this repo |

> Vault path: `F:/_WORK-KERNEL/PROJECTS/LazyHardWork/` (or wherever the vault lives on your machine)

## Stack

Node.js ≥ 18 · Express · `@line/bot-sdk` v9 · Anthropic SDK · axios (Discord webhooks)

## File map

```
src/
├── index.js     Express server — /webhook POST + /health GET
├── bot.js       State machine (BOT_ACTIVE/WAITING_HUMAN/HUMAN_ACTIVE) + 6.5s debounce + handoff
├── llm.js       Anthropic call — system prompt builder (KB + rules + hours), KB-gap detection
├── kb.js        Knowledge base injected into every LLM call — update here when KB changes
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
- **KB-only answers.** Bot must not invent services, prices, or proof numbers not in `src/kb.js`.
- **All config from `.env`.** Phone, email, hours, tokens, webhook URLs — never in source.
- **State before reply.** Check `state.getStatus(userId)` before calling the LLM. If `HUMAN_ACTIVE`, return silently.
- **Debounce always.** Every incoming message resets the 6.5s timer — never process immediately.
- **Pricing:** Starter ฿15,000 · Advanced ฿20,000 · Operation ฿30,000. These are the authoritative floor prices; `src/kb.js` must use these.

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
