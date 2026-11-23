-- tool-qa state store, schema version 1.
-- Applied by state/db.mjs when PRAGMA user_version is below 1.
-- All timestamps are UTC ISO 8601 strings from Date.prototype.toISOString(),
-- so they sort and compare correctly as text.

-- Named monotonic counters. 'fence' issues lease fencing tokens.
CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

-- Things the loop tracks (servers, packages, repos).
CREATE TABLE subjects (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  source     TEXT NOT NULL,           -- where we first saw it
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
) STRICT;

-- GitHub Actions workflow runs the loop knows about.
CREATE TABLE runs (
  id         TEXT PRIMARY KEY,        -- workflow run id
  workflow   TEXT NOT NULL,
  attempt    INTEGER NOT NULL DEFAULT 1,
  started    TEXT,
  finished   TEXT,
  conclusion TEXT
) STRICT;

-- One lease row per subject. Rows are kept after release or expiry so the
-- latest fence stays visible; fences come from counters('fence') and only grow.
CREATE TABLE leases (
  subject  TEXT PRIMARY KEY,
  holder   TEXT,                      -- NULL once released
  fence    INTEGER NOT NULL CHECK (fence > 0),
  acquired TEXT NOT NULL,
  expires  TEXT NOT NULL,
  released TEXT
) STRICT;

-- Worker slots across all loop repositories (0..14, so at most 15 open).
CREATE TABLE slot_ledger (
  id         INTEGER PRIMARY KEY,
  slot       INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 14),
  holder_run TEXT NOT NULL,
  acquired   TEXT NOT NULL,
  released   TEXT
) STRICT;
CREATE UNIQUE INDEX slot_ledger_open ON slot_ledger (slot) WHERE released IS NULL;

-- Every result a worker hands back, accepted or rejected. Never overwritten.
CREATE TABLE attempts (
  id       INTEGER PRIMARY KEY,
  subject  TEXT NOT NULL,
  holder   TEXT NOT NULL,
  fence    INTEGER NOT NULL,
  run_id   TEXT,
  run_key  TEXT,
  digest   TEXT,                      -- digest of the result bundle
  received TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  reason   TEXT                       -- NULL when accepted, else why it was rejected
) STRICT;
CREATE INDEX attempts_subject ON attempts (subject, id);
