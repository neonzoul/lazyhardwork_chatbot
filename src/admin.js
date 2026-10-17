// Admin router (v2): JSON only, bearer ADMIN_TOKEN, constant-time compare. Not wired into src/index.js here —
// the head engineer mounts it (`app.use(createAdminRouter({ store }))`). Routes:
//   GET  /admin/leads?since=<iso>            leads export (design §9) — includes contact; token-protected
//   GET  /admin/sessions                      all sessions
//   GET  /admin/sessions/:userId              session + last 30 messages
//   POST /admin/sessions/:userId/mode {mode}  lay | quiet | mos_active | demo
//   GET  /admin/events?limit=                 debugging feed (default 100, max 1000)
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
function createAdminRouter({ store, token, clock, log } = {}) {
  if (!store) throw new Error('createAdminRouter: store is required');
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

  // Errors inside /admin stay JSON (no HTML error page).
  router.use('/admin', (err, _req, res, _next) => { // eslint-disable-line no-unused-vars
    if (log && log.error) log.error('admin.error', { message: String(err && err.message) });
    const status = err && (err.status || err.statusCode);
    res.status(status && status >= 400 && status < 600 ? status : 500).json({ error: status === 400 ? 'bad request' : 'internal error' });
  });

  return router;
}

module.exports = { createAdminRouter, safeEqual, MODES };
