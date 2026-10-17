'use strict';
/**
 * Offline validator for a Flex message — catches the LINE rejections (and our own rules) we can
 * predict before send. Limits: doc/line-platform-notes.md §4–5 + tokens.limits.
 *
 *   validate(message) → { ok, errors: string[], bytes }
 */
const { color, limits } = require('./tokens');
const { codePoints, hasEmoji } = require('./primitives');

const ACTION_TYPES = new Set(['postback', 'uri', 'message', 'datetimepicker', 'clipboard']);

function walk(node, visit, path = '$') {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, visit, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    visit(node, path);
    for (const [k, v] of Object.entries(node)) walk(v, visit, `${path}.${k}`);
  }
}

function isHttps(u) {
  return typeof u === 'string' && /^https:\/\/\S+$/i.test(u);
}

/** First text component found in a bubble's header/hero/body — our "header title". */
function headerTitleOf(bubble) {
  let found = null;
  walk(bubble.header || bubble.body, (n) => {
    if (!found && n.type === 'text' && typeof n.text === 'string' && n.weight === 'bold') found = n.text;
  });
  if (found == null) {
    walk(bubble.body, (n) => {
      if (!found && n.type === 'text') found = n.text;
    });
  }
  return found;
}

function validateBubble(b, i, errors) {
  const where = `bubble[${i}]`;
  if (!b || b.type !== 'bubble') {
    errors.push(`${where}: not a bubble`);
    return;
  }
  if (!b.body) errors.push(`${where}: no body`);
  const bytes = Buffer.byteLength(JSON.stringify(b), 'utf8');
  if (bytes > limits.bubbleBytesMax) errors.push(`${where}: ${bytes} bytes (max ${limits.bubbleBytesMax})`);

  let emeraldCount = 0;
  walk(b, (node, path) => {
    if (node.type === 'text') {
      if (typeof node.text !== 'string' || node.text.trim() === '') errors.push(`${path}: empty text`);
      if (node.wrap !== true) errors.push(`${path}: text without wrap:true`);
    }
    if (node.type === 'image' && !isHttps(node.url)) errors.push(`${path}: image url must be https`);
    if (node.type === 'button') {
      if (!node.action || typeof node.action.label !== 'string' || !node.action.label.trim()) {
        errors.push(`${path}: button without label`);
      }
      if (node.style === 'primary' || node.color === color.emerald) emeraldCount += 1;
    } else if (node.backgroundColor === color.emerald || (node.type === 'text' && node.color === color.emerald)) {
      emeraldCount += 1;
    }
    if (ACTION_TYPES.has(node.type) && node.label !== undefined) {
      const n = codePoints(node.label);
      if (n === 0) errors.push(`${path}: empty action label`);
      if (n > limits.actionLabelMax) errors.push(`${path}: action label "${node.label}" is ${n} chars (max ${limits.actionLabelMax})`);
    }
    if (node.type === 'uri' && !isHttps(node.uri)) errors.push(`${path}: uri action must be https`);
    if (node.type === 'postback') {
      if (typeof node.data !== 'string' || !node.data) errors.push(`${path}: postback without data`);
      else if (node.data.length > limits.postbackDataMax) errors.push(`${path}: postback data > ${limits.postbackDataMax}`);
      if (node.displayText && codePoints(node.displayText) > limits.displayTextMax) {
        errors.push(`${path}: displayText > ${limits.displayTextMax}`);
      }
    }
  });
  if (emeraldCount > 1) errors.push(`${where}: ${emeraldCount} primary-coloured elements (max 1)`);

  const title = headerTitleOf(b);
  if (title && hasEmoji(title)) errors.push(`${where}: emoji in header title "${title}"`);
}

function validate(message) {
  const errors = [];
  if (!message || message.type !== 'flex') errors.push('message.type must be "flex"');
  const alt = message && message.altText;
  if (typeof alt !== 'string' || !alt.trim()) errors.push('altText is empty');
  else if (codePoints(alt) > limits.altTextMax) errors.push(`altText is ${codePoints(alt)} chars (max ${limits.altTextMax})`);

  const contents = message && message.contents;
  let bytes = 0;
  if (!contents || typeof contents !== 'object') {
    errors.push('contents missing');
    return { ok: false, errors, bytes };
  }
  bytes = Buffer.byteLength(JSON.stringify(contents), 'utf8');

  if (contents.type === 'carousel') {
    const bubbles = Array.isArray(contents.contents) ? contents.contents : [];
    if (bubbles.length === 0) errors.push('carousel is empty');
    if (bubbles.length > limits.carouselBubblesMax) {
      errors.push(`carousel has ${bubbles.length} bubbles (max ${limits.carouselBubblesMax})`);
    }
    if (bytes > limits.carouselBytesMax) errors.push(`carousel is ${bytes} bytes (max ${limits.carouselBytesMax})`);
    const sizes = new Set(bubbles.map((b) => b && b.size));
    if (sizes.size > 1) errors.push('carousel bubbles must share one size');
    bubbles.forEach((b, i) => validateBubble(b, i, errors));
  } else if (contents.type === 'bubble') {
    validateBubble(contents, 0, errors);
  } else {
    errors.push(`contents.type "${contents.type}" is not bubble|carousel`);
  }

  return { ok: errors.length === 0, errors, bytes };
}

module.exports = { validate, walk };
