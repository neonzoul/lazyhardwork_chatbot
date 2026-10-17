#!/usr/bin/env node
/**
 * Rich Menu v2 setup — creates the `lay-default` and `lay-demo` menus on a channel (idempotent by alias).
 *
 *   node scripts/setup-rich-menu.js [--channel test|prod] [--dry-run] [--recreate] [--yes-prod]
 *
 * --channel test (default) uses LINE_CHANNEL_ACCESS_TOKEN; prod uses LINE_PROD_CHANNEL_ACCESS_TOKEN (from .env).
 * --dry-run prints the two definitions and the image sizes; no LINE call, no token needed.
 * --yes-prod is required together with --channel prod (guard against running the default against the live OA).
 * --recreate deletes the existing menus/aliases first (the image of an existing menu cannot be replaced).
 * Images are built from scripts/richmenu/*.html if public/richmenu/*.png are missing. See doc/richmenu.md.
 */

require('dotenv').config();
const fs = require('node:fs');
const rm = require('../src/line/richmenu');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : 'test';
if (!['test', 'prod'].includes(channel)) { console.error('--channel must be test or prod'); process.exit(2); }

function ensureImages() {
    const missing = rm.VARIANTS.filter((v) => !fs.existsSync(rm.imagePath(v)));
    if (!missing.length) return;
    console.log(`images missing (${missing.join(', ')}) — building from scripts/richmenu/*.html`);
    require('./richmenu/build').build();
}

function report() {
    for (const v of rm.VARIANTS) {
        const def = rm.menuDefinition(v);
        const bad = rm.validateDefinition(def);
        const img = rm.loadImage(v);
        console.log(`\n[${v}] alias=${rm.ALIASES[v]} chatBarText="${def.chatBarText}" areas=${def.areas.length} valid=${bad.length ? 'NO: ' + bad.join('; ') : 'yes'}`);
        console.log(`  image ${img.file} ${img.width}x${img.height} ${(img.bytes / 1024).toFixed(1)} KB`);
        for (const a of def.areas) console.log(`  ${a.bounds.x},${a.bounds.y} ${a.bounds.width}x${a.bounds.height}  ${a.action.type}:${a.action.data || a.action.text}  "${a.action.label}"`);
    }
}

async function main() {
    ensureImages();
    report();
    if (flag('--dry-run')) { console.log('\n--dry-run: nothing sent to LINE.'); return; }

    const token = channel === 'prod' ? process.env.LINE_PROD_CHANNEL_ACCESS_TOKEN : process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) { console.error(`\n${channel === 'prod' ? 'LINE_PROD_CHANNEL_ACCESS_TOKEN' : 'LINE_CHANNEL_ACCESS_TOKEN'} not set in .env`); process.exit(1); }
    if (channel === 'prod' && !flag('--yes-prod')) { console.error('\nrefusing to touch the prod channel without --yes-prod'); process.exit(1); }

    const manager = rm.createRichMenuManager({ line: { channelAccessToken: token }, log: { info: (e, f) => console.log(`  ${e}`, f), warn: console.warn } });
    console.log(`\nchannel: ${channel} — ensuring menus${flag('--recreate') ? ' (recreate)' : ''}…`);
    const r = await manager.ensureMenus({ recreate: flag('--recreate') });
    for (const v of rm.VARIANTS) console.log(`${v}: ${r[v].richMenuId}  alias=${r[v].alias}  ${r[v].created ? 'created' : 'existing'}`);
    console.log(`default menu: ${r.defaultRichMenuId} (visible when the user re-opens the chat, up to ~1 min)`);
}

main().catch((err) => {
    console.error('setup failed:', err.body || err.message || err);
    process.exit(1);
});
