// The three handoff behaviours (flow §5, brief §3.9) and notify-before-promise (flow §5.4).
// T8 extends the notifier (Discord threads) and the relay; the rules here are the contract.
const { enterQuiet, CALL_LAY_LABEL } = require('../identity/quiet');

// "คุณมอส" (polite form) counts too — GPT review scenario 5, 23 Oct: "ขอคุยกับคุณมอสหน่อยค่ะ" got the error line
const ASK_HUMAN_RE = [
    /คุย\s*กับ\s*คน\s*จริง/u,
    /(?:ขอ|อยาก)\s*คุย\s*กับ\s*(?:คุณ\s*)?(?:มอส|mos|คน|เจ้าของ|แอดมิน)/iu,
    /(?:ขอ|อยาก)\s*(?:นัด|คุย)\s*กับ\s*คน/u,
    /ให้\s*คน\s*มา\s*คุย/u,
    /^\s*คุยกับ(?:คุณ)?มอส\s*$/u,
    /^\s*นัดคุยกับมอส\s*$/u,
    /ติดต่อ\s*(?:คุณ\s*)?มอส\s*(?:ได้ไหม|หน่อย|โดยตรง)/u,
    /(?:มี|ขอ)\s*คน\s*(?:จริง)?\s*ตอบ/u,
];
const SPECIAL_PRICE_RE = /ขอ\s*ส่วนลด|ลดราคา|ลดได้ไหม|ลดหน่อย|ราคาพิเศษ|เหมาจ่าย|ขอเหมา|เหมา\s*(?:ได้|ราคา|ทั้งหมด|รวม)|ต่อรอง|ถูกกว่านี้/u;

const strings = {
    askHuman: (phone) => `ได้ครับ ส่งเรื่องให้มอสแล้ว เดี๋ยวมอสเข้ามาคุยเองนะครับ\nถ้าเร่งด่วน โทร ${phone} ได้เลย`,
    scope: 'เรื่องนี้ผมตัดสินใจแทนมอสไม่ได้ครับ ส่งเรื่องให้มอสแล้ว เดี๋ยวมอสตอบกลับมาทางแชทนี้ครับ',
    unknownForwarded: 'ส่งคำถามให้มอสแล้วครับ เดี๋ยวมอสตอบกลับมาทางแชทนี้\nระหว่างนี้ถามเรื่องอื่นต่อได้เลย',
    unknown: 'เรื่องนี้ผมยังไม่มีข้อมูลครับ ไม่อยากตอบมั่ว\nให้ส่งคำถามนี้ให้มอสตอบไหมครับ',
    notifyFailed: (phone) => `ขออภัยครับ ระบบส่งเรื่องขัดข้อง\nรบกวนโทรหามอสโดยตรงที่ ${phone} ครับ`,
    booking: 'ขอเช็กคิวกับมอสก่อนนะครับ แล้วจะยืนยันเวลาให้ในแชทนี้',
    unknownButtons: ['ส่งให้มอสตอบ', 'ถามเรื่องอื่น'],
    forwardPostback: 'FORWARD_TO_MOS',
};

function isAskHuman(text) { return ASK_HUMAN_RE.some((re) => re.test(text || '')); }
function isSpecialPrice(text) { return SPECIAL_PRICE_RE.test(text || ''); }

// Performs a handoff: notify FIRST, then (and only then) change state and build the customer message.
// kind: 'handoff_human' | 'handoff_scope' | 'handoff_unknown' | 'handoff_booking' (a time question during the booking)
async function performHandoff({ kind, session, lead, question, draft, deps, config, now }) {
    const phone = config.contact.phoneDisplay;
    try {
        const res = await deps.notifier.handoff({ kind, session, lead, question, draft });
        if (res?.threadId) session.discord_thread_id = res.threadId;
    } catch (err) {
        deps.log.error('handoff.notify_failed', { kind, userId: session.user_id, error: err?.message });
        await deps.store.events.append({ kind: 'handoff_notify_failed', user_id: session.user_id, payload: { kind, error: err?.message }, created_at: now.toISOString() });
        return { ok: false, text: strings.notifyFailed(phone), quickReplies: [CALL_LAY_LABEL], action: null };
    }
    if (kind === 'handoff_unknown') {
        // the question is forwarded; Lay stays (design §6.3)
        return { ok: true, text: strings.unknownForwarded, quickReplies: null, action: 'handoff_unknown' };
    }
    enterQuiet(session, now, kind);
    const text = kind === 'handoff_human' ? strings.askHuman(phone) : kind === 'handoff_booking' ? strings.booking : strings.scope;
    return { ok: true, text, quickReplies: [CALL_LAY_LABEL], action: kind };
}

module.exports = { isAskHuman, isSpecialPrice, performHandoff, strings, ASK_HUMAN_RE };
