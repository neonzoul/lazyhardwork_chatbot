// "เหมาะกับงานผมไหม" by symptom (brief §3.4, design §4 "Fit by symptom", flow §4).
// Five symptoms, each mapped to a card. The tap is a postback `FIT_<key>`; the code stores the choice
// (draft.symptom / draft.card / draft.tier) and hands the model a hint so it answers "their day" from the
// fit-map section and ends on the matching offer. The symptom is never asked again.

const SYMPTOMS = [
    { key: 'chat_overload', label: 'ตอบแชทลูกค้าไม่ทัน', card: 'A2', kbRef: 'fit.chat-overload',
        re: /ตอบ(?:แชท|ลูกค้า|ไม่ทัน)|แชท(?:เยอะ|ล้น|ไม่ทัน)|ลูกค้าถามซ้ำ|ตอบไม่ไหว|ตอบไม่ทัน/u },
    { key: 'scattered_data', label: 'ข้อมูลกระจาย ต้องตามงานเอง', card: 'A1', kbRef: 'fit.data-scattered',
        re: /ข้อมูลกระจาย|ข้อมูลอยู่หลายที่|ตามงานเอง|ตามงานไม่ทัน|หาข้อมูลไม่เจอ|กระจัดกระจาย/u },
    { key: 'repetitive_work', label: 'งานซ้ำ คีย์ซ้ำทุกวัน', card: 'A3', kbRef: 'fit.repetitive-work',
        re: /งานซ้ำ|คีย์ซ้ำ|คีย์ข้อมูล|ทำซ้ำทุกวัน|งานเดิมๆ|copy|ก็อปวาง|กรอกซ้ำ/iu },
    { key: 'ai_know_my_work', label: 'อยากให้ AI รู้จักงานผม', card: 'A4', kbRef: 'fit.ai-knows-my-work',
        re: /ai\s*รู้จัก(?:งาน|ธุรกิจ|ร้าน)|ให้\s*ai\s*(?:เข้าใจ|รู้)งาน|ตั้งค่า\s*ai|เซ็ต\s*ai|workspace/iu },
    { key: 'dont_know_where_to_start', label: 'ยังไม่รู้จะเริ่มตรงไหน', card: 'C1', kbRef: 'fit.where-to-start',
        re: /ไม่รู้(?:จะ)?เริ่ม(?:ตรงไหน|ยังไง|จากไหน)|เริ่มไม่ถูก|ยังไม่รู้ว่าต้องการอะไร|ไม่รู้ว่าเหมาะกับอะไร/u },
];
const BY_KEY = Object.fromEntries(SYMPTOMS.map((s) => [s.key, s]));
const POSTBACK_PREFIX = 'FIT_';

const strings = {
    cardTitle: 'งานของคุณเป็นแบบไหนครับ',
    cardSubtitle: 'เลือกอาการที่ใกล้เคียงที่สุด เดี๋ยวผมเล่าให้ฟังว่าช่วยตรงไหนได้',
    cardAlt: 'เหมาะกับงานผมไหม — เลือกอาการที่ตรงกับคุณ',
    chosen: (label) => `เลือกอาการ: ${label}`,
};

function postbackFor(key) { return `${POSTBACK_PREFIX}${key}`; }
function keyFromPostback(data) {
    if (typeof data !== 'string' || !data.startsWith(POSTBACK_PREFIX)) return null;
    const key = data.slice(POSTBACK_PREFIX.length);
    return BY_KEY[key] ? key : null;
}

// The `choice` card (cards/render template) — options are the five symptoms as postbacks.
function fitChoiceCard() {
    return {
        template: 'choice',
        alt: strings.cardAlt,
        data: {
            title: strings.cardTitle,
            subtitle: strings.cardSubtitle,
            options: SYMPTOMS.map((s, i) => ({ label: s.label, postback: postbackFor(s.key), primary: i === 0 })),
        },
    };
}

function alreadyChosen(session) { return !!(session && session.draft && session.draft.symptom); }

// Loose matching for a typed symptom (or the button label typed back). Returns the key or null.
function symptomFromText(text) {
    if (!text) return null;
    const t = String(text).trim();
    for (const s of SYMPTOMS) if (t === s.label || t === strings.chosen(s.label)) return s.key;
    for (const s of SYMPTOMS) if (s.re.test(t)) return s.key;
    return null;
}

// Record the choice on the session (pure, synchronous). Returns the symptom row.
function chooseSymptom(session, key) {
    const s = BY_KEY[key];
    if (!s) return null;
    session.draft = session.draft || {};
    session.draft.symptom = s.key;
    session.draft.card = s.card;
    session.draft.tier = 'T1';
    session.draft.fit_ref = s.kbRef;
    session.intent_hints = [...new Set([...(session.intent_hints || []), 'fit'])];
    return s;
}

// Hook called by core/turn step 8 for `FIT_*` postbacks → { intentHint, userText }.
// The model then answers "their day" (fit-map section is selected by intentHint 'fit' + draft.card).
function onSymptomPostback(data, session) {
    const key = keyFromPostback(data);
    if (!key) return { intentHint: 'unknown', userText: String(data || '') };
    const s = chooseSymptom(session, key);
    return { intentHint: 'fit', userText: strings.chosen(s.label) };
}

function symptomLabel(key) { return BY_KEY[key] ? BY_KEY[key].label : null; }
function cardForSymptom(key) { return BY_KEY[key] ? BY_KEY[key].card : null; }

module.exports = { SYMPTOMS, BY_KEY, POSTBACK_PREFIX, strings, fitChoiceCard, onSymptomPostback, symptomFromText, alreadyChosen, chooseSymptom, keyFromPostback, postbackFor, symptomLabel, cardForSymptom };
