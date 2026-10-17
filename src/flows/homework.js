// Homework pack gathered naturally (brief §3.5, design §4 "Homework"). Seven fields; the model fills what the
// customer already said (lead_updates → session.homework); this module decides the ONE next gap to ask, with
// buttons where the answer set is small, and when an ending must be offered (≤ 4 questions).
//
//   nextQuestion(session)      → { field, text, options?: [{label, value}] } | null
//   readyForEnding(session)    → questions_asked ≥ 4 OR the key gaps (business, problem_verbatim, preferred_contact) filled
//   answerFromButton(text)     → { field, value } | null   (a tapped option label back to its field)
//   applyAnswer(session, field, value) → true when stored
//   homeworkSummary(session)   → Thai text for the Discord thread (never phone / name / email)

const MAX_QUESTIONS = 4;
const KEY_GAPS = ['business', 'problem_verbatim', 'preferred_contact'];
// Order asked: what Mos needs to read first, then the shape of the work, then logistics.
const ORDER = ['problem_verbatim', 'business', 'where_work_lives', 'team_size', 'maintainer', 'preferred_contact', 'urgency'];

const FIELDS = {
    problem_verbatim: {
        label: 'เรื่องที่อยากให้ช่วย',
        text: 'เล่าสั้นๆ ได้ไหมครับว่าตอนนี้อยากให้ช่วยเรื่องไหนมากที่สุด\nพิมพ์สั้นๆ ก็พอครับ เดี๋ยวคุยรายละเอียดกันอีกที',
    },
    business: {
        label: 'ธุรกิจ',
        text: 'ธุรกิจของคุณทำอะไรครับ พิมพ์สั้นๆ ได้เลย เช่น ร้านอาหาร คลินิก ขายของออนไลน์',
    },
    where_work_lives: {
        label: 'งานและข้อมูลอยู่ที่ไหน',
        text: 'ตอนนี้งานหรือข้อมูลส่วนใหญ่อยู่ที่ไหนครับ',
        options: ['LINE', 'Google Sheets·Excel', 'POS·ระบบอื่น', 'กระดาษ·หัวคน'],
    },
    team_size: {
        label: 'ขนาดทีม',
        text: 'ทีมที่ทำงานส่วนนี้มีกี่คนครับ',
        options: ['1 คน', '2–5', '6–15', 'มากกว่า 15'],
    },
    maintainer: {
        label: 'คนดูแลระบบต่อ',
        text: 'ถ้ามีระบบแล้ว ใครจะเป็นคนดูแลต่อครับ',
        options: ['ผมเอง', 'มีคนในทีม', 'ยังไม่แน่ใจ'],
    },
    preferred_contact: {
        label: 'สะดวกติดต่อแบบไหน',
        text: 'สะดวกคุยกับมอสแบบไหนครับ',
        options: ['โทร', 'นัดประชุม', 'แชทต่อ'],
    },
    urgency: {
        label: 'ความเร่งด่วน',
        text: 'อยากเริ่มช่วงไหนครับ',
        options: ['เริ่มเร็วที่สุด', 'ภายใน 1 เดือน', 'แค่ดูข้อมูลก่อน'],
    },
};
const HOMEWORK_FIELDS = ORDER.slice();

// Optional fields the model may fill but Lay never asks for (brief §3.5: "urgency/budget if volunteered").
const VOLUNTEERED_ONLY = ['budget_frame', 'came_from'];

function hw(session) { return (session && session.homework) || {}; }
function missing(session) { return ORDER.filter((f) => !hw(session)[f]); }
function keyGapsFilled(session) { return KEY_GAPS.every((f) => !!hw(session)[f]); }

function readyForEnding(session) {
    return (session.questions_asked || 0) >= MAX_QUESTIONS || keyGapsFilled(session);
}

// The single next gap, or null when nothing is missing / the budget is spent.
function nextQuestion(session, { fields = ORDER } = {}) {
    if ((session.questions_asked || 0) >= MAX_QUESTIONS) return null;
    const h = hw(session);
    const field = fields.find((f) => FIELDS[f] && !h[f]);
    if (!field) return null;
    return questionFor(field);
}

function questionFor(field) {
    const def = FIELDS[field];
    if (!def) return null;
    const q = { field, text: def.text };
    if (def.options) q.options = def.options.map((label) => ({ label, value: label }));
    return q;
}

// A tapped button label → the field it answers. Labels are unique across fields by construction.
function answerFromButton(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    for (const [field, def] of Object.entries(FIELDS)) {
        if (def.options && def.options.includes(t)) return { field, value: t };
    }
    return null;
}

function applyAnswer(session, field, value) {
    if (!FIELDS[field] && !VOLUNTEERED_ONLY.includes(field)) return false;
    const v = String(value || '').trim();
    if (!v) return false;
    session.homework = session.homework || {};
    session.homework[field] = v;
    return true;
}

function countQuestion(session) { session.questions_asked = (session.questions_asked || 0) + 1; return session.questions_asked; }

// Discord summary: the seven fields in Mos's reading order, free text clipped, never a phone/email/name.
const PHONE_RE = /(?:\+?66|0)\s?\d(?:[\s-]?\d){7,9}/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
function scrub(v) { return String(v).replace(PHONE_RE, '[เบอร์]').replace(EMAIL_RE, '[อีเมล]').slice(0, 200); }

function homeworkSummary(session) {
    const h = hw(session);
    const lines = ORDER.filter((f) => h[f]).map((f) => `${FIELDS[f].label}: ${scrub(h[f])}`);
    for (const f of VOLUNTEERED_ONLY) if (h[f]) lines.push(`${f === 'budget_frame' ? 'กรอบงบ' : 'มาจาก'}: ${scrub(h[f])}`);
    const gaps = missing(session);
    if (gaps.length) lines.push(`ยังไม่ได้ถาม: ${gaps.map((f) => FIELDS[f].label).join(', ')}`);
    return lines.join('\n') || 'ยังไม่มีข้อมูลการบ้าน';
}

module.exports = { FIELDS, ORDER, HOMEWORK_FIELDS, KEY_GAPS, MAX_QUESTIONS, VOLUNTEERED_ONLY, nextQuestion, questionFor, readyForEnding, answerFromButton, applyAnswer, countQuestion, missing, keyGapsFilled, homeworkSummary };
