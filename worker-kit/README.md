# worker-kit

What a worker job uses to hand its results back to tool-qa: the result
contract, a composite action that builds, encrypts and uploads the bundle, and
the public key bundles are encrypted to.

A worker runs untrusted server code. So the bundle is only a claim: tool-qa's
ingest (see [`../ingest/README.md`](../ingest/README.md)) checks every part of it
against what was dispatched before anything is kept.

## Files

| Path | What it is |
|---|---|
| `manifest.schema.json` | JSON Schema of `manifest.json` (schema version 1) |
| `contract.mjs` | Bundle layout, manifest builder and validator, artifact name |
| `tar.mjs` | Deterministic tar writer and a strict reader (regular files only, safe paths) |
| `build-bundle.mjs` | Builds `manifest.json` and the tar from a bundle directory |
| `install-age.sh` | Installs `age` and `age-keygen` (pinned version, sha256 checked; Linux) |
| `action.yml` | Composite action: build, encrypt with age, upload as a 3-day artifact |
| `ingest.pub` | The age public key bundles are encrypted to |

## Bundle layout

The worker writes its files into one directory:

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

`meta-file` is a JSON file the worker writes before calling the action:

```json
{
  "subject": { "id": "io.example/demo", "repo": "example/demo", "sha": "<40 hex or null>" },
  "tools": [{ "name": "mcp-check", "version": "0.1.0" }],
  "oracles": [],
  "settings_manifest_digest": "<sha256 hex of the settings used>",
  "started_at": "2026-01-01T00:00:00Z",
  "finished_at": "2026-01-01T00:05:00Z",
  "skips": [{ "stage": "start", "reason": "timeout_start", "evidence": "logs/start.log" }],
  "controls": [
    { "kind": "forgery", "expected": "contained", "observed": "contained",
      "output": "controls/forgery.json", "marker": "<marker the forgery target prints>" }
  ]
}
```

- `finished_at` is optional (the build time is used).
- `skips[].reason` is one of the codes in `contract.mjs` (`SKIP_REASONS`). A
  stage that did not run is recorded, never left out.
- `controls[].kind` is `known_good`, `known_bad`, `malicious`,
  `protocol_variant` or `forgery`; `expected` and `observed` are short labels
  such as `contained` (lower case letters, digits, `_`). Ingest rejects the bundle unless every
  control has `observed` equal to `expected`, and unless the bundle carries at
  least one control.
- A `forgery` control needs `output` (outside `raw/`). Its target tries to
  forge a result: it prints an envelope with another attempt's identity and
  the `marker`. Ingest checks that the marker shows up in `raw/` (the target
  really ran) and nowhere else, and that the control output holds no envelope.

The attempt identity (attempt id, fence, run_key) comes from the dispatch
inputs, and the workflow identity (repo, file, commit, run id, run attempt) from
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
      # ... run the tool, write out/bundle/ and out/meta.json ...
      - uses: isokron-ai/tool-qa/worker-kit@<40-char commit sha> # <tag or branch>
        with:
          bundle-dir: out/bundle
          meta-file: out/meta.json
          attempt-id: ${{ inputs.attempt_id }}
          fence: ${{ fromJSON(inputs.items)[0].fence }}
          run-key: ${{ fromJSON(inputs.items)[0].run_key }}
```

The inputs are the ones the pump sends ([docs/INTERFACES.md](../docs/INTERFACES.md),
"Worker dispatch"). Result manifest v1 holds one run_key, so workers are
dispatched with `shard_size: 1` and `items` holds exactly one entry. The
`run-name` lets the pump find the run when the dispatch response does not
name it.

The job needs no secrets and no token permissions. The action:

1. builds `manifest.json` (sha256 and size of every file) and a tar;
2. installs age and encrypts the tar to `ingest.pub` at the pinned commit (or
   to the `recipient` input);
3. uploads only the ciphertext as the artifact `result-<attempt-id>.tar.age`
   (no zip wrapper, kept 3 days), and deletes the plaintext tar.

`dry-run: 'true'` builds and checks the bundle without encrypting or uploading.
Outputs: `artifact-name`, `manifest-sha256` and, for a dry run, `bundle-path`.

The worker workflow must be started by `workflow_dispatch` from tool-qa, with
the file name and commit the dispatch recorded; ingest rejects runs from any
other event, file or commit.

## Limits

| What | Limit |
|---|---|
| Artifact (ciphertext) | 512 MiB |
| Bundle content after decryption | 1 GiB |
| Files in a bundle | 10,000 (manifest schema) |
| Path length | 240 characters |
| Controls, skips | 20 controls, 1,000 skips |
