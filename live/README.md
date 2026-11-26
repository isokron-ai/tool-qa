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
| `history.mjs` | the day file of the daily history (`isokron-loop-day/1`), `buildDay(db, {day, now, config})` |
| `vendor-names.mjs` | the vendor, model and client name scanner (word list kept split in source, as R-PUB-08 does) |

The builder reads `events`, `results`, `dispatches`, `slot_ledger`,
`subjects` and `kv` (the day builder only `events` and `subjects`), never `dispatch_items`, `attempts`, `leases`,
`run_keys`, any digest, fence, holder or error column, or any bundle. Every statement it runs is checked against that list.

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
| `edges[]` | `{from, to, w1h, w24h, w7d}`: pump → lane (batches sent), lane → ingest (accepted results), pump → history (deltas) |
| `publish` | `{state: on/off}` |
| `counts` | `subjects_in_seed`, `checked {w24h, w7d, all}`, `assessed {w24h, all}` |
| `now_checking[]` | per lane with batches out: `{lane, batches_out, since_oldest}`; no server names, no item counts |
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

## The daily history

`live/history.mjs` builds one file per complete UTC day, and
`publishHistory` (in `live/publish.mjs`) uploads it once, after the first
good snapshot upload of the next day:

```js
import { buildDay } from './live/history.mjs';
const { day, problems } = buildDay(db, { day: '2026-11-24', now, config });
// problems non-empty: upload nothing.
```

| Object | Content |
|---|---|
| `v1/history/days/<YYYY-MM-DD>.json` | one day (`isokron-loop-day/1`), immutable, kept indefinitely |
| `v1/history/recent.json` | `{schema: 'isokron-loop-history-recent/1', days: [day objects]}`: the last 120 days, oldest first, `max-age=300` |
| `v1/history/index.json` | `{schema: 'isokron-loop-history-index/1', days: ['YYYY-MM-DD', ...]}`: every day with a file, `max-age=300` |

A day:

| Field | Content |
|---|---|
| `schema`, `day`, `generated_at` | `isokron-loop-day/1`, the UTC day, when it was built (whole seconds) |
| `partial` | true only for the day the events table begins (the loop's first day): its counts start at its first event |
| `lanes[]` | per lane of `pump/workflows.json`: `id`, `state` (`on`, `off`, `not_built` from the config, or null; see below), `pins`, `results`, `assessed`, `sides {subject, tool, infra, policy, unknown}`, `not_used`, `classes {lease, integrity, worker_output, infra}`; the numbers are null for a lane not built |
| `totals` | `subjects_in_seed` (when built), `servers_checked` and `servers_assessed` (distinct servers with an accepted, or an accepted and assessed, result that day) |
| `tool_releases` | always `[]` for now: no feed records our tools' releases yet |

- `results`: accepted results that day (by `occurred_at`); `assessed`: those
  with coverage `assessed`; `sides`: the rest by fault side (`sideOf`, the
  snapshot's `fault`). `tool`, `infra`, `policy` and `unknown` are ours;
  `subject` is the server's condition.
- `not_used` and `classes` follow `ring_daily`: `not_used` null below 5;
  `classes` null unless every class is 5 or more, a quarantine counted in
  `integrity`. A test builds two days that differ only in one item
  quarantined or rejected for its lease (and one more unused item) and checks
  the files are byte-identical (R-LIVE-30).
- `pins`: the lane's `versions.tool` then `versions.probe` labels
  (`"<name> <version>"`, plain labels with no vendor name only). `state` and
  `pins` come from the config only when the day is built within a day of its
  end; for an older day (the backfill, or after the pump was off) both are
  `null`, since what was in force then is not known (R-LIVE-33).
- Nothing names a server, a batch or an item, and no dispatched item count is
  in it (R-LIVE-28). No reason code, id, fence, held or security-class count.
  The whole file passes `scanPublic`; a hit keeps that day out.

The rollover, once per UTC day, while kv `live.history.last_day` is not the
previous day:

1. A day file whose upload was not confirmed (kv `live.history.pending`) is
   sent again with exactly its stored body, never rebuilt, so an immutable
   key never gets a second body even when a PUT landed but answered an error
   (R-LIVE-31).
2. Each missing day, oldest first, at most 2 per publish (a build is a few
   synchronous queries on the pump's thread): the previous day and, on the
   first run or after a gap, the up to 7 days before it. A day is built only
   when the events table holds all of it (its oldest event at or before the
   day's start, and the day inside the 8 days events are kept), or when it
   is the day the events begin, marked `partial` (R-LIVE-32). Days in kv
   `live.history.days` or `live.history.blocked` are skipped. Build, scan,
   store the body as pending, upload, record, clear pending.
3. Then `recent.json`, then `index.json`, from kv, and only then `last_day`.
   A failure anywhere leaves `last_day`; the next publish goes on. Keys, retention and
recovery: docs/OPERATIONS.md, "The daily history".

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
| `dispatch_sent` | `batch_sent` | lane, n (always 1: one batch) |
| `dispatch_failed`, `dispatch_unconfirmed` | `batch_not_sent` | lane, n (1), label (`GitHub error`, `refused`, `withdrawn`) |
| `dispatch_closed` | `batch_closed` | lane, n (1) |
| `dispatch_expired` | `batch_expired` | lane, n (1) |
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
- Dispatched work is public only as batch counts, never item counts
  (R-LIVE-28): items sent minus accepted results would give each batch's, and
  each day's, non-use, and undo the suppression of a small `not_used`.
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

## What stays visible, by design

Per-lane counts of accepted results are live (`w1h`, `w24h`, `spark24`,
`fault`, `ring.accepted`, the lane → ingest edge, `counts`), and accepted
results that are assessed or the server's own condition are named an hour
later. How many batches a lane sent, ended and has out is live. None of this
says how many items a batch had, which server was in which batch, or what
happened to an item that was not used.

## What never is

Fences, attempt ids, item positions, run keys and their fields, digests,
holders, shard ids, run URLs, artifact names, raw reason codes, error text,
App or installation ids, environment values, batch membership, item counts of dispatched work, any
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
