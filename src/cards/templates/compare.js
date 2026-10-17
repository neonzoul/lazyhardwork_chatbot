'use strict';
/**
 * compare — {title, columns:[{name, rows:[{k, v}], price_from?, cta?:{label, postback|url}}] (2–3)}
 * Carousel of 2–3 kilo bubbles, rows in the same order in every column. Each bubble carries one
 * emerald element: the cta button when given, otherwise the header accent mark.
 */
const P = require('../primitives');
const { cleanTitle, list, actionOf } = require('../common');

function build(data, ctx) {
  const title = cleanTitle(data.title, ctx, 'compare.title');
  const columns = list(data, 'columns', 2, 3, 'compare');
  const bubbles = columns.map((col, i) => {
    const name = cleanTitle(col.name, ctx, `compare.columns[${i}].name`);
    const rows = list(col, 'rows', 1, 8, `compare.columns[${i}]`);
    const body = [P.header(name, null, { kicker: title, accent: !col.cta }), P.separator()];
    body.push({ type: 'box', layout: 'vertical', spacing: 'sm', contents: rows.map((r) => P.kvRow(r.k, r.v)) });
    if (col.price_from) {
      body.push(P.separator());
      body.push(P.priceRow('ราคาเริ่มต้น', col.price_from, col.price_note));
    }
    const footer = col.cta ? [P.buttonPrimary(col.cta.label, actionOf(col.cta))] : [];
    return P.bubble({ body, footer });
  });
  return {
    altText: `${title} — เปรียบเทียบ ${columns.map((c) => c.name).join(' / ')}`,
    contents: { type: 'carousel', contents: bubbles },
  };
}

function fallback(data) {
  const cols = data.columns || [];
  return {
    text: [data.title, ...cols.map((c) => `- ${c.name}${c.price_from ? ` เริ่ม ${c.price_from}` : ''}`)].join('\n'),
    quick_replies: cols
      .filter((c) => c.cta)
      .slice(0, 4)
      .map((c) => ({ label: P.shortLabel(c.cta.label), ...actionOf(c.cta) })),
  };
}

module.exports = { build, fallback };
