---
type: instruction
status: active
owner: Mos
lang: en
issued: 2026-08-07
audience: "CodeArea — repo neonzoul/lazyhardwork_chatbot @ main"
priority: P1
scope: "One bug. Do not refactor anything else in this repo."
tags: [instruction, bugfix, handoff, production, p1]
links:
  - Clients/000_lazyhardwork/PJ_lineOA_chatcot_v1/gap-vs-discovery-2026-08-06.md
---

# FIX: the bot can promise a handoff that nobody hears

**Repo:** `neonzoul/lazyhardwork_chatbot` @ `main` — the live production bot.
**Estimated time:** 30 minutes including the test.
**Scope discipline:** this repo is being replaced. Fix *only* what is below. Do not refactor, do not
restructure, do not add features. Every extra line here is throwaway work.

---

## The bug

`src/discord.js` — all three functions end the same way:

```js
await axios.post(config.discord.crmWebhook, { content }).catch(console.error);
```

That trailing `.catch` swallows the error, so **`postCrmHandoff` can never throw.**

Which makes this, in `src/bot.js` → `handleHandoff`, unreachable dead code:

```js
try {
    await postCrmHandoff({ displayName, summary });
} catch (err) {
    // tell the customer to contact Mos directly instead of making a broken promise
}
```

There is a second, quieter version of the same bug on the line above it:

```js
if (!config.discord.crmWebhook) return;
```

If the webhook env var is unset or misconfigured, the function returns successfully having done
nothing at all.

**Consequence.** If Discord is down, or the webhook is misconfigured, the customer is told
*"ได้เลยครับ ส่งเรื่องให้คุณมอสแล้ว"* — and **nobody is notified.** They wait for someone who is
never coming. The one code path whose entire job is "never make a promise we can't keep" is the path
that silently makes one.

This is the worst failure mode in the system. It is also a five-character fix.

---

## What to change

### 1. `src/discord.js` — let the caller see failures

- **`postCrmHandoff`** — remove the trailing `.catch(console.error)`, and make the missing-webhook
  case throw instead of returning silently. The caller has a real fallback for both, and it must be
  allowed to run.
- **`postLead`** and **`postCrmFeedback`** — **leave the `.catch` in place.** These are
  fire-and-forget; a failed lead log should not break a conversation the customer is still having.
  Only the handoff path makes a promise to a customer, and only the handoff path needs to know.

### 2. `src/bot.js` — verify the existing fallback actually works

The `try/catch` in `handleHandoff` is already correct in shape. Confirm two things:

- the customer-facing failure message contains a **real, working contact route** (phone and/or
  email from config) — not just an apology
- the customer is **not** told the handoff succeeded anywhere on the failure path, and the session
  is **not** left in `WAITING_HUMAN` (a state where the bot has stopped answering *and* nobody was
  notified is a dead end with no exit)

### 3. `#crm` message — add `userId`

`README.md` and `/admin/docs` both document that the `#crm` notification includes the LINE `userId`.
It does not. That makes the documented recovery procedure impossible to follow — Mos cannot reply to
a customer he cannot identify. Add it to the `postCrmHandoff` payload.

---

## How to prove it (required — do not skip)

The absence of this test is the reason the bug survived. **Add a test that forces the notification
transport to throw** (mock `axios.post` to reject, or point the webhook at an unreachable URL) and
asserts:

1. `postCrmHandoff` **rejects** — it does not resolve
2. `handleHandoff`'s catch block runs
3. the message sent to the customer is the failure message, containing the contact details
4. the phrase `ส่งเรื่องให้คุณมอสแล้ว` (or any equivalent success claim) appears **nowhere** in what
   the customer receives on this path

Repeat #1 with `crmWebhook` unset — it must reject there too.

---

## Out of scope — explicitly

Do **not** touch, in this ticket: the `pendingHandoffOffer` / `/ได้เลย/` substring-match bug, the
missing `try/catch` around the OpenAI call, the Rich Menu, the KB, or anything about cards, quick
replies, or booking.

Those are real problems and they are all being solved by migrating to
`neonzoul/lhw000_demo_factory` — see `conversation-flow-2026-08-07.md`. Building them here would be
work thrown away twice: once when written, once when migrated.

**This ticket exists for one reason: the live bot must stop being able to lie, today.**
