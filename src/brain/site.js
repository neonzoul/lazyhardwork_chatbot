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

// exact aliases only (CE review, v2.0.2): a wrong prototype path that is a known name for a real page → that page.
// Anything else is dropped. Mos's test: business-review → review, agent → agentic-workflow.
const ALIASES = {
  '/prototype/business-review': '/prototype/review', '/prototype/ai-business-review': '/prototype/review',
  '/prototype/agent': '/prototype/agentic-workflow', '/prototype/ai-agent': '/prototype/agentic-workflow', '/prototype/agentic': '/prototype/agentic-workflow',
  '/prototype/chat-bot': '/prototype/chatbot', '/prototype/ai-chatbot': '/prototype/chatbot', '/prototype/line-bot': '/prototype/chatbot',
  '/prototype/ai-automation': '/prototype/automation',
  '/prototype/ai-workspace': '/prototype/workspace', '/prototype/workspace-setup': '/prototype/workspace',
};

const siteUrl = (path) => `${SITE_BASE}${path}`;

// absolute site URLs, and bare /prototype/… paths written without the domain. A URL ends at the first character that
// is not URL-safe ASCII (CE review of PR #15: "…/prototype/reviewครับ" — Thai written right after the link stays text)
const SITE_URL_RE = /https?:\/\/(?:www\.)?lhw\.anant-agent\.com(\/[A-Za-z0-9\-._~%/?#=&+:@]*)?|(?<![\w/.])(\/prototype\/[a-z0-9-]+)/giu;
// trailing sentence punctuation is not part of the link
const TRAIL_RE = /[.,!?;:]+$/u;

function normPath(p) {
  let path = String(p || '/').split(/[?#]/)[0];
  if (path.length > 1) path = path.replace(/\/+$/u, '');
  return path || '/';
}

// a known page: exact, or under /en (every /en/<page> checked live 25 Oct)
function known(path) {
  if (SITE_PATHS.has(path)) return true;
  return path.startsWith('/en/') && SITE_PATHS.has(path.slice(3));
}

// the canonical page for a wrong-case or alias path (the site is case-sensitive: /prototype/Review is a 404), else null
function repair(path) {
  const lower = path.toLowerCase();
  const en = lower.startsWith('/en/') ? '/en' : '';
  const rest = en ? lower.slice(3) : lower;
  if (known(lower)) return lower;
  return ALIASES[rest] ? `${en}${ALIASES[rest]}` : null;
}

function fixSiteUrls(text, { lastTouch } = {}) {
  const changed = [];
  void lastTouch;   // kept in the signature; the session no longer picks the page (Head review, PR #14)
  const out = String(text || '').replace(SITE_URL_RE, (whole, absPath, barePath) => {
    const trail = (whole.match(TRAIL_RE) || [''])[0];
    const link = trail ? whole.slice(0, -trail.length) : whole;
    const isAbs = /^https?:/iu.test(link);
    const raw = isAbs ? (absPath ? absPath.slice(0, absPath.length - Math.min(trail.length, absPath.length)) : '/') : barePath;
    const path = normPath(raw);
    if (known(path)) return whole;
    // repaired only through the case fix and the exact alias list; anything else is dropped, never guessed (Head + CE)
    const to = repair(path);
    const replacement = to ? siteUrl(to) : '';
    changed.push({ from: link, to: replacement || null });
    return replacement + (replacement ? trail : '');
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
