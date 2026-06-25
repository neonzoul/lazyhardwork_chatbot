const line = require('@line/bot-sdk');
const config = require('./config');
const state = require('./state');
const { chat, hasBuyingSignal, extractLead } = require('./llm');
const { postLead, postCrmHandoff } = require('./discord');

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

// Spec §3: 6–7 s debounce (engineering spec uses 6.5 s)
const DEBOUNCE_MS = 6500;

const HANDOFF_PATTERNS = [
  /คุยกับคนจริง/,
  /ขอคุยกับมอส/,
  /อยากนัดคุย/,
  /คุยกับคน/,
  /ขอคุยกับคน/,
];

function isHandoffRequest(text) {
  return HANDOFF_PATTERNS.some((p) => p.test(text));
}

// Rich Menu button postback → canned reply text
const MENU_REPLIES = {
  MENU_SERVICES: `[Agent Lay]
📋 บริการของ LazyHardWork มี 3 อย่างหลักครับ:

1️⃣ LINE OA แชทบอต AI — ตอบลูกค้า / รับออเดอร์ / จองคิว อัตโนมัติ 24 ชม.
2️⃣ ออโตเมชันงานซ้ำด้วย AI — รวม lead / คีย์ข้อมูล / ตอบกลับ อัตโนมัติ
3️⃣ เซตอัป AI ผู้ช่วยให้ทีม — วาง Custom GPT/Claude + สอนทีมใช้

สนใจบริการไหนเป็นพิเศษมั้ยครับ?`,

  MENU_PORTFOLIO: `[Agent Lay]
💼 ผลงานของเราครับ:

✅ Fastwork 135 งาน · เรต 4.9★
✅ บอทตัวนี้ที่คุณกำลังคุยด้วยอยู่ก็เป็นผลงานของเรา
✅ ผู้สร้าง zFiN — AI ผู้ช่วยบัญชีที่ทำงานจริงบน LINE OA

ดูเพิ่มเติมได้ที่ Fastwork: ${config.contact.fastworkUrl}`,

  MENU_PRICING: `[Agent Lay]
💰 ราคาเริ่มต้น (ปรับตามขอบเขตจริง):

Starter → ฿15,000
Advanced → ฿20,000
Operation → ฿30,000

ดูแลรายเดือน: ฿2,500/เดือน
มัดจำ 50% ก่อนเริ่ม · ที่เหลือตอนส่งมอบ

อยากให้ Mos ประเมินงานของคุณโดยตรงมั้ยครับ?`,

  MENU_CONTACT: `[Agent Lay]
📞 ติดต่อเราได้เลยครับ:

📱 โทร: ${config.contact.phone}
📧 Email: ${config.contact.email}
🕑 เวลาทำการ: 13:00–22:00 ทุกวัน

หรือดูผลงานได้ที่ Fastwork: ${config.contact.fastworkUrl}`,
};

async function showTyping(userId) {
  try {
    await lineClient.showLoadingAnimation({ chatId: userId, loadingSeconds: 5 });
  } catch {
    // typing indicator is best-effort — ignore failures
  }
}

async function sendText(userId, text) {
  await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
}

// Fetch display name from LINE Profile API and cache in session (called once per user).
async function resolveDisplayName(userId) {
  const cached = state.getDisplayName(userId);
  if (cached) return cached;
  try {
    const profile = await lineClient.getProfile(userId);
    state.setDisplayName(userId, profile.displayName);
    return profile.displayName;
  } catch {
    return userId; // fallback to raw userId if profile fetch fails
  }
}

async function handleHandoff(userId, displayName, history) {
  state.setStatus(userId, state.WAITING_HUMAN);
  await sendText(userId, '[Agent Lay]\nได้เลยครับ\nกำลังประสานงานให้คุณมอสมาดูแลต่อนะครับ รบกวนรอสักครู่\nถ้าระหว่างรอมีอะไรอยากถามเพิ่มเติมก็ได้เลยครับ');
  const summary = history.length ? history[history.length - 1].content.slice(0, 100) : '—';
  await postCrmHandoff({ displayName, summary });
}

async function processMessage(userId, displayName, text) {
  const status = state.getStatus(userId);

  if (status === state.HUMAN_ACTIVE) return;

  if (status === state.WAITING_HUMAN) {
    await sendText(userId, '[Agent Lay]\nกำลังรอคุณมอสอยู่นะครับ\nรบกวนรอสักครู่');
    return;
  }

  // BOT_ACTIVE path
  if (isHandoffRequest(text)) {
    await handleHandoff(userId, displayName, state.getHistory(userId));
    return;
  }

  state.addMessage(userId, 'user', text);
  const historyBeforeReply = state.getHistory(userId).slice(0, -1);

  const { reply } = await chat(userId, text, historyBeforeReply);
  state.addMessage(userId, 'assistant', reply);

  await sendText(userId, reply);

  // Lead capture: fire async after replying so it doesn't block the response
  if (hasBuyingSignal(text)) {
    extractLead(displayName, state.getHistory(userId))
      .then((lead) => postLead(lead))
      .catch(console.error);
  }
}

async function processPostback(userId, displayName, data) {
  if (data === 'MENU_HANDOFF') {
    if (state.getStatus(userId) === state.BOT_ACTIVE) {
      await handleHandoff(userId, displayName, state.getHistory(userId));
    } else {
      await sendText(userId, '[Agent Lay]\nกำลังรอคุณมอสอยู่นะครับ\nรบกวนรอสักครู่');
    }
    return;
  }

  const reply = MENU_REPLIES[data];
  if (reply) {
    await sendText(userId, reply);
  }
}

// Lossless debounce accumulator for text messages
function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'postback') {
    resolveDisplayName(userId).then(name =>
      processPostback(userId, name, event.postback.data)
    ).catch(console.error);
    return;
  }

  if (event.type === 'follow') {
    resolveDisplayName(userId).catch(() => {}); // warm cache on follow
    sendText(userId, '[Agent Lay]\nสวัสดีครับ 🙏 ยินดีต้อนรับสู่ LazyHardWork นะครับ มีอะไรให้ช่วยได้บ้าง หรือมีบริการไหนที่สนใจเป็นพิเศษมั้ยครับ?').catch(console.error);
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text;

  state.pushPendingMessage(userId, text);

  const existing = state.getPendingTimer(userId);
  if (existing) clearTimeout(existing);

  // Show typing indicator immediately — best-effort
  showTyping(userId);

  const timer = setTimeout(() => {
    state.setPendingTimer(userId, null);
    const burst = state.drainPendingMessages(userId);
    resolveDisplayName(userId)
      .then(name => processMessage(userId, name, burst))
      .catch(console.error);
  }, DEBOUNCE_MS);

  state.setPendingTimer(userId, timer);
}

module.exports = { handleEvent };
