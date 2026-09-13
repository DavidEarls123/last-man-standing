import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });

export const db = new DatabaseSync(config.databaseFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
const schema = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');
db.exec(schema);

/** Add a column to an existing database if the schema has grown since it was created. */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('notifications', 'meta', 'TEXT');
ensureColumn('leagues', 'tagline', 'TEXT');
ensureColumn('leagues', 'primary_color', "TEXT NOT NULL DEFAULT '#1f9d55'");
ensureColumn('leagues', 'secondary_color', "TEXT NOT NULL DEFAULT '#2f6df6'");
ensureColumn('leagues', 'logo_data', 'BLOB');
ensureColumn('leagues', 'logo_mime', 'TEXT');
ensureColumn('leagues', 'config_locked_at', 'TEXT');
ensureColumn('leagues', 'config_locked_by', 'INTEGER');

/**
 * `initial_picks` used to mean "rounds you must pick before the first kick off".
 * Entrants now only ever have to pick for the round coming up, so the column
 * became "rounds you MAY pick ahead" and was renamed to match.
 */
(function renameInitialPicks() {
  const columns = db.prepare('PRAGMA table_info(leagues)').all().map((column) => column.name);
  if (!columns.includes('initial_picks')) return;
  if (columns.includes('advance_picks')) {
    db.exec('ALTER TABLE leagues DROP COLUMN initial_picks');
    return;
  }
  db.exec('ALTER TABLE leagues RENAME COLUMN initial_picks TO advance_picks');
  // The old default of three was an obligation, not an allowance.
  db.exec('UPDATE leagues SET advance_picks = 1 WHERE advance_picks = 3');
  console.log('[db] leagues.initial_picks is now advance_picks (rounds you may pick ahead)');
})();
ensureColumn('entries', 'reinstated_at', 'TEXT');
ensureColumn('entries', 'reinstated_by', 'INTEGER');
ensureColumn('entries', 'reinstated_reason', 'TEXT');
ensureColumn('picks', 'needs_reselect', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('picks', 'reselect_deadline', 'TEXT');
ensureColumn('picks', 'auto_assigned', 'INTEGER NOT NULL DEFAULT 0');

/**
 * Older databases carry `UNIQUE(entry_id, cycle, team_id)` inline on `picks`.
 * A pick voided by a called-off fixture should free that club up again, which
 * needs a partial index instead, and SQLite cannot drop a table constraint —
 * so rebuild the table when the old shape is found.
 */
(function migratePicksTeamConstraint() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'picks'").get();
  if (!table || !/UNIQUE\s*\(\s*entry_id\s*,\s*cycle\s*,\s*team_id\s*\)/i.test(table.sql)) return;

  const columns = db.prepare('PRAGMA table_info(picks)').all().map((column) => column.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE picks RENAME TO picks_legacy');
    db.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS picks'),
      schema.indexOf('CREATE TABLE IF NOT EXISTS settings')));
    db.exec(`INSERT INTO picks (${columns}) SELECT ${columns} FROM picks_legacy`);
    db.exec('DROP TABLE picks_legacy');
    db.exec('COMMIT');
    // The legacy table owned index names until it was dropped, so the fresh
    // indexes have to be created after it is gone.
    db.exec(schema);
    console.log('[db] rebuilt picks table so voided picks free their club again');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
})();

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export function audit(actorUserId, action, entity, entityId, detail) {
  run(
    'INSERT INTO audit_log (actor_user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    actorUserId ?? null,
    action,
    entity ?? null,
    entityId ?? null,
    detail == null ? null : JSON.stringify(detail),
    new Date().toISOString(),
  );
}
