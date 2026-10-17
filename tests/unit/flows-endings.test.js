// flows/endings — the two endings, the booking state machine, Mos's decisions; unit + pipeline (brief §3.6, flow §6).
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTurn } = require('../../src/core/turn');
const fit = require('../../src/flows/fit');
const endings = require('../../src/flows/endings');
const homework = require('../../src/flows/homework');
const lint = require('../../src/core/lint');
const { createFakeLine } = require('../fakes/line');
const { createFakeNotifier } = require('../fakes/notifier');
const { createFakeModel, text } = require('../fakes/model');
const { createFakeClock } = require('../fakes/clock');
const { createFakeStore } = require('../fakes/store');

const config = { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22, fastworkUrl: 'https://fastwork.co/user/mos_lazyhardwork' }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' }, quiet: { windowMinutes: 30, debounceMs: 10 }, publicBaseUrl: '' };
const pack = {
  ladders: { A1: { tiers: { T1: 9900 } }, A2: { tiers: { T1: 4900 } }, A3: { tiers: { T1: 7900 } }, A4: { tiers: { T1: 4999 } }, C1: { tiers: { T1: 4900 } } },
  fastworkUrls: { A2: 'https://fastwork.co/user/mos_lazyhardwork/a2' },
  sections: new Map([['offer.A2.T1', { file: 'offer', title: 'A2 T1', text: 'intro line\n- ตอบคำถามที่ถามซ้ำแทนคุณ\n- ส่งต่อให้คนเมื่อเกินขอบเขต' }]]),
};
const NO_CONFIRM_WORDS = /ยืนยันแล้ว|นัดเรียบร้อย|นัดหมายเรียบร้อย/u;

function world(modelQueue = [], { displayName = 'พี่เอ', withPack = true } = {}) {
  const line = createFakeLine(); const notifier = createFakeNotifier(); const model = createFakeModel({ queue: modelQueue });
  const clock = createFakeClock(); const store = createFakeStore();
  const deps = { line, notifier, model, clock, store, log: { info() {}, warn() {}, error() {} }, config, flows: { fit, endings }, ...(withPack ? { pack } : {}) };
  const input = (over) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), displayName, ...over });
  const pb = (data) => input({ kind: 'postback', data });
  const allJson = () => JSON.stringify(line.allMessages());
  return { line, notifier, model, clock, store, deps, input, pb, allJson };
}
const bookingStart = (extra = {}) => text('ได้เลยครับ นัดคุยกับมอส 30 นาที', { intent: 'booking', action: 'booking_start', lead_updates: { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบแชทลูกค้าไม่ทัน' }, ...extra });

// ---- unit ---------------------------------------------------------------------------------------------------
test('chooseEnding: door packages go short (A4 T1, C1 any tier, any T1); otherwise long', () => {
  assert.equal(endings.chooseEnding({ draft: {} }), 'long');
  assert.equal(endings.chooseEnding({ draft: { card: 'A4', tier: 'T1' } }), 'short');
  assert.equal(endings.chooseEnding({ draft: { card: 'C1', tier: 'T2' } }), 'short');
  assert.equal(endings.chooseEnding({ draft: { card: 'A2', tier: 'T1' } }), 'short');
  assert.equal(endings.chooseEnding({ draft: { card: 'A2', tier: 'T2' } }), 'long');
  assert.equal(endings.chooseEnding({ draft: { card: 'A1' } }), 'short'); // tier defaults to T1
});

test('offerCard: bullets from the pack section when present, fixed default otherwise; never a price in data', () => {
  const s = { draft: { card: 'A2', tier: 'T1' } };
  const withPack = endings.offerCard(s, { deps: { pack } });
  assert.equal(withPack.template, 'offer');
  assert.deepEqual(withPack.data.bullets, ['ตอบคำถามที่ถามซ้ำแทนคุณ', 'ส่งต่อให้คนเมื่อเกินขอบเขต']);
  assert.equal(withPack.data.price_from, undefined);
  const noPack = endings.offerCard({ draft: { card: 'A3', tier: 'T1' } }, { deps: {} });
  assert.deepEqual(noPack.data.bullets, endings.DEFAULT_BULLETS.A3);
  assert.equal(noPack.data.secondary_cta.postback, 'BOOK_START');
  assert.equal(endings.offerCard({ draft: {} }), null);
  for (const [, bullets] of Object.entries(endings.DEFAULT_BULLETS)) for (const b of bullets) assert.equal(lint.findBanned(b).length, 0, b);
});

test('decorateResponse appends the offer once on the short path when ready, never when a card is already there', () => {
  const s = { draft: { card: 'C1', tier: 'T1' }, homework: {}, questions_asked: 0 };
  const r = text('เหมาะครับ', { intent: 'fit' });
  assert.equal(endings.decorateResponse({ response: r, session: s, deps: {} }), true);
  assert.equal(r.messages.length, 2); assert.equal(r.messages[1].template, 'offer'); assert.equal(s.offer_shown, true);
  assert.equal(endings.decorateResponse({ response: text('อีกที', { intent: 'fit' }), session: s, deps: {} }), false); // once
  const long = { draft: { card: 'A2', tier: 'T2' }, homework: {}, questions_asked: 0 };
  assert.equal(endings.decorateResponse({ response: text('x', { intent: 'fit' }), session: long, deps: {} }), false);
  const notReady = { draft: { card: 'A2', tier: 'T1' }, homework: {}, questions_asked: 0 };
  assert.equal(endings.decorateResponse({ response: text('x', { intent: 'capability' }), session: notReady, deps: {} }), false);
});

test('no string in the endings module says ยืนยันแล้ว / นัดเรียบร้อย', () => {
  const walk = (v) => (typeof v === 'function' ? [v('X'), v('X', 'Y')] : typeof v === 'object' && v ? Object.values(v).flatMap(walk) : [v]);
  for (const s of walk(endings.strings)) if (typeof s === 'string') assert.doesNotMatch(s, NO_CONFIRM_WORDS, s);
  for (const s of walk(homework.FIELDS)) if (typeof s === 'string') assert.doesNotMatch(s, NO_CONFIRM_WORDS, s);
});

// fake turn context for driving the state machine directly (text hook included)
function fakeCtx(session, { deps, displayName } = {}) {
  const w = world([], { displayName });
  const d = { ...w.deps, ...(deps || {}) };
  session.user_id = session.user_id || 'U1';
  const out = { sent: [] };
  const send = async (input, messages, quickReplies, sender) => { const list = require('../../src/line/messages').attachQuickReplies(messages, quickReplies || [], sender); out.sent.push(list); await d.line.push('U1', list); return [list]; };
  const persist = async () => { await d.store.sessions.save(session); };
  const done = (sent, action) => ({ sent, action, session });
  const base = { input: { userId: 'U1', kind: 'postback' }, session, deps: d, config, send, persist, done, sender: { name: 'Lay · ผู้ช่วย AI' }, senders: { lay: { name: 'Lay · ผู้ช่วย AI' }, mos: { name: 'มอส' } } };
  return { ...w, deps: d, base, out, last: () => out.sent.at(-1), lastText: () => out.sent.at(-1).filter((m) => m.type === 'text').map((m) => m.text).join('\n'), qr: () => out.sent.at(-1).at(-1).quickReply?.items?.map((i) => i.action.label) || [] };
}

test('booking asks only the homework gaps (text hook), never more than 4 questions, then the window', async () => {
  const s = { draft: {}, homework: {}, questions_asked: 0, display_name: 'พี่เอ', topics_covered: [] };
  const c = fakeCtx(s);
  await endings.onModelAction({ ...c.base, action: 'booking_start', response: bookingStart({ lead_updates: {} }) });
  assert.equal(s.booking_step, 'hw'); assert.equal(s.booking_hw_field, 'problem_verbatim'); assert.equal(s.questions_asked, 1);
  assert.match(c.lastText(), /เล่าสั้นๆ/);
  await endings.onBookingText({ ...c.base, text: 'ตอบแชทไม่ทัน' });
  assert.equal(s.homework.problem_verbatim, 'ตอบแชทไม่ทัน'); assert.equal(s.booking_hw_field, 'business'); assert.equal(s.questions_asked, 2);
  await endings.onBookingText({ ...c.base, text: 'ร้านกาแฟ' });
  // business + problem + preferred_contact (implied by booking) → ready → no more questions; name skipped (displayName) → day
  assert.equal(s.booking_step, 'window_day'); assert.equal(s.draft.name, 'พี่เอ');
  assert.deepEqual(c.qr(), ['วันนี้', 'พรุ่งนี้', 'เลือกวันเอง']);
  assert.ok(s.questions_asked <= 4);

  // budget spent → straight to the window even with gaps
  const s2 = { draft: {}, homework: {}, questions_asked: 4, display_name: 'พี่บี', topics_covered: [] };
  const c2 = fakeCtx(s2);
  await endings.onBookingPostback({ ...c2.base, data: 'BOOK_START' });
  assert.equal(s2.booking_step, 'window_day');
  // text hook returns null when the booking is not waiting for text (the turn goes on to the model)
  assert.equal(await endings.onBookingText({ ...c2.base, text: 'อะไรก็ได้' }), null);
});

test('name is asked (typed) when no displayName; เลือกวันเอง takes a typed day', async () => {
  const s = { draft: {}, homework: { business: 'a', problem_verbatim: 'b' }, questions_asked: 0, display_name: null, topics_covered: [] };
  const c = fakeCtx(s, { displayName: null });
  await endings.onBookingPostback({ ...c.base, data: 'BOOK_START' });
  assert.equal(s.booking_step, 'name'); assert.match(c.lastText(), /ขอชื่อ/); assert.deepEqual(c.qr(), []);
  await endings.onBookingText({ ...c.base, text: 'คุณเอก' });
  assert.equal(s.draft.name, 'คุณเอก'); assert.equal(s.booking_step, 'window_day');
  await endings.onBookingPostback({ ...c.base, data: 'BOOK_DAY_other' });
  assert.equal(s.booking_step, 'window_day_text'); assert.match(c.lastText(), /พิมพ์วัน/);
  await endings.onBookingText({ ...c.base, text: 'จันทร์หน้า' });
  assert.equal(s.draft.window_day, 'จันทร์หน้า'); assert.equal(s.booking_step, 'window_time');
  assert.deepEqual(c.qr(), ['เช้า 9-12', 'บ่าย 13-17', 'เย็น 18-20']);
});

// ---- pipeline -----------------------------------------------------------------------------------------------
test('pipeline: FIT_ postback sets the draft, hands the model the fit hint; the symptom is never asked again', async () => {
  const w = world([text('เหมาะครับ ร้านที่ตอบแชทไม่ทัน…', { intent: 'fit', topics: ['fit'] }), text('ครับ', { intent: 'fit', topics: ['fit'] })]);
  const r = await runTurn(w.pb('FIT_chat_overload'), w.deps);
  assert.equal(r.errors.length, 0);
  assert.deepEqual([r.session.draft.symptom, r.session.draft.card, r.session.draft.tier], ['chat_overload', 'A2', 'T1']);
  const lastUser = w.model.calls[0].messages.at(-1).content;
  assert.match(lastUser, /เลือกอาการ: ตอบแชทลูกค้าไม่ทัน/);
  assert.equal(fit.alreadyChosen(r.session), true);
  const r2 = await runTurn(w.input({ text: 'เหมาะกับงานผมไหม' }), w.deps);
  assert.equal(fit.alreadyChosen(r2.session), true);
  assert.equal(r2.session.draft.symptom, 'chat_overload');
  const lead = await w.store.leads.byUser('U1');
  assert.ok(!lead || lead.symptom === 'chat_overload');
});

test('pipeline: short path — the offer card renders as flex with ราคาเริ่มต้น from the pack', async () => {
  const w = world();
  const s = await w.store.sessions.getOrCreate('U1'); fit.chooseSymptom(s, 'chat_overload'); s.opened = true; s.homework = { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบแชทไม่ทัน', preferred_contact: 'แชทต่อ' }; await w.store.sessions.save(s);
  const card = endings.offerCard(s, { deps: w.deps });
  w.model.push(require('../../src/brain/schema').emptyResponse({ messages: [
    { type: 'text', text: 'แพ็กเริ่มต้นที่ตรงกับอาการนี้ครับ', explain: false, template: null, alt: null, data: null },
    { type: 'card', text: null, explain: false, template: 'offer', alt: card.alt, data: card.data },
  ], intent: 'pricing', topics: ['pricing'] }));
  const r = await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  assert.equal(r.errors.length, 0);
  const flex = w.line.cards();
  assert.equal(flex.length, 1);
  const json = JSON.stringify(flex[0]);
  assert.ok(json.includes('ราคาเริ่มต้น'));
  assert.ok(json.includes('4,900'));
  assert.ok(json.includes('https://fastwork.co/user/mos_lazyhardwork/a2'));
  assert.ok(json.includes('BOOK_START'));
  assert.equal(flex[0].contents._template, 'offer');
});

async function bookToSummary(w, { modelQueue } = {}) {
  if (modelQueue) w.model.push(...modelQueue); else w.model.push(bookingStart());
  const r1 = await runTurn(w.input({ text: 'ร้านกาแฟครับ ตอบแชทลูกค้าไม่ทัน เริ่มยังไง' }), w.deps);
  assert.equal(r1.errors.length, 0);
  assert.equal(r1.session.booking_step, 'window_day');
  assert.equal(r1.session.draft.name, 'พี่เอ'); // name skipped: displayName known
  assert.deepEqual(w.line.quickReplies(), ['วันนี้', 'พรุ่งนี้', 'เลือกวันเอง']);
  assert.match(w.line.texts()[0], /ได้เลยครับ/); // the model's words first
  w.line.reset();
  const r2 = await runTurn(w.pb('BOOK_DAY_tomorrow'), w.deps);
  assert.equal(r2.session.booking_step, 'window_time');
  assert.match(r2.session.draft.window_day, /^พรุ่งนี้ \(19 ต\.ค\.\)$/);
  assert.deepEqual(w.line.quickReplies(), ['เช้า 9-12', 'บ่าย 13-17', 'เย็น 18-20']);
  w.line.reset();
  const r3 = await runTurn(w.pb('BOOK_TIME_afternoon'), w.deps);
  assert.equal(r3.session.booking_step, 'summary');
  const card = w.line.cards()[0];
  assert.ok(card, 'summary card expected');
  assert.equal(card.contents._template, 'summary_confirm');
  const json = JSON.stringify(card);
  assert.ok(json.includes('รอมอสยืนยัน')); assert.ok(json.includes('BOOK_CONFIRM')); assert.ok(json.includes('BOOK_EDIT'));
  assert.ok(json.includes('พรุ่งนี้ (19 ต.ค.) บ่าย 13-17')); assert.ok(json.includes('ร้านกาแฟ'));
  assert.doesNotMatch(json, NO_CONFIRM_WORDS);
  assert.equal(w.model.calls.length, 1); // postbacks never touch the model
  return r3;
}

test('pipeline: long path — two taps, summary card, confirm → notifier BEFORE the promise, pending, no ยืนยันแล้ว', async () => {
  const w = world();
  await bookToSummary(w);
  w.line.reset();
  let sentWhenNotified = -1;
  const orig = w.notifier.booking; w.notifier.booking = async (p) => { sentWhenNotified = w.line.sent.length; return orig(p); };
  const r = await runTurn(w.pb('BOOK_CONFIRM'), w.deps);
  assert.equal(r.errors.length, 0);
  assert.equal(r.action, 'booking_confirm');
  assert.equal(w.notifier.named('booking').length, 1);
  assert.equal(sentWhenNotified, 0, 'notifier.booking must run before the customer message');
  assert.equal(w.line.sent.length, 1);
  assert.match(w.line.texts()[0], /^ส่งให้มอสแล้วครับ มอสจะยืนยันเวลากลับมาทางแชทนี้\nถ้าเกิน 1 วันทำการยังไม่มีตอบ โทร 095 569 1674 \(มอส\) ได้เลย$/);
  assert.doesNotMatch(w.allJson(), NO_CONFIRM_WORDS);
  for (const t of w.line.texts()) assert.equal(lint.lintText(t).ok, true, lint.lintText(t).errors.join());
  const b = w.store.bookings.all()[0];
  assert.equal(b.status, 'pending'); assert.equal(b.window_text, 'พรุ่งนี้ (19 ต.ค.) บ่าย 13-17'); assert.equal(b.discord_thread_id, 'T1');
  assert.equal(r.session.booking_step, 'pending'); assert.equal(r.session.discord_thread_id, 'T1');
  const payload = w.notifier.named('booking')[0].payload;
  assert.equal(payload.booking.id, b.id); assert.equal(payload.lead.status, 'booking_pending'); assert.match(payload.summary, /ธุรกิจ: ร้านกาแฟ/);
  assert.equal((await w.store.leads.byUser('U1')).status, 'booking_pending');
  // a second BOOK_START while pending does not create another booking
  w.line.reset();
  await runTurn(w.pb('BOOK_START'), w.deps);
  assert.equal(w.store.bookings.all().length, 1); assert.match(w.line.texts()[0], /รอมอสยืนยัน/);
});

test('pipeline: notifier throws on confirm → truth + phone, booking notify_failed, no promise', async () => {
  const w = world();
  await bookToSummary(w);
  w.line.reset(); w.notifier.fail.booking = true;
  const r = await runTurn(w.pb('BOOK_CONFIRM'), w.deps);
  assert.equal(r.errors.length, 0); assert.equal(r.action, null);
  assert.equal(w.line.sent.length, 1);
  assert.match(w.line.texts()[0], /ขัดข้อง/); assert.match(w.line.texts()[0], /095 569 1674/);
  assert.doesNotMatch(w.line.texts()[0], /ส่งให้มอสแล้ว/);
  assert.equal(w.store.bookings.all()[0].status, 'notify_failed');
  assert.ok(w.store.events.all().some((e) => e.kind === 'booking_notify_failed'));
  assert.equal(r.session.booking_step, 'notify_failed');
});

test('pipeline: BOOK_EDIT asks which field and re-asks only that one, then the summary comes back', async () => {
  const w = world();
  await bookToSummary(w);
  w.line.reset();
  const r = await runTurn(w.pb('BOOK_EDIT'), w.deps);
  assert.equal(r.session.booking_step, 'edit');
  assert.deepEqual(w.line.quickReplies(), ['ชื่อ', 'วัน', 'ช่วงเวลา', 'เรื่องที่อยากคุย']);
  w.line.reset();
  const r2 = await runTurn(w.pb('BOOK_EDIT_time'), w.deps);
  assert.equal(r2.session.booking_step, 'window_time');
  assert.equal(r2.session.draft.window_day, 'พรุ่งนี้ (19 ต.ค.)'); // the day was kept
  assert.equal(w.line.sent.length, 1); assert.equal(w.line.cards().length, 0);
  assert.deepEqual(w.line.quickReplies(), ['เช้า 9-12', 'บ่าย 13-17', 'เย็น 18-20']);
  w.line.reset();
  const r3 = await runTurn(w.pb('BOOK_TIME_morning'), w.deps);
  assert.equal(r3.session.booking_step, 'summary');
  assert.ok(JSON.stringify(w.line.cards()[0]).includes('พรุ่งนี้ (19 ต.ค.) เช้า 9-12'));
  // editing the name offers the displayName as a tap
  w.line.reset();
  await runTurn(w.pb('BOOK_EDIT'), w.deps); w.line.reset();
  const r4 = await runTurn(w.pb('BOOK_EDIT_name'), w.deps);
  assert.equal(r4.session.booking_step, 'name');
  assert.deepEqual(w.line.quickReplies(), ['ใช้ชื่อ พี่เอ', 'พิมพ์ชื่ออื่น']);
  w.line.reset();
  const r5 = await runTurn(w.pb('BOOK_NAME_USE'), w.deps);
  assert.equal(r5.session.booking_step, 'summary'); assert.equal(r5.session.draft.name, 'พี่เอ');
});

test('pipeline: a model booking_confirm is ignored (logged), the state machine keeps its own step', async () => {
  const w = world([text('ยืนยันนัดให้แล้วนะครับ', { intent: 'booking', action: 'booking_confirm' })]);
  const r = await runTurn(w.input({ text: 'โอเคนัดเลย' }), w.deps);
  assert.equal(r.errors.length, 0);
  assert.ok(w.store.events.all().some((e) => e.kind === 'ignored_model_confirm'));
  assert.equal(w.store.bookings.all().length, 0);
  assert.equal(w.notifier.named('booking').length, 0);
  assert.doesNotMatch(w.allJson(), NO_CONFIRM_WORDS); // the model's own "ยืนยันนัดให้แล้ว" line is not banned but no booking exists
  assert.ok(['hw', 'window_day'].includes(r.session.booking_step)); // started properly instead
  // and while the summary is shown, a model confirm still does not create a booking
  const w2 = world();
  await bookToSummary(w2);
  w2.line.reset();
  w2.model.push(text('รับทราบครับ', { intent: 'booking', action: 'booking_confirm' }));
  const r2 = await runTurn(w2.input({ text: 'ยืนยัน' }), w2.deps);
  assert.equal(w2.store.bookings.all().length, 0); assert.equal(r2.session.booking_step, 'summary');
  assert.ok(w2.line.cards().length === 1); // the summary is shown again instead
});

test('applyMosDecision: approve → confirmed card (the only ยืนยันแล้ว), propose → BOOK_PICK windows, decline → phone', async () => {
  const w = world();
  await bookToSummary(w);
  await runTurn(w.pb('BOOK_CONFIRM'), w.deps);
  const session = await w.store.sessions.get('U1');
  const booking = w.store.bookings.all()[0];
  const senders = { lay: { name: 'Lay · ผู้ช่วย AI' }, mos: { name: 'มอส' } };
  // approve
  w.line.reset();
  const a = await endings.applyMosDecision({ decision: 'approve', booking, session, deps: w.deps, config, senders });
  assert.ok(a.allow.has('booking_confirmed'));
  assert.equal(a.booking.status, 'confirmed'); assert.equal(a.booking.decided_by, 'mos');
  const card = w.line.cards()[0];
  assert.ok(card); assert.ok(JSON.stringify(card).includes('ยืนยันแล้ว')); assert.ok(!JSON.stringify(card).includes('BOOK_CONFIRM'));
  assert.equal(w.line.senders()[0], 'Lay · ผู้ช่วย AI');
  assert.equal((await w.store.sessions.get('U1')).booking_step, 'confirmed');
  for (const t of w.line.texts()) assert.equal(lint.lintText(t, { allow: a.allow }).ok, true);
  // propose
  const w2 = world();
  await bookToSummary(w2); await runTurn(w2.pb('BOOK_CONFIRM'), w2.deps); w2.line.reset();
  const s2 = await w2.store.sessions.get('U1'); const b2 = w2.store.bookings.all()[0];
  const p = await endings.applyMosDecision({ decision: 'propose', windows: ['พุธ 22 ต.ค. บ่าย', 'พฤหัส 23 ต.ค. เช้า'], booking: b2, session: s2, deps: w2.deps, config, senders });
  assert.equal(p.booking.status, 'reproposed'); assert.deepEqual(p.booking.proposed_windows, ['พุธ 22 ต.ค. บ่าย', 'พฤหัส 23 ต.ค. เช้า']);
  assert.deepEqual(w2.line.quickReplies(), ['พุธ 22 ต.ค. บ่าย', 'พฤหัส 23 ต.ค. เช้า', 'ขอเสนอเวลาอื่น']);
  assert.equal(w2.line.allMessages().at(-1).quickReply.items[1].action.data, 'BOOK_PICK_1');
  assert.doesNotMatch(w2.allJson(), NO_CONFIRM_WORDS);
  // the customer picks one → back to pending, Mos notified again before the words
  w2.line.reset(); await w2.store.sessions.save(s2);
  const r = await runTurn(w2.pb('BOOK_PICK_1'), w2.deps);
  assert.equal(r.errors.length, 0);
  assert.equal(w2.store.bookings.all()[0].status, 'pending'); assert.equal(w2.store.bookings.all()[0].window_text, 'พฤหัส 23 ต.ค. เช้า');
  assert.equal(w2.notifier.named('booking').length, 2);
  assert.match(w2.line.texts()[0], /พฤหัส 23 ต\.ค\. เช้า/); assert.match(w2.line.texts()[0], /รอมอสยืนยัน/);
  assert.doesNotMatch(w2.allJson(), NO_CONFIRM_WORDS);
  // decline
  const w3 = world();
  await bookToSummary(w3); await runTurn(w3.pb('BOOK_CONFIRM'), w3.deps); w3.line.reset();
  const d = await endings.applyMosDecision({ decision: 'decline', booking: w3.store.bookings.all()[0], session: await w3.store.sessions.get('U1'), deps: w3.deps, config, senders });
  assert.equal(d.booking.status, 'declined');
  assert.match(w3.line.texts()[0], /095 569 1674/); assert.match(w3.line.texts()[0], /ขออภัย/);
  assert.doesNotMatch(w3.allJson(), NO_CONFIRM_WORDS);
  await assert.rejects(() => endings.applyMosDecision({ decision: 'propose', windows: [], booking: b2, session: s2, deps: w2.deps, config, senders }));
});
