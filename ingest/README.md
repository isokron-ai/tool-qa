# ingest

Trusted ingest of worker results. For one attempt it downloads the worker's
encrypted bundle for each dispatched item, decrypts it, checks it against what
tool-qa dispatched, decides, and records each item's decision in the attempts
ledger. It never runs anything from a bundle.

It runs in two places, with the same checks:

- **In the pump** ([`collect.mjs`](collect.mjs)), at the start of every tick:
  for each dispatch still waiting it finds the worker run, judges every item
  once the run has finished, records each decision in the pump's open state
  store, seals each item's outputs, and closes the dispatch once every item is
  decided. This is the normal path; the pump is the only state writer. See
  [docs/INTERFACES.md](../docs/INTERFACES.md) ("Ingest in the pump").
- **By hand** ([`ingest.mjs`](ingest.mjs) command line, run by
  [`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml)) for one
  attempt the pump did not judge, only while the pump is paused. See
  [docs/OPERATIONS.md](../docs/OPERATIONS.md) ("Manual re-ingest").

Trusted: the dispatch (worker repo, attempt id, and the run id the pump found
or the operator gave), the attempts ledger in the state store, and what the
GitHub API says about the run. Untrusted: everything in the artifact,
including the manifest.

An attempt is one shard: the `items` list the worker received, one or more
`{subject, run_key, fence}`. Result manifest v1 names one run_key, so the
worker uploads one bundle per item, named by the item's 0-based position
(`<index>`) in that list. The attempt and its run are checked once; then each
item is judged and recorded on its own, so a missing or bad bundle rejects
that item only.

## Steps

1. **Ledger.** The attempt must exist and belong to the given repo (and run,
   if the ledger has the run id). Items that already have a result are
   skipped; if all have one, the answer is `already_recorded`. An item whose
   fence has moved on gets `stale_fence`, without a download; if every open
   item is stale, the run is not even looked at.
2. **Run.** The run must be completed, in that repo, from the dispatched
   workflow file, started by `workflow_dispatch` and, if the ledger has the
   commit, at that commit. The worker's own conclusion (success or failure)
   does not matter; the bundles decide. A run that fails these checks rejects
   every item still open, with the same reason. While the run is not
   finished, nothing is recorded for any item (`pending`).
3. **Artifact.** The run's artifacts are listed once. For each item, exactly
   one artifact named `result-<attempt>-<index>.tar.age` (or
   `result-<attempt>-<index>`) from that run, not expired, at most 65 MiB.
   For an attempt of one item, the older name `result-<attempt>.tar.age` (or
   `result-<attempt>`) is accepted too; both at once is `duplicate_artifact`.
   It is downloaded through the API (the token never goes to blob storage)
   and, if GitHub wrapped it in a zip, unwrapped.
4. **Decrypt** with age and the ingest identity (`AGE_IDENTITY`).
5. **Bundle.** A tar of regular files with safe paths, at most 64 MiB, each
   file (`manifest.json` included) at most 8 MiB, with a
   `manifest.json` that is valid JSON and valid against
   [`manifest.schema.json`](../worker-kit/manifest.schema.json).
6. **Forgery checks** ([`forgery.mjs`](forgery.mjs)): the manifest's identity
   (attempt id, and this item's run_key and fence) and workflow match the
   ledger and the run (the run's `head_sha` is the workflow commit); the tar
   holds exactly the listed files with the listed sizes and sha256; outside
   `raw/` nothing names another attempt id, fence or run_key (another item of
   the same attempt counts as another); every control passed, and a forgery
   control's marker is in `raw/` and nowhere else.
7. **Field registry** ([`registry.mjs`](registry.mjs)): every observation uses a
   declared, non-deprecated field with a value of the declared type. The
   registry is read from `isokron-ai/mcp-results` at a pinned commit and
   checked against a pinned sha256.
8. **Secret scan** ([`redact.mjs`](redact.mjs)): the manifest and every file
   outside `raw/` are scanned with the redaction rules and the canaries the
   ledger holds for the attempt. Any hit quarantines the bundle. Hits in `raw/`
   are only counted.

9. **Retry.** A bundle that passed every check but whose skips are all marked
   `retryable` (rate limits, upstream outages; see
   [`worker-kit/README.md`](../worker-kit/README.md)) is rejected as
   `retry_later`, so the item is sent out again, at most three times per
   run_key (`MAX_RETRIES`); after that it is accepted with its skips. When
   every skip is a rate limit or an upstream outage, it is rejected as
   `retry_throttled` instead: not counted towards `MAX_RETRIES`, and sent out
   again for as long as 7 days after the run_key's first throttled retry
   (`RETRY_WINDOW_MS`), so throttling never costs a whole tier max age. An
   accepted bundle with no observation records whose every skip is retryable
   is recorded with result outcome `skips_only`, which the pump looks at
   again after a day; one with any permanent skip is an ordinary result.

Steps 5 to 8 read untrusted bytes, so they run in a worker thread
([`analyze.mjs`](analyze.mjs)) with no environment, a 1 GiB heap limit and a
60 second wall-clock limit. A judge that runs past the limit is stopped and
the item is rejected as `ingest_timeout`; one that fails in any other way
(an exception, out of memory) is rejected as `ingest_error`. Every pattern
and walk in these steps runs in linear time, and JSON nested deeper than 64
levels is read as text (see [REGRESSIONS.md](../REGRESSIONS.md)). Once an
artifact is downloaded, a failure caused by its contents is always a recorded
rejection, never an error that is tried again.

Each item's decision is then recorded with `recordResult`, one call per item.
The ledger does its own fence check; if it refuses an acceptance, the outcome
becomes `rejected` with the ledger's reason.

## Outcomes

Per item (`<index>` is the item's position in `items`):

| Outcome | Recorded | Outputs |
|---|---|---|
| `accepted` | yes | `accepted/<attempt>/<index>/`: `manifest.json`, every bundle file, `ingest.json` |
| `rejected` | yes, except the refusals below | `rejected/<attempt>/<index>/`: `ingest.json`, and `result.tar.age` (the ciphertext as uploaded) once it was downloaded |
| `quarantined` | yes | `quarantine/<attempt>/<index>/`: `ingest.json`, `result.tar.age` |

For the whole attempt:

| Outcome | Recorded | Outputs |
|---|---|---|
| refused (reasons below) | no | `rejected/<attempt>/ingest.json` |
| `pending` | no | none; the run is not finished, the pump looks again next tick (by hand: run again later) |
| `already_recorded` | no | none; every item has a result, running again is a no-op |

The outputs are packed into tars and age-encrypted to `worker-kit/ingest.pub`,
so nothing is stored in the clear in CI. The pump writes one
`ingest-<attempt>-<index>.tar.age` per judged item (and
`ingest-<attempt>.tar.age` for a refused attempt) into its outputs directory
(`--ingest-out`, uploaded by `pump.yml` as `ingest-<run id>-<run attempt>`);
the CLI writes all items of the attempt into one `--sealed` file. A rejected
or quarantined bundle is kept only as ciphertext.

`ingest.json` is the report for one item: outcome, reason, `item_index`, the
ledger row (this item's run_key and fences, the number of items, canaries only
as a count), the run, the artifact (id, name, sizes, sha256 of the download and of
the ciphertext, `raw` or `zip`), bundle counts, the registry digest, problems
and secret-scan hits. Problems and hits carry reason or rule codes, paths,
lines, JSON paths and offsets, never file contents; any name that reaches the
report is masked if it looks like a secret or a canary.

## Reasons

Refused without recording (the inputs may be wrong; an attempt that never gets
a result is handled by lease expiry):

| Reason | Meaning |
|---|---|
| `unknown_attempt` | The ledger has no such attempt |
| `ledger_repo_mismatch` | The attempt was dispatched to another repo |
| `ledger_run_mismatch` | The ledger binds the attempt to another run |
| `run_not_found` | The run does not exist or the token can't see it |

Recorded rejections and quarantine:

| Stage | Reasons |
|---|---|
| ledger | `stale_fence` (fence moved on, before download or refused at record time), `ledger_refused` (refused without a reason) |
| run | `run_repo_mismatch`, `run_workflow_mismatch`, `run_event_mismatch`, `run_sha_mismatch` |
| artifact | `no_artifact`, `duplicate_artifact`, `artifact_run_mismatch`, `artifact_expired`, `artifact_too_large`, `bad_container` |
| decrypt | `decrypt_failed` (not encrypted to the ingest key, or damaged), `bundle_too_large` |
| bundle | `bad_bundle` (not a safe tar of regular files), `file_too_large` (a file over 8 MiB), `no_manifest`, `manifest_not_json`, `manifest_invalid` |
| identity | `attempt_mismatch`, `fence_mismatch`, `run_key_mismatch`, `workflow_repo_mismatch`, `workflow_file_mismatch`, `workflow_sha_mismatch`, `run_id_mismatch`, `run_attempt_mismatch` |
| files | `unlisted_file`, `missing_file`, `size_mismatch`, `digest_mismatch` |
| controls and claims | `forgery_control_injected`, `forgery_marker_leaked`, `foreign_identity_claim`, `control_output_in_raw`, `control_failed`, `control_missing`, `forgery_control_unverified` |
| registry | `observation_format`, `undeclared_field`, `deprecated_field`, `field_type` |
| secrets (quarantined) | `secret_scan` |
| retry | `retry_later` (every skip is retryable; sent out again after a backoff; not counted towards parking), `retry_throttled` (every skip is a retryable rate limit or upstream outage; sent out again for up to 7 days; not counted towards parking or the three retries) |
| judging | `ingest_timeout` (judging or decrypting ran past its time limit), `ingest_error` (judging failed on this bundle, or the pump failed to judge the item three times; see "Ingest in the pump" in docs/INTERFACES.md) |

When a bundle has several problems, all are listed and the most specific names
the rejection, in the order of the table (identity first).

## Command line

```sh
GITHUB_TOKEN=... AGE_IDENTITY="$(cat ingest-identity.txt)" \
node ingest/ingest.mjs --repo isokron-ai/mcp-check --run-id 123456789 --attempt-id att-1 \
  --state state/state.sqlite --sealed out/ingest-att-1.tar.age
```

| Option | Meaning |
|---|---|
| `--repo`, `--run-id`, `--attempt-id` | The dispatch: worker repo, its run id, the attempt id (required) |
| `--state FILE` | Attempts ledger from the state store (`state/db.mjs`) |
| `--ledger-json FILE` | Or a JSON stand-in for local runs: `{"attempts": [<row>], "results": []}` |
| `--sealed FILE` | Write the outputs as one age-encrypted tar (mode 0600) |
| `--work-dir DIR` | Write the outputs as plain files (local runs) |
| `--registry FILE` | Read the field registry from a file instead of the pinned URL |
| `--seal-to FILE` | Recipients for `--sealed` (default `worker-kit/ingest.pub`) |
| `--allow-no-controls` | Accept bundles that carry no control at all |

Environment: `GITHUB_TOKEN` (or `GH_TOKEN`) and `AGE_IDENTITY`, both removed
from the process environment at start; optional `AGE_BIN`, `AGE_KEYGEN_BIN`,
`GITHUB_API_URL`, `RUNNER_TEMP` (where the identity file lives for the moment
age needs it), `GITHUB_OUTPUT`.

Before judging anything, the CLI checks that `worker-kit/ingest.pub` holds a
key and that `AGE_IDENTITY` is the identity for one of its keys. If not, it
exits 1 and nothing is fetched or recorded.

Step outputs, over all items of the attempt: `outcome` (the items' common
outcome, or `mixed`), `reason` (the common reason, or empty), `accepted`
(`true` only if every item was accepted), `recorded` (`true` if any item was
recorded) and `sealed` (path, empty when there was nothing to write). It
prints one line, `::notice` or `::warning title=ingest::attempt <id>:
<outcome> (<reason>)`, and for an attempt of more than one item one more line
per item, `... attempt <id> item <index>: <outcome> (<reason>)`. Errors are one
`::error` line, with the token and identity cut out.

Exit codes: 0 a decision was made (any outcome, including `pending`), 1 an
operational error (GitHub unreachable after retries, bad configuration, state
store problem), 2 a usage error. After exit 1 nothing is kept: the workflow
pushes state only after the sealed outputs were uploaded.

In the pump, an error on one item is logged and nothing is recorded for that
item; the next tick tries again for the items still open. Recording an item
and sealing its outputs are one state transaction, so a decision is never
recorded without its sealed outputs on disk. The dispatch is closed once
every item has a result.

## Ledger interface

[`ledger.mjs`](ledger.mjs) uses two calls of the state store
([`state/db.mjs`](../state/db.mjs), documented in
[docs/INTERFACES.md](../docs/INTERFACES.md)). The pump wraps its open store
with `dbLedger(db)`; the CLI's `--state FILE` opens one with `openLedger()`.

- `getAttempt(attempt_id)` returns the dispatched attempt or nothing:
  `attempt_id`, `repo`, `workflow_file`, optionally `run_id`, `workflow_sha`
  and `canaries` (always empty for now: the pump injects none yet), and
  `items`: `[{index, run_key, fence, current_fence, outcome}]` in dispatch
  order (`outcome` is set once recorded). A JSON row without `items` (for
  `--ledger-json`) may give `run_key`, `fence`, `current_fence` and `outcome`
  at the top level instead; it is read as one item with index 0.
- `recordResult({run_key, attempt_id, fence, outcome, accepted, reason})`
  records one item and returns `{accepted, reason}` after the store's own
  fence check. Calling it again for a recorded item stores nothing and
  returns the first decision.

## Files

| Path | What it is |
|---|---|
| `ingest.mjs` | The steps above (`openAttempt()` and its per-item `judge()`, `ingestAttempt()` for all items) and the command line |
| `collect.mjs` | Ingest inside the pump: finds finished worker runs, judges and records every item, seals, closes dispatches |
| `forgery.mjs` | Identity, file list, foreign-claim and control checks |
| `registry.mjs` | Field registry loader (pinned commit and sha256) and observation checks |
| `redact.mjs` | Redaction rules (secrets, emails, canaries) as pure functions |
| `container.mjs` | Gets the age ciphertext out of a raw or zipped artifact |
| `age.mjs` | age encrypt, decrypt and key checks through the age binaries |
| `github.mjs` | The REST calls: run, run by name, artifact list, artifact download |
| `ledger.mjs` | The attempts ledger: state store or JSON file |
| `testkit.mjs` | Test helpers: synthetic bundles, fake GitHub API and ledger |

Tests: `node --test ingest/`. The age and CLI tests use the real `age` and
`age-keygen` binaries and are skipped (with a note) when they are not on
`PATH`; set `AGE_BIN` and `AGE_KEYGEN_BIN` to point at them.
