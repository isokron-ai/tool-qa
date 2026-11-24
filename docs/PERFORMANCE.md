# Performance baselines for our own servers

Upgrade 16 of the loop. For each release of one of **our own** servers, a free
GitHub Actions job measures how fast it answers a fixed, modest read-only
workload and compares the numbers with **the same server's previous release**.
A release that got clearly slower shows amber or fails the job.

What it never does: load a third-party server, load anything remote, compare one
server with another, call a model, or use a secret.

## The tool

The official MCP Inspector CLI, `--load` mode, pinned to `@modelcontextprotocol/inspector` **2.16.0**
(`perf/package.json`, exact version and integrity in `perf/package-lock.json`, installed with `--ignore-scripts`).
Read from its own `--help` and source at that version:

| What | Flag |
|---|---|
| load mode | `--load` with `--method tools/call` |
| a weighted mix of tools | `--load-scenario <file>` (steps of `tools/call`, `resources/read`, `prompts/get`, each with a weight; the summary is also broken down per step) |
| in-flight calls | `--load-concurrency <n>` |
| sessions (HTTP and SSE only) | `--load-connections <n>` |
| session churn (HTTP and SSE only) | `--load-churn --load-churn-calls <n>` |
| duration, warm-up | `--load-duration <s>`, `--load-warmup <s>` (warm-up calls are left out of every statistic) |
| seeding by a bounded run | `--load-requests <n>`, `--load-args-file <ndjson>` with `{{seq}}` placeholders |
| output | `--format json`: one object with `latencyMs` (`p50`, `p90`, `p95`, `p99`, `p999`, `min`, `mean`, `max`), `requests`, `ok`, `errorRate`, `okThroughput`, `steps[]`, and `churn` |
| thresholds and baselines of its own | `--load-max-p50/-p95/-p99`, `--load-max-error-rate`, `--load-min-throughput`, `--load-baseline <file>` with `--load-max-regression <pct>` |

Things the Inspector cannot do that this design works around:

- **Over stdio there is one session.** `--load-connections`, `--load-churn`, `--load-workers` and `--load-subscribe` are HTTP or SSE only. So the
  stdio profile is 8 calls in flight on one session, and the HTTP profile is 8 real sessions plus a churn pass.
- **`tools/list` cannot be load-tested.** Scenario steps are `tools/call`, `resources/read` or `prompts/get`. The workload is read-only tool calls.
- **Its own `--load-baseline` compares p50, p99, error rate and throughput, not p95, and it needs identically shaped runs.** We keep our own comparison
  (below) so that p95 is the headline and repeats are medians. The Inspector's threshold flags are not used.
- **Notification fan-out** (`--load-subscribe`) needs a server with resource subscriptions. None of ours has them, so it is not run.

## What is measured

`perf/servers.json` lists the servers. All four are installed from npm at the release being measured and started on the runner.

| Server | npm package | Profiles | Read-only mix (weights) |
|---|---|---|---|
| kronicle-lite | `kronicle-lite` | stdio, HTTP | `get_system_state` pulse (4), `recall` (4), `verify_chain` (1), `anchor_status` (1) over 24 seeded notes |
| sea-lite | `sea-lite` | stdio, HTTP | `sea_list` (4), `sea_stats` (2), `sea_history` (2), `sea_scope_check` (2) over 24 seeded tickets |
| mcp-check | `@isokron/mcp-check` (`mcp-check-server`) | stdio | `check_tools_list` on a 6-tool list (3), `explain_check` (3), `compare_tools_lists` (1) |
| tiny-tracker | `@mcp-write-safety/tiny-tracker` | HTTP | `list_projects` (2), `list_tickets` (3), `get_ticket` (3) over 24 seeded tickets |

tiny-tracker 0.3.0 has no stdio mode (its usage text said it had; fixed in isokron-ai/mcp-write-safety, R-TT-01), so it is measured over HTTP only.

`strapi-plugin-writesafe-mcp` is not measured: no such repository or package exists (the public repo is `strapi-plugin-writesafe`, a Strapi
plugin that needs a running Strapi and database, so it cannot start over stdio without a project around it).

Per profile: 3 s warm-up, then 20 s measured, 8 concurrent calls (HTTP: 8 sessions), **3 repeats on a fresh data directory each**. The HTTP profile
adds an 8 s churn pass per repeat (each worker connects, makes 3 calls, disconnects, repeats). One server takes about 2 to 4 minutes.

Each server gets a clean environment (`PATH`, a throwaway `HOME`, nothing else), and servers bind `127.0.0.1` on a free port that is never one of
4710, 4711, 47310 or 47311.

## Why not the sandbox

Third-party servers run only in the gVisor sandbox (`mcp-surface-corpus`, `sandbox-guard`). These four are ours, the job holds no secret
(`permissions: contents: read`, no token passed to a measured process), and gVisor would add syscall cost to exactly the numbers being compared.
So they run on the runner directly. If a server stopped being ours, it would not belong in this file.

## The numbers kept

Per profile (medians over the repeats): `p50_ms`, `p95_ms`, `p99_ms`, `error_rate` (the worst repeat), `ok_per_s`, `p95_spread` (largest p95 over
smallest, a noise reading), the same per scenario step, and for HTTP the churn numbers (`sessions_per_s`, `connect_p50_ms`, `connect_p95_ms`,
`connect_failed`). The result is `tool-qa/perf/1` JSON; it also records the package, version and npm integrity, the Inspector version and flags,
and the runner (`calibration_ms`, CPUs, Node).

### mcp-results fields

The registry has `latency_warm_p50_ms`, `latency_warm_p95_ms` and `robustness_under_load` (all `planned`, source `scan-live`). Those describe a
third-party scan, a different measurement, and they are not filled from this job. This job needs its own fields. Proposed, not added to the
registry here: `perf_load_p50_ms`, `perf_load_p95_ms`, `perf_load_p99_ms`, `perf_load_error_rate`, `perf_load_ok_per_s`, `perf_churn_sessions_per_s`,
`perf_churn_connect_p95_ms`, each per profile, and `perf_load_runner_calibration_ms`. Until they are decided, the JSON files in
`perf/baselines/` are the record.

## Baselines

`perf/baselines/<server>/<version>.json`, committed. A scheduled run measures a server only when its latest npm release has no baseline file, so
each release is measured once. The run's result is an artifact (90 days); to make it the baseline for the next release, commit it under that name.
The first baselines were taken from the workflow run on GitHub's runners, not from a laptop, so they share the runner type that later runs use.

Triggers: weekly (Wednesday 05:41 UTC), `workflow_dispatch` (server, exact version, force, duration, repeats), and a pull request that changes
`perf/**` (a forced run of the current releases). A release tag in the server's own repository does not trigger it directly: that would need a
cross-repository token. The release is published to npm, and the next weekly run finds it.

## The verdict

A run is compared with the baseline of the newest earlier version of **the same server** (`previousVersion`; a different server is refused with an
error). Shared runners are noisy, so the limits are generous and apply to medians of three repeats:

| | amber | red |
|---|---|---|
| p95 | above 1.5x the baseline **and** more than 2 ms above | above 2.5x **and** more than 5 ms above |
| p50 | above 1.75x and 1 ms (amber only) | |
| error rate | 0.2 percentage points above | 2 points above |
| ok calls per second | below half the baseline | below 30 percent |

- **Both a ratio and a millisecond margin must be exceeded**, so a sub-millisecond server cannot go red on a 0.3 ms wobble.
- **Calibration.** Each run times a fixed CPU job (`calibration_ms`). The baseline is scaled by the ratio of the two, when the ratio is between 0.5 and 2,
  so a slower runner does not read as a regression. Outside that band the raw numbers are compared and the report says so.
- **Run-to-run noise is real.** The same four releases measured a second time, on other runner machines, differed from the first baselines by up to 1.4x in raw p95 (kronicle-lite over stdio: 46.5 ms, then 32.7 ms) and by 40 percent in throughput. After calibration all four compared as ok, and the limits above sit well outside that spread. Do not tighten them without more runs.
- **Noise.** If the run's own repeats disagree by more than 3x (p95 spread), red is shown as amber and the report says to run it again.
- **A first baseline must be clean**: failed calls above 2 percent, or a profile that did not complete, is red even with nothing to compare.
- Amber prints a GitHub warning annotation. Red fails the job (the artifact is still kept).

## The control

Before measuring anything, each job runs `test/perf-harness.test.mjs`: the real harness against `perf/fixture-server.mjs`, a dependency-free
server with one read-only tool, once fast and once with a 20 ms delay. The slowed run must be **red** against the fast one, and a second fast run
must be neither amber nor red. If the harness cannot see a planted slowdown, nothing is recorded.

## Kill switches

The first job runs `scripts/guard.mjs --job perf --no-slots`: `LOOP_ENABLED` must be exactly `true`, `LOOP_PAUSE_UNTIL` must be past, and the lane
variable `LANE_PERF_ENABLED` must not be set to anything but `true`.

## Running it by hand

```sh
npm ci --prefix perf --ignore-scripts
npm install --prefix /tmp/srv --ignore-scripts --no-save kronicle-lite@0.12.1 && (cd /tmp/srv && npm rebuild better-sqlite3)
node perf/run.mjs --server kronicle-lite --srv-dir /tmp/srv --out /tmp/result.json
node perf/compare.mjs --result /tmp/result.json
```

A laptop run is for looking, not for a baseline: only runs from the workflow are committed.
