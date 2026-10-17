// The pipeline against the fakes (policy/cards/prompt modules may or may not be merged — the pipeline degrades).
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTurn } = require('../../src/core/turn');
const { createFakeLine } = require('../fakes/line');
const { createFakeNotifier } = require('../fakes/notifier');
const { createFakeModel, text } = require('../fakes/model');
const { createFakeClock } = require('../fakes/clock');
const { createFakeStore } = require('../fakes/store');

const config = { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22, fastworkUrl: 'https://fastwork.co/user/mos_lazyhardwork' }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' }, quiet: { windowMinutes: 30, debounceMs: 10 }, publicBaseUrl: '' };

function world(modelQueue = []) {
  const line = createFakeLine(); const notifier = createFakeNotifier(); const model = createFakeModel({ queue: modelQueue });
  const clock = createFakeClock(); const store = createFakeStore();
  const deps = { line, notifier, model, clock, store, log: { info() {}, warn() {}, error() {} }, config };
  const input = (over) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), ...over });
  return { line, notifier, model, clock, store, deps, input };
}

test('follow → opening with 3 quick replies, Lay sender, via reply token', async () => {
  const w = world();
  const r = await runTurn(w.input({ kind: 'follow' }), w.deps);
  assert.equal(r.errors.length, 0);
  assert.equal(w.line.sent[0].via, 'reply');
  assert.deepEqual(w.line.quickReplies(), ['ทำอะไรได้บ้าง', 'เหมาะกับงานผมไหม', 'ขอดูตัวอย่าง']);
  assert.equal(w.line.senders()[0], 'Lay · ผู้ช่วย AI');
  assert.ok(w.line.texts()[0].includes('3 เรื่อง'));
});

test('a question goes to the model; topics union; follow-up quick replies filtered', async () => {
  const w = world([text('แล้วแต่งานครับ ราคาเริ่มต้น 4,900 บาท', { topics: ['pricing'], intent: 'pricing', quick_replies: ['ราคาเท่าไหร่', 'เริ่มยังไง'] })]);
  const r = await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.session.topics_covered, ['pricing']);
  assert.deepEqual(w.line.quickReplies(), ['เริ่มยังไง']); // 'ราคาเท่าไหร่' dropped: covered
  assert.equal(w.model.calls.length, 1);
});

test('model throws → honest fallback with phone + เรียก Lay, never silent', async () => {
  const w = world(['throw']);
  const r = await runTurn(w.input({ text: 'อธิบายเพิ่ม' }), w.deps);
  assert.equal(w.line.sent.length, 1);
  assert.match(w.line.texts()[0], /095 569 1674/);
  assert.deepEqual(w.line.quickReplies(), ['เรียก Lay']);
  assert.ok(w.store.events.all().some((e) => e.kind === 'model_fallback'));
  assert.equal(r.session.mode, 'lay');
});

test('garbage model output → fallback', async () => {
  const w = world(['garbage']);
  await runTurn(w.input({ text: 'ทำอะไรได้บ้าง' }), w.deps);
  assert.match(w.line.texts()[0], /ขัดข้อง/);
});

test('ask for a human → notify first, quiet mode, เรียก Lay button; notifier failure → truth', async () => {
  const w = world();
  const r = await runTurn(w.input({ text: 'ขอคุยกับคนจริงครับ' }), w.deps);
  assert.equal(r.action, 'handoff_human');
  assert.equal(w.notifier.named('handoff').length, 1);
  assert.equal(r.session.mode, 'quiet');
  assert.match(w.line.texts()[0], /ส่งเรื่องให้มอสแล้ว/);
  assert.deepEqual(w.line.quickReplies(), ['เรียก Lay']);
  // in quiet: first message gets one ack, second is stored silently
  w.line.reset();
  await runTurn(w.input({ text: 'ยังอยู่ไหม' }), w.deps);
  assert.equal(w.line.sent.length, 1); assert.match(w.line.texts()[0], /กำลังรอมอส/);
  w.line.reset();
  const r3 = await runTurn(w.input({ text: 'ฮัลโหล' }), w.deps);
  assert.equal(w.line.sent.length, 0); assert.equal(r3.silent, true);
  // เรียก Lay resumes
  const r4 = await runTurn(w.input({ text: 'เรียก Lay' }), w.deps);
  assert.equal(r4.session.mode, 'lay'); assert.match(w.line.texts()[0], /Lay กลับมาดูแลต่อ/);

  const w2 = world(); w2.notifier.fail.handoff = true;
  const f = await runTurn(w2.input({ text: 'คุยกับมอส' }), w2.deps);
  assert.equal(f.action, null); assert.equal(f.session.mode, 'lay');
  assert.match(w2.line.texts()[0], /ขัดข้อง/); assert.doesNotMatch(w2.line.texts()[0], /ส่งเรื่องให้มอสแล้ว/);
});

test('quiet window expires after 30 min with no customer message', async () => {
  const w = world([text('ได้ครับ', { topics: ['capability'], intent: 'capability' })]);
  await runTurn(w.input({ text: 'คุยกับมอส' }), w.deps);
  w.clock.advanceMinutes(31); w.line.reset();
  const r = await runTurn(w.input({ text: 'ทำอะไรได้บ้าง', timestamp: w.clock.now().getTime() }), w.deps);
  assert.equal(r.session.mode, 'lay');
  assert.equal(w.model.calls.length, 1);
});

test('model says ไม่รู้ (handoff_unknown) → gap logged, button offered, Lay stays; tapping the button forwards', async () => {
  const w = world([text('เรื่องนี้ผมยังไม่มีข้อมูลครับ', { intent: 'unknown', action: 'handoff_unknown' })]);
  const r = await runTurn(w.input({ text: 'รับทำแอปไหม' }), w.deps);
  assert.equal(r.action, null);
  assert.equal(w.store.kbGaps.all().length, 1);
  assert.deepEqual(w.line.quickReplies(), ['ส่งให้มอสตอบ', 'ถามเรื่องอื่น']);
  assert.equal(r.session.mode, 'lay');
  w.line.reset();
  const r2 = await runTurn(w.input({ kind: 'postback', data: 'FORWARD_TO_MOS' }), w.deps);
  assert.equal(r2.action, 'handoff_unknown');
  assert.equal(r2.session.mode, 'lay');
  assert.equal(w.notifier.named('handoff')[0].payload.question, 'รับทำแอปไหม');
});

test('closing signal after two topics → loose-ends once, no model call', async () => {
  const w = world();
  const s = await w.store.sessions.getOrCreate('U1'); s.topics_covered = ['pricing', 'capability']; s.opened = true; await w.store.sessions.save(s);
  const r = await runTurn(w.input({ text: 'ขอบคุณครับ' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.deepEqual(w.line.quickReplies(), ['เหมาะกับงานผมไหม', 'ใช้เวลานานไหม', 'นัดคุยกับมอส']);
  assert.equal(r.session.loose_ends_fired, true);
});

test('media gets its own reply; text never gets the media reply', async () => {
  const w = world([text('ครับ', { intent: 'banter' })]);
  await runTurn(w.input({ kind: 'media', mediaType: 'image' }), w.deps);
  assert.match(w.line.texts()[0], /รูปหรือไฟล์/);
  w.line.reset();
  await runTurn(w.input({ text: 'ไอ้สัส' }), w.deps);
  assert.doesNotMatch(w.line.texts()[0], /รูปหรือไฟล์/);
});

test('Mos relay pushes as มอส and silences Lay', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'mos_relay', text: 'สวัสดีครับ มอสเองครับ', replyToken: null }), w.deps);
  assert.equal(w.line.senders()[0], 'มอส');
  assert.deepEqual(w.line.quickReplies(), ['เรียก Lay']);
  w.line.reset();
  const r = await runTurn(w.input({ text: 'ครับผม' }), w.deps);
  assert.equal(r.silent, true); assert.equal(w.line.sent.length, 0);
});

test('LINE push fails twice → undelivered event, no crash loop', async () => {
  const w = world([text('ครับ', { intent: 'capability', topics: ['capability'] })]);
  w.line.fail = { push: new Error('500'), reply: new Error('500') };
  // fakes read fail at call time
  const origPush = w.line.push; w.line.push = async () => { throw new Error('500'); }; w.line.reply = async () => { throw new Error('500'); };
  const r = await runTurn(w.input({ text: 'ทำอะไรได้บ้าง' }), w.deps);
  assert.ok(w.store.events.all().some((e) => e.kind === 'undelivered'));
  assert.ok(r.errors.length >= 1);
  w.line.push = origPush;
});
