// The LazyHardWork website's real pages (hotfix 24 Oct: Lay linked /prototype/business-review and /prototype/agent, both
// 404). Every site URL Lay sends must be in SITE_PATHS; the policy post-check (fixSiteUrls) repairs or drops anything else.
// Each path was checked live (HTTP 200) on 24 Oct 2026. Add a page here only after it is live.
//
//   SITE_BASE, SITE_PATHS, PROTOTYPES, DEMO_PAGE   the table
//   siteUrl(path) → absolute URL                   fixSiteUrls(text, { lastTouch }) → { text, changed: [{ from, to }] }

const SITE_BASE = 'https://lhw.anant-agent.com';

// the five prototypes, in the order Lay names them (key = the website's demo token)
const PROTOTYPES = [
  { key: 'a4', path: '/prototype/workspace', name_th: 'AI Workspace' },
  { key: 'c1', path: '/prototype/review', name_th: 'AI Business Review' },
  { key: 'a2', path: '/prototype/chatbot', name_th: 'แชทบอท' },
  { key: 'a1', path: '/prototype/agentic-workflow', name_th: 'ระบบงานภายใน (AI Agent)' },
  { key: 'a3', path: '/prototype/automation', name_th: 'ออโตเมชัน' },
];

const SITE_PATHS = new Set([
  '/', '/en',
  ...PROTOTYPES.map((p) => p.path),
  '/work/kv-premium',
  '/journal/ai-agent-vs-chatgpt', '/journal/ai-for-sme-where-to-start', '/journal/ai-no-results',
  '/journal/ai-pass-for-business', '/journal/ai-recommend-your-business', '/journal/scattered-data-ai',
]);

// web-demo-<id> (lead last_touch) → that demo's page
const DEMO_PAGE = { a4: '/prototype/workspace', c1: '/prototype/review', a2: '/prototype/chatbot', 'a2-shop': '/prototype/chatbot', a1: '/prototype/agentic-workflow', a3: '/prototype/automation' };

// a wrong prototype path → the page it most likely meant (Mos's test: business-review → review, agent → agentic-workflow)
const NEAREST = [
  [/review|business/i, '/prototype/review'],
  [/agent|workflow|internal/i, '/prototype/agentic-workflow'],
  [/chat|bot|line/i, '/prototype/chatbot'],
  [/automat/i, '/prototype/automation'],
  [/workspace|claude/i, '/prototype/workspace'],
];

const siteUrl = (path) => `${SITE_BASE}${path}`;

// absolute site URLs, and bare /prototype/… paths written without the domain
const SITE_URL_RE = /https?:\/\/(?:www\.)?lhw\.anant-agent\.com(\/[^\s)"'<>]*)?|(?<![\w/.])(\/prototype\/[a-z0-9-]+)/giu;

function normPath(p) {
  let path = String(p || '/').split(/[?#]/)[0].replace(/[.,!?;:)\]]+$/u, '');
  if (path.length > 1) path = path.replace(/\/+$/u, '');
  return path || '/';
}

function fixSiteUrls(text, { lastTouch } = {}) {
  const changed = [];
  void lastTouch;   // kept in the signature; the session no longer picks the page (Head review, PR #14)
  const out = String(text || '').replace(SITE_URL_RE, (whole, absPath, barePath) => {
    const raw = absPath !== undefined || /^https?:/iu.test(whole) ? (absPath || '/') : barePath;
    const path = normPath(raw);
    if (SITE_PATHS.has(path)) return whole;
    // repaired only through the known alias map; anything else is dropped, never guessed from the session (Head review)
    let to = null;
    if (/^\/prototype\//u.test(path)) to = (NEAREST.find(([re]) => re.test(path)) || [])[1] || null;
    const replacement = to ? siteUrl(to) : '';
    changed.push({ from: whole, to: replacement || null });
    return replacement;
  });
  if (!changed.length) return { text: String(text || ''), changed };
  // a dropped link leaves "…ได้ที่นี่ครับ:" with nothing after it: clean the lead-in and stray spaces
  const tidy = out.replace(/\s*(?:ได้ที่|ที่)นี่(?:ครับ|ค่ะ)?\s*:\s*(?=\n|$)/gu, '').replace(/(?:ได้)?ที่\s+(?=ครับ|ค่ะ)/gu, '')
    .replace(/[ \t]{2,}/gu, ' ').replace(/[ \t]+$/gmu, '').trim();
  return { text: tidy, changed };
}

// Card data from the model (info / steps templates can carry a cta {label, uri|url}): every string is checked; a button
// whose only action was an unknown site URL is removed, so no Flex or quick-reply URI points at a page that does not exist.
const ACTION_KEYS = ['postback', 'data', 'uri', 'url', 'text'];
function fixCardUrls(value, opts = {}, changed = []) {
  if (typeof value === 'string') { const r = fixSiteUrls(value, opts); changed.push(...r.changed); return r.text; }
  if (Array.isArray(value)) return value.map((v) => fixCardUrls(v, opts, changed)).filter((v) => v !== DROP);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const fixed = fixCardUrls(v, opts, changed);
    if (fixed === DROP || ((k === 'uri' || k === 'url') && !fixed)) continue;
    out[k] = fixed;
  }
  // a button that lost its only action (an unknown site link) goes
  if ('label' in value && ACTION_KEYS.some((k) => k in value) && !ACTION_KEYS.some((k) => k in out)) return DROP;
  return out;
}
const DROP = Symbol('drop');
function fixCardData(data, opts = {}) {
  const changed = [];
  const out = fixCardUrls(data, opts, changed);
  return { data: out === DROP ? {} : out, changed };
}

module.exports = { SITE_BASE, SITE_PATHS, PROTOTYPES, DEMO_PAGE, siteUrl, fixSiteUrls, fixCardData, SITE_URL_RE };
