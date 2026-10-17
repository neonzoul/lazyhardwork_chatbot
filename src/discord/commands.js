// Thread commands Mos types in a #leads relay thread (design §6.2): /approve · /propose <text> · /decline · /lay.
// parseCommand is pure. handleCommand is the reference mapping onto the pipeline; the relay calls it through `onCommand`.

const COMMANDS = ['approve', 'propose', 'decline', 'lay'];

const strings = {
    ackApprove: '✅ ยืนยันนัดแล้ว ส่งการ์ดสีเขียวให้ลูกค้าแล้ว',
    ackPropose: (text) => `✅ ส่งช่วงเวลาใหม่ให้ลูกค้าแล้ว: ${text}`,
    ackDecline: '✅ ส่งข้อความปฏิเสธอย่างสุภาพให้ลูกค้าแล้ว',
    ackLay: '✅ ส่งต่อให้ Lay ดูแลต่อแล้ว',
    unknown: (cmd) => `❌ ไม่รู้จักคำสั่ง /${cmd} · ใช้ได้: /approve · /propose <ช่วงเวลา> · /decline · /lay`,
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

// Returns { ok, text } — the one-line ack the relay posts back into the thread.
async function handleCommand({ command, args, threadId, userId, lead_id }, { deps, config, runTurn, endings } = {}) {
    if (!COMMANDS.includes(command)) return { ok: false, text: strings.unknown(command) };
    if (!userId) return { ok: false, text: strings.noCustomer };
    try {
        if (command === 'lay') {
            await releaseToLay({ userId, deps, config, runTurn });
            return { ok: true, text: strings.ackLay };
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
];

module.exports = { COMMANDS, parseCommand, handleCommand, releaseToLay, slashDefinitions, strings };
