const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('./config');
const { postCrmFeedback } = require('./discord');

const client = new Anthropic({ apiKey: config.llm.apiKey });

// Load KB content at startup (see kb.js — injected into system prompt)
const KB = require('./kb');

function isWithinBusinessHours() {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }),
    10
  );
  return hour >= config.contact.hoursStart && hour < config.contact.hoursEnd;
}

function buildSystemPrompt() {
  return `คุณคือ Agent Lay ผู้ช่วยของ LazyHardWork (LhW)
สไตล์: admin + service mind — เป็นธรรมชาติ ไม่แอบอ้างว่าเป็นคน แต่ไม่ต้องประกาศว่าเป็น AI ทุกข้อความ
ลงท้ายทุก response ด้วย [Agent Lay] ห้ามละเว้น

ข้อมูลติดต่อ:
- เบอร์: ${config.contact.phone}
- อีเมล: ${config.contact.email}
- เวลาทำการ: ${config.contact.hoursStart}:00–${config.contact.hoursEnd}:00 ทุกวัน

Knowledge Base:
${KB}

กฎการตอบ:
1. ตอบจาก KB เท่านั้น — ห้ามแต่งข้อมูลที่ไม่มีใน KB
2. หากไม่มีข้อมูลในคำถามนั้น → บอกตรงๆ ว่าไม่มี แล้วถามว่าจะ (ก) ให้ส่งคำถามให้ Mos หรือ (ข) โทร/email โดยตรง
3. ราคา custom / ดีลพิเศษ / ส่วนลด → ต้อง escalate ไม่ตอบเอง
4. ขอข้อมูล lead เฉพาะเมื่อลูกค้าแสดง buying signal เท่านั้น (เช่น "สนใจจ้าง", "เริ่มยังไง")

${!isWithinBusinessHours() ? `ขณะนี้นอกเวลาทำการ (${config.contact.hoursStart}:00–${config.contact.hoursEnd}:00) — แจ้งลูกค้าว่าจะมีคนมาตอบให้เร็วที่สุด` : ''}`;
}

// Returns { reply: string, kbGap: string|null, lead: object|null }
async function chat(userId, userMessage, history) {
  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: config.llm.model,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    messages,
  });

  const reply = response.content[0].text;

  // Heuristic: detect KB gap signal from the model's reply to trigger Discord feedback
  const kbGap = reply.includes('ไม่มีข้อมูล') || reply.includes('ไม่ทราบ')
    ? userMessage
    : null;

  if (kbGap) {
    await postCrmFeedback({ question: kbGap });
  }

  return { reply, kbGap };
}

module.exports = { chat };
