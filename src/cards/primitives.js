'use strict';
/**
 * Flex building blocks shared by every template. Every text component sets `wrap: true`.
 * Nothing here knows about templates, prices or URLs.
 */
const { color, size, space, limits } = require('./tokens');

const EMOJI_SRC = '\\p{Extended_Pictographic}|\\uFE0F|\\u200D|[\\u{1F1E6}-\\u{1F1FF}]';

function codePoints(s) {
  return Array.from(String(s)).length;
}

function hasEmoji(s) {
  return new RegExp(EMOJI_SRC, 'u').test(String(s));
}

function stripEmoji(s) {
  return String(s)
    .replace(new RegExp(EMOJI_SRC, 'gu'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Shorten to the action-label limit (code points); adds an ellipsis when cut. */
function shortLabel(s, max = limits.actionLabelMax) {
  const cps = Array.from(String(s).trim());
  if (cps.length <= max) return cps.join('');
  return `${cps.slice(0, max - 1).join('').trim()}…`;
}

function text(value, opts = {}) {
  return { type: 'text', text: String(value), wrap: true, color: color.ink, size: size.body, ...opts };
}

function separator() {
  return { type: 'separator', color: color.line };
}

/**
 * Normalise an action spec into a LINE action object.
 *   action = 'POSTBACK_DATA' | {type:'postback', data} | {type:'uri', uri} | {postback} | {url}
 * Postback actions carry `data` as given and `displayText` = the full label.
 */
function toAction(label, action) {
  const full = String(label).trim();
  const short = shortLabel(full);
  if (typeof action === 'string') {
    return { type: 'postback', label: short, data: action, displayText: full };
  }
  if (!action || typeof action !== 'object') {
    throw new Error(`action missing for label "${full}"`);
  }
  const uri = action.uri || action.url;
  if (action.type === 'uri' || (uri && action.data === undefined && action.postback === undefined)) {
    return { type: 'uri', label: short, uri: String(uri) };
  }
  const data = action.data !== undefined ? action.data : action.postback;
  if (data === undefined || data === null) throw new Error(`postback data missing for label "${full}"`);
  return { type: 'postback', label: short, data: String(data), displayText: full };
}

/** Title (+ optional subtitle). `accent: true` draws the one emerald mark for cards with no button. */
function header(title, subtitle, opts = {}) {
  const contents = [];
  if (opts.kicker) contents.push(text(opts.kicker, { size: size.caption, color: color.muted }));
  if (opts.accent) {
    contents.push({
      type: 'box',
      layout: 'vertical',
      width: '28px',
      height: '3px',
      backgroundColor: color.emerald,
      cornerRadius: '2px',
      contents: [],
    });
  }
  contents.push(text(title, { weight: 'bold', size: size.title }));
  if (subtitle) contents.push(text(subtitle, { color: color.muted }));
  return { type: 'box', layout: 'vertical', spacing: space.gapXs, contents };
}

function kvRow(k, v) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: space.gapMd,
    contents: [text(k, { flex: 4, color: color.muted }), text(v, { flex: 7 })],
  };
}

function bulletRow(value) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: space.gapSm,
    contents: [text('•', { flex: 0, color: color.muted }), text(value, { flex: 1 })],
  };
}

function priceRow(label, price, note) {
  const contents = [text(`${label} ${price}`, { weight: 'bold', size: size.price })];
  if (note) contents.push(text(note, { size: size.caption, color: color.muted }));
  return { type: 'box', layout: 'vertical', spacing: space.gapXs, contents };
}

const STATUS = Object.freeze({
  pending: { label: 'รอมอสยืนยัน', fg: color.amber, bg: color.amberBg },
  reproposed: { label: 'มอสเสนอเวลาใหม่', fg: color.amber, bg: color.amberBg },
  confirmed: { label: 'ยืนยันแล้ว', fg: color.success, bg: color.successBg },
  declined: { label: 'ยกเลิกแล้ว', fg: color.muted, bg: color.mutedBg },
});

function statusPill(status) {
  const s = STATUS[status];
  if (!s) throw new Error(`unknown status "${status}"`);
  return {
    type: 'box',
    layout: 'horizontal',
    justifyContent: 'flex-start',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: s.bg,
        cornerRadius: space.pill,
        paddingAll: space.pillPadY,
        paddingStart: space.pillPadX,
        paddingEnd: space.pillPadX,
        contents: [text(s.label, { size: size.caption, color: s.fg, weight: 'bold' })],
      },
    ],
  };
}

function buttonPrimary(label, action) {
  return { type: 'button', style: 'primary', color: color.emerald, height: size.button, action: toAction(label, action) };
}

/** "Outline" look: link-style button inside a 1px bordered box (Flex has no outline style). */
function buttonSecondary(label, action) {
  return {
    type: 'box',
    layout: 'vertical',
    borderWidth: space.border,
    borderColor: color.line,
    cornerRadius: space.radius,
    contents: [{ type: 'button', style: 'link', color: color.ink, height: size.button, action: toAction(label, action) }],
  };
}

/** Tappable box for options longer than 20 chars: full text inside, short label + full displayText on the action. */
function optionBox(label, action, primary) {
  const base = {
    type: 'box',
    layout: 'vertical',
    cornerRadius: space.radius,
    paddingAll: space.boxPad,
    action: toAction(label, action),
  };
  if (primary) {
    return {
      ...base,
      backgroundColor: color.emerald,
      contents: [text(label, { color: color.onEmerald, align: 'center', weight: 'bold' })],
    };
  }
  return { ...base, borderWidth: space.border, borderColor: color.line, contents: [text(label, { align: 'center' })] };
}

function footer(buttons) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: space.gapSm,
    paddingAll: space.footerPad,
    paddingTop: '0px',
    contents: buttons,
  };
}

function bubble({ body, footer: foot, hero, size: bubbleSize = size.bubble }) {
  const b = {
    type: 'bubble',
    size: bubbleSize,
    styles: { body: { backgroundColor: color.bg }, footer: { backgroundColor: color.bg, separator: false } },
  };
  if (hero) b.hero = hero;
  b.body = { type: 'box', layout: 'vertical', spacing: space.gapMd, paddingAll: space.bubblePad, contents: body };
  if (foot && foot.length) b.footer = footer(foot);
  return b;
}

module.exports = {
  text,
  separator,
  header,
  kvRow,
  bulletRow,
  priceRow,
  statusPill,
  buttonPrimary,
  buttonSecondary,
  optionBox,
  footer,
  bubble,
  toAction,
  shortLabel,
  codePoints,
  hasEmoji,
  stripEmoji,
  STATUS,
};
