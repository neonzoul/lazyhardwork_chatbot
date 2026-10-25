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
// Leading bullets / dashes / quotes and wrapping quotes come off every line before any matching (Mos's test 24 Oct:
// '- “ขอลองเป็นลูกค้าร้านตัวอย่างก่อนค่ะ”' missed the demo path and the model played the shop itself).
const LEAD_MARK_RE = /^[\s\-–—•·‣◦*>"“”'‘’«»「」『』]+/u;
const TRAIL_MARK_RE = /[\s"“”'‘’«»「」『』]+$/u;
const normaliseText = (text) => String(text || '').split('\n')
    .map((line) => line.replace(LEAD_MARK_RE, '').replace(TRAIL_MARK_RE, ''))
    .filter((line) => line.trim()).join('\n').trim();

function lazy(path) { try { return require(path); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(path.split('/').pop())) return null; throw e; } }

function defaultConfig() { return lazy('../config') || { contact: { phoneDisplay: '095 569 1674 (มอส)', hoursStart: 13, hoursEnd: 22 }, identity: { layName: 'Agent Lay · AI', mosName: 'มอส' }, quiet: { windowMinutes: 30, debounceMs: 6500 }, publicBaseUrl: '' }; }

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

        // 0a. bullets / dashes / quotes off before every matcher (opening, intent, demo path, model)
        if (input.kind === 'text' && typeof input.text === 'string') {
            const n = normaliseText(input.text);
            if (n && n !== input.text) input = { ...input, text: n };
        }
        // 0. a website CTA prefills "#demo-<id>" (Head GTM 23 Oct, Issue #2): the token never reaches the model, the opening
        // check or the transcript. First touch: the account's first message sets lead.source = web-demo-<id> (kept forever).
        // Last touch (v2.0.1, Head 24 Oct): ANY message with a token sets homework.last_touch = web-demo-<id>, so a returning
        // LINE friend who comes in from the website is counted too.
        let demoTag = null;
        if (input.kind === 'text' && DEMO_TAG_RE.test(input.text || '')) {
            demoTag = String(input.text).match(DEMO_TAG_RE)[1].toLowerCase();
            if (!s.last_customer_at) s.lead_source = `web-demo-${demoTag}`;
            s.homework = { ...(s.homework || {}), last_touch: `web-demo-${demoTag}`, last_touch_at: now.toISOString() };
            input = { ...input, text: String(input.text).replace(DEMO_TAG_RE, ' ').replace(/[ \t]{2,}/gu, ' ').trim() || 'สวัสดีครับ' };
        }

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
        // a returning friend's lead gets the last touch now (a new visitor's lead is created later, as before)
        if (demoTag) {
            try { if (await deps.store.leads.byUser(s.user_id)) await upsertLead(s); } catch (e) { deps.log.warn('lead.last_touch_failed', { error: e?.message }); }
        }
        // the sample-shop CTA: a text that names the shop ("ขอดูตัวอย่าง ร้านกาแฟ") enters that shop; otherwise the picker
        if (demoTag === 'a2-shop' && !['demo', 'human', 'mos_active', 'quiet'].includes(s.mode)) {   // never past the mode gates (CE review, PR #12)
            const demo = deps.flows?.demo || lazy('../flows/demo');
            if (demo?.onModelAction && demo.shopFromText?.(text)) return await demo.onModelAction({ action: 'demo_enter', response: null, input, session: s, deps, config, send, persist, done, senders });
            if (demo?.onDemoPostback) return await demo.onDemoPostback({ data: 'DEMO_PICK', input, session: s, deps, config, send, persist, done, senders });
        }
        // the visitor JUST came from that demo (v2.0.2, Head 24 Oct): when the message is only the website's prefill, code
        // acknowledges the demo and asks one question about their work. Never the demo link back; the free talk is offered.
        // A prefill with the visitor's own question added goes to the model, which knows the demo from the session line.
        if (demoTag && DEMO_FOLLOW_UP[demoTag] && (!s.mode || s.mode === 'lay') && WEB_PREFILL_RE.test(text) && [...text].length <= 60) {
            const sent = await send(input, [msg.text(DEMO_FOLLOW_UP[demoTag])], ['นัดคุยกับมอส', 'ราคาเท่าไหร่'], senders.lay);
            await persist(input, s, sent, { role: 'lay' });
            return done(sent, null);
        }

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
            // a time / availability question the day-time buttons do not answer ("ว่างกี่โมงบ้าง"): never the neutral line and
            // never a slot implied as confirmed — say Mos checks the queue, and hand off (Head GTM ruling, Mos's test 24 Oct)
            if (['window_day', 'window_time', 'window_day_text'].includes(s.booking_step) && BOOKING_TIME_ASK_RE.test(text)) {
                return await doHandoff('handoff_booking', input, s, { question: text });
            }
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
            else if (data === GEO_NOTE_PB || data === GEO_SKIP_PB) { return await geoNoteTurn(data === GEO_NOTE_PB); }
            else if (data === GEO_TALK_PB) { return await geoTalkTurn(); }
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
        // Too-early vs operating (Head GTM review 22 Oct, case B: an operating hotel got the pre-launch answer because the flag
        // from an earlier burger line stuck to the user):
        //  · both signals in one message → one clarifying question, set nothing until the answer
        //  · an operating signal alone → clear the too-early flag (the lead leaves nurture) and carry on to qualify
        //  · the answer to the clarifying question decides
        const tooEarlyNow = input.kind === 'text' && TOO_EARLY_RE.test(text);
        const operatingNow = input.kind === 'text' && OPERATING_RE.test(text);
        if (input.kind === 'text' && s.launch_question_open) {
            s.launch_question_open = false;
            if (LAUNCH_NO_RE.test(text)) return await tooEarlyTurn();
            if (LAUNCH_YES_RE.test(text)) { await clearTooEarly(); s.operating = true; }
        } else if (tooEarlyNow && operatingNow && !s.draft?.confirmed) {
            return await launchQuestionTurn();
        } else if (operatingNow) {
            if (s.too_early) await clearTooEarly();
            s.operating = true;
        }
        if (input.kind === 'text' && tooEarlyNow && !operatingNow && !s.operating && !s.draft?.confirmed) return await tooEarlyTurn();
        // 8a'''. marketing work itself (content, clips, ads, page management, branding) is not ours: say so, one free tip, no card
        // GEO / SEO interest (Head GTM 22 Oct, Mos's ruling): not a service yet but being prepared — honest "not open yet", one
        // DIY line, offer to note the interest. Checked before the marketing refusal; never not_fit.
        if (input.kind === 'text' && GEO_INTEREST_RE.test(text)) return await geoInterestTurn();
        if (input.kind === 'text' && (text.trim() === GEO_NOTE_LABEL || text.trim() === GEO_SKIP_LABEL) && s.geo_asked) return await geoNoteTurn(text.trim() === GEO_NOTE_LABEL);
        if (input.kind === 'text' && text.trim() === GEO_TALK_LABEL && s.geo_asked) return await geoTalkTurn();
        // a guarantee question gets a fixed honest line (Head GTM ruling R1, 23 Oct): the model's answer kept tripping the
        // banned-guarantee rule and ended in "รับทราบครับ"
        if (input.kind === 'text' && GUARANTEE_ASK_RE.test(text)) {
            const aboutBeingFound = s.geo_asked || GEO_INTEREST_RE.test(text) || /แนะนำ|ค้นเจอ|ติดอันดับ|ChatGPT|Google/iu.test(text);
            return await plainTurn([aboutBeingFound ? GUARANTEE_GEO : GUARANTEE_GENERAL], { intent: 'capability', topics: ['capability'], lead: false });
        }
        // "ต่างจากทำเองใน Claude Projects ยังไง" — A4's most common objection: the approved answer verbatim (faq.a4-vs-projects,
        // Head 24 Oct after Mos's test; the model's answer was generic)
        if (input.kind === 'text' && A4_VS_PROJECTS_RE.test(text) && A4_WHY_RE.test(text)) {
            const answer = faqAnswer(deps.pack, 'faq.a4-vs-projects');
            if (answer) {
                session.unionTopics(s, ['capability']);
                const sent = await send(input, [msg.text(answer)], ['ราคาเท่าไหร่', 'ใช้เวลานานไหม', 'เริ่มยังไง'], senders.lay);
                await persist(input, s, sent, { role: 'lay' });
                return done(sent, null);
            }
        }
        // right after the shop picker, a typed shop name ("คลินิกความงาม") enters that sample shop by code (Mos's test 24 Oct:
        // the model played the clinic itself and "confirmed" a booking)
        if (input.kind === 'text' && s.demo_pick_open && s.mode !== 'demo') {
            s.demo_pick_open = false;
            const demo = flows.demo || lazy('../flows/demo');
            if (demo?.onModelAction && demo.shopFromText?.(text) && [...text].length <= 40) return await demo.onModelAction({ action: 'demo_enter', response: null, input, session: s, deps, config, send, persist, done, senders });
        }
        // "ขอลองเป็นลูกค้าร้านตัวอย่าง" typed: the shop picker by code (the model wrote a two-item list with one line twice)
        if (input.kind === 'text' && DEMO_TRY_RE.test(text) && s.mode !== 'demo') {
            const demo = flows.demo || lazy('../flows/demo');
            if (demo?.onDemoPostback) return await demo.onDemoPostback({ data: 'DEMO_PICK', input, session: s, deps, config, send, persist, done, senders });
        }
        if (input.kind === 'text' && MARKETING_RE.test(text) && !IN_SCOPE_HINT_RE.test(text)) return await marketingTurn();
        // ...and while they have not started, telling us about the team or plans gets the same short line (the model kept
        // praising and asking screening questions, replay 20 Oct); a named problem or one of the main questions still goes on
        if (input.kind === 'text' && s.too_early && !operatingNow && !s.draft?.confirmed && !topics.topicFromText(text) && !handoff.isAskHuman(text)) {
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
        // Qualify an operating business with no named problem (Head GTM review 22 Oct): the model asks which work floods them
        // with 2–3 examples from their domain; code adds the symptom chooser. This is the SYMPTOM question, not a screening
        // question — prompt rule "คำถามคัดกรอง … ถามได้เฉพาะหลังลูกค้าบอกปัญหา" is not violated. Do not "fix" it backwards.
        const askedTopic = topics.topicFromText(text);
        if (operatingNow && (!askedTopic || askedTopic === 'fit') && !s.draft?.confirmed && !(response.messages || []).some((m) => m.type === 'card')) {
            const fitMod = flows.fit || lazy('../flows/fit');
            const card = fitMod?.fitChoiceCard?.();
            if (card) response.messages = [...(response.messages || []).filter((m) => m.type === 'text').slice(0, 1), { type: 'card', text: null, explain: false, template: card.template, alt: card.alt, data: card.data }];
        }
        dropUnfitOffers(response, s, endingsMod);
        // the model answered a GEO ask the regex missed (Head GTM ruling 22 Oct) and offered the note button: the tap then
        // records interest=geo exactly like the code branch
        if ((response.quick_replies || []).some((q) => (typeof q === 'string' ? q : q && q.label) === GEO_NOTE_LABEL)) s.geo_asked = true;
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

    async function geoInterestTurn() {
        const again = !!s.geo_asked;
        s.geo_asked = true;
        // keep the wording demand uses (Head GTM): the customer's own ask, only if no problem was recorded yet
        if (!s.homework?.problem_verbatim) s.homework = { ...(s.homework || {}), problem_verbatim: String(input.text || '').slice(0, 200) };
        const response = emptyResponse({ intent: 'out_of_scope', topics: ['capability'], messages: [{ type: 'text', text: (again ? [GEO_AGAIN] : GEO_LINES).join('\n'), explain: false, template: null, alt: null, data: null }] });
        session.unionTopics(s, response.topics);
        const sent = await send(input, renderMessages(response, { deps, config, session: s }), GEO_QUICK, senders.lay);
        await persist(input, s, sent, { role: 'lay', response });
        return done(sent, null);
    }

    // Either positive tap is the demand signal (Head GTM, D-39): interest=geo; status follows the normal ladder.
    async function geoNoteTurn(note) {
        if (note) {
            s.homework = { ...(s.homework || {}), interest: 'geo' };
            try { await upsertLead(s, { reason: 'status' }); } catch (e) { deps.log.warn('lead.upsert_failed', { error: e?.message }); }
        }
        return plainTurn([note ? GEO_NOTED : 'รับทราบครับ'], { intent: note ? 'pricing' : 'out_of_scope', topics: ['capability'], lead: false });
    }
    // "คุยฟรีก่อน": interest=geo, then the normal booking entry (the free 30-minute talk)
    async function geoTalkTurn() {
        s.homework = { ...(s.homework || {}), interest: 'geo' };
        const endingsMod = deps.flows?.endings || lazy('../flows/endings');
        if (endingsMod?.onModelAction) return await endingsMod.onModelAction({ action: 'booking_start', response: null, input, session: s, deps, config, send, persist, done, senders, doHandoff, upsertLead });
        return await geoNoteTurn(true);
    }

    async function clearTooEarly() {
        s.too_early = false;
        s.too_early_replies = 0;
        try { await upsertLead(s, {}); } catch (e) { deps.log.warn('lead.upsert_failed', { error: e?.message }); }
    }

    async function launchQuestionTurn() {
        s.launch_question_open = true;
        const response = emptyResponse({ intent: 'fit', topics: [], messages: [{ type: 'text', text: LAUNCH_QUESTION, explain: false, template: null, alt: null, data: null }] });
        const sent = await send(input, renderMessages(response, { deps, config, session: s }), LAUNCH_QUICK, senders.lay);
        await persist(input, s, sent, { role: 'lay', response });
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
            : `คุณคือ Agent Lay ผู้ช่วย AI ของ LazyHardWork ตอบสั้น สุภาพ ครับ ตอบเป็น JSON ตาม schema`;
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
            // A stated budget is not a handoff (Head GTM ruling 23 Oct, flower shop): only the customer's own words count.
            if (response && response.action === 'handoff_scope' && response.intent !== 'benefits' && !handoff.isSpecialPrice(userText) && !HELP_APPLY_RE.test(userText || '') && !handoff.isAskHuman(userText)) {
                d.log.info('model.handoff_ignored', { intent: response.intent, action: 'handoff_scope' });
                response = { ...response, action: null };
            }
            if (policy?.applyPolicy) {
                let p = policy.applyPolicy(response, { session: sess, pack, allow: policyAllow(sess), userText });
                if (p.severity === 'regenerate') {
                    d.log.warn('policy.regenerate', { violations: p.violations.map((v) => v.rule || v).join(',') });
                    response = await attempt(`คำตอบก่อนหน้าละเมิดกฎ: ${p.violations.map((v) => v.rule || v).join(', ')} — ตอบใหม่โดยไม่ละเมิด ถ้ายาวหรือเป็นรายการ ให้แบ่งเป็น 2 ข้อความสั้น หรือใช้การ์ด steps/info แทนรายการ`);
                    p = policy.applyPolicy(response, { session: sess, pack, allow: policyAllow(sess), userText });
                    if ((p.severity === 'regenerate' || p.severity === 'fallback') && policy.salvage && policy.isStyleOnly(p.violations)) {
                        // style-only twice: repair by code (split, unlist) instead of claiming a system error (honesty)
                        const salvaged = policy.applyPolicy(policy.salvage(p.response || response), { session: sess, pack, allow: policyAllow(sess), userText });
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
                // a reply that kept claiming a booking / order Lay never made: say plainly that nothing was booked
                if (/claimed_action/.test(err.message)) return emptyResponse({ messages: [{ type: 'text', text: CLAIM_SAFE_LINE, explain: false, template: null, alt: null, data: null }], quick_replies: ['ลองร้านตัวอย่าง', 'นัดคุยกับมอส'], intent: 'capability' });
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
// "running a business now" / "wants to use AI": a business already selling (not "จะ/เริ่ม/อยากทำธุรกิจ")
const OPERATING_RE = /(?<!(?:จะ|เริ่ม|อยาก)\s*)ทำ(?:ธุรกิจ|กิจการ|ร้าน|บริษัท|โรงแรม|รีสอร์ท)|เปิด(?:ร้าน|กิจการ|ขาย|บริการ|โรงแรม)?(?:มา|อยู่|แล้ว)|ขายอยู่|(?<!ไม่)มีลูกค้า|ลูกค้า(?:ทัก|ถาม|เยอะ|ประจำ)|ออเดอร์(?:เข้า|เยอะ)|อยาก(?:เอา|ใช้|ให้)\s*(?:AI|เอไอ)|(?:เอา|ใช้)\s*(?:AI|เอไอ)\s*(?:มา|ไป)?(?:ใช้|ช่วย)/iu;
const LAUNCH_QUESTION = 'ตอนนี้เปิดขายอยู่แล้วหรือยังครับ';
const LAUNCH_QUICK = ['เปิดขายอยู่แล้ว', 'ยังไม่เปิด'];
const LAUNCH_YES_RE = /เปิด(?:ขาย)?(?:อยู่)?แล้ว|ขายอยู่|เปิดอยู่|^\s*(?:ใช่|ครับ|ค่ะ|คะ|แล้ว)/u;
const LAUNCH_NO_RE = /ยังไม่|^\s*ยัง|กำลังจะ/u;
// Being found or recommended — on Google (SEO) or in AI answers (GEO). Not a service yet; interest is recorded on a tap.
const GEO_INTEREST_RE = /(?:ChatGPT|แชทจีพีที|Gemini|เจมิไน|Perplexity|Claude|\bAI\b|เอไอ|Google\s*AI|AI\s*Overview)[^\n]{0,20}(?:แนะนำ(?:ร้าน|ธุรกิจ|แบรนด์|เรา|ผม)|ค้นเจอ|พูดถึงร้าน|อ้างอิง)|(?:แนะนำ|รู้จัก)[^\n]{0,12}(?:ร้าน|ธุรกิจ|แบรนด์|เรา)[^\n]{0,12}(?:ใน|ผ่าน|บน)\s*(?:ChatGPT|AI|เอไอ)|(?:ChatGPT|แชทจีพีที|Gemini|\bAI\b|เอไอ)[^\n]{0,60}(?:มีชื่อ(?:ร้าน|ที่พัก|เรา|ผม)?|ชื่อ(?:ร้าน|ที่พัก)[^\n]{0,15})\s*ขึ้น(?:มา)?|\bGEO\b|AI\s*search|ติดอันดับ[^\n]{0,15}(?:ChatGPT|AI|เอไอ)|\bSEO\b|ติดหน้าแรก\s*Google|ติดอันดับ[^\n]{0,10}Google/iu;
const GEO_LINES = [
    'เรื่องให้ร้านถูกค้นเจอหรือถูกแนะนำ ทั้งบน Google และใน AI อย่าง ChatGPT — AI Business Review ฿4,900 ของเราตรวจเรื่องนี้ให้ได้ครับ: ข้อมูลร้านตรงกันทุกช่องทางไหม หน้าไหนตอบคำถามลูกค้าได้ อะไรทำเองได้ อะไรควรจ้าง และจะดูผลยังไง',
    'ระหว่างนี้ทำเองได้ครับ เขียนหน้าเว็บหรือโปรไฟล์ร้านให้ตอบคำถามที่ลูกค้ามักถามให้ชัด เช่น อยู่ที่ไหน ขายอะไร ราคาประมาณเท่าไหร่ เปิดกี่โมง เพราะ AI มักหยิบข้อมูลที่เขียนชัดและตรงคำถามไปใช้',
    'ไม่มีใครรับประกันได้ว่า AI จะแนะนำร้านไหนนะครับ เราก็ไม่รับประกัน และเราไม่รับทำเว็บเป็นบริการ ถ้าสนใจ Review ทักต่อได้เลย หรือคุยฟรี 30 นาทีก่อนก็ได้ครับ',
];
// A4 vs doing it yourself in Claude Projects (faq.a4-vs-projects): the message names the tool or A4 AND asks about the
// difference or doing it oneself (CE review 24 Oct: "ตั้งค่า LINE OA ทำเองได้ไหม" must not get this answer)
const A4_VS_PROJECTS_RE = /(?:Claude|ChatGPT|GPT|Gemini)\s*Projects?|โปรเจกต์(?:ของ)?\s*(?:Claude|ChatGPT)|\bProjects?\b|AI\s*Workspace|Workspace\s*Setup|\bA4\b/iu;
const A4_WHY_RE = /ต่าง(?:กัน|จาก|ตรง|ยังไง)|ทำไม|ดีกว่า|ทำเอง|อัปโหลด(?:ไฟล์)?เอง/u;
// a time / availability question during the booking that the buttons do not answer: time words, or a bare "ได้ไหม /
// ไม่สะดวก / ไม่ได้" right next to a day or time word (CE review 24 Oct: "ขอถามเรื่องราคาก่อนได้ไหม" is not one)
const BOOKING_DAYTIME = 'วันนี้|พรุ่งนี้|มะรืน|เช้า|บ่าย|เย็น|ค่ำ|เที่ยง|โมง|ทุ่ม|วัน(?:จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์)|สัปดาห์หน้า|อาทิตย์หน้า|เวลา';
const BOOKING_TIME_ASK_RE = new RegExp(`ว่าง|กี่โมง|เวลาไหน|ช่วงไหน|วันไหน|เมื่อไหร่|เมื่อไร|ขอ(?:วัน|เวลา)อื่น|เปลี่ยน(?:วัน|เวลา)|(?:${BOOKING_DAYTIME})[^\\n]{0,12}(?:ได้(?:ไหม|มั้ย|มั๊ย|รึเปล่า|หรือเปล่า)|ไม่(?:สะดวก|ได้))|ไม่(?:สะดวก|ได้)[^\\n]{0,8}(?:${BOOKING_DAYTIME})`, 'u');
// an approved FAQ answer from the pack: the section without its bold question line
function faqAnswer(pack, id) {
    const ex = lazy('../flows/examples');
    const raw = ex && ex.sectionText ? ex.sectionText(pack, id) : null;
    if (!raw) return null;
    const lines = String(raw).split('\n').filter((l) => l.trim() && !/^#{1,4}\s/.test(l) && !/^<!--/.test(l));
    if (lines.length && /^\*\*.*\*\*$/.test(lines[0].trim())) lines.shift();
    return lines.join('\n').trim() || null;
}
// Lint ids a model reply may contain in this session: once Mos has really confirmed the booking (endings.applyMosDecision),
// the prompt says so and "ยืนยันแล้ว" is true (CE review 24 Oct)
function policyAllow(sess) {
    const confirmed = (sess && sess.booking && sess.booking.status === 'confirmed') || (sess && sess.booking_step === 'confirmed');
    return confirmed ? new Set(['booking_confirmed']) : new Set();
}
// Safe line when the model keeps claiming an action Lay did not perform (Mos's test 24 Oct, freeze exception (b))
const CLAIM_SAFE_LINE = 'ผมจองหรือยืนยันอะไรแทนไม่ได้ครับ ตอนนี้ยังไม่มีอะไรถูกจองไว้ ถ้าอยากเห็นบอทรับจองจริง ลองเป็นลูกค้าร้านตัวอย่างได้เลยครับ';
// after a website demo (v2.0.2): acknowledge it, one question about their own work. Wording approved by the Head, 25 Oct
// (only A2 / A4 are "ลอง": A1 / A3 are storyboards, C1 is a sample report).
const DEMO_FOLLOW_UP = {
    a4: 'เห็นว่าเพิ่งลองเดโม AI Workspace มาครับ ถ้าเป็นร้านของพี่เอง อยากให้ AI อ่านไฟล์อะไรแล้วช่วยตอบหรือทำงานอะไรให้ครับ',
    c1: 'เห็นว่าเพิ่งดูรายงานตัวอย่าง AI Business Review มาครับ ตอนนี้งานไหนในร้านที่กินเวลาที่สุดครับ',
    a2: 'เห็นว่าเพิ่งดูหน้าเดโมแชทบอทมาครับ ตอนนี้พี่ก็กำลังคุยกับ Agent Lay แชทบอทตัวจริงของเราอยู่ครับ ลูกค้าของพี่ทักมาถามเรื่องอะไรบ่อยที่สุดครับ',
    a1: 'เห็นว่าเพิ่งดูภาพตัวอย่างระบบงานภายใน (AI Agent) มาครับ ตอนนี้งานในทีมที่ต้องตามหรือส่งต่อกันเองบ่อยที่สุดคืออะไรครับ',
    a3: 'เห็นว่าเพิ่งดูภาพตัวอย่างออโตเมชันมาครับ งานไหนที่พี่หรือทีมต้องคีย์หรือทำซ้ำทุกวันครับ',
};
// the website's prefilled texts start like this ("มาจากเว็บ ดูเดโม Workspace", "มาจากเว็บ ลองถาม Lay")
const WEB_PREFILL_RE = /^มาจากเว็บ/u;
// website CTA tokens (Head GTM 23 Oct): a4 · c1 · a2 · a2-shop · a1 · a3
const DEMO_TAG_RE = /#demo-(a2-shop|a[1-4]|c1)(?![\w-])/iu;
const GUARANTEE_ASK_RE = /รับประกัน|การันตี|guarantee|รับรองผล|(?:รับรอง|สัญญา)(?:ได้)?(?:ไหม|มั้ย)?ว่า/iu;
const GUARANTEE_GEO = 'ไม่มีใครรับประกันได้ว่า AI จะแนะนำร้านไหนครับ รวมถึงเราด้วย ที่ทำได้คือทำให้ข้อมูลร้านชัด ตรงกันทุกที่ และตอบคำถามที่ลูกค้าถามจริง ซึ่งเพิ่มโอกาส แต่ไม่ใช่คำสัญญา';
const GUARANTEE_GENERAL = 'เราไม่รับประกันผลลัพธ์เป็นตัวเลขครับ สิ่งที่รับประกันได้คือขอบเขตงานที่ตกลงกัน และแก้จนใช้ได้ตามที่ตกลง';
const DEMO_TRY_RE = /^\s*(?:ขอ)?ลอง(?:เป็น)?ลูกค้า(?:ของ)?ร้านตัวอย่าง|^\s*(?:ขอ)?ลอง(?:คุยกับ)?(?:บอท)?ร้านตัวอย่าง/u;
const GEO_AGAIN = 'เรื่องให้ร้านถูกค้นเจอ AI Business Review ฿4,900 ตรวจให้ได้ครับ ถ้าสนใจ Review ทักต่อได้เลย หรือคุยฟรี 30 นาทีก่อนก็ได้ครับ';
// after "สนใจ Review": the Review needs to know where the shop's information lives (scenario 81 pass condition, §5)
const GEO_NOTED = 'ได้ครับ ตอนนี้ข้อมูลร้านอยู่ช่องทางไหนบ้างครับ เช่น Facebook, Google Maps, เว็บจองที่พัก หรือยังไม่มีเว็บ';
const GEO_NOTE_LABEL = 'สนใจ Review';
const GEO_TALK_LABEL = 'คุยฟรีก่อน';
const GEO_TALK_PB = 'GEO_TALK';
const GEO_SKIP_LABEL = 'ไม่เป็นไร';
const GEO_NOTE_PB = 'GEO_NOTE';
const GEO_SKIP_PB = 'GEO_SKIP';
const GEO_QUICK = [{ label: GEO_NOTE_LABEL, data: GEO_NOTE_PB }, { label: GEO_TALK_LABEL, data: GEO_TALK_PB }, { label: GEO_SKIP_LABEL, data: GEO_SKIP_PB }];
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
module.exports = { normaliseText, shortenMosIntro, cardContext, runTurn, createEventHandler, isGreeting, isTellMeMore, countQuestions, sanitizeInput, MENU_TO_TEXT, INPUT_KINDS };
