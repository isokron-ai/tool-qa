# worker-kit

What a worker job uses to hand its results back to tool-qa: the result
contract, a composite action that builds, encrypts and uploads a bundle, and
the public key bundles are encrypted to. A worker hands back one bundle per
item it was dispatched.

A worker runs untrusted server code. So the bundle is only a claim: tool-qa's
ingest (see [`../ingest/README.md`](../ingest/README.md)) checks every part of it
against what was dispatched before anything is kept.

## Running untrusted servers

Run the server under test without the runner's environment, and never in
the job that uploads results. GitHub gives every job of a run an
`ACTIONS_RUNTIME_TOKEN` (and `ACTIONS_RESULTS_URL`) that can upload artifacts
to that run. Code that can read it can upload, or replace, the result
artifact of any item of the shard, with the right name and the run's real
identity, and ingest could not tell. So:

- start the server inside the sandbox with an empty environment, never as a
  plain step of the job (a step inherits the runner's environment, and the
  runner's files and processes are within reach of anything it runs);
- build, encrypt and upload results in a job that never runs untrusted code,
  or in steps that only start after every untrusted process has ended and
  the sandbox is gone;
- never pass `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_*`,
  `GITHUB_TOKEN` or any secret into the sandbox.

Ingest's identity, file and claim checks catch a careless forgery, not one
made with the upload token, so this rule is what keeps one item's server
from forging a sibling item's result.

## Files

| Path | What it is |
|---|---|
| `manifest.schema.json` | JSON Schema of `manifest.json` (schema version 1) |
| `contract.mjs` | Bundle layout, manifest builder and validator, artifact names |
| `tar.mjs` | Deterministic tar writer and a strict reader (regular files only, safe paths) |
| `build-bundle.mjs` | Builds `manifest.json` and the tar from one item's bundle directory |
| `install-age.sh` | Installs `age` and `age-keygen` (pinned version, sha256 checked; Linux) |
| `action.yml` | Composite action: build, encrypt with age, upload as a 3-day artifact |
| `ingest.pub` | The age public key bundles are encrypted to |

## Bundle layout

For each item, the worker writes that item's files into one directory:

| Directory | Holds | How ingest treats it |
|---|---|---|
| `observations/` | `*.ndjson` field records, one JSON object per line: `{"field": "<registry id>", "value": ..., "why"?: "...", "stage"?: "..."}` | Every field must be declared in the field registry, not deprecated, with a value of the declared type. A `null` value needs `why`. |
| `results/` | Our tools' own reports | Checked for foreign attempt identities and secrets |
| `controls/` | What the pipeline produced for the shard's control targets | As `results/`, plus the control checks below |
| `raw/` | Captured target bytes | Data only: never read as a claim, never scanned into a decision (secret hits are counted) |
| `logs/` | Our tools' logs | As `results/` |

File names may use letters, digits, `.`, `_` and `-`; no other top-level
directories, links or empty names. `manifest.json` is added by the kit.

## The meta file

`meta-file` is a JSON file the worker writes for each item before calling the
action for it:

```json
{
  "subject": { "id": "io.example/demo", "repo": "example/demo", "sha": "<40 hex or null>" },
  "tools": [{ "name": "mcp-check", "version": "0.1.0" }],
  "oracles": [],
  "settings_manifest_digest": "<sha256 hex of the settings used>",
  "started_at": "2026-01-01T00:00:00Z",
  "finished_at": "2026-01-01T00:05:00Z",
  "skips": [{ "stage": "start", "reason": "timeout_start", "fault": "subject", "evidence": "logs/start.log" }],
  "controls": [
    { "kind": "forgery", "expected": "contained", "observed": "contained",
      "output": "controls/forgery.json", "marker": "<marker the forgery target prints>" }
  ]
}
```

- `finished_at` is optional (the build time is used).
- `skips[].reason` is one of the codes in `contract.mjs` (`SKIP_REASONS`). A
  stage that did not run is recorded, never left out. Use `rate_limited` when
  a rate limit stopped it (GitHub, a package registry) and
  `upstream_unavailable` when an upstream timed out or answered 5xx; don't
  borrow another code, since the codes feed the coverage counts.
- **Our own limits have their own codes** (R-COV-01): `unsupported_language`
  (our reader does not read the language), `unsupported_layout` (several
  servers in one repository, a monorepo), `reader_limit` (the reader stopped
  short: file limits, names without schemas, an idiom it does not follow),
  `no_tools_found` (no tool registration found; ours unless the worker can
  show the subject is not a server), `too_large` (over one of our size caps)
  and `tool_error` (our reader, grader or bundle builder failed). Never record
  one of these under `no_runnable_artifact` or `policy_excluded`.
- `skips[].fault` (optional) says who the skip is down to: `tool` (our tools),
  `subject` (the server itself: gone, empty, needs credentials, its build
  fails), `infra` (a rate limit, an outage) or `policy` (we chose not to run
  it). Each reason allows only some faults (`SKIP_FAULTS` in `contract.mjs`):
  our own limits only `tool`, so none can be put down to the server; a fault
  the reason does not allow makes the manifest invalid. Without `fault`,
  ingest records the reason's default from the same map, and `unknown` for a
  reason that has no single fault (`no_runnable_artifact`, `timeout_start`,
  `install_failed_registry`). Set it on every skip.

  | Reason | Recorded without `fault` | May declare |
  |---|---|---|
  | `remote_only` | subject | subject, policy |
  | `no_runnable_artifact` | unknown | subject, tool, policy |
  | `unsupported_transport` | tool | tool, subject |
  | `build_failed_upstream` | subject | subject, tool, infra |
  | `install_failed_registry` | unknown | subject, tool, infra |
  | `start_requires_credentials` | subject | subject |
  | `no_local_backend` | subject | subject, tool |
  | `heavy_backend`, `cluster_member`, `quarantined`, `lane_disabled`, `policy_excluded` | policy | policy |
  | `timeout_start` | unknown | subject, tool, infra |
  | `trace_unavailable` | tool | tool, infra |
  | `bridge_required` | tool | tool |
  | `rate_limited` | infra | infra |
  | `upstream_unavailable` | infra | infra, subject, tool |
  | `unsupported_language`, `unsupported_layout`, `reader_limit`, `too_large`, `tool_error` | tool | tool |
  | `no_tools_found` | tool | tool, subject |

  Ingest stores the result's fault (the first of tool, unknown, infra,
  subject, policy among its skips, so our limits are never hidden behind
  another skip) and its coverage state: `assessed` (no skip),
  `unassessed_tool`, `unassessed_unknown`, `unassessed_infra`, `subject` or
  `excluded` (policy only). A tool-fault skip is never `excluded` and never
  counts as the server's failure. `fault` is optional so that workers pinned
  to an older kit keep working; an older kit refuses a manifest that has it,
  so set it only after moving the pin.
- `skips[].retryable` (optional, `true` or `false`, default `false`) says the
  stage did not run for a passing reason and may succeed later. Mark it per
  skip; it usually goes with `rate_limited` or `upstream_unavailable`. When
  **every** skip of an item's bundle is retryable (and the bundle is
  otherwise valid), ingest records the item as rejected `retry_later`: its
  lease and slot are freed and the pump sends it out again after a backoff
  (30, 60, then 120 minutes, `retry_backoff_minutes` in `pump/tiers.json`).
  After three `retry_later` decisions for the same run_key, the next such
  bundle is accepted with its skips. When every skip is `rate_limited` or
  `upstream_unavailable` from a stage the lane lists in `throttle_stages`
  (`pump/workflows.json`), the item is rejected as `retry_throttled` instead:
  those do not count towards the three, and the item is sent out again
  (backoff capped at 6 hours) for up to 7 days after its first throttled
  retry. A bundle with at least one skip that is not retryable is judged as
  before.
- **Name the stage honestly.** Give a skip the stage that failed. Report a
  rate limit or outage of a third party (a registry, a search API, GitHub's
  shared token budget) under that third party's own stage, which the lane can
  declare as throttling. Report a failure of the subject itself (its own
  fetch timing out, a server under test that hangs, crashes or answers 5xx)
  under the subject's own stage (for example `fetch` or `probe`), which is
  never declared, so it uses the counted retries and cannot keep itself out
  of them. If the stage cannot tell the two apart, treat it as the subject's.
- `controls[].kind` is `known_good`, `known_bad`, `malicious`,
  `protocol_variant` or `forgery`; `expected` and `observed` are short labels
  such as `contained` (lower case letters, digits, `_`). Ingest rejects the bundle unless every
  control has `observed` equal to `expected`, and unless the bundle carries at
  least one control. Each item's bundle is judged on its own, so each needs its
  own controls.
- A `forgery` control needs `output` (outside `raw/`). Its target tries to
  forge a result: it prints an envelope with another attempt's identity and
  the `marker`. Ingest checks that the marker shows up in `raw/` (the target
  really ran) and nowhere else, and that the control output holds no envelope.

The attempt identity (attempt id, and the item's fence and run_key) comes from
the dispatch inputs, and the workflow identity (repo, file, commit, run id, run attempt) from
the runner's own `GITHUB_*` variables; the meta file can't set either.

## Using the action

```yaml
on:
  workflow_dispatch:
    inputs:
      shard_id: { type: string, required: true }
      attempt_id: { type: string, required: true }
      items: { type: string, required: true }

run-name: shard ${{ inputs.shard_id }}

permissions: {}

jobs:
  qa:
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    permissions: {}
    steps:
      # ... run the tool for every item, write out/<i>/bundle/ and out/<i>/meta.json ...
      # One call per item; this is item 0. Repeat with 1, 2, ... for the others.
      - uses: isokron-ai/tool-qa/worker-kit@<40-char commit sha> # <tag or branch>
        with:
          bundle-dir: out/0/bundle
          meta-file: out/0/meta.json
          attempt-id: ${{ inputs.attempt_id }}
          item-index: 0
          fence: ${{ fromJSON(inputs.items)[0].fence }}
          run-key: ${{ fromJSON(inputs.items)[0].run_key }}
```

The inputs are the ones the pump sends ([docs/INTERFACES.md](../docs/INTERFACES.md),
"Worker dispatch"). `items` is a JSON list of one to `shard_size` entries
`{subject, run_key, fence}`. The worker builds one bundle per item and calls
the action once per item with that item's 0-based position in `items` as
`item-index` and that item's `fence` and `run-key`. Each item is judged on its
own: a missing or bad bundle for one item rejects that item only. The
`run-name` lets the pump find the run when the dispatch response does not
name it.

The job needs no secrets and no token permissions. Each call of the action:

1. builds `manifest.json` (sha256 and size of every file) and a tar;
2. installs age and encrypts the tar to `ingest.pub` at the pinned commit (or
   to the `recipient` input);
3. uploads only the ciphertext as the artifact
   `result-<attempt-id>-<item-index>.tar.age` (no zip wrapper, kept 3 days),
   and deletes the plaintext tar.

Ingest still accepts the older name `result-<attempt-id>.tar.age` (no index)
for a dispatch that carried exactly one item, so a one-item worker built
before item indexes keeps working. For more than one item, only the indexed
names count.

`dry-run: 'true'` builds and checks the bundle without encrypting or uploading.
Outputs: `artifact-name`, `manifest-sha256` and, for a dry run, `bundle-path`.

The worker workflow must be started by `workflow_dispatch` from tool-qa, with
the file name and commit the dispatch recorded; ingest rejects runs from any
other event, file or commit.

## Limits

| What | Limit |
|---|---|
| One file in a bundle (`manifest.json` included) | 8 MiB |
| Bundle tar, before encryption | 64 MiB per item |
| Artifact (ciphertext) | 65 MiB per item |
| `item-index` | 0 to 9,999 |
| Files in a bundle | 10,000 (manifest schema) |
| Path length | 240 characters |
| Controls, skips | 20 controls, 1,000 skips |

The size caps are in [`contract.mjs`](contract.mjs) (`MAX_FILE_BYTES`,
`MAX_BUNDLE_BYTES`, `MAX_ARTIFACT_BYTES`). `build-bundle.mjs` refuses to
build past them, and ingest rejects a bundle past them (`file_too_large`,
`bundle_too_large`, `artifact_too_large`). Ingest judges every bundle inside
a pump tick on one CPU, so the caps keep each item to seconds of work.
Truncate captured target output in `raw/` to fit (and record that it was
truncated) rather than dropping it.
