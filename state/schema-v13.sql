-- Schema version 13: the code of each skip, kept with the result (R-COV-49).
--
-- skip_codes: JSON list of {fault, code}, one per distinct pair among the
-- skips of the accepted bundle that carry a `code` (worker-kit/contract.mjs
-- skipCodes), or NULL when none does. state/coverage.mjs breaks the
-- unassessed counts down by it; it never changes fault or coverage.
-- Rows from before version 13 keep NULL: counted as "uncoded".
ALTER TABLE results ADD COLUMN skip_codes TEXT;
