// brain/keys: rotation, exhaustion, reset at UTC midnight, recovery hooks (doc/llm.md §5).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyring, nextUtcMidnight, mask } = require('../../src/brain/keys');
const { createFakeClock } = require('../fakes/clock');

const KEYS = ['sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa0001', 'sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbb0002', 'sk-or-v1-cccccccccccccccccccccccc0003'];

test('current() returns keys in order; blanks are dropped; labels are masked', () => {
  const k = createKeyring({ keys: [KEYS[0], '', undefined, KEYS[1]] });
  assert.equal(k.size, 2);
  assert.equal(k.current().index, 0);
  assert.equal(k.current().key, KEYS[0]);
  const st = k.status();
  assert.equal(st.exhausted, false);
  assert.equal(st.configured, true);
  for (const e of st.keys) { assert.ok(!e.label.includes('aaaaaaaaaaaa')); assert.ok(!JSON.stringify(e).includes(KEYS[0])); }
  assert.equal(mask('short'), 'sh…');
});

test('markExhausted: daily ⇒ retry at next 00:00 UTC; the key comes back when the clock passes it', () => {
  const clock = createFakeClock('2026-10-18T15:00:00Z');
  const k = createKeyring({ keys: [KEYS[0], KEYS[1]], clock });
  const r = k.markExhausted(0, '402 key limit', { limitReset: 'daily' });
  assert.equal(r.retryAt.toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(k.current().index, 1, 'the spare key is now current');
  assert.equal(k.status().keys[0].exhausted, true);
  assert.equal(k.status().usable, 1);
  clock.set('2026-10-19T00:00:01Z');
  assert.equal(k.current().index, 0, 'restored after the reset');
  assert.equal(k.status().keys[0].exhausted, false);
  assert.equal(nextUtcMidnight(new Date('2026-12-31T23:59:59Z')).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('non-daily limits retry after 60 min; an explicit resetAt wins', () => {
  const clock = createFakeClock('2026-10-18T15:00:00Z');
  const k = createKeyring({ keys: [KEYS[0]], clock });
  assert.equal(k.markExhausted(0, 'x', { limitReset: 'monthly' }).retryAt.toISOString(), '2026-10-18T16:00:00.000Z');
  assert.equal(k.markExhausted(0, 'x', { resetAt: '2026-10-18T18:30:00Z' }).retryAt.toISOString(), '2026-10-18T18:30:00.000Z');
  // a reset time in the past falls back to 60 min, never "retry immediately"
  assert.equal(k.markExhausted(0, 'x', { resetAt: '2026-10-18T10:00:00Z' }).retryAt.toISOString(), '2026-10-18T16:00:00.000Z');
});

test('all keys exhausted ⇒ status().exhausted, next_retry_at, onExhausted once; recovery fires onRecovered once', () => {
  const clock = createFakeClock('2026-10-18T15:00:00Z');
  const events = [];
  const k = createKeyring({ keys: [KEYS[0], KEYS[1]], clock, onExhausted: (s) => events.push(['exhausted', s.usable]), onRecovered: (s) => events.push(['recovered', s.usable]) });
  assert.equal(k.rotate('402').index, 1, 'rotate marks the current key and returns the spare');
  assert.equal(k.status().exhausted, false);
  assert.equal(k.rotate('402'), null, 'no spare left');
  const st = k.status();
  assert.equal(st.exhausted, true);
  assert.equal(st.usable, 0);
  assert.equal(st.next_retry_at, '2026-10-19T00:00:00.000Z');
  assert.ok(st.all_exhausted_since);
  assert.equal(k.current(), null);
  assert.deepEqual(events, [['exhausted', 0]]);
  k.markExhausted(1, 'again'); // no second hook while already all-out
  assert.deepEqual(events, [['exhausted', 0]]);
  clock.set('2026-10-19T00:00:00Z');
  assert.equal(k.current().index, 0);
  assert.deepEqual(events, [['exhausted', 0], ['recovered', 2]]);
  assert.equal(k.status().all_exhausted_since, null);
});

test('an empty keyring reports exhausted + unconfigured; setInfo/keyAt round-trip', () => {
  const none = createKeyring({ keys: [] });
  assert.equal(none.size, 0);
  assert.equal(none.current(), null);
  assert.equal(none.status().exhausted, true);
  assert.equal(none.status().configured, false);
  const k = createKeyring({ keys: [KEYS[2]] });
  k.setInfo(0, { limit: 15, limit_remaining: 3 });
  assert.deepEqual(k.status().keys[0].info, { limit: 15, limit_remaining: 3 });
  assert.equal(k.keyAt(0), KEYS[2]);
  assert.equal(k.keyAt(5), null);
});
