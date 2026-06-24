const OpenAI = require('openai');
const config = require('./config');
const agentConfig = require('./agents.config');
const { postCrmFeedback } = require('./discord');

const client = new OpenAI({ apiKey: config.llm.apiKey });

// Load KB content at startup (see kb.js — injected into system prompt as full-context)
const KB = require('./kb');

// Agent model slot for this module (spec §7.2)
const { model, maxTokens } = agentConfig.agentLay;

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
- Fastwork: ${config.contact.fastworkUrl}
- เวลาทำการ: ${config.contact.hoursStart}:00–${config.contact.hoursEnd}:00 ทุกวัน

Knowledge Base:
${KB}

กฎการตอบ:
1. ตอบจาก KB เท่านั้น — ห้ามแต่งข้อมูลที่ไม่มีใน KB
2. หากไม่มีข้อมูลในคำถามนั้น → บอกตรงๆ ว่าไม่มี แล้วถามว่าจะ (ก) ให้ส่งคำถามให้ Mos หรือ (ข) โทร/email โดยตรง
3. ราคา custom / ดีลพิเศษ / ส่วนลด → ต้อง escalate ไม่ตอบเอง
4. ขอข้อมูล lead เฉพาะเมื่อลูกค้าแสดง buying signal เท่านั้น (เช่น "สนใจจ้าง", "เริ่มยังไง")
${!isWithinBusinessHours() ? `\nขณะนี้นอกเวลาทำการ (${config.contact.hoursStart}:00–${config.contact.hoursEnd}:00) — แจ้งลูกค้าว่าจะมีคนมาตอบให้เร็วที่สุด และยังถามเพิ่มได้` : ''}`;
}

// Returns { reply: string, kbGap: string|null }
async function chat(userId, userMessage, history) {
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
  });

  const reply = response.choices[0].message.content;

  // KB gap heuristic — triggers Discord #crm feedback if KB appears to lack the answer
  const kbGap = reply.includes('ไม่มีข้อมูล') || reply.includes('ไม่ทราบ')
    ? userMessage
    : null;

  if (kbGap) {
    await postCrmFeedback({ question: kbGap });
  }

  return { reply, kbGap };
}

// Buying-signal detection — used by bot.js to decide when to capture lead
const BUYING_SIGNALS = [
  /สนใจจ้าง/, /อยากจ้าง/, /จ้างทำ/, /ราคาเท่าไหร่สำหรับ/, /ทำให้.*ได้ไหม/,
  /เริ่มยังไง/, /สนใจสั่ง/, /อยากเริ่ม/, /ทดลองใช้/, /อยากซื้อ/, /จะซื้อ/,
];

function hasBuyingSignal(text) {
  return BUYING_SIGNALS.some((p) => p.test(text));
}

// Second LLM call to extract structured lead fields from conversation history
async function extractLead(displayName, history) {
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'ลูกค้า' : 'บอท'}: ${m.content}`)
    .join('\n');

  const response = await client.chat.completions.create({
    model,
    max_tokens: 512,
    messages: [
      { role: 'system', content: 'Extract lead info from this LINE chat transcript. Reply ONLY with valid JSON, no explanation, no markdown.' },
      { role: 'user', content: `Transcript:\n${transcript}\n\nExtract into JSON (use "—" for unknown fields):\n{"name":"","business":"","problem":"","budget":"","contact":"","keyRemark":""}` },
    ],
  });

  try {
    const text = response.choices[0].message.content.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const lead = JSON.parse(text.slice(start, end + 1));
    if (!lead.name || lead.name === '—') lead.name = displayName;
    return lead;
  } catch {
    return { name: displayName, business: '—', problem: '—', budget: '—', contact: '—', keyRemark: '—' };
  }
}

module.exports = { chat, hasBuyingSignal, extractLead };
