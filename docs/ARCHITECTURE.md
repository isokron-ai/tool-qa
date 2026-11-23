# Architecture

A short overview of how the loop is put together. Status: P0, foundations and
history capture. Nothing scans servers yet.

## Repositories and roles

| Repository | Role | Runs server code? | Secrets |
|---|---|---|---|
| `tool-qa` (this repo) | The orchestrator: history capture, discovery, the due list, leases, the slot ledger, the state store, dispatch to workers, checking and storing results, loop health | No, never | Only what dispatch and storage need, limited to the main branch |
| Our tool repos (`mcp-check`, `mcp-catalog-snap`, `mcp-writecheck-action` and others) | Workers. Each tool runs against servers inside its own repo, as that tool's regression suite. Workflows there are dispatch-only | Yes, in a sandbox | None |
| `mcp-results` | Published data, methodology and corrections (later phase) | No | Deploy hook only |

The orchestrator is trusted and never runs target code. Workers are treated as
untrusted: they get `permissions: {}`, no secrets, and their output is checked
by the orchestrator before it is kept. A worker's own exit status never decides
whether its result is accepted.

## The queue: a computed due list

There is no queue to lose. On each tick the pump computes what is due from the
state store. A subject is due for a workflow when, for example:

- there is no result yet for its current version and our current tool versions;
- something changed (a new release, a new commit, a new advisory);
- one of our tools or checks released a new version;
- its result is older than the maximum age for its tier.

Because "due" is always recomputed from state, a missed run catches up on its
own.

## Leases, fencing and attempts

Before work is sent out, the pump takes a **lease** on the subject. Each lease
carries a **fencing token**: a number drawn from one counter that only ever
grows. A result is accepted only if it carries the fencing token of the
subject's current, live lease. If a worker stalls, its lease expires and a newer
lease (with a higher token) can be granted; when the stale worker finally
reports, its result is rejected as `stale_fence`.

Every result, accepted or rejected, is stored as an **attempt** and never
overwritten, so nothing is lost and late or forged results are visible.

## Slots

Concurrency groups in GitHub Actions only work within one repository, so they
can't cap a budget that spans several. The pump keeps a **slot ledger**
instead: a dispatch first acquires a slot, and the slot is released when the
result is accepted or rejected, or when the lease expires. Outstanding
dispatches count against the budget the same as running jobs.

The budget is at most 15 concurrent loop jobs, and always leaves headroom for
ordinary CI. `LOOP_SLOTS` sets the ceiling (0 to 15) and can drop it at once;
see [OPERATIONS.md](OPERATIONS.md).

## State store

All authoritative state (subjects, runs, leases, slot ledger, attempts) is one
SQLite file, written only by the pump inside a single concurrency group. Between
runs it is kept as the Release asset `state.sqlite` on the release tagged
`state`. Code: [`state/schema.sql`](../state/schema.sql),
[`state/db.mjs`](../state/db.mjs), [`scripts/state-asset.mjs`](../scripts/state-asset.mjs).

It uses Node's built-in `node:sqlite` module (Node 22.13 or newer), so there is
no dependency to install. Ubuntu runners get that Node version through
`actions/setup-node`.

## History capture

Some data can't be collected later: registry entries change, and download
counts are only kept for a limited window. So history capture starts before any
scanning. It takes regular snapshots of the official MCP registry, package feed
logs (npm, PyPI, crates.io, Go) and popularity counts. These snapshots read
public APIs only and never run server code. Each day's manifest is meant to be
timestamped publicly by hash, without publishing the data itself.

History capture lives under `history/` and is added separately from these
foundations.

## Kill switches

Every scheduled or dispatched loop job first runs
[`scripts/guard.mjs`](../scripts/guard.mjs), which reads `LOOP_ENABLED`,
`LOOP_PAUSE_UNTIL`, the job's `LANE_<JOB>_ENABLED` and `LOOP_SLOTS`. A stopped
loop exits green with a notice. See [OPERATIONS.md](OPERATIONS.md).

## Workflow rules

Every workflow is checked on each push and pull request by actionlint, zizmor
and [`scripts/check-workflows.mjs`](../scripts/check-workflows.mjs): top-level
`permissions: {}`, explicit permissions and `timeout-minutes` on every job,
actions pinned to full commit SHAs, no `pull_request_target`, no event data
interpolated into `run:` (that covers `inputs`, `github.head_ref` and step or job
outputs too), no `secrets: inherit` or `write-all`, and `concurrency` on every scheduled workflow.

## Not done yet

- History capture workflows (`history/`).
- The pump, the watchdog and dispatch to worker repos.
- The GitHub App the orchestrator will use for cross-repo work.
- Sandboxed workers, the result contract and its checks.
- Any scanning, and any publishing to `mcp-results`.
- Hourly versioned snapshots of the state asset.
