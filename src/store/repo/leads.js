// leads — design §5/§9. Ids are L-YYYY-MM-DD-line_oa-<6 base36>, generated when missing (date from the clock).
// upsert merges the patch over the existing row (same semantics as the fake). since(iso) filters on updated_at
// so a re-synced lead shows up again after it changes.
const { nowIso, dateStamp, shortId, toJson, fromJson, bind, insertSql, repo } = require('./_util');

const COLS = [
  'id', 'user_id', 'status', 'card_id', 'symptom', 'homework', 'customer_words_th', 'wave_group', 'source',
  'discord_thread_id', 'synced_at', 'created_at', 'updated_at',
];
const STATUSES = ['new', 'qualified', 'booking_pending', 'booked', 'offer_shown', 'closed'];
const ID_RE = /^L-\d{4}-\d{2}-\d{2}-[a-z_]+-[a-z0-9]{6}$/;

const makeLeadId = (clock, source = 'line_oa') => `L-${dateStamp(clock)}-${source}-${shortId(6)}`;

function fromRow(r) {
  if (!r) return null;
  return { ...r, homework: fromJson(r.homework, {}) };
}

function createLeadsRepo(db, { clock } = {}) {
  const selectOne = db.prepare('SELECT * FROM leads WHERE id = $id');
  const selectByUser = db.prepare('SELECT * FROM leads WHERE user_id = $user_id ORDER BY created_at DESC, id DESC LIMIT 1');
  const selectSince = db.prepare('SELECT * FROM leads WHERE updated_at >= $since ORDER BY updated_at ASC, id ASC');
  const selectAll = db.prepare('SELECT * FROM leads ORDER BY created_at ASC, id ASC');
  const upsertStmt = db.prepare(`${insertSql('leads', COLS)}
    ON CONFLICT(id) DO UPDATE SET
      ${COLS.filter((c) => c !== 'id' && c !== 'created_at').map((c) => `${c} = excluded.${c}`).join(', ')}`);

  const upsert = (l) => {
    if (!l) throw new Error('leads.upsert: lead required');
    const existing = l.id ? fromRow(selectOne.get({ $id: l.id })) : null;
    const source = l.source || (existing && existing.source) || 'line_oa';
    const id = l.id || makeLeadId(clock, source);
    const userId = l.user_id || (existing && existing.user_id);
    if (!userId) throw new Error('leads.upsert: user_id required');
    if (l.status && !STATUSES.includes(l.status)) throw new Error(`leads.upsert: invalid status ${l.status}`);
    const now = nowIso(clock);
    const merged = { status: 'new', homework: {}, ...(existing || {}), ...l, id, user_id: userId, source };
    const params = {};
    for (const c of COLS) params[c] = merged[c];
    params.homework = toJson(merged.homework, {});
    params.created_at = (existing && existing.created_at) || l.created_at || now;
    params.updated_at = now;
    upsertStmt.run(bind(params));
    return fromRow(selectOne.get({ $id: id }));
  };

  return repo({
    get: (id) => fromRow(selectOne.get({ $id: id })),
    byUser: (userId) => fromRow(selectByUser.get({ $user_id: userId })),
    upsert,
    since: (iso) => (iso ? selectSince.all({ $since: new Date(iso).toISOString() }) : selectAll.all()).map(fromRow),
    all: () => selectAll.all().map(fromRow),
  });
}

module.exports = { createLeadsRepo, makeLeadId, STATUSES, ID_RE };
