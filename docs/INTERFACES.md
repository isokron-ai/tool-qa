# Interfaces

The contracts between the pump, worker workflows and ingest. Code that sits on
either side of one of these should change only together with this page.

## One writer

The state database (`state.sqlite` on the `state` release) has one writer: the
pump, inside the `pump` concurrency group. Ingest runs inside the pump for that
reason (below). The watchdog downloads a copy to read and never pushes. Only
while the pump is paused (`LANE_PUMP_ENABLED=false`) may anything else push
it: the manual re-ingest workflow (`.github/workflows/ingest.yml`, which
refuses to run while the pump lane is on and waits in the `pump` group), or a
person by hand (docs/OPERATIONS.md).

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

The result format (files, artifact name, encryption, checks) is the worker
contract in [`worker-kit/README.md`](../worker-kit/README.md) and
[`ingest/README.md`](../ingest/README.md): one artifact
`result-<attempt_id>.tar.age` per run, sealed to `worker-kit/ingest.pub`.
Result manifest v1 names exactly one `run_key`, so for now every enabled
workflow needs `shard_size: 1` in `pump/workflows.json`; the pump refuses to
dispatch anything otherwise (see "Ingest in the pump").

How long a dispatch may take: 1.5 × (`setup_minutes` + items ×
`minutes_per_subject`) + 10 minutes, from `pump/workflows.json`. After that its
leases and its slot expire, the pump closes it as `lease_expired`, and the work
is due again. A result that arrives later is stored as rejected.

## Ingest in the pump

Ingest runs inside the pump process, so the pump stays the only writer.
[`pump/run.mjs`](../pump/run.mjs) builds one collector per run with
`createCollector()` from [`ingest/collect.mjs`](../ingest/collect.mjs) and,
at the start of every tick (every 150 seconds, and once in a housekeeping
run), calls:

```js
const summary = await collector.collect({ db, now, log, mintToken, deadline });
```

| Argument | What it is |
|---|---|
| `db` | The open state store (`state/db.mjs`). Ingest uses the calls below and never writes tables directly. |
| `now()` | The current time in ms (tests control it). |
| `log(line)` | Writes a line to the run log, with tokens and `AGE_IDENTITY` removed. |
| `mintToken({ repositories, permissions })` | Mints a GitHub App token. Ingest asks for `{ repositories: ['<worker repo>'], permissions: { actions: 'read' } }` and reuses it until five minutes before it expires. Returns `{ token, expiresAt }`. |
| `deadline` | Time in ms after which ingest starts no new attempt. |

Order inside one pump run:

1. Before the first tick, if the pump has worker slots and any workflow is
   enabled, `collector.check({ workflows })` makes sure results can be judged:
   `worker-kit/ingest.pub` holds a real age key (not the placeholder),
   `AGE_IDENTITY` is set and is the identity of a key in it, and every enabled
   workflow has `shard_size: 1`. It makes no API calls. If it throws
   `IngestSetupError`, the pump logs why, dispatches nothing for the whole run,
   still reaps and pushes, and the run fails. `collect()` repeats the key
   checks whenever there is a dispatch to look at, so a housekeeping run with
   a bad key judges nothing either.
2. Each tick: `collect()`, then the tick itself (reap, then dispatch), then a
   state push if anything changed. So a result judged in a tick is in the state
   before that tick's push.
3. `collect()` is not called within two minutes of the run's end (the
   `deadline` is the run's end minus two minutes, about minute 9 of 11), so the
   last decisions are pushed with the final state.

What `collect()` does, oldest dispatch first, for each dispatch from
`db.dispatchesAwaitingResults()`:

| Situation | What happens |
|---|---|
| No run id yet | Look the run up by its name, `shard <shard_id>`, among `workflow_dispatch` runs of the worker workflow created since two minutes before the dispatch; store it with `db.setDispatchRun()`. None yet: wait. |
| Run not finished, or GitHub does not know it | Wait. A run that never finishes is handled by lease expiry. |
| Run finished | Judge its one result artifact (`ingestAttempt()` in [`ingest/ingest.mjs`](../ingest/ingest.mjs), steps in [`ingest/README.md`](../ingest/README.md)), record the decision with `db.recordResult()`, seal the outputs to `worker-kit/ingest.pub` as `ingest-<attempt_id>.tar.age` in the outputs directory, and close the dispatch as `run_completed` (frees its slot and any lease left). Recording, sealing and closing are one transaction (`db.txAsync()`): if sealing fails, nothing is recorded and a later tick tries again. |
| More than one run_key | Closed as `unsupported_shard` without judging (result manifest v1 holds one run_key). |
| Lease expired before the run finished | Still judged for six hours after the dispatch was closed, at most every ten minutes; the store keeps the late result as rejected. |

It returns a summary: `{ checked, waiting, judged, recorded, closed,
correlated, unsupported, errors, stopped, outcomes, changed }`. `stopped` is
`budget` when the API budget (pump/budgets.mjs; ingest's calls go through the
same budget as the pump's, in the `actions` and `artifacts` families) would
have to wait, `deadline`, or `registry` when the field registry could not be
loaded; the rest waits for the next tick. An error on one attempt is logged,
nothing is recorded for it, and the next tick tries again. Any other error
thrown by `collect()` is logged and the tick goes on; `IngestSetupError` stops
dispatching for the rest of the run. The pump keeps the summary in
`pump.last_tick` (below).

The sealed outputs are uploaded by `pump.yml` at the end of the job as the
artifact `ingest-<run_id>-<run_attempt>` (docs/OPERATIONS.md, "Reading ingest
outputs").

The manual re-ingest workflow (`.github/workflows/ingest.yml`) runs the same
`ingestAttempt()` for one attempt through the command line, while the pump is
paused.

## State calls for ingest

### `db.getAttempt(attemptId)`

What ingest needs to know about a dispatch, or `undefined` if there is no
such attempt: `attempt_id`, `run_key`, `fence`, `subject`, `workflow`, `repo`,
`workflow_file` (a path under `.github/workflows/`), `run_id` (a number, or
`null` until the run is known), `workflow_sha`, `current_fence` (the fence of
the run_key's lease now; a newer one means this attempt is stale), `outcome`
(`null` until a result for this attempt and fence is recorded), `canaries`
(always empty for now: none are injected yet), `status`, `shard_id`, `created`
and `expires`. It throws for a dispatch that carries more than one run_key.
[`ingest/ledger.mjs`](../ingest/ledger.mjs) (`dbLedger()`) adapts it for
ingest.

### `db.dispatchesAwaitingResults({ now, lateMs })` and `db.setDispatchRun(attemptId, { runId, runUrl, workflowSha, correlatedBy })`

The first lists the dispatches ingest should look at: every open one
(`pending` or `dispatched`, expired or not, since ingest runs before the reap)
and those closed as expired within `lateMs` that have a run id and nothing
recorded. The second stores the run found for a dispatch whose run id the
dispatch response did not return; `correlatedBy` says how it was found
(`run-name`).

### `db.txAsync(fn)`

Runs an async `fn` in one write transaction and commits only if it resolves.
Safe only because the pump is the single writer and nothing else uses the
connection meanwhile.

### `db.getDispatch(attemptId)`

The dispatch row with its items, or `undefined`. Fields include `repo`,
`workflow`, `workflow_file`, `ref`, `status` (`pending`, `dispatched`, `done`,
`failed`, `expired`), `run_id`, `run_url`, `workflow_sha` and `expires`. Each
item has `run_key`, `subject`, `fence` and `resolved`. Ingest uses it to check
that a result came from the run the pump started, in the repository and at the
workflow commit it expected.

### `db.recordResult({ run_key, attempt_id, fence, verdict, reason, outcome, digest, now })`

Stores one result after ingest has checked it. `verdict` is `accepted` or
`rejected` (ingest's own decision; ingest passes `accepted: true|false`
instead, which means the same); `reason` says why ingest rejected it.
`outcome` is ingest's outcome (`accepted`, `rejected`, `quarantined`);
`digest` is the sha256 of the stored result.

The store accepts the result only if all of these hold: the attempt exists, it
carries this `run_key` with this `fence`, that item has not reported already,
the fence is the run_key's current live lease, and ingest accepted it. It
returns `{ accepted, reason, id }`. `reason` is `null` when accepted, otherwise
one of the reasons below. An acceptance the store refuses is kept with outcome
`rejected`.

A call for an attempt, run_key and fence that already has a decision stores
nothing and returns the first decision with `duplicate: true`, so judging an
attempt twice (a retried tick, a manual re-ingest) is harmless and never turns
an earlier rejection into an acceptance.

| Reason | Meaning | Counts towards parking the run_key? |
|---|---|---|
| `unknown_attempt` | No such dispatch (for example state was restored from an older copy). | no |
| `unknown_run_key` | The dispatch did not carry this run_key. | no |
| `fence_mismatch` | The fence is not the one sent with this run_key. | no |
| `duplicate_result` | This item is already resolved without a recorded decision for this fence (not expected; repeats of a recorded decision return it with `duplicate: true` instead). | no |
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
| `pump.last_tick` | The last tick's summary: due, planned, dispatched, failed, reaped, why it stopped early; `ingest` (checked, judged, recorded, outcomes, errors, why ingest stopped, or `null` if it did not run) and `blocked` (why nothing may be dispatched this run, or `null`). |
| `pump.last_run` | Start, finish, ticks, dispatched, failed and slot numbers of the last pump run. |
