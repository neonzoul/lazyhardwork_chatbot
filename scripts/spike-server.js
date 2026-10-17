/**
 * Spike server — serves /assets (sender icons) over the tunnel and logs every webhook event's source,
 * so we can (a) give LINE HTTPS icon URLs before the v2 app is deployed and (b) capture Mos's userId /
 * a test group's groupId for the identity test. It never replies to anyone.
 *
 * Usage:  node scripts/spike-server.js            (PORT from .env, default 3000)
 * Then:   npx ngrok http <PORT>  → set LAY_ICON_URL / MOS_ICON_URL / webhook to the https URL
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets'), { maxAge: '1h' }));
app.get('/health', (_, res) => res.json({ status: 'ok', spike: true }));

app.post('/webhook', line.middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET }), (req, res) => {
  res.json({ status: 'ok' });
  for (const ev of req.body.events || []) {
    const src = ev.source || {};
    const what = ev.type === 'message' ? `message/${ev.message?.type}` : ev.type;
    const text = ev.message?.type === 'text' ? JSON.stringify(ev.message.text).slice(0, 80) : '';
    console.log(
      `[webhook] ${new Date().toISOString()} ${what} sourceType=${src.type} userId=${src.userId || '-'} ` +
        `groupId=${src.groupId || '-'} roomId=${src.roomId || '-'} redelivery=${ev.deliveryContext?.isRedelivery} ${text}`
    );
  }
});

app.listen(PORT, () => console.log(`spike server on :${PORT} — assets at /assets, webhook at /webhook`));
