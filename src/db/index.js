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
ensureColumn('leagues', 'logo_preset', 'TEXT');
ensureColumn('leagues', 'sms_enabled', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('leagues', 'config_locked_at', 'TEXT');
ensureColumn('leagues', 'config_locked_by', 'INTEGER');

/**
 * The opening-block column has been through two earlier names: `initial_picks`,
 * then briefly `advance_picks` when it was modelled as a rolling window. It is
 * now `opening_picks` — rounds every entrant must pick before the competition
 * starts, and nothing after that.
 */
(function renameOpeningPicks() {
  const columns = () => db.prepare('PRAGMA table_info(leagues)').all().map((column) => column.name);
  const current = columns();
  if (current.includes('opening_picks')) {
    for (const stale of ['initial_picks', 'advance_picks']) {
      if (current.includes(stale)) db.exec(`ALTER TABLE leagues DROP COLUMN ${stale}`);
    }
    return;
  }
  const previous = current.includes('advance_picks') ? 'advance_picks'
    : current.includes('initial_picks') ? 'initial_picks' : null;
  if (!previous) return;
  db.exec(`ALTER TABLE leagues RENAME COLUMN ${previous} TO opening_picks`);
  console.log(`[db] leagues.${previous} is now opening_picks (locked rounds picked before kick off)`);
})();

/**
 * An opening block of one is indistinguishable from no block at all, so it is
 * no longer offered: those leagues become 0, meaning the ordinary weekly game.
 */
(function normaliseOpeningPicks() {
  const columns = db.prepare('PRAGMA table_info(leagues)').all().map((column) => column.name);
  if (!columns.includes('opening_picks')) return;
  const changed = db.prepare(
    'UPDATE leagues SET opening_picks = 0 WHERE opening_picks = 1',
  ).run().changes;
  db.exec('UPDATE leagues SET opening_picks = 10 WHERE opening_picks > 10');
  db.exec('UPDATE leagues SET opening_picks = 0 WHERE opening_picks < 0');
  if (changed) console.log(`[db] ${changed} league(s) with a one-round opening block now run as normal`);
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
