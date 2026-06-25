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

  const STATUS_OPTIONS = ['BOT_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE'];
  const statusColor = { BOT_ACTIVE: '#22c55e', WAITING_HUMAN: '#f59e0b', HUMAN_ACTIVE: '#ef4444' };
  const statusEmoji = { BOT_ACTIVE: '🟢', WAITING_HUMAN: '🟡', HUMAN_ACTIVE: '🔴' };

  const counts = { BOT_ACTIVE: 0, WAITING_HUMAN: 0, HUMAN_ACTIVE: 0 };
  sessions.forEach(s => counts[s.status] = (counts[s.status] || 0) + 1);

  const rows = sessions.map(({ userId, displayName, status, lastMessage, updatedAt }) => {
    const options = STATUS_OPTIONS.map(s =>
      `<option value="${s}" ${s === status ? 'selected' : ''}>${statusEmoji[s]} ${s}</option>`
    ).join('');
    const color = statusColor[status] || '#94a3b8';
    return `
      <tr style="border-bottom:1px solid #1e293b">
        <td style="padding:10px 12px;color:#94a3b8;font-size:12px;font-family:monospace">${userId.slice(0, 12)}…</td>
        <td style="padding:10px 12px;font-weight:600">${displayName || '—'}</td>
        <td style="padding:10px 12px">
          <select onchange="setStatus('${userId}', this.value)"
            style="background:#0f172a;color:${color};border:1px solid ${color}44;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;outline:none">
            ${options}
          </select>
        </td>
        <td style="padding:10px 12px;color:#94a3b8;font-size:13px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lastMessage || '—'}</td>
        <td style="padding:10px 12px;color:#64748b;font-size:12px">${updatedAt ? new Date(updatedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '—'}</td>
      </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="5" style="padding:32px;text-align:center;color:#475569">ยังไม่มี session — รอลูกค้าทัก</td></tr>`;

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
    .toast { position:fixed; bottom:20px; right:20px; background:#1e293b; border:1px solid #334155; color:#e2e8f0; padding:10px 16px; border-radius:8px; font-size:13px; display:none; z-index:99; }
  </style>
</head>
<body>
  <div class="toast" id="toast"></div>
  <script>
    function setStatus(userId, newStatus) {
      fetch('/admin/set-status?secret=${secret}&userId=' + userId + '&status=' + newStatus)
        .then(r => r.json())
        .then(d => {
          const t = document.getElementById('toast');
          t.textContent = '✅ ' + (d.displayName || userId.slice(0,8)) + ' → ' + newStatus;
          t.style.display = 'block';
          setTimeout(() => { t.style.display = 'none'; }, 3000);
          // Update dropdown color
          const sel = document.querySelector('select[onchange*="' + userId + '"]');
          const colors = { BOT_ACTIVE:'#22c55e', WAITING_HUMAN:'#f59e0b', HUMAN_ACTIVE:'#ef4444' };
          if (sel) { sel.style.color = colors[newStatus]; sel.style.borderColor = colors[newStatus] + '44'; }
        })
        .catch(() => alert('Error — check server'));
    }
  </script>
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
      </tr>
    </thead>
    <tbody>
      ${sessions.length ? rows : emptyRow}
    </tbody>
  </table>
</body>
</html>`);
});

// Admin guide: GET /admin/docs?secret=xxx
app.get('/admin/docs', (req, res) => {
  const secret = req.query.secret;
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>คู่มือ Agent Lay — สำหรับแอดมิน</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.7}
    .wrap{max-width:780px;margin:0 auto;padding:32px 20px}
    h1{font-size:26px;font-weight:800;margin-bottom:4px}
    h2{font-size:17px;font-weight:700;margin:36px 0 12px;padding-left:12px;border-left:3px solid #3b82f6}
    h3{font-size:14px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin:20px 0 8px}
    p{color:#cbd5e1;margin-bottom:10px}
    .sub{color:#64748b;font-size:13px;margin-bottom:28px}
    .nav{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:32px}
    .nav a{background:#1e293b;color:#94a3b8;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:13px}
    .nav a:hover{color:#e2e8f0;background:#334155}
    .card{background:#1e293b;border-radius:12px;padding:20px 24px;margin-bottom:16px}
    .card p{margin-bottom:0}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700}
    .green{background:#22c55e22;color:#22c55e}
    .yellow{background:#f59e0b22;color:#f59e0b}
    .red{background:#ef444422;color:#ef4444}
    .blue{background:#3b82f622;color:#60a5fa}
    .step{display:flex;gap:14px;margin-bottom:14px;align-items:flex-start}
    .step .num{background:#3b82f6;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;margin-top:2px}
    .step .body{flex:1}
    .step .body strong{display:block;margin-bottom:2px}
    code{background:#1e293b;padding:2px 7px;border-radius:4px;font-family:monospace;font-size:13px;color:#f472b6;word-break:break-all}
    .url-box{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 16px;font-family:monospace;font-size:13px;color:#60a5fa;word-break:break-all;margin:10px 0}
    .scenario{background:#1e293b;border-left:3px solid #334155;border-radius:0 8px 8px 0;padding:14px 18px;margin-bottom:12px}
    .scenario .trigger{font-weight:700;margin-bottom:4px}
    .scenario .action{color:#94a3b8;font-size:14px}
    .tip{background:#1e3a5f;border-radius:8px;padding:14px 18px;margin-bottom:12px;font-size:14px;color:#93c5fd}
    .warn{background:#2d1b0e;border-radius:8px;padding:14px 18px;margin-bottom:12px;font-size:14px;color:#fbbf24}
    hr{border:none;border-top:1px solid #1e293b;margin:32px 0}
    table{width:100%;border-collapse:collapse;margin:10px 0}
    td,th{text-align:left;padding:10px 12px;border-bottom:1px solid #1e293b;font-size:14px}
    th{color:#64748b;font-weight:600;font-size:12px;text-transform:uppercase}
    .footer{color:#334155;font-size:12px;text-align:center;margin-top:48px;padding-top:24px;border-top:1px solid #1e293b}
  </style>
</head>
<body>
<div class="wrap">

  <h1>🤖 คู่มือ Agent Lay</h1>
  <p class="sub">สำหรับแอดมิน (คุณมอส) · ไม่ต้องเป็น dev ก็อ่านได้</p>

  <div class="nav">
    <a href="/admin?secret=${secret}">📊 Dashboard</a>
    <a href="#states">สถานะบอท</a>
    <a href="#discord">Discord Alerts</a>
    <a href="#resume">วิธี Resume</a>
    <a href="#kb">อัปเดต KB</a>
    <a href="#scenarios">Scenarios</a>
    <a href="#urls">Quick Links</a>
  </div>

  <!-- WHAT IS AGENT LAY -->
  <div class="card">
    <h3>Agent Lay ทำอะไร?</h3>
    <p>บอท LINE OA ของ LazyHardWork ที่คอยตอบลูกค้าแทนคุณมอสตลอด 24 ชม. ตอบจาก KB เท่านั้น ไม่แต่งข้อมูลเอง เมื่อลูกค้าสนใจจ้างจริง บอทจะส่ง lead มาที่ Discord <code>#leads</code> เมื่อลูกค้าขอคุยกับคน บอทจะแจ้งที่ <code>#crm</code> แล้วหยุดตอบรอคุณมอสเข้ามาจัดการ</p>
  </div>

  <hr>

  <!-- BOT STATES -->
  <h2 id="states">สถานะบอท (Bot States)</h2>
  <p>บอทมี 3 สถานะ — ดูได้จาก Dashboard</p>

  <div class="card" style="margin-bottom:10px">
    <span class="badge green">🟢 BOT_ACTIVE</span>
    <p style="margin-top:8px">บอททำงานปกติ ตอบลูกค้าเอง คุณมอสไม่ต้องทำอะไร</p>
  </div>
  <div class="card" style="margin-bottom:10px">
    <span class="badge yellow">🟡 WAITING_HUMAN</span>
    <p style="margin-top:8px">ลูกค้าขอคุยกับคนจริง บอทหยุดตอบแล้ว รอคุณมอสเข้ามา Discord จะส่ง alert <code>#crm</code> ให้ <strong>ต้องกด Resume</strong> เมื่อคุยเสร็จ</p>
  </div>
  <div class="card" style="margin-bottom:10px">
    <span class="badge red">🔴 HUMAN_ACTIVE</span>
    <p style="margin-top:8px">คุณมอสกำลังคุยกับลูกค้าอยู่ บอทหยุดสนิท ไม่แทรก <strong>ต้องกด Resume</strong> เมื่อคุยเสร็จ</p>
  </div>

  <hr>

  <!-- DISCORD ALERTS -->
  <h2 id="discord">Discord Alerts — อ่านยังไง?</h2>

  <h3>🟢 #leads — มี Lead เข้า</h3>
  <div class="card">
    <p style="font-family:monospace;font-size:13px;color:#86efac;line-height:2">
      🟢 New Lead<br>
      ชื่อ: สมชาย ร้านข้าวมันไก่<br>
      ธุรกิจ: ร้านอาหาร<br>
      ปัญหา: อยากให้บอทรับออเดอร์แทน<br>
      งบ: 15,000<br>
      ติดต่อ: 0891234567<br>
      ช่องทาง: LINE OA<br>
      เวลา: 24/6/2569 09:53<br>
      สรุป: สนใจจ้างทำบอท LINE OA สำหรับร้านอาหาร
    </p>
  </div>
  <div class="tip">💡 เมื่อเห็น #leads — โทรหาลูกค้าได้เลย หรือแอดกลับใน LINE ภายใน 1-2 ชม. ขณะที่ลูกค้ายังร้อน</div>

  <h3>🔴 #crm — ลูกค้าขอคุยกับคนจริง</h3>
  <div class="card">
    <p style="font-family:monospace;font-size:13px;color:#fca5a5;line-height:2">
      🔴 Human Required<br>
      ลูกค้า: สมชาย ร้านข้าวมันไก่<br>
      เรื่อง: สนใจบริการ Starter แต่อยากคุยรายละเอียดเพิ่ม<br>
      เวลา: 24/6/2569 09:54<br>
      สถานะ: WAITING_HUMAN
    </p>
  </div>
  <div class="tip">💡 เมื่อเห็น #crm — เปิด LINE OA Manager แล้วเข้าไปคุยกับลูกค้าได้เลย บอทหยุดรอแล้ว เมื่อคุยเสร็จอย่าลืม Resume บอท</div>

  <div class="tip">❓ #crm ยังใช้สำหรับแจ้งเมื่อ "บอทไม่รู้คำตอบ" ด้วย (KB Gap) — นั่นแปลว่าควรเพิ่มข้อมูลใน KB</div>

  <hr>

  <!-- RESUME -->
  <h2 id="resume">วิธี Resume บอท (เมื่อคุยกับลูกค้าเสร็จแล้ว)</h2>

  <div class="step">
    <div class="num">1</div>
    <div class="body">
      <strong>เปิด Dashboard</strong>
      คลิกลิงก์ Dashboard ด้านบน หรือไปที่ Quick Links
    </div>
  </div>
  <div class="step">
    <div class="num">2</div>
    <div class="body">
      <strong>หาชื่อลูกค้าในตาราง</strong>
      ดูที่คอลัมน์ Status — จะเห็น <span class="badge yellow">🟡 WAITING_HUMAN</span> หรือ <span class="badge red">🔴 HUMAN_ACTIVE</span>
    </div>
  </div>
  <div class="step">
    <div class="num">3</div>
    <div class="body">
      <strong>กดปุ่ม "Resume Bot"</strong>
      ปุ่มสีน้ำเงินด้านขวาของแถวนั้น — กดแล้วรอ 1 วิ บอทจะกลับมา <span class="badge green">🟢 BOT_ACTIVE</span> ทันที
    </div>
  </div>

  <div class="warn">⚠️ อย่าลืม Resume หลังคุยเสร็จทุกครั้ง ไม่งั้นบอทจะหยุดตอบลูกค้ารายนั้นถาวร (จนกว่าจะ Resume)</div>

  <hr>

  <!-- KB UPDATE -->
  <h2 id="kb">อัปเดตความรู้บอท (Knowledge Base)</h2>
  <p>บอทตอบจากไฟล์ <code>knowledge/kb.md</code> เท่านั้น — แก้ไฟล์นี้แล้วรีสตาร์ทบอท บอทจะรู้ข้อมูลใหม่ทันที ไม่ต้องแก้โค้ด</p>

  <h3>เมื่อไหร่ควรอัปเดต KB?</h3>
  <div class="scenario">
    <div class="trigger">❓ Discord #crm มีแจ้ง "บอทไม่รู้คำตอบ" (KB Gap)</div>
    <div class="action">→ เพิ่มคำตอบนั้นใน KB บล็อกที่เกี่ยวข้อง แล้วรีสตาร์ทบอท</div>
  </div>
  <div class="scenario">
    <div class="trigger">📝 ราคา / บริการ / เงื่อนไขเปลี่ยน</div>
    <div class="action">→ แก้ในบล็อก 2 (ราคา) หรือบล็อก 1 (บริการ) ใน kb.md</div>
  </div>
  <div class="scenario">
    <div class="trigger">📞 เบอร์โทรหรืออีเมลเปลี่ยน</div>
    <div class="action">→ แก้ใน .env (CONTACT_PHONE / CONTACT_EMAIL) แล้วรีสตาร์ท — ไม่ต้องแตะ KB</div>
  </div>

  <hr>

  <!-- SCENARIOS -->
  <h2 id="scenarios">สถานการณ์ที่เจอบ่อย</h2>

  <table>
    <thead><tr><th>สถานการณ์</th><th>บอททำอะไร</th><th>คุณมอสต้องทำอะไร</th></tr></thead>
    <tbody>
      <tr>
        <td>ลูกค้าทักเข้ามาธรรมดา</td>
        <td>ตอบจาก KB อัตโนมัติ</td>
        <td>ไม่ต้องทำอะไร</td>
      </tr>
      <tr>
        <td>ลูกค้าบอก "สนใจจ้าง" หรืองบประมาณ</td>
        <td>ส่ง lead ไป Discord #leads</td>
        <td>โทรกลับลูกค้าภายใน 1-2 ชม.</td>
      </tr>
      <tr>
        <td>ลูกค้าพิมพ์ "ขอคุยกับคนจริง"</td>
        <td>ส่งแจ้ง #crm แล้วหยุดตอบ</td>
        <td>เปิด LINE OA Manager คุยเอง → Resume เมื่อเสร็จ</td>
      </tr>
      <tr>
        <td>ลูกค้าถามเรื่องที่ไม่มีใน KB</td>
        <td>บอกว่าไม่รู้ + ส่ง #crm KB Gap</td>
        <td>เพิ่มข้อมูลใน kb.md แล้วรีสตาร์ท</td>
      </tr>
      <tr>
        <td>ลูกค้าทักตอนดึก / เช้า (นอกเวลา)</td>
        <td>ตอบปกติ + แจ้งว่านอกเวลาทำการ</td>
        <td>ไม่ต้องทำอะไร — บอทจัดการได้</td>
      </tr>
      <tr>
        <td>บอทหยุดตอบโดยไม่มีเหตุผล</td>
        <td>อาจค้างอยู่ที่ WAITING_HUMAN</td>
        <td>เปิด Dashboard → กด Resume</td>
      </tr>
    </tbody>
  </table>

  <hr>

  <!-- QUICK LINKS -->
  <h2 id="urls">Quick Links</h2>
  <p>บุ๊กมาร์กลิงก์เหล่านี้ไว้ในมือถือ</p>

  <h3>Dashboard</h3>
  <div class="url-box">/admin?secret=${secret}</div>

  <h3>Resume บอท (ต้องใส่ userId)</h3>
  <div class="url-box">/admin/resume?secret=${secret}&userId=U&lt;lineUserId&gt;</div>
  <p style="font-size:13px;color:#64748b">userId อยู่ใน Discord #crm notification บรรทัด "ลูกค้า:"</p>

  <h3>เช็คสถานะ (JSON)</h3>
  <div class="url-box">/admin/status?secret=${secret}&userId=U&lt;lineUserId&gt;</div>

  <div class="footer">Agent Lay v1.0 · LazyHardWork · feature/claude-code</div>
</div>
</body>
</html>`);
});

// Set any status: GET /admin/set-status?secret=xxx&userId=Uxxxxx&status=BOT_ACTIVE
app.get('/admin/set-status', (req, res) => {
  const { userId, status } = req.query;
  const VALID = [state.BOT_ACTIVE, state.WAITING_HUMAN, state.HUMAN_ACTIVE];
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!VALID.includes(status)) return res.status(400).json({ error: `status must be one of ${VALID.join(', ')}` });
  const prev = state.getStatus(userId);
  state.setStatus(userId, status);
  res.json({ userId, displayName: state.getDisplayName(userId), prev, now: status });
});

// Resume bot (legacy shortcut): GET /admin/resume?secret=xxx&userId=Uxxxxx
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

// Full session dump for testing: GET /admin/session?secret=xxx&userId=Uxxxxx
app.get('/admin/session', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const s = state.getSession(userId);
  res.json({ userId, status: s.status, history: s.history, pendingHandoffOffer: s.pendingHandoffOffer, lastMessage: s.lastMessage });
});

app.listen(config.port, () => {
  console.log(`Agent Lay listening on port ${config.port}`);
});
