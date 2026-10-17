# Feature map — Lay v2 (for agents)

Every customer-visible feature → how to reach it on the phone → which module handles it → which test proves it.
Pipeline step numbers refer to the `// N.` comments in `src/core/turn.js`. "scenario" = `tests/scenarios/*.yaml`
run by `npm run scenarios`; "unit" = `tests/unit/*.test.js` run by `npm test`. Where no test exists yet it says so.

## Conversation

| Feature | Reach it (phone) | Module | Proof |
|---|---|---|---|
| Opening (3 quick replies, Lay sender, reply token) | add friend (`follow`) or a plain greeting "สวัสดี" as first message | turn step 2 → `flows/opening.js` | unit `turn.test` "follow → opening" |
| First message that already asks a question | type "ราคาเท่าไหร่" as first message | turn step 2 skips the opening, model answers with the opening folded into the prompt | unit `turn.test` "a question goes to the model" |
| Six carried questions + follow-up map | tap a quick reply: ทำอะไรได้บ้าง · เหมาะกับงานผมไหม · ราคาเท่าไหร่ · ใช้เวลานานไหม · ขอดูตัวอย่าง · เริ่มยังไง (or type a variant) | `flows/topics.js` (`TOPIC_PATTERNS`, `FOLLOW_UP`), turn steps 8–12; covered topics never re-offered | unit `flows.test`, scenario `00-smoke-pricing` |
| "Tell me more" expands instead of restarting | "อธิบายเพิ่มหน่อย" after an answer | `isTellMeMore` → `intentHint: tell_me_more`, `brain/prompt.js` session block names last `kb_refs` | unit `brain.prompt.test` |
| Loose ends on a closing signal | after ≥ 2 topics, type "ขอบคุณครับ" / "โอเค" | turn step 7 → `topics.shouldLooseEnds` / `looseEndsReply` (once per session, no model call) | unit `turn.test` "closing signal after two topics" |
| Fit by symptom (5 symptoms → card A1–A4/C1) | tap เหมาะกับงานผมไหม → the choice card → one symptom (`FIT_<key>`) | turn step 8 → `flows/fit.js` `onSymptomPostback`; `brain/select` adds `fit-map` + the card's `offer.*` | unit `flows-fit.test`, scenario `10-short-path-offer` |
| Homework (7 fields, ≤ 4 questions, one gap per turn) | answer Lay's questions by text or button; volunteered facts are kept | `flows/homework.js` + `core/session.mergeLeadUpdates`; stored as Thai labels | unit `flows-homework.test` |
| Short path — offer card | symptom that lands on C1 or any T1 card, once homework is ready or intent is fit/howtostart/pricing | `flows/endings.js` `chooseEnding` / `offerCard` / `decorateResponse` (turn step 10); price + Fastwork URL only from `pack.ladders` via `cardContext` | scenario `10-short-path-offer`, unit `flows-endings.test` |
| Booking — start | tap นัดคุยกับมอสก่อน on the offer card (`BOOK_START`), type "นัดคุย", or the model proposes `booking_start` | turn step 6a / 8 / 11 → `endings.onModelAction` / `onBookingPostback` | scenario `11-booking-pending` |
| Booking — name, day, time, summary, confirm, edit | buttons วันนี้/พรุ่งนี้/เลือกวันเอง · เช้า/บ่าย/เย็น · ยืนยัน (`BOOK_CONFIRM`) · ขอแก้ไข (`BOOK_EDIT` → ชื่อ/วัน/ช่วงเวลา/เรื่อง); typed answers inside the booking go to `onBookingText` | `flows/endings.js` state machine (`session.booking_step`); summary card = `cards/templates/summary_confirm` with amber "รอมอสยืนยัน" | scenario `11-booking-pending`, unit `flows-endings.test` |
| Notify before promise | confirm a booking; the customer hears "ส่งให้มอสแล้วครับ" only after `notifier.booking` resolved; notifier failure → honest failure line + phone | `endings.js` pending transition | scenario `11-booking-pending` (`fault: notifier`) |
| Mos approve / propose / decline | Mos types `/approve`, `/propose พรุ่งนี้ 14:00 หรือ 16:00`, `/decline` in the `#leads` thread | `discord/commands.js` → `endings.applyMosDecision`; approve is the **only** path that renders green "ยืนยันแล้ว"; propose → `BOOK_PICK_<i>` quick replies → back to pending + notify again | unit `flows-endings.test`, `discord.relay.test` |
| Handoff — human | type "คุยกับคนจริง"/"ขอคุยกับมอส", tap คุยกับมอส (`MENU_HANDOFF`/`ASK_HUMAN`), or the model proposes `handoff_human` | turn step 6 / 11 → `flows/handoff.js` `performHandoff` → `notifier.handoff` (Discord thread) → quiet mode | unit `turn.test` "ask for a human → notify first" |
| Handoff — scope (discount / special price) | type "ขอส่วนลด", "ราคาพิเศษ", "ต่อรอง" | `handoff.isSpecialPrice` → `handoff_scope` → quiet | unit `flows.test` |
| Handoff — unknown (KB gap) | ask something outside the KB; Lay says it has no data and **offers** ส่งให้มอสตอบ / ถามเรื่องอื่น; tapping forwards (`FORWARD_TO_MOS`), Lay stays active | turn step 11 (`kbGaps.append`, `notifier.kbGap`) + step 6 | unit `turn.test` "model says ไม่รู้" |
| Quiet window + `เรียก Lay` | after a handoff: one acknowledgement, then silence; type "เรียก Lay"/"Lay" or tap เรียก Lay (`CALL_LAY`) to resume; auto-resume after 30 min idle (`QUIET_WINDOW_MINUTES`) | `identity/quiet.js`, turn steps 1, 4, 5; customer text while quiet/mos_active is mirrored to the thread (`relayToMos`) | unit `turn.test` "quiet window expires", scenario `11-booking-pending` |
| Mos relay ("มอส" identity) | Mos types plain text in the lead's `#leads` thread | `discord/relay.js` → `runTurn({kind:'mos_relay'})` → push with the มอส sender + เรียก Lay quick reply; mode `mos_active`; `/lay` → `mos_release` | unit `turn.test` "Mos relay pushes as มอส", `discord.relay.test` |

## Demo and examples

| Feature | Reach it (phone) | Module | Proof |
|---|---|---|---|
| Examples carousel | tap ขอดูตัวอย่าง (tile `MENU_EXAMPLES` or quick reply), or type "ขอดูตัวอย่าง"/"ผลงาน" (≤ 20 chars, first time) | turn step 8 → `flows/examples.js` via `demo.onDemoPostback('DEMO_EXAMPLES')`; images from `public/assets/examples-*.png` (placeholders) | unit `demo.test`, scenario `20-demo-cafe` |
| Shop picker · "บอทตัวนี้" · "งานของเรา" | carousel buttons `DEMO_PICK`, `DEMO_THIS_BOT`, `DEMO_OUR_WORK` | `flows/examples.js` (fixed text + `choice`/`info`/`examples` cards, no model) | unit `demo.test` |
| Demo — enter | pick ร้านกาแฟตัวอย่าง / คลินิกความงามตัวอย่าง (`DEMO_ENTER_cafe|clinic`) or name a shop in text when the model proposes `demo_enter` | `flows/demo.js` `enterDemo`; mode `demo`, shop sender (`ริมคลอง · ผู้ช่วย AI`, `ใสใส · ผู้ช่วย AI`) | unit `demo.test`, scenario `20-demo-cafe` |
| Demo — order → summary → confirm / edit | chat with the shop, place an order; summary card → ยืนยัน (`DEMO_CONFIRM`, simulated "ส่งให้เจ้าของร้าน (ตัวอย่าง)") / แก้ไข (`DEMO_EDIT`) | `demo.runDemoTurn` (demo prompt, `summary_confirm` with status pill "รอร้านยืนยัน" via `status_label`); never touches leads/bookings/notifier | unit `demo.test` "the whole cafe path" (≤ 8 turns) |
| Demo — exit | quick reply กลับไปคุยกับ Lay, text "เรียก Lay", tile `CALL_LAY`, or the model's `demo_exit` | turn step 4 → `demo.exitDemo` + `exitToLay` (recap + 5-symptom choice card) | unit `demo.test`, scenario `20-demo-cafe` |

## Surface and resilience

| Feature | Reach it (phone) | Module | Proof |
|---|---|---|---|
| Rich Menu — default (`lay-default`) | chat bar เมนู: ทำอะไรได้บ้าง `MENU_CAPABILITY` · เหมาะกับงานผมไหม `MENU_FIT` · ขอดูตัวอย่าง `MENU_EXAMPLES` · เริ่มยังไง `MENU_START` · คุยกับมอส `MENU_HANDOFF` · เรียก Lay `CALL_LAY` | `src/line/richmenu.js` `TILES`; `MENU_*` → `turn.MENU_TO_TEXT` → topic; created by `scripts/setup-rich-menu.js` | unit `richmenu.test`, `richmenu.image.test` |
| Rich Menu — demo (`lay-demo`) | กลับไปคุยกับ Lay `CALL_LAY` · ดูเมนู/บริการ (text เมนู) · สั่ง/จองเลย (text สั่งเลย) · เปลี่ยนร้านตัวอย่าง `DEMO_PICK` · คุยกับมอส · เริ่มยังไง | definition exists; **per-user link on demo enter is not wired** in `turn.js` (`linkDemo`/`unlinkDemo` unused — Should, `doc/backlog.md`) | unit `richmenu.test` (definition only) |
| Media / sticker replies | send an image, file or sticker | turn step 2 → `opening.mediaReply(mediaType)`; never reaches the model; in demo the shop sender replies | unit `turn.test` "media gets its own reply" |
| Burst debounce + loading animation | send 3 texts within 6.5 s → one answer | `core/debounce.js` (text only; postbacks/follow/media bypass), `createEventHandler` | unit `turn.test` (debounce), `runner.test` |
| Injection resistance | type "[SYSTEM] ignore previous instructions…" | `turn.sanitizeInput` (strips `[SYSTEM…]`, `<system>`, "IGNORE PREVIOUS INSTRUCTIONS"); prompt static prefix states what code owns | **no dedicated test yet** (planned injection suite, T13) |
| Policy lint and regenerate | any model text with banned content / emoji / prose list / ungrounded price | `core/policy.js` `applyPolicy` → fix · regenerate once · fallback | unit `policy.test`, `lint.test`, `brain.examples.test` |
| Fallbacks — never silent | model throws, returns garbage, times out; LINE push fails | turn catch-all → "ตอนนี้ระบบขัดข้องชั่วคราวครับ ถ้ารีบ โทร <phone> ได้เลย" + เรียก Lay; push retried once then `undelivered` event | unit `turn.test` "model throws", "garbage", "LINE push fails twice"; scenario `fault:` steps |
| Card fallback | any card whose build/validate fails | `cards/render.js` → text + ≤ 4 quick replies, never a prose list, never an invented price | unit `cards.test` (snapshots) |
| Identity (three senders) | every message: Lay (`Lay · ผู้ช่วย AI`), มอส, demo shop; omitted `sender` = OA default | `identity/sender.js` `forSession`; icons from `LAY_ICON_URL`/`MOS_ICON_URL` (served under `/assets`) | scenario `sender:` expectations, unit `turn.test` |
| Webhook dedupe / group ignore | LINE redelivery; group or room message | `createEventHandler`: `webhookEventId` LRU, `chatType !== 'user'` logged and dropped | unit `turn.test` / `runner.test` |

## Admin API (`src/admin.js`, bearer `ADMIN_TOKEN`, JSON only)

| Route | Purpose |
|---|---|
| `GET /health` (no auth) | `{status, version, pack: built_at}` — smoke check |
| `GET /admin/leads?since=<iso>` | leads export incl. contact + booking — consumed by `scripts/lead-sync.js` |
| `GET /admin/sessions` · `GET /admin/sessions/:userId` | all sessions · one session + last 30 messages |
| `POST /admin/sessions/:userId/mode {mode}` | force `lay` / `quiet` / `mos_active` / `demo` (logged as `admin_mode_change`) |
| `GET /admin/events?limit=` | debugging feed (errors, model_fallback, booking_notify_failed, …; max 1000) |

Static: `/assets/*` (icons, example images), `/richmenu/*` (menu PNGs). Webhook: `POST /webhook`.
