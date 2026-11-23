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

| Variable | `history-registry` | `history-packages` | `history-popularity` | `pump` | `watchdog` | Workers (later) |
|---|---|---|---|---|---|---|
| `LOOP_ENABLED` | yes | yes | yes | yes | yes | yes |
| `LOOP_PAUSE_UNTIL` | yes | yes | yes | yes | yes | yes |
| `LANE_<JOB>_ENABLED` | `LANE_HISTORY_REGISTRY_ENABLED` | `LANE_HISTORY_PACKAGES_ENABLED` | `LANE_HISTORY_POPULARITY_ENABLED` | `LANE_PUMP_ENABLED` | `LANE_WATCHDOG_ENABLED` | their own lane |
| `LOOP_SLOTS` | no | no | no | 0 = housekeeping only | 0 = no pump expected | yes |

The three history workflows capture public data and don't work in slots, so
they run the guard with `--no-slots`: `LOOP_SLOTS=0` does not stop them. Use
`LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` or the lane switch for those.

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

The loop's state (subjects, runs, leases, slot ledger, attempts) is one SQLite
file. Between runs it lives as the asset `state.sqlite` on the release tagged
`state` in this repo. Only the pump writes it, inside one concurrency group.

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

`push` needs a token with `contents: write`. It uploads under a temporary name,
then deletes the old asset and renames the new one, so a failed push keeps the
last good copy. `pull` checks the sha256 in the asset label and that the file
is a healthy SQLite database before it replaces the local file. To reset state,
delete `state.sqlite` and any `state.sqlite.upload-*` assets; the next run
starts empty.

## State store: one writer at a time

`scripts/state-asset.mjs push` refuses to overwrite the state asset if it changed since this run pulled it, and re-checks just before replacing it. There is still a short window between that re-check and the swap, so the check is a safety net, not a lock: every workflow that pushes state must run in the same `concurrency` group (one writer at a time). Pull again before every push.

The pump is that one writer (concurrency group `pump`). To push state by hand,
first switch the pump off (`LANE_PUMP_ENABLED=false`) and wait until no pump
run is going. The watchdog only downloads a copy and never pushes.

## The pump

`.github/workflows/pump.yml` runs every 30 minutes and can be started by hand
(Actions → pump → Run workflow). Each run works for about 11 minutes, ticking
every 150 seconds, and first dispatches the next run, which waits for it in the
`pump` concurrency group. While `LOOP_SLOTS` is above 0 the pump therefore runs
back to back; the schedule restarts the chain if it breaks. Because only one
run can wait in a concurrency group, a scheduled run that starts while one is
already waiting replaces it, and the replaced run shows as cancelled. That is
normal.

To start it:

1. Set up the GitHub App and the `loop` environment (below).
2. Enable a worker workflow in `pump/workflows.json` (`"enabled": true`) once it
   exists in its repository. Until then the pump has nothing to dispatch.
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
| `LOOP_SLOTS=0` | The pump only does housekeeping on its schedule (reap expired leases and slots, run ingest). No new work, no successor run. Workers already running finish. |
| `LANE_PUMP_ENABLED=false` | The pump does nothing at all. Leases and slots are not reaped until it is back; they expire on their own. The health issue shows the pump as off. |
| `LOOP_ENABLED=false` | Everything stops, the watchdog too. |

A running pump run notices none of these until its next start; cancel it from
the Actions tab if it must stop at once. Its dispatches stay in the state, and
their leases expire as usual.

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

What each token is used for:

| Job | Repository | Permissions | For |
|---|---|---|---|
| pump | each worker repository | `actions: write` | dispatching shards and finding their runs |
| pump (successor) | `tool-qa` | `actions: write` | dispatching the next pump run |
| pump (successor failed) | `tool-qa` | `issues: write` | marking `pump-successor` red on the health issue |
| watchdog | `tool-qa` | `issues: write`, `actions: write` | reading runs and artifacts, dispatching the pump, re-enabling workflows, the health issue |

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
   placeholder (lines starting with `#` may stay), and merge it. Workers use
   the key in the tool-qa commit they pin.
2. Store the identity as the secret `AGE_IDENTITY` in the environment `loop`:

   ```sh
   gh secret set AGE_IDENTITY --env loop --repo isokron-ai/tool-qa < ingest-identity.txt
   ```

3. Keep one offline copy of the identity somewhere safe, then delete the file.
   Never commit it, and never paste it into an issue, a log or a workflow.

Until `ingest.pub` holds a key, the worker action refuses to upload and ingest
exits 1 without judging anything. Ingest also exits 1, before fetching
anything, if `AGE_IDENTITY` is not the identity of a key in `ingest.pub`, so a
wrong secret never turns into a series of `decrypt_failed` rejections.

**Rotation.** Set `LOOP_ENABLED=false` and let running workers finish and be
ingested. Create a new pair, put the new public key in `ingest.pub` and the
new identity in `AGE_IDENTITY` together, update the tool-qa pin in every worker
repo, then turn the loop back on. A bundle encrypted to the old key after that
is rejected as `decrypt_failed`. If the identity may have leaked, rotate at
once: it can read every bundle and every sealed ingest output encrypted to it.

**Reading ingest outputs.** Each ingest run uploads `ingest-<attempt>` (kept 30
days): one age-encrypted tar. Download it from the run's page (or with
`gh run download`; unzip it if it arrives zipped), then:

```sh
age --decrypt -i ingest-identity.txt -o ingest.tar ingest-<attempt>.tar.age
tar -tf ingest.tar    # accepted/<attempt>/..., rejected/<attempt>/... or quarantine/<attempt>/...
```

`ingest.json` in there is the report. For a rejected or quarantined attempt,
`result.tar.age` is the worker's bundle as uploaded; it decrypts with the same
identity. A quarantined bundle holds a secret or a canary in the clear: open it
only on a trusted machine and never publish it.

## Ingest

[`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml) judges one
worker attempt and records the decision (details:
[`ingest/README.md`](../ingest/README.md)). It is dispatched once the worker
run has completed:

```sh
gh workflow run ingest.yml --repo isokron-ai/tool-qa \
  -f repo=isokron-ai/mcp-check -f run_id=123456789 -f attempt_id=att-1
```

| Name | Kind | Where | Needed |
|---|---|---|---|
| `AGE_IDENTITY` | secret | environment `loop` | yes (see above) |
| `LOOP_APP_ID` | variable | repository | optional: artifacts are then read with a short-lived GitHub App token for the one worker repo (`actions: read`) |
| `LOOP_APP_PRIVATE_KEY` | secret | environment `loop` | with `LOOP_APP_ID` |
| `LOOP_ENABLED`, `LOOP_PAUSE_UNTIL`, `LANE_INGEST_ENABLED` | variables | repository | kill switches; ingest runs the guard with `--no-slots`, so `LOOP_SLOTS` does not stop it |

Without `LOOP_APP_ID` the run's own token reads the artifacts, which can only
work for public worker repos (not yet tried in CI).

The job pulls the state asset, judges, uploads the sealed outputs, and pushes
the state only if a result was recorded, after the upload. A run is green for
every decision (accepted, rejected, quarantined, pending, already recorded):
see the notice line and the step outputs. It is red only for operational
errors (GitHub unreachable after retries, bad configuration, state problems),
and then nothing is recorded. `pending` means the worker run was not finished:
dispatch again later. Dispatching again for a recorded attempt does nothing.

Ingest pushes state, so it runs in the concurrency group `loop-state`; every
workflow that pushes state must use the same group. GitHub keeps at most one
pending run per group and cancels the older pending run when another is
queued, so when several attempts finish together some ingest dispatches are
cancelled. Whatever dispatches ingest must dispatch again for completed worker
runs whose attempt still has no recorded result.

