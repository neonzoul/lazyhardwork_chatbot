const test = require('node:test');
const assert = require('node:assert/strict');
const intake = require('../../src/leads/intake');

const now = new Date('2026-10-18T10:00:00+07:00');
const session = (over = {}) => ({ user_id: 'U' + 'a'.repeat(32), display_name: 'คุณบี', draft: {}, homework: {}, ...over });

test('buildLeadRow: new → qualified when business + problem known; flows raise; never regresses', () => {
  const r1 = intake.buildLeadRow({ session: session(), existing: null, now });
  assert.equal(r1.status, 'new');
  assert.equal(r1.source, 'line_oa');
  assert.equal(r1.created_at, now.toISOString());

  const r2 = intake.buildLeadRow({ session: session({ homework: { business: 'คลินิก', problem_verbatim: 'ลืมตามลูกค้า' }, draft: { card: 'A2', symptom: 'no_followup' } }), existing: r1, now });
  assert.equal(r2.status, 'qualified');
  assert.equal(r2.card_id, 'A2');
  assert.equal(r2.customer_words_th, 'ลืมตามลูกค้า');

  const r3 = intake.buildLeadRow({ session: session({ homework: { business: 'คลินิก', problem_verbatim: 'ลืมตามลูกค้า' } }), existing: r2, now, status: 'booking_pending' });
  assert.equal(r3.status, 'booking_pending');
  // a later turn with only the derived status must not pull it back
  const r4 = intake.buildLeadRow({ session: session({ homework: {} }), existing: r3, now });
  assert.equal(r4.status, 'booking_pending');
  assert.deepEqual(r4.homework, { business: 'คลินิก', problem_verbatim: 'ลืมตามลูกค้า' }, 'homework never loses fields');
  const r5 = intake.buildLeadRow({ session: session(), existing: { ...r4, status: 'booked' }, now, status: 'qualified' });
  assert.equal(r5.status, 'booked');
  assert.equal(intake.advanceStatus('offer_shown', 'new', 'garbage'), 'offer_shown');
});

test('qualify: cold with nothing, warm with the two core fields, hot with urgency + contact; reasons listed', () => {
  assert.equal(intake.qualify(session()).qualification, 'cold');
  assert.deepEqual(intake.qualify(session()).reasons, ['no homework yet']);
  const warm = intake.qualify(session({ homework: { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบแชทไม่ทัน', team_size: '3' } }));
  assert.equal(warm.qualification, 'warm');
  assert.ok(warm.reasons.includes('business known'));
  const hot = intake.qualify(session({ homework: { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบแชทไม่ทัน', urgency: 'อยากได้ภายในเดือนนี้ ด่วน', preferred_contact: 'โทร' } }));
  assert.equal(hot.qualification, 'hot');
  assert.ok(hot.reasons.includes('urgent'));
  const slow = intake.qualify(session({ homework: { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบแชทไม่ทัน', urgency: 'ยังไม่รีบ แค่ดูก่อน' } }));
  assert.equal(slow.qualification, 'cold');
  assert.ok(slow.reasons.includes('not urgent'));
  const booking = intake.qualify(session({ homework: { business: 'x', problem_verbatim: 'y' }, booking_step: 'window' }));
  assert.equal(booking.qualification, 'hot');
});

test('waveGroup: only from the customer words, never from card or symptom', () => {
  assert.equal(intake.waveGroup(session({ draft: { card: 'B14' } })), null, 'card alone says nothing');
  assert.equal(intake.waveGroup(session({ homework: { problem_verbatim: 'ลืมตามลูกค้า' } })), null);
  assert.equal(intake.waveGroup(session({ homework: { problem_verbatim: 'ได้ AI Pass มาแล้ว แต่ไม่รู้จะใช้กับงานยังไง' } })), 'W2');
  assert.equal(intake.waveGroup(session({ homework: { problem_verbatim: 'ทีมใช้ ChatGPT กันอยู่ แต่ไม่เห็นผลอะไรเลย' } })), 'W1');
  assert.equal(intake.waveGroup(session({ homework: { problem_verbatim: 'ไม่เคยใช้ AI เลยครับ ร้านเล็กๆ' } })), 'W3');
  assert.equal(intake.waveGroup(session(), ['ยังไม่เคยลอง AI']), 'W3', 'raw customer texts count too');
  assert.equal(intake.wave_group, intake.waveGroup);
  const row = intake.buildLeadRow({ session: session({ homework: { problem_verbatim: 'สมัคร Gemini รายเดือนแล้ว แต่ไม่มีระบบ' } }), now });
  assert.equal(row.wave_group, 'W2');
});

test('redactForDiscord strips display name, LINE id, phone and email planted anywhere', () => {
  const uid = 'U' + '0123456789abcdef'.repeat(2);
  const lead = {
    id: 'L-2026-10-18-line_oa-abc123', user_id: uid, display_name: 'สมชาย ใจดี', status: 'qualified', card_id: 'A2',
    customer_words_th: 'โทรหาผม 081-234-5678 หรือเมล somchai@example.com นะ ผมสมชาย ใจดี',
    homework: { business: 'ร้านกาแฟ', preferred_contact: 'LINE ' + uid + ' หรือ +66 81 234 5678', notes: ['ติดต่อ somchai.j@mail.co.th'] },
    contact: { display_name: 'สมชาย ใจดี', line_user_id: uid },
  };
  const r = intake.redactForDiscord(lead);
  const flat = JSON.stringify(r);
  assert.equal(r.display_name, undefined);
  assert.equal(r.user_id, undefined);
  assert.equal(r.contact, undefined);
  assert.ok(!flat.includes(uid));
  assert.ok(!flat.includes('081-234-5678') && !flat.includes('234 5678'));
  assert.ok(!flat.includes('@'));
  assert.ok(!flat.includes('สมชาย ใจดี'));
  assert.ok(flat.includes('[phone]') && flat.includes('[email]') && flat.includes('[name]') && flat.includes('[line_user_id]'));
  assert.equal(r.homework.business, 'ร้านกาแฟ');
  assert.deepEqual(lead.contact, { display_name: 'สมชาย ใจดี', line_user_id: uid }, 'input untouched');
});

test('leadSummaryTh is Thai, redacted, and names the next step', () => {
  const lead = { id: 'L-2026-10-18-line_oa-abc123', display_name: 'สมชาย ใจดี', status: 'booking_pending', card_id: 'A2', symptom: 'no_followup', customer_words_th: 'ลืมตามลูกค้า โทร 0812345678', homework: { business: 'คลินิก', problem_verbatim: 'ลืมตามลูกค้า' }, wave_group: 'W1' };
  const s = intake.leadSummaryTh(lead, { reason: 'booking' });
  assert.match(s, /^ขอนัดโทร · L-2026-10-18-line_oa-abc123/);
  assert.ok(s.includes('การ์ด: A2'));
  assert.ok(s.includes('[phone]') && !s.includes('0812345678'));
  assert.ok(!s.includes('สมชาย'));
  assert.ok(s.includes('การบ้าน 2/9'));
  assert.ok(s.includes('กลุ่ม W1'));
  assert.ok(s.includes('ขั้นต่อไป: มอสยืนยันช่วงเวลาโทร'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(s), 'no emoji');
});
