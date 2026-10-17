# Cards — Lay v2 Flex renderer (`src/cards/`)

The model fills **data**; the renderer owns **layout**. `render(card, ctx)` turns
`{template, alt?, data}` into a validated LINE Flex message, or a text + quick-reply fallback.
CommonJS, no dependencies. Tests: `node --test tests/unit/cards.test.js`.

```
src/cards/
  tokens.js        colours, sizes, spacing, limits — the one place
  primitives.js    header · kvRow · bulletRow · priceRow · statusPill · buttonPrimary/Secondary · optionBox · footer · separator · bubble
  common.js        cleanTitle (emoji strip + log), list bounds, action normalisation
  templates/*.js   choice · compare · steps · offer · summary_confirm · examples · info   → build(data, ctx) / fallback(data, ctx)
  validate.js      validate(message) → {ok, errors[], bytes}
  render.js        render(card, ctx) → {message, fallback, errors, bytes} · renderOrFallback(card, ctx) → LINE message
```

## Data shapes (what the model fills)

| Template | `data` | Shape |
|---|---|---|
| `choice` | `{title, subtitle?, options:[{label, postback, primary?}] (2–6)}` | kilo bubble. Options ≤ 20 chars → buttons; if **any** option is longer, all become tappable `optionBox`es (full text inside, short ≤20 `label`, full `displayText`). The `primary` option (else the first) is the emerald one. |
| `compare` | `{title, columns:[{name, rows:[{k,v}], price_from?, price_note?, cta?:{label, postback\|url}}] (2–3)}` | carousel of 2–3 kilo bubbles, same row order per column; title as a small kicker in each bubble. |
| `steps` | `{title, subtitle?, steps:[{title, detail?, ai?}] (2–5), cta?}` | numbered rows; the `ai: true` step (else step 1) gets the emerald badge unless a `cta` button is given. |
| `offer` | `{card_id, tier, title, bullets:[≤5], note?, secondary_cta?:{label, postback}}` | price and URL come **only** from `ctx.priceFor(card_id, tier)` / `ctx.fastworkUrlFor(card_id)`. Any `price_from`/`fastwork_url` the model put in data is ignored. Primary = "ดูการ์ดบน Fastwork" (uri). |
| `summary_confirm` | `{title, fields:[{k,v}] (1–6), status, confirm_postback, edit_postback}` | status text set by code: `pending` amber "รอมอสยืนยัน" · `reproposed` amber "มอสเสนอเวลาใหม่" · `confirmed` green "ยืนยันแล้ว" (no buttons) · `declined` muted "ยกเลิกแล้ว" (edit button only). |
| `examples` | `{title?, items:[{image_key, title, line, cta:{label, postback\|url}}] (1–5)}` | **mega** carousel, hero image = `ctx.assets[image_key]` (https). Missing key → build error → fallback. |
| `info` | `{title, subtitle?, rows:[{k,v}] (1–5), note?, cta?}` | kilo bubble; emerald accent mark in the header when there is no cta. |

Action specs accepted anywhere: `'POSTBACK_DATA'`, `{postback}`, `{data}`, `{url}` / `{uri}`, or a full
`{type, …}` action. Postbacks always carry `data` as given and `displayText` = the full label; labels are cut to
20 code points (with "…") only on the action, never in the visible text.

`ctx` (injected by the caller, never hardcoded in templates):
`{ assets: {key → https url}, fastworkUrlFor(cardId) → url, priceFor(cardId, tier) → {price_from, label_th} | null, log?: {warn} }`.

## Tokens (`tokens.js`)

| Token | Value | Use |
|---|---|---|
| `bg` | `#FAFAF8` | every bubble body/footer |
| `ink` | `#1B1B1B` | text |
| `muted` | `#6B6B6B` | labels, captions, declined pill text |
| `line` | `#E6E4DF` | separators, secondary-button border, inactive step badge |
| `emerald` | `#0E6E5C` | **exactly one per bubble**: primary button, primary optionBox, AI step badge, or header accent |
| `amber` on `amberBg` | `#B8860B` / `#FFF4D6` | only "รอมอสยืนยัน" and "มอสเสนอเวลาใหม่" |
| `success` on `successBg` | `#1F7A4D` / `#E6F4EC` | only "ยืนยันแล้ว" |

Sizes: title `lg`, body `sm`, caption `xs`, price `md`; bubble `kilo` (`mega` for examples); buttons `height: sm`.
No gradients, no emoji in titles (stripped and logged via `ctx.log.warn`).

## Adding a template

1. Create `src/cards/templates/<name>.js` exporting `build(data, ctx) → {altText, contents}` and
   `fallback(data, ctx) → {text, quick_replies:[{label, postback|data|url}]}`. Build only from primitives; take
   every price/URL/image from `ctx`; call `cleanTitle` on anything that lands in a title; throw on bad data (render
   turns a throw into the fallback).
2. Register it in `TEMPLATES` in `render.js`.
3. Add sample Thai data to `SAMPLES` in `tests/unit/cards.test.js`; run `UPDATE_SNAPSHOTS=1 node --test
   tests/unit/cards.test.js` once to write `tests/unit/__snapshots__/cards.<name>.json`, then run without the flag.
4. Add the row to the table above and to the schema enum in `src/brain/schema.js` (brain team).

## The fallback rule

A card is **never** sent half-right. If the template is unknown, the build throws, or `validate()` fails, `render`
returns `message: null` and `fallback: {text, quick_replies}` (≤ 4 postback/uri items, labels ≤ 20) so the caller
still sends the choice as buttons, never as a prose list. `renderOrFallback` does that conversion to a LINE
`{type:'text', text, quickReply}` message. The offer fallback carries no price when `ctx.priceFor` has none — a
number is never invented.

## LINE limits enforced (`validate.js`; sources: `doc/line-platform-notes.md` §4–5)

| Check | Limit | Ours vs LINE |
|---|---|---|
| `altText` | non-empty, ≤ 400 code points | LINE allows 1500 |
| bubble JSON | ≤ 30 KB | LINE |
| carousel JSON / bubbles | ≤ 50 KB, ≤ 10 bubbles, all one `size` | LINE 12 bubbles |
| action label | 1–20 code points | LINE 20 |
| postback `data` / `displayText` | ≤ 300 | LINE |
| `uri` action, image `url` | https only | LINE (TLS 1.2+) |
| text component | non-empty, `wrap: true` | ours — LINE truncates otherwise |
| primary-coloured elements | ≤ 1 per bubble | brand rule |
| header title | no emoji | brand rule |

Current JSON sizes with the test samples (contents only): choice 3.1 KB · compare 4.5 KB · steps 3.3 KB ·
offer 2.8 KB · summary_confirm 2.7 KB · examples 2.1 KB · info 1.8 KB.
