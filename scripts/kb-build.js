#!/usr/bin/env node
'use strict';
// kb-build — generates the Lay v2 knowledge pack from the vault (design-lay-v2.md §8).
//
//   node scripts/kb-build.js [--vault <root>] [--project-dir <PJ_lineOA folder>] [--out knowledge]
//                            [--faq <file>] [--fit-map <file>] [--examples <file>] [--hours 13-22]
//
// Defaults: vault = $VAULT_ROOT or the LhW vault root on Mos's machine; project-dir =
// <vault>/Clients/000_lazyhardwork/PJ_lineOA_chatbot_v2, falling back to .../PJ_lineOA_chatcot_v1.
//
// Writes knowledge/kb/{about,offer,fit-map,process,faq,examples,benefits,policies}.md,
// knowledge/promotions.yaml and knowledge/kb-manifest.json. Output is deterministic: the same inputs
// give identical bytes except the built_at stamp, which appears only in each file's header comment and
// in the manifest. The build FAILS (exit 1) when a price in the cards file disagrees with the ledger
// ladders / care bands, or when a required source is missing.
//
// Content rules enforced here: prices always carry "ราคาเริ่มต้น" + the profile's price_sentence_th;
// proof = proof.line_th only; no email; phone only in about.contact-policy; no headcount selling.
// Generated files are content for the model, never edited by hand (tests/unit/kb.test.js checks hashes).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const DEFAULT_VAULT = 'F:\\_WORK-KERNEL\\ANANTAGENT_Vault\\DEPARTMENT\\LazyHardWork';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const VAULT = path.resolve(args.vault || process.env.VAULT_ROOT || DEFAULT_VAULT);
const OUT = path.resolve(args.out || 'knowledge');
const CLIENT_DIR = path.join(VAULT, 'Clients', '000_lazyhardwork');
const GTM = path.join(CLIENT_DIR, 'PJ_go_to_market');
const BENEFITS = path.join(CLIENT_DIR, 'PJ_benefits');

function resolveProjectDir() {
  if (args['project-dir']) return path.resolve(args['project-dir']);
  const v2 = path.join(CLIENT_DIR, 'PJ_lineOA_chatbot_v2');
  if (fs.existsSync(v2)) return v2;
  return path.join(CLIENT_DIR, 'PJ_lineOA_chatcot_v1');
}
const PROJECT_DIR = resolveProjectDir();

const hoursArg = String(args.hours || `${process.env.BUSINESS_HOURS_START || 13}-${process.env.BUSINESS_HOURS_END || 22}`);
const HOURS = hoursArg.split('-').map((n) => parseInt(n, 10));

function fail(msg) {
  console.error(`kb-build: FAILED — ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Sources (every read is recorded for the manifest)
// ---------------------------------------------------------------------------------------------
const sources = new Map(); // abs path -> { rel, sha256 }

function relToVault(abs) {
  const rel = path.relative(VAULT, abs);
  return rel.startsWith('..') ? abs.replace(/\\/g, '/') : rel.replace(/\\/g, '/');
}

function readSource(abs, label) {
  if (!fs.existsSync(abs)) fail(`required source missing: ${label} (${abs})`);
  const buf = fs.readFileSync(abs);
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  sources.set(abs, { rel: relToVault(abs), sha256 });
  return text;
}

const SRC = {
  profile: path.join(GTM, 'lhw-public-profile.yaml'),
  cards: path.join(GTM, 'fastwork-cards-v2-2026-10.md'),
  ledger: path.join(GTM, 'growth-ledger.yaml'),
  promotions: path.join(GTM, 'promotions.yaml'),
  operatingPlan: path.join(GTM, 'lhw-gtm-operating-plan-2026-10.md'),
  playbook: path.join(GTM, 'engagement-flow-playbook.md'),
  benefits: path.join(BENEFITS, 'benefits-register.yaml'),
  faq: args.faq ? path.resolve(args.faq) : path.join(PROJECT_DIR, 'faq-lay-v2.md'),
  fitMap: args['fit-map'] ? path.resolve(args['fit-map']) : path.join(PROJECT_DIR, 'fit-map-lay-v2.md'),
  examples: args.examples ? path.resolve(args.examples) : path.join(PROJECT_DIR, 'examples-lay-v2.md'),
};

const profile = yaml.load(readSource(SRC.profile, 'public profile'));
const ledger = yaml.load(readSource(SRC.ledger, 'growth ledger'));
const promotionsText = readSource(SRC.promotions, 'promotions');
const promotions = yaml.load(promotionsText) || {};
const cardsText = readSource(SRC.cards, 'Fastwork cards v2');
const operatingPlanText = readSource(SRC.operatingPlan, 'GTM operating plan');
const playbookText = readSource(SRC.playbook, 'engagement flow playbook');
const benefitsReg = yaml.load(readSource(SRC.benefits, 'benefits register'));
const faqText = readSource(SRC.faq, 'FAQ source (faq-lay-v2.md)');
const fitMapText = readSource(SRC.fitMap, 'fit-map source (fit-map-lay-v2.md)');
const examplesText = readSource(SRC.examples, 'examples source (examples-lay-v2.md)');

// the process pack cites these but does not quote them; keep them hashed so changes are visible
void operatingPlanText;
void playbookText;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const thb = (n) => Number(n).toLocaleString('en-US');
const num = (s) => parseInt(String(s).replace(/[^\d]/g, ''), 10);
const PRICE_SENTENCE = profile.packages.price_sentence_th;
const TIER_NAMES = ledger.tier_names_th; // {T1: ลองก่อน, ...}
const TIER_ORDER = ['T1', 'T2', 'T3'];

function stripFrontmatter(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  return m ? text.slice(m[0].length) : text;
}

function splitByHeading(text, level) {
  // returns [{title, body}] for headings of exactly `level` hashes; body excludes the heading line
  const re = new RegExp(`^#{${level}} (.+)$`, 'gm');
  const out = [];
  let m;
  const marks = [];
  while ((m = re.exec(text)) !== null) marks.push({ idx: m.index, end: m.index + m[0].length, title: m[1].trim() });
  for (let i = 0; i < marks.length; i++) {
    const body = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].idx : text.length);
    out.push({ title: marks[i].title, body: body.replace(/^\n+/, '').replace(/\n+$/, '') });
  }
  return out;
}

function cutAtRule(body) {
  // drop everything after a '---' horizontal rule
  const i = body.indexOf('\n---\n');
  return i >= 0 ? body.slice(0, i) : body;
}

// ---------------------------------------------------------------------------------------------
// Parse the cards file
// ---------------------------------------------------------------------------------------------
function parseCards(text) {
  const h1 = splitByHeading(stripFrontmatter(text), 1);
  const cards = {};
  const bCards = {};
  let hardRules = [];
  let whyChoose = [];
  let howToStart = [];
  let screening = [];

  for (const block of h1) {
    const m = block.title.match(/^([A-C]\d+) — (.+?)(?:\s*⭐.*)?$/);
    if (m) {
      const id = m[1];
      const h3 = Object.fromEntries(splitByHeading(cutAtRule(block.body), 3).map((s) => [s.title.replace(/\s*\(.*\)$/, '').trim(), s.body]));
      const desc = h3['คำอธิบาย'] || '';
      const parts = desc.split(/\n(?=▍ )/).map((p) => p.trim()).filter(Boolean);
      const t4Part = parts.find((p) => p.startsWith('▍ เมื่อพร้อมทั้งธุรกิจ'));
      const t4Price = t4Part ? num((t4Part.match(/ราคาเริ่มต้น \*?\*?([\d,]+) บาท/) || [])[1]) : null;
      cards[id] = {
        id,
        title: m[2].trim(),
        seoTitle: (h3['ชื่องาน'] || '').split('\n')[0].trim(),
        descriptionParts: parts.filter((p) => p !== t4Part),
        t4: t4Part ? { text: t4Part.replace(/^▍ /, ''), price: t4Price } : null,
        packages: parsePackages(h3['แพ็กเกจ'] || '', id),
        notes: parseNotes(h3['แพ็กเกจ'] || ''),
      };
      continue;
    }
    if (block.title.startsWith('Fastwork — การ์ดบริการ')) {
      const h2 = splitByHeading(cutAtRule(block.body), 2);
      for (const s of h2) {
        if (s.title.startsWith('⛔')) {
          hardRules = s.body.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''));
        }
        if (s.title.startsWith('ตั้งค่ารวมทุกการ์ด')) {
          const quoted = s.body.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, ''));
          const iStart = quoted.findIndex((l) => l.startsWith('▍ เริ่มยังไง'));
          whyChoose = quoted.slice(0, iStart).filter(Boolean);
          howToStart = quoted.slice(iStart).filter(Boolean);
          screening = s.body.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''));
        }
      }
      continue;
    }
    if (/การ์ดตาข่าย/.test(block.title)) {
      for (const s of splitByHeading(cutAtRule(block.body), 3)) {
        const bm = s.title.match(/^(B\d+) — (.+?)\s*\*\((?:แม่: )?(.+?)\)\*$/);
        if (!bm) continue;
        const get = (label) => ((s.body.match(new RegExp(`\\*\\*${label}:\\*\\* (.+)`)) || [])[1] || '').trim();
        bCards[bm[1]] = { id: bm[1], title: bm[2].trim(), parent: bm[3].trim(), name: get('ชื่องาน'), description: get('คำอธิบาย'), packages: get('แพ็กเกจ') };
      }
    }
  }
  return { cards, bCards, hardRules, whyChoose, howToStart, screening };
}

function tierOf(name, cardId) {
  if (name.startsWith('ลองก่อน')) return 'T1';
  if (name.startsWith('วางระบบ')) return 'T2';
  if (name.startsWith('ให้ระบบรันเอง')) return 'T3';
  if (cardId === 'C1') return 'T1';
  return null;
}

function parsePackages(section, cardId) {
  const lines = section.split('\n');
  const pkgs = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const head = line.match(/^\*\*(.+?)\*\*(?:\s*\(แพ็กเดียว\))?\s*(⭐)?\s*$/);
    if (head && !line.startsWith('- ') && !line.startsWith('>')) {
      cur = { name: head[1].trim(), recommended: Boolean(head[2]), tier: tierOf(head[1].trim(), cardId), detail: '', price: null, days: '', revisions: '', deliverables: [] };
      pkgs.push(cur);
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = line.match(/^- รายละเอียด.*?: (.+)$/))) cur.detail = m[1].trim();
    else if ((m = line.match(/^- ราคาเริ่มต้น: \*\*([\d,]+)\*\* \| ระยะเวลา: \*\*(.+?)\*\* \| แก้: (.+)$/))) {
      cur.price = num(m[1]);
      cur.days = m[2].trim();
      cur.revisions = m[3].trim();
    } else if ((m = line.match(/^- สิ่งที่ลูกค้าจะได้รับ:\s*(.*)$/))) {
      if (m[1].trim()) cur.deliverables.push(...m[1].split(' · ').map((s) => s.trim()).filter(Boolean));
    } else if ((m = line.match(/^\s+• (.+)$/))) cur.deliverables.push(m[1].trim());
  }
  for (const p of pkgs) if (!p.tier || p.price === null) fail(`could not parse package "${p.name}" of card ${cardId}`);
  return pkgs;
}

function parseNotes(section) {
  const notes = section.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, '').trim()).filter(Boolean);
  const joined = notes.join('\n');
  const out = { lines: notes, careStandard: null, careBands: null, addChannel: null };
  let m;
  if ((m = joined.match(/ค่าดูแลหลังหมดช่วงฟรี:\*\* ([\d,]+) บาท\/เดือน/))) out.careStandard = num(m[1]);
  if ((m = joined.match(/ไม่เกิน ([\d,]+) ข้อความ\/เดือน \*\*([\d,]+)\*\* · ไม่เกิน ([\d,]+) \*\*([\d,]+)\*\* · ไม่เกิน ([\d,]+) \*\*([\d,]+)\*\*/))) {
    out.careBands = [[num(m[1]), num(m[2])], [num(m[3]), num(m[4])], [num(m[5]), num(m[6])]];
  }
  if ((m = joined.match(/เพิ่มช่องทาง:\*\* \+([\d,]+) บาท/))) out.addChannel = num(m[1]);
  return out;
}

const parsed = parseCards(cardsText);
const CARD_IDS = ['A1', 'A2', 'A3', 'A4', 'C1'];
for (const id of CARD_IDS) if (!parsed.cards[id]) fail(`card ${id} not found in cards file`);
if (parsed.hardRules.length < 7) fail('hard rules block (⛔) not parsed from cards file');
if (!parsed.whyChoose.length || !parsed.howToStart.length || parsed.screening.length !== 3) fail('shared card blocks (ทำไมเลือก / เริ่มยังไง / คำถามคัดกรอง) not parsed');

// ---------------------------------------------------------------------------------------------
// Price cross-check: cards file vs ledger ladders / care bands (build fails on any mismatch)
// ---------------------------------------------------------------------------------------------
function ledgerPrice(cardId, tier) {
  const row = (ledger.cards || []).find((c) => c.id === cardId);
  const ladderId = row && row.ladder ? row.ladder : cardId;
  const override = row && row.price_override && row.price_override[tier];
  if (override !== undefined && override !== null) return override;
  const ladder = ledger.ladders[ladderId];
  return ladder && ladder.tiers ? ladder.tiers[tier] : undefined;
}

const checks = [];
const mismatches = [];
function check(label, cardValue, ledgerValue) {
  const ok = Number(cardValue) === Number(ledgerValue);
  checks.push({ label, cardValue, ledgerValue, ok });
  if (!ok) mismatches.push(`${label}: cards=${cardValue} ledger=${ledgerValue}`);
}

for (const id of CARD_IDS) {
  const card = parsed.cards[id];
  for (const p of card.packages) check(`${id}.${p.tier} (${p.name})`, p.price, ledgerPrice(id, p.tier));
  if (card.t4) check(`${id}.T4 (ทีม AI ประจำธุรกิจ)`, card.t4.price, ledgerPrice(id, 'T4'));
  if (card.notes.careStandard !== null) check(`${id} care standard`, card.notes.careStandard, ledger.ladders.care_monthly.standard);
  if (card.notes.addChannel !== null) check(`${id} add_channel`, card.notes.addChannel, ledger.ladders[id].add_channel);
  if (card.notes.careBands) {
    const lb = ledger.ladders.care_monthly.chatbot_by_messages;
    card.notes.careBands.forEach((band, i) => {
      check(`${id} care band ${i + 1} max messages`, band[0], lb[i] && lb[i][0]);
      check(`${id} care band ${i + 1} THB`, band[1], lb[i] && lb[i][1]);
    });
  }
}
// B cards quote a parent price in prose ("เริ่มได้ที่ 4,999 บาท") — any such number must exist in the ledger
const ledgerPriceSet = new Set();
for (const l of Object.values(ledger.ladders)) if (l.tiers) Object.values(l.tiers).forEach((v) => ledgerPriceSet.add(Number(v)));
for (const b of Object.values(parsed.bCards)) {
  const re = /(?:ราคาเริ่มต้น|เริ่มได้ที่) ([\d,]+) บาท/g;
  let m;
  while ((m = re.exec(b.description + ' ' + b.packages)) !== null) {
    const v = num(m[1]);
    checks.push({ label: `${b.id} prose price`, cardValue: v, ledgerValue: ledgerPriceSet.has(v) ? v : 'not in ladders', ok: ledgerPriceSet.has(v) });
    if (!ledgerPriceSet.has(v)) mismatches.push(`${b.id} prose price ${v} is not a ledger ladder price`);
  }
}
if (mismatches.length) fail(`price cross-check mismatch:\n  ${mismatches.join('\n  ')}`);

// ---------------------------------------------------------------------------------------------
// Parse the FAQ source
// ---------------------------------------------------------------------------------------------
function parseFaq(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  const front = fm ? yaml.load(fm[1]) : {};
  const body = stripFrontmatter(text);
  const groups = splitByHeading(body, 2);
  const items = [];
  for (const g of groups) {
    for (const it of splitByHeading(g.body, 3)) {
      const id = it.title.trim();
      if (!/^faq\.[a-z0-9-]+$/.test(id)) fail(`FAQ heading is not a faq.<slug> id: "${it.title}"`);
      const q = (it.body.match(/\*\*Q:\*\* (.+)/) || [])[1];
      const a = (it.body.match(/\*\*A:\*\* ([\s\S]+?)\n\*\*source:\*\*/) || [])[1];
      const status = ((it.body.match(/\*\*status:\*\* (\w+)/) || [])[1] || 'draft').toLowerCase();
      if (!q || !a) fail(`FAQ item ${id} has no Q/A`);
      items.push({ id, group: g.title, q: q.trim(), a: a.trim(), status });
    }
  }
  const approved = Boolean(front.approved_by && String(front.approved_by).trim());
  return { items, approved, front };
}
const faq = parseFaq(faqText);

// ---------------------------------------------------------------------------------------------
// Parse the authored fit-map and examples sources
// ---------------------------------------------------------------------------------------------
const ID_RE = /^(##{1,2}) ([a-z][a-z0-9-]*(?:\.[A-Za-z0-9-]+)+)\s*$/;

function parseFitMap(text) {
  const body = stripFrontmatter(text);
  const sections = splitByHeading(body, 2).filter((s) => /^fit\.[a-z0-9-]+$/.test(s.title));
  if (sections.length !== 5) fail(`fit-map source must have exactly 5 "## fit.<slug>" sections, found ${sections.length}`);
  return sections.map((s) => {
    const meta = {};
    const rest = [];
    for (const line of s.body.split('\n')) {
      const m = line.match(/^(symptom|card|tier): (.+)$/);
      if (m && rest.length === 0) meta[m[1]] = m[2].trim();
      else rest.push(line);
    }
    if (!meta.card || !meta.tier || !meta.symptom) fail(`fit-map section ${s.title} lacks symptom/card/tier lines`);
    if (!parsed.cards[meta.card]) fail(`fit-map section ${s.title} points at unknown card ${meta.card}`);
    if (/[\d,]{4,}\s*บาท/.test(rest.join('\n'))) fail(`fit-map section ${s.title} contains a THB amount — prices come from the ledger only`);
    return { id: s.title, meta, body: rest.join('\n').trim() };
  });
}
const fitMap = parseFitMap(fitMapText);

function checkExamples(text) {
  const body = stripFrontmatter(text);
  const ids = body.split('\n').map((l) => (l.match(ID_RE) || [])[2]).filter(Boolean);
  for (const need of ['examples.carousel', 'examples.demo-cafe', 'examples.demo-clinic']) {
    if (!ids.includes(need)) fail(`examples source lacks section ${need}`);
  }
  return body.trim();
}
const examplesBody = checkExamples(examplesText);

// ---------------------------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------------------------
const builtAt = new Date().toISOString();
const outputs = []; // {name, file, text, sources: [abs...]}

function header(sourcesAbs) {
  const rels = sourcesAbs.map((a) => sources.get(a).rel);
  return `<!-- generated by kb-build on ${builtAt} from ${rels.join(', ')} — do not edit; run npm run kb:build -->\n`;
}

function addOutput(name, file, bodyText, sourcesAbs) {
  const text = header(sourcesAbs) + bodyText.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  outputs.push({ name, file, text, sourcesAbs });
}

function sectionIdsOf(text) {
  return text.split('\n').map((l) => (l.match(ID_RE) || [])[2]).filter(Boolean);
}

function priceLine(cardId, tier) {
  return `ราคาเริ่มต้น ${thb(ledgerPrice(cardId, tier))} บาท`;
}

// ---- about.md -------------------------------------------------------------------------------
{
  const p = profile;
  const hours = `${String(HOURS[0]).padStart(2, '0')}:00–${String(HOURS[1]).padStart(2, '0')}:00 น.`;
  const text = `# เกี่ยวกับ LazyHardWork (about)

## about.brand
**${p.brand} (${p.brand_short}) คือใคร**
${p.brand} เป็นสตูดิโอ AI-systems ขนาดเล็กของมอส ช่วยธุรกิจไทยนำ AI มาใช้ในงานจริงและวัดผลได้
สโลแกน: ${p.tagline_th}
${p.search_presence.fastwork_profile_bio_th.trim()}
บริการ 4 สาย: AI Agent / ระบบงานภายใน · AI Chatbot · AI Automation · AI Workspace Setup และ AI Business Review สำหรับคนที่ยังไม่รู้จะเริ่มตรงไหน (รายละเอียดใน offer)
ชื่อแบรนด์ใช้ "${p.brand}" เสมอ ไม่สะกดเป็นภาษาไทย

## about.mos
**มอส และวิธีที่สตูดิโอนี้ทำงาน**
${p.proof.dogfood_th}
สตูดิโอนี้รันด้วย AI ทั้งระบบ ระบบแบบที่ขายให้ลูกค้าคือระบบที่มอสใช้ทุกวัน (รวมถึง Lay บอทตัวนี้)
มอสเป็นคนดูงานจริงของลูกค้าเอง ตัดสินใจเรื่องราคา ขอบเขต และนัดหมายเอง Lay เป็นผู้ช่วย AI ของมอส

## about.proof
**หลักฐานที่พูดได้**
${p.proof.line_th}
พูดได้เท่านี้: เรต ${p.proof.rating} ดาวบน Fastwork และประโยค "${p.proof.dogfood_th}" ไม่ระบุจำนวนงาน ไม่อ้างชื่อลูกค้าเก่าหรือตัวเลขผลลัพธ์ที่ไม่ได้วัดจริง

## about.contact-policy
**ติดต่อ ตกลง และจ่ายเงินที่ไหน**
การคุย ตกลง และจ่ายเงินทำใน Fastwork เป็นหลัก (โปรไฟล์ Fastwork ของ ${p.brand}) ให้เบอร์โทรในแชทได้เมื่อช่วยให้ลูกค้าคุยได้เร็วขึ้น ไม่ใช้ช่องทางนอกเพื่อพาดีลหรือการจ่ายเงินออกนอก Fastwork และไม่มีอีเมลให้ติดต่อ
ประโยคที่ใช้เมื่อลูกค้าอยากคุยเลย: ${p.contact.phone_line_th}
การ์ดและรูปไม่ต้องมีข้อมูลติดต่อ

## about.hours
**เวลาทำการของมอส**
มอสตอบเองช่วง ${hours} (เวลาไทย) นอกเวลานี้ Lay ยังตอบคำถามในขอบเขตคลังความรู้ได้ตามปกติ และบอกลูกค้าว่ามอสจะกลับมาตอบในเวลาทำการ
คำขอคุยกับมอสหรือนัดคุย 30 นาที Lay รับเรื่องไว้ได้ทุกเวลา แต่การยืนยันนัดเป็นของมอสเสมอ

## about.prototypes
**ตัวอย่างที่ลองเองได้**
ต้นแบบให้ลองใช้: ${p.prototypes.base_url}{service} ใช้ข้อมูลสมมติทั้งหมด ไม่มีข้อมูลธุรกิจหรือลูกค้าจริง
ผลงาน KV Premium แสดงได้เฉพาะหน้าจอและเรื่องราว ไม่มีข้อมูลธุรกิจของ KV และไม่มีข้อมูลลูกค้าจริง
`;
  addOutput('about', 'kb/about.md', text, [SRC.profile]);
}

// ---- offer.md -------------------------------------------------------------------------------
{
  const c = parsed.cards;
  const ladderTable = CARD_IDS.map((id) => {
    const tiers = TIER_ORDER.map((t) => {
      const v = ledgerPrice(id, t);
      return v === undefined ? '—' : thb(v);
    });
    return `| ${id} | ${c[id].title} | ${tiers.join(' | ')} | ${c[id].t4 ? thb(c[id].t4.price) : '—'} |`;
  }).join('\n');

  const whyChoose = parsed.whyChoose.map((l) => (l.startsWith('▍') ? `**${l.replace(/^▍ /, '')}**` : l)).join('\n');
  const howToStart = parsed.howToStart.map((l) => (l.startsWith('▍') ? `**${l.replace(/^▍ /, '')}**` : l)).join('\n');

  let text = `# บริการและราคา (offer)

## offer.overview
**ภาพรวมแพ็กเกจและราคาเริ่มต้น**
ทุกการ์ดมีแพ็กเกจ 3 ระดับ: ${TIER_NAMES.T1} (T1) · ${TIER_NAMES.T2} (T2) · ${TIER_NAMES.T3} (T3) ระดับที่ 4 "${TIER_NAMES.T4}" ไม่ใช่แพ็กเกจ แต่เป็นงานทั้งธุรกิจที่มอสประเมินเฉพาะหลังคุย
ราคาทุกตัวคือ "ราคาเริ่มต้น" — ${PRICE_SENTENCE}
ไม่มีสัญญาผูกมัด ระบบ ข้อมูล และบัญชีทุกอย่างเป็นของลูกค้า 100%
ประตูทางเข้าที่สั่งได้เลยโดยไม่ต้องคุยก่อน: A4 ${TIER_NAMES.T1} ${priceLine('A4', 'T1')} · C1 AI Business Review ${priceLine('C1', 'T1')} · หรือแพ็ก ${TIER_NAMES.T1} ของการ์ดไหนก็ได้

| การ์ด | ชื่อ | ${TIER_NAMES.T1} (T1) | ${TIER_NAMES.T2} (T2) | ${TIER_NAMES.T3} (T3) | ${TIER_NAMES.T4} (T4) |
|---|---|---|---|---|---|
${ladderTable}
หน่วย: บาท ราคาเริ่มต้น ปรับตามขอบเขตจริงหลังคุย · C1 มีแพ็กเดียว ระดับ ${TIER_NAMES.T2} ขึ้นไปของ C1 คือการทำต่อด้วยบันได A1

${whyChoose}

${howToStart}

**คำถามคัดกรอง 3 ข้อ (ถามก่อนส่งให้มอสทุกครั้ง)**
${parsed.screening.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`;

  for (const id of CARD_IDS) {
    const card = c[id];
    text += `\n## offer.${id}\n**${id} — ${card.title}**\nชื่อการ์ดบน Fastwork: ${card.seoTitle}\n\n`;
    text += card.descriptionParts.map((p) => (p.startsWith('▍ ') ? `**${p.split('\n')[0].replace(/^▍ /, '')}**\n${p.split('\n').slice(1).join('\n')}` : p)).join('\n\n');
    text += '\n';
    for (const p of card.packages) {
      const pkgTitle = p.name.startsWith(TIER_NAMES[p.tier]) ? p.name : `${TIER_NAMES[p.tier]} — ${p.name}`;
      text += `\n### offer.${id}.${p.tier}\n**${id} ${pkgTitle}${p.recommended ? ' (แพ็กที่แนะนำ)' : ''}**\n`;
      text += `${priceLine(id, p.tier)} · ระยะเวลา ${p.days} (นับวันทดสอบด้วย) · แก้ได้ ${p.revisions}\n`;
      text += `${p.detail}\n`;
      if (p.deliverables.length) text += `สิ่งที่ลูกค้าจะได้รับ:\n${p.deliverables.map((d) => `- ${d}`).join('\n')}\n`;
      text += `${PRICE_SENTENCE}\n`;
    }
    if (card.t4) {
      text += `\n### offer.${id}.T4\n**${id} ${TIER_NAMES.T4} (ไม่ใช่แพ็กเกจ ประเมินหลังคุย)**\n${card.t4.text.replace(/\*\*/g, '')}\n${PRICE_SENTENCE}\n`;
    }
    const n = card.notes;
    text += `\n### offer.${id}.care\n**${id} ค่าดูแลหลังหมดช่วงฟรี และหมายเหตุ**\n`;
    if (n.careBands) {
      text += `แพ็กแชทบอทดูแลให้ฟรี ${ledger.ladders.care_monthly.free_months_after_delivery} เดือนแรก (แพ็ก ${TIER_NAMES.T3} ดูแล 6 เดือน) หลังจากนั้นคิดตามปริมาณข้อความจริงต่อเดือน รวมค่า AI ทุกข้อความ เซิร์ฟเวอร์ แก้/เพิ่มความรู้ กันล่ม และรายงานรายเดือน:\n`;
      text += n.careBands.map(([max, price]) => `- ไม่เกิน ${thb(max)} ข้อความ/เดือน: ราคาเริ่มต้น ${thb(price)} บาท/เดือน`).join('\n') + '\n';
      text += `- มากกว่านั้นประเมินตามจริง สรุปปริมาณให้ดูทุกเดือน ปรับขั้นขึ้นลงตามจริง ยกเลิกได้ทุกเดือน\n`;
    } else if (n.careStandard !== null) {
      text += `ดูแลให้ฟรี ${ledger.ladders.care_monthly.free_months_after_delivery} เดือนแรก (แพ็ก ${TIER_NAMES.T3} ดูแลรวมนานกว่า ดูในแพ็ก) หลังจากนั้นค่าดูแล ราคาเริ่มต้น ${thb(n.careStandard)} บาท/เดือน แก้ เพิ่มความรู้ กันล่ม รายงานรายเดือน ไม่มีสัญญาผูกมัด ยกเลิกได้ทุกเดือน\n`;
    }
    if (n.addChannel !== null) {
      text += `\n### offer.${id}.add-channel\n**${id} เพิ่มช่องทาง**\nเพิ่มช่องทาง (LINE OA / Facebook / Instagram / เว็บไซต์) ราคาเริ่มต้น ${thb(n.addChannel)} บาทต่อช่องทาง ถูกกว่าทำใหม่เพราะใช้สมองและคลังความรู้ชุดเดียวกัน แก้ที่เดียวเปลี่ยนครบทุกช่อง ${PRICE_SENTENCE}\n`;
    }
    const other = n.lines.filter((l) => !/ค่าดูแลหลังหมดช่วงฟรี|ไม่เกิน [\d,]+ ข้อความ|เพิ่มช่องทาง:/.test(l));
    for (const l of other) {
      const cleaned = l.replace(/\*\*/g, '');
      if (/Phase ถัดไป/.test(cleaned)) text += `หมายเหตุ: Phase ถัดไปหลัง Phase 1 ถูกกว่า Phase แรก 30–40% (มอสประเมินเป็นเฟสหลังคุย)\n`;
      else text += `หมายเหตุ: ${cleaned}\n`;
    }
  }

  text += `\n## offer.T4\n**${TIER_NAMES.T4} — เมื่อพร้อมทั้งธุรกิจ**\n${profile.packages.whole_business_tier.name_th} ไม่ใช่แพ็กเกจบนการ์ด เป็นงานทั้งธุรกิจที่มอสออกแบบเฉพาะหลังคุยและประเมินงานจริงก่อนเสนอ ราคาเริ่มต้นต่อสาย: `;
  text += CARD_IDS.filter((id) => c[id].t4).map((id) => `${id} ${thb(c[id].t4.price)} บาท`).join(' · ');
  text += `\n${PRICE_SENTENCE} คำขอระดับนี้ส่งต่อให้มอสเสมอ\n`;

  text += `\n## offer.symptom-cards\n**การ์ดตามอาการ (B) — ใช้บันไดราคาของการ์ดแม่ทั้งชุด ไม่มีราคาแยก**\n`;
  for (const b of Object.values(parsed.bCards)) {
    // card prose says "เริ่มได้ที่ N บาท"; the pack always says "ราคาเริ่มต้น N บาท"
    const desc = b.description.replace(/เริ่มได้ที่ ([\d,]+) บาท/g, 'ราคาเริ่มต้น $1 บาท');
    text += `\n### offer.${b.id}\n**${b.id} — ${b.title}** (การ์ดแม่: ${b.parent})\n${b.name}\n${desc}\n`;
    if (b.packages) text += `แพ็กเกจ: ${b.packages}\n`;
  }
  addOutput('offer', 'kb/offer.md', text, [SRC.cards, SRC.ledger, SRC.profile]);
}

// ---- fit-map.md -----------------------------------------------------------------------------
{
  let text = `# เหมาะกับงานผมไหม — แยกตามอาการ (fit-map)\n\nการ์ด 5 ตัวเลือกในคำถาม "เหมาะกับงานผมไหม" แต่ละอาการจบที่การ์ดเดียวและราคาเริ่มต้นของแพ็ก ${TIER_NAMES.T1} เมื่อลูกค้าเลือกอาการแล้ว จำไว้ ไม่ถามซ้ำ\n`;
  text += `| อาการ (ปุ่ม) | การ์ด | section |\n|---|---|---|\n`;
  text += fitMap.map((s) => `| ${s.meta.symptom} | ${s.meta.card} ${parsed.cards[s.meta.card].title} | ${s.id} |`).join('\n') + '\n';
  for (const s of fitMap) {
    const card = parsed.cards[s.meta.card];
    const pkg = card.packages.find((p) => p.tier === s.meta.tier);
    text += `\n## ${s.id}\n**${s.meta.symptom}**\n${s.body}\n\n`;
    const pkgName = pkg ? (pkg.name.startsWith(TIER_NAMES[s.meta.tier]) ? pkg.name : `${TIER_NAMES[s.meta.tier]} — ${pkg.name}`) : TIER_NAMES[s.meta.tier];
    text += `**การ์ดที่ตรง**\n${s.meta.card} ${card.title} — แพ็ก ${pkgName} ${priceLine(s.meta.card, s.meta.tier)}${pkg ? ` · ระยะเวลา ${pkg.days}` : ''} ${PRICE_SENTENCE} รายละเอียดแพ็กและระดับถัดไปอยู่ใน offer.${s.meta.card}\n`;
  }
  addOutput('fit-map', 'kb/fit-map.md', text, [SRC.fitMap, SRC.cards, SRC.ledger, SRC.profile]);
}

// ---- process.md -----------------------------------------------------------------------------
{
  const c = parsed.cards;
  const timelineRows = CARD_IDS.flatMap((id) => c[id].packages.map((p) => `| ${id} ${TIER_NAMES[p.tier]} | ${p.days} | แก้ ${p.revisions} |`)).join('\n');
  const text = `# ทำงานกับเรายังไง (process)

## process.steps
**ลำดับตั้งแต่ทักมาจนถึงดูแลหลังส่งมอบ**
1. ทักมาในแชท (LINE OA หรือ Fastwork) เล่าสั้นๆ ว่างานติดตรงไหน Lay ถาม 3 ข้อแล้วบอกได้ว่าแพ็กไหนพอดี
2. ดูตัวอย่างหรือลองต้นแบบได้ก่อน (ขอดูตัวอย่าง / โหมดเดโม) ถ้าอยากเห็นของจริงก่อนตัดสินใจ
3. คุยกับมอส 30 นาที (สำหรับงานที่ไม่ใช่แพ็กประตูทางเข้า) มอสดูงานจริง ไฟล์จริง แชทจริง คนที่ทำจริง
4. เลือกแพ็กจากการ์ด หรือรับข้อเสนอเป็นเฟสสำหรับงานที่ต้องออกแบบเฉพาะ ตกลงและจ่ายบน Fastwork
5. ออกแบบจากงานจริงและสร้าง โดยคุยกับคนที่จะใช้จริงก่อนล็อกดีไซน์ ไม่ใช่แค่คนจ่ายเงิน
6. ทดสอบกับข้อมูลจริงร่วมกับคนที่ใช้จริงก่อนส่ง รวมเคสที่ตั้งใจหลอกให้ระบบตอบมั่ว (นับวันทดสอบในระยะเวลาแพ็กเสมอ)
7. ส่งมอบ สอนใช้ พร้อมคู่มือ 1 หน้า ระบบ ข้อมูล และบัญชีเป็นของลูกค้า 100%
8. ดูแลหลังส่งมอบ ฟรี ${ledger.ladders.care_monthly.free_months_after_delivery} เดือนแรกในแพ็กแชทบอท ระบบงานภายใน และออโตเมชัน จากนั้นต่อค่าดูแลรายเดือนได้ ไม่มีสัญญาผูกมัด

## process.short-path
**ทางสั้น: สั่งแพ็กประตูทางเข้าได้เลย ไม่ต้องคอล ไม่ต้องรอข้อเสนอ**
งานที่พอดีกับแพ็กประตูทางเข้า สั่งบน Fastwork ได้ทันที: A4 ${TIER_NAMES.T1} ตั้งค่า AI Workspace ${priceLine('A4', 'T1')} · C1 AI Business Review ${priceLine('C1', 'T1')} · หรือแพ็ก ${TIER_NAMES.T1} ของการ์ดไหนก็ได้ ${PRICE_SENTENCE}
ขั้นตอน: ดูเดโมหรือการ์ด → กดสั่งแพ็กบน Fastwork → มอสนัดเวลาเริ่มงาน

## process.long-path
**ทางยาว: งานที่ต้องออกแบบเฉพาะ**
ดูเดโมหรือต้นแบบ → นัดคุยกับมอส 30 นาที (ลูกค้าบอกช่วงเวลาที่สะดวก มอสยืนยันเอง) → มอสขอดูไฟล์จริงและคุยกับคนที่ใช้จริง → ข้อเสนอเป็นเฟสที่ใช้งานได้จริงในตัวเอง พร้อมราคา → ตกลงและสั่งบน Fastwork → สร้าง ทดสอบ ส่งมอบ ดูแล
กติกาของมอส: บอกราคาแล้วไม่กดดัน ถ้าต่อรอง มอสปรับขอบเขตให้พอดีงบ ไม่ลดราคา เฟสถัดไปถูกกว่าเฟสแรก

## process.what-you-prepare
**สิ่งที่ลูกค้าเตรียม**
ตอบ 3 ข้อนี้ก่อน: ${parsed.screening.map((s, i) => `(${i + 1}) ${s}`).join(' ')}
สำหรับรีวิวและงานออกแบบเฉพาะ: ตัวอย่างไฟล์งานจริง 3–5 ไฟล์ · เวลาคุย 2 รอบ รอบละ 30–45 นาที · เจ้าของมาเอง
สำหรับแชทบอท: ตอบคำถามเรื่องร้านประมาณ 20 นาที ที่เหลือมอสสร้างคลังความรู้ให้เอง ไม่ต้องกรอกอะไร
สำหรับ AI Workspace: คอมพิวเตอร์ Windows/Mac · บัญชี Claude Pro ขึ้นไปพร้อมแอป Claude Desktop (ค่าบัญชีลูกค้าจ่ายเอง) · ไฟล์รวมไว้ที่เดียวก่อนนัด · เจ้าของมาเอง
สำหรับออโตเมชัน: มีคนในทีมที่รู้ว่าขั้นตอนจริงเป็นยังไง และเครื่องมือที่ใช้ต้องมี API หรือ export ไฟล์ได้

## process.payment
**ตกลงและจ่ายเงินบน Fastwork**
การคุย ตกลง และจ่ายเงินทำใน Fastwork เป็นหลัก ค่าวางระบบจ่ายครั้งเดียวต่อแพ็ก ค่าดูแลรายเดือนมีก็ต่อเมื่อลูกค้าอยากให้ดูแลต่อหลังหมดช่วงฟรี ไม่มีสัญญาผูกมัด ยกเลิกได้ทุกเดือน
ไม่พาดีลหรือการจ่ายเงินออกนอก Fastwork ไม่มีส่วนลดนอกจากที่ประกาศใน promotions (ตอนนี้ไม่มี)

## process.mos-touchpoints
**จุดที่มอสเข้ามาเอง**
1. คุย 30 นาทีแรก และดูงานจริงของลูกค้าก่อนเสนอ
2. คุยกับคนที่จะใช้จริงและยืนยันกฎของระบบก่อนสร้าง (ถามยืนยันก่อนทำเสมอ จะได้ไม่ต้องแก้เยอะ)
3. ทดสอบกับข้อมูลจริงร่วมกัน ส่งมอบ และสอนใช้ (AI Workspace ติดตั้งถึงเครื่องและให้ลูกค้ารันเองต่อหน้ามอส)
4. ดูแลหลังส่งมอบตามรอบแก้ของแพ็ก รายงานรายเดือน และประเมินเฟสถัดไป
Lay ทำหน้าที่ก่อนถึงจุดเหล่านี้: ตอบคำถาม เก็บเรื่องราว และนัดเวลาให้ มอสเป็นคนยืนยันนัดและราคาจริงเสมอ

## process.timelines
**ระยะเวลาต่อแพ็ก (นับวันทดสอบด้วย)**
| แพ็ก | ระยะเวลา | รอบแก้ |
|---|---|---|
${timelineRows}
งานที่ไม่ได้ทดสอบกับข้อมูลจริงไม่ส่ง คำขอให้ระบบที่ต้องทดสอบกับข้อมูลจริง (แชทบอท ระบบงานภายใน ออโตเมชัน) เสร็จใน 5 วัน มอสไม่รับ

## process.after-handover
**หลังส่งมอบ**
ช่วงดูแลฟรี: แก้และเพิ่มความรู้ตามรอบแก้ของแพ็ก · ต่อค่าดูแลรายเดือนได้ (รายละเอียดใน offer.*.care) · งานใหม่ที่ใหญ่ขึ้นประเมินเป็นเฟสถัดไป ซึ่งถูกกว่าเฟสแรก · ถ้าหยุดดูแล ระบบยังอยู่กับลูกค้า มอสส่งมอบสิทธิ์และคู่มือให้ครบ · หลังส่งมอบมอสขอรีวิวบน Fastwork และขออนุญาตเป็นลายลักษณ์อักษรก่อนนำไปเป็นเคสตัวอย่าง
`;
  addOutput('process', 'kb/process.md', text, [SRC.operatingPlan, SRC.playbook, SRC.cards, SRC.ledger, SRC.profile]);
}

// ---- faq.md ---------------------------------------------------------------------------------
{
  // FAQ header contract: `rejected` items are never included. Before the batch approval every item is a
  // draft (included, labelled). After approval an item still marked `draft` is included but labelled and
  // warned about, so a missed flag never empties the pack on a deploy day.
  const included = faq.items.filter((it) => it.status !== 'rejected');
  let text = `# คำถามที่พบบ่อย ในน้ำเสียงของมอส (faq)\n\nสถานะชุดนี้: ${faq.approved ? `มอสอนุมัติแล้ว (${faq.front.approved_on || ''})` : 'ร่าง ยังไม่ผ่านการอนุมัติจากมอส'} — รายการที่มี <!-- status: draft --> ให้ระบุเป็นคำตอบเบื้องต้นได้\n`;
  let group = null;
  for (const it of included) {
    if (it.group !== group) {
      group = it.group;
      text += `\n**หมวด: ${group}**\n`;
    }
    const draft = !faq.approved || it.status !== 'approved';
    if (faq.approved && it.status !== 'approved') console.warn(`kb-build: WARN FAQ approved but ${it.id} is still status: ${it.status}`);
    text += `\n### ${it.id}\n${draft ? '<!-- status: draft -->\n' : ''}**${it.q}**\n${it.a}\n`;
  }
  addOutput('faq', 'kb/faq.md', text, [SRC.faq]);
}

// ---- examples.md ----------------------------------------------------------------------------
{
  const text = `# ตัวอย่างและร้านตัวอย่าง (examples)\n\n${examplesBody}\n`;
  addOutput('examples', 'kb/examples.md', text, [SRC.examples, SRC.profile]);
}

// ---- benefits.md ----------------------------------------------------------------------------
const CLIENT_AUDIENCES = new Set(['client_sme', 'client_individual', 'freelancer']);
const AUDIENCE_TH = { client_sme: 'ธุรกิจ SME (นิติบุคคลหรือบุคคลธรรมดาที่จดทะเบียนพาณิชย์)', client_individual: 'บุคคลธรรมดา', freelancer: 'ฟรีแลนซ์' };
const TYPE_TH = { subsidy: 'เงินอุดหนุนค่าบริการ', voucher: 'คูปอง', grant: 'ทุนสนับสนุน', tax: 'สิทธิประโยชน์ทางภาษี', loan: 'สินเชื่อ', training: 'อบรม/คอร์ส', free_tool: 'เครื่องมือหรือสิทธิ์ใช้ฟรี' };
const CAVEAT = 'อาจใช้สิทธิ์ได้ ต้องตรวจสอบกับหน่วยงานก่อน';
const NOT_PROVIDER = 'LazyHardWork ยังไม่ได้เป็นผู้ให้บริการที่ขึ้นทะเบียนกับโครงการเหล่านี้ (ยังไม่ขึ้นทะเบียน BDSP ของ สสว. และยังไม่อยู่ในบัญชีบริการดิจิทัลของ depa) จึงยังรับประกันไม่ได้ว่าค่าบริการของเราจะเบิกได้ มอสช่วยเตรียมเอกสารได้ แต่ไม่ใช่ที่ปรึกษากฎหมายหรือภาษี';

// Plain-Thai glosses per register id (amounts always "สูงสุด … ตามประกาศ", never a promise).
// An entry missing here falls back to a generic rendering and a build warning.
const BENEFIT_TH = {
  'osmep-bds-core': { what: 'สสว. ออกค่าบริการพัฒนาธุรกิจให้บางส่วน (เช่น งานเพิ่มผลิตภาพ พัฒนาการบริหาร มาตรฐาน การตลาด) เมื่อใช้บริการจากผู้ให้บริการที่ขึ้นทะเบียน BDSP แล้วเบิกคืนภายหลัง', who: 'SME ไทยที่ลงทะเบียนกับ สสว. ยื่นภาษีครบ ไม่ล้มละลาย', amount: 'ร่วมจ่าย 50–80% ตามขนาดธุรกิจ สูงสุด 200,000 บาทต่อปี ตามประกาศ (2 สิทธิ์ต่อปีงบประมาณ เพดานตลอดโครงการ 500,000 บาท)', deadline: 'รอบปีงบ 2569–2570 เปิดถึง 30 มิถุนายน 2570 (งบมีจำกัด)', where: 'ลงทะเบียนและตรวจสอบที่ bds.sme.go.th (ต้องมี SME One ID)' },
  'osmep-bds-box-10k': { what: 'กล่องบริการพิเศษของ สสว. จ่าย 10,000 บาท ได้คืน 9,000 บาท สำหรับบริการด้านเทคโนโลยี เช่น Cloud AI ERP POS จากผู้ให้บริการที่ขึ้นทะเบียน', who: 'MSME ทุกขนาดที่ลงทะเบียนกับ สสว.', amount: 'อุดหนุน 90% ของค่าบริการ สูงสุด 10,000 บาท ตามประกาศ (ใช้ 1 ใน 2 สิทธิ์ต่อปี)', deadline: 'รอบปีงบ 2569–2570 เปิดถึง 30 มิถุนายน 2570', where: 'bds.sme.go.th' },
  'osmep-spring-board': { what: 'มาตรการ SME Spring Board ของ สสว. ร่วมจ่ายค่าบริการเทคโนโลยีดิจิทัลที่ซื้อจากผู้ให้บริการในบัญชีบริการดิจิทัลของ depa', who: 'SME ทุกขนาดที่ลงทะเบียนกับ สสว.', amount: 'ร่วมจ่าย 50% สูงสุด 500,000 บาทต่อราย ตามประกาศ (1 สิทธิ์ 1 ข้อเสนอ)', deadline: 'หน้าโครงการระบุถึง 31 มีนาคม 2570 (มีข้อมูลขัดกันระหว่างหน้าประกาศ ต้องยืนยันกับ สสว.)', where: 'bds.sme.go.th' },
  'depa-ai-transformation-fy2570': { what: 'โครงการ AI Transformation ปีงบ 2570 ของ depa สำหรับการซื้อบริการ AI จากผู้ให้บริการที่อยู่ในบัญชีบริการดิจิทัล', who: 'SME ที่ซื้อจากผู้ให้บริการในบัญชีบริการดิจิทัลของ depa', amount: 'อัตราและวงเงินยังไม่ประกาศรายละเอียด', deadline: 'ประกาศ 14 ตุลาคม 2569 เงื่อนไขยังไม่เปิดเผยครบ', where: 'depa.or.th หัวข้อประกาศทุน' },
  'depa-otod-ai-transformation-fy2569': { what: 'โครงการ OTOD AI Transformation ปีงบ 2569 ของ depa (d-transform / d-voucher) ช่วยค่าบริการดิจิทัลให้ผู้ประกอบการ', who: 'SME และร้านค้ารายย่อย', amount: 'd-transform สูงสุด 200,000 บาทต่อราย ตามประกาศ', deadline: 'ปิดรับแล้ว (รอบปีงบ 2569) มีโครงการปีงบ 2570 ตามมา', where: 'depa.or.th' },
  'depa-mini-transformation-voucher-ai': { what: 'คูปอง depa mini Transformation Voucher ด้าน AI (AI Chatbot, AI OCR) ปี 2568', who: 'SME และบุคคลธรรมดาที่ประกอบธุรกิจ', amount: 'อัตราและวงเงินตามประกาศรอบนั้น', deadline: 'ปิดรับแล้ว 30 กันยายน 2568 ยังไม่มีรอบใหม่ประกาศ', where: 'depa.or.th หัวข้อ smedigitalcoupon' },
  'depa-digital-transformation-measure': { what: 'มาตรการ depa สนับสนุนการใช้เทคโนโลยีดิจิทัลในภาคธุรกิจอุตสาหกรรม', who: 'SME ภาคธุรกิจอุตสาหกรรม', amount: 'สูงสุด 60% ของมูลค่าโครงการ ตามประกาศ', deadline: 'แบบฟอร์มรับสมัครปิดอยู่ ถือว่ายังไม่เปิด', where: 'depa.or.th/th/transformation' },
  'rd-tax200-digital': { what: 'มาตรการภาษีให้ SME หักรายจ่ายได้ 2 เท่า สำหรับซอฟต์แวร์ อุปกรณ์ และบริการดิจิทัลที่อยู่ในบัญชีบริการดิจิทัลของ depa (ไม่รวมคอมพิวเตอร์)', who: 'บริษัทหรือห้างหุ้นส่วนนิติบุคคลที่ทุนจดทะเบียนชำระแล้วไม่เกิน 5 ล้านบาท และรายได้ไม่เกิน 30 ล้านบาท', amount: 'หักรายจ่ายได้ 2 เท่า เฉพาะส่วนที่ไม่เกิน 300,000 บาท ตามประกาศ', deadline: 'รายจ่ายที่จ่ายระหว่าง 24 มิถุนายน 2568 ถึง 31 ธันวาคม 2570', where: 'กรมสรรพากร (rd.go.th) และหน้า tax200 ของ depa ให้ผู้ทำบัญชีตรวจสอบ' },
  'rd-training-437': { what: 'สิทธิหักรายจ่ายค่าฝึกอบรมพนักงานเพิ่มอีก 100% เมื่อหลักสูตรได้รับการรับรองจากกรมพัฒนาฝีมือแรงงานหรือสถาบันที่กำหนด', who: 'บริษัทที่ส่งพนักงานของตนเองไปอบรม', amount: 'หักรายจ่ายได้เพิ่มอีก 100% ตามอัตราต่อหัวที่กระทรวงแรงงานกำหนด ตามประกาศ', deadline: 'มาตรการถาวร ไม่พบวันสิ้นสุด', where: 'กรมสรรพากร (rd.go.th) และกรมพัฒนาฝีมือแรงงาน ให้สำนักงานบัญชีตรวจสอบ' },
  'rd-stem-training-778': { what: 'มาตรการภาษีค่าฝึกอบรมทักษะขั้นสูง STEM (พ.ร.ฎ. 778) หักเพิ่ม 150%', who: 'บริษัทที่ส่งพนักงานอบรมหลักสูตรที่รับรอง', amount: 'เคยหักเพิ่มได้ 150% ตามประกาศ', deadline: 'หมดอายุแล้ว 31 ธันวาคม 2568 ยังไม่พบการต่ออายุ ห้ามใช้ขาย', where: 'กรมสรรพากร (rd.go.th)' },
  'rd-automation-776': { what: 'มาตรการภาษีส่งเสริมการลงทุนในระบบอัตโนมัติ (พ.ร.ฎ. 776) สำหรับเครื่องจักรและซอฟต์แวร์ที่ต่อกับเครื่องจักร', who: 'ธุรกิจที่ลงทุนระบบอัตโนมัติในสายการผลิต', amount: 'เคยหักเพิ่มได้ 100% ของรายจ่ายจริง ตามประกาศ', deadline: 'หมดอายุแล้ว 31 ธันวาคม 2568 และไม่ครอบคลุม AI สำนักงานอยู่แล้ว', where: 'กรมสรรพากร (rd.go.th)' },
  'nstda-itap': { what: 'โปรแกรม ITAP ของ สวทช. ร่วมจ่ายค่าที่ปรึกษาและพัฒนาเทคโนโลยีให้ SME พร้อมผู้เชี่ยวชาญวินิจฉัยเบื้องต้นฟรี', who: 'นิติบุคคลที่คนไทยถือหุ้นไม่น้อยกว่า 51% ร้านค้าจดทะเบียน หรือวิสาหกิจชุมชนตามนิยาม SME', amount: 'ร่วมจ่าย 50% ของค่าดำเนินโครงการ สูงสุด 400,000 บาทต่อโครงการ ตามประกาศ (1 โครงการต่อปี เบิกคืนหลังจบ)', deadline: 'เปิดตลอดปี', where: 'itap.nstda.or.th' },
  'boi-digital-efficiency-sme': { what: 'มาตรการ BOI ยกเว้นภาษีเงินได้นิติบุคคลเมื่อลงทุนปรับปรุงประสิทธิภาพด้วยเทคโนโลยีดิจิทัล (ซอฟต์แวร์จากผู้พัฒนาไทยในบัญชีบริการดิจิทัลนับเต็ม)', who: 'SME ที่คนไทยถือหุ้นไม่น้อยกว่า 51% รายได้ไม่เกิน 500 ล้านบาท ต้องยื่น BOI ก่อนซื้อ', amount: 'ยกเว้นภาษีเงินได้นิติบุคคล 5 ปี ไม่เกิน 100% ของเงินลงทุน ตามประกาศ (ลงทุนขั้นต่ำ 500,000 บาท)', deadline: 'ไม่ระบุวันสิ้นสุดในประกาศที่อ่านได้', where: 'BOI และหน้า BOI ของบัญชีบริการดิจิทัล depa' },
  'aipass-gemini-enterprise': { what: 'AiPASS 2.0 ให้สิทธิ์ใช้ Gemini Enterprise ฟรีแก่บุคคล เมื่อเรียนจนได้ 1,000 คะแนนบนแพลตฟอร์ม', who: 'คนไทยอายุ 15 ปีขึ้นไป บัญชีบุคคล (ไม่ใช่นิติบุคคล) เลือกได้อย่างเดียวระหว่างเครื่องมือ AiPASS หรือ Gemini Enterprise', amount: 'ฟรี สูงสุด 10 เดือน ตามประกาศ (จำนวนสิทธิ์จำกัด)', deadline: 'ใช้งานได้ 9 พฤศจิกายน 2569 ถึง 31 สิงหาคม 2570 วันปิดรับสิทธิ์ยังไม่ประกาศทางการ', where: 'aipass.go.th' },
  'aipass-base': { what: 'TH-AI Passport (AiPASS) คอร์ส AI ฟรีและสิทธิ์ใช้โมเดล AI ระดับ Pro จากภาครัฐ', who: 'บุคคลทั่วไป ยืนยันตัวตนด้วย ทางรัฐ หรือ ThaID', amount: 'ฟรี ตามประกาศ', deadline: 'ถึง 31 สิงหาคม 2570 (ลงทะเบียนภายใน 30 พฤศจิกายน 2569 เพื่อรับสิทธิ์อัปเกรดช่วงแรก)', where: 'aipass.go.th' },
  'dsd-one-platform': { what: 'แพลตฟอร์ม One Platform ของกรมพัฒนาฝีมือแรงงาน มีคอร์ส AI พื้นฐานฟรีและคอร์สเสียเงินบางส่วน', who: 'ทุกคน ทั้งเจ้าของธุรกิจ พนักงาน และฟรีแลนซ์', amount: 'คอร์ส AI 101 และ GenAI พื้นฐานฟรี คอร์สอื่นตามราคาที่ประกาศ', deadline: 'เปิดตลอด', where: 'oneplatform.dsd.go.th' },
  'gsb-temmax-transformation': { what: 'สินเชื่อออมสิน เต็มแม็กซ์ (Transformation) สำหรับธุรกิจที่ปรับตัวด้านดิจิทัล สิ่งแวดล้อม หรือนวัตกรรม', who: 'ธุรกิจที่คนไทยถือหุ้นเกิน 50% ขอสินเชื่อใหม่', amount: 'อัตราดอกเบี้ยและวงเงินต่อรายตามประกาศของธนาคาร', deadline: 'ไม่ทราบช่วงเวลา ต้องสอบถามธนาคาร', where: 'สาขาธนาคารออมสิน หรือ gsb.or.th' },
};

{
  const all = (benefitsReg.programmes || []).filter((b) => b.verified === true && (b.who_can_use || []).some((w) => CLIENT_AUDIENCES.has(w)));
  const warnings = [];
  let text = `# สิทธิ์และโครงการสนับสนุนที่ลูกค้าอาจใช้ได้ (benefits)

## benefits.overview
**วิธีพูดเรื่องสิทธิ์และโครงการรัฐ**
Lay อธิบายได้เฉพาะรายการในไฟล์นี้ (ตรวจสอบจากแหล่งทางการแล้ว) ด้วยภาษาธุรกิจง่ายๆ และต้องปิดท้ายทุกครั้งว่า "${CAVEAT}" พร้อมบอกว่าตรวจสอบที่ไหน ไม่รับปากวงเงินหรือสิทธิ์ ไม่บอกว่าเบิกได้แน่
${NOT_PROVIDER}
ถ้าลูกค้าอยากให้ช่วยยื่นขอสิทธิ์ ส่งต่อให้มอสคุยเอง
รายการที่ปิดรับหรือหมดอายุแล้วเก็บไว้เพื่อให้ตอบได้ถูกว่า "ปิดแล้ว" ไม่ใช่เพื่อขาย
`;
  for (const b of all) {
    const g = BENEFIT_TH[b.id];
    if (!g) warnings.push(`benefits: no Thai gloss for ${b.id} — generic rendering used; add it to BENEFIT_TH`);
    const closed = /CLOSED|EXPIRED|closed/.test(`${b.window_close} ${b.round_or_fy}`);
    const status = closed ? 'ปิดรับ/หมดอายุแล้ว' : /UNKNOWN/.test(String(b.window_close)) ? 'ไม่ทราบช่วงเวลาแน่ชัด' : 'เปิดอยู่ตามประกาศล่าสุดที่อ่าน';
    const audiences = (b.who_can_use || []).filter((w) => CLIENT_AUDIENCES.has(w)).map((w) => AUDIENCE_TH[w]).join(' / ');
    const src = (b.sources || [])[0] || '';
    const agency = String(b.agency).split(';')[0].trim(); // register agency fields may carry a contact email after ';' — never emitted
    text += `\n## benefits.${b.id}\n**${b.name_th}**\n`;
    text += `หน่วยงาน: ${agency} · ประเภท: ${TYPE_TH[b.type] || b.type} · สำหรับ: ${audiences}\n`;
    text += `คืออะไร: ${g ? g.what : `${b.name_th} รายละเอียดตามประกาศของหน่วยงาน`}\n`;
    text += `ใครอาจเข้าข่าย: ${g ? g.who : audiences}\n`;
    text += `วงเงิน: ${g ? g.amount : 'ตามประกาศของหน่วยงาน'}\n`;
    text += `ช่วงเวลา: ${g ? g.deadline : 'ตามประกาศของหน่วยงาน'} · สถานะ: ${status}\n`;
    text += `ตรวจสอบและสมัครที่: ${g ? g.where : b.agency}${src ? ` (${src})` : ''}\n`;
    if (Array.isArray(b.fits_cards) && b.fits_cards.length) text += `เกี่ยวกับบริการ: ${b.fits_cards.join(', ')}\n`;
    text += `${CAVEAT} · ${NOT_PROVIDER.split(' ')[0]} ยังไม่ได้เป็นผู้ให้บริการที่ขึ้นทะเบียนกับโครงการนี้ ข้อมูลอ่านเมื่อ ${b.read_on}\n`;
  }
  for (const w of warnings) console.warn(`kb-build: WARN ${w}`);
  addOutput('benefits', 'kb/benefits.md', text, [SRC.benefits, SRC.profile]);
}

// ---- policies.md ----------------------------------------------------------------------------
{
  const p = profile;
  // Hard rule 1 names the forbidden phrases themselves; we restate it so the pack never contains them.
  const rules = parsed.hardRules.map((r, i) => (i === 0 ? 'ห้ามขายด้วยข้ออ้างเรื่องจำนวนคนหรือค่าจ้าง แม้ลูกค้าเปิดประเด็นเอง — ระบบไม่ได้มาแทนใคร มันรับงานซ้ำไปทำ ทีมได้เวลาคืนไปทำงานที่ต้องใช้คนจริง' : r.replace(/\*\*/g, '')));
  const text = `# กติกาของ Lay (policies)

## policies.ai-disclosure
**Lay คือใคร และพูดเรื่องนี้ยังไง**
Lay เป็นผู้ช่วย AI ของมอสที่ ${p.brand} บอกตั้งแต่ข้อความแรกว่าเป็น AI ไม่แกล้งเป็นคน ถ้าถูกถามว่าคุยกับคนหรือบอท ตอบตรงๆ ว่าเป็น Lay ผู้ช่วย AI ของมอส และเสนอเรียกมอสเข้ามาได้
ข้อความของ Lay ส่งด้วยชื่อผู้ส่ง "Lay · ผู้ช่วย AI" ข้อความของมอสส่งด้วยชื่อ "มอส" ลูกค้าเห็นว่าใครพูดเสมอ เมื่อส่งต่อให้มอส Lay บอกว่า "เดี๋ยวมอสเข้ามาคุยเองนะครับ" และเงียบให้มอสคุย เมื่อมอสคุยเสร็จ Lay บอกว่ากลับมาแล้ว
Lay ตอบจากคลังความรู้นี้เท่านั้น ถ้าไม่รู้ บอกว่าไม่รู้ แล้วเสนอส่งให้มอสตอบ ไม่เดา ไม่แต่งบริการ ราคา หรือหลักฐานที่ไม่มีในคลัง

## policies.what-lay-cannot-decide
**สิ่งที่ Lay ตัดสินใจแทนมอสไม่ได้ (ส่งต่อเสมอ)**
- ราคาจริงหรือใบเสนอราคา: Lay บอกได้แค่ราคาเริ่มต้น ราคาจริงมอสดูงานจริงก่อน
- ส่วนลดหรือราคาพิเศษตามงบ: ไม่มีส่วนลดนอกจากรายการใน promotions ที่ยังอยู่ในช่วงวันที่ (ตอนนี้ว่าง) คำขอราคาพิเศษส่งต่อมอส และชี้ไปแพ็ก ${TIER_NAMES.T1} แทน
- รับปากเวลาส่งงานหรือขอบเขตเฉพาะ: มอสประเมินเอง
- การนัดคุย: Lay เก็บช่วงเวลาที่สะดวก (ไม่ใช่เวลาตายตัว) แสดงการ์ดสรุปให้ยืนยัน แล้วบอกว่า "รอมอสยืนยัน" ห้ามใช้คำว่า ยืนยันแล้ว หรือ นัดเรียบร้อย ก่อนมอสอนุมัติ
- งานนอกขอบเขต (ERP เต็มรูปแบบ งานที่ต้องการใน 5 วัน จ้างคนขายหรือแอดมินแทน): บอกตรงๆ ว่าไม่ใช่งานที่เราทำ และส่งต่อมอสถ้าลูกค้ายังอยากคุย
- ช่วยยื่นขอสิทธิ์หรือเงินอุดหนุน: ส่งต่อมอส
- รูป ไฟล์ และสติกเกอร์: Lay อ่านไม่ได้ ตอบสั้นๆ ว่าอ่านไม่ได้และขอเป็นข้อความ หรือส่งต่อมอส
การแจ้งว่าส่งต่อสำเร็จ ให้บอกหลังระบบแจ้งมอสสำเร็จแล้วเท่านั้น ถ้าแจ้งไม่สำเร็จ บอกตามจริงและให้เบอร์โทรของมอส (about.contact-policy)

## policies.pricing-rules
**กติกาเรื่องราคา**
ราคาทุกตัวพูดคู่กับคำว่า "ราคาเริ่มต้น" และประโยค "${PRICE_SENTENCE}" เสมอ และต้องมาจาก offer เท่านั้น
ไม่ลดราคาเพื่อชนะดีล ถ้าลูกค้าเทียบราคากับเจ้าอื่น บอกว่าส่วนต่างซื้ออะไร หรือชี้ไปแพ็ก ${TIER_NAMES.T1} แล้วจบ
ระดับ "${TIER_NAMES.T4}" ประเมินเฉพาะหลังคุย ไม่ใช่แพ็กเกจ
การตกลงและจ่ายเงินทำบน Fastwork เท่านั้น ไม่พาดีลออกนอก Fastwork

## policies.subsidy-rules
**กติกาเรื่องสิทธิ์และโครงการรัฐ**
พูดได้เฉพาะรายการใน benefits ด้วยภาษาธุรกิจง่ายๆ ปิดท้ายทุกครั้งว่า "${CAVEAT}" และบอกที่ตรวจสอบ ไม่รับปากวงเงิน ไม่บอกว่าเบิกได้แน่ ไม่บอกว่า ${p.brand} เป็นผู้ให้บริการที่ขึ้นทะเบียน (ยังไม่ใช่) ถ้าลูกค้าอยากให้ช่วยยื่น ส่งต่อมอส

## policies.banned-claims
**สิ่งที่ห้ามพูดทุกกรณี**
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
8. หลักฐานใช้ได้เฉพาะ "${p.proof.line_th}" และประโยค "${p.proof.dogfood_th}" ห้ามระบุจำนวนงาน ห้ามอ้างชื่อ zFiN ห้ามใช้ตัวเลขอย่าง "จ้างซ้ำ 3 ใน 4" หรือตัวเลขผลลัพธ์ของลูกค้าที่ไม่ได้วัดจริง
9. ห้ามขายด้วยความกลัวเรื่องงานหาย หรือตัวเลขจากข่าว (เช่น ตัวเลข "40% ของงาน" ของ IMF) แม้ข่าวจะพูดถึง
10. ห้ามอ้างสิทธิ์หรือเงินอุดหนุนนอกเหนือจากรายการใน benefits และห้ามบอกว่า ${p.brand} เป็นผู้ให้บริการที่ขึ้นทะเบียนจนกว่าจะเป็นจริง
11. ห้ามใช้คำว่า "Small AI" เป็นชื่อเรียกแบรนด์หรือบริการ
12. ห้ามให้อีเมล ห้ามโชว์ผลงานของลูกค้าโดยไม่มีคำอนุญาตเป็นลายลักษณ์อักษร และห้ามอ้างแพ็กเกจแบบเก่า (ระบบสปรินต์รายเดือน) ที่เลิกขายแล้ว

## policies.privacy
**ข้อมูลที่เก็บและเหตุผล**
ระบบของ Lay เก็บ: ประวัติการสนทนา สถานะการคุย เรื่องราวของลูกค้า (ธุรกิจ ปัญหาในคำของลูกค้า งานอยู่ในเครื่องมืออะไร ขนาดทีมและคนดูแล ความเร่งด่วนหรืองบถ้าบอกเอง ช่องทางที่สะดวก มาจากไหน) อาการและการ์ดที่เลือก ร่างนัดหมาย และคำถามที่ Lay ตอบไม่ได้ เพื่อให้มอสอ่านก่อนคุยต่อและเพื่อเติมความรู้ให้ Lay
ข้อมูลติดต่อ (เบอร์โทร ชื่อ LINE) อยู่ในระบบของ ${p.brand} เท่านั้น ข้อความแจ้งเตือนถึงมอสไม่มีเบอร์โทรหรืออีเมล และไม่มีข้อมูลธุรกิจเกินกว่าที่ลูกค้าเล่าเองว่าเป็นปัญหา
Lay ไม่ขอข้อมูลที่ไม่จำเป็น ไม่ขอรหัสผ่านหรือข้อมูลการเงิน ร้านตัวอย่างในโหมดเดโมไม่รับออเดอร์จริง ไม่รับเงินจริง และไม่เก็บข้อมูลจริงของลูกค้า
ถ้าลูกค้าขอให้ลบข้อมูลหรือถามว่าเก็บอะไร ตอบตามนี้และส่งต่อมอสสำหรับการลบ
`;
  addOutput('policies', 'kb/policies.md', text, [SRC.profile, SRC.cards]);
}

// ---- promotions.yaml ------------------------------------------------------------------------
{
  const text = `# generated by kb-build on ${builtAt} from ${sources.get(SRC.promotions).rel} — do not edit; run npm run kb:build\n` + promotionsText.replace(/\s+$/, '') + '\n';
  outputs.push({ name: 'promotions', file: 'promotions.yaml', text, sourcesAbs: [SRC.promotions] });
}

// ---------------------------------------------------------------------------------------------
// Pack-wide content lint (same regexes as tests/unit/kb.test.js, run here so a bad source fails early)
// ---------------------------------------------------------------------------------------------
const BANNED = [
  { re: /181/, why: 'old job count' },
  { re: /36 ราย/, why: 'old client count' },
  { re: /ลดคน/, why: 'headcount selling' },
  { re: /แทนพนักงาน/, why: 'headcount selling' },
  { re: /ประหยัดค่าแรง/, why: 'headcount selling' },
  { re: /@/, why: 'email / handle' },
  { re: /Sprint/, why: 'retired package model' },
  { re: /15,000 \+/, why: 'retired pricing' },
];
const lintErrors = [];
for (const o of outputs) {
  for (const b of BANNED) {
    const m = o.text.match(b.re);
    if (m) lintErrors.push(`${o.file}: banned "${m[0]}" (${b.why})`);
  }
}
// phone number only in about.contact-policy (and faq.talk-now, whose source answer is the same profile line verbatim)
const PHONE_ALLOWED = new Set(['about.contact-policy', 'faq.talk-now']);
const phoneDigits = String(profile.contact.phone_display).replace(/\D/g, '');
function sectionsOf(text) {
  const out = [];
  let cur = { id: '(preamble)', lines: [] };
  for (const line of text.split('\n')) {
    const m = line.match(ID_RE);
    if (m) {
      out.push(cur);
      cur = { id: m[2], lines: [] };
    } else cur.lines.push(line);
  }
  out.push(cur);
  return out;
}
for (const o of outputs) {
  for (const s of sectionsOf(o.text)) {
    if (PHONE_ALLOWED.has(s.id)) continue;
    if (s.lines.join('\n').replace(/[\s-]/g, '').includes(phoneDigits)) lintErrors.push(`${o.file} ${s.id}: phone number allowed only in ${[...PHONE_ALLOWED].join(', ')}`);
  }
}
// unique section ids across the pack
const allIds = new Map();
for (const o of outputs) {
  if (!o.file.endsWith('.md')) continue;
  for (const id of sectionIdsOf(o.text)) {
    if (allIds.has(id)) lintErrors.push(`duplicate section id ${id} in ${o.file} and ${allIds.get(id)}`);
    allIds.set(id, o.file);
  }
}
// FAQ section ids must survive verbatim
for (const it of faq.items.filter((i) => i.status !== 'rejected')) if (!allIds.has(it.id)) lintErrors.push(`FAQ id ${it.id} missing from faq.md`);
if (lintErrors.length) fail(`content lint:\n  ${lintErrors.join('\n  ')}`);

// ---------------------------------------------------------------------------------------------
// Write files + manifest
// ---------------------------------------------------------------------------------------------
fs.mkdirSync(path.join(OUT, 'kb'), { recursive: true });
const manifest = {
  built_at: builtAt,
  builder: 'scripts/kb-build.js',
  vault: VAULT.replace(/\\/g, '/'),
  project_dir: relToVault(PROJECT_DIR),
  faq_approved: faq.approved,
  faq_items: faq.items.filter((i) => i.status !== 'rejected').length,
  price_cross_check: { checked: checks.length, mismatches: mismatches.length },
  outputs: {},
};
for (const o of outputs) {
  const abs = path.join(OUT, o.file);
  fs.writeFileSync(abs, o.text, 'utf8');
  manifest.outputs[o.file] = {
    sources: o.sourcesAbs.map((a) => sources.get(a).rel),
    source_sha256: Object.fromEntries(o.sourcesAbs.map((a) => [sources.get(a).rel, sources.get(a).sha256])),
    sha256: crypto.createHash('sha256').update(o.text, 'utf8').digest('hex'),
    chars: o.text.length,
    sections: o.file.endsWith('.md') ? sectionIdsOf(o.text) : [],
    built_at: builtAt,
  };
}
fs.writeFileSync(path.join(OUT, 'kb-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
console.log(`kb-build: OK — ${outputs.length} files written to ${OUT}`);
console.log(`  vault: ${VAULT}\n  project-dir: ${PROJECT_DIR}\n  faq_approved: ${faq.approved} (${manifest.faq_items} items)`);
console.log(`  price cross-check: ${checks.length} values compared, 0 mismatches`);
for (const c of checks) console.log(`    ok  ${c.label} = ${c.cardValue}`);
for (const o of outputs) console.log(`  ${o.file.padEnd(18)} ${String(o.text.length).padStart(6)} chars  ${manifest.outputs[o.file].sections.length} sections`);
