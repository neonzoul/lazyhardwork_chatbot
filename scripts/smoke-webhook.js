#!/usr/bin/env node
// Real-surface smoke (practice audit gap 4): prove a deployed Lay v2 works without anyone tapping on a phone.
//
//   node scripts/smoke-webhook.js --base https://<tunnel-or-railway> --secret <LINE channel secret> --token <ADMIN_TOKEN>
//                                 [--user Usmoke-<random>] [--real-push] [--wait-text 7500] [--wait-postback 1000]
//
// It builds LINE webhook events for one user id, signs each body exactly the way LINE does
// (x-line-signature = base64(HMAC-SHA256(channel secret, raw body bytes))), POSTs them to <base>/webhook in the order
//   follow → "สวัสดีครับ" → FIT_chat_overload → "ราคาเท่าไหร่" → MENU_EXAMPLES → "เรียก Lay"
// waits for the text debounce (core/turn: 6.5 s) between steps, then reads the persisted result back through the admin
// API (GET /admin/sessions/:userId, GET /admin/events) and prints a PASS / WARN / FAIL table.
//
// Synthetic id caveat. LINE rejects a push to an id that is not a real user (400), so with the default `Usmoke-…` id the
// app composes every message and hands it to LINE, LINE refuses, and core/turn records an `undelivered` event (payload
// lists the message types) plus an `error` event ("line undelivered") instead of a transcript row. This script treats
// that as the expected outcome of the synthetic id: the `undelivered` events are the evidence that a message of the right
// type was composed, and those two event kinds are filtered out of the error check. Content (text, Flex template) can
// only be verified from transcript rows, i.e. when LINE accepts the send: in the unit test (fake LINE) or with
// `--real-push --user U<real id>`, where the messages really arrive on that phone and `undelivered` counts as FAIL.
//
// Model availability. Free-text steps need the model; when the key is missing or exhausted the turn answers with the
// honest fallback ("ขัดข้อง") and records a `model_fallback` event. That is reported as WARN (model unavailable), never
// FAIL — the never-silent rule is what is asserted. Nothing sent at all is FAIL.
//
// Exit code: 1 when any check is FAIL, else 0. Exports runSmoke() and signBody() for tests.
'use strict';

const crypto = require('node:crypto');

const OPENING_MARK = '3 เรื่อง';                 // flows/opening.strings.opening
const BACK_MARK = 'กลับมาดูแลต่อ';               // identity/quiet.strings.back
const FALLBACK_MARK = 'ขัดข้อง';                 // core/turn.fallbackText / core/policy.strings.fallback
const DEFAULT_WAITS = { text: 7500, postback: 1000, follow: 1500 };
const IGNORED_ERROR_PAYLOADS = ['line undelivered'];

function signBody(secret, rawBody) {
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    return crypto.createHmac('sha256', String(secret)).update(bytes).digest('base64');
}

// ---------------------------------------------------------------------------------------------------------------
// Event builders (shape per doc/line-platform-notes.md §1 and src/line/events.js)
let seq = 0;
function baseEvent(userId, type, extra) {
    seq += 1;
    const ts = Date.now();
    return {
        type, mode: 'active', timestamp: ts,
        source: { type: 'user', userId },
        webhookEventId: `01SMOKE${ts.toString(36).toUpperCase()}${String(seq).padStart(4, '0')}`,
        deliveryContext: { isRedelivery: false },
        replyToken: `smoke-reply-${ts}-${seq}`,
        ...extra,
    };
}
const events = {
    follow: (userId) => baseEvent(userId, 'follow', { follow: { isUnblocked: false } }),
    text: (userId, text) => baseEvent(userId, 'message', { message: { type: 'text', id: `smoke-msg-${Date.now()}-${seq + 1}`, text, quoteToken: 'smoke-quote' } }),
    postback: (userId, data) => baseEvent(userId, 'postback', { postback: { data } }),
};

const STEPS = [
    { id: 'follow', label: 'follow (add friend)', build: (u) => events.follow(u), wait: 'follow' },
    { id: 'greeting', label: 'text "สวัสดีครับ"', build: (u) => events.text(u, 'สวัสดีครับ'), wait: 'text', model: true },
    { id: 'fit', label: 'postback FIT_chat_overload', build: (u) => events.postback(u, 'FIT_chat_overload'), wait: 'postback', model: true },
    { id: 'price', label: 'text "ราคาเท่าไหร่"', build: (u) => events.text(u, 'ราคาเท่าไหร่'), wait: 'text', model: true },
    { id: 'examples', label: 'postback MENU_EXAMPLES', build: (u) => events.postback(u, 'MENU_EXAMPLES'), wait: 'postback' },
    { id: 'call_lay', label: 'text "เรียก Lay"', build: (u) => events.text(u, 'เรียก Lay'), wait: 'text' },
];

// ---------------------------------------------------------------------------------------------------------------
// HTTP helpers
async function postWebhook(base, secret, body, { signature } = {}) {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await fetch(`${base}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-line-signature': signature !== undefined ? signature : signBody(secret, raw) },
        body: raw,
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
}

function admin(base, token) {
    const get = async (path) => {
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
        const text = await res.text().catch(() => '');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        if (res.status === 401) throw new Error(`admin ${path}: 401 unauthorized — wrong --token?`);
        return { status: res.status, json };
    };
    return {
        session: async (userId) => { const r = await get(`/admin/sessions/${encodeURIComponent(userId)}`); return r.status === 404 ? null : r.json; },
        events: async (userId) => { const r = await get('/admin/events?limit=200'); return (r.json?.events || []).filter((e) => e.user_id === userId); },
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snip = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const isBotRow = (m) => m.role && m.role !== 'customer';
const flexTemplate = (m) => (m.kind === 'flex' ? (m.payload?.template || null) : null);

// ---------------------------------------------------------------------------------------------------------------
async function runSmoke({ base, secret, token, user, realPush = false, waits = {}, out = null } = {}) {
    if (!base || !secret || !token) throw new Error('runSmoke: base, secret and token are required');
    base = String(base).replace(/\/$/, '');
    const userId = user || `Usmoke-${Date.now().toString(36)}`;
    const synthetic = !realPush;
    const W = { ...DEFAULT_WAITS, ...waits };
    if (waits.postback !== undefined && waits.follow === undefined) W.follow = waits.postback;
    const api = admin(base, token);
    const log = out || (() => {});
    const started = Date.now();
    const results = [];
    const seenMsg = new Set();
    const seenEv = new Set();
    let tailOverflow = false;

    const check = (step, name, status, observed) => { step.checks.push({ name, status, observed: observed || '' }); };
    const step = (id, label) => { const s = { id, label, checks: [] }; results.push(s); return s; };

    // Reads the persisted state and returns only what is new since the last read.
    async function observe() {
        const [data, evs] = await Promise.all([api.session(userId), api.events(userId)]);
        const messages = data?.messages || [];
        if (messages.length >= 30) tailOverflow = true;
        const newMessages = messages.filter((m) => !seenMsg.has(String(m.id)));
        newMessages.forEach((m) => seenMsg.add(String(m.id)));
        const newEvents = evs.filter((e) => !seenEv.has(String(e.id)));
        newEvents.forEach((e) => seenEv.add(String(e.id)));
        return { session: data?.session || null, newMessages, newEvents, allEvents: evs };
    }

    // Evidence that the app sent (or tried to send) a message of `kind` this step.
    function sentEvidence(obs, { kind, match, matchLabel }) {
        const rows = obs.newMessages.filter(isBotRow);
        const hit = rows.find((m) => m.kind === kind && (!match || match(m)));
        if (hit) return { status: 'PASS', observed: describeRow(hit) };
        const attempted = obs.newEvents.filter((e) => e.kind === 'undelivered');
        const attemptedKinds = attempted.flatMap((e) => e.payload?.messages || []);
        if (synthetic && attemptedKinds.includes(kind)) {
            return { status: 'PASS', observed: `composed [${attemptedKinds.join(',')}] → LINE rejected synthetic id (expected); ${matchLabel || 'content'} not verifiable without delivery` };
        }
        if (rows.length) return { status: 'FAIL', observed: `sent ${rows.map(describeRow).join(' | ')} — expected ${kind}${matchLabel ? ` ${matchLabel}` : ''}` };
        if (attemptedKinds.length) return { status: 'FAIL', observed: `composed [${attemptedKinds.join(',')}] but expected ${kind}` };
        return { status: 'FAIL', observed: 'nothing sent (silent turn)' };
    }
    function describeRow(m) {
        const who = m.sender_name ? ` from "${m.sender_name}"` : '';
        if (m.kind === 'flex') return `flex:${flexTemplate(m) || '?'}${who}`;
        return `${m.kind} "${snip(m.text)}"${who}`;
    }
    const modelFellBack = (obs) => obs.newEvents.some((e) => e.kind === 'model_fallback')
        || obs.newMessages.some((m) => isBotRow(m) && m.kind === 'text' && String(m.text || '').includes(FALLBACK_MARK));

    // 0. reachability + signature guard
    const s0 = step('health', 'GET /health + signature guard');
    try {
        const res = await fetch(`${base}/health`); const j = await res.json().catch(() => null);
        check(s0, 'health', res.status === 200 && j?.status === 'ok' ? 'PASS' : 'FAIL', `HTTP ${res.status} version=${j?.version || '?'} pack=${j?.pack || '?'}`);
    } catch (e) { check(s0, 'health', 'FAIL', `unreachable: ${e.message}`); return finish(); }
    try {
        const bad = await postWebhook(base, secret, { destination: 'smoke', events: [] }, { signature: 'bad-signature' });
        check(s0, 'rejects bad signature', bad.status !== 200 ? 'PASS' : 'FAIL', `HTTP ${bad.status} on wrong x-line-signature`);
        const empty = await postWebhook(base, secret, { destination: 'smoke', events: [] });
        check(s0, 'accepts signed empty body', empty.status === 200 ? 'PASS' : 'FAIL', `HTTP ${empty.status} (LINE's connectivity check)`);
    } catch (e) { check(s0, 'signature guard', 'FAIL', e.message); }
    const pre = await api.session(userId);
    if (pre) check(s0, 'fresh user id', 'WARN', `session for ${userId} already exists — results include earlier history`);
    else check(s0, 'fresh user id', 'PASS', userId);
    await observe(); // baseline: anything already persisted for this id is not counted

    // 1..6 the conversation
    for (const def of STEPS) {
        const st = step(def.id, def.label);
        const t0 = Date.now();
        let posted;
        try { posted = await postWebhook(base, secret, { destination: 'smoke', events: [def.build(userId)] }); }
        catch (e) { check(st, 'webhook', 'FAIL', `POST failed: ${e.message}`); continue; }
        check(st, 'webhook', posted.status === 200 ? 'PASS' : 'FAIL', `HTTP ${posted.status}${posted.status === 200 ? '' : ` ${snip(posted.text, 80)}`}`);
        if (posted.status !== 200) continue;
        await sleep(W[def.wait]);
        let obs;
        try { obs = await observe(); } catch (e) { check(st, 'admin read', 'FAIL', e.message); continue; }
        if (!obs.session) { check(st, 'session', 'FAIL', 'no session row for this user after the event'); continue; }
        const fellBack = def.model && modelFellBack(obs);
        const sentNote = (ev) => (fellBack && ev.status === 'PASS' ? { status: 'WARN', observed: `model unavailable — honest fallback sent: ${ev.observed}` } : ev);

        switch (def.id) {
            case 'follow': {
                check(st, 'session.opened', obs.session.opened === true ? 'PASS' : 'FAIL', `opened=${JSON.stringify(obs.session.opened)}`);
                const ev = sentEvidence(obs, { kind: 'text', match: (m) => String(m.text || '').includes(OPENING_MARK), matchLabel: `containing "${OPENING_MARK}"` });
                check(st, 'opening text', ev.status, ev.observed);
                break;
            }
            case 'greeting':
            case 'price': {
                const ev = sentNote(sentEvidence(obs, { kind: 'text' }));
                check(st, 'lay replied (never silent)', ev.status, ev.observed);
                if (fellBack && ev.status === 'FAIL') check(st, 'model', 'WARN', 'model_fallback recorded for this turn');
                break;
            }
            case 'fit': {
                const sym = obs.session.draft?.symptom;
                check(st, 'draft.symptom', sym === 'chat_overload' ? 'PASS' : 'FAIL', `draft=${JSON.stringify(obs.session.draft || null)}`);
                const text = sentNote(sentEvidence(obs, { kind: 'text' }));
                check(st, 'lay replied (never silent)', text.status, text.observed);
                const card = sentEvidence(obs, { kind: 'flex', match: (m) => ['choice', 'offer'].includes(flexTemplate(m)), matchLabel: 'template choice|offer' });
                if (card.status === 'FAIL' && fellBack) check(st, 'card choice|offer', 'WARN', `no card — model unavailable (fallback turn): ${card.observed}`);
                else if (card.status === 'FAIL' && obs.newMessages.filter(isBotRow).some((m) => m.kind === 'text' && /AI Chatbot|ราคาเริ่มต้น/.test(m.text || ''))) check(st, 'card choice|offer', 'FAIL', `${card.observed} — offer card fell back to text: is FASTWORK_URL set on the server?`);
                else check(st, 'card choice|offer', card.status, card.observed);
                break;
            }
            case 'examples': {
                const card = sentEvidence(obs, { kind: 'flex', match: (m) => flexTemplate(m) === 'examples', matchLabel: 'template examples' });
                check(st, 'card examples', card.status, card.status === 'FAIL' && obs.newMessages.some((m) => isBotRow(m) && m.kind === 'text')
                    ? `${card.observed} — carousel fell back to text: is PUBLIC_BASE_URL an https URL on the server?` : card.observed);
                break;
            }
            case 'call_lay': {
                const ev = sentEvidence(obs, { kind: 'text', match: (m) => String(m.text || '').includes(BACK_MARK), matchLabel: `containing "${BACK_MARK}"` });
                check(st, 'Lay is back', ev.status, ev.observed);
                check(st, 'session.mode', obs.session.mode === 'lay' ? 'PASS' : 'FAIL', `mode=${obs.session.mode}`);
                break;
            }
            default: break;
        }
        st.ms = Date.now() - t0;
    }

    // 7. persisted result + error feed
    const sf = step('final', 'session + event feed');
    try {
        const data = await api.session(userId);
        const sess = data?.session;
        check(sf, 'last_customer_at', sess?.last_customer_at ? 'PASS' : 'FAIL', `last_customer_at=${sess?.last_customer_at || null}`);
        check(sf, 'last_customer_text', sess?.last_customer_text ? 'PASS' : 'FAIL', `"${snip(sess?.last_customer_text)}"`);
        const all = await api.events(userId);
        const byKind = {};
        for (const e of all) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
        const undelivered = all.filter((e) => e.kind === 'undelivered');
        const errors = all.filter((e) => e.kind === 'error' && !(synthetic && IGNORED_ERROR_PAYLOADS.includes(e.payload?.error)));
        check(sf, 'no error events', errors.length === 0 ? 'PASS' : 'FAIL', errors.length ? errors.map((e) => `${e.payload?.input || '?'}: ${snip(e.payload?.error)}`).join(' | ') : `kinds seen: ${JSON.stringify(byKind)}`);
        if (synthetic) check(sf, 'undelivered (synthetic id)', 'PASS', `${undelivered.length} ignored — pushes to a synthetic id fail at LINE (expected); ${all.filter((e) => e.kind === 'error' && IGNORED_ERROR_PAYLOADS.includes(e.payload?.error)).length} "line undelivered" error rows ignored`);
        else check(sf, 'delivered to real user', undelivered.length === 0 ? 'PASS' : 'FAIL', undelivered.length ? `${undelivered.length} undelivered: ${snip(undelivered.map((e) => e.payload?.error).join('; '), 80)}` : 'no undelivered events');
        const fallbacks = all.filter((e) => e.kind === 'model_fallback').length;
        if (fallbacks) check(sf, 'model', 'WARN', `${fallbacks} model_fallback event(s) — key missing/exhausted? free-text steps answered with the honest fallback`);
        if (tailOverflow) check(sf, 'transcript tail', 'WARN', 'admin returns the last 30 rows only — early rows may have scrolled out');
    } catch (e) { check(sf, 'admin read', 'FAIL', e.message); }

    return finish();

    function finish() {
        const totalMs = Date.now() - started;
        const counts = { PASS: 0, WARN: 0, FAIL: 0 };
        for (const s of results) for (const c of s.checks) counts[c.status] = (counts[c.status] || 0) + 1;
        const report = { ok: counts.FAIL === 0, user: userId, base, synthetic, totalMs, counts, results };
        log(formatTable(report));
        return report;
    }
}

// ---------------------------------------------------------------------------------------------------------------
function formatTable(report) {
    const lines = [];
    lines.push(`Lay v2 real-surface smoke — ${report.base} — user ${report.user}${report.synthetic ? ' (synthetic id)' : ' (--real-push)'}`);
    lines.push('');
    const rows = [];
    report.results.forEach((s, i) => s.checks.forEach((c, j) => rows.push([j === 0 ? String(i) : '', j === 0 ? s.label : '', c.name, c.status, c.observed])));
    const widths = [1, 2, 3].map((k) => Math.min(44, Math.max(...rows.map((r) => [...r[k]].length), 4)));
    const pad = (s, w) => { const len = [...s].length; return len >= w ? s : s + ' '.repeat(w - len); };
    lines.push(`${pad('#', 2)} ${pad('step', widths[0])}  ${pad('check', widths[1])}  ${pad('status', widths[2])}  observed`);
    lines.push('-'.repeat(2 + 1 + widths[0] + 2 + widths[1] + 2 + widths[2] + 2 + 40));
    for (const r of rows) lines.push(`${pad(r[0], 2)} ${pad(r[1], widths[0])}  ${pad(r[2], widths[1])}  ${pad(r[3], widths[2])}  ${r[4]}`);
    lines.push('');
    lines.push(`${report.counts.PASS} PASS · ${report.counts.WARN} WARN · ${report.counts.FAIL} FAIL · ${(report.totalMs / 1000).toFixed(1)} s · result: ${report.ok ? 'PASS' : 'FAIL'}`);
    if (report.synthetic) lines.push('note: outbound pushes to a synthetic user id are rejected by LINE (400) — expected; `undelivered` and "line undelivered" error events for this user are ignored. Use --real-push --user U<real id> to verify delivered content.');
    return lines.join('\n');
}

function parseArgs(argv) {
    const o = { realPush: false, waits: {} };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => { i += 1; return argv[i]; };
        if (a === '--base') o.base = next();
        else if (a === '--secret') o.secret = next();
        else if (a === '--token') o.token = next();
        else if (a === '--user') o.user = next();
        else if (a === '--real-push') o.realPush = true;
        else if (a === '--wait-text') o.waits.text = parseInt(next(), 10);
        else if (a === '--wait-postback') o.waits.postback = parseInt(next(), 10);
        else if (a === '--help' || a === '-h') o.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return o;
}

const USAGE = `usage: node scripts/smoke-webhook.js --base <http(s)://host> --secret <LINE channel secret> --token <ADMIN_TOKEN>
                                    [--user Usmoke-<random>] [--real-push] [--wait-text 7500] [--wait-postback 1000]
env fallbacks: SMOKE_BASE, LINE_CHANNEL_SECRET, ADMIN_TOKEN`;

if (require.main === module) {
    (async () => {
        let args;
        try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(USAGE); process.exit(2); }
        if (args.help) { console.log(USAGE); process.exit(0); }
        args.base = args.base || process.env.SMOKE_BASE;
        args.secret = args.secret || process.env.LINE_CHANNEL_SECRET;
        args.token = args.token || process.env.ADMIN_TOKEN;
        if (!args.base || !args.secret || !args.token) { console.error(USAGE); process.exit(2); }
        if (args.realPush && !args.user) { console.error('--real-push needs --user U<real LINE user id> (the messages will arrive on that phone)'); process.exit(2); }
        const report = await runSmoke({ ...args, out: (s) => console.log(s) });
        process.exit(report.ok ? 0 : 1);
    })().catch((e) => { console.error(`smoke failed: ${e.message}`); process.exit(1); });
}

module.exports = { runSmoke, signBody, formatTable, STEPS, DEFAULT_WAITS };
