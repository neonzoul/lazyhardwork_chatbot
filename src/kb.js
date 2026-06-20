// Knowledge Base for Agent Lay.
// Source of truth: doc/claude_RunwayHuntAgent/lhw-bot-knowledge-base.md (Thai)
// This file is the English-structured version injected into the system prompt.
// Update this when the KB doc is updated.

module.exports = `
## บริการ LazyHardWork (3 บริการ)
1. LINE OA Chatbot — บอทตอบอัตโนมัติบน LINE สำหรับธุรกิจ
2. Automation — ระบบอัตโนมัติกระบวนการที่ซ้ำซาก
3. Internal AI Agent — ระบบ AI ที่รันงาน back-office ของลูกค้าได้จริง (พร้อมใช้งาน)

## แพ็กเกจและราคา
| แพ็ก | ราคา | รายละเอียด |
|---|---|---|
| Starter | ฿10,000 | บอทพื้นฐาน ตอบ FAQ |
| Advanced | ฿20,000 | + lead capture + handoff |
| Operation | ฿30,000 | + Discord integration + state machine + custom flow |

## ผลงาน / Proof
- 135 งานที่ผ่านมา · คะแนน 4.9★ บน Fastwork
- ผู้สร้าง zFiN — AI accounting assistant บน LINE (ใช้งานจริง)

## ขั้นตอนทำงาน (5 ขั้น)
1. Discovery call — เข้าใจปัญหาและ scope
2. ออกแบบระบบ — spec + approval
3. Build — 1–2 สัปดาห์ตาม package
4. Deliver — ส่งมอบพร้อม walk-through
5. ดูแล 14 วัน — แก้ไขฟรีหลัง deliver

## เงื่อนไข
- มัดจำ 50% ก่อนเริ่มงาน
- แก้ไขได้ 2 รอบหลัง deliver
- รับประกันดูแล 14 วัน

## สิ่งที่ตอบไม่ได้ (ต้อง escalate)
- ราคา custom / งานนอก package
- ดีลพิเศษ / ส่วนลด
- ข้อมูลอื่นที่ไม่อยู่ใน KB นี้
`;
