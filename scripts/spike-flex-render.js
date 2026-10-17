/**
 * Spike: Flex Message render test for the Lay v2 card renderer (built inline — no renderer module yet).
 *
 * Usage:
 *   node scripts/spike-flex-render.js --to <userId> [--template choice|offer|summary_confirm|all] [--carousel] [--dry-run]
 *
 *   --template   which bubble(s) to push, one push per bubble (default: all)
 *   --carousel   send the three bubbles as ONE carousel message instead
 *   --dry-run    print the exact request bodies and never touch the LINE API
 *
 * Card design tokens (see doc for the renderer):
 *   background #FAFAF8 · ink #1B1B1B · muted #6B6B6B · ONE emerald accent #0E6E5C per card
 *   (primary button only) · amber #B8860B only for the "รอมอสยืนยัน" status pill on #FFF4D6
 *   no gradients · no emoji in titles · every message carries a meaningful altText
 *
 * Needs LINE_CHANNEL_ACCESS_TOKEN in .env (not needed for --dry-run). Never print the token.
 */

require('dotenv').config();
const line = require('@line/bot-sdk');

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const C = {
  bg: '#FAFAF8',
  ink: '#1B1B1B',
  muted: '#6B6B6B',
  accent: '#0E6E5C',
  amber: '#B8860B',
  amberBg: '#FFF4D6',
  rule: '#E6E4DF',
};

// ---------------------------------------------------------------------------
// LINE limits worked around here
//   altText       ≤ 400 chars
//   Flex JSON     ≤ 50 KB per message (carousel: ≤ 12 bubbles, all same size)
//   action label  ≤ 20 chars (any postback/uri/message action — so long Thai options
//                 become tappable boxes with a short label + full displayText, not buttons)
//   postback data ≤ 300 chars
//   `color` on a button: primary → background, link → text; secondary → background
//   (so "outline" is done with a bordered box + a link-style button, not a button style)
//   Only `uri` actions may open URLs; postback actions carry `data` and optional `displayText`
// ---------------------------------------------------------------------------
const ALT_TEXT_MAX = 400;
const FLEX_JSON_MAX_BYTES = 50 * 1024;
const ACTION_LABEL_MAX = 20;
const POSTBACK_DATA_MAX = 300;

const FASTWORK_URI = process.env.FASTWORK_URL || 'https://fastwork.co/user/mos_lazyhardwork';

// ---------------------------------------------------------------------------
// Small component helpers
// ---------------------------------------------------------------------------
function text(value, opts = {}) {
  return { type: 'text', text: value, wrap: true, color: C.ink, size: 'sm', ...opts };
}

function title(value) {
  return text(value, { weight: 'bold', size: 'lg', color: C.ink });
}

function subtitle(value) {
  return text(value, { size: 'sm', color: C.muted });
}

function separator() {
  return { type: 'separator', color: C.rule };
}

function primaryButton(action) {
  return { type: 'button', style: 'primary', color: C.accent, height: 'sm', action };
}

// "Outline" look: a bordered box wrapping a link-style button with ink text (no second accent).
function secondaryButton(action) {
  return {
    type: 'box',
    layout: 'vertical',
    borderWidth: '1px',
    borderColor: C.rule,
    cornerRadius: '8px',
    contents: [{ type: 'button', style: 'link', color: C.ink, height: 'sm', action }],
  };
}

function postback(label, data, displayText) {
  return { type: 'postback', label, data, displayText: displayText || label };
}

function bullet(value) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      text('•', { flex: 0, color: C.muted }),
      text(value, { flex: 1 }),
    ],
  };
}

function kvRow(key, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      text(key, { flex: 4, color: C.muted }),
      text(value, { flex: 7 }),
    ],
  };
}

function statusPill(label) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: C.amberBg,
        cornerRadius: '999px',
        paddingAll: '6px',
        paddingStart: '12px',
        paddingEnd: '12px',
        contents: [text(label, { size: 'xs', color: C.amber, weight: 'bold', wrap: false })],
      },
    ],
    justifyContent: 'flex-start',
  };
}

function bubble({ body, footer }) {
  const b = {
    type: 'bubble',
    size: 'mega',
    styles: {
      body: { backgroundColor: C.bg },
      footer: { backgroundColor: C.bg, separator: false },
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', contents: body },
  };
  if (footer) {
    b.footer = { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', paddingTop: '0px', contents: footer };
  }
  return b;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
// Choice options are full Thai sentences (>20 chars), so they cannot be button `label`s.
// Render each as a tappable box: the postback action sits on the box, the visible text is a
// wrapped child, `label` is a short id (≤ 20) and `displayText` echoes the full option in chat.
function choiceOption({ text: label, data, shortLabel, primary }) {
  const action = postback(shortLabel, data, label);
  const base = {
    type: 'box',
    layout: 'vertical',
    cornerRadius: '8px',
    paddingAll: '12px',
    action,
  };
  if (primary) {
    return { ...base, backgroundColor: C.accent, contents: [text(label, { color: '#FFFFFF', align: 'center', weight: 'bold' })] };
  }
  return { ...base, borderWidth: '1px', borderColor: C.rule, contents: [text(label, { color: C.ink, align: 'center' })] };
}

function choiceBubble() {
  const options = [
    { text: 'ตอบแชทลูกค้าไม่ทัน', shortLabel: 'ตอบแชทไม่ทัน', data: 'FIT_chat_overload', primary: true },
    { text: 'ข้อมูลกระจาย ต้องตามงานเอง', shortLabel: 'ข้อมูลกระจาย', data: 'FIT_scattered_info' },
    { text: 'งานซ้ำ คีย์ซ้ำทุกวัน', shortLabel: 'งานซ้ำทุกวัน', data: 'FIT_repetitive_entry' },
    { text: 'อยากให้ AI รู้จักงานผม', shortLabel: 'AI รู้จักงานผม', data: 'FIT_ai_context' },
    { text: 'ยังไม่รู้จะเริ่มตรงไหน', shortLabel: 'ยังไม่รู้จะเริ่ม', data: 'FIT_unsure' },
  ];
  return bubble({
    body: [title('เหมาะกับงานผมไหม'), subtitle('เลือกอาการที่ตรงกับร้านคุณที่สุด')],
    footer: options.map(choiceOption),
  });
}

function offerBubble() {
  return bubble({
    body: [
      title('ตั้งค่า AI Workspace — Starter'),
      separator(),
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          bullet('จัดโฟลเดอร์ไม่เกิน 70 ไฟล์'),
          bullet('ไฟล์กฎ 1 ไฟล์'),
          bullet('คำสั่งพร้อมใช้ 3 ตัว'),
          bullet('ติดตั้ง 90 นาที + ถามต่อ 7 วัน'),
        ],
      },
      separator(),
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          text('ราคาเริ่มต้น 4,999 บาท', { weight: 'bold', size: 'md' }),
          text('ปรับตามขอบเขตจริงหลังคุย', { size: 'xs', color: C.muted }),
        ],
      },
    ],
    footer: [
      primaryButton({ type: 'uri', label: 'ดูการ์ดบน Fastwork', uri: FASTWORK_URI }),
      secondaryButton(postback('นัดคุยกับมอส', 'BOOK_START')),
    ],
  });
}

function summaryConfirmBubble() {
  return bubble({
    body: [
      title('ขอนัดคุย 30 นาที'),
      separator(),
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          kvRow('ชื่อ', 'คุณต้น'),
          kvRow('ธุรกิจ', 'ร้านกาแฟ 2 สาขา'),
          kvRow('เรื่องที่อยากคุย', 'ตอบแชทลูกค้าไม่ทัน อยากให้บอทช่วยตอบ'),
          kvRow('ช่วงเวลาที่สะดวก', 'พุธ–ศุกร์ หลัง 14:00'),
        ],
      },
      statusPill('รอมอสยืนยัน'),
    ],
    footer: [
      primaryButton(postback('ยืนยัน', 'BOOK_CONFIRM')),
      secondaryButton(postback('ขอแก้ไข', 'BOOK_EDIT')),
    ],
  });
}

const TEMPLATES = {
  choice: { altText: 'เหมาะกับงานผมไหม — เลือกอาการที่ตรงกับร้านคุณที่สุด', build: choiceBubble },
  offer: { altText: 'ตั้งค่า AI Workspace — Starter ราคาเริ่มต้น 4,999 บาท', build: offerBubble },
  summary_confirm: { altText: 'สรุปคำขอนัดคุย 30 นาที — รอมอสยืนยัน', build: summaryConfirmBubble },
};
const TEMPLATE_ORDER = ['choice', 'offer', 'summary_confirm'];

function flexMessage(altText, contents) {
  return { type: 'flex', altText, contents };
}

// ---------------------------------------------------------------------------
// Local validator — catches the LINE rejections we can predict offline
// ---------------------------------------------------------------------------
function walk(node, visit, path = '$') {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, visit, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    visit(node, path);
    for (const [k, v] of Object.entries(node)) walk(v, visit, `${path}.${k}`);
  }
}

function validateFlex(msg) {
  const violations = [];
  if (msg.type !== 'flex') violations.push('message.type must be "flex"');
  if (typeof msg.altText !== 'string' || !msg.altText.trim()) violations.push('altText is empty');
  else if (Array.from(msg.altText).length > ALT_TEXT_MAX) {
    violations.push(`altText is ${Array.from(msg.altText).length} chars (max ${ALT_TEXT_MAX})`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(msg.contents), 'utf8');
  if (bytes > FLEX_JSON_MAX_BYTES) violations.push(`Flex JSON is ${bytes} bytes (max ${FLEX_JSON_MAX_BYTES})`);

  const bubbles = msg.contents?.type === 'carousel' ? msg.contents.contents || [] : [msg.contents];
  if (msg.contents?.type === 'carousel' && bubbles.length > 12) {
    violations.push(`carousel has ${bubbles.length} bubbles (max 12)`);
  }
  bubbles.forEach((b, i) => {
    if (!b || b.type !== 'bubble') violations.push(`contents[${i}] is not a bubble`);
    else if (!b.body) violations.push(`bubble[${i}] has no body`);
  });

  walk(msg.contents, (node, path) => {
    if (node.type === 'text' && (typeof node.text !== 'string' || node.text.length === 0)) {
      violations.push(`empty text component at ${path}`);
    }
    if (node.type === 'button' && (typeof node.action?.label !== 'string' || !node.action.label)) {
      violations.push(`button without label at ${path}`);
    }
    if (typeof node.label === 'string' && ['postback', 'uri', 'message'].includes(node.type)) {
      if (Array.from(node.label).length > ACTION_LABEL_MAX) {
        violations.push(`action label "${node.label}" exceeds ${ACTION_LABEL_MAX} chars at ${path}`);
      }
    }
    if (node.type === 'postback' && typeof node.data === 'string' && node.data.length > POSTBACK_DATA_MAX) {
      violations.push(`postback data exceeds ${POSTBACK_DATA_MAX} chars at ${path}`);
    }
    if (node.type === 'uri' && !/^https:\/\//.test(node.uri || '')) {
      violations.push(`uri action must be https at ${path}`);
    }
  });

  return { ok: violations.length === 0, violations, bytes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { template: 'all', carousel: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--carousel') args.carousel = true;
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--template') args.template = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function usage() {
  console.log(
    'Usage: node scripts/spike-flex-render.js --to <userId> [--template choice|offer|summary_confirm|all] [--carousel] [--dry-run]'
  );
}

function buildPushes(args) {
  const names = args.template === 'all' ? TEMPLATE_ORDER : [args.template];
  for (const n of names) {
    if (!TEMPLATES[n]) throw new Error(`Unknown template "${n}". Use ${TEMPLATE_ORDER.join('|')}|all`);
  }
  if (args.carousel) {
    const chosen = args.template === 'all' ? TEMPLATE_ORDER : names;
    return [
      {
        label: `carousel(${chosen.join(',')})`,
        message: flexMessage(
          'การ์ดทดสอบ Lay v2 — เหมาะกับงานผมไหม / ข้อเสนอ Starter / สรุปนัดคุย',
          { type: 'carousel', contents: chosen.map((n) => TEMPLATES[n].build()) }
        ),
      },
    ];
  }
  return names.map((n) => ({ label: n, message: flexMessage(TEMPLATES[n].altText, TEMPLATES[n].build()) }));
}

function lineErrorBody(err) {
  const raw = err?.originalError?.response?.data || err?.body || err?.response?.data || err?.message || String(err);
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.to) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const pushes = buildPushes(args);

  // Validate everything before any network call; abort if anything is off.
  let invalid = 0;
  for (const p of pushes) {
    const v = validateFlex(p.message);
    if (v.ok) console.log(`[${p.label}] validated (${v.bytes} bytes)`);
    else {
      invalid += 1;
      console.error(`[${p.label}] INVALID:\n  - ${v.violations.join('\n  - ')}`);
    }
  }
  if (invalid > 0) {
    console.error(`\n${invalid} message(s) failed local validation — nothing sent`);
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] would push ${pushes.length} message(s) to ${args.to} — no API calls made`);
    pushes.forEach((p, i) => {
      console.log(`\n#${i + 1} ${p.label}\n${JSON.stringify({ to: args.to, messages: [p.message] }, null, 2)}`);
    });
    return;
  }

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error('ERROR: LINE_CHANNEL_ACCESS_TOKEN not set in .env');
    process.exit(1);
  }
  const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: token });

  let failures = 0;
  for (let i = 0; i < pushes.length; i += 1) {
    const p = pushes[i];
    try {
      const res = await client.pushMessageWithHttpInfo({ to: args.to, messages: [p.message] });
      console.log(`#${i + 1} ${p.label} → HTTP ${res.httpResponse.status}`);
    } catch (err) {
      failures += 1;
      const status = err?.status || err?.statusCode || err?.originalError?.response?.status || 'ERR';
      console.error(`#${i + 1} ${p.label} → HTTP ${status}`);
      console.error(JSON.stringify(lineErrorBody(err), null, 2));
    }
  }

  if (failures > 0) {
    console.error(`\n${failures}/${pushes.length} push(es) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${pushes.length} pushes succeeded.`);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Spike failed:', err.message);
    process.exit(1);
  });
}

module.exports = { validateFlex, TEMPLATES, choiceBubble, offerBubble, summaryConfirmBubble };
