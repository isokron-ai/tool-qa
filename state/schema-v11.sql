-- Schema version 11: leads (DESIGN-v3 section 7, "Leads -> issues on our repos").
--
-- A lead is one bug fingerprint in our own tools (state/fingerprint.mjs
-- leadKeyOf: tool, component, oracle, class, SDK idiom, layout, normalised
-- signature, without the tool versions), kept while LANE_LEADS_ENABLED is on.
-- Ingest folds every accepted result into it (StateDb.noteLeads, in the same
-- transaction as the result). The rules are in state/leads.mjs; the re-check
-- dispatch, filing and closing come with the pump's lead step (later parts).
--
-- leads: one row per fingerprint.
--   repo        our repository an issue for it goes to (leads/routing.json)
--   tool .. signature, partial, fault   the fingerprint's parts: shapes only, never a
--               subject name (safe to put in a public issue)
--   versions    JSON list of the tool versions it was seen on (last 10)
--   status      open    seen, not filed (waiting for its re-check, its flake rate,
--                       its 3 days as an infra failure, or a cap)
--               filed   an issue is open for it on `repo`
--               closed  3 clean re-checks in a row and no subject carries it
--                       now; reopened (to open or filed) when it comes back
--   reproduced_at, reproduced_run_id   a re-run of a (subject, lane) that showed
--               it, in another worker run than the one before, showed it again:
--               the condition for filing a tool-side lead
--   recheck_*   the (subject, lane) the pump re-dispatches to re-check it
--               (pump/due.mjs lead_reverify), after `recheck_after`; attempts
--               counts re-checks that came back
--   clean_rechecks  clean results of a (subject, lane) that carried it since it
--               was last seen; 3 close it (with no subject carrying it)
--   issue_number, issue_state, filed_at, filing_started_at   the issue; a filing
--               started but not confirmed is looked up before it is tried again
--   needs_sync  the issue's state on GitHub must follow status (close or reopen)
--
-- lead_subjects: where a lead was seen, one row per (fingerprint, subject, lane).
-- Subject names stay in the state (which is encrypted, R-ING-15) and are never
-- put in an issue.
--   current     1 while that pair's latest accepted result carries the lead
--   log         JSON [[iso, 1|0], ...]: the pair's results in the last 14 days
--               (1 carried it), at most 32, for the flake rate
--   last_run_id the worker run of the newest result folded in
--   last_hit_run_id  the worker run of the newest result that carried it: a re-run
--               reproduces the lead only from another run than this one
CREATE TABLE leads (
  fingerprint          TEXT PRIMARY KEY,
  repo                 TEXT NOT NULL,
  tool                 TEXT NOT NULL,
  lane                 TEXT NOT NULL,
  component            TEXT NOT NULL,
  oracle               TEXT NOT NULL,
  class                TEXT NOT NULL,
  idiom                TEXT NOT NULL,
  layout               TEXT NOT NULL,
  signature            TEXT NOT NULL,
  partial              INTEGER NOT NULL DEFAULT 0,
  fault                TEXT NOT NULL,
  versions             TEXT NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL CHECK (status IN ('open', 'filed', 'closed')),
  sightings            INTEGER NOT NULL DEFAULT 0,
  first_seen           TEXT NOT NULL,
  last_seen            TEXT NOT NULL,
  first_run_id         INTEGER,
  last_run_id          INTEGER,
  reproduced_at        TEXT,
  reproduced_run_id    INTEGER,
  recheck_subject      TEXT,
  recheck_lane         TEXT,
  recheck_after        TEXT,
  recheck_attempts     INTEGER NOT NULL DEFAULT 0,
  clean_rechecks       INTEGER NOT NULL DEFAULT 0,
  issue_number         INTEGER,
  issue_state          TEXT CHECK (issue_state IS NULL OR issue_state IN ('open', 'closed')),
  filed_at             TEXT,
  filing_started_at    TEXT,
  needs_sync           INTEGER NOT NULL DEFAULT 0,
  reopened             INTEGER NOT NULL DEFAULT 0,
  closed_at            TEXT,
  close_reason         TEXT,
  updated_at           TEXT NOT NULL
) STRICT;
CREATE INDEX leads_status ON leads (status, repo);

CREATE TABLE lead_subjects (
  fingerprint  TEXT NOT NULL REFERENCES leads (fingerprint) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  lane         TEXT NOT NULL,
  run_key      TEXT NOT NULL,
  current      INTEGER NOT NULL CHECK (current IN (0, 1)),
  seen         INTEGER NOT NULL DEFAULT 0,
  clean        INTEGER NOT NULL DEFAULT 0,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  last_checked TEXT NOT NULL,
  last_run_id  INTEGER,
  last_hit_run_id INTEGER,
  log          TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (fingerprint, subject, lane)
) STRICT;
CREATE INDEX lead_subjects_pair ON lead_subjects (subject, lane);
