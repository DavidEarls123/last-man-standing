/**
 * The database is `node:sqlite`, which Node only exposes without a command
 * line flag from 22.13.0 (and 23.4.0) onwards. On anything older the import
 * fails with a bare ERR_UNKNOWN_BUILTIN_MODULE that names no version and
 * suggests no fix — so say it properly before that can happen.
 *
 * Imported for its side effect, first, by the module that loads node:sqlite.
 */
const MINIMUM = [22, 13, 0];

const current = process.versions.node.split('.').map(Number);
const tooOld = MINIMUM.some((want, index) => {
  const have = current[index] ?? 0;
  if (have !== want) return have < want;
  return false;
});

if (tooOld) {
  console.error(`\nThis needs Node ${MINIMUM.join('.')} or newer. You are on ${process.versions.node}.`);
  console.error('Older versions hide the built-in SQLite database behind a flag, so nothing works.\n');
  console.error('Hosted on Render: set the NODE_VERSION environment variable (22.22.2 is known good).');
  console.error('On your own machine: install the current Node 22 LTS from https://nodejs.org\n');
  process.exit(1);
}
