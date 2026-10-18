const test = require('node:test');
const assert = require('node:assert/strict');
const { createModel, ModelOutputError, ModelError } = require('../../src/brain/respond');
const { responseSchema, emptyResponse, validateResponse } = require('../../src/brain/schema');

const good = emptyResponse({ messages: [{ type: 'text', text: 'แล้วแต่งานครับ', explain: false, template: null, alt: null, data: null }], intent: 'pricing', topics: ['pricing'] });
const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 900 } };

// A scripted OpenAI client: each queue item is a completion, an Error to throw, or a function of the request.
function fakeClient(queue) {
  const calls = [];
  return {
    calls,
    chat: { completions: { async create(body, opts) {
      calls.push({ body, opts });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(body);
      return next;
    } } },
  };
}
const completion = (content, extra = {}) => ({ choices: [{ message: { content, refusal: null, ...extra.message }, finish_reason: extra.finish_reason || 'stop' }], usage });
const req = (system = 'SYS') => ({ system, messages: [{ role: 'user', content: 'ราคาเท่าไหร่' }], schema: responseSchema });

test('valid output → parsed response with non-enumerable _meta; request carries strict json_schema and the system prompt', async () => {
  const client = fakeClient([completion(JSON.stringify(good))]);
  const model = createModel({ client, model: 'test-model', maxTokens: 777, temperature: 0.2, timeoutMs: 1234 });
  const r = await model.respond(req());
  assert.ok(validateResponse(r).ok);
  assert.equal(r.intent, 'pricing');
  assert.ok(!Object.keys(r).includes('_meta'));
  assert.equal(r._meta.repaired, false);
  assert.equal(r._meta.attempts, 1);
  assert.equal(r._meta.usage.prompt_tokens, 1000);
  assert.equal(r._meta.usage.cached_tokens, 900);
  assert.ok(typeof r._meta.latencyMs === 'number');
  const { body, opts } = client.calls[0];
  assert.equal(body.model, 'test-model');
  assert.equal(body.max_tokens, 777);
  assert.deepEqual(body.usage, { include: true }, 'OpenRouter returns usage.cost only when asked');
  assert.equal(body.temperature, 0.2);
  // lay_turn is strict-compatible since 2026-10-18 (card data = JSON string) → sent as strict: true
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { ...responseSchema, strict: true } });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'SYS');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(opts.timeout, 1234);
});

test('messages that already start with a system message are not double-prefixed', async () => {
  const client = fakeClient([completion(JSON.stringify(good))]);
  const model = createModel({ client });
  await model.respond({ system: 'IGNORED', messages: [{ role: 'system', content: 'S1' }, { role: 'user', content: 'x' }], schema: responseSchema });
  assert.equal(client.calls[0].body.messages.filter((m) => m.role === 'system').length, 1);
  assert.equal(client.calls[0].body.messages[0].content, 'S1');
});

test('invalid then repaired → ok, repair call quotes the errors and the bad output', async () => {
  const bad = { ...good, intent: 'fly', quick_replies: ['a', 'b', 'c', 'd', 'e'] };
  const client = fakeClient([completion(JSON.stringify(bad)), completion(JSON.stringify(good))]);
  const warns = [];
  const model = createModel({ client, log: { warn: (e, f) => warns.push([e, f]), info() {}, error() {} } });
  const r = await model.respond(req());
  assert.ok(validateResponse(r).ok);
  assert.equal(r._meta.repaired, true);
  assert.equal(r._meta.attempts, 2);
  assert.equal(r._meta.usage.prompt_tokens, 2000, 'usage summed over both calls');
  assert.equal(client.calls.length, 2);
  const repair = client.calls[1].body.messages;
  assert.equal(repair.at(-2).role, 'assistant');
  assert.equal(repair.at(-2).content, JSON.stringify(bad));
  assert.equal(repair.at(-1).role, 'user');
  assert.ok(repair.at(-1).content.includes('intent: unknown fly'));
  assert.ok(repair.at(-1).content.includes('quick_replies: array ≤ 4'));
  assert.ok(warns.some(([e]) => e === 'model_output_invalid'));
});

test('unparseable JSON counts as invalid and is repaired', async () => {
  const client = fakeClient([completion('{not json'), completion(JSON.stringify(good))]);
  const r = await createModel({ client }).respond(req());
  assert.equal(r._meta.repaired, true);
  assert.ok(client.calls[1].body.messages.at(-1).content.includes('not JSON'));
});

test('invalid twice → ModelOutputError kind invalid, with errors and usage', async () => {
  const client = fakeClient([completion('{"not":"valid"}'), completion('garbage')]);
  await assert.rejects(createModel({ client }).respond(req()), (err) => {
    assert.ok(err instanceof ModelOutputError);
    assert.ok(err instanceof ModelError);
    assert.equal(err.kind, 'invalid');
    assert.ok(Array.isArray(err.errors) && err.errors.length);
    assert.equal(err.attempts, 2);
    assert.equal(err.usage.total_tokens, 2100);
    return true;
  });
  assert.equal(client.calls.length, 2, 'no third call');
});

test('refusal → kind refusal; length cutoff → kind length; empty choice → kind empty (no repair attempted)', async () => {
  let client = fakeClient([completion(null, { message: { refusal: 'I cannot help with that' } })]);
  await assert.rejects(createModel({ client }).respond(req()), (e) => e instanceof ModelOutputError && e.kind === 'refusal' && /cannot help/.test(e.message));
  assert.equal(client.calls.length, 1);

  client = fakeClient([completion('{"messages":[', { finish_reason: 'length' })]);
  await assert.rejects(createModel({ client }).respond(req()), (e) => e.kind === 'length');

  client = fakeClient([{ choices: [], usage }]);
  await assert.rejects(createModel({ client }).respond(req()), (e) => e.kind === 'empty');
});

test('provider errors → ModelError kind provider; timeouts → kind timeout', async () => {
  const boom = Object.assign(new Error('401 invalid api key'), { status: 401, name: 'AuthenticationError' });
  await assert.rejects(createModel({ client: fakeClient([boom]) }).respond(req()), (e) => {
    assert.ok(e instanceof ModelError && !(e instanceof ModelOutputError));
    assert.equal(e.kind, 'provider');
    assert.equal(e.status, 401);
    assert.equal(e.cause, boom);
    return true;
  });
  // a timeout earns one try on the fallback model (doc/llm.md §2); when that times out too the kind is still timeout
  const slow = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
  const slowClient = fakeClient([slow, slow]);
  await assert.rejects(createModel({ client: slowClient }).respond(req()), (e) => e.kind === 'timeout');
  assert.equal(slowClient.calls.length, 2);
  assert.notEqual(slowClient.calls[1].body.model, slowClient.calls[0].body.model);
  // an error during the repair call surfaces as a provider error too (never silent)
  const client = fakeClient([completion('{}'), boom]);
  await assert.rejects(createModel({ client }).respond(req()), (e) => e.kind === 'provider');
});

test('defaults come from src/agents.config.js; a missing schema is rejected before any call', async () => {
  const cfg = require('../../src/agents.config').agentLay;
  const client = fakeClient([completion(JSON.stringify(good))]);
  const model = createModel({ client });
  assert.equal(model.config.model, cfg.model);
  assert.equal(model.config.maxTokens, cfg.maxTokens);
  assert.equal(model.config.timeoutMs, 20000);
  await assert.rejects(model.respond({ system: 'S', messages: [] }), (e) => e.kind === 'invalid_request');
  assert.equal(client.calls.length, 0);
});
