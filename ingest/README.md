# ingest

Trusted ingest of worker results. For one attempt it downloads the worker's
encrypted bundle, decrypts it, checks it against what tool-qa dispatched,
decides, and records the decision in the attempts ledger. It never runs
anything from the bundle.

It runs in two places, with the same checks:

- **In the pump** ([`collect.mjs`](collect.mjs)), at the start of every tick:
  for each dispatch still waiting it finds the worker run, judges it once the
  run has finished, records the decision in the pump's open state store, seals
  the outputs, and closes the dispatch. This is the normal path; the pump is
  the only state writer. See [docs/INTERFACES.md](../docs/INTERFACES.md)
  ("Ingest in the pump").
- **By hand** ([`ingest.mjs`](ingest.mjs) command line, run by
  [`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml)) for one
  attempt the pump did not judge, only while the pump is paused. See
  [docs/OPERATIONS.md](../docs/OPERATIONS.md) ("Manual re-ingest").

Trusted: the dispatch (worker repo, attempt id, and the run id the pump found
or the operator gave), the attempts ledger in the state store, and what the
GitHub API says about the run. Untrusted: everything in the artifact,
including the manifest.

Result manifest v1 names one run_key, so ingest handles dispatches of one item
only (`shard_size: 1`); the pump refuses to dispatch for an enabled workflow
with a larger shard, and closes any such dispatch as `unsupported_shard`.

## Steps

1. **Ledger.** The attempt must exist, belong to the given repo (and run, if
   the ledger has the run id) and have no result yet. If the subject's fence
   has moved on, `stale_fence` is recorded at once, without a download.
2. **Run.** The run must be completed, in that repo, from the dispatched
   workflow file, started by `workflow_dispatch` and, if the ledger has the
   commit, at that commit. The worker's own conclusion (success or failure)
   does not matter; the bundle decides.
3. **Artifact.** Exactly one artifact named `result-<attempt>.tar.age` (or
   `result-<attempt>`) from that run, not expired, at most 512 MiB. It is
   downloaded through the API (the token never goes to blob storage) and, if
   GitHub wrapped it in a zip, unwrapped.
4. **Decrypt** with age and the ingest identity (`AGE_IDENTITY`).
5. **Bundle.** A tar of regular files with safe paths, at most 1 GiB, with a
   `manifest.json` that is valid JSON and valid against
   [`manifest.schema.json`](../worker-kit/manifest.schema.json).
6. **Forgery checks** ([`forgery.mjs`](forgery.mjs)): the manifest's identity
   and workflow match the ledger and the run (the run's `head_sha` is the
   workflow commit); the tar holds exactly the listed files with the listed
   sizes and sha256; outside `raw/` nothing names another attempt id, fence or
   run_key; every control passed, and a forgery control's marker is in `raw/`
   and nowhere else.
7. **Field registry** ([`registry.mjs`](registry.mjs)): every observation uses a
   declared, non-deprecated field with a value of the declared type. The
   registry is read from `isokron-ai/mcp-results` at a pinned commit and
   checked against a pinned sha256.
8. **Secret scan** ([`redact.mjs`](redact.mjs)): the manifest and every file
   outside `raw/` are scanned with the redaction rules and the canaries the
   ledger holds for the attempt. Any hit quarantines the bundle. Hits in `raw/`
   are only counted.

The decision is then recorded with `recordResult`. The ledger does its own
fence check; if it refuses an acceptance, the outcome becomes `rejected` with
the ledger's reason.

## Outcomes

| Outcome | Recorded | Outputs |
|---|---|---|
| `accepted` | yes | `accepted/<attempt>/`: `manifest.json`, every bundle file, `ingest.json` |
| `rejected` | yes, except the refusals below | `rejected/<attempt>/`: `ingest.json`, and `result.tar.age` (the ciphertext as uploaded) once it was downloaded |
| `quarantined` | yes | `quarantine/<attempt>/`: `ingest.json`, `result.tar.age` |
| `pending` | no | none; the run is not finished, the pump looks again next tick (by hand: run again later) |
| `already_recorded` | no | none; running again for a recorded attempt is a no-op |

The outputs are packed into one tar and age-encrypted to
`worker-kit/ingest.pub`, so nothing is stored in the clear in CI: the pump
writes `ingest-<attempt>.tar.age` per judged attempt into its outputs directory
(`--ingest-out`, uploaded by `pump.yml` as `ingest-<run id>-<run attempt>`),
the CLI writes `--sealed`. A rejected or quarantined bundle is kept only as
ciphertext.

`ingest.json` is the report: outcome, reason, the ledger row (canaries only as
a count), the run, the artifact (id, name, sizes, sha256 of the download and of
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
| bundle | `bad_bundle` (not a safe tar of regular files), `no_manifest`, `manifest_not_json`, `manifest_invalid` |
| identity | `attempt_mismatch`, `fence_mismatch`, `run_key_mismatch`, `workflow_repo_mismatch`, `workflow_file_mismatch`, `workflow_sha_mismatch`, `run_id_mismatch`, `run_attempt_mismatch` |
| files | `unlisted_file`, `missing_file`, `size_mismatch`, `digest_mismatch` |
| controls and claims | `forgery_control_injected`, `forgery_marker_leaked`, `foreign_identity_claim`, `control_output_in_raw`, `control_failed`, `control_missing`, `forgery_control_unverified` |
| registry | `observation_format`, `undeclared_field`, `deprecated_field`, `field_type` |
| secrets (quarantined) | `secret_scan` |

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

Step outputs: `outcome`, `reason`, `accepted`, `recorded` (`true`/`false`) and
`sealed` (path, empty when there was nothing to write). It prints one line:
`::notice` or `::warning title=ingest::attempt <id>: <outcome> (<reason>)`.
Errors are one `::error` line, with the token and identity cut out.

Exit codes: 0 a decision was made (any outcome, including `pending`), 1 an
operational error (GitHub unreachable after retries, bad configuration, state
store problem), 2 a usage error. After exit 1 nothing is kept: the workflow
pushes state only after the sealed outputs were uploaded.

In the pump, an error on one attempt is logged and nothing is recorded for it;
the next tick tries again. Recording, sealing and closing the dispatch are one
state transaction, so a decision is never recorded without its sealed
outputs on disk.

## Ledger interface

[`ledger.mjs`](ledger.mjs) uses two calls of the state store
([`state/db.mjs`](../state/db.mjs), documented in
[docs/INTERFACES.md](../docs/INTERFACES.md)). The pump wraps its open store
with `dbLedger(db)`; the CLI's `--state FILE` opens one with `openLedger()`.

- `getAttempt(attempt_id)` returns the dispatched attempt or nothing:
  `attempt_id`, `run_key`, `fence`, `repo`, `workflow_file`, and optionally
  `run_id`, `workflow_sha`, `current_fence`, `outcome` (set once recorded) and
  `canaries` (always empty for now: the pump injects none yet).
- `recordResult({run_key, attempt_id, fence, outcome, accepted, reason})`
  returns `{accepted, reason}` after the store's own fence check. Calling it
  again for a recorded attempt stores nothing and returns the first decision.

## Files

| Path | What it is |
|---|---|
| `ingest.mjs` | The steps above (`ingestAttempt()`) and the command line |
| `collect.mjs` | Ingest inside the pump: finds finished worker runs, judges them, records, seals, closes dispatches |
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
