# Deploy runbook — Lay v2 (as it is on 22 Oct 2026)

Who reads this: any agent or Mos deploying, checking, backing up or moving Lay. Secrets never appear here or in chat;
read and set them with tools that do not print values.

## 0. Where Lay runs

| What | Where |
|---|---|
| Production | Railway project "LazyHardWork LineOA Chatbot", environment `production`, service `lazyhardwork_chatbot`, domain `lazyhardworkchatbot-production.up.railway.app`, volume `lazyhardwork_chatbot-volume` at `/data` |
| Production LINE OA | `@638bnoee` ("LazyHardWork \|Studio"); webhook `https://<domain>/webhook`; OA Manager set to manual chat |
| Test LINE OA | "[Test] LazyHardWork" — runs from a local app behind the ngrok tunnel (§7) |
| Code | `github.com/neonzoul/lazyhardwork_chatbot`. `main` = what production deploys. `v2` = integration branch |
| Discord | one bot (`agent.layline.lazyhardwork`) in the LhW server: `#leads` threads, `#crm` alerts |
| LLM | OpenRouter (`OPENROUTER_API_KEY`, optional `_2`, `_3`) — doc/llm.md |

## 1. Release path and gates

1. Work lands on `v2`, never on `main` without Mos's go for that change.
2. Gates before `main`, in this order:
   - `npm test` and `npm run scenarios` green locally, CI green on `v2`.
   - Real-model replay of the replay scenarios (70–77 today):
     `node tests/run-scenarios.js --model real --only "7"` with a working key. Scenario 70 step 12 is a known,
     accepted failure ("แล้วจะให้มัยเรียกว่าอะไร").
   - Mos tests the change on the test OA from his own LINE (§7).
   - Mos's go, in his own words.
3. `main` is fast-forwarded to `v2` (`git push origin v2:main`) and Railway builds it (§3).

## 2. Production variables (names only)

| Name | Notes |
|---|---|
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | the production channel (`@638bnoee`) |
| `OPENROUTER_API_KEY` (+ `_2`, `_3`) | rotation order; a 401 or a spent key falls through to the next |
| `ADMIN_TOKEN` | bearer token for `/admin/*` (sessions, leads, events, backup, take, reset, forget) |
| `PUBLIC_BASE_URL` | `https://<domain>`; icons and images are served from it |
| `DB_PATH` | `/data/lay.sqlite` (on the volume) |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_LEADS_CHANNEL_ID`, `DISCORD_CRM_CHANNEL_ID` | relay + alerts |
| `DISCORD_LEADS_WEBHOOK`, `DISCORD_CRM_WEBHOOK` | fallback when the bot cannot post |
| `MOS_LINE_USER_ID`, `CONTACT_PHONE`, `FASTWORK_URL`, `BUSINESS_HOURS_START/END` | facts Lay uses |
| `EXAMPLES_IMAGES_READY` | unset until real example images replace the placeholders (doc/demo.md) |

Railway applies a variable change **only with the next deployment**. Setting a variable is not enough: check §4.

## 3. Deploying on Railway

- A push to `main` triggers a build (Nixpacks, Node 22). Watch `railway deployment list` or the dashboard.
- **No deployment appeared?** Railway's GitHub trigger can fail (22 Oct). An empty commit through `v2` → `main`
  re-triggers; if that fails too, `railway up --detach` from a clean checkout of the same commit
  (`git worktree add .worktrees/deploy <sha>` then `railway up .worktrees/deploy --path-as-root --detach`).
- **"Limited Access — Deploys have been paused due to an upstream issue"** in the dashboard, or `railway up` answering
  "Deploys have been paused temporarily": a Railway platform incident (status.railway.com). Nothing to do on our
  side; production keeps running the last deployment. Deploy when the banner is gone.
- The Railway CLI login expires; `railway whoami` → "Unauthorized" means Mos runs `railway login` in the app's
  terminal and confirms in the browser.
- The Dockerfile is kept in `deploy/` on purpose: a root `Dockerfile` would switch Railway to a Docker build on the next
  deploy. Move it only after a verified Docker build (§5).

## 4. After every deploy

1. `GET /health` → `status: ok` and the expected `pack` timestamp.
2. `GET /admin/llm/status` (token) → the running key's label (`sk-or-v1…xxxx`) is the NEW one and not exhausted.
   The 10-minute key check logs `llm.budget_refresh_failed … 401` while a key is rejected.
3. Logs: `app.started` with `relay: true`, then `discord.relay_ready`.
4. Smoke (synthetic user; LINE rejects its pushes, which the script expects):
   `node scripts/smoke-webhook.js --base https://<domain> --secret <LINE secret> --token <ADMIN_TOKEN> --wait-text 20000 --wait-postback 16000`
   → 24 PASS. Then delete the synthetic user: `DELETE /admin/users/<Usmoke-…>` with `{"confirm": "<Usmoke-…>"}`.
5. Rich Menu only when it changed: `node scripts/setup-rich-menu.js --channel prod --yes-prod` with
   `PUBLIC_BASE_URL` set to the production domain.

## 5. Docker image (any host)

- `docker build -f deploy/Dockerfile -t lay-v2 .` from the repo root (Node 22 slim, runtime files only, runs as `node`,
  database on `/data`, `/health` health check).
- Run: `docker run -d --name lay -p 8080:8080 --env-file lay.env -v lay-data:/data lay-v2`.
- Status 22 Oct: written but **not yet built** — Docker was not running on the dev machine. Build and run it once
  (health 200, smoke 24/24 against it) before any host relies on it.

## 6. Moving off Railway in about an hour (VPS: Hetzner or DigitalOcean)

Files: `deploy/vps/` — `docker-compose.yml` (Lay + Caddy for automatic HTTPS, optional static website),
`Caddyfile`, `lay.env.example`, `backup.sh`.

1. Server: Ubuntu LTS, Docker + compose plugin, firewall open only 22/80/443, SSH keys only. A Singapore region is the
   closest to Thai customers.
2. `git clone` the repo to `/opt/lay`, `cp deploy/vps/lay.env.example deploy/vps/lay.env`, fill it on the server.
3. DNS: an A record for the bot host (e.g. `lay.<domain>`) → the server IP. Set `PUBLIC_BASE_URL` to it.
4. Restore the newest backup into the volume before the first start (§8 restore), then
   `LAY_DOMAIN=lay.<domain> docker compose -f deploy/vps/docker-compose.yml up -d --build`.
5. Check `https://lay.<domain>/health`.
6. **Discord: one process at a time.** The same bot in two places races for buttons and thread messages. Stop or
   suspend the Railway service (or remove its `DISCORD_BOT_TOKEN`) before the VPS starts with the token.
7. Point the production LINE webhook at the VPS (LINE Developers console, or
   `node scripts/set-webhook.js https://lay.<domain>/webhook` with the production token) and verify (LINE test → 200).
8. Run §4 checks against the VPS. Keep Railway stopped, not deleted, for a week as the way back.
9. On the VPS, cron `deploy/vps/backup.sh` nightly; set `LAY_BACKUP_REMOTE` (an rclone remote) so a copy leaves the box.

## 7. Test OA (Mos's tests, no production touch)

- Run v2 locally with the test channel credentials from `.env`, the OpenRouter key from Railway injected into the process
  only, a fresh `DB_PATH`, and **`DISCORD_BOT_TOKEN` empty** (production holds the bot; lead posts still reach `#leads`
  through the webhook, without buttons).
- Tunnel: `npx ngrok http 3100` (fixed domain on this account), then
  `node -r dotenv/config scripts/set-webhook.js https://<tunnel>/webhook` (test channel token from `.env`).
- Smoke against the tunnel with long waits (`--wait-text 50000 --wait-postback 50000`): LINE's rejection of synthetic
  users is slow from a local machine and overlapping turns give false FAILs.

## 8. Backups

- Route: `GET /admin/backup` (token) streams a consistent snapshot (`VACUUM INTO`) of the whole database. It contains
  customer data.
- Off-host copy: `npm run backup` (= `node scripts/backup-db.js`) downloads it, checks `integrity_check` and the core
  tables, names it `lay-YYYY-MM-DD.sqlite` (Bangkok date), keeps the newest 14, exits non-zero on any failure.
  Options `--base-url`, `--out` (or `LAY_BACKUP_DIR`), `--keep`. Never store backups in git or the vault.
- Daily on Mos's Windows machine (Task Scheduler, a user task — runs only while the machine is on):
  `schtasks /Create /SC DAILY /ST 03:00 /TN "LazyHardWork\Lay daily backup" /TR "cmd /c cd /d <repo> && node scripts/backup-db.js --out <backup dir> >> <backup dir>\backup.log 2>&1"`
- On a VPS: `deploy/vps/backup.sh` (§6 step 9).
- Restore: stop the app, copy the backup over `DB_PATH`, delete stale `-wal`/`-shm`, start. On Docker:
  `docker compose cp lay-YYYY-MM-DD.sqlite lay:/data/lay.sqlite` with the service stopped (`docker compose stop lay`).
- The route ships with `main` ≥ the commit that added it; until production runs it, the script gets 404.

## 9. Rollback

- Railway: redeploy the previous successful deployment from the dashboard, or `git push --force-with-lease origin <good-sha>:main`
  (Mos's go; the next build is that commit).
- Variables: put the old value back and redeploy.
- VPS: `git checkout <good-sha>` in `/opt/lay`, `docker compose up -d --build`.

## 10. Incidents we have seen (and what to do)

| Date | What | Do |
|---|---|---|
| 22 Oct | OpenRouter rejected the key (401 "User not found"); every model turn got the error line; no alert (fixed on v2: one `@here` "llm_key_rejected") | New key on Railway → redeploy (§3) → §4 step 2 |
| 22 Oct | Railway platform outage, deploys paused | Wait for the banner to clear; production keeps running |
| 22 Oct | A Discord thread rename reached LINE as "มอส" (fixed: system messages are never relayed) | Deploy `main` ≥ aa57b8f; until then, don't rename lead threads |
| 20 Oct | Mos replied in LINE OA Manager; Lay could not see it | Take the chat first (Human Mode: "Human Mode -⏸️Lay" on the #leads post, `/take`, or `POST /admin/sessions/:userId/take`) |
