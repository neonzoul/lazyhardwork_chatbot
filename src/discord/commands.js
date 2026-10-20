// Thread commands Mos types in a #leads relay thread (design §6.2): /approve · /propose <text> · /decline · /lay.
// parseCommand is pure. handleCommand is the reference mapping onto the pipeline; the relay calls it through `onCommand`.

const COMMANDS = ['approve', 'propose', 'decline', 'lay', 'take'];

const strings = {
    ackApprove: '✅ ยืนยันนัดแล้ว ส่งการ์ดสีเขียวให้ลูกค้าแล้ว',
    ackPropose: (text) => `✅ ส่งช่วงเวลาใหม่ให้ลูกค้าแล้ว: ${text}`,
    ackDecline: '✅ ส่งข้อความปฏิเสธอย่างสุภาพให้ลูกค้าแล้ว',
    ackLay: '✅ ส่งต่อให้ Lay ดูแลต่อแล้ว',
    ackTake: (threadId) => `⏸️ Human Mode: Lay หยุดตอบลูกค้าคนนี้แล้ว (ไม่มีหมดเวลา) ข้อความลูกค้าจะเข้าเธรด${threadId ? ` <#${threadId}>` : ''} · ปล่อยคืนด้วยปุ่ม ▶️Lay หรือ /lay`,
    takeNoThread: '⚠️ Human Mode เปิดแล้ว แต่เปิดเธรดไม่สำเร็จ ข้อความลูกค้าจะยังไม่ถูกส่งเข้า Discord',
    unknown: (cmd) => `❌ ไม่รู้จักคำสั่ง /${cmd} · ใช้ได้: /approve · /propose <ช่วงเวลา> · /decline · /lay · /take`,
    needArgs: '❌ /propose ต้องตามด้วยช่วงเวลา เช่น /propose พรุ่งนี้ 14:00 หรือ 16:00',
    noCustomer: '❌ เธรดนี้ไม่ได้ผูกกับลูกค้า (ไม่พบ user ของเธรด) — ตอบใน LINE OA Manager แทนครับ',
    notReady: (what) => `❌ ${what} ยังไม่พร้อมใช้งานในระบบ (รอโมดูล endings) — ตอบใน LINE OA Manager แทนครับ`,
    failed: (why) => `❌ ส่งไม่สำเร็จ: ${why}`,
};

function parseCommand(content) {
    const raw = String(content || '').trim();
    if (!raw.startsWith('/')) return null;
    const m = raw.match(/^\/([A-Za-z_]+)\s*([\s\S]*)$/);
    if (!m) return null;
    const command = m[1].toLowerCase();
    const args = m[2].trim();
    return { command, args, known: COMMANDS.includes(command) };
}

// Instructions Mos gives in plain words (Mos, 18 Oct): "@agent.layline Resume", "@bot ให้ Lay ตอบต่อ", or without a
// mention "Agent lay ไปตอบต่อเลย". Anything that @-mentions the bot is an instruction and NEVER reaches the customer.
// Returns { command, args, known: true, via } | { help: true } (mentioned, not understood) | null (a normal message).
const RESUME_RE = /^(?:resume|continue|back|lay|เลย์|ให้\s*(?:agent\s*)?(?:lay|เลย์)?|กลับ|ตอบต่อ|ดูแลต่อ|ไปตอบต่อ|ต่อเลย|รับต่อ|คืน)/iu;
const HANDBACK_RE = /^(?:agent\s*)?(?:lay|เลย์)\s*(?:ไป)?\s*(?:ตอบ|ดูแล|คุย|รับ)\s*ต่อ|^(?:ให้|ส่งให้|คืนให้)\s*(?:agent\s*)?(?:lay|เลย์)\s*(?:ไป)?\s*(?:ตอบ|ดูแล|คุย|รับ)?\s*ต่อ|^resume(?:\s+(?:lay|reply))?$/iu;
function parseBotInstruction(content, botId) {
    const raw = String(content || '').trim();
    const mentioned = !!botId && new RegExp(`<@!?${botId}>`).test(raw);
    if (mentioned) {
        const rest = raw.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim().replace(/^[\s,:·-]+/u, '');
        if (!rest || RESUME_RE.test(rest)) return { command: 'lay', args: '', known: true, via: 'mention' };
        if (/^(?:approve|ยืนยัน|อนุมัติ)/iu.test(rest)) return { command: 'approve', args: '', known: true, via: 'mention' };
        const p = rest.match(/^(?:propose|เสนอ(?:เวลา)?)\s*([\s\S]*)$/iu);
        if (p) return { command: 'propose', args: p[1].trim(), known: true, via: 'mention' };
        if (/^(?:decline|ปฏิเสธ|ไม่รับ)/iu.test(rest)) return { command: 'decline', args: '', known: true, via: 'mention' };
        return { help: true };
    }
    if (HANDBACK_RE.test(raw)) return { command: 'lay', args: '', known: true, via: 'phrase' };
    return null;
}

const LAY_BUTTON_ID = 'lay:release';
const layButtonRow = () => [{ type: 1, components: [{ type: 2, style: 1, label: '▶️Lay', custom_id: LAY_BUTTON_ID }] }];
// On every #leads post (Mos, 20 Oct): take the chat — Human Mode for that user + the lead thread.
const TAKE_BUTTON_PREFIX = 'take:';
const takeButtonRow = (userId) => (userId ? [{ type: 1, components: [{ type: 2, style: 2, label: 'Human Mode -⏸️Lay', custom_id: `${TAKE_BUTTON_PREFIX}${userId}` }] }] : undefined);
strings.mentionHelp = '❓ ไม่ได้ส่งถึงลูกค้า · สั่งบอทได้: `@บอท resume` (ให้ Lay ดูแลต่อ) · `@บอท approve` · `@บอท propose พรุ่งนี้ บ่าย` · `@บอท decline` · หรือกดปุ่ม "ให้ Lay ดูแลต่อ"';

function lazy(path) {
    try { return require(path); }
    catch (e) { if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(path.split('/').pop())) return null; throw e; }
}

// Hand back to Lay. Prefers the pipeline (`runTurn({kind:'mos_release'})`) when turn.js advertises it; otherwise does the
// minimal thing here through deps (no SDK): mode → lay, push quiet.strings.back as Lay with no quick replies.
async function releaseToLay({ userId, deps, config, runTurn }) {
    const turn = runTurn ? { runTurn } : lazy('../core/turn');
    const kinds = (turn && turn.INPUT_KINDS) || [];
    if (turn && turn.runTurn && (runTurn || kinds.includes('mos_release'))) {
        const r = await turn.runTurn({ kind: 'mos_release', userId, timestamp: Date.now() }, deps);
        if (r && r.errors && r.errors.length) throw r.errors[0];
        return { via: 'pipeline' };
    }
    const quiet = require('../identity/quiet');
    const msg = require('../line/messages');
    const { createSenders } = require('../identity/sender');
    const now = deps.clock ? deps.clock.now() : new Date();
    const s = await deps.store.sessions.getOrCreate(userId);
    quiet.callLay(s, now);
    s.resumed_by = 'mos_release';
    const senders = createSenders(config);
    const m = { ...msg.text(quiet.strings.back), sender: senders.lay };
    await deps.line.push(userId, [m]);
    await deps.store.messages.append({ user_id: userId, role: 'lay', kind: 'text', text: quiet.strings.back, sender_name: senders.lay.name, created_at: now.toISOString() });
    s.last_bot_at = now.toISOString();
    await deps.store.sessions.save(s);
    return { via: 'direct' };
}

// Human Mode (Mos, 20 Oct): Lay silent for this user with no timeout; the lead thread is opened when there is none, so
// customer messages are relayed and Mos can answer as "มอส" from Discord. Released by /lay (mos_release).
async function takeOver({ userId, deps, reason = 'take' }) {
    const s = await deps.store.sessions.get(userId);
    if (!s) throw new Error('no session for this user');
    const now = deps.clock ? deps.clock.now() : new Date();
    require('../core/session').setMode(s, 'human', now);
    s.taken_at = now.toISOString();
    let threadId = s.discord_thread_id || null;
    if (!threadId && deps.notifier && typeof deps.notifier.take === 'function') {
        const lead = deps.store.leads && deps.store.leads.byUser ? await deps.store.leads.byUser(userId) : null;
        const res = await deps.notifier.take({ session: s, lead, question: s.last_customer_text || null, reason });
        if (res && res.threadId) { threadId = res.threadId; s.discord_thread_id = threadId; }
    }
    await deps.store.sessions.save(s);
    if (deps.store.events && deps.store.events.append) await deps.store.events.append({ kind: 'human_mode', user_id: userId, payload: { reason, threadId }, created_at: now.toISOString() }).catch(() => {});
    return { threadId };
}

// Returns { ok, text } — the one-line ack the relay posts back into the thread.
async function handleCommand({ command, args, threadId, userId, lead_id }, { deps, config, runTurn, endings } = {}) {
    if (!COMMANDS.includes(command)) return { ok: false, text: strings.unknown(command) };
    if (!userId) return { ok: false, text: strings.noCustomer };
    try {
        if (command === 'lay') {
            await releaseToLay({ userId, deps, config, runTurn });
            return { ok: true, text: strings.ackLay };
        }
        if (command === 'take') {
            const r = await takeOver({ userId, deps });
            return { ok: true, text: r.threadId ? strings.ackTake(r.threadId) : strings.takeNoThread, threadId: r.threadId };
        }
        if (command === 'propose' && !args) return { ok: false, text: strings.needArgs };
        const mod = endings || lazy('../flows/endings');
        if (!mod || typeof mod.applyMosDecision !== 'function') {
            deps?.log?.warn?.('discord.command_unavailable', { command, reason: 'flows/endings.applyMosDecision missing' });
            return { ok: false, text: strings.notReady(`/${command}`) };
        }
        await mod.applyMosDecision({ decision: command, text: args, userId, leadId: lead_id, threadId, deps, config });
        if (command === 'approve') return { ok: true, text: strings.ackApprove };
        if (command === 'propose') return { ok: true, text: strings.ackPropose(args) };
        return { ok: true, text: strings.ackDecline };
    } catch (err) {
        deps?.log?.error?.('discord.command_failed', { command, threadId, error: err?.message });
        return { ok: false, text: strings.failed(err?.message || 'unknown') };
    }
}

// Slash-command definitions (registered per guild when DISCORD_REGISTER_COMMANDS=1).
const slashDefinitions = [
    { name: 'approve', description: 'ยืนยันนัดที่ลูกค้าขอ (ส่งการ์ดสีเขียว)' },
    { name: 'propose', description: 'เสนอช่วงเวลาใหม่ให้ลูกค้า', options: [{ type: 3, name: 'window', description: 'ช่วงเวลา 2–3 ตัวเลือก', required: true }] },
    { name: 'decline', description: 'ปฏิเสธอย่างสุภาพ + ช่องทางติดต่อ' },
    { name: 'lay', description: 'ส่งต่อให้ Lay ดูแลต่อ' },
    { name: 'take', description: 'Human Mode: Lay หยุดตอบลูกค้าคนนี้ (มอสคุยเอง)', options: [{ type: 3, name: 'lead', description: 'รหัสลีด L-… หรือ LINE userId (ในเธรดไม่ต้องใส่)', required: false }] },
];

module.exports = { takeOver, takeButtonRow, TAKE_BUTTON_PREFIX, parseBotInstruction, layButtonRow, LAY_BUTTON_ID, COMMANDS, parseCommand, handleCommand, releaseToLay, slashDefinitions, strings };
