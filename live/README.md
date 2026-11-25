# live/: the public loop snapshot

The pump publishes what the loop is doing to `live.isokron.ai` (the uploader
and its switch are in `pump/run.mjs` and `live/r2.mjs`). Everything it
publishes is built here, by one pure function, from an allowlist:

```js
import { buildLiveSnapshot } from './live/build.mjs';
const { snapshot, hourEvents, previousHourEvents, problems } = buildLiveSnapshot(db, { now, config, retry, version });
// problems non-empty: upload nothing.
// hourEvents: the file of the current UTC hour.
// previousHourEvents: the file of the hour before, while the current hour is
//   under 300 s old (write it again then, so the last minutes land); else null.
```

- `now`: epoch milliseconds (a `Date` or an ISO string also works). Nothing
  reads the clock, so the same state and `now` give the same bytes.
- `config`: `pump/workflows.json` plus `switches` (`LOOP_ENABLED`,
  `LOOP_PAUSE_UNTIL`, `LOOP_SLOTS`, `RESULTS_PUBLISH_ENABLED`,
  `LANE_HISTORY_*_ENABLED`), and optionally `history`
  (`[{kind, last_capture_at, versions, registry_size}]`), `lane_notes`
  (`{lane: key of LANE_NOTES | null}`) and `not_built_lanes` (default
  `["scan-deep", "build-probe"]`).
- `retry`: the open retry, `{call, status, attempt, of, next_at, since}`, or
  null. `call` is `github_api`, `state_asset` or `app_token`.
- `version`: a short label of the code (a commit), or null.

| File | What it does |
|---|---|
| `build.mjs` | the snapshot (`isokron-loop-live/1`), the hour files, `toPublicEvent(row)` |
| `classes.mjs` | raw rejection reason → `lease`, `integrity`, `worker_output`, `infra` (unknown → `worker_output`); a quarantine counts as `integrity` |
| `scan.mjs` | `scanPublic(value)`: the secret scan (`ingest/redact.mjs`) and the vendor-name scan over every string and key; hits are `{rule, path}` only |
| `vendor-names.mjs` | the vendor, model and client name scanner (word list kept split in source, as R-PUB-08 does) |

The builder reads `events`, `results`, `dispatches`, `dispatch_items` (counted
only), `slot_ledger`, `subjects` and `kv`, never `attempts`, `leases`,
`run_keys`, any digest, fence, holder, error or batch name column, or any
bundle. Every statement it runs is checked against that list.

## The snapshot

| Field | Content |
|---|---|
| `schema`, `seq`, `generated_at`, `version` | `isokron-loop-live/1`; `seq` is `generated_at` in whole seconds |
| `mode`, `mode_reason` | `live` "scanning live"; `idle` "scanning paused by us" or "every scanning lane is off"; `paused` "loop paused by us"; `off` "loop switched off by us"; `waiting` "waiting for the sandbox self-test" (every enabled lane waits for it); `retrying` "retrying: a GitHub call" / "retrying: saving the loop state" / "retrying: getting an access token" |
| `pump` | `run_started_at`, `tick_at`, `tick_s` (150), `runs_24h`, `successor {state: ok/failed, at}`, `slots {budget, open, max: 15, ramp}`, `registry_delta {at, w24h}` |
| `retry` | null or `{call, status, attempt, of, next_at, since}` |
| `breaker` | null or `{state: closed / waiting_sandbox_check, checked_at, lanes}` |
| `lanes[]` | `id`, `state` (`on`, `off`, `not_built`, `waiting_sandbox_check`), `tool`, `pin`, `note`, `w1h`, `w24h`, `spark24[24]` (accepted results per hour), `fault {subject, tool, infra, policy, unknown}` (24 h), `ring {accepted}` (24 h), `ring_daily {not_used, lease, integrity, worker_output, infra}`, `t0_w24h`; numbers null for a lane not built |
| `history[]` | `registry-delta {state, last_capture_at, versions}`, `registry-full {state, last_capture_at, registry_size, full_at}`, `packages`, `popularity` `{state, last_capture_at}` |
| `edges[]` | `{from, to, w1h, w24h, w7d}`: pump → lane (items sent), lane → ingest (items of batches that ended), pump → history (deltas) |
| `publish` | `{state: on/off}` |
| `counts` | `subjects_in_seed`, `checked {w24h, w7d, all}`, `assessed {w24h, all}` |
| `now_checking[]` | per lane with batches out: `{lane, batches_out, items_out, since_oldest}`; no server names |
| `just_checked` | `{hour, results: [{subject, lane, side}]}`: the named results of the last complete hour, sorted by name, at most 20 |
| `recent[]` | the 20 newest public events that name no server, newest first |

`ring_daily` is the previous complete UTC day: `not_used` (results that came
back and were not used, for any reason) is null below 5; the four classes are
all null unless every one of them is 5 or more, so no class can be worked out
from the others and the total.

Lane notes are fixed wordings (`LANE_NOTES`): by default "not built yet" for a
lane not built and "off" for a lane that is off; `config.lane_notes` can pick
another key ("built, switching on next", "most servers skipped: npm and PyPI
only for now", "re-checking every server after a fix to our PyPI launcher") or
null. Config never carries the text.

When the snapshot would reach 20 KB, `recent` and then `just_checked` are
shortened; only if it is still too big is the upload blocked.

## Hour files and public events

A public event has only the keys `seq, type, occurred_at, recorded_at, lane,
n, subject, side, label, status, state, lanes, counts`; the uploader adds
`published_at`. Times are whole seconds. The file of hour H holds, first, the
named results recorded in hour H-1, sorted by server name, their times set to
the start of H-1; then every other public event recorded in H, in order.
`seq` is H's index × 100000 plus the event's place in that file. A file over
256 KB becomes one `hour_counts` event with the count of each type.

| Internal event | Public event | Public fields |
|---|---|---|
| `dispatch_sent` | `batch_sent` | lane, n |
| `dispatch_failed`, `dispatch_unconfirmed` | `batch_not_sent` | lane, n, label (`GitHub error`, `refused`, `withdrawn`) |
| `dispatch_closed` | `batch_closed` | lane, n |
| `dispatch_expired` | `batch_expired` | lane, n |
| `result_recorded`, accepted, side `assessed` or `subject` | `result`, in the next hour's file only | lane, n (1), subject (owner/name or absent), side |
| `result_recorded`, anything else | nothing | lane counts only |
| `pump_run_started`, `pump_run_finished`, `successor` | `pump_run` | label (`started`, `finished`, `successor`), state and status for the successor |
| `registry_delta` (dispatched or failed) | `history_triggered` | state |
| `breaker_changed` | `sandbox_check` | state (`waiting_sandbox_check`, `closed`), lanes |
| `retry` | `retry` | label (call), status, n (attempts), state (`retrying`, `gave_up`) |
| `workflow_paused`, anything else | nothing | |

## Why it is shaped this way

The aim: no single server's non-use, and no class of rejection (a quarantine
above all), can be worked out from anything published, across any number of
snapshots and hour files.

- Which servers are in a batch is never public (R-LIVE-22). A server is named
  only for an accepted result that is assessed or its own condition (side
  `subject`), never for a tool, infra, policy or unknown result (R-LIVE-27),
  and only an hour later, sorted by name, with no time finer than the hour
  (R-LIVE-26). No batch says how many of its items were used.
- Rejections and quarantines are never events, and their classes are only
  daily totals per lane, suppressed as above (R-LIVE-20, R-LIVE-25). A test
  builds two timelines that differ only in one item being quarantined or
  rejected for its lease and checks every snapshot and hour file is the same,
  but for the next day's `ring_daily` when its classes are 5 or more.
- Public `seq` values are not event ids, whose gaps would place an unpublished
  event (R-LIVE-21).
- A server name must be a plain ASCII owner/name of at most 60 characters with
  no segment starting with a dot, and pass the secret and vendor-name scans,
  or it is left out (R-LIVE-23).
- Retry call labels come from a fixed list (R-LIVE-24).

## What never is

Fences, attempt ids, item positions, run keys and their fields, digests,
holders, shard ids, run URLs, artifact names, raw reason codes, error text,
App or installation ids, environment values, batch membership, any
per-server or per-batch rejection or quarantine, any count of held or
security-class results (no key or value says `held`), lane pauses, personal
names, logins or emails, and AI vendor or model names.
`live/test/build.test.mjs` seeds all of these and checks that none appears.

## Adding a field

1. Add it in `build.mjs`, from a count, a fixed word list, a validated time,
   a config lane id or `publicName()`. Never copy a string from the state.
2. Add it to the exact-shape test in `live/test/build.test.mjs` and to this
   file.
3. If it could carry anything from the never-public list, or change with a
   single server's fate, extend the allowlist test or the observer test
   (R-LIVE-25) to show it does not.
4. Refresh the example snapshots (`LIVE_WRITE_FIXTURES=1 node --test
   live/test/fixtures.test.mjs`) and tell the site, which copies them.
