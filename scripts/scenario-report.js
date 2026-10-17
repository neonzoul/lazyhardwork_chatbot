#!/usr/bin/env node
// Scenario report: turns the runner's --json output into a Markdown transcript per scenario.
//
//   node tests/run-scenarios.js --json tests/scenarios/_report/latest.json && node scripts/scenario-report.js
//   node scripts/scenario-report.js [--in tests/scenarios/_report/latest.json] [--out tests/scenarios/_report/latest.md]
//
// Per scenario: PASS/FAIL, covers, then every step as  customer line → bot bubbles (text / card template / quick
// replies / sender), failed steps highlighted. This is the raw material for the Thai HTML test report (brief §9.1:
// Mos rates the transcripts) — the words are the scripted model's, so they double as voice examples.

const fs = require('fs');
const path = require('path');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; }

const inPath = arg('in', path.join('tests', 'scenarios', '_report', 'latest.json'));
const outPath = arg('out', path.join('tests', 'scenarios', '_report', 'latest.md'));

const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const results = Array.isArray(raw) ? raw : raw.results || [];
const meta = Array.isArray(raw) ? { ran_at: null, model: null } : raw;

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const q = (s) => `"${String(s ?? '').replace(/\r?\n/g, ' ⏎ ')}"`;

function inputLine(step) {
  if (step.kind === 'fault') return null;
  if (step.kind === 'clock') return null;
  if (step.kind === 'decision') return `**มอส (Discord)**: /${step.input.decision}${step.input.windows?.length ? ' ' + step.input.windows.join(' · ') : ''}`;
  if (step.kind === 'mos_relay') return `**มอส (relay)**: ${q(step.input)}`;
  if (step.kind === 'postback') return `**ลูกค้า (ปุ่ม)**: \`${step.input}\``;
  if (step.kind === 'media') return `**ลูกค้า (สื่อ)**: ${step.input}`;
  if (step.kind === 'follow') return '**ลูกค้า**: _เพิ่มเพื่อน_';
  return `**ลูกค้า**: ${q(step.input)}`;
}

// bubbles came from the runner (bubblesOf); older JSON without them is rebuilt from `sent`
function bubblesOf(step) {
  if (step.bubbles) return step.bubbles;
  return (step.sent || []).flatMap((s) => s.messages.map((m) => ({
    type: m.type === 'flex' ? 'card' : m.type, text: m.type === 'text' ? m.text : null, template: m.type === 'flex' ? (m.altText || 'flex') : null,
    alt: m.altText || null, sender: m.sender?.name || null, quick_replies: m.quickReply?.items?.map((i) => i.action.label) || [],
  })));
}

const lines = [];
const passed = results.filter((r) => r.ok).length;
lines.push('# Lay v2 — scenario report');
lines.push('');
lines.push(`- run: ${meta.ran_at || 'n/a'} · model: ${meta.model || 'scripted'} · **${passed}/${results.length} passed**`);
lines.push('- scripted model words are the voice samples; deterministic lines (opening, booking, handoff, quiet) come from `src/flows`');
lines.push('');
lines.push('| # | scenario | result | covers |');
lines.push('|---|---|---|---|');
for (const r of results) lines.push(`| ${r.file} | ${esc(r.name)} | ${r.ok ? 'PASS' : '**FAIL**'}${r.pending_transcript ? ' (placeholder)' : ''} | ${esc((r.covers || []).join(', '))} |`);
lines.push('');

for (const r of results) {
  lines.push(`## ${r.ok ? 'PASS' : 'FAIL'} · ${r.name}`);
  lines.push('');
  lines.push(`\`${r.file}\` · covers: ${(r.covers || []).map((c) => `\`${c}\``).join(' ')}${r.pending_transcript ? ' · **pending_transcript: replace with the real tester lines**' : ''}`);
  lines.push('');
  for (const step of r.steps || []) {
    if (step.kind === 'fault') { lines.push(`> _fault injected_`); lines.push(''); continue; }
    if (step.kind === 'clock') { lines.push(`> _clock advanced_`); lines.push(''); continue; }
    const head = inputLine(step);
    lines.push(`${step.ok ? '' : '### FAIL step ' + step.i + '\n'}${head}`);
    const bubbles = bubblesOf(step);
    if (!bubbles.length) lines.push(step.ok ? '- _(เงียบตามที่ออกแบบ)_' : '- **(SILENT)**');
    for (const b of bubbles) {
      const who = b.sender ? `[${b.sender}]` : '[ไม่มีผู้ส่ง]';
      const body = b.type === 'card' ? `การ์ด \`${b.template}\`${b.alt ? ` — ${b.alt}` : ''}` : q(b.text);
      const qr = b.quick_replies?.length ? ` · ปุ่ม: ${b.quick_replies.map((x) => `[${x}]`).join(' ')}` : '';
      lines.push(`- ${who} ${body}${qr}`);
    }
    if (!step.ok) for (const f of step.fails || []) lines.push(`  - **✗ ${f}**`);
    if (step.errors?.length) lines.push(`  - _turn errors: ${step.errors.join(' | ')}_`);
    lines.push('');
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`report: ${outPath} (${passed}/${results.length} passed)`);
process.exitCode = passed === results.length ? 0 : 1;
