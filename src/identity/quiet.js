// Quiet window after a handoff + "เรียก Lay" (addendum A1, design §6.3). Pure rules; the turn applies them.
const { setMode, minutesSince } = require('../core/session');

const CALL_LAY_RE = /^\s*(?:lay|เลย์|เรียก\s*lay|เรียก\s*เลย์|เรียกบอท|กลับไปคุยกับ\s*lay|กลับไปคุยกับเลย์)\s*$/iu;
const CALL_LAY_POSTBACK = 'CALL_LAY';
const CALL_LAY_LABEL = 'เรียก Lay';

const strings = {
    back: 'Lay กลับมาดูแลต่อครับ มีอะไรให้ช่วยต่อ',
    quietAck: 'ส่งเรื่องให้มอสแล้วครับ กำลังรอมอสตอบ\nถ้าอยากให้ Lay ช่วยเรื่องอื่นระหว่างนี้ กด เรียก Lay ได้เลย',
};

function isCallLay(input) {
    if (!input) return false;
    if (input.kind === 'postback') return input.data === CALL_LAY_POSTBACK;
    if (input.kind === 'text') return CALL_LAY_RE.test(input.text || '');
    return false;
}

// Lazily resume: quiet/mos_active ends after `windowMinutes` with no customer message (and for mos_active, no Mos message).
function resumeIfIdle(session, now, { windowMinutes = 30 } = {}) {
    if (session.mode !== 'quiet' && session.mode !== 'mos_active') return false;
    const lastCustomer = minutesSince(session.last_customer_at, now);
    const lastMos = minutesSince(session.last_mos_at, now);
    const sinceMode = minutesSince(session.mode_since, now);
    const idle = Math.min(lastCustomer, sinceMode);
    if (session.mode === 'mos_active' && Math.min(lastMos, sinceMode) < windowMinutes) return false;
    if (idle >= windowMinutes) { setMode(session, 'lay', now); session.resumed_by = 'timeout'; return true; }
    return false;
}

function enterQuiet(session, now, reason) {
    setMode(session, 'quiet', now);
    session.quiet_reason = reason;
    session.quiet_acked = false;
    return session;
}

function callLay(session, now) {
    const was = session.mode;
    setMode(session, 'lay', now);
    session.resumed_by = 'call_lay';
    return was;
}

module.exports = { isCallLay, resumeIfIdle, enterQuiet, callLay, strings, CALL_LAY_POSTBACK, CALL_LAY_LABEL, CALL_LAY_RE };
