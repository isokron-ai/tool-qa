# history: official MCP registry capture (H1)

This folder holds the script that records the official MCP registry
(`https://registry.modelcontextprotocol.io/v0.1/servers`) so we have a dated
history of what was listed and when it changed.

## What is captured

- Every server version, not just the latest. `version=latest` is not sent.
- One server version per line, as the registry returned it, in gzipped NDJSON.
- `manifest.json` next to it: source URL, mode, start and finish time (UTC),
  page count, line count, sha256 of the `.ndjson.gz` file, script version, and
  any errors. A malformed page, or a request that still fails after 5 retries,
  is written to `errors` instead of stopping silently. If a malformed page still
  shows a `nextCursor`, paging continues from it.

The script waits 150 ms between pages, retries 429 and 5xx responses with
backoff (up to 5 times), and sends the User-Agent
`isokron-tool-qa/<version> (+https://github.com/isokron-ai/tool-qa)`.

## Cadence

Workflow `.github/workflows/history-registry.yml`:

- Full capture daily at 03:17 UTC.
- Delta capture every 15 minutes, using `updated_since` set to 90 minutes
  before the run. Scheduled runs on GitHub are often late by more than 15
  minutes, so consecutive windows overlap on purpose and a late or skipped run
  leaves no gap. The archive de-duplicates by (name, version, updated_at), so
  the repeated rows do no harm.
- Manual runs from the Actions tab, with a mode input.

Nothing runs unless the repository variable `LOOP_ENABLED` is exactly `true`.
When it is not, the workflow ends green with a one-line notice. The guard
(`scripts/guard.mjs --no-slots`) also honours `LOOP_PAUSE_UNTIL` and
`LANE_HISTORY_REGISTRY_ENABLED`, and ignores `LOOP_SLOTS`.
See [docs/OPERATIONS.md](../docs/OPERATIONS.md).

## Where the data goes

Each run uploads its folder as a workflow artifact, kept for 30 days. A daily
job pulls those artifacts into a private archive. The data itself is not
published from here. Each run also creates a GitHub build-provenance
attestation for `manifest.json` and the `.ndjson.gz` file, and the attestation
is the public record that the file existed at that time and has not changed.

## Run locally

Needs Node 22 or later and network access. No dependencies.

```sh
node history/registry.mjs --mode full --out history-out
node history/registry.mjs --mode delta --since 2026-11-21T00:00:00Z --out history-out
# or keep the window in a state file (advanced only after an error-free run):
node history/registry.mjs --mode delta --state history-out/state.json --out history-out
```

Tests (no network):

```sh
node --test 'history/test/*.test.mjs'
```
