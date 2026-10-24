#!/usr/bin/env node
// Daily database backup OFF the host (Railway today, a VPS tomorrow). Downloads GET /admin/backup, checks the file is a
// healthy SQLite database with the expected tables, keeps the newest N copies, and exits non-zero on any failure so the
// scheduler (Windows Task Scheduler, cron) shows it. The backups contain customer data: keep them on an owner-controlled
// disk, never in git or the vault.
//
//   node scripts/backup-db.js [--base-url https://…] [--token …] [--out <dir>] [--keep 14]
//   defaults: --base-url $LAY_BACKUP_BASE_URL or https://lazyhardworkchatbot-production.up.railway.app
//             --token $ADMIN_TOKEN (from .env) · --out $LAY_BACKUP_DIR or ./backups · --keep 14
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--base-url') o.baseUrl = next();
    else if (a === '--token') o.token = next();
    else if (a === '--out') o.out = next();
    else if (a === '--keep') o.keep = Number(next());
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const REQUIRED_TABLES = ['sessions', 'messages', 'leads', 'events'];

function verify(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const ok = db.prepare('PRAGMA integrity_check').get();
    const integrity = ok && Object.values(ok)[0];
    if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`);
    const counts = {};
    for (const t of REQUIRED_TABLES) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return counts;
  } finally { db.close(); }
}

function prune(dir, keep) {
  const files = fs.readdirSync(dir).filter((f) => /^lay-\d{4}-\d{2}-\d{2}.*\.sqlite$/.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return old.length;
}

async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 9).join('\n')); return 0; }
  const baseUrl = (a.baseUrl || process.env.LAY_BACKUP_BASE_URL || 'https://lazyhardworkchatbot-production.up.railway.app').replace(/\/$/, '');
  const token = a.token || process.env.ADMIN_TOKEN;
  const out = path.resolve(a.out || process.env.LAY_BACKUP_DIR || 'backups');
  const keep = Number.isFinite(a.keep) && a.keep > 0 ? a.keep : 14;
  if (!token) throw new Error('no admin token (ADMIN_TOKEN in .env or --token)');
  fs.mkdirSync(out, { recursive: true });
  const day = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // Bangkok date
  const file = path.join(out, `lay-${day}.sqlite`);
  const tmp = `${file}.part`;
  const res = await fetch(`${baseUrl}/admin/backup`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`GET /admin/backup → ${res.status}`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  let counts;
  try { counts = verify(tmp); } catch (err) { fs.rmSync(tmp, { force: true }); throw new Error(`downloaded file is not a healthy backup: ${err.message}`); }
  fs.renameSync(tmp, file);
  const pruned = prune(out, keep);
  const bytes = fs.statSync(file).size;
  console.log(`backup ok ${file} · ${bytes} bytes · ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')} · pruned ${pruned}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(`backup FAILED: ${err.message}`); process.exit(1); });
}

module.exports = { main, verify, prune, parseArgs };
