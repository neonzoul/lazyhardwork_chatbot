# CLAUDE.md

Guidance for Claude Code in this repository. **`AGENTS.md` is the entry point** (what the repo is, cold-start order,
layout, hard rules, commands, branch plan). This file adds the request flow, the injection rule, how to run one
scenario, and gotchas. Conventions: `doc/v2-conventions.md`. Platform limits: `doc/line-platform-notes.md`.

## Request flow (one turn)

```
POST /webhook  (src/app.js: line.middleware verifies the signature, 200 at once)
  → createEventHandler (src/core/turn.js): normalise (src/line/events.js) · drop group/room · dedupe webhookEventId
  → text: showLoading + debounce 6.5 s per user (src/core/debounce.js) · postback/follow/media: run now
  → runTurn(input, deps) — one try/catch, never silent:
      1 quiet-window expiry   2 unfollow / mos_relay / mos_release / follow→opening / media reply
      3 sanitise + persist    4 เรียก Lay from any mode (demo → exit line)
      5 mode gates: mos_active silent (mirror to thread) · quiet one ack · demo → flows/demo.runDemoTurn
      6a booking entry / typed booking answers   6 human / unknown-forward / discount → flows/handoff
      7 loose ends on a closing signal           8 FIT_* BOOK_* DEMO_* MENU_* postbacks set state + intent
      9 model (brain/prompt → brain/respond, structured JSON; policy fix/regenerate/fallback)
     10 state from the response (topics, lead_updates, offer decorate)   11 actions: handoff_*, booking_*, demo_*
     12 render (cards/render + line/messages) + quick replies → send (reply token < 20 s else push, with sender)
```

Then `persist` (messages, session) and `upsertLead` when lead fields changed. Details per area: `doc/*.md`.

## Dependency injection — the rule

Every external thing reaches a module through `deps` (`src/core/deps.js`): `line`, `notifier`, `store`, `model`,
`clock`, `log`, plus `pack`, `config`, `senders`, optional `flows`/`cards` overrides. Only `src/line`,
`src/brain/respond.js`, `src/discord`, `src/store` may `require` an SDK. `src/app.js` builds the real deps;
`tests/fakes/*` build the fake ones (the fake store is the contract for the real one). Flow modules are required
lazily inside `turn.js`, so a missing module degrades, never crashes. Config from `process.env` only via `src/config.js`.

## Run one scenario

```bash
node tests/run-scenarios.js --only booking          # substring of the file name or `name:`
node tests/run-scenarios.js --only demo --json out.json
node tests/run-scenarios.js --only smoke --model real   # OpenAI; needs OPENAI_API_KEY with credit
node --test tests/unit/turn.test.js                 # one unit file
```

Step and `expect` vocabulary is in the header of `tests/run-scenarios.js`. The runner loads the real `knowledge/`
pack when present, so an offer card with a price needs a built pack.

## Gotchas

- `node:sqlite` prints an `ExperimentalWarning` on Node 22/24 — harmless; `--no-warnings` if it clutters logs.
- `node --test` glob: keep the quotes — `node --test "tests/**/*.test.js"` (PowerShell expands unquoted globs
  wrongly; `npm test` already quotes it).
- LINE labels: quick-reply / action labels ≤ 20 code points, `chatBarText` ≤ 14, `sender.name` ≤ 20 (demo shop short
  names ≤ 7 so ` · ผู้ช่วย AI` fits). Policy drops over-long labels rather than truncating.
- Reply token: single use, valid ~1 min; the pipeline uses it only within 20 s of the event, then pushes.
- Rich Menu images are rendered from HTML with headless Chrome/Edge (`scripts/richmenu/build.js`); the build fails if
  the fonts did not load. A menu image cannot be replaced — `setup-rich-menu.js --recreate`.
- Channels: `LINE_CHANNEL_*` = the **test** channel for local work and staging; `LINE_PROD_*` = production, used
  only by `setup-rich-menu.js --channel prod --yes-prod` until cut-over. Never run the default against the live OA.
- `knowledge/` is generated — `npm run kb:build -- --project-dir …`; `tests/unit/kb.test.js` checks the hashes.
- Prices and Fastwork URLs reach cards only through `cardContext` (`pack.ladders`, `pack.fastworkUrls`); anything
  the model puts in `data.price_from` is ignored.
- Thai strings: in the `strings` object of the flow; every string must pass `core/lint.lintText` (unit tests check).
- Commits: small, say what and why, end with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push `main` before cut-over.
