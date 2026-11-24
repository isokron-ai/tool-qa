# tool-qa

tool-qa is IsoKron's continuous testing loop. It runs our own open-source MCP
tools against open-source MCP servers on free GitHub Actions runners. The goal
is to find bugs in our tools and to keep a record of every result. Publishing
comes later, through [isokron-ai/mcp-results](https://github.com/isokron-ai/mcp-results).

More about IsoKron: [isokron.ai](https://isokron.ai/?utm_source=tool-qa&utm_medium=readme).

**Status: P1 in progress: the pump, dispatch, ingest (inside the pump) and the
watchdog are built and the ingest key is in place. The pump loads its subjects,
the 997 repositories of the seed list, at start-up; no worker workflow is
switched on yet, so there is no scanning yet.**

## What runs where

| Where | What | Runs target code? |
|---|---|---|
| this repo (`tool-qa`) | Orchestration: history capture, the due list, leases, the slot ledger, the state store, collection and checks of results, loop health. Also the two metadata workers, `meta-github` and `meta-registry`, which read public metadata only, and `release-diff`, which compares published npm and PyPI packages with their source as data ([meta/](meta/README.md)) | No, never |
| our tool repos (for example `mcp-check`) | Workers: each tool runs against servers inside its own repo, as that tool's regression suite. Started only by dispatch from this repo | Yes, sandboxed |
| `mcp-results` | Published data (later phase) | No |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the queue and slot model.

## Safety model, in short

Nothing runs server code yet. When scanning starts, these rules apply:

- **Sandboxed.** Server code runs only in worker jobs, inside a sandbox with
  outbound network blocked. This repo never runs it.
- **Nothing secret in workers.** Worker jobs get `permissions: {}` and no
  secrets. Their results are encrypted to tool-qa's ingest key and checked
  here, by the pump, against the lease that sent them out, before anything is
  kept.

Already in place:

- **Locked-down workflows.** Every workflow starts from `permissions: {}`, every
  job asks only for what it needs, and every action is pinned to a full commit
  SHA. actionlint, zizmor and [`scripts/check-workflows.mjs`](scripts/check-workflows.mjs)
  run on every push and pull request.
- **Kill switches.** Every scheduled or dispatched loop job first runs
  [`scripts/guard.mjs`](scripts/guard.mjs). A stopped loop exits cleanly
  (green, with a one-line notice), never red.

## How to stop it

Set these as repository variables (Settings → Secrets and variables → Actions →
Variables), or with `gh variable set NAME --body VALUE --repo isokron-ai/tool-qa`.

| Variable | Effect |
|---|---|
| `LOOP_ENABLED` | Must be exactly `true` for anything to run. **Set it to `false` to stop everything in one step.** Unset means off. |
| `LOOP_SLOTS` | Whole number of worker slots, 0 to 15. Default 0: no work is sent out, and the pump only tidies up (judges finished worker runs, reaps expired leases and slots). Values above 15 count as 15. Set it to 5 or less to shrink the loop at once. |
| `LOOP_PAUSE_UNTIL` | Optional ISO 8601 time, such as `2026-12-01T09:00:00Z`. The loop does nothing until then. A value the guard can't read keeps the loop paused. |
| `LANE_<JOB>_ENABLED` | Optional per-job switch, for example `LANE_HISTORY_ENABLED=false`. Unset leaves the job on. |

Details, and what to do in an emergency: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Repository layout

| Path | What it is |
|---|---|
| `scripts/guard.mjs` | Kill-switch guard for loop jobs |
| `scripts/check-workflows.mjs` | Workflow policy check (permissions, SHA pins, timeouts, triggers, injection) |
| `scripts/state-asset.mjs` | Pulls and pushes the state database as a Release asset |
| `snapshot/`, `.github/workflows/state-snapshot.yml` | Hourly versioned snapshots of the encrypted state asset (release `state-snapshots`, retention, manifest) and the restore drill |
| `scripts/archive-pull.mjs` | Copies history artifacts into a local archive folder and checks them |
| `state/schema*.sql`, `state/db.mjs`, `state/prune.mjs` | State store: subjects, runs, leases with fencing, slot ledger, attempts, dispatch ledger, results; pruning of closed history |
| `pump/` | The pump: subjects from the seed list, due list, shards, slots, dispatch to workers, ingest of finished runs, API budgets, App tokens, state pruning and the size metric |
| `watchdog/` | Loop health checks and the "Loop health" issue |
| `.github/workflows/pump.yml`, `watchdog.yml` | The pump (back to back, restarted every 30 minutes) and the watchdog (every 15 minutes) |
| `worker-kit/` | Result contract (manifest schema), bundle builder and sealing action for workers, ingest public key |
| `ingest/` | Trusted ingest: decrypts a worker's sealed result and checks it before anything is recorded; the pump runs it every tick |
| `.github/workflows/ingest.yml` | Manual re-ingest of one attempt the pump did not judge (only while the pump is paused) |
| `scripts/ledger.mjs`, `ledger/`, `.github/workflows/ledger.yml` | The cross-repo regression ledger: every tool repository's `REGRESSIONS.md` in one place ([`docs/LEDGER.md`](docs/LEDGER.md), `ledger/ledger.json`), refreshed daily by a pull request |
| `.github/workflows/lint-workflows.yml` | Reusable workflow lint (actionlint, zizmor, policy check) |
| `.github/workflows/lint.yml`, `test.yml` | Lint and unit tests on push and pull request |
| `perf/`, `docs/PERFORMANCE.md`, `.github/workflows/perf-baselines.yml` | Performance baselines for our own servers: the pinned Inspector `--load`, each release compared only with its own previous release |
| `docs/` | Architecture, operations, the interfaces between pump, workers and ingest, and [the measurement rule](docs/MEASUREMENTS.md) (separate claims, never one score) |

## Development

Node 22.13 or newer. No runtime dependencies.

```sh
npm test                 # node --test
npm run check-workflows  # policy check on .github/workflows
```

## License

[MIT](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
