// Discord notifier (design §6.2) — the production `deps.notifier`. Shape matches tests/fakes/notifier.js.
//
//   handoff / booking  → thread in #leads via the bot (REST). Fallback: webhook plain message. Both down → THROW.
//   kbGap / lead       → one line to #leads (bot, else webhook). Never throw.
//   relayToMos         → post into the thread (mirror of what the customer sends while Mos is active). Never throw.
//
// Transport is injectable (`transport`) so tests run without the network. The default transport uses
// @discordjs/rest (bundled with discord.js) for the bot and global fetch for the webhook; 8 s per call.

const fmt = require('./format');

const CALL_TIMEOUT_MS = 8000;
const AUTO_ARCHIVE_MINUTES = 1440; // 1 day
const PUBLIC_THREAD = 11;          // ChannelType.PublicThread

function createRestTransport({ botToken, fetchImpl = globalThis.fetch, timeoutMs = CALL_TIMEOUT_MS }) {
    let rest = null;
    if (botToken) {
        const { REST } = require('discord.js');
        rest = new REST({ version: '10', timeout: timeoutMs, retries: 0 }).setToken(botToken);
    }
    const need = () => { if (!rest) throw new Error('discord bot not configured'); return rest; };
    return {
        botConfigured: !!rest,
        async createThread({ channelId, name, content }) {
            const r = need();
            const thread = await r.post(`/channels/${channelId}/threads`, {
                body: { name, type: PUBLIC_THREAD, auto_archive_duration: AUTO_ARCHIVE_MINUTES },
                reason: 'Lay v2 handoff',
            });
            await r.post(`/channels/${thread.id}/messages`, { body: { content, allowed_mentions: { parse: [] } } });
            return { threadId: thread.id };
        },
        // allowedMentions defaults to none; discord/alerts passes { parse: ['everyone'] } for @here on critical alerts.
        async postMessage({ channelId, content, allowedMentions }) {
            await need().post(`/channels/${channelId}/messages`, { body: { content, allowed_mentions: allowedMentions || { parse: [] } } });
        },
        async postWebhook({ url, content, allowedMentions }) {
            if (!url) throw new Error('discord webhook not configured');
            if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content, allowed_mentions: allowedMentions || { parse: [] } }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) throw new Error(`webhook ${res.status}`);
        },
    };
}

function createNotifier({ botToken, guildId, leadsChannelId, crmChannelId, leadsWebhook, log, store, transport, fetchImpl } = {}) {
    const t = transport || createRestTransport({ botToken, fetchImpl });
    const logger = log || { info() {}, warn() {}, error() {} };
    const botReady = () => !!(t.botConfigured && leadsChannelId);

    async function recordThread({ threadId, session, lead, openedFor }) {
        if (!store || !store.relayThreads || typeof store.relayThreads.create !== 'function') return;
        try {
            await store.relayThreads.create({
                discord_thread_id: threadId,
                user_id: session?.user_id || lead?.user_id || null,
                lead_id: lead?.id || null,
                opened_for: openedFor,
                created_at: new Date().toISOString(),
            });
        } catch (err) {
            logger.warn('discord.relay_thread_record_failed', { threadId, error: err?.message });
        }
    }

    // Thread first, webhook second, throw last. The caller (flows/handoff) only promises the customer after we resolve.
    async function openThread({ name, content, session, lead, openedFor }) {
        let botError = null;
        if (botReady()) {
            try {
                const { threadId } = await t.createThread({ channelId: leadsChannelId, name, content });
                logger.info('discord.thread_opened', { threadId, leadId: lead?.id, openedFor });
                await recordThread({ threadId, session, lead, openedFor });
                return { threadId };
            } catch (err) {
                botError = err;
                logger.warn('discord.thread_failed', { leadId: lead?.id, error: err?.message });
            }
        }
        try {
            await t.postWebhook({ url: leadsWebhook, content: `**${name}**\n${content}` });
            logger.warn('discord.webhook_fallback', { leadId: lead?.id, openedFor, botError: botError?.message || 'bot not configured' });
            return { threadId: null, fallback: 'webhook' };
        } catch (err) {
            logger.error('discord.notify_failed', { leadId: lead?.id, openedFor, botError: botError?.message, webhookError: err?.message });
            const e = new Error(`discord notify failed: bot=${botError?.message || 'not configured'}; webhook=${err?.message}`);
            e.cause = err;
            throw e;
        }
    }

    // One line to #leads; best effort.
    async function postLine(content, event) {
        try {
            if (botReady()) await t.postMessage({ channelId: leadsChannelId, content });
            else await t.postWebhook({ url: leadsWebhook, content });
        } catch (err) {
            logger.warn(event || 'discord.line_failed', { error: err?.message });
        }
    }

    return {
        async handoff({ kind, session, lead, question, draft }) {
            return openThread({
                name: fmt.handoffThreadTitle({ lead, kind, session }),
                content: fmt.handoffOpening({ kind, session, lead, question, draft }),
                session, lead, openedFor: kind || 'handoff',
            });
        },
        async booking({ lead, booking, session, question, draft }) {
            return openThread({
                name: fmt.handoffThreadTitle({ lead, kind: 'booking', session }),
                content: fmt.bookingOpening({ session, lead, booking, question, draft }),
                session, lead, openedFor: 'booking',
            });
        },
        async kbGap({ question }) { await postLine(fmt.kbGapLine({ question }), 'discord.kbgap_failed'); },
        async lead({ lead, reason }) { await postLine(fmt.leadLine({ lead, reason }), 'discord.lead_failed'); },
        async relayToMos({ threadId, text }) {
            if (!threadId || !botReady()) return;
            try { await t.postMessage({ channelId: threadId, content: fmt.mirrorLine({ text }) }); }
            catch (err) { logger.warn('discord.mirror_failed', { threadId, error: err?.message }); }
        },
        _transport: t,
    };
}

module.exports = { createNotifier, createRestTransport, CALL_TIMEOUT_MS, AUTO_ARCHIVE_MINUTES };
