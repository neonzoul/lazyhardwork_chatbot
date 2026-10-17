'use strict';
// Loader for the generated knowledge pack (knowledge/kb/*.md, promotions.yaml, kb-manifest.json).
// Engine, not content: nothing here knows what Lay says. Run `npm run kb:build` to regenerate the pack.
//
//   const { loadPack, activePromotions } = require('./brain/kb');
//   const pack = loadPack();                 // dir defaults to <repo>/knowledge
//   pack.files['offer.md']                   // whole file text (header comment included)
//   pack.sections.get('offer.A2.T1')         // { id, file, title, text, draft }
//   activePromotions(new Date(), pack.promotions)  // entries valid today

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SECTION_RE = /^(##{1,2}) ([a-z][a-z0-9-]*(?:\.[A-Za-z0-9-]+)+)\s*$/;

function parseSections(fileName, text) {
  const sections = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(SECTION_RE);
    if (m) {
      if (cur) sections.push(finish(cur));
      cur = { id: m[2], file: fileName, level: m[1].length, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) sections.push(finish(cur));
  return sections;
}

function finish(sec) {
  let lines = sec.lines;
  let draft = false;
  while (lines.length && lines[0].trim() === '') lines = lines.slice(1);
  if (lines[0] && /^<!--\s*status:\s*draft\s*-->$/.test(lines[0].trim())) {
    draft = true;
    lines = lines.slice(1);
  }
  const first = (lines[0] || '').trim();
  const bold = first.match(/^\*\*(.+?)\*\*$/);
  const title = bold ? bold[1] : sec.id;
  const text = lines.join('\n').trim();
  return { id: sec.id, file: sec.file, level: sec.level, title, text, draft };
}

function loadPack(dir = path.join(__dirname, '..', '..', 'knowledge')) {
  const kbDir = path.join(dir, 'kb');
  if (!fs.existsSync(kbDir)) throw new Error(`knowledge pack not found at ${kbDir} — run npm run kb:build`);
  const files = {};
  const sections = new Map();
  for (const name of fs.readdirSync(kbDir).filter((f) => f.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(kbDir, name), 'utf8');
    files[name] = text;
    for (const s of parseSections(name, text)) {
      if (sections.has(s.id)) throw new Error(`duplicate section id ${s.id} (${s.file} and ${sections.get(s.id).file})`);
      sections.set(s.id, s);
    }
  }
  const promoPath = path.join(dir, 'promotions.yaml');
  const promotions = fs.existsSync(promoPath) ? (yaml.load(fs.readFileSync(promoPath, 'utf8')) || {}).promotions || [] : [];
  const manifestPath = path.join(dir, 'kb-manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  return { dir, files, sections, promotions, manifest };
}

function toDay(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

// Entries whose [valid_from, valid_to] (inclusive, YYYY-MM-DD) contain `date`. Entries missing either
// bound never count as active: a discount Lay may quote has to be explicitly dated.
function activePromotions(date = new Date(), promotions) {
  const list = Array.isArray(promotions) ? promotions : loadPack().promotions;
  const day = toDay(date);
  return list.filter((p) => p && p.valid_from && p.valid_to && String(p.valid_from) <= day && day <= String(p.valid_to));
}

module.exports = { loadPack, activePromotions, parseSections, SECTION_RE };
