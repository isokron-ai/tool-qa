-- Schema version 8: subjects keyed by GitHub's numeric repository id (loop upgrade #15).
--
-- subjects.id stays what it was: the subject key. It is frozen at first sight
-- (owner/name as the seed spelled it then) and is what run_keys, leases,
-- dispatch items, attempts and results name, so no run_key moves and nothing
-- becomes due again with this version. Identity and continuity move to the
-- repository's numeric id instead:
--
--   name             the repository's current owner/name: what a worker is
--                    sent to clone or read. Follows renames and transfers.
--                    Rows from before version 8 get name = id.
--   repo_id          GitHub's numeric repository id (databaseId), once looked
--                    up; NULL until then. At most one subject per id.
--   node_id          GitHub's GraphQL node id, to look the repository up again
--                    by id however it is named.
--   repo_created_at  when GitHub says the repository was created. A lookup
--                    that returns a known id with another creation time is an
--                    id reused, which GitHub never does: refused, not rebound.
--   id_status        the last lookup: ok, error (try again soon), not_found
--                    (deleted, or turned private: no lookup is possible),
--                    duplicate (the same repository as another subject, which
--                    holds its history now: see alias_of) or conflict (the
--                    reuse guard refused it). NULL: not looked up yet.
--   id_checked_at    when it was last looked up.
--   gone_at          since when the repository cannot be found (a
--                    subject-fault skip: not dispatched while it lasts).
--   alias_of         the subject key this one turned out to be the same
--                    repository as; such a subject is retired.
--
-- The ids are backfilled by the pump (pump/identity.mjs), a few batched
-- GraphQL lookups per run. A subject not looked up yet is dispatched by its
-- name exactly as before, so a failed or slow backfill never holds the pump.
--
-- subject_events keeps every identity change (bound, renamed, transferred,
-- merged, not found, found again, conflicts) for good.
-- dispatch_items.subject_name is the owner/name the worker was sent, so a
-- rename between dispatch and ingest changes nothing about how the result is
-- recorded: by run_key and subject key, never by name.
ALTER TABLE subjects ADD COLUMN name TEXT;
ALTER TABLE subjects ADD COLUMN repo_id INTEGER CHECK (repo_id IS NULL OR repo_id > 0);
ALTER TABLE subjects ADD COLUMN node_id TEXT;
ALTER TABLE subjects ADD COLUMN repo_created_at TEXT;
ALTER TABLE subjects ADD COLUMN id_status TEXT
  CHECK (id_status IS NULL OR id_status IN ('ok', 'error', 'not_found', 'duplicate', 'conflict'));
ALTER TABLE subjects ADD COLUMN id_checked_at TEXT;
ALTER TABLE subjects ADD COLUMN gone_at TEXT;
ALTER TABLE subjects ADD COLUMN alias_of TEXT;
UPDATE subjects SET name = id WHERE name IS NULL;
CREATE UNIQUE INDEX subjects_repo_id ON subjects (repo_id) WHERE repo_id IS NOT NULL;

CREATE TABLE subject_events (
  id       INTEGER PRIMARY KEY,
  subject  TEXT NOT NULL,
  repo_id  INTEGER,
  kind     TEXT NOT NULL CHECK (kind IN ('id_bound', 'renamed', 'transferred', 'merged', 'not_found', 'found_again', 'id_conflict')),
  old_name TEXT,
  new_name TEXT,
  detail   TEXT,                    -- JSON
  at       TEXT NOT NULL
) STRICT;
CREATE INDEX subject_events_subject ON subject_events (subject, id);

ALTER TABLE dispatch_items ADD COLUMN subject_name TEXT;
