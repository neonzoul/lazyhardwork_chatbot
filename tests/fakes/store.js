// In-memory store with the repository shape src/store will implement (T1). Enough for scenarios and flows.
const { summarise, sinceIso } = require('../../src/store/repo/llmCalls');

function createFakeStore() {
  const llmCalls = [];
  const sessions = new Map();
  const messages = [];
  const leads = new Map();
  const bookings = new Map();
  const kbGaps = [];
  const events = [];
  let ids = 0;
  const nextId = (p) => `${p}${++ids}`;

  const defaultSession = (userId) => ({
    user_id: userId, display_name: null, mode: 'lay', mode_since: null, demo_shop: null,
    topics_covered: [], draft: {}, homework: {}, questions_asked: 0, loose_ends_fired: false,
    last_customer_at: null, last_bot_at: null, opened: false, booking_step: null,
  });

  return {
    sessions: {
      get: async (userId) => sessions.get(userId) || null,
      getOrCreate: async (userId) => { if (!sessions.has(userId)) sessions.set(userId, defaultSession(userId)); return sessions.get(userId); },
      save: async (s) => { sessions.set(s.user_id, { ...s }); return s; },
      all: async () => [...sessions.values()],
    },
    messages: {
      append: async (m) => { const row = { id: nextId('m'), ...m }; messages.push(row); return row; },
      recent: async (userId, n = 12) => messages.filter((m) => m.user_id === userId).slice(-n),
      all: () => messages,
    },
    leads: {
      byUser: async (userId) => [...leads.values()].find((l) => l.user_id === userId) || null,
      upsert: async (l) => { const id = l.id || nextId('L-test-'); const row = { ...(leads.get(id) || {}), ...l, id }; leads.set(id, row); return row; },
      since: async () => [...leads.values()],
      all: () => [...leads.values()],
    },
    bookings: {
      create: async (b) => { const row = { id: nextId('B'), status: 'pending', ...b }; bookings.set(row.id, row); return row; },
      get: async (id) => bookings.get(id) || null,
      update: async (id, patch) => { const row = { ...bookings.get(id), ...patch }; bookings.set(id, row); return row; },
      pendingFor: async (userId) => [...bookings.values()].find((b) => b.user_id === userId && b.status === 'pending') || null,
      all: () => [...bookings.values()],
    },
    kbGaps: { append: async (g) => { kbGaps.push({ id: nextId('g'), ...g }); }, all: () => kbGaps },
    events: { append: async (e) => { events.push({ id: nextId('e'), ...e }); }, all: () => events },
    llmCalls: {
      append: async (r) => { const row = { id: nextId('c'), attempts: 1, ...r }; llmCalls.push(row); return row; },
      since: async (iso, { task, limit = 200 } = {}) => llmCalls.filter((r) => (!iso || r.ts >= iso) && (!task || r.task === task)).slice(-limit).reverse(),
      recent: async (n = 100) => llmCalls.slice(-n).reverse(),
      summary: async ({ days = 7, now } = {}) => summarise(llmCalls.filter((r) => r.ts >= sinceIso({ days, now }))),
      all: () => llmCalls,
    },
    _dump: () => ({ sessions: [...sessions.values()], messages, leads: [...leads.values()], bookings: [...bookings.values()], kbGaps, events, llmCalls }),
  };
}

module.exports = { createFakeStore };
