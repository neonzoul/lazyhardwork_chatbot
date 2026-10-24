const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRelay } = require('../../src/discord/relay');
const { parseCommand, handleCommand, strings } = require('../../src/discord/commands');
const { createFakeStore } = require('../fakes/store');
const { createFakeLine } = require('../fakes/line');

const silent = { info() {}, warn() {}, error() {} };
const LEADS = 'C-leads';

function fakeClient() {
    const c = new EventEmitter();
    c.user = { id: 'BOT', tag: 'lay#0001' };
    c.login = async () => { c.loggedIn = true; };
    c.destroy = async () => { c.destroyed = true; };
    return c;
}
function thread({ id = 'T-1', parentId = LEADS, ownerId = 'BOT', name = 'L-1 · x · y' } = {}) {
    const sent = [];
    return { id, parentId, ownerId, name, sent, isThread: () => true, send: async (t) => { sent.push(t); } };
}
function message(channel, content, { bot = false, id = 'MOS' } = {}) {
    return { author: { bot, id }, content, channel };
}
async function world({ store } = {}) {
    const client = fakeClient();
    const relayed = []; const commands = [];
    const relay = createRelay({
        botToken: 'x', guildId: 'G', leadsChannelId: LEADS, store, client, log: silent,
        onMosMessage: async (m) => { relayed.push(m); },
        onCommand: async (c) => { commands.push(c); return { ok: true, text: `✅ ${c.command}` }; },
    });
    await relay.start();
    return { client, relay, relayed, commands };
}
const emit = (client, m) => new Promise((r) => { client.emit('messageCreate', m); setImmediate(() => setImmediate(r)); });

test('relay: plain text in a registered thread → onMosMessage with the LINE userId and lead id', async () => {
    const store = { relayThreads: { byThread: async (id) => (id === 'T-1' ? { user_id: 'Uabc', lead_id: 'L-1' } : null) } };
    const w = await world({ store });
    assert.ok(w.client.loggedIn);
    const ch = thread();
    await emit(w.client, message(ch, 'สวัสดีครับ มอสเองนะครับ'));
    assert.deepEqual(w.relayed, [{ threadId: 'T-1', userId: 'Uabc', lead_id: 'L-1', text: 'สวัสดีครับ มอสเองนะครับ' }]);
    assert.equal(ch.sent.length, 0);
});

test('relay: falls back to the session whose discord_thread_id matches (fake store has no relayThreads)', async () => {
    const store = createFakeStore();
    const s = await store.sessions.getOrCreate('U9'); s.discord_thread_id = 'T-9'; await store.sessions.save(s);
    const w = await world({ store });
    await emit(w.client, message(thread({ id: 'T-9' }), 'ok'));
    assert.equal(w.relayed[0].userId, 'U9');
});

test('relay: ignores bots, our own messages, non-thread channels, threads under other parents, unknown threads', async () => {
    const w = await world({ store: createFakeStore() });
    await emit(w.client, message(thread(), 'x', { bot: true }));
    await emit(w.client, message(thread(), 'x', { id: 'BOT' }));
    await emit(w.client, message({ id: 'C-leads', isThread: () => false, send: async () => {} }, 'x'));
    await emit(w.client, message(thread({ parentId: 'C-other' }), 'x'));
    await emit(w.client, message(thread({ ownerId: 'SOMEONE' }), 'x'));
    assert.equal(w.relayed.length, 0);
    assert.equal(w.commands.length, 0);
});

test('relay: thread we own but no mapping → lead id from the title, text answers "no customer", commands still routed', async () => {
    const w = await world({ store: createFakeStore() });
    const ch = thread({ id: 'T-x', name: 'L-2026-10-17-007 · card · sym' });
    await emit(w.client, message(ch, 'hello'));
    assert.equal(ch.sent[0], strings.noCustomer);
    await emit(w.client, message(ch, '/lay'));
    assert.equal(w.commands[0].lead_id, 'L-2026-10-17-007');
    assert.equal(w.commands[0].userId, null);
});

test('relay: /commands → onCommand with parsed args, ack posted; unknown → ❌ line, not routed', async () => {
    const store = { relayThreads: { byThread: async () => ({ user_id: 'Uabc', lead_id: 'L-1' }) } };
    const w = await world({ store });
    const ch = thread();
    await emit(w.client, message(ch, '/propose พรุ่งนี้ 14:00 หรือ 16:00'));
    await emit(w.client, message(ch, '/Approve'));
    await emit(w.client, message(ch, '/decline'));
    await emit(w.client, message(ch, '/lay'));
    await emit(w.client, message(ch, '/foo bar'));
    assert.deepEqual(w.commands.map((c) => [c.command, c.args]), [['propose', 'พรุ่งนี้ 14:00 หรือ 16:00'], ['approve', ''], ['decline', ''], ['lay', '']]);
    assert.equal(w.commands[0].userId, 'Uabc');
    assert.deepEqual(ch.sent, ['✅ propose', '✅ approve', '✅ decline', '✅ lay', strings.unknown('foo')]);
    assert.equal(w.relayed.length, 0);
});

test('relay: onMosMessage throwing → ❌ line in the thread, handler survives; stop() destroys the client', async () => {
    const client = fakeClient();
    const relay = createRelay({
        botToken: 'x', leadsChannelId: LEADS, client, log: silent,
        store: { relayThreads: { byThread: async () => ({ user_id: 'U1', lead_id: 'L-1' }) } },
        onMosMessage: async () => { throw new Error('LINE 500'); },
    });
    await relay.start();
    const ch = thread();
    await emit(client, message(ch, 'hi'));
    assert.equal(ch.sent[0], strings.failed('LINE 500'));
    await relay.stop();
    assert.ok(client.destroyed);
});

test('relay: no token and no client → start() returns null (disabled, not crashed)', async () => {
    const relay = createRelay({ leadsChannelId: LEADS, log: silent });
    assert.equal(await relay.start(), null);
});

test('parseCommand', () => {
    assert.equal(parseCommand('hello'), null);
    assert.equal(parseCommand(''), null);
    assert.deepEqual(parseCommand('/approve'), { command: 'approve', args: '', known: true });
    assert.deepEqual(parseCommand('  /PROPOSE  พรุ่งนี้ 14:00  '), { command: 'propose', args: 'พรุ่งนี้ 14:00', known: true });
    assert.deepEqual(parseCommand('/lay'), { command: 'lay', args: '', known: true });
    assert.deepEqual(parseCommand('/nope x'), { command: 'nope', args: 'x', known: false });
    assert.equal(parseCommand('/'), null);
});

test('handleCommand: unknown, no customer, propose without args', async () => {
    const deps = { log: silent };
    assert.equal((await handleCommand({ command: 'zzz', userId: 'U1' }, { deps })).text, strings.unknown('zzz'));
    assert.equal((await handleCommand({ command: 'approve', userId: null }, { deps })).text, strings.noCustomer);
    assert.equal((await handleCommand({ command: 'propose', args: '', userId: 'U1' }, { deps })).text, strings.needArgs);
});

test('handleCommand: approve/propose/decline → endings.applyMosDecision; missing module → honest ❌', async () => {
    const seen = [];
    const endings = { applyMosDecision: async (a) => { seen.push(a); } };
    const deps = { log: silent };
    const r1 = await handleCommand({ command: 'approve', args: '', threadId: 'T', userId: 'U1', lead_id: 'L-1' }, { deps, endings });
    const r2 = await handleCommand({ command: 'propose', args: 'บ่ายนี้', threadId: 'T', userId: 'U1', lead_id: 'L-1' }, { deps, endings });
    const r3 = await handleCommand({ command: 'decline', args: '', threadId: 'T', userId: 'U1', lead_id: 'L-1' }, { deps, endings });
    assert.deepEqual(seen.map((s) => [s.decision, s.text, s.userId, s.leadId]), [['approve', '', 'U1', 'L-1'], ['propose', 'บ่ายนี้', 'U1', 'L-1'], ['decline', '', 'U1', 'L-1']]);
    assert.ok(r1.ok && r2.ok && r3.ok);
    assert.equal(r1.text, strings.ackApprove);
    assert.equal(r2.text, strings.ackPropose('บ่ายนี้'));
    const missing = await handleCommand({ command: 'approve', userId: 'U1' }, { deps, endings: {} });
    assert.equal(missing.ok, false);
    assert.match(missing.text, /^❌ \/approve ยังไม่พร้อม/);
    const boom = await handleCommand({ command: 'decline', userId: 'U1' }, { deps, endings: { applyMosDecision: async () => { throw new Error('db down'); } } });
    assert.equal(boom.text, strings.failed('db down'));
});

test('handleCommand: /lay → pipeline when runTurn given; otherwise direct release (mode lay, Lay says it is back)', async () => {
    const turns = [];
    const viaPipeline = await handleCommand({ command: 'lay', userId: 'U1' }, { deps: { log: silent }, runTurn: async (input) => { turns.push(input); return { errors: [] }; } });
    assert.equal(viaPipeline.text, strings.ackLay);
    assert.equal(turns[0].kind, 'mos_release');
    assert.equal(turns[0].userId, 'U1');

    const store = createFakeStore(); const line = createFakeLine();
    const s = await store.sessions.getOrCreate('U2'); s.mode = 'mos_active'; s.mode_since = new Date().toISOString(); await store.sessions.save(s);
    const config = { identity: { layName: 'Agent Lay · AI', mosName: 'มอส', layIconUrl: '', mosIconUrl: '' }, publicBaseUrl: '' };
    const direct = await handleCommand({ command: 'lay', userId: 'U2' }, { deps: { store, line, log: silent, clock: { now: () => new Date() } }, config });
    assert.equal(direct.ok, true);
    const after = await store.sessions.get('U2');
    assert.equal(after.mode, 'lay');
    assert.equal(after.resumed_by, 'mos_release');
    assert.equal(line.sent.length, 1);
    assert.match(line.texts()[0], /Lay กลับมาดูแลต่อครับ/);
    assert.equal(line.senders()[0], 'Agent Lay · AI');
});

// Mos, 18 Oct: "@agent.layline.lazyhardwork Resume" and "Agent lay ไปตอบต่อเลย" hand the chat back to Lay; neither may
// reach the customer. A mention the bot does not understand gets help in the thread, still not the customer.
test('relay: @mention resume / plain hand-back phrase → /lay; unknown mention → help; nothing relayed to the customer', async () => {
    const store = { relayThreads: { byThread: async () => ({ user_id: 'Uabc', lead_id: 'L-1' }) } };
    const w = await world({ store });
    const ch = thread();
    await emit(w.client, message(ch, '<@BOT> Resume'));
    await emit(w.client, message(ch, 'Agent lay ไปตอบต่อเลย'));
    await emit(w.client, message(ch, '<@!BOT> propose พรุ่งนี้ บ่าย 13-17'));
    await emit(w.client, message(ch, '<@BOT> ขอบคุณนะ'));
    assert.deepEqual(w.commands.map((c) => [c.command, c.args]), [['lay', ''], ['lay', ''], ['propose', 'พรุ่งนี้ บ่าย 13-17']]);
    assert.equal(w.relayed.length, 0, 'no instruction reaches the customer');
    assert.ok(ch.sent.some((t) => /ไม่ได้ส่งถึงลูกค้า/.test(t)), 'the unknown mention gets help in the thread');
    await emit(w.client, message(ch, 'สวัสดีครับ มอสเองนะครับ'));
    assert.equal(w.relayed.length, 1, 'normal chat still goes to the customer');
});

test('relay: the "ให้ Lay ดูแลต่อ" button runs /lay for the thread user and replies in Discord', async () => {
    const { LAY_BUTTON_ID } = require('../../src/discord/commands');
    const store = { relayThreads: { byThread: async () => ({ user_id: 'Uabc', lead_id: 'L-1' }) } };
    const w = await world({ store });
    const replies = [];
    const interaction = { isButton: () => true, isChatInputCommand: () => false, customId: LAY_BUTTON_ID, channel: thread(), reply: async (r) => { replies.push(r.content); } };
    w.client.emit('interactionCreate', interaction);
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    assert.deepEqual(w.commands.map((c) => [c.command, c.userId]), [['lay', 'Uabc']]);
    assert.equal(replies[0], '✅ lay');
});

test('relay: Discord system messages never reach the customer (thread rename, pin, member added, thread created) — 22 Oct', async () => {
    const store = { relayThreads: { byThread: async (id) => (id === 'T-1' ? { user_id: 'Uabc', lead_id: 'L-1' } : null) } };
    const w = await world({ store });
    const ch = thread();
    // discord.js MessageType: 4 ChannelNameChange, 6 ChannelPinnedMessage, 7 UserJoin, 18 ThreadCreated, 21 ThreadStarterMessage
    for (const type of [4, 6, 7, 18, 21]) await emit(w.client, { ...message(ch, 'Mos-L-2026-10-19-line_oa-290v71'), type });
    await emit(w.client, { ...message(ch, 'Mos-L-2026-10-19-line_oa-290v71'), type: 0, system: true });
    assert.deepEqual(w.relayed, [], 'nothing relayed to LINE');
    assert.deepEqual(w.commands, []);
    assert.equal(ch.sent.length, 0, 'no reply posted in the thread either');
    // what Mos types (Default 0, Reply 19) still goes through
    await emit(w.client, { ...message(ch, 'สวัสดีครับ'), type: 0 });
    await emit(w.client, { ...message(ch, 'ตอบกลับครับ'), type: 19 });
    assert.deepEqual(w.relayed.map((r) => r.text), ['สวัสดีครับ', 'ตอบกลับครับ']);
});
