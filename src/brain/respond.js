// The structured-output call (design §1.2 step 6, §2). The only module outside src/line, src/discord and src/store
// that may require a provider SDK. Everything the turn needs is on the returned object; everything that goes wrong
// is a thrown error with a `kind` so core/turn can pick the fallback and log one event.
//
//   createModel({ apiKey?, model?, maxTokens?, temperature?, timeoutMs?, client?, log? })
//     → { respond({ system, messages, schema }) → Promise<response>, config }
//
//   respond: one call with response_format json_schema (strict); parse → validateResponse; on failure ONE repair
//   call that quotes the errors; then throw ModelOutputError. `_meta` (non-enumerable) carries usage and latency.
//
// Error kinds: 'invalid' (schema failed twice) · 'refusal' (model refused) · 'length' (cut off by max tokens)
//              'timeout' (20 s) · 'provider' (HTTP / network / auth) · 'empty' (no choice/content)

const agentsConfig = require('../agents.config');
const { validateResponse } = require('./schema');

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

function defaultClient(apiKey, timeoutMs) {
  // Lazy so tests never touch the SDK and a missing key only bites when a real call is attempted.
  // eslint-disable-next-line global-require
  const OpenAI = require('openai');
  let key = apiKey;
  if (!key) {
    // eslint-disable-next-line global-require
    key = require('../config').llm.apiKey;
  }
  if (!key) throw new ModelError('provider', 'OPENAI_API_KEY is not set');
  return new OpenAI({ apiKey: key, timeout: timeoutMs, maxRetries: 1 });
}

function parseJson(content) {
  if (typeof content !== 'string') return { ok: false, errors: ['no content'] };
  try { return { ok: true, value: JSON.parse(content) }; } catch (e) { return { ok: false, errors: [`not JSON: ${e.message}`] }; }
}

function classifyProviderError(err) {
  const name = err && err.name || '';
  const msg = err && err.message || String(err);
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(name + ' ' + msg)) return new ModelError('timeout', `model call timed out: ${msg}`, { cause: err, status: err && err.status });
  return new ModelError('provider', `model provider error: ${msg}`, { cause: err, status: err && err.status });
}

function addUsage(total, usage) {
  if (!usage) return total;
  total.prompt_tokens += usage.prompt_tokens || 0;
  total.completion_tokens += usage.completion_tokens || 0;
  total.total_tokens += usage.total_tokens || 0;
  const cached = usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens;
  if (cached) total.cached_tokens += cached;
  return total;
}

function createModel(opts = {}) {
  const base = agentsConfig.agentLay || {};
  const config = {
    model: opts.model || base.model || 'gpt-4o-mini',
    maxTokens: opts.maxTokens || base.maxTokens || 1024,
    temperature: opts.temperature !== undefined ? opts.temperature : (base.temperature !== undefined ? base.temperature : 0.4),
    timeoutMs: opts.timeoutMs || base.timeoutMs || 20000,
  };
  const log = opts.log || null;
  let client = opts.client || null;
  const getClient = () => { if (!client) client = defaultClient(opts.apiKey, config.timeoutMs); return client; };

  async function callOnce(messages, schema, usage) {
    const started = Date.now();
    let completion;
    try {
      completion = await getClient().chat.completions.create({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_completion_tokens: config.maxTokens,
        response_format: { type: 'json_schema', json_schema: schema },
      }, { timeout: config.timeoutMs });
    } catch (err) {
      if (err instanceof ModelError) throw err;
      throw classifyProviderError(err);
    }
    const latencyMs = Date.now() - started;
    addUsage(usage, completion && completion.usage);
    const choice = completion && completion.choices && completion.choices[0];
    if (!choice || !choice.message) throw new ModelOutputError('empty', 'model returned no choice', { latencyMs });
    if (choice.message.refusal) throw new ModelOutputError('refusal', `model refused: ${choice.message.refusal}`, { latencyMs });
    if (choice.finish_reason === 'length') throw new ModelOutputError('length', 'model output cut off by max tokens', { latencyMs });
    if (choice.finish_reason === 'content_filter') throw new ModelOutputError('refusal', 'model output blocked by content filter', { latencyMs });
    return { content: choice.message.content, latencyMs };
  }

  async function respond({ system, messages = [], schema } = {}) {
    if (!schema) throw new ModelError('invalid_request', 'respond() needs the response schema');
    const convo = [...messages];
    if (system && !(convo[0] && convo[0].role === 'system')) convo.unshift({ role: 'system', content: system });
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
    const started = Date.now();

    const first = await callOnce(convo, schema, usage);
    let parsed = parseJson(first.content);
    let check = parsed.ok ? validateResponse(parsed.value) : { ok: false, errors: parsed.errors };
    let repaired = false;
    let attempts = 1;

    if (!check.ok) {
      if (log) log.warn('model_output_invalid', { errors: check.errors.join('; '), model: config.model });
      const repairConvo = [
        ...convo,
        { role: 'assistant', content: typeof first.content === 'string' ? first.content : '' },
        { role: 'user', content: `Your previous output failed validation: ${check.errors.join('; ')}. Return a corrected JSON object only, following the schema exactly. Keep the same Thai wording where it was fine.` },
      ];
      const second = await callOnce(repairConvo, schema, usage);
      attempts = 2;
      parsed = parseJson(second.content);
      check = parsed.ok ? validateResponse(parsed.value) : { ok: false, errors: parsed.errors };
      if (!check.ok) {
        throw new ModelOutputError('invalid', `model output failed validation twice: ${check.errors.join('; ')}`, { errors: check.errors, usage, latencyMs: Date.now() - started, attempts });
      }
      repaired = true;
    }

    const response = parsed.value;
    Object.defineProperty(response, '_meta', {
      value: { usage, latencyMs: Date.now() - started, model: config.model, repaired, attempts },
      enumerable: false, writable: true, configurable: true,
    });
    return response;
  }

  return { respond, config };
}

module.exports = { createModel, ModelError, ModelOutputError };
