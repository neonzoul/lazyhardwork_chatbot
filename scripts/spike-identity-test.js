/**
 * Spike: per-message identity via LINE's `sender` property (icon + nickname).
 *
 * Pushes four messages, each as its own push call, so the chat shows them as
 * separate bubbles and we can see how the Lay / Mos / OA-default identities render.
 *
 * Usage:
 *   node scripts/spike-identity-test.js --to <userId|groupId> [--lay-icon URL] [--mos-icon URL] [--dry-run]
 *
 * Icon URLs resolve in this order: env LAY_ICON_URL / MOS_ICON_URL → flags → labelled placeholder.
 * --dry-run prints the exact request bodies and never touches the LINE API.
 *
 * Needs LINE_CHANNEL_ACCESS_TOKEN in .env (not needed for --dry-run). Never print the token.
 */

require('dotenv').config();
const line = require('@line/bot-sdk');

// ---------------------------------------------------------------------------
// LINE limits worked around here
//   sender.name    ≤ 20 characters
//   sender.iconUrl must be HTTPS, PNG recommended, ≤ 1 MB (not checked locally)
//   quickReply     ≤ 13 items; label ≤ 20 characters
// ---------------------------------------------------------------------------
const SENDER_NAME_MAX = 20;
const QUICK_REPLY_LABEL_MAX = 20;

const PLACEHOLDER_LAY_ICON = 'https://placehold.co/240x240/0E6E5C/FFFFFF.png?text=Lay';
const PLACEHOLDER_MOS_ICON = 'https://placehold.co/240x240/1B1B1B/FFFFFF.png?text=Mos';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--lay-icon') args.layIcon = argv[++i];
    else if (a === '--mos-icon') args.mosIcon = argv[++i];
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
    'Usage: node scripts/spike-identity-test.js --to <userId|groupId> [--lay-icon URL] [--mos-icon URL] [--dry-run]'
  );
}

function isHttps(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function assertSenderName(name) {
  // Count code points, not UTF-16 units — Thai combining marks are separate code points
  // and LINE counts characters, so this is the conservative side.
  const len = Array.from(name).length;
  if (len > SENDER_NAME_MAX) {
    throw new Error(`sender.name "${name}" is ${len} chars; LINE allows at most ${SENDER_NAME_MAX}`);
  }
}

function resolveIcons(args) {
  let usedPlaceholder = false;
  let lay = process.env.LAY_ICON_URL || args.layIcon;
  let mos = process.env.MOS_ICON_URL || args.mosIcon;
  if (!lay) {
    lay = PLACEHOLDER_LAY_ICON;
    usedPlaceholder = true;
  }
  if (!mos) {
    mos = PLACEHOLDER_MOS_ICON;
    usedPlaceholder = true;
  }
  for (const [label, url] of [['LAY_ICON', lay], ['MOS_ICON', mos]]) {
    if (!isHttps(url)) throw new Error(`${label} must be an https URL, got: ${url}`);
  }
  if (usedPlaceholder) {
    console.warn('WARNING: placeholder icon(s) in use (placehold.co). Set LAY_ICON_URL / MOS_ICON_URL or pass --lay-icon / --mos-icon.');
  }
  return { lay, mos };
}

function buildPushes(icons) {
  const laySender = { name: 'Lay · ผู้ช่วย AI', iconUrl: icons.lay };
  const mosSender = { name: 'มอส', iconUrl: icons.mos };
  assertSenderName(laySender.name);
  assertSenderName(mosSender.name);

  const quickReply = {
    items: [
      { type: 'action', action: { type: 'message', label: 'เรียก Lay', text: 'เรียก Lay' } },
      {
        type: 'action',
        action: { type: 'postback', label: 'คุยกับมอส', data: 'SPIKE_HANDOFF', displayText: 'คุยกับมอส' },
      },
    ],
  };
  for (const item of quickReply.items) {
    const len = Array.from(item.action.label).length;
    if (len > QUICK_REPLY_LABEL_MAX) {
      throw new Error(`quick reply label "${item.action.label}" exceeds ${QUICK_REPLY_LABEL_MAX} chars`);
    }
  }

  return [
    {
      identity: 'Lay (sender)',
      message: { type: 'text', text: 'ทดสอบตัวตน 1/3: ข้อความนี้ส่งจาก Lay', sender: laySender },
    },
    {
      identity: 'Mos (sender)',
      message: { type: 'text', text: 'ทดสอบตัวตน 2/3: ข้อความนี้ส่งในนาม มอส', sender: mosSender },
    },
    {
      identity: 'OA default (no sender)',
      message: { type: 'text', text: 'ทดสอบตัวตน 3/3: ข้อความนี้ไม่มี sender (ค่าเริ่มต้นของ OA)' },
    },
    {
      identity: 'Lay (sender) + quick reply',
      message: {
        type: 'text',
        text: 'ทดสอบตัวตน 1/3: ข้อความนี้ส่งจาก Lay',
        sender: laySender,
        quickReply,
      },
    },
  ];
}

function lineErrorBody(err) {
  // bot-sdk v9 throws HTTPFetchError { status, body: string }; older axios-style errors
  // carry originalError.response.data. Parse string bodies so the LINE error reads cleanly.
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

  const icons = resolveIcons(args);
  const pushes = buildPushes(icons);

  if (args.dryRun) {
    console.log(`[dry-run] would push ${pushes.length} message(s) to ${args.to} — no API calls made`);
    pushes.forEach((p, i) => {
      const body = { to: args.to, messages: [p.message] };
      console.log(`\n#${i + 1} ${p.identity}\n${JSON.stringify(body, null, 2)}`);
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
      // pushMessageWithHttpInfo exposes the HTTP status; plain pushMessage does not.
      const res = await client.pushMessageWithHttpInfo({ to: args.to, messages: [p.message] });
      console.log(`#${i + 1} ${p.identity} → HTTP ${res.httpResponse.status}`);
    } catch (err) {
      failures += 1;
      const status = err?.status || err?.statusCode || err?.originalError?.response?.status || 'ERR';
      console.error(`#${i + 1} ${p.identity} → HTTP ${status}`);
      console.error(JSON.stringify(lineErrorBody(err), null, 2));
    }
  }

  if (failures > 0) {
    console.error(`\n${failures}/${pushes.length} push(es) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${pushes.length} pushes succeeded.`);
}

run().catch((err) => {
  console.error('Spike failed:', err.message);
  process.exit(1);
});
