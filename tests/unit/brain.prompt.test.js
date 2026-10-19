const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt, buildDemoSystemPrompt, buildMessages, STATIC_PREFIX, HISTORY_CAP } = require('../../src/brain/prompt');
const { EXAMPLES } = require('../../src/brain/examples');

const kb = [
  { id: 'about.what-we-do', text: 'สตูดิโอเล็กๆ ที่ช่วยธุรกิจไทยนำ AI มาใช้' },
  { id: 'faq.price-range', text: 'แล้วแต่งานครับ ราคาเริ่มต้น 4,900 บาท' },
];
const config = { contact: { hoursStart: 13, hoursEnd: 22 } };

test('static prefix is byte-identical across calls and comes first', () => {
  const a = buildSystemPrompt({ kbSelection: kb, session: { topics_covered: ['pricing'] }, now: new Date('2026-10-17T03:00:00Z'), config });
  const b = buildSystemPrompt({ kbSelection: [], session: { mode: 'quiet', draft: { card: 'A2' } }, intentHint: 'fit', now: new Date('2026-10-18T15:00:00Z'), config });
  assert.ok(a.startsWith(STATIC_PREFIX));
  assert.ok(b.startsWith(STATIC_PREFIX));
  assert.equal(a.slice(0, STATIC_PREFIX.length), b.slice(0, STATIC_PREFIX.length));
  // nothing dynamic leaks into the prefix
  assert.ok(!STATIC_PREFIX.includes('topics_covered (คุยไปแล้ว'));
  assert.ok(!STATIC_PREFIX.includes('วันเวลา (กรุงเทพฯ)'));
  assert.ok(STATIC_PREFIX.length > 4000, 'prefix is long enough to be worth caching (≥ 1024 tokens)');
});

test('static prefix carries persona, voice, emoji policy, contract, not-list and every example', () => {
  for (const needle of ['Lay', 'ผู้ช่วย AI ของ LazyHardWork', 'นโยบายอีโมจิ', 'รูปแบบคำตอบ', 'สิ่งที่ Lay ไม่ทำ', 'ห้าม markdown', 'kb_refs', 'lead_updates']) {
    assert.ok(STATIC_PREFIX.includes(needle), `prefix missing "${needle}"`);
  }
  for (const ex of EXAMPLES) {
    assert.ok(STATIC_PREFIX.includes(`ลูกค้า: ${ex.user}`), `example ${ex.id} missing`);
    const shown = { ...ex.response, messages: ex.response.messages.map((m) => (m.type === 'card' && m.data && typeof m.data === 'object' ? { ...m, data: JSON.stringify(m.data) } : m)) };
    assert.ok(STATIC_PREFIX.includes(JSON.stringify(shown)), `example ${ex.id} response missing`);
  }
  assert.ok(!STATIC_PREFIX.includes('[Agent Lay] สวัสดี'));
});

test('KB sections are rendered with their ids after the prefix, session facts after the KB, time last', () => {
  const p = buildSystemPrompt({ kbSelection: kb, session: { topics_covered: ['pricing', 'fit'], homework: { team_size: '2', business: null }, questions_asked: 1, draft: { symptom: 'chat_overload' } }, now: new Date('2026-10-17T07:30:00Z'), config });
  const iKb = p.indexOf('### [faq.price-range]');
  const iSess = p.indexOf('## ข้อมูลบทสนทนานี้');
  const iNow = p.indexOf('## ตอนนี้');
  assert.ok(iKb > STATIC_PREFIX.length && iSess > iKb && iNow > iSess);
  assert.ok(p.includes('ราคาเริ่มต้น 4,900 บาท'));
  assert.ok(p.includes('topics_covered (คุยไปแล้ว อย่าเสนอซ้ำเป็นปุ่ม): pricing, fit'));
  assert.ok(p.includes('team_size="2"'));
  assert.ok(!p.includes('business=null'));
  assert.ok(p.includes('symptom="chat_overload"'));
  assert.ok(p.includes('questions_asked (ถามเก็บข้อมูลไปแล้วกี่ข้อ): 1'));
  // 07:30Z = 14:30 Bangkok → in hours
  assert.ok(p.includes('2026-10-17 14:30'));
  assert.ok(p.includes('อยู่ในเวลาทำการ'));
});

test('outside business hours is stated; empty KB says so', () => {
  const p = buildSystemPrompt({ kbSelection: [], session: {}, now: new Date('2026-10-17T17:30:00Z'), config }); // 00:30 Bangkok next day
  assert.ok(p.includes('นอกเวลาทำการ'));
  assert.ok(p.includes('2026-10-18 00:30'));
  assert.ok(p.includes('ไม่มีหัวข้อที่เกี่ยวข้อง'));
});

test('tell_me_more anchors on the previous answer\'s kb_refs', () => {
  const p = buildSystemPrompt({ kbSelection: kb, session: { last_kb_refs: ['faq.price-range', 'offer.A2.T1'] }, intentHint: 'tell_me_more', now: new Date(), config });
  const anchor = 'ข้อความนี้เป็นการถามต่อจากคำตอบก่อนหน้าของคุณ';
  assert.ok(p.includes(anchor));
  assert.ok(p.includes('faq.price-range, offer.A2.T1'));
  assert.ok(p.indexOf(anchor) > STATIC_PREFIX.length, 'anchor lives in the dynamic tail');
  const q = buildSystemPrompt({ kbSelection: kb, session: {}, intentHint: 'pricing', now: new Date(), config });
  assert.ok(!q.includes(anchor));
  assert.ok(q.includes('intent ที่ระบบคาดไว้จากข้อความนี้: pricing'));
});

test('demo prompt labels itself ร้านตัวอย่าง, never a real shop, same contract', () => {
  const p = buildDemoSystemPrompt({ shop: 'cafe', shopKb: [{ id: 'examples.demo-cafe.menu', text: 'อเมริกาโน่ร้อน 55 บาท' }] });
  assert.ok(p.includes('ร้านตัวอย่าง'));
  assert.ok(p.includes('ร้านกาแฟตัวอย่าง · ผู้ช่วย AI'));
  assert.ok(p.includes('ไม่อ้างว่าเป็นร้านจริง'));
  assert.ok(p.includes('ไม่รับเงินจริง'));
  assert.ok(p.includes('### [examples.demo-cafe.menu]'));
  assert.ok(p.includes('"intent" เป็น "demo"'));
  assert.ok(p.includes('demo_exit'));
  assert.ok(p.includes('กลับไปคุยกับ Lay'));
  const named = buildDemoSystemPrompt({ shop: { key: 'cafe', name: 'คาเฟ่ริมคลอง' }, shopKb: 'เมนู: ลาเต้ 70 บาท' });
  assert.ok(named.includes('คาเฟ่ริมคลอง (ร้านตัวอย่าง) · ผู้ช่วย AI'));
  assert.ok(named.includes('ลาเต้ 70 บาท'));
  assert.ok(buildDemoSystemPrompt({ shop: 'clinic' }).includes('คลินิกตัวอย่าง'));
});

test('buildMessages maps roles, labels Mos, caps history at 12 and ends with the user text', () => {
  const history = [];
  for (let i = 0; i < 20; i++) history.push({ role: i % 2 ? 'lay' : 'customer', text: `m${i}` });
  history.push({ role: 'mos', text: 'ผมมอสเองครับ' });
  history.push({ role: 'demo_shop', text: 'รับออเดอร์ครับ' });
  history.push({ role: 'customer', text: '   ' }); // blank → dropped
  const msgs = buildMessages({ systemPrompt: 'SYS', history, userText: 'ราคาเท่าไหร่' });
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'SYS');
  assert.equal(msgs.length, 1 + HISTORY_CAP + 1);
  assert.equal(msgs.at(-1).role, 'user');
  assert.equal(msgs.at(-1).content, 'ราคาเท่าไหร่');
  assert.equal(msgs.at(-2).content, 'รับออเดอร์ครับ');
  assert.equal(msgs.at(-2).role, 'assistant');
  assert.equal(msgs.at(-3).content, '(ข้อความจากมอส) ผมมอสเองครับ');
  assert.equal(msgs.at(-3).role, 'assistant');
  assert.equal(msgs[1].content, 'm10');
  assert.equal(msgs[1].role, 'user');
  // no user text (postback-driven turn) → no trailing user message
  assert.equal(buildMessages({ systemPrompt: 'S', history: [{ role: 'customer', text: 'hi' }] }).length, 2);
});
