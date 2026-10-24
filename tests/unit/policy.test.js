const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPolicy, fallbackReply } = require('../../src/core/policy');
const { emptyResponse, validateResponse } = require('../../src/brain/schema');

const txt = (t, extra = {}) => ({ type: 'text', text: t, explain: false, template: null, alt: null, data: null, ...extra });
const resp = (texts, extra = {}) => emptyResponse({ messages: texts.map((t) => (typeof t === 'string' ? txt(t) : t)), intent: 'pricing', ...extra });
const pack = { sections: [
  { id: 'faq.price-range', text: 'ราคาเริ่มต้น 4,900 บาท' },
  { id: 'offer.A2.T1', text: 'แชทบอท LINE OA ราคาเริ่มต้น 15,000 บาท' },
  { id: 'faq.care-fee', text: 'ไม่เกิน 1,000 ข้อความต่อเดือน 2,500 บาท' },
  { id: 'faq.data-safety', text: 'ระบบรันบนบัญชีของพี่เอง' },
] };

test('clean response → severity fix, nothing changed', () => {
  const r = resp(['แล้วแต่งานครับ ราคาเริ่มต้น 4,900 บาท ปรับตามขอบเขตจริงหลังคุย'], { kb_refs: ['faq.price-range'], quick_replies: ['เริ่มยังไง'] });
  const out = applyPolicy(r, { pack });
  assert.equal(out.severity, 'fix');
  assert.deepEqual(out.violations, []);
  assert.deepEqual(out.fixed, []);
  assert.deepEqual(out.response, r);
  assert.notEqual(out.response, r, 'input is not mutated');
});

test('markdown is stripped and trailing whitespace trimmed (mechanical fix)', () => {
  const out = applyPolicy(resp(['**ราคา** เริ่มต้นครับ  \n']), {});
  assert.equal(out.response.messages[0].text, 'ราคา เริ่มต้นครับ');
  assert.equal(out.severity, 'fix');
  assert.ok(out.fixed.some((f) => f.includes('markdown')));
  assert.ok(out.fixed.some((f) => f.includes('trailing')));
});

test('quick replies: list capped at 4, over-long or empty labels dropped, labels never truncated', () => {
  const long = 'ป้ายยาวมากเกินยี่สิบตัวอักษรแน่นอนครับผม';
  const out = applyPolicy(resp(['ครับ'], { quick_replies: ['ก', long, 'ข', '', 'ค', 'ง', 'จ'] }), {});
  assert.deepEqual(out.response.quick_replies, ['ก', 'ข', 'ค', 'ง']);
  assert.equal(out.severity, 'fix');
  assert.ok(out.fixed.some((f) => f.includes('dropped')) && out.fixed.some((f) => f.includes('cut from')));
});

test('unknown kb_refs are dropped and recorded as a fix-level violation', () => {
  const out = applyPolicy(resp(['ครับ'], { kb_refs: ['faq.data-safety', 'faq.made-up'] }), { pack });
  assert.deepEqual(out.response.kb_refs, ['faq.data-safety']);
  assert.equal(out.severity, 'fix');
  assert.ok(out.violations.some((v) => v.rule === 'unknown_kb_ref' && v.detail === 'faq.made-up'));
  // pack.sections as an object map works too
  const out2 = applyPolicy(resp(['ครับ'], { kb_refs: ['a', 'b'] }), { pack: { sections: { a: 'x' } } });
  assert.deepEqual(out2.response.kb_refs, ['a']);
  // no pack → refs are not checked
  assert.equal(applyPolicy(resp(['ครับ'], { kb_refs: ['anything'] }), {}).violations.length, 0);
});

test('price without a grounding ref → regenerate; offer.*, faq.*price* or a priced section grounds it', () => {
  const priced = 'แชทบอทราคาเริ่มต้น 15,000 บาทครับ';
  assert.equal(applyPolicy(resp([priced], { kb_refs: ['faq.data-safety'] }), { pack }).severity, 'regenerate');
  assert.equal(applyPolicy(resp([priced], { kb_refs: [] }), { pack }).violations[0].rule, 'price_without_ref');
  assert.equal(applyPolicy(resp([priced], { kb_refs: ['offer.A2.T1'] }), { pack }).severity, 'fix');
  assert.equal(applyPolicy(resp([priced], { kb_refs: ['faq.price-range'] }), { pack }).severity, 'fix');
  assert.equal(applyPolicy(resp([priced], { kb_refs: ['faq.care-fee'] }), { pack }).severity, 'fix', 'section text carries a price → grounded');
  // an unknown offer ref is dropped first, so the price is then ungrounded
  assert.equal(applyPolicy(resp([priced], { kb_refs: ['offer.ZZ'] }), { pack }).severity, 'regenerate');
  // no pack: the id pattern alone decides
  assert.equal(applyPolicy(resp([priced], { kb_refs: ['faq.price-range'] }), {}).severity, 'fix');
  assert.equal(applyPolicy(resp(['ไม่มีราคาในนี้ครับ'], { kb_refs: [] }), { pack }).severity, 'fix');
});

test('banned content, emoji policy, prose list and too-long are regenerate-level', () => {
  const sev = (t, extra) => applyPolicy(resp([t], extra), {}).severity;
  assert.equal(sev('Sprint 1 เริ่มที่ 15,000 + ครับ'), 'regenerate');
  assert.equal(sev('ส่งเมลมาที่ mos@example.com'), 'regenerate');
  assert.equal(sev('ยินดีครับ 🙏'), 'regenerate');
  assert.equal(sev('มี 3 แพ็กครับ\n1. ลองก่อน\n2. วางระบบ\n3. รันเอง'), 'regenerate');
  assert.equal(sev('ก'.repeat(320)), 'regenerate');
  const rules = applyPolicy(resp(['[Agent Lay] ยินดีช่วยเสมอครับ 😊']), {}).violations.map((v) => v.rule).sort();
  assert.deepEqual(rules, ['banned:agent_tag']); // the stock closer and its emoji are now repaired by code (18 Oct), not regenerated
  // an explain bubble may carry structural emoji
  assert.equal(applyPolicy(resp([txt('ขั้นตอน 1️⃣ คุย 2️⃣ สร้าง 3️⃣ ส่งมอบ', { explain: true })]), {}).severity, 'fix');
});

test('booking_confirmed words only when allow has it', () => {
  const r = resp(['นัดเรียบร้อยครับ เจอกันพรุ่งนี้']);
  assert.equal(applyPolicy(r, {}).violations[0].rule, 'banned:booking_confirmed');
  assert.equal(applyPolicy(r, { allow: new Set(['booking_confirmed']) }).severity, 'fix');
  assert.equal(applyPolicy(r, { allow: ['booking_confirmed'] }).severity, 'fix');
});

test('benefits topic needs the caveat frame', () => {
  const base = { topics: ['benefits'], intent: 'benefits', kb_refs: [] };
  assert.equal(applyPolicy(resp(['มีโครงการ BDS ของ สสว. ช่วยได้ครับ'], base), {}).violations[0].rule, 'benefits_without_caveat');
  assert.equal(applyPolicy(resp(['อาจใช้สิทธิ์ได้ครับ ต้องตรวจสอบกับหน่วยงานก่อน'], base), {}).severity, 'fix');
  assert.equal(applyPolicy(resp(['อาจใช้สิทธิ์ได้ครับ ต้องตรวจสอบกับ สสว. ก่อนครับ'], base), {}).severity, 'fix', 'the FAQ draft\'s own wording counts');
});

test('problem_verbatim must be in the customer text (whitespace-normalised) or it is nulled', () => {
  const lead = (pv) => ({ lead_updates: { ...emptyResponse().lead_updates, problem_verbatim: pv, business: 'ร้านออนไลน์' } });
  const user = 'ร้านออนไลน์ครับ  แชทเข้าเยอะ\nตอบไม่ทัน';
  let out = applyPolicy(resp(['ครับ'], lead('แชทเข้าเยอะ ตอบไม่ทัน')), { userText: user });
  assert.equal(out.response.lead_updates.problem_verbatim, 'แชทเข้าเยอะ ตอบไม่ทัน');
  assert.equal(out.response.lead_updates.business, 'ร้านออนไลน์');
  out = applyPolicy(resp(['ครับ'], lead('ลูกค้าถามซ้ำ')), { userText: user });
  assert.equal(out.response.lead_updates.problem_verbatim, null);
  assert.ok(out.fixed.some((f) => f.includes('problem_verbatim')));
  assert.equal(out.severity, 'fix');
  // falls back to the session's last customer text
  out = applyPolicy(resp(['ครับ'], lead('ตอบไม่ทัน')), { session: { last_customer_text: 'แชทตอบไม่ทันเลย' } });
  assert.equal(out.response.lead_updates.problem_verbatim, 'ตอบไม่ทัน');
});

test('card: emoji removed from title, markdown stripped from alt, banned alt → regenerate', () => {
  const card = { type: 'card', text: null, explain: false, template: 'steps', alt: '**ขั้นตอน**', data: { title: 'เริ่มยังไง 🚀', steps: [] } };
  const out = applyPolicy(resp([txt('ครับ'), card]), {});
  assert.equal(out.response.messages[1].data.title, 'เริ่มยังไง');
  assert.equal(out.response.messages[1].alt, 'ขั้นตอน');
  assert.equal(out.severity, 'fix');
  const bad = applyPolicy(resp([txt('ครับ'), { ...card, alt: 'Sprint 1 15,000 +' }]), {});
  assert.equal(bad.severity, 'regenerate');
});

test('unusable after policy → fallback severity; garbage input → fallback', () => {
  const out = applyPolicy(resp(['**  **']), {}); // markdown strip leaves an empty text
  assert.equal(out.severity, 'fallback');
  assert.ok(out.violations.some((v) => v.rule === 'invalid_after_policy'));
  assert.equal(applyPolicy(null, {}).severity, 'fallback');
  assert.equal(applyPolicy({ not: 'valid' }, {}).severity, 'fallback');
});

test('severity is the worst violation', () => {
  const out = applyPolicy(resp(['ราคาเริ่มต้น 4,900 บาท 🙏'], { kb_refs: ['faq.nope'] }), { pack });
  assert.equal(out.severity, 'regenerate');
  const rules = out.violations.map((v) => v.rule).sort();
  assert.deepEqual(rules, ['emoji', 'price_without_ref', 'unknown_kb_ref']);
});

test('fallbackReply is schema-valid, honest, uses the phone from config and never hard-codes it', () => {
  const r = fallbackReply({ reason: 'model_timeout', config: { contact: { phone: '095 569 1674' } } });
  assert.ok(validateResponse(r).ok);
  assert.equal(r.messages[0].text, 'ตอนนี้ระบบขัดข้องชั่วคราวครับ ถ้ารีบ โทร 095 569 1674 (มอส) ได้เลย');
  assert.deepEqual(r.quick_replies, ['เรียก Lay']);
  assert.equal(r._meta.reason, 'model_timeout');
  assert.ok(!Object.keys(r).includes('_meta'));
  const noPhone = fallbackReply({ reason: 'x', config: {} });
  assert.ok(validateResponse(noPhone).ok);
  assert.ok(!/\d{3} \d{3} \d{4}/.test(noPhone.messages[0].text));
  assert.ok(noPhone.messages[0].text.startsWith('ตอนนี้ระบบขัดข้องชั่วคราวครับ'));
  assert.equal(applyPolicy(r, {}).severity, 'fix');
});

test('first-tester replay (18 Oct): stock closers, "!" and a repeated price phrase are repaired by code (no regenerate)', () => {
  const { applyPolicy } = require('../../src/core/policy');
  const one = (t) => applyPolicy({ messages: [{ type: 'text', text: t, explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: [], kb_refs: ['faq.price-range'], intent: 'banter', lead_updates: {}, action: null }, {});
  assert.equal(one('5555 ขอบคุณครับพี่! ถ้ามีอะไรอยากคุยหรือถามเพิ่มเติม บอกได้เลยนะครับ').response.messages[0].text, '5555 ขอบคุณครับพี่');
  assert.equal(one('5555 โดนจับได้อีกแล้วครับ! ถามมาเถอะ พี่อยากรู้เรื่องอะไรเพิ่มเติมได้เลยครับ').response.messages[0].text, '5555 โดนจับได้อีกแล้วครับ');
  const price = one('ราคาเริ่มต้น 4,900 บาท ทุกตัวเป็นราคาเริ่มต้น ปรับตามขอบเขตจริงหลังคุยครับ');
  assert.equal((price.response.messages[0].text.match(/ราคาเริ่มต้น/g) || []).length, 1);
  assert.equal(price.severity, 'fix');
  assert.equal(one('ถ้ามีอะไรบอกได้เลยนะครับ').response.messages[0].text, 'ถ้ามีอะไรบอกได้เลยนะครับ', 'a bubble is never emptied');
});

test('style-only violations are salvaged by code: long list → short bubbles without markers; banned content is not', () => {
  const { salvage, isStyleOnly, applyPolicy } = require('../../src/core/policy');
  const long = 'สิ่งที่ได้มีดังนี้ครับ\n1. บอท 1 ช่องทาง\n2. คลังความรู้ครบทั้งร้าน\n3. ส่งต่อแอดมินเมื่อตอบไม่ได้\n4. ทดสอบด้วยเคสจริงและเคสหลอก\n5. สอนใช้ 30 นาทีพร้อมคู่มือ และดูแลให้ 3 เดือนแรก ' + 'ระบบจะถูกปรับให้ตรงกับคำถามที่ลูกค้าของร้านถามบ่อยที่สุด '.repeat(3);
  const r = { messages: [{ type: 'text', text: long, explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: ['capability'], kb_refs: [], intent: 'tell_me_more', lead_updates: {}, action: null };
  const first = applyPolicy(r, {});
  assert.ok(isStyleOnly(first.violations), JSON.stringify(first.violations));
  const fixed = applyPolicy(salvage(first.response), {});
  assert.notEqual(fixed.severity, 'fallback');
  assert.ok(fixed.response.messages.length >= 2 && fixed.response.messages.length <= 3);
  assert.ok(fixed.response.messages.every((m) => !/^\s*\d\./m.test(m.text)));
  assert.equal(isStyleOnly([{ rule: 'banned:email', severity: 'regenerate' }]), false);
});

test('replay 18 Oct: "มอสจะเข้ามาคุย" without a handoff action is regenerated; with a handoff, or as an offer, it is fine', () => {
  const { applyPolicy } = require('../../src/core/policy');
  const mk = (t, action = null) => ({ messages: [{ type: 'text', text: t, explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: [], kb_refs: [], intent: 'abuse', lead_updates: {}, action });
  const rules = (r) => r.violations.map((v) => v.rule);
  assert.ok(rules(applyPolicy(mk('ใจเย็นครับพี่ มอสจะเข้ามาคุยเองในเวลาทำการนะครับ'), {})).includes('unbacked_promise'));
  assert.ok(rules(applyPolicy(mk('ส่งเรื่องให้มอสแล้วครับ'), {})).includes('unbacked_promise'));
  assert.ok(!rules(applyPolicy(mk('ส่งเรื่องให้มอสแล้วครับ', 'handoff_human'), {})).includes('unbacked_promise'));
  assert.ok(!rules(applyPolicy(mk('ถ้าอยากคุยกับมอสเอง กดคุยกับมอสได้เลยครับ'), {})).includes('unbacked_promise'));
});

test('replay 18 Oct: a bubble that is only a stock closer is dropped when other content remains', () => {
  const { applyPolicy } = require('../../src/core/policy');
  const t = (x) => ({ type: 'text', text: x, explain: false, template: null, alt: null, data: null });
  const r = applyPolicy({ messages: [t('แชทบอทตอบลูกค้า 24 ชม. ผ่าน LINE OA ครับ'), t('ถ้าสนใจบริการไหนเพิ่มเติม แจ้งได้เลยครับ')], quick_replies: [], topics: [], kb_refs: [], intent: 'capability', lead_updates: {}, action: null }, {});
  assert.equal(r.response.messages.length, 1);
  assert.match(r.response.messages[0].text, /แชทบอท/);
});

test('replay 18 Oct: a benefits answer without the caveat gets it appended by code (no regenerate, no error line)', () => {
  const { applyPolicy } = require('../../src/core/policy');
  const r = applyPolicy({ messages: [{ type: 'text', text: 'มีโครงการ BDS ของ สสว. ช่วยค่าบริการบางส่วนครับ', explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: ['benefits'], kb_refs: [], intent: 'benefits', lead_updates: {}, action: null }, {});
  assert.equal(r.severity, 'fix');
  assert.match(r.response.messages[0].text, /ตรวจสอบกับหน่วยงาน/);
});

test('18 Oct: a closing question similar to the last one Lay asked is dropped; a new question stays', () => {
  const { applyPolicy } = require('../../src/core/policy');
  const t = (x) => ({ type: 'text', text: x, explain: false, template: null, alt: null, data: null });
  const mk = (q) => ({ messages: [t('แชทบอทตอบลูกค้า 24 ชม. ครับ'), t(q)], quick_replies: [], topics: [], kb_refs: [], intent: 'capability', lead_updates: {}, action: null });
  const said = (r) => r.response.messages.map((m) => m.text).join('\n'); // two short bubbles are merged into one (19 Oct)
  // a confirmed symptom: the screening question below is allowed, so only the repeat rule is under test
  const session = { last_lay_question: 'ตอนนี้พี่สนใจบริการไหนเป็นพิเศษครับ', draft: { confirmed: 'chat_overload' } };
  assert.doesNotMatch(said(applyPolicy(mk('ตอนนี้พี่สนใจบริการไหนอยู่ครับ จะได้เล่าให้ตรงจุด'), { session })), /สนใจบริการไหน/);
  assert.match(said(applyPolicy(mk('ตอนนี้ร้านพี่มีคนตอบแชทกี่คนครับ'), { session })), /มีคนตอบแชทกี่คน/);
});

test('one question per bubble (Head GTM 22 Oct): "กี่คน และ … กี่ข้อความ" is two; one question with an example list is one', () => {
  const { countQuestionClauses, applyPolicy, isStyleOnly } = require('../../src/core/policy');
  assert.equal(countQuestionClauses('ตอนนี้มีคนตอบแชทกี่คนครับ และแชทเข้ามาเฉลี่ยวันละกี่ข้อความครับ'), 2);
  assert.equal(countQuestionClauses('มีคนตอบแชทกี่คน และแชทเข้าวันละกี่ข้อความ'), 2);
  assert.equal(countQuestionClauses('ตอนนี้ของพี่เป็นธุรกิจอะไรครับ จะได้เล่าให้ตรงงาน'), 1);
  assert.equal(countQuestionClauses('งานไหนกินเวลามากที่สุดครับ เช่น ตอบลูกค้าถามห้องว่างกับราคา จองห้อง หรือเอกสารหลังบ้าน'), 0);
  assert.equal(countQuestionClauses('แชทบอทตอบลูกค้า 24 ชม. ครับ\nตอนนี้มีคนตอบแชทกี่คนครับ'), 1);
  const r = { messages: [{ type: 'text', text: 'ตอนนี้มีคนตอบแชทกี่คนครับ และแชทเข้ามาเฉลี่ยวันละกี่ข้อความครับ', explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: [], kb_refs: [], intent: 'fit', lead_updates: {}, action: null };
  const out = applyPolicy(r, { session: { draft: { confirmed: true } } }); // a matched symptom: the screening question itself is allowed
  assert.equal(out.severity, 'regenerate');
  assert.deepEqual(out.violations.map((v) => v.rule), ['two_questions']);
  assert.ok(isStyleOnly(out.violations), 'style-only: a second miss is salvaged and sent, never blocked');
});
