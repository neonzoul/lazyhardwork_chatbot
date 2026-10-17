// flows/fit — the five symptoms, the choice card, the postback hook (brief §3.4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fit = require('../../src/flows/fit');
const { render } = require('../../src/cards/render');
const lint = require('../../src/core/lint');

const ctx = { assets: {}, fastworkUrlFor: () => 'https://fastwork.co/user/mos_lazyhardwork', priceFor: () => ({ price_from: 4900, label_th: 'ราคาเริ่มต้น 4,900 บาท' }) };

test('five symptoms map to the brief §3.4 cards with the exact Thai labels', () => {
  const want = [
    ['chat_overload', 'ตอบแชทลูกค้าไม่ทัน', 'A2'],
    ['scattered_data', 'ข้อมูลกระจาย ต้องตามงานเอง', 'A1'],
    ['repetitive_work', 'งานซ้ำ คีย์ซ้ำทุกวัน', 'A3'],
    ['ai_know_my_work', 'อยากให้ AI รู้จักงานผม', 'A4'],
    ['dont_know_where_to_start', 'ยังไม่รู้จะเริ่มตรงไหน', 'C1'],
  ];
  assert.deepEqual(fit.SYMPTOMS.map((s) => [s.key, s.label, s.card]), want);
});

test('fitChoiceCard renders as a choice card with FIT_ postbacks and a lint-clean title', () => {
  const card = fit.fitChoiceCard();
  assert.equal(card.template, 'choice');
  assert.deepEqual(card.data.options.map((o) => o.postback), fit.SYMPTOMS.map((s) => `FIT_${s.key}`));
  const r = render(card, ctx);
  assert.ok(r.message, r.errors.join('; '));
  assert.equal(r.message.type, 'flex');
  assert.ok(JSON.stringify(r.message.contents).includes('FIT_chat_overload'));
  assert.equal(lint.lintText(card.data.title).ok, true);
  assert.equal(lint.countEmoji(card.data.subtitle), 0);
});

test('onSymptomPostback sets draft and returns the fit hint; unknown data is passed through', () => {
  const s = { draft: {} };
  const r = fit.onSymptomPostback('FIT_repetitive_work', s);
  assert.deepEqual(r, { intentHint: 'fit', userText: 'เลือกอาการ: งานซ้ำ คีย์ซ้ำทุกวัน' });
  assert.equal(s.draft.symptom, 'repetitive_work');
  assert.equal(s.draft.card, 'A3');
  assert.equal(s.draft.tier, 'T1');
  assert.ok(s.intent_hints.includes('fit'));
  assert.equal(fit.alreadyChosen(s), true);
  assert.equal(fit.alreadyChosen({ draft: {} }), false);
  assert.equal(fit.alreadyChosen({}), false);
  const u = fit.onSymptomPostback('FIT_nope', { draft: {} });
  assert.equal(u.intentHint, 'unknown'); assert.equal(u.userText, 'FIT_nope');
});

test('symptomFromText matches labels and loose Thai phrasing, null otherwise', () => {
  assert.equal(fit.symptomFromText('ตอบแชทลูกค้าไม่ทัน'), 'chat_overload');
  assert.equal(fit.symptomFromText('แชทเยอะมากตอบไม่ไหวครับ'), 'chat_overload');
  assert.equal(fit.symptomFromText('ข้อมูลอยู่หลายที่ ต้องตามงานเองตลอด'), 'scattered_data');
  assert.equal(fit.symptomFromText('ต้องคีย์ข้อมูลซ้ำทุกวัน'), 'repetitive_work');
  assert.equal(fit.symptomFromText('อยากให้ AI รู้จักธุรกิจผม'), 'ai_know_my_work');
  assert.equal(fit.symptomFromText('ยังไม่รู้จะเริ่มจากไหนเลย'), 'dont_know_where_to_start');
  assert.equal(fit.symptomFromText('ราคาเท่าไหร่'), null);
  assert.equal(fit.symptomFromText(''), null);
});
