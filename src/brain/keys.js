// Keyring for OpenRouter keys (doc/llm.md §5). Keys come from config (OPENROUTER_API_KEY, _2, _3); the provider asks
// `current()` before every attempt and `markExhausted(i, reason)` on HTTP 402 / credit 429 / limit_remaining ≤ 0.
// An exhausted key is retried after its limit reset: 'daily' ⇒ next 00:00 UTC (OpenRouter resets key limits at UTC
// midnight), anything else ⇒ 60 minutes. `status().exhausted` is true only when every key is out; core/turn then
// skips the model call entirely (no hammering) until a retry time passes.
//
//   createKeyring({ keys, clock, log, onExhausted, onRecovered })
//     → { current(), markExhausted(i, reason, { limitReset, resetAt }), rotate(reason), setInfo(i, info), status(), size }
//
// Key values never leave this module except through `current().key`; status() shows a masked label only.

const RETRY_FALLBACK_MS = 60 * 60 * 1000;

function nextUtcMidnight(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return d;
}

function mask(key) {
  const k = String(key || '');
  if (k.length <= 10) return `${k.slice(0, 2)}…`;
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

function createKeyring({ keys = [], clock, log, onExhausted, onRecovered } = {}) {
  const now = () => (clock && clock.now ? clock.now() : new Date());
  const logger = log || { info() {}, warn() {}, error() {} };
  const entries = keys.filter((k) => typeof k === 'string' && k.trim()).map((key, index) => ({
    index, key: key.trim(), label: mask(key), exhaustedAt: null, retryAt: null, reason: null, info: null,
  }));
  let allExhaustedSince = null;

  function usable(e, at) {
    if (!e.retryAt) return true;
    if (at.getTime() >= e.retryAt.getTime()) {
      logger.info('llm.key_restored', { key_index: e.index, label: e.label, was: e.reason });
      e.exhaustedAt = null; e.retryAt = null; e.reason = null;
      return true;
    }
    return false;
  }

  function current() {
    const at = now();
    const wasAllOut = !!allExhaustedSince;
    const e = entries.find((x) => usable(x, at)) || null;
    if (e && wasAllOut) {
      allExhaustedSince = null;
      logger.info('llm.keys_recovered', { key_index: e.index });
      if (onRecovered) { try { onRecovered(status()); } catch (err) { logger.warn('llm.keys_recovered_hook_failed', { error: err?.message }); } }
    }
    return e ? { index: e.index, key: e.key, label: e.label } : null;
  }

  function markExhausted(i, reason = 'exhausted', { limitReset, resetAt } = {}) {
    const e = entries[i];
    if (!e) return null;
    const at = now();
    let retry = null;
    if (resetAt && !Number.isNaN(Date.parse(resetAt))) retry = new Date(resetAt);
    else if (!limitReset || /daily/i.test(String(limitReset))) retry = nextUtcMidnight(at);
    else retry = new Date(at.getTime() + RETRY_FALLBACK_MS);
    if (retry.getTime() <= at.getTime()) retry = new Date(at.getTime() + RETRY_FALLBACK_MS);
    e.exhaustedAt = at; e.retryAt = retry; e.reason = String(reason).slice(0, 200);
    logger.warn('llm.key_exhausted', { key_index: i, label: e.label, reason: e.reason, retry_at: retry.toISOString() });
    const anyLeft = entries.some((x) => x.index !== i && usable(x, at));
    if (!anyLeft && !allExhaustedSince) {
      allExhaustedSince = at;
      logger.error('llm.keys_all_exhausted', { keys: entries.length, retry_at: nextRetryAt()?.toISOString() });
      if (onExhausted) { try { onExhausted(status()); } catch (err) { logger.warn('llm.keys_exhausted_hook_failed', { error: err?.message }); } }
    }
    return { index: i, retryAt: retry };
  }

  // Mark the current key exhausted and return the next usable one (or null when none is left).
  function rotate(reason = 'rotate') {
    const cur = current();
    if (!cur) return null;
    markExhausted(cur.index, reason);
    const next = entries.find((x) => x.index !== cur.index && usable(x, now())) || null;
    return next ? { index: next.index, key: next.key, label: next.label } : null;
  }

  function setInfo(i, info) { if (entries[i]) entries[i].info = info ? { ...info } : null; }

  function nextRetryAt() {
    const times = entries.filter((e) => e.retryAt).map((e) => e.retryAt.getTime());
    return times.length ? new Date(Math.min(...times)) : null;
  }

  function status() {
    const at = now();
    const keysOut = entries.map((e) => ({
      index: e.index, label: e.label,
      exhausted: !!(e.retryAt && at.getTime() < e.retryAt.getTime()),
      reason: e.reason, exhausted_at: e.exhaustedAt ? e.exhaustedAt.toISOString() : null,
      retry_at: e.retryAt ? e.retryAt.toISOString() : null,
      info: e.info,
    }));
    const usableCount = keysOut.filter((k) => !k.exhausted).length;
    return {
      total: entries.length, usable: usableCount,
      exhausted: entries.length === 0 || usableCount === 0,
      configured: entries.length > 0,
      all_exhausted_since: allExhaustedSince ? allExhaustedSince.toISOString() : null,
      next_retry_at: usableCount === 0 ? (nextRetryAt()?.toISOString() || null) : null,
      keys: keysOut,
    };
  }

  // Raw key by index — for the budget's /auth/key refresh only; never log or return it elsewhere.
  function keyAt(i) { return entries[i] ? entries[i].key : null; }

  return { current, markExhausted, rotate, setInfo, keyAt, status, size: entries.length };
}

module.exports = { createKeyring, nextUtcMidnight, mask, RETRY_FALLBACK_MS };
