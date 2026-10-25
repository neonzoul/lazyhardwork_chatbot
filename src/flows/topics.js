// The six carried questions, the follow-up map and the loose-ends check (flow §2–§3, brief §3.3).
const TOPIC_LABELS = {
    capability: 'ทำอะไรได้บ้าง',
    fit: 'เหมาะกับงานผมไหม',
    pricing: 'ราคาเท่าไหร่',
    timeline: 'ใช้เวลานานไหม',
    proof: 'ขอดูตัวอย่าง',
    howtostart: 'เริ่มยังไง',
};
const LABEL_TO_TOPIC = Object.fromEntries(Object.entries(TOPIC_LABELS).map(([k, v]) => [v, k]));
// Variants a person types (or old labels) → topic
const TOPIC_PATTERNS = [
    ['pricing', /ราคา|เท่าไหร่|กี่บาท|แพง|ถูก/u],
    ['timeline', /นานไหม|กี่วัน|กี่สัปดาห์|ใช้เวลา|เสร็จเมื่อไหร่/u],
    ['proof', /ตัวอย่าง|ผลงาน|เคส|เดโม|demo|ลองเล่น/iu],
    ['howtostart', /เริ่มยังไง|เริ่มต้นยังไง|สนใจ(?:จ้าง|ทำ)|อยากเริ่ม|นัดคุย|ขั้นตอน/u],
    ['fit', /เหมาะ(?:กับ)?(?:ร้าน|งาน|ธุรกิจ)|ร้านแบบ|ธุรกิจแบบ|ใช้ได้ไหม/u],
    ['capability', /ทำอะไรได้|ทำได้บ้าง|ช่วยอะไร|บริการ(?:อะไร|ไหน)/u],
];

const FOLLOW_UP = {
    capability: ['fit', 'pricing'],
    fit: ['pricing', 'howtostart'],
    pricing: ['timeline', 'howtostart'],
    timeline: ['pricing', 'howtostart'],
    proof: ['fit', 'pricing'],
    howtostart: [],               // enters the booking/ending flow
    _fallback: ['pricing', 'howtostart'],
};

const CLOSING_RE = /^\s*(?:ขอบคุณ(?:ครับ|ค่ะ|มาก|มากครับ|มากค่ะ|นะ|นะครับ)?|โอเค(?:ครับ|ค่ะ)?|ok(?:ay)?|ได้(?:ครับ|ค่ะ)|เดี๋ยวคิดดูก่อน(?:นะ|ครับ)?|ขอคิดดูก่อน(?:ครับ)?|ครับ|ค่ะ|รับทราบ(?:ครับ)?|เข้าใจแล้ว(?:ครับ)?)\s*[.!]*\s*$/iu;

function topicFromText(text) {
    if (!text) return null;
    const t = text.trim();
    if (LABEL_TO_TOPIC[t]) return LABEL_TO_TOPIC[t];
    for (const [topic, re] of TOPIC_PATTERNS) if (re.test(t)) return topic;
    return null;
}

// Next two questions, excluding what is already covered. Returns topic keys.
function nextTopics(lastTopic, covered = []) {
    const c = new Set(covered);
    const primary = (FOLLOW_UP[lastTopic] || FOLLOW_UP._fallback).filter((t) => !c.has(t));
    if (primary.length >= 2) return primary.slice(0, 2);
    const extra = Object.keys(TOPIC_LABELS).filter((t) => !c.has(t) && !primary.includes(t) && t !== lastTopic && t !== 'howtostart');
    return [...primary, ...extra].slice(0, 2);
}

function nextQuickReplies(lastTopic, covered = []) {
    return nextTopics(lastTopic, covered).map((t) => TOPIC_LABELS[t]);
}

function isClosingSignal(text) { return CLOSING_RE.test(text || ''); }

function uncoveredTopics(covered = []) {
    const c = new Set(covered);
    return Object.keys(TOPIC_LABELS).filter((t) => !c.has(t) && t !== 'howtostart');
}

// Loose-ends check (flow §3.4) — fires once per session when ≥2 topics covered and a closing signal arrives.
function looseEndsReply(covered = []) {
    const un = uncoveredTopics(covered).slice(0, 2);
    if (un.length === 0) {
        return { text: 'ยินดีครับ ถ้าเคลียร์แล้ว นัดคุยฟรีกับมอส 30 นาทีได้เลยครับ', quickReplies: ['นัดคุยกับมอส'] };
    }
    const names = un.map((t) => TOPIC_LABELS[t]);
    const text = un.length === 2
        ? `ยินดีครับ อีก 2 เรื่องที่คนมักถามก่อนตัดสินใจคือ ${names[0]} กับ ${names[1]}\nสนใจดูไหมครับ หรือถ้าเคลียร์แล้ว นัดคุยกับมอสได้เลย`
        : `ยินดีครับ อีกเรื่องที่คนมักถามก่อนตัดสินใจคือ ${names[0]}\nสนใจดูไหมครับ หรือถ้าเคลียร์แล้ว นัดคุยกับมอสได้เลย`;
    return { text, quickReplies: [...names, 'นัดคุยกับมอส'] };
}

function shouldLooseEnds(session, text) {
    return !session.loose_ends_fired && (session.topics_covered || []).length >= 2 && isClosingSignal(text);
}

module.exports = { TOPIC_LABELS, LABEL_TO_TOPIC, FOLLOW_UP, topicFromText, nextTopics, nextQuickReplies, isClosingSignal, uncoveredTopics, looseEndsReply, shouldLooseEnds };
