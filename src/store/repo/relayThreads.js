// relay_threads — Discord thread ↔ LINE user mapping for the relay bot (design §5/§6).
const { nowIso, bind, insertSql, repo } = require('./_util');

const COLS = ['discord_thread_id', 'user_id', 'lead_id', 'opened_for', 'created_at'];
const OPENED_FOR = ['handoff', 'booking'];

function createRelayThreadsRepo(db, { clock } = {}) {
  const insert = db.prepare(insertSql('relay_threads', COLS));
  const selectOne = db.prepare('SELECT * FROM relay_threads WHERE discord_thread_id = $discord_thread_id');
  const selectByUser = db.prepare('SELECT * FROM relay_threads WHERE user_id = $user_id ORDER BY created_at DESC, rowid DESC LIMIT 1');
  const selectAll = db.prepare('SELECT * FROM relay_threads ORDER BY created_at ASC, rowid ASC');

  const plain = (r) => (r ? { ...r } : null); // node:sqlite rows are null-prototype objects

  return repo({
    byThread: (threadId) => plain(selectOne.get({ $discord_thread_id: String(threadId) })),
    byUser: (userId) => plain(selectByUser.get({ $user_id: userId })),
    create: (t) => {
      if (!t || !t.discord_thread_id) throw new Error('relayThreads.create: discord_thread_id required');
      if (!t.user_id) throw new Error('relayThreads.create: user_id required');
      const openedFor = t.opened_for || 'handoff';
      if (!OPENED_FOR.includes(openedFor)) throw new Error(`relayThreads.create: invalid opened_for ${openedFor}`);
      const row = {
        discord_thread_id: String(t.discord_thread_id), user_id: t.user_id, lead_id: t.lead_id ?? null,
        opened_for: openedFor, created_at: t.created_at || nowIso(clock),
      };
      insert.run(bind(row));
      return plain(selectOne.get({ $discord_thread_id: row.discord_thread_id }));
    },
    all: () => selectAll.all().map(plain),
  });
}

module.exports = { createRelayThreadsRepo, OPENED_FOR };
