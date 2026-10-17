'use strict';
/**
 * Design tokens for Lay v2 Flex cards — the ONE place colours, sizes and spacing live.
 * Source: brand CI (lhw-brand-ci-document-standard-2026-10 §2.1) + design-lay-v2 §3.
 * Rule: exactly one emerald element per card. Amber only for "waiting on Mos" states.
 */
const color = Object.freeze({
  bg: '#FAFAF8', // ground — every surface
  ink: '#1B1B1B', // body text
  muted: '#6B6B6B', // captions, labels, declined state
  line: '#E6E4DF', // rules, borders
  emerald: '#0E6E5C', // the one point where AI acts / primary button
  onEmerald: '#FFFFFF',
  amber: '#B8860B', // waiting on a person
  amberBg: '#FFF4D6',
  success: '#1F7A4D', // confirmed
  successBg: '#E6F4EC',
  mutedBg: '#EFEDE7', // declined pill ground
});

const size = Object.freeze({
  title: 'lg',
  body: 'sm',
  caption: 'xs',
  price: 'md',
  bubble: 'kilo',
  bubbleWide: 'mega',
  button: 'sm',
});

const space = Object.freeze({
  bubblePad: '20px',
  footerPad: '16px',
  boxPad: '12px',
  pillPadY: '6px',
  pillPadX: '12px',
  radius: '8px',
  pill: '999px',
  border: '1px',
  gapXs: 'xs',
  gapSm: 'sm',
  gapMd: 'md',
});

const limits = Object.freeze({
  altTextMax: 400, // our rule (LINE 1500)
  bubbleBytesMax: 30 * 1024,
  carouselBytesMax: 50 * 1024,
  carouselBubblesMax: 10, // our rule (LINE 12)
  actionLabelMax: 20, // code points
  postbackDataMax: 300,
  displayTextMax: 300,
  quickRepliesMax: 4, // our rule (LINE 13)
});

module.exports = { color, size, space, limits };
