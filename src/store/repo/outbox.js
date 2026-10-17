// outbox — retry queue for non-promise notifications (design §5). Lifecycle:
//   enqueue → pending → nextBatch(n) hands out due rows → markSent / markFailed (backoff; failed after maxAttempts).
const { nowIso, fromJson, bind, insertSql, repo } = require('./_util');

const COLS = ['kind', 'payload', 'status', 'attempts', 'last_error', 'next_attempt_at', 'sent_at', 'created_at'];
const KINDS = ['discord_notify', 'line_push'];
const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];

function fromRow(r) {
  if (!r) return null;
  return { ...r, id: Number(r.id), attempts: Number(r.attempts || 0), payload: fromJson(r.payload, null) };
}

function createOutboxRepo(db, { clock, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const insert = db.prepare(insertSql('outbox', COLS));
  const selectOne = db.prepare('SELECT * FROM outbox WHERE id = $id');
  const selectDue = db.prepare(
    "SELECT * FROM outbox WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $now) ORDER BY id ASC LIMIT $n",
  );
  const selectAll = db.prepare('SELECT * FROM outbox ORDER BY id ASC');
  const sent = db.prepare("UPDATE outbox SET status = 'sent', sent_at = $now, last_error = NULL WHERE id = $id");
  const failed = db.prepare(
    'UPDATE outbox SET status = $status, attempts = $attempts, last_error = $last_error, next_attempt_at = $next_attempt_at WHERE id = $id',
  );

  const get = (id) => fromRow(selectOne.get({ $id: Number(id) }));

  return repo({
    enqueue: (item) => {
      if (!item || !item.kind) throw new Error('outbox.enqueue: kind required');
      if (!KINDS.includes(item.kind)) throw new Error(`outbox.enqueue: invalid kind ${item.kind}`);
      const now = nowIso(clock);
      const row = {
        kind: item.kind, payload: item.payload === undefined ? null : item.payload, status: 'pending', attempts: 0,
        last_error: null, next_attempt_at: item.next_attempt_at ?? null, sent_at: null, created_at: now,
      };
      if (row.payload === null) row.payload = '{}';
      const { lastInsertRowid } = insert.run(bind(row));
      return get(lastInsertRowid);
    },
    get,
    nextBatch: (n = 10) => selectDue.all({ $now: nowIso(clock), $n: Number(n) }).map(fromRow),
    markSent: (id) => {
      sent.run({ $id: Number(id), $now: nowIso(clock) });
      return get(id);
    },
    markFailed: (id, error) => {
      const row = get(id);
      if (!row) throw new Error(`outbox.markFailed: no item ${id}`);
      const attempts = row.attempts + 1;
      const exhausted = attempts >= maxAttempts;
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
      const nextAt = exhausted ? null : new Date(new Date(nowIso(clock)).getTime() + delay).toISOString();
      const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
      failed.run(bind({ id: Number(id), status: exhausted ? 'failed' : 'pending', attempts, last_error: message.slice(0, 500), next_attempt_at: nextAt }));
      return get(id);
    },
    all: () => selectAll.all().map(fromRow),
  });
}

module.exports = { createOutboxRepo, KINDS, DEFAULT_MAX_ATTEMPTS, BACKOFF_MS };
