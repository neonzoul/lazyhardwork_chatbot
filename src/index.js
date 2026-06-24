const express = require('express');
const line = require('@line/bot-sdk');
const config = require('./config');
const { handleEvent } = require('./bot');
const state = require('./state');

const app = express();

const lineMiddleware = line.middleware({
  channelSecret: config.line.channelSecret,
});

app.post('/webhook', lineMiddleware, (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ status: 'ok' }))
    .catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'internal' });
    });
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Admin endpoints — protected by ADMIN_SECRET token
app.use('/admin', (req, res, next) => {
  if (!config.adminSecret || req.query.secret !== config.adminSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// Resume bot: GET /admin/resume?secret=xxx&userId=Uxxxxx
app.get('/admin/resume', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const prev = state.getStatus(userId);
  state.setStatus(userId, state.BOT_ACTIVE);
  res.json({ userId, prev, now: state.BOT_ACTIVE });
});

// Status check: GET /admin/status?secret=xxx&userId=Uxxxxx
app.get('/admin/status', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ userId, status: state.getStatus(userId) });
});

app.listen(config.port, () => {
  console.log(`Agent Lay listening on port ${config.port}`);
});
