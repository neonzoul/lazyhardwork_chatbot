---
type: client-doc
status: active
owner: Mos
lang: th+en
issued: 2026-08-06
audience: "Mos + agents building LhW's own LINE OA bot"
subject: "client_no0 (LazyHardWork) — discovery for the production chatbot"
method: "Clients/000_lazyhardwork/PJ_go_to_market/lhw-discovery-kit.md (STAGE 1-3)"
tags: [discovery, client-zero, bot, requirements, lineoa]
links:
  - Clients/000_lazyhardwork/PJ_go_to_market/lhw-discovery-kit.md
  - Clients/000_lazyhardwork/PJ_go_to_market/lhw-product-2026-08.md
---

# Discovery — client_no0 (LazyHardWork's own LINE OA bot)

**กระดุมเม็ดแรก.** Ran the studio's own Discovery Kit on the studio itself. Answers below are Mos's,
captured 2026-08-06. This document — not the old spec, not the existing code — is what the bot is
judged against from here.

**Why this matters:** every previous audit of this bot measured it against a spec written before
anyone asked what the bot was *for*. This is that missing question, answered.

---

## STAGE 3 — Information → Data

```
CLIENT: LazyHardWork (LHW) · client_no0 · AI studio, solo operator (Mos)
        Serves service businesses: ร้านอาหาร · ร้านกาแฟ · ร้านตัดผม · ที่พัก · โรงแรม · โฮมสเตย์ · ไกด์ทัวร์

PROBLEM: Solo operator with a brand-new LINE OA and zero inbound traffic. Two things follow:
         1. Mos cannot man a chat channel — he is the whole studio. Anyone who arrives while he's
            building, sleeping, or on another job must still be served properly.
         2. More important: THE BOT IS THE PRODUCT DEMO. A prospect deciding whether to pay
            15,000-30,000 THB judges LhW by talking to this bot. It is simultaneously the
            storefront and the proof. A mediocre conversation doesn't just lose one lead — it
            disproves the pitch.

CURRENT_FLOW: Prospect arrives at LINE OA → bot answers from KB → if it can't, it offers to pass
              to Mos → Mos replies manually when he sees the Discord alert.

DESIRED_OUTCOME: ผู้ใช้เข้ามาพร้อมคำถามที่แบกมา → ได้คำตอบครบทุกข้อ → ถ้าสนใจ นัดคุยกับ Mos ได้จบในแชท
                 → กลับออกไปโดยไม่เหลือคำถามค้าง และจำได้ว่า "ที่นี่เอาจริง"

SCOPE: Sprint 1 (ตอบให้จบ) + Sprint 2 (รับงานให้จบ)
       ⚠️ Sprint 2 here is NOT product ordering. For a studio, "รับงานให้จบ" = booking a
       consultation with Mos, end to end, inside the chat. Same machinery (slot filling →
       summary → human approval), different payload.

TONE: admin + service mind · เป็นธรรมชาติ สุภาพ เป็นกันเอง · ลงท้าย "ครับ" · male persona
      ตัวอย่าง: "เรื่องนี้ยังไม่มีข้อมูลในระบบครับ 🙏 รบกวนส่งให้คุณ Mos ตอบโดยตรงดีไหมครับ"

KNOWLEDGE: knowledge/kb.md — verified current 2026-08-06 (Sprint pricing, no zFiN, headcount rule
           encoded, Sprint 3 gated). This part is DONE and correct.

SUCCESS_METRIC: see §2 below — three named criteria, all three must hold.
```

---

## 1. Volume reality — and what it changes

**Answer: ยังไม่มีเลย / เพิ่งเปิด.** Zero inbound today.

This inverts the usual priority. Nothing here is a scaling problem. **Every single early conversation
is a first impression on a channel with no reputation yet**, and there are few enough of them that
losing one is material. The design goal is not throughput — it is that *no one who arrives leaves
badly served*, not once.

Practical consequence: features that only matter at volume (rate limiting for cost control, queue
management, analytics dashboards) are **not** the priority. Features that make one conversation
excellent are.

---

## 2. What "ประทับใจ" means — Mos's three criteria

These are the acceptance criteria. All three, not two of three.

### 2.1 ไม่มั่ว — ไม่รู้ก็บอกว่าไม่รู้

Zero fabrication. If the KB doesn't cover it, say so plainly. A confident wrong answer about price
or scope is worse than an honest gap, because this bot is the proof of what LhW sells.

### 2.2 ไม่ต้องพิมพ์เยอะ — กดเลือกได้

Every choice point should be tappable, not typed. Typing is where people mis-spell, hesitate, and
drop out. This is the criterion the current bot fails hardest — it is 100% prose.

### 2.3 รู้ใจ — เหมือนคิดมาอย่างดีแล้วว่าคนที่เข้ามาแบกอะไรมา

The strongest and most demanding of the three. It says the bot should **anticipate**, not merely
respond. A visitor to LhW's OA is almost always carrying one of a small, knowable set of questions:
*ราคาเท่าไหร่ · ทำอะไรได้บ้าง · ใช้เวลานานไหม · เริ่มยังไง · เห็นตัวอย่างได้ไหม · เหมาะกับร้านแบบผมไหม*

"รู้ใจ" means those are surfaced before being asked, and that a conversation closes with **nothing
left hanging** — "กลับออกไปด้วยทุกอย่างที่เคลียร์."

This is a design requirement, not a tone note. It implies an opening that offers the common
questions as taps, and follow-through that checks whether anything is still unanswered.

---

## 3. Handoff policy — CHANGED, and this matters

**Mos's answer: handoff เฉพาะ (ก) เรื่องเงิน / ส่วนลด / งานนอก scope, และ (ข) เมื่อผู้ใช้ต้องการติดต่อกับคน**

The critical clarification: **"ไม่รู้" is NOT a handoff trigger.**

The current bot conflates these two. When it hits a KB gap it sets `pendingHandoffOffer`, and a
short affirmative from the user flips the session to `WAITING_HUMAN` — the bot stops serving
entirely and the visitor waits for a solo operator who may be asleep.

Under this discovery that is wrong. Correct behaviour:

| Situation | Bot does |
|---|---|
| Doesn't know something | Says so honestly (§2.1) — **and keeps serving.** Offers Mos as an option, doesn't force it |
| Money · discount · custom pricing · out of scope | **HANDOFF** — stop, notify Mos |
| User asks for a human, in any phrasing | **HANDOFF** — immediately, from any state |
| Everything else | Answer. Try hard before giving up |

**Design principle that falls out of this:** the bot should try to answer as much as it possibly can.
Handing off is a deliberate, narrow decision — not the fallback for uncertainty. A solo operator
cannot absorb an escalation every time the bot is unsure, and a visitor who wanted an answer at 2am
does not want a queue ticket.

---

## 4. Where the conversation should end — "นัดคุยให้จบ"

Mos's chosen scope: **ตอบ + นัดคุยให้จบ.** The bot's job isn't done when it answers — it's done when
an interested visitor has a consultation booked without Mos touching anything.

Target flow:

```
visitor arrives (carrying a question)
  → gets it answered, plus the things they'd have asked next (§2.3)
  → shows interest
  → bot collects what a consultation needs: ชื่อ · ประเภทธุรกิจ · ปัญหาที่อยากแก้ · ช่วงเวลาที่สะดวก
     (cascade — extract from what they already said, ask only for what's genuinely missing)
  → shows a summary card, visitor confirms
  → lands in Mos's queue as a booking request
  → ⛔ Mos approves → ONLY THEN is the visitor told the time is confirmed
```

The last line is non-negotiable and matches the product's own rule: **a promise to a customer is
never made by the bot alone.** A booked time is a promise about Mos's calendar.

**Currently: none of this exists.** The bot extracts lead fields and posts to Discord, but there is
no booking flow, no summary, no confirmation, no approval step.

---

## 5. STAGE 4 — confirmed 2026-08-07 · REQUIREMENT LOCKED 🔒

Per the kit, this document went back to the client (Mos) for confirmation. **All four confirmed
2026-08-07:**

- [x] Scope = Sprint 1 + Sprint 2-as-consultation-booking
- [x] The three ประทับใจ criteria in §2 are the acceptance bar
- [x] Handoff policy in §3, including "ไม่รู้ ≠ handoff"
- [x] Booking flow in §4 ends at Mos's approval, never bot-confirmed

**This is now the locked requirement.** Everything downstream is judged against it. Changes to this
document from here are scope changes, not clarifications — they require an explicit decision from Mos
and a note in `_agent/state.yaml` `open_decisions`.

**Next artifact downstream:** `conversation-flow-2026-08-07.md` — turns these requirements into the
actual conversation design (opening menu, quick-reply sets, booking state machine, exact Thai copy)
that CodeArea implements.
