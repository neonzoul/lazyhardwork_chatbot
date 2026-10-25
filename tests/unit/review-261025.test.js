'use strict';
// v2.0.2 (Head + CE, 24–25 Oct)
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/core/policy');

const mk = (...texts) => ({ messages: texts.map((x) => ({ type: 'text', text: x, explain: false, template: null, alt: null, data: null })), quick_replies: [], topics: [], kb_refs: [], intent: 'capability', lead_updates: {}, action: null });
const said = (p) => p.response.messages.filter((m) => m.type === 'text').map((m) => m.text).join('\n');

test('GEO lead: scenario 81 step 3 (23 Oct real reply) and a paraphrase lose the chatbot / internal-system pitch', () => {
  const session = { geo_asked: true };
  const userText = 'คุณช่วยทำให้เลย หรือให้แผนแล้วผมต้องไปทำเอง?';
  const s81 = policy.applyPolicy(mk('เราสามารถช่วยทำระบบให้ได้ครับ เช่น AI Chatbot ที่ตอบคำถามลูกค้า 24 ชั่วโมง หรือวางระบบงานภายในเพื่อจัดการข้อมูลให้ไหลลื่นขึ้น', 'ถ้าสนใจสามารถเริ่มจากแพ็ก AI Business Review เพื่อให้เราออกแบบระบบตามงานจริงของคุณได้ครับ'), { session, userText });
  assert.doesNotMatch(said(s81), /Chatbot|ระบบงานภายใน/);
  assert.match(said(s81), /AI Business Review/);
  const para = policy.applyPolicy(mk('AI Business Review จะให้แผนที่ระบบว่าควรเริ่มตรงไหนถึงคุ้มครับ แต่ถ้าคุณต้องการให้เราช่วยทำระบบจริงๆ จะต้องเลือกแพ็กระบบงานภายในหรือแชทบอทต่อครับ'), { session, userText });
  assert.doesNotMatch(said(para), /แชทบอท|ระบบงานภายใน/);
  assert.match(said(para), /แผนที่ระบบ/);
  // the customer asking about a chatbot themselves still gets an answer about it
  const asked = policy.applyPolicy(mk('แชทบอทของเราตอบลูกค้าได้ 24 ชั่วโมงครับ'), { session, userText: 'แล้วถ้าอยากได้แชทบอทด้วยล่ะ' });
  assert.match(said(asked), /แชทบอท/);
  // not a GEO session: untouched
  assert.match(said(policy.applyPolicy(mk('แชทบอทช่วยตอบลูกค้าได้ครับ'), { session: {}, userText: 'ตอบแชทไม่ทัน' })), /แชทบอท/);
});

test('B2 over-claim (Mos test 24 Oct): "ไม่ต้องกังวล… อีกต่อไป" is removed, the honest part stays', () => {
  const b2 = 'ปัญหานี้ตรงกับที่ AI Workspace จะช่วยได้ครับ โดย AI จะอ่านข้อมูลจากไฟล์จริงของคุณและสามารถให้คำตอบที่ถูกต้องตามข้อมูลล่าสุดได้เลย ไม่ต้องอธิบายใหม่ทุกครั้ง และจะช่วยให้คุณไม่ต้องกังวลเรื่องการหยิบราคาหรือข้อมูลเก่าไปตอบลูกค้าอีกต่อไป';
  const out = said(policy.applyPolicy(mk(b2), { session: {}, userText: 'ปัญหาคือต้องเล่าเรื่องลูกค้าใหม่ทุกครั้ง และบางทีหยิบราคาเก่ามาตอบ' }));
  assert.doesNotMatch(out, /อีกต่อไป|ไม่ต้องกังวล/);
  assert.match(out, /อ่านข้อมูลจากไฟล์จริงของคุณ/);
  for (const t of ['บอทจะไม่ตอบผิดอีกเลยครับ', 'ตอบได้แม่นยำ 100% ครับ']) assert.ok(policy.applyPolicy(mk(`ตั้งค่าเสร็จใน 5 วันครับ ${t}`), { session: {} }).fixed.some((f) => /over-claim/.test(f)), t);
  // an honest sentence is untouched
  assert.match(said(policy.applyPolicy(mk('ช่วยลดโอกาสหยิบราคาเก่ามาตอบครับ เพราะ AI อ่านไฟล์ล่าสุดเสมอ'), { session: {} })), /ลดโอกาส/);
});
