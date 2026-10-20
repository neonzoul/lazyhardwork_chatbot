// Human Mode (Mos, 20 Oct): Mos takes a chat from #leads (button / /take / admin). Lay is silent for that user with no
// timeout, customer messages (even "เรียก Lay") go to the lead thread, Mos's thread messages keep the mode, and only
// Mos's release (/lay) brings Lay back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTurn } = require('../../src/core/turn');
const { createFakeLine } = require('../fakes/line');
const { createFakeNotifier } = require('../fakes/notifier');
const { createFakeModel } = require('../fakes/model');
const { createFakeClock } = require('../fakes/clock');
const { createFakeStore } = require('../fakes/store');
const commands = require('../../src/discord/commands');

const config = { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22 }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' }, quiet: { windowMinutes: 30, debounceMs: 10 }, publicBaseUrl: '' };

function world() {
  const line = createFakeLine(); const notifier = createFakeNotifier(); const model = createFakeModel();
  const clock = createFakeClock(); const store = createFakeStore();
  const relayed = [];
  notifier.relayToMos = async ({ threadId, text }) => { relayed.push({ threadId, text }); };
  notifier.take = async () => ({ threadId: 'T-human' });
  const deps = { line, notifier, model, clock, store, log: { info() {}, warn() {}, error() {} }, config };
  const input = (o) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), ...o });
  return { line, notifier, model, clock, store, deps, input, relayed };
}

test('take → human mode + thread; Lay silent, messages relayed, no timeout; เรียก Lay by the customer does not release', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'follow' }), w.deps);
  const sentBefore = w.line.sent.length;
  const r = await commands.handleCommand({ command: 'take', userId: 'U1' }, { deps: w.deps, config });
  assert.equal(r.ok, true);
  assert.match(r.text, /Human Mode/);
  const s = await w.store.sessions.get('U1');
  assert.equal(s.mode, 'human');
  assert.equal(s.discord_thread_id, 'T-human');

  await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  w.clock.advanceMinutes(240);
  await runTurn(w.input({ text: 'ยังอยู่ไหมคะ', timestamp: w.clock.now().getTime() }), w.deps);
  await runTurn(w.input({ text: 'เรียก Lay', timestamp: w.clock.now().getTime() }), w.deps);
  assert.equal(w.line.sent.length, sentBefore, 'Lay sent nothing');
  assert.equal(w.model.calls.length, 0);
  assert.deepEqual(w.relayed.map((x) => x.text), ['ราคาเท่าไหร่', 'ยังอยู่ไหมคะ', 'เรียก Lay']);
  assert.equal((await w.store.sessions.get('U1')).mode, 'human');
});

test('Mos typing in the thread keeps human mode; /lay releases', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'follow' }), w.deps);
  await commands.handleCommand({ command: 'take', userId: 'U1' }, { deps: w.deps, config });
  await runTurn({ userId: 'U1', kind: 'mos_relay', text: 'สวัสดีครับ มอสเองครับ', timestamp: w.clock.now().getTime() }, w.deps);
  assert.equal((await w.store.sessions.get('U1')).mode, 'human');
  const r = await commands.handleCommand({ command: 'lay', userId: 'U1' }, { deps: w.deps, config, runTurn });
  assert.equal(r.ok, true);
  assert.equal((await w.store.sessions.get('U1')).mode, 'lay');
});

test('#leads posts carry the Human Mode button for that user', () => {
  const row = commands.takeButtonRow('U0123456789abcdef0123456789abcdef');
  assert.equal(row[0].components[0].label, 'Human Mode -⏸️Lay');
  assert.equal(row[0].components[0].custom_id, 'take:U0123456789abcdef0123456789abcdef');
  assert.equal(commands.takeButtonRow(null), undefined);
});

test('the sqlite sessions repo accepts every mode core/session knows (human included)', () => {
  const { createStore } = require('../../src/store');
  const store = createStore({ path: ':memory:', log: { info() {}, warn() {}, error() {} } });
  const s = { user_id: 'Uhm', mode: 'human', mode_since: new Date().toISOString() };
  return Promise.resolve(store.sessions.save(s)).then(() => store.sessions.get('Uhm')).then((got) => { assert.equal(got.mode, 'human'); });
});

test('the sqlite leads repo accepts every lead status intake can produce (not_fit and nurture included)', async () => {
  const { createStore } = require('../../src/store');
  const intake = require('../../src/leads/intake');
  const store = createStore({ path: ':memory:', log: { info() {}, warn() {}, error() {} } });
  for (const [i, status] of [...intake.STATUS_ORDER, ...intake.SIDE_STATUSES].entries()) {
    const saved = await store.leads.upsert({ user_id: `Ust${i}`, status, homework: {} });
    assert.equal(saved.status, status);
  }
});
