# Flows — fit · homework · endings (`src/flows/`)

The code owns every state transition; the model only supplies words and `lead_updates`. Sources: brief §3.4–§3.6,
design §4 (rows "Fit by symptom", "Homework", "Two endings"), conversation-flow §4 and §6.
Tests: `node --test tests/unit/flows-*.test.js` · scenarios `10-short-path-offer.yaml`, `11-booking-pending.yaml`.

```
src/flows/fit.js        five symptoms → card; FIT_<key> postback hook; choice card data
src/flows/homework.js   seven fields; the one next gap; ≤ 4 questions; button ↔ field; Discord summary
src/flows/endings.js    chooseEnding · offer card (short) · booking state machine (long) · Mos's decision
```

## 1. Fit by symptom (`fit.js`)

| key | button label (brief §3.4, verbatim) | card | fit-map section |
|---|---|---|---|
| `chat_overload` | ตอบแชทลูกค้าไม่ทัน | A2 | `fit.chat-overload` |
| `scattered_data` | ข้อมูลกระจาย ต้องตามงานเอง | A1 | `fit.data-scattered` |
| `repetitive_work` | งานซ้ำ คีย์ซ้ำทุกวัน | A3 | `fit.repetitive-work` |
| `ai_know_my_work` | อยากให้ AI รู้จักงานผม | A4 | `fit.ai-knows-my-work` |
| `dont_know_where_to_start` | ยังไม่รู้จะเริ่มตรงไหน | C1 | `fit.where-to-start` |

- `fitChoiceCard()` → `{template:'choice', alt, data:{title, subtitle, options:[{label, postback:'FIT_<key>'}]}}`.
  One label is > 20 chars, so the renderer uses tappable option boxes for all five (see `doc/cards.md`).
- `onSymptomPostback(data, session)` → sets `draft.symptom`, `draft.card`, `draft.tier = 'T1'`, `draft.fit_ref`,
  adds `fit` to `session.intent_hints`, returns `{ intentHint:'fit', userText:'เลือกอาการ: <label>' }`.
  `core/turn` step 8 feeds that to the model; `brain/select` picks `fit-map` + the card's `offer.*` sections.
- `symptomFromText(text)` — loose Thai matching for a typed symptom (labels first, then patterns). Not wired yet
  (see hooks) — meant for a typed answer to the fit question instead of a tap.
- `alreadyChosen(session)` — `!!draft.symptom`; the prompt/turn must never show the choice card again when true.

## 2. Homework (`homework.js`)

Seven fields, asked in this order, one gap per turn (the two optional ones, `budget_frame` and `came_from`, are
stored when volunteered but never asked):

| field | question (Thai) | answer |
|---|---|---|
| `problem_verbatim` | เล่าสั้นๆ ได้ไหมครับว่าตอนนี้อยากให้ช่วยเรื่องไหนมากที่สุด… | free text |
| `business` | ธุรกิจของคุณทำอะไรครับ… | free text |
| `where_work_lives` | ตอนนี้งานหรือข้อมูลส่วนใหญ่อยู่ที่ไหนครับ | LINE · Google Sheets·Excel · POS·ระบบอื่น · กระดาษ·หัวคน |
| `team_size` | ทีมที่ทำงานส่วนนี้มีกี่คนครับ | 1 คน · 2–5 · 6–15 · มากกว่า 15 |
| `maintainer` | ถ้ามีระบบแล้ว ใครจะเป็นคนดูแลต่อครับ | ผมเอง · มีคนในทีม · ยังไม่แน่ใจ |
| `preferred_contact` | สะดวกคุยกับมอสแบบไหนครับ | โทร · นัดประชุม · แชทต่อ |
| `urgency` | อยากเริ่มช่วงไหนครับ | เริ่มเร็วที่สุด · ภายใน 1 เดือน · แค่ดูข้อมูลก่อน |

- `nextQuestion(session, {fields?})` → `{field, text, options?:[{label,value}]}` or `null` (nothing missing, or
  `questions_asked ≥ 4`). `readyForEnding(session)` = `questions_asked ≥ 4` **or** `business + problem_verbatim +
  preferred_contact` filled. `answerFromButton(label)` → `{field, value}` (labels are unique across fields).
  `applyAnswer`, `countQuestion`, `missing`, `homeworkSummary(session)` (Thai lines for the Discord thread; phone
  numbers and emails inside free text are replaced; the still-missing fields are listed as `ยังไม่ได้ถาม`).
- Stored values are the Thai labels themselves (what Mos reads), under `session.homework.<field>`; the model's
  `lead_updates` land in the same place through `core/session.mergeLeadUpdates`.

## 3. Two endings (`endings.js`)

`chooseEnding(session)` → `'short'` when `draft.card` is a door package: **C1 at any tier**, or **any card at
T1** (A4 T1 included; `tier` defaults to T1, which is what `fit.js` sets) · else `'long'`.

### 3.1 Short path — the offer card
`offerCard(session, {deps})` → `{template:'offer', alt, data:{card_id, tier, title, bullets, secondary_cta}}`.
Bullets come from the pack section `offer.<card>.<tier>` (lines starting with `- `) when `deps.pack` has it,
otherwise a fixed 3-bullet default per card (`DEFAULT_BULLETS`, generic, no numbers). **Price and Fastwork URL are
never in the data** — the renderer resolves them from `ctx.priceFor / ctx.fastworkUrlFor` (pack ladders). The
secondary button is `นัดคุยกับมอสก่อน` → `BOOK_START`, so the short path still opens the long one.

`decorateResponse({response, session, deps})` appends the offer card to a model reply when: short path · a card is
known · no card in the reply yet · `homework.readyForEnding` **or** the reply's intent is `fit/howtostart/pricing`.
Once per session (`session.offer_shown`). Needs the hook in §5.

### 3.2 Long path — the booking state machine (`session.booking_step`)

```
null ──BOOK_START / model booking_start──▶ (preferred_contact := "นัดคุย 30 นาที" if empty)
  │
  ├─ hw            only while !homework.readyForEnding(session): ask problem_verbatim, then business
  │                (free text → onBookingText; counts toward questions_asked; budget 4)
  ├─ name          skipped when display_name is known (draft.name := display_name)
  │   name_text    otherwise typed; after BOOK_EDIT_name the buttons [ใช้ชื่อ <displayName>] [พิมพ์ชื่ออื่น]
  ├─ window_day    [วันนี้] [พรุ่งนี้] [เลือกวันเอง]   → BOOK_DAY_today|tomorrow|other
  │   window_day_text   เลือกวันเอง → typed day
  ├─ window_time   [เช้า 9-12] [บ่าย 13-17] [เย็น 18-20] → BOOK_TIME_morning|afternoon|evening
  ▼
summary          "ขอสรุปก่อนส่งให้มอสนะครับ…" + summary_confirm card (status pending, amber "รอมอสยืนยัน")
  │                buttons: ยืนยัน = BOOK_CONFIRM · ขอแก้ไข = BOOK_EDIT
  ├─ edit          "อยากแก้ตรงไหนครับ" [ชื่อ] [วัน] [ช่วงเวลา] [เรื่องที่อยากคุย] → BOOK_EDIT_name|day|time|problem
  │                clears ONLY that field → the machine re-asks it → back to summary
  ▼  BOOK_CONFIRM (only accepted while booking_step === 'summary')
pending          leads.upsert(status booking_pending) → bookings.create(status pending)
                 → notifier.booking({lead, booking, session, summary}) ──── MUST resolve first ────▶
                 "ส่งให้มอสแล้วครับ มอสจะยืนยันเวลากลับมาทางแชทนี้\nถ้าเกิน 1 วันทำการยังไม่มีตอบ โทร <phone> ได้เลย"
                 (notifier throws → booking status notify_failed, event booking_notify_failed,
                  "ขออภัยครับ ระบบส่งคำขอนัดให้มอสขัดข้อง…โทร <phone>" — no promise)
  │
  ├─ approve  (applyMosDecision)  → booking confirmed · summary_confirm status confirmed (green ยืนยันแล้ว — the
  │                                 ONLY path that renders it; returns allow = {booking_confirmed}) + one line
  ├─ propose  (windows ≤ 3)       → booking reproposed · text + quick replies BOOK_PICK_<i> (+ ขอเสนอเวลาอื่น)
  │     └─ BOOK_PICK_i            → window_text := windows[i] · status pending · notifier.booking again (before
  │                                 the words) · "รับทราบครับ เลือก <w> ส่งให้มอสแล้ว รอมอสยืนยันอีกครั้ง"
  └─ decline                      → booking declined · "ขออภัยครับ ช่วงนี้มอสยังรับนัดเพิ่มไม่ได้…โทร <phone>"
```

Session fields written here: `booking_step`, `booking_hw_field`, `booking_name_asked`, `booking_id`,
`draft.name`, `draft.window_day` (e.g. `พรุ่งนี้ (19 ต.ค.)`, Bangkok date from `deps.clock`), `draft.window_time`,
`homework.preferred_contact`, `discord_thread_id`, `offer_shown`, `questions_asked`.
Booking row: `{lead_id, user_id, window_text, fields:{name, business, problem, window}, status, proposed_windows,
decided_by, decided_at, created_at, discord_thread_id}`.

Guards: a model `booking_confirm` is **never** executed — logged `ignored_model_confirm` (+ event); if a booking is
mid-flight the current step is re-shown, if none exists the machine starts, if one is pending the "รอมอสยืนยัน"
line is repeated. `BOOK_START` while pending repeats that line too (no second booking). Postbacks never call the
model. ยืนยันแล้ว / นัดเรียบร้อย occur in no string of these three modules (asserted by a unit test).

## 4. Postback vocabulary
`FIT_<key>` · `BOOK_START` · `BOOK_HW_<field>_<i>` · `BOOK_NAME_USE` · `BOOK_NAME_OTHER` ·
`BOOK_DAY_<today|tomorrow|other>` · `BOOK_TIME_<morning|afternoon|evening>` · `BOOK_CONFIRM` · `BOOK_EDIT` ·
`BOOK_EDIT_<name|day|time|problem|business>` · `BOOK_PICK_<i>`.

> **Status 2026-10-17 evening:** the hooks listed below are implemented in `src/core/turn.js` / `src/app.js` / `tests/run-scenarios.js` (head engineer). Kept as the record of the contract.

## 5. Hooks

Already in `core/turn.js` (used as-is):
- step 8: `FIT_*` → `fit.onSymptomPostback(data, s)`; `BOOK_*` → `endings.onBookingPostback({...})`.
- step 11: model `booking_start` / `booking_confirm` → `endings.onModelAction({...})`.
- both resolve through `deps.flows` or lazy `require('../flows/fit|endings')`, so the scenario runner picks the
  modules up without changes.

Requested (not in this branch — described for the head engineer):
1. **Typed answers inside the booking** — `src/core/turn.js`, step 8, just before `let intentHint = …`
   (line 138): `if (input.kind === 'text' && s.booking_step && endings?.onBookingText) { const r = await
   endings.onBookingText({ text, input, session: s, deps, config, send, persist, done, sender: senders.lay });
   if (r) return r; }`. Without it the typed name / typed day / free-text homework answers go to the model and the
   machine waits at that step until the next `BOOK_*` tap.
2. **Short-path offer** — `src/core/turn.js`, after step 10 (line 161) and before step 11:
   `endings?.decorateResponse?.({ response, session: s, deps });` — appends the offer card when the short path is
   ready and the model did not already end on a card.
3. Optional: export `cardContext` from `turn.js` (or put it on `deps.cardContext`) — `endings.js` currently
   mirrors it to render the summary / offer cards.
4. `tests/run-scenarios.js`: pass `deps.pack` (at least `ladders` and `fastworkUrls`; e.g. load `knowledge/`
   through `brain/kb.loadPack` when present, or accept a `pack:` block in the YAML) — without a price the offer
   card falls back to text, so `10-short-path-offer.yaml` fails at `card: offer` today. Also note the offer
   **fallback** text uses `- ` bullet lines, which the runner's `no_prose_list` flags (`cards/templates/offer.js`).

## 6. Open experience questions for Mos (not guessed)
1. After the offer card (short path), should Lay also ask for the window, or stop and let Fastwork carry it? Today:
   the card has a secondary `นัดคุยกับมอสก่อน` button only.
2. Inside the booking, should Lay still ask the button-able homework (team size, where the work lives) before the
   window when the key three are known? Today: no — straight to the window; those gaps are listed for Mos.
3. `นัดคุยกับมอส` (the loose-ends button) is matched by `handoff.isAskHuman` and becomes a human handoff, not a
   booking. Which do you want — a booking (window + summary) or Mos live?
4. When the customer picks one of Mos's proposed windows, should that count as confirmed (Mos offered it) or go
   back to "รอมอสยืนยัน"? Today: back to pending, Mos notified again (flow §6.5).
5. Who "speaks" the approve / propose / decline message — Lay or มอส as sender? Today: Lay.
6. Default offer bullets per card (used when the pack has no `offer.<card>.T1`) are placeholders in
   `endings.DEFAULT_BULLETS` — please check the wording against the Fastwork cards.
