v1.1 Refinement — Issue List & Requirements

Repo: github.com/neonzoul/lazyhardwork_chatbot
Base: current main (v1.0, all 9 acceptance criteria passed)
Target branch: fix/v1.1-refinements

---

Issue 1 — Lead detection fires too early with empty fields, misses explicit leads

File: src/bot.js

Observed behavior:

- At 11:38, "สยใจทำ line chatbot" triggered lead notify to Discord with all fields empty: ชื่อ: ลูกค้า · ธุรกิจ: — · ปัญหา: — · งบ: — · ติดต่อ: —
- At 11:40, user explicitly provided: ชื่อ แดง, ธุรกิจ สอนกีต้าร์, ปัญหา ตอบลูกค้าไม่ทัน, งบ 30k, ช่องทาง LINE — no Discord notify fired

Root cause (two separate problems):

1. Heuristic triggers on buying-signal keyword alone, before any lead data is in the conversation
2. When a user provides full lead info in free text (name/business/problem/budget/contact), the heuristic doesn't recognize it as a lead trigger

Requirements:

1. Gate the lead notify behind minimum data — only fire #leads Discord notify when at least 2 of these fields are non-empty: name, business, problem, budget. If keyword fires but fields are empty, skip the notify silently (no false positives).
2. Add a free-text lead pattern — if within one message or burst the user provides ≥3 of: a Thai name, a business type, a problem statement, a budget number (e.g. 30k, 30,000, สามหมื่น), treat it as a lead trigger regardless of keyword match. Extract those fields into the lead payload.
3. Lead payload extraction — when a lead fires, the keyRemark field must be a 1-sentence bot-generated summary of the conversation (what the user wants + budget). Currently it is left as a static string.

---

Issue 2 — Double ครับ at end of some responses (criterion #9 Thai typo)

File: src/llm.js → buildSystemPrompt()

Observed behavior:
Responses occasionally end with duplicated ครับ:

- ...สอบถามได้เลยนะครับ ครับ
- ...สอบถามได้บ้างครับ? ครับ
- ...โทรตรงได้เลยครับ? ครับ

Root cause: The sign-off rule in the system prompt instructs the model to end with [Agent Lay] and the model's natural Thai politeness appends ครับ twice when the instruction conflicts with the in-context sentence ending.

Requirement:
Update the sign-off instruction in buildSystemPrompt() to explicitly forbid trailing ครับ after the sign-off tag. Suggested wording to add to the rules block:

ห้ามลงท้ายด้วย "ครับ" ซ้ำ — ถ้าประโยคสุดท้ายจบด้วย "ครับ" แล้ว ไม่ต้องเพิ่ม "ครับ" อีก

---

Issue 3 — Technical jargon in Operation package description (KB content)

File: knowledge/kb.md → pricing/packages section

Observed behavior:
Bot described Operation pack as: "เหมาะกับงานครบ, หลายระบบ, debounce + handoff + discord" — "debounce" is internal engineering terminology, not client-facing language.

Requirement:
Replace the Operation package description with client-friendly copy. Suggested:
Operation → ฿30,000
เหมาะกับงานครบวงจร — หลายระบบ, ส่งต่อทีมอัตโนมัติ, แจ้งเตือน real-time

---

Acceptance criteria for v1.1

- [ ] Discord #leads does NOT fire when lead fields are all empty
- [ ] แดง-style message (name + business + problem + budget in one burst) → fires #leads with populated fields
- [ ] No response ends with double ครับ or ครับ ครับ
- [ ] Operation package description contains no technical jargon (no "debounce", "handoff", "discord" as feature names)
- [ ] All 9 original v1.0 acceptance criteria still pass
