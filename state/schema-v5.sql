-- Schema version 5: retired subjects.
--
-- A subject that leaves its source list (for example the seed, history/seed-v1.json)
-- is not deleted: its results and history stay. retired_at says when it left;
-- the due list skips it, so it is no longer refreshed. setSubjectVersion() clears
-- it again when the subject comes back.
ALTER TABLE subjects ADD COLUMN retired_at TEXT;
