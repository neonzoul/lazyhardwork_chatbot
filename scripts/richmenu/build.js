#!/usr/bin/env node
// Renders scripts/richmenu/*.html to public/richmenu/*.png with the headless Chrome/Edge already on the machine.
// No npm deps. Usage: node scripts/richmenu/build.js [--out <dir>] [--browser <exe>] [--skip-font-check]
// Exits 1 if no browser is found, a PNG has the wrong size, or the fonts did not load (never ships a system-font render silently).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { CANVAS, VARIANTS, IMAGE_FILES, IMAGE_DIR, MAX_IMAGE_BYTES, pngDimensions } = require('../../src/line/richmenu');

const SRC_DIR = __dirname;
const SOURCES = { default: 'richmenu.html', demo: 'richmenu-demo.html' };
const FALLBACK = { width: 1200, height: 810 };   // used only if a 2500x1686 render is over 1 MB
const BROWSERS = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findBrowser(explicit) {
    const list = [explicit, process.env.RICHMENU_BROWSER, ...BROWSERS].filter(Boolean);
    return list.find((p) => fs.existsSync(p)) || null;
}

const fileUrl = (p) => 'file:///' + path.resolve(p).split(path.sep).join('/').replace(/^\//, '');

function screenshot(browser, htmlFile, outFile, { width, height }) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'richmenu-chrome-'));
    try {
        execFileSync(browser, [
            '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
            '--allow-file-access-from-files', `--user-data-dir=${userData}`,
            '--virtual-time-budget=4000',                 // lets @font-face files finish loading before the capture
            '--default-background-color=00000000',
            `--window-size=${width},${height}`, `--screenshot=${path.resolve(outFile)}`, fileUrl(htmlFile),
        ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
    } finally {
        fs.rmSync(userData, { recursive: true, force: true });
    }
    if (!fs.existsSync(outFile)) throw new Error(`browser produced no file for ${htmlFile}`);
    return fs.readFileSync(outFile);
}

// Renders the page once more with every @font-face removed; identical bytes mean the real render used system fonts too.
function fontsLoaded(browser, variant, tmpDir, withFonts) {
    const css = fs.readFileSync(path.join(SRC_DIR, 'richmenu.css'), 'utf8').replace(/@font-face\s*\{[^}]*\}/g, '');
    const html = fs.readFileSync(path.join(SRC_DIR, SOURCES[variant]), 'utf8')
        .replace('<link rel="stylesheet" href="richmenu.css">', `<style>${css}</style>`);
    const page = path.join(tmpDir, `nofont-${variant}.html`);
    fs.writeFileSync(page, html);
    const without = screenshot(browser, page, path.join(tmpDir, `nofont-${variant}.png`), CANVAS);
    const hash = (b) => crypto.createHash('sha1').update(b).digest('hex');
    return hash(without) !== hash(withFonts);
}

// Scales a fallback render by overriding the CSS custom properties (the layout is expressed in them).
function scaledPage(variant, size, tmpDir) {
    const k = size.width / CANVAS.width;
    const css = fs.readFileSync(path.join(SRC_DIR, 'richmenu.css'), 'utf8')
        .replace(/url\('fonts\//g, `url('${fileUrl(path.join(SRC_DIR, 'fonts'))}/`);
    const html = fs.readFileSync(path.join(SRC_DIR, SOURCES[variant]), 'utf8')
        .replace('<link rel="stylesheet" href="richmenu.css">', `<style>${css}
:root { --w: ${size.width}px; --h: ${size.height}px; --col: ${Math.floor(size.width / 3)}px; --row: ${Math.floor(size.height / 2)}px; }
.menu { zoom: ${k}; width: ${CANVAS.width}px; height: ${CANVAS.height}px; grid-template-columns: 833px 833px 1fr; grid-template-rows: 843px 1fr; }</style>`);
    const page = path.join(tmpDir, `scaled-${variant}.html`);
    fs.writeFileSync(page, html);
    return page;
}

function build({ outDir = IMAGE_DIR, browser: explicit, fontCheck = true, log = console } = {}) {
    const browser = findBrowser(explicit);
    if (!browser) throw new Error('no headless browser found (Chrome/Edge). Set RICHMENU_BROWSER=<path to chrome.exe>.');
    fs.mkdirSync(outDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'richmenu-build-'));
    const results = {};
    try {
        for (const variant of VARIANTS) {
            const out = path.join(outDir, IMAGE_FILES[variant]);
            let size = CANVAS;
            let buf = screenshot(browser, path.join(SRC_DIR, SOURCES[variant]), out, size);
            let note = '';
            if (buf.length > MAX_IMAGE_BYTES) {
                size = FALLBACK;
                note = ` (2500x1686 render was ${buf.length} bytes > 1 MB — re-rendered at ${size.width}x${size.height}; menuDefinition() size must be changed to match)`;
                buf = screenshot(browser, scaledPage(variant, size, tmpDir), out, size);
            }
            const dim = pngDimensions(buf);
            if (dim.width !== size.width || dim.height !== size.height) throw new Error(`${out}: rendered ${dim.width}x${dim.height}, expected ${size.width}x${size.height}`);
            const fonts = fontCheck ? fontsLoaded(browser, variant, tmpDir, buf) : null;
            results[variant] = { file: out, bytes: buf.length, ...dim, fontsLoaded: fonts };
            log.log(`${variant}: ${path.relative(process.cwd(), out)} ${dim.width}x${dim.height} ${(buf.length / 1024).toFixed(1)} KB` +
                (fonts === null ? '' : fonts ? ' · fonts: loaded' : ' · fonts: NOT LOADED') + note);
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    const missing = Object.entries(results).filter(([, r]) => r.fontsLoaded === false).map(([v]) => v);
    if (missing.length) throw new Error(`fonts did not load for: ${missing.join(', ')} — the render fell back to system fonts; not shipping it. Check scripts/richmenu/fonts/*.woff2 and --allow-file-access-from-files.`);
    results.browser = browser;
    return results;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    try {
        const r = build({ outDir: opt('--out'), browser: opt('--browser'), fontCheck: !args.includes('--skip-font-check') });
        console.log(`browser: ${r.browser}`);
    } catch (err) {
        console.error(`richmenu build failed: ${err.message}`);
        process.exit(1);
    }
}

module.exports = { build, findBrowser, screenshot, SOURCES, FALLBACK };
