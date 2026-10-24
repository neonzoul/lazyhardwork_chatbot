// Daily backup off the host: GET /admin/backup streams a consistent snapshot; scripts/backup-db.js verifies and prunes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createStore } = require('../../src/store');
const { createAdminRouter } = require('../../src/admin');
const backup = require('../../scripts/backup-db');

test('GET /admin/backup → a healthy SQLite copy with the data; the script saves, verifies and keeps the newest N', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lay-bk-'));
  const store = createStore({ path: path.join(dir, 'live.sqlite'), log: { info() {}, warn() {}, error() {} } });
  await store.sessions.save({ user_id: 'Ub1', mode: 'lay', homework: { business: 'ร้านกาแฟ' } });
  await store.messages.append({ user_id: 'Ub1', role: 'customer', kind: 'text', text: 'สวัสดี', created_at: new Date().toISOString() });
  const app = express();
  app.use(createAdminRouter({ store, token: 'tok', log: { info() {}, warn() {}, error() {} } }));
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/admin/backup`);
    assert.equal(denied.status, 401);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) fs.writeFileSync(path.join(out, `lay-${d}.sqlite`), 'old');
    const code = await backup.main(['--base-url', base, '--token', 'tok', '--out', out, '--keep', '2']);
    assert.equal(code, 0);
    const files = fs.readdirSync(out).sort();
    assert.equal(files.length, 2, 'pruned to --keep');
    const newest = path.join(out, files[files.length - 1]);
    const counts = backup.verify(newest);
    assert.equal(counts.sessions, 1);
    assert.equal(counts.messages, 1);
  } finally {
    server.close();
    await store.close();
  }
});

test('the script refuses a broken download instead of keeping it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lay-bk2-'));
  const server = await new Promise((r) => { const s = http.createServer((req, res) => { res.end('not a database'); }).listen(0, () => r(s)); });
  try {
    await assert.rejects(backup.main(['--base-url', `http://127.0.0.1:${server.address().port}`, '--token', 'x', '--out', dir]));
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.sqlite')), 'no half file kept as a backup');
  } finally { server.close(); }
});
