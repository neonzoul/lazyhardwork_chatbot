// events — append-only debugging feed: policy_violation, error, undelivered, model_fallback … (design §5).
const { nowIso, fromJson, bind, insertSql, repo } = require('./_util');

const COLS = ['kind', 'user_id', 'payload', 'created_at'];

function fromRow(r) {
  if (!r) return null;
  return { ...r, id: Number(r.id), payload: fromJson(r.payload, null) };
}

function createEventsRepo(db, { clock } = {}) {
  const insert = db.prepare(insertSql('events', COLS));
  const selectOne = db.prepare('SELECT * FROM events WHERE id = $id');
  const selectAll = db.prepare('SELECT * FROM events ORDER BY id ASC');
  const selectRecent = db.prepare('SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT $n) ORDER BY id ASC');

  return repo({
    append: (e) => {
      if (!e || !e.kind) throw new Error('events.append: kind required');
      const { kind, user_id: userId, created_at: createdAt, payload, ...rest } = e;
      // Anything beyond kind/user_id/created_at rides in payload so callers can pass flat objects.
      const body = payload !== undefined ? payload : (Object.keys(rest).length ? rest : null);
      const row = { kind, user_id: userId ?? null, payload: body, created_at: createdAt || nowIso(clock) };
      const { lastInsertRowid } = insert.run(bind(row));
      return fromRow(selectOne.get({ $id: lastInsertRowid }));
    },
    recent: (n = 100) => selectRecent.all({ $n: Number(n) }).map(fromRow),
    all: () => selectAll.all().map(fromRow),
  });
}

module.exports = { createEventsRepo };
