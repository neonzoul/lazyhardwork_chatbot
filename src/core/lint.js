// Output lint — the single source of truth for what a customer-facing text may not contain (design §1.2 step 7,
// brief §9.5/§9.6, §3.2). Used by core/policy.js before sending and by the scenario runner when asserting.

const BANNED = [
  { id: 'old_sprint_prices', re: /Sprint\s*[123]|฿?\s?15,000\s*\+|฿?\s?30,000\s*\+|45,000\s*บาท.*Sprint/i, why: 'retired Sprint offer' },
  { id: 'job_counts', re: /181\s*งาน|36\s*ราย|ลูกค้า\s*36/u, why: 'proof is 4.9★ only' },
  { id: 'email', re: /[\w.+-]+@[\w-]+\.[\w.]+/u, why: 'email never shown' },
  { id: 'guarantee', re: /การันตี|รับประกันผล|ยอดขายเพิ่ม\s*\d+/u, why: 'no guaranteed results' },
  { id: 'reduce_staff', re: /ลดคน|แทนพนักงาน|ไม่ต้องจ้างเพิ่ม|ประหยัดค่าแรง/u, why: 'never sell on job loss' },
  { id: 'subsidy_amount_promise', re: /(?:ได้เงินคืน|รัฐออกให้|อุดหนุนให้)\s*\d/u, why: 'subsidy amounts are never promised' },
  { id: 'agent_tag', re: /\[Agent Lay\]/u, why: 'the tag is gone (D2)' },
  { id: 'stock_closer', re: /ยินดีช่วยเสมอ|ยินดีให้บริการเสมอ/u, why: 'no stock closers' },
  { id: 'booking_confirmed', re: /ยืนยันแล้ว|นัดเรียบร้อย|นัดหมายเรียบร้อย/u, why: 'only after Mos approves', conditional: 'booking_confirmed' },
  { id: 'registered_provider', re: /(?:LazyHardWork|LhW|เรา|ผม)\s*(?:เป็น|คือ)\s*ผู้ให้บริการที่ขึ้นทะเบียน(?!.*(?:ยังไม่|ไม่ได้))/u, why: 'LhW is not a registered provider' },
];

// allow: set of banned ids that are permitted in this context (e.g. 'booking_confirmed' after Mos approved)
function findBanned(text, allow = new Set()) {
  if (!text) return [];
  return BANNED.filter((b) => !allow.has(b.id) && b.re.test(text)).map((b) => ({ id: b.id, why: b.why }));
}

// Emoji counting — Extended_Pictographic covers the usual suspects; keycap digits (1️⃣) and arrows count too.
const EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]️?⃣/gu;
function countEmoji(text) {
  if (!text) return 0;
  const m = text.match(EMOJI_RE);
  return m ? m.length : 0;
}

// Emoji policy (brief §3.2): default none; an `explain` bubble may use structural emoji; never a mood emoji at a
// sentence end; never 🙏/😊 as a habit; max one emoji in a plain reply.
const MOOD_EMOJI = /🙏|😊|😄|😁|🙂|😉|😍|🥰|😅|🤗|👍|✨|🎉/u;
function checkEmoji(text, { explain = false } = {}) {
  const errors = [];
  const n = countEmoji(text);
  if (n === 0) return { ok: true, errors, count: 0 };
  if (MOOD_EMOJI.test(text)) errors.push('mood emoji (🙏/😊/👍/✨…) not allowed');
  if (!explain && n > 1) errors.push(`${n} emoji in a plain reply (max 1)`);
  if (/\p{Extended_Pictographic}\s*$/u.test(text.trim())) errors.push('emoji at the end of the text');
  return { ok: errors.length === 0, errors, count: n };
}

// Prose-list detector (brief §9.2): choices must be buttons or cards, never a list in prose.
const PROSE_LIST_RES = [
  /(^|\n)\s*(?:[1-9][.)]|[-•●▪]|ก[.)]|ข[.)])\s*\S/u,              // "1." / "-" / "ก." lines
  /(?:^|\s)(?:หรือ|กับ)\s[^\n]{2,40}\s(?:หรือ|กับ)\s[^\n]{2,40}\s(?:หรือ|กับ)\s/u, // 3+ "หรือ … หรือ … หรือ" chains
  /[^\n]{3,}\s\(\s*[1-3]\s*\)\s[^\n]{3,}\s\(\s*[1-3]\s*\)/u,       // "(1) … (2) …"
];
function hasProseList(text) {
  if (!text) return false;
  return PROSE_LIST_RES.some((re) => re.test(text));
}

const MARKDOWN_RE = /\*\*[^*]+\*\*|__[^_]+__|^#{1,6}\s|`[^`\n]+`|\[[^\]]+\]\([^)]+\)/mu;
function hasMarkdown(text) { return !!text && MARKDOWN_RE.test(text); }
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/gs, '$1').replace(/__(.+?)__/gs, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/`([^`\n]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

// ~3 short lines: count lines and characters (Thai has no spaces; use chars).
function tooLong(text, { maxLines = 4, maxChars = 300 } = {}) {
  if (!text) return false;
  const lines = text.split('\n').filter((l) => l.trim()).length;
  return lines > maxLines || text.length > maxChars;
}

// Full report for one text bubble.
function lintText(text, { explain = false, allow = new Set() } = {}) {
  const banned = findBanned(text, allow);
  const emoji = checkEmoji(text, { explain });
  const errors = [
    ...banned.map((b) => `banned:${b.id}`),
    ...emoji.errors.map((e) => `emoji:${e}`),
    ...(hasProseList(text) ? ['prose_list'] : []),
    ...(hasMarkdown(text) ? ['markdown'] : []),
    ...(tooLong(text) ? ['too_long'] : []),
  ];
  return { ok: errors.length === 0, errors, emojiCount: emoji.count };
}

module.exports = { BANNED, findBanned, countEmoji, checkEmoji, hasProseList, hasMarkdown, stripMarkdown, tooLong, lintText };
