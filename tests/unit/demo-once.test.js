'use strict';
// P1 (Mos on production, 25 Oct): after "#demo-a1", "/forgot" and "/reset" got the same demo-link reply back word for
// word from the model. The demo line reaches the prompt only on the token message, a copied reply is regenerated, and
// slash text from a LINE customer is ordinary text (never a command).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runTurn } = require('../../src/core/turn');
const { createFakeLine } = require('../fakes/line');
const { createFakeNotifier } = require('../fakes/notifier');
const { createFakeModel, text } = require('../fakes/model');
const { createFakeClock } = require('../fakes/clock');
const { createFakeStore } = require('../fakes/store');
const { loadPack } = require('../../src/brain/kb');

const pack = loadPack(path.resolve(__dirname, '..', '..', 'knowledge'));
const config = { contact: { phoneDisplay: '000 000 0000', hoursStart: 13, hoursEnd: 22, fastworkUrl: 'https://example.invalid' }, identity: { layName: 'Agent Lay · AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' }, quiet: { windowMinutes: 30, debounceMs: 10 }, publicBaseUrl: '' };
function world() {
  const line = createFakeLine(); const notifier = createFakeNotifier(); const model = createFakeModel();
  const clock = createFakeClock(); const store = createFakeStore();
  const deps = { line, notifier, model, clock, store, pack, log: { info() {}, warn() {}, error() {} }, config };
  const input = (o) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), ...o });
  return { line, model, store, deps, input };
}
const system = (call) => call.system || (call.messages || []).find((m) => m.role === 'system')?.content || '';
const laySaid = async (w) => (await w.store.messages.recent('U1', 50)).filter((m) => m.role === 'lay').map((m) => m.text);
const DEMO_REPLY = 'ถ้าพี่สนใจดูเดโม AI Agent ของเรา ลองดูได้ที่นี่ครับ https://lhw.anant-agent.com/prototype/agentic-workflow';

async function afterDemo(w) {
  await runTurn(w.input({ kind: 'follow', text: undefined }), w.deps);
  // the token with the visitor's own words goes to the model (the bare prefill is answered by code)
  w.model.push(text(DEMO_REPLY, { intent: 'capability' }));
  await runTurn(w.input({ text: 'มาจากเว็บ ดูเดโม AI Agent อยากรู้ว่าใช้กับร้านดอกไม้ได้ไหม #demo-a1' }), w.deps);
}

test('the "just came from demo" line is in the prompt on the token message only; last_touch never reaches the prompt', async () => {
  const w = world();
  await afterDemo(w);
  assert.match(system(w.model.calls.at(-1)), /เพิ่งมาจากหน้าเดโม A1/);
  w.model.push(text('ได้ครับ ร้านดอกไม้ตอนนี้ลูกค้าทักมาถามเรื่องอะไรบ่อยครับ', { intent: 'fit' }));
  await runTurn(w.input({ text: 'ร้านผมขายดอกไม้ครับ' }), w.deps);
  const later = system(w.model.calls.at(-1));
  assert.doesNotMatch(later, /เพิ่งมาจากหน้าเดโม/);
  assert.doesNotMatch(later, /last_touch/);
  assert.equal((await w.store.sessions.get('U1')).homework.last_touch, 'web-demo-a1', 'the lead still keeps the last touch');
});

test('a reply that copies the last Lay message is regenerated once (Mos 25 Oct: "/forgot")', async () => {
  const w = world();
  await afterDemo(w);
  w.model.push(text(DEMO_REPLY, { intent: 'capability' }), text('อยากให้ช่วยเรื่องไหนครับ พิมพ์บอกได้เลย', { intent: 'unknown' }));
  await runTurn(w.input({ text: '/forgot' }), w.deps);
  const said = await laySaid(w);
  assert.equal(said.filter((t) => t === DEMO_REPLY).length, 1, 'the demo reply was sent once only');
  assert.equal(said.at(-1), 'อยากให้ช่วยเรื่องไหนครับ พิมพ์บอกได้เลย');
  assert.match(w.model.calls.at(-1).messages.at(-1).content, /ซ้ำกับข้อความที่ Lay ส่งไปแล้ว/);
  assert.ok(w.store.events.all().some((e) => e.kind === 'model_repeat'), 'logged as model_repeat');
});

test('a second copy → one honest line with buttons, never the same message again', async () => {
  const w = world();
  await afterDemo(w);
  w.model.push(text(DEMO_REPLY, { intent: 'capability' }), text(DEMO_REPLY, { intent: 'capability' }));
  await runTurn(w.input({ text: '/reset' }), w.deps);
  const said = await laySaid(w);
  assert.equal(said.filter((t) => t === DEMO_REPLY).length, 1);
  assert.match(said.at(-1), /ยังไม่แน่ใจว่าหมายถึงเรื่องไหน/);
  const reply = w.line.sent.at(-1);
  assert.ok(JSON.stringify(reply).includes('quickReply'), 'buttons are offered');
});

test('a short line may repeat ("ได้ครับ" is not a copy)', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'follow', text: undefined }), w.deps);
  w.model.push(text('ได้ครับ', { intent: 'banter' }), text('ได้ครับ', { intent: 'banter' }));
  await runTurn(w.input({ text: 'โอเค' }), w.deps);
  await runTurn(w.input({ text: 'โอเคครับ' }), w.deps);
  assert.equal(w.model.calls.length, 2, 'no regeneration for a short line');
});

test('"/reset" and "/forget" typed by a LINE customer are ordinary text: nothing is cleared or erased', async () => {
  const w = world();
  await afterDemo(w);
  const before = await w.store.sessions.get('U1');
  for (const cmd of ['/reset', '/forget']) {
    w.model.push(text(`ได้ครับ อยากรู้เรื่องไหนครับ (${cmd})`, { intent: 'unknown' }));
    await runTurn(w.input({ text: cmd }), w.deps);
  }
  const after = await w.store.sessions.get('U1');
  assert.equal(after.homework.last_touch, before.homework.last_touch);
  assert.equal(after.context_since || null, before.context_since || null, 'no reset');
  const all = await w.store.messages.recent('U1', 50);
  assert.ok(all.some((m) => m.role === 'customer' && m.text === '/forget'), 'the transcript is kept (no erasure)');
});
