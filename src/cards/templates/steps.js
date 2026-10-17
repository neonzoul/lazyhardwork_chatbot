'use strict';
/**
 * steps — {title, steps:[{title, detail?, ai?}] (3–5), cta?:{label, postback|url}}
 * Numbered rows. The one emerald element is the cta button when given; otherwise the badge of the
 * step flagged `ai: true` (else the first step) — "the point where AI acts".
 */
const P = require('../primitives');
const { color, size, space } = require('../tokens');
const { cleanTitle, list, actionOf } = require('../common');

function badge(n, emerald) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: '24px',
    height: '24px',
    cornerRadius: space.pill,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: emerald ? color.emerald : color.line,
    contents: [P.text(String(n), { size: size.caption, weight: 'bold', color: emerald ? color.onEmerald : color.ink, align: 'center' })],
  };
}

function stepRow(step, n, emerald, ctx) {
  const title = cleanTitle(step.title, ctx, `steps.steps[${n - 1}].title`);
  const lines = [P.text(title, { weight: 'bold' })];
  if (step.detail) lines.push(P.text(step.detail, { size: size.caption, color: color.muted }));
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: space.gapMd,
    alignItems: 'flex-start',
    contents: [badge(n, emerald), { type: 'box', layout: 'vertical', flex: 1, spacing: space.gapXs, contents: lines }],
  };
}

function build(data, ctx) {
  const title = cleanTitle(data.title, ctx, 'steps.title');
  const steps = list(data, 'steps', 2, 5, 'steps');
  let aiIndex = steps.findIndex((s) => s.ai);
  if (aiIndex < 0) aiIndex = 0;
  const hasCta = !!(data.cta && data.cta.label);
  const body = [
    P.header(title, data.subtitle),
    P.separator(),
    { type: 'box', layout: 'vertical', spacing: space.gapMd, contents: steps.map((s, i) => stepRow(s, i + 1, !hasCta && i === aiIndex, ctx)) },
  ];
  const footer = hasCta ? [P.buttonPrimary(data.cta.label, actionOf(data.cta))] : [];
  return {
    altText: `${title} — ${steps.length} ขั้นตอน`,
    contents: P.bubble({ body, footer }),
  };
}

function fallback(data) {
  const steps = data.steps || [];
  return {
    text: [data.title, ...steps.map((s, i) => `${i + 1}. ${s.title}`)].join('\n'),
    quick_replies: data.cta && data.cta.label ? [{ label: P.shortLabel(data.cta.label), ...actionOf(data.cta) }] : [],
  };
}

module.exports = { build, fallback };
