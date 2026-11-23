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

`LOOP_SLOTS` is the loop's ceiling on concurrent jobs across all repos. In the
state store, each slot row carries an expiry (set when it is taken); expired
rows are reaped the next time a slot is acquired, so a crashed run can't hold a
slot for good.
It is read as a whole number and clamped to 0..15: unset or 0 means slot-based
jobs do nothing, values above 15 count as 15, and a value that isn't a whole
number counts as 0.

## Pause until a set time

```sh
gh variable set LOOP_PAUSE_UNTIL --body 2026-12-01T09:00:00Z --repo isokron-ai/tool-qa
```

`LOOP_PAUSE_UNTIL` takes an ISO 8601 time with a zone (`Z` or `+02:00`), or a
date such as `2026-12-01` (midnight UTC). Until then every loop job skips. After
it passes, the value is ignored; delete it when convenient. A value the guard
can't read (no zone, a typo) keeps the loop paused, so a mistake fails safe.

## Which variable affects which workflow

| Variable | `history-registry` | `history-packages` | `history-popularity` | Workers and pump (later) |
|---|---|---|---|---|
| `LOOP_ENABLED` | yes | yes | yes | yes |
| `LOOP_PAUSE_UNTIL` | yes | yes | yes | yes |
| `LANE_<JOB>_ENABLED` | `LANE_HISTORY_REGISTRY_ENABLED` | `LANE_HISTORY_PACKAGES_ENABLED` | `LANE_HISTORY_POPULARITY_ENABLED` | their own lane |
| `LOOP_SLOTS` | no | no | no | yes |

The three history workflows capture public data and don't work in slots, so
they run the guard with `--no-slots`: `LOOP_SLOTS=0` does not stop them. Use
`LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` or the lane switch for those.

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
          LANE_PUMP_ENABLED: ${{ vars.LANE_PUMP_ENABLED }}
        run: node scripts/guard.mjs --job pump --slots

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
