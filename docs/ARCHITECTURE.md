# Architecture

A short overview of how the loop is put together. Status: P1 in progress. The
pump, dispatch and the watchdog are built; every worker workflow is still
switched off (`enabled: false` in `pump/workflows.json`), so nothing scans
servers yet.

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

What is due is decided per (subject, workflow) pair by
[`pump/due.mjs`](../pump/due.mjs), with the rules per tier in
[`pump/tiers.json`](../pump/tiers.json) and the worker workflows in
[`pump/workflows.json`](../pump/workflows.json). Each piece of work has a
**run_key**: the sha256 of a canonical JSON of everything that should give the
same result if nothing changed (the subject, its commit SHA or artifact
digest, the workflow, our tool, oracle and probe versions, the sandbox image
digest and the settings). A pair is due when there is no accepted result for
its current run_key, when a change event arrived after its last result, or when
that result is older than the tier allows. Pairs already in flight, on a
disabled workflow, or whose run_key was rejected too often are left out. The
list is sorted by tier weight plus reason and age points.

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

The account runs at most 20 jobs at once. In [`pump/slots.mjs`](../pump/slots.mjs):

```
loopBudget  = max(1, min(15, 20 - nonLoopRunning - 2))
workerSlots = min(LOOP_SLOTS, loopBudget - 1)
```

The pump's own job is the `- 1`. `nonLoopRunning` is taken as 0 for now (the
pump does not count other running jobs yet), so `LOOP_SLOTS=15` means 14
workers plus the pump. A slot row expires with its dispatch's lease, and every
tick reaps expired rows.

## The pump

[`.github/workflows/pump.yml`](../.github/workflows/pump.yml) runs
[`pump/run.mjs`](../pump/run.mjs). A run pulls the state asset, then ticks every
150 seconds for about 11 minutes, then pushes the state back. Each run first
dispatches the next one ([`pump/successor.mjs`](../pump/successor.mjs)), which
waits in the `pump` concurrency group, so runs follow each other back to back.
A schedule every 30 minutes restarts the chain if it breaks.

One tick ([`pump/tick.mjs`](../pump/tick.mjs)):

1. Run the ingest hook if there is one ([INTERFACES.md](INTERFACES.md)).
2. Reap: close dispatches whose lease expired and free their slots.
3. Compute the due list, cut it into shards (`shard_size` items each, at most
   `slots_max` open per workflow), highest priority first.
4. For each shard while a slot is free: take the slot, take a lease per
   run_key, write the dispatch to the **dispatch ledger** (state tables
   `dispatches` and `dispatch_items`), then send the `workflow_dispatch` and
   record the run it created.

The dispatch is written before it is sent, so a pump that dies mid-send leaves
a pending dispatch that simply expires. A failed send closes the dispatch and
frees its leases and slot at once. Tokens for worker repositories are minted
per repository from the loop's GitHub App with `actions: write` only
([`pump/app-token.mjs`](../pump/app-token.mjs)). The state asset itself is
pushed with the job token, which has `contents: write` on this repository
only. State is pushed after every tick that changed something, and at the end.

With `LOOP_SLOTS=0` a run does one housekeeping tick (reap, ingest), dispatches
nothing and does not start a successor.

## API budgets

Every GitHub call made by the pump and the watchdog goes through
[`pump/budgets.mjs`](../pump/budgets.mjs). Calls are grouped into families
(dispatch, actions, artifacts, contents, issues, graphql, search, auth), each
with an hourly and a per-minute cap, and all together stay under 1,500 calls an
hour. Dispatches are spaced 1 to 2 seconds apart. The budget honours
`retry-after`, backs off at least a minute on a secondary rate limit (longer if
it repeats), waits for the reset when a primary limit is spent, and keeps a
reserve for the calls that update the health issue. A wait longer than two
minutes ends the tick early instead; the next tick carries on.

## The watchdog

[`.github/workflows/watchdog.yml`](../.github/workflows/watchdog.yml) runs
[`watchdog/run.mjs`](../watchdog/run.mjs) four times an hour. It reads the
workflow list, recent loop runs, recent artifacts and a copy of the state, and
checks ([`watchdog/checks.mjs`](../watchdog/checks.mjs)):

- that a pump run started in the last 20 minutes (if not, it dispatches one);
- that each history capture produced a recent artifact;
- that no slot row or dispatch is more than 15 minutes past its expiry (that
  would mean the pump is not reaping);
- that the pump could dispatch its successor;
- that the latest scheduled or dispatched run of each loop workflow did not
  fail;
- that GitHub has not disabled a loop workflow for inactivity (if it has, the
  watchdog turns it back on).

It writes the result to one pinned issue, "Loop health"
([`watchdog/health.mjs`](../watchdog/health.mjs)), rewriting the body in place
and commenting only when the overall status turns red or recovers.

## Archive of history artifacts

Workflow artifacts expire after 30 days. [`scripts/archive-pull.mjs`](../scripts/archive-pull.mjs)
copies the history artifacts to a folder on a machine we keep, checks every
file against its manifest's sha256, and never overwrites or deletes anything
there. See [OPERATIONS.md](OPERATIONS.md).

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

- Worker workflows in the tool repos. All are switched off in
  `pump/workflows.json` until they exist.
- Wiring ingest to the state store and the pump: the result contract and its
  checks are in `worker-kit/` and `ingest/`, and the pump is the single state writer.
- Counting other running jobs (`nonLoopRunning` in the slot formula is 0).
- Sandboxed workers.
- Any scanning, and any publishing to `mcp-results`.
- Hourly versioned snapshots of the state asset.
