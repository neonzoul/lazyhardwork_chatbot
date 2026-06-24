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
    return res.status(401).send('<h2>401 Unauthorized</h2>');
  }
  next();
});

// Dashboard: GET /admin?secret=xxx
app.get('/admin', (req, res) => {
  const secret = req.query.secret;
  const sessions = state.getAllSessions();

  const statusColor = { BOT_ACTIVE: '#22c55e', WAITING_HUMAN: '#f59e0b', HUMAN_ACTIVE: '#ef4444' };
  const statusLabel = { BOT_ACTIVE: '🟢 BOT_ACTIVE', WAITING_HUMAN: '🟡 WAITING_HUMAN', HUMAN_ACTIVE: '🔴 HUMAN_ACTIVE' };

  const counts = { BOT_ACTIVE: 0, WAITING_HUMAN: 0, HUMAN_ACTIVE: 0 };
  sessions.forEach(s => counts[s.status] = (counts[s.status] || 0) + 1);

  const rows = sessions.map(({ userId, displayName, status, lastMessage, updatedAt }) => {
    const needsAction = status !== state.BOT_ACTIVE;
    const resumeBtn = needsAction
      ? `<a href="/admin/resume?secret=${secret}&userId=${userId}" style="background:#3b82f6;color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px">Resume Bot</a>`
      : '';
    return `
      <tr style="border-bottom:1px solid #1e293b">
        <td style="padding:10px 12px;color:#94a3b8;font-size:12px;font-family:monospace">${userId.slice(0, 12)}…</td>
        <td style="padding:10px 12px;font-weight:600">${displayName || '—'}</td>
        <td style="padding:10px 12px">
          <span style="background:${statusColor[status]}22;color:${statusColor[status]};padding:3px 8px;border-radius:20px;font-size:12px;font-weight:600">
            ${statusLabel[status] || status}
          </span>
        </td>
        <td style="padding:10px 12px;color:#94a3b8;font-size:13px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lastMessage || '—'}</td>
        <td style="padding:10px 12px;color:#64748b;font-size:12px">${updatedAt ? new Date(updatedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '—'}</td>
        <td style="padding:10px 12px">${resumeBtn}</td>
      </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="6" style="padding:32px;text-align:center;color:#475569">ยังไม่มี session — รอลูกค้าทัก</td></tr>`;

  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent Lay — Admin</title>
  <meta http-equiv="refresh" content="30">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, sans-serif; padding: 24px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
    .sub { color: #64748b; font-size: 13px; margin-bottom: 24px; }
    .cards { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .card { background: #1e293b; border-radius: 10px; padding: 16px 20px; min-width: 140px; }
    .card .num { font-size: 28px; font-weight: 700; }
    .card .lbl { font-size: 12px; color: #64748b; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; }
    th { text-align: left; padding: 10px 12px; font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #334155; }
    tr:hover { background: #263348; }
    .refresh { color: #64748b; font-size: 12px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>🤖 Agent Lay — Admin Dashboard</h1>
  <p class="sub">LazyHardWork LINE OA · auto-refreshes every 30 s</p>

  <div class="cards">
    <div class="card"><div class="num" style="color:#22c55e">${counts.BOT_ACTIVE}</div><div class="lbl">🟢 Bot Active</div></div>
    <div class="card"><div class="num" style="color:#f59e0b">${counts.WAITING_HUMAN}</div><div class="lbl">🟡 Waiting Human</div></div>
    <div class="card"><div class="num" style="color:#ef4444">${counts.HUMAN_ACTIVE}</div><div class="lbl">🔴 Human Active</div></div>
    <div class="card"><div class="num">${sessions.length}</div><div class="lbl">Total Sessions</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>User ID</th>
        <th>Display Name</th>
        <th>Status</th>
        <th>Last Message</th>
        <th>Updated</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody>
      ${sessions.length ? rows : emptyRow}
    </tbody>
  </table>
</body>
</html>`);
});

// Resume bot: GET /admin/resume?secret=xxx&userId=Uxxxxx
app.get('/admin/resume', (req, res) => {
  const userId = req.query.userId;
  const secret = req.query.secret;
  if (!userId) return res.status(400).send('userId required');
  const prev = state.getStatus(userId);
  state.setStatus(userId, state.BOT_ACTIVE);
  res.send(`<p>✅ Resumed <strong>${userId}</strong> from <code>${prev}</code> → BOT_ACTIVE</p><p><a href="/admin?secret=${secret}" style="color:#3b82f6">← Back to dashboard</a></p>`);
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
