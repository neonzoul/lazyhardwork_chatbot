const test = require('node:test');
const assert = require('node:assert/strict');
const topics = require('../../src/flows/topics');
const quiet = require('../../src/identity/quiet');
const handoff = require('../../src/flows/handoff');
const { normalise } = require('../../src/line/events');
const msg = require('../../src/line/messages');
const { createDebouncer } = require('../../src/core/debounce');
const session = require('../../src/core/session');
const { createFakeClock } = require('../fakes/clock');

test('follow-up map excludes covered topics and never returns an empty pair while topics remain', () => {
  assert.deepEqual(topics.nextQuickReplies('capability', []), ['เหมาะกับงานผมไหม', 'ราคาเท่าไหร่']);
  assert.deepEqual(topics.nextQuickReplies('capability', ['fit']), ['ราคาเท่าไหร่', 'ใช้เวลานานไหม']);
  assert.deepEqual(topics.nextQuickReplies('pricing', ['pricing', 'timeline', 'howtostart']), ['ทำอะไรได้บ้าง', 'เหมาะกับงานผมไหม']);
  assert.deepEqual(topics.nextTopics('pricing', ['capability', 'fit', 'pricing', 'timeline', 'proof']), ['howtostart']);
});

test('topic detection from labels and free text', () => {
  assert.equal(topics.topicFromText('ราคาเท่าไหร่'), 'pricing');
  assert.equal(topics.topicFromText('ทำเสร็จกี่วันครับ'), 'timeline');
  assert.equal(topics.topicFromText('ขอดูตัวอย่างหน่อย'), 'proof');
  assert.equal(topics.topicFromText('สนใจจ้างครับ'), 'howtostart');
  assert.equal(topics.topicFromText('สวัสดีครับ'), null);
});

test('loose-ends check fires once on a closing signal after two topics', () => {
  const s = { topics_covered: ['pricing', 'capability'], loose_ends_fired: false };
  assert.equal(topics.shouldLooseEnds(s, 'ขอบคุณครับ'), true);
  assert.equal(topics.shouldLooseEnds({ ...s, topics_covered: ['pricing'] }, 'ขอบคุณครับ'), false);
  assert.equal(topics.shouldLooseEnds(s, 'ขอบคุณครับ แล้วราคาล่ะ'), false);
  const r = topics.looseEndsReply(s.topics_covered);
  assert.deepEqual(r.quickReplies, ['เหมาะกับงานผมไหม', 'ใช้เวลานานไหม', 'นัดคุยกับมอส']);
  assert.ok(r.text.includes('2 เรื่อง'));
  assert.deepEqual(topics.looseEndsReply(['capability', 'fit', 'pricing', 'timeline', 'proof']).quickReplies, ['นัดคุยกับมอส']);
});

test('quiet window: เรียก Lay detection and lazy 30-minute expiry', () => {
  assert.equal(quiet.isCallLay({ kind: 'text', text: 'เรียก Lay' }), true);
  assert.equal(quiet.isCallLay({ kind: 'text', text: 'Lay' }), true);
  assert.equal(quiet.isCallLay({ kind: 'text', text: 'เรียกบอท' }), true);
  assert.equal(quiet.isCallLay({ kind: 'text', text: 'เรียก Lay มาช่วยหน่อยได้ไหม' }), false);
  assert.equal(quiet.isCallLay({ kind: 'postback', data: 'CALL_LAY' }), true);
  const clock = createFakeClock('2026-10-18T10:00:00+07:00');
  const s = { mode: 'lay' };
  quiet.enterQuiet(s, clock.now(), 'handoff_human');
  assert.equal(s.mode, 'quiet');
  s.last_customer_at = clock.now().toISOString();
  clock.advanceMinutes(29);
  assert.equal(quiet.resumeIfIdle(s, clock.now()), false);
  clock.advanceMinutes(2);
  assert.equal(quiet.resumeIfIdle(s, clock.now()), true);
  assert.equal(s.mode, 'lay');
});

test('handoff detection', () => {
  assert.equal(handoff.isAskHuman('ขอคุยกับคนจริงหน่อย'), true);
  assert.equal(handoff.isAskHuman('อยากคุยกับมอสครับ'), true);
  assert.equal(handoff.isAskHuman('คุยกับมอส'), true);
  assert.equal(handoff.isAskHuman('ราคาเท่าไหร่'), false);
  assert.equal(handoff.isSpecialPrice('ลดได้ไหมครับ'), true);
  assert.equal(handoff.isSpecialPrice('ราคาเริ่มต้นเท่าไหร่'), false);
});

test('performHandoff tells the truth when the notifier fails and never enters quiet', async () => {
  const clock = createFakeClock();
  const events = [];
  const deps = { notifier: { handoff: async () => { throw new Error('discord down'); } }, store: { events: { append: async (e) => events.push(e) } }, log: { error() {} } };
  const config = { contact: { phoneDisplay: '095 569 1674 (มอส)' } };
  const s = { user_id: 'U1', mode: 'lay' };
  const r = await handoff.performHandoff({ kind: 'handoff_human', session: s, deps, config, now: clock.now() });
  assert.equal(r.ok, false);
  assert.match(r.text, /095 569 1674/);
  assert.doesNotMatch(r.text, /ส่งเรื่องให้มอสแล้ว/);
  assert.equal(s.mode, 'lay');
  assert.equal(events[0].kind, 'handoff_notify_failed');
  const ok = await handoff.performHandoff({ kind: 'handoff_human', session: s, deps: { ...deps, notifier: { handoff: async () => ({ threadId: 'T9' }) } }, config, now: clock.now() });
  assert.equal(ok.ok, true);
  assert.equal(s.mode, 'quiet');
  assert.equal(s.discord_thread_id, 'T9');
  assert.deepEqual(ok.quickReplies, ['เรียก Lay']);
});

test('event normalisation and message builders', () => {
  const ev = normalise({ type: 'message', message: { type: 'text', text: 'hi', id: '1' }, source: { type: 'user', userId: 'U1' }, replyToken: 'rt', timestamp: 5, webhookEventId: 'w', deliveryContext: { isRedelivery: true } });
  assert.equal(ev.kind, 'text'); assert.equal(ev.isRedelivery, true); assert.equal(ev.chatType, 'user');
  assert.equal(normalise({ type: 'message', message: { type: 'image' }, source: { type: 'group', groupId: 'C1', userId: 'U1' } }).kind, 'media');
  assert.equal(normalise({ type: 'postback', postback: { data: 'FIT_x' }, source: { type: 'user', userId: 'U1' } }).data, 'FIT_x');
  assert.equal(normalise({ type: 'beacon', source: { type: 'user', userId: 'U1' } }), null);

  const m = msg.text('x', { sender: { name: 'Lay · ผู้ช่วย AI', iconUrl: 'https://a/b.png' }, quickReplies: ['ก', { label: 'ข', data: 'D' }, { label: 'เว็บ', uri: 'https://x' }, 'ง', 'จ'] });
  assert.equal(m.sender.name, 'Lay · ผู้ช่วย AI');
  assert.equal(m.quickReply.items.length, 4);
  assert.equal(m.quickReply.items[1].action.type, 'postback');
  assert.equal(msg.clipLabel('กขคงจฉชซฌญฎฏฐฑฒณดตถทธนบ').length <= 20, true);
  const list = msg.attachQuickReplies([msg.text('a'), msg.text('b')], ['x'], { name: 'มอส' });
  assert.equal(list[0].quickReply, undefined); assert.equal(list[1].quickReply.items.length, 1); assert.equal(list[0].sender.name, 'มอส');
});

test('debouncer joins a burst into one turn', async () => {
  const flushed = [];
  let cb; const timers = { set: (fn) => { cb = fn; return 1; }, clear: () => {} };
  const d = createDebouncer({ ms: 10, timers, onFlush: async (m) => flushed.push(m) });
  d.push({ userId: 'U1', kind: 'text', text: 'สวัสดี', replyToken: 'a', timestamp: 1 });
  d.push({ userId: 'U1', kind: 'text', text: 'ราคาเท่าไหร่', replyToken: 'b', timestamp: 2 });
  await cb();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].text, 'สวัสดี\nราคาเท่าไหร่');
  assert.equal(flushed[0].replyToken, 'b');
  assert.equal(flushed[0].burstCount, 2);
});

test('session helpers: topic union and lead merge', () => {
  const s = { topics_covered: ['pricing'], homework: {}, draft: {} };
  session.unionTopics(s, ['fit', 'banter', 'pricing']);
  assert.deepEqual(s.topics_covered, ['pricing', 'fit']);
  const changed = session.mergeLeadUpdates(s, { business: 'ร้านกาแฟ', symptom: 'chat_overload', problem_verbatim: null, name: '' });
  assert.deepEqual(changed, ['business', 'symptom']);
  assert.equal(s.homework.business, 'ร้านกาแฟ'); assert.equal(s.draft.symptom, 'chat_overload');
  assert.ok(session.missingHomework(s).includes('problem_verbatim'));
});
