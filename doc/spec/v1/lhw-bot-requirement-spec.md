# LazyHardWork LINE OA Bot — Requirement Spec v1.0

**Client:** LazyHardWork (ลูกค้ารายแรก = ตัวเราเอง)
**Package:** Operation · ฿30,000
**Timeline:** 2 สัปดาห์ (21/06 – 07/07/26)
**Implementer:** Codex / Claude Code / Antigravity
**Language:** Bot UI = Thai · Code + Spec = English

---

## 1. CLIENT KNOWLEDGE OBJECT

```yaml
CLIENT: LazyHardWork (LHW)
BUSINESS_TYPE: Premium AI Workflow Studio
PROBLEM: Mos operates solo — needs bot to filter serious leads,
    answer FAQs, and capture contact before reaching Mos
DESIRED_OUTCOME: Leads arrive pre-qualified to Mos via Discord.
    Bot handles everything below human judgment threshold.
SCOPE: LINE OA Bot · Operation package · Phase 1
TONE:
    style: 'Admin with service mind — natural, not obviously AI, not pretending to be human'
    sign_off: '[Agent Lay]' # every response ends with this
    sample: 'สวัสดีครับ มีบริการอะไรที่สนใจเป็นพิเศษมั้ยครับ?'
CONTACT:
    phone: '0955691674' # configurable — do not hard-code in prompt
    email: 'naruecha.ps@hotmail.com' # configurable
    business_hours: '13:00–22:00 daily'
SUCCESS_METRIC:
    - Bot answers from KB only — zero hallucination
    - Leads delivered to Discord with full summary
    - Users feel no friction; want to talk to a human (not because bot failed)
```

---

## 2. BOT PERSONA

| Field            | Value                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Name             | Agent Lay                                                                                                                     |
| Sign-off         | ลงท้ายทุก response ด้วย `[Agent Lay]`                                                                                         |
| Style            | Admin / service-minded / natural                                                                                              |
| AI disclosure    | ไม่แอบอ้างว่าเป็นคน แต่ไม่ต้องประกาศว่าเป็น AI ในทุกข้อความ                                                                   |
| Greeting         | สั้น เข้าประเด็น ทิ้งปลายเปิดให้ลูกค้า action ต่อ                                                                             |
| Greeting example | "สวัสดีครับ 🙏 ยินดีต้อนรับสู่ LazyHardWork นะครับ มีอะไรให้ช่วยได้บ้าง หรือมีบริการไหนที่สนใจเป็นพิเศษมั้ยครับ? [Agent Lay]" |

---

## 3. CONVERSATION MEMORY

- **Window:** จำ 10 ข้อความล่าสุดของบทสนทนาปัจจุบัน (ไม่ข้าม session)
- **Typing debounce:** รอ 6–7 วินาทีหลังข้อความล่าสุด ก่อนส่งไปประมวลผล
    - ระหว่างรอ: แสดง "typing…" animation
    - เหตุผล: กันบอทตอบกลางประโยคเมื่อลูกค้าพิมพ์ยาวหลายข้อความ
- **Tech note:** ใช้ debounce logic จากโปรเจกต์เก่าของ Mos ต่อยอดได้

---

## 4. KNOWLEDGE BASE RULES

**ตอบได้เอง (from KB):**

- บริการ LHW ทั้ง 3 (ดูรายละเอียดใน lhw-bot-knowledge-base.md)
- ราคาแพ็ก Starter / Advanced / Operation
- ขั้นตอนทำงาน (5 ขั้น)
- เงื่อนไข (มัดจำ / แก้ไข / ดูแล 14 วัน)
- ผลงาน/proof (135 งาน · 4.9★ · ผู้สร้าง zFiN)
- ข้อมูลติดต่อ (เบอร์ / email) — แจกได้เลย ไม่มีเงื่อนไข

**ห้ามตอบเอง (ต้อง escalate):**

- ราคางานเฉพาะ (custom quote) ที่นอก KB
- ดีลพิเศษ / ส่วนลด
- ทุกอย่างที่ไม่มีใน KB

**เมื่อไม่รู้:**

1. บอกตรงๆ ว่าไม่มีข้อมูลส่วนนี้
2. ถามลูกค้าว่าจะ: (ก) ให้ส่งคำถามให้ Mos ไปตอบเอง หรือ (ข) โทร/email โดยตรง
3. ส่ง feedback ไปที่ Discord #crm พร้อมคำถามที่ลูกค้าถาม (เพื่อ Mos review และอัปเดต KB ทีหลัง)

---

## 5. LEAD CAPTURE FLOW

**เงื่อนไขการขอ contact:** เฉพาะเมื่อลูกค้าแสดงความสนใจจริง (buying signal)

- สัญญาณ: "สนใจจ้าง", "ราคาเท่าไหร่สำหรับงานผม", "ทำให้ผมได้ไหม", "เริ่มยังไง"
- ไม่ขอ contact ตั้งแต่แรกทัก — รอสัญญาณก่อน

**ข้อมูลที่เก็บ:**

```
- ชื่อ (หรือชื่อร้าน/ธุรกิจ)
- ประเภทธุรกิจ
- ปัญหาหลักที่อยากแก้
- งบประมาณ (ถ้าบอก)
- ช่องทางติดต่อ (LINE / เบอร์ / email)
- key_remark: สรุปบทสนทนาสั้นๆ (บอทสรุปเอง)
```

**Discord notification format (#leads):**

```
🟢 New Lead
ชื่อ: {name}
ธุรกิจ: {business}
ปัญหา: {problem}
งบ: {budget}
ติดต่อ: {contact}
ช่องทาง: LINE OA
เวลา: {timestamp}
สรุป: {key_remark}
```

---

## 6. HUMAN HANDOFF

### 6.1 สถานะ

| Status          | ความหมาย    | บอททำอะไร                                  |
| --------------- | ----------- | ------------------------------------------ |
| `BOT_ACTIVE`    | บอทดูแลปกติ | ตอบตาม KB                                  |
| `WAITING_HUMAN` | รอคนมาตอบ   | หยุด response ในแชทนี้ ยกเว้น auto-message |
| `HUMAN_ACTIVE`  | คนมาตอบแล้ว | บอทหยุดสมบูรณ์ จนกว่าคนจะเปลี่ยนสถานะกลับ  |

### 6.2 Trigger เปลี่ยนเป็น WAITING_HUMAN

- ลูกค้ากดปุ่ม "คุยกับคนจริง" ใน Rich Menu
- ลูกค้าพิมพ์ขอคุยกับคน / "ขอคุยกับมอส" / "อยากนัดคุย"
- บอทตอบไม่ได้ และลูกค้ายืนยันอยากรอคน

### 6.3 เมื่อเปลี่ยนเป็น WAITING_HUMAN

1. บอทส่งข้อความลูกค้า:
    > "ได้เลยครับ กำลังประสานงานให้คุณมอสมาดูแลต่อนะครับ รบกวนรอสักครู่ ถ้าระหว่างรอมีอะไรอยากถามเพิ่มเติมก็ได้เลยครับ [Agent Lay]"
2. ส่ง notification ไปที่ Discord **#crm**:
    ```
    🔴 Human Required
    ลูกค้า: {name หรือ LINE display name}
    เรื่อง: {สรุปสั้นๆ}
    เวลา: {timestamp}
    สถานะ: WAITING_HUMAN
    ```
3. บอทหยุด respond ในแชทนี้ (ยกเว้นถ้าลูกค้าถามใหม่ → ตอบว่า "กำลังรอคุณมอสมาดูแลอยู่นะครับ [Agent Lay]")

### 6.4 นอกเวลาทำการ (หลัง 22:00 / ก่อน 13:00)

- บอทยังทำงานปกติใน scope KB
- เมื่อลูกค้าต้องการคน นอกเวลาทำการ:
    1. บอทบอก: "ตอนนี้นอกเวลาทำการครับ (บ่ายโมง–2 ทุ่ม) จะมีคนมาตอบให้เร็วที่สุดนะครับ [Agent Lay]"
    2. ส่งไป Discord #crm เหมือนปกติ
    3. บอทถามต่อ: "ระหว่างรอมีอะไรอยากถามเพิ่มอีกมั้ยครับ? หรือถ้าเร่งด่วนโทรตรงได้เลยครับ 📞 {phone}"
    4. บอทยังคง `BOT_ACTIVE` — คนมาปิดเป็น `HUMAN_ACTIVE` เอง

### 6.5 Resume

- คนเปลี่ยนสถานะกลับเป็น `BOT_ACTIVE` manual เท่านั้น
- ไม่มี auto-resume ในเฟสนี้

---

## 7. RICH MENU

5 ปุ่ม:

| ปุ่ม            | Action                                                |
| --------------- | ----------------------------------------------------- |
| 📋 บริการ       | ส่ง quick reply สรุปบริการ 3 อย่าง + ลิงก์ Fastwork   |
| 💼 ผลงาน        | ส่งข้อความสรุปผลงาน (135 งาน · 4.9★ · zFiN) + ลิงก์   |
| 💰 ราคา         | ส่งตารางราคา Starter/Advanced/Operation ทั้ง 3 บริการ |
| 👤 คุยกับคนจริง | Trigger WAITING_HUMAN flow                            |
| 📞 ติดต่อ       | ส่งเบอร์ + email โดยตรง                               |

---

## 8. CONTACT INFO (CONFIGURABLE)

เก็บใน config file แยก (ไม่ hard-code ใน prompt):

```env
CONTACT_PHONE=0955691674
CONTACT_EMAIL=naruecha.ps@hotmail.com
BUSINESS_HOURS_START=13:00
BUSINESS_HOURS_END=22:00
DISCORD_LEADS_CHANNEL=#leads
DISCORD_CRM_CHANNEL=#crm
```

---

## 9. TECHNICAL SCOPE

### In scope (เฟสนี้)

- LINE Messaging API webhook
- LLM (Claude / GPT) ตอบจาก KB + system prompt
- Conversation memory: 10 ข้อความล่าสุด per user
- Typing debounce: 6–7 วินาที
- Status state machine: BOT_ACTIVE / WAITING_HUMAN / HUMAN_ACTIVE
- Discord webhook: #leads (lead capture) + #crm (human handoff + feedback)
- Rich Menu: 5 ปุ่ม
- Contact info จาก config (ไม่ hard-code)

### Out of scope (เฟสนี้ — ทำทีหลัง)

- Cross-session memory (จำข้ามวัน)
- ดึงข้อมูลสด (Sheet / ปฏิทิน / ราคาเรียลไทม์)
- Auto-resume หลังคนตอบจบ
- Analytics dashboard / รายงานสรุป lead อัตโนมัติ
- บอทโทรออก / ระบบโทรอัตโนมัติ
- Multi-language

---

## 10. SIGN-OFF RULE

ทุก response จาก bot ต้องลงท้ายด้วย `[Agent Lay]`
ห้ามละเว้น — นี่คือ identity marker ที่ทำให้ลูกค้ารู้ว่ากำลังคุยกับ Agent Lay เสมอ

---

## 11. QUALITY BAR (Definition of Done)

- [x] ตอบจาก KB เท่านั้น — ไม่มี hallucination
- [x] ทุก response ลงท้าย [Agent Lay]
- [ ] Lead ส่ง Discord ครบทุก field
- [ ] Human handoff ทำงานถูก (WAITING_HUMAN → notify #crm → บอทหยุด)
- [ ] นอกเวลาทำการ: บอทยังทำงานใน KB scope + แจ้งลูกค้า
- [x] Rich Menu 5 ปุ่มทำงานครบ
- [ ] Contact info อ่านจาก config — เปลี่ยนได้โดยไม่แก้โค้ด
- [x] Typing debounce 6–7 วิทำงาน
- [ ] ไม่มี Thai typo ในข้อความบอท
