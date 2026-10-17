// lead-sync against temp copies of the two vault YAML files. Uses the real files when the vault is reachable
// (env LHW_VAULT or the default path below), otherwise the embedded fixtures that mirror their shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const sync = require('../../scripts/lead-sync');

const SCRIPT = path.resolve(__dirname, '../../scripts/lead-sync.js');
const REAL_VAULT = process.env.LHW_VAULT || 'F:/_WORK-KERNEL/ANANTAGENT_Vault/DEPARTMENT/LazyHardWork';

const FIXTURE_LEDGER = `# growth-ledger.yaml — LhW Growth Intelligence ledger (v0)
# Agents write observed fields. Only Mos fills \`mos_read\`. Never store customer personal contact details here.

version: "0.1"
created: "2026-10-12"
owner: "Mos"

cards:
  - { id: A2, tier: A, title_th: "AI Chatbot LINE OA", status: draft, wave: 1 }
# leads: source: fastwork_search|website|prototype:{service}|line_oa|social:{ig|fb|linkedin}|referral|unknown (lhw-gtm-channel-map §3)
# leads: Sales Assistant adds wave_group: W1|W2|W3|null from the chat's own words (never guessed)

snapshots: []
# - { week: "2026-W44", card_id: A1, views: 0 }

leads:
  - id: L-2026-07-11-ABC
    channel: fastwork
    card_id: null            # pre-portfolio; came through the old automation card
    date: "2026-07-11"
    customer_words_th: "ไม่หลุด ไม่มั่ว ไม่ลืม"
    qualification: { people: null, tools: "POS (brand unknown)", it_support: null }
    state: discovery
    outcome: "waiting on customer answers"
    mos_read: { pain: null, budget_signal: null, competition_pressure: null, fit_for_product: null, note: null }

  # ---- added 2026-10-14 from "Fastwork Chat History.txt" ----
  - id: L-2026-09-car-service
    channel: fastwork
    card_id: null
    date: null
    customer_words_th: "เป็นศูนย์บริการดูแลรถ ครับ"
    qualification: { people: null, tools: null, it_support: null }
    state: inquiry
    outcome: "Mos asked for a meeting"
    mos_read: { pain: null, budget_signal: null, competition_pressure: null, fit_for_product: null, note: null }

reviews: []
# - { date: "2026-11-10", cards_reviewed: [A1, A2] }
`;

const FIXTURE_LEADS = `# _agent/data/leads.yaml
# Structured lead database — SINGLE SOURCE OF TRUTH for lead data.
# HARD RULE: every write here = an _agent/index.yaml update in the same operation.

version: "1.0"
last_updated: "2026-09-16"
updated_by: "Codex backlog triage"

leads:
  - id: "LEAD-001"
    date_added: "2026-07-14"
    contact:
      channel: "line"
      handle: "☘️Limi"
      line_id: "SIWAPEUA"
    business_name: "Sathorn Hub Coworking Space"
    platform_source: "fastwork"
    status: "converted"          # new | contacted | qualifying | interested | converted | lost
    next_action: ""
    notes: >-
      Logged from a LINE DM before the link to the existing Fastwork lead was known.
      Real business name surfaced here.
    converted:
      date: "2026-07-14"
      client_folder: "Clients/002_penny_fastwork/"
    lost: null
`;

const FIXTURE_INDEX = `# _agent/index.yaml
# Metadata for every file in the workspace.

version: "1.0"
last_updated: "2026-10-01"
updated_by: "someone"

files:
  - path: AGENTS.md
    type: protocol
`;

const UID = 'U' + 'f'.repeat(32);
const EXPORT = [
  {
    id: 'L-2026-10-18-line_oa-k3x9q2', status: 'booking_pending', card_id: 'A2', symptom: 'no_followup',
    homework: { business: 'คลินิกความงาม', problem_verbatim: 'ตอบแชทลูกค้าไม่ทัน ลืมตามคนที่ถามราคา', urgency: 'อยากได้เดือนนี้', preferred_contact: 'โทร' },
    customer_words_th: 'ตอบแชทลูกค้าไม่ทัน ลืมตามคนที่ถามราคา', wave_group: 'W1', source: 'line_oa',
    created_at: '2026-10-18T03:10:00.000Z', updated_at: '2026-10-18T03:40:00.000Z',
    contact: { display_name: 'คุณบี 081-234-5678', line_user_id: UID },
    booking: { id: 'B-2026-10-18-aaaaaa', status: 'pending', window_text: 'จันทร์ 14:00', fields: {}, proposed_windows: null, decided_by: null, decided_at: null, created_at: '2026-10-18T03:40:00.000Z' },
  },
  {
    id: 'L-2026-10-18-line_oa-p0p0p0', status: 'new', card_id: null, symptom: null, homework: {}, customer_words_th: null, wave_group: null, source: 'line_oa',
    created_at: '2026-10-18T05:00:00.000Z', updated_at: '2026-10-18T05:00:00.000Z', contact: { display_name: null, line_user_id: 'U' + '1'.repeat(32) }, booking: null,
  },
];

function makeVault(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lhw-vault-'));
  const files = { ledger: path.join(root, sync.LEDGER_REL), leads: path.join(root, sync.LEADS_REL), index: path.join(root, sync.INDEX_REL) };
  for (const f of Object.values(files)) fs.mkdirSync(path.dirname(f), { recursive: true });
  if (source === 'real') {
    fs.copyFileSync(path.join(REAL_VAULT, sync.LEDGER_REL), files.ledger);
    fs.copyFileSync(path.join(REAL_VAULT, sync.LEADS_REL), files.leads);
    fs.copyFileSync(path.join(REAL_VAULT, sync.INDEX_REL), files.index);
  } else {
    fs.writeFileSync(files.ledger, FIXTURE_LEDGER, 'utf8');
    fs.writeFileSync(files.leads, FIXTURE_LEADS, 'utf8');
    fs.writeFileSync(files.index, FIXTURE_INDEX, 'utf8');
  }
  return { root, files, read: (k) => fs.readFileSync(files[k], 'utf8') };
}

function assertSynced(v, before) {
  const ledgerText = v.read('ledger');
  const leadsText = v.read('leads');
  const ledger = yaml.load(ledgerText);
  const leads = yaml.load(leadsText);

  // appended, parse OK, old entries untouched
  const l1 = ledger.leads.find((e) => e.id === EXPORT[0].id);
  const l2 = ledger.leads.find((e) => e.id === EXPORT[1].id);
  assert.ok(l1 && l2, 'both leads in the ledger');
  assert.deepEqual(Object.keys(l1), ['id', 'channel', 'card_id', 'date', 'customer_words_th', 'qualification', 'state', 'outcome', 'source', 'wave_group', 'mos_read']);
  assert.equal(l1.channel, 'line_oa'); assert.equal(l1.source, 'line_oa'); assert.equal(l1.card_id, 'A2');
  assert.equal(l1.date, '2026-10-18'); assert.equal(l1.state, 'discovery'); assert.equal(l1.outcome, null);
  assert.equal(l1.qualification, 'hot'); assert.equal(l1.wave_group, 'W1'); assert.deepEqual(l1.mos_read, {});
  assert.equal(l1.customer_words_th, 'ตอบแชทลูกค้าไม่ทัน ลืมตามคนที่ถามราคา');
  assert.equal(l2.state, 'inquiry'); assert.equal(l2.qualification, 'cold'); assert.equal(l2.customer_words_th, null);
  assert.equal(ledger.leads.length, before.ledger.leads.length + 2);
  assert.deepEqual(ledger.leads.slice(0, before.ledger.leads.length), before.ledger.leads, 'existing ledger entries untouched');
  assert.deepEqual(ledger.cards, before.ledger.cards);

  // no contact in the ledger
  assert.ok(!ledgerText.includes(UID) && !ledgerText.includes('คุณบี') && !ledgerText.includes('081-234-5678'));
  assert.ok(!/line_user_id|display_name|^\s+handle:/m.test(ledgerText));
  // comments preserved, header bumped
  for (const c of ['# leads: Sales Assistant adds wave_group', 'Never store customer personal contact details here', '# pre-portfolio', 'mos_read: { pain: null']) assert.ok(ledgerText.includes(c), `ledger comment kept: ${c}`);
  assert.ok(!ledgerText.includes('\r'), 'LF only');

  // leads.yaml: contact present, mapping, header bumped, existing entries untouched (block scalars included)
  const e1 = leads.leads.find((e) => e.id === EXPORT[0].id);
  const e2 = leads.leads.find((e) => e.id === EXPORT[1].id);
  assert.ok(e1 && e2);
  assert.deepEqual(e1.contact, { channel: 'line', handle: 'คุณบี 081-234-5678', line_user_id: UID });
  assert.equal(e1.business_name, 'คลินิกความงาม'); assert.equal(e1.platform_source, 'line_oa');
  assert.equal(e1.status, 'interested'); assert.equal(e1.date_added, '2026-10-18');
  assert.ok(e1.next_action.includes('จันทร์ 14:00'));
  assert.ok(e1.notes.includes('ตอบแชทลูกค้าไม่ทัน') && e1.notes.includes('จันทร์ 14:00') && e1.notes.includes(EXPORT[0].id));
  assert.equal(e1.converted, null); assert.equal(e1.lost, null);
  assert.equal(e2.status, 'new'); assert.equal(e2.business_name, 'TBD'); assert.equal(e2.contact.handle, null);
  assert.deepEqual(leads.leads.slice(0, before.leads.leads.length), before.leads.leads, 'existing leads.yaml entries untouched');
  assert.equal(leads.updated_by, 'lead-sync (Lay v2)');
  assert.notEqual(leads.last_updated, before.leads.last_updated);
  assert.equal(ledger.leads.length, before.ledger.leads.length + 2);
  assert.ok(leadsText.includes('# HARD RULE: every write here'), 'leads.yaml header comment kept');
  assert.ok(leadsText.includes('# new | contacted | qualifying | interested | converted | lost'));

  // index.yaml: only the last_updated line moved
  const idxBefore = before.indexText.split('\n');
  const idxAfter = v.read('index').split('\n');
  assert.equal(idxAfter.length, idxBefore.length);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const diff = idxAfter.map((l, i) => [l, idxBefore[i]]).filter(([a, b]) => a !== b);
  assert.ok(diff.length <= 1 && diff.every(([a, b]) => /^last_updated:/.test(a) && /^last_updated:/.test(b)), 'only the last_updated line may differ');
  assert.ok(idxAfter.includes(`last_updated: "${today}"`), 'index last_updated = today');
}

for (const source of ['fixture', 'real']) {
  const realOk = source !== 'real' || fs.existsSync(path.join(REAL_VAULT, sync.LEDGER_REL));
  test(`lead-sync (${source} files): append, preserve comments, re-parse, idempotent, mos_read kept, no contact in ledger`, { skip: realOk ? false : 'vault not reachable' }, () => {
    const v = makeVault(source);
    const before = { ledger: yaml.load(v.read('ledger')), leads: yaml.load(v.read('leads')), indexText: v.read('index') };

    // dry run writes nothing
    const dry = sync.syncLeads(EXPORT, { vault: v.root, dryRun: true });
    assert.equal(dry.files.ledger.created, 2);
    assert.equal(v.read('index'), before.indexText);

    const r1 = sync.syncLeads(EXPORT, { vault: v.root });
    assert.deepEqual([r1.files.ledger.created, r1.files.ledger.updated, r1.files.leads.created, r1.files.leads.updated, r1.files.index.bumped], [2, 0, 2, 0, true]);
    assertSynced(v, before);
    const after1 = { ledger: v.read('ledger'), leads: v.read('leads'), index: v.read('index') };

    // second run: nothing changes
    const r2 = sync.syncLeads(EXPORT, { vault: v.root });
    assert.deepEqual([r2.files.ledger.skipped, r2.files.leads.skipped, r2.changed, r2.files.index.bumped], [2, 2, false, false]);
    assert.equal(v.read('ledger'), after1.ledger); assert.equal(v.read('leads'), after1.leads); assert.equal(v.read('index'), after1.index);

    // Mos fills mos_read and flips a status by hand; the bot moves on → update keeps Mos's writes, never regresses
    const ledgerHand = v.read('ledger').replace(`  - id: ${EXPORT[0].id}\n`, `  - id: ${EXPORT[0].id}\n`).replace(/(  - id: L-2026-10-18-line_oa-k3x9q2[\s\S]*?)    mos_read: \{\}/, '$1    mos_read: { pain: "stated", note: "Mos read 18 Oct" }');
    fs.writeFileSync(v.files.ledger, ledgerHand, 'utf8');
    const leadsHand = v.read('leads').replace(/(  - id: "L-2026-10-18-line_oa-p0p0p0"[\s\S]*?)    status: "new"/, '$1    status: "lost"');
    fs.writeFileSync(v.files.leads, leadsHand, 'utf8');
    const moved = [
      { ...EXPORT[0], status: 'booked', booking: { ...EXPORT[0].booking, status: 'confirmed' }, customer_words_th: 'ตอบแชทลูกค้าไม่ทัน ลืมตามคนที่ถามราคา เสียลูกค้าไปหลายคน', homework: { ...EXPORT[0].homework, problem_verbatim: 'ตอบแชทลูกค้าไม่ทัน ลืมตามคนที่ถามราคา เสียลูกค้าไปหลายคน' } },
      { ...EXPORT[1], status: 'qualified', homework: { business: 'ร้านดอกไม้', problem_verbatim: 'ออเดอร์ตกหล่น' }, customer_words_th: 'ออเดอร์ตกหล่น' },
    ];
    const r3 = sync.syncLeads(moved, { vault: v.root });
    assert.deepEqual([r3.files.ledger.updated, r3.files.leads.updated], [2, 2]);
    const ledger3 = yaml.load(v.read('ledger'));
    const a = ledger3.leads.find((e) => e.id === EXPORT[0].id);
    assert.deepEqual(a.mos_read, { pain: 'stated', note: 'Mos read 18 Oct' }, 'mos_read preserved on update');
    assert.equal(a.customer_words_th, 'ตอบแชทลูกค้าไม่ทัน ลืมตามคนที่ถามราคา เสียลูกค้าไปหลายคน');
    assert.equal(a.state, 'discovery');
    const b = ledger3.leads.find((e) => e.id === EXPORT[1].id);
    assert.equal(b.state, 'discovery'); assert.equal(b.qualification, 'warm');
    const leads3 = yaml.load(v.read('leads'));
    const lost = leads3.leads.find((e) => e.id === EXPORT[1].id);
    assert.equal(lost.status, 'lost', 'hand-set terminal status is kept');
    assert.equal(lost.business_name, 'ร้านดอกไม้', 'facts still flow in');
    const l0 = leads3.leads.find((e) => e.id === EXPORT[0].id);
    assert.equal(l0.status, 'interested');
    assert.ok(l0.next_action.startsWith('Call at the booked window'));
    assert.ok(l0.notes.includes('(confirmed)'));
    assert.deepEqual(leads3.leads.slice(0, before.leads.leads.length), before.leads.leads);
    assert.ok(v.read('ledger').includes('# pre-portfolio'));
    // idempotent again
    const r4 = sync.syncLeads(moved, { vault: v.root });
    assert.equal(r4.changed, false);
  });
}

test('lead-sync CLI: --from-file + --vault prints the summary table and exits 0; second run reports skipped', () => {
  const v = makeVault('fixture');
  const file = path.join(v.root, 'export.json');
  fs.writeFileSync(file, JSON.stringify(EXPORT), 'utf8');
  const out1 = execFileSync(process.execPath, [SCRIPT, '--vault', v.root, '--from-file', file], { encoding: 'utf8' });
  assert.match(out1, /growth-ledger\.yaml\s+2\s+0\s+0/);
  assert.match(out1, /_agent\/data\/leads\.yaml\s+2\s+0\s+0/);
  assert.match(out1, /last_updated bumped/);
  const out2 = execFileSync(process.execPath, [SCRIPT, '--vault', v.root, '--from-file', file, '--dry-run'], { encoding: 'utf8' });
  assert.match(out2, /growth-ledger\.yaml\s+0\s+0\s+2/);
  assert.match(out2, /dry run/);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--vault', v.root], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PUBLIC_BASE_URL: '', ADMIN_TOKEN: '' } }));
  assert.deepEqual(sync.parseArgs(['--vault', 'x', '--since', '2026-10-18T00:00:00Z', '--dry-run']), { vault: 'x', since: '2026-10-18T00:00:00Z', dryRun: true });
});
