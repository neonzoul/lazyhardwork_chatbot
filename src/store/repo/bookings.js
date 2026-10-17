// bookings — one row per proposed call window (design §5). Ids are B-YYYY-MM-DD-<6 base36>.
const { nowIso, dateStamp, shortId, toJson, fromJson, bind, insertSql, repo } = require('./_util');

const COLS = [
  'id', 'lead_id', 'user_id', 'window_text', 'fields', 'status', 'proposed_windows', 'decided_by', 'decided_at',
  'created_at', 'updated_at',
];
const STATUSES = ['pending', 'confirmed', 'reproposed', 'declined', 'cancelled'];

const makeBookingId = (clock) => `B-${dateStamp(clock)}-${shortId(6)}`;

function fromRow(r) {
  if (!r) return null;
  return { ...r, fields: fromJson(r.fields, {}), proposed_windows: fromJson(r.proposed_windows, []) };
}

function createBookingsRepo(db, { clock } = {}) {
  const insert = db.prepare(insertSql('bookings', COLS));
  const selectOne = db.prepare('SELECT * FROM bookings WHERE id = $id');
  const selectPending = db.prepare(
    "SELECT * FROM bookings WHERE user_id = $user_id AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1",
  );
  const selectForLead = db.prepare('SELECT * FROM bookings WHERE lead_id = $lead_id ORDER BY created_at DESC, id DESC');
  const selectAll = db.prepare('SELECT * FROM bookings ORDER BY created_at ASC, id ASC');
  const updatable = COLS.filter((c) => !['id', 'created_at'].includes(c));

  const get = (id) => fromRow(selectOne.get({ $id: id }));

  return repo({
    create: (b) => {
      if (!b || !b.user_id) throw new Error('bookings.create: user_id required');
      const status = b.status || 'pending';
      if (!STATUSES.includes(status)) throw new Error(`bookings.create: invalid status ${status}`);
      const now = nowIso(clock);
      const row = {
        id: b.id || makeBookingId(clock), lead_id: b.lead_id ?? null, user_id: b.user_id,
        window_text: b.window_text ?? null, fields: toJson(b.fields, {}), status,
        proposed_windows: toJson(b.proposed_windows, []), decided_by: b.decided_by ?? null,
        decided_at: b.decided_at ?? null, created_at: b.created_at || now, updated_at: now,
      };
      insert.run(bind(row));
      return get(row.id);
    },
    get,
    update: (id, patch = {}) => {
      const existing = get(id);
      if (!existing) throw new Error(`bookings.update: no booking ${id}`);
      if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`bookings.update: invalid status ${patch.status}`);
      const merged = { ...existing, ...patch, id, updated_at: nowIso(clock) };
      const sets = updatable.map((c) => `${c} = $${c}`).join(', ');
      const params = {};
      for (const c of updatable) params[c] = merged[c];
      params.fields = toJson(merged.fields, {});
      params.proposed_windows = toJson(merged.proposed_windows, []);
      db.prepare(`UPDATE bookings SET ${sets} WHERE id = $id`).run(bind({ ...params, id }));
      return get(id);
    },
    pendingFor: (userId) => fromRow(selectPending.get({ $user_id: userId })),
    forLead: (leadId) => selectForLead.all({ $lead_id: leadId }).map(fromRow),
    all: () => selectAll.all().map(fromRow),
  });
}

module.exports = { createBookingsRepo, makeBookingId, STATUSES };
