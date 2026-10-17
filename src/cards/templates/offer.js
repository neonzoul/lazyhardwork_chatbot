'use strict';
/**
 * offer — {card_id, tier, title, bullets:[≤5], note?, secondary_cta?:{label, postback}}
 * Price and Fastwork URL come ONLY from ctx by card_id+tier (ctx.priceFor, ctx.fastworkUrlFor).
 * Any price_from / fastwork_url the model put in data is ignored. Primary button = Fastwork link.
 */
const P = require('../primitives');
const { cleanTitle, need, list, actionOf } = require('../common');

function formatPrice(p) {
  if (typeof p === 'number') return `${p.toLocaleString('en-US')} บาท`;
  return String(p);
}

function resolve(data, ctx) {
  const cardId = need(data, 'card_id', 'offer');
  const tier = need(data, 'tier', 'offer');
  if (!ctx || typeof ctx.priceFor !== 'function' || typeof ctx.fastworkUrlFor !== 'function') {
    throw new Error('offer: ctx.priceFor and ctx.fastworkUrlFor are required');
  }
  const price = ctx.priceFor(cardId, tier);
  if (!price || price.price_from == null) throw new Error(`offer: no price for ${cardId}/${tier}`);
  const url = ctx.fastworkUrlFor(cardId);
  if (!url) throw new Error(`offer: no Fastwork URL for ${cardId}`);
  return { price, url };
}

function build(data, ctx) {
  const title = cleanTitle(data.title, ctx, 'offer.title');
  const { price, url } = resolve(data, ctx);
  const bullets = list(data, 'bullets', 1, 5, 'offer');
  const priceText = formatPrice(price.price_from);

  const body = [
    P.header(title, price.label_th),
    P.separator(),
    { type: 'box', layout: 'vertical', spacing: 'sm', contents: bullets.map((b) => P.bulletRow(b)) },
    P.separator(),
    P.priceRow('ราคาเริ่มต้น', priceText, data.note),
  ];
  const footer = [P.buttonPrimary('ดูการ์ดบน Fastwork', { type: 'uri', uri: url })];
  if (data.secondary_cta && data.secondary_cta.label) {
    footer.push(P.buttonSecondary(data.secondary_cta.label, actionOf(data.secondary_cta)));
  }
  return {
    altText: `${title} ราคาเริ่มต้น ${priceText}`,
    contents: P.bubble({ body, footer }),
  };
}

function fallback(data, ctx) {
  let priceLine = '';
  let url = null;
  try {
    const r = resolve(data, ctx);
    priceLine = `ราคาเริ่มต้น ${formatPrice(r.price.price_from)}`;
    url = r.url;
  } catch (e) {
    /* no price available — text still goes out without a number (never fabricate one) */
  }
  const quick = [];
  if (url) quick.push({ label: 'ดูการ์ดบน Fastwork', type: 'uri', uri: url });
  if (data.secondary_cta && data.secondary_cta.label) {
    quick.push({ label: P.shortLabel(data.secondary_cta.label), ...actionOf(data.secondary_cta) });
  }
  return {
    text: [data.title, ...(data.bullets || []).map((b) => `- ${b}`), priceLine, data.note].filter(Boolean).join('\n'),
    quick_replies: quick.slice(0, 4),
  };
}

module.exports = { build, fallback };
