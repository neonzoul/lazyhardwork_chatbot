#!/usr/bin/env node
// Model probe (design §10, doc/llm.md §7): candidate models answer the six Rich-Menu questions plus "คุยกับคนหรือบอท"
// through the REAL lay.reply prompt (brain/prompt + the pack sections brain/select picks for that intent) and the
// strict schema. Prints validity, repairs, policy severity, latency, tokens, cost and the Thai replies.
// Calls are tracked in llm_calls under task `qa.probe` (never mixed with customer turns).
//
//   node scripts/model-probe.js --models openai/gpt-4o-mini,openai/gpt-4.1-mini [--env ../../.env] [--db ./data/lay.sqlite|:memory:]
//                               [--questions 7] [--dry] [--json out.json]
//
//   --env    path to a .env holding OPENROUTER_API_KEY (values are never printed)
//   --db     where to record qa.probe rows (default :memory: — pass the real path to keep them)
//   --dry    build the prompts and print their sizes; no network

const fs = require('fs');
const path = require('path');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def; }

const envPath = arg('env', null);
if (envPath) require('dotenv').config({ path: path.resolve(envPath) });

const QUESTIONS = [
  { text: 'ทำอะไรได้บ้าง', why: 'Rich Menu · capability' },
  { text: 'เหมาะกับงานผมไหม', why: 'Rich Menu · fit (expects the choice card)' },
  { text: 'ราคาเท่าไหร่', why: 'Rich Menu · pricing (price must be grounded)' },
  { text: 'ขอดูตัวอย่าง', why: 'Rich Menu · proof' },
  { text: 'เริ่มยังไง', why: 'Rich Menu · how to start' },
  { text: 'ใช้เวลานานไหม', why: 'follow-up · timeline' },
  { text: 'คุยกับคนหรือบอท', why: 'identity · must say it is Lay, Mos\'s AI assistant' },
];

async function main() {
  const models = String(arg('models', 'openai/gpt-4o-mini,openai/gpt-4.1-mini')).split(',').map((s) => s.trim()).filter(Boolean);
  const n = Math.min(QUESTIONS.length, Math.max(1, parseInt(arg('questions', '7'), 10) || 7));
  const dry = !!arg('dry', false);
  const config = require('../src/config');
  const { loadPack } = require('../src/brain/kb');
  const prompt = require('../src/brain/prompt');
  const { selectSections } = require('../src/brain/select');
  const { responseSchema, validateResponse } = require('../src/brain/schema');
  const policy = require('../src/core/policy');
  const topics = require('../src/flows/topics');
  const { createModel } = require('../src/brain/respond');
  const { createKeyring } = require('../src/brain/keys');
  const { createBudget, createTracker } = require('../src/brain/budget');

  const pack = loadPack(path.resolve(config.knowledgeDir));
  const questions = QUESTIONS.slice(0, n);
  const now = new Date();
  const session = { user_id: 'probe', mode: 'lay', topics_covered: [], draft: {}, homework: {}, questions_asked: 0, display_name: 'ผู้ทดสอบ' };

  // brain/select matches `section.file` against bare names ('about') while brain/kb stores 'about.md' — in this tree the
  // selector returns 0 sections (reported to the head engineer 2026-10-18). The probe must measure the prompt WITH the
  // KB, so it selects through a view of the pack whose file names are bare, and says so when production would differ.
  const bareView = { ...pack, sections: new Map([...pack.sections].map(([id, s]) => [id, { ...s, file: String(s.file || '').replace(/\.md$/, '') }])) };
  const productionCount = selectSections(pack, { intentHint: 'pricing', draft: {}, previousRefs: [] }).length;
  if (productionCount === 0) console.warn('WARNING: src/brain/select.js picks 0 sections from the real pack (file "about.md" vs "about") — the probe uses a bare-name view; production turns currently get no KB in the prompt.\n');

  const built = questions.map((q) => {
    const intentHint = topics.topicFromText(q.text) || 'unknown';
    const kbSelection = selectSections(bareView, { intentHint, draft: {}, previousRefs: [] });
    const system = prompt.buildSystemPrompt({ pack, session, intentHint, kbSelection, now, config });
    const messages = prompt.buildMessages({ systemPrompt: system, history: [], userText: q.text });
    return { ...q, intentHint, sections: kbSelection.length, system, messages, systemChars: system.length };
  });

  console.log(`probe · ${models.length} model(s) × ${questions.length} question(s) · pack built ${pack.manifest?.built_at || '?'}`);
  for (const b of built) console.log(`  ${b.text.padEnd(18)} intent=${b.intentHint.padEnd(10)} sections=${String(b.sections).padStart(2)} system≈${Math.round(b.systemChars / 1000)}k chars`);
  if (dry) return;

  const dbPath = arg('db', ':memory:');
  const { createStore } = require('../src/store');
  const store = createStore({ path: dbPath === ':memory:' ? ':memory:' : path.resolve(dbPath) });
  const keyring = createKeyring({ keys: config.llm.openrouterKeys });
  if (!keyring.size) { console.error('no OPENROUTER_API_KEY — pass --env <path to .env>'); process.exit(2); }
  const budget = createBudget({ keyring });
  const tracker = createTracker({ store, budget });
  await budget.refresh({ force: true }).catch(() => {});
  const before = budget.status().keys[0]?.server;
  if (before) console.log(`key: limit ${before.limit} USD · remaining ${before.limit_remaining} · reset ${before.limit_reset} (${before.resets_at})\n`);

  const results = [];
  for (const modelId of models) {
    const model = createModel({ task: 'lay.reply', model: modelId, keyring, tracker, timeoutMs: 45000, log: { info() {}, warn() {}, error() {} } });
    const rows = [];
    for (const b of built) {
      const started = Date.now();
      let out = { valid: false, repaired: false, severity: null, violations: [], latencyMs: 0, usage: null, replyTexts: [], card: null, quick: [], intent: null, kbRefs: [], error: null, action: null };
      try {
        const r = await model.respond({ system: b.system, messages: b.messages, schema: responseSchema, meta: { task: 'qa.probe', agent: 'qa', user_id: null } });
        const v = validateResponse(r);
        const p = policy.applyPolicy(r, { session, pack, allow: new Set(), userText: b.text });
        out = {
          ...out, valid: v.ok, repaired: !!r._meta?.repaired, severity: p.severity, violations: p.violations.map((x) => x.rule),
          latencyMs: r._meta?.latencyMs || Date.now() - started, usage: r._meta?.usage || null, model: r._meta?.model,
          replyTexts: (r.messages || []).filter((m) => m.type === 'text').map((m) => m.text),
          card: (r.messages || []).find((m) => m.type === 'card')?.template || null,
          quick: r.quick_replies || [], intent: r.intent, kbRefs: r.kb_refs || [], action: r.action || null,
        };
      } catch (err) {
        out.error = `${err.kind || 'error'}: ${err.message}`;
        out.latencyMs = Date.now() - started;
        out.usage = err.usage || null;
      }
      rows.push({ question: b.text, intentHint: b.intentHint, ...out });
      const flag = out.error ? 'ERR ' : out.valid ? (out.severity === 'fix' ? 'ok  ' : 'POL ') : 'INV ';
      console.log(`[${modelId}] ${flag} ${b.text.padEnd(18)} ${String(out.latencyMs).padStart(6)} ms  ${out.usage ? `${out.usage.prompt_tokens}/${out.usage.completion_tokens} tok  ${Number(out.usage.cost_usd || 0).toFixed(6)} USD` : ''}${out.repaired ? '  (repaired)' : ''}${out.violations.length ? `  ${out.violations.join(',')}` : ''}${out.error ? `  ${out.error}` : ''}`);
    }
    const ok = rows.filter((r) => r.valid && !r.error);
    const sendable = rows.filter((r) => r.valid && r.severity === 'fix');
    const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const sum = (k) => rows.reduce((a, r) => a + ((r.usage && r.usage[k]) || 0), 0);
    const summary = {
      model: modelId, calls: rows.length, valid: ok.length, sendable_without_regenerate: sendable.length, repaired: rows.filter((r) => r.repaired).length,
      errors: rows.filter((r) => r.error).length, p50_ms: lat[Math.floor(lat.length / 2)] || 0, max_ms: lat.at(-1) || 0,
      prompt_tokens: sum('prompt_tokens'), cached_tokens: sum('cached_tokens'), completion_tokens: sum('completion_tokens'), cost_usd: Number(sum('cost_usd').toFixed(6)),
    };
    summary.cost_per_call = rows.length ? Number((summary.cost_usd / rows.length).toFixed(6)) : 0;
    summary.cost_per_100_turns = Number((summary.cost_per_call * 100).toFixed(4));
    results.push({ summary, rows });
    console.log(`\n== ${modelId}: valid ${summary.valid}/${summary.calls} · sendable ${summary.sendable_without_regenerate}/${summary.calls} · repaired ${summary.repaired} · errors ${summary.errors} · p50 ${summary.p50_ms} ms (max ${summary.max_ms}) · tokens ${summary.prompt_tokens} in (${summary.cached_tokens} cached) / ${summary.completion_tokens} out · ${summary.cost_usd} USD total · ${summary.cost_per_call} USD/call · ≈ ${summary.cost_per_100_turns} USD per 100 turns\n`);
    for (const r of rows) {
      console.log(`  Q: ${r.question}  → intent ${r.intent || '-'}${r.card ? ` · card ${r.card}` : ''}${r.action ? ` · action ${r.action}` : ''} · refs ${r.kbRefs.join(',') || '-'} · buttons ${r.quick.join(' | ') || '-'}`);
      for (const t of r.replyTexts) console.log(`     ${t.replace(/\n/g, '\n     ')}`);
      if (r.error) console.log(`     !! ${r.error}`);
    }
    console.log('');
  }

  await budget.refresh({ force: true }).catch(() => {});
  const after = budget.status().keys[0]?.server;
  if (after) console.log(`key after: limit ${after.limit} USD · remaining ${after.limit_remaining} · usage today ${after.usage_daily}`);
  const jsonOut = arg('json', null);
  if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify({ ran_at: new Date().toISOString(), models, questions: questions.map((q) => q.text), key_before: before || null, key_after: after || null, results }, null, 2)); console.log(`written ${jsonOut}`); }
  await store.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
