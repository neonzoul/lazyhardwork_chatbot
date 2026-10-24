// Head review of the pre-launch burger chat (20 Oct 2026): marketing is not ours, too early → nurture, C1 needs an operating
// business, screening only after a matched symptom, model-side filler rule, "ผมจะ + studio action" → "เรา".
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
const policy = require('../../src/core/policy');
const intake = require('../../src/leads/intake');
const endings = require('../../src/flows/endings');

const pack = loadPack(path.resolve(__dirname, '..', '..', 'knowledge'));
const config = { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22, fastworkUrl: 'https://fastwork.com/user/moslazyhardwork' }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' }, quiet: { windowMinutes: 30, debounceMs: 10 }, publicBaseUrl: '' };
function world() {
  const line = createFakeLine(); const notifier = createFakeNotifier(); const model = createFakeModel();
  const clock = createFakeClock(); const store = createFakeStore();
  const deps = { line, notifier, model, clock, store, pack, log: { info() {}, warn() {}, error() {} }, config };
  const input = (o) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), ...o });
  return { line, model, store, deps, input };
}
const { normaliseText } = require('../../src/core/turn');

// Mos's hand test on the test OA, 24 Oct (review-pack-mos-test-2026-10-24.md): freeze exception (b), Head + CE.

test('Mos 24 Oct: leading bullets / dashes / quotes come off every line before matching', () => {
  assert.equal(normaliseText('- “ขอลองเป็นลูกค้าร้านตัวอย่างก่อนค่ะ”'), 'ขอลองเป็นลูกค้าร้านตัวอย่างก่อนค่ะ');
  assert.equal(normaliseText('“ให้บอทเช็กสลิปแล้วคอนเฟิร์มส่งของเลยได้ไหม?”\n“เจ้าอื่นเสนอถูกกว่า ของคุณต่างกันตรงไหน?”'), 'ให้บอทเช็กสลิปแล้วคอนเฟิร์มส่งของเลยได้ไหม?\nเจ้าอื่นเสนอถูกกว่า ของคุณต่างกันตรงไหน?');
  assert.equal(normaliseText('“ถ้าราคาโปรเปลี่ยน พนักงานแก้เองได้ไหม?”'), 'ถ้าราคาโปรเปลี่ยน พนักงานแก้เองได้ไหม?');
  assert.equal(normaliseText('• ราคาเท่าไหร่'), 'ราคาเท่าไหร่');
  assert.equal(normaliseText('ราคา 15,000 ใช่ไหม'), 'ราคา 15,000 ใช่ไหม');
});

test('Mos 24 Oct: "- “ขอลองเป็นลูกค้าร้านตัวอย่างก่อนค่ะ”" opens the shop picker by code, no model', async () => {
  const w = world();
  await runTurn(w.input({ text: '- “ขอลองเป็นลูกค้าร้านตัวอย่างก่อนค่ะ”' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  const all = JSON.stringify(w.line.sent);
  assert.match(all, /ร้านกาแฟตัวอย่าง/);
  assert.match(all, /คลินิกความงามตัวอย่าง/);
});

test('Mos 24 Oct: a claimed booking is a violation; asking to confirm, "รอ…ยืนยัน" and handoff lines are not', () => {
  const mk = (x) => ({ messages: [{ type: 'text', text: x, explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: [], kb_refs: [], intent: 'faq', lead_updates: {}, action: null });
  const claim = policy.applyPolicy(mk('ขอบคุณครับ บอทได้ทำการจองคิวทำหน้าที่คลินิกความงามให้พรุ่งนี้บ่าย 2 เรียบร้อยแล้วครับ'), { session: {} });
  assert.ok(claim.violations.some((v) => v.rule === 'claimed_action'));
  assert.equal(claim.severity, 'regenerate');
  for (const ok of ['บอทจะจองคิวทำหน้าที่คลินิกความงามให้พรุ่งนี้บ่าย 2 ครับ กรุณายืนยันว่าต้องการจองคิวนี้หรือไม่ครับ',
    'บอทรับสลิปแล้วส่งให้คนของร้านตรวจและยืนยันครับ บอทไม่ยืนยันเงินหรือสั่งส่งของเอง',
    'สรุปออเดอร์แล้ว รอเจ้าของร้านยืนยันครับ']) {
    assert.ok(!policy.applyPolicy(mk(ok), { session: {} }).violations.some((v) => v.rule === 'claimed_action'), ok);
  }
  // where code already holds Mos's confirmation, the same allow as the lint lets it through
  assert.ok(!policy.applyPolicy(mk('จองคิวคุยกับมอสเรียบร้อยแล้วครับ'), { session: {}, allow: new Set(['booking_confirmed']) }).violations.some((v) => v.rule === 'claimed_action'));
});

test('Mos 24 Oct: a model that claims the booking twice gets the safe line — never "เรียบร้อยแล้ว", never "รับทราบครับ"', async () => {
  const w = world();
  const claim = 'ขอบคุณครับ บอทได้ทำการจองคิวทำหน้าที่คลินิกความงามให้พรุ่งนี้บ่าย 2 เรียบร้อยแล้วครับ';
  w.model.push(text(claim, { intent: 'faq' }), text(claim, { intent: 'faq' }));
  await runTurn(w.input({ text: 'ยืนยันจองคิว' }), w.deps);
  assert.equal(w.model.calls.length, 2, 'one regenerate');
  const last = w.line.texts().slice(-1)[0];
  assert.doesNotMatch(last, /เรียบร้อยแล้ว/);
  assert.notEqual(last, 'รับทราบครับ');
  assert.match(last, /ยังไม่มีอะไรถูกจองไว้/);
});

test('the real sample-shop path says it waits for a person', () => {
  const demo = require('../../src/flows/demo');
  assert.match(demo.strings.sent('ออเดอร์'), /รอยืนยัน/);
});

test('Mos 24 Oct: after the picker, typing "คลินิกความงาม" enters the sample clinic by code', async () => {
  const w = world();
  await runTurn(w.input({ text: '- “ขอลองเป็นลูกค้าร้านตัวอย่างก่อนค่ะ”' }), w.deps);
  await runTurn(w.input({ text: 'คลินิกความงาม' }), w.deps);
  const s = await w.store.sessions.get('U1');
  assert.equal(s.mode, 'demo');
  assert.equal(s.demo_shop, 'clinic');
  assert.equal(w.model.calls.length, 0);
});
