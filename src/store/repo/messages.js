// messages — transcript per user. recent(userId, n) returns the last n rows in chronological order.
const { nowIso, fromJson, fromBool, bind, insertSql, repo } = require('./_util');

const COLS = ['user_id', 'role', 'sender_name', 'kind', 'text', 'payload', 'reply_token_used', 'created_at'];

function fromRow(r) {
  if (!r) return null;
  return { ...r, id: Number(r.id), payload: fromJson(r.payload, null), reply_token_used: fromBool(r.reply_token_used) };
}

function createMessagesRepo(db, { clock } = {}) {
  const insert = db.prepare(insertSql('messages', COLS));
  const selectOne = db.prepare('SELECT * FROM messages WHERE id = $id');
  const selectRecent = db.prepare(
    'SELECT * FROM (SELECT * FROM messages WHERE user_id = $user_id ORDER BY id DESC LIMIT $n) ORDER BY id ASC',
  );
  const selectAll = db.prepare('SELECT * FROM messages ORDER BY id ASC');
  const selectByUser = db.prepare('SELECT * FROM messages WHERE user_id = $user_id ORDER BY id ASC');

  return repo({
    append: (m) => {
      if (!m || !m.user_id) throw new Error('messages.append: user_id required');
      if (!m.role) throw new Error('messages.append: role required');
      const row = {
        user_id: m.user_id, role: m.role, sender_name: m.sender_name ?? null, kind: m.kind || 'text',
        text: m.text ?? null, payload: m.payload === undefined ? null : m.payload,
        reply_token_used: !!m.reply_token_used, created_at: m.created_at || nowIso(clock),
      };
      const { lastInsertRowid } = insert.run(bind(row));
      return fromRow(selectOne.get({ $id: lastInsertRowid }));
    },
    recent: (userId, n = 12) => selectRecent.all({ $user_id: userId, $n: Number(n) }).map(fromRow),
    byUser: (userId) => selectByUser.all({ $user_id: userId }).map(fromRow),
    all: () => selectAll.all().map(fromRow),
  });
}

module.exports = { createMessagesRepo };
