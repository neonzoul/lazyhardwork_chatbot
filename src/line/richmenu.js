// Rich Menu v2 — definitions (pure) + manager (LINE SDK). Design §4/§7, addendum A1, line-platform-notes §7.
//
// Two menus: `default` (Lay's six tiles) and `demo` (shown per-user while the customer is inside a demo shop).
// The pure parts (TILES, menuDefinition, validateDefinition, ALIASES) have no SDK dependency so tests and the
// HTML image source can share them. The manager wraps @line/bot-sdk messagingApi clients and is injectable.

const fs = require('node:fs');
const path = require('node:path');

const CANVAS = { width: 2500, height: 1686 };   // LINE template size: 3 columns x 2 rows
const COLS = 3;
const ROWS = 2;
const CHAT_BAR_TEXT = 'เมนู';                     // <= 14 grapheme clusters
const ALIASES = { default: 'lay-default', demo: 'lay-demo' };
const IMAGE_FILES = { default: 'lay-v2.png', demo: 'lay-v2-demo.png' };
const IMAGE_DIR = path.join(__dirname, '..', '..', 'public', 'richmenu');
const MAX_IMAGE_BYTES = 1024 * 1024;

// Postback data must match src/core/turn.js MENU_TO_TEXT and src/identity/quiet.js CALL_LAY_POSTBACK.
const postback = (data, displayText) => ({ type: 'postback', data, displayText });
const message = (text) => ({ type: 'message', text });

// Tile order = reading order: row 1 left→right, then row 2. `accent: true` marks the single emerald tile.
const TILES = {
    default: [
        { id: 'capability', label: 'ทำอะไรได้บ้าง', hint: '6 เรื่องที่คนถามบ่อย', action: postback('MENU_CAPABILITY', 'ทำอะไรได้บ้าง') },
        { id: 'fit', label: 'เหมาะกับงานผมไหม', hint: 'เลือกอาการของร้าน', action: postback('MENU_FIT', 'เหมาะกับงานผมไหม') },
        { id: 'examples', label: 'ขอดูตัวอย่าง', hint: 'ลองเป็นลูกค้าร้านตัวอย่าง', action: postback('MENU_EXAMPLES', 'ขอดูตัวอย่าง') },
        { id: 'start', label: 'เริ่มยังไง', hint: 'ขั้นตอนและนัดคุย', action: postback('MENU_START', 'เริ่มยังไง') },
        { id: 'handoff', label: 'คุยกับมอส', hint: 'ส่งเรื่องถึงมอส', action: postback('MENU_HANDOFF', 'คุยกับมอส') },
        { id: 'call-lay', label: 'เรียก Lay', hint: 'ให้ Lay กลับมาดูแล', action: postback('CALL_LAY', 'เรียก Lay'), accent: true },
    ],
    demo: [
        { id: 'call-lay', label: 'กลับไปคุยกับ Lay', hint: 'ออกจากร้านตัวอย่าง', action: postback('CALL_LAY', 'กลับไปคุยกับ Lay'), accent: true },
        { id: 'shop-menu', label: 'ดูเมนู/บริการ', hint: 'เมนูและราคาของร้าน', action: message('เมนู') },
        { id: 'shop-order', label: 'สั่ง/จองเลย', hint: 'ลองสั่งหรือจองคิว', action: message('สั่งเลย') },
        { id: 'demo-pick', label: 'เปลี่ยนร้านตัวอย่าง', hint: 'ร้านกาแฟ หรือ คลินิก', action: postback('DEMO_PICK', 'เปลี่ยนร้านตัวอย่าง') },
        { id: 'handoff', label: 'คุยกับมอส', hint: 'ส่งเรื่องถึงมอส', action: postback('MENU_HANDOFF', 'คุยกับมอส') },
        { id: 'start', label: 'เริ่มยังไง', hint: 'ขั้นตอนและนัดคุย', action: postback('MENU_START', 'เริ่มยังไง') },
    ],
};

const VARIANTS = Object.keys(TILES);

// Column/row edges: the last column absorbs the remainder so the areas tile the canvas exactly (833, 833, 834).
function gridBounds(index, canvas = CANVAS) {
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    const colW = Math.floor(canvas.width / COLS);
    const rowH = Math.floor(canvas.height / ROWS);
    const x = col * colW;
    const y = row * rowH;
    const width = col === COLS - 1 ? canvas.width - x : colW;
    const height = row === ROWS - 1 ? canvas.height - y : rowH;
    return { x, y, width, height };
}

function menuDefinition(variant = 'default') {
    const tiles = TILES[variant];
    if (!tiles) throw new Error(`richmenu: unknown variant "${variant}" (expected ${VARIANTS.join('|')})`);
    return {
        size: { ...CANVAS },
        selected: true,
        name: `Lay v2 ${variant}`,
        chatBarText: CHAT_BAR_TEXT,
        areas: tiles.map((t, i) => ({ bounds: gridBounds(i), action: { ...t.action, label: t.label } })),
    };
}

// Local check of the platform limits (notes §7) so a bad definition fails before any API call.
function validateDefinition(def) {
    const errors = [];
    const { width, height } = def.size || {};
    if (!(width >= 800 && width <= 2500)) errors.push(`width ${width} outside 800–2500`);
    if (!(height >= 250)) errors.push(`height ${height} below 250`);
    if (!(width / height >= 1.45)) errors.push(`aspect ${(width / height).toFixed(2)} below 1.45`);
    const chars = [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(def.chatBarText || '')].length;
    if (chars < 1 || chars > 14) errors.push(`chatBarText ${chars} graphemes (1–14)`);
    if (!Array.isArray(def.areas) || def.areas.length < 1 || def.areas.length > 20) errors.push('areas must be 1–20');
    let covered = 0;
    for (const [i, a] of (def.areas || []).entries()) {
        const b = a.bounds;
        if (b.x < 0 || b.y < 0 || b.x + b.width > width || b.y + b.height > height) errors.push(`area ${i} leaves the canvas`);
        covered += b.width * b.height;
        for (const [j, o] of def.areas.entries()) {
            if (j <= i) continue;
            const ob = o.bounds;
            const overlap = b.x < ob.x + ob.width && ob.x < b.x + b.width && b.y < ob.y + ob.height && ob.y < b.y + b.height;
            if (overlap) errors.push(`areas ${i} and ${j} overlap`);
        }
        if (a.action?.label && [...a.action.label].length > 20) errors.push(`area ${i} label > 20 chars`);
    }
    if (covered !== width * height) errors.push(`areas cover ${covered} px² of ${width * height}`);
    return errors;
}

// PNG IHDR: bytes 16–23 hold width/height big-endian (after the 8-byte signature + 4 length + 4 "IHDR").
function pngDimensions(buf) {
    if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG' || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function imagePath(variant, dir = IMAGE_DIR) { return path.join(dir, IMAGE_FILES[variant]); }

// Reads an image and checks it against the menu size and the 1 MB limit. Returns { buffer, width, height, bytes }.
function loadImage(variant, { dir = IMAGE_DIR } = {}) {
    const file = imagePath(variant, dir);
    if (!fs.existsSync(file)) throw new Error(`richmenu: image missing ${file} — run node scripts/richmenu/build.js`);
    const buffer = fs.readFileSync(file);
    const { width, height } = pngDimensions(buffer);
    const { size } = menuDefinition(variant);
    if (width !== size.width || height !== size.height) throw new Error(`richmenu: ${file} is ${width}x${height}, menu is ${size.width}x${size.height}`);
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`richmenu: ${file} is ${buffer.length} bytes (> 1 MB)`);
    return { buffer, width, height, bytes: buffer.length, file };
}

const isNotFound = (err) => (err?.status || err?.statusCode || err?.originalError?.response?.status) === 404;

/**
 * createRichMenuManager({ line: { channelAccessToken }, api?, blob?, imageDir?, log? })
 * `api`/`blob` are the SDK clients (MessagingApiClient / MessagingApiBlobClient); pass fakes in tests.
 * Without them the SDK is required lazily and built from `line.channelAccessToken`.
 */
function createRichMenuManager({ line, api, blob, imageDir = IMAGE_DIR, log = console } = {}) {
    if (!api || !blob) {
        const token = line?.channelAccessToken;
        if (!token) throw new Error('createRichMenuManager: line.channelAccessToken missing');
        const sdk = require('@line/bot-sdk');
        api = api || new sdk.messagingApi.MessagingApiClient({ channelAccessToken: token });
        blob = blob || new sdk.messagingApi.MessagingApiBlobClient({ channelAccessToken: token });
    }

    async function findAlias(aliasId) {
        try { return (await api.getRichMenuAlias(aliasId)).richMenuId; } catch (err) { if (isNotFound(err)) return null; throw err; }
    }

    async function createMenu(variant) {
        const def = menuDefinition(variant);
        const bad = validateDefinition(def);
        if (bad.length) throw new Error(`richmenu ${variant}: ${bad.join('; ')}`);
        const img = loadImage(variant, { dir: imageDir });
        const { richMenuId } = await api.createRichMenu(def);
        await blob.setRichMenuImage(richMenuId, new Blob([img.buffer], { type: 'image/png' }));
        await api.createRichMenuAlias({ richMenuAliasId: ALIASES[variant], richMenuId });
        log.info?.('richmenu.created', { variant, richMenuId, alias: ALIASES[variant], bytes: img.bytes });
        return richMenuId;
    }

    async function removeMenu(variant, richMenuId) {
        try { await api.deleteRichMenuAlias(ALIASES[variant]); } catch (err) { if (!isNotFound(err)) throw err; }
        try { await api.deleteRichMenu(richMenuId); } catch (err) { if (!isNotFound(err)) throw err; }
        log.info?.('richmenu.removed', { variant, richMenuId });
    }

    // Idempotent by alias: existing alias → reuse; missing → create + upload + alias. Then default = lay-default.
    // { recreate: true } deletes and rebuilds both (the image of an existing menu cannot be replaced).
    async function ensureMenus({ recreate = false } = {}) {
        const result = {};
        for (const variant of VARIANTS) {
            let richMenuId = await findAlias(ALIASES[variant]);
            let created = false;
            if (richMenuId && recreate) { await removeMenu(variant, richMenuId); richMenuId = null; }
            if (!richMenuId) { richMenuId = await createMenu(variant); created = true; }
            result[variant] = { richMenuId, alias: ALIASES[variant], created };
        }
        await api.setDefaultRichMenu(result.default.richMenuId);
        result.defaultRichMenuId = result.default.richMenuId;
        return result;
    }

    async function menuId(variant) {
        const id = await findAlias(ALIASES[variant]);
        if (!id) throw new Error(`richmenu: alias ${ALIASES[variant]} not found — run scripts/setup-rich-menu.js`);
        return id;
    }

    // Per-user link is immediate and needs the user to be a friend (notes §7). Failures are returned, not thrown:
    // the demo must still work with the quick reply alone (design: per-user swap is a Should).
    async function linkDemo(userId) {
        try { await api.linkRichMenuIdToUser(userId, await menuId('demo')); return { ok: true }; } catch (err) { log.warn?.('richmenu.link_failed', { userId, message: err?.message }); return { ok: false, error: err }; }
    }

    async function unlinkDemo(userId) {
        try { await api.unlinkRichMenuIdFromUser(userId); return { ok: true }; } catch (err) { if (isNotFound(err)) return { ok: true }; log.warn?.('richmenu.unlink_failed', { userId, message: err?.message }); return { ok: false, error: err }; }
    }

    return { ensureMenus, linkDemo, unlinkDemo, menuId, _api: api, _blob: blob };
}

module.exports = {
    CANVAS, COLS, ROWS, CHAT_BAR_TEXT, ALIASES, IMAGE_FILES, IMAGE_DIR, MAX_IMAGE_BYTES, TILES, VARIANTS,
    gridBounds, menuDefinition, validateDefinition, pngDimensions, imagePath, loadImage, createRichMenuManager,
};
