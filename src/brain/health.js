// Model-call health for GET /health (Issue #5, D-37): an outside monitor must see a dead key. On 22 Oct the OpenRouter
// key was rejected all day while /health kept answering {status: ok}.
//
//   createLlmHealth({ clock, keys }) → { ok(), error(err), snapshot() }
//   classifyHealthError(err) → 'auth' | 'quota' | 'rate' | 'timeout' | 'other'
//
// snapshot() = { last_ok_at, last_error_at, last_error_kind, keys } — timestamps and a count only: no key, no message
// content, no error text. The monitor decides what is an incident; /health stays HTTP 200.

// same wording respond.js treats as a spent key (a plain "rate limit" is not one)
const CREDIT_RE = /credit|quota|budget|insufficient|balance|key limit|limit (?:exceeded|reached)|spend(?:ing)? limit|exceeded .*limit/iu;

function statusOf(err) {
  const s = err && (err.status || (err.cause && err.cause.status));
  return Number.isFinite(Number(s)) ? Number(s) : null;
}
function textOf(err) {
  const parts = [err && err.message, err && err.cause && err.cause.message, err && err.error && JSON.stringify(err.error)];
  return parts.filter(Boolean).join(' ');
}

function classifyHealthError(err) {
  const status = statusOf(err);
  const text = textOf(err);
  if (status === 401 || /key rejected|user not found|invalid api key|no auth/iu.test(text)) return 'auth';
  if (status === 402 || ((status === 429 || status === 403) && CREDIT_RE.test(text)) || /key limit exhausted|keys exhausted/iu.test(text)) return 'quota';
  if (status === 429) return 'rate';
  if ((err && err.kind === 'timeout') || /timeout|timed out|ETIMEDOUT|AbortError/iu.test(text)) return 'timeout';
  return 'other';
}

function createLlmHealth({ clock, keys = 0 } = {}) {
  const now = () => (clock && clock.now ? clock.now() : new Date()).toISOString();
  const state = { last_ok_at: null, last_error_at: null, last_error_kind: null };
  return {
    ok() { state.last_ok_at = now(); },
    error(err) { state.last_error_at = now(); state.last_error_kind = classifyHealthError(err); },
    snapshot() { return { ...state, keys: typeof keys === 'function' ? keys() : keys }; },
  };
}

module.exports = { createLlmHealth, classifyHealthError };
