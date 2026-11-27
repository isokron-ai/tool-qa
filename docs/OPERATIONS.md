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

Every loop workflow runs the guard first (`scripts/guard.mjs --job <job>`), so `LOOP_ENABLED` and
`LOOP_PAUSE_UNTIL` stop all of them, and each has its own lane switch. In this repository:

| Workflow | Lane switch | Slots |
|---|---|---|
| `pump.yml` | `LANE_PUMP_ENABLED` (also `LANE_STATE_PRUNE_ENABLED`, `LANE_SUBJECT_IDS_ENABLED`, `LANE_HISTORY_REGISTRY_ENABLED` and `LANE_LIVE_SNAPSHOT_ENABLED` for the steps the pump runs) | `LOOP_SLOTS`: 0 = housekeeping only |
| `watchdog.yml` | `LANE_WATCHDOG_ENABLED` | no; `LOOP_SLOTS=0` means no pump is expected |
| `ingest.yml` (manual) | `LANE_INGEST_ENABLED`; also refuses to run unless `LANE_PUMP_ENABLED` is off | no |
| `history-registry.yml`, `history-packages.yml`, `history-popularity.yml` | `LANE_HISTORY_REGISTRY_ENABLED`, `LANE_HISTORY_PACKAGES_ENABLED`, `LANE_HISTORY_POPULARITY_ENABLED` | no |
| `meta-github.yml`, `meta-registry.yml`, `release-diff.yml` | `LANE_META_GITHUB_ENABLED`, `LANE_META_REGISTRY_ENABLED`, `LANE_RELEASE_DIFF_ENABLED` | no (source-only lanes) |
| `state-snapshot.yml` | `LANE_STATE_SNAPSHOT_ENABLED` | no |
| `offsite-backup.yml`, `keep-forever.yml` | `LANE_OFFSITE_ENABLED`, `LANE_KEEP_FOREVER_ENABLED` | no |
| `ledger.yml`, `perf-baselines.yml` | `LANE_LEDGER_ENABLED`, `LANE_PERF_ENABLED` | no |
| `publish-results.yml` | `LANE_PUBLISH_RESULTS_ENABLED`, and `RESULTS_PUBLISH_ENABLED` must be exactly `true` | no |

The worker lanes that run third-party code or scan servers live in their own repositories and
read variables there, not here: `LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` and the lane switch in
`mcp-check` (`LANE_SCAN_STATIC_ENABLED`, `LANE_LIVE_PROBE_ENABLED`) and in
`mcp-writecheck-action` (`LANE_WRITECHECK_ENABLED`). Whether the pump dispatches a lane at
all is `enabled` in `pump/workflows.json`. A lane switched off in its repository fails nothing: its
runs end as a notice.

`chaos-soak.yml`, `test.yml`, `lint.yml`, `lint-workflows.yml` and `meta-fixture.yml` are CI: they read no switch and never touch the live loop (the soak plays schedules against a simulated GitHub; the fixture run reads public data and uploads a 3-day artifact the pump never ingests).

The three history workflows capture public data and don't work in slots, so
they run the guard with `--no-slots`: `LOOP_SLOTS=0` does not stop them. Use
`LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` or the lane switch for those. The same goes
for the manual re-ingest workflow (see "Manual re-ingest").
The off-site backup (`offsite-backup`, "Off-site backup") also runs the guard
with `--no-slots`; its lane switch is `LANE_OFFSITE_ENABLED`. The keep-forever
copy (`keep-forever`, "Data retention") does the same, with
`LANE_KEEP_FOREVER_ENABLED`.

The publish workflow (`publish-results`, docs/PUBLISHING.md) is off unless
`RESULTS_PUBLISH_ENABLED` is exactly `true`, and then also obeys `LOOP_ENABLED`,
`LOOP_PAUSE_UNTIL` and `LANE_PUBLISH_RESULTS_ENABLED`; it does not use slots.

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

Since loop upgrade #14 `push` gzips the database before it encrypts it (a
state database compresses about 4x), and checks that the gzip reads back to
the same bytes first. `pull`, the watchdog and the restore drill tell the two
forms apart after decrypting by their first bytes, so an asset or snapshot
from before compression still reads. `push --no-compress` writes the old form;
it is only for going back to code from before #14 ("State pruning and size",
"Going back").

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
artifacts, the sealed ingest outputs and the sealed state archives
(`ingest-state-archive-*`, "State pruning and size") only, and needs no key.

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

## State pruning and size

The state grew by about 2.2 KB per attempt and nothing removed rows (1.0 MB at
350 attempts, 3.3 MB at 1,400). Since loop upgrade #14 the pump moves closed
history out of it ([`state/prune.mjs`](../state/prune.mjs),
[`pump/prune.mjs`](../pump/prune.mjs)), and records its size every run.

**What stays, and why.** A row leaves only when nothing the loop decides reads
it any more:

| Table | Kept | Because |
|---|---|---|
| `counters` | always | the fence counter only grows |
| `subjects`, `results`, `runs` | always | `results` holds the latest accepted result of every run_key, with coverage, fault, `assessed_at`, `measured_at` and `skips_streak`; the due list and `ever_assessed` read all of them |
| `dispatches`, `dispatch_items` | while open, and for 7 days after they closed | ingest still judges a late result for 6 hours after an expired dispatch closed (R-CHAOS-02), duplicate detection and `getAttempt` read them; worker artifacts last 3 days, so after 7 nothing can be judged or re-ingested |
| `leases` | for every run_key a kept item names, and while held and unexpired | fencing and stale-fence detection for in-flight and late work. A run_key with no lease row gets a fresh fence from the counter, as one never leased |
| `attempts` | while their dispatch is kept; and, however old, every counted rejection after the run_key's last acceptance and every `retry_later` / `retry_throttled` after its last measured result | duplicates and late results; parking (`max_rejections`), the retry budget, the throttle window and the backoff count exactly these |
| `slot_ledger` | open rows always; released rows for 7 days | |
| `run_keys` | the run_key(s) of each (subject, workflow)'s newest result, any run_key a kept item names, and while it has a lease | the due list reads the newest result's fields; a run_key's fields are a function of the key, so one due again is recorded again unchanged |
| `kv` | everything but `ingest.failures:<attempt>:<index>` of a pruned dispatch | the API budget and rate-limit blocks, pauses, the breaker memory, the successor and the seed state are never touched |
| `events` | for 8 days (the cutoff plus a day); the newest row always | the live loop view's 7-day windows read them, and nothing the loop decides does. Keeping the newest row means the events' max id (the live snapshot's `seq`) never goes back. About 3,000 rows (~150 bytes each) a day at `LOOP_SLOTS=2`: ~4 MB at the cutoff, ~25 MB at 15 slots |

The prune age is 7 days and can never be set below the late-result window plus
an hour. A test builds weeks of history with every kind of result and checks
that every reader (the due list, parking, the retry counters and backoff, the
late-result query, `getAttempt` of every dispatch left, fencing, in-flight
work, slots, results) answers the same before and after
(`test/state-prune.test.mjs`).

**How a pass runs.** At the end of each pump run, before the last push, and
never after a push that failed:

1. If an earlier run staged an archive, the pump looks for that artifact on
   that run (an installation token with `actions: read`), downloads it, checks
   its sha256 against the note in the state, decrypts it with
   `AGE_IDENTITY` and reads every row back. Only then does it delete, in one
   transaction, each archived row that is still exactly as archived and still
   meets its rule. Then it runs `VACUUM` if at least a tenth of the file (and
   256 KiB) is free.
2. If no archive is waiting, it selects the next rows (oldest first, at most
   50,000 rows and 30 seconds) and writes them as one archive into
   `--state-archive-out`; `pump.yml` uploads it as the artifact
   `ingest-state-archive-<run id>-<run attempt>` (90 days). Nothing is deleted
   in this run.

An archive that is not on its run within 6 hours, or does not read back, is
given up: nothing is deleted, the `state-size` check turns amber once, and the
rows are staged again. If a run dies after staging but before its push, the
archive is uploaded but not noted; the rows are staged again later, so an
archive can hold rows another one holds too. Readers keep one copy per table
and key.

**The archive.** `state-archive-<run id>-<attempt>.tar.age`, age-encrypted to
`state/state.pub`, holds `state-archive.json` (what it is: the cutoff, the
schema version, the run, rows per table, the sha256 of the rows) and
`rows.ndjson.gz`, one `{"table", "row"}` line per row with every column. The
artifact name starts with `ingest-`, so the archive pull and the off-site
backup copy it like the ingest outputs, unchanged. To read one:

```sh
age -d -i ~/.isokron/loop-age-identity.key state-archive-<run>-1.tar.age | tar -xOf - rows.ndjson.gz | gunzip | head
```

**Switch.** `LANE_STATE_PRUNE_ENABLED` (repository variable): unset, empty or
`true` is on; anything else stops staging and deleting. The size is still
recorded.

**The size metric.** Every pump run records kv `state.size`: database bytes,
free pages, rows per table, the size of the asset it pulled, and the last
prune result (kv `state.prune.last`). The watchdog's `state-size` check reads
it, with the size of the asset it pulled and the total of the
`state-snapshots` release. The thresholds: the pump refuses a state that
decrypts or decompresses to more than 1 GiB (GitHub's own limit is 2 GiB per
asset), so the database is amber over 256 MiB and red over 768 MiB; the
off-site backup holds at most 8 GB and copies every snapshot, so the snapshot
release is amber over 2 GB and red over 6 GB.

**Going back.** A pump from before #14 cannot read a gzipped asset. To go back:
pause the pump (`LANE_PUMP_ENABLED=false`) and wait until no pump run is
going, then with this code `pull` and `push --no-compress` the state, then
merge the revert, then turn the pump back on. Pruned rows stay in their
archives; nothing needs them back. To stop pruning without going back, set
`LANE_STATE_PRUNE_ENABLED=false`.

**Going back past schema v10 (the events table).** The first pump run with
v10 code migrates the state, and code from before it (the pump and the
watchdog) refuses a v10 state ("newer than this code"). To roll back, either
restore the last v9 snapshot with `snapshot/restore.mjs` ("State snapshots";
the runs since then are lost), or merge a revert that keeps
`state/schema-v10.sql` and `SCHEMA_VERSION = 10` so the state stays readable
and only the event writes go. A failed event insert never blocks its fact: it
is counted in kv `events.insert_failures` (`{ count, last_at, last_type }`)
and logged as one line, `state: event <type> not recorded`.

## State snapshots

The state asset is overwritten on every pump run, so on its own a damaged or
deleted asset would start the loop from empty. The pump refuses to: when the
state asset is missing but the `state-snapshots` release holds snapshots, a
pump run fails with "the state asset is missing, but N snapshot(s) of it are
on the "state-snapshots" release" and dispatches nothing (R-CHAOS-01); restore
one (below). A pump run that cannot read the state (missing, damaged,
encrypted to another key, or from newer code) also cancels the successor it
dispatched, so the chain stops instead of failing once a minute; the schedule
and the watchdog try again every 30 minutes or so, each a red run, until a
person fixes it (R-CHAOS-03). A passing GitHub error while pulling does not
stop the chain.

To start from an empty state on purpose, keep the snapshots (they are the only
way back) and put a fresh state in place by hand instead (R-CHAOS-11). With
the pump switched off (`LANE_PUMP_ENABLED=false`) and no pump run going:

```sh
node --input-type=module -e "import('./state/db.mjs').then((m) => m.openState('fresh.sqlite').close())"
GITHUB_TOKEN=<a token that may write this repository's releases> \
  node scripts/state-asset.mjs push --file fresh.sqlite --force --repo isokron-ai/tool-qa
```

The push encrypts to `state/state.pub`; `--force` is needed because there was
no pull. Then switch the pump back on. Do not delete the snapshots to get past
the refusal.

The workflow
[`state-snapshot.yml`](../.github/workflows/state-snapshot.yml) keeps
versioned copies ([`snapshot/snapshot.mjs`](../snapshot/snapshot.mjs)):

- **When.** Every hour at minute 41, and on `workflow_dispatch`. The GitHub
  schedule on this repository has not fired reliably, so the operator's
  stand-in scheduler (the Mac script that also dispatches the history
  workflows) dispatches it every hour too, unless a run started in the last
  50 minutes. Two runs in one hour do no harm: the second finds the state
  unchanged.
- **Where.** The pre-release tagged `state-snapshots`, as
  `state-<UTC time>-<first 8 hex of sha256>.sqlite.age` (for example
  `state-20261124T034100Z-6e511772.sqlite.age`), each with the label
  `sha256:<hex>`, plus `manifest.json`: for every snapshot its time, sha256,
  size, and the source asset's id and `updated_at`; and `current_at`, the last
  time a run saw the newest snapshot equal the live state.
- **Still encrypted.** A snapshot is the state asset's age ciphertext, byte for
  byte. The workflow holds no key and never decrypts; its job has only
  `contents: write` and no environment or secrets. Since loop upgrade #14 the
  pump gzips the database inside the encryption, so snapshots are about a
  quarter of the size; older ones stay as they were, and the drill reads both.
- **Copy check.** The run downloads the live asset, checks the bytes against
  its `sha256:` label, and checks the asset is still the same one (id, label,
  `updated_at`) after the download. If the pump pushed in between, it copies
  once more; if it loses that race again, the run ends with a notice (exit 0)
  and the next run tries again (the health item turns amber if this goes on).
  It refuses an asset with no label or that is not age ciphertext. Each new
  snapshot is downloaded back and checked before the manifest names it; if the
  read-back fails in any way, the upload is deleted.
- **Trust.** Only verified snapshots count, for dedupe and as "newest". A
  snapshot asset the manifest does not list (a lost manifest, a delete that
  failed) is downloaded and checked against its name and label first: added
  back if it passes, deleted if it fails, left for the next run if it cannot be
  read. Malformed manifest entries are left out, a snapshot's time always comes
  from its name, and one dated in the future is ignored.
- **Dedupe.** If the newest snapshot already has the live sha256, nothing is
  uploaded; only `current_at` in the manifest moves on.
- **Retention.** The 24 newest snapshots, plus the newest snapshot of each UTC
  day of the last 14 days and of each UTC week (Monday to Sunday) of the last
  8 weeks; the rest are deleted. The newest is never deleted. The count is of snapshots,
  not hours: an idle loop makes no new ones, so it never ages out the copies
  it would need. The manifest is written before anything is deleted, and the
  next run picks up any asset a failed delete left behind.
- **Switches.** `LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` and
  `LANE_STATE_SNAPSHOT_ENABLED`, like every loop job. While the loop is
  stopped the state does not change, so nothing is lost.

**Health.** The watchdog reads the manifest and shows a `state-snapshot` check
on the health issue: amber when `current_at` is more than 3 hours old, when
there is no snapshot yet, when the release or its manifest is missing or
unreadable, or when `current_at` is more than 5 minutes in the future; red after
6 hours ("The loop health issue" below).

**Restore drill.** [`snapshot/restore.mjs`](../snapshot/restore.mjs), on an
operator's machine with age installed and the state identity (default
`~/.isokron/loop-age-identity.key`, or `--identity <file>`; it is never
printed):

```sh
node snapshot/restore.mjs list
node snapshot/restore.mjs drill                      # the newest snapshot
node snapshot/restore.mjs drill --snapshot state-20261124T034100Z-6e511772.sqlite.age
```

`drill` downloads the snapshot, checks its sha256, size and name against the
manifest, decrypts it into a private temporary directory, checks that SQLite
opens it and that `PRAGMA integrity_check` says `ok`, and prints the schema
version, the fence counter and the row count of every table (subjects and
results first). The decrypted copy is deleted before it exits. If the manifest
is lost, `list` still shows the snapshot assets (marked as not in the
manifest), and `drill --snapshot <name>` checks one against its own label. It needs no
token for a public repository (it uses `GITHUB_TOKEN` or `gh auth token` if
there is one). Run it after any change to the state code, and now and then
anyway: a backup nobody has restored is a hope, not a backup.

**Restore for real** (`drill --apply`). First stop the pump: set
`LANE_PUMP_ENABLED=false` (or `LOOP_ENABLED`, or `LOOP_PAUSE_UNTIL` at least 10
minutes ahead) and wait until no `pump` or `ingest` run is queued or running.
`--apply` checks both and refuses otherwise. It reads the switches as the pump
job sees them (environment `loop`, then the repository, then the organization
variables shared with it); if any of those reads fails, it refuses. It also
refuses while a `state-snapshot` run has not finished. It needs a token that
can write releases and read variables (`gh auth token` of an admin). It then:

1. takes a normal snapshot of the live state, so the restore can be undone (if
   the live asset cannot be copied, it says so and goes on);
2. uploads the chosen snapshot's ciphertext, unchanged, under a temporary name;
3. checks the live asset is still the one it saw, and stops without changing
   anything if not;
4. renames the live asset, whatever its name (after an interrupted push it is
   a `state.sqlite.upload-*`), to `state.sqlite.replaced-<time>` (the pump
   never reads that name; delete it by hand once you no longer need it),
   deletes any other stale uploads, and renames the upload to `state.sqlite`.

Then switch the pump back on. Its next run pulls the restored state. Work the
loop did after the snapshot is not in it: dispatches sent since then are
unknown to the restored state, so their results are not ingested and their
subjects come due again. Fences issued after the snapshot can be issued again,
but a result is matched on its attempt id as well as its fence, and attempt
ids are random for every dispatch, so an old bundle is never taken for a new
dispatch.

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
- **What is written.** id `owner/name` as the seed spells it when the
  subject is first seen (the subject key, frozen: see "Subject ids"), kind
  `github`, source `seed-v1` (set when the subject is first seen), and a
  tier. A seed row is matched to its subject by the subject's current name,
  then its key, then a name it had before (case aside), so a rebuilt seed
  that spells a renamed repository by its new name keeps its subject. The commit SHA is left empty: the scan-static worker reads the head of
  the default branch itself. A SHA or digest set by another writer is kept.
- **A seed that cannot be read or is malformed** (no `size`, a `size` that
  does not match, a duplicate id, an id that is not `owner/name`, an unknown
  population) is refused whole. So is a state error during the load. Nothing
  is written, the subjects already in the state stay, and the run fails (red)
  with `pump: subjects: seed not loaded, ...`. The pump keeps dispatching the
  subjects it already has; the health issue shows the `subjects` check red
  with the reason (kv `pump.subjects`, R-SUB-11). kv `subjects.seed` records
  the path actually loaded (`file`).
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

**Skips only (R-SUB-06, R-SUB-08, R-SUB-10).** An accepted result whose
skips were all retryable (its retries ran out) and that measured nothing (no
observation with a value, null observations do not count, and no `results/`
file other than a skip's own `evidence`) is stored with outcome `skips_only`.
It is due again (reason `skips_only`) after `skips_only_max_age_days` (1 day)
for the first such result in a row, then 2, 4, 8 ... days, never later than
the tier max age. A result with any permanent skip (`remote_only`,
`no_runnable_artifact`, `policy_excluded`, ...), even beside a retryable one,
keeps the tier max age.

A `skips_only` result does not start the retry counters over: the three
`retry_later` retries and the 7-day `retry_throttled` window count from the
run_key's last result that measured something (`results.measured_at`), so a
subject that never works gets one window and then a few backed-off looks,
not a new window every day.

**Coverage gaps (R-COV-02, R-COV-03, R-COV-05..07).** Ingest stores each
result's fault side and coverage state (`results.fault`, `results.coverage`;
see `worker-kit/README.md`). A skip caused by our own tools (an unsupported
language or layout, a reader limit, no tool found, a size cap of ours, a
tool error) is `unassessed_tool`: our limit, never excluded and never the
server's failure. The due list adds a coverage-gap boost of
`priority.coverage_gap_share` (0.5) x the tier weight, capped one point under
the weight gap to the next tier up, to a due pair that:

- has no result yet, or was never assessed and last hit a rate limit or
  outage (`never_assessed`); or
- last ended in our own limit (tool or unknown fault) and something moved
  since: a new tool version, a new subject version or a change event
  (`our_limit`). A tool-limit skip that is merely stale is not boosted: the
  same tool on the same version would give the same skip.

With the shipped `tiers.json` the boosts are T0 +50, T1 +30, T2 +19 (0.5 x
40 = 20 would tie the 20-point gap to T1), T3 +10, T4 +5. With equal reasons
and age, a boosted pair stays below a bare pair of the tier above; an older
result or a heavier reason can still lift it over. Example: after an
mcp-check release, a T3 subject (weight 20) whose last scan-static result was
a reader limit is due with `tool_version` (+20) and gets +10, ahead of the
T3 subjects whose results were graded. The boost only orders due pairs. A
first-sight pair has no reason weight and no age, so it goes ahead of a stale
pair of its tier only while its boost beats stale's 10 points plus the stale
result's age: always in T0, in T1 while the stale result is under 20 days
old, never in T2 to T4. Results recorded before state schema 7 have no
coverage: they get no `our_limit` boost, and one that was not `skips_only`
counts as assessed.

**Oracle disagreement (loop upgrade 7, R-ORD-01..18).** Where our reader
(scan-static), the live tool list (live-probe) and the official SDK clients
or conformance suite disagree, our tools are weakest there, so those subjects
are looked at sooner and their fingerprints weigh more. The pieces:

- *The signal* (`state/oracle.mjs`, state schema 9). Ingest reads the facts of
  every accepted scan-static and live-probe bundle (tool count, whether the
  reader's list is complete, `sdk_client_results`, failed scored
  `conformance_checks`, the worker's `oracle_disagreements`) and
  `StateDb.noteOracle()` keeps the latest per (subject, lane) in
  `oracle_facts`, with the subject version (sha, else artifact digest) they
  were read at. It then derives one row per subject in
  `oracle_disagreements`: `kinds` (`tool_count`: reader and live list differ,
  or an SDK client listed another count; `tool_set`, `schema`, `protocol`,
  `conformance`: from the SDK clients' results and the worker's own
  comparisons, made within the live-probe lane), with the oracles involved,
  and a signature of those. **Across lanes only the tool count is compared,
  and only when the reader's list is complete** (R-ORD-11): scan-static and
  live-probe use the same catalog hash, but the reader derives its list from
  source, so a different hash alone says nothing. **Lanes are compared on one
  subject version only** (R-ORD-12): facts of an older version are stale and
  left out, and a lane's row is dropped when a newer-version result of that
  lane has no facts. **A subject with no version** (neither sha nor artifact
  digest) has nothing to tell its lanes' versions apart, so its two lanes are
  compared only when observed within `ORACLE_UNVERSIONED_WINDOW_MS` of each
  other (12 hours, `state/oracle.mjs`; R-ORD-16): a due re-check sends both
  lanes within a pump pass or two, while a server with no pinned version can
  change at any deploy. Outside the window nothing is compared across lanes
  (the live lane's own SDK and worker comparisons still count) and it is
  compared again when the lanes next report close together. **A late result
  is refused** (R-ORD-17): one observed before its lane's stored facts (the
  run's completion time, else the receive time) changes neither the facts nor
  the record, so an older version cannot overwrite a newer one. Counts moving
  does not change the signature. Until
  live-probe is switched on only the reader side exists, so there is nothing
  to disagree with and no row; it fills in as results arrive.
- *Fault side.* A disagreement is evidence about our tool, never the
  subject's: it writes nothing to `results.fault` or `results.coverage`, is
  not a coverage gap, and the check-in makes no fingerprint of it. Where an
  oracle shows the server is wrong (a worker entry with `attribution:
  server`, or a failed conformance check while the clients and our reader
  agree) it is kept as `server_side` evidence and opens nothing.
- *Priority* (`pump/due.mjs`, `priority.oracle_*` in `pump/tiers.json`). A
  subject whose record is `open` gets, on its oracle lanes (`oracle_lanes`:
  scan-static, live-probe): (1) a due reason `oracle_recheck` (15 points)
  once its last result is older than `oracle_recheck_days` (1), well before
  the tier max age; (2) a boost of `oracle_disagreement_share` (0.25) x the
  tier weight (T0 +25, T1 +15, T2 +10, T3 +5, T4 +2.5). **Order, all inside
  one cap:** the coverage-gap boost is taken first; then the
  `oracle_recheck` reason's points, cut to what is left; then the oracle
  boost, which gets what is left after both. The cap is `gapBoostCap()`, one
  point under the gap to the next tier up, so with equal other reasons and
  age a pair never reaches a bare pair of the tier above (R-ORD-02,
  R-ORD-14). Example, T1 (cap 39): a coverage gap (+30) leaves 9 for the
  reason, and the oracle boost gets 0; T2 (cap 19): reason 15, boost 4. The
  boost orders due pairs; only `oracle_recheck` makes a pair due, and a
  disagreement never moves a run_key.
- *Clearing.* A re-check is one check cycle: a result from every lane that
  has current facts (one result of one lane is not a cycle; R-ORD-13). The
  record clears when the oracles agree (kept with `cleared_at`; a later
  disagreement reopens it as a new episode). The same disagreement (same
  signature) surviving `ORACLE_MAX_UNCHANGED` (5) cycles is `settled`: the
  boost and the re-checks stop until the signature changes, so a server whose
  tools are registered at run time from config (which the reader cannot know)
  does not get looked at every day for ever. A changed signature starts over.
  A rolling budget stops flapping: at most `ORACLE_BUDGET_MAX` (6) cycles with
  a disagreement, counting each reopening, per `ORACLE_BUDGET_DAYS` (30) per
  subject, however often it clears; beyond that it is `settled` with reason
  `recheck_budget`, which a settled record keeps (R-ORD-18).
- *Check-in* (`longitudinal/checkin.mjs`). It derives the same signal from
  each subject's latest facts in the archive. A subject with an open
  disagreement counts `oracle_multiplier` (1.5) times as much in every
  fingerprint it is still affected by, so a fix that unlocks such subjects
  ranks higher; each fingerprint shows `oracle_subjects`, and the summary
  lists the disagreements by kind. The check-in compares lanes on one subject
  version only, like the store, and ignores the settle rule and the budget:
  it has no re-check count.
- *Watching it.* `SELECT subject, status, kinds, unchanged_rechecks FROM
  oracle_disagreements` (state read access) or `db.listOracleDisagreements()`;
  due items of an open one carry `oracle: [kinds]`. Pruning never touches
  these tables (like `results`, they are small and current).

**Throttling (R-SUB-04, R-SUB-09).** A result whose every skip is a
retryable `rate_limited` or `upstream_unavailable` from a third-party stage
the lane declares is sent back as `retry_throttled`. It does not use up the
three `retry_later` retries: it is sent out again after the usual backoff,
capped at `retry_backoff_max_minutes` (6 hours), for up to 7 days after the
run_key's first throttled retry. Only then is it kept as a skip.

A lane declares those stages in `pump/workflows.json` as `throttle_stages`:
`"stage"` (both reasons) or `"stage:reason"` (that reason only). The
subject's own fetch or probe is never declared, because a slow or hostile
subject could otherwise hang or answer 5xx to keep itself out of the counted
retries. scan-static declares `static:rate_limited`: its only stage reads the
subject from the GitHub API, and a GitHub rate limit (429, or a 403 with
`x-ratelimit-remaining: 0` or `retry-after`) is the shared token budget,
which a repository cannot cause; its `upstream_unavailable` (timeouts, broken
reads, 5xx) stays a counted retry. The lanes that run third-party code declare
nothing yet; add their registry or search stages (for example `registry`,
`mcp_registry_search`) when they are built.

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

## Subject ids (state schema v8)

A subject is keyed by its GitHub repository's numeric id (loop upgrade #15),
so a rename or a transfer never splits a server's history. Three things are
kept apart:

- **The subject key** (`subjects.id`): owner/name as first seen, frozen.
  run_keys are computed from it, so it never moves: a rename makes nothing
  due again, and the upgrade to schema v8 made nothing due again either.
- **The identity** (`subjects.repo_id`, `node_id`, `repo_created_at`):
  GitHub's numeric id, its GraphQL node id and its creation time.
- **The name** (`subjects.name`): what the repository is called now. Workers
  are sent this name (the item's `subject`), so they clone or read the
  repository where it is today.

**Lookups.** At the start of every pump run, after the seed load,
`pump/identity.mjs` looks ids up with GraphQL: subjects without an id by
name (GitHub follows renames and transfers), and bound subjects once a day
by node id (which finds renames, transfers and deletions even when another
repository took the old name). One query holds 100 repositories and costs
one point; at most 4 queries a run, through the pump's API budget (family
`graphql`) with the job's `GITHUB_TOKEN`. The 997 seed subjects take 10
queries to backfill (three pump runs, about 30 minutes) and 10 a day after
that. The log line is `pump: subject ids: ...` and kv `pump.identity` keeps
the last pass; each change is logged as `pump: subject <key>: <event>`.

**Never in the way.** A lookup that fails (rate limit, budget, outage, a bad
answer) is logged and tried again an hour later; the run goes on. A subject
not looked up yet is dispatched by its name, as before v8.

**What a lookup can find** (each is a row in `subject_events`):

| Event | What happened | What the loop does |
|---|---|---|
| `id_bound` | First lookup. | Records the id. |
| `renamed`, `transferred` | New name, or new owner. | Workers get the new name from the next dispatch. The key, run_keys and results stay. A result sent under the old name and judged after the rename is recorded as usual (by run_key). |
| `not_found` | Deleted, or turned private: no lookup is possible. | A subject-fault skip (`repo_not_visible`, fault `subject`): `gone_at` is set and the subject is not dispatched. Looked up again daily. A batch where more than 5 and more than 20% answer NOT_FOUND is not believed (most likely the token or its permissions changed): nothing is marked gone, those lookups are retried in an hour, and the health issue shows `subject-ids` red. |
| `found_again` | Public again. | `gone_at` cleared; due as usual. |
| `merged` | Two subjects are one repository, with the same id and creation time (a rebuilt seed listed the new name as a new row). | The survivor is the subject with history (results or attempts), else the one first seen earlier, whichever was bound first. If the newcomer was bound first, its binding (id, node id, creation time, name) moves to the survivor in the same transaction. The other is retired with `alias_of` pointing to the survivor, which is active if either was. |
| `id_conflict` | The id answered with another creation time, or a bound subject's id answered another id (an id reused, which GitHub never does); or a first lookup by name found a repository created after the subject was first seen (a newcomer that took the old name: GitHub answers it ahead of the redirect). | Nothing is bound, renamed or merged; the subject keeps being dispatched under its last good name. The health issue shows `subject-ids` amber. Look at it by hand. |

**Switch.** `LANE_SUBJECT_IDS_ENABLED` (repository variable): unset, empty or
`true` runs the lookups; anything else stops them. The ids and names already
found are still used, and the `subject-ids` health item shows `off`.

**Read them.** Pull the state and run
`sqlite3 state/state.sqlite "SELECT id, name, repo_id, id_status, gone_at FROM subjects WHERE name <> id OR id_status <> 'ok'"`
and `SELECT * FROM subject_events ORDER BY id`.

**Health.** The `subject-ids` item on the health issue (watchdog/identity.mjs)
shows the last pass's not-found, conflict and merged counts: red when a pass
stopped on a mass of NOT_FOUND and no batch has been believed since (kv
`pump.identity` carries `mass_not_found_at` forward through runs with nothing
to look up), or when more than 5 and more than 20% of the active subjects are
marked gone; amber on any id conflict.

**Accepting a conflict.** A conflict is sticky: the subject keeps its last
good name and the amber stays until a person decides. Read its `id_conflict`
event (`SELECT * FROM subject_events WHERE subject = '<key>' ORDER BY id`) and
check on GitHub that the repository it found is the one the subject means.
If it is: switch the pump off (`LANE_PUMP_ENABLED=false`) and wait until no
pump run is going, pull the state, run
`node scripts/subject-accept.mjs <key> --state state/state.sqlite`, push it,
and switch the pump back on. The acceptance names exactly the repository the
last `id_conflict` event found (its id and creation time). The next pump run
looks the subject up again, and if the answer is that repository it is bound
(event `id_bound`, with `accepted` saying when and which repository was
accepted), whatever the reuse and squatter guards say; the amber clears with
that run. The acceptance is used up by that one lookup whatever it answers
(not found, an error, another repository: the conflict stands, accept again
if still wanted) and lapses after 48 hours. An id that another subject holds
is still refused: merge or retire one of the two by hand first. If the repository is not the right one, leave the
conflict (the subject keeps being dispatched under its last good name) or
retire the subject.

**The v8 migration** runs in the first pump run with this code, in one
transaction: it adds the columns and `subject_events`, sets every subject's
name to its key and keeps every row. Code from before v8 refuses a v8 state
(`state schema version 8 is newer than this code`), so going back means
restoring the snapshot taken before the merge (see "State snapshots").

**What going back costs.** Restoring the v7 snapshot throws away everything
the loop recorded after it: every result, attempt and dispatch since the
merge, the fence counter's progress, the API budget and every other kv row,
and the ids looked up. Dispatches sent since then are unknown to the restored
state, so their results are never ingested (their sealed ingest outputs stay
in the archive), and that work is due again. The longer v8 has run, the more
is lost; decide early. There is no down-migration: a v8 state could be taken
back to v7 by dropping what v8 added (the R-SUBJ-01 test does exactly that),
but no tool for it is shipped, so if v8 has run for long, prefer fixing
forward (or switching the lookups off with `LANE_SUBJECT_IDS_ENABLED=false`)
to a restore.

## Change detection: subject heads (design audit A3)

Until this, `subjects.sha` and `changed_at` were null on every subject: a
subject was looked at again only on its tier's age, so a release or a new
commit went unseen for up to 30 days. The head poll (`pump/heads.mjs`) writes
both.

**Where it runs.** In the pump, the state's only writer, right after the
subject id pass at the start of every run (so on the pump's own schedule and
self-chain, free public Actions). One GraphQL query reads up to 100 bound
subjects by node id: `databaseId`, `isEmpty`, the default branch's head commit
and `latestRelease`. It costs one point.

**What it writes** (`state/db.mjs` `noteHead`, `noteChange`):

| Seen | Written | Due as |
|---|---|---|
| a head, and the subject has no sha yet | `sha`, `changed_at`, `change_reason = head_first_seen` | `new_version` (the run_key moves once) |
| a head other than the subject's sha | `sha`, `changed_at`, `change_reason = new_sha` | `new_version` |
| the same head, a release published after `changed_at` | `changed_at`, `change_reason = new_release` | `change_event` |
| a node not found, another repository id, a name other than `subjects.name` (renamed since the id pass), an empty repository, an error for that node | nothing (counted in kv `pump.heads`) | not due for it |

Only subjects whose id the id pass vouches for (`id_status = ok`) are polled:
one in conflict keeps an id that may not be the repository its name clones.
A GraphQL error under one node (FORBIDDEN, say) concerns that entry only; an
error only under its `latestRelease` loses the release and keeps the head; an
error with no node path fails the query, which is asked again next run.

A head it cannot read is never a fault of the server: nothing is recorded
against the subject, and gone or renamed repositories stay the id pass's
call ("Subject ids").

**Cadence.** `pump/tiers.json` `head_poll_hours`: T0 every run, T1 hourly, T2
every 6 hours, T3 daily, T4 every 3 days. Each tier is walked in key order from
a cursor in kv `pump.heads` (`tiers`); a new cycle starts once the last one has
finished and started at least that many hours ago. One query mixes tiers, and
T0 takes at most a quarter of a run's picks, so it can never starve the rest.

**Budget.** At most 3 queries a run (300 subjects), through the pump's API
budget (family `graphql`, 30 an hour and 5 a minute, shared with the id pass)
on the job's `GITHUB_TOKEN`, leaving the last 8 of the hourly 30 calls to the
id pass. Before the first query a pass checks GitHub's last known GraphQL
points (kept with the budget across runs) and makes none below 200; it also
stops once an answer reports fewer than 200. The 997 seed subjects need 10 queries
a day plus about one an hour for T0 to T2. A refused or failed query leaves
the cursor where it was: the next run asks again.

**Switch.** `LANE_HEADS_ENABLED`: only the exact value `true` runs the poll.
Off, kv `pump.heads` says `off: true`, and subjects come due on their tier's
age as before. Turning it on makes every bound subject due once
(`head_first_seen`), in tier order: that is the backlog the loop has not been
running.

**Health.** The watchdog's `subject-heads` item (`watchdog/heads.mjs`) reads
kv `pump.heads`: amber when no poll has been written for 6 hours or the last
pass stopped on an error or the budget, red after 24 hours, off when switched
off. A first pass that has not written yet is amber until it is a day old.
Holding points or calls back for others is not an error. The pump logs `pump: subject heads: ...` every run.

**Dry run against the live state.** Pull and decrypt the state into a 0700
temporary folder, then run the pass with a read-only token against a copy:
`node scripts/heads-dry-run.mjs --state <copy>` prints what it would write
and the due list before and after, and never pushes.

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

A result refused for its version pins (`pin_mismatch` or `pin_unverified`;
R-PIN-01, "Version pins" below) pauses its workflow the same way, for an hour,
at the first refusal: `pump: <workflow> is paused until ...: a result was
refused for its version pins`. The worker ran, or did not prove it ran, other
code than `versions` in `pump/workflows.json` names. Bump the pin to what the
worker runs (usually: the worker repository merged without a pin bump), or
fix the worker; nothing was parked, so the work goes out again when the pause
ends.

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

### GitHub outages: retries (R-CHAOS-13 to R-CHAOS-18)

Every GitHub call the pump, the state asset and the state snapshot make goes
through one retry policy (`pump/retry.mjs`). It retries HTTP 500, 502, 503,
504, 429, a 403 that carries a rate-limit signal, and network errors or
timeouts; any other 4xx is final. A call is tried up to 6 times, with
exponential delays and full jitter (2 s base, 120 s cap, 62 s at most per
call). `Retry-After` is honoured up to 60 s; a longer one ends the retries.
All the sleeping of one push or pull is capped (180 s; the snapshot job 300 s)
and a push stops at the run's deadline (the last push of a run may go 90 s past
it), so a retry can never outlast the job. The log shows `retry: <call>: HTTP
502; attempt 2/6 failed, next in 3.1s`.

What is repeated, and what is not: reads, deletes and renames; the successor
dispatch (a repeat only replaces the pending pump run) and token mints; an
upload or a release create, after looking at what the failed one stored (a
complete asset of the same name, size and label is used, a partial one is
deleted). A worker shard dispatch is sent once: a repeat after a 5xx could
start a second run for one lease. The pump still fails closed: it dispatches
nothing it could not save state for, and when the successor cannot be sent it
marks `pump-successor` red and carries on.

### Registry delta capture

GitHub's `*/15` cron for `history-registry.yml` fires hours late at times. Each
pump tick (at most every 5 minutes) therefore checks the newest
`registry-delta-*` artifact; if it is over 15 minutes old and no delta run is
queued or running, the pump dispatches `history-registry.yml` with `mode:
delta` (and `since` if the gap is over 75 minutes). The answer is in kv
`pump.registry_delta`. The cron stays as a second path;
`LANE_HISTORY_REGISTRY_ENABLED=false` stops both.

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
`meta-github`, `meta-registry`, `release-diff`) keep running. The run logs `pump: sandbox
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
| App installation | Organisation settings | `tool-qa` and each worker repository (for example `mcp-check`, `mcp-writecheck-action`). The watchdog's `sandbox-selftest` item needs `mcp-check` and `mcp-writecheck-action` covered: the job `GITHUB_TOKEN` cannot read their job logs (403), so it mints `actions: read` for them. |
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
| watchdog (self tests) | each enabled lane repository that runs third-party code (`mcp-check`, `mcp-writecheck-action`) | `actions: read` | the `sandbox-selftest` item: failed runs, their jobs and the head of the failing self-test job's log (the runner image). A mint failure falls back to the job `GITHUB_TOKEN` and shows amber with the reason |
| ingest (manual) | the one worker repository | `actions: read` | reading that run and its result artifact |

The state asset is pushed with the pump job's own token (`contents: write` on
this repository only) and read by the watchdog with its job token
(`contents: read`).

Create the environment under Settings → Environments → `loop`. Limit
deployment branches to `main`, so no other branch can use the key, and add no
required reviewers (scheduled runs would wait for approval). Each pump and
watchdog run shows up as a deployment to `loop`; that is expected.

## Sampling `mode: sample` tier cells (E12)

A tier cell in `mode: sample` in `pump/tiers.json` (T2 `writecheck`, T3 `scan-deep`, `build-probe` and `writecheck`) is due only when the sampling hook (`pump/sampling.mjs`) picks the pair. The pick is a stable hash of subject id, workflow and ISO week (UTC) under a rate, so every pump run in a week agrees and the sample moves when the week turns. A picked pair runs once a week: a result accepted this week is that week's sample. The due reason is `cell_sample`.

Repository variables, one pair per tier (T1 to T4), passed to the Pump step:

| Variable | Meaning | Unset means |
|---|---|---|
| `SAMPLE_RATE_T<n>` | Share of the tier's subjects sampled per workflow, 0 to 1, a plain decimal (a value above 1 reads as 0) | 0: nothing is sampled |
| `SAMPLE_CAP_T<n>` | Most pairs per workflow per week in that tier (the lowest scores are kept) | 25 |

The shipped state is no variable set, so rate 0 and the due list is unchanged. Opening a tier is a repository variable change by the owner: set `SAMPLE_RATE_T2` (for example `0.1`) and, if wanted, `SAMPLE_CAP_T2`. A lane that is not enabled in `pump/workflows.json` still dispatches nothing. To stop sampling again, unset the variable or set it to 0.

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
| `subjects` | The last pump run could not load the seed subjects (red, with why: an unreadable or malformed seed, the shrink guard, a state error). The pump keeps dispatching the subjects it already has. | Fix the seed file (or set the shrink override, "Subjects: where they come from") and merge. Clears when a pump run loads it. |
| `history-registry-delta` | Newest delta capture is over 45 minutes old (amber), or over 90 (red). | Open the `history-registry` runs. |
| `history-registry-full`, `history-packages`, `history-popularity` | Newest artifact is over 26 hours old (amber), or over 50 (red). | Open that workflow's runs. |
| `state` | No state asset yet, or it could not be read (amber; the details say which). | Normal until the first pump run has saved state. Otherwise check the `state` release; if the pump runs are red too, restore a snapshot ("State snapshots"). |
| `api-budget` | Amber while GitHub rate-limits the pump (a block it saved in `pump.api_budget` is still in force; the details say until when), or its latest tick stopped dispatching or ingest early on its own API budget. Results and dispatches wait meanwhile. Not shown otherwise. | Usually nothing: it clears when the limit resets. If it stays, look for what else spends the App's or the repository's API quota. |
| `slots`, `dispatches` | Rows more than 15 minutes past their expiry (red): the pump is not reaping. | See the `pump` check and the latest pump logs. |
| `run:<workflow>` | The latest scheduled or dispatched run of a loop workflow failed (red). | Open the linked run. Cancelled and skipped runs are ignored. |
| `workflow:<file>` | Amber: GitHub disabled the workflow for inactivity and the watchdog turned it back on. Red: turning it back on failed. Off: someone disabled it by hand. | For red, enable it under Actions → the workflow. |
| `config` | Red: the pump cannot load `pump/workflows.json` (for example `enabled` or `runs_untrusted` is not a real boolean), so it dispatches nothing. | Fix the file; the details name the entry. |
| `archive` | The Mac archive pull's last good run (repository variable `ARCHIVE_LAST_OK`, set by `scripts/archive-pull.mjs`) is more than 12 hours old, or dated in the future (amber); more than 24 hours old, or the variable is empty, not JSON or has no valid `at` (red). `off` when the variable is `off` (stop the Mac's agent first, or its next good pull sets the variable again). | On the Mac: `tail ~/Library/Logs/tool-qa-archive-pull.log`, `launchctl print gui/$(id -u)/ai.isokron.tool-qa.archive-pull`, then `launchctl kickstart` it. See "Archive of history artifacts and ingest outputs". |
| `sandbox-breaker` | The nightly sandbox conformance status is red, stale or unreadable ("The sandbox breaker" above). Red: an enabled lane runs third-party code and the pump is holding it. Amber: it would hold lanes, but none is enabled; or it is closed but an enabled lane pins another sandbox commit than the nightly tested. | Open the linked `conformance-nightly` run and follow "To clear it" above. For a pin difference, bump the lane's sandbox pin and `sandbox_sha`. |
| `sandbox-selftest` | The sandbox self test (`sandbox / sandbox-selftest`, the guard that fails closed) failed on the enabled lanes that run third-party code (live-probe in `mcp-check`, writecheck in `mcp-writecheck-action`). Amber: 2 or more failures in the last 6 hours, or one on a runner image the nightly has not passed on (an image whose log could not be read counts as not passed on), or the lookup failed (`could not read`). Never red: a lane that fails closed ran nothing and uploaded nothing, its items come back `no_artifact` and are retried. Also amber: the run list was truncated and no failure was found; no job named like the self test in the failed runs examined (renamed?); a 404 on a runs list; no token to read with (the log token could not be minted and `GITHUB_TOKEN` is unset: the tool-qa App token is never a fallback). Off when no such lane is enabled. The summary gives the count, the lanes, the runner image version(s), the image the nightly last passed on, and links the newest failing job. Reads: 1 to 3 pages of completed runs per lane (last 7 hours; the API takes one status, so the conclusions failure, timed_out, startup_failure and cancelled are picked here), 1 jobs call per such run (at most 10 per lane), and for each failing job (at most 3 in all) 2 calls: the API's 302 (token) and the blob store (no token, Range). Two calls when nothing failed. The run and job lists are of public repositories; job logs return 403 to the watchdog job's own `GITHUB_TOKEN` for them, so the watchdog mints a second App installation token for the lane repositories with `actions: read` only and reads with that (the App installation must cover them). If minting fails the reads fall back to the job token and the item is amber with the reason (images then read `unknown`). The image is the `Version:` line of the job log's `Runner Image` group, from a ranged read of the first 12 KiB (the Range header holds across the redirect to the blob store: HTTP 206). | Open the linked job. One failure on the image the nightly passed on is a flake: read the self-test telemetry artifact. Several, or all on one new image: a runner image rollout broke the sandbox; compare the image with the nightly status (`runner_image`), and hold the lanes (`enabled: false` in `pump/workflows.json`) until `mcp-surface-corpus` has a fix pinned. |
| `lane-fresh:<lane>` | The newest accepted result of an enabled lane (kv-free: `results.accepted_at`) is over 6 hours old (amber) or over 24 hours (red), **whatever is due**: on 27 Nov nothing came due for 18 of 30 hours and "nothing due" must not excuse it. A lane with no result is amber, red once its first dispatch is over 24 hours old. `off` when the pump is off or the sandbox breaker holds the lane; a disabled lane has no item. | Read `pump-idle` for why nothing goes out; then the lane's last runs and the pump log. |
| `pump-idle` | Nothing dispatched for over 3 hours (amber) or 12 hours (red) while the frame is incomplete: a subject with no sha or digest or no `changed_at` (change detection never set it), a subject with no result on an enabled `always` lane, or a newest result older than its tier's max age (`pump/tiers.json`). The summary counts them: subjects with no version, never-assessed and stale subjects per lane. Also amber when the pump's latest tick (under 30 minutes old) had subjects due, dispatched none, stopped on nothing and nothing is in flight. | A null sha everywhere means no poller sets versions: nothing becomes due until a tier's age runs out. Fix the release or SHA poller (audit A3) and the frame fill (A2); meanwhile read the pump's last tick (`pump.last_tick`) and the workflows' pause state. |
| `coverage:<lane>` | The share of the lane's whole frame (every non-retired subject whose tier runs the lane in `always` mode) whose newest result is assessed: amber under 80%, red under 50%. Not the share of the last 24 hours, so a lane that skips most servers does not look covered. A sampling lane has no frame. `correct` and `incorrect` do not exist in the state yet (audit G2); this is the assessed number only. | The lane's skips by reason and fault in the check-in; `tool-failures` says how many are ours. |
| `tool-failures:<lane>` | Results whose skips are our tool's fault (`results.fault = tool`). Always shown as counts: now, and of the last 24 hours. Amber from 50 results now or 20% of the last 24 hours (at least 5 results), red from 50% of the last 24 hours. | Open the lane's `tool` fault skips in the check-in; they are bugs of ours to fix or reclassify. |
| `oracle-disagreements` | Open oracle disagreements (`oracle_disagreements`): the count. Amber when the oldest has been open over 14 days (it is not settling). | `docs/INTERFACES.md`, oracle disagreement; the due list re-checks them. |
| `ingest-rejects` | Ingest rejects for pin and schema reasons in the last 24 hours (`pin_mismatch`, `pin_unverified`, `manifest_invalid`, `manifest_not_json`, `observation_format`, `undeclared_field`, `deprecated_field`, `field_type`), by reason. Amber when each of the two newest worker runs had one. | `ingest/README.md`, rejection reasons; a pin refusal pauses its lane. |
| `external-workflows` | The workflows the lanes depend on outside the loop's own list: the nightly `conformance-nightly.yml` and the workflow file of every enabled lane, read with the job token (public repositories, one call each). Amber: disabled by GitHub for inactivity (the watchdog's token cannot enable them: do it by hand), not found, or unreadable. `off`: disabled by hand. `watchdog/expected-workflows.json` also lists the tool-qa capture workflows (ledger, perf-baselines, chaos-soak, publish-results), which the watchdog re-enables itself, and an `external` list for more. | Enable the workflow (Actions, or `gh workflow enable`). |
| `state-snapshot` | No snapshot run has confirmed the live state is captured for 3 hours, there is no snapshot yet, or the manifest cannot be read (amber); more than 6 hours (red). Measured from `current_at` in the manifest, so an idle loop stays green while snapshot runs go on. | Open the `state-snapshot` runs. If none ran, dispatch it (`gh workflow run state-snapshot.yml`) and check the stand-in scheduler. See "State snapshots". |
| `state-size` | The state database (or the asset it was pulled from) is over 256 MiB, the `state-snapshots` release holds over 2 GB, the last prune pass failed or gave up its archive, or a pump run finished without recording a size (amber); the database is over 768 MiB or the snapshots over 6 GB (red). The details show the database and asset size, the main row counts, the last prune result and the snapshot total. | A failed or given-up pass needs nothing if the next one succeeds; otherwise read the pump log's `prune:` lines. If the size keeps growing, check that pruning is on (`LANE_STATE_PRUNE_ENABLED`) and that `ingest-state-archive-*` artifacts are uploaded. Red: act before it reaches 1 GiB (see "State pruning and size"). |
| `live-snapshot` | The live loop view snapshot (kv `live.last_upload`). `off` unless `LANE_LIVE_SNAPSHOT_ENABLED` is exactly `true`. Amber: the last good upload is over 20 minutes old (or none yet); red: over 40 minutes, no good upload at all 40 minutes after the first attempt (a missing credential shows here), the builder cannot run (`error: build`), or a scan block has not been followed by a good upload. | Read the pump log's `live:` lines (they name the scan rule and path, never the text). Red from the scan: find what leaked into the snapshot and fix the builder; nothing is published meanwhile. Otherwise check the R2 credentials and the bucket. To stop: "Live loop view snapshot". |
| `subject-ids` | The pump's last subject id pass (kv `pump.identity`) stopped on a mass of NOT_FOUND answers, or more than 5 and more than 20% of the active subjects are marked gone (red); any subject is in id conflict (amber). Green shows the not-found, conflict and merged counts; absent before the first pass. | Red on NOT_FOUND: check the pump job's `GITHUB_TOKEN` (nothing was marked gone; it retries hourly). Red on gone: read `subject_events` for `not_found`. Amber: read the `id_conflict` events and decide by hand (see "Subject ids"). |
| `offsite-backup` | The off-site backup to R2: no good run for 12 hours, not configured yet, near the cost cap, or a run stopped early (amber); no good run for 24 hours, over the cost cap, or a verification failure (red). | Open the newest `offsite-backup` run's summary. See "Off-site backup". |
| `keep-forever` | The keep-forever copy on the `keep-forever` release ("Data retention"): no good run for 12 hours, the last run failed, or an artifact has waited over 30 days to be copied (amber); no good run for 24 hours, or an artifact has waited over 60 days (red: GitHub deletes it at 90). Off: `LANE_KEEP_FOREVER_ENABLED` is not `true`. | Open the newest `keep-forever` run's summary. Dispatch it if no run is recent (`gh workflow run keep-forever.yml --repo isokron-ai/tool-qa`) and check the stand-in scheduler. |
| `retention-seal` | The last seal of the pump's outputs could not compress, or could not write the keep-forever file (amber); three seals in a row failed (red). The full bundle was still sealed, as a plain tar if need be, so nothing is lost, but each such seal leaves a hole in the keep-forever set. | Read the item's summary for the error (kv `retention.seal` in the state); fix the cause, then the next clean seal turns it green. "Data retention". |
| `keep-markers` | A seal whose keep-forever file failed has no `ingest-keepgap-<run>-<attempt>` artifact an hour later (red: the marker was lost), or cannot be matched to a run or is older than the artifact list reaches (amber). Green when every failed one has its marker, or none failed in the last 2 days. | Open the named pump run's "Upload the keep-forever gap markers" step. The prune checks every item's keep file itself ("Data retention"), so nothing expires unprotected; the marker is the second line. |

The watchdog comments on the issue when a red item appears that was not red on its previous
run (naming it), and when overall health recovers from red. An item that stays red for days
(a coverage number, say) does not hide the next real one: each new red id is announced. A red
item changes nothing else: the watchdog dispatches the pump only when no pump run started for
20 minutes, and re-enables only workflows GitHub disabled for inactivity; nothing reads this issue to pause a lane.

If the issue is missing, the next watchdog run creates it. If pinning fails
(the App may not be allowed to pin), pin it once by hand.

## Heartbeat report to the live view

The heartbeat Worker (`heartbeat/`) writes `v1/heartbeat.json` to the public live bucket every 5 minutes when `REPORT_ENABLED = "true"` in
`heartbeat/wrangler.toml` (default `"false"`). It holds the last 48 tick decisions, GitHub's own status for Actions, API Requests, Git
Operations and Webhooks, and the allowlisted fields of the loop health issue. Nothing is written if the secret or vendor-name scan hits.
Switch: `REPORT_ENABLED` (Worker variable, redeploy to change). Stop: set it to `"false"` and redeploy; delete the object to clear the page.
Details: `heartbeat/README.md`.

## Archive of history artifacts and ingest outputs

GitHub keeps history artifacts for 30 days and the sealed ingest outputs
(`ingest-*`, "Reading ingest outputs" below) for 90. Those ingest outputs are
the only copy of the loop's scan results. `scripts/archive-pull.mjs` copies
both to a folder you keep, on any machine with Node 22.13 or newer:

```sh
node scripts/archive-pull.mjs --dest ~/isokron-archive/tool-qa            # pull what is new
node scripts/archive-pull.mjs --dest ~/isokron-archive/tool-qa --dry-run  # list only
```

It needs a token that can read this repository's Actions artifacts:
`GITHUB_TOKEN` or `GH_TOKEN` (a fine-grained token with Actions: read on
`tool-qa` is enough), or else the token of a signed-in GitHub CLI, read with
`gh auth token` each run (so no token is written anywhere). It copies every
artifact that is not in the folder's `index.ndjson` yet:

- `history-*` and `registry-*` into `<dest>/<artifact name>/`, each file
  checked against the sha256 in the artifact's manifest;
- `ingest-*` into `<dest>/ingest/<YYYY-MM-DD>/<artifact name>/` (the UTC day
  the artifact was made; the pump's are named `ingest-<run id>-<run attempt>`,
  and its state archives `ingest-state-archive-<run id>-<run attempt>`, "State
  pruning and size"), still age-encrypted: nothing is decrypted. Each one gets a line in
  `<dest>/ingest/manifest.ndjson`: `artifact_id`, `artifact`, `kind` (`pump`,
  `state-archive` or `re-ingest`; lines written before it have none), `run_id`,
  `run_attempt` (or `attempt_id` for a manual re-ingest; a state archive also
  carries `state-archive-<run>-<attempt>` there), `created_at`,
  `date`, `dir`, `artifact_bytes`, `artifact_sha256`, and `files` (each
  `name`, `bytes`, `sha256`).

Only artifacts made by this repository's own workflows on `main` are pulled:
`ingest-*` from `pump.yml` or `ingest.yml`, `registry-*` from
`history-registry.yml`, `history-packages-*` and `history-popularity-*` from
their workflows. The artifact's run must be in this repository, not a fork
(`head_repository_id` equal to `repository_id`), on branch `main`, and its
workflow file is looked up once per run (from the run list, 100 runs a page,
when there are ten or more runs to check; one request per run otherwise, and
for any run the list did not show). A pull request from a fork can upload an
artifact with any name, so one from a fork or another branch is logged as
`REFUSED, not from our own workflow on main`, and left alone: not downloaded,
not quarantined, and not a failure.

An artifact from this repository on `main` but from a workflow `SOURCES` (in
`scripts/archive-pull.mjs`) does not list for its name, or whose run is gone, is
ours: a workflow was renamed or added. It is held, not left: the run counts it
as failed (`held, not pulled: ...`), exits 1 and notifies, the cursor stays at
it, and it is pulled on the first run after `SOURCES` lists the workflow.
Deleting that artifact on GitHub also ends the hold (it is no longer listed),
so do that only for an artifact you do not want archived. A test
(`R-ARC-20`) checks that every `upload-artifact` name in `.github/workflows/`
with an archived prefix is mapped to its workflow in `SOURCES`.

Every download is checked against the artifact's sha256 digest when GitHub
gives one. Each file is written and synced to disk in a temporary
`.partial-<id>-<pid>` folder, which is then renamed into place. Index and
manifest lines are synced as they are appended, and `.last-pull.json` is
replaced whole (a synced temporary file, renamed) after them. It never
overwrites or deletes anything in the archive. A history artifact that fails a
check is left out and tried again next time, and the command exits 1.
`<dest>/.last-pull.json` keeps its place for each kind; each run looks back one
hour before it. A kind with no place yet (ingest, in a folder made before
ingest outputs were pulled) is listed in full. If the list of artifacts runs
past 500 pages, the place is not moved and the command exits 1.

**Quarantine.** An ingest artifact is the only copy of its results, so a check
that would fail the same way every run does not throw it away. Every file in
it must be a non-empty `*.tar.age` file that starts like an age file, is not
named `.artifact.json` (in any case), has no empty or `.` part in its name, and
is not the same name as another file once case and Unicode form are ignored
(`A.tar.age` and `a.tar.age` are one file on a Mac's disk). When one fails (for
example a plain file, a 0-byte file, an entry past the 1 GiB unzip cap, or the
`.tmp-<pid>` file `ingest/collect.mjs` leaves when the pump is cancelled), the
zip itself cannot be read, or the files cannot be written under their names on
this disk (a name too long, say):

- the download is kept as it came, still encrypted, in
  `<dest>/quarantine/<artifact id>-<name>.zip` (`.download` for an artifact
  uploaded unzipped), with `<artifact id>-<name>.reason.json` beside it: the
  problems, each refused file's name, size, sha256 and reason, and the files
  kept;
- the files that pass are archived in the usual place;
- its index and manifest lines carry `partial: true`, `problems`, `refused`
  and `quarantine` (the path of the kept download); `dir` is `null` when no
  file passed.

The artifact is then done: it is not tried again, and the run still exits 0,
with a notification. Only a download that cannot be trusted (it does not match
the digest, or, with no digest, its size is not the artifact's) is tried again
next run. Nothing in the quarantine folder is ever decrypted.

**One run at a time.** A run holds the folder `<dest>/.lock` (`owner.json`
inside names its pid, host, the host's boot time, its start time and
`touched_at`, which it updates after each artifact). A second run that finds a
live holder logs it and exits 0 without doing anything. A lock from this host is
taken over only once its pid is gone or now runs something else; never just for
its age, however long the run has taken (a first backfill can take many hours,
and a Mac may sleep in the middle). `owner.json` also records the holder's own
command line as `ps -ww -o command=` shows it. If `ps` shows that line on the
pid, or a line containing `archive-pull.mjs`, the lock is live, even if the boot
time differs (macOS moves its boot time when the clock is set, so a clock jump
alone must not free a running pull); a run started through a wrapper or a link
is recognised by its recorded line. If `ps` shows anything else there, the lock
is stale. Only when `ps` cannot tell (no line for the pid) does the boot time
decide: a lock from an earlier boot is stale, since after a restart its pid can
belong to anything, even pid 1. A lock naming this run's own pid is stale. A lock from another host, whose pid cannot be
checked here, is taken over once it has not been touched for 12 hours. The
takeover happens under a second lock, `<dest>/.lock.takeover`, and only if the
owner file still names the holder judged stale, so two runs never both take
one. At start, `.partial-*` folders and files left by a run whose pid is gone are
removed.

To remove the lock by hand (only if no pull is running: `pgrep -fl
archive-pull.mjs` shows nothing, and `launchctl print
gui/$(id -u)/ai.isokron.tool-qa.archive-pull` says `state = not running`):

```sh
cat ~/isokron-archive/tool-qa/.lock/owner.json   # who held it, and since when
rm -r ~/isokron-archive/tool-qa/.lock ~/isokron-archive/tool-qa/.lock.takeover
```

**Alerts.** From the command line, after a successful run (nothing failed, the
list complete) it writes `<dest>/.last-ok.json` and sets the repository
variable `ARCHIVE_LAST_OK` on the repository it pulls from, through the API with
the same token, to JSON such as
`{"at":"2026-11-24T06:00:00.000Z","pulled":3,"recovered":0,"quarantined":0,"already":41,"refused_foreign":0,"failed":0,"listed":120}`.
The token needs to be able to write Actions variables (the GitHub CLI's token,
signed in as an admin of the repository, can). The watchdog reads it for its
`archive` item (`watchdog/archive.mjs`): amber when `at` is more than 12 hours
old, red after 24 hours or when the variable is empty, is not JSON, or `at` is
not a date. `watchdog.yml` passes it in as `${{ vars.ARCHIVE_LAST_OK }}`
through `env:`, because the job's `GITHUB_TOKEN` cannot read repository
variables through the REST API. Set the variable to `off` to switch the item off
(an archive retired on purpose); stop the Mac's agent first (`launchctl bootout
gui/$(id -u)/ai.isokron.tool-qa.archive-pull`), because its next successful pull
overwrites the variable with a fresh heartbeat. It shows a macOS notification (via
`osascript`) when a run fails, when it quarantines an artifact (or finds one quarantined by a run that died before indexing it), when the
heartbeat cannot be set, and, with a failed or locked-out run, when the last
good run is more than 24 hours old. Neither the heartbeat nor a notification
happens on a dry run, or when `CI` or `GITHUB_ACTIONS` is set.
`--no-heartbeat` and `--no-notify` turn each off; `ARCHIVE_PULL_NOTIFY=0`
also turns notifications off.

The archived files are the sealed tars themselves; decrypt one with
`age --decrypt -i ingest-identity.txt -o item.tar <file>`, as in "Reading
ingest outputs".

**On the archive Mac** it runs every six hours from the LaunchAgent
`~/Library/LaunchAgents/ai.isokron.tool-qa.archive-pull.plist`, into
`~/isokron-archive/tool-qa/`, from a checkout of this repository at
`~/isokron-archive/tool-qa-code/`, logging to
`~/Library/Logs/tool-qa-archive-pull.log`. The plist holds no token: the job
runs `gh auth token` when it starts. To install it elsewhere, save this (adjust
the paths) and load it with `launchctl bootstrap gui/$(id -u)` on that file:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.isokron.tool-qa.archive-pull</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/isokron-archive/tool-qa-code/scripts/archive-pull.mjs</string>
    <string>--dest</string>
    <string>/Users/you/isokron-archive/tool-qa</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/tool-qa-archive-pull.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/tool-qa-archive-pull.log</string>
</dict>
</plist>
```

`PATH` is set so the job can find the GitHub CLI for its token. A Mac that is
asleep runs a missed interval when it wakes. To run it at once, `launchctl
kickstart gui/$(id -u)/ai.isokron.tool-qa.archive-pull`. A run started by
hand while the agent is pulling finds the lock and exits. Check the log after the first
run; a full first pull takes a while, because it paces itself under the API
limits. To update the code it runs, `git -C ~/isokron-archive/tool-qa-code
pull --ff-only` after a change to the script is merged.

## Off-site backup

GitHub keeps release assets and Actions artifacts (history for 30 days, ingest
outputs for 90), and the Mac archive above keeps a second copy on one machine.
[`offsite-backup.yml`](../.github/workflows/offsite-backup.yml) keeps a third
copy in a Cloudflare R2 bucket, outside both. Every 6 hours (`23 */6 * * *`;
the operator's stand-in scheduler also dispatches it while the GitHub
schedule is unreliable) [`offsite/backup.mjs`](../offsite/backup.mjs) copies
everything new since the last run, byte for byte as GitHub stores it:

| What | Key | Encrypted |
|---|---|---|
| State snapshots the `state-snapshots` manifest lists | `snapshots/<day>/state-<time>-<sha8>.sqlite.age` | yes (state key) |
| Each version of that manifest | `snapshot-manifests/<day>/manifest-<updated>-<sha8>.json` | no (public metadata) |
| `ingest-*` artifacts | `ingest/<day>/<artifact>/<artifact>.zip` (or the artifact's one file, for `archive: false`) | yes: the zip holds only `*.tar.age` files |
| `ingest-keep-*` artifacts (the keep-forever part of the pump's outputs) | `keep/<day>/<artifact>/<artifact>.zip` | yes, the same |
| `history-*`, `registry-*` artifacts | `history/<day>/<artifact>/<artifact>.zip` | no (public registry and package data) |
| What each run copied | `manifest/<day>/<run time>-<run id>.ndjson` | no |
| Where the next run starts | `_state/cursor/<run time>-<run id>.json` | no |

`<day>` is the UTC day the item was made. It never decrypts anything and holds
no age key. Artifacts pass the archive pull's origin check (`SOURCES` in
`scripts/archive-pull.mjs`: this repository, not a fork, branch `main`, the
expected workflow): one from a fork or another branch is skipped and listed in
the run's summary; one of ours from a workflow `SOURCES` does not list fails
the run until `SOURCES` lists it. A download is checked against GitHub's
sha256 digest, and a snapshot against its manifest entry, before upload.

Each line of a run manifest names the key, its size, sha256 and MD5, the
source (artifact id and name, run id, head commit, workflow path, or the
release asset), and for artifacts the files inside with their sizes and
sha256s. The bucket's lock rule keeps every object for 30 days, so nothing is
rewritten: each run writes its own manifest part and its own cursor (the
newest cursor wins). A run that died before writing its manifest part leaves
objects without a line; the next run that meets one of them (written after the
last cursor) writes its line then, marked `"recovered": true`.

**Integrity.** Every upload is a new object only (`If-None-Match: *`) with
`Content-MD5` (R2 refuses a body that does not match),
the sha256 as metadata (`x-amz-meta-sha256`), and, only when asked for
(`OFFSITE_SHA256_HEADER=on`), `x-amz-checksum-sha256`.
A HEAD after each upload must show the same size, an ETag equal to the MD5,
and the same sha256; anything else is a verification failure (the run fails,
the health item is red). A key that already holds the same sha256 is skipped.
A key that holds other bytes is never overwritten: the copy goes beside it as
`<key>.sha256-<12 hex>` and that run reports a verification failure.
R2 refuses `Content-MD5` together with `x-amz-checksum-sha256`, so the header is
not sent unless the variable `OFFSITE_SHA256_HEADER` is `on` (it is not set in
production). Without it Content-MD5, the signed payload hash and the metadata
check remain.

**Client.** The official AWS SDK v3 S3 client, exact version in
[`offsite/package.json`](../offsite/package.json), installed with
`npm ci --prefix offsite --ignore-scripts` from
[`offsite/package-lock.json`](../offsite/package-lock.json), which holds every
package's integrity hash. The rest of tool-qa stays free of dependencies.

### Setup

1. In the Cloudflare dashboard, R2 → Manage API tokens → Create API token:
   permission **Object Read & Write**, applied to the bucket
   `isokron-loop-backup` only. Copy the Access Key ID and the Secret Access Key
   (the S3 credentials, not the token value).
2. Add them as repository secrets, the account ID as a secret too, and the
   bucket as a repository variable. The account ID is read only from the
   secret: GitHub prints each step's environment in the run log, which is
   public here, and masks only secrets. Delete any repository variable
   `R2_ACCOUNT_ID` (`gh variable delete R2_ACCOUNT_ID --repo isokron-ai/tool-qa`);
   the workflow does not read it:

   ```sh
   gh secret set R2_ACCESS_KEY_ID --repo isokron-ai/tool-qa       # paste the Access Key ID
   gh secret set R2_SECRET_ACCESS_KEY --repo isokron-ai/tool-qa   # paste the Secret Access Key
   gh secret set R2_ACCOUNT_ID --repo isokron-ai/tool-qa          # paste the 32-hex account ID
   gh variable set R2_BUCKET --repo isokron-ai/tool-qa --body isokron-loop-backup
   ```

3. Run it once and read the summary: `gh workflow run offsite-backup.yml --repo isokron-ai/tool-qa`.

Until all four are set, each run exits 0 with a notice ("not configured
yet") and the health item is amber. Only the `Back up` step (and the opt-in
`Prune` step) gets the secrets, and both jobs run only on `main`: a dispatch
from another branch skips them. Optional variables:

| Variable | Default | Meaning |
|---|---|---|
| `LANE_OFFSITE_ENABLED` | on | `false` stops the backup (and shows `off` on the health issue). `LOOP_ENABLED` and `LOOP_PAUSE_UNTIL` stop it too. |
| `OFFSITE_MAX_BYTES` | 8000000000 (8 GB) | The cost cap; at most 10000000000, the free tier. |
| `OFFSITE_MAX_RUN_BYTES` | 2000000000 | Bytes one phase of a run (snapshots, then artifacts) uploads; past it, the rest of that kind waits for the next run and the other kinds go on. A run also stops taking new items after 30 minutes. |
| `OFFSITE_MAX_CLASS_A` | 2000 | LIST and PUT operations one run may use. |
| `OFFSITE_MAX_CLASS_B` | 20000 | HEAD and GET operations one run may use. |
| `OFFSITE_SHA256_HEADER` | off | `on` sends `x-amz-checksum-sha256`; R2 refuses it together with Content-MD5, so leave it unset. |
| `OFFSITE_PRUNE_ENABLED` | off | `true` lets the prune job delete (below). |
| `OFFSITE_PRUNE_AT_BYTES`, `OFFSITE_PRUNE_TO_BYTES`, `OFFSITE_PRUNE_KEEP_SNAPSHOTS` | 85% and 70% of the cap; 48 | Prune thresholds. |
| `OFFSITE_PRUNE_LEGACY_INGEST` | off | `true` lets the prune expire full bundles made before the keep-forever files existed (they have no copy). |

### The cost cap

R2's free tier is 10 GB-month of storage, 1 million Class A operations (LIST,
PUT) and 10 million Class B operations (HEAD, GET) a month, with free egress,
and there is no spending cap on Cloudflare's side. So the run enforces one:

- before uploading it lists the whole bucket and sums its size; it uploads
  nothing that would take the bucket past `OFFSITE_MAX_BYTES` (1 MB is kept
  for the run's own manifest and cursor). A run that hits the cap fails, its
  heartbeat says `over_cap`, and the health item is red until room is made;
- from 85% of the cap the health item is amber ("near the cap");
- each run counts its operations, retries included (the S3 client does not
  retry on its own; the run retries a network error, 429 or 5xx up to three
  times and counts each attempt), refuses any past its per-run caps, and
  reports them in the run summary and the heartbeat;
- a PUT whose every attempt failed may still have been stored, so its bytes
  count against the cap (`possibly_stored_bytes` in the heartbeat);
- a bucket listing marked truncated with no continuation token is an error:
  the run copies nothing on a short sum.

**Operations per month.** At four runs a day the per-run caps bound a month
at 2,000 × 4 × 30 = 240,000 Class A operations (24% of the free tier) and
20,000 × 4 × 30 = 2.4 million Class B (24%), even if every run used its full
caps. The stand-in scheduler does not add runs: it dispatches only when no run
started in the last 330 minutes. Typical use is far below that (next
paragraph).

At the rate measured on 24 Nov 2026 (about 590 MB a day of ingest outputs, 45
MB of state snapshots, 6 MB of history; about 240 objects a day), a month is
about 7,000 PUTs plus about 1,000 LIST pages (0.8% of the Class A tier) and
about 11,000 HEADs (0.1% of the Class B tier). Storage is the limit: about 19
GB a month, so with the 30-day lock the 8 GB cap is reached after about 12
days, and the prune cannot make room before objects are 30 days old. Keeping
30 days off-site at that rate needs one of: a shorter lock with the prune on,
a cap above the free tier, or copying less (the ingest outputs are most of
it). Until then the item turns red when the cap is reached, and nothing is
lost on GitHub or the Mac archive.

### Prune (opt-in, off by default)

The `prune` job ([`offsite/prune.mjs`](../offsite/prune.mjs)) is our own
expiry; nothing is changed on the bucket (its 30-day lock stays, and the
token is object-only). It does two things, both only to objects last written
more than 31 days ago (the lock refuses younger ones; a day of margin):

1. **Expiry.** Every full ingest bundle (`ingest/`, a pump run's
   `ingest-<run>-<attempt>`) past 30 days goes, whatever the bucket's size, if
   its keep-forever copy (`keep/`, `ingest-keep-<run>-<attempt>`) is in the
   bucket. A full bundle with no copy (made before the keep-forever files
   existed) stays, and the summary counts it; `OFFSITE_PRUNE_LEGACY_INGEST=true`
   lets the prune expire those too. State archives and manual re-ingests are
   left to the cap pass.
2. **Cap.** Only while the bucket holds more than `OFFSITE_PRUNE_AT_BYTES`: it
   deletes, until the bucket is down to `OFFSITE_PRUNE_TO_BYTES`, oldest first
   in each group: old cursors (the newest 10 kept), old snapshot manifests (the
   newest 10 kept), full `ingest/` bundles, then `snapshots/`, never the newest
   `OFFSITE_PRUNE_KEEP_SNAPSHOTS` (48). It fails when it cannot reach the target
   because the rest is locked, held or keep-forever.

It never deletes the keep-forever set (`keep/`, `history/`), the run
manifests under `manifest/`, or an artifact on the hold list ("Data
retention"). In apply mode it deletes nothing, and fails, when the listing
looks cut short (a page marked truncated with no continuation token, or the
newest cursor or newest run manifest, each listed on its own, missing from
the full listing), when there is no cursor yet, or when the hold list cannot be
read. Its run summary is scrubbed of the credentials and the account ID.

- Dry run, any time: `gh workflow run offsite-backup.yml --repo isokron-ai/tool-qa -f prune=dry-run` (lists what it would delete in the run summary).
- **To turn it on** (it is off until you do): `gh variable set OFFSITE_PRUNE_ENABLED --repo isokron-ai/tool-qa --body true`. Read a dry run first. It then runs after every scheduled backup (not after a cancelled one), and on a dispatch with `-f prune=apply`; the stand-in scheduler dispatches with `-f prune=apply` while the variable is `true`. To turn it off again, set the variable to anything else or delete it.

An R2 lifecycle rule would expire a whole prefix without code, but it cannot
tell a full bundle with a copy from one without, or honour a hold, so the job
is used instead.

### Health

Each run uploads a heartbeat artifact, `offsite-heartbeat-<run id>-<attempt>.json`
(kept 7 days): status (`ok`, `unconfigured`, `over_cap`, `verify_failed`,
`error`), the last good run, bucket size and cap, counts and operations. The
job's `GITHUB_TOKEN` cannot write a repository variable such as
`OFFSITE_LAST_OK`, and handing the job the loop App's key or a second R2 token
only for a heartbeat would widen what it holds; an artifact needs no
permission. The watchdog reads the newest heartbeat of a finished
`offsite-backup.yml` run on `main` ([`watchdog/offsite.mjs`](../watchdog/offsite.mjs));
when that run failed before it could read the bucket, it takes the last good
time from an older heartbeat, so one failed run is amber, not red:

| Check | Amber or red means | What to do |
|---|---|---|
| `offsite-backup` | Amber: the last good run is 12 to 24 hours old, the backup is not configured yet, no run has reported yet, the bucket is near the cap, or a run stopped early on its per-run caps. Red: no good run for 24 hours, over the cost cap, a verification failure, or no good run ever and the last one failed. Off: `LANE_OFFSITE_ENABLED` is not `true`. | Open the newest `offsite-backup` run's summary. Over the cap: see "The cost cap" and the prune. A verification failure: the summary names the key; compare it with its manifest line (restore steps below). |

### Restore

On the operator's machine, with the AWS CLI (or any S3 client), a token that
can read the bucket, and age with the right identity. Use a separate
read-only R2 token for this (Object Read only, this bucket), not the backup's.

```sh
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=auto
R2=https://<account id>.r2.cloudflarestorage.com
B=s3://isokron-loop-backup

# 1. Find it: the run manifests list every object with its sha256.
aws s3 ls --endpoint-url "$R2" "$B/manifest/2026-11-24/"
aws s3 cp --endpoint-url "$R2" "$B/manifest/2026-11-24/<part>.ndjson" - | grep ingest-45312591667-1

# 2. Download it and check it against the manifest line and its own metadata.
aws s3 cp --endpoint-url "$R2" "$B/ingest/2026-11-24/ingest-45312591667-1/ingest-45312591667-1.zip" .
shasum -a 256 ingest-45312591667-1.zip            # must equal "sha256" in the manifest line
aws s3api head-object --endpoint-url "$R2" --bucket isokron-loop-backup \
  --key ingest/2026-11-24/ingest-45312591667-1/ingest-45312591667-1.zip --query Metadata.sha256

# 3. Decrypt locally (never on a runner).
unzip ingest-45312591667-1.zip -d ingest-45312591667-1   # each file's sha256 is in the line's contents.files
age --decrypt -i ingest-identity.txt -o item.tar ingest-45312591667-1/<file>.tar.age   # "Reading ingest outputs"

# A state snapshot: download, check the sha256 (it starts with the sha8 in the name), then
age --decrypt -i ~/.isokron/loop-age-identity.key -o state.sqlite state-<time>-<sha8>.sqlite.age
```

To put a snapshot back as the live state, follow "State snapshots" (the
restore drill and `restore --apply`, with the loop stopped); the off-site copy
is the same bytes as the release asset of that name.

## Data retention

Loop upgrade 20 (owner decisions of 24 Nov 2026; the study is in the company
audit repository, `research/data-retention-2026-11/`). Three parts: compress,
keep two tiers, and keep a second copy of the small tier.

**Compression.** The pump seals each judged item as `age(zstd(tar))`: plain
zstd at level 12 (`worker-kit/bundle.mjs`), checked by reading it back before it
is sealed, with Node's own zlib (no dependency; Node 22.15 or newer has it, and
the workflows run Node 24). No trained dictionary. Readers tell a sealed file
that is a plain tar (before the upgrade) from a zstd one by its first four
bytes, so an archive holding both reads the same way. If compression fails the
item is sealed as a plain tar and counted (kv `retention.seal`, the
`retention-seal` health item); the decision is still recorded. A manual
re-ingest seals zstd the same way.

**Two tiers.** The pump also writes, next to each full bundle, the keep-forever
part of it, from the same outputs (`ingest/retention.mjs`), to a second
directory it uploads as the artifact `ingest-keep-<run>-<attempt>` (90 days on
GitHub):

| Tier | What | How long |
|---|---|---|
| Full bundle | everything, as before: `ingest-<attempt>-<index>.tar.age` | 30 days on R2 (our prune), 90 days on GitHub, until the Mac archive is cleaned by hand |
| Keep-forever | `keep-<attempt>-<index>.tar.age`: `results/*`, `manifest.json`, `ingest.json` (also for rejected items), `observations/*`, `raw/subject/repo.json`; `catalog-<sha256>.tar.age`: `tools.json`, once per distinct tool list; the `history-*` and `registry-*` artifacts | indefinitely |

Left out of the keep-forever set: the forgery control files, the repeated
known-answer files, `report.json`, `scan.json`, logs and tar padding. The
control files of an item whose manifest records a control that did not give its
expected result are kept. Rejected items' `result.tar.age` (the worker's
bundle) is full-tier only. A manual re-ingest has no keep-forever file; its
decisions are in the state and its outputs live 90 days on GitHub.

**Windows and holds.** Full raw data is kept 30 days (DESIGN-v3 section 9.6),
90 days while a dispute or disclosure is open, and 18 months for items
selected for raw keeping. A hold is a line in
[`offsite/holds.json`](../offsite/holds.json), reviewed like any change:

```json
{ "holds": [ { "artifact": "ingest-45312591667-1", "for": "dispute", "from": "2026-11-24", "note": "ticket 12" } ] }
```

`for` is `dispute`, `disclosure` (90 days from `from`) or `raw` (548 days). A
hold is by artifact, so it keeps the whole artifact. It stops the prune on R2;
it cannot keep what GitHub already deleted (90 days), so add it early. A hold
list the prune cannot read stops the prune. **File a dispute or disclosure hold
within 30 days** of the data being made: after that the prune has deleted the
full bundle, the keep-forever set holds no raw data, and a hold cannot bring it
back. Window changes belong in
`HOLD_DAYS` and `FULL_RAW_DAYS` in `ingest/retention.mjs`.

**A keep-forever gap.** If the pump cannot write one item's keep-forever file
(`retention-seal` turns amber), it seals a marker `keep-gap-<attempt>-<index>.tar.age`,
uploaded as the artifact `ingest-keepgap-<run>-<attempt>`. The prune never
expires any full bundle of that run (not even with `OFFSITE_PRUNE_LEGACY_INGEST`).
If the marker cannot be written either, the item is not recorded and is judged
again next tick. To release such a run after fixing it by hand, delete its
`ingest-keepgap-*` object from R2.

**The prune does not rely on the marker (R-RET-27).** A marker can itself be
lost (its upload, or its off-site copy, fails), and then the full bundle would
have expired at day 31 with no keep copy. So before it takes a pump full bundle
that has a keep artifact, the prune lists the member names of both zips (ranged
reads of the zip directory, a few KiB; nothing is decrypted) and requires a
`keep-<attempt>.tar.age` in the keep artifact for every `ingest-<attempt>.tar.age`
in the bundle. A missing keep file, a zip it cannot list, or a bundle with no
item keeps the bundle, whatever the markers say and with or without
`OFFSITE_PRUNE_LEGACY_INGEST` (which only releases bundles with no keep artifact
at all, from before the keep files). The summary says how many zips could not be
listed. This check must hold before `OFFSITE_PRUNE_ENABLED` is set to `true`.
The watchdog's `keep-markers` item checks the markers too: every seal whose
keep-forever file failed (kv `retention.seal`, `keep_gaps`, each with the pump
run) must have its `ingest-keepgap-<run>` artifact an hour after the seal; a
missing one is red, one that cannot be matched to a run or is older than the
artifact list reaches is amber (R-WD-14). Red means the marker was lost: look at
the pump run's "Upload the keep-forever gap markers" step.

**R2.** The bucket lock stays at 30 days and no bucket setting is changed. The
off-site backup copies `ingest-keep-*` to `keep/` and everything else as
before; the prune ("Prune") expires full bundles past 30 days and never touches
`keep/` or `history/`.

**The second copy.** [`keep-forever.yml`](../.github/workflows/keep-forever.yml)
([`keep/copy.mjs`](../keep/copy.mjs)) copies the keep-forever set into the
release tagged `keep-forever` on this repository, rolled by month:

| Asset | What |
|---|---|
| `keep-<YYYY-MM>-<id>.tar` | one part per run and month, under 2 GiB (a run takes at most `KEEP_MAX_RUN_BYTES`, 512 MiB by default): the sealed `keep-*` and `catalog-*` files (still age-encrypted; the workflow holds no key) and the history zips (public data, not encrypted) |
| `manifest-<YYYY-MM>.r<N>.json` | every artifact copied that month, its files and their sha256s, and which part holds them |
| `catalogs.r<N>.json` | the sha256 of every catalog copied |
| `status.r<N>.json` | the last run's result; the watchdog reads it |

Re-runs do not duplicate: an artifact the manifest lists is skipped without a
download, a part is named by its contents and not uploaded twice, and a
catalog already copied is left out. A run that dies after uploading a part but
before its manifest uploads the same part's name again next time; if more
artifacts arrived meanwhile their files may appear in a second part (nothing is
lost). The `r<N>` files are revisions: a new one is written before the old go,
and the newest two stay. The workflow follows the other jobs' rules: actions
pinned to commit SHAs, a top-level `permissions: {}`, the guard first
(`LOOP_ENABLED`, `LOOP_PAUSE_UNTIL`, and the lane switch
`LANE_KEEP_FOREVER_ENABLED`), concurrency `keep-forever`.

*What the stand-in scheduler should dispatch* (GitHub's cron does not fire on
this repository): `gh workflow run keep-forever.yml --repo isokron-ai/tool-qa`
every 6 hours, but only when no run started in the last 330 minutes, like the
off-site backup. GitHub keeps the artifacts it copies 90 days, so a copy that
stops for more than a few weeks starts to lose data: the `keep-forever` health
item turns amber at 30 days of waiting and red at 60.

**Keep this repository private.** The release assets are age ciphertext (the
keep and catalog files) plus the public history zips. Making the repository
public would publish the ciphertext for good; anyone who later obtained the key
could read all of it.

**Restore.** Download `keep-<month>-<id>.tar` from the release, `tar -xf` it,
check each file against the month's `manifest-<month>.r<N>.json`, then
`age --decrypt -i ingest-identity.txt` and read it as in "Reading ingest
outputs". A `catalog-<sha256>.tar.age` holds one `tools.json`; the item's
`manifest.json` names the tool list's sha256 for the match.

**Health.** `keep-forever` (the copy: stalled, failing or off) and
`retention-seal` (compression or keep-forever file failures) and `keep-markers`
(every failed keep-forever file has its gap marker) are on the health
issue ("The loop health issue").

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
artifact `ingest-<run id>-<run attempt>` (kept 90 days, the most GitHub allows) holding one
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

Since loop upgrade 20 the decrypted file is zstd-compressed (it starts with the
bytes `28 b5 2f fd`); one sealed before then is a plain tar. `tar -tf` reads
both when `zstd` is installed (`brew install zstd`); otherwise `zstd -d ingest.tar`
first. The repository's own readers (`worker-kit/bundle.mjs`, used by
`longitudinal/derive.mjs` and `checkin.mjs`) tell them apart by those bytes.

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

## Version pins (R-PIN-01)

`versions.tool` and `versions.probe` of a lane in `pump/workflows.json` go
into every run_key: they are what a result is filed under. A worker workflow
is dispatched on a branch (`ref`, GitHub takes no commit there), so without
more the worker runs its branch head, whatever the pin says. `pin_check` on
each lane says how the label is made true:

| `pin_check` | Pump | Ingest |
|---|---|---|
| `enforce` | When `versions.tool` pins a commit of the worker repository itself (the entry named after the repository, such as `mcp-check` for isokron-ai/mcp-check), resolves it to the full commit (`GET /repos/{repo}/commits/{sha}`, once per run) and sends it as the `tool_sha` dispatch input; the worker checks out and runs that commit. A pin that cannot be resolved is not dispatched (`cannot resolve <lane>'s pinned commit ...`). | Refuses a result unless its manifest `tools` prove every pinned tool and probe component: a commit pin by the full commit it starts, any other pin by the same version string (`pin_unverified`), and refuses any that reports another version (`pin_mismatch`). |
| `label` | Sends nothing new. Says once a tick when the worker branch head is not the pin (`pin_check is "label" and ... is at ..., not the pinned ...`): those results run the head. | Refuses a contradiction (`pin_mismatch`), except on the lane's own commit pin (the worker repository's entry), which a `label` worker runs at its branch head: that one is listed under `pins.unverified` with a note `self_pin_moved: reported <x>, pinned <y>` and accepted (R-PIN-02). Accepts an unproven pin with it listed under `pins.unverified` in the item's `ingest.json`. Pins recorded for the run_key that cannot be read are refused (`pin_unverified`) on `enforce` only. |

A lane without `pin_check` is held to `enforce`. `label` is the rollout
setting for a worker repository that does not take `tool_sha` and report its
commits yet. Move a lane to `enforce` only after its worker workflow declares
the optional `tool_sha` input (GitHub refuses a dispatch with an input the
workflow does not declare, so an early switch only fails the dispatches, red,
and records nothing), checks out that commit, and reports its own code in
manifest `tools` at the full commit it ran (worker-kit/README.md). A pin
written as a full 40-character SHA needs no lookup.

Today: tool-qa's own lanes (meta-github, meta-registry, release-diff) are
`enforce`: their bundles report `tool-qa-<lane>` at the lane `VERSION`, which
is their pin. scan-static, live-probe and writecheck are `label` until
isokron-ai/mcp-check and isokron-ai/mcp-writecheck-action take `tool_sha`
and report what they ran (live-probe also pins its `fuzz` probe stage, which
its bundles must then report at the full mcp-check commit).
On a `label` lane, a worker repository that merges without a pin bump does
not stop its lane: writecheck reports `mcp-writecheck-action` at the commit
it runs (its branch head), and that contradiction of the lane's own pin is
only a `self_pin_moved` note (R-PIN-02). Every other pin is still refused
when contradicted on a `label` lane: writecheck's `mcp-writecheck` (CLI_REF),
`mcp-surface-corpus`, live-probe's corpus commit.

A lane `VERSION` bump (tool-qa's meta lanes, and any lane whose pin is a
version string) must merge in the same commit as its pin change in
`pump/workflows.json` (R-SUB-13 checks they agree). Even so, shards
dispatched by a pump run that started before such a merge carry the old pin
while their worker runs the new code: expect a one-off `pin_mismatch` and a
one-hour pause of that lane right after the merge. It ends on its own and
loses no work.

A refusal pauses the lane for an hour (above, "The pump"); pin refusals are
not counted towards parking, so a fixed pin or worker loses no work.

## Live loop view snapshot

The pump publishes a small public JSON snapshot of the loop's state to Cloudflare R2 every tick (and at once, at most every 20 seconds, while a GitHub retry is open), for the live loop view on the site. Code: `live/publish.mjs` (order and switch), `live/r2.mjs` (signed PUT), `live/build.mjs` (the allowlisted content and the scans).

| Item | Value |
|---|---|
| Switch | repository variable `LANE_LIVE_SNAPSHOT_ENABLED`. Only the exact value `true` turns it on (unset, empty or anything else is off, unlike pruning). Off means no build and no network call. |
| Credentials | `loop` environment secrets `LIVE_R2_ACCESS_KEY_ID`, `LIVE_R2_SECRET_ACCESS_KEY`, and the existing `R2_ACCOUNT_ID` secret. Passed to the Pump step only and scrubbed from its log. Missing any of the three: off. |
| Bucket | `isokron-loop-live` (`LIVE_R2_BUCKET` in `pump.yml`), public only through `live.isokron.ai`. The key needs write access to this bucket only, never the backup bucket. |
| Keys | `v1/snap/<16 hex of the body's sha256>.json` (immutable: the key is the content, so it never holds two bodies; a body equal to the last good upload's is not sent again, unless that was over 24 hours ago), `v1/events/<YYYY-MM-DD>/<HH>.ndjson` (60 s cache for the open hour; in the first minutes of a new UTC hour the builder also hands over the previous hour's events, written to that hour's key, immutable; hours are those of the moment the upload started), then `v1/latest.json` (5 s) last, so the pointer never names a missing object. The pointer carries `seq`, `generated_at` and `snap` (the snapshot key) and is rewritten every tick, so its `generated_at` shows liveness. While a GitHub retry is open, `v1/retry.json` (`{schema, at, retry}`, 5 s cache, built from memory, scanned like the rest) is uploaded at most every 20 seconds, and once with `retry: null` when it clears. |
| History times | The public history strip needs when `registry-full`, `packages` and `popularity` last succeeded. At most every 30 minutes (and only while the switch is on) the pump reads the newest successful run of `history-packages.yml` and `history-popularity.yml` (`status=success`, `branch=main`, `per_page=1`) and of `history-registry.yml` (`per_page=50`), takes each run's `updated_at`, and keeps them in kv `pump.history_times`; every snapshot in between reuses the kept values. For registry-full the newest run whose title ends ` full`, or a scheduled run created in the 03 UTC hour (the daily full capture is cron `17 3 * * *`; the delta runs are titled ` delta`), counts. Three small reads in the `actions` budget family, a short-lived read-only token, a 15 second window inside the tick. A failed or late read is one log line (`history time for ... not read`) and the kept value stays (null if none); the next run tries again. `registry_size` stays unknown. |
| Cadence | At each tick boundary, once at the end of the run, and about every 60 seconds (`LIVE_PUBLISH_MS`) in the wait between ticks. A between-ticks publish is skipped when the switch is not exactly `true`, inside a state transaction, when it could end after the run's deadline, or when the next tick is due before its 20 second cap would end, so it never delays a tick. The history lookup keeps its own 30 minute cache; an unchanged snapshot body is not uploaded again. |
| R2 cost | Per publish at most 3 Class A writes (the snapshot if changed, the hour file, the pointer). At one a minute that is about 4,320 a day, about 130,000 a month; with the heartbeat's about 8,600 a month and the rare previous-hour and retry writes, about 14% of R2's free 1,000,000 Class A operations a month. Reads are unchanged (the page polls the pointer). |
| Failure | Never fails the pump. The snapshot is read and uploaded only between ticks (never inside a state transaction), capped at what is left of the run and at 20 seconds; the last one of the run is capped at 5 seconds, and the final state push keeps its full grace. The retry upload never reads the state and is not waited for. A failed upload is logged and recorded in kv `live.last_upload` (`ok`, `at`, `first_at`, `last_ok_at`, `last_ok_hour`, `last_snap`, `seq`, `bytes`, or `error`: `build` when `live/build.mjs` cannot load or run, `put`, `deadline`, `credentials` when the switch is on but a secret is missing; `blocked: scan` with `blocked_at`, which stays until a good upload). A scan hit uploads nothing. The watchdog item `live-snapshot` shows the state. |

### The daily history (`v1/history/`)

The first good snapshot upload of each UTC day also writes the day before, once (`live/history.mjs` builds it, `publishHistory` in `live/publish.mjs` uploads it, after the pointer, in what is left of the same deadline). Same switch, credentials, bucket and scans; no call while the switch is off. What a day file holds and why: `live/README.md`, "The daily history".

| Item | Value |
|---|---|
| Keys | `v1/history/days/<YYYY-MM-DD>.json` (immutable, written once), then `v1/history/recent.json` (the last 120 days, `max-age=300`), then `v1/history/index.json` (every day with a file, `max-age=300`). Three writes a day. |
| Retention | Indefinite. There is **no lifecycle rule on `v1/history/`**; a rule on the bucket must leave that prefix out. About 1.5 KB a day. |
| State | kv `live.history.last_day`, `live.history.days`, `live.history.recent`, `live.history.pending`, `live.history.blocked` (INTERFACES.md, "Keys the pump keeps in kv"). |
| First run, gaps | The first rollover (no `last_day`), or one after the pump was off, also builds the up to 7 earlier days the events table still holds in full (oldest event at or before the day's start, inside the 8 days events are kept) and that are not in `live.history.days`, oldest first, at most 2 day files per publish (with 60 s publishing a full backfill takes about 4 minutes). The day the events begin is built once, marked `partial: true`. A day built more than a day after it ended gets lane `state: null` and `pins: null` (what was in force then is not known). |
| Failure | A failed upload is logged (`live: history upload failed (put at <key>)`) and leaves `last_day`, so the next publish tries again. A day file's body is stored in kv `live.history.pending` before its PUT and sent again unchanged until it is confirmed, so its immutable key never gets a second body; a day already stored is not rebuilt. A scan hit keeps that day out (logged by rule and path, kv `live.history.blocked`) and is not retried. It never changes the snapshot's result or `live.last_upload`, and never delays the pump past the snapshot's own cap. |
| Rebuild a day | Delete the day from kv `live.history.days`, `live.history.recent` and `live.history.blocked`, clear `live.history.pending` and `live.history.last_day` (a state edit, see "State store: one writer at a time"), while its events are still kept. Its key is cached as immutable, so a rebuilt body may take a while to reach readers. |

To stop publishing: set `LANE_LIVE_SNAPSHOT_ENABLED` to anything but `true` (`gh variable set LANE_LIVE_SNAPSHOT_ENABLED --body false --repo isokron-ai/tool-qa`); the next pump tick makes no call, and the watchdog item turns `off`. The last objects stay in the bucket until their lifecycle rules expire them; to take the page down at once, delete `v1/latest.json` in the bucket, or revoke the key.
