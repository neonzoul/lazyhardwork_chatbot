// In-memory conversation state per LINE userId.
// Production note: replace with Redis/DB for persistence across restarts.

const BOT_ACTIVE = 'BOT_ACTIVE';
const WAITING_HUMAN = 'WAITING_HUMAN';
const HUMAN_ACTIVE = 'HUMAN_ACTIVE';

// Map<userId, { status, history, pendingTimer, pendingMessages }>
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      status: BOT_ACTIVE,
      history: [],
      pendingTimer: null,
      pendingMessages: [],   // lossless burst accumulator — drained on debounce fire
    });
  }
  return sessions.get(userId);
}

function setStatus(userId, status) {
  getSession(userId).status = status;
}

function getStatus(userId) {
  return getSession(userId).status;
}

function addMessage(userId, role, content) {
  const session = getSession(userId);
  session.history.push({ role, content });
  // Keep last 10 messages (spec §3)
  if (session.history.length > 10) session.history.shift();
}

function getHistory(userId) {
  return getSession(userId).history;
}

function getPendingTimer(userId) {
  return getSession(userId).pendingTimer;
}

function setPendingTimer(userId, timer) {
  getSession(userId).pendingTimer = timer;
}

// Append one message to the accumulator; called on every incoming message event.
function pushPendingMessage(userId, text) {
  getSession(userId).pendingMessages.push(text);
}

// Drain and return all accumulated messages as a single joined string; clears the accumulator.
function drainPendingMessages(userId) {
  const session = getSession(userId);
  const msgs = session.pendingMessages.splice(0);
  return msgs.join('\n');
}

module.exports = {
  BOT_ACTIVE,
  WAITING_HUMAN,
  HUMAN_ACTIVE,
  getSession,
  setStatus,
  getStatus,
  addMessage,
  getHistory,
  getPendingTimer,
  setPendingTimer,
  pushPendingMessage,
  drainPendingMessages,
};
