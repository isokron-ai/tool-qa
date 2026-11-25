# live/: the public loop snapshot

The pump publishes what the loop is doing to `live.isokron.ai` (the uploader
and its switch are in `pump/run.mjs` and `live/r2.mjs`). Everything it
publishes is built here, by one pure function, from an allowlist:

```js
import { buildLiveSnapshot, toPublicEvent } from './live/build.mjs';
const { snapshot, hourEvents, problems } = buildLiveSnapshot(db, { now, config, retry, version });
// problems non-empty: upload nothing.
```

- `now`: epoch milliseconds (a `Date` or an ISO string also works). Nothing
  reads the clock, so the same state and `now` give the same bytes.
- `config`: `pump/workflows.json` plus `switches` (the values the run read:
  `LOOP_ENABLED`, `LOOP_PAUSE_UNTIL`, `LOOP_SLOTS`, `RESULTS_PUBLISH_ENABLED`,
  `LANE_HISTORY_*_ENABLED`) and optionally `history`
  (`[{kind, last_capture_at, versions, registry_size}]`) and `lane_notes`
  (`{lane: key of LANE_NOTES | null}`).
- `retry`: the open retry, `{call, status, attempt, of, next_at, since}`, or
  null. `call` is `github_api`, `state_asset` or `app_token`; anything else
  (a raw `METHOD /path`) is mapped to one of them, never copied.
- `version`: a short label of the code (a commit), or null.

| File | What it does |
|---|---|
| `build.mjs` | the snapshot (`isokron-loop-live/1`), `toPublicEvent(row)`, this hour's public events |
| `classes.mjs` | raw rejection reason → `lease`, `integrity`, `worker_output`, `infra` (unknown → `worker_output`); in the daily totals a quarantine counts as `integrity` |
| `scan.mjs` | `scanPublic(value)`: the secret scan (`ingest/redact.mjs`) and the vendor-name scan over every string and key; hits are `{rule, path}` only |
| `vendor-names.mjs` | the vendor, model and client name scanner (word list kept split in source, as R-PUB-08 does) |

The builder reads `events`, `results`, `dispatches`, `dispatch_items`,
`slot_ledger`, `subjects` and `kv`, and never `attempts`, `leases`,
`run_keys`, any digest, fence, holder or error column, or any bundle. Every
statement it runs is checked against that list.

## What is public

The snapshot's fields (design: PHASE-1-BUILD-PLAN.md section 3): `schema`,
`seq`, `generated_at`, `version`, `mode` and `mode_reason` (fixed words: "scanning
live", "scanning paused by us", "loop paused by us", "loop switched off by us",
"retrying a GitHub call"), `pump`, `retry`, `breaker` (`{state, checked_at, lanes}`),
`lanes[]`, `history[]`, `edges[]`, `publish`, `counts`, `now_checking[]` and
`recent[]`. `pump.registry_delta` is `{at, w24h}` (the last registry delta the
pump dispatched, and how many in 24 h). Each lane has a `note`, one of the
fixed wordings in `LANE_NOTES` or null: by default "not built yet", "built,
switching on next" for a lane that is off, and writecheck's "most servers
skipped: npm and PyPI only for now"; `config.lane_notes` (`{lane: key}`) can
pick another key from that list, or null, and never carries text itself. The
`registry-full` history entry has `registry_size` and `full_at`. Public events have only the keys `seq, type, occurred_at,
recorded_at, lane, n, accepted, not_used, subject, side, label, status, state, lanes`;
the uploader adds `published_at`.

| Internal event | Public event | Public fields |
|---|---|---|
| `dispatch_sent` | `batch_sent` | lane, n |
| `dispatch_failed`, `dispatch_unconfirmed` | `batch_not_sent` | lane, n, label (`GitHub error`, `refused`, `withdrawn`) |
| `dispatch_closed` | `batch_closed` | lane, n, accepted, not_used |
| `dispatch_expired` | `batch_expired` | lane, n, accepted, not_used |
| `result_recorded`, accepted | `result` | lane, subject (owner/name), side (`assessed` or the fault side) |
| `result_recorded`, rejected or quarantined | nothing | only in its batch's `not_used`, and in the next day's `ring_daily` |
| `pump_run_started`, `pump_run_finished`, `successor` | `pump_run` | label (`started`, `finished`, `successor`), state and status for the successor |
| `registry_delta` (dispatched or failed) | `history_triggered` | state |
| `breaker_changed` | `sandbox_check` | state (`held`, `closed`), lanes |
| `workflow_paused` | `lane_paused` | lane |
| `retry` | `retry` | label (call), status, n (attempts), state (`retrying`, `gave_up`) |
| anything else | nothing | |

Every batch that was sent ends with exactly one `batch_closed` or
`batch_expired` event. `accepted` is how many of its items had an accepted
result by then; `not_used` is every other item: rejected for any reason,
quarantined, or lost with its worker run (both null if the batch cannot be
found in the state). In the snapshot each lane has:

- `ring`: the last 24 h, `{accepted, not_used}` (not_used from the batches that
  ended in those 24 h);
- `ring_daily`: the previous complete UTC day's rejections by class,
  `{lease, integrity, worker_output, infra}`, a quarantine counted in
  `integrity`, and each class null below 5.

Nothing public tells a quarantine from any other rejection (R-LIVE-25: two
states that differ only in one item being quarantined or rejected for its
lease give the same output, but for the next day's `ring_daily`). Further
choices, each pinned by a test:

- A public event's `seq` is its UTC hour (by `recorded_at`) × 100000 plus its
  place among that hour's public events, and the snapshot's `seq` is
  `generated_at` in whole seconds. Internal event ids are never published:
  their gaps would show where a result was not published (R-LIVE-21).
- `ring_daily` is for the previous complete UTC day only, so it never moves
  while a day runs (R-LIVE-20).
- `now_checking` lists every server of a batch that is still out, results in
  or not, so a server leaves only when its whole batch closes (R-LIVE-22).
- A server name that is not owner/name, or that the secret or vendor-name
  scan would flag, is left out (`subject: null`, or no `subject` key on an
  event); the row or event stays (R-LIVE-23).

What still is visible, by design: which servers were in a batch, and which of
them have an accepted result. A server of a closed batch with no `result`
event was not used, for a reason that is never shown per server or per batch.

## What never is

Fences, attempt ids, item positions, run keys and their fields, digests,
holders, shard ids, run URLs, artifact names, raw reason codes, error text,
App or installation ids, environment values, any per-server rejection or
quarantine, any count of held or security-class results (no key starts with
`held`), personal names, logins or emails, and AI vendor or model names.
`live/test/build.test.mjs` seeds all of these and checks that none appears in
the output.

## Adding a field

1. Add it in `build.mjs`, from a count, a fixed word list, a validated time,
   a config lane id or `publicName()`. Never copy a string from the state.
2. Add it to the exact-shape test in `live/test/build.test.mjs` (the test
   lists every key; a new key fails it until it is listed) and to this file.
3. If it could carry anything from the never-public list, extend the
   allowlist property test to plant that thing and show it does not appear.
4. Refresh the example snapshots (`LIVE_WRITE_FIXTURES=1 node --test
   live/test/fixtures.test.mjs`) and tell the site, which copies them.
