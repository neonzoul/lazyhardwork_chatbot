# Testing Lay v2 — scenarios, faults, and Monday's run

Two layers. `npm test` is the unit suite (`tests/unit/*.test.js`, node:test, no network). `npm run scenarios` is the
**scenario suite**: YAML conversations driven through the real `src/core/turn.runTurn` with fakes for LINE, Discord,
the model, the clock and the store. The scenario suite is the merge gate for anything that touches replies, and its
transcripts are what Mos rates on Monday (brief §9.1).

## Run

```
npm run scenarios                                   # all of tests/scenarios/*.yaml, scripted model
node tests/run-scenarios.js --only booking          # substring of the name or file
node tests/run-scenarios.js --json out.json         # machine-readable results (+ transcript + store dump)
npm run scenarios:report                            # → tests/scenarios/_report/latest.{json,md}
node tests/run-scenarios.js --model real            # same customer lines against OpenAI (see below)
```

Exit code is non-zero when any scenario fails. Output lists `PASS/FAIL  <name>  (<file>)` and, per failing step,
every assertion that missed. Note that `scenarios:report` chains with `&&`: when the gate fails, `latest.json`
is still written but the Markdown is not — run `node scripts/scenario-report.js` by hand to see the failing
transcripts. `tests/scenarios/_report/latest.md` is committed (the readable transcript); `latest.json` is not.

## Anatomy of a scenario

```yaml
name: 05 · ลูกค้าจะเงียบ — ขอบคุณครับ หลัง 2 เรื่อง → เช็คเรื่องค้างครั้งเดียว
covers: ["§9.1", "H3.4"]            # brief §9 numbers / conversation-flow §9 suite-H ids (required)
user: { id: U05, displayName: "คุณเจ" }
session: { homework: { business: "ร้านอาหาร" } }   # optional initial session fields (booking shortcuts, modes)
pending_transcript: true            # only 70-*: marks a placeholder for the first-tester replay
steps:
  - user: "ราคาเท่าไหร่"            # one customer text (one burst)
    model: { ... }                  # the scripted model response for THIS step (see below)
    expect: { ... }
```

### Step kinds (exactly one per step)

| step | meaning |
|---|---|
| `user: "…"` | customer text; the runner sets a fresh reply token and the fake clock's time |
| `postback: FIT_chat_overload` | a button/Rich Menu postback (`FIT_*`, `BOOK_*`, `MENU_*`, `CALL_LAY`, `FORWARD_TO_MOS`) |
| `media: image` | image / file / sticker event |
| `follow: true` | the add-friend event (opening) |
| `mos: { threadId: T1, text: "…" }` | a line Mos typed in the Discord thread: pushed to the customer as "มอส", mode → `mos_active` |
| `decision: { decision: approve\|propose\|decline, windows: [..] }` | Mos's booking command (`/approve`, `/propose`, `/decline`) via `flows/endings.applyMosDecision` |
| `fault: { model: throw\|garbage }` | the next model call throws / returns unparseable output |
| `fault: { notifier: handoff\|booking\|kbGap\|lead }` | the named notifier call throws (reset after the next step) |
| `fault: { line: reply\|push\|[reply, push, push] }` | each named fake-LINE call throws once, in order |
| `clock: { advance_minutes: 31 }` | move the fake clock (quiet window, mos_active timeout) |
| `allow: [booking_confirmed]` | lint ids later steps may legitimately contain (only after Mos approves) |

### Scripted model blocks

With `--model scripted` (default) every step that reaches the model **must** carry a `model:` block, otherwise the
fake throws "no scripted response left" and the turn falls back (you will see the fallback text in the transcript
and usually a failed assertion). A block is a partial response merged over `brain/schema.emptyResponse`; a bare
string is shorthand for one text bubble. Write it as the model should answer — the policy (`src/core/policy.js`)
runs on it exactly as in production, so:

- a **price** (`4,900 บาท`) needs a grounding ref: `kb_refs` containing `offer.*` or `faq.*price*`, else the turn
  regenerates — and with no second scripted response, falls back;
- `topics: [benefits]` needs the caveat frame `ตรวจสอบกับ สสว./depa/กรมสรรพากร/หน่วยงาน` in the text;
- `lead_updates.problem_verbatim` must be a substring of the customer's text (else it is nulled);
- `kb_refs` must be real section ids (`## offer.A2.T1` headings in `knowledge/kb/*.md`); unknown ids are dropped;
- no markdown, no emoji in plain bubbles, no prose lists (`1.`/`-` lines), ≤ 4 quick replies of ≤ 20 chars;
- intents `banter`/`abuse`/`closing` with `quick_replies: []` produce **no** buttons (no CTA after a joke);
- `action:` is a proposal: `handoff_*` and `booking_start` are executed by code; `booking_confirm` is ignored.

Deterministic turns (opening, `FIT_*` state, `BOOK_*` state machine, ask-human, special price, loose-ends, quiet
window, เรียก Lay) need **no** model block — adding one leaves it in the queue for the next model turn.

Voice: scripted words are Mos's voice samples. Short, ครับ, no emoji, no lists, reuse the customer's words, one
question at a time, never a stock closer. The report renders them for Mos's rating, so write them as he would.

### `expect` vocabulary

| key | asserts |
|---|---|
| `replies` / `replies_min` | number of outgoing messages this step (text + cards) |
| `text_contains` / `text_not_contains` | substrings over all text bubbles joined |
| `quick_replies` | exact labels on the last message; `quick_replies_includes`, `quick_replies_max` |
| `card: offer\|choice\|summary_confirm\|…` or `null` | the Flex template sent (or none) |
| `sender: lay\|mos\|demo\|null` | sender name on **every** message of the step |
| `banned_clean: true` | `lint.findBanned` empty on every text (respects `allow`) |
| `emoji_max: 0` | emoji count over all texts |
| `no_prose_list: true` | `lint.hasProseList` false on every text |
| `action: handoff_human\|handoff_scope\|handoff_unknown\|booking_confirm\|null` | `runTurn` result action |
| `notified` / `not_notified: [handoff, booking, kbGap, lead, relayToMos]` | notifier calls made this scenario so far (a throwing call still counts) |
| `silent: true` | the step may send nothing (quiet / mos_active); otherwise an empty step is `SILENT` |
| `session: { mode, topics_covered_includes, questions_asked_max, draft_has, homework_has }` | session after the step |

Every key is checked by `tests/unit/scenarios.test.js`; a typo fails `npm test`.

## Writing a new scenario

1. Name it `NN-<slug>.yaml` (00–19 conversation paths, 30s injection, 40s faults, 50s quiet window, 60s identity,
   70s tester replays). Keep it under ~80 lines; split rather than grow.
2. Start from a real customer line (Fastwork history, sales case log, the tester transcript). Invent neutral names;
   never copy phone numbers or names.
3. Put the §9 / H ids it proves in `covers:`.
4. Assert the property, not the prose: the fixed strings of `src/flows` are fair game (`"ส่งให้มอสแล้วครับ"`), the
   scripted words are yours, so assert what must/must not appear (`ยืนยันแล้ว`, `095`, `[Agent Lay]`).
5. Run `npm test` (structure) then `npm run scenarios --only <slug>`.
6. If the scenario exposes a `src/` bug, do not bend the scenario: leave it failing and write up the step,
   observed vs expected and the suspected module.

## `--model real`

Same YAML, same assertions; `model:` blocks are ignored and `src/brain/respond.createModel()` calls OpenAI with the
production prompt (needs `OPENAI_API_KEY` with credit — the key had none on 17 Oct, 429). Expect two kinds of
difference: wording (so assert substrings the policy or the KB guarantees, not scripted phrases) and the
regenerate path (a real model may trip the policy once and be asked again). Deterministic steps behave identically.
Use it for the voice test, not as the merge gate.

## Monday's run (test 8/10)

1. Credit on the OpenAI key; `npm test` and `npm run scenarios` green on `v2`.
2. Drop the first-tester transcript into the vault; replace the steps of `70-first-tester-replay.yaml` with every
   customer line, in order; remove `pending_transcript`.
3. `npm run scenarios:report` → `tests/scenarios/_report/latest.md` (scripted voice). Then
   `node tests/run-scenarios.js --model real --json tests/scenarios/_report/real.json && node scripts/scenario-report.js --in tests/scenarios/_report/real.json --out tests/scenarios/_report/real.md`.
4. The Thai HTML test report is built from those two Markdown files (one transcript per scenario, Mos scores each
   1–10; ≥ 8/10 on the ten Mos scenarios = §9.1).
5. Demo mode (§9.7) and lead-sync (§9.9) are checked on the phone / against the test DB, not here.

## Real-surface smoke

`scripts/smoke-webhook.js` proves a **deployed** Lay (tunnel or Railway) works end to end without anyone tapping on a
phone — practice-audit gap 4. It signs LINE webhook events itself (`x-line-signature` = base64 HMAC-SHA256 of the raw
body with the channel secret, exactly as `@line/bot-sdk` verifies them), POSTs the sequence
`follow → "สวัสดีครับ" → FIT_chat_overload → "ราคาเท่าไหร่" → MENU_EXAMPLES → "เรียก Lay"` to `<base>/webhook`, waits for the text
debounce (7.5 s after a text, 1 s after a postback), and reads the persisted result back through the admin API
(`GET /admin/sessions/:userId`, `GET /admin/events`). What it proves: signature verification is on (a wrong signature is
refused, a signed empty body gets 200), events reach the pipeline, the debounce fires, the session mutates
(`opened`, `draft.symptom`, `last_customer_at`, `mode`), the deterministic turns send the right thing (opening text with
"3 เรื่อง", `examples` carousel, "Lay กลับมาดูแลต่อ"), the FIT turn produces a `choice`/`offer` card, and no `error` event was
recorded for that user. The output is a PASS / WARN / FAIL table with what was observed (text snippet, Flex template,
sender name), total time, and exit code 1 on any FAIL.

```
node scripts/smoke-webhook.js --base https://<tunnel-host> --secret "$LINE_CHANNEL_SECRET" --token "$ADMIN_TOKEN"
node scripts/smoke-webhook.js --base https://<app>.up.railway.app --secret … --token …      # same against Railway
node scripts/smoke-webhook.js … --user Usmoke-$(date +%s)                                  # pick the synthetic id yourself
node scripts/smoke-webhook.js … --real-push --user U<your real LINE user id>                # messages really arrive on that phone
```

`--base`, `--secret`, `--token` fall back to `SMOKE_BASE`, `LINE_CHANNEL_SECRET`, `ADMIN_TOKEN` in the environment. The
secret is the channel secret of the OA the deployment serves (test OA on the tunnel, prod OA on Railway) — a mismatch
shows as `webhook FAIL HTTP 500` on every step and nothing reaches the pipeline.

**Synthetic-id caveat.** The default user id is `Usmoke-<timestamp>`, which is not a real LINE user, so every push to it
is rejected by LINE (400). `core/turn.send` then records an `undelivered` event (payload lists the message types that
were composed) and the turn's catch records an `error` event with `line undelivered`; the transcript row is never
written because `persist` runs after a successful send. The script treats this as the expected outcome of the synthetic
id: those `undelivered` events are the evidence that a message of the right kind (`text` / `flex`) was composed and
handed to LINE, and the two event kinds are filtered out of the error check. What it cannot verify without delivery is
the content — the exact text or the Flex template name — so the observed column says so
(`composed [text,flex] → LINE rejected synthetic id (expected); template examples not verifiable without delivery`).
Session-state checks (`opened`, `draft.symptom`, `last_customer_at`, `mode`) are unaffected because the session is saved
on the error path too.

**`--real-push --user U<real id>`** turns the filter off: `undelivered` and every `error` event count as FAIL, the
transcript rows are read, and the text / template assertions are verified for real. The six messages arrive on that
phone, so use your own id (`MOS_LINE_USER_ID`) and expect the opening, the FIT answer with the offer card, the pricing
answer, the examples carousel and "Lay กลับมาดูแลต่อ".

**Model unavailable.** The greeting, FIT and pricing turns need the model. When the key is missing or exhausted the turn
answers with the honest fallback ("ขัดข้อง") and records a `model_fallback` event; the script reports those steps as
`WARN (model unavailable)` and the missing FIT card as WARN, never FAIL — the never-silent rule is what is asserted. A
step that sent nothing at all is FAIL. Two more server-side hints the table gives: the examples carousel falls back to
text when `PUBLIC_BASE_URL` is not an https URL, and the offer card falls back to text when `FASTWORK_URL` is unset
(the renderer never invents a URL, D-19) — both are reported as FAIL with the variable named.

`tests/unit/smoke-webhook.test.js` runs the same script against `createApp` with the fakes on an ephemeral port
(`DEBOUNCE_MS=20`), so the signing, the sequence and every assertion are exercised by `npm test`; the test also covers
the wrong-secret path, the model-unavailable path and the synthetic-vs-real-push filter. The script never pushes to a
real user unless you pass `--real-push`.
