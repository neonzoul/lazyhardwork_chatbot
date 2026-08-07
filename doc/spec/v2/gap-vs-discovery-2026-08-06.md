---
type: audit
status: active
owner: Mos
lang: th+en
issued: 2026-08-06
audience: "Mos — deciding what to do with the current bot"
subject: "neonzoul/lazyhardwork_chatbot @ main, measured against discovery-2026-08-06.md"
tags: [audit, bot, lineoa, gap-analysis, decision]
links:
  - Clients/000_lazyhardwork/PJ_lineOA_chatcot_v1/discovery-2026-08-06.md
  - Clients/000_lazyhardwork/PJ_lineOA_chatcot_v1/audit-2026-08-05.md
  - Clients/000_lazyhardwork/PJ_lineOA_chatcot_v1/production-audit-2026-08-06.md
---

# What to do with the current bot

Measured against `discovery-2026-08-06.md` — the first requirement document this bot has ever had.
Prior audits (engineering 2026-08-05, production 2026-08-06) measured it against a spec written
before anyone asked what the bot was for. This one uses the right yardstick.

---

## 1. Scorecard against the discovery

| Requirement (discovery §) | Status | Evidence |
|---|---|---|
| KB factually correct | ✅ **Done** | `kb.md` verified 2026-08-06: Sprint pricing, no zFiN, headcount rule encoded, Sprint 3 gated |
| §2.1 ไม่มั่ว — admits what it doesn't know | ✅ **Strong** | Verified in the July transcript: refused a fake discount, corrected a false ฿8,000 premise, resisted 4 injection styles. **This is the bot's best quality** |
| AI disclosure honest when asked | ✅ **Done** | Rule 8 in the system prompt; confirmed in transcript |
| §2.2 ไม่ต้องพิมพ์เยอะ — tappable | ❌ **Absent** | 100% prose. Rich Menu exists but only fires 4 canned replies — no cards, no quick replies, no choice buttons anywhere in a conversation |
| §2.3 รู้ใจ — anticipates what visitors carry | ❌ **Absent** | Purely reactive. Opening asks an open question; nothing surfaces the common set; nothing checks for unanswered threads |
| §3 Handoff only on money/scope/user-request | ❌ **Wrong by design** | Conflates "ไม่รู้" with handoff. KB gap → `pendingHandoffOffer` → one short affirmative → `WAITING_HUMAN`, bot goes silent |
| §4 นัดคุยให้จบ — booking to completion | ❌ **Does not exist** | No booking flow, no slot filling, no summary, no approval step. Lead fields → Discord, and that's the end |
| §4 Never confirms a promise without Mos | ⚠️ **Vacuously true** | Nothing to confirm because nothing is booked. Not a pass — an absence |
| Never goes silent on a visitor | ❌ **Fails 3 ways** | No try/catch around the OpenAI call; `WAITING_HUMAN` black hole; unreachable handoff fallback (§2 below) |

**Two of nine requirements met. The two it meets, it meets genuinely well.**

---

## 2. The one thing to fix today, regardless of what you decide

`src/discord.js`:

```js
await axios.post(config.discord.crmWebhook, { content }).catch(console.error);
```

That trailing `.catch` means `postCrmHandoff` **can never throw**. Which means this, in
`src/bot.js` `handleHandoff`, is unreachable dead code:

```js
try {
    await postCrmHandoff({ displayName, summary });
} catch (err) {
    // ...tell the customer to contact Mos directly instead of making a broken promise
}
```

**Consequence:** if Discord is down, the visitor is told *"ได้เลยครับ ส่งเรื่องให้คุณมอสแล้ว"* and
**nobody is notified.** They wait for someone who is never coming. The one path in the whole system
whose entire job is "never make a broken promise" is the path that silently makes one.

The fix is deleting five characters. Do it whatever else happens.

Two smaller ones alongside it:
- `#crm` never sends `userId`, but `README.md` and `/admin/docs` both say it does — the documented
  recovery procedure cannot be followed as written.
- The July transcript's lost salon lead was **not** injection over-correction as earlier write-ups
  concluded. Root cause: `/ได้เลย/` matched as a *substring* while `pendingHandoffOffer` was set.
  A well-qualified lead asking three answerable questions got none of them answered.

---

## 3. What the gaps have in common

The four ❌ rows are not four independent features. They share one root: **the bot is a prompt with
a knowledge base pasted into it, and nothing else.**

- No structured response type → cannot emit a card → §2.2 impossible
- No retrieval layer that knows what it *didn't* match → cannot distinguish "ไม่รู้" from "hand off"
  → §3 impossible
- No persistence → no draft survives a restart → §4 booking impossible, and the monthly
  "what did customers ask" report is unbuildable
- No state beyond a `Map` → cannot recognise a returning visitor → §2.3 impossible

You cannot buy these one at a time. Adding a booking flow to a bot with no persistence produces a
booking flow that forgets itself on every Railway redeploy — which is worse than not having one,
because now a visitor believes they booked something.

---

## 4. Recommendation

**Fix §2 today (~30 minutes). Do not build §2.2/§2.3/§3/§4 into this codebase.**

Everything in §3's root-cause list already exists, tested and deployed, in
`neonzoul/lhw000_demo_factory`: deterministic retrieval that knows what it missed, a rich-response
contract with card types, Postgres persistence, an approval queue where nothing reaches a customer
without a human pressing approve, and a LINE channel adapter. Building it a second time here, solo,
would take weeks and land somewhere worse.

**The path:**

1. **Today** — fix the dead-code handoff fallback (§2). The live bot stops being able to lie.
2. **Next** — bring LhW's own OA onto the engine as `demos/lazyhardwork/`. Two things must happen
   first, both known:
   - the engine has never done a live LINE round-trip — it must be proven end to end once
   - `demos/lazyhardwork/config.json` has `ordering:false` — the booking flow in discovery §4 needs
     it on, configured for consultation booking rather than product ordering
3. **Then** — build §2.2 (cards) and §2.3 (anticipation) on the engine, where the response contract
   already supports them. These are the two criteria that make the bot *impressive* rather than
   merely correct, and they are cheap there and expensive here.

**Keep this repo running until step 2 is proven.** It is not good, but it is honest and it is live —
and after §2's fix, its worst failure mode is gone.

---

## 5. What is genuinely good here — do not lose it in a migration

Worth naming, because a migration can quietly drop it:

- **Injection and social-engineering resistance.** Four attack styles in the July transcript, all
  handled correctly. This is hard to get right and it is right.
- **Honest AI disclosure.** Asked directly, it says it's an AI. No hedging.
- **The 7-second burst accumulator.** Multi-message bursts arrive as one block. Most competitors
  reply three times to three messages. This is a real quality edge and it is **not yet ported** to
  the engine.
- **Notify-before-promise ordering in `handleHandoff`.** The intent — confirm the action succeeded
  before telling the customer — is exactly right. It is only the implementation that is broken.

Carry all four across.
