// Demo mode (design §7, brief §3.7): the customer becomes a customer of a synthetic shop and that shop's bot answers.
//
//   demoShops(pack)                      → { cafe, clinic } built from kb/examples.md (examples.demo-cafe / -clinic)
//   enterDemo(session, shopKey, now)     → mode 'demo', demo_shop, demo_state {step:'chat', order:null, since}
//   exitDemo(session, now)               → mode 'lay', demo_shop null, demo_state null
//   runDemoTurn({...})                   → turn.js calls this for every text/postback while mode === 'demo'
//   onDemoPostback({...})                → every DEMO_* postback (any mode): picker, enter, confirm, edit, examples
//   onModelAction({...})                 → 'demo_enter' (enters only on a clear shop pick) · 'demo_exit' (Lay's exit line)
//
// Rules kept here: the shop's bot never notifies anyone (deps.notifier is never called), never writes lead fields
// (session.homework / draft untouched), stores its messages with role 'demo_shop', speaks as senders.demo(shop), and
// every message carries the กลับไปคุยกับ Lay quick reply (≤ 4 in total). The model proposes words and a summary card;
// the code owns state, postbacks, status and the sender.

const msg = require('../line/messages');
const lint = require('../core/lint');
const session = require('../core/session');
const quiet = require('../identity/quiet');
const { createSenders } = require('../identity/sender');
const { validateResponse, emptyResponse } = require('../brain/schema');
const examples = require('./examples');

const BACK_LABEL = 'กลับไปคุยกับ Lay';   // message action; identity/quiet.isCallLay recognises it
const QUICK_MAX = 4;
const HISTORY_N = 12;

const POSTBACKS = {
    confirm: 'DEMO_CONFIRM',
    edit: 'DEMO_EDIT',
    enterPrefix: 'DEMO_ENTER_',
};

const SYMPTOMS = [
    { key: 'chat_overload', label: 'ตอบแชทลูกค้าไม่ทัน' },
    { key: 'scattered_data', label: 'ข้อมูลกระจายหลายที่' },
    { key: 'repetitive_work', label: 'งานซ้ำ คีย์ซ้ำทุกวัน' },
    { key: 'ai_know_my_work', label: 'อยากให้ AI รู้จักงาน' },
    { key: 'dont_know_where_to_start', label: 'ไม่รู้จะเริ่มตรงไหน' },
];

// Shape per shop. Names come from the pack when it has them; everything else is fixed here.
const SHOP_DEFS = {
    cafe: {
        key: 'cafe', section_id: 'examples.demo-cafe', kind_th: 'ร้านกาแฟตัวอย่าง', default_name_th: 'คาเฟ่ริมคลอง', short_name_th: 'ริมคลอง', icon_key: 'demo-cafe',
        order_noun: 'ออเดอร์', pick_re: /กาแฟ|คาเฟ่|cafe|coffee/iu,
        fields: ['รายการ', 'จำนวน', 'รับที่ร้าน/ส่ง', 'เวลารับ', 'ชื่อผู้รับ', 'ยอดรวม'],
        starters: ['ดูเมนู', 'ลาเต้เย็น 1 แก้ว'],
        more: 'สั่งเพิ่ม',
    },
    clinic: {
        key: 'clinic', section_id: 'examples.demo-clinic', kind_th: 'คลินิกความงามตัวอย่าง', default_name_th: 'คลินิกใสใส', short_name_th: 'ใสใส', icon_key: 'demo-clinic',
        order_noun: 'การจอง', pick_re: /คลินิก|ความงาม|clinic|ผิว|เลเซอร์/iu,
        fields: ['บริการ', 'วัน', 'ช่วงเวลา', 'ชื่อผู้จอง', 'เคยใช้บริการ', 'มัดจำ'],
        starters: ['ดูบริการ', 'จองทรีตเมนต์หน้าใส'],
        more: 'จองเพิ่ม',
    },
};

const strings = {
    greeting: {
        cafe: (name) => `สวัสดีครับ ที่นี่${name} ร้านกาแฟตัวอย่างครับ สั่งล่วงหน้าแล้วมารับที่ร้านหรือให้ส่งก็ได้\nวันนี้รับอะไรดีครับ`,
        clinic: (name) => `สวัสดีครับ ${name} คลินิกความงามตัวอย่างครับ จองคิวหรือสอบถามบริการได้เลย\nสนใจเรื่องไหนครับ`,
    },
    sent: (noun) => `ส่ง${noun}ให้เจ้าของร้าน (ตัวอย่าง) แล้วครับ รอยืนยัน\nในร้านจริง เจ้าของร้านจะเห็นสรุปนี้ในแชทของทีมแล้วกดยืนยันกลับมาหาพี่`,
    edit: 'ได้เลยครับ บอกส่วนที่อยากเปลี่ยนมาได้เลย เดี๋ยวสรุปใหม่ให้',
    nothingToConfirm: 'ยังไม่มีรายการให้ยืนยันครับ บอกมาได้เลยว่าจะรับอะไร',
    notInDemo: 'ตอนนี้ไม่ได้อยู่ในร้านตัวอย่างแล้วครับ ถ้าอยากลองอีกครั้งกดเลือกร้านได้เลย',
    alreadyLay: 'ตอนนี้คุยกับ Lay อยู่แล้วครับ มีอะไรให้ช่วยต่อ',
    shopFallback: 'ขออภัยครับ ระบบของร้านตัวอย่างขัดข้องชั่วคราว ลองพิมพ์อีกครั้ง หรือกดกลับไปคุยกับ Lay ได้เลย',
    emptyText: 'พิมพ์มาได้เลยครับ หรือกดปุ่มด้านล่าง',
    exitSeen: {
        cafe: { order: 'เมื่อกี้พี่เห็นบอทของร้านกาแฟตัวอย่างรับออเดอร์ สรุปเป็นการ์ด แล้วส่งให้เจ้าของร้านรอยืนยันครับ', chat: 'เมื่อกี้พี่เห็นบอทของร้านกาแฟตัวอย่างตอบลูกค้าจากข้อมูลของร้านเองครับ' },
        clinic: { order: 'เมื่อกี้พี่เห็นบอทของคลินิกตัวอย่างรับจองคิว สรุปเป็นการ์ด แล้วส่งให้เจ้าของร้านรอยืนยันครับ', chat: 'เมื่อกี้พี่เห็นบอทของคลินิกตัวอย่างตอบลูกค้าจากข้อมูลของร้านเองครับ' },
    },
    exitAsk: 'อยากได้ส่วนไหนแบบนี้ในร้านพี่บ้างครับ',
    symptomTitle: 'ตอนนี้ติดตรงไหนมากที่สุดครับ',
    tryOther: 'ลองอีกร้าน',
    orderGuide: (def) => `## การรับ${def.order_noun}ในเดโม\nถามทีละข้อเฉพาะที่ยังไม่รู้ เมื่อครบแล้วส่งการ์ด summary_confirm 1 ใบ title "สรุป${def.order_noun} (ร้านตัวอย่าง)" fields ใช้ k ตามนี้เท่าที่มี: ${def.fields.join(', ')} และตั้ง action เป็น "booking_confirm" ตอนเริ่มรับ${def.order_noun}ตั้ง action เป็น "booking_start" สถานะและปุ่มของการ์ดระบบตั้งเอง ถ้าลูกค้าขอแก้ให้สรุปใหม่ทั้งใบ`,
};

// ---------------------------------------------------------------------------------------------------------------
// shops
function nameFromSection(text, fallback) {
    const first = String(text || '').split('\n').find((l) => l.trim()) || '';
    const m = first.match(/"([^"]+)"|“([^”]+)”/u);
    return (m && (m[1] || m[2])) || fallback;
}

function demoShops(pack) {
    const out = {};
    for (const def of Object.values(SHOP_DEFS)) {
        const kb = examples.sectionText(pack, def.section_id) || '';
        out[def.key] = {
            key: def.key,
            name_th: nameFromSection(kb, def.default_name_th),
            short_name_th: def.short_name_th,
            kind_th: def.kind_th,
            icon_key: def.icon_key,
            section_id: def.section_id,
            kb,
            fields: [...def.fields],
            starters: [...def.starters],
            order_noun: def.order_noun,
            more_label: def.more,
        };
    }
    return out;
}

let cachedPack = null;
function loadPackOnce() {
    if (cachedPack !== null) return cachedPack || null;
    try { cachedPack = require('../brain/kb').loadPack(); } catch { cachedPack = false; }
    return cachedPack || null;
}
function shopsFor(deps) {
    if (deps && deps.pack && deps.pack.demoShops) return deps.pack.demoShops;
    return demoShops((deps && deps.pack) || loadPackOnce());
}
function shopFromText(text) {
    const t = String(text || '');
    for (const def of Object.values(SHOP_DEFS)) if (def.pick_re.test(t)) return def.key;
    return null;
}

// ---------------------------------------------------------------------------------------------------------------
// state
function enterDemo(sess, shopKey, now) {
    if (!SHOP_DEFS[shopKey]) throw new Error(`unknown demo shop ${shopKey}`);
    session.setMode(sess, 'demo', now);
    sess.demo_shop = shopKey;
    sess.demo_state = { step: 'chat', order: null, since: now.toISOString(), turns: 0 };
    return sess;
}

function exitDemo(sess, now) {
    const was = sess.mode;
    session.setMode(sess, 'lay', now);
    sess.demo_shop = null;
    sess.demo_state = null;
    sess.resumed_by = 'demo_exit';
    return was;
}

function stateOf(sess) {
    if (!sess.demo_state || typeof sess.demo_state !== 'object') sess.demo_state = { step: 'chat', order: null, since: sess.mode_since || null, turns: 0 };
    return sess.demo_state;
}

// quick replies: the shop's suggestions first, กลับไปคุยกับ Lay always last, never more than 4
function withBack(items = []) {
    const isBack = (q) => (typeof q === 'string' ? q : q && (q.label || '')).trim() === BACK_LABEL || (typeof q === 'string' && quiet.CALL_LAY_RE.test(q));
    const kept = (items || []).filter((q) => q && !isBack(q)).slice(0, QUICK_MAX - 1);
    return [...kept, BACK_LABEL];
}

function markTemplate(m, template) {
    Object.defineProperty(m, '_template', { value: template, enumerable: false });
    if (m.contents) Object.defineProperty(m.contents, '_template', { value: template, enumerable: false });
    return m;
}

function lazyCards() { try { return require('../cards/render'); } catch { return null; } }
function lazyPrompt() { try { return require('../brain/prompt'); } catch { return null; } }
function lazyPolicy() { try { return require('../core/policy'); } catch { return null; } }

// ---------------------------------------------------------------------------------------------------------------
// the shop's model call: demo system prompt + shop KB + demo-only history; policy on top; honest fallback on throw
async function askShop({ shop, userText, sess, deps, config, now }) {
    const prompt = deps.brain || lazyPrompt();
    const policy = deps.policy || lazyPolicy();
    const def = SHOP_DEFS[shop.key];
    const state = stateOf(sess);
    const shopKb = [{ id: shop.section_id, text: shop.kb }, { id: `${shop.section_id}.order`, text: strings.orderGuide(def) }];
    const system = prompt && prompt.buildDemoSystemPrompt
        ? prompt.buildDemoSystemPrompt({ shop: { key: shop.key, name: shop.name_th }, shopKb })
        : `คุณคือผู้ช่วย AI ของ ${shop.name_th} (ร้านตัวอย่าง) ตอบจากข้อมูลร้านเท่านั้น\n${shop.kb}`;
    const all = await deps.store.messages.recent(sess.user_id, HISTORY_N * 2);
    const history = all
        .filter((m) => (m.role === 'customer' || m.role === 'demo_shop') && m.kind !== 'postback' && (!state.since || !m.created_at || m.created_at >= state.since))
        .map((m) => ({ role: m.role, text: m.text }));
    if (history.length && history[history.length - 1].role === 'customer' && history[history.length - 1].text === userText) history.pop();
    const messages = prompt && prompt.buildMessages
        ? prompt.buildMessages({ systemPrompt: system, history: history.slice(-HISTORY_N), userText })
        : [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role === 'customer' ? 'user' : 'assistant', content: h.text })), { role: 'user', content: userText }];
    const { responseSchema } = require('../brain/schema');

    const attempt = async (extraNote) => {
        const req = { system, messages: extraNote ? [...messages, { role: 'system', content: extraNote }] : messages, schema: responseSchema };
        const raw = await deps.model.respond(req);
        const v = validateResponse(raw);
        if (!v.ok) throw Object.assign(new Error(`model output invalid: ${v.errors.join('; ')}`), { kind: 'invalid_output' });
        return raw;
    };
    const apply = (r) => (policy && policy.applyPolicy ? policy.applyPolicy(r, { session: sess, pack: deps.pack || null, allow: new Set(), userText }) : { response: r, severity: 'fix', violations: [] });

    try {
        let response = await attempt();
        let p = apply(response);
        if (p.severity === 'regenerate') {
            deps.log.warn('demo.policy.regenerate', { shop: shop.key, violations: p.violations.map((v) => v.rule || v).join(',') });
            response = await attempt(`คำตอบก่อนหน้าละเมิดกฎ: ${p.violations.map((v) => v.rule || v).join(', ')} — ตอบใหม่โดยไม่ละเมิด`);
            p = apply(response);
        }
        // a menu answer that is only too long or list-shaped is split, not thrown away (real replay 19 Oct: "มีอะไรบ้าง"
        // became the shop's error line)
        if (p.severity !== 'fix' && policy && policy.salvage && policy.isStyleOnly && policy.isStyleOnly(p.violations)) {
            const s2 = apply(policy.salvage(p.response || response));
            if (s2.severity !== 'fallback' && !s2.violations.some((v) => String(v.rule).startsWith('banned:'))) { deps.log.warn('demo.policy.salvaged', { shop: shop.key }); p = { ...s2, severity: 'fix' }; }
        }
        if (p.severity !== 'fix') throw Object.assign(new Error(`policy: ${p.violations.map((v) => v.rule || v).join(', ')}`), { kind: 'policy' });
        const lastShop = [...history].reverse().find((h) => h.role === 'demo_shop');
        return { response: oneQuestionAtATime(p.response, lastShop ? lastShop.text : null), ok: true };
    } catch (err) {
        deps.log.error('demo.model.fallback', { userId: sess.user_id, shop: shop.key, kind: err.kind || 'error', error: err.message });
        try { await deps.store.events.append({ kind: 'model_fallback', user_id: sess.user_id, payload: { error: err.message, demo_shop: shop.key }, created_at: now.toISOString() }); } catch { /* ignore */ }
        return { response: emptyResponse({ messages: [{ type: 'text', text: strings.shopFallback, explain: false, template: null, alt: null, data: null }], quick_replies: [], intent: 'demo' }), ok: false, error: err };
    }
}

// Demo shop asks one thing at a time (head review 19 Oct: "เย็นหรือร้อน" and the sweetness list came together, then the
// sweetness list again). Keeps the first asking bubble, drops later ones, and drops a bubble that repeats the shop's
// previous message word for word.
const ASKS_RE = /[?？]|ไหม|หรือเปล่า|หรือยัง|เลือก|ต้องการ|รับ(?:ที่ร้าน|เอง)|ส่งหรือ|ร้อนหรือ|เย็นหรือ/u;
const norm = (s) => String(s || '').replace(/[\s.。!?？…]+/gu, '');
function oneQuestionAtATime(response, lastShopText) {
    if (!response || !Array.isArray(response.messages)) return response;
    let asked = false;
    const last = norm(lastShopText);
    const kept = response.messages.filter((m) => {
        if (!m || m.type !== 'text') return true;
        if (last && norm(m.text) === last) return false;
        if (!ASKS_RE.test(m.text || '')) return true;
        if (asked) return false;
        asked = true;
        return true;
    });
    response.messages = kept.length ? kept : response.messages.slice(0, 1);
    return response;
}

// Turn the response into LINE messages. A summary_confirm card becomes THE demo order: code sets status + postbacks.
function renderShopMessages(response, { sess, deps, config }) {
    const cards = deps.cards || lazyCards();
    const ctx = examples.cardContext(deps.pack, config, deps.log);
    const state = stateOf(sess);
    const out = [];
    for (const m of response.messages) {
        if (m.type === 'text') { if (m.text && m.text.trim()) out.push(msg.text(lint.stripMarkdown(m.text))); continue; }
        if (m.type !== 'card') continue;
        if (m.template === 'summary_confirm') {
            const fields = (Array.isArray(m.data && m.data.fields) ? m.data.fields : [])
                .filter((f) => f && f.k && f.v && !/^(?:กรุณา|โปรด|ระบุ|-|—|\?)/u.test(String(f.v).trim()))
                .slice(0, 6);
            const nameKey = (SHOP_DEFS[sess.demo_shop].fields || []).find((k) => /^ชื่อ/u.test(k));
            if (nameKey && sess.display_name && fields.length && !fields.some((f) => f.k === nameKey)) fields.splice(Math.max(0, fields.length - 1), 0, { k: nameKey, v: sess.display_name });
            const title = (m.data && m.data.title) || `สรุป${SHOP_DEFS[sess.demo_shop].order_noun} (ร้านตัวอย่าง)`;
            state.order = { title, fields };
            state.step = 'confirm';
            const data = { title, fields: fields.slice(0, 6), status: 'pending', status_label: 'รอเจ้าของร้านยืนยัน', confirm_postback: POSTBACKS.confirm, edit_postback: POSTBACKS.edit };
            const card = cards ? examples.flexMessage(cards, 'summary_confirm', data, ctx, `${title} รอยืนยัน`) : null;
            if (card && card.message) { out.push(markTemplate(card.message, 'summary_confirm')); if (card.quickReplies) response._fallbackQuick = card.quickReplies; continue; }
            out.push(msg.text([title, ...fields.map((f) => `${f.k}: ${f.v}`)].join('\n')));
            response._fallbackQuick = [{ label: 'ยืนยัน', data: POSTBACKS.confirm }, { label: 'ขอแก้ไข', data: POSTBACKS.edit }];
            continue;
        }
        if (m.template === 'offer') { if (m.alt) out.push(msg.text(m.alt)); continue; } // no LhW offers inside a shop demo
        if (cards && m.template) {
            const card = examples.flexMessage(cards, m.template, m.data || {}, ctx, m.alt || null);
            if (card.message) { out.push(markTemplate(card.message, m.template)); if (card.quickReplies) response._fallbackQuick = card.quickReplies; continue; }
        }
        if (m.alt) out.push(msg.text(m.alt));
    }
    if (!out.length) out.push(msg.text(strings.shopFallback));
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
async function runDemoTurn({ input, text, data, session: sess, deps, config, send, persist, done }) {
    const now = deps.clock.now();
    const senders = deps.senders || createSenders(config);
    const shops = shopsFor(deps);
    const shop = shops[sess.demo_shop];
    if (!shop) {
        // state says demo but no shop: hand back to Lay honestly
        exitDemo(sess, now);
        const sent = await send(input, [msg.text(quiet.strings.back)], [{ label: strings.tryOther, data: examples.POSTBACKS.pick }, 'ทำอะไรได้บ้าง'], senders.lay);
        await persist(input, sess, sent, { role: 'lay' });
        return done(sent, 'demo_exit');
    }
    if (data && data.startsWith('DEMO_')) return onDemoPostback({ data, input, session: sess, deps, config, send, persist, done, senders });

    const shopSender = senders.demo(shop);
    const state = stateOf(sess);
    state.turns = (state.turns || 0) + 1;
    const userText = (text || data || '').trim();
    if (!userText) {
        const sent = await send(input, [msg.text(strings.emptyText)], withBack(shop.starters), shopSender);
        await persist(input, sess, sent, { role: 'demo_shop' });
        return done(sent, null);
    }

    const { response } = await askShop({ shop, userText, sess, deps, config, now });

    if (response.action === 'demo_exit') return exitToLay({ input, session: sess, deps, config, send, persist, done, senders, shop });
    if (response.action === 'booking_start' && state.step === 'chat') state.step = 'ordering';
    if (response.action === 'demo_enter') deps.log.info('demo.ignored_model_demo_enter', { userId: sess.user_id, shop: shop.key });

    const messages = renderShopMessages(response, { sess, deps, config });
    const qr = withBack(response._fallbackQuick || response.quick_replies || []);
    const sent = await send(input, messages, qr, shopSender);
    await persist(input, sess, sent, { role: 'demo_shop' });
    return done(sent, null);
}

// ---------------------------------------------------------------------------------------------------------------
async function onDemoPostback({ data, input, session: sess, deps, config, send, persist, done, senders }) {
    const now = deps.clock.now();
    senders = senders || deps.senders || createSenders(config);
    const shops = shopsFor(deps);
    const inDemo = sess.mode === 'demo' && !!shops[sess.demo_shop];

    if (data.startsWith(POSTBACKS.enterPrefix)) {
        const key = data.slice(POSTBACKS.enterPrefix.length);
        if (shops[key]) return greet({ key, shops, input, sess, deps, send, persist, done, senders, now });
        deps.log.warn('demo.unknown_shop', { data });
        return examples.onExamplesPostback({ data: examples.POSTBACKS.pick, input, session: sess, deps, config, send, persist, done, senders });
    }

    if (data === POSTBACKS.confirm || data === POSTBACKS.edit) {
        if (!inDemo) {
            const sent = await send(input, [msg.text(strings.notInDemo)], [{ label: strings.tryOther, data: examples.POSTBACKS.pick }, 'ทำอะไรได้บ้าง'], senders.lay);
            await persist(input, sess, sent, { role: 'lay' });
            return done(sent, null);
        }
        const shop = shops[sess.demo_shop];
        const shopSender = senders.demo(shop);
        const state = stateOf(sess);
        if (data === POSTBACKS.edit) {
            state.step = 'chat';
            const sent = await send(input, [msg.text(strings.edit)], withBack(shop.starters), shopSender);
            await persist(input, sess, sent, { role: 'demo_shop' });
            return done(sent, null);
        }
        if (!state.order) {
            const sent = await send(input, [msg.text(strings.nothingToConfirm)], withBack(shop.starters), shopSender);
            await persist(input, sess, sent, { role: 'demo_shop' });
            return done(sent, null);
        }
        state.step = 'sent';
        state.sent_at = now.toISOString();
        // simulated: nothing notified, nothing stored beyond the session — deps.notifier is deliberately not touched
        const sent = await send(input, [msg.text(strings.sent(shop.order_noun))], withBack([shop.more_label, { label: strings.tryOther, data: examples.POSTBACKS.pick }]), shopSender);
        await persist(input, sess, sent, { role: 'demo_shop' });
        return done(sent, null);
    }

    // DEMO_EXAMPLES · DEMO_PICK · DEMO_THIS_BOT · DEMO_OUR_WORK (and anything unknown → the carousel): Lay content.
    if (inDemo) exitDemo(sess, now);
    const known = Object.values(examples.POSTBACKS).includes(data);
    const r = await examples.onExamplesPostback({ data: known ? data : examples.POSTBACKS.examples, input, session: sess, deps, config, send, persist, done, senders });
    return r;
}

async function greet({ key, shops, input, sess, deps, send, persist, done, senders, now }) {
    enterDemo(sess, key, now);
    const shop = shops[key];
    const sent = await send(input, [msg.text(strings.greeting[key](shop.name_th))], withBack(shop.starters), senders.demo(shop));
    await persist(input, sess, sent, { role: 'demo_shop' });
    return done(sent, 'demo_enter');
}

// ---------------------------------------------------------------------------------------------------------------
// Lay's exit line: one sentence on what they saw + the symptom question as a choice card (brief §3.4 keys).
async function exitToLay({ input, session: sess, deps, config, send, persist, done, senders, shop }) {
    const now = deps.clock.now();
    const state = stateOf(sess);
    const hadOrder = state.step === 'sent' || !!state.order;
    const key = (shop && shop.key) || sess.demo_shop || 'cafe';
    exitDemo(sess, now);
    session.unionTopics(sess, ['proof']);
    const cards = deps.cards || lazyCards();
    const ctx = examples.cardContext(deps.pack, config, deps.log);
    const text = `${(strings.exitSeen[key] || strings.exitSeen.cafe)[hadOrder ? 'order' : 'chat']}\n${strings.exitAsk}`;
    const messages = [msg.text(text)];
    let qr = [{ label: strings.tryOther, data: examples.POSTBACKS.pick }, 'ราคาเท่าไหร่', 'เริ่มยังไง'];
    const card = cards ? examples.flexMessage(cards, 'choice', symptomChoice(), ctx, strings.symptomTitle) : null;
    if (card && card.message) { messages.push(markTemplate(card.message, 'choice')); }
    else if (card && card.quickReplies) { messages.push(card.message); qr = card.quickReplies; }
    const sent = await send(input, messages, qr, senders.lay);
    await persist(input, sess, sent, { role: 'lay' });
    return done(sent, 'demo_exit');
}

function symptomChoice() {
    return { title: strings.symptomTitle, options: SYMPTOMS.map((s, i) => ({ label: s.label, postback: `FIT_${s.key}`, primary: i === 0 })) };
}

// Model-proposed demo actions. demo_enter is honoured only on a clear shop pick in the customer's own words.
async function onModelAction({ action, response, input, session: sess, deps, config, send, persist, done, senders }) {
    const now = deps.clock.now();
    senders = senders || deps.senders || createSenders(config);
    const shops = shopsFor(deps);
    if (action === 'demo_enter') {
        const key = input.kind === 'postback' && String(input.data || '').startsWith(POSTBACKS.enterPrefix) ? String(input.data).slice(POSTBACKS.enterPrefix.length) : shopFromText(input.text);
        if (key && shops[key]) return greet({ key, shops, input, sess, deps, send, persist, done, senders, now });
        deps.log.info('demo.ignored_model_demo_enter', { userId: sess.user_id, text: String(input.text || '').slice(0, 80) });
        return examples.onExamplesPostback({ data: examples.POSTBACKS.pick, input, session: sess, deps, config, send, persist, done, senders });
    }
    if (action === 'demo_exit') {
        if (sess.mode === 'demo') return exitToLay({ input, session: sess, deps, config, send, persist, done, senders, shop: shops[sess.demo_shop] });
        const first = (response && response.messages || []).find((m) => m.type === 'text' && m.text && m.text.trim());
        const sent = await send(input, [msg.text(first ? lint.stripMarkdown(first.text) : strings.alreadyLay)], (response && response.quick_replies && response.quick_replies.length ? response.quick_replies : ['ทำอะไรได้บ้าง', 'ราคาเท่าไหร่']).slice(0, QUICK_MAX), senders.lay);
        await persist(input, sess, sent, { role: 'lay', response });
        return done(sent, null);
    }
    throw new Error(`demo.onModelAction: unknown action ${action}`);
}

module.exports = { oneQuestionAtATime, demoShops, enterDemo, exitDemo, runDemoTurn, onDemoPostback, onModelAction, exitToLay, shopFromText, withBack, symptomChoice, strings, BACK_LABEL, POSTBACKS, SYMPTOMS, SHOP_DEFS };
