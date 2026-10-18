// llm_calls — one row per provider attempt (doc/llm.md §4). Written by brain/respond through the tracker; read by
// /admin/llm/* and scripts/llm-report.js.
//
//   append(row)                     → saved row
//   since(iso, { task, limit })     → rows with ts ≥ iso, newest first (limit default 200, max 2000)
//   recent(n)                       → last n rows, newest first
//   summary({ days = 7, now })      → [{ day, task, model, calls, ok, repaired, invalid, errors, exhausted, fallback_model,
//                                        prompt_tokens, completion_tokens, cached_tokens, total_tokens, cost_usd, avg_latency_ms }]
//   all()
const { nowIso, bind, insertSql, repo } = require('./_util');

const COLS = ['ts', 'task', 'agent', 'model', 'key_index', 'user_id', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'total_tokens', 'cost_usd', 'latency_ms', 'outcome', 'error', 'request_id', 'attempts'];
const OUTCOMES = ['ok', 'repaired', 'invalid', 'error', 'exhausted', 'fallback_model'];
const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 2000;

function fromRow(r) {
  if (!r) return null;
  return { ...r, id: Number(r.id), key_index: r.key_index === null ? null : Number(r.key_index), cost_usd: Number(r.cost_usd || 0) };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function normalise(row, clock) {
  if (!row || !row.task) throw new Error('llmCalls.append: task required');
  if (!row.model) throw new Error('llmCalls.append: model required');
  const outcome = OUTCOMES.includes(row.outcome) ? row.outcome : 'error';
  return {
    ts: row.ts || nowIso(clock), task: String(row.task), agent: row.agent ?? null, model: String(row.model),
    key_index: row.key_index === undefined || row.key_index === null ? null : Number(row.key_index),
    user_id: row.user_id ?? null,
    prompt_tokens: Math.round(num(row.prompt_tokens)), completion_tokens: Math.round(num(row.completion_tokens)),
    cached_tokens: Math.round(num(row.cached_tokens)), total_tokens: Math.round(num(row.total_tokens)),
    cost_usd: num(row.cost_usd), latency_ms: Math.round(num(row.latency_ms)),
    outcome, error: row.error ? String(row.error).slice(0, 300) : null, request_id: row.request_id ?? null,
    attempts: Math.max(0, Math.round(num(row.attempts === undefined ? 1 : row.attempts))),
  };
}

function summarise(rows) {
  const groups = new Map();
  for (const r of rows) {
    const day = String(r.ts).slice(0, 10);
    const k = `${day}|${r.task}|${r.model}`;
    if (!groups.has(k)) groups.set(k, { day, task: r.task, model: r.model, calls: 0, ok: 0, repaired: 0, invalid: 0, errors: 0, exhausted: 0, fallback_model: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, total_tokens: 0, cost_usd: 0, _lat: 0, _latN: 0 });
    const g = groups.get(k);
    g.calls += 1;
    if (r.outcome === 'ok') g.ok += 1;
    else if (r.outcome === 'repaired') g.repaired += 1;
    else if (r.outcome === 'invalid') g.invalid += 1;
    else if (r.outcome === 'error') g.errors += 1;
    else if (r.outcome === 'exhausted') g.exhausted += 1;
    else if (r.outcome === 'fallback_model') g.fallback_model += 1;
    g.prompt_tokens += num(r.prompt_tokens); g.completion_tokens += num(r.completion_tokens);
    g.cached_tokens += num(r.cached_tokens); g.total_tokens += num(r.total_tokens);
    g.cost_usd += num(r.cost_usd);
    if (num(r.latency_ms) > 0) { g._lat += num(r.latency_ms); g._latN += 1; }
  }
  return [...groups.values()]
    .map(({ _lat, _latN, ...g }) => ({ ...g, cost_usd: Number(g.cost_usd.toFixed(6)), avg_latency_ms: _latN ? Math.round(_lat / _latN) : 0 }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.task.localeCompare(b.task) || a.model.localeCompare(b.model)));
}

function sinceIso({ days = 7, now } = {}) {
  const at = now instanceof Date ? now : new Date();
  return new Date(at.getTime() - Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000).toISOString();
}

function createLlmCallsRepo(db, { clock } = {}) {
  const insert = db.prepare(insertSql('llm_calls', COLS));
  const selectOne = db.prepare('SELECT * FROM llm_calls WHERE id = $id');
  const selectAll = db.prepare('SELECT * FROM llm_calls ORDER BY id ASC');
  const selectSince = db.prepare('SELECT * FROM llm_calls WHERE ts >= $since ORDER BY id DESC LIMIT $limit');
  const selectSinceTask = db.prepare('SELECT * FROM llm_calls WHERE ts >= $since AND task = $task ORDER BY id DESC LIMIT $limit');
  const selectRecent = db.prepare('SELECT * FROM llm_calls ORDER BY id DESC LIMIT $n');
  const selectForSummary = db.prepare('SELECT ts, task, model, outcome, prompt_tokens, completion_tokens, cached_tokens, total_tokens, cost_usd, latency_ms FROM llm_calls WHERE ts >= $since');

  const clampLimit = (limit) => Math.min(LIMIT_MAX, Math.max(1, Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.round(Number(limit)) : LIMIT_DEFAULT));

  return repo({
    append: (row) => {
      const { lastInsertRowid } = insert.run(bind(normalise(row, clock)));
      return fromRow(selectOne.get({ $id: lastInsertRowid }));
    },
    since: (iso, { task, limit } = {}) => {
      const since = iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : '1970-01-01T00:00:00.000Z';
      const params = { $since: since, $limit: clampLimit(limit) };
      return (task ? selectSinceTask.all({ ...params, $task: String(task) }) : selectSince.all(params)).map(fromRow);
    },
    recent: (n = 100) => selectRecent.all({ $n: clampLimit(n) }).map(fromRow),
    summary: ({ days = 7, now } = {}) => summarise(selectForSummary.all({ $since: sinceIso({ days, now: now || (clock && clock.now ? clock.now() : undefined) }) })),
    all: () => selectAll.all().map(fromRow),
  });
}

module.exports = { createLlmCallsRepo, summarise, normalise, sinceIso, OUTCOMES, COLS };
