-- Last Man Standing schema.
-- Applied idempotently at boot by src/db/index.js.

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  email          TEXT UNIQUE,                 -- normalised to lowercase
  phone          TEXT UNIQUE,                 -- normalised to E.164
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  totp_secret    TEXT,                        -- base32, second factor (required for super admin)
  totp_enabled   INTEGER NOT NULL DEFAULT 0,
  notify_email   INTEGER NOT NULL DEFAULT 1,
  notify_sms     INTEGER NOT NULL DEFAULT 0,
  token_version  INTEGER NOT NULL DEFAULT 1,  -- bump to invalidate every issued session
  status         TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  created_at     TEXT NOT NULL,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- One-time break-glass codes for the super admin (stored hashed, shown once).
CREATE TABLE IF NOT EXISTS recovery_codes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  channel    TEXT NOT NULL,                   -- email | sms
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seasons (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,            -- e.g. "2025/26"
  is_current INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS teams (
  id           INTEGER PRIMARY KEY,
  season_id    INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  short_name   TEXT NOT NULL,
  external_ref TEXT,
  UNIQUE(season_id, name)
);

CREATE TABLE IF NOT EXISTS gameweeks (
  id        INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  number    INTEGER NOT NULL,
  deadline  TEXT NOT NULL,                    -- ISO instant of the first kickoff
  UNIQUE(season_id, number)
);

CREATE TABLE IF NOT EXISTS fixtures (
  id           INTEGER PRIMARY KEY,
  gameweek_id  INTEGER NOT NULL REFERENCES gameweeks(id) ON DELETE CASCADE,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  kickoff      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | finished | postponed | abandoned
  home_score   INTEGER,
  away_score   INTEGER,
  minute       INTEGER,
  external_ref TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_fixtures_gw ON fixtures(gameweek_id);

CREATE TABLE IF NOT EXISTS leagues (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  join_code          TEXT NOT NULL UNIQUE,
  season_id          INTEGER NOT NULL REFERENCES seasons(id),
  start_gameweek     INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',  -- open | active | completed | archived
  admin_user_id      INTEGER REFERENCES users(id),  -- the single league admin
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  -- Locked rounds every entrant must pick before the competition starts:
  -- 0 for none (the normal weekly game), otherwise 2 to 10. A block of one
  -- would be the same as no block, so it is not offered.
  opening_picks      INTEGER NOT NULL DEFAULT 0
    CHECK (opening_picks = 0 OR (opening_picks BETWEEN 2 AND 10)),
  draw_policy        TEXT NOT NULL DEFAULT 'eliminate',        -- eliminate | survive
  void_policy        TEXT NOT NULL DEFAULT 'reselect',         -- reselect | eliminate | survive
  no_pick_policy     TEXT NOT NULL DEFAULT 'auto_alphabetical',-- auto_alphabetical | eliminate
  max_entries        INTEGER,
  -- Texts cost money, so the super admin can switch them off league by league.
  sms_enabled        INTEGER NOT NULL DEFAULT 1,
  -- Hide entrants' names from each other; the field is shown as a graph instead.
  anonymous_entrants INTEGER NOT NULL DEFAULT 0,
  -- Branding chosen by the league admin.
  tagline            TEXT,
  primary_color      TEXT NOT NULL DEFAULT '#1f9d55',
  secondary_color    TEXT NOT NULL DEFAULT '#2f6df6',
  logo_data          BLOB,
  logo_mime          TEXT,
  logo_preset        TEXT,          -- a ready-made crest instead of an upload
  -- Setup locks once the admin says it is final; only the super admin reopens it.
  config_locked_at   TEXT,
  config_locked_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_leagues_admin ON leagues(admin_user_id);

CREATE TABLE IF NOT EXISTS entries (
  id                INTEGER PRIMARY KEY,
  league_id         INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'active',  -- active | eliminated | withdrawn
  eliminated_round  INTEGER,
  eliminated_reason TEXT,
  eliminated_at     TEXT,
  is_winner         INTEGER NOT NULL DEFAULT 0,
  -- A league admin can wave someone back in for special circumstances.
  reinstated_at     TEXT,
  reinstated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reinstated_reason TEXT,
  joined_at         TEXT NOT NULL,
  UNIQUE(league_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_league ON entries(league_id);

CREATE TABLE IF NOT EXISTS picks (
  id           INTEGER PRIMARY KEY,
  entry_id     INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  league_id    INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  gameweek_id  INTEGER NOT NULL REFERENCES gameweeks(id),
  round_number INTEGER NOT NULL,              -- 1-based round within the competition
  cycle        INTEGER NOT NULL,              -- 0 for rounds 1-20, 1 for 21-40, ...
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  outcome      TEXT NOT NULL DEFAULT 'pending', -- pending | win | draw | loss | void
  result       TEXT NOT NULL DEFAULT 'pending', -- pending | survived | eliminated
  -- Set when the fixture is called off and the entrant owes us a new pick.
  needs_reselect     INTEGER NOT NULL DEFAULT 0,
  reselect_deadline  TEXT,
  auto_assigned      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(entry_id, gameweek_id)
);
CREATE INDEX IF NOT EXISTS idx_picks_league_round ON picks(league_id, round_number);
-- A team may be used once per cycle of 20 — but a pick voided by a called-off
-- fixture was never really used, so that club becomes available again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_team_per_cycle
  ON picks(entry_id, cycle, team_id) WHERE outcome != 'void';

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league_id     INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                -- deadline_reminder | survived | eliminated | ...
  channel       TEXT NOT NULL,                -- email | sms
  dedupe_key    TEXT NOT NULL UNIQUE,
  meta          TEXT,                         -- JSON context, re-checked before sending
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed | skipped
  sent_at       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(status, scheduled_for);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY,
  actor_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  entity         TEXT,
  entity_id      INTEGER,
  detail         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
