// Pure formatters for what goes to Discord (design §6.2, brief §3.8, Discord workspace brief §1).
// Rule: Discord is a third-party service. Never phone, email, LINE userId or display name — the lead id only.
// Everything here is a pure function of its arguments; no I/O, no config.

const TITLE_MAX = 90;
const QUESTION_MAX = 300;
const FIELD_MAX = 120;

const KIND_LABEL = {
    handoff_human: 'คุยกับคน',
    handoff_scope: 'ราคาพิเศษ·นอกขอบเขต',
    handoff_unknown: 'คำถามที่ Lay ตอบไม่ได้',
    booking: 'นัดคุย',
};

const HOMEWORK_LABELS = [
    ['business', 'ธุรกิจ'],
    ['problem_verbatim', 'ปัญหา'],
    ['where_work_lives', 'งานอยู่ที่'],
    ['team_size', 'ทีม'],
    ['maintainer', 'คนดูแลต่อ'],
    ['urgency', 'ความเร่งด่วน'],
    ['preferred_contact', 'ช่องทางที่สะดวก'],
];

const HOW_TO_REPLY = [
    'วิธีตอบ',
    '• พิมพ์ข้อความธรรมดาในเธรดนี้ → ลูกค้าได้รับในนาม "มอส"',
    '• ให้ Lay กลับมาดูแล: กดปุ่ม "ให้ Lay ดูแลต่อ" หรือพิมพ์ `@บอท resume` หรือ `/lay`',
    '• งานนัดคุย: `/approve` · `/propose พรุ่งนี้ บ่าย 13-17` · `/decline`',
].join('\n');

// Contact-looking content is scrubbed even when it arrives inside free text (the customer may have typed a phone number).
const PHONE_RE = /(?:\+?66|0)[\s-]?\d(?:[\s-]?\d){7,9}/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LINE_ID_RE = /\bU[0-9a-f]{32}\b/g;
const LINE_HANDLE_RE = /(?:line\s*id|ไลน์|@line)\s*[:：]?\s*@?[\w.-]{3,}/giu;

function scrub(text) {
    return String(text || '')
        .replace(LINE_ID_RE, '[line-user]')
        .replace(EMAIL_RE, '[email]')
        .replace(PHONE_RE, '[phone]')
        .replace(LINE_HANDLE_RE, '[line-id]');
}

function clip(text, max) {
    const chars = [...String(text || '').replace(/\s+/g, ' ').trim()];
    return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…';
}

function kindLabel(kind) { return KIND_LABEL[kind] || KIND_LABEL.handoff_human; }

function leadId(lead) { return (lead && lead.id) || 'L-?'; }

function handoffThreadTitle({ lead, kind, session } = {}) {
    const card = (lead && lead.card_id) || (session && session.draft && session.draft.card) || '?';
    const symptom = (lead && lead.symptom) || (session && session.draft && session.draft.symptom) || kindLabel(kind);
    const parts = [leadId(lead), clip(scrub(card), 24), clip(scrub(symptom), 40)];
    return clip(parts.join(' · '), TITLE_MAX);
}

function homeworkLines(homework = {}) {
    const lines = [];
    for (const [key, label] of HOMEWORK_LABELS) {
        const v = homework && homework[key];
        if (v === null || v === undefined || v === '' ) continue;
        lines.push(`• ${label}: ${clip(scrub(v), FIELD_MAX)}`);
    }
    return lines;
}

function draftLine(draft = {}) {
    if (!draft) return null;
    const bits = [];
    if (draft.card) bits.push(`การ์ด ${scrub(draft.card)}`);
    if (draft.symptom) bits.push(`อาการ ${scrub(draft.symptom)}`);
    if (draft.tier) bits.push(`แพ็กเกจ ${scrub(draft.tier)}`);
    return bits.length ? `ร่างที่คุยกันอยู่: ${clip(bits.join(' · '), FIELD_MAX)}` : null;
}

function bookingLine(booking) {
    if (!booking) return null;
    const win = booking.requested_window || booking.window || booking.slot || booking.requested || null;
    const status = booking.status ? ` (สถานะ ${scrub(booking.status)})` : '';
    return win ? `ช่วงเวลาที่ลูกค้าขอ: ${clip(scrub(win), FIELD_MAX)}${status}` : null;
}

function handoffOpening({ kind, session, lead, question, draft, booking } = {}) {
    const hw = (lead && lead.homework) || (session && session.homework) || {};
    const lines = [
        `**${leadId(lead)}** · ${kindLabel(kind)}`,
    ];
    if (question) lines.push(`ลูกค้าพิมพ์ว่า: “${clip(scrub(question), QUESTION_MAX)}”`);
    const hwLines = homeworkLines(hw);
    if (hwLines.length) lines.push('การบ้านที่เก็บได้:', ...hwLines);
    const d = draftLine(draft || (session && session.draft));
    if (d) lines.push(d);
    const b = bookingLine(booking);
    if (b) lines.push(b);
    lines.push(HOW_TO_REPLY);
    return lines.join('\n');
}

function bookingOpening({ session, lead, booking, question, draft } = {}) {
    return handoffOpening({ kind: 'booking', session, lead, booking, question, draft });
}

function kbGapLine({ question } = {}) {
    return `❔ KB gap: “${clip(scrub(question), 200)}”`;
}

function leadLine({ lead, reason } = {}) {
    const isNew = !reason || reason === 'first_field';
    const bits = [isNew ? `🟢 ลีดใหม่ **${leadId(lead)}**` : `🔵 อัปเดตลีด **${leadId(lead)}**${lead && lead.status ? ` → ${clip(scrub(lead.status), 24)}` : ''}`];
    if (lead && lead.card_id) bits.push(`การ์ด ${clip(scrub(lead.card_id), 24)}`);
    if (lead && lead.symptom) bits.push(`อาการ ${clip(scrub(lead.symptom), 40)}`);
    if (lead && lead.homework && lead.homework.business) bits.push(`ธุรกิจ ${clip(scrub(lead.homework.business), 40)}`);
    return bits.join(' · ');
}

function mirrorLine({ text } = {}) {
    return `💬 ลูกค้า: ${clip(scrub(text), QUESTION_MAX)}`;
}

module.exports = {
    handoffThreadTitle, handoffOpening, bookingOpening, kbGapLine, leadLine, mirrorLine,
    scrub, clip, kindLabel, KIND_LABEL, HOW_TO_REPLY, TITLE_MAX,
};
