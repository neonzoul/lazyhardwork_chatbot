// brain/router + agents.config: every LLM use is a named task with a model, a fallback and a reason (doc/llm.md §1).
const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../../src/brain/router');
const agentsConfig = require('../../src/agents.config');

const REQUIRED = ['id', 'agent', 'purpose', 'model', 'fallback_models', 'max_tokens', 'temperature', 'structured', 'reason', 'cost_note', 'timeout_ms', 'enabled'];

test('every task row is complete and uses OpenRouter ids', () => {
  assert.ok(agentsConfig.tasks.length >= 5);
  for (const t of agentsConfig.tasks) {
    for (const k of REQUIRED) assert.ok(t[k] !== undefined, `${t.id}: ${k} missing`);
    assert.match(t.model, /^[a-z0-9-]+\/[a-z0-9.-]+$/i, `${t.id}: model "${t.model}" is not provider/model`);
    for (const f of t.fallback_models) assert.match(f, /^[a-z0-9-]+\/[a-z0-9.-]+$/i);
    assert.ok(t.reason.length > 20, `${t.id}: reason too short`);
  }
  const ids = agentsConfig.tasks.map((t) => t.id);
  for (const id of ['lay.reply', 'lay.repair', 'demo.reply', 'qa.judge', 'kb.rewrite']) assert.ok(ids.includes(id), `task ${id} missing`);
  assert.equal(new Set(ids).size, ids.length, 'task ids unique');
});

test('resolve: config defaults; lay.reply = gpt-4o-mini with gpt-4.1-mini fallback; repair is capped at 600 tokens', () => {
  const lay = router.resolve('lay.reply', { overrides: {} });
  assert.equal(lay.model, 'openai/gpt-4o-mini');
  assert.deepEqual(lay.fallback_models, ['openai/gpt-4.1-mini']);
  assert.equal(lay.structured, true);
  assert.equal(lay.source, 'config');
  const repair = router.resolve('lay.repair', { overrides: {} });
  assert.equal(repair.max_tokens, 600);
  assert.equal(repair.model, lay.model);
  const judge = router.resolve('qa.judge', { overrides: {} });
  assert.equal(judge.model, 'openai/gpt-4.1');
  assert.ok(judge.fallback_models.includes('anthropic/claude-sonnet-4.5'));
  assert.equal(router.resolve('kb.rewrite', { overrides: {} }).enabled, false);
});

test('env override LLM_MODEL_<TASK> wins and is reported as source env; blank values are ignored', () => {
  assert.equal(router.envKeyFor('lay.reply'), 'LLM_MODEL_LAY_REPLY');
  assert.equal(router.envKeyFor('demo.reply'), 'LLM_MODEL_DEMO_REPLY');
  const r = router.resolve('lay.reply', { overrides: { LLM_MODEL_LAY_REPLY: ' openai/gpt-4.1-mini ' } });
  assert.equal(r.model, 'openai/gpt-4.1-mini');
  assert.equal(r.source, 'env');
  assert.equal(router.resolve('lay.reply', { overrides: { LLM_MODEL_LAY_REPLY: '  ' } }).model, 'openai/gpt-4o-mini');
  // the override never mutates the table
  assert.equal(agentsConfig.tasks.find((t) => t.id === 'lay.reply').model, 'openai/gpt-4o-mini');
});

test('unknown task throws with the known list; listTasks resolves every row; NO_LLM documents the deterministic paths', () => {
  assert.throws(() => router.resolve('nope.task'), /unknown task "nope.task".*lay\.reply/);
  const all = router.listTasks({ overrides: { LLM_MODEL_QA_JUDGE: 'anthropic/claude-sonnet-4.5' } });
  assert.equal(all.length, agentsConfig.tasks.length);
  assert.equal(all.find((t) => t.id === 'qa.judge').model, 'anthropic/claude-sonnet-4.5');
  assert.ok(router.NO_LLM.length >= 8);
  for (const row of router.NO_LLM) { assert.ok(row.what && row.where && row.why); }
  const whats = router.NO_LLM.map((r) => r.what.toLowerCase()).join(' ');
  for (const w of ['opening', 'rich menu', 'fit', 'booking', 'handoff', 'quiet', 'lint', 'demo', 'lead']) assert.ok(whats.includes(w), `NO_LLM lacks ${w}`);
});

test('agentLay compatibility shape mirrors lay.reply', () => {
  const lay = agentsConfig.tasks.find((t) => t.id === 'lay.reply');
  assert.equal(agentsConfig.agentLay.model, lay.model);
  assert.equal(agentsConfig.agentLay.maxTokens, lay.max_tokens);
  assert.equal(agentsConfig.agentLay.timeoutMs, 20000);
});
