'use strict';
/**
 * render(card, ctx) → { message, fallback, errors, bytes }
 *   card = { template, alt?, data }     ctx = { assets, fastworkUrlFor, priceFor, log? }
 *   message  : { type:'flex', altText, contents } when the card builds AND validates, else null
 *   fallback : { text, quick_replies:[{label, type, data|uri}] (≤4) } — always present, so the caller
 *              can still send the choice as buttons when the card is dropped
 *
 * renderOrFallback(card, ctx) → a LINE message object ready to send (flex, or text + quickReply).
 */
const { limits } = require('./tokens');
const { validate } = require('./validate');
const { logger } = require('./common');
const { shortLabel } = require('./primitives');

const TEMPLATES = {
  choice: require('./templates/choice'),
  compare: require('./templates/compare'),
  steps: require('./templates/steps'),
  offer: require('./templates/offer'),
  summary_confirm: require('./templates/summary_confirm'),
  examples: require('./templates/examples'),
  info: require('./templates/info'),
};

function cleanQuickReplies(list) {
  return (Array.isArray(list) ? list : [])
    .filter((q) => q && q.label && (q.data || q.uri))
    .slice(0, limits.quickRepliesMax)
    .map((q) => ({ ...q, label: shortLabel(q.label) }));
}

function fallbackFor(card, ctx) {
  const t = TEMPLATES[card && card.template];
  const data = (card && card.data) || {};
  let fb = null;
  if (t && typeof t.fallback === 'function') {
    try {
      fb = t.fallback(data, ctx);
    } catch (e) {
      fb = null;
    }
  }
  const text = (fb && fb.text && String(fb.text).trim()) || (card && card.alt) || data.title || '';
  return { text: String(text), quick_replies: cleanQuickReplies(fb && fb.quick_replies) };
}

function render(card, ctx = {}) {
  const log = logger(ctx);
  const name = card && card.template;
  const t = TEMPLATES[name];
  const fallback = fallbackFor(card, ctx);
  if (!t) {
    log.warn(`unknown template "${name}" — falling back to text`);
    return { message: null, fallback, errors: [`unknown template "${name}"`], bytes: 0 };
  }
  let built;
  try {
    built = t.build(card.data || {}, ctx);
  } catch (e) {
    log.warn(`${name}: build failed — ${e.message}`);
    return { message: null, fallback, errors: [`build: ${e.message}`], bytes: 0 };
  }
  const altText = String((card.alt && card.alt.trim()) || built.altText || '').trim();
  const message = { type: 'flex', altText, contents: built.contents };
  const v = validate(message);
  if (!v.ok) {
    log.warn(`${name}: dropped card — ${v.errors.join('; ')}`);
    return { message: null, fallback, errors: v.errors, bytes: v.bytes };
  }
  return { message, fallback, errors: [], bytes: v.bytes };
}

function quickReplyItem(q) {
  const action = q.uri
    ? { type: 'uri', label: q.label, uri: q.uri }
    : { type: 'postback', label: q.label, data: q.data, displayText: q.label };
  return { type: 'action', action };
}

function renderOrFallback(card, ctx = {}) {
  const r = render(card, ctx);
  if (r.message) return r.message;
  const msg = { type: 'text', text: r.fallback.text || '…' };
  if (r.fallback.quick_replies.length) msg.quickReply = { items: r.fallback.quick_replies.map(quickReplyItem) };
  return msg;
}

module.exports = { render, renderOrFallback, fallbackFor, TEMPLATES };
