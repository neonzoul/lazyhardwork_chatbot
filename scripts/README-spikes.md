# Lay v2 spikes — LINE render tests

Throwaway scripts that push test messages to one LINE user/group so we can see how LINE renders
things before building the real renderer. They read `LINE_CHANNEL_ACCESS_TOKEN` from `.env`
(never commit `.env`). Both support `--dry-run`, which prints the exact request bodies and makes
no API call at all.

## `spike-identity-test.js` — per-message identity (`sender`)

Pushes four separate text bubbles to check how LINE's `sender` property (custom icon + nickname)
renders next to the OA default:

1. Lay identity (`sender.name` = `Lay · ผู้ช่วย AI`)
2. Mos identity (`sender.name` = `มอส`)
3. No `sender` (OA default name + icon)
4. Lay identity again, with a two-item quick reply row (`เรียก Lay`, `คุยกับมอส` → postback `MENU_HANDOFF`)

```
node scripts/spike-identity-test.js --to <userId|groupId> [--lay-icon URL] [--mos-icon URL] [--dry-run]
```

Icon URLs: env `LAY_ICON_URL` / `MOS_ICON_URL` win, then the flags, then labelled placeholders
from placehold.co (a warning is printed). Icons must be HTTPS; `sender.name` is asserted ≤ 20 chars.
Prints one line per push with HTTP status, and the LINE error body on failure. Exits non-zero on any failure.

## `spike-flex-render.js` — Flex card render test

Builds the three Lay v2 card templates inline (warm off-white `#FAFAF8`, ink `#1B1B1B`, muted
`#6B6B6B`, one emerald `#0E6E5C` primary button per card, amber pill only on the confirm card):

| template | what it is |
|---|---|
| `choice` | "เหมาะกับงานผมไหม" — five `FIT_*` postback options (tappable boxes, since the full Thai wording exceeds LINE's 20-char action label) |
| `offer` | "ตั้งค่า AI Workspace — Starter" — 4 bullets, price row, Fastwork URI button + `BOOK_START` |
| `summary_confirm` | "ขอนัดคุย 30 นาที" — 4 key/value rows, "รอมอสยืนยัน" pill, `BOOK_CONFIRM` / `BOOK_EDIT` |

```
node scripts/spike-flex-render.js --to <userId> [--template choice|offer|summary_confirm|all] [--carousel] [--dry-run]
```

`--carousel` sends the selected bubbles as one carousel message. A local validator runs before
anything is sent (altText ≤ 400 chars, Flex JSON ≤ 50 KB, no empty text components, every bubble
has a body, action labels ≤ 20 chars, https-only URIs) and prints `validated` or the violations.
`FASTWORK_URL` from `.env` overrides the placeholder Fastwork URI.

## Finding a LINE userId

LINE Developers Console → your provider → the Messaging API channel → **Basic settings** tab →
scroll to **Your user ID** (starts with `U`). That is the admin's own userId and works as `--to`
as long as the admin has added the OA as a friend.

For a group, use the `groupId` from a webhook event (`source.groupId`) after inviting the OA to the
group. The channel's **webhook must be ON** (Messaging API tab → Use webhook) for group tests,
otherwise the OA never learns the group id and group pushes will not be visible in your logs.
