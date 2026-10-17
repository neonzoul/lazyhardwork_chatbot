# Rich Menu v2 (Lay)

Two menus on the channel, both 2500 x 1686, 3 columns x 2 rows, drawn in the brand CI (bg `#FAFAF8`, ink `#1B1B1B`,
muted `#6B6B6B`, hairlines `#E6E4DF`, one emerald `#0E6E5C` accent on the Call-Lay tile). Design §4/§7, addendum A1,
platform limits in `doc/line-platform-notes.md` §7.

| alias | image | tiles (reading order) |
|---|---|---|
| `lay-default` | `public/richmenu/lay-v2.png` | ทำอะไรได้บ้าง `MENU_CAPABILITY` · เหมาะกับงานผมไหม `MENU_FIT` · ขอดูตัวอย่าง `MENU_EXAMPLES` · เริ่มยังไง `MENU_START` · คุยกับมอส `MENU_HANDOFF` · เรียก Lay `CALL_LAY` |
| `lay-demo` | `public/richmenu/lay-v2-demo.png` | กลับไปคุยกับ Lay `CALL_LAY` · ดูเมนู/บริการ (message `เมนู`) · สั่ง/จองเลย (message `สั่งเลย`) · เปลี่ยนร้านตัวอย่าง `DEMO_PICK` · คุยกับมอส `MENU_HANDOFF` · เริ่มยังไง `MENU_START` |

`chatBarText` is `เมนู`, `selected: true` on both. The tile data lives once, in `src/line/richmenu.js` (`TILES`);
the HTML sources repeat the labels and a unit test keeps them in sync. Postback `data` values must match
`src/core/turn.js` `MENU_TO_TEXT` and `src/identity/quiet.js` `CALL_LAY_POSTBACK` (tested).

## Files

```
src/line/richmenu.js            definitions (pure) + createRichMenuManager (SDK)
scripts/richmenu/richmenu.html  default menu source      scripts/richmenu/richmenu-demo.html  demo menu source
scripts/richmenu/richmenu.css   shared styles + @font-face  scripts/richmenu/fonts/*.woff2     Bai Jamjuree 600, IBM Plex Sans Thai 400 (OFL)
scripts/richmenu/build.js       HTML -> PNG with headless Chrome/Edge
scripts/setup-rich-menu.js      create menus + aliases on a channel
public/richmenu/lay-v2.png, lay-v2-demo.png   committed outputs (~110 KB / ~100 KB)
tests/unit/richmenu.test.js, richmenu.image.test.js
```

## Rebuilding the images

```
node scripts/richmenu/build.js            # writes public/richmenu/*.png, prints size + dimensions + font check
node scripts/richmenu/build.js --out tmp  # elsewhere;  --browser <exe>  or  RICHMENU_BROWSER=<exe>  to pick the browser
```

The build uses the Chrome or Edge already installed (`C:/Program Files/Google/Chrome/Application/chrome.exe`, then
Edge, then the usual Linux/macOS paths) with `--headless=new --screenshot --window-size=2500,1686`. No npm dependency.
It parses the PNG IHDR to confirm 2500 x 1686, fails if a file is over 1 MB after the fallback, and renders each page a
second time with every `@font-face` stripped: if that render is byte-identical to the real one the fonts did not load
and the build **fails** instead of shipping a system-font image. If the 2500 x 1686 render were ever over 1 MB it
re-renders at 1200 x 810 and says so — `menuDefinition()` `CANVAS` must then be changed to match (the areas are derived
from it). Edit the HTML/CSS, rebuild, open both PNGs, commit the PNGs together with the source.

Fonts are the doc-kit woff2 files copied from the vault (`Resources/lhw-doc-kit/fonts/`); copy again if the kit changes.

## Creating the menus on a channel

```
node scripts/setup-rich-menu.js --dry-run                 # prints both definitions, areas, image sizes; no LINE call
node scripts/setup-rich-menu.js                           # test channel: LINE_CHANNEL_ACCESS_TOKEN from .env
node scripts/setup-rich-menu.js --channel prod --yes-prod # live OA: LINE_PROD_CHANNEL_ACCESS_TOKEN
node scripts/setup-rich-menu.js --recreate                # delete + recreate (needed after any image change)
```

`ensureMenus()` is idempotent by alias: for each variant it looks up the alias (`getRichMenuAlias`); if present it
reuses the menu, otherwise `createRichMenu` → `setRichMenuImage` (blob client, `image/png`) → `createRichMenuAlias`.
Then `setDefaultRichMenu(lay-default)`. Images are built first if `public/richmenu/*.png` are missing. The default
menu appears when the user next opens the chat (up to about a minute). A LINE image cannot be replaced on an existing
menu, hence `--recreate`. Menus created by the API are not editable in OA Manager and vice versa.

## Demo linking (per user)

```js
const { createRichMenuManager } = require('./src/line/richmenu');
const menus = createRichMenuManager({ line: { channelAccessToken } });   // or inject { api, blob } fakes in tests
await menus.linkDemo(userId);     // on demo_enter: POST /user/{id}/richmenu/{lay-demo id}  — immediate
await menus.unlinkDemo(userId);   // on demo_exit / CALL_LAY: DELETE /user/{id}/richmenu   — falls back to default
```

Both return `{ ok, error? }` and never throw: the per-user swap is a Should (design §7); the demo must work with the
`กลับไปคุยกับ Lay` quick reply alone when the link fails (user not a friend, alias missing, LINE 5xx). The demo menu
keeps `เรียก Lay`/`กลับไปคุยกับ Lay` as its first tile so a customer can always leave. Priority on the phone:
per-user link > API default > OA Manager default. Not displayed on LINE for PC.

## Limits (notes §7)

Image JPEG/PNG, width 800–2500, height ≥ 250, aspect ≥ 1.45, ≤ 1 MB · ≤ 20 areas · `chatBarText` ≤ 14 graphemes ·
action `label` ≤ 20 · ≤ 1000 menus per channel · create/delete 100/hour, link/unlink 2,000 rps, batch link 3/hour.
`validateDefinition()` checks the local ones (size, aspect, chatBarText, area count, overlap, full coverage, labels)
before any API call.
