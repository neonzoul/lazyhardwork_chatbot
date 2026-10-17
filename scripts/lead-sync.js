#!/usr/bin/env node
// lead-sync — pull leads from the bot and write them into the vault (design §9, brief §6).
//
//   node scripts/lead-sync.js --vault <root> [--since <iso>] [--base-url <https://app>] [--token <ADMIN_TOKEN>]
//                             [--from-file export.json] [--dry-run]
//
// Reads  GET {base-url}/admin/leads?since=<iso>  (bearer token; env ADMIN_TOKEN / PUBLIC_BASE_URL as defaults) or a
// JSON file with the same shape (src/leads/export.js). Writes, by TEXT INSERTION so comments and formatting survive:
//   Clients/000_lazyhardwork/PJ_go_to_market/growth-ledger.yaml → leads[]   (GTM view — NO contact)
//   _agent/data/leads.yaml → leads[]                                        (operational view — contact lives here)
//   _agent/index.yaml                                                       (last_updated header line only)
// Idempotent: a second run with the same export changes nothing. `mos_read` is never overwritten.
// js-yaml is used to READ and to VERIFY; never to dump the whole file.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { qualify } = require('../src/leads/intake');

const LEDGER_REL = path.join('Clients', '000_lazyhardwork', 'PJ_go_to_market', 'growth-ledger.yaml');
const LEADS_REL = path.join('_agent', 'data', 'leads.yaml');
const INDEX_REL = path.join('_agent', 'index.yaml');
const UPDATED_BY = 'lead-sync (Lay v2)';

// bot status → ledger state / leads.yaml status. Sync only raises a state; hand-set higher states are kept.
const LEDGER_STATE = { new: 'inquiry', qualified: 'discovery', booking_pending: 'discovery', booked: 'discovery', offer_shown: 'proposed', closed: 'closed' };
const LEDGER_RANK = ['inquiry', 'discovery', 'proposed', 'paid'];
const LEADS_STATUS = { new: 'new', qualified: 'qualifying', booking_pending: 'interested', booked: 'interested', offer_shown: 'interested', closed: 'contacted' };
const LEADS_RANK = ['new', 'contacted', 'qualifying', 'interested', 'converted'];
const LEADS_TERMINAL = new Set(['converted', 'lost']);
const NEXT_ACTION = {
  new: 'Wait for homework; Lay keeps asking. Mos reads the thread in #leads.',
  qualified: 'Mos reads the lead and replies within the day.',
  booking_pending: 'Mos confirms the call window',
  booked: 'Call at the booked window',
  offer_shown: 'Follow up on the offer shown',
  closed: '',
};

// ---------------------------------------------------------------------------------------------------------------
// CLI
function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (a === '--vault') out.vault = next();
    else if (a === '--since') out.since = next();
    else if (a === '--base-url') out.baseUrl = next();
    else if (a === '--token') out.token = next();
    else if (a === '--from-file') out.fromFile = next();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function loadExport({ fromFile, baseUrl, token, since }) {
  if (fromFile) {
    const data = JSON.parse(fs.readFileSync(fromFile, 'utf8'));
    return Array.isArray(data) ? data : data.leads || [];
  }
  const base = (baseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const bearer = token || process.env.ADMIN_TOKEN;
  if (!base) throw new Error('--base-url (or PUBLIC_BASE_URL) required when --from-file is not given');
  if (!bearer) throw new Error('--token (or ADMIN_TOKEN) required when --from-file is not given');
  const url = `${base}/admin/leads${since ? `?since=${encodeURIComponent(since)}` : ''}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.leads || [];
}

// ---------------------------------------------------------------------------------------------------------------
// YAML text surgery helpers. Files are handled as LF text; a CRLF file is written back as CRLF.
const q = (v) => (v === null || v === undefined || v === '' ? 'null' : JSON.stringify(String(v)));
const isoDateBangkok = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
};

function readText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  return { text: raw.replace(/\r\n/g, '\n'), crlf };
}
function writeText(file, text, crlf) { fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8'); }

/** Span [start, end) of the top-level `leads:` block body (after the key line, up to the next top-level key). */
function leadsBlock(text) {
  const m = /^leads:[ \t]*(?:#.*)?$/m.exec(text);
  if (!m) throw new Error('no top-level `leads:` key');
  const bodyStart = m.index + m[0].length + 1;
  const rest = text.slice(bodyStart);
  const nextTop = /^(?=[A-Za-z_][\w-]*:)/m.exec(rest);
  const end = nextTop ? bodyStart + nextTop.index : text.length;
  return { start: bodyStart, end };
}

/** Span of the entry `  - id: <id>` inside the block (to the next `  - id:` or the block end). */
function entrySpan(text, block, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^  - id:[ \\t]*["']?${esc}["']?[ \\t]*(?:#.*)?$`, 'm');
  const body = text.slice(block.start, block.end);
  const m = re.exec(body);
  if (!m) return null;
  const start = block.start + m.index;
  const after = body.slice(m.index + m[0].length);
  const nxt = /^  - id:/m.exec(after);
  const end = nxt ? block.start + m.index + m[0].length + nxt.index : block.end;
  return { start, end };
}

/** Replace (or insert) the line(s) of `    key:` inside an entry's text. Keeps a trailing `# comment` on a one-line value. */
function setKey(entry, key, valueText, { before = [] } = {}) {
  const lines = entry.split('\n');
  const keyRe = new RegExp(`^    ${key}:`);
  let i = lines.findIndex((l) => keyRe.test(l));
  if (i >= 0) {
    let j = i + 1;
    while (j < lines.length && (/^ {5,}/.test(lines[j]) || (lines[j] === '' && j + 1 < lines.length && /^ {5,}/.test(lines[j + 1])))) j += 1;
    let comment = '';
    if (j === i + 1) {
      const cm = /^(\s*[\w-]+:\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^#\n]*?)(\s+#.*)$/.exec(lines[i]);
      if (cm) comment = cm[3];
    }
    lines.splice(i, j - i, `    ${key}: ${valueText}${comment}`);
    return lines.join('\n');
  }
  // insert before the first of `before` keys found, else at the end of the entry's own lines
  for (const b of before) {
    const k = lines.findIndex((l) => new RegExp(`^    ${b}:`).test(l));
    if (k >= 0) { lines.splice(k, 0, `    ${key}: ${valueText}`); return lines.join('\n'); }
  }
  let last = lines.length - 1;
  while (last > 0 && (lines[last] === '' || /^\s*#/.test(lines[last]))) last -= 1;
  lines.splice(last + 1, 0, `    ${key}: ${valueText}`);
  return lines.join('\n');
}

/** Append `entryText` at the end of the block body, before trailing blank lines. */
function appendEntry(text, block, entryText) {
  const body = text.slice(block.start, block.end);
  const trimmed = body.replace(/\n*$/, '');
  const trailing = body.slice(trimmed.length);
  const sep = trimmed === '' ? '' : '\n';
  const newBody = `${trimmed}${sep}${entryText.replace(/\n*$/, '')}\n${trailing.length ? trailing.slice(1) : ''}`;
  return text.slice(0, block.start) + newBody + text.slice(block.end);
}

function bumpHeader(text, { date, by }) {
  let out = text.replace(/^last_updated:.*$/m, `last_updated: ${q(date)}`);
  if (by !== undefined) out = out.replace(/^updated_by:.*$/m, `updated_by: ${q(by)}`);
  return out;
}

const higher = (rankList, current, proposed) => {
  if (!current) return proposed;
  const c = rankList.indexOf(current); const p = rankList.indexOf(proposed);
  if (c < 0) return current; // hand-written state we don't know: keep it
  return p > c ? proposed : current;
};

// ---------------------------------------------------------------------------------------------------------------
// Ledger — leads[] (no contact)
function ledgerFields(lead, existing) {
  const status = lead.status || 'new';
  const proposedState = LEDGER_STATE[status] || 'inquiry';
  const words = lead.customer_words_th || lead.homework?.problem_verbatim || null;
  return {
    channel: 'line_oa',
    card_id: lead.card_id || null,
    date: existing?.date || isoDateBangkok(lead.created_at),
    customer_words_th: words,
    qualification: qualify({ homework: lead.homework || {}, booking_step: lead.booking ? 'x' : null }).qualification,
    state: existing ? higher(LEDGER_RANK, existing.state, proposedState) : proposedState,
    outcome: existing && existing.outcome !== undefined ? existing.outcome : null,
    source: 'line_oa',
    wave_group: lead.wave_group || existing?.wave_group || null,
  };
}
const LEDGER_ORDER = ['channel', 'card_id', 'date', 'customer_words_th', 'qualification', 'state', 'outcome', 'source', 'wave_group'];

// the ledger writes simple enum values bare (`channel: fastwork`), like the existing entries
const BARE_KEYS = new Set(['channel', 'card_id', 'qualification', 'state', 'source', 'wave_group']);
const lv = (k, v) => (BARE_KEYS.has(k) && typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? v : q(v));

function ledgerEntryText(id, f) {
  return [`  - id: ${id}`, ...LEDGER_ORDER.map((k) => `    ${k}: ${lv(k, f[k])}`), '    mos_read: {}'].join('\n');
}

function syncLedger(text, leads) {
  const doc = yaml.load(text) || {};
  const byId = new Map((doc.leads || []).map((e) => [String(e.id), e]));
  const counts = { created: 0, updated: 0, skipped: 0 };
  let out = text;
  for (const lead of leads) {
    const id = String(lead.id);
    const existing = byId.get(id);
    const f = ledgerFields(lead, existing);
    if (!existing) { out = appendEntry(out, leadsBlock(out), ledgerEntryText(id, f)); counts.created += 1; continue; }
    const changedKeys = ['card_id', 'customer_words_th', 'qualification', 'state', 'wave_group'].filter((k) => (existing[k] ?? null) !== (f[k] ?? null));
    if (!changedKeys.length) { counts.skipped += 1; continue; }
    const span = entrySpan(out, leadsBlock(out), id);
    if (!span) throw new Error(`ledger: entry ${id} parsed but not found in text`);
    let entry = out.slice(span.start, span.end);
    for (const k of changedKeys) entry = setKey(entry, k, lv(k, f[k]), { before: ['mos_read'] });
    out = out.slice(0, span.start) + entry + out.slice(span.end);
    counts.updated += 1;
  }
  return { text: out, counts };
}

// ---------------------------------------------------------------------------------------------------------------
// _agent/data/leads.yaml — operational view (contact lives here)
function leadsFields(lead, existing) {
  const status = lead.status || 'new';
  const proposed = LEADS_STATUS[status] || 'new';
  const window = lead.booking?.window_text ? ` Booking window: ${lead.booking.window_text} (${lead.booking.status || 'pending'}).` : '';
  const problem = lead.customer_words_th || lead.homework?.problem_verbatim || '';
  const nextAction = status === 'booking_pending' || status === 'booked'
    ? `${NEXT_ACTION[status]}${lead.booking?.window_text ? `: ${lead.booking.window_text}` : ''}`
    : NEXT_ACTION[status] ?? '';
  const keep = existing && LEADS_TERMINAL.has(existing.status);
  return {
    date_added: existing?.date_added || isoDateBangkok(lead.created_at),
    contact: { channel: 'line', handle: lead.contact?.display_name || null, line_user_id: lead.contact?.line_user_id || null },
    business_name: lead.homework?.business || existing?.business_name || 'TBD',
    platform_source: 'line_oa',
    status: keep ? existing.status : higher(LEADS_RANK, existing?.status, proposed),
    next_action: keep ? existing.next_action : nextAction,
    notes: `${problem ? `Customer's words: ${problem}.` : 'No problem statement yet.'}${window} Lead id ${lead.id}; transcript in the bot DB.`,
  };
}

function leadsEntryText(id, f) {
  return [
    `  - id: ${q(id)}`,
    `    date_added: ${q(f.date_added)}`,
    '    contact:',
    `      channel: ${q(f.contact.channel)}`,
    `      handle: ${q(f.contact.handle)}`,
    `      line_user_id: ${q(f.contact.line_user_id)}`,
    `    business_name: ${q(f.business_name)}`,
    `    platform_source: ${q(f.platform_source)}`,
    `    status: ${q(f.status)}          # new | contacted | qualifying | interested | converted | lost`,
    `    next_action: ${q(f.next_action)}`,
    `    notes: ${q(f.notes)}`,
    '    converted: null',
    '    lost: null',
  ].join('\n');
}

function syncLeadsFile(text, leads) {
  const doc = yaml.load(text) || {};
  const byId = new Map((doc.leads || []).map((e) => [String(e.id), e]));
  const counts = { created: 0, updated: 0, skipped: 0 };
  let out = text;
  for (const lead of leads) {
    const id = String(lead.id);
    const existing = byId.get(id);
    const f = leadsFields(lead, existing);
    if (!existing) { out = appendEntry(out, leadsBlock(out), `\n${leadsEntryText(id, f)}`); counts.created += 1; continue; }
    const changed = ['business_name', 'status', 'next_action', 'notes'].filter((k) => (existing[k] ?? '') !== (f[k] ?? ''));
    const contactChanged = (existing.contact?.handle ?? null) !== f.contact.handle || (existing.contact?.line_user_id ?? null) !== f.contact.line_user_id;
    if (!changed.length && !contactChanged) { counts.skipped += 1; continue; }
    const span = entrySpan(out, leadsBlock(out), id);
    if (!span) throw new Error(`leads.yaml: entry ${id} parsed but not found in text`);
    let entry = out.slice(span.start, span.end);
    for (const k of changed) entry = setKey(entry, k, q(f[k]), { before: ['converted'] });
    if (contactChanged) {
      const contactText = `{ channel: ${q(f.contact.channel)}, handle: ${q(f.contact.handle)}, line_user_id: ${q(f.contact.line_user_id)} }`;
      entry = setKey(entry, 'contact', contactText, { before: ['business_name'] });
    }
    out = out.slice(0, span.start) + entry + out.slice(span.end);
    counts.updated += 1;
  }
  return { text: out, counts };
}

// ---------------------------------------------------------------------------------------------------------------
function verify(text, file, expectIds) {
  const doc = yaml.load(text);
  const ids = new Set((doc.leads || []).map((e) => String(e.id)));
  for (const id of expectIds) if (!ids.has(String(id))) throw new Error(`${file}: ${id} missing after write (verification failed, nothing written)`);
}

/**
 * Sync an export array into the vault. Returns { files: { ledger, leads, index }, changed }.
 * Nothing is written unless both YAML files re-parse with every synced id present.
 */
function syncLeads(exportRows, { vault, dryRun = false, now = new Date() } = {}) {
  if (!vault) throw new Error('vault root required');
  const leads = (exportRows || []).filter((l) => l && l.id);
  const ledgerPath = path.join(vault, LEDGER_REL);
  const leadsPath = path.join(vault, LEADS_REL);
  const indexPath = path.join(vault, INDEX_REL);
  const today = isoDateBangkok(now.toISOString());

  const ledger = readText(ledgerPath);
  const leadsF = readText(leadsPath);
  const l1 = syncLedger(ledger.text, leads);
  const l2 = syncLeadsFile(leadsF.text, leads);
  const ids = leads.map((l) => l.id);
  verify(l1.text, LEDGER_REL, ids);
  verify(l2.text, LEADS_REL, ids);

  const ledgerChanged = l1.counts.created + l1.counts.updated > 0;
  const leadsChanged = l2.counts.created + l2.counts.updated > 0;
  const changed = ledgerChanged || leadsChanged;
  const result = { files: { ledger: { path: ledgerPath, ...l1.counts }, leads: { path: leadsPath, ...l2.counts }, index: { path: indexPath, bumped: false } }, changed, dryRun };
  if (dryRun || !changed) return result;

  if (ledgerChanged) writeText(ledgerPath, bumpHeader(l1.text, { date: today, by: UPDATED_BY }), ledger.crlf);
  if (leadsChanged) writeText(leadsPath, bumpHeader(l2.text, { date: today, by: UPDATED_BY }), leadsF.crlf);
  if (fs.existsSync(indexPath)) {
    const idx = readText(indexPath);
    writeText(indexPath, bumpHeader(idx.text, { date: today }), idx.crlf);
    result.files.index.bumped = true;
  }
  return result;
}

function printSummary(result) {
  const rows = [
    ['file', 'created', 'updated', 'skipped'],
    ['growth-ledger.yaml', result.files.ledger.created, result.files.ledger.updated, result.files.ledger.skipped],
    ['_agent/data/leads.yaml', result.files.leads.created, result.files.leads.updated, result.files.leads.skipped],
    ['_agent/index.yaml', result.files.index.bumped ? 'last_updated bumped' : 'unchanged', '', ''],
  ];
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join('  '));
  if (result.dryRun) console.log('(dry run — nothing written)');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.vault) {
    console.log('usage: node scripts/lead-sync.js --vault <root> [--since <iso>] [--base-url <https://app>] [--token <ADMIN_TOKEN>] [--from-file export.json] [--dry-run]');
    return args.help ? 0 : 2;
  }
  const rows = await loadExport(args);
  const result = syncLeads(rows, { vault: args.vault, dryRun: args.dryRun });
  printSummary(result);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(`lead-sync: ${err.message}`); process.exit(1); });
}

module.exports = { syncLeads, syncLedger, syncLeadsFile, ledgerFields, leadsFields, parseArgs, loadExport, LEDGER_STATE, LEADS_STATUS, LEDGER_REL, LEADS_REL, INDEX_REL };
