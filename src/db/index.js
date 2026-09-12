import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });

export const db = new DatabaseSync(config.databaseFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));

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
