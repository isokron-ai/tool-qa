# longitudinal: drift at an unchanged release

Three signals that need two observations of the same subject. Each is found
by comparing a subject's successive accepted results, in the order they were
observed.

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
tool-list hashes and counts. `--since <time>` limits the items read.

A subject gets a field only once it has two observations from the lane it
comes from. An empty list means the observations were compared and nothing
moved.

## Detection, and the false-positive guards

[`drift.mjs`](drift.mjs) holds the rules, as pure functions.

- **Version-like tags only.** A full `MAJOR.MINOR.PATCH` (a fourth part, a
  pre-release or a build suffix allowed), optionally `v`-prefixed or behind a
  package prefix: `1.2.3`, `v1.2.3`, `pkg@1.2.3`, `server-v1.2.3`,
  `sub/v1.2.3`. `latest`, `main`, `nightly`, `v1`, `1.2` and other floating
  tags are expected to move: they are counted (`floating_moved`), never events.
- **Fix-up re-tags rank low.** A git tag whose old and new targets were made
  within an hour of each other (tagger date for an annotated tag, else commit
  date), or an image tag whose old digest was last seen within an hour of the
  registry release, is kept as an event with `rank: low`. Everything else is
  `rank: high`. A version tag re-annotated on the same commit is counted
  (`reannotated`), not an event.
- **Our own tools are not the subject's drift.** A tool list change is
  excluded (counted under `excluded`) when the manifest's tool versions differ
  (`tool_version_changed`), or when the run_key differs while the subject
  commit is the same (`run_key_changed`: a tool, oracle, probe or settings
  change). A new package version (`new_release`), a different package
  (`package_changed`) or a new commit (`new_commit`) is not drift either.
- **npm and PyPI versions are immutable.** A published version's content cannot
  change there, so a tool list change at the same npm or PyPI version is never
  an event (`immutable_registry_version`).
- **Same source, same reader, different list is ours.** For scan-static, a
  different list from the same commit with the same tools and run_key is our
  reader's nondeterminism. It is reported in the summary's `tool_side`, never
  as a subject event.

Tool list events: `catalog_changed_same_image` (same image digest, rank
medium), `catalog_changed_with_tag_move` (the version tag now points to a new
digest, rank high), `catalog_changed_same_version` (another package type at
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
