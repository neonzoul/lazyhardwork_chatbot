const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../../src/store/db');
const { migrate, listMigrations } = require('../../src/store/migrate');
const { createStore } = require('../../src/store');
const { createFakeStore } = require('../fakes/store');
const { createFakeClock } = require('../fakes/clock');
const { ID_RE } = require('../../src/store/repo/leads');

const TABLES = ['sessions', 'messages', 'leads', 'bookings', 'kb_gaps', 'relay_threads', 'outbox', 'events'];

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
}

test('migrate: creates every design §5 table, is idempotent, records schema_migrations', () => {
  const db = openDb(':memory:');
  const first = migrate(db);
  assert.deepEqual(first, listMigrations().map((m) => m.name));
  assert.ok(first.length >= 1);
  for (const t of TABLES) assert.ok(tableNames(db).includes(t), `missing table ${t}`);
  const second = migrate(db);
  assert.deepEqual(second, []);
  const rows = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all();
  assert.equal(rows.length, first.length);
  assert.equal(rows[0].name, '001-init.sql');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_leads_user_id') && idx.includes('idx_messages_user_created') && idx.includes('idx_outbox_status_next'));
  db.close();
});

test('openDb: default/relative path creates the folder and uses WAL; close works', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lay-store-'));
  const file = path.join(dir, 'nested', 'lay.sqlite');
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  db.close();
  assert.ok(fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStore exposes the same method names as the fake (contract check)', () => {
  const real = createStore({ path: ':memory:' });
  const fake = createFakeStore();
  for (const repo of ['sessions', 'messages', 'leads', 'bookings', 'kbGaps', 'events']) {
    for (const m of Object.keys(fake[repo])) {
      assert.equal(typeof real[repo][m], 'function', `${repo}.${m} missing on real store`);
    }
  }
  for (const m of ['byThread', 'byUser', 'create']) assert.equal(typeof real.relayThreads[m], 'function');
  for (const m of ['enqueue', 'nextBatch', 'markSent', 'markFailed']) assert.equal(typeof real.outbox[m], 'function');
  assert.equal(typeof real.close, 'function');
  // every method returns a Promise
  assert.ok(real.sessions.get('nobody') instanceof Promise);
  assert.ok(real.messages.all() instanceof Promise);
  return real.close();
});

test('sessions: getOrCreate defaults match the fake, save round-trips JSON + bools, all()', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00+07:00');
  const store = createStore({ path: ':memory:', clock });
  const fake = createFakeStore();
  assert.equal(await store.sessions.get('U1'), null);
  const s = await store.sessions.getOrCreate('U1');
  const f = await fake.sessions.getOrCreate('U1');
  for (const k of Object.keys(f)) assert.deepEqual(s[k], f[k], `default ${k}`);
  assert.equal(s.created_at, '2026-10-18T03:00:00.000Z');

  s.display_name = 'คุณเอ';
  s.topics_covered = ['pricing', 'timeline'];
  s.draft = { symptom: 'reply_slow', card: 'C2', nested: { tier: 2 } };
  s.homework = { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบไม่ทัน' };
  s.questions_asked = 3;
  s.loose_ends_fired = true;
  s.opened = true;
  s.booking_step = 'window';
  s.mode = 'quiet';
  clock.advanceMinutes(5);
  const saved = await store.sessions.save(s);
  const again = await store.sessions.get('U1');
  assert.deepEqual(again, saved);
  assert.deepEqual(again.topics_covered, ['pricing', 'timeline']);
  assert.deepEqual(again.draft, { symptom: 'reply_slow', card: 'C2', nested: { tier: 2 } });
  assert.deepEqual(again.homework, { business: 'ร้านกาแฟ', problem_verbatim: 'ตอบไม่ทัน' });
  assert.equal(again.loose_ends_fired, true);
  assert.equal(again.opened, true);
  assert.equal(again.display_name, 'คุณเอ');
  assert.equal(again.updated_at, '2026-10-18T03:05:00.000Z');
  assert.equal(again.created_at, '2026-10-18T03:00:00.000Z');

  // getOrCreate does not reset an existing session
  assert.deepEqual(await store.sessions.getOrCreate('U1'), again);
  await store.sessions.getOrCreate('U2');
  assert.deepEqual((await store.sessions.all()).map((x) => x.user_id).sort(), ['U1', 'U2']);
  await assert.rejects(store.sessions.save({ user_id: 'U1', mode: 'bogus' }), /invalid mode/);
  await assert.rejects(store.sessions.save({}), /user_id/);
  await store.close();
});

test('messages: append returns the row with id, recent(userId, n) is the chronological tail', async () => {
  const store = createStore({ path: ':memory:' });
  for (let i = 1; i <= 15; i++) {
    await store.messages.append({ user_id: 'U1', role: i % 2 ? 'customer' : 'lay', text: `m${i}`, payload: i === 15 ? { card: 'offer' } : undefined });
  }
  await store.messages.append({ user_id: 'U2', role: 'customer', text: 'other', reply_token_used: true, kind: 'postback' });
  const recent = await store.messages.recent('U1', 12);
  assert.equal(recent.length, 12);
  assert.equal(recent[0].text, 'm4');
  assert.equal(recent[11].text, 'm15');
  assert.deepEqual(recent[11].payload, { card: 'offer' });
  assert.equal(recent[0].payload, null);
  assert.equal((await store.messages.recent('U1')).length, 12); // default n
  const u2 = await store.messages.recent('U2', 5);
  assert.equal(u2.length, 1);
  assert.equal(u2[0].reply_token_used, true);
  assert.equal(u2[0].kind, 'postback');
  assert.equal(typeof u2[0].id, 'number');
  assert.equal((await store.messages.all()).length, 16);
  await assert.rejects(store.messages.append({ user_id: 'U1' }), /role/);
  await store.close();
});

test('leads: id format, upsert merge, byUser, since(iso) filtering, all', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00+07:00');
  const store = createStore({ path: ':memory:', clock });
  const a = await store.leads.upsert({ user_id: 'U1', symptom: 'reply_slow', customer_words_th: 'ตอบลูกค้าไม่ทัน', homework: { business: 'คาเฟ่' } });
  assert.match(a.id, ID_RE);
  assert.match(a.id, /^L-2026-10-18-line_oa-[a-z0-9]{6}$/);
  assert.equal(a.status, 'new');
  assert.equal(a.source, 'line_oa');
  assert.deepEqual(a.homework, { business: 'คาเฟ่' });
  assert.equal(a.created_at, '2026-10-18T03:00:00.000Z');

  clock.advanceMinutes(10);
  const a2 = await store.leads.upsert({ id: a.id, status: 'qualified', card_id: 'C2' });
  assert.equal(a2.id, a.id);
  assert.equal(a2.symptom, 'reply_slow'); // merged, not replaced
  assert.equal(a2.card_id, 'C2');
  assert.equal(a2.status, 'qualified');
  assert.equal(a2.created_at, a.created_at);
  assert.equal(a2.updated_at, '2026-10-18T03:10:00.000Z');
  assert.deepEqual(await store.leads.byUser('U1'), a2);
  assert.equal(await store.leads.byUser('nobody'), null);

  clock.advanceMinutes(10);
  const b = await store.leads.upsert({ user_id: 'U2' });
  assert.notEqual(b.id, a.id);

  const sinceAll = await store.leads.since('2026-10-18T00:00:00Z');
  assert.deepEqual(sinceAll.map((l) => l.id), [a.id, b.id]);
  const sinceLater = await store.leads.since('2026-10-18T03:15:00.000Z');
  assert.deepEqual(sinceLater.map((l) => l.id), [b.id]);
  assert.deepEqual(await store.leads.since('2027-01-01T00:00:00Z'), []);
  assert.equal((await store.leads.since()).length, 2);
  assert.equal((await store.leads.all()).length, 2);

  // explicit id is kept; invalid status rejected
  const c = await store.leads.upsert({ id: 'L-2026-10-01-line_oa-abc123', user_id: 'U3' });
  assert.equal(c.id, 'L-2026-10-01-line_oa-abc123');
  await assert.rejects(store.leads.upsert({ user_id: 'U4', status: 'won' }), /invalid status/);
  await assert.rejects(store.leads.upsert({ symptom: 'x' }), /user_id/);
  await store.close();
});

test('bookings: create/get/update/pendingFor/forLead/all with JSON fields', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00+07:00');
  const store = createStore({ path: ':memory:', clock });
  const lead = await store.leads.upsert({ user_id: 'U1' });
  assert.equal(await store.bookings.pendingFor('U1'), null);
  const b = await store.bookings.create({ user_id: 'U1', lead_id: lead.id, window_text: 'พรุ่งนี้ 14:00', fields: { phone_ok: true }, proposed_windows: ['14:00', '16:00'] });
  assert.match(b.id, /^B-2026-10-18-[a-z0-9]{6}$/);
  assert.equal(b.status, 'pending');
  assert.deepEqual(b.fields, { phone_ok: true });
  assert.deepEqual(b.proposed_windows, ['14:00', '16:00']);
  assert.deepEqual(await store.bookings.get(b.id), b);
  assert.deepEqual(await store.bookings.pendingFor('U1'), b);
  clock.advanceMinutes(1);
  const u = await store.bookings.update(b.id, { status: 'confirmed', decided_by: 'mos', decided_at: clock.now().toISOString() });
  assert.equal(u.status, 'confirmed');
  assert.equal(u.decided_by, 'mos');
  assert.deepEqual(u.fields, { phone_ok: true });
  assert.equal(await store.bookings.pendingFor('U1'), null);
  assert.equal((await store.bookings.forLead(lead.id)).length, 1);
  assert.equal((await store.bookings.all()).length, 1);
  assert.equal(await store.bookings.get('B-none'), null);
  await assert.rejects(store.bookings.update('B-none', { status: 'declined' }), /no booking/);
  await assert.rejects(store.bookings.update(b.id, { status: 'maybe' }), /invalid status/);
  await store.close();
});

test('kbGaps and events: append/all with JSON payloads', async () => {
  const store = createStore({ path: ':memory:' });
  await store.kbGaps.append({ user_id: 'U1', question: 'รับทำเว็บไหม', kb_refs_tried: ['services', 'pricing'], forwarded: true });
  await store.kbGaps.append({ question: 'anon' });
  const gaps = await store.kbGaps.all();
  assert.equal(gaps.length, 2);
  assert.deepEqual(gaps[0].kb_refs_tried, ['services', 'pricing']);
  assert.equal(gaps[0].forwarded, true);
  assert.equal(gaps[1].user_id, null);
  assert.deepEqual(gaps[1].kb_refs_tried, []);

  await store.events.append({ kind: 'policy_violation', user_id: 'U1', payload: { rule: 'emoji', text: 'x' } });
  await store.events.append({ kind: 'model_fallback', reason: 'schema', attempt: 2 }); // flat fields ride in payload
  await store.events.append({ kind: 'error' });
  const ev = await store.events.all();
  assert.equal(ev.length, 3);
  assert.deepEqual(ev[0].payload, { rule: 'emoji', text: 'x' });
  assert.deepEqual(ev[1].payload, { reason: 'schema', attempt: 2 });
  assert.equal(ev[1].user_id, null);
  assert.equal(ev[2].payload, null);
  assert.deepEqual((await store.events.recent(2)).map((e) => e.kind), ['model_fallback', 'error']);
  await assert.rejects(store.events.append({}), /kind/);
  await assert.rejects(store.kbGaps.append({}), /question/);
  await store.close();
});

test('relayThreads: create/byThread/byUser (latest wins)', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00+07:00');
  const store = createStore({ path: ':memory:', clock });
  const t1 = await store.relayThreads.create({ discord_thread_id: '111', user_id: 'U1', lead_id: 'L-x', opened_for: 'handoff' });
  assert.deepEqual(t1, { discord_thread_id: '111', user_id: 'U1', lead_id: 'L-x', opened_for: 'handoff', created_at: '2026-10-18T03:00:00.000Z' });
  clock.advanceMinutes(2);
  await store.relayThreads.create({ discord_thread_id: 222, user_id: 'U1', opened_for: 'booking' });
  assert.deepEqual(await store.relayThreads.byThread('111'), t1);
  assert.equal((await store.relayThreads.byThread(222)).opened_for, 'booking');
  assert.equal((await store.relayThreads.byUser('U1')).discord_thread_id, '222');
  assert.equal(await store.relayThreads.byThread('nope'), null);
  assert.equal(await store.relayThreads.byUser('nope'), null);
  await assert.rejects(store.relayThreads.create({ discord_thread_id: '333', user_id: 'U1', opened_for: 'chat' }), /opened_for/);
  await assert.rejects(store.relayThreads.create({ discord_thread_id: '111', user_id: 'U9' }), /UNIQUE|PRIMARY/i);
  await store.close();
});

test('outbox: enqueue → nextBatch → markFailed (backoff) → markSent; exhausted → failed', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00+07:00');
  const store = createStore({ path: ':memory:', clock });
  const a = await store.outbox.enqueue({ kind: 'discord_notify', payload: { thread: '1', text: 'hi' } });
  const b = await store.outbox.enqueue({ kind: 'line_push', payload: { to: 'U1', messages: [] } });
  assert.equal(a.status, 'pending');
  assert.equal(a.attempts, 0);
  assert.deepEqual(a.payload, { thread: '1', text: 'hi' });

  let batch = await store.outbox.nextBatch(10);
  assert.deepEqual(batch.map((x) => x.id), [a.id, b.id]);
  assert.equal((await store.outbox.nextBatch(1)).length, 1);

  const failedOnce = await store.outbox.markFailed(a.id, new Error('discord 500'));
  assert.equal(failedOnce.status, 'pending');
  assert.equal(failedOnce.attempts, 1);
  assert.equal(failedOnce.last_error, 'discord 500');
  assert.equal(failedOnce.next_attempt_at, '2026-10-18T03:00:30.000Z');
  // not due yet → only b
  assert.deepEqual((await store.outbox.nextBatch(10)).map((x) => x.id), [b.id]);
  clock.advanceMinutes(1);
  assert.deepEqual((await store.outbox.nextBatch(10)).map((x) => x.id), [a.id, b.id]);

  const sent = await store.outbox.markSent(b.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sent_at, clock.now().toISOString());
  assert.deepEqual((await store.outbox.nextBatch(10)).map((x) => x.id), [a.id]);

  for (let i = 0; i < 4; i++) await store.outbox.markFailed(a.id, 'still down');
  const dead = await store.outbox.get(a.id);
  assert.equal(dead.status, 'failed');
  assert.equal(dead.attempts, 5);
  assert.equal(dead.next_attempt_at, null);
  clock.advanceMinutes(24 * 60);
  assert.deepEqual(await store.outbox.nextBatch(10), []);
  assert.equal((await store.outbox.all()).length, 2);
  await assert.rejects(store.outbox.enqueue({ kind: 'sms' }), /invalid kind/);
  await store.close();
});

test('close(): is idempotent and later calls reject instead of throwing', async () => {
  const store = createStore({ path: ':memory:' });
  await store.close();
  await store.close();
  await assert.rejects(store.sessions.get('U1'));
});
