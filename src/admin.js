// Admin router (v2): JSON only, bearer ADMIN_TOKEN, constant-time compare. Not wired into src/index.js here —
// the head engineer mounts it (`app.use(createAdminRouter({ store }))`). Routes:
//   GET  /admin/leads?since=<iso>            leads export (design §9) — includes contact; token-protected
//   GET  /admin/sessions                      all sessions
//   GET  /admin/sessions/:userId              session + last 30 messages
//   POST /admin/sessions/:userId/mode {mode}  lay | quiet | mos_active | demo
//   GET  /admin/events?limit=                 debugging feed (default 100, max 1000)
//   GET  /admin/llm/calls?since=&task=&limit= llm_calls rows, newest first (doc/llm.md §4)
//   GET  /admin/llm/summary?days=7            day × task × model: calls, tokens, cost
//   GET  /admin/llm/status                    keyring + budget + routing table + NO_LLM list
const crypto = require('node:crypto');
const express = require('express');
const { exportLeads } = require('./leads/export');

const MODES = ['lay', 'quiet', 'mos_active', 'demo'];
const MESSAGES_TAIL = 30;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerAuth(getToken) {
  return (req, res, next) => {
    const expected = getToken();
    const header = req.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!expected || !m || !safeEqual(m[1].trim(), expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {{ store: object, token?: string, clock?: {now(): Date}, log?: object }} deps
 *   token defaults to process.env.ADMIN_TOKEN read per request (so tests and restarts pick up changes).
 */
function createAdminRouter({ store, token, clock, log, llm } = {}) {
  if (!store) throw new Error('createAdminRouter: store is required');
  const nowDate = () => (clock && clock.now ? clock.now() : new Date());
  const getToken = () => (token !== undefined ? token : process.env.ADMIN_TOKEN);
  const router = express.Router();

  router.use('/admin', bearerAuth(getToken));
  router.use('/admin', express.json({ limit: '64kb' }));

  router.get('/admin/leads', wrap(async (req, res) => {
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
    if (since && Number.isNaN(Date.parse(since))) return res.status(400).json({ error: 'since must be an ISO date' });
    const leads = await exportLeads(store, { since });
    res.json({ since: since ? new Date(since).toISOString() : null, count: leads.length, leads });
  }));

  router.get('/admin/sessions', wrap(async (_req, res) => {
    const sessions = await store.sessions.all();
    res.json({ count: sessions.length, sessions });
  }));

  router.get('/admin/sessions/:userId', wrap(async (req, res) => {
    const session = await store.sessions.get(req.params.userId);
    if (!session) return res.status(404).json({ error: 'not found' });
    const messages = await store.messages.recent(req.params.userId, MESSAGES_TAIL);
    res.json({ session, messages });
  }));

  router.post('/admin/sessions/:userId/mode', wrap(async (req, res) => {
    const mode = req.body && req.body.mode;
    if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join('|')}` });
    const session = await store.sessions.get(req.params.userId);
    if (!session) return res.status(404).json({ error: 'not found' });
    const now = (clock && clock.now ? clock.now() : new Date()).toISOString();
    const saved = await store.sessions.save({ ...session, mode, mode_since: now });
    if (store.events && store.events.append) {
      await store.events.append({ kind: 'admin_mode_change', user_id: req.params.userId, payload: { from: session.mode, to: mode } });
    }
    if (log && log.info) log.info('admin.mode_change', { user_id: req.params.userId, from: session.mode, to: mode });
    res.json({ session: saved });
  }));

  router.get('/admin/events', wrap(async (req, res) => {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    limit = Math.min(limit, 1000);
    const events = store.events.recent ? await store.events.recent(limit) : (await store.events.all()).slice(-limit);
    res.json({ count: events.length, events });
  }));

  // --- LLM tracking (doc/llm.md §4): llm = { keyring?, budget?, statusLine? } from src/app.js ---
  const llmReady = (res) => { if (!store.llmCalls) { res.status(404).json({ error: 'llm tracking not available' }); return false; } return true; };

  router.get('/admin/llm/calls', wrap(async (req, res) => {
    if (!llmReady(res)) return undefined;
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
    if (since && Number.isNaN(Date.parse(since))) return res.status(400).json({ error: 'since must be an ISO date' });
    const task = typeof req.query.task === 'string' && req.query.task ? req.query.task : undefined;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 2000);
    const calls = await store.llmCalls.since(since || '1970-01-01T00:00:00.000Z', { task, limit });
    return res.json({ since: since ? new Date(since).toISOString() : null, task: task || null, count: calls.length, calls });
  }));

  router.get('/admin/llm/summary', wrap(async (req, res) => {
    if (!llmReady(res)) return undefined;
    let days = parseInt(req.query.days, 10);
    if (!Number.isFinite(days) || days <= 0) days = 7;
    days = Math.min(days, 90);
    const rows = await store.llmCalls.summary({ days, now: nowDate() });
    const totals = rows.reduce((t, r) => ({ calls: t.calls + r.calls, prompt_tokens: t.prompt_tokens + r.prompt_tokens, completion_tokens: t.completion_tokens + r.completion_tokens, cached_tokens: t.cached_tokens + r.cached_tokens, cost_usd: Number((t.cost_usd + r.cost_usd).toFixed(6)), errors: t.errors + r.errors + r.exhausted, invalid: t.invalid + r.invalid }), { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cost_usd: 0, errors: 0, invalid: 0 });
    return res.json({ days, rows, totals });
  }));

  router.get('/admin/llm/status', wrap(async (_req, res) => {
    const llmRouter = require('./brain/router');
    const keyring = llm && llm.keyring && llm.keyring.status ? llm.keyring.status() : null;
    const budget = llm && llm.budget && llm.budget.status ? llm.budget.status() : null;
    let statusLine = null;
    try { statusLine = llm && typeof llm.statusLine === 'function' ? llm.statusLine() : null; } catch { statusLine = null; }
    res.json({ keyring, budget, status_line: statusLine, router: llmRouter.listTasks(), no_llm: llmRouter.NO_LLM });
  }));

  // Errors inside /admin stay JSON (no HTML error page).
  router.use('/admin', (err, _req, res, _next) => { // eslint-disable-line no-unused-vars
    if (log && log.error) log.error('admin.error', { message: String(err && err.message) });
    const status = err && (err.status || err.statusCode);
    res.status(status && status >= 400 && status < 600 ? status : 500).json({ error: status === 400 ? 'bad request' : 'internal error' });
  });

  return router;
}

module.exports = { createAdminRouter, safeEqual, MODES };
