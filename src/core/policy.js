// Policy lint (design §1.2 step 7). The model proposes; this is where code disposes of what it may not say.
//
//   applyPolicy(response, { session, pack, allow, userText })
//     → { response, violations: [{rule, severity, detail, index?}], fixed: [string], severity }
//
//   severity (worst over all violations):
//     'fix'        — nothing wrong, or only mechanical repairs were applied (markdown stripped, trailing space
//                    trimmed, quick replies capped, unknown kb_refs dropped, non-verbatim problem nulled). Send it.
//     'regenerate' — content violation the code cannot repair (banned phrase, emoji policy, prose list, too long,
//                    price with no grounding ref, benefits without the caveat). Regenerate once, naming the rule.
//     'fallback'   — the response is unusable after fixes (fails validateResponse). Send fallbackReply().
//
//   fallbackReply({ reason, config }) → schema-valid honest fallback; the phone comes from config, never from here.
//
// `pack.sections` may be an array of {id, text}, an object {id: text | {text}}, or a Map — the KB loader is another
// implementer's; this module only needs ids and (for price grounding) the section text.

const lint = require('./lint');
const { emptyResponse, validateResponse } = require('../brain/schema');

const QUICK_REPLY_MAX = 4;
const QUICK_REPLY_LABEL_MAX = 20;
const PRICE_RE = /\d{1,3}(,\d{3})+\s*บาท/u;
const PRICE_REF_RE = /^offer\.|^faq\.[^\s]*price/u;
// The caveat frame (design §4 "Subsidies", brief §5.7). The FAQ draft names the agency instead of the generic word,
// so the agency names from the vault register count as the same frame.
const BENEFITS_CAVEAT_RE = /ตรวจสอบกับ\s*(?:หน่วยงาน|สสว|depa|กรมสรรพากร|ดีป้า)/iu;
const EMOJI_ALL_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]️?⃣|️/gu;

const strings = {
  fallback: (phone) => (phone
    ? `ตอนนี้ระบบขัดข้องชั่วคราวครับ ถ้ารีบ โทร ${phone} (มอส) ได้เลย`
    : 'ตอนนี้ระบบขัดข้องชั่วคราวครับ เดี๋ยวมอสเข้ามาดูให้นะครับ'),
  fallbackQuickReply: 'เรียก Lay',
};

function sectionEntries(pack) {
  const s = pack && pack.sections;
  if (!s) return null;
  if (s instanceof Map) return [...s.entries()].map(([id, v]) => [id, textOf(v)]);
  if (Array.isArray(s)) return s.filter((x) => x && x.id).map((x) => [x.id, textOf(x)]);
  if (typeof s === 'object') return Object.entries(s).map(([id, v]) => [id, textOf(v)]);
  return null;
}
function textOf(v) { return typeof v === 'string' ? v : (v && (v.text || v.body || '')) || ''; }

function normaliseWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function stripWs(s) { return String(s || '').replace(/\s+/g, ''); }

function toSet(allow) {
  if (!allow) return new Set();
  if (allow instanceof Set) return allow;
  if (Array.isArray(allow)) return new Set(allow);
  return new Set(Object.keys(allow).filter((k) => allow[k]));
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function applyPolicy(input, { session = {}, pack = null, allow, userText } = {}) {
  const allowSet = toSet(allow);
  const violations = [];
  const fixed = [];
  // one entry per rule per message; several lint errors of the same family merge into the detail
  const violate = (rule, severity, detail, index) => {
    const dup = violations.find((v) => v.rule === rule && v.index === index);
    if (dup) { dup.detail = `${dup.detail}; ${detail}`; return; }
    violations.push(index === undefined ? { rule, severity, detail } : { rule, severity, detail, index });
  };

  if (!input || typeof input !== 'object') {
    return { response: null, violations: [{ rule: 'not_an_object', severity: 'fallback', detail: 'response is not an object' }], fixed, severity: 'fallback' };
  }
  const r = clone(input);

  // --- texts: mechanical repairs, then lint ---
  (r.messages || []).forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'text' && typeof m.text === 'string') {
      let t = m.text;
      if (lint.hasMarkdown(t)) { t = lint.stripMarkdown(t); fixed.push(`messages[${i}]: markdown stripped`); }
      const trimmed = t.replace(/[ \t]+$/gmu, '').replace(/\s+$/u, '');
      if (trimmed !== t) { t = trimmed; fixed.push(`messages[${i}]: trailing whitespace trimmed`); }
      m.text = t;
      const rep = lint.lintText(t, { explain: !!m.explain, allow: allowSet });
      for (const e of rep.errors) violate(e.startsWith('banned:') ? e : e.replace(/:.*$/u, ''), 'regenerate', e, i);
    }
    if (m.type === 'card') {
      if (typeof m.alt === 'string' && lint.hasMarkdown(m.alt)) { m.alt = lint.stripMarkdown(m.alt); fixed.push(`messages[${i}]: markdown stripped from alt`); }
      if (m.data && typeof m.data.title === 'string' && lint.countEmoji(m.data.title) > 0) {
        m.data.title = m.data.title.replace(EMOJI_ALL_RE, '').replace(/\s{2,}/gu, ' ').trim();
        fixed.push(`messages[${i}]: emoji removed from card title`);
      }
      if (typeof m.alt === 'string') {
        const banned = lint.findBanned(m.alt, allowSet);
        for (const b of banned) violate(`banned:${b.id}`, 'regenerate', `alt: ${b.why}`, i);
      }
    }
  });

  // --- quick replies: cap the list, drop unsendable labels, never truncate a label ---
  if (Array.isArray(r.quick_replies)) {
    const before = r.quick_replies.length;
    const kept = r.quick_replies.filter((q) => typeof q === 'string' && q.trim() && [...q].length <= QUICK_REPLY_LABEL_MAX).map((q) => q.trim());
    if (kept.length !== before) fixed.push(`quick_replies: ${before - kept.length} empty or over-${QUICK_REPLY_LABEL_MAX}-char label(s) dropped`);
    if (kept.length > QUICK_REPLY_MAX) { fixed.push(`quick_replies: list cut from ${kept.length} to ${QUICK_REPLY_MAX}`); kept.length = QUICK_REPLY_MAX; }
    r.quick_replies = kept;
  } else { r.quick_replies = []; fixed.push('quick_replies: reset to []'); }

  // --- kb_refs: drop ids the pack does not know (hallucination tripwire) ---
  const entries = sectionEntries(pack);
  const known = entries ? new Map(entries) : null;
  if (!Array.isArray(r.kb_refs)) { r.kb_refs = []; fixed.push('kb_refs: reset to []'); }
  if (known) {
    const unknown = r.kb_refs.filter((id) => !known.has(id));
    if (unknown.length) {
      r.kb_refs = r.kb_refs.filter((id) => known.has(id));
      violate('unknown_kb_ref', 'fix', unknown.join(', '));
      fixed.push(`kb_refs: dropped unknown ${unknown.join(', ')}`);
    }
  }

  // --- price without grounding ---
  const texts = (r.messages || []).filter((m) => m && m.type === 'text' && typeof m.text === 'string').map((m) => m.text);
  const hasPrice = texts.some((t) => PRICE_RE.test(t));
  if (hasPrice) {
    const grounded = r.kb_refs.some((id) => PRICE_REF_RE.test(id) || (known && PRICE_RE.test(known.get(id) || '')));
    if (!grounded) violate('price_without_ref', 'regenerate', 'a price appears but no offer.* / faq.*price* ref (or priced section) is cited');
  }

  // --- benefits caveat ---
  const topics = Array.isArray(r.topics) ? r.topics : [];
  if (topics.includes('benefits') || r.intent === 'benefits') {
    const joined = texts.join('\n');
    if (!BENEFITS_CAVEAT_RE.test(joined)) violate('benefits_without_caveat', 'regenerate', 'benefits answer lacks the "ตรวจสอบกับหน่วยงาน" frame');
  }

  // --- problem_verbatim must be the customer's words ---
  if (r.lead_updates && typeof r.lead_updates === 'object' && r.lead_updates.problem_verbatim) {
    const last = userText !== undefined ? userText : (session.last_customer_text || session.last_user_text || '');
    const needle = normaliseWs(r.lead_updates.problem_verbatim);
    const hay = normaliseWs(last);
    const ok = needle && (hay.includes(needle) || stripWs(hay).includes(stripWs(needle)));
    if (!ok) { r.lead_updates.problem_verbatim = null; fixed.push('lead_updates.problem_verbatim: not in the customer text, nulled'); }
  }

  // --- severity ---
  const check = validateResponse(r);
  if (!check.ok) violate('invalid_after_policy', 'fallback', check.errors.join('; '));
  const rank = { fix: 0, regenerate: 1, fallback: 2 };
  const severity = violations.reduce((worst, v) => (rank[v.severity] > rank[worst] ? v.severity : worst), 'fix');
  return { response: r, violations, fixed, severity };
}

function fallbackReply({ reason = 'error', config } = {}) {
  const phone = config && config.contact && config.contact.phone;
  const response = emptyResponse({
    messages: [{ type: 'text', text: strings.fallback(phone), explain: false, template: null, alt: null, data: null }],
    quick_replies: [strings.fallbackQuickReply],
    topics: [],
    kb_refs: [],
    intent: 'unknown',
    action: null,
  });
  Object.defineProperty(response, '_meta', { value: { fallback: true, reason }, enumerable: false, writable: true, configurable: true });
  return response;
}

module.exports = { applyPolicy, fallbackReply, strings, PRICE_RE, PRICE_REF_RE, BENEFITS_CAVEAT_RE, QUICK_REPLY_MAX, QUICK_REPLY_LABEL_MAX };
