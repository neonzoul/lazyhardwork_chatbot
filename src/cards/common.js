'use strict';
/** Helpers shared by the templates: title hygiene, logging, list bounds, option helpers. */
const { hasEmoji, stripEmoji, codePoints } = require('./primitives');
const { limits } = require('./tokens');

function logger(ctx) {
  const l = ctx && ctx.log;
  return {
    warn: (...a) => (l && typeof l.warn === 'function' ? l.warn(...a) : console.warn('[cards]', ...a)),
  };
}

/** Titles never carry emoji: strip and log. Throws on an empty result so render falls back. */
function cleanTitle(value, ctx, where = 'title') {
  let t = String(value == null ? '' : value).trim();
  if (hasEmoji(t)) {
    logger(ctx).warn(`emoji stripped from ${where}: "${t}"`);
    t = stripEmoji(t);
  }
  if (!t) throw new Error(`${where} is empty`);
  return t;
}

function need(data, key, where) {
  if (data == null || data[key] == null || data[key] === '') throw new Error(`${where}: "${key}" missing`);
  return data[key];
}

function list(data, key, min, max, where) {
  const v = need(data, key, where);
  if (!Array.isArray(v) || v.length < min) throw new Error(`${where}: "${key}" needs ${min}-${max} items`);
  return v.slice(0, max);
}

/** Every option/cta is {label, postback|data|url|uri}. Label longer than 20 code points → needs a box. */
function labelTooLong(label) {
  return codePoints(label) > limits.actionLabelMax;
}

function actionOf(opt) {
  if (opt.url || opt.uri) return { type: 'uri', uri: opt.url || opt.uri };
  return { type: 'postback', data: opt.postback != null ? opt.postback : opt.data };
}

module.exports = { logger, cleanTitle, need, list, labelTooLong, actionOf };
