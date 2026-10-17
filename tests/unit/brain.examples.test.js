const test = require('node:test');
const assert = require('node:assert/strict');
const { EXAMPLES } = require('../../src/brain/examples');
const { validateResponse } = require('../../src/brain/schema');
const lint = require('../../src/core/lint');
const { applyPolicy } = require('../../src/core/policy');

test('there are 6–8 examples with unique ids and a user line each', () => {
  assert.ok(EXAMPLES.length >= 6 && EXAMPLES.length <= 8, `got ${EXAMPLES.length}`);
  assert.equal(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length);
  for (const e of EXAMPLES) assert.ok(typeof e.user === 'string' && e.user.trim());
  for (const id of ['capability', 'fit', 'pricing', 'timeline', 'howtostart', 'banter', 'ai_disclosure', 'unknown']) {
    assert.ok(EXAMPLES.some((e) => e.id === id), `missing example ${id}`);
  }
});

test('every example response is schema-valid', () => {
  for (const e of EXAMPLES) {
    const v = validateResponse(e.response);
    assert.ok(v.ok, `${e.id}: ${v.errors.join('; ')}`);
  }
});

test('every example text passes the lint and the policy as-is (no pack → refs are not checked)', () => {
  for (const e of EXAMPLES) {
    for (const m of e.response.messages) {
      if (m.type !== 'text') continue;
      const rep = lint.lintText(m.text, { explain: m.explain });
      assert.ok(rep.ok, `${e.id}: ${rep.errors.join('; ')} in "${m.text.slice(0, 40)}"`);
    }
    const out = applyPolicy(e.response, { userText: e.user });
    assert.equal(out.severity, 'fix', `${e.id}: ${JSON.stringify(out.violations)}`);
    assert.deepEqual(out.fixed, [], `${e.id}: unexpected fixes ${out.fixed.join('; ')}`);
  }
});

test('the fit example fills problem_verbatim with the customer\'s own words; banter has no CTA', () => {
  const fit = EXAMPLES.find((e) => e.id === 'fit');
  assert.ok(fit.user.includes(fit.response.lead_updates.problem_verbatim));
  const banter = EXAMPLES.find((e) => e.id === 'banter');
  assert.deepEqual(banter.response.quick_replies, []);
  assert.equal(banter.response.action, null);
  assert.ok(banter.response.messages.every((m) => m.type === 'text'));
  const unknown = EXAMPLES.find((e) => e.id === 'unknown');
  assert.equal(unknown.response.action, null, 'ไม่รู้ is not a handoff');
  assert.ok(unknown.response.quick_replies.includes('ส่งให้มอสตอบ'));
});
