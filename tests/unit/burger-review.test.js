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

test('pre-launch → "not needed yet, come back when…", no model, no card; lead nurture', async () => {
  const w = world();
  await runTurn(w.input({ text: 'กำลังจะเริ่มทำธุรกิจขายburger homemade' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  const said = w.line.texts().join('\n');
  assert.match(said, /ยังไม่ต้องใช้ระบบหรือจ้างเรา/);
  assert.doesNotMatch(said, /Business Review|4,900/);
  assert.equal((await w.store.leads.byUser('U1')).status, 'nurture');
});

test('marketing work → not ours, one tip, no card; an in-scope chat problem from ads still goes to the model', async () => {
  const w = world();
  await runTurn(w.input({ text: 'การตลาด' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.match(w.line.texts().join('\n'), /ไม่ใช่งานที่ LazyHardWork รับ/);
  assert.equal(w.line.sent.flatMap((x) => x.messages || []).filter((m) => m.type === 'flex').length, 0);
});

test('C1 fits only an operating business with work somewhere', () => {
  assert.equal(endings.c1Fits({ homework: {} }), false);
  assert.equal(endings.c1Fits({ homework: { where_work_lives: 'ยังไม่ได้เริ่มทำอะไรเลยค่ะ' } }), false);
  assert.equal(endings.c1Fits({ too_early: true, homework: { where_work_lives: 'Google Sheets' } }), false);
  assert.equal(endings.c1Fits({ homework: { where_work_lives: 'Google Sheets กับ LINE' } }), true);
});

test('policy: no package for a too-early lead; screening before a symptom is regenerated; ผมจะดูงาน → เราดูงาน', () => {
  const mk = (x, intent = 'capability') => ({ messages: [{ type: 'text', text: x, explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: [], kb_refs: [], intent, lead_updates: {}, action: null });
  assert.equal(policy.applyPolicy(mk('ลองแพ็ก AI Business Review ราคาเริ่มต้น 4,900 บาทได้ครับ'), { session: { too_early: true } }).severity, 'regenerate');
  assert.ok(policy.applyPolicy(mk('ตอนนี้มีคนช่วยทำการตลาดอยู่กี่คนครับ'), { session: {}, userText: 'การตลาด' }).violations.some((v) => v.rule === 'screening_before_symptom'));
  assert.ok(!policy.applyPolicy(mk('ตอนนี้มีคนตอบแชทกี่คนครับ'), { session: {}, userText: 'แชทเข้าเยอะตอบไม่ทัน' }).violations.some((v) => v.rule === 'screening_before_symptom'));
  assert.equal(policy.speakAsLay('ผมจะดูงานจริงของคุณสองรอบ'), 'เราดูงานจริงของคุณสองรอบ');
});

test('lead status: nurture beats not_fit; qualified still needs a card', () => {
  const row = intake.buildLeadRow({ session: { user_id: 'U2', too_early: true, not_fit: true, homework: { business: 'เบอร์เกอร์', problem_verbatim: 'การตลาด', came_from: 'เพื่อนแชร์โพสต์' } }, now: new Date() });
  assert.equal(row.status, 'nurture');
  assert.equal(row.homework.came_from, 'เพื่อนแชร์โพสต์');
});

test('a swear word → one calm line by code, no model, no buttons', async () => {
  const w = world();
  await runTurn(w.input({ text: 'ไอเหี้ยมอส' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.equal(w.line.texts().length, 1);
  assert.doesNotMatch(w.line.texts()[0], /[?？]|แพ็ก|ราคา/);
});

test('pre-launch: telling us about the team gets the short line by code; each repeat is shorter', async () => {
  const w = world();
  await runTurn(w.input({ text: 'กำลังจะเริ่มทำธุรกิจขายburger homemade' }), w.deps);
  await runTurn(w.input({ text: 'มี 3 คน ตัวเราทำการตลาด พี่สาวทำเอกสาร' }), w.deps);
  await runTurn(w.input({ text: 'ยังไม่ได้เริ่มทำอะไรเลยค่ะ' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  const t = w.line.texts();
  assert.equal(t.length, 3);
  assert.ok(t[1].length < t[0].length && t[2].length < t[1].length);
});

test('case B (22 Oct): an operating business clears the too-early flag and the lead leaves nurture', async () => {
  const w = world();
  await runTurn(w.input({ text: 'กำลังจะเริ่มทำธุรกิจขายburger homemade' }), w.deps);
  assert.equal((await w.store.leads.byUser('U1')).status, 'nurture');
  w.model.push(text('งานไหนล้นที่สุดครับ เช่น ตอบแชทถามห้องว่างกับราคา คำถามแขกซ้ำๆ หรือเอกสารหลังบ้าน', { intent: 'fit', lead_updates: { business: 'โรงแรม' } }));
  await runTurn(w.input({ text: 'ผมทำธุรกิจโรงแรม อยากเอา Ai ไปใช้ครับ' }), w.deps);
  const s = await w.store.sessions.get('U1');
  assert.equal(s.too_early, false);
  assert.equal(s.homework.business, 'โรงแรม');
  assert.notEqual((await w.store.leads.byUser('U1')).status, 'nurture');
  assert.doesNotMatch(w.line.texts().join('\n'), /ยังไม่ต้องเริ่มอะไรกับเรา/);
});

test('precedence (22 Oct): both signals in one message → one clarifying question, nothing set', async () => {
  const w = world();
  await runTurn(w.input({ text: 'กำลังจะเปิดร้าน อยากเอา AI ไปใช้' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.deepEqual(w.line.texts(), ['ตอนนี้เปิดขายอยู่แล้วหรือยังครับ']);
  const s = await w.store.sessions.get('U1');
  assert.ok(!s.too_early && !s.operating);
});

test('GEO/SEO interest (22 Oct): honest "not open yet", lead stays on its ladder; only the tap records interest=geo', async () => {
  const w = world();
  await runTurn(w.input({ text: 'อยากให้ ChatGPT แนะนำร้านผมได้ไหมครับ' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.match(w.line.texts()[0], /ยังไม่ได้เปิดเป็นบริการ/);
  let s = await w.store.sessions.get('U1');
  assert.ok(!s.not_fit);
  assert.equal(s.homework.interest, undefined, 'a curious ask is not counted');
  assert.equal(s.homework.problem_verbatim, 'อยากให้ ChatGPT แนะนำร้านผมได้ไหมครับ');
  await runTurn(w.input({ kind: 'postback', data: 'GEO_NOTE', text: '' }), w.deps);
  s = await w.store.sessions.get('U1');
  assert.equal(s.homework.interest, 'geo');
  const lead = await w.store.leads.byUser('U1');
  assert.equal(lead.homework.interest, 'geo');
  assert.notEqual(lead.status, 'not_fit');
  const { leadLine } = require('../../src/discord/format');
  assert.match(leadLine({ lead, reason: 'status' }), /สนใจ: GEO \(ยังไม่มีบริการ\)/);
});

test('GEO regex does not catch our own services ("AI รู้จักงานผม" is A4; "AI แนะนำสินค้าให้ลูกค้า" is a chatbot)', async () => {
  for (const t of ['อยากให้ AI รู้จักงานผม', 'ให้ AI แนะนำสินค้าให้ลูกค้าได้ไหม', 'ใช้ AI แล้วเจอปัญหาตอบผิด']) {
    const w = world();
    w.model.push(text('ได้ครับ'));
    await runTurn(w.input({ text: t }), w.deps);
    assert.doesNotMatch(w.line.texts().join('\n'), /ยังไม่ได้เปิดเป็นบริการ/, t);
  }
});

test('a GEO ask the regex misses: the model offers "จดไว้ให้หน่อย" and the tap records interest=geo (Head GTM 22 Oct)', async () => {
  const w = world();
  w.model.push(text('เรื่องนี้ LazyHardWork ยังไม่ได้เปิดเป็นบริการครับ กำลังเตรียมอยู่ และทดลองกับเว็บของเราเองก่อน ถ้าอยากให้แจ้งตอนเปิด ผมจดไว้ให้ได้ครับ', { intent: 'out_of_scope', quick_replies: ['จดไว้ให้หน่อย', 'ไม่เป็นไร'] }));
  await runTurn(w.input({ text: 'อยากให้ ChatGPT รู้จักร้านเรา' }), w.deps);
  assert.equal(w.model.calls.length, 1);
  await runTurn(w.input({ text: 'จดไว้ให้หน่อย' }), w.deps);
  assert.equal(w.model.calls.length, 1, 'the tap is handled by code');
  assert.equal((await w.store.sessions.get('U1')).homework.interest, 'geo');
});
