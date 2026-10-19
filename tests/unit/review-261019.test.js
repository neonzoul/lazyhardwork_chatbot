// Head review of the real test run 19 Oct 2026 (run1_261019): out of scope, A1 card coherence, speaker, price answer,
// placeholder images, demo café questions. One test per finding, against the fakes and the real knowledge pack.
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
const config = { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22, fastworkUrl: 'https://fastwork.com/user/moslazyhardwork' }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' }, quiet: { windowMinutes: 30, debounceMs: 10 }, publicBaseUrl: 'https://lay.example.com' };

function world(modelQueue = [], over = {}) {
  const line = createFakeLine(); const notifier = createFakeNotifier(); const model = createFakeModel({ queue: modelQueue });
  const clock = createFakeClock(); const store = createFakeStore();
  const deps = { line, notifier, model, clock, store, pack, log: { info() {}, warn() {}, error() {} }, config: { ...config, ...over } };
  const input = (o) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), ...o });
  return { line, notifier, model, clock, store, deps, input };
}

test('1. trading / backtest / indicator → plain "not our work", no model, no "ตอบแทนมอสไม่ได้", lead not_fit', async () => {
  const w = world();
  const r = await runTurn(w.input({ text: 'การ back test ทำได้ไหม' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  const said = w.line.texts().join('\n');
  assert.match(said, /ไม่ใช่งานที่ LazyHardWork รับ/);
  assert.doesNotMatch(said, /ตอบแทนมอสไม่ได้|ระบบเก็บข้อมูลการเทรด/);
  assert.equal(r.session.out_of_scope, true);
  const lead = await w.store.leads.byUser('U1');
  assert.equal(lead.status, 'not_fit');
  await runTurn(w.input({ text: 'เขียนอินดี้ได้ไหม' }), w.deps);
  assert.equal(w.model.calls.length, 0);
});

test('1b. after an out-of-scope question, a model reply that tailors a service to it is regenerated', () => {
  const r = { messages: [{ type: 'text', text: 'AI ช่วยวิเคราะห์ข้อมูลการเทรดได้ครับ', explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: ['capability'], kb_refs: [], intent: 'capability', lead_updates: {}, action: null };
  const out = policy.applyPolicy(r, { session: { out_of_scope: true }, pack: null });
  assert.equal(out.severity, 'regenerate');
  assert.ok(out.violations.some((v) => v.rule === 'out_of_scope_offer'));
});

test('1c. qualified needs a matched card', () => {
  const row = intake.buildLeadRow({ session: { user_id: 'U9', homework: { business: 'เทรด', problem_verbatim: 'อยาก backtest' } }, now: new Date() });
  assert.equal(row.status, 'new');
  const row2 = intake.buildLeadRow({ session: { user_id: 'U9', homework: { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบแชทไม่ทัน' }, draft: { card: 'A2' } }, now: new Date() });
  assert.equal(row2.status, 'qualified');
});

test('2. A1 offer shows its own build package (49,000) and names the review (4,900) as the way in', () => {
  const card = endings.offerCard({ draft: { card: 'A1', tier: 'T1' } }, { deps: { pack } });
  assert.equal(card.data.card_id, 'A1');
  assert.equal(card.data.tier, 'T2');
  assert.equal(pack.ladders.A1.tiers[card.data.tier], 49000);
  assert.match(card.data.note, /AI Business Review 4,900/);
  assert.ok(!card.data.bullets.some((b) => /แผนที่ระบบ|Business Review/.test(b)));
});

test('2b. "อยากได้แบบนี้" on an example → that card and its offer, decided by code (no model, no other card)', async () => {
  const w = world();
  const r = await runTurn(w.input({ kind: 'postback', data: 'WANT_scattered_data', text: '' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.equal(r.session.draft.card, 'A1');
  const offer = w.line.sent.flatMap((x) => x.messages || []).find((m) => m.type === 'flex');
  assert.ok(offer, 'an offer card was sent');
  assert.match(offer.altText, /ระบบงานภายใน/);
});

test('3. speaker: "ผม" meaning Mos becomes "มอส"; "แน่นอน" is dropped', () => {
  assert.equal(policy.speakAsLay('แบบนี้ตรงกับงานที่ผมทำบ่อยครับ ผมจะตั้งค่า AI ให้'), 'แบบนี้ตรงกับงานที่มอสทำบ่อยครับ มอสจะตั้งค่า AI ให้');
  assert.equal(policy.speakAsLay('ผมเป็น Lay ผู้ช่วย AI ของมอสครับ'), 'ผมเป็น Lay ผู้ช่วย AI ของมอสครับ');
  assert.equal(policy.dropCertainty('ถ้ามีปัญหาเรื่องงานซ้ำๆ ผมช่วยได้แน่นอน'), 'ถ้ามีปัญหาเรื่องงานซ้ำๆ ผมช่วยได้');
  assert.equal(policy.dropCertainty('แน่นอนครับ ลาเต้เย็นได้เลย'), 'ได้ครับ ลาเต้เย็นได้เลย');
});

test('4. a plain price question before any card → the approved FAQ answer (4,900 … 49,000), no model', async () => {
  const w = world();
  await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  const said = w.line.texts().join('\n');
  assert.match(said, /4,900/);
  assert.match(said, /49,000/);
});

test('5. placeholder images: without EXAMPLES_IMAGES_READY the examples are text + buttons, no carousel', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'MENU_EXAMPLES', text: '' }), w.deps);
  const msgs = w.line.sent.flatMap((x) => x.messages || []);
  assert.ok(!msgs.some((m) => m.type === 'flex'), 'no flex carousel');
  assert.match(w.line.texts().join('\n'), /ดูตัวอย่างได้ 3 แบบ/);
  assert.ok(w.line.quickReplies().length >= 3);
});

test('6. demo shop asks one thing at a time and never repeats its last message', () => {
  const demo = require('../../src/flows/demo');
  const r = { messages: [
    { type: 'text', text: 'ลาเต้เย็น 1 แก้ว ราคา 70 บาท ครับ ต้องการให้ทำเป็นเย็นหรือร้อนครับ?' },
    { type: 'text', text: 'เลือกความหวานครับ: หวานน้อย, ปกติ, หวานมาก' },
  ] };
  const out = demo.oneQuestionAtATime(r, null);
  assert.equal(out.messages.length, 1);
  const again = demo.oneQuestionAtATime({ messages: [{ type: 'text', text: 'เลือกความหวานครับ: หวานน้อย, ปกติ, หวานมาก.' }, { type: 'text', text: 'รับที่ร้านหรือส่งครับ?' }] }, 'เลือกความหวานครับ: หวานน้อย, ปกติ, หวานมาก');
  assert.deepEqual(again.messages.map((m) => m.text), ['รับที่ร้านหรือส่งครับ?']);
});
