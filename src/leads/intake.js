// Lead intake (design §9, brief §6). Pure functions over the session row — no store, no network.
//
//   buildLeadRow({ session, existing, now, status? })  → the row to hand to store.leads.upsert()
//   qualify(session)                                   → { qualification: 'cold'|'warm'|'hot', reasons[] }
//   waveGroup(session, customerTexts?)                 → 'W1'|'W2'|'W3'|null  (only from the customer's own words)
//   redactForDiscord(lead)                             → deep copy with contact and phone/email-like strings removed
//   leadSummaryTh(lead, { reason? })                   → Thai text for the #leads thread (already redacted)
//
// Status order (never regresses): new → qualified → booking_pending → booked → offer_shown → closed.
// `new → qualified` is decided here (business + problem_verbatim known). booking_pending / booked / offer_shown
// are set by the flows through the `status` argument; buildLeadRow keeps whichever rank is higher.

const { HOMEWORK_FIELDS } = require('../core/session');

const STATUS_ORDER = ['new', 'qualified', 'booking_pending', 'booked', 'offer_shown', 'closed'];
const SIDE_STATUSES = ['not_fit', 'nurture'];
// side statuses (not on the ladder): not_fit = asked for something we do not do; nurture = not ready yet (pre-launch),
// come back later (head review 20 Oct). nurture wins over not_fit; a booking in progress wins over both.
const rank = (s) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? 0 : i; };

/** Highest of the given statuses (unknown values count as `new`). */
function advanceStatus(...statuses) {
  return statuses.filter(Boolean).reduce((best, s) => (rank(s) > rank(best) ? s : best), 'new');
}

function buildLeadRow({ session, existing = null, now, status = null }) {
  if (!session || !session.user_id) throw new Error('buildLeadRow: session with user_id required');
  const at = (now || new Date()).toISOString();
  const homework = { ...((existing && existing.homework) || {}), ...(session.homework || {}) };
  // qualified needs a matched card (head review 19 Oct: a trading lead with business + problem but no service is not_fit)
  const card = session.draft?.card || existing?.card_id || null;
  const derived = homework.business && homework.problem_verbatim && card ? 'qualified' : 'new';
  const raised = advanceStatus(existing?.status, derived, status);
  const notFit = session.not_fit && !card && rank(raised) < rank('booking_pending');
  const nurture = (session.too_early || session.nurture) && rank(raised) < rank('booking_pending');
  const words = session.homework?.problem_verbatim || existing?.customer_words_th || null;
  return {
    ...(existing || {}),
    user_id: session.user_id,
    status: nurture ? 'nurture' : notFit ? 'not_fit' : raised,
    card_id: session.draft?.card || existing?.card_id || null,
    symptom: session.draft?.symptom || existing?.symptom || null,
    homework,
    customer_words_th: words,
    wave_group: waveGroup({ homework }) || existing?.wave_group || null,
    source: existing?.source || 'line_oa',
    display_name: session.display_name || existing?.display_name || null,
    created_at: existing?.created_at || at,
    updated_at: at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Qualification. Points: business 1, problem 1, each other homework field 0.5, urgent words +2 (not urgent −1),
// preferred_contact +1, a booking in progress +3.  hot ≥ 5 · warm ≥ 2 (business + problem = qualified) · else cold.
const URGENT_RE = /ด่วน|รีบ|เร็วที่สุด|ทันที|สัปดาห์นี้|อาทิตย์นี้|เดือนนี้|ภายใน\s*\d|asap|urgent|this week|this month/iu;
const NOT_URGENT_RE = /ยังไม่รีบ|ไม่รีบ|แค่ดู|ดูก่อน|ศึกษา|ไว้ก่อน|ปีหน้า|เฉยๆ|no rush|just looking|next year/iu;

function qualify(session) {
  const h = (session && session.homework) || {};
  const reasons = [];
  let score = 0;
  if (h.business) { score += 1; reasons.push('business known'); }
  if (h.problem_verbatim) { score += 1; reasons.push('problem in the customer\'s words'); }
  const others = HOMEWORK_FIELDS.filter((f) => f !== 'business' && f !== 'problem_verbatim' && h[f]);
  if (others.length) { score += 0.5 * others.length; reasons.push(`${others.length} more homework fields`); }
  const urgency = String(h.urgency || '');
  if (urgency && URGENT_RE.test(urgency) && !NOT_URGENT_RE.test(urgency)) { score += 2; reasons.push('urgent'); }
  else if (urgency && NOT_URGENT_RE.test(urgency)) { score -= 1; reasons.push('not urgent'); }
  if (h.preferred_contact) { score += 1; reasons.push('preferred contact given'); }
  if (session && (session.booking_step || (session.draft && session.draft.booking))) { score += 3; reasons.push('booking in progress'); }
  const qualification = score >= 5 ? 'hot' : score >= 2 ? 'warm' : 'cold';
  if (!reasons.length) reasons.push('no homework yet');
  return { qualification, reasons, score };
}

// ---------------------------------------------------------------------------------------------------------------
// Wave group — ONLY from the customer's own words (homework values the model copied, plus any raw customer texts
// passed in). Never from the card, the symptom or a guess.  W3 never used AI · W2 has a seat/subscription and no
// system · W1 used AI but no results · else null.
const NEVER_USED_RE = /ไม่เคยใช้\s*(?:ai|เอไอ|chatgpt|gemini|claude|copilot)|ยังไม่เคย(?:ใช้|ลอง)\s*(?:ai|เอไอ)|ไม่เคยลอง\s*(?:ai|เอไอ)|never used\s*ai/iu;
const SEAT_RE = /ai\s*pass|gemini\s*(?:enterprise|advanced|pro)?|chatgpt\s*(?:plus|team|enterprise)?|copilot|claude\s*(?:pro|team)?|m365|microsoft\s*365|(?:สมัคร|จ่าย|เสียเงิน|ได้มา|มี).{0,12}(?:ai|เอไอ|subscription|แพ็กเกจ|แพ็คเกจ|รายเดือน|ซีท|seat|license|ไลเซนส์)/iu;
const NO_SYSTEM_RE = /ไม่รู้จะใช้(?:ยังไง|กับงาน|ทำอะไร)|ยังไม่ได้ใช้(?:กับงาน|จริง)|ไม่มีระบบ|ไม่ได้เอามาใช้|ยังไม่ได้ตั้ง|ใช้ไม่เป็น|ไม่รู้จะเริ่ม|no system|don't know how to use|haven't set/iu;
const USED_RE = /(?:เคย|ลอง|ใช้)\s*(?:ใช้\s*)?(?:ai|เอไอ|chatgpt|gemini|claude|copilot)|used\s*(?:ai|chatgpt)|tried\s*(?:ai|chatgpt)/iu;
const NO_RESULT_RE = /ไม่ได้อะไร|ไม่เห็นผล|ไม่รู้ว่าได้อะไร|ไม่ช่วย|ไม่เวิร์[คก]|ไม่คุ้ม|ไม่ได้ผล|ไม่ต่างจากเดิม|เสียเวลา|no result|didn't help|not working/iu;

function customerWords(session, customerTexts = []) {
  const h = (session && session.homework) || {};
  const parts = [h.problem_verbatim, h.where_work_lives, h.came_from, h.maintainer, ...(Array.isArray(customerTexts) ? customerTexts : [])];
  return parts.filter((p) => typeof p === 'string' && p.trim()).join(' \n ');
}

function waveGroup(session, customerTexts = []) {
  const words = customerWords(session, customerTexts);
  if (!words) return null;
  if (NEVER_USED_RE.test(words)) return 'W3';
  if (SEAT_RE.test(words) && NO_SYSTEM_RE.test(words)) return 'W2';
  if (USED_RE.test(words) && NO_RESULT_RE.test(words)) return 'W1';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Redaction for Discord / Mos. Drops contact keys outright and scrubs phone-like, email-like, LINE-user-id-like
// strings and the display name from every remaining string (nested objects and arrays included).
const CONTACT_KEYS = new Set(['display_name', 'line_user_id', 'user_id', 'contact', 'phone', 'email', 'handle', 'line_id']);
const PHONE_RE = /(?:\+66|0)[\s-]?\d{1,2}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LINE_UID_RE = /\bU[0-9a-f]{32}\b/g;

function scrub(value, names) {
  if (typeof value !== 'string') return value;
  let out = value.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]').replace(LINE_UID_RE, '[line_user_id]');
  for (const n of names) if (n && out.includes(n)) out = out.split(n).join('[name]');
  return out;
}

function redactForDiscord(lead) {
  if (!lead || typeof lead !== 'object') return lead;
  const names = [lead.display_name, lead.contact?.display_name, lead.contact?.handle].filter((n) => typeof n === 'string' && n.trim().length >= 2);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) { if (CONTACT_KEYS.has(k)) continue; o[k] = walk(val); }
      return o;
    }
    return scrub(v, names);
  };
  return walk(lead);
}

// ---------------------------------------------------------------------------------------------------------------
const NEXT_STEP_TH = {
  new: 'รอการบ้านเพิ่ม — Lay ถามต่อ',
  qualified: 'มอสอ่านลีด แล้วตอบภายในวัน',
  not_fit: 'นอกขอบเขตงานของเรา ไม่ต้องติดตาม',
  nurture: 'ยังไม่ถึงเวลา (ยังไม่เริ่มขาย) ทักกลับเมื่อเริ่มขายและงานเริ่มล้น',
  booking_pending: 'มอสยืนยันช่วงเวลาโทร',
  booked: 'โทรตามเวลานัด',
  offer_shown: 'ติดตามข้อเสนอ',
  closed: 'ปิดแล้ว',
};
const REASON_TH = { first_field: 'ลีดใหม่', handoff_human: 'ลูกค้าขอคุยกับมอส', handoff_scope: 'ถามราคาพิเศษ/นอกขอบเขต', handoff_unknown: 'คำถามที่ Lay ตอบไม่ได้', booking: 'ขอนัดโทร', status: 'สถานะเปลี่ยน' };

function leadSummaryTh(lead, { reason = 'first_field' } = {}) {
  const r = redactForDiscord(lead || {});
  const h = r.homework || {};
  const filled = HOMEWORK_FIELDS.filter((f) => h[f]);
  const q = qualify({ homework: h, booking_step: null });
  const lines = [
    `${REASON_TH[reason] || REASON_TH.status} · ${r.id || '(ยังไม่มี id)'}`,
    `การ์ด: ${r.card_id || '-'} · อาการ: ${r.symptom || '-'} · สถานะ: ${r.status || 'new'}`,
    `ลูกค้าบอกว่า: ${r.customer_words_th ? `"${r.customer_words_th}"` : '-'}`,
    `การบ้าน ${filled.length}/${HOMEWORK_FIELDS.length}: ${filled.map((f) => `${f}=${h[f]}`).join(' · ') || '-'}`,
    `ระดับ: ${q.qualification} (${q.reasons.join(', ')})${r.wave_group ? ` · กลุ่ม ${r.wave_group}` : ''}`,
    `ขั้นต่อไป: ${NEXT_STEP_TH[r.status] || NEXT_STEP_TH.new}`,
  ];
  return lines.join('\n');
}

module.exports = { STATUS_ORDER, SIDE_STATUSES,
  STATUS_ORDER, advanceStatus, buildLeadRow, qualify, waveGroup, wave_group: waveGroup, redactForDiscord, leadSummaryTh, NEXT_STEP_TH,
};
