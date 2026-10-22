// brain/budget: today's spend per key, /auth/key refresh, the 80 % warning, the tracker (doc/llm.md §3–§4).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBudget, createTracker, keyStatusLine, AUTH_KEY_URL } = require('../../src/brain/budget');
const { createKeyring } = require('../../src/brain/keys');
const { createFakeClock } = require('../fakes/clock');
const { createFakeStore } = require('../fakes/store');

const KEYS = ['sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa0001', 'sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbb0002'];

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const data = responder(init?.headers?.Authorization || '');
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  fn.calls = calls;
  return fn;
}

const keyInfo = (over = {}) => ({ label: 'sk-or-v1-1e1...356', limit: 15, limit_remaining: 14.5, limit_reset: 'daily', usage: 0.5, usage_daily: 0.5, effective_budget: { resets_at: '2026-10-19T00:00:00.000Z', reset_interval: 'daily', limit_usd: 15, remaining_usd: 14.5 }, ...over });

test('record sums cost per key per UTC day; the day rolls over with the clock', () => {
  const clock = createFakeClock('2026-10-18T20:00:00Z');
  const keyring = createKeyring({ keys: KEYS, clock });
  const b = createBudget({ keyring, clock });
  b.record({ key_index: 0, cost_usd: 0.001 });
  b.record({ key_index: 0, cost_usd: 0.002 });
  b.record({ key_index: 1, cost_usd: 0.5 });
  b.record({ key_index: 0, cost_usd: NaN });
  let st = b.status();
  assert.equal(st.day, '2026-10-18');
  assert.equal(st.keys[0].spent_usd, 0.003);
  assert.equal(st.keys[1].spent_usd, 0.5);
  assert.equal(b.remaining(0), null, 'no limit known yet');
  clock.set('2026-10-19T00:00:00Z');
  st = b.status();
  assert.equal(st.day, '2026-10-19');
  assert.equal(st.keys[0].spent_usd, 0);
});

test('refresh: reads /auth/key per key with its own bearer, stores limit/remaining/reset, throttles to once per 10 min', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00Z');
  const keyring = createKeyring({ keys: KEYS, clock });
  const fetchImpl = fakeFetch((auth) => keyInfo({ limit_remaining: auth.endsWith('0001') ? 14.5 : 15 }));
  const b = createBudget({ keyring, clock, fetchImpl });
  const r1 = await b.refresh();
  assert.equal(r1.refreshed, true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls.every((c) => c.url === AUTH_KEY_URL));
  assert.equal(fetchImpl.calls[0].auth, `Bearer ${KEYS[0]}`);
  const st = b.status();
  assert.equal(st.keys[0].limit_usd, 15);
  assert.equal(st.keys[0].server.limit_reset, 'daily');
  assert.equal(st.keys[0].server.resets_at, '2026-10-19T00:00:00.000Z');
  assert.equal(b.remaining(0), 14.5);
  assert.equal(keyring.status().keys[0].info.limit, 15);
  const r2 = await b.refresh();
  assert.equal(r2.refreshed, false);
  assert.equal(r2.reason, 'throttled');
  clock.advanceMinutes(11);
  assert.equal((await b.refresh()).refreshed, true);
  assert.equal((await b.refresh({ force: true })).refreshed, true);
});

test('refresh marks a key exhausted when the server says limit_remaining ≤ 0; fetch failures are logged, not thrown', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00Z');
  const keyring = createKeyring({ keys: KEYS, clock });
  const fetchImpl = fakeFetch((auth) => keyInfo({ limit_remaining: auth.endsWith('0001') ? 0 : 9 }));
  const warns = [];
  const b = createBudget({ keyring, clock, fetchImpl, log: { info() {}, warn: (e, f) => warns.push([e, f]), error() {} } });
  await b.refresh();
  assert.equal(keyring.status().keys[0].exhausted, true);
  assert.equal(keyring.status().keys[0].retry_at, '2026-10-19T00:00:00.000Z');
  assert.equal(keyring.current().index, 1);
  const broken = createBudget({ keyring, clock, fetchImpl: async () => { throw new Error('ECONNRESET'); }, log: { info() {}, warn: (e, f) => warns.push([e, f]), error() {} } });
  const r = await broken.refresh({ force: true });
  assert.equal(r.refreshed, true);
  assert.ok(r.results.every((x) => x.ok === false));
  assert.ok(warns.some(([e]) => e === 'llm.budget_refresh_failed'));
});

test('warns once per UTC day per key at 80 % of the limit (local count or server usage, whichever is higher)', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00Z');
  const keyring = createKeyring({ keys: [KEYS[0]], clock });
  const warned = [];
  const b = createBudget({ keyring, clock, fetchImpl: fakeFetch(() => keyInfo({ limit: 10, limit_remaining: 10, usage_daily: 0 })), onWarn: (w) => warned.push(w) });
  await b.refresh();
  b.record({ key_index: 0, cost_usd: 7.9 });
  assert.equal(warned.length, 0);
  b.record({ key_index: 0, cost_usd: 0.2 });
  assert.equal(warned.length, 1);
  assert.equal(warned[0].kind, 'llm_budget_80');
  assert.equal(warned[0].detail.key_index, 0);
  assert.equal(warned[0].detail.limit_usd, 10);
  assert.ok(warned[0].detail.pct >= 80);
  b.record({ key_index: 0, cost_usd: 1 });
  assert.equal(warned.length, 1, 'no repeat today');
  assert.equal(b.status().keys[0].warned_today, true);
  clock.set('2026-10-19T00:00:01Z');
  // next day, server reports 85 % used already → warn again from the server number
  const b2 = createBudget({ keyring, clock, fetchImpl: fakeFetch(() => keyInfo({ limit: 10, limit_remaining: 1.5, usage_daily: 8.5 })), onWarn: (w) => warned.push(w) });
  await b2.refresh();
  assert.equal(warned.length, 2);
  assert.equal(b2.remaining(0), 1.5);
});

test('tracker: writes llm_calls through the store and counts the budget; a failing store never throws', async () => {
  const store = createFakeStore();
  const clock = createFakeClock('2026-10-18T10:00:00Z');
  const keyring = createKeyring({ keys: [KEYS[0]], clock });
  const budget = createBudget({ keyring, clock });
  const t = createTracker({ store, budget });
  t.record({ ts: clock.now().toISOString(), task: 'lay.reply', agent: 'lay', model: 'openai/gpt-4o-mini', key_index: 0, prompt_tokens: 3000, completion_tokens: 200, cached_tokens: 2000, total_tokens: 3200, cost_usd: 0.00057, latency_ms: 1200, outcome: 'ok', error: null, request_id: 'gen-1', attempts: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.llmCalls.all().length, 1);
  assert.equal(budget.status().keys[0].spent_usd, 0.00057);
  const warns = [];
  const bad = createTracker({ store: { llmCalls: { append: async () => { throw new Error('disk full'); } } }, log: { info() {}, warn: (e, f) => warns.push([e, f]), error() {} } });
  assert.doesNotThrow(() => bad.record({ task: 'lay.reply', model: 'm', outcome: 'ok' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(warns[0][0], 'llm.track_failed');
  const sync = createTracker({ store: { llmCalls: { append: () => { throw new Error('sync boom'); } } }, log: { info() {}, warn: (e, f) => warns.push([e, f]), error() {} } });
  assert.doesNotThrow(() => sync.record({ task: 'lay.reply', model: 'm', outcome: 'ok' }));
});

test('keyStatusLine: limit, remaining, reset per key; never the key value', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00Z');
  const keyring = createKeyring({ keys: [KEYS[0]], clock });
  const budget = createBudget({ keyring, clock, fetchImpl: fakeFetch(() => keyInfo({ limit_remaining: 3.21 })) });
  assert.equal(keyStatusLine(createKeyring({ keys: [] }), null), 'keys: none configured');
  await budget.refresh();
  const line = keyStatusLine(keyring, budget);
  assert.match(line, /keys: 1\/1 usable/);
  assert.match(line, /key0 · limit 15 USD · remaining 3\.21 · reset daily \(2026-10-19T00:00:00\.000Z\)/);
  assert.ok(!line.includes(KEYS[0]));
  keyring.markExhausted(0, '402');
  assert.match(keyStatusLine(keyring, budget), /keys: 0\/1 usable · key0 EXHAUSTED/);
});

test('a rejected key (401) found by the refresh is marked unusable and alerts once, even with no traffic (22 Oct)', async () => {
  const { createKeyring } = require('../../src/brain/keys');
  const { createBudget } = require('../../src/brain/budget');
  const keyring = createKeyring({ keys: ['sk-or-v1-dead'] });
  const alerts = [];
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'User not found.' } }), text: async () => 'User not found.' });
  const budget = createBudget({ keyring, fetchImpl, refreshMs: 0, onKeyRejected: (d) => alerts.push(d) });
  await budget.refresh({ force: true });
  await budget.refresh({ force: true });
  assert.equal(keyring.status().exhausted, true);
  assert.equal(alerts.length, 1, 'one alert, not one per refresh');
});
