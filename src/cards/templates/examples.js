'use strict';
/**
 * examples — {title?, items:[{image_key, title, line, cta:{label, postback|url}}] (2–5)}
 * Mega carousel; the hero image comes from ctx.assets[image_key] (https). Missing key → throws →
 * render falls back. Each bubble's cta is its one emerald element.
 */
const P = require('../primitives');
const { size } = require('../tokens');
const { cleanTitle, list, need, actionOf } = require('../common');

function hero(url) {
  return { type: 'image', url, size: 'full', aspectRatio: '16:9', aspectMode: 'cover' };
}

function build(data, ctx) {
  const assets = (ctx && ctx.assets) || {};
  const items = list(data, 'items', 1, 5, 'examples');
  const bubbles = items.map((it, i) => {
    const where = `examples.items[${i}]`;
    const key = need(it, 'image_key', where);
    const url = assets[key];
    if (!url) throw new Error(`${where}: no asset for image_key "${key}"`);
    const title = cleanTitle(it.title, ctx, `${where}.title`);
    const cta = need(it, 'cta', where);
    const body = [P.header(title), P.text(need(it, 'line', where))];
    return P.bubble({ hero: hero(url), body, footer: [P.buttonPrimary(cta.label, actionOf(cta))], size: size.bubbleWide });
  });
  const title = data.title ? cleanTitle(data.title, ctx, 'examples.title') : 'ตัวอย่างงาน';
  return {
    altText: `${title} — ${items.map((it) => it.title).join(' / ')}`,
    contents: { type: 'carousel', contents: bubbles },
  };
}

function fallback(data) {
  const items = data.items || [];
  return {
    text: [data.title || 'ตัวอย่างงาน', ...items.map((it) => `- ${it.title}: ${it.line}`)].join('\n'),
    quick_replies: items
      .filter((it) => it.cta && it.cta.label)
      .slice(0, 4)
      .map((it) => ({ label: P.shortLabel(it.cta.label), ...actionOf(it.cta) })),
  };
}

module.exports = { build, fallback };
