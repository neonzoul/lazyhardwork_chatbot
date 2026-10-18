const test = require('node:test');
const assert = require('node:assert/strict');
const fmt = require('../../src/discord/format');

// Sample data deliberately full of things that must never reach Discord.
const PHONE = '081-234-5678';
const EMAIL = 'somchai@example.com';
const LINE_UID = 'U4af4980629abcdef0123456789abcdef';
const DISPLAY = 'สมชาย ใจดี';

const lead = {
    id: 'L-2026-10-17-007', user_id: LINE_UID, display_name: DISPLAY, card_id: 'line-oa-assistant', symptom: 'ตอบแชทไม่ทัน',
    phone: PHONE, email: EMAIL,
    homework: {
        business: 'ร้านกาแฟ 2 สาขา', problem_verbatim: `ลูกค้าทักมาเยอะ ตอบไม่ทัน โทร ${PHONE} ได้`, where_work_lives: 'LINE OA + Google Sheet',
        team_size: '3 คน', maintainer: 'เจ้าของดูแลเอง', urgency: 'ภายในเดือนนี้', preferred_contact: `LINE ${PHONE}`, came_from: 'facebook',
    },
};
const session = { user_id: LINE_UID, display_name: DISPLAY, draft: { card: 'line-oa-assistant', symptom: 'ตอบแชทไม่ทัน', tier: 'starter' }, homework: lead.homework };
const question = `ขอคุยกับมอสหน่อยครับ เบอร์ผม ${PHONE} อีเมล ${EMAIL} ไอดีไลน์ ${LINE_UID}`;

const FORBIDDEN = [
    [/081[\s-]?234[\s-]?5678/, 'phone'],
    [/0812345678/, 'phone (joined)'],
    [/somchai@example\.com/, 'email'],
    [/U4af4980629abcdef0123456789abcdef/, 'LINE userId'],
    [/สมชาย/, 'display name'],
];

function assertClean(text, label) {
    for (const [re, what] of FORBIDDEN) assert.ok(!re.test(text), `${label} leaks ${what}: ${text}`);
}

test('handoffThreadTitle: lead id · card · symptom, ≤ 90 chars, no personal data', () => {
    const t = fmt.handoffThreadTitle({ lead, kind: 'handoff_human' });
    assert.equal(t, 'L-2026-10-17-007 · line-oa-assistant · ตอบแชทไม่ทัน');
    assert.ok([...t].length <= 90);
    assertClean(t, 'title');
});

test('handoffThreadTitle: falls back to ? and the kind label; clips long symptoms', () => {
    const t = fmt.handoffThreadTitle({ lead: { id: 'L-1' }, kind: 'handoff_scope' });
    assert.equal(t, 'L-1 · ? · ราคาพิเศษ·นอกขอบเขต');
    const long = fmt.handoffThreadTitle({ lead: { id: 'L-1', card_id: 'x'.repeat(50), symptom: 'y'.repeat(200) }, kind: 'handoff_human' });
    assert.ok([...long].length <= 90, long);
});

test('handoffOpening: lead id, kind, customer words, homework (filled only), draft, how-to line — never contact data', () => {
    const o = fmt.handoffOpening({ kind: 'handoff_human', session, lead, question, draft: session.draft });
    assert.match(o, /L-2026-10-17-007/);
    assert.match(o, /คุยกับคน/);
    assert.match(o, /ลูกค้าพิมพ์ว่า/);
    assert.match(o, /ธุรกิจ: ร้านกาแฟ 2 สาขา/);
    assert.match(o, /ทีม: 3 คน/);
    assert.match(o, /ช่องทางที่สะดวก: LINE \[phone\]/);
    assert.ok(!/came_from|facebook/.test(o), 'came_from is not part of the summary');
    assert.match(o, /ร่างที่คุยกันอยู่: การ์ด line-oa-assistant/);
    assert.ok(o.endsWith(fmt.HOW_TO_REPLY));
    assert.match(o, /`\/approve` · `\/propose [^`]+` · `\/decline`/);
    assert.match(o, /`\/lay`/);
    assertClean(o, 'opening');
});

test('handoffOpening: kinds map to Thai labels; question clipped to 300 chars; empty homework omitted', () => {
    const scope = fmt.handoffOpening({ kind: 'handoff_scope', lead: { id: 'L-2' }, question: 'ลดได้ไหม' });
    assert.match(scope, /ราคาพิเศษ·นอกขอบเขต/);
    assert.ok(!/การบ้านที่เก็บได้/.test(scope));
    const unknown = fmt.handoffOpening({ kind: 'handoff_unknown', lead: { id: 'L-3' }, question: 'ก'.repeat(500) });
    assert.match(unknown, /คำถามที่ Lay ตอบไม่ได้/);
    const quoted = unknown.match(/“([^”]*)”/)[1];
    assert.ok([...quoted].length <= 300);
});

test('bookingOpening: requested window shown, still clean', () => {
    const o = fmt.bookingOpening({ session, lead, booking: { requested_window: 'พรุ่งนี้ 14:00', status: 'pending' } });
    assert.match(o, /นัดคุย/);
    assert.match(o, /ช่วงเวลาที่ลูกค้าขอ: พรุ่งนี้ 14:00 \(สถานะ pending\)/);
    assertClean(o, 'booking');
});

test('kbGapLine / leadLine / mirrorLine: short and clean', () => {
    const g = fmt.kbGapLine({ question: `รองรับ Shopee ไหม ติดต่อ ${EMAIL}` });
    assert.match(g, /KB gap/); assertClean(g, 'kbGap');
    const l = fmt.leadLine({ lead });
    assert.match(l, /ลีดใหม่ \*\*L-2026-10-17-007\*\*/); assert.match(l, /ร้านกาแฟ/); assertClean(l, 'lead');
    const m = fmt.mirrorLine({ text: `โทรกลับ ${PHONE} นะ` });
    assert.match(m, /ลูกค้า: โทรกลับ \[phone\] นะ/); assertClean(m, 'mirror');
});

test('scrub: +66 numbers, LINE ids and emails', () => {
    assert.equal(fmt.scrub('โทร +66 81 234 5678 หรือ a.b+c@mail.co.th'), 'โทร [phone] หรือ [email]');
    assert.equal(fmt.scrub('Line ID: @somchai99'), '[line-id]');
});
