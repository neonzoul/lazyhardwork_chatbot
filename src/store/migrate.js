// Numbered SQL migrations: src/store/migrations/NNN-name.sql, applied in order inside a transaction,
// recorded in schema_migrations. Idempotent — running migrate() twice applies nothing the second time.
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d{3}-.*\.sql$/.test(f))
    .sort()
    .map((file) => ({ id: Number(file.slice(0, 3)), name: file, sql: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

function appliedIds(db) {
  return new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => Number(r.id)));
}

/** Apply pending migrations. Returns the list of migration names applied in this call. */
function migrate(db, { dir = MIGRATIONS_DIR, log } = {}) {
  ensureTable(db);
  const done = appliedIds(db);
  const applied = [];
  const insert = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES ($id, $name, $applied_at)');
  for (const m of listMigrations(dir)) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      insert.run({ $id: m.id, $name: m.name, $applied_at: new Date().toISOString() });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      err.message = `migration ${m.name} failed: ${err.message}`;
      throw err;
    }
    applied.push(m.name);
    if (log) log.info('store.migrated', { migration: m.name });
  }
  return applied;
}

module.exports = { migrate, listMigrations, MIGRATIONS_DIR };
