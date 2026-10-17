# AGENTS.md — Lay v2 (lazyhardwork_chatbot)

> Entry point for any coding agent opening this repo. Read this before touching any file.

## What this repo is

**Lay v2** — LazyHardWork's own LINE OA assistant (client zero). One Node/Express process, one inbound surface
(the LINE webhook), one SQLite file. Every turn runs through a single pipeline: deterministic handlers first, then
the model returns one structured JSON response, then code validates, renders (text bubbles, one Flex card, quick
replies, the right `sender`) and sends. Mos answers from a Discord thread and the bot relays him as "มอส".

- **Code lives here**; the **record lives in the vault**:
  `LazyHardWork/Clients/000_lazyhardwork/PJ_lineOA_chatbot_v2/` (folder may still be named `PJ_lineOA_chatcot_v1`)
  → `design-lay-v2.md` (architecture), `decisions.md` (D-xx), `build-log.md`, the brief (`brief-lay-v2-*.md`).
- Status: **v2 in build**. `main` is still v1 and live. Cut-over planned **Tue 2026-10-20**. The Railway `lay-v2`
  service does not exist yet (D-18) — see `doc/deploy.md`.

## Cold-start checklist

1. `AGENTS.md` (this file).
2. `doc/v2-conventions.md` — branches, layout, code rules, tests. The head engineer reviews against it.
3. `doc/line-platform-notes.md` — platform limits; re-read before any change that touches LINE.
4. The module doc for the area you touch (table below), then `doc/feature-map.md` to find the feature → module →
   test you are changing.
5. `cp .env.example .env` (never commit it); `npm install`; `npm test`; `npm run scenarios`.

## Layout

| Folder | Owns | Doc |
|---|---|---|
| `src/app.js`, `src/index.js` | production wiring (deps from config), Express routes, start/stop | `CLAUDE.md` |
| `src/core/` | `turn.js` pipeline, `debounce.js`, `session.js`, `lint.js`, `policy.js`, `deps.js` | `doc/brain.md` (policy), `CLAUDE.md` (flow) |
| `src/line/` | SDK wrapper: reply-or-push with `sender`, quick replies, loading, events, Rich Menu manager | `doc/line-platform-notes.md`, `doc/richmenu.md` |
| `src/brain/` | response schema, prompt builder, structured-output call, KB pack loader, section select | `doc/brain.md` |
| `src/cards/` | tokens, primitives, 7 Flex templates, validate, render + text fallback | `doc/cards.md` |
| `src/flows/` | opening, topics, fit, homework, endings (offer + booking), handoff, demo, examples | `doc/flows.md`, `doc/demo.md` |
| `src/identity/` | sender presets (Lay / มอส / demo shop), quiet window + `เรียก Lay` | `doc/discord.md` (thread lifecycle) |
| `src/discord/` | notifier (threads, webhook fallback), relay bot, `/approve /propose /decline /lay` | `doc/discord.md` |
| `src/leads/` | lead row from session, qualification, export endpoint | `doc/leads.md` |
| `src/store/` | `node:sqlite` db, migrations, repositories | `doc/store.md` |
| `src/admin.js` | JSON admin API (bearer `ADMIN_TOKEN`) | `doc/feature-map.md` (admin) |
| `src/config.js`, `src/agents.config.js` | env → config (secrets, infra) · model choice (committed) | — |
| `knowledge/` | **GENERATED** KB pack (`kb/*.md`, `ladders.json`, `promotions.yaml`, `kb-manifest.json`) | `scripts/kb-build.js` header |
| `public/assets/`, `public/richmenu/` | icons, example images (placeholders), Rich Menu PNGs — served by the app | `doc/demo.md`, `doc/richmenu.md` |
| `scripts/` | `kb-build.js`, `lead-sync.js`, `set-webhook.js`, `setup-rich-menu.js`, `richmenu/build.js`, spikes | each file's header |
| `tests/` | `unit/*.test.js`, `fakes/`, `scenarios/*.yaml` + `run-scenarios.js` | `tests/scenarios/README.md` |
| `doc/` | this doc set; `doc/spec/` holds the v1 specs (history only) | — |

## Hard rules

- **Never push `main`** before the Tuesday cut-over. `v2` merges are the head engineer's, after `npm test` is green.
- **`knowledge/` is generated.** Never hand-edit. Rebuild with
  `npm run kb:build -- --project-dir <vault>/Clients/000_lazyhardwork/<PJ_lineOA folder>` and commit the output.
  Offer, prices, proof lines and the FAQ come from the vault through `kb-build` — **never typed here**. The build
  fails if a card price disagrees with the ledger ladders.
- **The model proposes, the code disposes.** Prices, URLs, actions, state transitions, buttons, the sender and
  booking status are decided in code. A model output is data to validate, never an instruction.
- **Never silent.** The whole turn sits in one try/catch; any failure produces the honest fallback reply plus
  `เรียก Lay`, never nothing.
- **Notify before promise.** "ส่งให้มอสแล้ว" is said only after the notifier resolved.
- **Lint is the law** (`src/core/lint.js` + `src/core/policy.js`): banned content, emoji policy, prose lists,
  markdown. Every outgoing text passes it; tests assert on it. No stock closers, no email, no sign-off tags.
- **Everything external is injected** through `deps` (`line`, `notifier`, `store`, `model`, `clock`, `log`). Only
  `src/line`, `src/brain/respond.js`, `src/discord`, `src/store` may require the SDKs.
- **Secrets only in `.env`** / Railway variables, read only through `src/config.js`. Never in code, logs or tests.
- **No customer personal data in Discord** (display name, LINE userId, phone, email). Lead id is the only key;
  free text is scrubbed before posting (`doc/leads.md` §4, `doc/discord.md`).
- Thai customer-facing strings live in the `strings` object of the flow that uses them. Docs and code in English.
- Conventions, dependencies and commit format: `doc/v2-conventions.md`. Ask before adding a dependency.

## Commands

```bash
npm test                                   # node --test "tests/**/*.test.js" — unit + fakes, no network, < 1 min
npm run scenarios                          # tests/run-scenarios.js over tests/scenarios/*.yaml (scripted model)
node tests/run-scenarios.js --only <substring> [--model real] [--json out.json]
npm run kb:build -- --project-dir <folder> # regenerate knowledge/ from the vault (also --vault, --out, --hours)
node scripts/setup-rich-menu.js [--channel test|prod] [--dry-run] [--recreate] [--yes-prod]
node scripts/richmenu/build.js             # HTML → PNG with headless Chrome/Edge (only after editing the menu)
node scripts/lead-sync.js --vault <root> [--since <iso>] [--dry-run]   # bot leads → vault YAML
node scripts/set-webhook.js https://<host>/webhook | --show            # channel in LINE_CHANNEL_ACCESS_TOKEN
npm start · npm run dev                    # run locally; expose with ngrok for the test OA (D-18)
```

There is no `scenarios:report` script in `package.json`; the QA report is built from `--json` output.

## Branch plan (D-02, D-13)

| Branch | Role |
|---|---|
| `main` | v1, **live on Railway** until the Tuesday cut-over. Receives `v2` only after Mos's go. |
| `v2` | integration branch; the Railway `lay-v2` service will deploy it (not created yet). |
| `v2-<module>` | one feature branch per module, each in its own worktree under `.worktrees/<module>` (ignored); one implementer per module. Git refuses `v2/<x>` while `v2` exists. |

Merge order so far: store, brain, kb → cards, turn → flows, discord → demo, leads, richmenu. Open worktrees belong
to other implementers — do not edit them from the main checkout.

## Acceptance and the gate

- Acceptance criteria are **brief §9** in the vault (`brief-lay-v2-2026-10-17.md` + addendum); design §12 maps
  them to tests. Each scenario file names what it covers in `covers:`.
- **The scenario suite is the merge gate** for anything that touches replies: a PR that changes behaviour adds or
  changes a scenario (`tests/scenarios/NN-<slug>.yaml`). Fault injection (`fault:` steps) is first-class.
- `node tests/run-scenarios.js --model real` replays the same customer lines against OpenAI for QA (needs
  `OPENAI_API_KEY` with credit).
