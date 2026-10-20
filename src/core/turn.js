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
const intake = require('../leads/intake');
const { OUT_OF_SCOPE_RE } = require('./policy');

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
        if (input.kind === 'mos_release') {
            session.setMode(s, 'lay', now); s.resumed_by = 'mos_release';
            const sent = await send({ ...input, replyToken: null }, [msg.text(quiet.strings.back)], topics.nextQuickReplies(null, s.topics_covered), senders.lay, { allowReply: false });
            await persist(input, s, sent, { role: 'lay' });
            return done(sent, null);
        }

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
        if (text) s.last_customer_text = text;
        await deps.store.messages.append({ user_id: s.user_id, role: 'customer', kind: input.kind, text: text || data, created_at: now.toISOString(), payload: input.kind === 'postback' ? { data } : null });

        // 4a. Human Mode (Mos took the chat): Lay never answers; every customer message goes to the lead thread. Only Mos
        // releases it (▶️Lay / /lay / @บอท resume), so the customer's own "เรียก Lay" is relayed too.
        if (s.mode === 'human') {
            if (s.discord_thread_id) deps.notifier.relayToMos({ threadId: s.discord_thread_id, text: text || data }).catch(() => {});
            await deps.store.sessions.save(s); return done([], null, { silent: true });
        }
        // 4. เรียก Lay — from any mode
        if (quiet.isCallLay(input)) {
            // Inside a demo the demo module exits itself (it needs mode === 'demo' to write the exit line + symptom card).
            if (s.mode === 'demo') {
                const demo = deps.flows?.demo || lazy('../flows/demo');
                if (demo?.onModelAction) { const r = await demo.onModelAction({ action: 'demo_exit', response: null, input, session: s, deps, config, send, persist, done, senders, doHandoff }); if (r && typeof r === 'object') r.action = 'demo_exit'; return r; }
                if (demo?.exitDemo) demo.exitDemo(s, now); else { s.demo_shop = null; s.demo_state = null; }
            }
            const was = quiet.callLay(s, now);
            const qr = topics.nextQuickReplies(null, s.topics_covered);
            const sent = await send(input, [msg.text(quiet.strings.back)], qr, senders.lay);
            await persist(input, s, sent, { role: 'lay' });
            return done(sent, was === 'demo' ? 'demo_exit' : null);
        }

        // 5. mode gates
        if (s.mode === 'mos_active') {
            if (s.discord_thread_id) deps.notifier.relayToMos({ threadId: s.discord_thread_id, text: text || data }).catch(() => {});
            await deps.store.sessions.save(s); return done([], null, { silent: true });
        }
        if (s.mode === 'quiet') {
            if (s.discord_thread_id) deps.notifier.relayToMos({ threadId: s.discord_thread_id, text: text || data }).catch(() => {});
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

        // 6a. booking entry (the loose-ends / offer buttons) and typed answers inside a booking
        const endingsMod = deps.flows?.endings || lazy('../flows/endings');
        if (endingsMod && BOOK_ENTRY_RE.test(text) && (!s.booking_step || ['confirmed', 'declined', 'notify_failed'].includes(s.booking_step))) {
            return await endingsMod.onModelAction({ action: 'booking_start', response: null, input, session: s, deps, config, send, persist, done, senders, doHandoff, upsertLead });
        }
        if (input.kind === 'text' && s.booking_step && endingsMod?.onBookingText && !handoff.isAskHuman(text)) {
            const r = await endingsMod.onBookingText({ text, input, session: s, deps, config, send, persist, done, sender: senders.lay });
            if (r) return r;
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
            else if (data.startsWith('BOOK_') && endings?.onBookingPostback) { return await endings.onBookingPostback({ data, input, session: s, deps, config, send, persist, done, sender: senders.lay, doHandoff, upsertLead }); }
            else if (data.startsWith('DEMO_') && demo?.onDemoPostback) { return await demo.onDemoPostback({ data, input, session: s, deps, config, send, persist, done, senders }); }
            else if (data.startsWith('DETAIL_')) { return await detailsTurn(data.slice('DETAIL_'.length)); }
            // "อยากได้แบบนี้" on an example: that example's card, its offer and its next step — decided by code, no model
            // question from another card (head review 19 Oct).
            else if (data.startsWith('WANT_') && fit?.chooseSymptom) { const sym = fit.chooseSymptom(s, data.slice('WANT_'.length)); if (sym) return await detailsTurn(sym.card); }
            else if (data === 'MENU_EXAMPLES' || data === 'MENU_PORTFOLIO') { const demo = flows.demo || lazy('../flows/demo'); if (demo?.onDemoPostback) return await demo.onDemoPostback({ data: 'DEMO_EXAMPLES', input, session: s, deps, config, send, persist, done, senders }); }
            else if (data.startsWith('MENU_')) { const t = MENU_TO_TEXT[data]; if (t) { userText = t; intentHint = topics.topicFromText(t) || 'unknown'; } }
            else { userText = data; }
        }
        if (input.kind === 'text' && intentHint === 'proof' && !s.examples_shown && [...text.trim()].length <= 20) {
            const demo = flows.demo || lazy('../flows/demo');
            if (demo?.onDemoPostback) { s.examples_shown = true; session.unionTopics(s, ['proof']); return await demo.onDemoPostback({ data: 'DEMO_EXAMPLES', input, session: s, deps, config, send, persist, done, senders }); }
        }
        // 8a. out of scope (head review 19 Oct): trading bots, strategies, indicators and backtests are not services.
        // Say so plainly, name the real services once, close politely; the lead becomes not_fit unless a card was matched.
        // 8a0. a swear word: one calm line by code, no button, no sale, no question (D-26; the real model drifted into package
        // details after a detail card, replay 20 Oct)
        if (input.kind === 'text' && PROFANITY_RE.test(text)) return await plainTurn([PROFANITY_LINE], { intent: 'abuse', topics: ['banter'], lead: false });
        if (input.kind === 'text' && OUT_OF_SCOPE_RE.test(text)) return await outOfScopeTurn();
        // 8a''. not started yet (head review 20 Oct, pre-launch burger): no system and no paid card is needed yet; say when we
        // would help and invite them back. The lead becomes nurture.
        if (input.kind === 'text' && TOO_EARLY_RE.test(text) && !s.draft?.confirmed) return await tooEarlyTurn();
        // 8a'''. marketing work itself (content, clips, ads, page management, branding) is not ours: say so, one free tip, no card
        if (input.kind === 'text' && MARKETING_RE.test(text) && !IN_SCOPE_HINT_RE.test(text)) return await marketingTurn();
        // ...and while they have not started, telling us about the team or plans gets the same short line (the model kept
        // praising and asking screening questions, replay 20 Oct); a named problem or one of the main questions still goes on
        if (input.kind === 'text' && s.too_early && !s.draft?.confirmed && !topics.topicFromText(text) && !handoff.isAskHuman(text)) {
            const fitMod = flows.fit || lazy('../flows/fit');
            if (!fitMod?.symptomFromText?.(text)) return await tooEarlyTurn();
        }
        // 8a'. a plain price question before any card is matched: the approved FAQ answer word for word (4,900 → 49,000)
        if (input.kind === 'text' && intentHint === 'pricing' && !s.draft?.card && [...text.trim()].length <= 30 && !/ค่าดูแล|รายเดือน|ลด|โปร|งบ/u.test(text)) {
            const r = await priceRangeTurn();
            if (r) return r;
        }
        // 8b. "ขอดีเทล / แจกแจง / ได้อะไรบ้าง" is answered by code with real deliverables from the pack (replay 18 Oct:
        // the model kept answering with a summary of the four services and asking back). A plain "explain more" right
        // after a specific answer still goes to the model, anchored on that answer.
        if (input.kind === 'text' && (DETAIL_RE.test(text) || (isTellMeMore(text) && !(s.last_kb_refs || []).length))) {
            return await detailsTurn(s.draft?.card || null);
        }
        if (isTellMeMore(text) && s.last_kb_refs?.length) intentHint = 'tell_me_more';

        if (input.kind === 'text' && !s.draft?.confirmed) { const fitMod = flows.fit || lazy('../flows/fit'); const k = fitMod?.symptomFromText?.(text); if (k) fitMod.chooseSymptom(s, k); }
        // 8c. "เหมาะกับงานผมไหม" before the customer named a problem: ask which work takes the most time with the symptom
        // chooser, never a guess from the business name (head correction 19 Oct, Oat: "ขายและให้บริการพื้นที่")
        if ((input.kind === 'text' || data === 'MENU_FIT') && intentHint === 'fit' && !s.draft?.confirmed && [...String(userText || '').trim()].length <= 30) {
            const r = await fitChooserTurn();
            if (r) return r;
        }
        // 9. the model
        const response = await askModel({ s, userText, intentHint, now, config, deps, errors });

        // 10. state from the response
        session.unionTopics(s, response.topics);
        const changed = session.mergeLeadUpdates(s, response.lead_updates);
        if (s.draft?.symptom && !s.draft.card) { const fitMod = flows.fit || lazy('../flows/fit'); const c = fitMod?.cardForSymptom?.(s.draft.symptom); if (c) s.draft.card = c; }
        // the customer's own words name a symptom → confirmed (an offer card may follow); a model guess alone is not
        if (input.kind === 'text' && !s.draft?.confirmed) { const fitMod = flows.fit || lazy('../flows/fit'); const k = fitMod?.symptomFromText?.(text); if (k) fitMod.chooseSymptom(s, k); }
        if (s.draft?.card && !s.draft.tier) s.draft.tier = 'T1';
        try { endingsMod?.decorateResponse?.({ response, session: s, deps }); } catch (e) { deps.log.warn('endings.decorate_failed', { error: e?.message }); }
        fixA1Offer(response, s, deps, endingsMod);
        dropUnfitOffers(response, s, endingsMod);
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
            if (handler) return await handler({ action: response.action, response, input, session: s, deps, config, send, persist, done, senders, doHandoff, upsertLead });
            action = response.action; // module not merged yet: keep the words, record the intent
        }

        // 12. render + quick replies
        const lastTopic = (response.topics || []).find((t) => topics.TOPIC_LABELS[t]) || null;
        let qr = override?.quickReplies || (response.quick_replies || []).filter((q) => !topicCovered(q, s));
        if (!qr.length && response.intent !== 'banter' && response.intent !== 'abuse' && response.intent !== 'closing') qr = topics.nextQuickReplies(lastTopic, s.topics_covered);
        const messages = renderMessages(response, { deps, config, session: s });
        const sent = await send(input, messages, qr, sender);
        s.questions_asked = (s.questions_asked || 0) + countQuestions(response);
        { const q = (response.messages || []).filter((m) => m.type === 'text' && QUESTION_RE.test(String(m.text || '').trim())).pop(); if (q) s.last_lay_question = q.text; }
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

    // Package details, owned by code (18 Oct): no card yet → a choice of five kinds of work; a card → its T1 deliverables,
    // starting price and Fastwork button straight from the knowledge pack (endings.offerCard). No model call, no invention.
    async function outOfScopeTurn() {
        const again = !!s.out_of_scope;
        s.out_of_scope = true;
        if (!s.draft?.card) s.not_fit = true;
        const lines = again ? [OOS_AGAIN] : [OOS_LINES.join('\n')]; // one message per turn
        const response = emptyResponse({ intent: 'capability', topics: ['capability'], messages: lines.map((text) => ({ type: 'text', text, explain: false, template: null, alt: null, data: null })) });
        session.unionTopics(s, response.topics);
        const sent = await send(input, renderMessages(response, { deps, config, session: s }), [], senders.lay);
        await persist(input, s, sent, { role: 'lay', response });
        try { await upsertLead(s, {}); } catch (e) { deps.log.warn('lead.upsert_failed', { error: e?.message }); }
        return done(sent, null);
    }

    async function plainTurn(lines, { intent = 'capability', topics: tps = ['capability'], lead = true } = {}) {
        const response = emptyResponse({ intent, topics: tps, messages: [{ type: 'text', text: lines.join('\n'), explain: false, template: null, alt: null, data: null }] });
        session.unionTopics(s, response.topics);
        const sent = await send(input, renderMessages(response, { deps, config, session: s }), [], senders.lay);
        await persist(input, s, sent, { role: 'lay', response });
        if (lead) { try { await upsertLead(s, {}); } catch (e) { deps.log.warn('lead.upsert_failed', { error: e?.message }); } }
        return done(sent, null);
    }

    async function tooEarlyTurn() {
        const n = s.too_early_replies || 0;
        s.too_early = true;
        s.too_early_replies = n + 1;
        return plainTurn(n === 0 ? TOO_EARLY_LINES : [n === 1 ? TOO_EARLY_AGAIN : TOO_EARLY_LAST]);
    }

    async function marketingTurn() {
        const again = !!s.marketing_asked;
        s.marketing_asked = true;
        s.out_of_scope = true;
        if (!s.draft?.card) s.not_fit = true;
        return plainTurn(again ? [MARKETING_AGAIN] : MARKETING_LINES);
    }

    async function fitChooserTurn() {
        const fitMod = deps.flows?.fit || lazy('../flows/fit');
        if (!fitMod?.fitChoiceCard) return null;
        const card = fitMod.fitChoiceCard();
        const response = emptyResponse({ intent: 'fit', topics: ['fit'], messages: [
            { type: 'text', text: FIT_ASK, explain: false, template: null, alt: null, data: null },
            { type: 'card', text: null, explain: false, template: card.template, alt: card.alt, data: card.data },
        ] });
        session.unionTopics(s, response.topics);
        const sent = await send(input, renderMessages(response, { deps, config, session: s }), [], senders.lay);
        await persist(input, s, sent, { role: 'lay', response });
        return done(sent, null);
    }

    async function priceRangeTurn() {
        const raw = sectionBody(deps.pack, 'faq.price-range');
        if (!raw) return null;
        const q = raw.search(/ตอนนี้[^\n]*ครับ\s*$/u);
        const parts = q > 0 ? [`${raw.slice(0, q).trim()}\n${raw.slice(q).trim()}`] : [raw]; // one message, the question on its own line
        s.last_kb_refs = ['faq.price-range']; // "อธิบายเพิ่ม" right after expands this answer
        const response = emptyResponse({ intent: 'pricing', topics: ['pricing'], kb_refs: ['faq.price-range'], messages: parts.map((text) => ({ type: 'text', text, explain: false, template: null, alt: null, data: null })) });
        session.unionTopics(s, response.topics);
        const sent = await send(input, renderMessages(response, { deps, config, session: s }), topics.nextQuickReplies('pricing', s.topics_covered), senders.lay);
        await persist(input, s, sent, { role: 'lay', response });
        return done(sent, null);
    }

    async function detailsTurn(cardId) {
        const endings = deps.flows?.endings || lazy('../flows/endings');
        const card = DETAIL_CHOICES.find((c) => c.card === cardId) ? cardId : null;
        let response;
        if (!card || !endings?.offerCard) {
            response = emptyResponse({
                intent: 'capability', topics: ['capability'],
                messages: [
                    { type: 'text', text: 'ได้ครับ เลือกงานที่อยากดูรายละเอียด ผมแจกแจงให้ว่าได้อะไรบ้าง', explain: false, template: null, alt: null, data: null },
                    { type: 'card', text: null, explain: false, template: 'choice', alt: 'เลือกงานที่อยากดูรายละเอียด', data: { title: 'อยากดูรายละเอียดงานไหน', options: DETAIL_CHOICES.map((c) => ({ label: c.label, postback: `DETAIL_${c.card}` })) } },
                ],
            });
        } else {
            s.draft = { ...(s.draft || {}), card, tier: s.draft?.tier || 'T1', confirmed: true };
            const offer = endings.offerCard({ ...s, draft: { ...s.draft, tier: 'T1' } }, { deps });
            response = emptyResponse({
                intent: 'capability', topics: ['capability', 'pricing'],
                messages: [
                    { type: 'text', text: `แพ็กเริ่มต้นของงาน${DETAIL_CHOICES.find((c) => c.card === card).label}ได้ตามนี้ครับ`, explain: false, template: null, alt: null, data: null },
                    { type: 'card', text: null, explain: false, template: offer.template, alt: offer.alt, data: offer.data },
                ],
            });
            s.offer_shown = true;
        }
        session.unionTopics(s, response.topics);
        const messages = renderMessages(response, { deps, config, session: s });
        const sent = await send(input, messages, response.quick_replies?.length ? response.quick_replies : topics.nextQuickReplies('capability', s.topics_covered), senders.lay);
        await persist(input, s, sent, { role: 'lay', response });
        return done(sent, null);
    }

    async function doHandoff(kind, inp, sess, { question }) {
        const lead = await upsertLead(sess, { reason: kind });
        const r = await handoff.performHandoff({ kind, session: sess, lead, question, draft: sess.draft, deps, config, now });
        const sent = await send(inp, [msg.text(r.text)], r.quickReplies || topics.nextQuickReplies(null, sess.topics_covered), senders.lay);
        await persist(inp, sess, sent, { role: 'lay' });
        return done(sent, r.action);
    }

    async function relayFromMos(inp, sess) {
        // A message Mos typed in the Discord thread: push as "มอส", mark mos_active (Human Mode stays human).
        if (sess.mode !== 'human') session.setMode(sess, 'mos_active', now);
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
        const history = (await d.store.messages.recent(sess.user_id, 12)).filter((m) => m.role !== 'system' && (!sess.context_since || !m.created_at || m.created_at >= sess.context_since)).map((m) => ({ role: m.role, text: m.text }));
        const kbSelection = selectSections(pack, { intentHint, draft: sess.draft, previousRefs: intentHint === 'tell_me_more' ? sess.last_kb_refs : [] });
        const system = prompt?.buildSystemPrompt
            ? prompt.buildSystemPrompt({ pack, session: sess, intentHint, kbSelection, now: at, config: cfg })
            : `คุณคือ Lay ผู้ช่วย AI ของมอส (LazyHardWork) ตอบสั้น สุภาพ ครับ ตอบเป็น JSON ตาม schema`;
        const messages = prompt?.buildMessages ? prompt.buildMessages({ systemPrompt: system, history, userText }) : [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role === 'customer' ? 'user' : 'assistant', content: h.text })), { role: 'user', content: userText }];
        const { responseSchema } = require('../brain/schema');
        const degraded = d.degraded || lazy('./degraded');

        const attempt = async (extraNote) => {
            // no hammering: while every key is exhausted the provider is not called at all (keys are re-checked at their reset time)
            if (d.keyring?.status?.().exhausted) throw Object.assign(new Error('llm keys exhausted (call skipped)'), { kind: 'exhausted', skipped: true });
            const req = { system, messages: extraNote ? [...messages, { role: 'system', content: extraNote }] : messages, schema: responseSchema, meta: { user_id: sess.user_id, agent: 'lay' } };
            const raw = await d.model.respond(req);
            const v = validateResponse(raw);
            if (!v.ok) throw Object.assign(new Error(`model output invalid: ${v.errors.join('; ')}`), { kind: 'invalid_output' });
            return raw;
        };

        let response;
        try {
            response = await attempt();
            // The model proposes, code disposes: a human handoff only when the customer asked for a person (brief §3.9).
            // Profanity or banter is answered with one calm line, never a handoff (brief §3.2; replay 18 Oct step 12).
            if (response && response.action === 'handoff_human' && response.intent !== 'ask_human' && !handoff.isAskHuman(userText)) {
                d.log.info('model.handoff_ignored', { intent: response.intent });
                response = { ...response, action: null };
            }
            // A scope handoff only for special price / discount / firm quote; "not what we do" is an honest no in words
            // (brief §2 row "อยากได้คนขาย"; replay 18 Oct on gpt-4.1-mini silenced Lay for the rest of the chat).
            // Allowed: special price / discount / firm quote, and help applying for a subsidy (brief §5.7).
            const HELP_APPLY_RE = /ช่วย\s*(?:ยื่น|สมัคร|ทำเรื่อง|กรอก)|ยื่นขอ|ทำเรื่องขอ/u;
            if (response && response.action === 'handoff_scope' && !['special_price', 'benefits'].includes(response.intent) && !handoff.isSpecialPrice(userText) && !HELP_APPLY_RE.test(userText || '') && !handoff.isAskHuman(userText)) {
                d.log.info('model.handoff_ignored', { intent: response.intent, action: 'handoff_scope' });
                response = { ...response, action: null };
            }
            if (policy?.applyPolicy) {
                let p = policy.applyPolicy(response, { session: sess, pack, allow: new Set(), userText });
                if (p.severity === 'regenerate') {
                    d.log.warn('policy.regenerate', { violations: p.violations.map((v) => v.rule || v).join(',') });
                    response = await attempt(`คำตอบก่อนหน้าละเมิดกฎ: ${p.violations.map((v) => v.rule || v).join(', ')} — ตอบใหม่โดยไม่ละเมิด ถ้ายาวหรือเป็นรายการ ให้แบ่งเป็น 2 ข้อความสั้น หรือใช้การ์ด steps/info แทนรายการ`);
                    p = policy.applyPolicy(response, { session: sess, pack, allow: new Set(), userText });
                    if ((p.severity === 'regenerate' || p.severity === 'fallback') && policy.salvage && policy.isStyleOnly(p.violations)) {
                        // style-only twice: repair by code (split, unlist) instead of claiming a system error (honesty)
                        const salvaged = policy.applyPolicy(policy.salvage(p.response || response), { session: sess, pack, allow: new Set(), userText });
                        if (salvaged.severity !== 'fallback' && !salvaged.violations.some((v) => String(v.rule).startsWith('banned:'))) {
                            d.log.warn('policy.salvaged', { violations: p.violations.map((v) => v.rule || v).join(',') });
                            await d.store.events.append({ kind: 'policy_salvaged', user_id: sess.user_id, payload: { violations: p.violations.map((v) => v.rule) }, created_at: at.toISOString() });
                            p = { ...salvaged, severity: 'fix' };
                        }
                    }
                    if (p.severity === 'regenerate' || p.severity === 'fallback') throw Object.assign(new Error(`policy: ${p.violations.map((v) => v.rule || v).join(', ')}`), { kind: 'policy' });
                } else if (p.severity === 'fallback') {
                    throw Object.assign(new Error(`policy: ${p.violations.map((v) => v.rule || v).join(', ')}`), { kind: 'policy' });
                }
                response = p.response;
                if (p.violations?.length) await d.store.events.append({ kind: 'policy_violation', user_id: sess.user_id, payload: { violations: p.violations, fixed: p.fixed }, created_at: at.toISOString() });
            } else {
                response = minimalPolicy(response);
            }
            return response;
        } catch (err) {
            if (err.kind === 'exhausted' && degraded?.degradedReply) return await degradedTurn(err);
            if (err.kind === 'policy') {
                // The model kept breaking a content rule (e.g. promising Mos without a handoff). Nothing is broken, so
                // the "ระบบขัดข้อง" line would be untrue: send a calm neutral line with the next questions instead.
                d.log.warn('model.policy_neutral', { userId: sess.user_id, error: err.message });
                await d.store.events.append({ kind: 'policy_neutral', user_id: sess.user_id, payload: { error: err.message }, created_at: at.toISOString() });
                return emptyResponse({ messages: [{ type: 'text', text: 'รับทราบครับ', explain: false, template: null, alt: null, data: null }], quick_replies: topics.nextQuickReplies(null, sess.topics_covered), intent: 'banter' });
            }
            errs.push(err);
            d.log.error('model.fallback', { userId: sess.user_id, kind: err.kind || 'error', error: err.message });
            await d.store.events.append({ kind: 'model_fallback', user_id: sess.user_id, payload: { error: err.message }, created_at: at.toISOString() });
            if (policy?.fallbackReply) return policy.fallbackReply({ reason: err.kind || 'error', config: cfg });
            return emptyResponse({ messages: [{ type: 'text', text: fallbackText(cfg), explain: false, template: null, alt: null, data: null }], quick_replies: [quiet.CALL_LAY_LABEL], intent: 'unknown' });
        }

        // Every OpenRouter key is out (doc/llm.md §5): (a) tell Mos in #crm (throttled inside alerts), (b) forward the
        // customer's question — notify before promise, (c) a schema-valid degraded reply. Lay stays in mode `lay`.
        // "เหมาะกับงานผมไหม" needs no model: the five-symptom choice card is rendered by code instead.
        async function degradedTurn(err) {
            errs.push(err);
            d.log.error('llm_exhausted_turn', { userId: sess.user_id, skipped: !!err.skipped, intent: intentHint, error: err.message });
            await d.store.events.append({ kind: 'llm_exhausted_turn', user_id: sess.user_id, payload: { error: err.message, skipped: !!err.skipped, intent: intentHint }, created_at: at.toISOString() });
            try { await d.alerts?.critical?.({ kind: 'llm_exhausted', detail: { task: 'lay.reply', skipped: !!err.skipped, error: String(err.message).slice(0, 200) } }); }
            catch (e) { d.log.warn('alerts.critical_failed', { error: e?.message }); }
            if (intentHint === 'fit' && !sess.draft?.symptom && degraded.degradedFitChoiceReply) return degraded.degradedFitChoiceReply({ config: cfg });
            try {
                const lead = await upsertLead(sess, { reason: 'llm_exhausted' });
                const res = await d.notifier.handoff({ kind: 'handoff_unknown', session: sess, lead, question: userText, draft: sess.draft });
                if (res?.threadId) sess.discord_thread_id = res.threadId;
            } catch (e) {
                d.log.error('llm_exhausted_notify_failed', { userId: sess.user_id, error: e?.message });
                await d.store.events.append({ kind: 'handoff_notify_failed', user_id: sess.user_id, payload: { kind: 'llm_exhausted', error: e?.message }, created_at: at.toISOString() });
                return degraded.degradedNotifyFailedReply({ config: cfg });
            }
            sess.last_unknown_question = userText;
            return degraded.degradedReply({ config: cfg });
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
        shortenMosIntro(messages, s);
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
        const row = intake.buildLeadRow({ session: sess, existing, now, status: extra.status || null });
        const saved = await deps.store.leads.upsert(row);
        const statusChanged = existing && existing.status !== saved.status;
        if (!existing || statusChanged) {
            const reason = extra.reason || (statusChanged ? 'status' : 'first_field');
            deps.notifier.lead({ lead: intake.redactForDiscord(saved), summary: intake.leadSummaryTh(saved, { reason }), leadId: saved.id, userId: sess.user_id, reason }).catch(() => {});
        }
        return saved;
    }
}

// ---------------------------------------------------------------------------------------------------------------
const MENU_TO_TEXT = { MENU_CAPABILITY: 'ทำอะไรได้บ้าง', MENU_FIT: 'เหมาะกับงานผมไหม', MENU_PRICING: 'ราคาเท่าไหร่', MENU_EXAMPLES: 'ขอดูตัวอย่าง', MENU_START: 'เริ่มยังไง', MENU_SERVICES: 'ทำอะไรได้บ้าง', MENU_PORTFOLIO: 'ขอดูตัวอย่าง' };
const BOOK_ENTRY_RE = /^\s*(?:นัดคุยกับมอส(?:ก่อน)?|นัดคุย|ขอนัดคุย|จองคิวคุย|นัดเวลาคุย)\s*$/u;
const GREETING_RE = /^\s*(?:สวัสดี(?:ครับ|ค่ะ|คับ)?|หวัดดี(?:ครับ|ค่ะ)?|hi|hello|ดีครับ|ดีค่ะ|ทักครับ|ทัก)\s*[!.]*\s*$/iu;
// An offer card for A1 at its door tier would show the AI Business Review under the A1 title: replace it with the
// code-built A1 card (A1 build package + "start with the review" note), whoever produced it (head review 19 Oct).
function fixA1Offer(response, s, deps, endingsMod) {
    if (!endingsMod?.offerCard) return;
    for (const m of response?.messages || []) {
        if (!m || m.type !== 'card' || m.template !== 'offer') continue;
        let d = m.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { continue; } }
        if (!d || d.card_id !== 'A1' || (d.tier || 'T1') !== 'T1') continue;
        const c = endingsMod.offerCard({ ...s, draft: { ...(s.draft || {}), card: 'A1', tier: 'T1' } }, { deps });
        if (c) { m.data = typeof m.data === 'string' ? JSON.stringify(c.data) : c.data; m.alt = c.alt; }
    }
}
// "มอส ผู้ออกแบบระบบของเรา" introduces Mos once per conversation; from the second mention on it is just "มอส"
// (Mos, 19 Oct: several FAQ answers in one chat would repeat the introduction). Runs on every message Lay sends.
const MOS_INTRO_RE = /มอส\s*ผู้ออกแบบระบบของเรา/gu;
function shortenMosIntro(messages, sess) {
    let introduced = !!(sess && sess.mos_introduced);
    for (const m of messages || []) {
        if (!m || m.type !== 'text' || typeof m.text !== 'string' || !MOS_INTRO_RE.test(m.text)) continue;
        MOS_INTRO_RE.lastIndex = 0;
        m.text = m.text.replace(MOS_INTRO_RE, (full) => { if (introduced) return 'มอส'; introduced = true; return full; });
    }
    MOS_INTRO_RE.lastIndex = 0;
    if (introduced && sess) sess.mos_introduced = true;
    return messages;
}
const PROFANITY_RE = /เหี้ย|เชี่ย|สัส|ควย|\bfuck|\bshit/iu;
const PROFANITY_LINE = 'ขอโทษครับ ถ้าที่ผมตอบไม่ตรงใจ ผมรอฟังก่อนนะครับ';
const TOO_EARLY_RE = /กำลังจะ(?:เริ่ม|เปิด)|ยังไม่(?:ได้)?(?:เริ่ม|เปิด)|เพิ่งคิด(?:จะ)?|วางแผน(?:จะ)?(?:เปิด|เริ่ม)|ยังไม่มีลูกค้า|ยังไม่ได้ขาย|pre-?launch/iu;
const TOO_EARLY_LINES = [
    'ช่วงที่ยังไม่ได้เริ่มขาย ยังไม่ต้องใช้ระบบหรือจ้างเราครับ ตั้งใจกับสินค้าและลูกค้ากลุ่มแรกก่อนคุ้มกว่า',
    'เราช่วยได้ตอนที่เริ่มขายแล้วและงานเริ่มล้น เช่น ออเดอร์หรือแชทเข้าจนตอบไม่ทัน ถึงตอนนั้นทักกลับมาได้เลยครับ',
];
const TOO_EARLY_LAST = 'รับทราบครับ ไว้เริ่มขายแล้วทักมาได้เลยครับ';
const TOO_EARLY_AGAIN = 'ตอนนี้ยังไม่ต้องเริ่มอะไรกับเราครับ พอเริ่มขายแล้วออเดอร์หรือแชทเริ่มล้น ทักกลับมาได้เลยครับ';
const MARKETING_RE = /การตลาด|มาร์เก็ตติ้ง|marketing|คอนเทนต์|content|ทำคลิป|ตัดต่อคลิป|ยิงแอด|ยิงโฆษณา|ทำโฆษณา|ดูแลเพจ|แอดมินเพจ|โซเชียลมีเดีย|social\s*media|สร้างแบรนด์|ทำแบรนด์|branding|ออกแบบโลโก้/iu;
const IN_SCOPE_HINT_RE = /แชท|ตอบลูกค้า|ออเดอร์|ข้อมูล|คีย์|ซ้ำ|เอกสาร|สต็อก|ตาราง|ระบบ|ใบเสนอราคา|นัด/u;
const MARKETING_LINES = [
    'งานการตลาด เช่น ทำคอนเทนต์ ทำคลิป ยิงโฆษณา ดูแลเพจ หรือสร้างแบรนด์ ไม่ใช่งานที่ LazyHardWork รับครับ',
    'เคล็ดลับเล็กๆ ช่วงเริ่ม เลือกช่องทางเดียวที่ลูกค้าอยู่มากที่สุดแล้วโพสต์ให้สม่ำเสมอก่อน ดีกว่ากระจายหลายช่องทางพร้อมกัน',
    'ส่วนที่เราช่วยได้คืองานหลังบ้าน เช่น พอแชทหรือออเดอร์เริ่มล้นจนตอบไม่ทัน ทักมาได้เลยครับ',
];
const MARKETING_AGAIN = 'เรื่องการตลาดยังไม่ใช่งานที่เรารับครับ ถ้ามีงานหลังบ้าน เช่น แชทหรือออเดอร์ล้น ทักมาได้เลยครับ';
const FIT_ASK = 'บอกได้ตรงขึ้นถ้ารู้ว่างานไหนกินเวลามากที่สุดครับ เลือกข้อที่ใกล้ที่สุด หรือพิมพ์เล่าสั้นๆ ก็ได้';
// no paid card for a lead that is not ready (too early) or asked for something we do not do; C1 only when it fits
function dropUnfitOffers(response, s, endingsMod) {
    if (!response || !Array.isArray(response.messages)) return;
    const unfit = (m) => {
        if (!m || m.type !== 'card' || m.template !== 'offer') return false;
        if (s.too_early || s.not_fit) return true;
        let d = m.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return false; } }
        return !!(d && d.card_id === 'C1' && endingsMod?.c1Fits && !endingsMod.c1Fits(s));
    };
    if (response.messages.some(unfit)) response.messages = response.messages.filter((m) => !unfit(m));
    if (!response.messages.length) response.messages = [{ type: 'text', text: 'รับทราบครับ', explain: false, template: null, alt: null, data: null }];
}
const OOS_LINES = [
    'เรื่องบอทเทรด กลยุทธ์ อินดิเคเตอร์ หรือ backtest ไม่ใช่งานที่ LazyHardWork รับครับ บอกตรงๆ จะได้ไม่เสียเวลาพี่',
    'งานที่เราทำคือระบบหลังบ้านของธุรกิจ เช่น แชทบอทตอบลูกค้า ระบบงานภายใน หรือออโตเมชันงานซ้ำ ถ้าวันไหนมีงานแบบนี้ ทักมาได้เลยครับ',
];
const OOS_AGAIN = 'เรื่องนี้ยังไม่ใช่งานที่ LazyHardWork รับครับ ถ้ามีงานหลังบ้านของธุรกิจ เช่น ตอบแชทลูกค้าหรืองานคีย์ซ้ำ ทักมาได้เลยครับ';
// the answer line of a KB section: drops the heading, the **question** line and status comments
function sectionBody(pack, id) {
    const sec = pack && pack.sections;
    let v = null;
    if (sec instanceof Map) v = sec.get(id); else if (Array.isArray(sec)) v = sec.find((x) => x && x.id === id); else if (sec && typeof sec === 'object') v = sec[id];
    const text = v && (typeof v === 'string' ? v : (v.text || v.body || ''));
    if (!text) return null;
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('<!--') && !/^\*\*.*\*\*$/u.test(l));
    return lines.join(' ').trim() || null;
}
const DETAIL_RE = /ดีเทล|แจกแจง|ได้อะไรบ้าง|มีอะไรบ้างในแพ็ก|รายละเอียดแพ็ก|รายละเอียดงาน/u;
const DETAIL_CHOICES = [
    { card: 'A2', label: 'แชทบอทตอบลูกค้า' },
    { card: 'A1', label: 'ระบบงานภายใน' },
    { card: 'A3', label: 'ออโตเมชันงานซ้ำ' },
    { card: 'A4', label: 'ตั้งค่า AI ให้รู้จักงาน' },
    { card: 'C1', label: 'ดูว่าควรเริ่มตรงไหน' },
];
const TELL_ME_MORE_RE =/อธิบาย(?:เพิ่ม|ละเอียด|ต่อ)|ละเอียดกว่านี้|ขอรายละเอียด|เพิ่มเติมหน่อย|ยังไง(?:บ้าง)?ครับ?$|แล้ว(?:ไง|ยังไง)ต่อ|มีอะไรอีก|ดีเทล|detail/iu;
const QUESTION_RE = /(?:ไหม|มั้ย|หรือเปล่า|หรือยัง|อะไร(?:บ้าง)?|ยังไง|กี่\S*|ที่ไหน|เมื่อไหร่|ช่วงไหน|แบบไหน)\s*(?:ครับ|คะ)?\s*[?？]?\s*$/u;

function isGreeting(text) { return GREETING_RE.test(text || ''); }
function isTellMeMore(text) { return TELL_ME_MORE_RE.test(text || ''); }
function countQuestions(response) { return (response.messages || []).filter((m) => m.type === 'text' && QUESTION_RE.test((m.text || '').trim())).length; }
function topicCovered(label, s) { const t = topics.LABEL_TO_TOPIC[label]; return t ? (s.topics_covered || []).includes(t) : false; }
function markTemplate(m, template) { Object.defineProperty(m, '_template', { value: template, enumerable: false }); if (m.contents) Object.defineProperty(m.contents, '_template', { value: template, enumerable: false }); }
function cardContext(pack, config) {
    if (pack?.cardContext) return pack.cardContext;
    const ladder = pack?.ladders || {};
    return {
        assets: pack?.assets || {},
        fastworkUrlFor: (cardId) => pack?.fastworkUrls?.[cardId] || config.contact.fastworkUrl || null,   // no invented handle (D-19)
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
        if (input.chatType !== 'user') { deps.log.info('event.ignored_chat', { chatType: input.chatType, chatId: input.chatId, userId: input.userId, kind: input.kind }); return; }
        if (input.webhookEventId) {
            if (seen.has(input.webhookEventId)) return;
            seen.set(input.webhookEventId, Date.now());
            if (seen.size > 2000) { const k = seen.keys().next().value; seen.delete(k); }
        }
        if (input.kind === 'text') { deps.line.showLoading(input.userId).catch(() => {}); debouncer.push(input); return; }
        runTurn(input, deps, opts).catch((e) => deps.log.error('turn.unhandled', { error: e?.message }));
    };
}

const INPUT_KINDS = ['text', 'postback', 'media', 'follow', 'unfollow', 'mos_relay', 'mos_release'];
module.exports = { shortenMosIntro, cardContext, runTurn, createEventHandler, isGreeting, isTellMeMore, countQuestions, sanitizeInput, MENU_TO_TEXT, INPUT_KINDS };
