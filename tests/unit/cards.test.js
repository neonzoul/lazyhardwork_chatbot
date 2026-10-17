'use strict';
/**
 * Lay v2 card renderer — every template builds from sample Thai data, validates, and matches its
 * snapshot in tests/unit/__snapshots__/cards.<template>.json.
 *   UPDATE_SNAPSHOTS=1 node --test tests/unit/cards.test.js   → rewrite snapshots
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { render, renderOrFallback, TEMPLATES } = require('../../src/cards/render');
const { validate } = require('../../src/cards/validate');
const P = require('../../src/cards/primitives');
const { color, limits } = require('../../src/cards/tokens');

const SNAP_DIR = path.join(__dirname, '__snapshots__');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const warnings = [];
const ctx = {
  log: { warn: (m) => warnings.push(m) },
  assets: {
    'example.cafe': 'https://cdn.example.com/lay/example-cafe.png',
    'example.clinic': 'https://cdn.example.com/lay/example-clinic.png',
  },
  fastworkUrlFor: (cardId) => `https://fastwork.co/user/mos_lazyhardwork/${cardId}`,
  priceFor: (cardId, tier) => {
    const table = {
      'A2:starter': { price_from: 4999, label_th: 'Starter — เริ่มต้นใช้งาน' },
      'A2:pro': { price_from: 12900, label_th: 'Pro — ทีมเล็ก' },
    };
    return table[`${cardId}:${tier}`] || null;
  },
};

const SAMPLES = {
  choice: {
    template: 'choice',
    data: {
      title: 'เหมาะกับงานผมไหม',
      subtitle: 'เลือกอาการที่ตรงกับร้านคุณที่สุด',
      options: [
        { label: 'ตอบแชทลูกค้าไม่ทัน', postback: 'FIT_chat_overload' },
        { label: 'ข้อมูลกระจาย ต้องตามงานเอง', postback: 'FIT_scattered_info' },
        { label: 'งานซ้ำ คีย์ซ้ำทุกวัน', postback: 'FIT_repetitive_entry' },
        { label: 'อยากให้ AI รู้จักงานผม', postback: 'FIT_ai_context' },
        { label: 'ยังไม่รู้จะเริ่มตรงไหน', postback: 'FIT_unsure' },
      ],
    },
  },
  compare: {
    template: 'compare',
    data: {
      title: 'Starter กับ Pro ต่างกันตรงไหน',
      columns: [
        {
          name: 'Starter',
          rows: [
            { k: 'โฟลเดอร์', v: 'ไม่เกิน 70 ไฟล์' },
            { k: 'ไฟล์กฎ', v: '1 ไฟล์' },
            { k: 'คำสั่งพร้อมใช้', v: '3 ตัว' },
            { k: 'ดูแลต่อ', v: 'ถามต่อได้ 7 วัน' },
          ],
          price_from: '4,999 บาท',
          cta: { label: 'สนใจ Starter', postback: 'OFFER_A2_starter' },
        },
        {
          name: 'Pro',
          rows: [
            { k: 'โฟลเดอร์', v: 'ไม่เกิน 300 ไฟล์' },
            { k: 'ไฟล์กฎ', v: '3 ไฟล์ แยกตามทีม' },
            { k: 'คำสั่งพร้อมใช้', v: '8 ตัว' },
            { k: 'ดูแลต่อ', v: 'ถามต่อได้ 30 วัน' },
          ],
          price_from: '12,900 บาท',
          cta: { label: 'สนใจ Pro', postback: 'OFFER_A2_pro' },
        },
      ],
    },
  },
  steps: {
    template: 'steps',
    data: {
      title: 'เริ่มงานกับมอสยังไง',
      steps: [
        { title: 'คุย 30 นาที', detail: 'เล่าหน้างานให้ฟัง มอสถามให้ครบ' },
        { title: 'มอสส่งขอบเขตและราคา', detail: 'ภายใน 2 วันทำการ' },
        { title: 'ติดตั้งและสอนใช้', detail: '90 นาทีที่ร้านหรือออนไลน์', ai: true },
        { title: 'ถามต่อได้ 7 วัน', detail: 'ผ่าน LINE นี้' },
      ],
    },
  },
  offer: {
    template: 'offer',
    data: {
      card_id: 'A2',
      tier: 'starter',
      title: 'ตั้งค่า AI Workspace — Starter',
      bullets: ['จัดโฟลเดอร์ไม่เกิน 70 ไฟล์', 'ไฟล์กฎ 1 ไฟล์', 'คำสั่งพร้อมใช้ 3 ตัว', 'ติดตั้ง 90 นาที + ถามต่อ 7 วัน'],
      price_from: 99, // model-supplied — must be ignored
      fastwork_url: 'http://evil.example/not-used', // model-supplied — must be ignored
      note: 'ปรับตามขอบเขตจริงหลังคุย',
      secondary_cta: { label: 'นัดคุยกับมอส', postback: 'BOOK_START' },
    },
  },
  summary_confirm: {
    template: 'summary_confirm',
    data: {
      title: 'ขอนัดคุย 30 นาที',
      fields: [
        { k: 'ชื่อ', v: 'คุณต้น' },
        { k: 'ธุรกิจ', v: 'ร้านกาแฟ 2 สาขา' },
        { k: 'เรื่องที่อยากคุย', v: 'ตอบแชทลูกค้าไม่ทัน อยากให้บอทช่วยตอบ' },
        { k: 'ช่วงเวลาที่สะดวก', v: 'พุธ–ศุกร์ หลัง 14:00' },
      ],
      status: 'pending',
      confirm_postback: 'BOOK_CONFIRM',
      edit_postback: 'BOOK_EDIT',
    },
  },
  examples: {
    template: 'examples',
    data: {
      title: 'ตัวอย่างงานที่ทำไป',
      items: [
        {
          image_key: 'example.cafe',
          title: 'ร้านกาแฟ 2 สาขา',
          line: 'บอทตอบคำถามเมนูและเวลาเปิด ลดแชทค้าง 60%',
          cta: { label: 'ดูเคสนี้', postback: 'CASE_cafe' },
        },
        {
          image_key: 'example.clinic',
          title: 'คลินิกความงาม',
          line: 'จองคิวผ่าน LINE แล้วลงปฏิทินให้อัตโนมัติ',
          cta: { label: 'ดูเคสนี้', postback: 'CASE_clinic' },
        },
      ],
    },
  },
  info: {
    template: 'info',
    data: {
      title: 'ข้อมูลของร้านปลอดภัยไหม',
      rows: [
        { k: 'เก็บที่ไหน', v: 'ในบัญชีของร้านเอง ไม่ใช่ของมอส' },
        { k: 'ใครเห็นบ้าง', v: 'เฉพาะคนที่ร้านให้สิทธิ์' },
        { k: 'เลิกใช้แล้ว', v: 'ลบได้ทันที ไม่มีผูกมัด' },
      ],
      note: 'รายละเอียดเต็มอยู่ในเอกสารส่งมอบ',
    },
  },
};

function readSnap(name) {
  const file = path.join(SNAP_DIR, `cards.${name}.json`);
  if (UPDATE || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSnap(name, message) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(path.join(SNAP_DIR, `cards.${name}.json`), `${JSON.stringify(message, null, 2)}\n`);
}

function bubblesOf(message) {
  return message.contents.type === 'carousel' ? message.contents.contents : [message.contents];
}

function countEmerald(bubble) {
  let n = 0;
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && (node.style === 'primary' || node.color === color.emerald)) n += 1;
    else if (node.backgroundColor === color.emerald || (node.type === 'text' && node.color === color.emerald)) n += 1;
    Object.values(node).forEach(walk);
  })(bubble);
  return n;
}

const sizes = {};

for (const name of Object.keys(TEMPLATES)) {
  test(`template ${name}: builds, validates, matches snapshot`, () => {
    assert.ok(SAMPLES[name], `sample data for ${name}`);
    const r = render(SAMPLES[name], ctx);
    assert.deepEqual(r.errors, []);
    assert.ok(r.message, 'message rendered');
    assert.equal(r.message.type, 'flex');
    assert.ok(r.message.altText.length > 0 && r.message.altText.length <= 400);
    assert.deepEqual(validate(r.message).errors, []);
    for (const b of bubblesOf(r.message)) assert.equal(countEmerald(b), 1, `${name}: exactly one emerald element per bubble`);
    sizes[name] = r.bytes;

    const snap = readSnap(name);
    if (!snap) {
      writeSnap(name, r.message);
    } else {
      assert.deepEqual(r.message, snap, `snapshot mismatch for ${name} (UPDATE_SNAPSHOTS=1 to accept)`);
    }
  });
}

test('bubble sizes: kilo by default, mega for examples', () => {
  for (const name of Object.keys(TEMPLATES)) {
    const r = render(SAMPLES[name], ctx);
    const expected = name === 'examples' ? 'mega' : 'kilo';
    for (const b of bubblesOf(r.message)) assert.equal(b.size, expected, name);
  }
  assert.equal(render(SAMPLES.compare, ctx).message.contents.type, 'carousel');
  assert.equal(render(SAMPLES.examples, ctx).message.contents.type, 'carousel');
});

test('choice: options over 20 chars render as optionBox with short label + full displayText', () => {
  const r = render(SAMPLES.choice, ctx);
  const footer = r.message.contents.footer.contents;
  assert.equal(footer.length, 5);
  for (const box of footer) {
    assert.equal(box.type, 'box');
    assert.equal(box.action.type, 'postback');
    assert.ok(P.codePoints(box.action.label) <= 20);
    assert.equal(box.action.displayText, box.contents[0].text);
  }
  const long = footer[1];
  assert.equal(long.action.displayText, 'ข้อมูลกระจาย ต้องตามงานเอง');
  assert.equal(long.action.data, 'FIT_scattered_info');
  assert.equal(footer[0].backgroundColor, color.emerald, 'first option is the primary box');
  assert.equal(footer[1].borderColor, color.line);
});

test('choice: all options ≤ 20 chars render as buttons (one primary, rest secondary)', () => {
  const card = {
    template: 'choice',
    data: {
      title: 'อยากคุยเรื่องไหนก่อน',
      options: [
        { label: 'ราคา', postback: 'T_pricing' },
        { label: 'ใช้เวลานานไหม', postback: 'T_timeline', primary: true },
        { label: 'เริ่มยังไง', postback: 'T_howtostart' },
      ],
    },
  };
  const r = render(card, ctx);
  assert.deepEqual(r.errors, []);
  const footer = r.message.contents.footer.contents;
  assert.equal(footer[0].type, 'box'); // secondary = bordered box around a link button
  assert.equal(footer[0].contents[0].style, 'link');
  assert.equal(footer[1].type, 'button');
  assert.equal(footer[1].style, 'primary');
  assert.equal(footer[1].action.displayText, 'ใช้เวลานานไหม');
  assert.equal(footer[2].contents[0].style, 'link');
});

test('offer: price and URL come from ctx, model-supplied values are ignored', () => {
  const r = render(SAMPLES.offer, ctx);
  const json = JSON.stringify(r.message);
  assert.ok(json.includes('4,999 บาท'), 'ctx price present');
  assert.ok(!json.includes('99 บาท') || json.includes('4,999 บาท'));
  assert.ok(!/"text":"ราคาเริ่มต้น 99/.test(json), 'model price not rendered');
  assert.ok(!json.includes('evil.example'), 'model URL not rendered');
  const primary = r.message.contents.footer.contents[0];
  assert.equal(primary.action.type, 'uri');
  assert.equal(primary.action.uri, 'https://fastwork.co/user/mos_lazyhardwork/A2');
  assert.ok(r.message.altText.includes('4,999 บาท'));
});

test('offer: unknown card_id/tier → no card, fallback without a fabricated price', () => {
  const r = render({ template: 'offer', data: { ...SAMPLES.offer.data, tier: 'enterprise' } }, ctx);
  assert.equal(r.message, null);
  assert.match(r.errors[0], /no price/);
  assert.ok(!/บาท/.test(r.fallback.text), 'fallback carries no price');
  assert.equal(r.fallback.quick_replies.length, 1); // only the secondary cta
});

test('summary_confirm: status pill and buttons follow the state', () => {
  const base = SAMPLES.summary_confirm.data;
  const pend = render({ template: 'summary_confirm', data: base }, ctx).message;
  assert.ok(JSON.stringify(pend).includes('รอมอสยืนยัน'));
  assert.ok(JSON.stringify(pend).includes(color.amber));
  assert.equal(pend.contents.footer.contents.length, 2);

  const conf = render({ template: 'summary_confirm', data: { ...base, status: 'confirmed' } }, ctx).message;
  assert.ok(JSON.stringify(conf).includes('ยืนยันแล้ว'));
  assert.ok(JSON.stringify(conf).includes(color.success));
  assert.equal(conf.contents.footer, undefined, 'no buttons when confirmed');

  const re = render({ template: 'summary_confirm', data: { ...base, status: 'reproposed' } }, ctx).message;
  assert.ok(JSON.stringify(re).includes('มอสเสนอเวลาใหม่'));

  const dec = render({ template: 'summary_confirm', data: { ...base, status: 'declined' } }, ctx).message;
  assert.ok(JSON.stringify(dec).includes(color.muted));
  assert.equal(dec.contents.footer.contents.length, 1);
  assert.equal(countEmerald(dec.contents), 1);
});

test('titles: emoji are stripped and logged', () => {
  warnings.length = 0;
  const r = render({ template: 'info', data: { ...SAMPLES.info.data, title: '✨ ข้อมูลของร้านปลอดภัยไหม 🚀' } }, ctx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.message.contents.body.contents[0].contents[1].text, 'ข้อมูลของร้านปลอดภัยไหม');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /emoji stripped/);
});

test('every text component sets wrap:true and postbacks echo their label', () => {
  for (const name of Object.keys(TEMPLATES)) {
    const r = render(SAMPLES[name], ctx);
    (function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node.type === 'text') assert.equal(node.wrap, true, `${name}: text wrap`);
      if (node.type === 'postback') assert.ok(node.displayText && node.displayText.length > 0, `${name}: displayText`);
      Object.values(node).forEach(walk);
    })(r.message.contents);
  }
});

// ---------------------------------------------------------------------------
// Validator — each limit caught
// ---------------------------------------------------------------------------
function good() {
  return JSON.parse(JSON.stringify(render(SAMPLES.summary_confirm, ctx).message));
}

test('validator: accepts a good message', () => {
  assert.deepEqual(validate(good()), { ok: true, errors: [], bytes: validate(good()).bytes });
});

test('validator: too-long altText', () => {
  const m = good();
  m.altText = 'ก'.repeat(401);
  const v = validate(m);
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /altText is 401 chars/);
  m.altText = '   ';
  assert.match(validate(m).errors.join('\n'), /altText is empty/);
});

test('validator: text without wrap / empty text', () => {
  const m = good();
  const t = m.contents.body.contents[0].contents[0];
  t.wrap = false;
  assert.match(validate(m).errors.join('\n'), /without wrap:true/);
  t.wrap = true;
  t.text = '';
  assert.match(validate(m).errors.join('\n'), /empty text/);
});

test('validator: http image and http uri rejected', () => {
  const m = JSON.parse(JSON.stringify(render(SAMPLES.examples, ctx).message));
  m.contents.contents[0].hero.url = 'http://cdn.example.com/x.png';
  assert.match(validate(m).errors.join('\n'), /image url must be https/);
  const o = JSON.parse(JSON.stringify(render(SAMPLES.offer, ctx).message));
  o.contents.footer.contents[0].action.uri = 'http://fastwork.co/x';
  assert.match(validate(o).errors.join('\n'), /uri action must be https/);
});

test('validator: two primary buttons in one bubble', () => {
  const m = good();
  m.contents.footer.contents.push(P.buttonPrimary('อีกปุ่ม', 'X'));
  assert.match(validate(m).errors.join('\n'), /2 primary-coloured elements/);
});

test('validator: action label over 20 code points', () => {
  const m = good();
  m.contents.footer.contents[0].action.label = 'ยืนยันการนัดหมายคุยกับมอสวันพุธนี้';
  assert.match(validate(m).errors.join('\n'), /action label .* is \d+ chars \(max 20\)/);
});

test('validator: emoji in header title', () => {
  const m = good();
  m.contents.body.contents[0].contents[0].text = 'ขอนัดคุย 🎉';
  assert.match(validate(m).errors.join('\n'), /emoji in header title/);
});

test('validator: carousel over 10 bubbles and mixed sizes', () => {
  const one = render(SAMPLES.compare, ctx).message.contents.contents[0];
  const m = { type: 'flex', altText: 'x', contents: { type: 'carousel', contents: Array.from({ length: 11 }, () => one) } };
  assert.match(validate(m).errors.join('\n'), /carousel has 11 bubbles \(max 10\)/);
  const mixed = { type: 'flex', altText: 'x', contents: { type: 'carousel', contents: [one, { ...one, size: 'mega' }] } };
  assert.match(validate(mixed).errors.join('\n'), /share one size/);
});

test('validator: oversized bubble', () => {
  const m = good();
  m.contents.body.contents.push(P.text('ก'.repeat(12000)));
  const v = validate(m);
  assert.match(v.errors.join('\n'), /bytes \(max 30720\)/);
});

// ---------------------------------------------------------------------------
// render fallback
// ---------------------------------------------------------------------------
test('render: invalid card → message null + text fallback with ≤4 quick replies', () => {
  const card = { template: 'choice', data: { ...SAMPLES.choice.data, title: '' } };
  const r = render(card, ctx);
  assert.equal(r.message, null);
  assert.ok(r.errors.length > 0);
  assert.equal(r.fallback.quick_replies.length, 4);
  assert.ok(r.fallback.quick_replies.every((q) => P.codePoints(q.label) <= 20 && q.data));
  const msg = renderOrFallback(card, ctx);
  assert.equal(msg.type, 'text');
  assert.equal(msg.quickReply.items.length, 4);
  assert.equal(msg.quickReply.items[0].action.type, 'postback');
  assert.equal(msg.quickReply.items[0].action.data, 'FIT_chat_overload');
});

test('render: unknown template → fallback', () => {
  const r = render({ template: 'carousel_of_doom', alt: 'สวัสดี', data: { title: 'x' } }, ctx);
  assert.equal(r.message, null);
  assert.match(r.errors[0], /unknown template/);
  assert.equal(r.fallback.text, 'สวัสดี');
  assert.equal(renderOrFallback({ template: 'nope', alt: 'สวัสดี', data: {} }, ctx).type, 'text');
});

test('render: examples with a missing asset key → fallback', () => {
  const data = { ...SAMPLES.examples.data, items: [{ ...SAMPLES.examples.data.items[0], image_key: 'nope' }] };
  const r = render({ template: 'examples', data }, ctx);
  assert.equal(r.message, null);
  assert.match(r.errors[0], /no asset/);
});

test('render: a valid message passes through renderOrFallback unchanged', () => {
  const msg = renderOrFallback(SAMPLES.steps, ctx);
  assert.equal(msg.type, 'flex');
});

test('limits exported once from tokens', () => {
  assert.equal(limits.actionLabelMax, 20);
  assert.equal(limits.altTextMax, 400);
  assert.equal(limits.carouselBubblesMax, 10);
});

test.after(() => {
  const lines = Object.entries(sizes).map(([k, v]) => `  ${k.padEnd(16)} ${String(v).padStart(6)} bytes`);
  console.log(`\nFlex JSON sizes (contents only):\n${lines.join('\n')}\n`);
});
