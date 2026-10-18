// Operator alerts to Discord #crm (doc/llm.md §6) — the production `deps.alerts`. Reuses the notifier's REST/webhook
// transport (src/discord/notify.js createRestTransport); bot first, webhook second, log last. Never throws.
//
//   createAlerts({ botToken, crmChannelId, leadsChannelId, crmWebhook, log, clock, transport, fetchImpl, statusLine })
//     critical({ kind, detail })  → "@here 🔴 LAY v2 CRITICAL — <kind>" + detail + key status; once per 15 min per kind
//     recovered({ kind, detail }) → "🟢 LAY v2 recovered — <kind>" + key status; clears the throttle for kind
//     warn({ kind, detail })      → "🟠 LAY v2 warning — <kind>" + detail; once per UTC day per kind; no mention
//   each returns { posted: bool, throttled: bool, via: 'bot'|'webhook'|null }
//
// `detail` is a string or a flat object of technical fields. Callers never pass customer data (ids, names, text).
// `statusLine()` (injected) renders the keyring/budget line so this module knows nothing about keys.

const { createRestTransport } = require('./notify');

const CRITICAL_THROTTLE_MS = 15 * 60 * 1000;
const MENTION_EVERYONE = { parse: ['everyone'] };
const NO_MENTION = { parse: [] };

function fmtDetail(detail) {
  if (detail === undefined || detail === null || detail === '') return '';
  if (typeof detail === 'string') return detail.slice(0, 800);
  if (typeof detail !== 'object') return String(detail).slice(0, 200);
  return Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'function')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200)}`)
    .join('\n');
}

function createAlerts({ botToken, crmChannelId, leadsChannelId, crmWebhook, log, clock, transport, fetchImpl, statusLine } = {}) {
  const t = transport || createRestTransport({ botToken, fetchImpl });
  const logger = log || { info() {}, warn() {}, error() {} };
  const now = () => (clock && clock.now ? clock.now() : new Date());
  const channelId = crmChannelId || leadsChannelId || null;
  const lastCritical = new Map();   // kind → ms
  const warnedDay = new Map();      // kind → YYYY-MM-DD (UTC)

  function status() {
    if (typeof statusLine !== 'function') return '';
    try { return String(statusLine() || ''); } catch (err) { return `key status unavailable (${err?.message})`; }
  }

  function compose(head, detail) {
    return [head, fmtDetail(detail), status(), `at ${now().toISOString()}`].filter(Boolean).join('\n').slice(0, 1900);
  }

  async function post(content, allowedMentions, event) {
    let botError = null;
    if (t.botConfigured && channelId) {
      try { await t.postMessage({ channelId, content, allowedMentions }); return { posted: true, via: 'bot' }; } catch (err) { botError = err; }
    }
    try {
      await t.postWebhook({ url: crmWebhook, content, allowedMentions });
      if (botError) logger.warn('alerts.webhook_fallback', { event, botError: botError.message });
      return { posted: true, via: 'webhook' };
    } catch (err) {
      logger.error('alerts.post_failed', { event, botError: botError?.message || 'bot not configured', webhookError: err?.message });
      return { posted: false, via: null };
    }
  }

  return {
    async critical({ kind = 'unknown', detail } = {}) {
      const at = now().getTime();
      const last = lastCritical.get(kind);
      if (last !== undefined && at - last < CRITICAL_THROTTLE_MS) {
        logger.info('alerts.critical_throttled', { kind, since_ms: at - last });
        return { posted: false, throttled: true, via: null };
      }
      lastCritical.set(kind, at);
      logger.error('alerts.critical', { kind });
      const r = await post(compose(`@here 🔴 LAY v2 CRITICAL — ${kind}`, detail), MENTION_EVERYONE, 'critical');
      return { ...r, throttled: false };
    },
    async recovered({ kind = 'unknown', detail } = {}) {
      lastCritical.delete(kind);
      logger.info('alerts.recovered', { kind });
      const r = await post(compose(`🟢 LAY v2 recovered — ${kind}`, detail), NO_MENTION, 'recovered');
      return { ...r, throttled: false };
    },
    async warn({ kind = 'unknown', detail } = {}) {
      const day = now().toISOString().slice(0, 10);
      if (warnedDay.get(kind) === day) return { posted: false, throttled: true, via: null };
      warnedDay.set(kind, day);
      logger.warn('alerts.warn', { kind });
      const r = await post(compose(`🟠 LAY v2 warning — ${kind}`, detail), NO_MENTION, 'warn');
      return { ...r, throttled: false };
    },
    _transport: t,
  };
}

module.exports = { createAlerts, fmtDetail, CRITICAL_THROTTLE_MS };
