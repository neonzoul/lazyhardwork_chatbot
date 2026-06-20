const express = require('express');
const line = require('@line/bot-sdk');
const config = require('./config');
const { handleEvent } = require('./bot');

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

app.listen(config.port, () => {
  console.log(`Agent Lay listening on port ${config.port}`);
});
