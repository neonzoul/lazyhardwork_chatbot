// Exhaustion behaviour end to end (doc/llm.md §5–§6): degraded replies, the turn pipeline with every key out,
// the deterministic fit card, and the Discord operator alerts (throttle, mention, webhook fallback).
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTurn } = require('../../src/core/turn');
const { validateResponse } = require('../../src/brain/schema');
const lint = require('../../src/core/lint');
const degraded = require('../../src/core/degraded');
const { createAlerts, CRITICAL_THROTTLE_MS } = require('../../src/discord/alerts');
const { createFakeLine } = require('../fakes/line');
const { createFakeNotifier } = require('../fakes/notifier');
const { createFakeModel, text } = require('../fakes/model');
const { createFakeClock } = require('../fakes/clock');
const { createFakeStore } = require('../fakes/store');

const config = { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22, fastworkUrl: 'https://fastwork.co/user/mos_lazyhardwork' }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส', layIconUrl: 'https://x/lay.png', mosIconUrl: 'https://x/mos.png' }, quiet: { windowMinutes: 30, debounceMs: 10 }, publicBaseUrl: '' };

function fakeTransport({ botConfigured = true, botFails = false, webhookFails = false } = {}) {
  const posts = [];
  return {
    posts, botConfigured,
    async postMessage(p) { if (botFails) throw new Error('bot 500'); posts.push({ via: 'bot', ...p }); },
    async postWebhook(p) { if (webhookFails) throw new Error('webhook 400'); posts.push({ via: 'webhook', ...p }); },
    async createThread() { throw new Error('no'); },
  };
}

function world({ modelQueue = [], notifierFail = {}, keyring = null, transport = fakeTransport() } = {}) {
  const line = createFakeLine(); const notifier = createFakeNotifier({ fail: notifierFail }); const model = createFakeModel({ queue: modelQueue });
  const clock = createFakeClock(); const store = createFakeStore();
  const alerts = createAlerts({ transport, crmChannelId: 'crm', crmWebhook: 'https://discord.test/hook', clock, statusLine: () => 'keys: 0/1 usable · key0 EXHAUSTED · limit 15 USD · remaining 0.00 · reset daily' });
  const deps = { line, notifier, model, clock, store, alerts, keyring, log: { info() {}, warn() {}, error() {} }, config };
  const input = (over) => ({ userId: 'U1', kind: 'text', text: '', replyToken: 'rt', timestamp: clock.now().getTime(), ...over });
  return { line, notifier, model, clock, store, deps, input, alerts, transport };
}

test('degraded replies are schema-valid, lint-clean, phone from config, no promise when the forward failed', () => {
  const a = degraded.degradedReply({ config });
  assert.ok(validateResponse(a).ok);
  assert.match(a.messages[0].text, /ส่งคำถามของคุณให้มอสแล้ว/);
  assert.match(a.messages[0].text, /095 569 1674/);
  assert.deepEqual(a.quick_replies, ['เรียก Lay', 'ราคาเท่าไหร่', 'เริ่มยังไง']);
  assert.equal(a._meta.degraded, true);
  const b = degraded.degradedNotifyFailedReply({ config });
  assert.ok(validateResponse(b).ok);
  assert.ok(!/ส่งคำถาม|ส่งให้มอสแล้ว/.test(b.messages[0].text), 'no promise');
  assert.match(b.messages[0].text, /095 569 1674/);
  assert.deepEqual(b.quick_replies, ['เรียก Lay']);
  const c = degraded.degradedFitChoiceReply({ config });
  assert.ok(validateResponse(c).ok);
  assert.equal(c.messages[1].template, 'choice');
  assert.equal(c.messages[1].data.options.length, 5);
  for (const r of [a, b, c]) for (const m of r.messages) if (m.type === 'text') { assert.equal(lint.findBanned(m.text).length, 0); assert.equal(lint.countEmoji(m.text), 0); }
});

test('model exhausted → Mos alerted in #crm with @here, question forwarded first, degraded reply, mode lay, events logged', async () => {
  const w = world({ modelQueue: ['exhausted'] });
  const r = await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  assert.equal(w.line.sent.length, 1);
  assert.match(w.line.texts()[0], /ระบบตอบอัตโนมัติขัดข้องชั่วคราว/);
  assert.match(w.line.texts()[0], /095 569 1674/);
  assert.ok(w.line.quickReplies().includes('เรียก Lay'));
  assert.equal(w.line.senders()[0], 'Lay · ผู้ช่วย AI');
  assert.equal(r.session.mode, 'lay');
  assert.equal(w.notifier.named('handoff').length, 1);
  assert.equal(w.notifier.named('handoff')[0].payload.kind, 'handoff_unknown');
  assert.equal(w.notifier.named('handoff')[0].payload.question, 'ราคาเท่าไหร่');
  assert.equal(w.transport.posts.length, 1);
  const post = w.transport.posts[0];
  assert.ok(post.content.startsWith('@here 🔴 LAY v2 CRITICAL — llm_exhausted'));
  assert.deepEqual(post.allowedMentions, { parse: ['everyone'] });
  assert.match(post.content, /key0 EXHAUSTED/);
  assert.ok(!post.content.includes('ราคาเท่าไหร่') && !post.content.includes('U1'), 'no customer data in the alert');
  assert.ok(w.store.events.all().some((e) => e.kind === 'llm_exhausted_turn'));
  assert.ok(!w.store.events.all().some((e) => e.kind === 'model_fallback'));
  assert.ok(r.errors.length >= 1);
});

test('second exhausted turn within 15 min → no second critical post; after the window → posted again; recovered clears the throttle', async () => {
  const w = world({ modelQueue: ['exhausted', 'exhausted', 'exhausted', 'exhausted'] });
  await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  w.clock.advanceMinutes(5);
  await runTurn(w.input({ text: 'เริ่มยังไง' }), w.deps);
  assert.equal(w.transport.posts.filter((p) => /CRITICAL/.test(p.content)).length, 1);
  assert.equal(w.notifier.named('handoff').length, 2, 'both questions still forwarded');
  w.clock.advance(CRITICAL_THROTTLE_MS);
  await runTurn(w.input({ text: 'ใช้เวลานานไหม' }), w.deps);
  assert.equal(w.transport.posts.filter((p) => /CRITICAL/.test(p.content)).length, 2);
  await w.alerts.recovered({ kind: 'llm_exhausted' });
  assert.match(w.transport.posts.at(-1).content, /^🟢 LAY v2 recovered — llm_exhausted/);
  assert.deepEqual(w.transport.posts.at(-1).allowedMentions, { parse: [] });
  await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  assert.equal(w.transport.posts.filter((p) => /CRITICAL/.test(p.content)).length, 3, 'throttle cleared by recovered');
});

test('keyring says exhausted → the model is not called at all; keys back → the model is called again', async () => {
  let out = true;
  const keyring = { status: () => ({ exhausted: out, usable: out ? 0 : 1, total: 1 }) };
  const w = world({ modelQueue: [text('ตอบปกติครับ', { intent: 'pricing', topics: ['pricing'] })], keyring });
  await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  assert.equal(w.model.calls.length, 0, 'no hammering');
  assert.match(w.line.texts()[0], /ขัดข้องชั่วคราว/);
  assert.equal(w.notifier.named('handoff').length, 1);
  out = false;
  await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  assert.equal(w.model.calls.length, 1);
  assert.match(w.line.texts().at(-1), /ตอบปกติ/);
});

test('deterministic paths keep working with the model exhausted: MENU_FIT → choice card (no model, no handoff); FIT_<key> → symptom stored + forwarded', async () => {
  const w = world({ modelQueue: ['exhausted', 'exhausted'] });
  const r1 = await runTurn(w.input({ kind: 'postback', data: 'MENU_FIT' }), w.deps);
  const flex = w.line.sent.flatMap((s) => s.messages).find((m) => m.type === 'flex');
  assert.ok(flex, 'choice card rendered');
  assert.equal(flex.contents?._template || flex.altText, flex.contents?._template ? 'choice' : 'เหมาะกับงานผมไหม — เลือกอาการที่ตรงกับคุณ');
  assert.equal(w.notifier.named('handoff').length, 0, 'nothing to forward yet');
  assert.equal(r1.session.mode, 'lay');
  const r2 = await runTurn(w.input({ kind: 'postback', data: 'FIT_chat_overload' }), w.deps);
  assert.equal(r2.session.draft.symptom, 'chat_overload');
  assert.equal(r2.session.draft.card, 'A2');
  assert.equal(w.notifier.named('handoff').length, 1);
  assert.match(w.notifier.named('handoff')[0].payload.question, /ตอบแชทลูกค้าไม่ทัน/);
  assert.match(w.line.texts().at(-1), /ส่งคำถามของคุณให้มอสแล้ว/);
  // opening (follow) and CALL_LAY never touch the model either
  const w2 = world({ modelQueue: [] });
  await runTurn(w2.input({ kind: 'follow' }), w2.deps);
  assert.ok(w2.line.texts()[0].includes('3 เรื่อง'));
  assert.equal(w2.model.calls.length, 0);
});

test('forward fails while exhausted → no promise, phone only, event recorded; the alert still went out', async () => {
  const w = world({ modelQueue: ['exhausted'], notifierFail: { handoff: true } });
  await runTurn(w.input({ text: 'ราคาเท่าไหร่' }), w.deps);
  const t = w.line.texts()[0];
  assert.ok(!/ส่งคำถามของคุณให้มอสแล้ว/.test(t));
  assert.match(t, /095 569 1674/);
  assert.deepEqual(w.line.quickReplies(), ['เรียก Lay']);
  assert.ok(w.store.events.all().some((e) => e.kind === 'handoff_notify_failed'));
  assert.equal(w.transport.posts.length, 1);
});

test('alerts: bot down → webhook; both down → logged, never throws; warn once per UTC day; detail formatting', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00Z');
  const errors = [];
  const log = { info() {}, warn() {}, error: (e, f) => errors.push([e, f]) };
  const t1 = fakeTransport({ botFails: true });
  const a1 = createAlerts({ transport: t1, crmChannelId: 'crm', crmWebhook: 'https://discord.test/hook', clock, log });
  const r1 = await a1.critical({ kind: 'llm_exhausted', detail: { task: 'lay.reply', skipped: true } });
  assert.deepEqual(r1, { posted: true, via: 'webhook', throttled: false });
  assert.equal(t1.posts[0].via, 'webhook');
  assert.match(t1.posts[0].content, /task: lay.reply\nskipped: true/);
  assert.match(t1.posts[0].content, /at 2026-10-18T10:00:00.000Z/);
  const t2 = fakeTransport({ botFails: true, webhookFails: true });
  const a2 = createAlerts({ transport: t2, crmChannelId: 'crm', crmWebhook: 'https://discord.test/hook', clock, log });
  const r2 = await a2.critical({ kind: 'x', detail: 'plain text' });
  assert.deepEqual(r2, { posted: false, via: null, throttled: false });
  assert.ok(errors.some(([e]) => e === 'alerts.post_failed'));
  const t3 = fakeTransport();
  const a3 = createAlerts({ transport: t3, crmChannelId: 'crm', clock });
  assert.equal((await a3.warn({ kind: 'llm_budget_80', detail: { pct: 81 } })).posted, true);
  assert.equal((await a3.warn({ kind: 'llm_budget_80', detail: { pct: 90 } })).throttled, true);
  assert.equal(t3.posts.length, 1);
  assert.match(t3.posts[0].content, /^🟠 LAY v2 warning — llm_budget_80\npct: 81/);
  assert.deepEqual(t3.posts[0].allowedMentions, { parse: [] });
  clock.set('2026-10-19T00:00:00Z');
  assert.equal((await a3.warn({ kind: 'llm_budget_80', detail: { pct: 85 } })).posted, true);
  // no bot configured + no webhook: still no throw
  const a4 = createAlerts({ transport: fakeTransport({ botConfigured: false, webhookFails: true }), clock, log });
  assert.equal((await a4.critical({ kind: 'y' })).posted, false);
});
