# longitudinal: drift at an unchanged release

Three signals that need two observations of the same subject. Each is found
by comparing every accepted result of a subject, in the order they were
observed, with what was last seen before it. Tags keep their last-seen state
over the whole history: a failed read in between (ok, rate-limited, ok with a
new digest), or a git tag that leaves the 100-tag window and comes back, does
not hide a move.

| Signal | Field (mcp-results registry) | From | Class |
|---|---|---|---|
| A version tag force-pushed to another commit | `git_tag_moves` | meta-github `git_tag_targets` | P |
| A version image tag that resolves to a new digest | `oci_tag_moves` | meta-registry `oci_tag_digests` | P |
| A tool list that changes while the package version, image digest, tag and commit do not | `catalog_drift_same_version` | live-probe `tool_list_sha256`; scan-static's catalog hash | P-h |

A moving version tag, on git or on an image, is a supply-chain or hardening
signal, published by company and repository name.

## Where it runs

[`derive.mjs`](derive.mjs) is a separate step that only reads. It is not part
of ingest, because ingest judges one bundle at a time and keeps no
observation history in the state store (adding one would change the state
schema), and because the tool list signal needs results from several lanes
side by side. The archive the Mac's archive pull keeps
([`scripts/archive-pull.mjs`](../scripts/archive-pull.mjs)) is the only
complete history, so the step runs there:

```sh
node longitudinal/derive.mjs --archive ~/isokron-archive/tool-qa --out drift.ndjson
node longitudinal/derive.mjs --plain <folder with accepted/<attempt>/<index>/...>
```

`--archive` decrypts each sealed `ingest/<day>/<artifact>/*.tar.age` in memory
with the ingest identity (default `~/.isokron/loop-age-identity.key`, or
`--identity <file>`; never printed) and reads accepted items only: the
manifest, the observations and the scan-static or live-probe result. Nothing
decrypted is written to disk. The summary goes to stdout; `--out` writes one
line per derived field per subject (`{subject, field, value, derived_at,
source}`), holding only public facts: tag names, commit ids, image digests,
tool-list hashes and counts. The file is written with mode 0600, and never
inside the folder being read. `--since <time>` reports only events seen at or
after that time (parsed as a time, so an offset is honoured); everything
observed before it is the baseline they are compared with.

A subject gets a field only once it has two observations from the lane it
comes from. An empty list means the observations were compared and nothing
moved.

## Detection, and the false-positive guards

[`drift.mjs`](drift.mjs) holds the rules, as pure functions.

- **Version-like tags only.** A full `MAJOR.MINOR.PATCH` (a fourth part, a
  pre-release or a build suffix allowed), optionally `v`-prefixed or behind a
  package prefix: `1.2.3`, `v1.2.3`, `pkg@1.2.3`, `server-v1.2.3`,
  `sub/v1.2.3`, with no floating word (snapshot, dev, nightly, edge, latest,
  main, master, canary) in the pre-release or as a bare one-word prefix. A
  package prefix (ending in `@`, or of several parts, like `mcp-main@` or
  `edge-runtime-v`) is a name and is not checked. `latest`, `main`,
  `v1`, `1.2`, `1.0.0-SNAPSHOT`, `nightly-1.0.0` and other floating tags are
  expected to move: they are counted (`floating_moved`), never events.
- **Fix-up re-tags rank low; moved images rank medium.** A git tag whose old
  and new targets were made within an hour of each other (tagger date for an
  annotated tag, else commit date) is kept as an event with `rank: low`, but
  only if we also last saw the old target within an hour of when it was made:
  those dates are set by whoever made the commit or tag, so they are not
  trusted alone. An image tag whose old digest we last saw within an hour of
  the registry release is `rank: low` too. Otherwise a moved git tag is
  `rank: high`, and a moved image tag `rank: medium`, because base images are
  rebuilt routinely and results are public by name. A version tag
  re-annotated on the same commit is counted (`reannotated`), not an event.
- **Our own tools are not the subject's drift.** A tool list change is
  excluded (counted under `excluded`) when the manifest's tool versions differ
  (`tool_version_changed`), or when the run_key differs while the subject
  commit is the same (`run_key_changed`: a tool, oracle, probe or settings
  change). A new package version (`new_release`), a different package
  (`package_changed`) or a new commit (`new_commit`) is not drift either.
- **npm, PyPI and NuGet versions are immutable.** A published version's
  content cannot change there, so a tool list change at the same version is
  never an event (`immutable_registry_version`).
- **Floating image tags.** For an image, the version is the tag live-probe
  ran (the identifier's own tag, else the registry version). A tool list that
  changes with the digest behind a floating tag is a new image, not drift
  (`floating_tag`).
- **Same source, same reader, different list is ours.** For scan-static, a
  different list from the same commit with the same tools and run_key is our
  reader's nondeterminism. It is reported in the summary's `tool_side`, never
  as a subject event. Other lanes have no such case: with only a commit to go
  on they are `no_anchor`.

Tool list events: `catalog_changed_same_image` (same image digest, rank
medium), `catalog_changed_with_tag_move` (a version-like tag now points to a
new digest, rank high), `catalog_changed_same_version` (another package type at
the same version, rank medium).

## Limits

- Only the newest 100 tags (by commit date) are read per repository, so a
  force-push of an older tag is seen only while the tag is among them; a
  force-pushed tag moves to the top, so it is seen if it was in the previous
  sample.
- Five image tags per subject, newest registry versions first.
- An image tag rebuilt for a base-image refresh is a move like any other.
- Live-probe is not switched on yet, so the "same released version" case has
  fixtures only. scan-static reads source at the default branch head, so for
  it only "same commit" applies.
