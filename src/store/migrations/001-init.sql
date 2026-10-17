-- Lay v2 initial schema (design §5). JSON columns are TEXT holding JSON; timestamps are ISO-8601 TEXT.

CREATE TABLE IF NOT EXISTS sessions (
  user_id           TEXT PRIMARY KEY,
  display_name      TEXT,
  mode              TEXT NOT NULL DEFAULT 'lay',       -- lay | quiet | mos_active | demo
  mode_since        TEXT,
  demo_shop         TEXT,
  topics_covered    TEXT NOT NULL DEFAULT '[]',        -- json array
  draft             TEXT NOT NULL DEFAULT '{}',        -- json: symptom, card, tier, business, problem...
  homework          TEXT NOT NULL DEFAULT '{}',        -- json: 7 homework fields
  questions_asked   INTEGER NOT NULL DEFAULT 0,
  loose_ends_fired  INTEGER NOT NULL DEFAULT 0,        -- bool
  opened            INTEGER NOT NULL DEFAULT 0,        -- bool
  booking_step      TEXT,
  last_customer_at  TEXT,
  last_bot_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions (mode);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL,
  role              TEXT NOT NULL,                     -- customer | lay | mos | demo_shop | system
  sender_name       TEXT,
  kind              TEXT NOT NULL DEFAULT 'text',      -- text | card | quick | postback | media
  text              TEXT,
  payload           TEXT,                              -- json
  reply_token_used  INTEGER NOT NULL DEFAULT 0,        -- bool
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

CREATE TABLE IF NOT EXISTS leads (
  id                 TEXT PRIMARY KEY,                 -- L-YYYY-MM-DD-line_oa-xxxxxx
  user_id            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'new',      -- new | qualified | booking_pending | booked | offer_shown | closed
  card_id            TEXT,
  symptom            TEXT,
  homework           TEXT NOT NULL DEFAULT '{}',       -- json
  customer_words_th  TEXT,
  wave_group         TEXT,
  source             TEXT NOT NULL DEFAULT 'line_oa',
  discord_thread_id  TEXT,
  synced_at          TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads (user_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_updated_at ON leads (updated_at);

CREATE TABLE IF NOT EXISTS bookings (
  id                TEXT PRIMARY KEY,                  -- B-YYYY-MM-DD-xxxxxx
  lead_id           TEXT,
  user_id           TEXT NOT NULL,
  window_text       TEXT,
  fields            TEXT NOT NULL DEFAULT '{}',        -- json
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | reproposed | declined | cancelled
  proposed_windows  TEXT NOT NULL DEFAULT '[]',        -- json array
  decided_by        TEXT,
  decided_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings (user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_lead_id ON bookings (lead_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings (created_at);

CREATE TABLE IF NOT EXISTS kb_gaps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT,
  question        TEXT NOT NULL,
  kb_refs_tried   TEXT,                                -- json array
  forwarded       INTEGER NOT NULL DEFAULT 0,          -- bool
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_gaps_user_id ON kb_gaps (user_id);
CREATE INDEX IF NOT EXISTS idx_kb_gaps_created_at ON kb_gaps (created_at);

CREATE TABLE IF NOT EXISTS relay_threads (
  discord_thread_id  TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  lead_id            TEXT,
  opened_for         TEXT NOT NULL,                    -- handoff | booking
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_threads_user_id ON relay_threads (user_id);

CREATE TABLE IF NOT EXISTS outbox (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL,                      -- discord_notify | line_push
  payload          TEXT NOT NULL,                      -- json
  status           TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TEXT,
  sent_at          TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON outbox (created_at);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                           -- policy_violation | error | undelivered | model_fallback | ...
  user_id     TEXT,
  payload     TEXT,                                    -- json
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events (user_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
