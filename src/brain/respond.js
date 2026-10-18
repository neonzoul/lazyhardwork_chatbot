// The structured-output call (design §1.2 step 6, §2; doc/llm.md). The only module outside src/line, src/discord and
// src/store that may require a provider SDK. Provider: OpenRouter through the `openai` SDK (`baseURL`). Everything
// the turn needs is on the returned object; everything that goes wrong is a thrown error with a `kind` so core/turn
// can pick the fallback and log one event.
//
//   createModel({ task = 'lay.reply', keys?, keyring?, tracker?, log?, client?, model?, maxTokens?, temperature?, timeoutMs? })
//     → { respond({ system, messages, schema, meta }) → Promise<response>, config, keyring }
//
//   respond: one call with response_format json_schema when the task is structured (strict when the schema allows it —
//   see providerSchema: the card `data` object is free-form, so today's lay_turn goes out with strict: false and
//   validateResponse + the repair call hold the contract); parse → validateResponse;
//   on failure ONE repair call (lay.repair caps) that quotes the errors; then throw ModelOutputError.
//   Key rotation: HTTP 402 / credit 429 ⇒ key marked exhausted, same request retried on the next key; none left ⇒
//   kind 'exhausted' (and while the keyring says exhausted, no call is made at all).
//   Model fallback: provider 5xx / network / timeout on the first call ⇒ fallback_models[0] once (tracked separately).
//   Every attempt → tracker.record(row) (llm_calls + budget); never throws, never blocks the reply.
//   `_meta` (non-enumerable): usage (+ cost_usd, cached_tokens), latencyMs, model actually used, attempts, repaired,
//   key_index, fallback_model.
//
// Error kinds: 'invalid' (schema failed twice) · 'refusal' · 'length' · 'empty' · 'timeout' (per task, 20 s)
//              'provider' (HTTP / network / auth) · 'exhausted' (key limit) · 'disabled' (task off) · 'invalid_request'

const router = require('./router');
const { validateResponse } = require('./schema');
const { createKeyring } = require('./keys');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const APP_TITLE = 'Lay v2 (LazyHardWork)';
const DEFAULT_REFERER = 'https://lhw.anant-agent.com';
// "Rate limited" alone is a plain 429 (retry later); only credit / key-limit wording means the key is spent.
const EXHAUSTED_RE = /credit|quota|budget|insufficient|key limit|limit (?:exceeded|reached)|spend(?:ing)? limit|exceeded .*limit/i;

class ModelError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

class ModelOutputError extends ModelError {
  constructor(kind, message, extra = {}) {
    super(kind, message, extra);
    this.name = 'ModelOutputError';
  }
}

function appConfig() { try { return require('../config'); } catch { return null; } }

// OpenAI strict mode rejects any object without `additionalProperties: false` (and so any free-form object such as the
// card `data`). Find the first such place; the schema is then sent with strict: false (JSON mode guided by the schema;
// validateResponse + the repair call keep the contract). Returns null when the schema is strict-compatible.
function strictViolation(node, path = 'schema') {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) { const v = strictViolation(node[i], `${path}[${i}]`); if (v) return v; } return null; }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes('object') && node.additionalProperties !== false) return `${path}: additionalProperties must be false`;
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) { const r = strictViolation(v, `${path}.${k}`); if (r) return r; }
  if (node.items) { const r = strictViolation(node.items, `${path}.items`); if (r) return r; }
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (node[key]) { const r = strictViolation(node[key], `${path}.${key}`); if (r) return r; }
  return null;
}

function providerSchema(schema, log) {
  if (!schema || typeof schema !== 'object' || !schema.strict) return schema;
  const violation = strictViolation(schema.schema);
  if (!violation) return schema;
  if (log && !providerSchema.warned) { providerSchema.warned = true; log.warn('llm.schema_not_strict', { name: schema.name, violation }); }
  return { ...schema, strict: false };
}

function parseJson(content) {
  if (typeof content !== 'string') return { ok: false, errors: ['no content'] };
  try {
    const value = JSON.parse(content);
    // strict schema carries card data as a JSON string; the pipeline works with objects
    if (value && Array.isArray(value.messages)) for (const m of value.messages) {
      if (m && m.type === 'card' && typeof m.data === 'string') { try { m.data = JSON.parse(m.data); } catch { /* validateResponse reports it */ } }
    }
    return { ok: true, value };
  } catch (e) { return { ok: false, errors: [`not JSON: ${e.message}`] }; }
}

function errorText(err) {
  let body = '';
  try { body = err && err.error ? JSON.stringify(err.error) : ''; } catch { body = ''; }
  return `${(err && err.name) || ''} ${(err && err.message) || String(err)} ${body}`;
}

// 402, or a 429/403 whose body talks about credits / limits ⇒ the key is spent (OpenRouter key limit or account credit).
function isExhaustedError(err) {
  const status = err && err.status;
  if (status === 402) return true;
  if ((status === 429 || status === 403) && EXHAUSTED_RE.test(errorText(err))) return true;
  return false;
}

function classifyProviderError(err) {
  const text = errorText(err);
  const status = err && err.status;
  if (isExhaustedError(err)) return new ModelError('exhausted', `key limit exhausted: ${(err && err.message) || status}`, { cause: err, status });
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(text)) return new ModelError('timeout', `model call timed out: ${err && err.message}`, { cause: err, status });
  return new ModelError('provider', `model provider error: ${(err && err.message) || String(err)}`, { cause: err, status });
}

// Worth one try on the fallback model: the provider broke, not our request.
function retryableOnFallback(err) {
  if (err.kind === 'timeout') return true;
  if (err.kind === 'provider') return !err.status || err.status >= 500;
  return false;
}

function addUsage(total, usage) {
  if (!usage) return total;
  total.prompt_tokens += usage.prompt_tokens || 0;
  total.completion_tokens += usage.completion_tokens || 0;
  total.total_tokens += usage.total_tokens || 0;
  const cached = usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens;
  if (cached) total.cached_tokens += cached;
  if (Number.isFinite(usage.cost)) total.cost_usd += usage.cost;
  return total;
}

function createModel(opts = {}) {
  const task = router.resolve(opts.task || 'lay.reply', { overrides: opts.overrides });
  const repairTask = task.id === 'lay.reply' || task.id === 'demo.reply' ? router.resolve('lay.repair', { overrides: opts.overrides }) : null;
  const cfg = appConfig();
  const config = {
    task: task.id,
    agent: task.agent,
    model: opts.model || task.model,
    fallbackModels: Array.isArray(opts.fallbackModels) ? opts.fallbackModels : task.fallback_models,
    maxTokens: opts.maxTokens || task.max_tokens,
    repairMaxTokens: opts.repairMaxTokens || (repairTask ? repairTask.max_tokens : null) || opts.maxTokens || task.max_tokens,
    temperature: opts.temperature !== undefined ? opts.temperature : task.temperature,
    timeoutMs: opts.timeoutMs || task.timeout_ms,
    structured: opts.structured !== undefined ? !!opts.structured : !!task.structured,
    enabled: task.enabled !== false,
    baseURL: opts.baseURL || OPENROUTER_BASE_URL,
    referer: opts.referer || (cfg && cfg.publicBaseUrl) || DEFAULT_REFERER,
    title: APP_TITLE,
  };
  const log = opts.log || null;
  const tracker = opts.tracker || null;

  let keyring = opts.keyring || null;
  if (!keyring) {
    const keys = opts.keys || (opts.apiKey ? [opts.apiKey] : ((cfg && cfg.llm && cfg.llm.openrouterKeys) || []));
    keyring = createKeyring({ keys: keys.length ? keys : (opts.client ? ['injected-client'] : []), log: log || undefined });
  }

  const clients = new Map();
  function clientFor(key) {
    if (opts.client) return opts.client;
    if (!clients.has(key.index)) {
      // eslint-disable-next-line global-require
      const OpenAI = require('openai');
      clients.set(key.index, new OpenAI({
        apiKey: key.key, baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 0,
        defaultHeaders: { 'HTTP-Referer': config.referer, 'X-Title': config.title },
      }));
    }
    return clients.get(key.index);
  }

  function track(row) {
    if (!tracker || typeof tracker.record !== 'function') return;
    try { tracker.record(row); } catch (err) { if (log) log.warn('llm.track_failed', { error: err && err.message }); }
  }

  // One HTTP call. Returns { content, finishReason, usage, latencyMs, requestId, done(outcome) }; throws a classified error
  // (already tracked as error/exhausted). The caller tracks the success outcome once it knows whether the output was valid.
  async function callOnce({ messages, schema, model, key, maxTokens, meta, attemptNo }) {
    const started = Date.now();
    const base = { ts: new Date(started).toISOString(), task: (meta && meta.task) || config.task, agent: (meta && meta.agent) || config.agent, model, key_index: key.index, user_id: (meta && meta.user_id) || null, attempts: attemptNo };
    let completion;
    try {
      const body = {
        model, messages, temperature: config.temperature, max_tokens: maxTokens,
        usage: { include: true },
      };
      if (config.structured && schema) body.response_format = { type: 'json_schema', json_schema: providerSchema(schema, log) };
      completion = await clientFor(key).chat.completions.create(body, { timeout: config.timeoutMs });
    } catch (err) {
      const e = err instanceof ModelError ? err : classifyProviderError(err);
      track({ ...base, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, total_tokens: 0, cost_usd: 0, latency_ms: Date.now() - started, outcome: e.kind === 'exhausted' ? 'exhausted' : 'error', error: e.message.slice(0, 300), request_id: null });
      throw e;
    }
    const latencyMs = Date.now() - started;
    const u = completion && completion.usage;
    const tokens = { prompt_tokens: (u && u.prompt_tokens) || 0, completion_tokens: (u && u.completion_tokens) || 0, cached_tokens: (u && u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, total_tokens: (u && u.total_tokens) || 0, cost_usd: (u && Number.isFinite(u.cost)) ? u.cost : 0 };
    const requestId = (completion && completion.id) || null;
    const done = (outcome, error) => track({ ...base, ...tokens, latency_ms: latencyMs, outcome, error: error ? String(error).slice(0, 300) : null, request_id: requestId });
    const choice = completion && completion.choices && completion.choices[0];
    const fail = (kind, message) => { done('error', message); return new ModelOutputError(kind, message, { latencyMs, model, key_index: key.index }); };
    if (!choice || !choice.message) throw fail('empty', 'model returned no choice');
    if (choice.message.refusal) throw fail('refusal', `model refused: ${choice.message.refusal}`);
    if (choice.finish_reason === 'length') throw fail('length', 'model output cut off by max tokens');
    if (choice.finish_reason === 'content_filter') throw fail('refusal', 'model output blocked by content filter');
    return { content: choice.message.content, finishReason: choice.finish_reason, usage: u, latencyMs, requestId, done };
  }

  function exhaustedError(message, extra = {}) {
    return new ModelError('exhausted', message, { keyring: keyring.status(), ...extra });
  }

  async function respond({ system, messages = [], schema, meta = {} } = {}) {
    if (!config.enabled) throw new ModelError('disabled', `llm task ${config.task} is disabled in src/agents.config.js`);
    if (config.structured && !schema) throw new ModelError('invalid_request', 'respond() needs the response schema');
    const convo = [...messages];
    if (system && !(convo[0] && convo[0].role === 'system')) convo.unshift({ role: 'system', content: system });
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, cost_usd: 0 };
    const started = Date.now();
    let attempts = 0;
    let model = config.model;
    let switched = false;
    let key = null;

    const ks = keyring.status();
    if (ks.exhausted) {
      track({ ts: new Date().toISOString(), task: meta.task || config.task, agent: meta.agent || config.agent, model, key_index: null, user_id: meta.user_id || null, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, total_tokens: 0, cost_usd: 0, latency_ms: 0, outcome: 'exhausted', error: ks.configured ? 'skipped: all keys exhausted' : 'skipped: no OpenRouter key configured', request_id: null, attempts: 0 });
      throw exhaustedError(ks.configured ? `all OpenRouter keys exhausted until ${ks.next_retry_at || 'reset'}` : 'OPENROUTER_API_KEY is not set', { skipped: true });
    }

    // First call: rotate keys on exhaustion, switch to the fallback model once on provider failure.
    async function firstCall() {
      let triedFallback = false;
      for (;;) {
        key = keyring.current();
        if (!key) throw exhaustedError('all OpenRouter keys exhausted during the call');
        attempts += 1;
        try {
          return await callOnce({ messages: convo, schema, model, key, maxTokens: config.maxTokens, meta, attemptNo: attempts });
        } catch (err) {
          if (err.kind === 'exhausted') {
            keyring.markExhausted(key.index, err.message, { limitReset: 'daily' });
            if (keyring.current()) { if (log) log.warn('llm.key_rotated', { from: key.index, task: config.task }); continue; }
            throw exhaustedError(err.message, { cause: err, status: err.status });
          }
          if (!triedFallback && retryableOnFallback(err) && config.fallbackModels[0] && config.fallbackModels[0] !== model) {
            triedFallback = true;
            if (log) log.warn('llm.fallback_model', { task: config.task, from: model, to: config.fallbackModels[0], kind: err.kind, error: err.message });
            model = config.fallbackModels[0];
            switched = true;
            continue;
          }
          throw err;
        }
      }
    }

    const first = await firstCall();
    addUsage(usage, first.usage);

    const finish = (value, { repaired }) => {
      Object.defineProperty(value, '_meta', {
        value: { usage, latencyMs: Date.now() - started, model, requestedModel: config.model, repaired, attempts, key_index: key.index, fallback_model: switched, task: config.task },
        enumerable: false, writable: true, configurable: true,
      });
      return value;
    };

    if (!config.structured) {
      first.done(switched ? 'fallback_model' : 'ok');
      return finish({ text: typeof first.content === 'string' ? first.content : '' }, { repaired: false });
    }

    let parsed = parseJson(first.content);
    let check = parsed.ok ? validateResponse(parsed.value) : { ok: false, errors: parsed.errors };
    if (check.ok) {
      first.done(switched ? 'fallback_model' : 'ok');
      return finish(parsed.value, { repaired: false });
    }

    first.done('invalid', check.errors.join('; '));
    if (log) log.warn('model_output_invalid', { errors: check.errors.join('; ').slice(0, 300), model });
    const repairConvo = [
      ...convo,
      { role: 'assistant', content: typeof first.content === 'string' ? first.content : '' },
      { role: 'user', content: `Your previous output failed validation: ${check.errors.join('; ')}. Return a corrected JSON object only, following the schema exactly. Keep the same Thai wording where it was fine.` },
    ];
    attempts += 1;
    let second;
    try {
      second = await callOnce({ messages: repairConvo, schema, model, key, maxTokens: config.repairMaxTokens, meta: { ...meta, task: meta.task || (repairTask ? repairTask.id : config.task) }, attemptNo: attempts });
    } catch (err) {
      if (err.kind === 'exhausted') { keyring.markExhausted(key.index, err.message, { limitReset: 'daily' }); throw exhaustedError(err.message, { cause: err, status: err.status }); }
      throw err;
    }
    addUsage(usage, second.usage);
    parsed = parseJson(second.content);
    check = parsed.ok ? validateResponse(parsed.value) : { ok: false, errors: parsed.errors };
    if (!check.ok) {
      second.done('invalid', check.errors.join('; '));
      throw new ModelOutputError('invalid', `model output failed validation twice: ${check.errors.join('; ')}`, { errors: check.errors, usage, latencyMs: Date.now() - started, attempts, model, key_index: key.index });
    }
    second.done('repaired');
    return finish(parsed.value, { repaired: true });
  }

  return { respond, config, keyring, task };
}

module.exports = { createModel, ModelError, ModelOutputError, classifyProviderError, isExhaustedError, strictViolation, providerSchema, OPENROUTER_BASE_URL };
