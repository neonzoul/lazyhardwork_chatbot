// "ขอดูตัวอย่าง" (design §7, brief §3.7). The carousel, "บอทตัวนี้", "งานของเรา" and the shop picker are fixed
// content (no model): the words come from the KB pack's `examples.carousel.*` sections when present, else from
// `strings` below. Every image goes through `ctx.assets[image_key]` → `public/assets/examples-<key>.png` (placeholders
// until Mos replaces them — see doc/demo.md).
//
//   examplesCarousel(pack, config)        → card data for the `examples` template (4 items)
//   examplesAssets(config)                → { image_key → https url } to merge into pack.assets (app wiring)
//   onExamplesPostback({ data, ... })     → handles DEMO_EXAMPLES · DEMO_PICK · DEMO_THIS_BOT · DEMO_OUR_WORK
//   cardContext(pack, config, log)        → ctx for cards/render (assets, fastworkUrlFor, priceFor)

const msg = require('../line/messages');
const lint = require('../core/lint');

const DEFAULT_FASTWORK = null; // no invented handle (D-19): the Fastwork item is dropped when no URL is configured

const POSTBACKS = {
    examples: 'DEMO_EXAMPLES',
    pick: 'DEMO_PICK',
    thisBot: 'DEMO_THIS_BOT',
    ourWork: 'DEMO_OUR_WORK',
    enterCafe: 'DEMO_ENTER_cafe',
    enterClinic: 'DEMO_ENTER_clinic',
};

// image_key (as written in kb/examples.md) → file under public/assets
const IMAGE_FILES = {
    demo_shops: 'examples-demo-shops.png',
    this_bot: 'examples-this-bot.png',
    our_work: 'examples-our-work.png',
    kv_premium: 'examples-kv-premium.png',
    lhw_workspace: 'examples-lhw-workspace.png',
    fastwork_profile: 'examples-fastwork-profile.png',
};

const strings = {
    carouselTitle: 'ตัวอย่างงาน',
    carouselIntro: 'ตัวอย่างมี 4 แบบครับ เลื่อนดูแล้วกดอันที่อยากเห็นได้เลย',
    items: {
        demoShops: { title: 'ลองเป็นลูกค้าร้านตัวอย่าง', line: 'ลองสั่งกาแฟหรือจองคิวคลินิกกับบอทของร้านตัวอย่าง แล้วดูว่าบอทรับงานให้ร้านจนจบได้ยังไง', cta: 'ลองเลย' },
        thisBot: { title: 'บอทตัวนี้', line: 'ตัวอย่างที่ใกล้ที่สุดคือ Lay ที่พี่คุยอยู่ตอนนี้ บอทที่ LazyHardWork ใช้จริงกับลูกค้าของตัวเอง', cta: 'ดู 3 ข้อ' },
        ourWork: { title: 'งานของเรา (ตัวอย่าง)', line: 'ระบบงานภายในของธุรกิจค้าส่ง และ AI Workspace ของ LazyHardWork เอง ภาพใช้ข้อมูลสมมติทั้งหมด', cta: 'ดูงานของเรา' },
        fastwork: { title: 'โปรไฟล์และรีวิวบน Fastwork', line: 'ดูผลงาน รีวิว และการ์ดบริการทั้งหมดได้ที่โปรไฟล์ Fastwork ของ LazyHardWork การตกลงงานและจ่ายเงินทำที่นั่น', cta: 'เปิด Fastwork' },
    },
    pickTitle: 'อยากลองเป็นลูกค้าร้านไหนครับ',
    pickSubtitle: 'ทั้งสองร้านเป็นร้านสมมติ ไม่รับออเดอร์จริง ไม่เก็บข้อมูลจริง',
    pickOptions: { cafe: 'ร้านกาแฟตัวอย่าง', clinic: 'คลินิกความงามตัวอย่าง' },
    pickIntro: 'ได้เลยครับ เลือกร้านที่อยากลองก่อน แล้วบอทของร้านนั้นจะมาคุยกับพี่เอง',
    thisBotIntro: 'ตัวอย่างที่ใกล้ที่สุดคือผมเองครับ ตอนนี้ Lay ทำให้ LazyHardWork อยู่ 3 อย่าง',
    thisBot: {
        title: 'สิ่งที่ Lay ทำให้ LazyHardWork ตอนนี้',
        rows: [
            { k: 'ตอบคำถาม', v: 'ตอบเรื่องเบื้องต้นจากคลังความรู้ของ LazyHardWork เท่านั้น ทำอะไรได้ เหมาะกับใคร ราคาเริ่มต้น เริ่มยังไง และยอมบอกเมื่อไม่รู้' },
            { k: 'เก็บเรื่องราว', v: 'เก็บเรื่องของลูกค้าให้มอสอ่านก่อนคุยต่อ ธุรกิจอะไร ติดตรงไหน งานอยู่ในเครื่องมืออะไร โดยถามทีละข้อเท่าที่ยังไม่รู้' },
            { k: 'ส่งต่อให้มอส', v: 'ส่งต่อเมื่อถึงเวลา เช่น ขอราคาเป๊ะ อยากคุยกับคน หรือจองคิวคุย 30 นาที แล้วรอมอสยืนยัน ไม่เงียบหาย ไม่รับปากแทนมอส' },
        ],
        note: 'พี่กำลังคุยกับตัวอย่างนี้อยู่ครับ',
    },
    textOnly: {
        examples: 'ดูตัวอย่างได้ 3 แบบครับ ลองเป็นลูกค้าร้านตัวอย่าง ดูว่าบอทตัวนี้ทำอะไรให้ LazyHardWork หรือดูงานของเราเอง กดเลือกด้านล่างได้เลย',
        pick: 'ลองร้านตัวอย่าง', thisBot: 'บอทตัวนี้ทำอะไร', ourWork: 'งานของเรา', fastwork: 'โปรไฟล์ Fastwork',
        ourWorkList: 'ชิ้นแรกคือระบบงานภายในของธุรกิจค้าส่ง รวมรายการสินค้าและสถานะงานไว้ที่เดียว ชิ้นที่สองคือ AI Workspace ที่มอสใช้ทุกวัน ไฟล์ที่จัดแล้ว กฎ และชุดคำสั่งที่ AI อ่านจากไฟล์จริง',
        wantKv: 'อยากได้ระบบงานภายใน', wantWs: 'อยากได้ AI Workspace',
    },
    ourWorkIntro: 'งานของเราเองครับ ทุกภาพใช้ข้อมูลสมมติ ไม่มีข้อมูลธุรกิจหรือลูกค้าจริง',
    ourWork: {
        title: 'งานของเรา (ตัวอย่าง)',
        kv: { title: 'ระบบงานภายในค้าส่ง (ตัวอย่าง)', line: 'รวมรายการสินค้าและสถานะงานไว้ที่เดียว ทีมขายและเจ้าของเห็นชุดเดียวกัน ไม่ต้องถามกันในแชท', cta: 'อยากได้แบบนี้', postback: 'WANT_scattered_data' },
        workspace: { title: 'AI Workspace ของ LazyHardWork', line: 'โฟลเดอร์ที่จัดแล้ว ไฟล์กฎ และชุดคำสั่งที่มอสใช้ทุกวัน สั่ง "สรุปสัปดาห์นี้" แล้ว AI อ่านจากไฟล์จริง', cta: 'อยากได้แบบนี้', postback: 'WANT_ai_know_my_work' },
    },
    alts: { carousel: 'ตัวอย่างงาน 4 แบบ กดดูได้เลย', pick: 'เลือกร้านตัวอย่างที่อยากลอง', thisBot: 'สิ่งที่ Lay ทำให้ LazyHardWork ตอนนี้ 3 อย่าง', ourWork: 'งานของเรา (ตัวอย่าง) 2 ชิ้น' },
    quickAfter: { pick: 'ลองร้านตัวอย่าง', fit: 'เหมาะกับงานผมไหม', pricing: 'ราคาเท่าไหร่', start: 'เริ่มยังไง' },
};

// ---------------------------------------------------------------------------------------------------------------
// pack helpers (sections may be a Map, an array or an object — see core/policy.sectionEntries)
function sectionText(pack, id) {
    const s = pack && pack.sections;
    if (!s) return null;
    let v = null;
    if (s instanceof Map) v = s.get(id);
    else if (Array.isArray(s)) v = s.find((x) => x && x.id === id);
    else if (typeof s === 'object') v = s[id];
    if (!v) return null;
    return typeof v === 'string' ? v : (v.text || v.body || null);
}

// "key: value" lines of a carousel section → object
function kvLines(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = line.match(/^([a-z_]+):\s*(.+?)\s*$/u);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

function fastworkUrl(config, pack) {
    const u = (config && config.contact && config.contact.fastworkUrl) || (pack && pack.fastworkUrl) || DEFAULT_FASTWORK;
    return u && /^https:\/\//.test(u) ? u : null;
}

// The images in public/assets are placeholders until Mos replaces them. No placeholder art goes to customers
// (head review 19 Oct): without EXAMPLES_IMAGES_READY=1 there are no image assets and the carousels become a text
// line with quick replies instead.
function imagesReady(config) { return !!(config && config.examplesImagesReady); }
function examplesAssets(config) {
    if (!imagesReady(config)) return {};
    const base = (config && config.publicBaseUrl) || '';
    if (!/^https:\/\//.test(base)) return {};
    return Object.fromEntries(Object.entries(IMAGE_FILES).map(([k, f]) => [k, `${base}/assets/${f}`]));
}

function cardContext(pack, config, log) {
    return {
        assets: { ...examplesAssets(config), ...((pack && pack.assets) || {}) },
        fastworkUrlFor: (cardId) => (pack && pack.fastworkUrls && pack.fastworkUrls[cardId]) || fastworkUrl(config, pack),
        priceFor: () => ({ price_from: null, label_th: 'ราคาเริ่มต้น ปรับตามขอบเขตจริงหลังคุย' }),
        log: log || { warn() {} },
    };
}

// ---------------------------------------------------------------------------------------------------------------
function examplesCarousel(pack, config) {
    const kb = (id) => kvLines(sectionText(pack, `examples.carousel.${id}`));
    const shops = kb('demo-shops'); const bot = kb('this-bot'); const fw = kb('fastwork-profile');
    const S = strings.items;
    return {
        title: strings.carouselTitle,
        items: [
            { image_key: 'demo_shops', title: shops.title || S.demoShops.title, line: shops.line || S.demoShops.line, cta: { label: S.demoShops.cta, postback: POSTBACKS.pick } },
            { image_key: 'this_bot', title: bot.title || S.thisBot.title, line: bot.line || S.thisBot.line, cta: { label: S.thisBot.cta, postback: POSTBACKS.thisBot } },
            { image_key: 'our_work', title: S.ourWork.title, line: S.ourWork.line, cta: { label: S.ourWork.cta, postback: POSTBACKS.ourWork } },
            ...(fastworkUrl(config, pack) ? [{ image_key: 'fastwork_profile', title: fw.title || S.fastwork.title, line: fw.line || S.fastwork.line, cta: { label: S.fastwork.cta, uri: fastworkUrl(config, pack) } }] : []),
        ],
    };
}

function shopPicker() {
    return {
        title: strings.pickTitle,
        subtitle: strings.pickSubtitle,
        options: [
            { label: strings.pickOptions.cafe, postback: POSTBACKS.enterCafe, primary: true },
            { label: strings.pickOptions.clinic, postback: POSTBACKS.enterClinic },
        ],
    };
}

function thisBotCard() { return { title: strings.thisBot.title, rows: strings.thisBot.rows, note: strings.thisBot.note }; }

function ourWorkCarousel(pack) {
    const kv = kvLines(sectionText(pack, 'examples.carousel.kv-premium'));
    const ws = kvLines(sectionText(pack, 'examples.carousel.lhw-workspace'));
    const W = strings.ourWork;
    return {
        title: W.title,
        items: [
            { image_key: 'kv_premium', title: W.kv.title, line: kv.line || W.kv.line, cta: { label: W.kv.cta, postback: W.kv.postback } },
            { image_key: 'lhw_workspace', title: W.workspace.title, line: ws.line || W.workspace.line, cta: { label: W.workspace.cta, postback: W.workspace.postback } },
        ],
    };
}

// A Flex message with the template recorded the way turn.js does (scenario runner reads contents._template).
function flexMessage(cards, template, data, ctx, alt) {
    const r = cards.render({ template, alt: alt || null, data }, ctx);
    if (r.message) {
        const m = msg.flex(r.message);
        Object.defineProperty(m, '_template', { value: template, enumerable: false });
        if (m.contents) Object.defineProperty(m.contents, '_template', { value: template, enumerable: false });
        return { message: m, quickReplies: null };
    }
    // the card was dropped: the choice still goes out as buttons, never as prose (doc/cards.md "fallback rule")
    const fb = r.fallback || { text: data.title || '', quick_replies: [] };
    return { message: msg.text(lint.stripMarkdown(fb.text || data.title || '…')), quickReplies: (fb.quick_replies || []).map((q) => (q.uri ? { label: q.label, uri: q.uri } : { label: q.label, data: q.data })) };
}

function lazyCards() { try { return require('../cards/render'); } catch { return null; } }

// ---------------------------------------------------------------------------------------------------------------
// Postbacks outside demo mode (turn.js step 8 routes every DEMO_* here through flows/demo.onDemoPostback).
// Returns null for data it does not own.
async function onExamplesPostback({ data, input, session, deps, config, send, persist, done, senders }) {
    const cards = (deps && deps.cards) || lazyCards();
    const pack = deps && deps.pack;
    const ctx = cardContext(pack, config, deps && deps.log);
    const lay = senders.lay;
    const unionProof = () => { const set = new Set(session.topics_covered || []); set.add('proof'); session.topics_covered = [...set]; };

    if (data === POSTBACKS.examples && !imagesReady(config)) {
        unionProof();
        const qr = [{ label: strings.textOnly.pick, data: POSTBACKS.pick }, { label: strings.textOnly.thisBot, data: POSTBACKS.thisBot }, { label: strings.textOnly.ourWork, data: POSTBACKS.ourWork }];
        const fw = fastworkUrl(config, pack);
        if (fw) qr.push({ label: strings.textOnly.fastwork, uri: fw });
        const sent = await send(input, [msg.text(strings.textOnly.examples)], qr, lay);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    if (data === POSTBACKS.examples) {
        unionProof();
        const card = flexMessage(cards, 'examples', examplesCarousel(pack, config), ctx, strings.alts.carousel);
        const qr = card.quickReplies || [{ label: strings.quickAfter.pick, data: POSTBACKS.pick }, strings.quickAfter.fit, strings.quickAfter.pricing];
        const sent = await send(input, [msg.text(strings.carouselIntro), card.message], qr, lay);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    if (data === POSTBACKS.pick) {
        unionProof();
        const card = flexMessage(cards, 'choice', shopPicker(), ctx, strings.alts.pick);
        const qr = card.quickReplies || [strings.quickAfter.fit, strings.quickAfter.pricing];
        const sent = await send(input, [msg.text(strings.pickIntro), card.message], qr, lay);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    if (data === POSTBACKS.thisBot) {
        unionProof();
        const card = flexMessage(cards, 'info', thisBotCard(), ctx, strings.alts.thisBot);
        const qr = card.quickReplies || [{ label: strings.quickAfter.pick, data: POSTBACKS.pick }, strings.quickAfter.fit, strings.quickAfter.pricing];
        const sent = await send(input, [msg.text(strings.thisBotIntro), card.message], qr, lay);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    if (data === POSTBACKS.ourWork && !imagesReady(config)) {
        unionProof();
        const W = strings.ourWork;
        const qr = [{ label: strings.textOnly.wantKv, data: W.kv.postback }, { label: strings.textOnly.wantWs, data: W.workspace.postback }, { label: strings.quickAfter.pick, data: POSTBACKS.pick }];
        const sent = await send(input, [msg.text(strings.ourWorkIntro), msg.text(strings.textOnly.ourWorkList)], qr, lay);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    if (data === POSTBACKS.ourWork) {
        unionProof();
        const card = flexMessage(cards, 'examples', ourWorkCarousel(pack), ctx, strings.alts.ourWork);
        const qr = card.quickReplies || [{ label: strings.quickAfter.pick, data: POSTBACKS.pick }, strings.quickAfter.fit, strings.quickAfter.start];
        const sent = await send(input, [msg.text(strings.ourWorkIntro), card.message], qr, lay);
        await persist(input, session, sent, { role: 'lay' });
        return done(sent, null);
    }
    return null;
}

module.exports = { examplesCarousel, examplesAssets, shopPicker, thisBotCard, ourWorkCarousel, onExamplesPostback, cardContext, flexMessage, sectionText, strings, POSTBACKS, IMAGE_FILES, DEFAULT_FASTWORK };
