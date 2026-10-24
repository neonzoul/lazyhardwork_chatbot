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
    ? `ตอนนี้ระบบขัดข้องชั่วคราวครับ ถ้ารีบ โทร ${phone}${/มอส/.test(phone) ? '' : ' (มอส)'} ได้เลย`
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

// --- voice repairs found in the first-tester replay (2026-10-18) — mechanical, so they never cost a regenerate ---
// A trailing "if you have anything else, just tell me" sentence is the v2 cousin of v1's "ยินดีช่วยเสมอ".
const CLOSER_RE = /\s*(?:ถ้า|หาก)\s*(?:พี่|คุณ)?\s*(?:มี|ต้องการ|สนใจ|อยาก)[^\n]{0,110}?(?:บอก|ถาม|สอบถาม|ทัก|แจ้ง)(?:มา)?\s*ได้(?:เลย|ตลอด|เสมอ)?\s*(?:นะ)?\s*(?:ครับ|คะ|ค่ะ)?\s*[!.]?\s*$/u;
const CLOSER_2_RE = /\s*(?:ผมอยู่ที่นี่เพื่อช่วย[^\n]{0,20}|ยินดีช่วย[^\n]{0,20}|ถามมาเถอะ[^\n]{0,60}|(?:พี่)?อยากรู้อะไร[^\n]{0,20}(?:ถาม|บอก)(?:มา)?\s*ได้(?:เลย)?(?:นะ)?(?:ครับ)?|มีอะไรให้ช่วย(?:อีก|เพิ่มเติม)ไหม(?:ครับ)?|(?:ตอนนี้)?(?:มี|ยังมี)คำถาม(?:เพิ่มเติม)?(?:อะไร)?(?:อีก)?(?:ไหม|มั้ย|หรือเปล่า)(?:ครับ)?|(?:พี่)?อยากให้ผมช่วยอะไร(?:เพิ่มเติม|อีก)?ไหม(?:ครับ)?)\s*[!.?]?\s*$/u;
function stripClosers(t) {
  let out = t;
  for (let i = 0; i < 2; i++) { const n = out.replace(CLOSER_RE, '').replace(CLOSER_2_RE, ''); if (n === out) break; out = n; }
  if (out === t) return t;                        // untouched: leave whitespace to the trim step
  return out.trim() ? out.trim() : t;            // never empty a bubble
}
// Naming rule (head correction 19 Oct 15:20): studio work is "เรา", Lay itself is "ผม", "มอส" only at human steps
// (the 30-min call, firm quote / budget, handoff, Mos replying). "ผม" or "มอส" doing studio work becomes "เรา".
const MOS_AS_ME_RE = /(งานที่|ลูกค้าของ|ผลงานของ|โปรไฟล์(?:\s*Fastwork)?\s*ของ|ต่อหน้า)ผม|ผม(?=\s*(?:จะ\s*)?(?:ตั้งค่า|ติดตั้ง|สร้างระบบ|สร้างบอท|สร้างคลัง|ออกแบบ|วางระบบ|ทำระบบ|ดูแลระบบ|รับทำ|ทำบ่อย|ทำให้ลูกค้า))/gu;
const MOS_STUDIO_RE = /(งานที่|ลูกค้าของ|ผลงานของ|โปรไฟล์(?:\s*Fastwork)?\s*ของ|ระบบ(?:งาน)?ที่)มอส|มอส(?=\s*(?:จะ\s*)?(?:สามารถ\s*)?(?:ช่วย(?:ธุรกิจ|ทำ|สร้าง|ได้)|สร้าง|ทดสอบ|ออกแบบ|ติดตั้ง|ตั้งค่า|ดูแลระบบ|ส่งมอบ|สรุปปริมาณ|แก้และเพิ่ม|เลือก|ไม่ส่ง|ไม่ลด|ทำบ่อย|ทำให้|ทำระบบ|ใช้ทุกวัน|รับทำ))/gu;
// a message that is about a human step keeps "มอส"; studio work elsewhere becomes "เรา"
const HUMAN_STEP_RE = /(?<!ถ)นัด|โทร|คุยกับมอส|คุยเอง|ราคาเป๊ะ|ราคาจริง|ใบเสนอราคา|งบ(?:ประมาณ|มี|เท่า|แค่|จำกัด|ไม่|ของ|\s|$)|ส่งเรื่อง|ส่งต่อ|ส่งให้มอส|มอสตอบ|มอสดูให้|ยืนยัน/u;
// "ผมจะดูงานจริง" → "เราดูงานจริง": Lay does not do studio work (head review 20 Oct)
const ME_WILL_STUDIO_RE = /ผม(?:จะ)?(?=\s*(?:ดูงาน|ส่งแผน|ทำแผน|วางแผน|ประเมิน|ทดสอบ|สอนใช้|ส่งมอบ|ดูแลระบบ|ติดตั้ง|ตั้งค่า|ออกแบบ|สร้าง|วางระบบ|ทำระบบ|ดูให้|ทำให้))/gu;
function speakAsLay(t) {
  let out = t.replace(MOS_AS_ME_RE, (m, pre) => (pre ? `${pre}เรา` : 'เรา')).replace(ME_WILL_STUDIO_RE, 'เรา');
  if (!HUMAN_STEP_RE.test(out)) out = out.replace(MOS_STUDIO_RE, (m, pre) => (pre ? `${pre}เรา` : 'เรา'));
  return out;
}
// Empty praise before the point (head correction 19 Oct): "ล่องแก่งที่พัทลุงฟังดูน่าสนใจครับ", "การเทรดเป็นธุรกิจที่น่าสนใจครับ"
function dropFiller(t) {
  const n = t.replace(/^เข้าใจ(?:แล้ว)?ครับ[ \t]*/u, '').replace(/^[^\n]{0,40}?(?:ฟังดู(?:น่าสนใจ|ดี)|เป็น(?:ธุรกิจ|งาน)ที่น่าสนใจ)(?:มาก)?(?:เลย)?(?:ครับ|นะครับ)?[ \t]*/u, '')
    .replace(/(^|\s)[^\s]{0,40}?ฟังดู(?:น่าสนใจ|ดี)(?:มาก)?(?:เลย)?(?:ครับ|นะครับ)?[ \t]*/gu, '$1')
    .replace(/(^|\s)[^\s]{0,40}?เป็น(?:ธุรกิจ|งาน)ที่น่าสนใจ(?:มาก)?(?:ครับ)?[ \t]*/gu, '$1')
    .replace(/^[ \t]+/u, '');
  return n.trim() ? n : t;
}
// No "แน่นอน" guarantees (head review 19 Oct, demo café and "ผมช่วยได้แน่นอน").
function dropCertainty(t) {
  if (!/แน่นอน/u.test(t)) return t;
  return t.replace(/ได้\s*(?:อย่าง)?แน่นอน/gu, 'ได้').replace(/^แน่นอน(?:ครับ|ค่ะ)?[ \t]*/u, 'ได้ครับ ').replace(/[ \t]*(?:อย่าง)?แน่นอน/gu, '').replace(/[ \t]{2,}/gu, ' ');
}
// Topics LazyHardWork does not take (head review 19 Oct): trading bots, strategies, indicators, backtests, signals.
const OUT_OF_SCOPE_RE = /เทรด|trading|back\s*-?\s*test|แบ็ค?เทส|อินดี้|อินดิเคเตอร์|indicator|บอทเทรด|EA\s*(?:เทรด|forex)|forex|ฟอเร็กซ์|สัญญาณ(?:ซื้อ|ขาย|เทรด)|กราฟเทคนิค/iu;
function mergeShortPair(r) {
  const ms = r && Array.isArray(r.messages) ? r.messages : [];
  if (ms.length !== 2 || !ms.every((m) => m && m.type === 'text' && typeof m.text === 'string' && !m.explain)) return false;
  const joined = `${ms[0].text.trim()}\n${ms[1].text.trim()}`;
  if (joined.length > 220 || joined.split('\n').length > 3) return false;
  r.messages = [{ ...ms[0], text: joined }];
  return true;
}
function stripExclaim(t) { return t.replace(/!+/gu, '').replace(/\s+([?.])/gu, '$1'); }
function dedupePriceSentence(t) {
  if ((t.match(/ราคาเริ่มต้น/gu) || []).length < 2) return t;
  return t.replace(/\s*(?:ทุกตัวเป็น|ราคาที่เห็นคือ|ทุกแพ็กเป็น)ราคาเริ่มต้น\s*/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
}

// Style-only rules: when the model breaks only these twice, the reply is repaired by code instead of sending the
// "system error" line — that line is for real failures (honesty). Banned content is never salvaged.
// two_questions is style-only: regenerate once, and if the second answer still asks two, it goes out (salvaged, logged) —
// never blocked (Head GTM 22 Oct)
// "Not worth hiring us yet": said outright, or as "use LINE's free auto-reply first and come back later" (Head GTM round-2
// ruling, 23 Oct). Shared with flows/endings so no code-added offer card lands under it.
const NOT_WORTH_RE = /ยังไม่(?:ต้อง)?จ้าง|ไม่คุ้ม(?:ที่จะ)?จ้าง|อาจไม่คุ้ม|(?:ข้อความ)?ตอบอัตโนมัติ(?:ฟรี)?ของ\s*LINE\s*(?:OA\s*)?(?:เอง\s*)?ก่อน|ฟรีของ\s*LINE\s*ก่อน|ค่อยกลับมาคุย|รอให้แชท(?:เข้า)?(?:มา)?(?:มาก|เยอะ)/u;
// Claimed actions, completed and done by "us" (CE review 24 Oct: narrow, so describing what a bot does is not a claim):
// "ได้ทำการจองคิว… แล้ว / เรียบร้อย", "จองคิว… ให้(พี่) … เรียบร้อย(แล้ว)", "จองให้แล้ว", "การจองของพี่สำเร็จแล้ว / ยืนยันแล้ว".
// Checked per clause; a clause with a condition or a future (เมื่อ · หลัง · ถ้า · หาก · พอ · จะ) is a description, not a claim.
// "แล้ว" counts only at the end of a clause ("…ให้แล้วครับ"), not as "and then" ("…ให้ลูกค้ากดยืนยัน แล้วส่งต่อ");
// "คำสั่ง" (a prompt) is not "สั่ง" (an order)
const CLAIMED_ACTION_RE = /(?:ได้|ทำการ)\s*(?:ทำการ\s*)?(?:จอง|(?<!คำ)สั่ง|ยืนยัน|บันทึก)[^\n]{0,40}(?:เรียบร้อย|แล้ว(?=\s*(?:ครับ|ค่ะ|คะ|นะ|$|[.!?])))|(?:จอง|(?<!คำ)สั่ง|ยืนยัน|บันทึก)(?:คิว|ห้อง|นัด|ออเดอร์|การจอง|การสั่ง)?[^\n]{0,30}ให้(?:พี่|คุณ|ลูกค้า)?[^\n]{0,30}(?:เรียบร้อย|แล้ว(?=\s*(?:ครับ|ค่ะ|คะ|นะ|$|[.!?])))|(?:การจอง|การสั่ง|ออเดอร์|คิว|นัด)(?:ของ(?:พี่|คุณ))?[^\n]{0,10}(?:สำเร็จแล้ว|ยืนยันแล้ว|เรียบร้อยแล้ว)/u;
const CLAIM_CONDITION_RE = /(?:^|\s)(?:เมื่อ|หลัง|ถ้า|หาก|พอ)|จะ/u;
const WAITS_FOR_PERSON_RE = /รอ\s*(?:คน|เจ้าของร้าน|แอดมิน|มอส|ทางร้าน|พนักงาน)?\s*(?:ของร้าน)?\s*(?:กด|ตรวจ(?:และ)?)?\s*ยืนยัน/u;
function claimsAction(text) {
  return String(text || '').split(/\n+|(?<=ครับ|ค่ะ|คะ)\s+|\s+(?=แต่|และ)/u)
    .some((c) => CLAIMED_ACTION_RE.test(c) && !CLAIM_CONDITION_RE.test(c) && !WAITS_FOR_PERSON_RE.test(c));
}
const STYLE_RULES = new Set(['prose_list', 'too_long', 'emoji', 'markdown', 'two_questions']);
// One question per bubble: split into clauses at ครับ/ค่ะ + space, และ, a question mark or a line break, and count the
// clauses that ask (ไหม · กี่ · อะไร · ยังไง · หรือเปล่า · ?). "มีคนตอบแชทกี่คนครับ และแชทเข้าวันละกี่ข้อความครับ" → 2.
const QUESTION_MARK_RE = /ไหม|กี่|อะไร|ยังไง|อย่างไร|หรือเปล่า|หรือยัง|[?？]/u;
function countQuestionClauses(text) {
  return String(text || '').split(/(?:ครับ|ค่ะ|คะ)\s+|\s+และ\s*|\s*[?？]\s*|\n+/u)
    .map((c) => c.trim()).filter((c) => c && QUESTION_MARK_RE.test(c)).length;
}
function isStyleOnly(violations) { return violations.length > 0 && violations.every((v) => v.severity === 'fix' || STYLE_RULES.has(v.rule)); }
function splitLong(text, max = 220) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.4) cut = max;
    parts.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
function salvage(response) {
  const r = clone(response);
  const out = [];
  for (const m of r.messages || []) {
    if (m.type !== 'text') { out.push(m); continue; }
    let t = lint.stripMarkdown(m.text || '');
    if (!m.explain) t = t.replace(EMOJI_ALL_RE, '');
    t = t.replace(/^\s*(?:[1-9][.)]|[-•●▪]|ก[.)]|ข[.)])\s*/gmu, '').replace(/\n{2,}/gu, '\n');   // list markers off
    for (const piece of splitLong(t)) out.push({ ...m, text: piece });
  }
  const cards = out.filter((m) => m.type === 'card');
  const texts = out.filter((m) => m.type === 'text').slice(0, 3 - cards.length);
  r.messages = [...texts, ...cards].slice(0, 3);
  return r;
}

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
      const voiced = dropFiller(dropCertainty(speakAsLay(dedupePriceSentence(stripExclaim(stripClosers(t))))));
      if (voiced !== t) { t = voiced; fixed.push(`messages[${i}]: stock closer / "!" / repeated price phrase removed / speaker or "แน่นอน" fixed`); }
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
  // the GEO buttons belong to a findability ask only (real-model run 23 Oct: the flower shop got "สนใจ Review")
  {
    const GEO_BUTTONS = new Set(['สนใจ Review', 'คุยฟรีก่อน']);
    // the customer's own words decide (82: the model pitched the Review "ให้ถูกค้นเจอ" to a shop asking about more sales)
    const askedFindability = (session && session.geo_asked) || /ค้นเจอ|แนะนำร้าน|ถูกแนะนำ|รู้จักร้าน|ChatGPT|Google|Gemini|\bAI\b|เอไอ|\bSEO\b|\bGEO\b/iu.test(userText || '');
    if (!askedFindability) {
      if (r.quick_replies.some((q) => GEO_BUTTONS.has(q))) {
        r.quick_replies = r.quick_replies.filter((q) => !GEO_BUTTONS.has(q));
        fixed.push('quick_replies: GEO buttons dropped for a lead who did not ask about being found');
      }
      (r.messages || []).forEach((m) => {
        if (!m || m.type !== 'text' || typeof m.text !== 'string' || !/ถูกค้นเจอ|ค้นเจอมากขึ้น/u.test(m.text)) return;
        const n = m.text.split('\n').filter((line) => !/ถูกค้นเจอ|ค้นเจอมากขึ้น/u.test(line)).join('\n').trim();
        if (n) { m.text = n; fixed.push('findability pitch removed: the customer did not ask about being found'); }
      });
    }
  }

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

  // --- banter / profanity: one short human line, no follow-up question, no buttons (brief §2, §3.2) ---
  // Enforced by code: in the 18 Oct replay the model kept adding "ตอนนี้พี่สนใจบริการไหน…" after a joke or a swear word.
  if ((r.intent === 'banter' || r.intent === 'abuse') && !r.action) {
    const firstText = (r.messages || []).find((m) => m && m.type === 'text');
    if (firstText && ((r.messages || []).length > 1 || (r.quick_replies || []).length)) {
      r.messages = [firstText];
      r.quick_replies = [];
      fixed.push('banter: reduced to one line, no follow-up question or buttons');
    }
  }

  // --- the same closing question as last turn is dropped when other content remains (replay 18 Oct: Lay asked
  // "ตอนนี้พี่สนใจบริการไหน…" on four turns in a row). Similarity = character-bigram overlap, Thai-safe. ---
  if (session && session.last_lay_question && (r.messages || []).length > 1) {
    const norm = (t) => String(t || '').replace(/ครับ|คะ|ค่ะ|พี่|นะ|ตอนนี้|[\s?!.]/gu, '');
    const grams = (t) => { const a = [...norm(t)]; const set = new Set(); for (let k = 0; k < a.length - 1; k++) set.add(a[k] + a[k + 1]); return set; };
    const dice = (x, y) => { const A = grams(x); const B = grams(y); if (!A.size || !B.size) return 0; let n = 0; for (const g of A) if (B.has(g)) n++; return (2 * n) / (A.size + B.size); };
    const isQuestion = (t) => /(?:ไหน|ไหม|มั้ย|อะไร|ยังไง|เท่าไหร่|เท่าไร)\s*(?:อยู่)?\s*(?:ครับ|คะ|ค่ะ)?\s*\??\s*$/u.test(String(t || '').trim()) || /จะได้เล่าให้ตรง/u.test(String(t || ''));
    const WHICH_ONE_RE = /(?:สนใจ|อยากให้ช่วย|ต้องการ|อยากได้)[^\n]{0,15}(?:บริการ|งาน|เรื่อง|แพ็ก)\s*(?:ไหน|อะไร)/u;
    const before = r.messages.length;
    r.messages = r.messages.filter((m) => !(m && m.type === 'text' && isQuestion(m.text) && (dice(m.text, session.last_lay_question) >= 0.4 || (WHICH_ONE_RE.test(m.text) && WHICH_ONE_RE.test(session.last_lay_question)))));
    if (!r.messages.length) r.messages = clone(input).messages.slice(0, 1);
    if (r.messages.length !== before) fixed.push('messages: question repeated from last turn dropped');
  }

  // --- a bubble that is nothing but a stock closer is dropped when other content remains (replay 18 Oct) ---
  const closerOnly = (t) => typeof t === 'string' && t.replace(CLOSER_RE, '').replace(CLOSER_2_RE, '').trim() === '';
  if ((r.messages || []).length > 1) {
    const before = r.messages.length;
    r.messages = r.messages.filter((m) => !(m && m.type === 'text' && closerOnly(m.text)));
    if (!r.messages.length) r.messages = clone(input).messages.slice(0, 1);
    if (r.messages.length !== before) fixed.push(`messages: ${before - r.messages.length} closer-only bubble(s) dropped`);
  }

  // --- one question per bubble (Head GTM 22 Oct) ---
  (r.messages || []).forEach((m, i) => {
    if (m && m.type === 'text' && countQuestionClauses(m.text) >= 2) violate('two_questions', 'regenerate', 'ask ONE question per message — keep the most useful one', i);
  });
  // --- speak the customer's domain (Head GTM 22 Oct): shop-only examples for a business that does not sell goods ---
  {
    const biz = session && session.homework && session.homework.business ? String(session.homework.business) : '';
    const sellsGoods = /ร้าน|ขาย|ออนไลน์|shop|สินค้า|ค้าส่ง|ค้าปลีก|ออเดอร์|ส่งของ/iu.test(biz);
    const shopOnly = /สต็อก|ค่าส่ง|ปิดการขาย/u;
    // fixed in place, never blocked: a reply replaced by "รับทราบครับ" is worse than a shop word (real-model run 22 Oct)
    if (biz && !sellsGoods) {
      (r.messages || []).forEach((m, i) => {
        if (!m || m.type !== 'text' || !shopOnly.test(m.text || '')) return;
        m.text = m.text.replace(/ไป\s*ปิดการขาย/gu, 'ไปดูแลลูกค้า').replace(/ปิดการขาย/gu, 'ดูแลลูกค้า')
          .replace(/[ \t]*(?:สต็อก(?:สินค้า)?|ค่าส่ง)(?=[ \t]|$)/gu, '').replace(/[ \t]{2,}/gu, ' ');
        fixed.push(`messages[${i}]: shop-only examples removed for ${biz.slice(0, 40)}`);
      });
    }
  }
  // --- no paid offer for a lead that is not ready or not a fit (head review 20 Oct, pre-launch burger) ---
  const bubbleTexts = (r.messages || []).filter((m) => m && m.type === 'text' && typeof m.text === 'string').map((m) => m.text);
  if (session && (session.too_early || session.not_fit) && r.intent !== 'pricing' && bubbleTexts.some((t) => /Business Review|4,900|แพ็ก(?:เริ่มต้น|ลองก่อน|นี้)|ราคาเริ่มต้น/u.test(t))) {
    violate('paid_offer_unfit', 'regenerate', 'the lead is pre-launch or out of scope: no package, price or AI Business Review — say when we would help and invite them back');
  }
  // --- screening questions (people / where the data lives / who maintains) only after a matched in-scope symptom ---
  {
    let named = false;
    try { named = !!(userText && require('../flows/fit').symptomFromText(userText)); } catch { /* absent */ }
    const confirmed = !!(session && session.draft && session.draft.confirmed) || named;
    const SCREEN_RE = /กี่คน|อยู่ในเครื่องมือ(?:อะไร|ไหน)|เก็บไว้ที่ไหน|ใคร(?:เป็นคน)?ดูแล(?:ระบบ)?(?:ได้)?ไหม|ใครดูแลต่อ/u;
    // removed in place, never blocked: two blocked rounds ended in "รับทราบครับ" for a customer who had named the
    // problem in their own words (real-model run 23 Oct, bakery). Only when nothing else is left is it regenerated.
    if (!confirmed && bubbleTexts.some((t) => SCREEN_RE.test(t))) {
      const dropScreening = (t) => t.split('\n').map((line) => (SCREEN_RE.test(line)
        ? line.split(/(?<=(?:ครับ|ค่ะ|คะ|[?？]))\s+/u).filter((c) => !SCREEN_RE.test(c)).join(' ')
        : line)).filter((line) => line.trim()).join('\n').trim();
      const kept = [];
      (r.messages || []).forEach((m) => {
        if (!m || m.type !== 'text' || typeof m.text !== 'string' || !SCREEN_RE.test(m.text)) { kept.push(m); return; }
        const n = dropScreening(m.text);
        if (n) kept.push({ ...m, text: n });
      });
      if (kept.some((m) => m && m.type === 'text')) {
        r.messages = kept;
        fixed.push('screening question before a named problem removed');
      } else {
        violate('screening_before_symptom', 'regenerate', 'screening questions (how many people / where the data lives / who maintains) come only after the customer named a problem we solve; ask which work takes the most time instead');
      }
    }
  }
  // --- symptom before card (head correction 19 Oct): no "ตรงกับงานที่เราทำ" until the customer named the problem ---
  let namedNow = false;
  try { namedNow = !!(userText && require('../flows/fit').symptomFromText(userText)); } catch { /* fit module absent */ }
  if (!(session && session.draft && session.draft.confirmed) && !namedNow) {
    for (const m of r.messages || []) {
      if (!m || m.type !== 'text' || typeof m.text !== 'string') continue;
      const n = m.text.replace(/[^\s\n]{0,40}?\s*(?:แบบนี้)?\s*ตรงกับงานที่(?:เรา|ผม|มอส)ทำ(?:บ่อย(?:สุด|ที่สุด)?)?(?:ครับ)?[ \t]*/u, '').trim();
      if (n && n !== m.text) { m.text = n; fixed.push('fit claim before the customer named a problem removed'); }
    }
  }
  // --- "not worth hiring us yet" and a package card in the same reply contradict each other: the card goes (real-model
  // run 23 Oct, flower shop; Head GTM ruling R2) ---
  if ((r.messages || []).some((m) => m && m.type === 'card') && bubbleTexts.some((t) => NOT_WORTH_RE.test(t))) {
    r.messages = r.messages.filter((m) => !(m && m.type === 'card'));
    fixed.push('package card dropped: the reply says hiring us is not worth it yet');
  }
  // --- ...and no price or package name either: the free advice stands alone unless the customer asked what paid options
  // exist (Head GTM round-2 ruling, 23 Oct, flower shop: "แต่ถ้าแชทเข้า 10 ข้อความ… แพ็กลองก่อน" with its price) ---
  const PAID_TALK_RE = /\d{1,3}(?:,\d{3})+\s*บาท|฿\s*\d|แพ็ก|AI Business Review|AI Workspace|AI Chatbot|AI Agent|ระบบงานภายใน|ราคาเริ่มต้น/u;
  const ASKED_PAID_RE = /ราคา|แพ็ก|เท่าไหร่|เท่าไร|ค่าใช้จ่าย|เสียเงิน|ตัวเลือก|บริการอะไร/u;
  if (bubbleTexts.some((t) => NOT_WORTH_RE.test(t)) && !ASKED_PAID_RE.test(userText || '')) {
    let cut = false;
    (r.messages || []).forEach((m) => {
      if (!m || m.type !== 'text' || typeof m.text !== 'string' || !PAID_TALK_RE.test(m.text)) return;
      const n = m.text.split('\n').map((line) => line.split(/(?<=ครับ|ค่ะ|คะ|[.?？])\s+|\s+(?=แต่(?:ถ้า|หาก)?|ถ้า|หาก)/u)
        .filter((c) => !PAID_TALK_RE.test(c)).join(' ').trim()).filter(Boolean).join('\n');
      if (n !== m.text) { m.text = n; cut = true; }
    });
    if (cut) {
      r.messages = r.messages.filter((m) => !(m && m.type === 'text' && !String(m.text || '').trim()));
      r.quick_replies = (r.quick_replies || []).filter((q) => !PAID_TALK_RE.test(q) && !/ราคา/u.test(q));
      fixed.push('price / package talk removed from a "not worth it yet" reply');
    }
  }
  // --- one small start, never a menu of packages (Head GTM round-2 ruling, 23 Oct, bakery: "อยากเริ่มจากแพ็กไหนครับ เช่น
  // AI Agent หรือ AI Chatbot") — a line that asks the customer to choose between packages is dropped in place ---
  {
    const PKG = 'AI\\s*Agent|AI\\s*Chatbot|แชทบอท|ระบบงานภายใน|AI\\s*Workspace|(?:AI\\s*)?Business\\s*Review|ออโตเมชัน';
    const MENU_RE = new RegExp(`(?:${PKG})[^\\n]{0,25}หรือ[^\\n]{0,10}(?:${PKG})[^\\n]{0,15}(?:[?？]|ครับ\\s*$|ดี(?:ครับ)?\\s*$)|(?:แพ็ก|บริการ)ไหน[^\\n]{0,30}(?:${PKG})[^\\n]{0,20}หรือ`, 'iu');
    let dropped = false;
    (r.messages || []).forEach((m) => {
      if (!m || m.type !== 'text' || typeof m.text !== 'string' || !MENU_RE.test(m.text)) return;
      const n = m.text.split('\n').filter((line) => !MENU_RE.test(line)).join('\n').trim();
      if (n) { m.text = n; dropped = true; }
    });
    if (dropped) {
      const pkgButton = new RegExp(`^(?:${PKG})$`, 'iu');
      r.quick_replies = (r.quick_replies || []).filter((q) => !pkgButton.test(q));
      fixed.push('package menu question removed: recommend one small start');
    }
  }
  // --- one message per turn (head correction 19 Oct): a short reply split in two bubbles goes out as one ---
  if (mergeShortPair(r)) fixed.push('messages: two short bubbles merged into one');

  // --- price without grounding ---
  const texts = (r.messages || []).filter((m) => m && m.type === 'text' && typeof m.text === 'string').map((m) => m.text);

  // --- a promise about Mos with no handoff behind it: the customer would wait for someone nobody told (brief §6) ---
  const UNBACKED_PROMISE_RE = /(?:คุณ\s*)?มอส\s*(?:จะ|จะได้)\s*(?:เข้ามา|ติดต่อ|โทร|ตอบ)|เดี๋ยว\s*(?:คุณ\s*)?มอส\s*(?:จะ)?\s*(?:เข้ามา|ติดต่อ|โทร|ตอบ)|ส่งเรื่อง(?:ให้|ถึง)\s*(?:คุณ\s*)?มอส(?:แล้ว|ให้แล้ว)/u;
  if (!/^handoff_/.test(String(r.action || '')) && texts.some((t) => UNBACKED_PROMISE_RE.test(t) && !/(?:ถ้า|หาก|อยาก|ต้องการ|กด|บอก)[^\n]{0,20}มอส/u.test(t))) {
    violate('unbacked_promise', 'regenerate', 'says Mos will come/reply without a handoff action — only code may promise that, after the notify succeeded');
  }
  // --- an action Lay did not perform is never claimed (Mos's test 24 Oct: "บอทได้ทำการจองคิว… เรียบร้อยแล้วครับ" outside
  // the sample shop). Bookings, orders and confirmations are done only by code paths, which do not pass through here.
  // A line that says it still waits for a person ("รอ…ยืนยัน") is not a claim. ---
  // (allowed only where code says Mos already confirmed: the same 'booking_confirmed' allow as the lint)
  if (!allowSet.has('booking_confirmed') && texts.some((t) => claimsAction(t))) {
    if (/^booking_/.test(String(r.action || ''))) {
      // the booking flow runs by code right after this reply: the claim is removed in place, the flow says what is true
      r.messages = (r.messages || []).map((m) => (m && m.type === 'text' && claimsAction(m.text)
        ? { ...m, text: String(m.text).split(/(?<=ครับ|ค่ะ|คะ)\s+|\n+/u).filter((c) => !claimsAction(c)).join(' ').trim() }
        : m)).filter((m) => !(m && m.type === 'text' && !String(m.text || '').trim()));
      if (!r.messages.length) r.messages = [{ type: 'text', text: 'ได้ครับ', explain: false, template: null, alt: null, data: null }];
      fixed.push('claimed booking removed: the booking flow follows');
    } else {
      violate('claimed_action', 'regenerate', 'the reply says a booking / order / confirmation is done — Lay cannot do that; say what the customer can do next instead');
    }
  }
  // --- out of scope: once the customer asked about something LazyHardWork does not do, never tailor an offer to it ---
  if (session && session.out_of_scope && texts.some((t) => OUT_OF_SCOPE_RE.test(t))) {
    violate('out_of_scope_offer', 'regenerate', 'the reply talks about the out-of-scope topic (e.g. trading) as if it were a service — answer with the real services only');
  }
  const hasPrice = texts.some((t) => PRICE_RE.test(t));
  if (hasPrice) {
    const grounded = r.kb_refs.some((id) => PRICE_REF_RE.test(id) || (known && PRICE_RE.test(known.get(id) || '')));
    if (!grounded) violate('price_without_ref', 'regenerate', 'a price appears but no offer.* / faq.*price* ref (or priced section) is cited');
  }

  // --- benefits caveat ---
  const topics = Array.isArray(r.topics) ? r.topics : [];
  // only a reply that actually talks about a programme needs the caveat; a stray 'benefits' tag is dropped (replay 18 Oct)
  const SUBSIDY_WORDS_RE = /สิทธิ์|สิทธิ|สสว|depa|ดีป้า|อุดหนุน|โครงการรัฐ|ลดหย่อน|ภาษี|BDS|AI ?Pass|AiPASS/iu;
  if ((topics.includes('benefits') || r.intent === 'benefits') && !SUBSIDY_WORDS_RE.test(texts.join('\n'))) {
    r.topics = topics.filter((t) => t !== 'benefits');
    fixed.push('topics: stray benefits tag dropped');
  }
  if ((r.topics || []).includes('benefits') || (r.intent === 'benefits' && SUBSIDY_WORDS_RE.test(texts.join('\n')))) {
    const joined = texts.join('\n');
    if (!BENEFITS_CAVEAT_RE.test(joined)) {
      // repaired by code (replay 18 Oct: two misses ended in the system-error line): the caveat is a fixed sentence
      const last = [...(r.messages || [])].reverse().find((m) => m && m.type === 'text' && typeof m.text === 'string');
      if (last) { last.text = `${last.text.trim()}\nอาจใช้สิทธิ์ได้ ต้องตรวจสอบกับหน่วยงานก่อนครับ`; fixed.push('benefits caveat appended'); violate('benefits_without_caveat', 'fix', 'caveat appended by code'); }
      else violate('benefits_without_caveat', 'regenerate', 'benefits answer lacks the "ตรวจสอบกับหน่วยงาน" frame');
    }
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
  const phone = config && config.contact && (config.contact.phoneDisplay || config.contact.phone);
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

module.exports = { NOT_WORTH_RE, CLAIMED_ACTION_RE, WAITS_FOR_PERSON_RE, claimsAction, countQuestionClauses, speakAsLay, dropFiller, mergeShortPair, dropCertainty, OUT_OF_SCOPE_RE, salvage, isStyleOnly, stripClosers, STYLE_RULES, applyPolicy, fallbackReply, strings, PRICE_RE, PRICE_REF_RE, BENEFITS_CAVEAT_RE, QUICK_REPLY_MAX, QUICK_REPLY_LABEL_MAX };
