// In-memory conversation state per LINE userId.
// Production note: replace with Redis/DB for persistence across restarts.

const BOT_ACTIVE = 'BOT_ACTIVE';
const WAITING_HUMAN = 'WAITING_HUMAN';
const HUMAN_ACTIVE = 'HUMAN_ACTIVE';

// Map<userId, { status, history, pendingTimer, pendingMessages, displayName, lastMessage, updatedAt, pendingHandoffOffer }>
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      status: BOT_ACTIVE,
      history: [],
      pendingTimer: null,
      pendingMessages: [],   // lossless burst accumulator — drained on debounce fire
      displayName: null,     // cached from LINE Profile API on first contact
      lastMessage: null,
      updatedAt: null,
      pendingHandoffOffer: false, // true after bot asks "want me to escalate?" due to KB gap
    });
  }
  return sessions.get(userId);
}

function setDisplayName(userId, name) {
  getSession(userId).displayName = name;
}

function getDisplayName(userId) {
  return getSession(userId).displayName;
}

// Returns all sessions as an array for the admin dashboard
function getAllSessions() {
  return Array.from(sessions.entries()).map(([userId, s]) => ({
    userId,
    displayName: s.displayName,
    status: s.status,
    lastMessage: s.lastMessage,
    updatedAt: s.updatedAt,
  })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
  if (session.history.length > 10) session.history.shift();
  if (role === 'user') {
    session.lastMessage = content.slice(0, 80);
    session.updatedAt = Date.now();
  }
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
  const session = getSession(userId);
  session.pendingMessages.push(text);
  session.lastMessage = text.slice(0, 80);
  session.updatedAt = Date.now();
}

// Drain and return all accumulated messages as a single joined string; clears the accumulator.
function drainPendingMessages(userId) {
  const session = getSession(userId);
  const msgs = session.pendingMessages.splice(0);
  return msgs.join('\n');
}

function setPendingHandoffOffer(userId, value) {
  getSession(userId).pendingHandoffOffer = value;
}

function getPendingHandoffOffer(userId) {
  return getSession(userId).pendingHandoffOffer || false;
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
  setDisplayName,
  getDisplayName,
  getAllSessions,
  setPendingHandoffOffer,
  getPendingHandoffOffer,
};
