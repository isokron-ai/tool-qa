# Interfaces

The contracts between the pump, worker workflows and ingest. Code that sits on
either side of one of these should change only together with this page.

## One writer

The state database (`state.sqlite` on the `state` release) has one writer: the
pump, inside the `pump` concurrency group. Nothing else pushes it. Ingest runs
inside the pump for that reason (below). The watchdog downloads a copy to read
and never pushes. A person may pull and push by hand (docs/OPERATIONS.md) only
while the pump is stopped.

## Worker dispatch

The pump starts a worker with a `workflow_dispatch` on the workflow named in
`pump/workflows.json` (`repo`, `file`, `ref`). Every worker workflow takes these
inputs, all strings:

| Input | Meaning |
|---|---|
| `shard_id` | The shard's id, such as `scan-static-3f2a9c01b7d4`. Unique per dispatch. |
| `attempt_id` | The dispatch's id in the state store. Results must quote it. |
| `items` | JSON array, one entry per piece of work: `[{"subject": "...", "run_key": "<64 hex>", "fence": 17}, ...]`. At most 60,000 characters. |

A worker workflow must:

- set `run-name: shard ${{ inputs.shard_id }}`. When GitHub does not return the
  new run's id in the dispatch response, the pump finds the run by that name;
- have `workflow_dispatch` as its only trigger, `permissions: {}` and no
  secrets, like every worker;
- pass the inputs to its steps through `env:`, never by writing
  `${{ inputs.* }}` inside `run:`;
- report one result per item, quoting `run_key`, `attempt_id` and `fence`
  exactly as given. A result for anything else is rejected.

The result format itself (files, artifact name, checks) is defined with the
worker contract in a later phase.

How long a dispatch may take: 1.5 × (`setup_minutes` + items ×
`minutes_per_subject`) + 10 minutes, from `pump/workflows.json`. After that its
leases and its slot expire, the pump closes it as `lease_expired`, and the work
is due again. A result that arrives later is stored as rejected.

## Ingest hook

If `ingest/collect.mjs` exists and exports `collect`, the pump calls it at the
start of every tick (every 150 seconds while a pump run is going, and once in a
housekeeping run):

```js
export async function collect({ db, now, log, mintToken }) { ... }
```

| Argument | What it is |
|---|---|
| `db` | The open state store (`state/db.mjs`). Use the calls below; don't write tables directly. |
| `now()` | The current time in ms. Use it instead of `Date.now()` so tests can control time. |
| `log(line)` | Writes a line to the run log, with tokens removed. |
| `mintToken({ repositories, permissions })` | Mints a GitHub App token, for example `{ repositories: ['mcp-check'], permissions: { actions: 'read' } }`. Ask for the least you need. Returns `{ token, expiresAt }`. |

An error thrown by `collect` is logged and the tick goes on. Ingest should do
a bounded amount of work per call and pick up where it stopped next time;
anything it has not recorded is simply still open.

This is a proposal until ingest exists: the pump already calls the hook, and
nothing else depends on its shape yet.

## State calls for ingest

### `db.getDispatch(attemptId)`

The dispatch row with its items, or `undefined`. Fields include `repo`,
`workflow`, `workflow_file`, `ref`, `status` (`pending`, `dispatched`, `done`,
`failed`, `expired`), `run_id`, `run_url`, `workflow_sha` and `expires`. Each
item has `run_key`, `subject`, `fence` and `resolved`. Ingest uses it to check
that a result came from the run the pump started, in the repository and at the
workflow commit it expected.

### `db.recordResult({ run_key, attempt_id, fence, verdict, reason, outcome, digest, now })`

Stores one result after ingest has checked it. `verdict` is `accepted` or
`rejected` (ingest's own decision); `reason` says why ingest rejected it.
`outcome` is a short label of what the worker found; `digest` is the sha256 of
the stored result.

The store accepts the result only if all of these hold: the attempt exists, it
carries this `run_key` with this `fence`, that item has not reported already,
the fence is the run_key's current live lease, and ingest accepted it. It
returns `{ accepted, reason, id }`. `reason` is `null` when accepted, otherwise
one of:

| Reason | Meaning | Counts towards parking the run_key? |
|---|---|---|
| `unknown_attempt` | No such dispatch (for example state was restored from an older copy). | no |
| `unknown_run_key` | The dispatch did not carry this run_key. | no |
| `fence_mismatch` | The fence is not the one sent with this run_key. | no |
| `duplicate_result` | This item already reported. | no |
| `stale_fence` | A newer lease exists; the work was sent out again. | no |
| `lease_expired`, `lease_released`, `no_lease`, `unknown_fence`, `holder_mismatch` | The lease is not live any more. | yes |
| ingest's `reason`, or `rejected_by_ingest` | Ingest rejected the result. | yes |

Every call is kept as an attempt, accepted or not; a rejected result never
overwrites an accepted one. When the attempt is current, its lease is released.
When the last item of a dispatch reports, the dispatch is closed as
`results_in` and its slot is freed. A run_key with `max_rejections`
(`pump/tiers.json`) counted rejections since its last accepted result is
parked: it is not due again until its run_key changes (a new version of the
subject, or of our tools or settings).

### `releaseOnResult(db, attemptId, { reason, now })` (`pump/slots.mjs`)

Call it when a worker run has finished but did not report every item (it
failed, was cancelled, or lost some results), after recording the results it
did produce. It closes the dispatch with `reason`, frees its slot and releases
the leases of the items that did not report, so they are due again at once
instead of after the lease expires. It wraps `db.closeDispatch()` and returns
`false` if the dispatch was not open.

## Keys the pump keeps in `kv`

| Key | Value |
|---|---|
| `pump.successor` | `{ ok, at, ref, runId?, error? }` from `pump/successor.mjs` for the current run. The watchdog reports `ok: false` as red. |
| `pump.last_tick` | The last tick's summary: due, planned, dispatched, failed, reaped, why it stopped early. |
| `pump.last_run` | Start, finish, ticks, dispatched, failed and slot numbers of the last pump run. |
