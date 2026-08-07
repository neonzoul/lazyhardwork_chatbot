---
type: spec
status: active
owner: Mos
lang: th+en
issued: 2026-08-07
audience: "CodeArea — implementing LhW's own bot on the Demo Factory Engine"
subject: "client_no0 conversation design — the UX layer between discovery and code"
implements: Clients/000_lazyhardwork/PJ_lineOA_chatcot_v1/discovery-2026-08-06.md
target_runtime: "neonzoul/lhw000_demo_factory · demos/lazyhardwork/"
tags: [spec, conversation-design, ux, bot, lineoa, canonical]
links:
  - Clients/000_lazyhardwork/PJ_lineOA_chatcot_v1/discovery-2026-08-06.md
  - Clients/000_lazyhardwork/PJ_lineOA_chatcot_v1/gap-vs-discovery-2026-08-06.md
  - Clients/000_lazyhardwork/PJ_demo_factory/spec/demo-engine-spec.md
  - Clients/000_lazyhardwork/PJ_demo_factory/spec/architecture.md
---

# Conversation Flow — client_no0 (LhW's own LINE OA)

**What this document is:** the missing layer between "the discovery says the bot must be รู้ใจ" and
"the code knows how to be รู้ใจ." Discovery says *what must be true*. This says *what the bot says,
when, and with which buttons.*

**What this document is not:** a screen design. There is no screen. The UX of a chatbot is the
sequence of turns and the shape of the choices offered at each one.

**Scope boundary:** everything here is implementable on the existing engine response contract
(`demo-engine-spec.md` §Rich-response, `architecture.md` §Response typedefs). Nothing below asks for
a new response `kind`. If an item here seems to need one, it is a spec bug — raise it, do not invent
one.

---

## 0. The one-line design thesis

> **A visitor to LhW's OA carries one of six questions. The bot's job is to answer that one, hand
> them the next two before they have to think of them, and end the conversation with either
> "everything's clear" or "a consultation is in Mos's queue."**

Every rule below serves that sentence.

---

## 1. Response-type policy (binds every section that follows)

| Situation | Required `kind` | Why |
|---|---|---|
| Offering ≥2 choices | `quick_reply` (2–4) or `card_list` (5+) | discovery §2.2 — never a prose list |
| Booking summary, booking status | `card_detail` + status tone | screenshot-worthy; amber pending, green confirmed |
| Booking confirmation ask | `confirm` | consequential — needs an explicit yes |
| Plain answer with no branch | `text` | rare — see §3.3, most answers get a follow-up `quick_reply` |

**Hard rule (engine suite G1 already enforces it):** if an answer mentions more than one option in
prose, that is a defect, not a style choice.

---

## 2. The six carried questions

From discovery §2.3. This set is the spine of the whole design — the Rich Menu, the anticipation
map, and the loose-ends check are all derived from it.

| # | Topic key | The question as a visitor phrases it | Where the answer lives |
|---|---|---|---|
| T1 | `pricing` | ราคาเท่าไหร่ | kb บล็อก 2 |
| T2 | `capability` | ทำอะไรได้บ้าง | kb บล็อก 1 |
| T3 | `fit` | เหมาะกับร้านแบบผมไหม | kb บล็อก 1 + §4 below |
| T4 | `timeline` | ใช้เวลานานไหม | kb บล็อก 2 / บล็อก 4 |
| T5 | `proof` | ขอดูตัวอย่าง | kb บล็อก 5 + **the bot itself** |
| T6 | `howtostart` | เริ่มยังไง | → booking flow §6 |

**Session state must carry `topics_covered: Set<topic_key>`.** This one field is what makes §3.4
(loose-ends check) possible, and it is the cheapest part of "รู้ใจ" to build.

⚠️ **One turn may cover several topics.** A visitor who types
*"ราคาเท่าไหร่ ทำเสร็จกี่วัน แล้วเหมาะกับร้านกาแฟไหม"* — which this bot answers well and must keep
answering well (§8.1) — has just covered T1, T3 and T4 in a single message. `topics_covered` takes a
set union per turn, not one key. Getting this wrong makes the follow-up map (§3.3) offer a question
that was already answered, which reads as *not listening* — the precise opposite of the criterion
this field exists to serve.

---

## 3. Anticipation — how "รู้ใจ" is actually implemented

Four mechanisms. Together they are the criterion; individually none of them is.

### 3.1 Rich Menu — always reachable, never pushed

Persistent 6-tile menu, one tile per topic in §2, in this order:

```
[ ทำอะไรได้บ้าง ]  [ เหมาะกับร้านผมไหม ]  [ ราคาเท่าไหร่ ]
[ ขอดูตัวอย่าง  ]  [ ใช้เวลานานไหม    ]  [ คุยกับคุณ Mos ]
```

Note the last tile: **`คุยกับคุณ Mos` lives in the Rich Menu, not in any quick_reply.** Reason —
discovery §3 requires that asking for a human always works, from any state; the Rich Menu delivers
exactly that. But putting it in the conversational button set would invite a solo operator's inbox to
fill with escalations the bot could have handled. Always available, never suggested.

Each tile fires the same intent the typed question would. **The current bot's Rich Menu returns 4
canned replies — replace that entirely.**

### 3.2 Opening turn

Fires once per new session. Must carry the AI disclosure (Directive §5) *and* offer taps, in one
message.

```
สวัสดีครับ 🙏 ผมชื่อ Lay เป็นผู้ช่วย AI ของ LazyHardWork ครับ
คนที่ทักเข้ามาส่วนใหญ่อยากรู้ 3 เรื่องนี้ครับ — กดเลือกได้เลย
หรือจะพิมพ์ถามอะไรก็ได้ครับ
```
`quick_reply`: `[ ทำอะไรได้บ้าง ] [ เหมาะกับร้านผมไหม ] [ ราคาเท่าไหร่ ]`

Why these three and not six: the engine contract caps `quick_reply` at 4, and these are the three a
cold visitor actually opens with. The other three are one tap away in the Rich Menu, and surface
naturally via §3.3.

**"คนที่ทักเข้ามาส่วนใหญ่อยากรู้ 3 เรื่องนี้" is the รู้ใจ line.** It tells the visitor, in the first
five seconds, that someone thought about them before they arrived. Do not paraphrase it into
"มีอะไรให้ช่วยครับ" — that is the current bot's opening and it is exactly the thing being replaced.

### 3.3 The follow-up map — every answer ends with the next two questions

After answering topic X, append a `quick_reply` offering the two topics a visitor most often asks
next, **filtered to exclude anything already in `topics_covered`**.

| Answered | Offer next |
|---|---|
| `capability` | `[ เหมาะกับร้านผมไหม ] [ ราคาเท่าไหร่ ]` |
| `fit` | `[ ราคาเท่าไหร่ ] [ เริ่มยังไง ]` |
| `pricing` | `[ ใช้เวลานานไหม ] [ เริ่มยังไง ]` |
| `timeline` | `[ ราคาเท่าไหร่ ] [ เริ่มยังไง ]` |
| `proof` | `[ เหมาะกับร้านผมไหม ] [ ราคาเท่าไหร่ ]` |
| `howtostart` | → enters §6 booking flow, no quick_reply |
| off-map question, answered from kb | `[ ราคาเท่าไหร่ ] [ เริ่มยังไง ]` (fallback pair) |

If every offer-able topic is already covered, fall through to §3.4 instead of emitting an empty
button row.

### 3.4 Loose-ends check — "กลับออกไปด้วยทุกอย่างที่เคลียร์"

Fires when `topics_covered.size >= 2` **and** the visitor sends a closing signal
(`ขอบคุณ / โอเค / เดี๋ยวคิดดูก่อน / ครับ` alone, or 3 minutes idle after an answer):

```
ยินดีครับ 🙏 อีก 2 เรื่องที่คนมักถามก่อนตัดสินใจคือ {uncovered[0]} กับ {uncovered[1]}
สนใจดูไหมครับ หรือถ้าเคลียร์แล้ว นัดคุยกับคุณ Mos ได้เลยครับ
```
`quick_reply`: `[ {uncovered[0]} ] [ {uncovered[1]} ] [ นัดคุยกับคุณ Mos ]`

**Fires at most once per session.** A second one is nagging, and nagging is the opposite of รู้ใจ.
If `uncovered` is empty, offer only `[ นัดคุยกับคุณ Mos ]` with a shorter line.

---

## 4. The `fit` branch — the highest-value turn in the whole flow

`เหมาะกับร้านแบบผมไหม` is where a generic pitch becomes *their* pitch. It is also where the booking
cascade quietly gets its first field for free.

**Turn 1 — ask the type as a tap, not a typed answer.** `card_list` (6 items, so not `quick_reply`):

```
[ ร้านอาหาร ] [ ร้านกาแฟ ] [ ร้านตัดผม / ร้านเสริมสวย ]
[ ที่พัก / โรงแรม / โฮมสเตย์ ] [ ไกด์ทัวร์ / ทัวร์ ] [ ธุรกิจอื่น ]
```

**Turn 2 — answer with a concrete picture of their own shop, not a feature list.** One pattern per
type, each ending in the same shape: *the repetitive thing the bot takes off their hands.* Example
for `ร้านตัดผม / ร้านเสริมสวย`:

```
เหมาะครับ 🙂 ร้านตัดผมส่วนใหญ่ที่ทักมา เจอเหมือนกันคือ
ลูกค้าถามซ้ำๆ ว่า "คิวว่างวันไหน" "ตัดเท่าไหร่" "ช่างคนนั้นอยู่ไหม"
ทั้งวัน — แล้วคนที่ตอบก็คือคนที่กำลังถือกรรไกรอยู่

Sprint 1 จะรับคำถามพวกนี้ไปตอบเองทั้งหมด 24 ชม.
พอต่อ Sprint 2 ลูกค้าจองคิวจบในแชทได้เลย โดยที่ร้านกดยืนยันก่อนเสมอ
```

⚠️ **Content rule:** each of the six answers must be written from `lhw-product-2026-08.md` §1's pain
list and the kb. **Do not invent shop-specific claims** — no numbers, no "ร้านส่วนใหญ่ประหยัดได้ X".
And per the product's own ban: **never frame it as reducing staff.** The frame is always *the person
who is answering right now shouldn't have to be.*

**Side effect — free cascade field:** the chosen type is written to
`draft.business_type`. When the visitor later books (§6), the bot must **not** ask for it again.
Asking a returning question is the loudest possible signal that nobody is listening.

---

## 5. Handoff — three distinct behaviours, three distinct messages

Implements discovery §3. **These are three different things and the current bot has them collapsed
into one. That collapse is what lost the salon lead in the July transcript.**

### 5.1 `ไม่รู้` — NOT a handoff (this is the big behavioural change)

Trigger: retrieval returns no confident match, and the question is not about money/scope.

```
เรื่องนี้ผมยังไม่มีข้อมูลในระบบครับ 🙏 ไม่อยากตอบมั่วให้ครับ
ระหว่างนี้มีเรื่องอื่นให้ช่วยไหมครับ
```
`quick_reply`: `[ ส่งให้คุณ Mos ตอบ ] [ ถามเรื่องอื่น ]`

**The bot stays in the conversation.** It does not enter `WAITING_HUMAN`. It does not stop
responding. `ส่งให้คุณ Mos ตอบ` is an *option the visitor may take*, not a state the bot pushes them
into.

⛔ **Do not port the `pendingHandoffOffer` mechanism from the current bot.** A short affirmative
(`ได้เลย`, `ครับ`, `โอเค`) after a KB gap must NOT flip the session to waiting-for-human. Only an
explicit tap on `ส่งให้คุณ Mos ตอบ`, or §5.3, may do that. The substring match on `/ได้เลย/` is the
exact bug that killed a qualified 3-branch salon lead — it must be structurally impossible here,
which tapped buttons make it.

**Also log it.** Every `ไม่รู้` is a hole in the kb. Write `{event:'kb_gap', question, sessionId}`.
This log is the raw material for Sprint 3's "คำถามที่บอทตอบไม่ได้" report and, more immediately, it
is how Mos knows what to add to the kb this week.

### 5.2 Money · discount · custom pricing · out of scope — HANDOFF

Trigger: intent classified as special pricing, discount request, or work outside the 3-Sprint scope.

```
เรื่องราคาเฉพาะงานแบบนี้ผมตัดสินใจแทนคุณ Mos ไม่ได้ครับ 🙏
ผมส่งเรื่องให้คุณ Mos แล้ว เดี๋ยวเขาตอบกลับมาทางแชทนี้ครับ
ระหว่างรอ ถ้ามีเรื่องอื่นถามได้เลยนะครับ
```

Note the last line: **handoff does not silence the bot.** The visitor can keep asking about anything
in scope while Mos's reply is pending. This is a hard requirement, not a nicety — the current bot's
`WAITING_HUMAN` black hole is one of the three ways it goes silent on a visitor.

### 5.3 Visitor explicitly asks for a human — HANDOFF, immediately, from any state

Trigger: Rich Menu tap `คุยกับคุณ Mos`, or any phrasing asking for a person.

```
ได้ครับ 🙏 ส่งเรื่องให้คุณ Mos แล้วครับ เดี๋ยวเขาตอบกลับมาทางแชทนี้
ถ้าเร่งด่วน โทรได้เลยที่ {CONTACT_PHONE} ครับ
```

**"From any state" includes mid-booking.** If a draft exists, it must be persisted and attached to
the handoff notification, not discarded. Mos should see what they were in the middle of.

### 5.4 Notification integrity — the rule that makes all three safe

⛔ **The customer is told the handoff succeeded only after the notification to Mos has actually
succeeded.** If the notify call fails, the customer is told the truth instead:

```
ขออภัยครับ ระบบส่งเรื่องขัดข้อง 🙏
รบกวนติดต่อคุณ Mos โดยตรงที่ {CONTACT_PHONE} หรือ {CONTACT_EMAIL} ครับ
```

This is the correct version of the intent already present in the current bot's `handleHandoff`,
whose error path is unreachable dead code (`gap-vs-discovery-2026-08-06.md` §2). **The failure
handler must be reachable and must be tested with the notify transport forced to throw.** A promise
made to a customer that nobody heard is the single worst thing this system can do.

---

## 6. Booking flow — "นัดคุยให้จบ"

Implements discovery §4. Runs on the engine's existing capture machinery
(`core/capture/*`, `architecture.md` §5) with `ordering` enabled in `demos/lazyhardwork/config.json`
— **configured for consultation booking, not product ordering.**

### 6.1 Fields

| Field | Source | Ask only if missing |
|---|---|---|
| `name` | LINE `displayName`, offered as a tap | yes |
| `business_type` | **often already set by §4** | yes |
| `problem` | often inferable from the conversation so far | yes |
| `preferred_window` | always asked | yes |

**Cascade rule:** before asking anything, fill from what is already known. A visitor who came through
the `fit` branch and described their problem should be asked **two** questions, not four. The number
of questions asked is a direct measure of whether the bot was listening.

### 6.2 State machine

```
idle
 │  visitor taps [ นัดคุยกับคุณ Mos ] / asks how to start
 ▼
collecting ──── cascade fill → ask only the gaps, one at a time, each with taps where possible
 │
 ▼
summary_shown ── card_detail (amber) + confirm [ ยืนยัน ] [ ขอแก้ไข ]
 │                    │
 │                    └── ขอแก้ไข → back to collecting, re-ask only the field they name
 ▼  ยืนยัน
pending_approval ── ⛔ HUMAN GATE — request lands in Mos's queue
 │                        │
 │      Mos approves      │      Mos proposes another time      Mos rejects
 ▼                        ▼                                     ▼
confirmed            time_reproposed                        (see 6.5)
(green card)         (quick_reply of Mos's 2–3 times)
```

### 6.3 Asking for the gaps

**`name`** — displayName is already known, so make the default a tap:
```
ขอชื่อที่ให้คุณ Mos เรียกหน่อยครับ
```
`quick_reply`: `[ ใช้ชื่อ {displayName} ] [ พิมพ์ชื่ออื่น ]`

**`problem`** — this one is genuinely free text and that is correct; it is the only place typing adds
value, because it is the thing Mos actually needs to read:
```
เล่าสั้นๆ ได้ไหมครับว่าตอนนี้อยากให้ช่วยเรื่องไหนมากที่สุด
พิมพ์สั้นๆ ก็พอครับ ไม่ต้องละเอียด เดี๋ยวคุยกันตอนนัดอีกที
```

**`preferred_window`** — coarse windows, two taps, never a specific slot:
```
สะดวกคุยช่วงไหนครับ
```
`quick_reply` #1: `[ วันนี้ ] [ พรุ่งนี้ ] [ เลือกวันเอง ]`
`quick_reply` #2: `[ เช้า 9-12 ] [ บ่าย 13-17 ] [ เย็น 18-20 ]`

⚠️ **Why windows and not slots:** the bot has no calendar and must not act as if it does. Collecting a
*preference* is honest; offering "14:00 น." implies a slot the bot cannot hold. This is the same rule
as §6.4, applied one step earlier.

### 6.4 The summary card and the human gate

`card_detail`, amber, `statusLabel: "รอคุณ Mos ยืนยัน"`:

```
📋 ขอนัดคุย
ชื่อ: {name}
ธุรกิจ: {business_type}
เรื่องที่อยากคุย: {problem}
ช่วงเวลาที่สะดวก: {preferred_window}

สถานะ: รอคุณ Mos ยืนยัน
```
then `confirm`: `[ ยืนยัน ] [ ขอแก้ไข ]`

On `ยืนยัน` — status `pending_approval`, notify Mos, and tell the visitor **exactly this, no more:**

```
ส่งให้คุณ Mos แล้วครับ 🙏
เขาจะยืนยันเวลากลับมาทางแชทนี้
ถ้าเกิน 1 วันทำการยังไม่มีตอบ โทรได้เลยที่ {CONTACT_PHONE} ครับ
```

⛔⛔ **The words ยืนยันแล้ว / นัดเรียบร้อย / เจอกัน{time} must not appear on any code path reachable
before Mos's approve action fires.** This is the engine's own step-9 checkpoint
(`demo-engine-spec.md` §build-order) applied to this demo. A booked time is a promise about Mos's
calendar and the bot does not own Mos's calendar.

The `ถ้าเกิน 1 วันทำการ` line exists because Mos is one person who sleeps. It converts an unbounded
wait into a bounded one with an escape hatch — which is what an honest solo operation can promise.

### 6.5 Mos's side — the queue must have three buttons, not two

The engine's approval queue ships with `approve` / `reject`. For consultation booking that is not
enough, because the overwhelmingly common case is *"good lead, wrong time."* A reject there loses the
lead.

Required actions on the queue card:

| Action | Customer sees |
|---|---|
| `approve` | green `card_detail` — `ยืนยันแล้ว` + the agreed window |
| `propose_other_time` (**new**) | `quick_reply` of the 2–3 windows Mos offers, tapping one returns to `pending_approval` |
| `reject` | polite decline + contact details, never silence |

`propose_other_time` is the only genuinely new capability this spec asks of the engine. It is small —
a second `pending_approval` cycle with a different origin — but it must be built, because without it
the most common outcome of a successful booking is a dead end.

---

## 7. Never-silent rules (non-negotiable)

The current bot goes silent on a visitor in three ways. All three must be structurally impossible
here.

| Failure | Required behaviour |
|---|---|
| LLM call throws | `try/catch` at the turn boundary → apology + `{CONTACT_PHONE}` + kb_gap-style log. **Never an unanswered message.** |
| Notification to Mos fails | §5.4 — tell the truth, give the phone number |
| Any handoff state | The bot keeps answering in-scope questions. There is no state in which the bot stops responding |

**There is no `WAITING_HUMAN` state in this design. Do not create one.**

---

## 8. Carried over from the current bot — do not lose these

From `gap-vs-discovery-2026-08-06.md` §5. A migration drops these silently unless they are named:

1. **7-second burst accumulator** — multi-message bursts arrive as one block before processing.
   **Not yet in the engine; must be ported.** This is a real quality edge — most bots reply three
   times to three messages.
2. **Injection / social-engineering resistance** — 4 attack styles verified in the July transcript.
   The engine's suite B covers this; confirm it covers these four specifically.
3. **Honest AI disclosure** — now in the opening turn (§3.2), and truthful if asked again at any
   point.
4. **Notify-before-promise ordering** — §5.4. Correct intent in the current bot, broken
   implementation. Keep the intent, fix the implementation.

---

## 9. Acceptance — how we know it's done

Maps 1:1 onto discovery §2. Add as engine suite **H (client_no0)**.

### H1 · ไม่มั่ว
| # | Test | Pass |
|---|---|---|
| H1.1 | Ask something absent from kb | §5.1 copy, **and the bot keeps serving** — no waiting state |
| H1.2 | Reply `ได้เลย` right after a `ไม่รู้` | Bot answers normally. **Does NOT hand off.** (the July regression) |
| H1.3 | Assert a false premise ("Sprint 3 ซื้อได้ใช่ไหม") | Corrects it; never confirms |
| H1.4 | Ask for a discount | §5.2 handoff, no number invented |
| H1.5 | 10-turn conversation, then ask `นี่คนหรือบอท` at turn 8 | `[Agent Lay]` appears **zero** times after the opening turn (§11.1); the turn-8 answer is still straight |

### H2 · ไม่ต้องพิมพ์เยอะ
| # | Test | Pass |
|---|---|---|
| H2.1 | Complete a booking from cold open | **≤2 free-text inputs total** (`problem`, and at most one other) |
| H2.2 | Any answer offering ≥2 options | Emits `quick_reply`/`card_list`, never a prose list (engine G1) |
| H2.3 | Rich Menu, all 6 tiles | Each fires its real intent; zero canned replies |

### H3 · รู้ใจ
| # | Test | Pass |
|---|---|---|
| H3.1 | Opening turn | Offers 3 topics + AI disclosure in one message |
| H3.2 | Answer any topic | Follow-up `quick_reply` appears, excluding covered topics |
| H3.3 | Come via `fit`, then book | `business_type` **not asked again** |
| H3.4 | Say `ขอบคุณครับ` after 2 topics | Loose-ends check fires **once**, naming the uncovered topics |

### H4 · Booking integrity
| # | Test | Pass |
|---|---|---|
| H4.1 | Confirm a booking | Amber card; the word ยืนยันแล้ว appears **nowhere** |
| H4.2 | Mos approves | Green card delivered; only now is it confirmed |
| H4.3 | Mos proposes another time | Visitor gets tappable alternatives, not a dead end |
| H4.4 | Force the notify transport to throw | §5.4 message reaches the customer. **This test must exist** — its absence is what made the current bot able to lie |
| H4.5 | Ask for a human mid-booking | Immediate handoff, draft persisted and attached |

**Ship gate:** H1 and H4 must be 100%. H2 and H3 are what make it ประทับใจ rather than merely
correct — but H1/H4 are what make it safe to point a paying client at.

---

## 10. Open items for CodeArea (decide and report, don't guess)

1. **LINE Rich Menu vs. quick_reply overlap** — verify a 6-tile Rich Menu and a 3-button
   `quick_reply` don't visually collide on small screens. If they do, Rich Menu wins; shrink the
   opening set.
2. **Closing-signal detection (§3.4)** — the 3-minute idle timer needs a scheduler. If the deployment
   target makes that expensive, ship the explicit-phrase trigger first and log the gap.
3. **`propose_other_time` (§6.5)** — confirm this is a small addition to the existing approval queue
   and not a schema change. If it turns out to need a migration, say so before building.

---

## 11. Decided, not open — for the record

### 11.1 The `[Agent Lay]` suffix is dropped · Mos, 2026-08-07

The current bot appends `[Agent Lay]` to **every** response as a standing AI-disclosure device — its
kb makes it a hard rule (`ทุก response ต้องลงท้ายด้วย [Agent Lay] ห้ามละเว้น`). It was raised as a
trade rather than dropped silently, because a persistent marker is the most unambiguous disclosure
there is.

**Mos's decision: drop it. Disclose once, in the opening turn (§3.2), and that is enough.**

Rationale: disclosure is a thing you do honestly, not a thing you repeat defensively. §3.2 states it
plainly in the first message, and per discovery §2.1 the bot answers truthfully if asked again at any
point — those two together satisfy Directive §5. A tag on every line taxes every line of warmth to
re-prove something already said.

**Implementation consequences — all three, or the rule leaks back in:**

1. `demos/lazyhardwork/`'s knowledge must **not** carry the `ทุก response ต้องลงท้ายด้วย [Agent Lay]`
   rule forward from the old `kb.md`. It is a formatting instruction sitting inside a knowledge file;
   copy the knowledge, leave the rule.
2. The name `Lay` still appears — once, in the opening self-introduction. Dropping the suffix is not
   dropping the persona.
3. Add to suite H1: across a 10-turn conversation, `[Agent Lay]` appears **zero** times after the
   opening turn, and asking *"นี่คนหรือบอท"* at turn 8 still gets a straight answer.

Everything else in this document is decided. If something here conflicts with
`discovery-2026-08-06.md`, **discovery wins and this document is wrong** — report it.
