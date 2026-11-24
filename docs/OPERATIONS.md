# Operations

How to start, slow down and stop the loop.

## Stop everything in one step

Set the repository variable `LOOP_ENABLED` to `false` on `isokron-ai/tool-qa`:

```sh
gh variable set LOOP_ENABLED --body false --repo isokron-ai/tool-qa
```

or Settings → Secrets and variables → Actions → Variables → `LOOP_ENABLED`.

Every loop job reads it at its next start and exits green with a one-line
notice. Worker jobs in our tool repos only run when this repo dispatches them,
so they stop too. Jobs that are already running keep going until they end;
cancel them from the Actions tab if you need them gone at once.

Any value other than exactly `true` (including unset, `TRUE` or `1`) means off.

## Shrink the loop

Set `LOOP_SLOTS` to 5 or less:

```sh
gh variable set LOOP_SLOTS --body 5 --repo isokron-ai/tool-qa
```

`LOOP_SLOTS` is the number of worker runs the loop may have going at once,
across all repos. The pump's own job is one more on top (the account runs at
most 20 jobs at once, and the pump keeps 2 free for ordinary CI, so
`LOOP_SLOTS=15` gives 14 workers plus the pump). In the state store, each slot
row carries an expiry (set when it is taken); expired rows are reaped on every
pump tick and whenever a slot is acquired, so a crashed run can't hold a slot
for good.
It is read as a whole number and clamped to 0..15: unset or 0 means slot-based
jobs do nothing, values above 15 count as 15, and a value that isn't a whole
number counts as 0. With 0 the pump still runs on its schedule, but only for
housekeeping: it reaps expired leases and slots, runs ingest, dispatches no
work and does not start a successor run.

Lowering `LOOP_SLOTS` does not stop workers already running; they finish or
their leases expire. The pump simply starts no new work until the number of
open slots is below the new value.

## Pause until a set time

```sh
gh variable set LOOP_PAUSE_UNTIL --body 2026-12-01T09:00:00Z --repo isokron-ai/tool-qa
```

`LOOP_PAUSE_UNTIL` takes an ISO 8601 time with a zone (`Z` or `+02:00`), or a
date such as `2026-12-01` (midnight UTC). Until then every loop job skips. After
it passes, the value is ignored; delete it when convenient. A value the guard
can't read (no zone, a typo) keeps the loop paused, so a mistake fails safe.

## Which variable affects which workflow

| Variable | `history-registry` | `history-packages` | `history-popularity` | `pump` | `watchdog` | `ingest` (manual) | Workers (later) |
|---|---|---|---|---|---|---|---|
| `LOOP_ENABLED` | yes | yes | yes | yes | yes | yes | yes |
| `LOOP_PAUSE_UNTIL` | yes | yes | yes | yes | yes | yes | yes |
| `LANE_<JOB>_ENABLED` | `LANE_HISTORY_REGISTRY_ENABLED` | `LANE_HISTORY_PACKAGES_ENABLED` | `LANE_HISTORY_POPULARITY_ENABLED` | `LANE_PUMP_ENABLED` | `LANE_WATCHDOG_ENABLED` | `LANE_INGEST_ENABLED`; also refuses to run unless `LANE_PUMP_ENABLED` is off | their own lane |
| `LOOP_SLOTS` | no | no | no | 0 = housekeeping only | 0 = no pump expected | no | yes |

The three history workflows capture public data and don't work in slots, so
they run the guard with `--no-slots`: `LOOP_SLOTS=0` does not stop them. Use
`LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` or the lane switch for those. The same goes
for the manual re-ingest workflow (see "Manual re-ingest").

The watchdog also reads every lane switch above: a lane that is off shows as
`off` on the health issue instead of red, and the watchdog does not dispatch a
pump whose lane is off.

## Stop one job

Set `LANE_<JOB>_ENABLED` to `false`, where `<JOB>` is the job name passed to the
guard in upper case with anything other than letters and digits turned into
`_`. For example `history` → `LANE_HISTORY_ENABLED`, `meta-github` →
`LANE_META_GITHUB_ENABLED`. Unset or empty leaves the job on.

## Stronger stops, in order

1. `LOOP_ENABLED=false` (above).
2. Disable a single workflow: Actions → the workflow → ⋯ → Disable workflow.
3. Disable Actions for the repository: Settings → Actions → General.

## Variable scope

These are read as repository variables of `isokron-ai/tool-qa`. If you also
define them at organisation level, note that a repository variable with the
same name takes precedence over the organisation one.

## How the guard works

`scripts/guard.mjs` is the first thing every scheduled or dispatched loop job
runs. It checks, in order: `LOOP_ENABLED`, `LOOP_PAUSE_UNTIL`, the job's
`LANE_<JOB>_ENABLED`, then `LOOP_SLOTS` (with `--slots`; `--no-slots` skips this
check and ignores `LOOP_SLOTS`). It prints one notice
line and writes `proceed`, `slots` and `reason` to `$GITHUB_OUTPUT`. It exits 0
whenever it has decided, so a stopped loop is never a red run; it exits 2 only
on a usage error.

| `reason` | Meaning |
|---|---|
| `ok` | Run. `slots` is the clamped slot count. |
| `disabled` | `LOOP_ENABLED` is not `true`. |
| `paused` | `LOOP_PAUSE_UNTIL` is in the future. |
| `invalid_pause` | `LOOP_PAUSE_UNTIL` can't be read; treated as paused. |
| `lane_disabled` | This job's `LANE_<JOB>_ENABLED` is set and not `true`. |
| `no_slots` | The job works in slots (`--slots`) and `LOOP_SLOTS` is 0. |

Pattern for a loop workflow (pin the actions to SHAs as usual):

```yaml
jobs:
  guard:
    runs-on: ubuntu-24.04
    timeout-minutes: 2
    permissions:
      contents: read
    outputs:
      proceed: ${{ steps.guard.outputs.proceed }}
      slots: ${{ steps.guard.outputs.slots }}
    steps:
      - uses: actions/checkout@<sha> # <tag>
        with:
          persist-credentials: false
          sparse-checkout: scripts/guard.mjs
          sparse-checkout-cone-mode: false
      - id: guard
        env:
          LOOP_ENABLED: ${{ vars.LOOP_ENABLED }}
          LOOP_SLOTS: ${{ vars.LOOP_SLOTS }}
          LOOP_PAUSE_UNTIL: ${{ vars.LOOP_PAUSE_UNTIL }}
          LANE_META_GITHUB_ENABLED: ${{ vars.LANE_META_GITHUB_ENABLED }}
        run: node scripts/guard.mjs --job meta-github --slots

  work:
    needs: guard
    if: needs.guard.outputs.proceed == 'true'
    # ...
```

## State store

The loop's state (subjects, runs, leases, slot ledger, dispatches, attempts,
results) is one SQLite file. Between runs it lives as the asset `state.sqlite`
on the release tagged `state` in this repo. Only the pump writes it, inside the
`pump` concurrency group; ingest runs inside the pump. The manual re-ingest
workflow writes it too, but only while the pump is paused.

```sh
GITHUB_REPOSITORY=isokron-ai/tool-qa node scripts/state-asset.mjs pull   # -> state/state.sqlite
GITHUB_TOKEN=... GITHUB_REPOSITORY=isokron-ai/tool-qa node scripts/state-asset.mjs push
```

`pull` also writes `state.sqlite.pulled.json` next to the file: the id, sha256
and `updated_at` of the asset it read. `push` re-reads the remote asset before
it uploads and again before it deletes the old copy, and exits 1 with "remote
state changed" if it is no longer the pulled one, so a stale writer can't
overwrite newer state. A push with no pull record is refused unless you pass
`--force`.

The asset is age ciphertext (see "State encryption" below): `push`
encrypts the database before upload, and `pull` decrypts it with
`AGE_IDENTITY`, so both need age (`AGE_BIN`, `AGE_KEYGEN_BIN`) and `pull`
needs the identity.

`push` needs a token with `contents: write`. It uploads under a temporary name,
then deletes the old asset and renames the new one, so a failed push keeps the
last good copy. `pull` checks the sha256 in the asset label and that the file
is a healthy SQLite database before it replaces the local file. To reset state,
delete `state.sqlite` and any `state.sqlite.upload-*` assets; the next run
starts empty.

## State encryption

This repository is public, so anyone can download a release asset. The state
database is for the loop only (attempts with their rejection and quarantine
reasons, leases, dispatches, results before they are published), so
[`scripts/state-asset.mjs`](../scripts/state-asset.mjs) keeps the asset
age-encrypted:

- `push` encrypts the database to every public key in
  [`state/state.pub`](../state/state.pub) and uploads only age ciphertext. A
  writer that has an identity (the pump, the manual re-ingest) first checks
  that its identity is one of those keys, so it never pushes a state it could
  not read back.
- `pull` decrypts with `AGE_IDENTITY` and refuses an asset that is not age
  ciphertext (it fails closed: the pump run fails before it does anything).
- The sha256 label and the stale-writer check are over the uploaded
  ciphertext, so they work as before.

`state/state.pub` must list the ingest public key (the one in
`worker-kit/ingest.pub`): the pump, the watchdog and the manual re-ingest all
read the state with the `AGE_IDENTITY` secret of environment `loop`. A test
checks this. You may add a key of your own, on its own line, to read the
state on your machine:

```sh
GITHUB_REPOSITORY=isokron-ai/tool-qa AGE_IDENTITY="$(cat my-identity.txt)" \
  node scripts/state-asset.mjs pull --file state/state.sqlite
```

Nothing else reads the state asset: the archive pull copies history
artifacts only and needs no key.

**One-time migration** from the plaintext asset of earlier versions. Pause
the pump (`LANE_PUMP_ENABLED=false`) and wait until no pump run is going,
then, with age installed and a token that can write this repository's
releases:

```sh
GITHUB_TOKEN=... GITHUB_REPOSITORY=isokron-ai/tool-qa node scripts/state-asset.mjs migrate --file /tmp/state.sqlite
```

`migrate` downloads the plaintext asset, checks it, encrypts it to
`state/state.pub` and replaces the asset, with the same stale-writer checks as
`push`. It needs no identity. If the asset is already encrypted (or absent) it
says so and changes nothing. Turn the pump back on afterwards. Until the
migration is done, every pump, watchdog and re-ingest run fails with "is not
age ciphertext; refusing to use it". Delete the local copy when done.

**Rotation.** Add the new public key to `state/state.pub` (keep the old one),
merge, and let one pump run push: the asset is then encrypted to both keys.
Then switch `AGE_IDENTITY` (see "Result encryption keys") and remove the old
key from `state/state.pub`; the next push drops it.

## State store: one writer at a time

`scripts/state-asset.mjs push` refuses to overwrite the state asset if it changed since this run pulled it, and re-checks just before replacing it. There is still a short window between that re-check and the swap, so the check is a safety net, not a lock: every workflow that pushes state must run in the same `concurrency` group (one writer at a time). Pull again before every push.

The pump is that one writer (concurrency group `pump`), and it judges worker
results itself, in the same process, so ingest never needs a second writer. To
push state by hand or run the manual re-ingest workflow, first switch the pump
off (`LANE_PUMP_ENABLED=false`) and wait until no pump run is going. The
watchdog only downloads a copy and never pushes.

## Subjects: where they come from

The due list works on the `subjects` table. Today its only source is the seed
list, [`history/seed-v1.json`](../history/seed-v1.json): 997 GitHub
repositories, drawn as described in
[`history/seed/README.md`](../history/seed/README.md).
[`pump/subjects.mjs`](../pump/subjects.mjs) loads it at the start of every pump
run, inside the pump (the one writer), before the first tick. The log line is
`pump: subjects: ...`.

- **Cheap and idempotent.** The seed file's sha256 and the loader's mapping
  version are kept in kv as `subjects.seed`. When both match, nothing is
  written (`pump: subjects: seed-v1 already loaded (997 subjects)`).
  Otherwise every seed subject is upserted in one transaction.
- **What is written.** id `owner/name` (what the scan-static worker takes),
  kind `github`, source `seed-v1` (set when the subject is first seen), and a
  tier. The commit SHA is left empty: the scan-static worker reads the head of
  the default branch itself. A SHA or digest set by another writer is kept.
- **A seed that cannot be read or is malformed** (no `size`, a `size` that
  does not match, a duplicate id, an id that is not `owner/name`, an unknown
  population) is refused whole. So is a state error during the load. Nothing
  is written, the subjects already in the state stay, and the run fails (red)
  with `pump: subjects: seed not loaded, ...`. kv `subjects.seed` records the
  path actually loaded (`file`).
- **Shrink guard (R-SUB-03).** A seed that would retire more than 10% of the
  active seed subjects is refused the same way (`... would retire N of M
  active seed subjects ...`), so a truncated or wrong file cannot retire
  nearly everything. To retire more on purpose, set the one-shot override
  `subjects.seed.allow_retire` to `true` in kv: switch the pump off
  (`LANE_PUMP_ENABLED=false`) and wait until no pump run is going, pull the
  state, run
  `node -e "import('./state/db.mjs').then(({openState})=>{const d=openState('state/state.sqlite');d.setKv('subjects.seed.allow_retire',true);d.close()})"`,
  push it, and switch the pump back on. The load that uses it clears it and
  says so in its log line.

**Tiers.** From the seed's own population labels:

| Seed label | Subjects | Tier | Why |
|---|---|---|---|
| `T0` (our five repositories) | 5 | T0 | Our own servers: the tier that runs first and most often. |
| `gold14` (the 14 Go and Rust servers) and `reference` (`modelcontextprotocol/servers`) | 15 | T1 | Calibration subjects: vendor-official or reference servers whose results we check our tools against, refreshed at least weekly. They come right after T0 in a first pass, as the gold-set stratum does in the design. |
| `sample` with 100 or more stars in the seed | 48 | T2 | Popular community servers: refreshed at least every 14 days. |
| `sample` with fewer than 100 stars | 929 | T3 | The long tail: refreshed at least every 30 days. |

The star count is the one recorded in the seed, so a subject's tier does not
move with its live star count. Star bucket is one of the sample's strata, so
the different cadences stay within strata and the sample's weights still hold.

**No SHA, so cadence only.** With no SHA, a subject's run_key does not move
when the repository changes, so it is due again only when its last result is
older than the tier's max age (`pump/tiers.json`). Where a tier's cell has no
max age of its own (T0 scan-static: "every push"), `unversioned_max_age_days`
applies to a subject with no SHA and no digest: 1 day for T0, then 7, 14, 30
and 90 days for T1 to T4. Without it, T0 would never be scanned again after
its first result. A new tool version in `pump/workflows.json` still makes
every subject due at once.

**Skips only (R-SUB-06).** An accepted result whose bundle held no
observation records and only retryable skips (its retries ran out)
measured nothing for a passing reason. It is stored with outcome
`skips_only` and is due again after `skips_only_max_age_days` (1 day, reason
`skips_only`) instead of the tier max age (up to 30 days). A result with
any permanent skip (`remote_only`, `no_runnable_artifact`,
`policy_excluded`, ...), even beside a retryable one, keeps the tier max age.

**Throttling (R-SUB-04).** A result whose every skip is a retryable
`rate_limited` or `upstream_unavailable` is sent back as `retry_throttled`.
It does not use up the three `retry_later` retries: it is sent out again
after the usual backoff, capped at `retry_backoff_max_minutes` (6 hours), for
up to 7 days after the run_key's first throttled retry. Only then is it kept
as a skip.

**Before switching on a lane that runs third-party code.** In
`pump/tiers.json`, `live-probe` is `always` for every tier, T0 to T4 (and
`build-probe` is `always` for T0 to T2, `writecheck` for T0 and T1). The seed's 977
sample subjects would all be due for it at once. Before any lane that runs
third-party code is switched on, review its tier cells (mode and max age) for
the subjects actually loaded, and change them in the same reviewed PR as the
switch.

**Leaving the seed.** A subject removed from a later seed is not deleted; its
results and history stay. It is marked retired (`subjects.retired_at`), the
due list skips it, and its last results simply grow older from then on. It
becomes active again if a later seed lists it. Only subjects first seen from a
seed (`source` `seed-v...`) are retired this way.

**Refreshing.** Edit or rebuild the seed (`history/seed/README.md`) and merge.
The next pump run sees the new hash and loads it. To re-apply the same file
after a change to the tier mapping, bump `MAPPING_VERSION` in
`pump/subjects.mjs`. To see the result without dispatching anything, pull the
state and run `node pump/run.mjs --plan --state state/state.sqlite` (the plan
reads the state as pushed; the seed is loaded by the next pump run).

**First pass.** With scan-static on (shard size 25, at most 3 open shards) and
`LOOP_SLOTS=3`, the first tick finds all 997 subjects due (`first_sight`) and
sends three full shards of 25: our five, the 15 calibration subjects and the
first T2 subjects first. Later ticks send nothing until results free a slot,
so a full pass takes 14 rounds of up to 75, each about as long as one shard runs
(at most about 30 minutes for 25 subjects), roughly 7 hours.

## The pump

`.github/workflows/pump.yml` runs every 30 minutes and can be started by hand
(Actions → pump → Run workflow). Each run works for about 11 minutes, ticking
every 150 seconds, and first dispatches the next run, which waits for it in the
`pump` concurrency group. While `LOOP_SLOTS` is above 0 the pump therefore runs
back to back; the schedule restarts the chain if it breaks. Because only one
run can wait in a concurrency group, a scheduled run that starts while one is
already waiting replaces it, and the replaced run shows as cancelled. That is
normal.

Each tick, in this order:

1. **Reap.** Close dispatches whose lease expired and free their slots, so a
   dispatch that cannot be judged stops being an open one when its lease
   ends.
2. **Ingest.** For every dispatch still waiting for a result, the pump checks
   whether its worker run has finished. For a finished run it judges each
   item's result artifact on its own (the checks in
   [`ingest/README.md`](../ingest/README.md)), records each decision in the
   state, writes each item's outputs sealed to `worker-kit/ingest.pub`, and,
   once every item has a decision, closes the dispatch, which frees its slot.
   One log line per judged item: `ingest: <workflow> shard <shard id>
   (<attempt id>) item <index>: <outcome> (<reason>), recorded, outputs
   sealed`. Judging one item is limited to a minute (`ingest_timeout`), and
   an item the pump fails to judge three times is recorded as `ingest_error`.
   Ingest stops taking new results about two minutes before the run ends
   (about minute 9), so everything it judged is in the final push.
3. **Dispatch.** Record due work for the free slots as pending dispatches,
   **push the state**, and only then send them. If that push fails, nothing is
   sent and the pending dispatches are withdrawn.
4. **Push** the state if anything changed.

If three dispatches of one workflow in a row come back with runs at another
commit than the pump recorded when it sent them (`run_sha_mismatch`: its
worker branch keeps moving, or someone else dispatches the workflow with the
same run names), the pump pauses that workflow for six hours: it dispatches
none of it, and every pump run fails with `pump: <workflow> is paused until
...`, so the health issue shows the pump red. Find out who moves the branch or
runs the workflow; the pause ends on its own (kv `pump.paused:<workflow>`).

If any push fails, the run dispatches nothing more, does one housekeeping
tick (reap and ingest), tries a final push and fails (red). Look at the
`pump: state push (...) failed` line; the next run starts from the last state
that was pushed. Work sent before the failure is in that state (it was pushed
before it was sent) and holds its slots until it reports or its lease
expires.

At the end of the job, `pump.yml` uploads the sealed ingest outputs as one
artifact (see "Reading ingest outputs" below).

Before it dispatches anything, a run checks that results can be judged:
`worker-kit/ingest.pub` holds the real key, and `AGE_IDENTITY` is set and
matches it. If either fails, the run logs `pump: ingest is
not ready, so nothing is dispatched this run: <why>`, still reaps and pushes,
and fails (red), so no worker is sent out whose result could not be judged.

To start it:

1. Set up the GitHub App and the `loop` environment (below), including the
   ingest key pair ("Result encryption keys").
2. Enable a worker workflow in `pump/workflows.json` (`"enabled": true`) once
   it exists in its repository and uploads one result bundle per item
   ([`worker-kit/README.md`](../worker-kit/README.md)). Until then the pump
   has nothing to dispatch.
   A workflow that runs third-party code also needs `"runs_untrusted": true`
   and a passing nightly sandbox status ("The sandbox breaker" below).
3. Set `LOOP_SLOTS` (for example 5) and `LOOP_ENABLED=true`.
4. Run the pump by hand once, or wait for the schedule.

To see what it would do without dispatching anything, pull the state and run
the plan:

```sh
GITHUB_REPOSITORY=isokron-ai/tool-qa node scripts/state-asset.mjs pull
node pump/run.mjs --plan --state state/state.sqlite
```

To stop it:

| Do this | Effect |
|---|---|
| `LOOP_SLOTS=0` | The pump only does housekeeping on its schedule (one tick: ingest finished worker runs, reap expired leases and slots). No new work, no successor run. Workers already running finish and are still judged. |
| `LANE_PUMP_ENABLED=false` | The pump does nothing at all, ingest included. Leases and slots are not reaped until it is back; they expire on their own. Results of workers that finish meanwhile are judged once the pump is back; a result whose lease has expired by then is judged as a late result and stored as rejected. The health issue shows the pump as off. |
| `LOOP_ENABLED=false` | Everything stops, the watchdog too. |

A running pump run notices none of these until its next start; cancel it from
the Actions tab if it must stop at once. Its dispatches stay in the state, and
their leases expire as usual.

## The sandbox breaker

Lanes that run third-party code (servers, builds) run it only inside the
sandbox of `isokron-ai/mcp-surface-corpus`. That repository runs the sandbox
self test and its mutation matrix every night (`conformance-nightly.yml`, 03:41
UTC, whatever the loop's switches say) and publishes the result as a small
public file, readable without a token:

```
https://github.com/isokron-ai/mcp-surface-corpus/releases/download/conformance/conformance-status.json
```

The pump reads it on every tick that may dispatch a workflow that runs
third-party code (one GET each 150 seconds). The breaker is **open** while the
status is:

| Reason | Means |
|---|---|
| `red` | The last nightly run failed: `ok` is not true, or the self test or the mutations did not pass. |
| `stale` | The last pass is more than 36 hours old (or the file claims a time more than 10 minutes ahead). |
| `unreadable` | The file could not be fetched (after one retry), is over 16 KiB (reading stops there), is not JSON, or is not a well-formed status. Also: it names an older run (or attempt) than the newest verified run, a rollback; or its run does not back it (below). |

Every status is checked against its run before anything is remembered from
it: the Actions API must show that run attempt as a `conformance-nightly.yml`
run in `isokron-ai/mcp-surface-corpus` on `main`, started by `schedule` or by
hand, of the very commit the status names, with the status's `checked_at`
inside the run's own times; and that commit must be on `main` (`GET
/compare/main...<sha>` is `identical` or `behind`), so a tag named `main`
does not pass. A red status needs that identity; a green one also needs the
run to have succeeded. Only then does the run become the newest seen (so a
forged status, red or green, cannot move the rollback memory). A green status
is aged by its run's start, not its own `checked_at`, so a replay of an old
green with a fresh date is still stale.

The lookups (`GET .../actions/runs/<id>/attempts/<n>` and the compare) send the
job token to `api.github.com` only, for its own rate budget; the reads are
public. A run is looked up once and remembered in the state
(`pump.conformance`: the newest verified run, and the verified green with its
start and end times). For a minute or so after the nightly publishes, its run
is still finishing and the breaker reads `unreadable`; it closes on the next
tick after the run ends.

**Resetting the memory.** Only verified runs are remembered, so this should
never be needed. If `pump.conformance` ever holds a run that keeps the breaker
open wrongly (for example the corpus repository was recreated and its run ids
started again), delete the key: pause the pump (`LANE_PUMP_ENABLED=false`) and
wait until no pump run is going, pull the state ("State encryption" above),
then

```sh
node -e 'import("./state/db.mjs").then(({ openState }) => { const db = openState("state/state.sqlite"); db.deleteKv("pump.conformance"); db.close(); })'
GITHUB_TOKEN=... GITHUB_REPOSITORY=isokron-ai/tool-qa node scripts/state-asset.mjs push
```

and turn the pump lane back on. The next tick verifies the current status
afresh.

While it is open the pump dispatches none of the workflows marked
`"runs_untrusted": true` in `pump/workflows.json` (today `live-probe`,
`writecheck`, `build-probe` and `scan-deep`; a workflow that does not say
`false` counts as `true`). A workflow is enabled only when `enabled` is exactly
`true`: the due list, the ingest key check, the breaker and the watchdog all
use the one test (`isEnabled` in `pump/due.mjs`), and the pump refuses to load
`pump/workflows.json` when `enabled` or `runs_untrusted` is not a real boolean.
Which lanes are trusted is pinned by a test (`R-WD-04`), so changing a flag
needs that test changed and a review. Source-only workflows (`scan-static`,
`meta-github`, `meta-registry`) keep running. The run logs `pump: sandbox
breaker open (<reason>): not dispatching <lanes>: <why>` once, keeps what it
saw as `pump.breaker` in the state (and in `pump.last_tick`), and does not
fail. Work already dispatched is not recalled; each such job runs the sandbox
self test on its own runner before any target. The breaker closes by itself
at the next pump run after a passing nightly status.

Each untrusted lane names the mcp-surface-corpus commit its sandbox is pinned
at (`sandbox_sha` in `pump/workflows.json`, `null` until it pins one). When the
nightly tested another commit, the breaker stays closed (the nightly tests
`main`, which moves with every commit there, so holding on every difference
would hold the lanes after each unrelated change), the pump logs the lanes and
records them in `pump.breaker` (`mismatch`), and the watchdog shows amber.
Bump the lane's pin, and its `sandbox_sha`, to the tested commit.

The watchdog reads the same file, judges it the same way with what the pump
remembered, and shows it as `sandbox-breaker` on the health issue (below).

To clear it:

1. Open the latest `conformance-nightly` run in `mcp-surface-corpus` (the
   health issue links it when the status names one). Red: the failing job's
   log and its telemetry artifact say which case or mutation failed; the
   runner image, kernel, Docker and gVisor versions are in the status file.
2. Stale: check that `conformance-nightly.yml` is still enabled there (GitHub
   disables scheduled workflows after 60 days without a commit) and run it by
   hand (Actions → conformance-nightly → Run workflow).
3. Unreadable: check that the `conformance` release and its asset
   `conformance-status.json` exist; the nightly run makes them.

There is no switch to override the breaker. To run an untrusted lane anyway,
fix or rerun the nightly; to stop worrying about it, disable the lane.

## The GitHub App and the `loop` environment

The pump and the watchdog use a GitHub App owned by the organisation. They mint
short-lived tokens from it, each for one repository and only the permissions
that call needs, and refuse a token that comes back with more.

| What | Where | Value |
|---|---|---|
| App permissions | App settings | Repository: Actions read and write, Issues read and write, Metadata read. Nothing else. |
| App installation | Organisation settings | `tool-qa` and each worker repository (for example `mcp-check`, `mcp-writecheck-action`). |
| `APP_ID` | Variable (repository or `loop` environment) | The App's id. |
| `APP_INSTALLATION_ID` | Variable (repository or `loop` environment) | The installation's id. |
| `APP_PRIVATE_KEY` | Secret in the `loop` environment only | The App's private key (PEM). |
| `AGE_IDENTITY` | Secret in the `loop` environment only | The ingest identity that decrypts worker results ("Result encryption keys" below). Only the pump's `Pump` step (and the manual re-ingest step) gets it; the pump drops it from its environment at start and scrubs it from its logs. |

The manual re-ingest workflow uses the same `APP_ID` and `APP_PRIVATE_KEY`.

What each token is used for:

| Job | Repository | Permissions | For |
|---|---|---|---|
| pump | each worker repository | `actions: write` | dispatching shards and finding their runs; reading the commit the worker workflow's ref points to (no permission needed, the worker repositories are public; a private one would need Contents: read) |
| pump (ingest) | each worker repository | `actions: read` | finding finished worker runs and downloading their result artifacts |
| pump (successor) | `tool-qa` | `actions: write` | dispatching the next pump run |
| pump (successor failed) | `tool-qa` | `issues: write` | marking `pump-successor` red on the health issue |
| watchdog | `tool-qa` | `issues: write`, `actions: write` | reading runs and artifacts, dispatching the pump, re-enabling workflows, the health issue |
| ingest (manual) | the one worker repository | `actions: read` | reading that run and its result artifact |

The state asset is pushed with the pump job's own token (`contents: write` on
this repository only) and read by the watchdog with its job token
(`contents: read`).

Create the environment under Settings → Environments → `loop`. Limit
deployment branches to `main`, so no other branch can use the key, and add no
required reviewers (scheduled runs would wait for approval). Each pump and
watchdog run shows up as a deployment to `loop`; that is expected.

## The loop health issue

The watchdog runs at minutes 7, 22, 37 and 52 of every hour and keeps one
pinned issue titled **Loop health** (label `loop-health`) up to date. The body
is rewritten in place; a comment is added only when the overall status turns
red or recovers, so subscribe to the issue to be told when something needs a
person. The issue is not updated while the loop is stopped or paused, because
the watchdog stops too.

green: fine. amber: late or degraded, the loop is handling it. red: needs a
person. off: switched off on purpose.

| Check | Amber or red means | What to do |
|---|---|---|
| `pump` | No pump run started for 20 minutes (amber; the watchdog dispatches one) or 40 minutes (red). | Look at recent pump runs: are they queued, failing, or skipped by the guard? Check the Actions queue and the App settings. |
| `pump-dispatch` | The watchdog could not dispatch the pump; the HTTP status is in the details. | 403: the App lacks `actions: write` or is not installed on `tool-qa`. 404 or 422: `pump.yml` is missing or has no `workflow_dispatch`. |
| `pump-successor` | The pump could not dispatch its next run, so the chain is broken until the next schedule (at most 30 minutes). | Check `APP_ID`, `APP_INSTALLATION_ID`, the private key and the installation. Clears when a later pump run succeeds. |
| `history-registry-delta` | Newest delta capture is over 45 minutes old (amber), or over 90 (red). | Open the `history-registry` runs. |
| `history-registry-full`, `history-packages`, `history-popularity` | Newest artifact is over 26 hours old (amber), or over 50 (red). | Open that workflow's runs. |
| `state` | No state asset yet, or it could not be read (amber; the details say which). | Normal until the first pump run has saved state. Otherwise check the `state` release. |
| `slots`, `dispatches` | Rows more than 15 minutes past their expiry (red): the pump is not reaping. | See the `pump` check and the latest pump logs. |
| `run:<workflow>` | The latest scheduled or dispatched run of a loop workflow failed (red). | Open the linked run. Cancelled and skipped runs are ignored. |
| `workflow:<file>` | Amber: GitHub disabled the workflow for inactivity and the watchdog turned it back on. Red: turning it back on failed. Off: someone disabled it by hand. | For red, enable it under Actions → the workflow. |
| `config` | Red: the pump cannot load `pump/workflows.json` (for example `enabled` or `runs_untrusted` is not a real boolean), so it dispatches nothing. | Fix the file; the details name the entry. |
| `sandbox-breaker` | The nightly sandbox conformance status is red, stale or unreadable ("The sandbox breaker" above). Red: an enabled lane runs third-party code and the pump is holding it. Amber: it would hold lanes, but none is enabled; or it is closed but an enabled lane pins another sandbox commit than the nightly tested. | Open the linked `conformance-nightly` run and follow "To clear it" above. For a pin difference, bump the lane's sandbox pin and `sandbox_sha`. |

If the issue is missing, the next watchdog run creates it. If pinning fails
(the App may not be allowed to pin), pin it once by hand.

## Archive of history artifacts

History artifacts are kept by GitHub for 30 days. `scripts/archive-pull.mjs`
copies them to a folder you keep, on any machine with Node 22.13 or newer:

```sh
node scripts/archive-pull.mjs --dest /path/to/tool-qa-history            # pull what is new
node scripts/archive-pull.mjs --dest /path/to/tool-qa-history --dry-run  # list only
```

It needs a token that can read this repository's Actions artifacts:
`GITHUB_TOKEN` or `GH_TOKEN` (a fine-grained token with Actions: read on
`tool-qa` is enough), or else the token of a signed-in GitHub CLI. It copies
every artifact named `history-*` or `registry-*` that is not in the folder's
`index.ndjson` yet, checks each file against the sha256 in the artifact's
manifest, and writes it to `<dest>/<artifact name>/`. It never overwrites or
deletes anything in the folder. An artifact that fails a check is left out and
tried again next time, and the command exits 1. `<dest>/.last-pull.json` keeps
its place; each run looks back one hour before it.

To run it every six hours on a Mac, save this as
`~/Library/LaunchAgents/ai.isokron.tool-qa.archive-pull.plist` (adjust the
paths) and load it with `launchctl load` on that file:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.isokron.tool-qa.archive-pull</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/src/tool-qa/scripts/archive-pull.mjs</string>
    <string>--dest</string>
    <string>/Users/you/archive/tool-qa-history</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/tool-qa-archive-pull.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/tool-qa-archive-pull.log</string>
</dict>
</plist>
```

`PATH` is set so the job can find the GitHub CLI for its token. Check the log
after the first run; a full first pull of 30 days takes a while, because it
paces itself under the API limits.

## Result encryption keys

Workers encrypt their result bundles with [age](https://age-encryption.org) to
one public key; ingest decrypts them with the matching identity (secret key).
Ingest also encrypts its own outputs to that key, so only the identity holder
can read them.

Create the pair on a trusted machine, not in CI:

```sh
age-keygen -o ingest-identity.txt   # writes the identity, prints the public key
age-keygen -y ingest-identity.txt   # prints the public key again
```

1. Put the public key (`age1...`) on its own line in
   [`worker-kit/ingest.pub`](../worker-kit/ingest.pub), in place of the
   current one (lines starting with `#` may stay), and in
   [`state/state.pub`](../state/state.pub) (see "State encryption"), and
   merge it. Workers use the key in the tool-qa commit they pin.
2. Store the identity as the secret `AGE_IDENTITY` in the environment `loop`:

   ```sh
   gh secret set AGE_IDENTITY --env loop --repo isokron-ai/tool-qa < ingest-identity.txt
   ```

3. Keep one offline copy of the identity somewhere safe, then delete the file.
   Never commit it, and never paste it into an issue, a log or a workflow.

`worker-kit/ingest.pub` holds the real key. If it ever holds no key (only
`#` comment lines, the placeholder it once shipped with), the worker action
refuses to upload, the pump judges nothing and dispatches no work (each run
fails with `pump: ingest is not ready ... worker-kit/ingest.pub has no age
public key yet (it is still the placeholder) ...`), and the manual re-ingest
exits 1 without judging anything. The same happens, before anything is
fetched, if `AGE_IDENTITY` is missing or is not the identity of a key in
`ingest.pub`, so a wrong secret never turns into a series of
`decrypt_failed` rejections.

**Rotation.** Set `LOOP_SLOTS=0` so no new work goes out, and wait until the
pump has judged every running worker (no open dispatches: `ingest: checked 0`
or no `ingest:` lines in the pump log). Create a new pair, add the new public
key to `state/state.pub` (keep the old one) and merge, and let one pump
housekeeping run push the state, now encrypted to both keys (see "State
encryption"). Then set `LOOP_ENABLED=false`, put the new public key in
`ingest.pub` (and drop the old one from `state/state.pub`) and the new
identity in `AGE_IDENTITY` together, update the tool-qa pin in every worker
repo, and turn the loop back on. A bundle encrypted to the old key after that
is rejected as
`decrypt_failed`. If the identity may have leaked, rotate at once: it can read
every bundle and every sealed ingest output encrypted to it, and every copy
of the state asset encrypted to it.

**Reading ingest outputs.** Each pump run that sealed any outputs uploads one
artifact `ingest-<run id>-<run attempt>` (kept 30 days) holding one
age-encrypted tar per judged item, `ingest-<attempt>-<index>.tar.age`
(`<index>` is the item's position in the shard, from 0), and
`ingest-<attempt>.tar.age` for an attempt refused before any item was judged.
To find the run that judged an attempt, search the pump logs for its attempt
id (the `ingest:` lines). A manual re-ingest uploads `ingest-<attempt>`
instead, one tar with every item it judged. Download
it from the run's page (or with `gh run download`; unzip it if it arrives
zipped), then:

```sh
age --decrypt -i ingest-identity.txt -o ingest.tar ingest-<attempt>-<index>.tar.age
tar -tf ingest.tar    # accepted/<attempt>/<index>/..., rejected/<attempt>/<index>/... or quarantine/<attempt>/<index>/...
```

`ingest.json` in there is the report. For a rejected or quarantined item,
`result.tar.age` is the worker's bundle as uploaded; it decrypts with the same
identity. A quarantined bundle holds a secret or a canary in the clear: open it
only on a trusted machine and never publish it.

The pump uploads the artifact at the end of the job, after it has pushed the
state, and also when the pump step failed. If the job is lost before the upload
(a lost runner, a job timeout), decisions it already pushed stay recorded but
their outputs are gone; judging the attempt again does not bring them back,
because items that already have a result are skipped.

## Manual re-ingest

The pump judges every finished worker run itself. The workflow
[`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml) is a tool for
the attempts it did not judge, for example one whose run it never found (no run
id came back from the dispatch and no run named `shard <shard id>` turned up
before the lease expired), one that finished more than six hours after its
lease expired, or one that kept failing with an error in the pump log. It judges one attempt with the same
checks (details: [`ingest/README.md`](../ingest/README.md)) and records a
decision for each of its items that has none yet.

It writes the state, so **pause the pump first**:

1. Set `LANE_PUMP_ENABLED=false` and wait until no pump run is in progress
   (Actions → pump). The workflow refuses to run (red, "pause the pump first")
   while the pump lane is on.
2. Run it with the worker repo, the worker run id and the attempt id:

   ```sh
   gh workflow run ingest.yml --repo isokron-ai/tool-qa \
     -f repo=isokron-ai/mcp-check -f run_id=123456789 -f attempt_id=att-1
   ```

3. Read the notice line of the run, and the sealed outputs it uploaded as
   `ingest-<attempt>` ("Reading ingest outputs" above).
4. Set `LANE_PUMP_ENABLED=true` (or delete it). The schedule starts the pump
   again within 30 minutes, or run it by hand.

The ingest job runs in the `pump` concurrency group, so it never overlaps a
pump run. GitHub keeps at most one waiting run per group and cancels the older
one when another queues. The pump's schedule queues a run every 30 minutes,
even while its lane is off (that run then stops at once), so a re-ingest that
is still waiting when it fires is cancelled: **if the ingest job shows as
cancelled, run the workflow again.** Run one attempt at a time. Once the job
holds the group it checks the kill switches and the pump lane again (they may
have changed while it waited) and stops, red and having judged nothing, if
the loop or the ingest lane is now off or the pump is back on.

| Name | Kind | Where | Needed |
|---|---|---|---|
| `AGE_IDENTITY` | secret | environment `loop` | yes (see "Result encryption keys") |
| `APP_ID` | variable | repository or environment `loop` | optional: the run and its artifact are then read with a short-lived GitHub App token for the one worker repo (`actions: read`) |
| `APP_PRIVATE_KEY` | secret | environment `loop` | with `APP_ID` |
| `LANE_PUMP_ENABLED` | variable | repository | must be off (set and not `true`) |
| `LOOP_ENABLED`, `LOOP_PAUSE_UNTIL`, `LANE_INGEST_ENABLED` | variables | repository | kill switches; the workflow runs the guard with `--no-slots`, so `LOOP_SLOTS` does not stop it |

Without `APP_ID` the run's own token reads the artifacts, which can only work
for public worker repos (not yet tried in CI).

The job pulls the state asset, judges, uploads the sealed outputs, and pushes
the state only if a result was recorded, after the upload. A run is green for
every decision (accepted, rejected, quarantined, pending, already recorded):
see the notice line and the step outputs. It is red for operational errors
(GitHub unreachable after retries, bad configuration, state problems), and
then nothing is recorded. `pending` means the worker run is not finished yet:
run it again later (or let the pump judge it). Running it again for a recorded
attempt does nothing. A result whose lease has expired is stored as rejected.
If the dispatch is still open afterwards, the pump closes it on its first tick
back.

