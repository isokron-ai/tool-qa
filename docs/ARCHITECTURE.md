# Architecture

A short overview of how the loop is put together. Status: P1 in progress. The
pump, dispatch, ingest (inside the pump) and the watchdog are built, and
`worker-kit/ingest.pub` holds the real ingest key. Which worker workflows are
switched on is `enabled` in `pump/workflows.json` (since 25 Nov 2026:
scan-static, live-probe, writecheck, meta-github, meta-registry and
release-diff; scan-deep and build-probe are not built).

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

The tool and probe versions in a run_key are a claim about which code ran, so
they are checked (R-PIN-01, [`pump/pins.mjs`](../pump/pins.mjs)): the pump
sends a lane's own pinned commit to its worker (`tool_sha`), and ingest
refuses a result whose manifest reports other versions, or, on a lane whose
`pin_check` is `enforce`, does not prove them.

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
result is accepted or rejected, when ingest has judged the finished run, or
when the lease expires. Outstanding
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

One tick:

1. Ingest ([`ingest/collect.mjs`](../ingest/collect.mjs), see "Ingest" below):
   judge the results of worker runs that finished and record the decisions.
   Not in the last two minutes of a run, so the last decisions make the final
   push.
2. Reap ([`pump/tick.mjs`](../pump/tick.mjs) from here on): close dispatches
   whose lease expired and free their slots.
3. Compute the due list, cut it into shards (`shard_size` items each, at most
   `slots_max` open per workflow), highest priority first.
4. For each shard while a slot is free: take the slot, take a lease per
   run_key, write the dispatch to the **dispatch ledger** (state tables
   `dispatches` and `dispatch_items`), then send the `workflow_dispatch` and
   record the run it created.
5. Push the state if the tick changed anything.

The dispatch is written before it is sent, so a pump that dies mid-send leaves
a pending dispatch that simply expires. A send GitHub refused (a 4xx) closes
the dispatch and frees its leases and slot at once; so does any failure before
the dispatch request goes out (re-reading the ref, minting the token;
R-CHAOS-08). A dispatch request, or the poll for its run right after, that
failed with a server or network error may have started a run anyway, so that
dispatch stays pending like a send the pump died after: ingest finds the run
by name, or the lease expires (R-CHAOS-05). Tokens for worker repositories are minted
per repository from the loop's GitHub App with `actions: write` only to
dispatch, and `actions: read` only for ingest
([`pump/app-token.mjs`](../pump/app-token.mjs)). The state asset itself is
pushed with the job token, which has `contents: write` on this repository
only. State is pushed after every tick that changed something, and at the end.

With `LOOP_SLOTS=0` a run does one housekeeping tick (ingest, reap), dispatches
nothing and does not start a successor.

## Ingest

A worker's result is a claim until tool-qa has checked it. Ingest runs inside
the pump process, at the start of every tick, so the pump stays the only
writer of the state. For each dispatch still waiting, it looks up the worker
run (by the id the dispatch returned, or by its run name `shard <shard_id>`).
Once the run has finished, it judges every item of the shard on its own: it
downloads the item's result artifact (`result-<attempt_id>-<index>.tar.age`,
one per item, since result manifest v1 holds one run_key), decrypts it with
the ingest identity (`AGE_IDENTITY`), checks it against the dispatch
(identity, fence, workflow file and commit, file list, controls, the field
registry, a secret scan) and records the item's decision with the fence check
of the state store. A missing or bad bundle rejects that item only. Once every
item has a decision, the dispatch is closed, which frees its slot. The
worker's own exit status never decides. The checks are described in
[`ingest/README.md`](../ingest/README.md), the calls between pump, state and
ingest in [INTERFACES.md](INTERFACES.md).

Ingest's outputs for each item (the accepted bundle, or the report and the
ciphertext of a rejected or quarantined one) are age-encrypted to
`worker-kit/ingest.pub` and uploaded by `pump.yml` as one artifact per run, so
nothing is kept in the clear in CI.

Before a run dispatches anything, it checks that results could be judged: a
real key in `worker-kit/ingest.pub` and a matching `AGE_IDENTITY`. Otherwise
it dispatches nothing and fails, so no worker runs whose result would be
lost.

[`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml) is a manual
re-ingest tool for single attempts the pump did not judge. It writes the
state, so it only runs while the pump is paused, and waits in the `pump`
concurrency group.

## API budgets

Every GitHub call made by the pump and the watchdog goes through
[`pump/budgets.mjs`](../pump/budgets.mjs). Calls are grouped into families
(dispatch, actions, artifacts, contents, issues, graphql, search, auth), each
with an hourly and a per-minute cap, and all together stay under 2,500 calls an
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

## Archive of history artifacts and ingest outputs

Workflow artifacts expire (history after 30 days, the sealed ingest outputs
after 90). [`scripts/archive-pull.mjs`](../scripts/archive-pull.mjs)
copies both to a folder on a machine we keep, checks each download against
GitHub's digest and every history file against its manifest's sha256, keeps
ingest outputs age-encrypted with a manifest line per artifact, and never
overwrites or deletes anything there. See [OPERATIONS.md](OPERATIONS.md).

## State store

All authoritative state (subjects, runs, leases, slot ledger, dispatches,
attempts, results) is one SQLite file, written only by the pump inside a
single concurrency group (and by the manual re-ingest while the pump is
paused). Between
runs it is kept as the Release asset `state.sqlite` on the release tagged
`state`. Code: [`state/schema.sql`](../state/schema.sql),
[`state/db.mjs`](../state/db.mjs), [`scripts/state-asset.mjs`](../scripts/state-asset.mjs).
Every hour [`state-snapshot.yml`](../.github/workflows/state-snapshot.yml)
copies that asset, still encrypted, to the release `state-snapshots` (the 24
newest copies, one a day for 14 days and one a week for 8 weeks);
`snapshot/restore.mjs` checks one and puts it back. See
[OPERATIONS.md](OPERATIONS.md), "State snapshots". The asset is the database
gzipped, then encrypted. At the end of each run the pump moves closed history
(dispatches, items, attempts, leases, slots and old run_key generations no
decision reads any more) out of the state into sealed archives it uploads as
artifacts, deleting rows only once their archive reads back
([`state/prune.mjs`](../state/prune.mjs), [`pump/prune.mjs`](../pump/prune.mjs));
see OPERATIONS.md, "State pruning and size".

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

## Drift signals (longitudinal)

`longitudinal/derive.mjs` compares each subject's successive accepted results,
read from the archive (still encrypted there; decrypted in memory on the
operator's machine), and derives three signals: a force-pushed version tag
(`git_tag_moves`, from meta-github's `git_tag_targets`), an image tag that
resolves to a new digest (`oci_tag_moves`, from meta-registry's
`oci_tag_digests`), and a tool list that changes at an unchanged release
(`catalog_drift_same_version`, from live-probe and scan-static). It is a
separate step, not part of ingest: ingest keeps no observation history in the
state store, and the archive is the only complete history. See
[`longitudinal/README.md`](../longitudinal/README.md).

## Not done yet

- The scan-deep and build-probe workers. They are switched off in
  `pump/workflows.json` until they exist.
- Canaries. Ingest scans for the canaries of an attempt, but the pump does not
  inject any yet, so that list is always empty.
- Ingest outputs are uploaded at the end of the pump job, after the state was
  pushed. A job lost before the upload keeps its decisions but loses their
  outputs.
- Counting other running jobs (`nonLoopRunning` in the slot formula is 0).
- Sandboxed workers.
- Any scanning, and switching on the publishing to `mcp-results` (built, off: [PUBLISHING.md](PUBLISHING.md)).
- Hourly versioned snapshots of the state asset.
