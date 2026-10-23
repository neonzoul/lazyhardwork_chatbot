'use strict';
// Issue #5 (D-37): /health shows model-call status so an outside monitor catches a dead key. No secrets, HTTP 200.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLlmHealth, classifyHealthError } = require('../../src/brain/health');
const { createModel } = require('../../src/brain/respond');
const { createFakeClock } = require('../fakes/clock');

test('error classification: 401 auth · 402 / credit 429 quota · plain 429 rate · timeout · other', () => {
  assert.equal(classifyHealthError({ status: 401, message: 'User not found' }), 'auth');
  assert.equal(classifyHealthError({ status: 402, message: 'Payment required' }), 'quota');
  assert.equal(classifyHealthError({ status: 429, message: 'Key limit exceeded: insufficient credits' }), 'quota');
  assert.equal(classifyHealthError({ status: 403, message: 'credit limit reached' }), 'quota');
  assert.equal(classifyHealthError({ status: 429, message: 'Rate limit, slow down' }), 'rate');
  assert.equal(classifyHealthError({ kind: 'timeout', message: 'model call timed out' }), 'timeout');
  assert.equal(classifyHealthError(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })), 'timeout');
  assert.equal(classifyHealthError({ status: 500, message: 'upstream error' }), 'other');
  assert.equal(classifyHealthError(new Error('socket hang up')), 'other');
});

test('snapshot: timestamps, kind and key count only — never a key or error text', () => {
  const clock = createFakeClock();
  const h = createLlmHealth({ clock, keys: 2 });
  assert.deepEqual(h.snapshot(), { last_ok_at: null, last_error_at: null, last_error_kind: null, keys: 2 });
  h.error({ status: 401, message: 'sk-or-v1-secret User not found' });
  const s = h.snapshot();
  assert.equal(s.last_error_kind, 'auth');
  assert.ok(s.last_error_at);
  assert.doesNotMatch(JSON.stringify(s), /sk-or|User not found/);
  h.ok();
  assert.ok(h.snapshot().last_ok_at);
});

test('createModel feeds the health tracker: a provider 401 is auth, a completion is ok', async () => {
  const health = createLlmHealth({ keys: 1 });
  const failing = { chat: { completions: { create: async () => { throw Object.assign(new Error('User not found'), { status: 401 }); } } } };
  const m1 = createModel({ task: 'lay.reply', keys: ['k1'], client: failing, health, structured: false });
  await assert.rejects(() => m1.respond({ system: 's', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(health.snapshot().last_error_kind, 'auth');
  const working = { chat: { completions: { create: async () => ({ id: 'r1', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) } } };
  const m2 = createModel({ task: 'lay.reply', keys: ['k2'], client: working, health, structured: false });
  await m2.respond({ system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.ok(health.snapshot().last_ok_at);
});
