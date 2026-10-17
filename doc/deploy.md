# Deploy runbook — Lay v2 on Railway

**Status (2026-10-17): nothing is created yet.** The Railway CLI on the build machine is not logged in (D-18), so
these steps are for Mos, or for an agent after `railway login`. Until then the local app serves the test OA
through an ngrok tunnel. `main` (v1) stays live on its existing Railway service until the Tuesday cut-over.

## 0. Prerequisites

- **OpenAI credit** on the account behind `OPENAI_API_KEY` — without it every turn is the fallback reply. Check
  before the first smoke test, not after.
- The **test LINE channel** credentials (`LINE_CHANNEL_*` in `.env`, D-14) and the production ones (`LINE_PROD_*`).
- Discord bot created with **Message Content Intent** on, invited to the guild with View Channel · Send Messages ·
  Create Public Threads · Send Messages in Threads · Read Message History in `#leads` (D-17, `doc/discord.md`).
- `knowledge/` built and committed on `v2` (`npm run kb:build -- --project-dir …`); `npm test` and
  `npm run scenarios` green.

## 1. Create the staging service (test channel)

1. Railway → the existing project → **New service → GitHub repo** `neonzoul/lazyhardwork_chatbot`, branch **`v2`**.
   Name it `lay-v2`. Node is auto-detected; start command is `npm start` (`engines >= 22.13`, `node:sqlite`).
2. **Volume**: service → Volumes → add, mount path **`/data`**. One instance only — SQLite is not shared across
   replicas. Without the volume the DB dies on every deploy (`doc/store.md`).
3. **Variables** (service → Variables). S = secret.

| Variable | Value for staging | |
|---|---|---|
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` | the **test** channel | S |
| `LINE_PROD_CHANNEL_SECRET` / `LINE_PROD_CHANNEL_ACCESS_TOKEN` | production channel (used by `setup-rich-menu --channel prod`; the app itself reads `LINE_CHANNEL_*`) | S |
| `LINE_TEST_CHANNEL_ID`, `LINE_TEST_BOT_BASIC_ID`, `MOS_LINE_USER_ID` | from the Developers Console / logs | |
| `OPENAI_API_KEY` | key with credit; model is in `src/agents.config.js` | S |
| `DISCORD_BOT_TOKEN` | relay bot | S |
| `DISCORD_GUILD_ID`, `DISCORD_LEADS_CHANNEL_ID`, `DISCORD_CRM_CHANNEL_ID` | ids | |
| `DISCORD_LEADS_WEBHOOK`, `DISCORD_CRM_WEBHOOK` | webhook fallback when the bot cannot open a thread | S |
| `PUBLIC_BASE_URL` | `https://<railway domain>` (no trailing slash) — step 4 | |
| `LAY_ICON_URL`, `MOS_ICON_URL` | `${PUBLIC_BASE_URL}/assets/lay-icon.png`, `…/mos-icon.png` (may be omitted: config derives them) | |
| `DB_PATH` | `/data/lay.sqlite` | |
| `ADMIN_TOKEN` | long random string (bearer for `/admin/*`) | S |
| `CONTACT_PHONE`, `CONTACT_PHONE_DISPLAY`, `FASTWORK_URL` | profile values; default display `095 569 1674 (มอส)` | |
| `BUSINESS_HOURS_START` / `END` | `13` / `22` | |
| `QUIET_WINDOW_MINUTES`, `DEBOUNCE_MS`, `KNOWLEDGE_DIR` | optional (defaults 30, 6500, `knowledge`) | |
| `DISCORD_REGISTER_COMMANDS` | optional `1` to register guild slash commands on start | |

`PORT` is injected by Railway — do not set it. `CONTACT_EMAIL` and `ADMIN_SECRET` are v1-only; leave them unset.

4. **Domain**: Settings → Networking → Generate Domain. Put it in `PUBLIC_BASE_URL` (and the icon URLs if set),
   redeploy. Icons must resolve as public HTTPS PNG 1:1 ≤ 1 MB: open `https://<domain>/assets/lay-icon.png`.
5. **Webhook** (test channel): locally, with the test token in `.env`,
   `node scripts/set-webhook.js https://<domain>/webhook` — it sets the endpoint and runs LINE's test call.
   In OA Manager for the test OA: Webhooks **on**, Greeting **off**, Auto-response **off**; turn on Webhook
   redelivery in the Developers Console.
6. **Rich Menu** (test channel): `node scripts/setup-rich-menu.js --dry-run`, then `node scripts/setup-rich-menu.js`
   (creates `lay-default` + `lay-demo`, sets the default). After any image change: `--recreate`.

## 2. Smoke checks (staging)

1. `GET https://<domain>/health` → `{"status":"ok","version":"2.0.0-dev","pack":"<built_at>"}` — `pack: null`
   means `knowledge/` is missing from the deploy.
2. On the test OA send **สวัสดี** → opening with 3 quick replies from `Lay · ผู้ช่วย AI` (LINE appends "from <OA>").
3. Tap **each Rich Menu tile**: ทำอะไรได้บ้าง · เหมาะกับงานผมไหม (symptom card) · ขอดูตัวอย่าง (carousel) · เริ่มยังไง ·
   คุยกับมอส (thread appears in `#leads`, Lay goes quiet) · เรียก Lay (Lay returns).
4. In the `#leads` thread type a line → arrives on LINE as **มอส**; `/lay` → Lay back.
5. Railway logs: `app.started` with `relay: true`; no `model.fallback` lines. `GET /admin/events` with the token.

## 3. Tuesday cut-over (2026-10-20, after Mos's go)

1. Freeze: `npm test` + `npm run scenarios` green on `v2`; FAQ approved and `kb:build` re-run if it changed.
2. Merge `v2 → main` (fast-forward or merge commit; this is the first push to `main` since the freeze).
3. Production LINE channel: either switch the `lay-v2` service's `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`
   to the `LINE_PROD_*` values, or create a second service `lay-v2-prod` from `main` with the same variable set,
   its own volume and domain, and the production values in `LINE_CHANNEL_*`. Option two keeps staging alive.
4. Rich Menu on production: `node scripts/setup-rich-menu.js --channel prod --yes-prod`.
5. Point the production channel's webhook at the v2 URL: with the prod token in `LINE_CHANNEL_ACCESS_TOKEN`
   (temporarily, locally) `node scripts/set-webhook.js https://<prod v2 domain>/webhook`. OA Manager: Greeting and
   Auto-response off.
6. Confirm with **one message** from Mos's own LINE: opening arrives from Lay, `app.started` in the logs, the
   message row shows up under `GET /admin/sessions/<MOS_LINE_USER_ID>`.
7. **Keep the v1 service running for 24 h** (do not delete, do not change its variables).
8. Next morning: `node scripts/lead-sync.js --vault <root> --dry-run` to see the first leads; then without `--dry-run`.

## 4. Rollback

Point the production webhook back at the v1 service URL (`set-webhook.js https://<v1 domain>/webhook`). Nothing
else is needed: v1 keeps its own state, v2's SQLite stays on its volume for diagnosis. Rich Menu: v1's menu was made
in its own tool; if the v2 default menu must go, delete it via the API (`--recreate` logic in `src/line/richmenu.js`)
or set the v1 menu as default again.

## 5. Day-to-day after cut-over

- Push to the deployed branch = redeploy; migrations run on boot (`doc/store.md`).
- Knowledge change: edit the vault → `npm run kb:build -- --project-dir …` → commit `knowledge/` → push.
- Backup: `store.checkpoint()` then copy `/data/lay.sqlite` (`doc/store.md` §Backup).
