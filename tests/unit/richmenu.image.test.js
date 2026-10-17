// Checks the committed PNG outputs (public/richmenu/*.png). Skips with a message when they are missing and no
// browser is available to build them; never calls LINE.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rm = require('../../src/line/richmenu');
const { findBrowser } = require('../../scripts/richmenu/build');

const missing = rm.VARIANTS.filter((v) => !fs.existsSync(rm.imagePath(v)));
const browser = findBrowser();
const skip = missing.length && !browser
  ? `PNG outputs missing (${missing.join(', ')}) and no headless Chrome/Edge found — run node scripts/richmenu/build.js on a machine with a browser`
  : false;

for (const variant of rm.VARIANTS) {
  test(`${variant} PNG exists at 2500x1686 and is <= 1 MB`, { skip }, () => {
    if (!fs.existsSync(rm.imagePath(variant))) assert.fail(`${rm.imagePath(variant)} missing — run node scripts/richmenu/build.js (browser found at ${browser})`);
    const img = rm.loadImage(variant);
    assert.equal(img.width, 2500);
    assert.equal(img.height, 1686);
    assert.ok(img.bytes <= rm.MAX_IMAGE_BYTES, `${img.bytes} bytes > 1 MB`);
    assert.ok(img.bytes > 10_000, 'suspiciously small render');
  });
}
