# meta: the metadata lanes

Three worker lanes that live in this repository, because none runs any code
from a subject: two read public metadata through public APIs, and
`release-diff` reads published packages and source archives as data
([below](#release-diff)).

| Lane | Workflow | Reads |
|---|---|---|
| `meta-github` | `.github/workflows/meta-github.yml` | GitHub GraphQL and REST, api.scorecard.dev |
| `meta-registry` | `.github/workflows/meta-registry.yml` | the official MCP registry, npm, PyPI, crates.io, the Go module proxy, deps.dev, the allowlisted OCI registries (manifest HEAD only) |
| `release-diff` | `.github/workflows/release-diff.yml` | npm and PyPI artifacts, their provenance, the repository's tags and source archive |

The pump dispatches them like any worker (`pump/workflows.json`, shard size
100, one slot each) with `shard_id`, `attempt_id` and `items`
([docs/INTERFACES.md](../docs/INTERFACES.md), "Worker dispatch"). Each item's
subject is a GitHub repository, `owner/name`.

## What a bundle holds

One bundle per item, sealed by the worker kit as
`result-<attempt_id>-<i>.tar.age`:

| Path | What |
|---|---|
| `observations/<lane>.ndjson` | Field records from the mcp-results field registry (below) |
| `results/<lane>.json` | Our report: outcome, the stage outcomes, fields emitted, the shard's API use |
| `controls/known-answer.json`, `controls/forgery.json` | The two controls |
| `raw/control-forgery/answers.json` | The forgery target's planted answers, with the marker |
| `logs/<lane>.log` | One line: outcome, record and skip counts |

### meta-github fields

`repo_core`, `repo_owner_type`, `repo_popularity`, `owner_org_facts`,
`releases_summary`, `issues_prs_summary`, `contributors_counts`,
`security_posture`, `branch_rules_public`, `community_profile`,
`workflow_health`, `scorecard_api_result` (the published result from
api.scorecard.dev; `scorecard_result` is left for scan-deep's own Scorecard
run), `git_tag_targets` and `git_tag_map_sha256`.

`git_tag_targets` lists the newest 100 tags by commit date (`refs(refPrefix:
"refs/tags/", first: 100, orderBy: TAG_COMMIT_DATE DESC)`, in the same GraphQL
query as the rest), each with the commit it points to (an annotated tag is
peeled once and keeps its tag object), the commit date and the tagger date,
plus the total and whether the list was cut. `git_tag_map_sha256` is the
sha256 of the canonical JSON of the sorted `[tag, commit, tag object]` list.
Tag names are sanitised (and bidirectional control characters replaced)
before they are kept or hashed. A GraphQL error on the tag refs is a failed
read (`null` with why, a retryable `tag_refs` skip), not an empty list. They feed the
force-pushed tag signal (`longitudinal/`). The tags cost no REST call; a batch
of nine real repositories cost 1 GraphQL point with and without them (24 Nov
2026).

Per shard: one GraphQL query per 10 repositories, then three conditional REST
calls per repository (contributor count from the `Link` header, the rules for
the default branch, private vulnerability reporting) and one Scorecard call.
The job's `GITHUB_TOKEN` has an hourly REST limit and an hourly GraphQL
point limit for this repository (1,000 each on the free plan; GitHub reports
the real figure in `x-ratelimit-limit` and `rateLimit.limit`). That bucket is
shared: the pump, ingest, the watchdog and history-popularity use the same
job token here. So the lane keeps a reserve of 25 % of the reported limit,
and never less than 300 (`META_RESERVE_PERCENT`, `META_RESERVE_MIN`). No
REST call starts if the requests left, less those already in flight, would
go under it, nor after 400 counted calls in the shard (`META_REST_CAP`); no
GraphQL query starts under the GraphQL reserve. A 304 answer does not count.

### meta-registry fields

`registry_entry_history` (every version of every official MCP registry entry
whose repository is the subject, with publish and status dates and the
packages each version declares; an empty list when there is none),
`npm_version_doc`, `npm_maintainer_count_and_change`, `npm_attestations`,
`pypi_info`, `pypi_project_status`, `pypi_provenance`, `crates_crate_facts`,
`go_module_facts`, `depsdev_facts`, `oci_tag_digests`.

`oci_tag_digests` holds the digest each declared image tag resolves to, for at
most five tags per subject: the subject owner's own registry entries first
(newest version first), then the seed list, then other entries that claim the
repository. Each element has the image reference, the tag, the entry and
version that declared it, the digest, the media type, how it was read and a
status (`ok`, `not_found`, `unauthorized`, `host_not_allowed`,
`no_digest_header`, `no_digest`, `too_large`, `token_unreadable`,
`redirect_refused`, `rate_limited`, `upstream_unavailable`). An empty list means no OCI package. Only the hosts in
`lib/oci.mjs` are asked (docker.io, ghcr.io, quay.io, public.ecr.aws,
mcr.microsoft.com, registry.gitlab.com; the same allowlist as mcp-check's
live-probe), and their token services. One tag is one manifest `HEAD`, which
answers with `Docker-Content-Digest`; the first tag of an image also costs a
401 and one anonymous token request. Redirects are not followed, no layer or
blob is fetched, and Docker Hub never gets a manifest `GET` (it counts as a
pull there), and an empty manifest is `no_digest`. A token realm must be
https, on the default port, with no user or password, on the token-host list.
So a subject costs at most 5 tags + 2 requests per image. A rate limit or an
outage is a retryable `oci` skip. A refused realm, or a token answer we cannot
use (over 64 KiB, not JSON, no token: `token_unreadable`, a `tool_error` skip
with fault `tool` that is not retried), fails the same way every time. Any of
these stops that host's remaining reads for the subject. They feed the moving image tag signal (`longitudinal/`).

npm is read through its abbreviated document
(`application/vnd.npm.install-v1+json`: versions, tags, deprecations,
provenance per version, without the readmes that make full documents run to
hundreds of MB), the latest version's own document (repository, licence,
gitHead, scripts, maintainers at that publish) and deps.dev's version list
for publish dates (`dates_source: deps.dev`).

`npm_maintainer_count_and_change` holds the maintainer count only, from the
latest version's document (`basis: latest_version_document`). The change
is derived later, by ingest's longitudinal layer, from the counts of
successive scans: the worker keeps no maintainer names, not even hashed, so it
cannot compare sets itself.

The packages read are those the newest registry versions declare, plus the
seed list's (`history/seed-v1.json`), at most five per ecosystem. The Go
module `github.com/<owner>/<name>` is read through the proxy's `/cached-only/`
endpoint, so the proxy never fetches from the origin for us. crates.io gets
at most one request a second. No GitHub API is called (ghcr.io is read as a
container registry, not the API).

## What is kept, and what is not

- Values sit under keys we chose. Upstream object keys are never copied: a
  map such as npm's `engines` becomes a list of `{name, range}`.
- Every kept string is scanned with ingest's redaction rules and its
  identity-claim pattern; a hit is replaced by `[removed: <rule>]`.
- Free text by upstream authors (descriptions, licence texts, deprecation
  messages) is kept as a sha256 and a length only.
- No personal data: maintainers, owners and contributors are counted, never
  named. Emails are never read into the cache or a bundle.
- Captured answers are not kept in `raw/`, apart from the forgery target's.
- The cache holds the same summaries: licence texts, summaries and crate
  descriptions are digests there too.
- No answer is read past 20 MiB. A larger one stops that stage with a
  `too_large` skip (fault tool) that is not retried.
- Anyone can publish a registry entry that claims a repository. The subject's
  own entry, `io.github.<owner>/<name>`, is read by its exact name first, so a
  crowded or failing search cannot hide it (a failing search is its own
  `mcp_registry_search` skip). Packages are read in this order: those of
  entries in the owner's own namespace, then the seed list's, then any other
  entry's, at most five per ecosystem.
- Each `registry_entry_history` element carries `namespace_matches_subject`:
  `false` for an `io.github.<owner>/...` entry whose owner is not the
  subject's (an entry that claims someone else's repository), `null` for a
  domain namespace.

## Skips

Every skip says its reason and its fault side (R-META-10). A stage that could
not run for a passing reason is a skip with `fault: infra` and
`retryable: true`: `rate_limited` for a rate limit or our own budget, and
`upstream_unavailable` for a timeout, a network error or a 5xx after two
retries. A subject not started before the shard deadline (22 minutes,
`META_DEADLINE_MINUTES`) is `reader_limit` with `fault: tool`, retryable: the
time limit is ours. When every skip of an item is retryable, ingest sends
it back later. A subject that is not `owner/name` reports `unsupported_layout`
with `fault: tool` (the lane reads GitHub only). A
repository or package that does not exist is data (`null` with a `why`), not
a skip. A subject whose data makes the lane fail is that subject's own skip
(`upstream_unavailable`, not retryable), never a failed shard.

Retries are bounded by ingest, not here: after three `retry_later` decisions
for the same run_key, ingest accepts the next bundle whose skips are all
retryable, even one with no records (for example a subject the known-answer
outage skipped), and that subject is not due again until `max_age_days`
(`pump/tiers.json`). The retry cap lives in `ingest/`, where it is being
changed separately.

## Controls

Both run before any subject is read. If one fails, nothing is written and the
job uploads nothing. If the known-answer read is stopped by a rate limit or
an outage in a stage its facts come from, nothing is compared and no subject
is read: every item gets a bundle with the forgery control and one retryable
`known_answer` skip, so ingest sends it back later (`retry_later`, which does
not count towards parking). A fact that does not match stays a failure.

- **known-answer** (`known_good`, expected `match`): the lane reads our own
  repository `isokron-ai/mcp-check`, live, and compares facts that do not
  change, or only grow, with [`fixtures/known-answer.json`](fixtures/known-answer.json). For
  meta-registry the facts come only from entries in the owner's own
  namespace, and only `@isokron/mcp-check`'s npm outcome counts, so entries
  others publish for the repository cannot break the control.
- **forgery** (`forgery`, expected `contained`), fresh marker per item: the
  lane reads a planted subject offline from `fixtures/forgery-<lane>.json`,
  whose answers pose as another attempt's result. Contained: the answers were
  read, and what the lane keeps holds no marker, no identity-shaped key or
  text and no envelope.

## The conditional-request cache

`META_CACHE_FILE` maps each URL to its ETag or Last-Modified and the summary
we extracted from that answer (never the body). The workflow restores it with
`actions/cache/restore` and saves it after the run, so an unchanged answer
costs a 304.

## Runtime

The job has 40 minutes; the pump's lease for a shard of 100 is 43. The worker
starts no subject after 22 minutes (`META_DEADLINE_MINUTES`, checked before
each subject). Then come the 100 worker-kit slots. The kit pinned at 2ffcea1
downloads and checks age in every slot (`install-age.sh` has no "already
installed" check, and the action calls it with its own path, so a copy on
`PATH` is not used), then encrypts and uploads. The fixture's upload mode
measures a slot on GitHub: 2 to 4 seconds (2.5 s on average over 6 slots,
23 Nov 2026). With N seconds a slot, a full shard takes at most
22 + 100 × N / 60 minutes plus about 1 minute of setup, so about 30 minutes
at the measured worst of 4 s: it fits in 40 minutes while N is at most 10. If N is higher, lower `shard_size` in
`pump/workflows.json` to (40 − 23) × 60 / N, or skip the install in the kit
and move the pin.

## Kill switch

The first step checks `LOOP_ENABLED`; then `scripts/guard.mjs --job <lane>
--no-slots` checks `LOOP_PAUSE_UNTIL` and `LANE_META_GITHUB_ENABLED` or
`LANE_META_REGISTRY_ENABLED`. Off is a notice, never a failed run. `LOOP_SLOTS`
is the pump's business: a worker it has already dispatched finishes its shard.

## Files and tests

- `run.mjs`: the worker; `lanes.mjs`: the two lanes behind one interface;
  `github.mjs`, `registry.mjs`: the reads and the field mapping;
  `controls.mjs`: the controls; `lib/`: inputs, sanitising, HTTP and the cache.
- `gen-workflows.mjs` writes the three workflows (100 worker-kit slots each);
  edit it, not the YAML. `node meta/gen-workflows.mjs --check` is part of the
  tests.
- `test/`: mocked fetch only; every bundle is judged with ingest's own checks
  against a copy of the pinned field registry.
- `.github/workflows/meta-fixture.yml`: on pull requests, both lanes read three
  of our own repositories through the real APIs. In `check` mode the kit builds
  every bundle in dry-run mode and `fixture.mjs judge` checks each one as
  ingest would; in `upload` mode the kit encrypts and uploads as the workers
  do, which measures the time per slot.

## release-diff

Is what a subject publishes what its source says? For each npm tarball,
PyPI sdist and wheel a repository publishes, the lane compares the artifact
with the source tree at the version's git tag (`release-diff.mjs`,
`lib/diff.mjs`). It is switched off in `pump/workflows.json` until review
switches it on; shard size 20, one slot.

### What it reads, and from where

| Step | Source |
|---|---|
| Packages | the subject's own official MCP registry entries, the seed list, deps.dev's GetProjectPackageVersions (attested links first, v3alpha), then other registry entries; at most three per ecosystem |
| Release | the latest version (`registry.npmjs.org/<name>/latest`, `pypi.org/pypi/<name>/json`); npm's tarball, PyPI's sdist and one wheel (`py3-none-any` first) |
| Provenance | npm SLSA v1 (`dist.attestations`) and PyPI PEP 740 (the integrity API), checked as live-probe checks them (`lib/provenance.mjs`): Sigstore's Fulcio root, a GitHub Actions workflow of the subject, the DSSE signature, the artifact's digest; plus the commit and ref the certificate names |
| Tags | `git-upload-pack` over smart HTTP, protocol 2 `ls-refs` for `refs/tags/` and `HEAD` only (`lib/gitrefs.mjs`); no API quota |
| Source | `codeload.github.com/<repo>/tar.gz/<commit>` |

Every request goes to `ALLOWED_HOSTS` over HTTPS (registry.npmjs.org,
pypi.org, files.pythonhosted.org, github.com, codeload.github.com,
api.deps.dev, registry.modelcontextprotocol.io); anything else is refused
before it is sent. Downloads never follow a redirect, the npm tarball URL
must be on registry.npmjs.org and the PyPI file on files.pythonhosted.org,
and the bytes must match the registry's digest (npm's sha512 integrity,
PyPI's sha256) before they are read.

### Nothing from an artifact runs

Artifacts and source archives are read in memory by our own readers,
`scripts/lib/untar.mjs` (new) and `scripts/lib/unzip.mjs`, and nothing is
written to disk, installed, imported or run. Paths that could leave a folder
(`..`, absolute, drive letters, backslashes, NUL) are refused; symbolic and
hard links, devices and FIFOs are recorded and never followed or read. Caps:

| | artifact | source archive |
|---|---|---|
| compressed | 64 MiB | 128 MiB |
| inflated (every byte gunzip gives counts, kept or not) | 256 MiB | 1 GiB |
| entries | 20,000 | 100,000 |
| one kept file | 16 MiB | 2 MiB |
| time | 2 minutes a download | 2 minutes |

A subject starts no network call after 6 minutes (downloads are not retried), and reads at most four source
commits.

### The tag and the source commit

The version's tag is matched strongly (`v1.2.3`, `1.2.3`; with the package,
folder or ecosystem name: `name@1.2.3`, `name-v1.2.3`, `folder/v1.2.3`,
`py-v1.2.3`) or weakly (any tag that ends in the version after a separator).
The source commit is the strong tag's, else a weak tag's when provenance or
npm's `gitHead` names the same commit, else the provenance commit, else
`gitHead`. With none, nothing is compared (`no_source_basis`). A package whose
metadata names another repository and that has no provenance from the subject
is not compared (`not_linked_to_subject`).

### Fields

`release_artifacts` (P), `release_diff_summary` (P), `release_diff_findings`
(P-h) and `release_diff_held` (S), declared in mcp-results
`fields/registry.yaml`. Every file of an artifact is identical, identical
once line endings are folded, explained (`build_output`, `compiled_output`,
`compiled_extension`, `copied_from_repo`, `generated_metadata`,
`generated_lockfile`, `generated_setup_py`, `generated_version_file`,
`version_stamp`, `manifest`), or unexplained. A file the source tree has, with other
content, is never explained by the folder it sits in: a changed `lib/index.js`
that is tracked in the source is `content_differs`. A version stamp is a line
that carries the artifact's version and differs from the source's line in
nothing else. Findings,
each with a level:

| Kind | Level |
|---|---|
| `unexpected_file` | high for executable, binary or install-time files; medium; low for docs and media |
| `content_differs` | high for code, else medium |
| `manifest_differs` (package.json, pyproject.toml; explained keys left out) | high for added dependencies, install scripts or the build system |
| `install_script` (preinstall, install, postinstall, implicit `binding.gyp`) | medium; high when the source manifest does not have it |
| `setup_py_executes`, `in_tree_build_backend`, `pth_file` | low to high |
| `no_matching_tag` | low |
| `tag_commit_differs_from_provenance` | high when the build was from that very tag (the tag moved), else medium |
| `tag_commit_differs_from_git_head` | low (an attention item: release flows that commit after npm's `gitHead` trigger it) |
| `source_commit_not_found` | medium |
| `link_in_package`, `duplicate_entry`, `special_entry`, `unsafe_entry_refused`, `no_source_overlap`, `artifact_unreadable` | medium or high |

### Packages linked only by what their author wrote

A package that reaches the subject only through its own `repository` field or
PyPI project URLs (`linked_by` `repository_field` or `project_urls`) can name
any repository. Its public findings are capped at `low`, with `level_capped_from`
and `linked_by` on the finding. Verified provenance and an attested deps.dev link
keep their levels.

### Security-class items are held

`lib/indicators.mjs` looks for strong indicators (javascript-obfuscator
identifiers in bulk, code decoded and evaluated, exfiltration endpoints,
download-and-run, credential stores read by name) and secrets (ingest's
precise rules, secret file names). An item is held when one turns up where
the source does not explain it: an unexplained or differing file, an install
script or the file it runs, setup.py, a `.pth` file, or build output whose
matched text appears nowhere in the source tree. A held item goes to
`release_diff_held` (class S) with its path, digest and rule ids, never the
matched text, and is left out of every public field and count. The held list is capped at 500 entries like the findings; a last
`held_truncated` entry counts what it left out. The fixture
run's log prints nothing about it.

### Skips

Every skip says its fault side. Passing problems (a rate limit or a 403 from
GitHub or a registry, an outage, a cut stream, a digest mismatch) are
`rate_limited` or `upstream_unavailable` with `fault: infra`, retryable. A
redirect we do not follow (a download, a codeload archive, a registry answer
that leaves the allowed hosts, a renamed repository that moved off github.com)
is `upstream_unavailable` with `fault: tool`, retryable; a renamed repository
on github.com is read at its new name. Only a 404 (or GitHub's 401 for a
repository that is gone) is the subject's, and it is data, not a skip. Our own limits say
`fault: tool` and are not retried: `too_large` (a cap above),
`reader_limit` (the time limit, the subject's budget, the commit limit, the
compute budget of 90 seconds for all comparisons of a subject, a zip feature or
tar number our readers lack: zip64, unsupported compression, encryption),
`tool_error` (the lane failed on the subject), `unsupported_layout` (a subject
that is not a GitHub repository). The shard deadline is `reader_limit` with
`fault: tool`, retryable. These need the worker kit at 2ffcea1 or later,
which every lane's workflow and the fixture pin (R-META-11).

### Controls

- **known-answer**: our own `@isokron/mcp-check` 1.3.1 (npm) and
  `mcp-write-safety-kit` 0.1.0 (PyPI, sdist and wheel), pinned in
  `fixtures/known-answer.json`: discovery, tags, verified provenance with its
  commit, the source commit, file counts and findings.
- **forgery**: `fixtures/forgery-release-diff.json`, built offline per item
  with a fresh marker: a package tarball and a source archive whose file
  names, manifest keys and tag names pose as another attempt's result.

### Runtime

Measured locally on 19 subjects (our 7 that publish, 12 from the seed list):
1 to 4 seconds for most subjects, 27 seconds for one with 64 MiB platform
packages (skipped as too large), and up to the 6-minute budget for a
repository of about 500 MB whose source archive is slow.
