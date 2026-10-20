# Lay v2 — store (SQLite via `node:sqlite`)

Design of record: design-lay-v2 §5 (data model) and §9 (leads export). Code: `src/store/`. Everything the pipeline
needs is behind `createStore({ path })`; a later move to Postgres touches `src/store/` only.

```js
const { createStore } = require('./src/store');
const store = createStore({ path: process.env.DB_PATH, clock, log }); // opens, migrates, returns repositories
await store.sessions.getOrCreate(userId);
await store.close();
```

- `path` defaults to `process.env.DB_PATH || ./data/lay.sqlite`; the parent folder is created. `:memory:` for tests.
- Pragmas: WAL journal, `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON`.
- `node:sqlite` is synchronous; every repository method still returns a Promise so `tests/fakes/store.js` and the
  real store are interchangeable (same method names and return shapes — the fake is the contract).
- Node ≥ 22.13 (Railway: pin 22 or 24 in `engines`). Node 24 prints an `ExperimentalWarning` for `node:sqlite`;
  harmless, silence with `--no-warnings` if it bothers the logs.

## Repositories (`src/store/repo/*.js`)

| Repo | Methods | Notes |
|---|---|---|
| `sessions` | `get(userId)`, `getOrCreate(userId)`, `save(session)`, `all()` | `topics_covered` (array), `draft`, `homework` (objects) and bools round-trip as JS values. `save` upserts; `mode` validated (`lay/quiet/mos_active/demo`). |
| `messages` | `append(m)`, `recent(userId, n = 12)`, `byUser(userId)`, `all()` | `recent` returns the chronological tail (oldest first). `payload` is JSON. |
| `leads` | `byUser(userId)`, `upsert(lead)`, `since(iso)`, `all()`, `get(id)` | Missing `id` ⇒ `L-YYYY-MM-DD-line_oa-xxxxxx` (date from the clock, UTC). `upsert` merges over the existing row. `since` filters on `updated_at ≥ iso`, so a changed lead re-syncs. |
| `bookings` | `create(b)`, `get(id)`, `update(id, patch)`, `pendingFor(userId)`, `forLead(leadId)`, `all()` | Ids `B-YYYY-MM-DD-xxxxxx`; status defaults to `pending`; `fields`, `proposed_windows` are JSON. |
| `kbGaps` | `append(gap)`, `all()` | `kb_refs_tried` JSON array. |
| `relayThreads` | `byThread(threadId)`, `byUser(userId)`, `create(t)`, `all()` | Discord thread id stored as TEXT; `byUser` returns the newest thread. |
| `outbox` | `enqueue({kind, payload})`, `nextBatch(n)`, `markSent(id)`, `markFailed(id, err)`, `get(id)`, `all()` | Retry queue for non-promise notifications. `markFailed` bumps `attempts`, sets backoff (30 s → 2 m → 10 m → 30 m → 1 h); after 5 attempts the row is `failed` and leaves the queue. |
| `events` | `append(e)`, `recent(n)`, `all()` | Flat extra fields on `e` are folded into `payload`. |

Plus `store.checkpoint()` (WAL flush) and `store.close()` (idempotent).

## Tables (migration `001-init.sql`)

All timestamps are ISO-8601 TEXT (UTC). JSON columns are TEXT holding JSON. Booleans are INTEGER 0/1.

- `sessions` — `user_id` PK, `display_name`, `mode`, `mode_since`, `demo_shop`, `topics_covered` json, `draft` json,
  `homework` json, `questions_asked`, `loose_ends_fired`, `opened`, `booking_step`, `last_customer_at`, `last_bot_at`,
  `created_at`, `updated_at`. Indexes: `mode`, `updated_at`.
- `messages` — `id`, `user_id`, `role` (customer/lay/mos/demo_shop/system), `sender_name`, `kind`
  (text/card/quick/postback/media), `text`, `payload` json, `reply_token_used`, `created_at`. Indexes:
  `(user_id, created_at)`, `created_at`.
- `leads` — `id` PK, `user_id`, `status` (new/qualified/booking_pending/booked/offer_shown/closed), `card_id`, `symptom`,
  `homework` json, `customer_words_th`, `wave_group`, `source`, `discord_thread_id`, `synced_at`, `created_at`,
  `updated_at`. Indexes: `user_id`, `status`, `created_at`, `updated_at`.
- `bookings` — `id` PK, `lead_id`, `user_id`, `window_text`, `fields` json, `status`
  (pending/confirmed/reproposed/declined/cancelled), `proposed_windows` json, `decided_by`, `decided_at`, `created_at`,
  `updated_at`. Indexes: `user_id`, `lead_id`, `status`, `created_at`.
- `kb_gaps` — `id`, `user_id`, `question`, `kb_refs_tried` json, `forwarded`, `created_at`.
- `relay_threads` — `discord_thread_id` PK, `user_id`, `lead_id`, `opened_for` (handoff/booking), `created_at`.
- `outbox` — `id`, `kind` (discord_notify/line_push), `payload` json, `status` (pending/sent/failed), `attempts`,
  `last_error`, `next_attempt_at`, `sent_at`, `created_at`. Index: `(status, next_attempt_at)`.
- `events` — `id`, `kind`, `user_id`, `payload` json, `created_at`. Indexes: `kind`, `user_id`, `created_at`.
- `schema_migrations` — `id`, `name`, `applied_at` (written by `migrate.js`).

Contact details (display name, LINE user id) live only here and later in the vault's `_agent/data/leads.yaml` —
never in Discord or the growth ledger (design §5/§9).

## Reset context and erase a user (20 Oct 2026)

- **Reset** (`/reset` in the lead thread, or `POST /admin/sessions/:userId/reset`): `core/session.resetContext` clears what Lay
  knows (draft, homework, topics, flags, demo, booking step), sets mode `lay` and stores `context_since`. The model history
  (`core/turn.askModel`, `flows/demo`) ignores messages before it. Transcript, lead and events stay.
- **Erase** (`/forget` then the confirm button, or `DELETE /admin/users/:userId` with `{"confirm": "<userId>"}`):
  `store.forgetUser(userId)` deletes in one transaction from every table with a `user_id` (sessions, messages, leads,
  bookings incl. bookings of the user's leads, kb_gaps, relay_threads, events, llm_calls) and outbox rows whose payload names
  the user. One `user_deleted` event remains with a hashed reference and the counts, no personal data. A test fails if a new
  table with `user_id` is not covered.
- **Not erased by us:** messages already on the customer's phone, the chat in LINE OA Manager, the Discord thread (Mos deletes
  it by hand), copies in vault files written by lead-sync (`_agent/data/leads.yaml`, growth-ledger), and Railway volume backups.

## Adding a migration

1. Create `src/store/migrations/NNN-short-name.sql` with the next three-digit number (`002-…`). Plain SQL; several
   statements are fine. Prefer `ADD COLUMN … DEFAULT …` and `CREATE … IF NOT EXISTS` so a rerun on a half-migrated
   database stays safe (each file already runs inside one transaction).
2. Update the repository that reads/writes the table (`COLS` list + `fromRow`) and, if the shape visible to callers
   changes, `tests/fakes/store.js` too — the fake is the contract.
3. Add or extend a test in `tests/unit/store.test.js`; `migrate` is idempotent, so the test runs it twice.
4. `migrate(db)` runs on every `createStore()`; deploys apply pending files on boot. There is no down migration —
   write a new forward one.

## Backup and restore

The database is a single file plus its WAL side files (`lay.sqlite`, `lay.sqlite-wal`, `lay.sqlite-shm`). To copy a
consistent snapshot while the app runs, checkpoint first so the WAL is folded into the main file, then copy:

```js
await store.checkpoint();            // PRAGMA wal_checkpoint(TRUNCATE)
// then copy data/lay.sqlite (fs.copyFileSync or the platform shell)
```

Or, from a shell with the app stopped: `sqlite3 data/lay.sqlite ".backup backup-$(date +%F).sqlite"`. Restore by
stopping the app, replacing the file, deleting any stale `-wal`/`-shm`, and starting again. Never commit `*.sqlite`
(`data/` is gitignored).

## Railway

Mount a volume and point `DB_PATH` at it, e.g. volume mount path `/data` and `DB_PATH=/data/lay.sqlite`. Without a
volume the default `./data/lay.sqlite` lives on the container's ephemeral disk and is lost on every deploy. One
instance only — SQLite on a volume is not shared across replicas.
