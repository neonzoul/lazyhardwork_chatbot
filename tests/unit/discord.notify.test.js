const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, createRestTransport } = require('../../src/discord/notify');
const { createFakeStore } = require('../fakes/store');

const lead = { id: 'L-1', user_id: 'Uabc', card_id: 'line-oa-assistant', symptom: 'ตอบแชทไม่ทัน', homework: { business: 'ร้านกาแฟ' } };
const session = { user_id: 'Uabc', homework: lead.homework, draft: { card: 'line-oa-assistant' } };

function fakeTransport({ botConfigured = true, threadFails = false, webhookFails = false, postFails = false } = {}) {
    const calls = [];
    return {
        calls,
        botConfigured,
        async createThread(a) { calls.push(['createThread', a]); if (threadFails) throw new Error('403 Missing Permissions'); return { threadId: 'T-42' }; },
        async postMessage(a) { calls.push(['postMessage', a]); if (postFails) throw new Error('500'); },
        async postWebhook(a) { calls.push(['postWebhook', a]); if (webhookFails) throw new Error('webhook 404'); },
    };
}
const silent = { info() {}, warn() {}, error() {} };
const base = { guildId: 'G', leadsChannelId: 'C-leads', leadsWebhook: 'https://discord.com/api/webhooks/x/y', log: silent };

test('handoff: bot ok → thread in #leads, opening posted, {threadId}', async () => {
    const t = fakeTransport();
    const n = createNotifier({ ...base, transport: t });
    const r = await n.handoff({ kind: 'handoff_human', session, lead, question: 'ขอคุยกับมอส', draft: session.draft });
    assert.deepEqual(r, { threadId: 'T-42' });
    assert.equal(t.calls[0][0], 'createThread');
    assert.equal(t.calls[0][1].channelId, 'C-leads');
    assert.match(t.calls[0][1].name, /^L-1 · line-oa-assistant · ตอบแชทไม่ทัน$/);
    assert.match(t.calls[0][1].content, /คุยกับคน/);
    assert.ok(!/Uabc/.test(t.calls[0][1].content));
});

test('handoff: records the thread when store.relayThreads exists; fake store without it is fine', async () => {
    const rows = [];
    const store = { relayThreads: { create: async (r) => { rows.push(r); } } };
    const n = createNotifier({ ...base, transport: fakeTransport(), store });
    await n.handoff({ kind: 'handoff_scope', session, lead, question: 'ลดได้ไหม' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].discord_thread_id, 'T-42');
    assert.equal(rows[0].user_id, 'Uabc');
    assert.equal(rows[0].lead_id, 'L-1');
    assert.equal(rows[0].opened_for, 'handoff_scope');

    const n2 = createNotifier({ ...base, transport: fakeTransport(), store: createFakeStore() });
    const r = await n2.handoff({ kind: 'handoff_human', session, lead, question: 'x' });
    assert.equal(r.threadId, 'T-42');
});

test('handoff: bot fails → webhook fallback {threadId:null, fallback:"webhook"} with the same text', async () => {
    const t = fakeTransport({ threadFails: true });
    const n = createNotifier({ ...base, transport: t });
    const r = await n.handoff({ kind: 'handoff_human', session, lead, question: 'ขอคุยกับมอส' });
    assert.deepEqual(r, { threadId: null, fallback: 'webhook' });
    const wh = t.calls.find((c) => c[0] === 'postWebhook');
    assert.equal(wh[1].url, base.leadsWebhook);
    assert.match(wh[1].content, /L-1 · line-oa-assistant/);
    assert.match(wh[1].content, /วิธีตอบ/);
});

test('handoff: bot not configured → straight to webhook', async () => {
    const t = fakeTransport({ botConfigured: false });
    const n = createNotifier({ ...base, transport: t });
    const r = await n.handoff({ kind: 'handoff_human', session, lead, question: 'x' });
    assert.equal(r.fallback, 'webhook');
    assert.ok(!t.calls.some((c) => c[0] === 'createThread'));
});

test('handoff / booking: both transports fail → throws (pipeline tells the customer the truth)', async () => {
    const n = createNotifier({ ...base, transport: fakeTransport({ threadFails: true, webhookFails: true }) });
    await assert.rejects(() => n.handoff({ kind: 'handoff_human', session, lead, question: 'x' }), /discord notify failed/);
    await assert.rejects(() => n.booking({ lead, session, booking: { requested_window: 'พรุ่งนี้บ่าย' } }), /discord notify failed/);
});

test('booking: thread with the requested window', async () => {
    const t = fakeTransport();
    const n = createNotifier({ ...base, transport: t });
    const r = await n.booking({ lead, session, booking: { requested_window: 'พรุ่งนี้ 14:00' } });
    assert.equal(r.threadId, 'T-42');
    assert.match(t.calls[0][1].content, /นัดคุย/);
    assert.match(t.calls[0][1].content, /พรุ่งนี้ 14:00/);
});

test('kbGap / lead: one line to #leads, never throw even when everything is down', async () => {
    const ok = fakeTransport();
    const n = createNotifier({ ...base, transport: ok });
    await n.kbGap({ question: 'รองรับ Shopee ไหม', userId: 'Uabc' });
    await n.lead({ lead });
    assert.equal(ok.calls.filter((c) => c[0] === 'postMessage' && c[1].channelId === 'C-leads').length, 2);
    assert.ok(!ok.calls.some((c) => /Uabc/.test(c[1].content)));

    const down = createNotifier({ ...base, transport: fakeTransport({ postFails: true, webhookFails: true, threadFails: true }) });
    await down.kbGap({ question: 'x' });
    await down.lead({ lead });
    const noBot = createNotifier({ ...base, transport: fakeTransport({ botConfigured: false, webhookFails: true }) });
    await noBot.kbGap({ question: 'x' });
});

test('relayToMos: posts the mirror line into the thread; no-ops without a thread or bot; never throws', async () => {
    const t = fakeTransport();
    const n = createNotifier({ ...base, transport: t });
    await n.relayToMos({ threadId: 'T-42', text: 'โทร 0812345678 นะ' });
    assert.equal(t.calls[0][1].channelId, 'T-42');
    assert.match(t.calls[0][1].content, /ลูกค้า: โทร \[phone\] นะ/);
    await n.relayToMos({ threadId: null, text: 'x' });
    const bad = createNotifier({ ...base, transport: fakeTransport({ postFails: true }) });
    await bad.relayToMos({ threadId: 'T-1', text: 'x' });
});

test('rest transport: no token → botConfigured false, bot calls throw, webhook uses fetch with a JSON body', async () => {
    const seen = [];
    const t = createRestTransport({ botToken: '', fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 204 }; } });
    assert.equal(t.botConfigured, false);
    await assert.rejects(() => t.postMessage({ channelId: 'C', content: 'x' }), /not configured/);
    await t.postWebhook({ url: 'https://hook', content: 'hi' });
    assert.equal(JSON.parse(seen[0].init.body).content, 'hi');
    await assert.rejects(() => t.postWebhook({ url: '', content: 'x' }), /webhook not configured/);
    const t2 = createRestTransport({ botToken: '', fetchImpl: async () => ({ ok: false, status: 404 }) });
    await assert.rejects(() => t2.postWebhook({ url: 'https://hook', content: 'x' }), /webhook 404/);
});
