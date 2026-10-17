'use strict';
/**
 * info — {title, rows:[{k, v}] (3–5), note?, cta?:{label, postback|url}}
 * Key/value facts. One emerald element: the cta when given, otherwise the header accent mark.
 */
const P = require('../primitives');
const { size, color } = require('../tokens');
const { cleanTitle, list, actionOf } = require('../common');

function build(data, ctx) {
  const title = cleanTitle(data.title, ctx, 'info.title');
  const rows = list(data, 'rows', 1, 5, 'info');
  const hasCta = !!(data.cta && data.cta.label);
  const body = [
    P.header(title, data.subtitle, { accent: !hasCta }),
    P.separator(),
    { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows.map((r) => P.kvRow(r.k, r.v)) },
  ];
  if (data.note) body.push(P.text(data.note, { size: size.caption, color: color.muted }));
  const footer = hasCta ? [P.buttonPrimary(data.cta.label, actionOf(data.cta))] : [];
  return {
    altText: `${title} — ${rows.map((r) => `${r.k} ${r.v}`).join(', ')}`,
    contents: P.bubble({ body, footer }),
  };
}

function fallback(data) {
  return {
    text: [data.title, ...(data.rows || []).map((r) => `${r.k}: ${r.v}`), data.note].filter(Boolean).join('\n'),
    quick_replies: data.cta && data.cta.label ? [{ label: P.shortLabel(data.cta.label), ...actionOf(data.cta) }] : [],
  };
}

module.exports = { build, fallback };
