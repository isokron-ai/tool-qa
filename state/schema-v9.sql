-- Schema version 9: oracle disagreement per subject (loop upgrade #7).
--
-- oracle_facts: what the latest accepted result of each oracle lane (scan-static,
-- live-probe) said that the oracles can disagree on: tool count and tool list
-- hash, the official SDK clients' results, failed conformance checks and the
-- worker's own disagreement leads (state/oracle.mjs oracleFacts). One row per
-- (subject, lane), replaced by each accepted result. JSON, a few hundred bytes.
--
-- oracle_disagreements: the derived record per subject (state/oracle.mjs).
--   status   open     the oracles disagree: the due list boosts the subject's
--                     priority and re-checks it sooner (pump/due.mjs)
--            cleared  they agree again; the row stays as history
--            settled  the same disagreement survived max_unchanged_rechecks
--                     re-checks: the boost stops until it changes
--   kinds    JSON [{kind, oracles}], sorted; signature is its sha256
--   server_side  JSON list of evidence that the server itself is wrong
--                (never opens a disagreement, never boosts)
-- Nothing here touches results.fault or results.coverage: a disagreement is
-- evidence about our tool, never a subject-side finding by itself.
-- Rows from before version 9 have no facts; they fill in as the oracle lanes
-- report, and nothing becomes due or changes priority because of the migration.
CREATE TABLE oracle_facts (
  subject    TEXT NOT NULL,
  workflow   TEXT NOT NULL,
  run_key    TEXT NOT NULL,
  facts      TEXT NOT NULL,         -- JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subject, workflow)
) STRICT;

CREATE TABLE oracle_disagreements (
  subject            TEXT PRIMARY KEY,
  status             TEXT NOT NULL CHECK (status IN ('open', 'cleared', 'settled')),
  kinds              TEXT NOT NULL,   -- JSON
  signature          TEXT NOT NULL,
  server_side        TEXT,            -- JSON
  unchanged_rechecks INTEGER NOT NULL DEFAULT 0,
  opened_at          TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  cleared_at         TEXT,
  reason             TEXT
) STRICT;
