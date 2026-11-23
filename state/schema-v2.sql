-- Schema version 2: slot ledger rows expire. Rows from version 1 get an empty
-- expiry, which sorts before any time, so they are reaped on the next acquire.
ALTER TABLE slot_ledger ADD COLUMN expires TEXT NOT NULL DEFAULT '';
