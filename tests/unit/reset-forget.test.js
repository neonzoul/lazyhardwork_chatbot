// /reset and /forget (Mos, 20 Oct): manage one user's context and data. Every behaviour is checked against BOTH the fake
// store and the real sqlite store — the fake did not validate like sqlite and two production bugs slipped through on 20 Oct.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTurn } = require('../../src/core/turn');
const { createFakeLine } = require('../fakes/line');
const { createFakeNotifier } = require('../fakes/notifier');
const { createFakeModel, text } = require('../fakes/model');
const { createFakeClock } = require('../fakes/clock');
const { createFakeStore } = require('../fakes/store');
const { createStore } = require('../../src/store');
const commands = require('../../src/discord/commands');

const config = { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22 }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' }, quiet: { windowMinutes: 30, debounceMs: 10 }, publicBaseUrl: '' };
const STORES = {
  fake: () => createFakeStore(),
  sqlite: () => createStore({ path: ':memory:', log: { info() {}, warn() {}, error() {} } }),
};

function world(makeStore, queue = []) {
  const line = createFakeLine(); const notifier = createFakeNotifier(); const model = createFakeModel({ queue });
  const clock = createFakeClock(); const store = makeStore();
  const deps = { line, notifier, model, clock, store, log: { info() {}, warn() {}, error() {} }, config };
  const input = (o) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), ...o });
  return { line, notifier, model, clock, store, deps, input };
}

for (const [name, makeStore] of Object.entries(STORES)) {
  test(`[${name}] /reset clears what Lay knows and starts the model history now; transcript and lead stay`, async () => {
    const w = world(makeStore, [text('ร้านกาแฟครับ', { intent: 'fit', lead_updates: { business: 'ร้านกาแฟ', problem_verbatim: 'แชทเข้าเยอะตอบไม่ทัน' } }), text('สวัสดีครับ')]);
    await runTurn(w.input({ kind: 'follow' }), w.deps);
    await runTurn(w.input({ text: 'ร้านกาแฟครับ แชทเข้าเยอะตอบไม่ทัน' }), w.deps);
    const before = await w.store.sessions.get('U1');
    assert.equal(before.homework.business, 'ร้านกาแฟ');
    w.clock.advanceMinutes(5);
    const r = await commands.handleCommand({ command: 'reset', userId: 'U1' }, { deps: w.deps, config });
    assert.equal(r.ok, true);
    const s = await w.store.sessions.get('U1');
    assert.deepEqual(s.homework, {});
    assert.deepEqual(s.draft, {});
    assert.deepEqual(s.topics_covered, []);
    assert.equal(s.mode, 'lay');
    assert.ok(s.context_since);
    assert.ok((await w.store.messages.recent('U1', 50)).length >= 2, 'transcript kept');
    w.clock.advanceMinutes(1);
    await runTurn(w.input({ text: 'ทำอะไรได้บ้าง', timestamp: w.clock.now().getTime() }), w.deps);
    const last = w.model.calls[w.model.calls.length - 1];
    const sent = JSON.stringify(last.messages || last);
    assert.doesNotMatch(sent, /ร้านกาแฟครับ แชทเข้าเยอะ/, 'old turns are not in the model history');
  });

  test(`[${name}] /forget asks first, then erases the user from every table; others untouched`, async () => {
    const w = world(makeStore, [text('ได้ครับ', { lead_updates: { business: 'ร้านกาแฟ' } }), text('ได้ครับ')]);
    await runTurn(w.input({ kind: 'follow' }), w.deps);
    await runTurn(w.input({ text: 'ร้านกาแฟครับ' }), w.deps);
    await runTurn(w.input({ userId: 'U2', kind: 'follow' }), w.deps);
    await w.store.events.append({ kind: 'note', user_id: 'U1', payload: {}, created_at: w.clock.now().toISOString() });
    const ask = await commands.handleCommand({ command: 'forget', userId: 'U1', args: '' }, { deps: w.deps, config });
    assert.equal(ask.ok, true);
    assert.ok(ask.components, 'a confirm button');
    assert.ok(await w.store.sessions.get('U1'), 'nothing erased before the confirm');
    const done = await commands.handleCommand({ command: 'forget', userId: 'U1', args: 'confirmed' }, { deps: w.deps, config });
    assert.equal(done.ok, true);
    assert.equal(await w.store.sessions.get('U1'), null);
    assert.equal((await w.store.messages.recent('U1', 50)).length, 0);
    assert.equal(await w.store.leads.byUser('U1'), null);
    assert.ok(await w.store.sessions.get('U2'), 'another user is untouched');
    assert.ok((await w.store.messages.recent('U2', 50)).length >= 1);
  });
}

test('[sqlite] forgetUser covers every table that holds user rows, in one transaction', async () => {
  const store = STORES.sqlite();
  const db = store._db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all().map((r) => r.name);
  const withUser = tables.filter((t) => db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'user_id'));
  const counts = await store.forgetUser('Unobody');
  for (const t of withUser) assert.ok(t in counts, `forgetUser misses table ${t}`);
});
