const line = require('@line/bot-sdk');
const config = require('./config');
const state = require('./state');
const { chat } = require('./llm');
const { postCrmHandoff } = require('./discord');

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const DEBOUNCE_MS = 6500; // spec §3: 6–7 sec

// Human handoff trigger phrases
const HANDOFF_PATTERNS = [
  /คุยกับคนจริง/,
  /ขอคุยกับมอส/,
  /อยากนัดคุย/,
  /คุยกับคน/,
];

function isHandoffRequest(text) {
  return HANDOFF_PATTERNS.some((p) => p.test(text));
}

function isWithinBusinessHours() {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }),
    10
  );
  return hour >= config.contact.hoursStart && hour < config.contact.hoursEnd;
}

async function handleHandoff(userId, displayName, summary) {
  state.setStatus(userId, state.WAITING_HUMAN);
  await lineClient.pushMessage({
    to: userId,
    messages: [{
      type: 'text',
      text: 'ได้เลยครับ กำลังประสานงานให้คุณมอสมาดูแลต่อนะครับ รบกวนรอสักครู่ ถ้าระหว่างรอมีอะไรอยากถามเพิ่มเติมก็ได้เลยครับ [Agent Lay]',
    }],
  });
  await postCrmHandoff({ displayName, summary });
}

async function processMessage(userId, displayName, text) {
  const status = state.getStatus(userId);

  if (status === state.HUMAN_ACTIVE) return; // bot is fully silent

  if (status === state.WAITING_HUMAN) {
    await lineClient.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: 'กำลังรอคุณมอสมาดูแลอยู่นะครับ [Agent Lay]' }],
    });
    return;
  }

  // BOT_ACTIVE
  if (isHandoffRequest(text)) {
    const history = state.getHistory(userId);
    const summary = history.length ? history[history.length - 1].content.slice(0, 80) : text;
    await handleHandoff(userId, displayName, summary);
    return;
  }

  state.addMessage(userId, 'user', text);
  const history = state.getHistory(userId);

  const { reply } = await chat(userId, text, history.slice(0, -1)); // history before this msg
  state.addMessage(userId, 'assistant', reply);

  await lineClient.pushMessage({
    to: userId,
    messages: [{ type: 'text', text: reply }],
  });
}

// Entry point called by the webhook handler.
// Applies 6–7 sec debounce per user so multi-message bursts are batched.
function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = event.message.text;
  const displayName = event.source.displayName || userId;

  const existing = state.getPendingTimer(userId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    state.setPendingTimer(userId, null);
    processMessage(userId, displayName, text).catch(console.error);
  }, DEBOUNCE_MS);

  state.setPendingTimer(userId, timer);
}

module.exports = { handleEvent };
