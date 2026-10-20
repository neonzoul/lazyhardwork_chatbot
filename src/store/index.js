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
const { createLlmCallsRepo } = require('./repo/llmCalls');

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
    llmCalls: createLlmCallsRepo(db, opts),
    /**
     * Erase everything about one LINE user (Mos, 20 Oct: /forget, PDPA erasure). One transaction over every table that
     * holds the user: rows keyed by user_id, outbox rows whose payload names the user, bookings of the user's leads.
     * Returns { table: rowsDeleted }.
     */
    forgetUser: async (userId) => {
      if (!userId || typeof userId !== 'string') throw new Error('forgetUser: userId required');
      const counts = {};
      const run = (table, sql, params) => { counts[table] = (counts[table] || 0) + Number(db.prepare(sql).run(params).changes || 0); };
      db.exec('BEGIN');
      try {
        run('bookings', 'DELETE FROM bookings WHERE user_id = $u OR lead_id IN (SELECT id FROM leads WHERE user_id = $u)', { $u: userId });
        for (const table of ['messages', 'leads', 'kb_gaps', 'relay_threads', 'events', 'llm_calls', 'sessions']) {
          run(table, `DELETE FROM ${table} WHERE user_id = $u`, { $u: userId });
        }
        run('outbox', 'DELETE FROM outbox WHERE instr(payload, $u) > 0', { $u: userId });
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      return counts;
    },
    /** Flush WAL to the main file (backup step). No-op for :memory:. */
    checkpoint: async () => { if (!closed) try { checkpoint(db); } catch { /* memory db */ } },
    close: async () => { if (!closed) { closed = true; db.close(); } },
    _db: db,
  };
}

module.exports = { createStore };
