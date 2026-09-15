import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadEnvFile } = await import('../src/config.js');

/**
 * The .env file is written by hand, usually on Windows, usually in Notepad or
 * Command Prompt. Both leave marks on the line that must not end up inside the
 * value — a key with a stray space on the end fails with an opaque 401.
 */
function readBack(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents);
  const env = {};
  loadEnvFile(file, env);
  fs.rmSync(dir, { recursive: true, force: true });
  return env;
}

test('a .env written on Windows does not smuggle whitespace into the values', () => {
  // CRLF line endings, and the trailing space `echo KEY=value > .env` leaves.
  const env = readBack('FOOTBALL_PROVIDER=football-data \r\nFOOTBALL_DATA_API_KEY=abc123 \r\n');
  assert.equal(env.FOOTBALL_PROVIDER, 'football-data');
  assert.equal(env.FOOTBALL_DATA_API_KEY, 'abc123', 'no trailing space or carriage return');
});

test('a .env strips quotes, skips comments and keeps spaces inside a value', () => {
  const env = readBack('# the real feed\nFOOTBALL_DATA_API_KEY="abc123"\nEMAIL_FROM=Last One Standing\n');
  assert.equal(env.FOOTBALL_DATA_API_KEY, 'abc123');
  assert.equal(env.EMAIL_FROM, 'Last One Standing');
});

test('a missing .env is simply no .env', () => {
  const env = {};
  loadEnvFile(path.join(os.tmpdir(), 'definitely-not-here', '.env'), env);
  assert.deepEqual(env, {});
});

test('the real environment always beats the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'PORT=9999\n');
  const env = { PORT: '3000' };
  loadEnvFile(file, env);
  assert.equal(env.PORT, '3000', 'a value already set is not overwritten');
  fs.rmSync(dir, { recursive: true, force: true });
});
