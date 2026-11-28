-- Schema version 14: write backends (the meta-backend lane, docs/INTERFACES.md "Writecheck modes").
--
-- write_backends: the latest accepted write_backend observation of each subject
-- (state/backends.mjs backendFacts), what the pump routes writecheck's modes by
-- (pump/modes.mjs) and what writecheck's coverage counts per mode
-- (state/coverage.mjs). One row per subject, replaced by each accepted
-- meta-backend result that holds a value; a result observed before the stored
-- one is late and changes nothing. A result with no value (the repository was
-- not found) leaves the row as it was.
--   class      local_full | mock_min | none
--   mode       full | min | none
--   reason     for none: no_backend_signal | hosted_without_spec | stand_in_not_cleared
--              | no_stand_in | not_a_store | no_write_tools_seen; NULL otherwise
--   backend, backend_kind, stand_in, spec_url, spec_format   the routing facts
--   env_names  JSON list of env var names (never values), base-URL knobs first, at most 20
--   observed_at  when the worker run that read it completed
-- Nothing here is a result's fault or coverage: `none` means "not testable here".
CREATE TABLE write_backends (
  subject      TEXT PRIMARY KEY,
  run_key      TEXT NOT NULL,
  class        TEXT NOT NULL CHECK (class IN ('local_full', 'mock_min', 'none')),
  mode         TEXT NOT NULL CHECK (mode IN ('full', 'min', 'none')),
  reason       TEXT,
  backend      TEXT,
  backend_kind TEXT,
  stand_in     TEXT,
  spec_url     TEXT,
  spec_format  TEXT,
  confidence   TEXT,
  env_names    TEXT NOT NULL DEFAULT '[]',
  observed_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
