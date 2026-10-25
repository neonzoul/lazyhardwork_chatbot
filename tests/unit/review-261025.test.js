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
