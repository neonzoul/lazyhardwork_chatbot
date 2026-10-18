'use strict';
// Conventions as CI-red checks (doc/v2-conventions.md, doc/practice-audit-2026-10-18.md §3 item 2).
// Pure fs + regex over the source tree — no requires of src modules except src/core/lint.js (rule 4).
//
// How to read a failure: each test prints the offending `file:line` list. Fix the source, or — when the convention
// itself is wrong — change the rule here and the matching line in doc/v2-conventions.md in the same commit.
//
// KNOWN_DEBT below pins deviations that existed when this file was written. Each entry is a ratchet: the test fails
// if the count grows (new violation) OR drops to zero (debt paid — delete the entry). Do not add entries to make a
// new violation pass; route the case through the config/deps boundary instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findBanned } = require('../../src/core/lint');

const ROOT = path.join(__dirname, '..', '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const abs = (p) => path.join(ROOT, p);

function walk(dir, pred = () => true, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}
const SRC_JS = walk(abs('src'), (p) => p.endsWith('.js')).map(rel).sort();
const read = (file) => fs.readFileSync(abs(file), 'utf8');
const lines = (file) => read(file).split('\n');

// glob-lite: `src/line/**` = anything under the folder, exact path otherwise
function matches(file, pattern) {
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}
const allowed = (file, patterns) => patterns.some((p) => matches(file, p));

// Every line of `file` matching `re`, as `file:line  snippet`
function hits(file, re) {
  const out = [];
  lines(file).forEach((l, i) => { if (re.test(l)) out.push(`${file}:${i + 1}  ${l.trim().slice(0, 110)}`); });
  return out;
}

// Debt ratchet: { file: expectedCount }. Returns offenders (unexpected files or changed counts).
function applyDebt(found, debt, label) {
  const byFile = new Map();
  for (const h of found) { const f = h.split(':')[0]; byFile.set(f, [...(byFile.get(f) || []), h]); }
  const offenders = [];
  for (const [f, hs] of byFile) {
    const expected = debt[f];
    if (expected === undefined) offenders.push(...hs);
    else if (hs.length > expected) offenders.push(`${f}: ${hs.length} ${label} (KNOWN_DEBT allows ${expected})`, ...hs);
  }
  for (const f of Object.keys(debt)) if (!byFile.has(f)) offenders.push(`${f}: KNOWN_DEBT entry is stale — the ${label} is gone; delete the entry`);
  return offenders;
}
const fail = (title, offenders) => assert.equal(offenders.length, 0, `${title}\n  ${offenders.join('\n  ')}`);

// ---------------------------------------------------------------------------------------------------------------
// 1. SDK boundaries — "everything external is injected through deps"
const SDK_RULES = [
  { name: '@line/bot-sdk', re: /require\(['"]@line\/bot-sdk(?:\/[^'"]*)?['"]\)/, where: ['src/line/**', 'src/app.js'] },
  { name: 'openai', re: /require\(['"]openai(?:\/[^'"]*)?['"]\)/, where: ['src/brain/respond.js'] },
  { name: 'discord.js', re: /require\(['"](?:discord\.js|@discordjs\/[^'"]*)['"]\)/, where: ['src/discord/**'] },
  { name: 'axios', re: /require\(['"]axios['"]\)/, where: ['src/discord/**', 'src/app.js'] },
  { name: 'node:sqlite', re: /require\(['"](?:node:)?sqlite['"]\)/, where: ['src/store/**'] },
];

test('conventions 1: SDK requires only inside their owning folder (+ src/app.js as composition root)', () => {
  const offenders = [];
  for (const file of SRC_JS) {
    for (const rule of SDK_RULES) {
      if (allowed(file, rule.where)) continue;
      offenders.push(...hits(file, rule.re).map((h) => `[${rule.name}] ${h}`));
    }
  }
  fail('SDK required outside its owning folder — inject it through deps (src/core/deps.js):', offenders);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Config boundary — process.env only through src/config.js
const ENV_ALLOWED = ['src/config.js', 'src/agents.config.js', 'src/brain/router.js'];
const ENV_DEBT = {
  'src/admin.js': 2,          // ADMIN_TOKEN read per request so tests/restarts pick up changes (doc comment + code)
  'src/discord/relay.js': 1,  // DISCORD_REGISTER_COMMANDS flag — not in config.js yet
  'src/store/db.js': 1,       // openDb() default path reads DB_PATH directly — config.db.path exists
};

test('conventions 2: process.env only in src/config.js (and agents.config.js / brain/router.js)', () => {
  const found = [];
  for (const file of SRC_JS) {
    if (allowed(file, ENV_ALLOWED)) continue;
    found.push(...hits(file, /process\.env/));
  }
  fail('process.env outside the config boundary — add the key to src/config.js and read it from there:', applyDebt(found, ENV_DEBT, 'process.env reads'));
});

// ---------------------------------------------------------------------------------------------------------------
// 3. No hard-coded business facts in src/ — prices, phone, email, Fastwork URL, retired tag/offer
const FACT_RULES = [
  {
    name: 'THB price', re: /\d{1,3},\d{3}\s*บาท/u,
    where: ['src/cards/templates/**'],            // sample/preview data only; live prices come from pack.ladders
    debt: { 'src/brain/examples.js': 1 },         // few-shot "ราคาเริ่มต้น" example — numbers must match the pack (checked below)
  },
  {
    name: 'phone number', re: /0\d{2}[- ]?\d{3}[- ]?\d{4}/u,
    where: ['src/config.js'],                     // contact.phoneDisplay default
    debt: { 'src/core/turn.js': 1 },              // defaultConfig() fallback duplicates the config default
  },
  { name: 'email address', re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/iu, where: [], debt: {} },
  {
    name: 'fastwork.co URL', re: /fastwork\.co\//u,
    where: ['src/config.js'],
    debt: { 'src/flows/endings.js': 1, 'src/flows/examples.js': 1 },   // last-resort fallback URL; pack.fastworkUrls / config win
  },
  {
    name: '[Agent Lay] tag', re: /\[Agent Lay\]/u,
    where: ['src/core/lint.js', 'src/brain/prompt.js'],  // the ban itself and the prompt rule that states it
    debt: {},
  },
  {
    name: 'Sprint pricing', re: /Sprint\s*[123]|Sprint\s*(?:pack|package|แพ็ก)/iu,
    where: ['src/core/lint.js', 'src/brain/prompt.js'],
    debt: {},
  },
];

for (const rule of FACT_RULES) {
  test(`conventions 3: no hard-coded ${rule.name} in src/`, () => {
    const found = [];
    for (const file of SRC_JS) {
      if (allowed(file, rule.where)) continue;
      found.push(...hits(file, rule.re));
    }
    fail(`${rule.name} literal in src/ — business facts come from the knowledge pack or src/config.js:`, applyDebt(found, rule.debt, `${rule.name} literals`));
  });
}

test('conventions 3b: every price quoted in src/brain/examples.js exists in the generated offer pack', () => {
  const offer = fs.existsSync(abs('knowledge/kb/offer.md')) ? read('knowledge/kb/offer.md') : '';
  const prices = [...read('src/brain/examples.js').matchAll(/(\d{1,3},\d{3})\s*บาท/gu)].map((m) => m[1]);
  const missing = prices.filter((p) => !offer.includes(`${p} บาท`));
  assert.deepEqual(missing, [], `few-shot prices not in knowledge/kb/offer.md (stale example): ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Lint strings — every Thai customer-facing literal passes findBanned()
const THAI = /[฀-๿]/g;

// Tiny JS scanner: yields string literals with their line, skipping comments and regex literals.
function stringLiterals(src) {
  const out = [];
  let i = 0, line = 1, prevSig = '';
  const n = src.length;
  const regexCanStart = () => prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || /\b(?:return|typeof|case|in|of|do|else)$/.test(prevSig);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c, start = line; let s = ''; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
        if (src[i] === '\n') line++;
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {  // skip ${...} (one level of nesting is enough here)
          let depth = 0;
          while (i < n) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } else if (src[i] === '\n') line++; i++; }
          s += ' ';
          continue;
        }
        s += src[i++];
      }
      i++;
      out.push({ text: s, line: start });
      prevSig = 'str';
      continue;
    }
    if (c === '/' && regexCanStart()) {  // regex literal
      i++; let inClass = false;
      while (i < n && !(src[i] === '/' && !inClass)) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false;
        if (src[i] === '\n') break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/.test(src[i])) i++;
      prevSig = 're';
      continue;
    }
    if (!/\s/.test(c)) {
      // keep a short tail of significant chars/identifier to decide whether `/` starts a regex
      prevSig = /[A-Za-z_$]/.test(c) ? (/[A-Za-z_$]/.test(prevSig.slice(-1)) ? prevSig + c : c).slice(-8) : c;
    }
    i++;
  }
  return out;
}

const LINT_FOLDERS = ['src/flows/', 'src/identity/'];
const LINT_FILES = ['src/core/degraded.js'];
// "ยืนยันแล้ว" is only banned before Mos approves — the booking flow renders it on the approve path.
const LINT_ALLOW = { 'src/flows/endings.js': new Set(['booking_confirmed']) };

test('conventions 4: every Thai string literal in flows/identity passes lint findBanned()', () => {
  const files = SRC_JS.filter((f) => LINT_FOLDERS.some((d) => f.startsWith(d)) || LINT_FILES.includes(f));
  assert.ok(files.length >= 8, `expected the flow files, got ${files.length}`);
  const offenders = [];
  let checked = 0;
  for (const file of files) {
    for (const { text, line } of stringLiterals(read(file))) {
      if ((text.match(THAI) || []).length < 8) continue;
      checked++;
      const banned = findBanned(text, LINT_ALLOW[file] || new Set());
      if (banned.length) offenders.push(`${file}:${line}  [${banned.map((b) => b.id).join(',')}] ${text.slice(0, 80)}`);
    }
  }
  assert.ok(checked > 50, `scanner found only ${checked} Thai literals — scanner broken?`);
  fail('Thai string literal fails src/core/lint.js findBanned():', offenders);
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Feature map integrity — every test named in doc/feature-map.md exists
test('conventions 5: every scenario/unit test named in doc/feature-map.md exists on disk', () => {
  const map = read('doc/feature-map.md');
  const missing = [];
  const exists = (p) => {
    if (p.includes('*')) {  // glob-lite: prefix match inside the folder
      const dir = path.dirname(p), base = path.basename(p);
      const re = new RegExp('^' + base.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return fs.existsSync(abs(dir)) && fs.readdirSync(abs(dir)).some((f) => re.test(f));
    }
    return fs.existsSync(abs(p));
  };
  // explicit paths: `tests/...`
  for (const m of map.matchAll(/`(tests\/[^`\s]+)`/g)) if (!exists(m[1])) missing.push(m[1]);
  // "scenario `00-smoke-pricing`, `10-x`" and "unit `flows.test`, `turn.test`"
  for (const m of map.matchAll(/\b(scenario|unit)s?\s+((?:`[^`]+`(?:\s*,\s*)?)+)/g)) {
    const kind = m[1];
    for (const t of m[2].matchAll(/`([^`]+)`/g)) {
      const name = t[1].trim();
      if (name.endsWith(':')) continue;  // `fault:` / `sender:` are step keys, not files
      const p = kind === 'scenario' ? `tests/scenarios/${name.split(/\s+/)[0]}.yaml` : `tests/unit/${name.split(/\s+/)[0]}.js`;
      if (!exists(p)) missing.push(`${p} (feature-map: ${kind} \`${name}\`)`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], `doc/feature-map.md names tests that do not exist:\n  ${missing.join('\n  ')}`);
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Generated knowledge — header + manifest hashes
test('conventions 6: knowledge/kb/*.md carry the kb-build header and match kb-manifest.json hashes', () => {
  const kbFiles = walk(abs('knowledge/kb'), (p) => p.endsWith('.md')).map(rel).sort();
  assert.ok(kbFiles.length >= 8, `expected the 8 pack files, got ${kbFiles.length}`);
  const manifest = JSON.parse(read('knowledge/kb-manifest.json'));
  const offenders = [];
  for (const file of kbFiles) {
    const text = read(file);
    if (!/^<!-- generated by kb-build on \d{4}-\d{2}-\d{2}T[^\n]* — do not edit; run npm run kb:build -->/.test(text.split('\n')[0])) offenders.push(`${file}:1  missing kb-build header (hand-written?)`);
    const key = file.replace(/^knowledge\//, '');
    const entry = manifest.outputs?.[key];
    if (!entry) { offenders.push(`${file}  not listed in knowledge/kb-manifest.json`); continue; }
    const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    if (sha !== entry.sha256) offenders.push(`${file}  sha256 differs from the manifest — edited by hand; run npm run kb:build`);
  }
  fail('knowledge/ is GENERATED by scripts/kb-build.js — never hand-edit:', offenders);
});

// ---------------------------------------------------------------------------------------------------------------
// 7. Scenario coverage — every scenario declares what it covers
test('conventions 7: every tests/scenarios/*.yaml has a top-level covers: list', () => {
  const files = fs.readdirSync(abs('tests/scenarios')).filter((f) => f.endsWith('.yaml')).sort();
  assert.ok(files.length >= 20, `expected the scenario suite, got ${files.length}`);
  const offenders = [];
  for (const f of files) {
    const text = read(`tests/scenarios/${f}`);
    const m = text.match(/^covers:\s*(.*)$/m);
    if (!m) { offenders.push(`tests/scenarios/${f}  no covers:`); continue; }
    const inlineList = /^\[.*\S.*\]\s*$/.test(m[1]);
    const blockList = m[1].trim() === '' && /^covers:\s*\n\s*-\s*\S/m.test(text);
    if (!inlineList && !blockList) offenders.push(`tests/scenarios/${f}  covers: is empty or not a list`);
  }
  fail('scenario without a covers: list (what brief/design sections does it prove?):', offenders);
});

// ---------------------------------------------------------------------------------------------------------------
// 8. Logging goes through deps.log — no console.log in src/
const CONSOLE_ALLOWED = ['src/core/deps.js', 'src/index.js'];
test('conventions 8: no console.log in src/ (use deps.log.info/warn/error)', () => {
  const offenders = [];
  for (const file of SRC_JS) {
    if (allowed(file, CONSOLE_ALLOWED)) continue;
    offenders.push(...hits(file, /\bconsole\.log\(/));
  }
  fail('console.log in src/ — log one line per event through deps.log:', offenders);
});
