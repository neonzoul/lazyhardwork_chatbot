// Inbound relay (design §6.2): a discord.js Client that listens in the #leads threads the notifier opened.
//   plain text  → onMosMessage({ threadId, userId, lead_id, text })   (the pipeline pushes it as "มอส")
//   /command    → onCommand({ threadId, userId, lead_id, command, args }) → { ok, text } posted back as the ack
//
// Thread → customer lookup: store.relayThreads.byThread(threadId) (T1), else a session whose discord_thread_id matches
// (flows/handoff sets it), else — if the thread's owner is our bot and its parent is #leads — the lead id from the title
// with no userId (commands then answer "เธรดนี้ไม่ได้ผูกกับลูกค้า").
//
// `client` is injectable (an EventEmitter with user/login/destroy) so tests run without the gateway.

const { parseCommand, parseBotInstruction, LAY_BUTTON_ID, TAKE_BUTTON_PREFIX, FORGET_BUTTON_PREFIX, slashDefinitions, strings } = require('./commands');

const LEAD_ID_RE = /^(L-[\w-]+)/;

// discord.js MessageType: 0 Default and 19 Reply are what a person types; every other type is a system notice.
const USER_MESSAGE_TYPES = new Set([0, 19]);
function isSystemMessage(message) {
    if (message.system === true) return true;
    if (message.type === undefined || message.type === null) return false;
    return !USER_MESSAGE_TYPES.has(Number(message.type));
}

function createRelay({ botToken, guildId, leadsChannelId, store, onMosMessage, onCommand, log, client, registerCommands } = {}) {
    const logger = log || { info() {}, warn() {}, error() {} };
    let c = client || null;
    let started = false;

    function makeClient() {
        const { Client, GatewayIntentBits, Partials } = require('discord.js');
        return new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
            partials: [Partials.Channel, Partials.Message],
            rest: { timeout: 8000, retries: 0 },
        });
    }

    async function lookup(threadId, channel) {
        if (store?.relayThreads?.byThread) {
            try {
                const row = await store.relayThreads.byThread(threadId);
                if (row) return { userId: row.user_id || null, lead_id: row.lead_id || null, source: 'relayThreads' };
            } catch (err) { logger.warn('discord.relay_lookup_failed', { threadId, error: err?.message }); }
        }
        if (store?.sessions?.all) {
            try {
                const s = (await store.sessions.all()).find((x) => x.discord_thread_id === threadId);
                if (s) return { userId: s.user_id, lead_id: null, source: 'session' };
            } catch (err) { logger.warn('discord.relay_lookup_failed', { threadId, error: err?.message }); }
        }
        const ours = channel?.ownerId && c?.user?.id && channel.ownerId === c.user.id;
        if (ours) {
            const m = String(channel.name || '').match(LEAD_ID_RE);
            return { userId: null, lead_id: m ? m[1] : null, source: 'owner' };
        }
        return null;
    }

    // "/take" target: a LINE userId (U…) or a lead id (L-…)
    async function resolveLead(ref) {
        const r = String(ref || '').trim();
        if (/^U[0-9a-f]{32}$/i.test(r)) return { userId: r, lead_id: null };
        if (/^L-/i.test(r) && store && store.leads && typeof store.leads.get === 'function') {
            const lead = await store.leads.get(r);
            if (lead && lead.user_id) return { userId: lead.user_id, lead_id: lead.id };
        }
        return null;
    }

    function inLeadsThread(channel) {
        if (!channel) return false;
        const isThread = typeof channel.isThread === 'function' ? channel.isThread() : !!channel.parentId;
        return isThread && String(channel.parentId) === String(leadsChannelId);
    }

    async function say(channel, text, components) {
        try { await channel.send(components ? { content: text, components } : text); } catch (err) { logger.warn('discord.ack_failed', { channelId: channel?.id, error: err?.message }); }
    }

    async function onMessage(message) {
        try {
            if (!message || message.author?.bot) return;
            if (c?.user?.id && message.author?.id === c.user.id) return;
            // Only what Mos actually typed reaches the customer. Discord system messages (thread rename, pin, member added,
            // thread created, …) carry Mos as author and the new name as content: a rename on 22 Oct reached LINE as "มอส".
            if (isSystemMessage(message)) { logger.info('discord.system_message_ignored', { type: message.type }); return; }
            const channel = message.channel;
            // "/take <L-… | U…>" typed in #leads itself (not a thread)
            if (!inLeadsThread(channel) && String(channel?.id) === String(leadsChannelId)) {
                const m = String(message.content || '').trim().match(/^\/take\s+(\S+)/i);
                if (!m) return;
                const who = await resolveLead(m[1]);
                const res = onCommand && who ? await onCommand({ threadId: null, userId: who.userId, lead_id: who.lead_id, command: 'take', args: '' }) : { ok: false, text: strings.noCustomer };
                return say(channel, (res && res.text) || '❌');
            }
            if (!inLeadsThread(channel)) return;
            const threadId = String(channel.id);
            const content = String(message.content || '').trim();
            if (!content) return;
            const who = await lookup(threadId, channel);
            if (!who) return; // not one of ours
            const instr = parseBotInstruction(content, c?.user?.id);
            if (instr && instr.help) return say(channel, strings.mentionHelp);
            const parsed = instr || parseCommand(content);
            if (parsed) {
                if (!parsed.known) return say(channel, strings.unknown(parsed.command));
                const res = onCommand
                    ? await onCommand({ threadId, userId: who.userId, lead_id: who.lead_id, command: parsed.command, args: parsed.args })
                    : { ok: false, text: strings.notReady(`/${parsed.command}`) };
                logger.info('discord.command', { threadId, command: parsed.command, via: parsed.via || 'slash-text', ok: !!res?.ok });
                return say(channel, (res && res.text) || (res?.ok ? '✅' : '❌'), res && res.components);
            }
            if (!who.userId) return say(channel, strings.noCustomer);
            // A command typed mid-sentence, or the help text pasted back, must never reach the customer.
            if (/(^|\s)\/(approve|propose|decline|lay)/i.test(content) || /วิธีตอบ|ส่งถึงลูกค้าในนาม/u.test(content)) {
                logger.warn('discord.relay_blocked_command_like', { threadId });
                return say(channel, '❌ ไม่ได้ส่งถึงลูกค้า: ข้อความนี้มีคำสั่งอยู่กลางประโยค คำสั่งต้องขึ้นต้นบรรทัดด้วย / เช่น `/lay` ถ้าจะคุยกับลูกค้า พิมพ์ข้อความธรรมดาได้เลย');
            }
            if (!onMosMessage) return;
            try {
                await onMosMessage({ threadId, userId: who.userId, lead_id: who.lead_id, text: content });
                logger.info('discord.relayed', { threadId, chars: content.length });
                if (typeof message.react === 'function') await message.react('✅').catch(() => {});
            } catch (err) {
                logger.error('discord.relay_failed', { threadId, error: err?.message });
                await say(channel, strings.failed(err?.message || 'unknown'));
            }
        } catch (err) {
            logger.error('discord.relay_handler_failed', { error: err?.message });
        }
    }

    async function onInteraction(interaction) {
        try {
            if (interaction?.isButton?.() && String(interaction.customId || '').startsWith(FORGET_BUTTON_PREFIX)) {
                const userId = String(interaction.customId).slice(FORGET_BUTTON_PREFIX.length);
                const res = onCommand ? await onCommand({ threadId: interaction.channel ? String(interaction.channel.id) : null, userId, lead_id: null, command: 'forget', args: 'confirmed' }) : { ok: false, text: strings.noCustomer };
                logger.info('discord.command', { command: 'forget', via: 'button', ok: !!res?.ok });
                return interaction.reply({ content: (res && res.text) || '❌' });
            }
            if (interaction?.isButton?.() && String(interaction.customId || '').startsWith(TAKE_BUTTON_PREFIX)) {
                const userId = String(interaction.customId).slice(TAKE_BUTTON_PREFIX.length);
                const res = onCommand ? await onCommand({ threadId: null, userId, lead_id: null, command: 'take', args: '' }) : { ok: false, text: strings.noCustomer };
                logger.info('discord.command', { command: 'take', via: 'button', ok: !!res?.ok });
                return interaction.reply({ content: (res && res.text) || '❌' });
            }
            if (interaction?.isButton?.() && interaction.customId === LAY_BUTTON_ID) {
                const ch = interaction.channel;
                const who = inLeadsThread(ch) ? await lookup(String(ch.id), ch) : null;
                const res = onCommand && who && who.userId
                    ? await onCommand({ threadId: String(ch.id), userId: who.userId, lead_id: who.lead_id, command: 'lay', args: '' })
                    : { ok: false, text: strings.noCustomer };
                logger.info('discord.command', { threadId: ch?.id, command: 'lay', via: 'button', ok: !!res?.ok });
                return interaction.reply({ content: (res && res.text) || '❌' });
            }
            if (!interaction?.isChatInputCommand?.()) return;
            const channel = interaction.channel;
            if (interaction.commandName === 'take' && !inLeadsThread(channel)) {
                const who = await resolveLead(interaction.options?.getString?.('lead') || '');
                const res = onCommand && who ? await onCommand({ threadId: null, userId: who.userId, lead_id: who.lead_id, command: 'take', args: '' }) : { ok: false, text: strings.noCustomer };
                return interaction.reply({ content: (res && res.text) || '❌' });
            }
            if (!inLeadsThread(channel)) return interaction.reply({ content: 'ใช้คำสั่งนี้ในเธรดลูกค้าใน #leads เท่านั้น', ephemeral: true });
            const threadId = String(channel.id);
            const who = await lookup(threadId, channel);
            const command = interaction.commandName;
            const args = interaction.options?.getString?.('window') || '';
            const res = onCommand && who
                ? await onCommand({ threadId, userId: who.userId, lead_id: who.lead_id, command, args })
                : { ok: false, text: who ? strings.notReady(`/${command}`) : strings.noCustomer };
            await interaction.reply({ content: (res && res.text) || '❌', ...(res && res.components ? { components: res.components } : {}) });
        } catch (err) {
            logger.error('discord.interaction_failed', { error: err?.message });
        }
    }

    async function registerSlash() {
        if (!(registerCommands ?? process.env.DISCORD_REGISTER_COMMANDS === '1')) return;
        if (!guildId || !c?.user?.id || !c.rest?.put) return;
        try {
            const { Routes } = require('discord.js');
            await c.rest.put(Routes.applicationGuildCommands(c.user.id, guildId), { body: slashDefinitions });
            logger.info('discord.slash_registered', { guildId, count: slashDefinitions.length });
        } catch (err) {
            logger.warn('discord.slash_register_failed', { error: err?.message });
        }
    }

    return {
        async start() {
            if (started) return c;
            if (!botToken && !client) { logger.warn('discord.relay_disabled', { reason: 'no bot token' }); return null; }
            c = c || makeClient();
            c.on('messageCreate', onMessage);
            c.on('interactionCreate', onInteraction);
            c.once?.('clientReady', () => { logger.info('discord.relay_ready', { user: c.user?.tag }); registerSlash(); });
            c.on('error', (err) => logger.error('discord.client_error', { error: err?.message }));
            started = true;
            if (typeof c.login === 'function') await c.login(botToken);
            return c;
        },
        async stop() {
            if (!c) return;
            try { await c.destroy?.(); } catch { /* ignore */ }
            started = false;
        },
        _onMessage: onMessage,
        _lookup: lookup,
    };
}

module.exports = { createRelay, isSystemMessage };
