const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rm = require('../../src/line/richmenu');
const { MENU_TO_TEXT } = require('../../src/core/turn');
const { CALL_LAY_POSTBACK } = require('../../src/identity/quiet');

const graphemes = (s) => [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(s)].length;
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const fakePng = (w, h) => { const b = Buffer.alloc(64); PNG_HEAD.copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

for (const variant of rm.VARIANTS) {
  test(`${variant}: 6 areas tile the 2500x1686 canvas exactly, no overlap, selected, chatBarText <= 14`, () => {
    const def = rm.menuDefinition(variant);
    assert.deepEqual(def.size, { width: 2500, height: 1686 });
    assert.equal(def.selected, true);
    assert.equal(def.areas.length, 6);
    assert.equal(def.chatBarText, 'เมนู');
    assert.ok(graphemes(def.chatBarText) <= 14);
    assert.deepEqual(rm.validateDefinition(def), []);
    const area = def.areas.reduce((n, a) => n + a.bounds.width * a.bounds.height, 0);
    assert.equal(area, 2500 * 1686);
    assert.deepEqual(def.areas[2].bounds, { x: 1666, y: 0, width: 834, height: 843 });
    assert.deepEqual(def.areas[5].bounds, { x: 1666, y: 843, width: 834, height: 843 });
    for (const a of def.areas) assert.ok([...a.action.label].length <= 20, `label "${a.action.label}" > 20`);
  });

  test(`${variant}: exactly one accent tile and the HTML source carries the same labels and hints`, () => {
    const tiles = rm.TILES[variant];
    assert.equal(tiles.filter((t) => t.accent).length, 1);
    assert.equal(tiles.find((t) => t.accent).action.data, CALL_LAY_POSTBACK);
    const file = path.join(__dirname, '..', '..', 'scripts', 'richmenu', variant === 'demo' ? 'richmenu-demo.html' : 'richmenu.html');
    const html = fs.readFileSync(file, 'utf8');
    const labels = [...html.matchAll(/class="label">([^<]+)</g)].map((m) => m[1]);
    const hints = [...html.matchAll(/class="hint">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(labels, tiles.map((t) => t.label));
    assert.deepEqual(hints, tiles.map((t) => t.hint));
    assert.equal((html.match(/class="tile accent"/g) || []).length, 1);
    assert.equal(html.split('data-tile="').length - 1, 6);
  });
}

test('default postbacks match turn.js MENU_TO_TEXT and quiet.js CALL_LAY', () => {
  const def = rm.menuDefinition('default');
  const data = def.areas.map((a) => a.action.data);
  assert.deepEqual(data, ['MENU_CAPABILITY', 'MENU_FIT', 'MENU_EXAMPLES', 'MENU_START', 'MENU_HANDOFF', CALL_LAY_POSTBACK]);
  for (const d of data.filter((d) => d.startsWith('MENU_') && d !== 'MENU_HANDOFF')) {
    assert.equal(MENU_TO_TEXT[d], rm.TILES.default.find((t) => t.action.data === d).label, `${d} text differs from the tile label`);
  }
  assert.ok(def.areas.every((a) => a.action.type === 'postback'));
});

test('demo menu: CALL_LAY first, shop message actions, DEMO_PICK, handoff and start', () => {
  const actions = rm.menuDefinition('demo').areas.map((a) => a.action);
  assert.deepEqual(actions.map((a) => a.type), ['postback', 'message', 'message', 'postback', 'postback', 'postback']);
  assert.equal(actions[0].data, CALL_LAY_POSTBACK);
  assert.equal(actions[1].text, 'เมนู');
  assert.equal(actions[2].text, 'สั่งเลย');
  assert.deepEqual(actions.slice(3).map((a) => a.data), ['DEMO_PICK', 'MENU_HANDOFF', 'MENU_START']);
});

test('unknown variant throws; validateDefinition catches overlap, gaps, chatBarText and aspect', () => {
  assert.throws(() => rm.menuDefinition('nope'), /unknown variant/);
  const def = rm.menuDefinition('default');
  const overlap = { ...def, areas: def.areas.map((a, i) => (i === 1 ? { ...a, bounds: { ...a.bounds, x: 800 } } : a)) };
  assert.ok(rm.validateDefinition(overlap).some((e) => /overlap/.test(e)));
  const gap = { ...def, areas: def.areas.slice(0, 5) };
  assert.ok(rm.validateDefinition(gap).some((e) => /cover/.test(e)));
  assert.ok(rm.validateDefinition({ ...def, chatBarText: 'เมนูหลักของเลย์ยาวเกินไปแน่นอน' }).some((e) => /chatBarText/.test(e)));
  assert.ok(rm.validateDefinition({ ...def, size: { width: 2500, height: 2000 } }).some((e) => /aspect/.test(e)));
});

test('pngDimensions reads the IHDR and rejects non-PNG', () => {
  assert.deepEqual(rm.pngDimensions(fakePng(1200, 810)), { width: 1200, height: 810 });
  assert.throws(() => rm.pngDimensions(Buffer.from('not a png at all, really not')), /not a PNG/);
});

// ---- manager with a fake SDK -------------------------------------------------------------------------------

function fakeSdk({ aliases = {}, imageDir } = {}) {
  const calls = [];
  let n = 0;
  const notFound = () => Object.assign(new Error('404'), { status: 404 });
  const api = {
    async getRichMenuAlias(id) { calls.push(['getRichMenuAlias', id]); if (!aliases[id]) throw notFound(); return { richMenuAliasId: id, richMenuId: aliases[id] }; },
    async createRichMenu(def) { calls.push(['createRichMenu', def.name]); return { richMenuId: `rm-${++n}` }; },
    async createRichMenuAlias(req) { calls.push(['createRichMenuAlias', req.richMenuAliasId, req.richMenuId]); aliases[req.richMenuAliasId] = req.richMenuId; return {}; },
    async deleteRichMenuAlias(id) { calls.push(['deleteRichMenuAlias', id]); delete aliases[id]; return {}; },
    async deleteRichMenu(id) { calls.push(['deleteRichMenu', id]); return {}; },
    async setDefaultRichMenu(id) { calls.push(['setDefaultRichMenu', id]); return {}; },
    async linkRichMenuIdToUser(userId, id) { calls.push(['linkRichMenuIdToUser', userId, id]); return {}; },
    async unlinkRichMenuIdFromUser(userId) { calls.push(['unlinkRichMenuIdFromUser', userId]); return {}; },
  };
  const blob = { async setRichMenuImage(id, body) { calls.push(['setRichMenuImage', id, body.type, body.size]); return {}; } };
  const log = { info() {}, warn() {} };
  return { api, blob, calls, manager: rm.createRichMenuManager({ api, blob, imageDir, log }) };
}

// Fake 2500x1686 PNG headers so the manager tests do not depend on the rendered images.
function fakeImageDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'richmenu-test-'));
  for (const v of rm.VARIANTS) fs.writeFileSync(rm.imagePath(v, dir), fakePng(2500, 1686));
  return dir;
}

test('ensureMenus: aliases exist → no create/upload, default set to lay-default id', async () => {
  const { manager, calls } = fakeSdk({ aliases: { 'lay-default': 'rm-d', 'lay-demo': 'rm-x' }, imageDir: fakeImageDir() });
  const r = await manager.ensureMenus();
  assert.equal(r.default.richMenuId, 'rm-d');
  assert.equal(r.demo.richMenuId, 'rm-x');
  assert.equal(r.default.created, false);
  assert.ok(!calls.some((c) => c[0] === 'createRichMenu' || c[0] === 'setRichMenuImage'));
  assert.deepEqual(calls.at(-1), ['setDefaultRichMenu', 'rm-d']);
});

test('ensureMenus: aliases missing → create, upload PNG, alias, default — in that order; second run is a no-op', async () => {
  const { manager, calls } = fakeSdk({ imageDir: fakeImageDir() });
  const r = await manager.ensureMenus();
  assert.equal(r.default.created, true);
  assert.equal(r.demo.created, true);
  assert.deepEqual(calls.map((c) => c[0]), [
    'getRichMenuAlias', 'createRichMenu', 'setRichMenuImage', 'createRichMenuAlias',
    'getRichMenuAlias', 'createRichMenu', 'setRichMenuImage', 'createRichMenuAlias',
    'setDefaultRichMenu',
  ]);
  assert.deepEqual(calls[2].slice(0, 3), ['setRichMenuImage', 'rm-1', 'image/png']);
  assert.deepEqual(calls[3], ['createRichMenuAlias', 'lay-default', 'rm-1']);
  assert.deepEqual(calls[7], ['createRichMenuAlias', 'lay-demo', 'rm-2']);
  assert.deepEqual(calls.at(-1), ['setDefaultRichMenu', 'rm-1']);
  calls.length = 0;
  await manager.ensureMenus();
  assert.deepEqual(calls.map((c) => c[0]), ['getRichMenuAlias', 'getRichMenuAlias', 'setDefaultRichMenu']);
});

test('ensureMenus({ recreate }) deletes alias + menu before creating again', async () => {
  const { manager, calls } = fakeSdk({ aliases: { 'lay-default': 'rm-d', 'lay-demo': 'rm-x' }, imageDir: fakeImageDir() });
  const r = await manager.ensureMenus({ recreate: true });
  assert.ok(calls.some((c) => c[0] === 'deleteRichMenuAlias' && c[1] === 'lay-default'));
  assert.ok(calls.some((c) => c[0] === 'deleteRichMenu' && c[1] === 'rm-x'));
  assert.equal(r.default.created, true);
  assert.notEqual(r.default.richMenuId, 'rm-d');
});

test('ensureMenus refuses a wrong-size image', async () => {
  const dir = fakeImageDir();
  fs.writeFileSync(rm.imagePath('demo', dir), fakePng(1200, 1686));
  const { manager } = fakeSdk({ aliases: { 'lay-default': 'rm-d' }, imageDir: dir });
  await assert.rejects(() => manager.ensureMenus(), /1200x1686/);
});

test('linkDemo links the demo alias id; unlinkDemo unlinks; failures are returned not thrown', async () => {
  const { manager, calls, api } = fakeSdk({ aliases: { 'lay-default': 'rm-d', 'lay-demo': 'rm-x' } });
  assert.deepEqual(await manager.linkDemo('U1'), { ok: true });
  assert.deepEqual(calls.at(-1), ['linkRichMenuIdToUser', 'U1', 'rm-x']);
  assert.deepEqual(await manager.unlinkDemo('U1'), { ok: true });
  assert.deepEqual(calls.at(-1), ['unlinkRichMenuIdFromUser', 'U1']);
  api.linkRichMenuIdToUser = async () => { throw Object.assign(new Error('not a friend'), { status: 400 }); };
  const r = await manager.linkDemo('U2');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /not a friend/);
  api.unlinkRichMenuIdFromUser = async () => { throw Object.assign(new Error('nothing linked'), { status: 404 }); };
  assert.deepEqual(await manager.unlinkDemo('U2'), { ok: true });
});

test('linkDemo without the demo alias fails cleanly', async () => {
  const { manager } = fakeSdk({ aliases: {} });
  const r = await manager.linkDemo('U1');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /lay-demo not found/);
});

test('createRichMenuManager without clients needs a token', () => {
  assert.throws(() => rm.createRichMenuManager({}), /channelAccessToken/);
});
