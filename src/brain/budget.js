// Budget + tracker (doc/llm.md §3–§4).
//
//   createBudget({ keyring, clock, log, fetchImpl, refreshMs = 10 min, warnAt = 0.8, onWarn })
//     record({ key_index, cost_usd })  — today's spend per key from `usage.cost` (UTC day = OpenRouter's reset day)
//     refresh({ force })               — GET /api/v1/auth/key per key, at most every refreshMs (force ignores the
//                                        timer); stores limit / remaining / reset on the keyring; marks a key
//                                        exhausted when the server says limit_remaining ≤ 0
//     remaining(i?)                    — USD left on key i (default: the current key); null when no limit is known
//     status()                         — per-key spend, limit, pct, server info, warned flags
//     maybeWarn()                      — once per UTC day per key at ≥ warnAt of the key's limit → onWarn({kind, detail})
//
//   createTracker({ store, budget, log }) → { record(row) }   never throws, never blocks the reply
//
// Nothing here touches customer text.

const AUTH_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';
const DEFAULT_REFRESH_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const dayOf = (d) => d.toISOString().slice(0, 10);

function createBudget({ keyring, clock, log, fetchImpl = globalThis.fetch, refreshMs = DEFAULT_REFRESH_MS, warnAt = 0.8, onWarn } = {}) {
  const now = () => (clock && clock.now ? clock.now() : new Date());
  const logger = log || { info() {}, warn() {}, error() {} };
  let day = dayOf(now());
  let spend = new Map();            // key_index → USD today (local count)
  let server = new Map();           // key_index → { limit, limit_remaining, limit_reset, resets_at, usage_daily, label, refreshed_at }
  let warned = new Map();           // key_index → day warned
  let lastRefreshAt = null;

  function rollDay() {
    const d = dayOf(now());
    if (d !== day) { day = d; spend = new Map(); warned = new Map(); }
  }

  function record({ key_index: i = 0, cost_usd: cost = 0 } = {}) {
    rollDay();
    const c = Number(cost);
    if (!Number.isFinite(c) || c <= 0) return;
    spend.set(i, (spend.get(i) || 0) + c);
    maybeWarn();
  }

  function limitFor(i) {
    const s = server.get(i);
    return s && Number.isFinite(s.limit) ? s.limit : null;
  }

  function spentFor(i) {
    rollDay();
    const local = spend.get(i) || 0;
    const s = server.get(i);
    const remote = s && Number.isFinite(s.usage_daily) ? s.usage_daily : 0;
    // the server number is authoritative when it is fresher than our count; take the larger of the two
    return Math.max(local, remote);
  }

  function remaining(i) {
    const idx = i === undefined ? (keyring && keyring.current ? (keyring.current()?.index ?? 0) : 0) : i;
    const limit = limitFor(idx);
    if (limit === null) return null;
    const s = server.get(idx);
    if (s && Number.isFinite(s.limit_remaining)) return Math.max(0, Math.min(s.limit_remaining, limit - spentFor(idx)));
    return Math.max(0, limit - spentFor(idx));
  }

  function maybeWarn() {
    rollDay();
    const count = keyring ? keyring.size : Math.max(1, ...spend.keys(), ...server.keys());
    for (let i = 0; i < count; i++) {
      const limit = limitFor(i);
      if (limit === null || limit <= 0) continue;
      const pct = spentFor(i) / limit;
      if (pct >= warnAt && warned.get(i) !== day) {
        warned.set(i, day);
        const detail = { key_index: i, spent_usd: Number(spentFor(i).toFixed(4)), limit_usd: limit, pct: Math.round(pct * 100), reset: server.get(i)?.limit_reset || 'daily', resets_at: server.get(i)?.resets_at || null };
        logger.warn('llm.budget_warn', detail);
        if (onWarn) { try { Promise.resolve(onWarn({ kind: 'llm_budget_80', detail })).catch(() => {}); } catch { /* never */ } }
      }
    }
  }

  async function fetchKeyInfo(key) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
    const res = await fetchImpl(AUTH_KEY_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`auth/key ${res.status}`);
    const body = await res.json();
    const d = body && body.data ? body.data : body;
    const eff = d.effective_budget || (Array.isArray(d.budgets) && d.budgets[0]) || {};
    return {
      label: d.label || null,
      limit: Number.isFinite(d.limit) ? d.limit : (Number.isFinite(eff.limit_usd) ? eff.limit_usd : null),
      limit_remaining: Number.isFinite(d.limit_remaining) ? d.limit_remaining : (Number.isFinite(eff.remaining_usd) ? eff.remaining_usd : null),
      limit_reset: d.limit_reset || eff.reset_interval || null,
      resets_at: eff.resets_at || null,
      usage: Number.isFinite(d.usage) ? d.usage : null,
      usage_daily: Number.isFinite(d.usage_daily) ? d.usage_daily : null,
    };
  }

  async function refresh({ force = false } = {}) {
    if (!keyring || !keyring.size) return { refreshed: false, reason: 'no keys' };
    const at = now();
    if (!force && lastRefreshAt && at.getTime() - lastRefreshAt.getTime() < refreshMs) return { refreshed: false, reason: 'throttled' };
    lastRefreshAt = at;
    const results = [];
    for (let i = 0; i < keyring.size; i++) {
      try {
        const info = await fetchKeyInfo(keyring.keyAt(i));
        const entry = { ...info, refreshed_at: at.toISOString() };
        server.set(i, entry);
        if (keyring.setInfo) keyring.setInfo(i, entry);
        if (Number.isFinite(info.limit_remaining) && info.limit_remaining <= 0) {
          keyring.markExhausted(i, 'auth/key: limit_remaining <= 0', { limitReset: info.limit_reset, resetAt: info.resets_at });
        }
        results.push({ key_index: i, ok: true });
      } catch (err) {
        logger.warn('llm.budget_refresh_failed', { key_index: i, error: err?.message });
        results.push({ key_index: i, ok: false, error: err?.message });
      }
    }
    maybeWarn();
    return { refreshed: true, results };
  }

  function status() {
    rollDay();
    const count = keyring ? keyring.size : 0;
    const keys = [];
    for (let i = 0; i < count; i++) {
      const s = server.get(i) || null;
      const limit = limitFor(i);
      const spent = spentFor(i);
      keys.push({
        index: i, spent_usd: Number(spent.toFixed(6)), local_spent_usd: Number((spend.get(i) || 0).toFixed(6)),
        limit_usd: limit, remaining_usd: remaining(i), pct: limit ? Math.round((spent / limit) * 100) : null,
        warned_today: warned.get(i) === day,
        server: s ? { limit: s.limit, limit_remaining: s.limit_remaining, limit_reset: s.limit_reset, resets_at: s.resets_at, usage_daily: s.usage_daily, refreshed_at: s.refreshed_at } : null,
      });
    }
    return { day, warn_at: warnAt, last_refresh_at: lastRefreshAt ? lastRefreshAt.toISOString() : null, refresh_ms: refreshMs, keys };
  }

  return { record, refresh, remaining, status, maybeWarn, _fetchKeyInfo: fetchKeyInfo };
}

// One line in llm_calls per attempt + the budget count. Fire-and-forget: a tracking failure is logged, never raised.
function createTracker({ store, budget, log } = {}) {
  const logger = log || { info() {}, warn() {}, error() {} };
  return {
    record(row) {
      try { if (budget) budget.record({ key_index: row.key_index, cost_usd: row.cost_usd }); } catch (err) { logger.warn('llm.budget_record_failed', { error: err?.message }); }
      try {
        const p = store && store.llmCalls && store.llmCalls.append ? store.llmCalls.append(row) : null;
        if (p && typeof p.catch === 'function') p.catch((err) => logger.warn('llm.track_failed', { error: err?.message }));
      } catch (err) { logger.warn('llm.track_failed', { error: err?.message }); }
    },
  };
}

// "key0 · limit 15 USD · remaining 3.21 · reset daily (2026-10-19T00:00:00Z)" — for alerts and the admin status.
function keyStatusLine(keyring, budget) {
  const ks = keyring && keyring.status ? keyring.status() : null;
  if (!ks || !ks.total) return 'keys: none configured';
  const bs = budget && budget.status ? budget.status() : null;
  const parts = ks.keys.map((k) => {
    const b = bs && bs.keys[k.index];
    const limit = b && b.limit_usd != null ? `${b.limit_usd} USD` : '?';
    const rem = b && b.remaining_usd != null ? b.remaining_usd.toFixed(2) : (b ? `spent ${b.spent_usd.toFixed(2)}` : '?');
    const reset = (b && b.server && b.server.limit_reset) || 'daily';
    const at = (b && b.server && b.server.resets_at) || k.retry_at || '';
    return `key${k.index}${k.exhausted ? ' EXHAUSTED' : ''} · limit ${limit} · remaining ${rem} · reset ${reset}${at ? ` (${at})` : ''}`;
  });
  return `keys: ${ks.usable}/${ks.total} usable · ${parts.join(' | ')}`;
}

module.exports = { createBudget, createTracker, keyStatusLine, AUTH_KEY_URL, DEFAULT_REFRESH_MS };
