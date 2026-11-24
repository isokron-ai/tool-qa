-- Schema version 3: the dispatch ledger (P1).
--
-- Leases from version 1 are now keyed by run_key (the `subject` column of
-- `leases` holds the run_key), so a fence belongs to one run_key.

-- What the due list needs to know about a subject.
ALTER TABLE subjects ADD COLUMN tier INTEGER NOT NULL DEFAULT 4;   -- 0..4 (T0..T4)
ALTER TABLE subjects ADD COLUMN sha TEXT;                          -- commit SHA under test
ALTER TABLE subjects ADD COLUMN artifact_digest TEXT;              -- package or image digest
ALTER TABLE subjects ADD COLUMN changed_at TEXT;                   -- last change event
ALTER TABLE subjects ADD COLUMN change_reason TEXT;

-- Results received now name the dispatch they answer and the outcome.
ALTER TABLE attempts ADD COLUMN attempt_id TEXT;
ALTER TABLE attempts ADD COLUMN outcome TEXT;
CREATE INDEX attempts_attempt_id ON attempts (attempt_id);
CREATE INDEX attempts_run_key ON attempts (run_key, id);

-- Slot ledger rows are held by an attempt_id (holder_run) and say why they closed.
ALTER TABLE slot_ledger ADD COLUMN release_reason TEXT;            -- result | expired | failed

-- The fields each run_key was computed from (canonical JSON).
CREATE TABLE run_keys (
  run_key    TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  workflow   TEXT NOT NULL,
  fields     TEXT NOT NULL,
  first_seen TEXT NOT NULL
) STRICT;

-- One row per dispatch (one shard sent to one worker workflow).
CREATE TABLE dispatches (
  attempt_id    TEXT PRIMARY KEY,
  shard_id      TEXT NOT NULL,
  workflow      TEXT NOT NULL,      -- loop workflow name, e.g. live-probe
  repo          TEXT NOT NULL,      -- owner/name of the worker repository
  workflow_file TEXT NOT NULL,
  ref           TEXT NOT NULL,
  created       TEXT NOT NULL,
  expires       TEXT NOT NULL,      -- lease expiry; the slot expires at the same time
  status        TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'failed', 'done', 'expired')),
  run_id        TEXT,
  run_url       TEXT,
  workflow_sha  TEXT,
  correlated_by TEXT,               -- response | run-name
  closed        TEXT,
  close_reason  TEXT,
  error         TEXT
) STRICT;
CREATE INDEX dispatches_status ON dispatches (status, expires);

-- The run_keys a dispatch carries, each with the fence issued for it.
CREATE TABLE dispatch_items (
  attempt_id TEXT NOT NULL REFERENCES dispatches (attempt_id),
  run_key    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  workflow   TEXT NOT NULL,
  fence      INTEGER NOT NULL,
  resolved   TEXT,                  -- when ingest reported on it (accepted or rejected)
  PRIMARY KEY (attempt_id, run_key)
) STRICT;
CREATE INDEX dispatch_items_run_key ON dispatch_items (run_key);
CREATE INDEX dispatch_items_subject ON dispatch_items (subject, workflow);

-- The accepted result for each run_key (upsert keyed on run_key). Every
-- result, accepted or not, is also kept in `attempts`.
CREATE TABLE results (
  run_key     TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  workflow    TEXT NOT NULL,
  attempt_id  TEXT NOT NULL,
  fence       INTEGER NOT NULL,
  outcome     TEXT,
  digest      TEXT,
  accepted_at TEXT NOT NULL
) STRICT;
CREATE INDEX results_subject ON results (subject, workflow, accepted_at);

-- Small loop metadata (pump heartbeat, last successor dispatch). JSON values.
CREATE TABLE kv (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  updated TEXT NOT NULL
) STRICT;
