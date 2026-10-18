# Practice audit — Lay v2 against the Tech Knowledge Resources (2026-10-18)

Question from Mos: does this build actually apply the ideas in `CodeArea/Tech Knowledge Resources/` (the TypeSafe/Jev
analysis PDF and Lauren Tan's SpaceXAI-workflow talk), or only cite them? Method: both sources read in full; repo `v2`
at `33ccedf` read (AGENTS, conventions, feature map, testing, turn/policy/lint, schema/respond, runner, CI, git log);
`npm run scenarios` re-run today: 27/27. Line numbers are from that commit. Read-only audit; nothing else changed.

## 1. The ideas

### 1a. "Engineering Machine-Native Decisions with TypeSafe Jev" (PDF, 16 pp)

| # | Idea | One-line meaning | Page |
|---|---|---|---|
| P1 | Split decisions from generation | "System 1" typed decisions (route, score, assert) are a separate primitive from "System 2" prose generation; reserve the generative model for synthesis | 1–2, 10 |
| P2 | Typed contract in and out | Program state + predefined schema in, typed values out; schema errors "eliminated by construction" | 1, 6 |
| P3 | Syntax is not semantics | Constrained decoding guarantees parseable JSON, "not semantic correctness"; a valid enum can still be the wrong enum | 6 |
| P4 | Calibrated confidence drives thresholds | Auto-execute when confident, route to a deliberative model when ambiguous, flag for a human below a floor | 3 |
| P5 | Explicit fallback option | Every Choice needs an "other" key or probability mass is forced into wrong options | 4 |
| P6 | Tool guardrail firewall | Before executing an action: is it destructive (assert) + blast radius (score); block or run without a human | 10–12 |
| P7 | Output judge + self-refinement | Rubric scores + policy checks on the drafted reply; on failure feed the failed criteria back for one targeted retry | 9, 11 |
| P8 | Speculative fan-out | Ask all invariants about one state at once; host code branches on the vector | 11 |
| P9 | Context rot | Noisy or long state flattens the distribution; clean and trim state before asking | 14 |
| P10 | Arithmetic and time in code | The model cannot count, total or compare dates; compute them deterministically first | 14 |
| P11 | Audit trace | Decisions without rationale need an asynchronous explanation/audit record | 14 |
| P12 | Cost and latency per call are the metrics; distrust vendor benchmarks | 12–13 |

### 1b. Lauren Tan — "SpaceXAI workflow" (talk transcript)

| # | Idea | One-line meaning | Time |
|---|---|---|---|
| T1 | Trust curve | In-the-loop → verification → cloud agents → auto-merge; "no shortcut" between stages | 3:06–5:46, 30:39 |
| T2 | Verification skill | The agent runs the product the way users do and closes the loop itself; otherwise "you are the verifier … the bottleneck" | 7:46–8:37, 10:42–11:13 |
| T3 | Feature map | A file that tells the agent how to reach every feature (paths, shortcuts, selectors) | 12:13–15:29 |
| T4 | Skills from observed failures | Read the tool calls, turn each failure mode into a skill; maintain them | 16:57–19:09, 22:29–23:30 |
| T5 | Evals you can hill-climb | Evals are unit tests for skills; produce a score, cross-check with a judge of another model, loop until 10/10 | 20:00–24:33 |
| T6 | Head chef / kitchen | The engineer designs the environment and hands narrow tasks to sub-agents | 25:05–25:42 |
| T7 | Local first, then cloud | Observe locally; cloud agents (Benny) then reproduce bug reports unattended | 26:24–29:04 |
| T8 | Small atomic PRs | Each PR describes one thing; git history is context; easy revert | 39:54–40:41 |
| T9 | Hard enforcement beats prose | Layers: architecture conventions > CI/lint/import-graph (red) > rules/skills/bugbot (soft). "Every review comment → a lint rule" | 41:07–45:03, 47:33–50:25 |
| T10 | Strict greenfield, shortest path = best path | Vibe-coded greenfield is the biggest risk; make the easy way the right way; co-locate a feature | 34:48–37:12, 45:48–47:08 |
| T11 | Token ROI | Spend tokens up front on constraints so "the dumbest agent" writes good code | 51:29–55:40 |

## 2. Scorecard (applied / partly / not — in THIS repo)

| Idea | Status | Evidence | What is missing |
|---|---|---|---|
| P1 split | partly | Deterministic handlers run before the model: opening, media, เรียก Lay, mode gates, booking entry, ask-human, special price, loose ends, postbacks (`src/core/turn.js` steps 2–8, lines 60–182) | Intent, topics and the action proposal still come from the same generative call (`schema.js:7–13`); the "System 1" is regex (`handoff.isSpecialPrice` — the เหมาะ false positive in build-log 19:10 is the cost of that). No cheap classifier, no confidence |
| P2 contract | applied | Strict `json_schema` (`respond.js:92`); parse → `validateResponse` → one repair → throw (`respond.js:112–133`); validated again in the turn (`turn.js:274`) and after policy (`policy.js:147`) | Card `data` is `additionalProperties: true` (`schema.js:39`) and `kb_refs` are free strings — both enforced late (render fallback `turn.js:313–320`, ref filter `policy.js:110–120`). Envelope end to end: yes; card payload: at render only |
| P3 semantics judge + P7 refinement | applied | `policy.js` rules price_without_ref (124–128), benefits_without_caveat (131–135), problem_verbatim (138–144), unknown_kb_ref; regenerate once naming the rule (`turn.js:284–288`) = the PDF's self-refine loop | All checks binary regex; no rubric, no score, no judge of another model. Voice quality is unmeasured until Mos reads transcripts |
| P4 confidence | not | No confidence field anywhere in the contract | Human-review route (`handoff_unknown` offers a button, `turn.js:202–208`) is model-declared, not threshold-driven |
| P5 fallback option | applied | `unknown`, `out_of_scope`, `offtopic`, `action: null` (`schema.js:7–13`) | — |
| P6 tool firewall | applied (by state, not by score) | "Model proposes, code disposes": `booking_confirm` never executes from the model, handoffs only via `doHandoff`, prices only from `ladders.json` (`turn.js:197–215, 379–386`) | — |
| P8 fan-out | n/a | One call per turn; fine at this scale | — |
| P9 context hygiene | partly | History capped at 12 (`turn.js:263`), KB sections selected per intent (`turn.js:264`), input sanitised (`turn.js:26–31`) | Prompt size per call is unknown because usage is never logged (see P12) |
| P10 numbers/time in code | applied | `cardContext.priceFor`, `kb-build` fails on ledger mismatch (AGENTS.md:55), injected clock, quiet-window math in code | — |
| P11 audit trace | partly | `events` rows: policy_violation, model_fallback, undelivered, error (`turn.js:231, 293, 301, 340`); `GET /admin/events` | No per-turn record joining message ↔ model ↔ attempts ↔ violations ↔ cost |
| P12 cost/latency | **not** (built, then dropped) | `respond.js:136–139` computes usage, cached tokens, latency, attempts into a non-enumerable `_meta`; `turn.js` never reads it and `policy.clone()` (JSON round-trip, `policy.js:57,73`) strips it. `agents.config.js:22–23` refers to `scripts/model-probe.js`, which does not exist | Zero per-call cost/latency visibility going into go-live; the Sunday model test has no instrument |
| T1 trust curve | partly | Honest stage: local, human-verified, no auto-merge | The build jumped to 10 parallel implementers on day one (fine for disjoint modules) but the verification loop that justifies it (T2) stops at the fakes |
| T2 verification skill | partly | Strong at the fake layer: `run-scenarios.js` drives the real `runTurn` with fake LINE/Discord/model/clock/store, never-silent check (line 196), `fault:` steps, 27 scenarios | Nothing reaches the real surface without Mos: no script that posts a signed webhook to a running app and reads back `/admin/sessions/:userId`; only spikes (`scripts/spike-identity-test.js`) and the phone. `--model real` is blocked by the 429 since 17 Oct (`doc/testing.md:111`) |
| T3 feature map | applied | `doc/feature-map.md`: feature → phone path → module → proof, with honest "no test yet" rows | Already drifting (line 47 says injection has no test; `30-*/31-*` exist); no selectors for an automated driver because none exists; nothing checks the map against the code |
| T4 skills from failures | partly | v1's silent-handoff bug (906c7f2) became two invariants (never-silent, notify-before-promise); QA's 3 bugs became scenario fixes (33ccedf) | Rules live in AGENTS.md/conventions prose; no skill files; no "every review comment → a rule" habit yet |
| T5 hill-climbable evals | **not** | Pass/fail only (`run-scenarios.js:220–223`); report is a PASS/FAIL table; the only score is Mos's manual 1–10 on Monday (`doc/testing.md:116–124`) | No automatic score (violations, regenerates, fallbacks, latency, tokens, voice rubric); no second-model judge; the committed `_report/latest.md` is stale (23/26 vs 27/27 today) |
| T6 kitchen | applied | design §14 roles, one worktree per module (`git worktree list`: 12), narrow written briefs, head engineer merges (AGENTS.md:51) | No independent reviewer: 11 `merge: v2-*` commits between 16:55 and 17:46 by the same session; most merges were gated by unit tests only because the scenario suite (T13) landed last |
| T7 local → cloud / CI | partly | `.github/workflows/test.yml` runs tests + scenarios | CI has never executed: `v2` was never pushed (`git branch -r` has no `origin/v2`); no cloud agents (correct for this stage) |
| T8 small PRs | **not** | No PRs; one commit per module of 900–2,950 added lines (`4c065d4 +2,948`, `276483b +2,263`, `26bef06 +1,422`) | Revert granularity is a whole module; the merge message is the only review artefact |
| T9 hard enforcement | partly | Layer 1 (architecture) strong: folder per responsibility, `deps` injection, `strings` objects, generated `knowledge/` | Layer 2 (CI red) weak: no eslint (though `eslint-disable` comments exist, `respond.js:35`), no import-boundary test for the "only src/line, respond.js, src/discord, src/store may require SDKs" rule (AGENTS.md:63 — `src/app.js` already does, unstated), no code lint for hard-coded prices/phones/`process.env` outside `config.js`, no check that `knowledge/` matches its manifest. Most rules sit in layer 3 (prose) — the layer the talk calls soft |
| T10 shortest path | applied | New topic = pattern + strings + scenario; new card = template + validator; `MENU_TO_TEXT` map | — |
| T11 token ROI | n/a | Cannot be judged without P12 | — |

## 3. The five highest-leverage gaps

1. **Per-turn model telemetry** — before Tuesday, 2–3 h. In `askModel` (`src/core/turn.js:271–297`) capture `raw._meta`
   before `applyPolicy` clones it; log one `model.call` line {model, prompt_tokens, cached_tokens, completion_tokens,
   latency_ms, attempts, repaired, violations, outcome: sent|regenerated|fallback} and append a `model_call` event;
   sum tokens/cost into `GET /health` or `/admin/events`. Why now: going live on a mini model with a freshly topped-up
   key and no cost/latency number is not retrofittable, and the Sunday model test (`agents.config.js:5–7`) needs it.
2. **Make the conventions CI-red** — before Tuesday, 2 h. `tests/unit/conventions.test.js`: walk `src/`, assert SDK
   `require`s only in the allowed files (+ `src/app.js` as composition root, and say so in AGENTS.md), `process.env`
   only in `src/config.js`, no `\d{1,3},\d{3}\s*บาท` or phone literal outside `knowledge/`/`config.js`/`strings`, every
   `tests/scenarios/*.yaml` named in `doc/feature-map.md` or `covers:` — and the feature-map rows that name a test point
   at a file that exists. Runs under `npm test`, so `test.yml` picks it up. Why: it converts AGENTS.md prose into T9's
   hard layer for every agent that touches `src/` after launch, at near-zero cost.
3. **Scored evals and a judge for `--model real`** — Sunday/Monday, 4–6 h. `run-scenarios.js` emits per scenario
   {violations, regenerates, fallbacks, p50 latency, tokens} (needs gap 1) and per step the policy report;
   `scripts/scenario-report.js` prints a scoreboard; new `scripts/model-probe.js` runs the `candidates` list and
   writes the `results` block `agents.config.js:23` promises. Optional: a second-model voice rubric (short, ครับ, no stock
   closer, reuses the customer's words) only in real mode. Why: Monday becomes a number you can hill-climb per prompt
   change instead of a one-off 8/10, and the model choice stops being a guess.
4. **A verification script that reaches the real surface** — before Tuesday, 2–3 h. `scripts/smoke-webhook.js`:
   build a LINE text/postback event, sign it with the channel secret (`x-line-signature`), POST to `/webhook` (local or
   Railway), wait past the debounce, read `/admin/sessions/:userId`, assert the last bot messages (sender, template,
   text, quick replies); `--live` pushes the same to Mos's userId. Add a "reach it by script" column to the feature map.
   Why: this is T2 — the agent closes the loop on Tuesday's cut-over and every fix after without Mos as the verifier.
5. **Branch discipline for the post-launch phase** — after Tuesday, 1 h to set up. Push `v2` so CI actually runs once
   before it is the release gate; feature branches become PRs into `v2` with diffs ≤ ~300 lines and the scenario diff in
   the description; refresh `_report/latest.md` in the same commit (stale today); `turn.js`/`policy.js` changes get a
   second pair of eyes (`/code-review` or another session). Why: with real customers on the OA, T8 revertability per
   change is worth more than the speed that got v2 built in a day.

Cheap fixes on the way: feature-map line 47 (injection now has `30-*/31-*`), `agents.config.js` comment naming a script
that does not exist, `doc/testing.md:14` advertising `scenarios:report` which AGENTS.md:85 says is absent.

## 4. What the project does that the sources do not cover

Neither source is about a customer-facing Thai bot where a silent or wrong reply costs a lead. The repo's own invariants
sit above anything in the PDF or the talk and are the strongest part of the build: **never silent** (one try/catch
around the whole turn, reply → push → push, an `undelivered` event, and the runner failing any step that sends nothing,
`run-scenarios.js:196`); **notify before promise** ("ส่งให้มอสแล้ว" only after the notifier resolved, with a forced-failure
scenario); the **Thai voice lint** (`src/core/lint.js`: banned content specific to the LhW offer, the emoji policy, the
prose-list detector, stock closers, "ยืนยันแล้ว" only after Mos approves) applied to the prompt's own examples
(`brain.examples.test.js`); identity on every message; customer PII scrubbed before Discord; the knowledge pack
generated from the vault with prices cross-checked against the ledger; and the quiet window. The PDF describes a product
(Jev) this build does not and could not use for Thai today, and the talk describes a 1,000-PR-a-month Electron team
with unlimited tokens; the audit scores the ideas, not the tools.

**Verdict.** The architecture ideas are genuinely applied — typed contract, code owns state and prices, a policy judge
with one targeted retry, verification-first with fakes, a kitchen of narrow sub-agents — and they produced a working
system in a day. The build is weakest exactly where both sources say trust is earned: nothing is CI-red beyond tests,
evals are pass/fail, per-call cost/latency was built and then thrown away, and no verification reaches the phone
without Mos. Gaps 1, 2 and 4 fit before Tuesday; 3 and 5 pay off from Monday onward.
