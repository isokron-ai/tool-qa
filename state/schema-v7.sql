-- Schema version 7: the fault side and coverage state of each result (R-COV-02).
--
-- fault: who the result's skips are down to, by worker-kit/contract.mjs
-- resultFault(): tool, unknown, infra, subject or policy (the first of these
-- among its skips), or NULL for a result with no skip.
-- coverage: what the result means for coverage (DESIGN 4.7): assessed,
-- unassessed_tool, unassessed_unknown, unassessed_infra, subject or excluded.
-- A tool-fault skip is unassessed_tool: never excluded, never the subject's.
-- assessed_at: when the run_key last had an accepted result with coverage
-- assessed; a later skip does not clear it.
-- Rows from before version 7 keep all three NULL: whether they were skips is
-- not known here (the sealed ingest reports say).
ALTER TABLE results ADD COLUMN fault TEXT
  CHECK (fault IS NULL OR fault IN ('tool', 'unknown', 'infra', 'subject', 'policy'));
ALTER TABLE results ADD COLUMN coverage TEXT
  CHECK (coverage IS NULL OR coverage IN ('assessed', 'unassessed_tool', 'unassessed_unknown', 'unassessed_infra', 'subject', 'excluded'));
ALTER TABLE results ADD COLUMN assessed_at TEXT;
