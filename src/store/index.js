// createStore({ path, clock, log }) → repositories with the exact shape of tests/fakes/store.js, backed by SQLite.
// Every method returns a Promise even though node:sqlite is synchronous, so fakes and the real store swap freely.
const { openDb, checkpoint } = require('./db');
const { migrate } = require('./migrate');
const { createSessionsRepo } = require('./repo/sessions');
const { createMessagesRepo } = require('./repo/messages');
const { createLeadsRepo } = require('./repo/leads');
const { createBookingsRepo } = require('./repo/bookings');
const { createKbGapsRepo } = require('./repo/kbGaps');
const { createRelayThreadsRepo } = require('./repo/relayThreads');
const { createOutboxRepo } = require('./repo/outbox');
const { createEventsRepo } = require('./repo/events');

function createStore({ path, clock, log, busyTimeoutMs } = {}) {
  const db = openDb(path, { busyTimeoutMs });
  migrate(db, { log });
  const opts = { clock };
  let closed = false;
  return {
    sessions: createSessionsRepo(db, opts),
    messages: createMessagesRepo(db, opts),
    leads: createLeadsRepo(db, opts),
    bookings: createBookingsRepo(db, opts),
    kbGaps: createKbGapsRepo(db, opts),
    relayThreads: createRelayThreadsRepo(db, opts),
    outbox: createOutboxRepo(db, opts),
    events: createEventsRepo(db, opts),
    /** Flush WAL to the main file (backup step). No-op for :memory:. */
    checkpoint: async () => { if (!closed) try { checkpoint(db); } catch { /* memory db */ } },
    close: async () => { if (!closed) { closed = true; db.close(); } },
    _db: db,
  };
}

module.exports = { createStore };
