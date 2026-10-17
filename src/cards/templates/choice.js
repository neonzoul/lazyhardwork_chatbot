'use strict';
/**
 * choice — {title, subtitle?, options:[{label, postback, primary?}] (3–6)}
 * Options ≤ 20 chars render as buttons; if ANY option is longer, every option becomes a tappable
 * optionBox (full text inside, short label + full displayText) so the card stays consistent.
 * The option flagged `primary` (else the first) is the one emerald element.
 */
const P = require('../primitives');
const { cleanTitle, list, labelTooLong, actionOf } = require('../common');

function build(data, ctx) {
  const title = cleanTitle(data.title, ctx, 'choice.title');
  const options = list(data, 'options', 2, 6, 'choice').map((o) => ({
    label: String(o.label || '').trim(),
    action: actionOf(o),
    primary: !!o.primary,
  }));
  if (options.some((o) => !o.label)) throw new Error('choice: option label empty');
  if (!options.some((o) => o.primary)) options[0].primary = true;

  const useBox = options.some((o) => labelTooLong(o.label));
  const footer = options.map((o) => {
    if (useBox) return P.optionBox(o.label, o.action, o.primary);
    return o.primary ? P.buttonPrimary(o.label, o.action) : P.buttonSecondary(o.label, o.action);
  });

  return {
    altText: data.subtitle ? `${title} — ${data.subtitle}` : title,
    contents: P.bubble({ body: [P.header(title, data.subtitle)], footer }),
  };
}

/** Quick-reply fallback: the options themselves, short labels, ≤ 4. */
function fallback(data) {
  return {
    text: [data.title, data.subtitle].filter(Boolean).join('\n'),
    quick_replies: (data.options || []).slice(0, 4).map((o) => ({ label: P.shortLabel(o.label), ...actionOf(o) })),
  };
}

module.exports = { build, fallback };
