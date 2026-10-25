// Structural check of every scenario YAML, so a broken scenario fails `npm test` before anyone runs the suite.
//   - steps non-empty, every step is one of the runner's step kinds, every input step is exactly one input
//   - every `model:` block is a schema-valid response once completed by emptyResponse (the fake does the same)
//   - every `expect` key (and expect.session key) is known to the runner — a typo would silently assert nothing
//   - quick-reply labels (scripted and expected) ≤ 20 chars (LINE limit; the policy would drop longer ones)
//   - kb_refs name sections that exist in the pack (the policy drops unknown ids: a scripted ref must be real)
//   - lead_updates.problem_verbatim is a substring of that step's customer text (otherwise the policy nulls it)
//   - `covers:` present and non-empty (the brief §9 / flow H ids the report groups by)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { validateResponse, emptyResponse } = require('../../src/brain/schema');
const { loadScenarios, EXPECT_KEYS, SESSION_EXPECT_KEYS, STEP_KEYS, INPUT_STEP_KEYS } = require('../run-scenarios');

const DIR = path.join(__dirname, '..', 'scenarios');
const LABEL_MAX = 20;
const DECISIONS = ['approve', 'propose', 'decline'];
const FAULT_KEYS = ['notifier', 'model', 'line'];
const FAULT_VALUES = { notifier: ['handoff', 'booking', 'kbGap', 'lead', 'relayToMos'], model: ['throw', 'garbage', 'exhausted'], line: ['reply', 'push'] };

let pack = null;
try { pack = require('../../src/brain/kb').loadPack(path.join(__dirname, '..', '..', 'knowledge')); } catch { pack = null; }

const scenarios = loadScenarios(DIR, null);

test('scenario files exist and parse', () => {
  assert.ok(scenarios.length >= 20, `expected the full set, found ${scenarios.length}`);
  for (const f of fs.readdirSync(DIR)) if (/\.ya?ml$/.test(f)) assert.match(f, /^\d{2}-[a-z0-9-]+\.ya?ml$/, `${f}: name as NN-<slug>.yaml`);
});

for (const sc of scenarios) {
  test(`scenario ${sc.file} is well-formed`, () => {
    const where = (i, what) => `${sc.file} step ${i}: ${what}`;
    assert.ok(typeof sc.name === 'string' && sc.name.trim(), `${sc.file}: name required`);
    assert.ok(Array.isArray(sc.covers) && sc.covers.length, `${sc.file}: covers[] required`);
    assert.ok(Array.isArray(sc.steps) && sc.steps.length, `${sc.file}: steps non-empty`);
    const lines = fs.readFileSync(path.join(DIR, sc.file), 'utf8').split('\n').length;
    assert.ok(lines <= 130, `${sc.file}: ${lines} lines — split it (keep scenarios under ~80 lines)`);

    sc.steps.forEach((step, i) => {
      assert.ok(step && typeof step === 'object', where(i, 'not an object'));
      const keys = Object.keys(step);
      for (const k of keys) assert.ok(STEP_KEYS.includes(k), where(i, `unknown step key "${k}" (known: ${STEP_KEYS.join(', ')})`));
      const inputs = keys.filter((k) => INPUT_STEP_KEYS.includes(k));
      const control = keys.filter((k) => ['fault', 'clock', 'allow'].includes(k));
      if (control.length) {
        assert.equal(inputs.length, 0, where(i, 'a fault/clock/allow step carries no input'));
        if (step.fault) {
          for (const [k, v] of Object.entries(step.fault)) {
            assert.ok(FAULT_KEYS.includes(k), where(i, `unknown fault "${k}"`));
            for (const x of [].concat(v)) assert.ok(FAULT_VALUES[k].includes(x), where(i, `fault.${k}: unknown value "${x}"`));
          }
        }
        if (step.clock) assert.ok(Number.isFinite(step.clock.advance_minutes), where(i, 'clock.advance_minutes must be a number'));
        if (step.allow) assert.ok(Array.isArray(step.allow), where(i, 'allow must be a list of lint ids'));
        return;
      }
      assert.equal(inputs.length, 1, where(i, `exactly one input key (got ${inputs.join(', ') || 'none'})`));
      if (step.mos) assert.ok(step.mos.threadId && step.mos.text, where(i, 'mos needs threadId + text'));
      if (step.decision) {
        assert.ok(DECISIONS.includes(step.decision.decision), where(i, `decision must be one of ${DECISIONS.join('/')}`));
        if (step.decision.decision === 'propose') assert.ok(Array.isArray(step.decision.windows) && step.decision.windows.length >= 1 && step.decision.windows.length <= 3, where(i, 'propose needs 1-3 windows'));
        for (const w of step.decision.windows || []) assert.ok([...String(w)].length <= LABEL_MAX, where(i, `window "${w}" > ${LABEL_MAX} chars (it becomes a quick reply)`));
      }
      if (step.model !== undefined) {
        assert.ok(!step.decision, where(i, 'a decision step has no model block'));
        // a list = the reply, then the regenerated one(s) for the same step; each must be valid
        for (const one of Array.isArray(step.model) ? step.model : [step.model]) {
          const r = typeof one === 'string'
            ? emptyResponse({ messages: [{ type: 'text', text: one, explain: false, template: null, alt: null, data: null }] })
            : emptyResponse(one);
          const v = validateResponse(r);
          assert.ok(v.ok, where(i, `model block invalid: ${v.errors.join('; ')}`));
          for (const q of r.quick_replies) assert.ok([...q].length <= LABEL_MAX, where(i, `scripted quick reply "${q}" > ${LABEL_MAX} chars`));
          if (pack) for (const id of r.kb_refs) assert.ok(pack.sections.has(id), where(i, `kb_ref "${id}" is not a section in knowledge/kb`));
          const pv = r.lead_updates && r.lead_updates.problem_verbatim;
          // a FIT_* postback's customer text is "เลือกอาการ: <label>" (flows/fit), so only free-text steps are checked here
          if (pv && typeof step.user === 'string') assert.ok(step.user.replace(/\s+/g, '').includes(String(pv).replace(/\s+/g, '')), where(i, `problem_verbatim "${pv}" is not in the customer text`));
          for (const m of r.messages) if (m.type === 'text') assert.ok(!/\[Agent Lay\]|ยินดีช่วยเสมอ/.test(m.text), where(i, 'scripted text carries a banned phrase'));
        }
      }
      for (const k of Object.keys(step.expect_scripted || {})) assert.ok(EXPECT_KEYS.includes(k), where(i, `unknown expect_scripted key "${k}"`));
      const e = step.expect || {};
      for (const k of Object.keys(e)) assert.ok(EXPECT_KEYS.includes(k), where(i, `unknown expect key "${k}" (known: ${EXPECT_KEYS.join(', ')})`));
      for (const k of Object.keys(e.session || {})) assert.ok(SESSION_EXPECT_KEYS.includes(k), where(i, `unknown expect.session key "${k}"`));
      for (const q of [...(e.quick_replies || []), ...(e.quick_replies_includes || [])]) assert.ok([...q].length <= LABEL_MAX, where(i, `expected quick reply "${q}" > ${LABEL_MAX} chars`));
      if (e.silent) assert.ok(e.replies === undefined || e.replies === 0, where(i, 'silent steps expect 0 replies'));
      if (!e.silent && step.mos === undefined) assert.ok(Object.keys(e).length > 0, where(i, 'an input step needs at least one expectation'));
    });
  });
}

test('every scenario declares a brief §9 or flow H coverage id', () => {
  for (const sc of scenarios) assert.ok(sc.covers.some((c) => /§9|\bH\d/.test(String(c))), `${sc.file}: covers has no §9 / H id`);
});
