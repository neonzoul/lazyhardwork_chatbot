// Production wiring (design §1.1): builds deps from config and returns the Express app + start/stop.
// Nothing in here is business logic; everything is injected so tests use the fakes instead.
const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');
const config = require('./config');
const { createLineClient } = require('./line/client');
const { createStore } = require('./store');
const { createModel } = require('./brain/respond');
const { createKeyring } = require('./brain/keys');
const { createBudget, createTracker, keyStatusLine } = require('./brain/budget');
const { loadPack } = require('./brain/kb');
const { createDeps, consoleLog } = require('./core/deps');
const { createEventHandler, runTurn } = require('./core/turn');
const { createSenders } = require('./identity/sender');
const { createAdminRouter } = require('./admin');

function optional(p) { try { return require(p); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(p.split('/').pop())) return null; throw e; } }

function createApp({ overrides = {} } = {}) {
    const log = overrides.log || consoleLog();
    const store = overrides.store || createStore({ path: config.db.path, log });
    const pack = overrides.pack || loadPack(path.resolve(config.knowledgeDir));
    const demoFlow = optional('./flows/demo');
    if (demoFlow?.demoShops && !pack.demoShops) pack.demoShops = demoFlow.demoShops(pack);
    const examplesFlow = optional('./flows/examples');
    if (examplesFlow?.examplesAssets) pack.assets = { ...(pack.assets || {}), ...examplesFlow.examplesAssets(config) };
    const lineClient = overrides.line || createLineClient({ channelAccessToken: config.line.channelAccessToken, log });
    // LLM platform (doc/llm.md): keyring → budget → alerts → tracker → model. `alerts` is read lazily by the hooks.
    let alerts = overrides.alerts || null;
    const keyring = overrides.keyring || createKeyring({
        keys: config.llm.openrouterKeys, log,
        onRecovered: (st) => alerts?.recovered?.({ kind: 'llm_exhausted', detail: { usable: st.usable, total: st.total } }).catch?.(() => {}),
    });
    const budget = overrides.budget || createBudget({ keyring, log, onWarn: (w) => alerts?.warn?.(w) });
    if (!alerts) {
        const alertsMod = optional('./discord/alerts');
        if (alertsMod?.createAlerts) {
            alerts = alertsMod.createAlerts({ botToken: config.discord.botToken, crmChannelId: config.discord.crmChannelId, leadsChannelId: config.discord.leadsChannelId, crmWebhook: config.discord.crmWebhook, log, statusLine: () => keyStatusLine(keyring, budget) });
        }
    }
    const tracker = overrides.tracker || createTracker({ store, budget, log });
    const model = overrides.model || createModel({ task: 'lay.reply', keyring, tracker, log });

    // Notifier: Discord module when merged, else the legacy webhook poster adapted to the interface.
    let notifier = overrides.notifier;
    if (!notifier) {
        const discord = optional('./discord/notify');
        if (discord?.createNotifier) {
            notifier = discord.createNotifier({ botToken: config.discord.botToken, guildId: config.discord.guildId, leadsChannelId: config.discord.leadsChannelId, crmChannelId: config.discord.crmChannelId, leadsWebhook: config.discord.leadsWebhook, log, store });
        } else {
            const axios = require('axios');
            const post = async (url, content) => { if (!url) throw new Error('webhook not configured'); await axios.post(url, { content }, { timeout: 8000 }); };
            notifier = {
                handoff: async ({ kind, lead, question }) => { await post(config.discord.leadsWebhook, `🔴 ${kind} · ${lead?.id || '-'}\n${(question || '').slice(0, 300)}`); return { threadId: null, fallback: 'webhook' }; },
                booking: async ({ lead, booking }) => { await post(config.discord.leadsWebhook, `📅 booking · ${lead?.id || '-'} · ${booking?.window_text || ''}`); return { threadId: null, fallback: 'webhook' }; },
                kbGap: async ({ question }) => post(config.discord.crmWebhook || config.discord.leadsWebhook, `❓ KB gap: ${(question || '').slice(0, 300)}`).catch(() => {}),
                lead: async ({ lead }) => post(config.discord.leadsWebhook, `🟢 lead ${lead?.id || '-'} · ${lead?.card_id || '?'} · ${lead?.symptom || ''}`).catch(() => {}),
                relayToMos: async () => {},
            };
        }
    }

    const deps = createDeps({ line: lineClient, notifier, store, model, log, pack, config, senders: createSenders(config), keyring, budget, alerts });
    const handleEvent = createEventHandler(deps);

    const app = express();
    app.get('/health', (_, res) => res.json({ status: 'ok', version: require('../package.json').version, pack: pack.manifest?.built_at || null }));
    app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets'), { maxAge: '1d' }));
    app.use('/richmenu', express.static(path.join(__dirname, '..', 'public', 'richmenu'), { maxAge: '1d' }));

    app.post('/webhook', line.middleware({ channelSecret: config.line.channelSecret }), (req, res) => {
        res.json({ status: 'ok' });                  // answer first; LINE wants a fast 200
        for (const ev of req.body.events || []) {
            try { handleEvent(ev); } catch (err) { log.error('webhook.handle_failed', { error: err?.message }); }
        }
    });

    app.use(createAdminRouter({ store, token: config.adminToken, log, llm: { keyring, budget, statusLine: () => keyStatusLine(keyring, budget) } }));

    // Discord relay (inbound): started with the server when the module and token exist.
    let relay = null;
    const relayMod = optional('./discord/relay');
    if (relayMod?.createRelay && config.discord.botToken) {
        relay = relayMod.createRelay({
            botToken: config.discord.botToken, guildId: config.discord.guildId, leadsChannelId: config.discord.leadsChannelId, store, log,
            onMosMessage: async ({ userId, text }) => runTurn({ userId, kind: 'mos_relay', text, timestamp: Date.now() }, deps),
            onCommand: async (cmd) => { const commands = optional('./discord/commands'); if (commands?.handleCommand) return commands.handleCommand(cmd, { deps, config, runTurn }); return { ok: false, text: 'commands not available' }; },
        });
    }

    let server = null;
    let budgetTimer = null;
    return {
        app, deps, pack,
        async start(port = config.port) {
            server = await new Promise((resolve) => { const s = app.listen(port, () => resolve(s)); });
            log.info('app.started', { port, knowledge: pack.manifest?.built_at, relay: !!relay, llm_keys: keyring.size });
            if (relay) relay.start().catch((e) => log.error('relay.start_failed', { error: e?.message }));
            // key limits from /auth/key (gives the budget its limit for the 80 % warning); refreshed every 10 min, throttled inside
            if (keyring.size && !overrides.budget) {
                budget.refresh().catch(() => {});
                budgetTimer = setInterval(() => budget.refresh().catch(() => {}), 10 * 60 * 1000);
                budgetTimer.unref?.();
            }
            return server;
        },
        async stop() {
            if (budgetTimer) { clearInterval(budgetTimer); budgetTimer = null; }
            if (relay) await relay.stop().catch(() => {});
            if (server) await new Promise((r) => server.close(r));
            await store.close?.();
        },
    };
}

module.exports = { createApp };
