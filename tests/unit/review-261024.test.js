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

test('Mos 24 Oct: "วันนี้ได้มั้ย" while the day buttons are up is the day answer — never the neutral line, no model', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'BOOK_START', text: '' }), w.deps);
  // answer the homework / name questions the booking asks first, as a customer would
  for (let i = 0; i < 6; i++) {
    const step = (await w.store.sessions.get('U1')).booking_step;
    if (step === 'window_day') break;
    await runTurn(w.input({ text: step === 'name' || step === 'name_text' ? 'มอส' : 'ร้านเค้กตามสั่ง ตามรายละเอียดลูกค้าไม่ทัน' }), w.deps);
  }
  assert.equal((await w.store.sessions.get('U1')).booking_step, 'window_day', 'precondition: the day question is up');
  const calls = w.model.calls.length;
  await runTurn(w.input({ text: 'วันนี้ได้มั้ย' }), w.deps);
  const s = await w.store.sessions.get('U1');
  assert.equal(w.model.calls.length, calls);
  assert.match(s.draft.window_day, /^วันนี้/);
  assert.equal(s.booking_step, 'window_time');
  assert.notEqual(w.line.texts().slice(-1)[0], 'รับทราบครับ');
  await runTurn(w.input({ text: 'บ่ายสองได้ไหม' }), w.deps);
  assert.equal((await w.store.sessions.get('U1')).draft.window_time, 'บ่าย 13-17');
});

test('Mos 24 Oct B2: "ต่างจากที่ผมทำเองยังไง" (Claude Projects) gets faq.a4-vs-projects verbatim — four points + the honest last line, no model', async () => {
  const w = world();
  await runTurn(w.input({ text: 'เห็น Workspace Setup 4,999 ครับ ผมใช้ Claude Projects แล้ว อัปโหลดไฟล์เองก็เป็น ของคุณต่างจากที่ผมทำเองยังไง?' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  const said = w.line.texts().join('\n');
  for (const part of ['Claude Projects คือที่ใส่ไฟล์', '1) อ่านไฟล์ของร้านแล้วจัดใหม่ให้ AI หาเจอ', '2) เขียนไฟล์กฎของร้าน', '3) ทำคำสั่งพร้อมใช้', '4) ติดตั้งบน Claude Desktop', 'ทำเองคุ้มกว่าครับ ไม่ต้องจ้างเรา']) assert.ok(said.includes(part), part);
  assert.doesNotMatch(said, /จำทุกอย่าง/);
  // a plain mention of Claude without the comparison still goes to the model
  const v = world();
  v.model.push(text('ได้ครับ', { intent: 'capability' }));
  await runTurn(v.input({ text: 'ทีมผมใช้ Claude อยู่' }), v.deps);
  assert.equal(v.model.calls.length, 1);
});

test('booking: a time question the buttons do not answer ("ว่างกี่โมงบ้าง") → the honest check-the-queue line + handoff, never the neutral line', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'BOOK_START', text: '' }), w.deps);
  for (let i = 0; i < 6; i++) {
    const step = (await w.store.sessions.get('U1')).booking_step;
    if (step === 'window_day') break;
    await runTurn(w.input({ text: step === 'name' || step === 'name_text' ? 'มอส' : 'ร้านเค้กตามสั่ง ตามรายละเอียดลูกค้าไม่ทัน' }), w.deps);
  }
  const calls = w.model.calls.length;
  await runTurn(w.input({ text: 'มอสว่างกี่โมงบ้างครับ' }), w.deps);
  assert.equal(w.model.calls.length, calls);
  const last = w.line.texts().slice(-1)[0];
  assert.match(last, /ขอเช็กคิวกับมอสก่อนนะครับ แล้วจะยืนยันเวลาให้ในแชทนี้/);
  assert.doesNotMatch(last, /ยืนยันแล้ว|เรียบร้อย/);
  assert.equal((await w.store.sessions.get('U1')).mode, 'quiet');
});

// CE review 24 Oct (22c1928..f339295)
test('CE review: describing what a bot does is not a claim — offer.md:126 and the conditional probes pass; real claims still caught', () => {
  for (const t of ['• รับออเดอร์ / จองคิว สรุปรายการเรียบร้อย รอคนกดยืนยัน — บอทไม่ยืนยันเรื่องเงินเอง',
    'เมื่อชำระเงินเรียบร้อยแล้ว เราเริ่มงานทันที', 'หลังโอนมัดจำสำเร็จ เราส่งไฟล์ให้',
    'ระบบจะส่งข้อความยืนยันให้ลูกค้าเมื่อจองเรียบร้อย', 'สรุปออเดอร์เรียบร้อยครับ',
    'แสดงการ์ดสรุปการจองให้ลูกค้ากดยืนยัน แล้วส่งต่อให้เจ้าของร้าน', 'ทำคำสั่งที่ใช้ซ้ำได้ ให้ AI ที่คุณมีอยู่แล้วรู้จักร้าน']) {
    assert.equal(policy.claimsAction(t), false, t);
  }
  for (const t of ['ขอบคุณครับ บอทได้ทำการจองคิวทำหน้าที่คลินิกความงามให้พรุ่งนี้บ่าย 2 เรียบร้อยแล้วครับ', 'จองคิวให้แล้วครับ', 'การจองของพี่สำเร็จแล้วครับ']) {
    assert.equal(policy.claimsAction(t), true, t);
  }
  // nothing in the generated pack trips it
  const fs = require('fs'); const dir = path.resolve(__dirname, '..', '..', 'knowledge', 'kb');
  const flagged = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => policy.claimsAction(l)));
  assert.deepEqual(flagged, []);
});

test('CE review: after Mos really confirmed the booking, "ยืนยันแล้ว" from the model goes through (no safe line)', async () => {
  const w = world();
  const s = await w.store.sessions.getOrCreate('U1');
  s.booking_step = 'confirmed'; s.booking = { status: 'confirmed' }; s.opened = true;
  await w.store.sessions.save(s);
  w.model.push(text('นัดคุยกับมอสยืนยันแล้วครับ เจอกันตามเวลาที่นัดไว้', { intent: 'faq' }));
  await runTurn(w.input({ text: 'เจอกันกี่โมงนะครับ' }), w.deps);
  const last = w.line.texts().slice(-1)[0];
  assert.match(last, /ยืนยันแล้ว/);
  assert.equal(w.model.calls.length, 1);
});

test('CE review: a negated day / time during the booking is not taken as a slot — it is handed to Mos honestly', async () => {
  for (const said of ['พรุ่งนี้ไม่ว่าง', 'เช้าไม่สะดวก ขอเย็น']) {
    const w = world();
    await runTurn(w.input({ kind: 'postback', data: 'BOOK_START', text: '' }), w.deps);
    for (let i = 0; i < 6; i++) {
      const step = (await w.store.sessions.get('U1')).booking_step;
      if (step === 'window_day') break;
      await runTurn(w.input({ text: step === 'name' || step === 'name_text' ? 'มอส' : 'ร้านเค้กตามสั่ง ตามรายละเอียดลูกค้าไม่ทัน' }), w.deps);
    }
    if (said.startsWith('เช้า')) await runTurn(w.input({ text: 'วันนี้' }), w.deps);
    await runTurn(w.input({ text: said }), w.deps);
    const s = await w.store.sessions.get('U1');
    if (said.startsWith('พรุ่ง')) assert.ok(!/^พรุ่งนี้/.test(s.draft.window_day || ''), said);
    else assert.notEqual(s.draft.window_time, 'เช้า 9-12', said);
    assert.match(w.line.texts().slice(-1)[0], /ขอเช็กคิวกับมอสก่อนนะครับ/, said);
  }
});

// CE review 24 Oct (f339295..da4333e): two regex fixes before ship
test('CE review: the A4 answer needs a named tool / A4 AND a difference or do-it-yourself ask — "ตั้งค่า LINE OA ทำเองได้ไหม" does not get it', async () => {
  for (const t of ['ตั้งค่า LINE OA ทำเองได้ไหม', 'ทำเองได้ไหมครับ ไม่อยากจ้าง', 'AI Workspace คืออะไรครับ']) {
    const w = world();
    w.model.push(text('ได้ครับ', { intent: 'capability' }));
    await runTurn(w.input({ text: t }), w.deps);
    assert.doesNotMatch(w.line.texts().join('\n'), /Claude Projects คือที่ใส่ไฟล์/, t);
  }
  for (const t of ['ใช้ ChatGPT Projects อยู่แล้ว ต่างกันยังไง', 'AI Workspace ทำไมต้องจ้าง ทำเองไม่ได้เหรอ']) {
    const w = world();
    await runTurn(w.input({ text: t }), w.deps);
    assert.match(w.line.texts().join('\n'), /Claude Projects คือที่ใส่ไฟล์/, t);
  }
});

test('CE review: during the booking only time questions hand off — price, chat-instead-of-phone and queue-length questions do not', async () => {
  const toDay = async (w) => {
    await runTurn(w.input({ kind: 'postback', data: 'BOOK_START', text: '' }), w.deps);
    for (let i = 0; i < 6; i++) {
      const step = (await w.store.sessions.get('U1')).booking_step;
      if (step === 'window_day') break;
      await runTurn(w.input({ text: step === 'name' || step === 'name_text' ? 'มอส' : 'ร้านเค้กตามสั่ง ตามรายละเอียดลูกค้าไม่ทัน' }), w.deps);
    }
  };
  for (const t of ['ขอถามเรื่องราคาก่อนได้ไหม', 'ไม่สะดวกคุยโทรศัพท์ คุยในแชทได้ไหม', 'คิวยาวไหมครับ']) {
    const w = world();
    await toDay(w);
    w.model.push(text('ได้ครับ', { intent: 'faq' }));
    await runTurn(w.input({ text: t }), w.deps);
    assert.doesNotMatch(w.line.texts().slice(-1)[0], /ขอเช็กคิวกับมอส/, t);
    assert.notEqual((await w.store.sessions.get('U1')).mode, 'quiet', t);
  }
  for (const t of ['ว่างกี่โมงบ้าง', 'พรุ่งนี้ไม่ว่าง']) {
    const w = world();
    await toDay(w);
    await runTurn(w.input({ text: t }), w.deps);
    assert.match(w.line.texts().slice(-1)[0], /ขอเช็กคิวกับมอสก่อนนะครับ/, t);
  }
});

// v2.0.1 last_touch (Head 24 Oct, approved (b)): a returning friend from the website is counted
test('v2.0.1: a token on a later message sets homework.last_touch on the existing lead; first-touch source is kept; token stripped', async () => {
  const w = world();
  w.model.push(text('ได้ครับ งานไหนกินเวลาที่สุดครับ', { intent: 'fit', lead_updates: { business: 'ร้านเค้ก', problem_verbatim: 'ตอบแชทไม่ทัน' } }));
  await runTurn(w.input({ text: 'ร้านเค้กครับ ตอบแชทไม่ทัน' }), w.deps);
  const before = await w.store.leads.byUser('U1');
  assert.ok(before, 'precondition: a lead exists');
  assert.equal(before.source, 'line_oa');
  w.model.push(text('ได้ครับ AI Workspace ช่วยให้ AI อ่านไฟล์จริงของร้านครับ', { intent: 'capability' }));
  await runTurn(w.input({ text: 'มาจากเว็บ ดูเดโม Workspace #demo-a4' }), w.deps);
  const lead = await w.store.leads.byUser('U1');
  assert.equal(lead.source, 'line_oa', 'first touch untouched');
  assert.equal(lead.homework.last_touch, 'web-demo-a4');
  assert.ok(lead.homework.last_touch_at);
  assert.doesNotMatch(JSON.stringify(w.model.calls.slice(-1)), /#demo-a4/);
  const msgs = await w.store.messages.recent('U1', 20);
  assert.ok(!JSON.stringify(msgs).includes('#demo-'));
  // a second page later moves the last touch
  w.model.push(text('ได้ครับ', { intent: 'capability' }));
  await runTurn(w.input({ text: 'มาจากเว็บ ดูเดโม AI Business Review #demo-c1' }), w.deps);
  assert.equal((await w.store.leads.byUser('U1')).homework.last_touch, 'web-demo-c1');
});

test('v2.0.1: a first message with a token still sets the first-touch source (and the last touch)', async () => {
  const w = world();
  w.model.push(text('ได้ครับ', { intent: 'capability' }));
  await runTurn(w.input({ text: 'มาจากเว็บ ดูเดโม Workspace #demo-a4' }), w.deps);
  const s = await w.store.sessions.get('U1');
  assert.equal(s.lead_source, 'web-demo-a4');
  assert.equal(s.homework.last_touch, 'web-demo-a4');
  assert.equal(intake.buildLeadRow({ session: s, now: new Date() }).source, 'web-demo-a4');
});
