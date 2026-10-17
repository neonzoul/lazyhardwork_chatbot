// The two endings (brief §3.6, design §4 "Two endings", flow §6).
//
//   short path  — the need fits a door package (A4 T1, C1, any T1) → `offer` card (price/URL from the KB pack via ctx)
//   long path   — book a 30-minute call: a state machine on session.booking_step
//
//     null ─▶ hw:<field> (only while !homework.readyForEnding) ─▶ name (skipped when display_name known)
//          ─▶ window_day ─▶ window_time ─▶ summary (summary_confirm, amber "รอมอสยืนยัน")
//          ─▶ BOOK_CONFIRM: bookings.create → notifier.booking → ONLY THEN "ส่งให้มอสแล้วครับ…"  (pending)
//          ─▶ Mos: approve → confirmed (the one path allowed to say ยืนยันแล้ว) · propose → reproposed (BOOK_PICK_i)
//                  · decline → declined
//
// The code owns every transition; a model `booking_confirm` is ignored (logged `ignored_model_confirm`).
// Strings live here. ยืนยันแล้ว / นัดเรียบร้อย appear in no string of this file — the confirmed card's pill
// text comes from the renderer, and only applyMosDecision('approve') renders it.

const msg = require('../line/messages');
const lint = require('../core/lint');
const topics = require('./topics');
const homework = require('./homework');

const PB = {
    start: 'BOOK_START', confirm: 'BOOK_CONFIRM', edit: 'BOOK_EDIT',
    nameUse: 'BOOK_NAME_USE', nameOther: 'BOOK_NAME_OTHER',
    day: (k) => `BOOK_DAY_${k}`, time: (k) => `BOOK_TIME_${k}`, hw: (field, i) => `BOOK_HW_${field}_${i}`,
    editField: (f) => `BOOK_EDIT_${f}`, pick: (i) => `BOOK_PICK_${i}`,
};

const DAYS = [{ key: 'today', label: 'วันนี้', offset: 0 }, { key: 'tomorrow', label: 'พรุ่งนี้', offset: 1 }, { key: 'other', label: 'เลือกวันเอง' }];
const TIMES = [{ key: 'morning', label: 'เช้า 9-12' }, { key: 'afternoon', label: 'บ่าย 13-17' }, { key: 'evening', label: 'เย็น 18-20' }];
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const DOOR_CARDS = new Set(['C1']);           // a door package at any tier
const DOOR_TIER = 'T1';                        // every card's T1 is a door package (A4 T1 included)
const CARD_TITLES = { A1: 'AI Agent / internal workflow', A2: 'AI Chatbot', A3: 'AI Automation', A4: 'AI Workspace Setup', C1: 'AI Business Review' };
// Default bullets when the pack has no `offer.<card>.T1` section — generic, no numbers, no job-loss framing.
const DEFAULT_BULLETS = {
    A1: ['รวมข้อมูลที่กระจายอยู่ให้ดูที่เดียว', 'ตามงานและสรุปสถานะให้อัตโนมัติ', 'ออกแบบตามงานจริงของทีมคุณ'],
    A2: ['ตอบคำถามที่ลูกค้าถามซ้ำได้เองตลอดวัน', 'ส่งต่อให้คนเมื่อเรื่องเกินขอบเขต', 'ปรับคำตอบจากข้อมูลของร้านคุณ'],
    A3: ['เปลี่ยนงานคีย์ซ้ำเป็นขั้นตอนอัตโนมัติ', 'เชื่อมกับเครื่องมือที่ใช้อยู่แล้ว', 'มีจุดให้คนตรวจก่อนทุกขั้นสำคัญ'],
    A4: ['ตั้งค่า AI ให้รู้จักงานและข้อมูลของคุณ', 'คู่มือสั้นๆ ให้ทีมใช้ต่อได้เอง', 'เริ่มใช้ได้ทันทีหลังส่งมอบ'],
    C1: ['ทบทวนงานปัจจุบันว่าจุดไหนใช้ AI ได้จริง', 'แผนเริ่มต้นเป็นขั้นตอนที่ทำได้เลย', 'คุยกับมอสโดยตรง'],
};

const strings = {
    offerAlt: (title) => `แพ็กเริ่มต้น ${title}`,
    offerSecondary: 'นัดคุยกับมอสก่อน',
    askName: 'ขอชื่อที่ให้มอสเรียกหน่อยครับ พิมพ์มาได้เลย',
    askNameWithDefault: 'ขอชื่อที่ให้มอสเรียกหน่อยครับ',
    useName: (name) => `ใช้ชื่อ ${name}`,
    typeOtherName: 'พิมพ์ชื่ออื่น',
    askDay: 'สะดวกคุยกับมอสช่วงไหนครับ เลือกวันก่อนได้เลย',
    askDayText: 'พิมพ์วันที่สะดวกมาได้เลยครับ เช่น จันทร์หน้า หรือ 25 ต.ค.',
    askTime: (day) => `${day} ช่วงเวลาไหนสะดวกครับ`,
    summaryTitle: 'ขอนัดคุยกับมอส 30 นาที',
    summaryLead: 'ขอสรุปก่อนส่งให้มอสนะครับ ถ้าถูกต้องกดยืนยันได้เลย',
    sentToMos: (phone) => `ส่งให้มอสแล้วครับ มอสจะยืนยันเวลากลับมาทางแชทนี้\nถ้าเกิน 1 วันทำการยังไม่มีตอบ โทร ${phone} ได้เลย`,
    notifyFailed: (phone) => `ขออภัยครับ ระบบส่งคำขอนัดให้มอสขัดข้อง ผมบันทึกไว้แล้วแต่ยังไม่ถึงมอส\nรบกวนโทรหามอสโดยตรงที่ ${phone} ครับ`,
    alreadyPending: (phone) => `คำขอนัดของคุณส่งถึงมอสแล้วครับ กำลังรอมอสยืนยันเวลา\nถ้าเกิน 1 วันทำการยังไม่มีตอบ โทร ${phone} ได้เลย`,
    askEditField: 'อยากแก้ตรงไหนครับ',
    editLabels: { name: 'ชื่อ', day: 'วัน', time: 'ช่วงเวลา', problem: 'เรื่องที่อยากคุย' },
    approved: 'มอสยืนยันช่วงเวลามาแล้วครับ ถ้ามีอะไรเปลี่ยนแปลง ทักมาทางแชทนี้ได้เลย',
    proposed: 'ช่วงที่ขอไว้มอสไม่สะดวกครับ มอสเสนอช่วงนี้แทน เลือกได้เลย',
    proposeOther: 'ขอเสนอเวลาอื่น',
    picked: (w) => `รับทราบครับ เลือก ${w}\nส่งให้มอสแล้ว รอมอสยืนยันอีกครั้งทางแชทนี้ครับ`,
    declined: (phone) => `ขออภัยครับ ช่วงนี้มอสยังรับนัดเพิ่มไม่ได้\nถ้าอยากคุยสั้นๆ โทร ${phone} ได้เลย หรือทักมาใหม่ภายหลังได้ครับ`,
    fields: { name: 'ชื่อ', business: 'ธุรกิจ', problem: 'เรื่องที่อยากคุย', window: 'ช่วงเวลาที่สะดวก' },
    afterBooking: ['ถามเรื่องอื่นต่อ'],
};

// ---------------------------------------------------------------------------------------------------------------
// Which ending
function chooseEnding(session) {
    const d = (session && session.draft) || {};
    if (!d.card) return 'long';
    if (DOOR_CARDS.has(d.card)) return 'short';
    if ((d.tier || DOOR_TIER) === DOOR_TIER) return 'short';
    return 'long';
}

// ---------------------------------------------------------------------------------------------------------------
// Short path: the offer card data (price and URL are resolved by the renderer from ctx, never here)
function bulletsFromPack(pack, cardId, tier) {
    const sec = pack && pack.sections && typeof pack.sections.get === 'function' ? pack.sections.get(`offer.${cardId}.${tier}`) : null;
    if (!sec || !sec.text) return null;
    const lines = String(sec.text).split('\n').map((l) => l.trim()).filter((l) => /^[-•*]\s+/.test(l)).map((l) => l.replace(/^[-•*]\s+/, '').trim()).filter(Boolean);
    return lines.length ? lines.slice(0, 5) : null;
}

function offerCard(session, { deps = {}, secondary = true } = {}) {
    const d = (session && session.draft) || {};
    const cardId = d.card;
    if (!cardId) return null;
    const tier = DOOR_CARDS.has(cardId) ? (d.tier || DOOR_TIER) : DOOR_TIER;
    const title = CARD_TITLES[cardId] || cardId;
    const bullets = bulletsFromPack(deps.pack, cardId, tier) || DEFAULT_BULLETS[cardId] || DEFAULT_BULLETS.C1;
    const data = { card_id: cardId, tier, title, bullets };
    if (secondary) data.secondary_cta = { label: strings.offerSecondary, postback: PB.start };
    return { template: 'offer', alt: strings.offerAlt(title), data };
}

// Hook for core/turn (between step 10 and 12): append the offer card to a model response when the short path is
// ready and no card is in the reply yet. Returns true when a card was added. Shows the offer once per session.
function decorateResponse({ response, session, deps }) {
    if (!response || !session || session.offer_shown) return false;
    if (chooseEnding(session) !== 'short' || !session.draft?.card) return false;
    const ready = homework.readyForEnding(session) || ['fit', 'howtostart', 'pricing'].includes(response.intent);
    if (!ready) return false;
    if ((response.messages || []).some((m) => m.type === 'card')) return false;
    const card = offerCard(session, { deps });
    if (!card) return false;
    response.messages = [...(response.messages || []).slice(0, 2), { type: 'card', text: null, explain: false, template: card.template, alt: card.alt, data: card.data }];
    session.offer_shown = true;
    return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Long path helpers
function bangkok(now) { return new Date(now.getTime() + 7 * 3600 * 1000); }
function dayLabel(kind, now) {
    const d = DAYS.find((x) => x.key === kind);
    if (!d || d.offset === undefined) return null;
    const t = bangkok(now); t.setUTCDate(t.getUTCDate() + d.offset);
    return `${d.label} (${t.getUTCDate()} ${TH_MONTHS[t.getUTCMonth()]})`;
}
function windowText(session) {
    const d = session.draft || {};
    return [d.window_day, d.window_time].filter(Boolean).join(' ');
}
function cardContext(deps, config) {
    if (typeof deps.cardContext === 'function') return deps.cardContext(deps.pack, config);
    const pack = deps.pack || {};
    const ladder = pack.ladders || {};
    return {
        assets: pack.assets || {},
        log: deps.log,
        fastworkUrlFor: (cardId) => pack.fastworkUrls?.[cardId] || config.contact?.fastworkUrl || 'https://fastwork.co/user/mos_lazyhardwork',
        priceFor: (cardId, tier) => { const p = ladder[cardId]?.tiers?.[tier]; return p ? { price_from: p, label_th: `ราคาเริ่มต้น ${p.toLocaleString('th-TH')} บาท` } : { price_from: null, label_th: 'ราคาเริ่มต้น ปรับตามขอบเขตจริงหลังคุย' }; },
    };
}
function lazyCards() { try { return require('../cards/render'); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return null; throw e; } }
function markTemplate(m, template) {
    Object.defineProperty(m, '_template', { value: template, enumerable: false });
    if (m.contents) Object.defineProperty(m.contents, '_template', { value: template, enumerable: false });
}
// Render a card → { messages:[LINE message], quickReplies|null }. Falls back to text + the fallback buttons.
function renderCard(card, { deps, config }) {
    const cards = deps.cards || lazyCards();
    if (!cards || !cards.render) return { messages: [msg.text(card.alt)], quickReplies: null };
    const r = cards.render(card, cardContext(deps, config));
    if (r.message) { const m = msg.flex(r.message); markTemplate(m, card.template); return { messages: [m], quickReplies: null }; }
    const qr = (r.fallback.quick_replies || []).map((q) => (q.uri ? { label: q.label, uri: q.uri } : { label: q.label, data: q.data }));
    return { messages: [msg.text(r.fallback.text || card.alt)], quickReplies: qr.length ? qr : null };
}

function summaryFields(session) {
    const d = session.draft || {}; const h = session.homework || {};
    const f = [];
    if (d.name) f.push({ k: strings.fields.name, v: d.name });
    if (h.business) f.push({ k: strings.fields.business, v: String(h.business).slice(0, 60) });
    if (h.problem_verbatim) f.push({ k: strings.fields.problem, v: String(h.problem_verbatim).slice(0, 80) });
    f.push({ k: strings.fields.window, v: windowText(session) || '-' });
    return f;
}
function summaryCard(session, status = 'pending') {
    return { template: 'summary_confirm', alt: `${strings.summaryTitle} — ${windowText(session)}`, data: { title: strings.summaryTitle, fields: summaryFields(session), status, confirm_postback: PB.confirm, edit_postback: PB.edit } };
}

// The homework fields Lay may ask inside the booking (free text; buttons when the field has options).
const BOOKING_HW_FIELDS = ['problem_verbatim', 'business'];

// Decide the next step from what is known. Returns { step, messages, quickReplies }.
function nextPrompt(session, ctx) {
    const { deps, config } = ctx;
    // homework gaps first, only while an ending is not yet "earned" and the question budget remains
    if (!homework.readyForEnding(session)) {
        const q = homework.nextQuestion(session, { fields: BOOKING_HW_FIELDS });
        if (q) {
            session.booking_step = 'hw'; session.booking_hw_field = q.field;
            homework.countQuestion(session);
            const qr = q.options ? q.options.map((o, i) => ({ label: o.label, data: PB.hw(q.field, i) })) : null;
            return { step: 'hw', messages: [msg.text(q.text)], quickReplies: qr };
        }
    }
    const d = session.draft = session.draft || {};
    if (!d.name) {
        if (session.display_name && !session.booking_name_asked) { d.name = session.display_name; }
        else {
            session.booking_step = 'name';
            const qr = session.display_name ? [{ label: strings.useName(session.display_name), data: PB.nameUse }, { label: strings.typeOtherName, data: PB.nameOther }] : null;
            return { step: 'name', messages: [msg.text(qr ? strings.askNameWithDefault : strings.askName)], quickReplies: qr };
        }
    }
    if (!d.window_day) {
        session.booking_step = 'window_day';
        return { step: 'window_day', messages: [msg.text(strings.askDay)], quickReplies: DAYS.map((x) => ({ label: x.label, data: PB.day(x.key) })) };
    }
    if (!d.window_time) {
        session.booking_step = 'window_time';
        return { step: 'window_time', messages: [msg.text(strings.askTime(d.window_day))], quickReplies: TIMES.map((x) => ({ label: x.label, data: PB.time(x.key) })) };
    }
    session.booking_step = 'summary';
    const r = renderCard(summaryCard(session, 'pending'), { deps, config });
    return { step: 'summary', messages: [msg.text(strings.summaryLead), ...r.messages], quickReplies: r.quickReplies };
}

async function advance(ctx, prelude = []) {
    const { input, session, send, persist, done, sender } = ctx;
    const p = nextPrompt(session, ctx);
    const sent = await send(input, [...prelude, ...p.messages].slice(0, 5), p.quickReplies || [], sender);
    await persist(input, session, sent, { role: 'lay' });
    return done(sent, null);
}

async function startBooking(ctx, prelude = []) {
    const { session, config, input, send, persist, done, sender } = ctx;
    if (session.booking_step === 'pending') {
        const sent = await send(input, [...prelude, msg.text(strings.alreadyPending(config.contact.phoneDisplay))], strings.afterBooking, sender);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    session.homework = session.homework || {};
    if (!session.homework.preferred_contact) session.homework.preferred_contact = 'นัดคุย 30 นาที';
    if (session.booking_step === 'confirmed' || session.booking_step === 'declined') { session.booking_id = null; session.draft = { ...(session.draft || {}), window_day: null, window_time: null }; }
    return advance(ctx, prelude);
}

async function upsertLead(session, deps, now, patch = {}) {
    const existing = await deps.store.leads.byUser(session.user_id);
    const row = {
        ...(existing || {}), user_id: session.user_id, status: patch.status || existing?.status || 'new',
        card_id: session.draft?.card || existing?.card_id || null, symptom: session.draft?.symptom || existing?.symptom || null,
        homework: session.homework || {}, customer_words_th: session.homework?.problem_verbatim || existing?.customer_words_th || null,
        source: 'line_oa', display_name: session.display_name, updated_at: now.toISOString(), created_at: existing?.created_at || now.toISOString(),
    };
    const saved = await deps.store.leads.upsert(row);
    if (!existing) deps.notifier.lead({ lead: saved, session, reason: 'booking' }).catch(() => {});
    return saved;
}

// BOOK_CONFIRM from the summary: create the booking, notify Mos, and only then promise.
async function confirmBooking(ctx) {
    const { input, session, deps, config, send, persist, done, sender } = ctx;
    const now = deps.clock.now();
    const phone = config.contact.phoneDisplay;
    const lead = await upsertLead(session, deps, now, { status: 'booking_pending' });
    const booking = await deps.store.bookings.create({
        lead_id: lead.id, user_id: session.user_id, window_text: windowText(session),
        fields: { name: session.draft?.name || null, business: session.homework?.business || null, problem: session.homework?.problem_verbatim || null, window: windowText(session) },
        status: 'pending', proposed_windows: null, decided_by: null, decided_at: null, created_at: now.toISOString(),
    });
    session.booking_id = booking.id;
    session.booking_step = 'pending';
    try {
        const res = await deps.notifier.booking({ lead, booking, session, summary: homework.homeworkSummary(session) });
        if (res?.threadId) { session.discord_thread_id = res.threadId; await deps.store.bookings.update(booking.id, { discord_thread_id: res.threadId }); }
    } catch (err) {
        deps.log.error('booking.notify_failed', { userId: session.user_id, bookingId: booking.id, error: err?.message });
        await deps.store.bookings.update(booking.id, { status: 'notify_failed' });
        await deps.store.events.append({ kind: 'booking_notify_failed', user_id: session.user_id, payload: { bookingId: booking.id, error: err?.message }, created_at: now.toISOString() });
        session.booking_step = 'notify_failed';
        const sent = await send(input, [msg.text(strings.notifyFailed(phone))], strings.afterBooking, sender);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    const sent = await send(input, [msg.text(strings.sentToMos(phone))], strings.afterBooking, sender);
    await persist(input, session, sent, { role: 'lay' });
    return done(sent, 'booking_confirm');
}

async function askEditField(ctx) {
    const { input, session, send, persist, done, sender } = ctx;
    session.booking_step = 'edit';
    const fields = ['name', 'day', 'time', 'problem'];
    const qr = fields.map((f) => ({ label: strings.editLabels[f], data: PB.editField(f) }));
    const sent = await send(input, [msg.text(strings.askEditField)], qr, sender);
    await persist(input, session, sent, { role: 'lay' });
    return done(sent, null);
}

async function pickProposed(ctx, index) {
    const { input, session, deps, config, send, persist, done, sender } = ctx;
    const now = deps.clock.now();
    const booking = session.booking_id ? await deps.store.bookings.get(session.booking_id) : null;
    const windows = booking?.proposed_windows || [];
    const w = windows[index];
    if (!booking || !w) return advance(ctx);
    session.draft = { ...(session.draft || {}), window_day: w, window_time: null };
    const updated = await deps.store.bookings.update(booking.id, { window_text: w, status: 'pending', decided_by: null, decided_at: null });
    session.booking_step = 'pending';
    const lead = await deps.store.leads.byUser(session.user_id);
    try {
        await deps.notifier.booking({ lead, booking: updated, session, picked: w, summary: homework.homeworkSummary(session) });
    } catch (err) {
        deps.log.error('booking.notify_failed', { userId: session.user_id, bookingId: booking.id, error: err?.message, stage: 'pick' });
        await deps.store.bookings.update(booking.id, { status: 'notify_failed' });
        const sent = await send(input, [msg.text(strings.notifyFailed(config.contact.phoneDisplay))], strings.afterBooking, sender);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    const sent = await send(input, [msg.text(strings.picked(w))], strings.afterBooking, sender);
    await persist(input, session, sent, { role: 'lay' });
    return done(sent, 'booking_confirm');
}

// ---------------------------------------------------------------------------------------------------------------
// Hook: core/turn step 8 — every `BOOK_*` postback lands here.
async function onBookingPostback(ctx) {
    const { data, session, deps } = ctx;
    const now = deps.clock.now();
    session.draft = session.draft || {};
    if (data === PB.start) return startBooking(ctx);
    if (data === PB.confirm) {
        if (session.booking_step !== 'summary') { deps.log.warn('booking.confirm_out_of_step', { userId: session.user_id, step: session.booking_step }); return session.booking_step === 'pending' ? startBooking(ctx) : advance(ctx); }
        return confirmBooking(ctx);
    }
    if (data === PB.edit) return askEditField(ctx);
    if (data === PB.nameUse) { session.draft.name = session.display_name || session.draft.name; session.booking_name_asked = false; return advance(ctx); }
    if (data === PB.nameOther) { session.draft.name = null; session.booking_name_asked = true; session.booking_step = 'name_text'; return ask(ctx, strings.askName); }
    let m;
    if ((m = /^BOOK_HW_(\w+?)_(\d+)$/.exec(data))) {
        const def = homework.FIELDS[m[1]]; const opt = def && def.options && def.options[Number(m[2])];
        if (opt) homework.applyAnswer(session, m[1], opt);
        return advance(ctx);
    }
    if ((m = /^BOOK_DAY_(\w+)$/.exec(data))) {
        if (m[1] === 'other') { session.booking_step = 'window_day_text'; return ask(ctx, strings.askDayText); }
        const label = dayLabel(m[1], now);
        if (label) session.draft.window_day = label;
        return advance(ctx);
    }
    if ((m = /^BOOK_TIME_(\w+)$/.exec(data))) {
        const t = TIMES.find((x) => x.key === m[1]);
        if (t) session.draft.window_time = t.label;
        return advance(ctx);
    }
    if ((m = /^BOOK_EDIT_(\w+)$/.exec(data))) {
        const f = m[1];
        if (f === 'name') { session.draft.name = null; session.booking_name_asked = true; return advance(ctx); }
        if (f === 'day') { session.draft.window_day = null; return advance(ctx); }
        if (f === 'time') { session.draft.window_time = null; return advance(ctx); }
        if (f === 'problem' || f === 'business') {
            session.homework = session.homework || {}; session.homework[f === 'problem' ? 'problem_verbatim' : 'business'] = null;
            session.booking_step = 'hw'; session.booking_hw_field = f === 'problem' ? 'problem_verbatim' : 'business';
            return ask(ctx, homework.questionFor(session.booking_hw_field).text);
        }
        return advance(ctx);
    }
    if ((m = /^BOOK_PICK_(\d+)$/.exec(data))) return pickProposed(ctx, Number(m[1]));
    deps.log.warn('booking.unknown_postback', { data: String(data).slice(0, 40) });
    return advance(ctx);
}

async function ask(ctx, text, quickReplies = []) {
    const { input, session, send, persist, done, sender } = ctx;
    const sent = await send(input, [msg.text(text)], quickReplies, sender);
    await persist(input, session, sent, { role: 'lay' });
    return done(sent, null);
}

// Hook (requested in core/turn step 8, before the model): a typed message while the booking waits for text.
// Returns null when the booking is not waiting for text, so the turn continues to the model.
async function onBookingText(ctx) {
    const { text, session } = ctx;
    const step = session.booking_step;
    const t = String(text || '').trim();
    if (!t) return null;
    if (step === 'name' || step === 'name_text') { session.draft = session.draft || {}; session.draft.name = t.slice(0, 40); session.booking_name_asked = false; return advance(ctx); }
    if (step === 'window_day_text') { session.draft = session.draft || {}; session.draft.window_day = t.slice(0, 60); return advance(ctx); }
    if (step === 'hw' && session.booking_hw_field) {
        const b = homework.answerFromButton(t);
        if (b) homework.applyAnswer(session, b.field, b.value); else homework.applyAnswer(session, session.booking_hw_field, t);
        session.booking_hw_field = null;
        return advance(ctx);
    }
    return null;
}

// Hook: core/turn step 11 — the model proposed booking_start / booking_confirm.
async function onModelAction(ctx) {
    const { action, response, session, deps, senders, input, send, persist, done } = ctx;
    const sender = ctx.sender || senders.lay;
    const prelude = (response?.messages || []).filter((m) => m.type === 'text' && m.text && m.text.trim()).slice(0, 2).map((m) => msg.text(lint.stripMarkdown(m.text).trim()));
    const c = { ...ctx, sender };
    if (action === 'booking_start') return startBooking(c, prelude);
    if (action === 'booking_confirm') {
        // the model never confirms: only the customer's BOOK_CONFIRM tap from the summary does
        deps.log.warn('ignored_model_confirm', { userId: session.user_id, step: session.booking_step || null });
        await deps.store.events.append({ kind: 'ignored_model_confirm', user_id: session.user_id, payload: { step: session.booking_step || null }, created_at: deps.clock.now().toISOString() }).catch(() => {});
        if (session.booking_step && !['pending', 'confirmed', 'declined', 'notify_failed'].includes(session.booking_step)) return advance(c, prelude);
        if (!session.booking_step) return startBooking(c, prelude);
        const messages = prelude.length ? prelude : [msg.text(strings.alreadyPending(ctx.config.contact.phoneDisplay))];
        const sent = await send(input, messages, topics.nextQuickReplies(null, session.topics_covered), sender);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    return advance(c, prelude);
}

// ---------------------------------------------------------------------------------------------------------------
// Mos's decision from the Discord relay. Pushes to the customer (no reply token on this side) as Lay.
//   decision: 'approve' | 'propose' | 'decline'   windows: ['…', …] (propose, ≤ 3)
// Returns { sent, booking, allow } — `allow` lists the lint ids this message may legitimately contain.
async function applyMosDecision({ decision, windows = [], booking, session, deps, config, senders }) {
    const now = deps.clock.now();
    const phone = config.contact.phoneDisplay;
    const sender = senders?.lay || null;
    const allow = new Set();
    let messages = []; let quickReplies = []; let updated = booking;
    if (decision === 'approve') {
        updated = await deps.store.bookings.update(booking.id, { status: 'confirmed', decided_by: 'mos', decided_at: now.toISOString() });
        session.booking_step = 'confirmed';
        if (updated.window_text && !windowText(session)) session.draft = { ...(session.draft || {}), window_day: updated.window_text };
        const r = renderCard(summaryCard(session, 'confirmed'), { deps, config });
        messages = [...r.messages, msg.text(strings.approved)];
        quickReplies = topics.nextQuickReplies(null, session.topics_covered);
        allow.add('booking_confirmed');
    } else if (decision === 'propose') {
        const list = windows.filter(Boolean).map((w) => String(w).trim()).filter(Boolean).slice(0, 3);
        if (!list.length) throw new Error('propose needs 1-3 windows');
        updated = await deps.store.bookings.update(booking.id, { status: 'reproposed', proposed_windows: list, decided_by: 'mos', decided_at: now.toISOString() });
        session.booking_step = 'reproposed';
        messages = [msg.text(strings.proposed)];
        quickReplies = [...list.map((w, i) => ({ label: w, data: PB.pick(i) })), { label: strings.proposeOther, data: PB.editField('day') }];
    } else if (decision === 'decline') {
        updated = await deps.store.bookings.update(booking.id, { status: 'declined', decided_by: 'mos', decided_at: now.toISOString() });
        session.booking_step = 'declined';
        messages = [msg.text(strings.declined(phone))];
        quickReplies = topics.nextQuickReplies(null, session.topics_covered);
    } else {
        throw new Error(`unknown decision ${decision}`);
    }
    const list = msg.attachQuickReplies(messages, quickReplies, sender);
    await deps.line.push(session.user_id, list);
    for (const m of list) await deps.store.messages.append({ user_id: session.user_id, role: 'lay', kind: m.type, text: m.type === 'text' ? m.text : m.altText || null, sender_name: sender?.name || null, payload: m.type === 'flex' ? { template: m._template || null } : null, created_at: now.toISOString() });
    session.last_bot_at = now.toISOString();
    await deps.store.sessions.save(session);
    return { sent: [list], booking: updated, allow };
}

module.exports = { PB, DAYS, TIMES, CARD_TITLES, DEFAULT_BULLETS, strings, chooseEnding, offerCard, decorateResponse, summaryCard, windowText, dayLabel, nextPrompt, onBookingPostback, onBookingText, onModelAction, applyMosDecision, startBooking, confirmBooking };
