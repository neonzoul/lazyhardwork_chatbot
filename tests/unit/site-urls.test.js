'use strict';
// Hotfix 24 Oct: Lay must never send an invented LazyHardWork URL. Mos's production test: #demo-c1 got
// /prototype/business-review and #demo-a1 got /prototype/agent, both 404.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const site = require('../../src/brain/site');
const policy = require('../../src/core/policy');

// Lay's two production replies, verbatim (24 Oct 14:03 UTC)
const C1_REPLY = 'ถ้าพี่สนใจดูเดโม AI Business Review สามารถลองใช้ได้ที่นี่ครับ: https://lhw.anant-agent.com/prototype/business-review\nลองดูว่าการรีวิวธุรกิจช่วยได้ยังไงและวางแผนการใช้ AI ในธุรกิจได้อย่างไรครับ';
const A1_REPLY = 'ถ้าพี่สนใจดูเดโม AI Agent ของเรา สามารถลองใช้ได้ที่นี่ครับ: https://lhw.anant-agent.com/prototype/agent\nลองดูว่าระบบทำงานยังไงและช่วยจัดการงานภายในได้อย่างไรครับ';

const mk = (x) => ({ messages: [{ type: 'text', text: x, explain: false, template: null, alt: null, data: null }], quick_replies: [], topics: [], kb_refs: [], intent: 'proof', lead_updates: {}, action: null });
const urls = (t) => [...String(t).matchAll(site.SITE_URL_RE)].map((m) => m[0]);

test("Mos's two production replies come out with the real pages, never the 404s", () => {
  const c1 = policy.applyPolicy(mk(C1_REPLY), { session: { homework: { last_touch: 'web-demo-c1' } } }).response.messages[0].text;
  assert.deepEqual(urls(c1), ['https://lhw.anant-agent.com/prototype/review']);
  const a1 = policy.applyPolicy(mk(A1_REPLY), { session: { homework: { last_touch: 'web-demo-a1' } } }).response.messages[0].text;
  assert.deepEqual(urls(a1), ['https://lhw.anant-agent.com/prototype/agentic-workflow']);
  for (const t of [c1, a1]) assert.doesNotMatch(t, /business-review|\/prototype\/agent(?!ic)/);
});

test('every table page is kept; unknown site pages are dropped; bare /prototype paths are repaired; other domains untouched', () => {
  for (const p of site.SITE_PATHS) assert.equal(site.fixSiteUrls(`ดู ${site.siteUrl(p)} ครับ`).changed.length, 0, p);
  const dropped = site.fixSiteUrls('ราคาดูได้ที่ https://lhw.anant-agent.com/pricing ครับ');
  assert.equal(dropped.changed[0].to, null);
  assert.doesNotMatch(dropped.text, /anant-agent/);
  assert.match(site.fixSiteUrls('ลองที่ /prototype/agent ได้เลย').text, /https:\/\/lhw\.anant-agent\.com\/prototype\/agentic-workflow/);
  // an unknown prototype with no alias is dropped, even when the session came from a demo (no guessing, Head review)
  const unknown = site.fixSiteUrls('ลิงก์ https://lhw.anant-agent.com/prototype/xyz', { lastTouch: 'web-demo-a3' });
  assert.equal(unknown.changed[0].to, null);
  assert.doesNotMatch(unknown.text, /anant-agent/);
  const other = 'โปรไฟล์ https://fastwork.co/user/moslazyhardwork และ https://lin.ee/OrYthD8';
  assert.equal(site.fixSiteUrls(other).text, other);
});

test('nothing under knowledge/ names a site URL outside the table (CE review: the whole folder, not only kb/)', () => {
  const root = path.resolve(__dirname, '..', '..', 'knowledge');
  const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(root);
  const bad = files.flatMap((f) => urls(fs.readFileSync(f, 'utf8')).filter((u) => site.fixSiteUrls(u).changed.length).map((u) => `${path.relative(root, f)}: ${u}`));
  assert.ok(files.length > 5);
  assert.deepEqual(bad, []);
  const dir = path.join(root, 'kb');
  const about = fs.readFileSync(path.join(dir, 'about.md'), 'utf8');
  for (const p of site.PROTOTYPES) assert.ok(about.includes(site.siteUrl(p.path)), p.path);
  assert.doesNotMatch(about, /\{service\}/);
});

test('card data from the model: a cta with an invented site URL is repaired; one with an unknown page is removed', () => {
  const card = (cta) => ({ messages: [{ type: 'text', text: 'ดูตัวอย่างได้เลยครับ', explain: false, template: null, alt: null, data: null }, { type: 'card', text: null, explain: false, template: 'info', alt: 'เดโม', data: { title: 'เดโม', rows: [], cta } }], quick_replies: [], topics: [], kb_refs: [], intent: 'proof', lead_updates: {}, action: null });
  const fixedCta = policy.applyPolicy(card({ label: 'ลองเดโม', uri: 'https://lhw.anant-agent.com/prototype/agent' }), { session: {} }).response.messages.find((m) => m.type === 'card').data.cta;
  assert.equal(fixedCta.uri, 'https://lhw.anant-agent.com/prototype/agentic-workflow');
  const gone = policy.applyPolicy(card({ label: 'ราคา', uri: 'https://lhw.anant-agent.com/pricing' }), { session: {} }).response.messages.find((m) => m.type === 'card').data;
  assert.equal(gone.cta, undefined);
  const kept = policy.applyPolicy(card({ label: 'Fastwork', uri: 'https://fastwork.co/user/moslazyhardwork' }), { session: {} }).response.messages.find((m) => m.type === 'card').data.cta;
  assert.equal(kept.uri, 'https://fastwork.co/user/moslazyhardwork');
});

test('exact aliases only: business-automation or similar keyword paths are dropped, not mapped (CE review)', () => {
  for (const p of ['/prototype/business-automation', '/prototype/review-demo', '/prototype/agent-workflow-x']) {
    const r = site.fixSiteUrls(`ดูที่ https://lhw.anant-agent.com${p} ครับ`);
    assert.equal(r.changed[0].to, null, p);
  }
  assert.match(site.fixSiteUrls('https://lhw.anant-agent.com/prototype/ai-agent').text, /\/prototype\/agentic-workflow$/);
});
