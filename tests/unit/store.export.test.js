const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../../src/store');
const { createFakeStore } = require('../fakes/store');
const { createFakeClock } = require('../fakes/clock');
const { exportLeads } = require('../../src/leads/export');

const SHAPE = ['id', 'status', 'card_id', 'symptom', 'homework', 'customer_words_th', 'wave_group', 'source', 'created_at', 'updated_at', 'contact', 'booking'];

test('exportLeads (real store): shape, contact from session, latest booking, since filter', async () => {
  const clock = createFakeClock('2026-10-18T10:00:00+07:00');
  const store = createStore({ path: ':memory:', clock });
  const s = await store.sessions.getOrCreate('U1');
  await store.sessions.save({ ...s, display_name: 'คุณบี' });
  const lead = await store.leads.upsert({
    user_id: 'U1', status: 'booking_pending', card_id: 'C3', symptom: 'no_followup',
    homework: { business: 'คลินิก', problem_verbatim: 'ลืมตามลูกค้า' }, customer_words_th: 'ลืมตามลูกค้า', wave_group: 'w1',
  });
  await store.bookings.create({ user_id: 'U1', lead_id: lead.id, window_text: 'old', status: 'declined' });
  clock.advanceMinutes(1);
  const b2 = await store.bookings.create({ user_id: 'U1', lead_id: lead.id, window_text: 'จันทร์ 14:00', fields: { ok: 1 } });
  clock.advanceMinutes(60);
  const later = await store.leads.upsert({ user_id: 'U2' }); // no session, no booking

  const all = await exportLeads(store, {});
  assert.equal(all.length, 2);
  assert.deepEqual(Object.keys(all[0]), SHAPE);
  const first = all.find((l) => l.id === lead.id);
  assert.deepEqual(first.contact, { display_name: 'คุณบี', line_user_id: 'U1' });
  assert.equal(first.booking.id, b2.id);
  assert.equal(first.booking.status, 'pending');
  assert.equal(first.booking.window_text, 'จันทร์ 14:00');
  assert.deepEqual(first.booking.fields, { ok: 1 });
  assert.deepEqual(first.homework, { business: 'คลินิก', problem_verbatim: 'ลืมตามลูกค้า' });
  assert.equal(first.status, 'booking_pending');
  assert.equal(first.source, 'line_oa');
  const second = all.find((l) => l.id === later.id);
  assert.deepEqual(second.contact, { display_name: null, line_user_id: 'U2' });
  assert.equal(second.booking, null);
  assert.deepEqual(second.homework, {});

  const since = await exportLeads(store, { since: '2026-10-18T03:30:00Z' });
  assert.deepEqual(since.map((l) => l.id), [later.id]);
  assert.deepEqual(await exportLeads(store, { since: '2030-01-01T00:00:00Z' }), []);
  await assert.rejects(exportLeads(store, { since: 'yesterday' }), RangeError);
  await store.close();
});

test('exportLeads works against the fake store too (same contract)', async () => {
  const store = createFakeStore();
  await store.sessions.getOrCreate('U1');
  const lead = await store.leads.upsert({ user_id: 'U1', symptom: 's', status: 'new' });
  await store.bookings.create({ user_id: 'U1', lead_id: lead.id, window_text: 'w', created_at: '2026-10-18T00:00:00Z' });
  const out = await exportLeads(store, {});
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]), SHAPE);
  assert.equal(out[0].contact.line_user_id, 'U1');
  assert.equal(out[0].booking.window_text, 'w');
});
