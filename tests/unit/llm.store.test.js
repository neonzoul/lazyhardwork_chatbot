// llm_calls: migration 002, the repository (real SQLite and the fake agree), the /admin/llm/* routes (doc/llm.md §4).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { openDb } = require('../../src/store/db');
const { migrate } = require('../../src/store/migrate');
const { createStore } = require('../../src/store');
const { createFakeStore } = require('../fakes/store');
const { createFakeClock } = require('../fakes/clock');
const { createAdminRouter } = require('../../src/admin');
const { createKeyring } = require('../../src/brain/keys');
const { createBudget } = require('../../src/brain/budget');

const TOKEN = 'test-admin-token-not-a-secret';
const row = (over = {}) => ({ ts: '2026-10-18T10:00:00.000Z', task: 'lay.reply', agent: 'lay', model: 'openai/gpt-4o-mini', key_index: 0, user_id: 'U1', prompt_tokens: 3000, completion_tokens: 200, cached_tokens: 2500, total_tokens: 3200, cost_usd: 0.00057, latency_ms: 1200, outcome: 'ok', error: null, request_id: 'gen-1', attempts: 1, ...over });

function seed(store) {
  return Promise.all([
    store.llmCalls.append(row()),
    store.llmCalls.append(row({ ts: '2026-10-18T10:00:05.000Z', outcome: 'invalid', error: 'intent: unknown fly', request_id: 'gen-2' })),
    store.llmCalls.append(row({ ts: '2026-10-18T10:00:06.000Z', task: 'lay.repair', outcome: 'repaired', prompt_tokens: 3100, completion_tokens: 150, total_tokens: 3250, cost_usd: 0.00055, latency_ms: 900, attempts: 2, request_id: 'gen-3' })),
    store.llmCalls.append(row({ ts: '2026-10-17T09:00:00.000Z', model: 'openai/gpt-4.1-mini', outcome: 'fallback_model', cost_usd: 0.002, latency_ms: 2000, request_id: 'gen-4' })),
    store.llmCalls.append(row({ ts: '2026-10-01T09:00:00.000Z', outcome: 'error', error: 'boom', cost_usd: 0, latency_ms: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 })),
    store.llmCalls.append(row({ ts: '2026-10-18T11:00:00.000Z', outcome: 'exhausted', key_index: null, attempts: 0, cost_usd: 0, latency_ms: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, error: 'skipped: all keys exhausted' })),
  ]);
}

test('migration 002 creates llm_calls with its indexes; idempotent', () => {
  const db = openDb(':memory:');
  const applied = migrate(db);
  assert.ok(applied.includes('002-llm-calls.sql'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tables.includes('llm_calls'));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'llm_calls'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_llm_calls_ts') && idx.includes('idx_llm_calls_task_ts'));
  assert.deepEqual(migrate(db), []);
  db.close();
});

for (const [label, make] of [['sqlite', () => createStore({ path: ':memory:', clock: createFakeClock('2026-10-18T12:00:00Z') })], ['fake', () => createFakeStore()]]) {
  test(`llmCalls repo (${label}): append normalises, since filters by ts/task/limit newest first, summary groups day × task × model`, async () => {
    const store = make();
    await seed(store);
    const saved = await store.llmCalls.append(row({ outcome: 'weird', cost_usd: '0.001', attempts: undefined, request_id: 'gen-x' }));
    if (label === 'sqlite') { assert.equal(saved.outcome, 'error', 'unknown outcome is stored as error'); assert.equal(saved.cost_usd, 0.001); assert.equal(saved.attempts, 1); }
    const since = await store.llmCalls.since('2026-10-18T00:00:00Z');
    assert.ok(since.length >= 4);
    assert.ok(since.every((r) => r.ts >= '2026-10-18T00:00:00'));
    assert.ok(since[0].ts >= since[since.length - 1].ts, 'newest first');
    const repairs = await store.llmCalls.since('2026-10-01T00:00:00Z', { task: 'lay.repair' });
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0].outcome, 'repaired');
    assert.equal((await store.llmCalls.since('2026-10-01T00:00:00Z', { limit: 2 })).length, 2);
    const recent = await store.llmCalls.recent(3);
    assert.equal(recent.length, 3);

    const now = new Date('2026-10-18T12:00:00Z');
    const rows = await store.llmCalls.summary({ days: 7, now });
    assert.ok(!rows.some((r) => r.day === '2026-10-01'), 'outside the window');
    const lay = rows.find((r) => r.day === '2026-10-18' && r.task === 'lay.reply' && r.model === 'openai/gpt-4o-mini');
    assert.ok(lay, 'group present');
    assert.equal(lay.ok, 1);
    assert.equal(lay.invalid, 1);
    assert.equal(lay.exhausted, 1);
    assert.equal(lay.prompt_tokens, 6000 + (label === 'sqlite' ? 3000 : 3000));
    assert.equal(lay.avg_latency_ms, 1200);
    const repair = rows.find((r) => r.task === 'lay.repair');
    assert.equal(repair.repaired, 1);
    assert.equal(repair.cost_usd, 0.00055);
    const fb = rows.find((r) => r.day === '2026-10-17');
    assert.equal(fb.fallback_model, 1);
    assert.equal(fb.model, 'openai/gpt-4.1-mini');
    assert.equal(rows[0].day, '2026-10-18', 'newest day first');
    if (store.close) await store.close();
  });
}

async function boot({ llm } = {}) {
  const clock = createFakeClock('2026-10-18T12:00:00Z');
  const store = createStore({ path: ':memory:', clock });
  const app = express();
  app.use(createAdminRouter({ store, token: TOKEN, clock, llm }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, token = TOKEN) => {
    const res = await fetch(base + path, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
    return { status: res.status, json: await res.json() };
  };
  return { store, api, close: async () => { await new Promise((r) => server.close(r)); await store.close(); } };
}

test('/admin/llm/calls: bearer-protected, since/task/limit filters, 400 on a bad date', async () => {
  const w = await boot();
  await seed(w.store);
  assert.equal((await w.api('/admin/llm/calls', null)).status, 401);
  assert.equal((await w.api('/admin/llm/calls', 'wrong')).status, 401);
  const all = await w.api('/admin/llm/calls');
  assert.equal(all.status, 200);
  assert.equal(all.json.count, 6);
  assert.equal(all.json.calls[0].ts, '2026-10-18T11:00:00.000Z');
  const r = await w.api('/admin/llm/calls?since=2026-10-18T00:00:00Z&task=lay.reply&limit=2');
  assert.equal(r.json.count, 2);
  assert.equal(r.json.task, 'lay.reply');
  assert.ok(r.json.calls.every((c) => c.task === 'lay.reply'));
  assert.equal((await w.api('/admin/llm/calls?since=yesterday')).status, 400);
  await w.close();
});

test('/admin/llm/summary: days window, rows + totals', async () => {
  const w = await boot();
  await seed(w.store);
  const r = await w.api('/admin/llm/summary?days=7');
  assert.equal(r.status, 200);
  assert.equal(r.json.days, 7);
  assert.ok(r.json.rows.length >= 3);
  assert.equal(r.json.totals.calls, 5);
  assert.equal(r.json.totals.errors, 1, 'exhausted counts as an error in totals');
  assert.equal(r.json.totals.invalid, 1);
  assert.ok(r.json.totals.cost_usd > 0.003);
  const d1 = await w.api('/admin/llm/summary?days=1');
  assert.ok(d1.json.rows.every((x) => x.day === '2026-10-18'));
  const dflt = await w.api('/admin/llm/summary?days=abc');
  assert.equal(dflt.json.days, 7);
  await w.close();
});

test('/admin/llm/status: keyring + budget + routing table + NO_LLM; works without llm wiring too', async () => {
  const clock = createFakeClock('2026-10-18T12:00:00Z');
  const keyring = createKeyring({ keys: ['sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa0001'], clock });
  const budget = createBudget({ keyring, clock });
  budget.record({ key_index: 0, cost_usd: 0.01 });
  const w = await boot({ llm: { keyring, budget, statusLine: () => 'keys: 1/1 usable' } });
  const r = await w.api('/admin/llm/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.keyring.total, 1);
  assert.equal(r.json.keyring.exhausted, false);
  assert.ok(!JSON.stringify(r.json).includes('aaaaaaaaaaaaaaaa'), 'no key value in the admin output');
  assert.equal(r.json.budget.keys[0].spent_usd, 0.01);
  assert.equal(r.json.status_line, 'keys: 1/1 usable');
  assert.ok(r.json.router.some((t) => t.id === 'lay.reply' && t.model && t.source));
  assert.ok(r.json.no_llm.length >= 8);
  await w.close();
  const bare = await boot();
  const b = await bare.api('/admin/llm/status');
  assert.equal(b.status, 200);
  assert.equal(b.json.keyring, null);
  assert.ok(Array.isArray(b.json.router));
  await bare.close();
});
