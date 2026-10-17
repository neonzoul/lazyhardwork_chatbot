# LINE platform notes — Lay v2

Read on: 2026-10-17

Practical reference for the Lay v2 build: what we can build, the limits, the gotchas. Every fact carries the official
page it was read from. `REF` = https://developers.line.biz/en/reference/messaging-api/ (anchors appended). Anything
not confirmed on an official page is marked **UNVERIFIED**. Numbers in the task brief that turned out wrong are
corrected here (altText is 1500 not 400; rich-menu sizes are a range, not a fixed list).

## 1. Messaging API basics

| Topic | Fact | Source |
| --- | --- | --- |
| Reply token | Single use; must be used **within 1 minute** of receiving the webhook ("use beyond one minute isn't guaranteed"). Token in a *redelivered* webhook is also usable for 1 minute after the redelivery, unless the original was already used or **20 minutes** have passed since the event. | REF#send-reply-message |
| Messages per call | `messages` array **max 5** objects per reply/push/multicast call. | REF#send-reply-message, #send-push-message; https://developers.line.biz/en/docs/messaging-api/sending-messages/ |
| Push conditions | Push works to friends, to groups/rooms the OA has joined, and to non-friends who messaged the OA 1:1 **within the last 7 days**. Push to a blocker / deleted account / non-friend returns 200 but is not delivered. | REF#send-push-message |
| What is billed | **Counted:** push, multicast, broadcast, narrowcast. **Not counted:** reply messages; also OA Manager chats, auto-response and greeting messages. Count = number of *recipients*, not message objects (4 objects to 5 people = 5 messages). Blocked / non-existent recipients are not counted. | https://developers.line.biz/en/docs/messaging-api/pricing/ ; https://developers.line.biz/en/faq/ |
| Free quota | "All plans allow you to send a certain number of messages for free each month"; the amount depends on the OA's subscription plan **per country**. Japan example on the page: 200 / 5,000 / 30,000. Thai plan numbers: **UNVERIFIED** (not on developers.line.biz; check LINE for Business Thailand). Over the limit the API errors and nothing is sent. | https://developers.line.biz/en/docs/messaging-api/pricing/ |
| `notificationDisabled` | Optional boolean on reply/push: `true` = no push notification for the user. | REF#send-push-message |
| Retry key | `X-Line-Retry-Key: {UUID}` header on push/multicast lets us retry a timed-out send without double delivery. Developer generates the UUID. | REF#send-push-message ; https://developers.line.biz/en/docs/messaging-api/retrying-api-request/ |
| Rate limits | Token-bucket, per channel, per endpoint. Reply, push, getProfile, rich-menu link/unlink, get content fall under "Other API endpoints: **2,000 requests/second**". Loading animation **100 rps**. Multicast 200 rps. Create/delete rich menu **100/hour**. Get rich menu list 10 rps. Over limit = `429 Too Many Requests`. | REF#rate-limits |

Webhook:

| Topic | Fact | Source |
| --- | --- | --- |
| Signature | Header `x-line-signature` = Base64(HMAC-SHA256(channel secret, **raw request body bytes**)). Compare before any parsing; do not re-serialize or let a proxy rewrite the body; keep UTF-8. Missing/mismatched header => do not process. | https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/ |
| Events we handle | 1:1: `message` (text/image/sticker/file/…), `follow` (friend add *or unblock*), `unfollow` (block), `postback`, `unsend`. Groups/rooms: `message`, `edit` (groups only), `unsend`, `join`, `leave`, `memberJoined`, `memberLeft`, `postback`. No `follow`/`unfollow` in groups. | https://developers.line.biz/en/docs/messaging-api/receiving-messages/ (event table) |
| Response | Return HTTP **200** promptly; LINE may POST an empty-event body to check connectivity — still return 200. Process asynchronously. No numeric timeout is published on the pages read: **UNVERIFIED** (treat as "respond in well under a second"). | REF#response ; receiving-messages |
| Redelivery | Off by default; enable in Console > Messaging API > *Webhook redelivery*. Triggers when we don't return 2xx. Count/interval of retries are **not disclosed** and delivery is not guaranteed. Redelivered events are identical except `deliveryContext.isRedelivery: true`; same `webhookEventId` and same reply token. Duplicates and out-of-order delivery can happen: dedupe on `webhookEventId`, order on `timestamp`. | https://developers.line.biz/en/docs/messaging-api/receiving-messages/#webhook-redelivery ; REF#common-properties |
| `mode` | Every event carries `mode`: `active` (normal) or `standby` (no reply token; only relevant with module channels). | REF#common-properties |
| Suspension | LINE "may suspend sending webhooks" if the server keeps failing for a long time; a failing webhook also emails the channel admin. | receiving-messages ; https://developers.line.biz/en/docs/partner-docs/error-notification/ |

## 2. `sender` property (icon + nickname switch)

Source: REF#icon-nickname-switch ("Customize icon and display name") and
https://developers.line.biz/en/docs/messaging-api/icon-nickname-switch/.

```json
{ "type": "text", "text": "…", "sender": { "name": "Lay · ผู้ช่วย AI", "iconUrl": "https://…/lay.png" } }
```

- Shape: `sender.name` (string) and `sender.iconUrl` (string); both optional, set per message object.
- `name`: **max 20 characters**; "certain words such as `LINE` may not be used". Counting rule for `sender.name` is not
  listed on the character-count page; Thai combining marks may count as >1 UTF-16 unit — **UNVERIFIED**, test it.
- `iconUrl`: HTTPS (TLS 1.2+), **PNG only**, **1:1 aspect**, **max 1 MB**, URL max 2000 chars, percent-encoded UTF-8.
  No pixel-size limit stated.
- Message types: "There is no restriction on the type of Message objects" — works on text, Flex, image, sticker, etc.
- APIs: reply, push, multicast, narrowcast, broadcast — all listed as supported.
- Rendering (official page): in the bubble the custom icon + name appear **with "from '<OA name>'" attached** so the
  user can still identify the OA. Chat-room title, chat-list icon/name, friends list and business profile are NOT
  changed. Chat-list preview of non-text messages reads "(Display name) sent a photo". Search results show the custom
  icon/name with the "from" suffix.
- 1:1 vs group: the page does not distinguish; nothing says it is 1:1-only. Group rendering **UNVERIFIED** (test).
- Omitting `sender` => default OA icon and name. So "OA Manager default" identity = just send without `sender`.
- Official advice: push a test to your own account first.

## 3. Human messages from LINE Official Account Manager (chat screen)

- **No webhook event exists for operator-sent messages.** The event list (message, edit, unsend, follow, unfollow,
  join, leave, memberJoined, memberLeft, postback, videoPlayComplete, beacon, accountLink, membership) only covers
  user/system actions; the overview says the API counts "only … messages sent through the Messaging API, not LINE
  Official Account Manager". Absence of a documented event is the evidence — treat "webhook cannot see manual chat
  replies" as **UNVERIFIED-by-omission** and confirm by test. Sources: REF#webhook-event-objects ;
  https://developers.line.biz/en/docs/messaging-api/overview/
- Chat and webhook coexist: since 30 Nov 2022 the old *Response mode* (Bot mode XOR Chat mode) is gone; **Chat
  On/Off** and **Webhooks On/Off** are independent switches in OA Manager > Settings > Response settings. The webhook
  toggle there is **synchronized** with "Use webhook" in the Developers Console. Sources:
  https://developers.line.biz/en/docs/partner-docs/development-guidelines/ ; LINE Developers news 2022-12-01
  ("You can now use both webhooks and chats together…", listed at https://developers.line.biz/en/news/22 — full
  text not fetchable, **UNVERIFIED** beyond the summary).
- Allowed combos: Webhooks on + auto-responses on/off, or Webhooks off + auto-responses on. Webhooks off **and**
  Response mode + Greeting off is not allowed. Source: partner development guidelines (same URL).
- Auto-replies that can fight the bot: Greeting message, Auto-response, and Chat "On" with certain *Chat response
  method* settings. Official recommendation for a bot: disable Greeting and Auto-reply and handle `follow` +
  messages in code. Sources: https://developers.line.biz/en/faq/ ("Why does my LINE Official Account automatically
  send replies?") ; https://developers.line.biz/en/docs/messaging-api/building-bot/
- Chat Off => user messages are auto-marked read; Chat On => we must mark read ourselves via
  `POST /v2/bot/chat/markAsRead` with the `markAsReadToken` from the message event (no expiry). Source:
  https://developers.line.biz/en/docs/messaging-api/mark-as-read/
- Per-chat "turn off auto-response / bot" in the OA Manager chat screen: **UNVERIFIED** — not documented on
  developers.line.biz; it is an OA Manager UI feature (help.line.me). Do not design around it; design the handoff in
  our own state ("human mode" flag per user).

## 4. Quick reply

Source: https://developers.line.biz/en/docs/messaging-api/using-quick-reply/ ; REF#quick-reply ; REF#action-object-label-spec

- **Max 13** items; attach `quickReply.items` to any message type; when several messages are sent in one call, only
  the **last** message's quickReply is shown.
- Label: **required, max 20 chars** (counted in grapheme clusters). Optional `imageUrl`: HTTPS, **PNG, 1:1, ≤1 MB**.
- Actions: postback, message, uri, datetimepicker, clipboard, plus quick-reply-only camera, cameraRoll, location.
  **Not** allowed: richmenuswitch.
- Available in **1:1, group and multi-person chats** (official). iOS/Android only; old clients just show the message.
- Disappear when the user taps one (camera/cameraRoll/datetimepicker/location buttons persist until data is sent) or
  when **any new message** appears in the room; if that message is deleted they reappear.
- Rich menu interplay: none documented beyond "switch action not allowed" (quick reply sits above the composer, rich
  menu below — visual coexistence **UNVERIFIED**, test).
- Postback: `data` ≤300 chars, `displayText` ≤300 (shows as a user bubble); message action `text` ≤300.

## 5. Flex Message limits

Sources: REF#flex-message, #bubble, #f-carousel, #button, #f-image, #f-text ; https://developers.line.biz/en/docs/messaging-api/flex-message-elements/ ;
https://developers.line.biz/en/docs/messaging-api/flex-message-layout/ ; https://developers.line.biz/en/docs/messaging-api/using-flex-messages/

| Item | Limit |
| --- | --- |
| `altText` | **required, max 1500 chars**; shown in notifications, chat list and quotes. Unicode emoji allowed. |
| Bubble | JSON **≤30 KB**. `size`: `nano`, `micro`, `deca`, `hecto`, `kilo`, `mega` (default), `giga`. `deca`/`hecto` need LINE 13.6+/PC 7.17+, else render as `kilo`. Width depends on device screen (no px given). |
| Carousel | **≤12 bubbles**, JSON **≤50 KB**. |
| Blocks | header, hero, body, footer — each at most once, none required. |
| Text | `wrap` default **false** (overflow is truncated with "…"); `\n` only breaks lines when `wrap: true`. `maxLines` (0 = all, else ellipsis). `size` tokens `xxs xs sm md lg xl xxl 3xl 4xl 5xl` or px (no %). `lineSpacing` "Npx", LINE 11.22+. `adjustMode: shrink-to-fit` is best-effort ("may not work at all" on some platforms). |
| Button | `style` `primary` / `secondary` / `link`; `color` hex = background for primary/secondary, text for link; `height` `sm`/`md`. Label **required, ≤40 chars**. |
| Image | HTTPS TLS 1.2+, JPEG/PNG, **≤1024×1024 px**, **≤10 MB** (300 KB if `animated`), URL ≤2000 chars. `size` tokens xxs…5xl / `full` / px / %; `aspectRatio` "W:H"; `aspectMode` cover/contain. |
| Video (hero) | mp4 ≤200 MB, needs `altContent` image for old clients. |
| Icon | only inside a `baseline` box. |
| Separator | horizontal line in a vertical box, vertical in a horizontal box. |
| Filler | deprecated — use padding/offset. |
| Simulator | https://developers.line.biz/flex-simulator/ |

Fails-silently notes: unwrapped long Thai text gets cut with "…"; rendering differs by OS, LINE version, font and
language settings; trailing `\n` renders differently per device; `gravity`/`offsetBottom` ignored in baseline boxes;
absolute-positioned components drift unless both offsets are set. (flex-message-elements, flex-message-layout)

## 6. Loading animation

Source: REF#display-a-loading-indicator ; https://developers.line.biz/en/docs/messaging-api/use-loading-indicator/

- `POST https://api.line.me/v2/bot/chat/loading/start` with `{ "chatId": "U…", "loadingSeconds": 5 }`.
- `loadingSeconds` **5–60**; animation ends when the time elapses **or when our next message arrives**.
- **1:1 only** — "You can't specify group chats or multi-person chats". LINE iOS/Android 13.16+.
- Only visible if the user is currently viewing the chat; otherwise nothing happens (no notification, not shown later).
- Repeat call while visible: timer is reset to the new value (so it is effectively idempotent; no retry key).
- Rate limit 100 rps.

## 7. Rich menu

Sources: REF#rich-menu-object, #upload-rich-menu-image, #link-rich-menu-to-user, #richmenu-switch-action, #create-rich-menu ;
https://developers.line.biz/en/docs/messaging-api/rich-menus-overview/ ; …/use-per-user-rich-menus/ ; …/switch-rich-menus/

- Image: JPEG or PNG, **width 800–2500 px, height ≥250 px, aspect (w/h) ≥1.45, ≤1 MB**. Upload via
  `POST https://api-data.line.me/v2/bot/richmenu/{richMenuId}/content`. Image cannot be replaced — make a new menu.
  The six "template" sizes (2500×1686, 2500×843, 1200×810, 1200×405, 800×540, 800×270) are OA Manager templates,
  all inside the API range; the API does not list them as the only options — **UNVERIFIED as a fixed list**.
- `areas`: **max 20**; `chatBarText` **max 14 chars** (grapheme clusters); `name` ≤300 (internal). `selected: true`
  opens the menu by default. Validate first with the *Validate rich menu object* endpoint.
- Actions: postback, message, uri, datetimepicker, clipboard, **richmenuswitch** (rich menu only; label ≤20, read
  by accessibility).
- Max **1000** rich menus per channel (create returns 400 past that). Alias count limit exists but is not numbered.
- Default menu: `POST /v2/bot/user/all/richmenu/{richMenuId}` — takes effect when the user re-opens the chat (up to
  ~1 min). Per-user: `POST /v2/bot/user/{userId}/richmenu/{richMenuId}` — **immediate**, one menu per user, replaces
  the previous link; `DELETE /v2/bot/user/{userId}/richmenu` unlinks and falls back to the default. Per-user link
  needs the user to be a friend. Priority: per-user (API) > default (API) > default (OA Manager).
- Rate: link/unlink are "other endpoints" (2,000 rps); batch link/unlink 3/hour; create/delete 100/hour.
- Tabs: aliases (`POST /v2/bot/richmenu/alias`) + `richmenuswitch` action; switching fires a `postback` event with
  the alias ID.
- Menus made in OA Manager and via API are separate: each is editable only in its own tool.
- Not displayed on LINE for PC.

## 8. Group chats

Sources: https://developers.line.biz/en/docs/messaging-api/group-chats/ ; REF#source-group ; REF#get-group-member-profile ; REF#get-profile

- `source`: `{ "type": "group", "groupId": "C…", "userId": "U…" }` (room: `type: "room"`, `roomId`). `userId` is
  **"Not always included"**: only in message events, and only for iOS/Android users who consented.
- "Allow bot to join group chats" is **off by default** in the Console; only one OA can be in a group at a time.
- Profile: `GET /v2/bot/group/{groupId}/member/{userId}` works for any member of a group the OA is in, even if they
  are not a friend or have blocked us. Plain `GET /v2/bot/profile/{userId}` needs friend or recent 1:1 message.
- Push to a group: put the `groupId` in `to`; visible to all members. Multicast to groups is not possible.
- Events in groups: message, edit, unsend, join, leave, memberJoined, memberLeft, postback (no follow/unfollow).
- `sender` in groups: not restricted by the docs, rendering **UNVERIFIED**. Loading animation is not available.

## 9. Content retrieval

- `GET https://api-data.line.me/v2/bot/message/{messageId}/content` (note the `api-data` host) for image/video/audio/
  file, only when `message.contentProvider.type == "line"`. Content is deleted by LINE "after a certain period"
  (unspecified) and text cannot be re-fetched. Source: REF#get-content ; receiving-messages.

## 10. Text message limits

Sources: REF#text-message ; https://developers.line.biz/en/docs/messaging-api/text-character-count/

- `text` **max 5000 chars, counted in UTF-16 code units** (an emoji like 🍎 = 2; some Thai combining sequences >1).
- Unicode emoji are allowed inline. LINE emoji use `$` placeholders + `emojis[]` (max 20, with `productId`/`emojiId`);
  a wrong `index` returns 400. "LINE original unicode emojis" were discontinued 2022-03-31.
- Newlines: plain `\n` in `text`; no counting rule given for newlines (count as 1 code unit by UTF-16 — inference).
- `textV2` (`type: "textV2"`) adds `{mention}`/`{emoji}` substitution; not needed for Lay v2.

## 11. Gotchas / recommendations for our build (our own bullets)

- **Reply first, push second.** Replies are not billed; keep the reply token hot by acking the webhook, firing the
  loading animation, and replying within ~1 minute. Fall back to push only after that window.
- **Three identities = three `sender` presets** (`Lay`, `มอส`, none). Icons must be public HTTPS **PNG 1:1 ≤1 MB**
  on a host with TLS 1.2+. Name ≤20 — "Lay · ผู้ช่วย AI" fits, but test the Thai count.
- LINE always appends **"from <OA name>"** to custom senders — design copy knowing the OA name stays visible.
- Dedupe webhooks on `webhookEventId`; honour `isRedelivery`; never reply twice to the same reply token (400).
- Verify the signature on the raw body **before** JSON parsing; make sure the reverse proxy does not alter the body.
- `wrap: true` on every Flex text that carries Thai sentences; set `maxLines` where layout matters; keep `altText`
  a real sentence (it is the notification text) even though the limit is 1500.
- Keep a bubble ≤30 KB / carousel ≤50 KB / 12 bubbles; preview in the Flex simulator on both light and dark theme.
- Quick replies vanish on the next message in the room — do not rely on them in group chats where others type.
- Demo mode: use the **per-user** rich-menu link (immediate) to swap menus, and unlink to fall back to the default.
- OA Manager: switch **Greeting** and **Auto-response** off; keep **Webhooks** on; decide Chat On/Off deliberately
  (Chat On means we own the read receipts via `markAsRead`).
- Turn on **Webhook redelivery** in the Console, and keep the handler idempotent because of it.
- Human-relay ("มอส") messages must be sent through our backend (push with `sender`) — anything typed in the OA
  Manager chat screen is invisible to the bot and carries the default identity.

## Open questions to verify by test

1. How `sender` renders in a group chat and in the chat-list preview on iOS vs Android (and on LINE PC).
2. Whether `sender.name` "Lay · ผู้ช่วย AI" passes the 20-char limit (UTF-16 vs grapheme counting).
3. Whether an operator reply typed in the OA Manager chat screen produces **any** webhook event (expected: none).
4. What the per-chat "pause bot / manual response" toggle in OA Manager actually does to webhook delivery.
5. Real webhook response deadline before LINE counts the call as failed and schedules redelivery.
6. Quick reply + rich menu on screen at the same time: layout on small phones.
7. Thai free-message quota for our OA plan (LINE Thailand pricing) and whether the OA Manager dashboard counts
   our pushes the same way as `GET /v2/bot/message/quota/consumption`.
8. Flex rendering of long Thai strings with `wrap: true` and `lineSpacing` on Android (tone marks clipping).
9. Loading animation behaviour when a reply arrives in <1 s (flicker?) and when the user is not in the chat.
