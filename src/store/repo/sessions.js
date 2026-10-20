// sessions — one row per LINE user (design §5). JSON fields (topics_covered, draft, homework) and bools
// round-trip transparently; callers see the same shape as tests/fakes/store.js defaultSession().
const { nowIso, toJson, fromJson, fromBool, bind, insertSql, repo } = require('./_util');

const COLS = [
  'user_id', 'display_name', 'mode', 'mode_since', 'demo_shop', 'topics_covered', 'draft', 'homework',
  'questions_asked', 'loose_ends_fired', 'opened', 'booking_step', 'last_customer_at', 'last_bot_at',
  'created_at', 'updated_at', 'extra',
];
const FIXED = new Set(COLS);

const MODES = ['lay', 'quiet', 'mos_active', 'demo', 'human']; // keep in step with core/session.js

function defaultSession(userId) {
  return {
    user_id: userId, display_name: null, mode: 'lay', mode_since: null, demo_shop: null,
    topics_covered: [], draft: {}, homework: {}, questions_asked: 0, loose_ends_fired: false,
    last_customer_at: null, last_bot_at: null, opened: false, booking_step: null,
    created_at: null, updated_at: null,
  };
}

function fromRow(r) {
  if (!r) return null;
  const extra = fromJson(r.extra, {});
  const { extra: _e, ...rest } = r;
  return {
    ...extra,
    ...rest,
    topics_covered: fromJson(r.topics_covered, []),
    draft: fromJson(r.draft, {}),
    homework: fromJson(r.homework, {}),
    questions_asked: Number(r.questions_asked || 0),
    loose_ends_fired: fromBool(r.loose_ends_fired),
    opened: fromBool(r.opened),
  };
}

function createSessionsRepo(db, { clock } = {}) {
  const selectOne = db.prepare('SELECT * FROM sessions WHERE user_id = $user_id');
  const selectAll = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
  const upsert = db.prepare(`${insertSql('sessions', COLS)}
    ON CONFLICT(user_id) DO UPDATE SET
      ${COLS.filter((c) => c !== 'user_id' && c !== 'created_at').map((c) => `${c} = excluded.${c}`).join(', ')}`);

  const save = (s) => {
    if (!s || !s.user_id) throw new Error('sessions.save: user_id required');
    if (s.mode && !MODES.includes(s.mode)) throw new Error(`sessions.save: invalid mode ${s.mode}`);
    const now = nowIso(clock);
    const merged = { ...defaultSession(s.user_id), ...s };
    const row = {
      ...merged,
      topics_covered: toJson(merged.topics_covered, []),
      draft: toJson(merged.draft, {}),
      homework: toJson(merged.homework, {}),
      questions_asked: Number(merged.questions_asked || 0),
      created_at: merged.created_at || now,
      updated_at: now,
    };
    const extra = {};
    for (const [k, v] of Object.entries(merged)) if (!FIXED.has(k) && v !== undefined) extra[k] = v;
    row.extra = toJson(extra, {});
    const params = {};
    for (const c of COLS) params[c] = row[c];
    upsert.run(bind(params));
    return fromRow(selectOne.get({ $user_id: s.user_id }));
  };

  return repo({
    get: (userId) => fromRow(selectOne.get({ $user_id: userId })),
    getOrCreate: (userId) => fromRow(selectOne.get({ $user_id: userId })) || save(defaultSession(userId)),
    save,
    all: () => selectAll.all().map(fromRow),
  });
}

module.exports = { createSessionsRepo, defaultSession, MODES };
