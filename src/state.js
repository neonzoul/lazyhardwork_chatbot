// In-memory conversation state per LINE userId.
// Production note: replace with Redis/DB for persistence across restarts.

const BOT_ACTIVE = 'BOT_ACTIVE';
const WAITING_HUMAN = 'WAITING_HUMAN';
const HUMAN_ACTIVE = 'HUMAN_ACTIVE';

// Map<userId, { status, history: [{role, content}], pendingTimer }>
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { status: BOT_ACTIVE, history: [], pendingTimer: null });
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
};
