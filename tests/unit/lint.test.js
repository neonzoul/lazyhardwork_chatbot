const test = require('node:test');
const assert = require('node:assert/strict');
const lint = require('../../src/core/lint');

test('banned content is found', () => {
  const ids = (t) => lint.findBanned(t).map((b) => b.id);
  assert.deepEqual(ids('Sprint 1 ฿15,000 + ดูแล'), ['old_sprint_prices']);
  assert.deepEqual(ids('ผลงาน Fastwork 181 งาน · ลูกค้า 36 ราย'), ['job_counts']);
  assert.deepEqual(ids('ส่งอีเมลมาที่ mos@example.com'), ['email']);
  assert.deepEqual(ids('การันตียอดขายเพิ่ม 300%'), ['guarantee']);
  assert.deepEqual(ids('ช่วยลดคนได้ ไม่ต้องจ้างเพิ่ม'), ['reduce_staff']);
  assert.deepEqual(ids('[Agent Lay] สวัสดีครับ'), ['agent_tag']);
  assert.deepEqual(ids('นัดเรียบร้อยครับ เจอกัน'), ['booking_confirmed']);
  assert.deepEqual(lint.findBanned('ยืนยันแล้วครับ', new Set(['booking_confirmed'])), []);
  assert.deepEqual(ids('ราคาเริ่มต้น 4,900 บาท ปรับตามขอบเขตจริงหลังคุยครับ'), []);
});

test('emoji policy', () => {
  assert.equal(lint.countEmoji('สวัสดีครับ'), 0);
  assert.equal(lint.countEmoji('1️⃣ เก็บข้อมูล 2️⃣ ทดสอบ ✅'), 3);
  assert.equal(lint.checkEmoji('ยินดีครับ 🙏').ok, false);
  assert.equal(lint.checkEmoji('ขั้นตอน 1️⃣ คุย 2️⃣ สร้าง 3️⃣ ส่งมอบ', { explain: true }).ok, true);
  assert.equal(lint.checkEmoji('ขั้นตอน 1️⃣ คุย 2️⃣ สร้าง', { explain: false }).ok, false);
  assert.equal(lint.checkEmoji('ได้เลยครับ 😊').ok, false);
});

test('prose list detector', () => {
  assert.equal(lint.hasProseList('มี 3 แพ็กครับ\n1. ลองก่อน\n2. วางระบบ\n3. ให้ระบบรันเอง'), true);
  assert.equal(lint.hasProseList('เลือกได้ว่าจะ โทรคุย หรือ นัดประชุม หรือ แชทต่อ หรือ รอมอส'), true);
  assert.equal(lint.hasProseList('แล้วแต่งานครับ ส่วนใหญ่เริ่มที่แพ็กลองก่อน'), false);
  assert.equal(lint.hasProseList('ราคาเริ่มต้น 4,900 บาท ปรับตามขอบเขตจริงหลังคุย'), false);
});

test('markdown and length', () => {
  assert.equal(lint.hasMarkdown('**ราคา** 4,900'), true);
  assert.equal(lint.stripMarkdown('## หัวข้อ\n**ราคา** `4,900`'), 'หัวข้อ\nราคา 4,900');
  assert.equal(lint.tooLong('สั้นๆ'), false);
  assert.equal(lint.tooLong('ก'.repeat(300)), true);
  assert.equal(lint.tooLong('a\nb\nc\nd\ne'), true);
});

test('lintText aggregates', () => {
  const r = lint.lintText('ยินดีครับ 🙏 มี 2 ทางคือ โทร หรือ นัด หรือ แชท หรือ รอ [Agent Lay]');
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('banned:agent_tag'));
  assert.ok(r.errors.includes('prose_list'));
  assert.ok(r.errors.some((e) => e.startsWith('emoji:')));
  assert.equal(lint.lintText('รับทราบครับ เดี๋ยวดูให้').ok, true);
});
