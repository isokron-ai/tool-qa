# meta: the metadata lanes

Two worker lanes that live in this repository, because neither runs any code
from a subject: they read public metadata through public APIs.

| Lane | Workflow | Reads |
|---|---|---|
| `meta-github` | `.github/workflows/meta-github.yml` | GitHub GraphQL and REST, api.scorecard.dev |
| `meta-registry` | `.github/workflows/meta-registry.yml` | the official MCP registry, npm, PyPI, crates.io, the Go module proxy, deps.dev |

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
run).

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
`go_module_facts`, `depsdev_facts`.

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
at most one request a second. No GitHub API is called.

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
  `policy_excluded` skip that is not retried.
- Each `registry_entry_history` element carries `namespace_matches_subject`:
  `false` for an `io.github.<owner>/...` entry whose owner is not the
  subject's (an entry that claims someone else's repository), `null` for a
  domain namespace.

## Skips

A stage that could not run for a passing reason is a skip with
`retryable: true`: `rate_limited` for a rate limit or our own budget, and
`upstream_unavailable` for a timeout, a network error or a 5xx after two
retries, or a subject not started before the shard deadline (22 minutes,
`META_DEADLINE_MINUTES`). When every skip of an item is retryable, ingest sends
it back later. A subject that is not `owner/name` reports `policy_excluded`. A
repository or package that does not exist is data (`null` with a `why`), not
a skip. A subject whose data makes the lane fail is that subject's own skip
(`upstream_unavailable`, not retryable), never a failed shard.

## Controls

Both run before any subject is read. If one fails, nothing is written and the
job uploads nothing. If the known-answer read is stopped by a rate limit or
an outage in a stage its facts come from, nothing is compared and no subject
is read: every item gets a bundle with the forgery control and one retryable
`known_answer` skip, so ingest sends it back later (`retry_later`, which does
not count towards parking). A fact that does not match stays a failure.

- **known-answer** (`known_good`, expected `match`): the lane reads our own
  repository `isokron-ai/mcp-check`, live, and compares facts that do not
  change, or only grow, with [`fixtures/known-answer.json`](fixtures/known-answer.json).
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
each subject). Then come the 100 worker-kit slots. The kit pinned at b1f25a9
downloads and checks age in every slot (`install-age.sh` has no "already
installed" check, and the action calls it with its own path, so a copy on
`PATH` is not used), then encrypts and uploads. The fixture's upload mode
measures a slot on GitHub. With N seconds a slot, a full shard takes at most
22 + 100 × N / 60 minutes plus about 1 minute of setup: it fits in 40 minutes
while N is at most 10. If N is higher, lower `shard_size` in
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
