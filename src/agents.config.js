// LLM routing table — version-controlled, not in .env (design §10; doc/llm.md).
// Secrets (API keys) stay in .env. Which model does which task is an engineering decision: it belongs here.
//
// Every LLM use is one row below. No row ⇒ no LLM: the NO_LLM list says what is deterministic on purpose.
// Env override per task: LLM_MODEL_<TASK_ID upper-cased, dots → underscores>, e.g. LLM_MODEL_LAY_REPLY=openai/gpt-4.1-mini
// (read by src/brain/router.js through src/config.js). Model ids are OpenRouter ids (provider/model).
//
// Prices (USD per 1M tokens in/out, OpenRouter 2026-10-18): gpt-4o-mini 0.15/0.60 · gpt-4.1-mini 0.40/1.60 ·
// gpt-4.1-nano 0.10/0.40 · gpt-5-mini 0.25/2.00 · gpt-5-nano 0.05/0.40 · gemini-2.5-flash 0.30/2.50 ·
// gemini-2.5-flash-lite 0.10/0.40 · claude-haiku-4.5 1.00/5.00 · claude-sonnet-4.5 3.00/15.00 · gpt-4.1 2.00/8.00.

const TIMEOUT_MS = 20000; // design §1.2: 20 s, then the turn falls back

const tasks = [
  {
    id: 'lay.reply',
    agent: 'lay',
    purpose: 'One customer turn on the LINE OA: structured JSON reply (≤ 3 bubbles + ≤ 1 card) from the KB pack.',
    model: 'openai/gpt-4o-mini',
    fallback_models: ['openai/gpt-4.1-mini'],
    max_tokens: 1024,
    temperature: 0.4,
    structured: true,
    timeout_ms: TIMEOUT_MS,
    enabled: true,
    reason: 'Baseline: cheapest model with strict json_schema and acceptable Thai; ~3.5k prompt tokens per turn makes input price the lever. gpt-4.1-mini is the fallback for provider 5xx/timeouts and the candidate if voice or validity falls short (probe numbers in doc/llm.md).',
    cost_note: '≈ 0.0006–0.0009 USD per turn (≈ 3.5k in / 250 out) ⇒ ≈ 0.07–0.09 USD per 100 turns.',
  },
  {
    id: 'lay.repair',
    agent: 'lay',
    purpose: 'Second call when the first output failed the schema or the policy lint: quotes the errors, asks for a corrected object.',
    model: 'openai/gpt-4o-mini',
    fallback_models: [],
    max_tokens: 600,
    temperature: 0.4,
    structured: true,
    timeout_ms: TIMEOUT_MS,
    enabled: true,
    reason: 'Same model as the turn (the provider reuses whichever model produced the first output so the repair sees its own text); shorter output cap because a corrected object is never longer than the original.',
    cost_note: 'Only on invalid output; expected on < 5 % of turns.',
  },
  {
    id: 'demo.reply',
    agent: 'demo_shop',
    purpose: 'Demo-mode turn: the customer plays a customer of a fictional shop (cafe / clinic) with the shop KB.',
    model: 'openai/gpt-4o-mini',
    fallback_models: ['openai/gpt-4.1-mini'],
    max_tokens: 768,
    temperature: 0.5,
    structured: true,
    timeout_ms: TIMEOUT_MS,
    enabled: true,
    reason: 'Same tier as lay.reply: the demo is a sales prop, not a product; voice warmth matters more than precision, hence slightly higher temperature.',
    cost_note: 'Smaller prompt than lay.reply (shop KB only) ⇒ cheaper per turn.',
  },
  {
    id: 'qa.judge',
    agent: 'qa',
    purpose: 'Offline voice scoring of scenario transcripts (scripts only, never in a customer turn): rates Thai voice against the brand samples.',
    model: 'openai/gpt-4.1',
    fallback_models: ['anthropic/claude-sonnet-4.5'],
    max_tokens: 1024,
    temperature: 0,
    structured: true,
    timeout_ms: 60000,
    enabled: true,
    reason: 'A judge should be stronger than the model it grades. gpt-4.1 is the default; anthropic/claude-sonnet-4.5 is the alternative when a second opinion on Thai register is wanted (≈ 2× the price).',
    cost_note: 'Dozens of calls per QA run, not per customer; budget it per run.',
  },
  {
    id: 'qa.probe',
    agent: 'qa',
    purpose: 'scripts/model-probe.js: candidate models answer the fixed question set through the real lay.reply prompt.',
    model: 'openai/gpt-4o-mini',
    fallback_models: [],
    max_tokens: 1024,
    temperature: 0.4,
    structured: true,
    timeout_ms: 30000,
    enabled: true,
    reason: 'Tracking label only — the probe sets the model per run; rows land in llm_calls under this task so they never mix with customer turns.',
    cost_note: '≤ 7 calls per candidate model per run.',
  },
  {
    id: 'kb.rewrite',
    agent: 'document',
    purpose: 'Reserved: rewrite a vault section into KB-pack form. Not wired; the pack is built deterministically by scripts/kb-build.js.',
    model: 'anthropic/claude-sonnet-4.5',
    fallback_models: [],
    max_tokens: 2048,
    temperature: 0.3,
    structured: false,
    timeout_ms: 60000,
    enabled: false,
    reason: 'Disabled on purpose: Mos curates the vault; an agent may only propose drafts. Enable when a review step exists.',
    cost_note: 'n/a while disabled.',
  },
];

// Deterministic on purpose — code does these; no model is consulted (conventions: "the model proposes, the code disposes").
const NO_LLM = [
  { what: 'Opening (follow / first message)', where: 'src/flows/opening.js', why: 'Fixed brand words; three fixed quick replies.' },
  { what: 'Rich Menu postbacks and quick replies', where: 'src/core/turn.js MENU_TO_TEXT, src/flows/topics.js', why: 'Buttons map to known topics; only the words of the answer need a model.' },
  { what: 'Fit choice (the five symptoms → card)', where: 'src/flows/fit.js', why: 'Symptom → card mapping is a table; the choice card is rendered from it.' },
  { what: 'Booking state machine', where: 'src/flows/endings.js', why: 'Windows, confirmations and Mos decisions are state transitions, never free text.' },
  { what: 'Handoff detection (ขอคุยกับคน / special price / scope)', where: 'src/flows/handoff.js', why: 'Regex + policy; a wrong model guess here would be a promise we cannot keep.' },
  { what: 'Quiet window, เรียก Lay, Mos relay identity', where: 'src/identity/*', why: 'Who speaks is a rule, not a judgement.' },
  { what: 'Lint and policy (banned phrases, emoji, prose lists, price grounding)', where: 'src/core/lint.js, src/core/policy.js', why: 'The law is applied by code; the model only gets one regenerate.' },
  { what: 'Demo carousel / examples picker', where: 'src/flows/examples.js, src/flows/demo.js', why: 'Fixed assets and fixed shop list.' },
  { what: 'Lead extraction', where: 'src/leads/intake.js', why: 'The structured output already carries lead_updates; code merges and validates — no extraction call.' },
  { what: 'Lead sync to the vault', where: 'scripts/lead-sync.js', why: 'Pure data transfer.' },
  { what: 'Degraded reply when every key is exhausted', where: 'src/core/degraded.js', why: 'Must work precisely when the model does not.' },
];

// Legacy shape kept for callers that still read agentLay.{model,maxTokens,temperature,timeoutMs} (src/brain/respond tests).
const lay = tasks.find((t) => t.id === 'lay.reply');
const agentLay = {
  model: lay.model,
  maxTokens: lay.max_tokens,
  temperature: lay.temperature,
  timeoutMs: lay.timeout_ms,
  description: 'Lay — LINE OA assistant, structured replies from the KB pack (src/brain)',
  reason: lay.reason,
};

module.exports = { tasks, NO_LLM, agentLay };
