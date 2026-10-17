const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createStore } = require('../../src/store');
const { createFakeClock } = require('../fakes/clock');
const { createAdminRouter, safeEqual } = require('../../src/admin');

const TOKEN = 'test-admin-token-not-a-secret';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function boot() {
  const clock = createFakeClock('2026-10-18T10:00:00+07:00');
  const store = createStore({ path: ':memory:', clock });
  const app = express();
  app.use(createAdminRouter({ store, token: TOKEN, clock }));
  const { server, base } = await listen(app);
  const api = async (method, path, { body, token = TOKEN } = {}) => {
    const headers = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, type: res.headers.get('content-type') || '' };
  };
  const close = async () => { await new Promise((r) => server.close(r)); await store.close(); };
  return { store, clock, api, close };
}

test('safeEqual: constant-time compare semantics', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(undefined, 'x'), false);
});

test('admin: every route is 401 without / with a wrong token, JSON body', async () => {
  const { api, close } = await boot();
  try {
    for (const [m, p] of [['GET', '/admin/leads'], ['GET', '/admin/sessions'], ['GET', '/admin/sessions/U1'], ['POST', '/admin/sessions/U1/mode'], ['GET', '/admin/events']]) {
      const none = await api(m, p, { token: null, body: m === 'POST' ? { mode: 'quiet' } : undefined });
      assert.equal(none.status, 401, `${m} ${p} without token`);
      assert.deepEqual(none.json, { error: 'unauthorized' });
      assert.match(none.type, /application\/json/);
      const wrong = await api(m, p, { token: 'nope', body: m === 'POST' ? { mode: 'quiet' } : undefined });
      assert.equal(wrong.status, 401, `${m} ${p} wrong token`);
    }
  } finally { await close(); }
});

test('admin: 401 when ADMIN_TOKEN is not configured at all', async () => {
  const store = createStore({ path: ':memory:' });
  const app = express();
  const prev = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  app.use(createAdminRouter({ store }));
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/admin/sessions`, { headers: { authorization: 'Bearer ' } });
    assert.equal(res.status, 401);
    const res2 = await fetch(`${base}/admin/sessions`, { headers: { authorization: 'Bearer undefined' } });
    assert.equal(res2.status, 401);
  } finally {
    if (prev !== undefined) process.env.ADMIN_TOKEN = prev;
    await new Promise((r) => server.close(r));
    await store.close();
  }
});

test('admin: leads export with since, sessions list/detail with last 30 messages, mode change, events', async () => {
  const { store, clock, api, close } = await boot();
  try {
    const s = await store.sessions.getOrCreate('U1');
    await store.sessions.save({ ...s, display_name: 'คุณซี' });
    const lead = await store.leads.upsert({ user_id: 'U1', symptom: 'reply_slow', homework: { business: 'ร้านอาหาร' } });
    await store.bookings.create({ user_id: 'U1', lead_id: lead.id, window_text: 'อังคาร 15:00' });
    for (let i = 1; i <= 35; i++) await store.messages.append({ user_id: 'U1', role: i % 2 ? 'customer' : 'lay', text: `m${i}` });
    clock.advanceMinutes(30);
    const lead2 = await store.leads.upsert({ user_id: 'U2' });

    const leads = await api('GET', '/admin/leads');
    assert.equal(leads.status, 200);
    assert.equal(leads.json.count, 2);
    assert.equal(leads.json.since, null);
    const l1 = leads.json.leads.find((l) => l.id === lead.id);
    assert.deepEqual(l1.contact, { display_name: 'คุณซี', line_user_id: 'U1' });
    assert.equal(l1.booking.window_text, 'อังคาร 15:00');
    assert.deepEqual(l1.homework, { business: 'ร้านอาหาร' });

    const since = await api('GET', `/admin/leads?since=${encodeURIComponent('2026-10-18T03:15:00Z')}`);
    assert.equal(since.status, 200);
    assert.deepEqual(since.json.leads.map((l) => l.id), [lead2.id]);
    assert.equal(since.json.since, '2026-10-18T03:15:00.000Z');
    assert.equal((await api('GET', '/admin/leads?since=garbage')).status, 400);

    const sessions = await api('GET', '/admin/sessions');
    assert.equal(sessions.status, 200);
    assert.equal(sessions.json.count, 1);
    assert.equal(sessions.json.sessions[0].user_id, 'U1');

    const detail = await api('GET', '/admin/sessions/U1');
    assert.equal(detail.status, 200);
    assert.equal(detail.json.session.display_name, 'คุณซี');
    assert.equal(detail.json.messages.length, 30);
    assert.equal(detail.json.messages[0].text, 'm6');
    assert.equal(detail.json.messages[29].text, 'm35');
    assert.equal((await api('GET', '/admin/sessions/nobody')).status, 404);

    const mode = await api('POST', '/admin/sessions/U1/mode', { body: { mode: 'mos_active' } });
    assert.equal(mode.status, 200);
    assert.equal(mode.json.session.mode, 'mos_active');
    assert.equal(mode.json.session.mode_since, '2026-10-18T03:30:00.000Z');
    assert.equal((await store.sessions.get('U1')).mode, 'mos_active');
    for (const bad of [{ mode: 'off' }, {}, { mode: 42 }]) {
      assert.equal((await api('POST', '/admin/sessions/U1/mode', { body: bad })).status, 400);
    }
    assert.equal((await api('POST', '/admin/sessions/nobody/mode', { body: { mode: 'quiet' } })).status, 404);

    await store.events.append({ kind: 'model_fallback', user_id: 'U1', payload: { reason: 'schema' } });
    const events = await api('GET', '/admin/events?limit=1');
    assert.equal(events.status, 200);
    assert.equal(events.json.count, 1);
    assert.equal(events.json.events[0].kind, 'model_fallback');
    const allEvents = await api('GET', '/admin/events');
    assert.equal(allEvents.json.count, 2); // admin_mode_change + model_fallback
    assert.equal(allEvents.json.events[0].kind, 'admin_mode_change');
    assert.deepEqual(allEvents.json.events[0].payload, { from: 'lay', to: 'mos_active' });
  } finally { await close(); }
});

test('admin: malformed JSON body returns a JSON 400, never HTML', async () => {
  const { api, close, store } = await boot();
  try {
    await store.sessions.getOrCreate('U1');
    const { server, base } = await listen(express().use(createAdminRouter({ store, token: TOKEN })));
    try {
      const res = await fetch(`${base}/admin/sessions/U1/mode`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{not json',
      });
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await res.json(), { error: 'bad request' });
    } finally { await new Promise((r) => server.close(r)); }
    assert.equal((await api('GET', '/admin/sessions')).status, 200);
  } finally { await close(); }
});
