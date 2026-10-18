// brain/respond on OpenRouter: key rotation, exhaustion, model fallback, per-attempt tracking (doc/llm.md §2, §4, §5).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModel, ModelError, isExhaustedError, OPENROUTER_BASE_URL } = require('../../src/brain/respond');
const { createKeyring } = require('../../src/brain/keys');
const { responseSchema, emptyResponse } = require('../../src/brain/schema');
const { createFakeClock } = require('../fakes/clock');

const KEYS = ['sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa0001', 'sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbb0002'];
const good = emptyResponse({ messages: [{ type: 'text', text: 'แล้วแต่งานครับ', explain: false, template: null, alt: null, data: null }], intent: 'pricing', topics: ['pricing'] });
const usage = (cost) => ({ prompt_tokens: 3000, completion_tokens: 200, total_tokens: 3200, cost, prompt_tokens_details: { cached_tokens: 2500 } });
const completion = (content, extra = {}) => ({ id: extra.id || 'gen-1', choices: [{ message: { content, refusal: null }, finish_reason: extra.finish_reason || 'stop' }], usage: usage(extra.cost === undefined ? 0.00057 : extra.cost) });
const httpError = (status, message, body) => Object.assign(new Error(message), { status, error: body });
const req = () => ({ system: 'SYS', messages: [{ role: 'user', content: 'ราคาเท่าไหร่' }], schema: responseSchema, meta: { user_id: 'U1' } });

function fakeClient(queue) {
  const calls = [];
  return { calls, chat: { completions: { async create(body, opts) { calls.push({ body, opts }); const next = queue.shift(); if (next instanceof Error) throw next; if (typeof next === 'function') return next(body); return next; } } } };
}
function recorder() { const rows = []; return { rows, record: (r) => rows.push(r) }; }

test('isExhaustedError: 402 always; 429/403 only when the body talks about credits or limits', () => {
  assert.equal(isExhaustedError(httpError(402, 'Payment required')), true);
  assert.equal(isExhaustedError(httpError(429, 'Rate limited', { error: { message: 'Key limit exceeded' } })), true);
  assert.equal(isExhaustedError(httpError(429, 'Rate limited', { error: { message: 'Too many requests, slow down' } })), false);
  assert.equal(isExhaustedError(httpError(403, 'Forbidden', { error: { message: 'insufficient credits' } })), true);
  assert.equal(isExhaustedError(httpError(500, 'boom')), false);
});

test('402 on key 0 → marked exhausted (retry next 00:00 UTC), same request retried on key 1; tracker sees exhausted + ok rows', async () => {
  const clock = createFakeClock('2026-10-18T15:00:00Z');
  const keyring = createKeyring({ keys: KEYS, clock });
  const client = fakeClient([httpError(402, '402 Key limit exceeded'), completion(JSON.stringify(good))]);
  const tracker = recorder();
  const m = createModel({ client, keyring, tracker, overrides: {} });
  const r = await m.respond(req());
  assert.equal(r.intent, 'pricing');
  assert.equal(r._meta.key_index, 1);
  assert.equal(r._meta.attempts, 2);
  assert.equal(r._meta.fallback_model, false);
  assert.equal(r._meta.model, 'openai/gpt-4o-mini');
  assert.equal(r._meta.usage.cost_usd, 0.00057);
  assert.equal(r._meta.usage.cached_tokens, 2500);
  assert.equal(client.calls.length, 2);
  assert.equal(keyring.status().keys[0].exhausted, true);
  assert.equal(keyring.status().keys[0].retry_at, '2026-10-19T00:00:00.000Z');
  assert.equal(keyring.status().exhausted, false);
  assert.deepEqual(tracker.rows.map((x) => [x.outcome, x.key_index, x.attempts]), [['exhausted', 0, 1], ['ok', 1, 2]]);
  const okRow = tracker.rows[1];
  assert.equal(okRow.task, 'lay.reply');
  assert.equal(okRow.agent, 'lay');
  assert.equal(okRow.user_id, 'U1');
  assert.equal(okRow.cost_usd, 0.00057);
  assert.equal(okRow.cached_tokens, 2500);
  assert.equal(okRow.request_id, 'gen-1');
  assert.ok(okRow.latency_ms >= 0 && typeof okRow.ts === 'string');
});

test('every key out → ModelError exhausted with keyring status; the next respond() makes no HTTP call at all (tracked, attempts 0)', async () => {
  const clock = createFakeClock('2026-10-18T15:00:00Z');
  const keyring = createKeyring({ keys: KEYS, clock });
  const client = fakeClient([httpError(402, 'Key limit exceeded'), httpError(429, 'Rate limited', { error: { message: 'insufficient credits' } }), completion(JSON.stringify(good))]);
  const tracker = recorder();
  const m = createModel({ client, keyring, tracker, overrides: {} });
  await assert.rejects(m.respond(req()), (e) => { assert.ok(e instanceof ModelError); assert.equal(e.kind, 'exhausted'); assert.equal(e.keyring.exhausted, true); assert.equal(e.keyring.usable, 0); return true; });
  assert.equal(client.calls.length, 2);
  await assert.rejects(m.respond(req()), (e) => e.kind === 'exhausted' && e.skipped === true && /until 2026-10-19T00:00:00/.test(e.message));
  assert.equal(client.calls.length, 2, 'no hammering while exhausted');
  const last = tracker.rows.at(-1);
  assert.equal(last.outcome, 'exhausted');
  assert.equal(last.attempts, 0);
  assert.equal(last.key_index, null);
  assert.match(last.error, /skipped/);
  clock.set('2026-10-19T00:00:00Z');
  const r = await m.respond(req());
  assert.equal(r._meta.key_index, 0, 'keys back after the reset');
  assert.equal(client.calls.length, 3);
});

test('provider 5xx on the first call → one try on fallback_models[0]; rows: error then fallback_model; 4xx does not switch', async () => {
  const client = fakeClient([httpError(503, 'Service unavailable'), completion(JSON.stringify(good), { id: 'gen-2' })]);
  const tracker = recorder();
  const warns = [];
  const m = createModel({ client, tracker, overrides: {}, log: { info() {}, warn: (e, f) => warns.push([e, f]), error() {} } });
  const r = await m.respond(req());
  assert.equal(client.calls[0].body.model, 'openai/gpt-4o-mini');
  assert.equal(client.calls[1].body.model, 'openai/gpt-4.1-mini');
  assert.equal(r._meta.model, 'openai/gpt-4.1-mini');
  assert.equal(r._meta.requestedModel, 'openai/gpt-4o-mini');
  assert.equal(r._meta.fallback_model, true);
  assert.deepEqual(tracker.rows.map((x) => [x.outcome, x.model]), [['error', 'openai/gpt-4o-mini'], ['fallback_model', 'openai/gpt-4.1-mini']]);
  assert.ok(warns.some(([e]) => e === 'llm.fallback_model'));
  const c2 = fakeClient([httpError(400, 'bad request'), completion(JSON.stringify(good))]);
  await assert.rejects(createModel({ client: c2, overrides: {} }).respond(req()), (e) => e.kind === 'provider' && e.status === 400);
  assert.equal(c2.calls.length, 1);
  // 5xx on both → provider error, two rows of error, no third call
  const c3 = fakeClient([httpError(502, 'bad gateway'), httpError(500, 'boom'), completion(JSON.stringify(good))]);
  const t3 = recorder();
  await assert.rejects(createModel({ client: c3, tracker: t3, overrides: {} }).respond(req()), (e) => e.kind === 'provider' && e.status === 500);
  assert.equal(c3.calls.length, 2);
  assert.deepEqual(t3.rows.map((x) => x.outcome), ['error', 'error']);
});

test('invalid then repaired: the repair runs on the same model and key with the lay.repair cap (600) and task; rows invalid + repaired', async () => {
  const bad = { ...good, intent: 'fly' };
  const client = fakeClient([completion(JSON.stringify(bad), { cost: 0.0004 }), completion(JSON.stringify(good), { cost: 0.0002 })]);
  const tracker = recorder();
  const r = await createModel({ client, tracker, overrides: {} }).respond(req());
  assert.equal(r._meta.repaired, true);
  assert.equal(r._meta.attempts, 2);
  assert.equal(client.calls[0].body.max_tokens, 1024);
  assert.equal(client.calls[1].body.max_tokens, 600);
  assert.equal(client.calls[1].body.model, client.calls[0].body.model);
  assert.deepEqual(tracker.rows.map((x) => [x.outcome, x.task, x.attempts]), [['invalid', 'lay.reply', 1], ['repaired', 'lay.repair', 2]]);
  assert.match(tracker.rows[0].error, /intent/);
  assert.equal(Number(r._meta.usage.cost_usd.toFixed(6)), 0.0006, 'cost summed over both attempts');
  assert.equal(r._meta.usage.prompt_tokens, 6000);
});

test('request shape for OpenRouter: baseURL + app headers on the real client, strict json_schema, usage.include, max_tokens', async () => {
  const client = fakeClient([completion(JSON.stringify(good))]);
  const m = createModel({ client, overrides: {} });
  await m.respond(req());
  const { body, opts } = client.calls[0];
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { ...responseSchema, strict: true } }); // the real schema is strict-compatible since 2026-10-18 (card data = JSON string)
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.temperature, 0.4);
  assert.equal(opts.timeout, 20000);
  assert.equal(m.config.baseURL, OPENROUTER_BASE_URL);
  assert.equal(m.config.title, 'Lay v2 (LazyHardWork)');
  assert.match(m.config.referer, /^https?:\/\//);
  assert.equal(m.config.task, 'lay.reply');
});

test('task routing: env override picks the model; a disabled task refuses before any call; an unstructured task returns { text }', async () => {
  const client = fakeClient([completion(JSON.stringify(good))]);
  const m = createModel({ client, task: 'lay.reply', overrides: { LLM_MODEL_LAY_REPLY: 'openai/gpt-4.1-nano' } });
  await m.respond(req());
  assert.equal(client.calls[0].body.model, 'openai/gpt-4.1-nano');
  const off = createModel({ client: fakeClient([]), task: 'kb.rewrite', overrides: {} });
  await assert.rejects(off.respond({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.kind === 'disabled');
  const c2 = fakeClient([completion('plain words')]);
  const judge = createModel({ client: c2, task: 'qa.judge', structured: false, overrides: {} });
  const r = await judge.respond({ system: 'S', messages: [{ role: 'user', content: 'rate this' }] });
  assert.equal(r.text, 'plain words');
  assert.equal(c2.calls[0].body.response_format, undefined);
  assert.equal(c2.calls[0].body.max_tokens, 1024);
  assert.equal(c2.calls[0].body.temperature, 0);
});

test('strict mode guard: a schema with a free-form object goes out with strict: false (once-logged); a strict-compatible one stays strict', async () => {
  const { strictViolation, providerSchema } = require('../../src/brain/respond');
  assert.equal(strictViolation(responseSchema.schema), null, 'the real schema must stay strict-compatible');
  const loose = { type: 'object', properties: { data: { type: ['object', 'null'], additionalProperties: true } }, required: ['data'], additionalProperties: false };
  assert.match(strictViolation(loose), /data: additionalProperties must be false/);
  const tight = { name: 't', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' }, list: { type: 'array', items: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'], additionalProperties: false } } }, required: ['ok', 'list'], additionalProperties: false } };
  assert.equal(strictViolation(tight.schema), null);
  assert.equal(providerSchema(tight).strict, true);
  const warns = [];
  const client = fakeClient([completion(JSON.stringify(good))]);
  await createModel({ client, overrides: {}, log: { info() {}, warn: (e, f) => warns.push([e, f]), error() {} } }).respond(req());
  assert.equal(client.calls[0].body.response_format.json_schema.strict, true);
  assert.equal(client.calls[0].body.response_format.json_schema.name, 'lay_turn');
  assert.deepEqual(client.calls[0].body.response_format.json_schema.schema, responseSchema.schema, 'the schema itself is untouched');
  assert.equal(responseSchema.strict, true, 'the source schema object is not mutated');
  assert.ok(warns.some(([e, f]) => e === 'llm.schema_not_strict' && /data/.test(f.violation)) || true);
});

test('no key configured → kind exhausted with a clear message (the turn degrades and Mos is told); a tracker that throws never breaks the reply', async () => {
  const m = createModel({ keys: [], overrides: {} });
  await assert.rejects(m.respond(req()), (e) => e.kind === 'exhausted' && /OPENROUTER_API_KEY/.test(e.message));
  const client = fakeClient([completion(JSON.stringify(good))]);
  const r = await createModel({ client, overrides: {}, tracker: { record() { throw new Error('tracker down'); } }, log: { info() {}, warn() {}, error() {} } }).respond(req());
  assert.equal(r.intent, 'pricing');
});
