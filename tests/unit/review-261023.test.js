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

test('R3 (D-39): the GEO answer offers the Review and the free talk; R4: a typed demo ask opens the shop picker by code', async () => {
  const w = world();
  await runTurn(w.input({ text: 'อยากให้ ChatGPT แนะนำร้านผม รับทำไหม' }), w.deps);
  assert.match(w.line.texts().join('\n'), /คุยฟรี 30 นาทีก่อนก็ได้ครับ/);
  const d = world();
  await runTurn(d.input({ text: 'ขอลองเป็นลูกค้าร้านตัวอย่างก่อนค่ะ' }), d.deps);
  assert.equal(d.model.calls.length, 0);
  const all = JSON.stringify(d.line.sent);
  assert.match(all, /ร้านกาแฟตัวอย่าง/);
  assert.match(all, /คลินิกความงามตัวอย่าง/);
});

test('R2: "not worth hiring us yet" drops a package card in the same reply', () => {
  const r = { messages: [{ type: 'text', text: 'ถ้าแชทเข้าวันละห้าข้อความ อาจไม่คุ้มที่จะจ้างบอทตอนนี้ครับ', explain: false, template: null, alt: null, data: null }, { type: 'card', text: null, explain: false, template: 'offer', alt: 'แพ็กเริ่มต้น AI Chatbot', data: { card_id: 'A2' } }], quick_replies: [], topics: [], kb_refs: [], intent: 'fit', lead_updates: {}, action: null };
  const p = policy.applyPolicy(r, { session: {}, userText: 'วันธรรมดาคนทักประมาณห้าคน' });
  assert.equal(p.response.messages.filter((m) => m.type === 'card').length, 0);
});

test('D-39: the GEO buttons are dropped for a lead who did not ask about being found', () => {
  const mk = (x) => ({ messages: [{ type: 'text', text: x, explain: false, template: null, alt: null, data: null }], quick_replies: ['สนใจ Review', 'คุยฟรีก่อน', 'ไม่เป็นไร'], topics: [], kb_refs: [], intent: 'fit', lead_updates: {}, action: null });
  const shop = policy.applyPolicy(mk('เมื่อแชทเริ่มล้น ค่อยกลับมาคุยเรื่องบอทได้ครับ'), { session: {} });
  assert.deepEqual(shop.response.quick_replies, ['ไม่เป็นไร']);
  const geo = policy.applyPolicy(mk('เรื่องให้ร้านถูกค้นเจอ Review ตรวจให้ได้ครับ'), { session: {}, userText: 'อยากให้ ChatGPT แนะนำร้านผม' });
  assert.equal(geo.response.quick_replies.length, 3);
});

test('#demo-<id> on the first message: lead.source web-demo-<id>, the token is stripped before the model (Issue #2)', async () => {
  const w = world();
  w.model.push(text('ได้ครับ งาน AI Workspace ช่วยให้ AI อ่านไฟล์จริงของคุณครับ', { intent: 'capability' }));
  await runTurn(w.input({ text: 'สนใจตั้งค่า AI Workspace ครับ #demo-a4' }), w.deps);
  const req = JSON.stringify(w.model.calls[0] || {});
  assert.doesNotMatch(req, /#demo-a4/);
  const msgs = await w.store.messages.recent('U1', 20);
  assert.ok(msgs.length > 0);
  assert.ok(!JSON.stringify(msgs).includes('#demo-'));
  const s = await w.store.sessions.get('U1');
  assert.equal(s.lead_source, 'web-demo-a4');
  const row = intake.buildLeadRow({ session: s, now: new Date() });
  assert.equal(row.source, 'web-demo-a4');
});

test('#demo-a2-shop opens the sample-shop picker by code; a token after the first message is ignored', async () => {
  const w = world();
  await runTurn(w.input({ text: 'อยากลองบอทร้านตัวอย่าง #demo-a2-shop' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.match(JSON.stringify(w.line.sent), /ร้านกาแฟตัวอย่าง/);
  assert.equal((await w.store.sessions.get('U1')).lead_source, 'web-demo-a2-shop');
  const v = world();
  v.model.push(text('ได้ครับ'), text('ได้ครับ'));
  await runTurn(v.input({ text: 'แชทเข้าเยอะตอบไม่ทัน' }), v.deps);
  await runTurn(v.input({ text: 'ดูเพิ่ม #demo-c1' }), v.deps);
  assert.equal((await v.store.sessions.get('U1')).lead_source, undefined);
});

// Head GTM round-2 rulings (23 Oct evening)
const mkR = (texts, quick = [], intent = 'fit') => ({ messages: texts.map((x) => ({ type: 'text', text: x, explain: false, template: null, alt: null, data: null })), quick_replies: quick, topics: [], kb_refs: [], intent, lead_updates: {}, action: null });

test('round 2 / 82: a "not worth it yet" reply carries no price and no package name', () => {
  const p = policy.applyPolicy(mkR(['ถ้าแชทเข้าวันละไม่กี่ข้อความ แนะนำให้ใช้ข้อความตอบอัตโนมัติฟรีของ LINE ก่อนครับ ยังไม่ต้องจ้างเรา แต่ถ้าแชทเข้ามากกว่าวันละ 10 ข้อความ เรามีแพ็กลองก่อนที่ราคาเริ่มต้น 15,000 บาทครับ'], ['ราคาเท่าไหร่', 'เริ่มยังไง']), { session: {}, userText: 'มีงบประมาณห้าพัน พอทำได้ไหมคะ' });
  const said = p.response.messages.map((m) => m.text).join('\n');
  assert.match(said, /ตอบอัตโนมัติฟรีของ LINE/);
  assert.doesNotMatch(said, /15,000|แพ็ก|บาท/);
  assert.ok(!p.response.quick_replies.includes('ราคาเท่าไหร่'));
  // asked for paid options → prices stay
  const asked = policy.applyPolicy(mkR(['ตอนนี้ยังไม่ต้องจ้างครับ ถ้าอยากรู้ แพ็กลองก่อนราคาเริ่มต้น 15,000 บาท'], [], 'pricing'), { session: {}, userText: 'ถ้าจะจ้างจริง ราคาเท่าไหร่' });
  assert.match(asked.response.messages[0].text, /15,000/);
});

test('round 2 / 78: a package menu question ("AI Agent หรือ AI Chatbot") is dropped with its buttons', () => {
  const p = policy.applyPolicy(mkR(['ทีมยังใช้ LINE และ Google Sheets เหมือนเดิมครับ ระบบอยู่ข้างหลัง\nถ้าพร้อมแล้ว อยากเริ่มจากแพ็กไหนครับ เช่น AI Agent หรือ AI Chatbot?'], ['AI Agent', 'AI Chatbot']), { session: { draft: { confirmed: 'scattered_data' } }, userText: 'ไม่อยากเปลี่ยนทุกอย่างครับ พนักงานไม่ถนัดคอม' });
  const said = p.response.messages.map((m) => m.text).join('\n');
  assert.match(said, /ระบบอยู่ข้างหลัง/);
  assert.doesNotMatch(said, /AI Agent หรือ AI Chatbot/);
  assert.deepEqual(p.response.quick_replies, []);
});

test('round 2 / 79: the pack carries the A4 revisions per tier and the after-follow-up line', () => {
  const faq = require('fs').readFileSync(require('path').resolve(__dirname, '..', '..', 'knowledge', 'kb', 'faq.md'), 'utf8');
  assert.match(faq, /Starter แก้ได้ 1 ครั้ง ภายใน 5 วัน ถามต่อได้ 7 วัน/);
  assert.match(faq, /หลังช่วงถามต่อ ทักมาได้ครับ เราดูให้ว่าเป็นเรื่องเล็กหรือต้องคิดเป็นงานใหม่/);
});

test('round 2 / 82: "use LINE free auto-reply first" counts as not worth it — no price, no card; no findability pitch for a sales ask', () => {
  const card = { type: 'card', text: null, explain: false, template: 'offer', alt: 'แพ็กเริ่มต้น AI Chatbot', data: { card_id: 'A2' } };
  const r = mkR(['สำหรับงบ 5,000 บาท แนะนำให้ใช้ข้อความตอบอัตโนมัติฟรีของ LINE ก่อนครับ แต่ถ้าแชทเข้าวันละ 10 ข้อความขึ้นไป เรามีแพ็กลองก่อนราคาเริ่มต้น 15,000 บาท']);
  r.messages.push(card);
  const p = policy.applyPolicy(r, { session: {}, userText: 'มีงบประมาณห้าพัน พอทำได้ไหมคะ' });
  const said = p.response.messages.filter((m) => m.type === 'text').map((m) => m.text).join('\n');
  assert.equal(p.response.messages.filter((m) => m.type === 'card').length, 0);
  assert.doesNotMatch(said, /15,000|แพ็ก/);
  const s = policy.applyPolicy(mkR(['บอทไม่ได้พาลูกค้าใหม่เข้าร้านครับ การหาลูกค้าใหม่เป็นงานการตลาด\nถ้าสนใจ อาจใช้ AI Business Review เพื่อดูว่าร้านควรทำอะไรให้ถูกค้นเจอมากขึ้นครับ'], ['สนใจ Review', 'คุยฟรีก่อน', 'ไม่เป็นไร']), { session: {}, userText: 'บอททำให้ลูกค้าเข้าร้านมากขึ้นได้ไหม' });
  const s2 = s.response.messages.map((m) => m.text).join('\n');
  assert.match(s2, /งานการตลาด/);
  assert.doesNotMatch(s2, /ถูกค้นเจอ/);
  assert.deepEqual(s.response.quick_replies, ['ไม่เป็นไร']);
});

test('round 2 / 82: "ถ้ายังไม่จ้าง…" (do-it-yourself ask) gets no code-added offer card', () => {
  const endings = require('../../src/flows/endings');
  const response = mkR(['ถ้ายังไม่จ้าง เริ่มจากข้อความตอบอัตโนมัติของ LINE ได้ครับ'], [], 'howtostart');
  const session = { draft: { card: 'A2', confirmed: 'chat_overload' }, homework: { business: 'ร้านดอกไม้' }, topics_covered: [] };
  assert.equal(endings.decorateResponse({ response, session, deps: {} }), false);
  assert.equal(response.messages.filter((m) => m.type === 'card').length, 0);
});
