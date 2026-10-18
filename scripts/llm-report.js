#!/usr/bin/env node
// LLM spend report (doc/llm.md §4) — the same summary as GET /admin/llm/summary, as a table for Mos / the daily status.
//
//   node scripts/llm-report.js [--days 7] [--db ./data/lay.sqlite] [--json]
//
// Reads llm_calls only; opens the database read/write (node:sqlite) but writes nothing. Run it on the box that holds
// the database (Railway: `railway run node scripts/llm-report.js --db /data/lay.sqlite`).

const path = require('path');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def; }

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (vals) => vals.map((v, i) => (cols[i].right ? String(v).padStart(widths[i]) : String(v).padEnd(widths[i]))).join('  ');
  return [line(cols.map((c) => c.label)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => c.get(r))))].join('\n');
}

async function main() {
  const days = Math.max(1, parseInt(arg('days', '7'), 10) || 7);
  const config = (() => { try { return require('../src/config'); } catch { return { db: { path: './data/lay.sqlite' } }; } })();
  const dbPath = arg('db', config.db.path);
  const { createStore } = require('../src/store');
  const store = createStore({ path: path.resolve(dbPath) });
  try {
    const rows = await store.llmCalls.summary({ days });
    if (arg('json', false)) { console.log(JSON.stringify({ days, db: dbPath, rows }, null, 2)); return; }
    console.log(`LLM calls — last ${days} day(s) — ${dbPath}\n`);
    if (!rows.length) { console.log('no calls recorded'); return; }
    const f6 = (n) => Number(n || 0).toFixed(6);
    console.log(table(rows, [
      { label: 'day', get: (r) => r.day },
      { label: 'task', get: (r) => r.task },
      { label: 'model', get: (r) => r.model },
      { label: 'calls', get: (r) => r.calls, right: true },
      { label: 'ok', get: (r) => r.ok, right: true },
      { label: 'rep', get: (r) => r.repaired, right: true },
      { label: 'inv', get: (r) => r.invalid, right: true },
      { label: 'err', get: (r) => r.errors, right: true },
      { label: 'exh', get: (r) => r.exhausted, right: true },
      { label: 'fb', get: (r) => r.fallback_model, right: true },
      { label: 'prompt', get: (r) => r.prompt_tokens, right: true },
      { label: 'cached', get: (r) => r.cached_tokens, right: true },
      { label: 'compl', get: (r) => r.completion_tokens, right: true },
      { label: 'cost USD', get: (r) => f6(r.cost_usd), right: true },
      { label: 'avg ms', get: (r) => r.avg_latency_ms, right: true },
    ]));
    const total = rows.reduce((t, r) => ({ calls: t.calls + r.calls, cost: t.cost + r.cost_usd, prompt: t.prompt + r.prompt_tokens, compl: t.compl + r.completion_tokens, cached: t.cached + r.cached_tokens, bad: t.bad + r.errors + r.exhausted + r.invalid }), { calls: 0, cost: 0, prompt: 0, compl: 0, cached: 0, bad: 0 });
    console.log(`\ntotal: ${total.calls} calls · ${total.prompt} prompt (${total.cached} cached) · ${total.compl} completion · ${f6(total.cost)} USD · ${total.bad} not-ok attempts`);
    const byTask = new Map();
    for (const r of rows) { const t = byTask.get(r.task) || { calls: 0, cost: 0, good: 0 }; t.calls += r.calls; t.cost += r.cost_usd; t.good += r.ok + r.repaired + r.fallback_model; byTask.set(r.task, t); }
    console.log('\nper task:');
    for (const [task, t] of byTask) {
      const per100 = t.good ? (t.cost / t.good) * 100 : 0;
      console.log(`  ${task.padEnd(12)} ${String(t.calls).padStart(5)} calls  ${f6(t.cost)} USD  ≈ ${per100.toFixed(4)} USD per 100 successful calls`);
    }
    const perDay = new Map();
    for (const r of rows) perDay.set(r.day, (perDay.get(r.day) || 0) + r.cost_usd);
    console.log('\nper day:');
    for (const [day, cost] of [...perDay.entries()].sort()) console.log(`  ${day}  ${f6(cost)} USD`);
  } finally {
    await store.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
