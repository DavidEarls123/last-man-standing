import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-inbox-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { createApp } = await import('../src/app.js');
const { get, run } = await import('../src/db/index.js');
const { hashPassword } = await import('../src/lib/auth.js');

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'lms-web',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const entry of response.headers.getSetCookie?.() ?? []) cookie = entry.split(';')[0];
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

const PASSWORD = 'a-perfectly-fine-password-1';
const alice = client();
const bob = client();
let aliceId;

const queue = (userId, { kind = 'survived', key, channel = 'email', subject, body = 'Body' }) => run(
  `INSERT INTO notifications (user_id, kind, channel, dedupe_key, subject, body, scheduled_for, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'sent', datetime('now'))`,
  userId, kind, channel, `${key}:${channel}`, subject, body,
);

test('setup: two accounts with messages of their own', async () => {
  for (const [email, name] of [['alice@example.com', 'Alice'], ['bob@example.com', 'Bob']]) {
    run(
      `INSERT INTO users (email, display_name, password_hash, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
      email, name, await hashPassword(PASSWORD),
    );
  }
  aliceId = get("SELECT id FROM users WHERE email = 'alice@example.com'").id;
  const bobId = get("SELECT id FROM users WHERE email = 'bob@example.com'").id;

  await alice('POST', '/api/auth/login', { identifier: 'alice@example.com', password: PASSWORD });
  await bob('POST', '/api/auth/login', { identifier: 'bob@example.com', password: PASSWORD });

  queue(aliceId, { key: 'a1', subject: 'Through to round 2' });
  // The same message on both channels: one message, two ways of travelling.
  queue(aliceId, { key: 'a2', channel: 'email', subject: 'Deadline in an hour' });
  queue(aliceId, { key: 'a2', channel: 'sms', subject: 'Deadline in an hour' });
  queue(bobId, { key: 'b1', subject: 'Not for Alice' });
});

test('you see your own messages and nobody else’s', async () => {
  const mine = await alice('GET', '/api/inbox');
  assert.equal(mine.status, 200);
  assert.deepEqual(
    mine.body.messages.map((message) => message.subject).sort(),
    ['Deadline in an hour', 'Through to round 2'],
  );

  const theirs = await bob('GET', '/api/inbox');
  assert.deepEqual(theirs.body.messages.map((message) => message.subject), ['Not for Alice']);
});

test('a message queued to email and text is one message, listing both', async () => {
  const { body } = await alice('GET', '/api/inbox');
  const deadline = body.messages.find((message) => message.subject === 'Deadline in an hour');
  assert.deepEqual([...deadline.channels].sort(), ['email', 'sms']);
  assert.equal(body.messages.length, 2, 'not one row per channel');
});

test('everything starts unread', async () => {
  const { body } = await alice('GET', '/api/inbox');
  assert.equal(body.unread, 2);
  assert.ok(body.messages.every((message) => !message.read));
});

test('reading one marks its other channel too, so the count does not stick', async () => {
  const before = await alice('GET', '/api/inbox');
  const deadline = before.body.messages.find((message) => message.subject === 'Deadline in an hour');

  const marked = await alice('POST', '/api/inbox/read', { ids: [deadline.id] });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.unread, 1);

  const after = await alice('GET', '/api/inbox');
  assert.equal(after.body.messages.find((m) => m.subject === 'Deadline in an hour').read, true);
  assert.equal(after.body.messages.find((m) => m.subject === 'Through to round 2').read, false);
  // Both rows, not just the one whose id was sent.
  assert.equal(
    get("SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key LIKE 'a2:%' AND read_at IS NULL").n,
    0,
  );
});

test('mark all read clears the badge', async () => {
  const marked = await alice('POST', '/api/inbox/read', {});
  assert.equal(marked.body.unread, 0);
  assert.equal((await alice('GET', '/api/inbox')).body.unread, 0);
});

test('reading yours leaves everyone else unread', async () => {
  assert.equal((await bob('GET', '/api/inbox')).body.unread, 1);
});

test('a stranger gets nothing', async () => {
  const stranger = client();
  assert.equal((await stranger('GET', '/api/inbox')).status, 401);
});

test('you cannot mark somebody else’s message read', async () => {
  const theirs = await bob('GET', '/api/inbox');
  const [bobMessage] = theirs.body.messages;
  await alice('POST', '/api/inbox/read', { ids: [bobMessage.id] });
  assert.equal((await bob('GET', '/api/inbox')).body.unread, 1, 'still unread for Bob');
});

test.after(() => server.close());
