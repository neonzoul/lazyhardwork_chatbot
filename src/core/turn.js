// The turn pipeline (design §1.2). One try/catch around everything: the customer always gets a message.
//
//   runTurn(input, deps, opts) → { sent, action, session, errors }
//     input: { userId, kind: 'text'|'postback'|'media'|'follow'|'unfollow'|'mos_relay', text?, data?, mediaType?,
//              replyToken?, timestamp, displayName?, burstCount? }
//     deps: line, notifier, store, model, clock, log (+ optional pack, config, senders, cards, flows overrides)
//
// Modules this file leans on (merged from the module branches): brain/prompt, brain/kb, core/policy, cards/render.
// Each is required lazily so the pure parts of the pipeline work in tests before every branch has landed.

const { normalise } = require('../line/events');
const msg = require('../line/messages');
const { createDebouncer } = require('./debounce');
const session = require('./session');
const { createSenders } = require('../identity/sender');
const quiet = require('../identity/quiet');
const opening = require('../flows/opening');
const topics = require('../flows/topics');
const handoff = require('../flows/handoff');
const { selectSections } = require('../brain/select');
const { validateResponse, emptyResponse } = require('../brain/schema');
const lint = require('./lint');

const REPLY_TOKEN_MAX_AGE_MS = 20 * 1000;
const sanitizeInput = (text) => String(text || '')
    .replace(/\[SYSTEM[^\]]*\]/gi, '')
    .replace(/<system[\s\S]*?<\/system>/gi, '')
    .replace(/###\s*system\s*###[\s\S]*?###/gi, '')
    .replace(/IGNORE\s+(ALL\s+)?(PREVIOUS|PRIOR|ABOVE)\s+(INSTRUCTIONS?|RULES?|PROMPTS?)[^\n]*/gi, '')
    .trim();

function lazy(path) { try { return require(path); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(path.split('/').pop())) return null; throw e; } }

function defaultConfig() { return lazy('../config') || { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22 }, identity: { layName: 'Lay · ผู้ช่วย AI', mosName: 'มอส' }, quiet: { windowMinutes: 30, debounceMs: 6500 }, publicBaseUrl: '' }; }

function fallbackText(config) { return `ตอนนี้ระบบขัดข้องชั่วคราวครับ ถ้ารีบ โทร ${config.contact.phoneDisplay} ได้เลย`; }

// ---------------------------------------------------------------------------------------------------------------
async function runTurn(input, deps, opts = {}) {
    const config = opts.config || deps.config || defaultConfig();
    const now = deps.clock.now();
    const senders = deps.senders || createSenders(config);
    const errors = [];
    let s = null;
    let sender = senders.lay;

    // Everything below is inside one guard: any throw → honest fallback (never silent).
    try {
        s = await deps.store.sessions.getOrCreate(input.userId);
        if (!s.display_name) {
            s.display_name = input.displayName || (await deps.line.getProfile(input.userId).then((p) => p.displayName).catch(() => null));
        }
        const shops = deps.pack?.demoShops || {};
        sender = senders.forSession(s, shops);

        // 1. lazy quiet-window expiry
        const resumed = quiet.resumeIfIdle(s, now, { windowMinutes: config.quiet.windowMinutes });

        // 2. non-conversational events
        if (input.kind === 'unfollow') { s.unfollowed_at = now.toISOString(); await deps.store.sessions.save(s); return done([], null); }
        if (input.kind === 'mos_relay') return await relayFromMos(input, s);

        if (input.kind === 'follow' || (input.kind !== 'postback' && opening.needsOpening(s, input) && input.kind === 'text' && !topics.topicFromText(input.text) && !handoff.isAskHuman(input.text))) {
            // follow, or a first message that is a plain greeting → opening (a first message that already asks a
            // question is answered directly, with the opening line folded into the prompt)
            if (input.kind === 'follow' || isGreeting(input.text)) {
                s.opened = true;
                const o = opening.openingReply();
                const sent = await send(input, [msg.text(o.text)], o.quickReplies, senders.lay);
                await persist(input, s, sent, { role: 'lay' });
                return done(sent, null);
            }
        }
        s.opened = true;

        if (input.kind === 'media') {
            const r = opening.mediaReply(input.mediaType);
            const sent = await send(input, [msg.text(r.text)], s.mode === 'quiet' ? [quiet.CALL_LAY_LABEL] : r.quickReplies, sender);
            await persist(input, s, sent, { role: s.mode === 'demo' ? 'demo_shop' : 'lay' });
            return done(sent, null);
        }

        // 3. text / postback → a unified "utterance"
        const text = input.kind === 'text' ? sanitizeInput(input.text) : '';
        const data = input.kind === 'postback' ? String(input.data || '') : '';
        s.last_customer_at = now.toISOString();
        await deps.store.messages.append({ user_id: s.user_id, role: 'customer', kind: input.kind, text: text || data, created_at: now.toISOString(), payload: input.kind === 'postback' ? { data } : null });

        // 4. เรียก Lay — from any mode
        if (quiet.isCallLay(input)) {
            const was = quiet.callLay(s, now);
            if (was === 'demo') { s.demo_shop = null; }
            const qr = topics.nextQuickReplies(null, s.topics_covered);
            const sent = await send(input, [msg.text(quiet.strings.back)], qr, senders.lay);
            await persist(input, s, sent, { role: 'lay' });
            return done(sent, was === 'demo' ? 'demo_exit' : null);
        }

        // 5. mode gates
        if (s.mode === 'mos_active') { await deps.store.sessions.save(s); return done([], null, { silent: true }); }
        if (s.mode === 'quiet') {
            if (!s.quiet_acked) {
                s.quiet_acked = true;
                const sent = await send(input, [msg.text(quiet.strings.quietAck)], [quiet.CALL_LAY_LABEL], senders.lay);
                await persist(input, s, sent, { role: 'lay' });
                return done(sent, null);
            }
            await deps.store.sessions.save(s);
            return done([], null, { silent: true });
        }
        if (s.mode === 'demo') {
            const demo = deps.flows?.demo || lazy('../flows/demo');
            if (demo && demo.runDemoTurn) return await demo.runDemoTurn({ input, text, data, session: s, deps, config, send, persist, done, sender });
            // demo module not merged yet: fall through as Lay
        }

        // 6. explicit human request (any state) and discount asks
        if (handoff.isAskHuman(text) || data === 'MENU_HANDOFF' || data === 'ASK_HUMAN') {
            return await doHandoff('handoff_human', input, s, { question: text });
        }
        if (data === handoff.strings.forwardPostback || text === handoff.strings.unknownButtons[0]) {
            return await doHandoff('handoff_unknown', input, s, { question: s.last_unknown_question || text });
        }
        if (handoff.isSpecialPrice(text)) {
            return await doHandoff('handoff_scope', input, s, { question: text });
        }

        // 7. loose-ends check on a closing signal
        if (input.kind === 'text' && topics.shouldLooseEnds(s, text)) {
            s.loose_ends_fired = true;
            const r = topics.looseEndsReply(s.topics_covered);
            const sent = await send(input, [msg.text(r.text)], r.quickReplies, senders.lay);
            await persist(input, s, sent, { role: 'lay' });
            return done(sent, null);
        }

        // 8. deterministic postbacks that set state, then continue to the model for the words
        let intentHint = input.kind === 'text' ? (topics.topicFromText(text) || 'unknown') : 'unknown';
        let userText = text;
        const flows = deps.flows || {};
        if (data) {
            const fit = flows.fit || lazy('../flows/fit');
            const endings = flows.endings || lazy('../flows/endings');
            const demo = flows.demo || lazy('../flows/demo');
            if (data.startsWith('FIT_') && fit?.onSymptomPostback) { ({ intentHint, userText } = fit.onSymptomPostback(data, s)); }
            else if (data.startsWith('BOOK_') && endings?.onBookingPostback) { return await endings.onBookingPostback({ data, input, session: s, deps, config, send, persist, done, sender: senders.lay, doHandoff }); }
            else if (data.startsWith('DEMO_') && demo?.onDemoPostback) { return await demo.onDemoPostback({ data, input, session: s, deps, config, send, persist, done, senders }); }
            else if (data.startsWith('MENU_')) { const t = MENU_TO_TEXT[data]; if (t) { userText = t; intentHint = topics.topicFromText(t) || 'unknown'; } }
            else { userText = data; }
        }
        if (isTellMeMore(text) && s.last_kb_refs?.length) intentHint = 'tell_me_more';

        // 9. the model
        const response = await askModel({ s, userText, intentHint, now, config, deps, errors });

        // 10. state from the response
        session.unionTopics(s, response.topics);
        const changed = session.mergeLeadUpdates(s, response.lead_updates);
        s.last_kb_refs = response.kb_refs || [];
        s.last_intent = response.intent;
        if (response.intent === 'unknown' || response.intent === 'faq' && response.action === 'handoff_unknown') s.last_unknown_question = userText;

        // 11. actions proposed by the model, executed by code
        let action = null;
        let override = null;
        if (response.action === 'handoff_human') return await doHandoff('handoff_human', input, s, { question: userText });
        if (response.action === 'handoff_scope') return await doHandoff('handoff_scope', input, s, { question: userText });
        if (response.action === 'handoff_unknown') {
            // model says "ไม่รู้": log the gap and OFFER the button (never auto-forward)
            await deps.store.kbGaps.append({ user_id: s.user_id, question: userText, kb_refs_tried: response.kb_refs, forwarded: false, created_at: now.toISOString() });
            deps.notifier.kbGap({ question: userText, userId: s.user_id }).catch(() => {});
            s.last_unknown_question = userText;
            override = { quickReplies: [{ label: handoff.strings.unknownButtons[0], data: handoff.strings.forwardPostback }, handoff.strings.unknownButtons[1]] };
        }
        if (response.action === 'booking_start' || response.action === 'booking_confirm' || response.action === 'demo_enter' || response.action === 'demo_exit') {
            const endings = flows.endings || lazy('../flows/endings');
            const demo = flows.demo || lazy('../flows/demo');
            const handler = response.action.startsWith('booking') ? endings?.onModelAction : demo?.onModelAction;
            if (handler) return await handler({ action: response.action, response, input, session: s, deps, config, send, persist, done, senders, doHandoff });
            action = response.action; // module not merged yet: keep the words, record the intent
        }

        // 12. render + quick replies
        const lastTopic = (response.topics || []).find((t) => topics.TOPIC_LABELS[t]) || null;
        let qr = override?.quickReplies || (response.quick_replies || []).filter((q) => !topicCovered(q, s));
        if (!qr.length && response.intent !== 'banter' && response.intent !== 'abuse' && response.intent !== 'closing') qr = topics.nextQuickReplies(lastTopic, s.topics_covered);
        const messages = renderMessages(response, { deps, config, session: s });
        const sent = await send(input, messages, qr, sender);
        s.questions_asked = (s.questions_asked || 0) + countQuestions(response);
        if (changed.length) await upsertLead(s, { changed });
        await persist(input, s, sent, { role: s.mode === 'demo' ? 'demo_shop' : 'lay', response });
        return done(sent, action);
    } catch (err) {
        // never silent
        errors.push(err);
        (deps.log?.error || console.error)('turn.failed', { userId: input.userId, kind: input.kind, error: err?.message, stack: (err?.stack || '').split('\n').slice(0, 3).join(' | ') });
        try { await deps.store.events.append({ kind: 'error', user_id: input.userId, payload: { error: err?.message, input: input.kind }, created_at: now.toISOString() }); } catch { /* ignore */ }
        let sent = [];
        try { sent = await send(input, [msg.text(fallbackText(config))], [quiet.CALL_LAY_LABEL], sender, { allowReply: false }); } catch (e2) { errors.push(e2); }
        try { if (s) await deps.store.sessions.save(s); } catch { /* ignore */ }
        return { sent, action: null, session: s, errors };
    }

    // ---- helpers bound to this turn -------------------------------------------------------------------------
    function done(sent, action, extra = {}) { return { sent, action, session: s, errors, ...extra }; }

    async function doHandoff(kind, inp, sess, { question }) {
        const lead = await upsertLead(sess, { reason: kind });
        const r = await handoff.performHandoff({ kind, session: sess, lead, question, draft: sess.draft, deps, config, now });
        const sent = await send(inp, [msg.text(r.text)], r.quickReplies || topics.nextQuickReplies(null, sess.topics_covered), senders.lay);
        await persist(inp, sess, sent, { role: 'lay' });
        return done(sent, r.action);
    }

    async function relayFromMos(inp, sess) {
        // A message Mos typed in the Discord thread: push as "มอส", mark mos_active.
        session.setMode(sess, 'mos_active', now);
        sess.last_mos_at = now.toISOString();
        const sent = await send({ ...inp, replyToken: null }, [msg.text(inp.text)], [quiet.CALL_LAY_LABEL], senders.mos, { allowReply: false });
        await deps.store.messages.append({ user_id: sess.user_id, role: 'mos', kind: 'text', text: inp.text, sender_name: senders.mos.name, created_at: now.toISOString() });
        await deps.store.sessions.save(sess);
        return done(sent, null);
    }

    async function askModel({ s: sess, userText, intentHint, now: at, config: cfg, deps: d, errors: errs }) {
        const prompt = d.brain || lazy('../brain/prompt');
        const policy = d.policy || lazy('./policy');
        const pack = d.pack || null;
        const history = (await d.store.messages.recent(sess.user_id, 12)).filter((m) => m.role !== 'system').map((m) => ({ role: m.role, text: m.text }));
        const kbSelection = selectSections(pack, { intentHint, draft: sess.draft, previousRefs: intentHint === 'tell_me_more' ? sess.last_kb_refs : [] });
        const system = prompt?.buildSystemPrompt
            ? prompt.buildSystemPrompt({ pack, session: sess, intentHint, kbSelection, now: at, config: cfg })
            : `คุณคือ Lay ผู้ช่วย AI ของมอส (LazyHardWork) ตอบสั้น สุภาพ ครับ ตอบเป็น JSON ตาม schema`;
        const messages = prompt?.buildMessages ? prompt.buildMessages({ systemPrompt: system, history, userText }) : [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role === 'customer' ? 'user' : 'assistant', content: h.text })), { role: 'user', content: userText }];
        const { responseSchema } = require('../brain/schema');

        const attempt = async (extraNote) => {
            const req = { system, messages: extraNote ? [...messages, { role: 'system', content: extraNote }] : messages, schema: responseSchema };
            const raw = await d.model.respond(req);
            const v = validateResponse(raw);
            if (!v.ok) throw Object.assign(new Error(`model output invalid: ${v.errors.join('; ')}`), { kind: 'invalid_output' });
            return raw;
        };

        let response;
        try {
            response = await attempt();
            if (policy?.applyPolicy) {
                let p = policy.applyPolicy(response, { session: sess, pack, allow: new Set() });
                if (p.severity === 'regenerate') {
                    d.log.warn('policy.regenerate', { violations: p.violations });
                    response = await attempt(`คำตอบก่อนหน้าละเมิดกฎ: ${p.violations.join(', ')} — ตอบใหม่โดยไม่ละเมิด`);
                    p = policy.applyPolicy(response, { session: sess, pack, allow: new Set() });
                    if (p.severity === 'regenerate' || p.severity === 'fallback') throw Object.assign(new Error(`policy: ${p.violations.join(', ')}`), { kind: 'policy' });
                } else if (p.severity === 'fallback') {
                    throw Object.assign(new Error(`policy: ${p.violations.join(', ')}`), { kind: 'policy' });
                }
                response = p.response;
                if (p.violations?.length) await d.store.events.append({ kind: 'policy_violation', user_id: sess.user_id, payload: { violations: p.violations, fixed: p.fixed }, created_at: at.toISOString() });
            } else {
                response = minimalPolicy(response);
            }
            return response;
        } catch (err) {
            errs.push(err);
            d.log.error('model.fallback', { userId: sess.user_id, kind: err.kind || 'error', error: err.message });
            await d.store.events.append({ kind: 'model_fallback', user_id: sess.user_id, payload: { error: err.message }, created_at: at.toISOString() });
            if (policy?.fallbackReply) return policy.fallbackReply({ reason: err.kind || 'error', config: cfg });
            return emptyResponse({ messages: [{ type: 'text', text: fallbackText(cfg), explain: false, template: null, alt: null, data: null }], quick_replies: [quiet.CALL_LAY_LABEL], intent: 'unknown' });
        }
    }

    function renderMessages(response, { deps: d, config: cfg, session: sess }) {
        const cards = d.cards || lazy('../cards/render');
        const out = [];
        for (const m of response.messages) {
            if (m.type === 'text') { out.push(msg.text(lint.stripMarkdown(m.text))); continue; }
            if (m.type === 'card') {
                if (cards?.render) {
                    const ctx = cardContext(d.pack, cfg);
                    const r = cards.render({ template: m.template, alt: m.alt, data: m.data }, ctx);
                    if (r.message) { out.push(msg.flex(r.message)); markTemplate(out[out.length - 1], m.template); continue; }
                    if (r.fallback) { out.push(msg.text(r.fallback.text)); response.quick_replies = r.fallback.quick_replies || response.quick_replies; continue; }
                }
                // renderer not merged yet: keep the alt text so the customer still gets the content
                if (m.alt) out.push(msg.text(m.alt));
            }
        }
        if (!out.length) out.push(msg.text(fallbackText(cfg)));
        return out;
    }

    async function send(inp, messages, quickReplies, snd, { allowReply = true } = {}) {
        const list = msg.attachQuickReplies(messages.slice(0, 5), quickReplies || [], snd);
        const fresh = allowReply && inp.replyToken && (now.getTime() - (inp.timestamp || 0)) < REPLY_TOKEN_MAX_AGE_MS && !inp.replyTokenUsed;
        if (fresh) {
            try { await deps.line.reply(inp.replyToken, list); inp.replyTokenUsed = true; return [list]; }
            catch (err) { deps.log.warn('line.reply_failed', { error: err?.message }); }
        }
        try { await deps.line.push(inp.userId, list); return [list]; }
        catch (err) {
            deps.log.warn('line.push_failed', { error: err?.message });
            try { await deps.line.push(inp.userId, list); return [list]; }
            catch (err2) {
                deps.log.error('line.undelivered', { userId: inp.userId, error: err2?.message });
                await deps.store.events.append({ kind: 'undelivered', user_id: inp.userId, payload: { error: err2?.message, messages: list.map((m) => m.type) }, created_at: now.toISOString() }).catch(() => {});
                throw Object.assign(new Error('line undelivered'), { kind: 'undelivered', delivered: false });
            }
        }
    }

    async function persist(inp, sess, sent, { role, response } = {}) {
        for (const batch of sent) for (const m of batch) {
            await deps.store.messages.append({ user_id: sess.user_id, role, kind: m.type, text: m.type === 'text' ? m.text : m.altText || null, sender_name: m.sender?.name || null, payload: m.type === 'flex' ? { template: m._template || null } : null, created_at: now.toISOString() });
        }
        sess.last_bot_at = now.toISOString();
        await deps.store.sessions.save(sess);
    }

    async function upsertLead(sess, extra = {}) {
        const existing = await deps.store.leads.byUser(sess.user_id);
        const row = {
            ...(existing || {}),
            user_id: sess.user_id,
            status: existing?.status || 'new',
            card_id: sess.draft?.card || existing?.card_id || null,
            symptom: sess.draft?.symptom || existing?.symptom || null,
            homework: sess.homework || {},
            customer_words_th: sess.homework?.problem_verbatim || existing?.customer_words_th || null,
            source: 'line_oa',
            display_name: sess.display_name,
            updated_at: now.toISOString(),
            created_at: existing?.created_at || now.toISOString(),
        };
        const saved = await deps.store.leads.upsert(row);
        if (!existing) deps.notifier.lead({ lead: saved, session: sess, reason: extra.reason || 'first_field' }).catch(() => {});
        return saved;
    }
}

// ---------------------------------------------------------------------------------------------------------------
const MENU_TO_TEXT = { MENU_CAPABILITY: 'ทำอะไรได้บ้าง', MENU_FIT: 'เหมาะกับงานผมไหม', MENU_PRICING: 'ราคาเท่าไหร่', MENU_EXAMPLES: 'ขอดูตัวอย่าง', MENU_START: 'เริ่มยังไง', MENU_SERVICES: 'ทำอะไรได้บ้าง', MENU_PORTFOLIO: 'ขอดูตัวอย่าง' };
const GREETING_RE = /^\s*(?:สวัสดี(?:ครับ|ค่ะ|คับ)?|หวัดดี(?:ครับ|ค่ะ)?|hi|hello|ดีครับ|ดีค่ะ|ทักครับ|ทัก)\s*[!.]*\s*$/iu;
const TELL_ME_MORE_RE = /อธิบาย(?:เพิ่ม|ละเอียด|ต่อ)|ละเอียดกว่านี้|ขอรายละเอียด|เพิ่มเติมหน่อย|ยังไง(?:บ้าง)?ครับ?$|แล้ว(?:ไง|ยังไง)ต่อ|มีอะไรอีก|ดีเทล|detail/iu;
const QUESTION_RE = /(?:ไหม|มั้ย|หรือเปล่า|หรือยัง|อะไร(?:บ้าง)?|ยังไง|กี่\S*|ที่ไหน|เมื่อไหร่|ช่วงไหน|แบบไหน)\s*(?:ครับ|คะ)?\s*[?？]?\s*$/u;

function isGreeting(text) { return GREETING_RE.test(text || ''); }
function isTellMeMore(text) { return TELL_ME_MORE_RE.test(text || ''); }
function countQuestions(response) { return (response.messages || []).filter((m) => m.type === 'text' && QUESTION_RE.test((m.text || '').trim())).length; }
function topicCovered(label, s) { const t = topics.LABEL_TO_TOPIC[label]; return t ? (s.topics_covered || []).includes(t) : false; }
function markTemplate(m, template) { Object.defineProperty(m, '_template', { value: template, enumerable: false }); if (m.contents) Object.defineProperty(m.contents, '_template', { value: template, enumerable: false }); }
function cardContext(pack, config) {
    const ladder = pack?.ladders || {};
    return {
        assets: pack?.assets || {},
        fastworkUrlFor: (cardId) => pack?.fastworkUrls?.[cardId] || config.contact.fastworkUrl || 'https://fastwork.co/user/mos_lazyhardwork',
        priceFor: (cardId, tier) => { const p = ladder[cardId]?.tiers?.[tier]; return p ? { price_from: p, label_th: `ราคาเริ่มต้น ${p.toLocaleString('th-TH')} บาท` } : { price_from: null, label_th: 'ราคาเริ่มต้น ปรับตามขอบเขตจริงหลังคุย' }; },
    };
}
// Minimal policy when core/policy (T2) is not merged: strip markdown, cap quick replies, run lint (log only).
function minimalPolicy(response) {
    response.messages = response.messages.map((m) => (m.type === 'text' ? { ...m, text: lint.stripMarkdown(m.text).trim() } : m));
    response.quick_replies = (response.quick_replies || []).slice(0, 4);
    return response;
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook entry: normalise, dedupe redeliveries, debounce text, run the turn.
function createEventHandler(deps, opts = {}) {
    const config = opts.config || deps.config || defaultConfig();
    const seen = new Map(); // webhookEventId → ts (small LRU)
    const debouncer = createDebouncer({ ms: config.quiet.debounceMs, timers: opts.timers, onFlush: (merged) => runTurn(merged, deps, opts) });
    return function handleEvent(event) {
        const input = normalise(event);
        if (!input || !input.userId) return;
        if (input.chatType !== 'user') { deps.log.info('event.ignored_chat', { chatType: input.chatType }); return; }
        if (input.webhookEventId) {
            if (seen.has(input.webhookEventId)) return;
            seen.set(input.webhookEventId, Date.now());
            if (seen.size > 2000) { const k = seen.keys().next().value; seen.delete(k); }
        }
        if (input.kind === 'text') { deps.line.showLoading(input.userId).catch(() => {}); debouncer.push(input); return; }
        runTurn(input, deps, opts).catch((e) => deps.log.error('turn.unhandled', { error: e?.message }));
    };
}

module.exports = { runTurn, createEventHandler, isGreeting, isTellMeMore, countQuestions, sanitizeInput, MENU_TO_TEXT };
