// Demo mode + examples carousel against the real KB pack and the fakes (design §7, brief §3.7, §9.7).
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTurn } = require('../../src/core/turn');
const { loadPack } = require('../../src/brain/kb');
const { createSenders } = require('../../src/identity/sender');
const { validate } = require('../../src/cards/validate');
const { render } = require('../../src/cards/render');
const lint = require('../../src/core/lint');
const demo = require('../../src/flows/demo');
const examples = require('../../src/flows/examples');
const { createFakeLine } = require('../fakes/line');
const { createFakeNotifier } = require('../fakes/notifier');
const { createFakeModel, text } = require('../fakes/model');
const { createFakeClock } = require('../fakes/clock');
const { createFakeStore } = require('../fakes/store');

const config = {
  contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22, fastworkUrl: 'https://fastwork.co/user/mos_lazyhardwork' },
  identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' },
  quiet: { windowMinutes: 30, debounceMs: 10 },
  publicBaseUrl: 'https://lay.example.com',
};

const pack = loadPack();
pack.demoShops = demo.demoShops(pack);
pack.assets = { ...(pack.assets || {}), ...examples.examplesAssets(config) };

function world(modelQueue = []) {
  const line = createFakeLine(); const notifier = createFakeNotifier(); const model = createFakeModel({ queue: modelQueue });
  const clock = createFakeClock(); const store = createFakeStore();
  const deps = { line, notifier, model, clock, store, pack, log: { info() {}, warn() {}, error() {} }, config, flows: { demo } };
  const input = (over) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), ...over });
  return { line, notifier, model, clock, store, deps, input };
}

const card = (template, data, alt, extra = {}) => ({
  messages: [{ type: 'card', text: null, explain: false, template, alt, data }],
  quick_replies: [], topics: [], kb_refs: ['examples.demo-cafe'], intent: 'demo', action: null,
  lead_updates: Object.fromEntries(['business', 'problem_verbatim', 'where_work_lives', 'team_size', 'maintainer', 'urgency', 'budget_frame', 'preferred_contact', 'came_from', 'symptom', 'card', 'name'].map((f) => [f, null])),
  ...extra,
});
const shopText = (t, extra = {}) => text(t, { intent: 'demo', kb_refs: ['examples.demo-cafe'], ...extra });
const cp = (s) => [...s].length;

// ---------------------------------------------------------------------------------------------------------------
test('demoShops: both shops come from the real pack with names, KB text, fields and short sender names', () => {
  const shops = demo.demoShops(pack);
  assert.deepEqual(Object.keys(shops).sort(), ['cafe', 'clinic']);
  assert.equal(shops.cafe.name_th, 'คาเฟ่ริมคลอง');
  assert.equal(shops.clinic.name_th, 'คลินิกใสใส');
  assert.match(shops.cafe.kb, /อเมริกาโน่/);
  assert.match(shops.clinic.kb, /มัดจำ/);
  assert.ok(shops.cafe.fields.length >= 4 && shops.clinic.fields.length >= 4);
  assert.equal(shops.cafe.icon_key, 'demo-cafe');
  const senders = createSenders(config);
  for (const s of Object.values(shops)) {
    assert.ok(cp(s.short_name_th) <= 8, `${s.short_name_th} short name ≤ 8`);
    const snd = senders.demo(s);
    assert.ok(cp(snd.name) <= 20, `sender "${snd.name}" is ${cp(snd.name)} code points`);
    assert.match(snd.name, /ผู้ช่วย AI$/);
    assert.equal(snd.iconUrl, `https://lay.example.com/assets/${s.icon_key}.png`);
  }
  // without a pack the shops still exist (names from the defaults, empty KB)
  const bare = demo.demoShops(null);
  assert.equal(bare.cafe.name_th, 'คาเฟ่ริมคลอง'); assert.equal(bare.cafe.kb, '');
});

test('examples carousel: 4 items in design order, validates as a Flex carousel, uri is https Fastwork', () => {
  const data = examples.examplesCarousel(pack, config);
  assert.equal(data.items.length, 4);
  assert.deepEqual(data.items.map((i) => i.cta.postback || 'uri'), ['DEMO_PICK', 'DEMO_THIS_BOT', 'DEMO_OUR_WORK', 'uri']);
  assert.equal(data.items[3].cta.uri, 'https://fastwork.co/user/mos_lazyhardwork');
  assert.match(data.items[2].title, /ตัวอย่าง/);
  const ctx = examples.cardContext(pack, config);
  const r = render({ template: 'examples', data }, ctx);
  assert.ok(r.message, r.errors.join('; '));
  assert.equal(validate(r.message).ok, true);
  assert.equal(r.message.contents.contents.length, 4);
  // picker and the "our work" carousel validate too
  assert.equal(validate(render({ template: 'choice', data: examples.shopPicker() }, ctx).message).ok, true);
  assert.equal(validate(render({ template: 'examples', data: examples.ourWorkCarousel(pack) }, ctx).message).ok, true);
  assert.equal(validate(render({ template: 'info', alt: examples.strings.alts.thisBot, data: examples.thisBotCard() }, ctx).message).ok, true);
  assert.equal(validate(render({ template: 'choice', data: demo.symptomChoice() }, ctx).message).ok, true);
  // every asset key the flows use resolves to a png under public/assets
  const fs = require('fs'); const path = require('path');
  for (const [key, file] of Object.entries(examples.IMAGE_FILES)) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'public', 'assets', file)), `${key} → ${file} missing`);
  }
  for (const key of ['demo-cafe', 'demo-clinic']) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'public', 'assets', `${key}.png`)));
});

test('examples without a public base url: no assets → carousel falls back to text + ≤4 buttons (never prose)', async () => {
  const w = world();
  w.deps.config = { ...config, publicBaseUrl: '' };
  w.deps.pack = { ...pack, assets: {} };
  const r = await runTurn(w.input({ kind: 'postback', data: 'DEMO_EXAMPLES' }), w.deps);
  assert.equal(r.errors.length, 0);
  assert.equal(w.line.cards().length, 0);
  const qr = w.line.quickReplies();
  assert.ok(qr.length >= 1 && qr.length <= 4);
  assert.deepEqual(w.line.senders(), ['Lay · ผู้ช่วย AI', 'Lay · ผู้ช่วย AI']);
});

test('fixed Lay content: DEMO_THIS_BOT (3 points, no model) and DEMO_OUR_WORK (labelled ตัวอย่าง)', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'DEMO_THIS_BOT' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.equal(w.line.cards().length, 1);
  assert.match(w.line.texts()[0], /3 อย่าง/);
  assert.equal(w.line.senders()[0], 'Lay · ผู้ช่วย AI');
  for (const t of w.line.texts()) { assert.equal(lint.findBanned(t).length, 0); assert.equal(lint.hasProseList(t), false); assert.equal(lint.countEmoji(t), 0); }
  w.line.reset();
  const r = await runTurn(w.input({ kind: 'postback', data: 'DEMO_OUR_WORK' }), w.deps);
  assert.equal(w.model.calls.length, 0);
  assert.match(w.line.texts()[0], /ข้อมูลสมมติ/);
  const c = w.line.cards()[0];
  assert.equal(c.contents.contents.length, 2);
  assert.ok(JSON.stringify(c).includes('ตัวอย่าง'));
  assert.ok(r.session.topics_covered.includes('proof'));
});

// ---------------------------------------------------------------------------------------------------------------
test('the whole cafe path: pick → enter → ask → order card → confirm → exit, ≤ 8 customer turns, nothing notified', async () => {
  const w = world();
  let turns = 0;
  const go = async (over) => { turns++; w.line.reset(); return runTurn(w.input(over), w.deps); };

  // 1. carousel (what "ขอดูตัวอย่าง" opens once turn.js routes it here)
  let r = await go({ kind: 'postback', data: 'DEMO_EXAMPLES' });
  assert.equal(r.errors.length, 0);
  assert.equal(w.line.cards()[0].contents.type, 'carousel');

  // 2. pick a shop → choice card (Lay)
  r = await go({ kind: 'postback', data: 'DEMO_PICK' });
  assert.equal(w.line.cards().length, 1);
  assert.ok(JSON.stringify(w.line.cards()[0]).includes('DEMO_ENTER_cafe'));
  assert.ok(JSON.stringify(w.line.cards()[0]).includes('DEMO_ENTER_clinic'));
  assert.equal(r.session.mode, 'lay');

  // 3. enter → the shop greets (no model), shop sender, back button
  r = await go({ kind: 'postback', data: 'DEMO_ENTER_cafe' });
  assert.equal(r.action, 'demo_enter');
  assert.equal(r.session.mode, 'demo'); assert.equal(r.session.demo_shop, 'cafe');
  assert.deepEqual(r.session.demo_state.step, 'chat');
  assert.equal(w.model.calls.length, 0);
  assert.match(w.line.texts()[0], /คาเฟ่ริมคลอง/); assert.match(w.line.texts()[0], /ตัวอย่าง/);
  assert.equal(w.line.senders()[0], 'ริมคลอง · ผู้ช่วย AI');
  assert.ok(w.line.quickReplies().includes('กลับไปคุยกับ Lay'));

  // 4. a question → the shop's bot answers via the model with the demo prompt + shop KB
  w.model.push(shopText('มีอเมริกาโน่ ลาเต้ คาปูชิโน่ มัทฉะ ชาไทย โกโก้ และครัวซองต์ครับ รับอะไรดีครับ', { quick_replies: ['ลาเต้เย็น 1 แก้ว', 'ดูเวลาเปิด', 'ส่งถึงบ้านไหม', 'ค่าส่งเท่าไหร่', 'กลับไปคุยกับ Lay'] }));
  r = await go({ text: 'มีอะไรบ้าง' });
  assert.equal(r.errors.length, 0);
  assert.equal(w.model.calls.length, 1);
  const req = w.model.calls[0];
  assert.match(req.system, /ร้านตัวอย่าง/); assert.match(req.system, /อเมริกาโน่ร้อน 55 บาท/); assert.match(req.system, /summary_confirm/);
  assert.equal(req.messages.at(-1).content, 'มีอะไรบ้าง');
  assert.equal(req.messages.filter((m) => m.role === 'user').length, 1, 'the customer line is not duplicated');
  assert.equal(w.line.senders()[0], 'ริมคลอง · ผู้ช่วย AI');
  const qr4 = w.line.quickReplies();
  assert.ok(qr4.length <= 4); assert.equal(qr4.at(-1), 'กลับไปคุยกับ Lay'); assert.equal(qr4.filter((q) => q === 'กลับไปคุยกับ Lay').length, 1);
  assert.equal(r.session.demo_state.turns, 1);

  // 5. the order → the model returns a summary_confirm card; code owns status + postbacks
  w.model.push(card('summary_confirm', { title: 'สรุปออเดอร์ (ร้านตัวอย่าง)', fields: [{ k: 'รายการ', v: 'ลาเต้เย็น หวานน้อย' }, { k: 'จำนวน', v: '1 แก้ว' }, { k: 'รับที่ร้าน/ส่ง', v: 'รับที่ร้าน' }, { k: 'เวลารับ', v: '10:00' }, { k: 'ชื่อผู้รับ', v: 'มอส' }, { k: 'ยอดรวม', v: '70 บาท' }], status: 'confirmed', confirm_postback: 'HACK', edit_postback: 'HACK' }, 'สรุปออเดอร์', { action: 'booking_confirm' }));
  r = await go({ text: 'ลาเต้เย็น 1 แก้ว หวานน้อย รับที่ร้าน 10 โมง ชื่อมอส' });
  assert.equal(r.errors.length, 0);
  const summary = w.line.cards()[0];
  assert.ok(summary, 'summary card sent');
  const json = JSON.stringify(summary);
  assert.ok(json.includes('DEMO_CONFIRM') && json.includes('DEMO_EDIT'), 'code-owned postbacks');
  assert.ok(!json.includes('HACK'));
  assert.ok(!json.includes('ยืนยันแล้ว'), 'status is pending, never confirmed by the model');
  assert.equal(summary.sender.name, 'ริมคลอง · ผู้ช่วย AI');
  assert.equal(w.line.quickReplies().at(-1), 'กลับไปคุยกับ Lay');
  assert.equal(r.session.demo_state.step, 'confirm');
  assert.equal(r.session.demo_state.order.fields.length, 6);
  assert.deepEqual(r.session.homework, {}); assert.deepEqual(r.session.draft, {});

  // 6. confirm → simulated hand-over line, nothing notified, no booking row, no lead
  r = await go({ kind: 'postback', data: 'DEMO_CONFIRM' });
  assert.equal(r.errors.length, 0);
  assert.match(w.line.texts()[0], /ส่งออเดอร์ให้เจ้าของร้าน \(ตัวอย่าง\) แล้วครับ รอยืนยัน/);
  assert.equal(w.line.senders()[0], 'ริมคลอง · ผู้ช่วย AI');
  assert.ok(w.line.quickReplies().includes('กลับไปคุยกับ Lay'));
  assert.equal(r.session.demo_state.step, 'sent');
  assert.equal(w.notifier.calls.length, 0, 'notifier never called in demo');
  assert.equal(w.store.bookings.all().length, 0); assert.equal(w.store.leads.all().length, 0);

  // 7. back to Lay via the model's demo_exit → exit line + symptom choice (FIT_* postbacks)
  w.model.push(shopText('ได้เลยครับ กลับไปคุยกับ Lay ได้เลย', { action: 'demo_exit' }));
  r = await go({ text: 'พอแล้ว ขอคุยเรื่องบอทของผมต่อ' });
  assert.equal(r.action, 'demo_exit');
  assert.equal(r.session.mode, 'lay'); assert.equal(r.session.demo_shop, null); assert.equal(r.session.demo_state, null);
  assert.match(w.line.texts()[0], /รับออเดอร์/); assert.match(w.line.texts()[0], /อยากได้ส่วนไหนแบบนี้/);
  assert.deepEqual([...new Set(w.line.senders())], ['Lay · ผู้ช่วย AI']);
  const exitCard = JSON.stringify(w.line.cards()[0]);
  for (const k of ['chat_overload', 'scattered_data', 'repetitive_work', 'ai_know_my_work', 'dont_know_where_to_start']) assert.ok(exitCard.includes(`FIT_${k}`), `FIT_${k}`);
  assert.ok(r.session.topics_covered.includes('proof'));
  assert.ok(turns <= 8, `demo path took ${turns} customer turns`);

  // every stored demo message carries the demo_shop role; Lay's carry lay
  const roles = w.store.messages.all().filter((m) => m.role !== 'customer').map((m) => m.role);
  assert.ok(roles.includes('demo_shop') && roles.includes('lay'));
  assert.ok(w.store.messages.all().filter((m) => m.role === 'demo_shop').every((m) => m.sender_name === 'ริมคลอง · ผู้ช่วย AI'));
  // lint on everything said
  for (const t of w.line.texts()) assert.equal(lint.findBanned(t).length, 0, t);
});

test('clinic: enter via DEMO_ENTER_clinic, edit keeps the order, fallback card data still yields buttons', async () => {
  const w = world();
  let r = await runTurn(w.input({ kind: 'postback', data: 'DEMO_ENTER_clinic' }), w.deps);
  assert.equal(r.session.demo_shop, 'clinic');
  assert.equal(w.line.senders()[0], 'ใสใส · ผู้ช่วย AI');
  assert.match(w.line.texts()[0], /คลินิกใสใส/);
  // a card with too-short data → render falls back; the confirm/edit still arrive as buttons
  w.line.reset();
  w.model.push(card('summary_confirm', { title: 'สรุปการจอง (ร้านตัวอย่าง)', fields: [] }, 'สรุปการจอง'));
  r = await runTurn(w.input({ text: 'จองทรีตเมนต์หน้าใส พรุ่งนี้บ่าย ชื่อมอส' }), w.deps);
  assert.equal(r.errors.length, 0);
  assert.equal(w.line.cards().length, 0);
  const qr = w.line.quickReplies();
  assert.ok(qr.includes('ยืนยัน') && qr.includes('ขอแก้ไข') && qr.at(-1) === 'กลับไปคุยกับ Lay', JSON.stringify(qr));
  w.line.reset();
  r = await runTurn(w.input({ kind: 'postback', data: 'DEMO_EDIT' }), w.deps);
  assert.equal(r.session.demo_state.step, 'chat');
  assert.match(w.line.texts()[0], /บอกส่วนที่อยากเปลี่ยน/);
  assert.equal(w.line.senders()[0], 'ใสใส · ผู้ช่วย AI');
  assert.equal(w.notifier.calls.length, 0);
});

test('model throws inside demo → honest fallback as the shop sender with the back button; garbage too', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'DEMO_ENTER_cafe' }), w.deps);
  w.line.reset(); w.model.push('throw');
  const r = await runTurn(w.input({ text: 'ลาเต้ร้อน' }), w.deps);
  assert.equal(r.errors.length, 0);
  assert.equal(w.line.sent.length, 1);
  assert.match(w.line.texts()[0], /ขัดข้องชั่วคราว/);
  assert.equal(w.line.senders()[0], 'ริมคลอง · ผู้ช่วย AI');
  assert.deepEqual(w.line.quickReplies(), ['กลับไปคุยกับ Lay']);
  assert.equal(r.session.mode, 'demo');
  assert.ok(w.store.events.all().some((e) => e.kind === 'model_fallback' && e.payload.demo_shop === 'cafe'));
  w.line.reset(); w.model.push('garbage');
  await runTurn(w.input({ text: 'ลาเต้ร้อน' }), w.deps);
  assert.match(w.line.texts()[0], /ขัดข้องชั่วคราว/);
  assert.equal(w.line.senders()[0], 'ริมคลอง · ผู้ช่วย AI');
});

test('policy inside demo: a banned phrase is regenerated once, then falls back honestly', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'DEMO_ENTER_cafe' }), w.deps);
  w.line.reset();
  w.model.push(shopText('เรารับประกันผลครับ'), shopText('มีลาเต้ร้อนและเย็นครับ'));
  await runTurn(w.input({ text: 'มีลาเต้ไหม' }), w.deps);
  assert.equal(w.model.calls.length, 2);
  assert.match(w.line.texts()[0], /ลาเต้ร้อนและเย็น/);
  w.line.reset();
  w.model.push(shopText('เรารับประกันผลครับ'), shopText('เรารับประกันผลครับ'));
  await runTurn(w.input({ text: 'แน่ใจนะ' }), w.deps);
  assert.match(w.line.texts()[0], /ขัดข้องชั่วคราว/);
  assert.equal(w.line.senders()[0], 'ริมคลอง · ผู้ช่วย AI');
});

test('เรียก Lay / กลับไปคุยกับ Lay (text) exits via turn.js from inside demo; DEMO_CONFIRM afterwards is not an order', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'DEMO_ENTER_cafe' }), w.deps);
  w.line.reset();
  let r = await runTurn(w.input({ text: 'กลับไปคุยกับ Lay' }), w.deps);
  assert.equal(r.action, 'demo_exit');
  assert.equal(r.session.mode, 'lay'); assert.equal(r.session.demo_shop, null);
  assert.equal(w.model.calls.length, 0);
  assert.equal(w.line.senders()[0], 'Lay · ผู้ช่วย AI');
  w.line.reset();
  r = await runTurn(w.input({ kind: 'postback', data: 'DEMO_CONFIRM' }), w.deps);
  assert.match(w.line.texts()[0], /ไม่ได้อยู่ในร้านตัวอย่าง/);
  assert.equal(w.line.senders()[0], 'Lay · ผู้ช่วย AI');
  assert.equal(w.notifier.calls.length, 0);
  // and เรียก Lay the short way
  await runTurn(w.input({ kind: 'postback', data: 'DEMO_ENTER_clinic' }), w.deps);
  r = await runTurn(w.input({ text: 'เรียก Lay' }), w.deps);
  assert.equal(r.session.mode, 'lay');
});

test('model proposes demo_enter: honoured only when the customer clearly named a shop, else logged + picker', async () => {
  const logged = [];
  const w = world([text('ได้เลยครับ', { intent: 'demo', action: 'demo_enter' }), text('ได้เลยครับ', { intent: 'demo', action: 'demo_enter' })]);
  w.deps.log = { info: (e, f) => logged.push([e, f]), warn() {}, error() {} };
  let r = await runTurn(w.input({ text: 'อยากลองเป็นลูกค้าดู' }), w.deps);
  assert.equal(r.session.mode, 'lay');
  assert.ok(logged.some(([e]) => e === 'demo.ignored_model_demo_enter'));
  assert.ok(JSON.stringify(w.line.cards()[0] || {}).includes('DEMO_ENTER_cafe') || w.line.quickReplies().length > 0);
  w.line.reset();
  r = await runTurn(w.input({ text: 'ขอลองร้านกาแฟตัวอย่างหน่อย' }), w.deps);
  assert.equal(r.session.mode, 'demo'); assert.equal(r.session.demo_shop, 'cafe');
  assert.equal(w.line.senders()[0], 'ริมคลอง · ผู้ช่วย AI');
});

test('switching shop with DEMO_PICK while in demo leaves the shop quietly; demo_exit outside demo is harmless', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'DEMO_ENTER_cafe' }), w.deps);
  w.line.reset();
  let r = await runTurn(w.input({ kind: 'postback', data: 'DEMO_PICK' }), w.deps);
  assert.equal(r.session.mode, 'lay'); assert.equal(r.session.demo_state, null);
  assert.equal(w.line.senders()[0], 'Lay · ผู้ช่วย AI');
  w.line.reset(); w.model.push(text('ครับ', { intent: 'demo', action: 'demo_exit' }));
  r = await runTurn(w.input({ text: 'ออกจากเดโม' }), w.deps);
  assert.equal(r.errors.length, 0); assert.equal(r.session.mode, 'lay');
  assert.equal(w.line.sent.length, 1);
});

test('media inside demo still answers and keeps the mode', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'DEMO_ENTER_cafe' }), w.deps);
  w.line.reset();
  const r = await runTurn(w.input({ kind: 'media', mediaType: 'image' }), w.deps);
  assert.equal(r.session.mode, 'demo');
  assert.equal(w.line.sent.length, 1);
});

test('strings pass lint: no banned phrases, no emoji, no prose lists, labels ≤ 20', () => {
  const texts = [
    demo.strings.greeting.cafe('คาเฟ่ริมคลอง'), demo.strings.greeting.clinic('คลินิกใสใส'), demo.strings.sent('ออเดอร์'), demo.strings.sent('การจอง'),
    demo.strings.edit, demo.strings.nothingToConfirm, demo.strings.notInDemo, demo.strings.shopFallback, demo.strings.emptyText, demo.strings.exitAsk,
    ...Object.values(demo.strings.exitSeen).flatMap((o) => Object.values(o)),
    examples.strings.carouselIntro, examples.strings.pickIntro, examples.strings.thisBotIntro, examples.strings.ourWorkIntro,
    ...examples.strings.thisBot.rows.map((r) => r.v),
  ];
  for (const t of texts) {
    const rep = lint.lintText(t);
    assert.equal(rep.ok, true, `${t} → ${rep.errors.join(', ')}`);
  }
  for (const s of demo.SYMPTOMS) assert.ok(cp(s.label) <= 20, s.label);
  for (const shop of Object.values(demo.SHOP_DEFS)) for (const q of [...shop.starters, shop.more]) assert.ok(cp(q) <= 20, q);
  assert.ok(cp(demo.BACK_LABEL) <= 20);
  assert.deepEqual(demo.withBack(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'กลับไปคุยกับ Lay']);
  assert.deepEqual(demo.withBack(['กลับไปคุยกับ Lay', 'a']), ['a', 'กลับไปคุยกับ Lay']);
});

test('phone run 18 Oct: demo summary says the shop confirms (not Mos), drops placeholder values, fills the name; เรียก Lay from a demo gives the exit line', async () => {
  const w = world();
  await runTurn(w.input({ kind: 'postback', data: 'DEMO_ENTER_cafe' }), w.deps);
  w.line.reset();
  w.model.push(card('summary_confirm', { title: 'สรุปออเดอร์ (ร้านตัวอย่าง)', fields: [{ k: 'รายการ', v: 'ลาเต้เย็น' }, { k: 'ชื่อผู้รับ', v: 'กรุณาแจ้งชื่อผู้รับ' }, { k: 'ยอดรวม', v: '70 บาท' }] }, 'สรุปออเดอร์'));
  await runTurn(w.input({ text: 'รับที่ร้าน' }), w.deps);
  const json = JSON.stringify(w.line.cards()[0]);
  assert.match(json, /รอเจ้าของร้านยืนยัน/);
  assert.doesNotMatch(json, /รอมอสยืนยัน/);
  assert.doesNotMatch(json, /กรุณาแจ้ง/);
  w.line.reset();
  const r = await runTurn(w.input({ text: 'กลับไปคุยกับ Lay' }), w.deps);
  assert.equal(r.session.mode, 'lay');
  assert.doesNotMatch(w.line.texts().join('\n'), /คุยกับ Lay อยู่แล้ว/);
});
