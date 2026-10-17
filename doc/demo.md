# Demo mode and "ขอดูตัวอย่าง" (`src/flows/demo.js`, `src/flows/examples.js`)

Design §7, brief §3.7, acceptance §9.7. Two synthetic shops from `knowledge/kb/examples.md` (คาเฟ่ริมคลอง, คลินิกใสใส)
answer as themselves; Lay owns the carousel, the picker, "บอทตัวนี้", "งานของเรา" and the exit line. The model proposes the
shop's words and a summary card; code owns state, postbacks, status, sender and quick replies. Nothing in demo touches
`deps.notifier`, `store.leads`, `store.bookings`, `session.homework` or `session.draft`.

Tests: `node --test tests/unit/demo.test.js` (13) · scenario `tests/scenarios/20-demo-cafe.yaml`.

## Session state

| Field | Value |
|---|---|
| `mode` | `demo` while inside a shop (`core/session.setMode`) |
| `demo_shop` | `cafe` \| `clinic` \| `null` |
| `demo_state` | `{ step, order, since, turns, sent_at? }` — `null` outside demo |
| `demo_state.step` | `chat` → `ordering` (model said `booking_start`) → `confirm` (summary card shown) → `sent` (DEMO_CONFIRM) ; DEMO_EDIT → `chat` |
| `demo_state.order` | `{ title, fields:[{k,v}] }` taken from the model's `summary_confirm` card; never a lead field |
| `demo_state.since` | ISO time of entry; the shop's model history is only `customer`/`demo_shop` rows (kind ≠ postback) at or after it |

`enterDemo(session, shopKey, now)` · `exitDemo(session, now)` (clears `demo_shop` + `demo_state`, mode `lay`).
Messages the shop sends persist with role `demo_shop` and `sender_name` = the shop sender; Lay's with role `lay`.

## Postbacks

| Data | Where handled | Effect |
|---|---|---|
| `DEMO_EXAMPLES` | examples | intro text + `examples` carousel (4 items), topic `proof` covered |
| `DEMO_PICK` | examples | intro + `choice` card ร้านกาแฟตัวอย่าง / คลินิกความงามตัวอย่าง |
| `DEMO_THIS_BOT` | examples | fixed text + `info` card with the 3 things Lay does (no model) |
| `DEMO_OUR_WORK` | examples | fixed text + `examples` carousel of 2 (KV Premium screens, LhW workspace), labelled ตัวอย่าง, ctas `FIT_scattered_data` / `FIT_ai_know_my_work` |
| `DEMO_ENTER_cafe` / `DEMO_ENTER_clinic` | demo | `enterDemo` + the shop's fixed greeting (no model) as the shop sender; `action: demo_enter` |
| `DEMO_CONFIRM` | demo | in demo with an order → step `sent`, line "ส่ง…ให้เจ้าของร้าน (ตัวอย่าง) แล้วครับ รอยืนยัน" (simulated); no order → "ยังไม่มีรายการให้ยืนยัน"; outside demo → Lay says the demo is over + picker button |
| `DEMO_EDIT` | demo | step back to `chat`, "บอกส่วนที่อยากเปลี่ยน" (order kept for context) |
| any other `DEMO_*` | demo → examples | treated as `DEMO_EXAMPLES` |
| `DEMO_PICK` / `DEMO_EXAMPLES` / `DEMO_THIS_BOT` / `DEMO_OUR_WORK` while in demo | demo | `exitDemo` quietly first (no exit line), then the Lay content |
| `FIT_<key>` | fit flow (not here) | keys on the exit card: `chat_overload`, `scattered_data`, `repetitive_work`, `ai_know_my_work`, `dont_know_where_to_start` |

Quick-reply item `กลับไปคุยกับ Lay` is a message action; `identity/quiet.isCallLay` matches it and turn.js step 4 exits.
`exitDemo` is also what `onModelAction('demo_exit')` and `runDemoTurn` use.

## Model actions (turn.js step 11 → `demo.onModelAction`)

- `demo_enter` — honoured only when the customer's own text names a shop (`/กาแฟ|คาเฟ่|cafe|coffee/`, `/คลินิก|ความงาม|clinic|ผิว|เลเซอร์/`)
  or the input is a `DEMO_ENTER_*` postback. Otherwise `log.info('demo.ignored_model_demo_enter')` and the picker is shown.
- `demo_exit` — inside demo: `exitToLay` (below). Outside: Lay sends the model's first text (or "ตอนนี้คุยกับ Lay อยู่แล้วครับ").
- Inside demo the shop's response may also carry `booking_start` (step → `ordering`) and `booking_confirm` (ignored on its own;
  the `summary_confirm` card is what creates the order).

## The shop turn (`runDemoTurn`)

1. `DEMO_*` postback → `onDemoPostback`. Empty text → "พิมพ์มาได้เลยครับ" + starters.
2. System prompt = `brain/prompt.buildDemoSystemPrompt({ shop:{key,name}, shopKb })` with `shopKb` = the shop's
   `examples.demo-*` section + a generated order guide (`strings.orderGuide`: which `k` labels to use in the card, when to set
   `booking_start` / `booking_confirm`). History: demo rows only. Same response schema; `core/policy.applyPolicy` on top with
   one regenerate, then the honest shop fallback (`strings.shopFallback`, logged as `model_fallback` with `demo_shop`).
3. Render: text → stripped; `summary_confirm` → the order is captured, status forced to `pending`, postbacks forced to
   `DEMO_CONFIRM` / `DEMO_EDIT`; `offer` cards are dropped to alt text (no LhW offers inside a shop); other templates render
   through `cards/render` with `examples.cardContext`. A dropped card still ships its buttons as quick replies (fallback rule).
4. Sender `senders.demo(shop)`; quick replies = the shop's ≤ 3 + `กลับไปคุยกับ Lay` last (`withBack`), 4 max.

Shop senders: `ริมคลอง · ผู้ช่วย AI` (20 code points) and `ใสใส · ผู้ช่วย AI`. `short_name_th` must stay ≤ 7 code points because
`identity/sender.demo` appends ` · ผู้ช่วย AI` (13) and LINE caps sender names at 20. The ตัวอย่าง label therefore lives in the
greeting, every card title and the exit line, not in the sender name. Icons: `public/assets/demo-cafe.png`, `demo-clinic.png`
via `config.publicBaseUrl`.

## Exit line (`exitToLay`)

Lay, role `lay`, action `demo_exit`: one sentence on what they saw (order path vs chat-only, per shop) + "อยากได้ส่วนไหนแบบนี้ในร้านพี่บ้างครับ",
then a `choice` card "ตอนนี้ติดตรงไหนมากที่สุดครับ" with the 5 symptoms as `FIT_<key>` postbacks (brief §3.4). Quick replies:
`ลองอีกร้าน` (→ `DEMO_PICK`), `ราคาเท่าไหร่`, `เริ่มยังไง`. Topic `proof` is marked covered.
The symptoms ride on a card rather than quick replies because two of the brief's labels exceed the 20-code-point quick-reply
limit and five exceed the 4-button cap; the card labels are shortened to ≤ 20 (`demo.SYMPTOMS`). If `flows/fit` publishes its
own labels, point `SYMPTOMS` at them.

## Turn count (brief §9.7)

Customer turns on the scripted happy path (`tests/unit/demo.test.js` "the whole cafe path"):
`DEMO_EXAMPLES` → `DEMO_PICK` → `DEMO_ENTER_cafe` → "มีอะไรบ้าง" → the order line → `DEMO_CONFIRM` → exit = **7** (the test
asserts ≤ 8). Entering straight from the picker is 5. With a real model, each extra clarifying question the shop asks adds one.

## Strings (Thai, in `strings` of each file)

`demo.strings`: `greeting.cafe/clinic(name)`, `sent(noun)`, `edit`, `nothingToConfirm`, `notInDemo`, `alreadyLay`, `shopFallback`,
`emptyText`, `exitSeen.{cafe,clinic}.{order,chat}`, `exitAsk`, `symptomTitle`, `tryOther`, `orderGuide(def)`.
`examples.strings`: `carouselIntro`, `items.*`, `pickTitle/Subtitle/Options/Intro`, `thisBotIntro`, `thisBot.{title,rows,note}`,
`ourWorkIntro`, `ourWork.*`, `alts.*`, `quickAfter.*`. All pass `core/lint.lintText` (asserted in the unit test). Carousel
titles/lines prefer the pack's `examples.carousel.*` `title:` / `line:` values when present.

## Assets to replace (placeholders)

Generated solid-colour PNGs with a pixel label; Mos replaces them with real screens (keep the file names, 16:9 for the
carousel, square for icons, https via `PUBLIC_BASE_URL`):

| image_key | file | shows |
|---|---|---|
| `demo_shops` | `public/assets/examples-demo-shops.png` (1024×576) | the two sample shops |
| `this_bot` | `public/assets/examples-this-bot.png` | a Lay screenshot |
| `our_work` | `public/assets/examples-our-work.png` | cover for "งานของเรา" |
| `kv_premium` | `public/assets/examples-kv-premium.png` | KV Premium screen, synthetic data only |
| `lhw_workspace` | `public/assets/examples-lhw-workspace.png` | LhW workspace screenshot |
| `fastwork_profile` | `public/assets/examples-fastwork-profile.png` | Fastwork profile |
| — | `public/assets/demo-cafe.png`, `demo-clinic.png` (256×256) | shop sender icons |

`examples.examplesAssets(config)` maps the keys to `${publicBaseUrl}/assets/<file>`; with no https base the carousel degrades to
text + buttons (never a broken image).

## Wiring still needed outside this module (turn.js / app)

1. **Open the carousel on "ขอดูตัวอย่าง"**: in turn.js step 8, when `data === 'MENU_EXAMPLES' || data === 'MENU_PORTFOLIO'` or
   `topics.topicFromText(text) === 'proof'` (and the carousel has not been shown this session, e.g. `!s.topics_covered.includes('proof')`),
   `return await demo.onDemoPostback({ data: 'DEMO_EXAMPLES', input, session: s, deps, config, send, persist, done, senders })`
   instead of calling the model. Today it only opens from the `DEMO_EXAMPLES` postback (rich-menu tile can use that data directly).
2. **เรียก Lay from demo** (turn.js step 4): when `was === 'demo'`, call `demo.exitDemo(s, now)` (clears `demo_state`; today only
   `demo_shop` is nulled) and preferably `return await demo.onModelAction({ action: 'demo_exit', ... })` so the customer gets the
   design's exit line + symptom card instead of `quiet.strings.back`.
3. **Pack wiring** (app): `pack.demoShops = demo.demoShops(pack)` and `pack.assets = { ...pack.assets, ...examples.examplesAssets(config) }`
   (`senders.forSession` reads `pack.demoShops`; `cardContext` in turn.js reads `pack.assets`). Without it the flows load the pack
   themselves (`brain/kb.loadPack`, cached) and still work, but the media reply inside demo would carry Lay's sender.
4. **summary_confirm status text**: `cards/templates/summary_confirm` renders `pending` as "รอมอสยืนยัน". In demo the approver is the
   shop owner; a `status_label` override (or a `pending_shop` status) in the template would make the pill say "รอร้านยืนยัน".
5. **Scenario runner** (`tests/run-scenarios.js`): (a) merge a step's `model:` over `brain/schema.emptyResponse()` so YAML without
   `lead_updates` validates (the pre-existing `00-smoke-pricing.yaml` fails on this today; `20-demo-cafe.yaml` sets `lead_updates: {}`);
   (b) `sender: demo` should accept the shop sender names (`"ริมคลอง · ผู้ช่วย AI"`, `"ใสใส · ผู้ช่วย AI"`) — they cannot contain ตัวอย่าง
   under the 20-code-point cap; (c) pass a `config` with an https `publicBaseUrl` (or `deps.pack.assets`) so `card: examples` can
   be asserted.
