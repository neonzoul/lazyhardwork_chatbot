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
ขึ้นต้นทุก response ด้วย [Agent Lay] แล้วขึ้นบรรทัดใหม่ ห้ามละเว้น และห้ามใส่ [Agent Lay] ที่ท้ายข้อความอีกครั้ง — ใส่ได้ครั้งเดียวที่ต้นเท่านั้น
ห้ามใช้ markdown เช่น ** __ ## — ข้อความต้องเป็น plain text เท่านั้น เพราะ LINE ไม่รองรับ markdown
เมื่อข้อความยาว ให้ขึ้นบรรทัดใหม่ที่จุดหยุดธรรมชาติเพื่อให้อ่านง่ายบนมือถือ

ข้อมูลติดต่อ:
- เบอร์: ${config.contact.phone}
- อีเมล: ${config.contact.email}
- Fastwork: ${config.contact.fastworkUrl}
- เวลาทำการ: ${config.contact.hoursStart}:00–${config.contact.hoursEnd}:00 ทุกวัน

Knowledge Base:
${KB
  .replace(/{CONTACT_PHONE}/g, config.contact.phone)
  .replace(/{CONTACT_EMAIL}/g, config.contact.email)
  .replace(/{FASTWORK_URL}/g, config.contact.fastworkUrl)
  .replace(/{HOURS_START}/g, config.contact.hoursStart)
  .replace(/{HOURS_END}/g, config.contact.hoursEnd)
}

กฎการตอบ:
1. ตอบจาก KB เท่านั้น — ห้ามแต่งข้อมูลที่ไม่มีใน KB ห้ามสร้าง URL ใดๆ ที่ไม่ได้ระบุไว้ใน KB อย่างชัดเจน
2. หากไม่มีข้อมูลในคำถามนั้น → บอกตรงๆ ว่าไม่มี แล้วถามว่าจะ (ก) ให้ส่งคำถามให้ Mos หรือ (ข) โทร/email โดยตรง
3. ราคา custom / ดีลพิเศษ / ส่วนลด → ต้อง escalate ไม่ตอบเอง
4. ขอข้อมูล lead เฉพาะเมื่อลูกค้าแสดง buying signal เท่านั้น (เช่น "สนใจจ้าง", "เริ่มยังไง")
5. ห้ามลงท้ายด้วย "ครับ" ซ้ำ — ถ้าประโยคสุดท้ายจบด้วย "ครับ" แล้ว ไม่ต้องเพิ่ม "ครับ" อีก
${!isWithinBusinessHours() ? `\nขณะนี้นอกเวลาทำการ (${config.contact.hoursStart}:00–${config.contact.hoursEnd}:00 ทุกวัน)
ห้ามบอกว่า "ติดต่อได้เลย" หรือ "โทรได้เลยตอนนี้" — เพราะยังไม่ถึงเวลาทำการ
ถ้าลูกค้าถามว่าโทรได้ไหม / ติดต่อได้ทันทีไหม → บอกว่านอกเวลาทำการ แนะนำให้โทรช่วง ${config.contact.hoursStart}:00–${config.contact.hoursEnd}:00 หรือฝากข้อความไว้ได้` : ''}`;
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

  // Strip trailing [Agent Lay] if the LLM duplicated the sign-off it was told to put at the start
  const raw = response.choices[0].message.content;
  const reply = raw.replace(/\s*\[Agent Lay\]\s*$/i, '').trimEnd();

  // KB gap heuristic — triggers Discord #crm feedback if KB appears to lack the answer
  const KB_GAP_SIGNALS = ['ไม่มีข้อมูล', 'ไม่ทราบ', 'ไม่ได้รับข้อมูล', 'ไม่สามารถตอบ', 'ไม่มีในข้อมูล', 'นอกขอบเขต', 'ไม่ครอบคลุม'];
  const kbGap = KB_GAP_SIGNALS.some(s => reply.includes(s)) ? userMessage : null;

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

// Free-text lead pattern — fires when user provides ≥3 of: name, business type, problem, budget
// Catches leads that skip buying-signal keywords and go straight to providing details
const FREE_TEXT_LEAD_SIGNALS = [
  { key: 'name',     pattern: /ชื่อ\s*[ก-๙a-zA-Z]{2,}/ },
  { key: 'business', pattern: /ธุรกิจ|ร้าน|สอน|ขาย|บริษัท|คลินิก|โรงแรม|คาเฟ่|สตูดิโอ|ฟิตเนส|สปา/ },
  { key: 'problem',  pattern: /ปัญหา|ตอบไม่ทัน|ไม่มีคน|ทำเอง|ลูกค้าเยอะ|พลาด|ช้าไป/ },
  { key: 'budget',   pattern: /\b\d+\s*[kK]\b|\d[\d,]{3,}\s*(?:บาท|฿)|หมื่น|แสน/ },
];

function hasLeadPattern(text) {
  return FREE_TEXT_LEAD_SIGNALS.filter(s => s.pattern.test(text)).length >= 3;
}

// Second LLM call to extract structured lead fields from conversation history
async function extractLead(displayName, history) {
  // Label roles unambiguously so the LLM cannot confuse "[Customer]" with a person's name
  const transcript = history
    .map((m) => `${m.role === 'user' ? '[Customer]' : '[Agent]'}: ${m.content}`)
    .join('\n');

  const response = await client.chat.completions.create({
    model,
    max_tokens: 512,
    messages: [
      {
        role: 'system',
        content:
          'Extract lead info from [Customer] lines only — ignore [Agent] lines entirely.\n' +
          'Rules:\n' +
          '- "name": customer\'s real name if they stated it. "[Customer]" is a role label, NOT a name — use "—" if no name given.\n' +
          '- "budget": only if the customer explicitly stated a number. Do NOT use prices mentioned by [Agent].\n' +
          '- "contact": customer\'s phone/email/LINE ID, NOT the business contact info.\n' +
          '- "keyRemark": 1 Thai sentence — what the customer wants + their budget (e.g. "ต้องการบอท LINE สำหรับร้านสอนกีต้าร์ งบ 20,000 บาท").\n' +
          '- Use "—" for any field not explicitly stated by the customer.\n' +
          'Reply ONLY with valid JSON, no explanation, no markdown.',
      },
      { role: 'user', content: `Transcript:\n${transcript}\n\nExtract into JSON:\n{"name":"","business":"","problem":"","budget":"","contact":"","keyRemark":""}` },
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

module.exports = { chat, hasBuyingSignal, hasLeadPattern, extractLead };
