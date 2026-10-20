// Admin router (v2): JSON only, bearer ADMIN_TOKEN, constant-time compare. Not wired into src/index.js here —
// the head engineer mounts it (`app.use(createAdminRouter({ store }))`). Routes:
//   GET  /admin/leads?since=<iso>            leads export (design §9) — includes contact; token-protected
//   GET  /admin/sessions                      all sessions
//   GET  /admin/sessions/:userId              session + last 30 messages
//   POST /admin/sessions/:userId/mode {mode}  lay | quiet | mos_active | demo | human
//   POST /admin/sessions/:userId/take         Human Mode + open the lead thread in #leads
//   POST /admin/sessions/:userId/reset        clear what Lay knows about the user; history starts now
//   DELETE /admin/users/:userId {confirm}     erase the user from every table
//   POST /admin/sessions/:userId/lead {nurture?, came_from?}  mark the lead from what Mos knows outside the chat
//   GET  /admin/events?limit=                 debugging feed (default 100, max 1000)
//   GET  /admin/llm/calls?since=&task=&limit= llm_calls rows, newest first (doc/llm.md §4)
//   GET  /admin/llm/summary?days=7            day × task × model: calls, tokens, cost
//   GET  /admin/llm/status                    keyring + budget + routing table + NO_LLM list
const crypto = require('node:crypto');
const express = require('express');
const { exportLeads } = require('./leads/export');

const MODES = ['lay', 'quiet', 'mos_active', 'demo', 'human'];
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
function createAdminRouter({ store, token, clock, log, llm, take, reset, forget } = {}) {
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

  // Human Mode for one user + the lead thread (same as the #leads button / /take). Body: {} — used when Mos took a chat
  // in OA Manager, which the webhook never sees (20 Oct).
  router.post('/admin/sessions/:userId/take', wrap(async (req, res) => {
    if (typeof take !== 'function') return res.status(404).json({ error: 'take not available' });
    const session = await store.sessions.get(req.params.userId);
    if (!session) return res.status(404).json({ error: 'not found' });
    const r = await take(req.params.userId);
    const after = await store.sessions.get(req.params.userId);
    res.json({ mode: after.mode, threadId: r.threadId || null });
  }));

  // Mark a lead from what Mos knows outside the chat (20 Oct): {nurture: true} and/or {came_from: "เพื่อนแชร์โพสต์"}.
  // Writes the session (so later turns keep it) and rebuilds the lead row from it.
  router.post('/admin/sessions/:userId/lead', wrap(async (req, res) => {
    const session = await store.sessions.get(req.params.userId);
    if (!session) return res.status(404).json({ error: 'not found' });
    const body = req.body || {};
    if (body.nurture === true) session.nurture = true;
    if (typeof body.came_from === 'string' && body.came_from.trim()) session.homework = { ...(session.homework || {}), came_from: body.came_from.trim().slice(0, 120) };
    await store.sessions.save(session);
    const intake = require('./leads/intake');
    const existing = await store.leads.byUser(req.params.userId);
    const lead = await store.leads.upsert(intake.buildLeadRow({ session, existing, now: clock && clock.now ? clock.now() : new Date() }));
    if (store.events && store.events.append) await store.events.append({ kind: 'admin_lead_update', user_id: req.params.userId, payload: { nurture: body.nurture === true, came_from: !!body.came_from } });
    res.json({ lead: { id: lead.id, status: lead.status, came_from: lead.homework && lead.homework.came_from } });
  }));

  // /reset: Lay starts fresh with this user; transcript and lead stay
  router.post('/admin/sessions/:userId/reset', wrap(async (req, res) => {
    if (typeof reset !== 'function') return res.status(404).json({ error: 'reset not available' });
    if (!(await store.sessions.get(req.params.userId))) return res.status(404).json({ error: 'not found' });
    res.json(await reset(req.params.userId));
  }));

  // erase one user everywhere; body must repeat the userId: {"confirm": "U…"}
  router.delete('/admin/users/:userId', wrap(async (req, res) => {
    if (typeof forget !== 'function') return res.status(404).json({ error: 'forget not available' });
    if (!req.body || req.body.confirm !== req.params.userId) return res.status(400).json({ error: 'confirm must equal the userId' });
    res.json(await forget(req.params.userId));
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
