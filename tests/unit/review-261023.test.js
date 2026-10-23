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

// Head GTM rulings on the GPT review run (23 Oct): A1–A5, R1–R4.

test('A1/A2: the bakery\'s own words name the problem; a screening line before a symptom is removed in place, not blocked', () => {
  const fit = require('../../src/flows/fit');
  assert.ok(fit.symptomFromText('ส่วนใหญ่เสียเวลาตามรายละเอียดลูกค้า แล้วก็ถามกันเองว่าใครทำถึงไหน'));
  const mk = (...xs) => ({ messages: xs.map((x) => ({ type: 'text', text: x, explain: false, template: null, alt: null, data: null })), quick_replies: [], topics: [], kb_refs: [], intent: 'fit', lead_updates: {}, action: null });
  const p = policy.applyPolicy(mk('งานแบบนี้ระบบช่วยรวมสถานะไว้ที่เดียวได้ครับ', 'ตอนนี้มีคนทำงานนี้กี่คนครับ'), { session: {}, userText: 'ร้านวุ่นมาก' });
  assert.ok(!p.violations.some((v) => v.rule === 'screening_before_symptom'));
  assert.equal(p.severity, 'fix');
  assert.doesNotMatch(p.response.messages.map((m) => m.text).join('\n'), /กี่คน/);
});

test('A3/A4: "ต่อหน้าผม" becomes "ต่อหน้าเรา"; the stock "any more questions?" closer is dropped', () => {
  assert.equal(policy.speakAsLay('ให้คุณรันเองต่อหน้าผมครับ'), 'ให้คุณรันเองต่อหน้าเราครับ');
  assert.equal(policy.stripClosers('ระยะเวลาประมาณ 14 วันครับ\nตอนนี้มีคำถามเพิ่มเติมอะไรอีกไหมครับ?'), 'ระยะเวลาประมาณ 14 วันครับ');
});

test('R1: a guarantee question gets the fixed honest line by code, GEO wording after a GEO ask', async () => {
  const w = world();
  await runTurn(w.input({ text: 'บอทตอบถูกทุกข้อ รับประกันได้ไหมครับ' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.match(w.line.texts().join('\n'), /^เราไม่รับประกันผลลัพธ์เป็นตัวเลขครับ/);
  const g = world();
  await runTurn(g.input({ text: 'อยากให้ ChatGPT แนะนำร้านผม รับทำไหม' }), g.deps);
  await runTurn(g.input({ text: 'จ่ายแล้วรับประกันได้ไหมว่าจะถูกแนะนำ ภายในสามเดือน?' }), g.deps);
  assert.equal(g.model.calls.length, 0);
  assert.match(g.line.texts().join('\n'), /ไม่มีใครรับประกันได้ว่า AI จะแนะนำร้านไหนครับ/);
  assert.doesNotMatch(g.line.texts().join('\n'), /^รับทราบครับ$/m);
});

test('R2: a stated budget is not a handoff — the model\'s scope handoff is ignored, Lay answers and stays on', async () => {
  const w = world();
  w.model.push(text('งบห้าพันเริ่มจากข้อความทักทายและตอบอัตโนมัติของ LINE OA เองก่อนได้ครับ ไม่มีค่าใช้จ่าย', { intent: 'special_price', action: 'handoff_scope' }));
  w.model.push(text('ช่วงเทศกาลถ้าแชทเริ่มล้น ค่อยมาดูเรื่องบอทกันครับ', { intent: 'fit' }));
  await runTurn(w.input({ text: 'อยากได้บอทตอบลูกค้าร้านดอกไม้ค่ะ ทำคนเดียว มีงบประมาณห้าพัน พอทำได้ไหมคะ?' }), w.deps);
  await runTurn(w.input({ text: 'วันธรรมดาคนทักประมาณห้าคน แต่เทศกาลจะเยอะ' }), w.deps);
  const said = w.line.texts().join('\n');
  assert.doesNotMatch(said, /ตัดสินใจแทนมอส|ส่งเรื่องให้มอสแล้ว/);
  assert.match(said, /ช่วงเทศกาล/);
  const s = await w.store.sessions.get('U1');
  assert.equal(s.mode, 'lay');
});

test('R2: asking for a discount still hands off', async () => {
  const w = world();
  await runTurn(w.input({ text: 'ลดราคาได้ไหมคะ' }), w.deps);
  assert.match(w.line.texts().join('\n'), /ตัดสินใจแทนมอส/);
});

test('R3: the GEO answer offers the free talk and the note; R4: a typed demo ask opens the shop picker by code', async () => {
  const w = world();
  await runTurn(w.input({ text: 'อยากให้ ChatGPT แนะนำร้านผม รับทำไหม' }), w.deps);
  assert.match(w.line.texts().join('\n'), /นัดคุยฟรี 30 นาที/);
  const d = world();
  await runTurn(d.input({ text: 'ขอลองเป็นลูกค้าร้านตัวอย่างก่อนค่ะ' }), d.deps);
  assert.equal(d.model.calls.length, 0);
  const all = JSON.stringify(d.line.sent);
  assert.match(all, /ร้านกาแฟตัวอย่าง/);
  assert.match(all, /คลินิกความงามตัวอย่าง/);
});
