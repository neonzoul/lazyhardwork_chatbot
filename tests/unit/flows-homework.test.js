// flows/homework — the seven fields, one gap at a time, ≤ 4 questions (brief §3.5).
const test = require('node:test');
const assert = require('node:assert/strict');
const hw = require('../../src/flows/homework');
const session = require('../../src/core/session');
const lint = require('../../src/core/lint');

test('the seven fields are a subset of session.HOMEWORK_FIELDS; option labels fit a quick reply', () => {
  for (const f of hw.ORDER) assert.ok(session.HOMEWORK_FIELDS.includes(f), f);
  assert.equal(hw.ORDER.length, 7);
  for (const [f, def] of Object.entries(hw.FIELDS)) {
    assert.equal(lint.lintText(def.text).ok, true, `${f}: ${lint.lintText(def.text).errors}`);
    for (const o of def.options || []) assert.ok([...o].length <= 20, `${f} option "${o}" > 20`);
  }
  assert.deepEqual(hw.FIELDS.team_size.options, ['1 คน', '2–5', '6–15', 'มากกว่า 15']);
  assert.deepEqual(hw.FIELDS.where_work_lives.options, ['LINE', 'Google Sheets·Excel', 'POS·ระบบอื่น', 'กระดาษ·หัวคน']);
  assert.deepEqual(hw.FIELDS.maintainer.options, ['ผมเอง', 'มีคนในทีม', 'ยังไม่แน่ใจ']);
  assert.deepEqual(hw.FIELDS.preferred_contact.options, ['โทร', 'นัดประชุม', 'แชทต่อ']);
  assert.deepEqual(hw.FIELDS.urgency.options, ['เริ่มเร็วที่สุด', 'ภายใน 1 เดือน', 'แค่ดูข้อมูลก่อน']);
  assert.equal(hw.FIELDS.business.options, undefined);
  assert.equal(hw.FIELDS.problem_verbatim.options, undefined);
});

test('nextQuestion asks only the single next gap, free text for business/problem, buttons otherwise', () => {
  const s = { homework: {}, questions_asked: 0 };
  assert.equal(hw.nextQuestion(s).field, 'problem_verbatim');
  assert.equal(hw.nextQuestion(s).options, undefined);
  s.homework.problem_verbatim = 'ตอบแชทไม่ทัน';
  assert.equal(hw.nextQuestion(s).field, 'business');
  s.homework.business = 'ร้านกาแฟ';
  const q = hw.nextQuestion(s);
  assert.equal(q.field, 'where_work_lives');
  assert.deepEqual(q.options.map((o) => o.label), hw.FIELDS.where_work_lives.options);
  // never re-asks a filled field, whatever the order
  s.homework = { problem_verbatim: 'x', business: 'y', where_work_lives: 'LINE', team_size: '1 คน', maintainer: 'ผมเอง', preferred_contact: 'โทร', urgency: 'ภายใน 1 เดือน' };
  assert.equal(hw.nextQuestion(s), null);
});

test('budget: no question after 4 asked; readyForEnding by budget or by key gaps', () => {
  assert.equal(hw.nextQuestion({ homework: {}, questions_asked: 4 }), null);
  assert.equal(hw.readyForEnding({ homework: {}, questions_asked: 4 }), true);
  assert.equal(hw.readyForEnding({ homework: {}, questions_asked: 3 }), false);
  assert.equal(hw.readyForEnding({ homework: { business: 'a', problem_verbatim: 'b' }, questions_asked: 0 }), false);
  assert.equal(hw.readyForEnding({ homework: { business: 'a', problem_verbatim: 'b', preferred_contact: 'โทร' }, questions_asked: 0 }), true);
  const s = { homework: {}, questions_asked: 0 };
  for (let i = 0; i < 4; i++) { const q = hw.nextQuestion(s); assert.ok(q); hw.countQuestion(s); hw.applyAnswer(s, q.field, q.options ? q.options[0].value : 'ตอบ'); }
  assert.equal(s.questions_asked, 4);
  assert.equal(hw.nextQuestion(s), null);
  assert.equal(hw.readyForEnding(s), true);
});

test('answerFromButton maps every option back to its field; free text → null', () => {
  assert.deepEqual(hw.answerFromButton('2–5'), { field: 'team_size', value: '2–5' });
  assert.deepEqual(hw.answerFromButton(' โทร '), { field: 'preferred_contact', value: 'โทร' });
  assert.deepEqual(hw.answerFromButton('กระดาษ·หัวคน'), { field: 'where_work_lives', value: 'กระดาษ·หัวคน' });
  assert.equal(hw.answerFromButton('ร้านกาแฟครับ'), null);
  assert.equal(hw.answerFromButton(''), null);
  const s = { homework: {} };
  assert.equal(hw.applyAnswer(s, 'team_size', '6–15'), true);
  assert.equal(hw.applyAnswer(s, 'phone', '0812345678'), false);
  assert.equal(s.homework.team_size, '6–15');
});

test('homeworkSummary lists filled fields in Thai, names the gaps, and scrubs phone/email', () => {
  const s = { homework: { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบแชทไม่ทัน โทร 081-234-5678 หรือ a@b.co', team_size: '2–5' } };
  const out = hw.homeworkSummary(s);
  assert.match(out, /ธุรกิจ: ร้านกาแฟ/);
  assert.match(out, /ขนาดทีม: 2–5/);
  assert.doesNotMatch(out, /081/);
  assert.doesNotMatch(out, /a@b\.co/);
  assert.match(out, /ยังไม่ได้ถาม: .*สะดวกติดต่อแบบไหน/);
  assert.match(hw.homeworkSummary({}), /^ยังไม่ได้ถาม: เรื่องที่อยากให้ช่วย/); // an empty pack still names the gaps
});
