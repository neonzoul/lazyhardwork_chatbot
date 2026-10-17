// SQLite connection (design §5). node:sqlite is built into Node ≥ 22.13 — no native build.
// The DatabaseSync API is synchronous; repositories wrap it in Promises so the real store is a
// drop-in for tests/fakes/store.js.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PATH = './data/lay.sqlite';

/**
 * Open (and create) the database. `:memory:` is supported for tests.
 * - creates the parent folder
 * - WAL journal (file databases only; memory databases ignore it)
 * - busy timeout so a concurrent writer waits instead of throwing SQLITE_BUSY
 * - foreign keys on
 * Returns the DatabaseSync instance; call `db.close()` when done.
 */
function openDb(dbPath = process.env.DB_PATH || DEFAULT_PATH, { busyTimeoutMs = 5000 } = {}) {
  const isMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:');
  if (!isMemory) fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
  db.exec('PRAGMA foreign_keys = ON');
  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return db;
}

/** Flush the WAL into the main file (run before copying the sqlite file for a backup). */
function checkpoint(db) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

module.exports = { openDb, checkpoint, DEFAULT_PATH };
