// scripts/smoke-webhook.js against the real Express app (src/app.createApp) on an ephemeral port, with the fakes
// injected: signed webhook POSTs in, admin API out. Proves the smoke's signing, sequencing and assertions end to end.
// Env is set before src/config is required (createApp reads config at require time: channel secret, admin token,
// debounce, PUBLIC_BASE_URL for the examples carousel assets).
process.env.LINE_CHANNEL_SECRET = 'test-secret';
process.env.ADMIN_TOKEN = 't';
process.env.DEBOUNCE_MS = '20';
process.env.PUBLIC_BASE_URL = 'https://lay.example.com';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'unused';
process.env.FASTWORK_URL = 'https://fastwork.co/user/mos_lazyhardwork';   // the offer card refuses to invent a URL (D-19)
delete process.env.DISCORD_BOT_TOKEN;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../../src/app');
const { loadPack } = require('../../src/brain/kb');
const { createFakeLine } = require('../fakes/line');
const { createFakeNotifier } = require('../fakes/notifier');
const { createFakeModel } = require('../fakes/model');
const { createFakeStore } = require('../fakes/store');
const { runSmoke, signBody } = require('../../scripts/smoke-webhook');

const silent = { info() {}, warn() {}, error() {} };
const WAITS = { text: 250, postback: 80 };

// The three model turns in the smoke sequence: greeting, FIT (text + offer card, as scenario 10), price (no number).
function modelQueue() {
  return [
    'สวัสดีครับ มีอะไรให้ช่วยดูบอกได้เลยครับ',
    {
      messages: [
        { type: 'text', text: 'ร้านที่ตอบแชทไม่ทันส่วนใหญ่เจอเหมือนกันครับ คำถามเดิมซ้ำทั้งวัน แล้วคนตอบคือคนที่ทำงานหน้าร้านอยู่', explain: false, template: null, alt: null, data: null },
        { type: 'card', text: null, explain: false, template: 'offer', alt: 'แพ็กเริ่มต้น AI Chatbot',
          data: { card_id: 'A2', tier: 'T1', title: 'AI Chatbot', bullets: ['ตอบคำถามที่ลูกค้าถามซ้ำได้เองตลอดวัน', 'ส่งต่อให้คนเมื่อเรื่องเกินขอบเขต', 'ปรับคำตอบจากข้อมูลของร้านคุณ'], secondary_cta: { label: 'นัดคุยกับมอสก่อน', postback: 'BOOK_START' } } },
      ],
      quick_replies: ['ราคาเท่าไหร่', 'เริ่มยังไง'],
      topics: ['fit'], kb_refs: ['fit.chat-overload', 'offer.A2.T1'], intent: 'fit', action: null,
    },
    { messages: [{ type: 'text', text: 'ราคาขึ้นกับขอบเขตงานครับ ถ้าเล่าหน้างานให้ฟังหน่อย เดี๋ยวบอกช่วงราคาให้ได้', explain: false, template: null, alt: null, data: null }], quick_replies: ['เริ่มยังไง'], topics: ['pricing'], kb_refs: ['fit.chat-overload'], intent: 'pricing', action: null },
  ];
}

async function boot({ queue = modelQueue(), line = createFakeLine() } = {}) {
  const store = createFakeStore();
  const model = createFakeModel({ queue });
  const app = createApp({ overrides: { line, notifier: createFakeNotifier(), model, store, log: silent, pack: loadPack() } });
  const server = await app.start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, store, model, line, base, stop: () => app.stop() };
}

function flat(report) { return report.results.flatMap((s) => s.checks.map((c) => ({ step: s.id, ...c }))); }

test('signBody: base64 HMAC-SHA256 over the exact raw bytes (LINE verify-webhook-signature)', () => {
  const raw = Buffer.from('{"events":[{"type":"follow","source":{"userId":"Uทดสอบ"}}]}', 'utf8');
  const expected = crypto.createHmac('sha256', 'test-secret').update(raw).digest('base64');
  assert.equal(signBody('test-secret', raw), expected);
  assert.equal(signBody('test-secret', raw.toString('utf8')), expected);
  assert.notEqual(signBody('other-secret', raw), expected);
});

test('runSmoke against createApp with the fakes: every check PASS, no WARN, no FAIL', async () => {
  const w = await boot();
  const lines = [];
  try {
    const report = await runSmoke({ base: w.base, secret: 'test-secret', token: 't', user: 'Usmoke-unit', waits: WAITS, out: (s) => lines.push(s) });
    const checks = flat(report);
    const notPass = checks.filter((c) => c.status !== 'PASS');
    assert.deepEqual(notPass, [], `non-PASS checks:\n${lines.join('\n')}`);
    assert.equal(report.ok, true);
    assert.equal(report.counts.FAIL, 0);
    assert.equal(report.counts.WARN, 0);
    assert.ok(report.counts.PASS >= 16, `expected a full table, got ${report.counts.PASS}`);
    // the table says what was observed, not just the verdict
    const table = lines.join('\n');
    assert.match(table, /opening text\s+PASS\s+text "สวัสดีครับ ผม Lay/);
    assert.match(table, /card choice\|offer\s+PASS\s+flex:offer from "Lay/);
    assert.match(table, /card examples\s+PASS\s+flex:examples/);
    assert.match(table, /draft\.symptom\s+PASS\s+draft=.*"symptom":"chat_overload"/);
    assert.match(table, /result: PASS/);
    // the model was asked exactly for the three free-text / FIT turns; the rest was deterministic
    assert.equal(w.model.calls.length, 3);
    // every signed POST really went through the LINE middleware into the pipeline (customer rows persisted)
    const customerRows = w.store.messages.all().filter((m) => m.user_id === 'Usmoke-unit' && m.role === 'customer');
    assert.deepEqual(customerRows.map((m) => `${m.kind}:${m.text}`), ['text:สวัสดีครับ', 'postback:FIT_chat_overload', 'text:ราคาเท่าไหร่', 'postback:MENU_EXAMPLES', 'text:เรียก Lay']);
    console.log(table);
  } finally { await w.stop(); }
});

test('a wrong secret is rejected by the webhook and the smoke reports FAIL (exit 1 path)', async () => {
  const w = await boot();
  try {
    const report = await runSmoke({ base: w.base, secret: 'wrong-secret', token: 't', user: 'Usmoke-badsig', waits: WAITS });
    assert.equal(report.ok, false);
    const webhookChecks = flat(report).filter((c) => c.name === 'webhook');
    assert.ok(webhookChecks.length >= 1);
    assert.ok(webhookChecks.every((c) => c.status === 'FAIL'), JSON.stringify(webhookChecks));
    assert.equal(w.model.calls.length, 0);
  } finally { await w.stop(); }
});

test('model unavailable: free-text steps are WARN (honest fallback), never FAIL; deterministic steps still PASS', async () => {
  const w = await boot({ queue: ['throw', 'throw', 'throw'] });
  try {
    const report = await runSmoke({ base: w.base, secret: 'test-secret', token: 't', user: 'Usmoke-nomodel', waits: WAITS });
    const checks = flat(report);
    assert.equal(report.counts.FAIL, 0, JSON.stringify(checks.filter((c) => c.status === 'FAIL')));
    assert.ok(report.ok);
    const warned = checks.filter((c) => c.status === 'WARN').map((c) => `${c.step}:${c.name}`);
    assert.ok(warned.includes('greeting:lay replied (never silent)'), warned.join(', '));
    assert.ok(warned.includes('price:lay replied (never silent)'), warned.join(', '));
    assert.ok(warned.includes('fit:card choice|offer'), warned.join(', '));
    assert.ok(warned.includes('final:model'), warned.join(', '));
    for (const name of ['opening text', 'card examples', 'Lay is back', 'draft.symptom', 'no error events']) {
      assert.equal(checks.find((c) => c.name === name)?.status, 'PASS', name);
    }
  } finally { await w.stop(); }
});

test('synthetic id against a LINE that rejects pushes: undelivered is evidence, not an error; --real-push makes it FAIL', async () => {
  const rejecting = () => createFakeLine({ fail: { push: new Error('400 invalid user id'), reply: new Error('400 invalid reply token') } });
  let w = await boot({ line: rejecting() });
  try {
    const report = await runSmoke({ base: w.base, secret: 'test-secret', token: 't', user: 'Usmoke-synthetic', waits: WAITS });
    const checks = flat(report);
    assert.equal(report.counts.FAIL, 0, JSON.stringify(checks.filter((c) => c.status === 'FAIL')));
    assert.ok(checks.some((c) => c.name === 'card examples' && /LINE rejected synthetic id/.test(c.observed)));
    assert.equal(checks.find((c) => c.name === 'no error events')?.status, 'PASS');
    assert.match(checks.find((c) => c.name === 'undelivered (synthetic id)')?.observed || '', /ignored/);
  } finally { await w.stop(); }

  w = await boot({ line: rejecting() });
  try {
    const report = await runSmoke({ base: w.base, secret: 'test-secret', token: 't', user: 'Usmoke-realpush', realPush: true, waits: WAITS });
    assert.equal(report.ok, false);
    const checks = flat(report);
    assert.equal(checks.find((c) => c.name === 'no error events')?.status, 'FAIL');
    assert.equal(checks.find((c) => c.name === 'delivered to real user')?.status, 'FAIL');
  } finally { await w.stop(); }
});
