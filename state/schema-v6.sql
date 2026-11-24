-- Schema version 6: retry counters that a skips-only result does not reset (R-SUB-08).
--
-- measured_at: when the run_key last had an accepted result that measured
-- something (outcome other than 'skips_only'); NULL when it never had one.
-- The retry_later count and the retry_throttled window are counted from it,
-- so a skips_only acceptance cannot start them over.
-- skips_streak: skips_only acceptances in a row since then; the due list waits
-- skips_only_max_age_days x 2^(streak-1) before looking again, at most the
-- tier's max age.
ALTER TABLE results ADD COLUMN measured_at TEXT;
ALTER TABLE results ADD COLUMN skips_streak INTEGER NOT NULL DEFAULT 0 CHECK (skips_streak >= 0);
UPDATE results SET measured_at = accepted_at WHERE outcome IS NOT 'skips_only';
UPDATE results SET skips_streak = 1 WHERE outcome IS 'skips_only';
