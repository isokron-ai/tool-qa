-- Schema version 10: the events table (live loop view).
--
-- One row per thing the loop did, written by the pump in the same transaction
-- as the fact it describes, so an event exists exactly when its fact does.
-- Append only: rows are never updated, and only state/prune.mjs deletes them
-- (older than 8 days, always keeping the newest row so the id keeps growing).
--   id           the sequence number; AUTOINCREMENT so an id is never reused,
--                even after the newest rows are pruned
--   type         internal event type (docs/INTERFACES.md "Events")
--   occurred_at  when it happened
--   recorded_at  when the pump wrote it
--   lane         workflow name, NULL for loop-wide events
--   n            how many things the event counts (items in a batch, ...)
--   subject      subjects.id, NULL unless the event is about one server
--   data         JSON; internal, never published as is
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  lane        TEXT,
  n           INTEGER NOT NULL DEFAULT 1 CHECK (n >= 0),
  subject     TEXT,
  data        TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX events_time ON events (occurred_at);
CREATE INDEX events_type ON events (type, id);
