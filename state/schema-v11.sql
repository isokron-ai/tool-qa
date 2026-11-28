-- Schema version 11: discovery keys (design audit A2, DESIGN-v3 4.2).
--
-- The discover lane (pump/discover.mjs) adds subjects from the registry and
-- package feeds. A subject stays one GitHub repository (bulk publishers and
-- monorepos collapse to the repository; it is deduped by repo_id). Each
-- (subfolder, purl) it was seen under is kept here, so the servers inside a
-- monorepo and the packages built from it are known beside the subject.
--   subject     subjects.id
--   repo_id     the repository's numeric id when known
--   subfolder   the server's folder in the repository ('' for the root)
--   purl        a package URL ('' when the feed named no package)
--   feeds       comma-separated feeds that named this key (registry, npm, pypi, crates, go)
CREATE TABLE discovery_keys (
  subject    TEXT NOT NULL,
  repo_id    INTEGER,
  subfolder  TEXT NOT NULL DEFAULT '',
  purl       TEXT NOT NULL DEFAULT '',
  feeds      TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (subject, subfolder, purl)
) STRICT;
CREATE INDEX discovery_keys_repo ON discovery_keys (repo_id);
CREATE INDEX discovery_keys_purl ON discovery_keys (purl) WHERE purl <> '';
