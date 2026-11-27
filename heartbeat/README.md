# Loop heartbeat

A Cloudflare Worker that restarts the loop when GitHub's own mechanisms don't. Every 5 minutes it checks every
scheduled workflow in isokron-ai/tool-qa that should keep running. It dispatches a workflow that has nothing queued or
running and whose newest run started too long ago.

| Workflow | Schedule | Restart after (staleMin) | Stuck after (stuckMin) | Lane variable | Notes |
|---|---|---|---|---|---|
| `pump.yml` | self-chain, `*/30` | 15 min | 40 min | `LANE_PUMP_ENABLED` | also held by `LOOP_SLOTS=0` |
| `watchdog.yml` | every 15 min | 40 min | 20 min | `LANE_WATCHDOG_ENABLED` | |
| `state-snapshot.yml` | hourly | 90 min | 20 min | `LANE_STATE_SNAPSHOT_ENABLED` | a failed newest run is retried after 30 min |
| `keep-forever.yml` | every 6 h | 7 h | 80 min | `LANE_KEEP_FOREVER_ENABLED` | |
| `offsite-backup.yml` | every 6 h | 7 h | 80 min | `LANE_OFFSITE_ENABLED` | |
| `ledger.yml` | daily | 26 h | 20 min | `LANE_LEDGER_ENABLED` | |
| `history-packages.yml` | daily | 26 h | 3 h | `LANE_HISTORY_PACKAGES_ENABLED` | |
| `history-popularity.yml` | daily | 26 h | 90 min | `LANE_HISTORY_POPULARITY_ENABLED` | sends `mode=stars`, or `all` on Monday (UTC), as its own schedule does |
| `history-registry.yml` | daily full capture | 26 h | 60 min | `LANE_HISTORY_REGISTRY_ENABLED` | only runs named `history-registry full` count; sends `mode=full` |
| `perf-baselines.yml` | weekly | 8 days | 40 min | `LANE_PERF_ENABLED` | |
| `chaos-soak.yml` | weekly | 8 days | 2 h | none (no guard step) | in-memory simulation only |

`publish-results.yml` is not watched: it is off by design (`RESULTS_PUBLISH_ENABLED`).

**How the numbers were chosen.** `staleMin` is about 1.5 to 2 times the schedule, because GitHub's scheduler fires late.
`stuckMin` is twice the workflow's largest `timeout-minutes`. The lane variable is the one the workflow's own guard step
reads (a test checks it against each workflow file, so perf is `LANE_PERF_ENABLED`, not a name derived from the file).
The registry's daily full capture needs its own filter because the pump dispatches a delta capture about every 15
minutes, so the newest `history-registry.yml` run is always recent.

**Which runs count.** Only runs on `main` (a pull request run, e.g. perf-baselines', cannot hide a missed scheduled run).
The registry lists the window of `staleMin` + 30 min with `created=>=`, paging until its full run shows up.

**Failed runs.** The newest run counts whatever its conclusion, so a daily or weekly workflow that keeps failing is
retried only after its `staleMin`, not every 5 minutes. The one exception is `state-snapshot.yml` (`retryFailedAfterMin`
30): a stale backup is the risk, so a failed newest run is retried after 30 minutes. After 3 failed runs in a row it
stops the fast retry (back to `staleMin`) and logs `ALERT ... failing repeatedly: N runs in a row`.

**Why it exists.** On 25 Nov 2026 a GitHub outage broke the pump's self-dispatch chain, and the `*/30` schedule fallback
didn't fire after recovery. In the 24 hours after that the pump ran 1 of 48 scheduled runs, the watchdog 2 of 96, the
hourly state snapshot 3 of 24, and keep-forever and offsite-backup 2 of 4 each; the snapshot went 16.7 hours without a
good run, and nothing retried the failed daily ledger. GitHub's scheduled runs are unreliable under load: that week the `*/15` schedules ran every
5–9 hours. This Worker doesn't depend on GitHub's scheduler.

**Safety.**
- **Kill switches.** It reads the loop's variables the way `scripts/guard.mjs` does. It dispatches nothing while
  tool-qa's `LOOP_ENABLED` variable is not `true`, while `HEARTBEAT_ENABLED` (in `wrangler.toml`) is not `true`, or when
  it can't read the variables (401, 5xx, network). It leaves a workflow alone while `LOOP_PAUSE_UNTIL` is in the future
  (or unreadable) or that workflow's lane variable (table above) is set and not `true`, and the pump alone while
  `LOOP_SLOTS` is set to 0. A variable that isn't set takes the guard's default.
- **Stuck runs.** A run that stays queued longer than twice its workflow's timeout (pump 40 min, watchdog 20 min)
  doesn't count as healthy: the Worker logs a warning and dispatches (the `stuckMin` column).
- **No route.** It only runs on its cron trigger, and has no `workers.dev` URL.
- **Narrow token.** `GH_TOKEN` is a fine-grained token for isokron-ai/tool-qa only. It has **Actions: read and
  write** and **Variables: read**, nothing else.
- **Duplicate dispatches are harmless.** The pump's concurrency group (`pump`, `cancel-in-progress: false`) keeps one
  run going and one pending, and a newer pending run supersedes an older one. The watchdog has the same shape.

**Cost.** It makes 288 runs a day. The Workers free plan allows 50 subrequests per run; a tick reads all repository
variables in one call (GitHub lists 30 per page; at most 10 pages, more means nothing is done), makes one run-list call per workflow (11; the registry
reads up to 3 pages of 100 until it finds its full run), and sends at most 4 dispatches, so at most 27 calls, and a hard stop at 40. If more than 4 workflows need a dispatch (an
outage recovery), the rest wait for the next tick, in table order.

## Deploy (owner)

1. Create a fine-grained token on GitHub (Settings → Developer settings → Fine-grained tokens):
   - Resource owner: isokron-ai
   - Repository access: only isokron-ai/tool-qa
   - Repository permissions: Actions (read and write) and Variables (read only). That covers everything above: run lists, dispatches for every
     workflow, and the variables list. No new permission is needed for the extra workflows
   - Expiry: 1 year. Put the renewal date in the runbook.
2. In this folder, run `npx wrangler@4 login` to sign in to Cloudflare.
3. Run `npx wrangler@4 secret put GH_TOKEN` and paste the token. It's stored only as a Worker secret.
4. Run `npx wrangler@4 deploy`.
5. Watch the logs with `npx wrangler@4 tail`. Within 5 minutes you should see one `heartbeat: <workflow>: ok (...)` line per watched workflow.

**To stop it:** set `HEARTBEAT_ENABLED = "false"` and redeploy, or run `npx wrangler@4 delete`.

## Report to the live loop view (REPORT_ENABLED)

Besides restarting workflows, the heartbeat Worker can write one public file for the live loop view:
`v1/heartbeat.json` in the R2 bucket `isokron-loop-live` (binding `LIVE`, served only through `live.isokron.ai`,
`Cache-Control: public, max-age=30`). It is **off** until the owner sets `REPORT_ENABLED = "true"` in `wrangler.toml` and redeploys.

The report runs after the tick in its own `ctx.waitUntil`, only when `REPORT_ENABLED` is exactly `"true"` and the `LIVE` binding exists.
A report that throws, times out or finds nothing to write cannot change what the tick dispatched.

What the file holds (schema `isokron-loop-heartbeat/1`):

| Field | Content |
|---|---|
| `checked_at` | when this report ran |
| `heartbeat` | `on`, `off` (`HEARTBEAT_ENABLED` is not `true`) or `no_token` (no `GH_TOKEN`): a disabled heartbeat never reads as healthy |
| `decisions` | the last 48 of `{at, workflow, action, http?}` from the tick, kept in the same object. `action` is `ok`, `restarted` (a dispatch the Worker sent), `failed` (a dispatch POST that failed), `check_failed` (a read failed: the variables list, as one entry with workflow `*`, or one workflow's run list), `deferred` (a dispatch held back by the per-tick cap) or `skipped_switch`. Everything except `restarted` is written when a workflow's state (action and http) changes, not every tick, so a restart stays in the ring through hours of outage |
| `github` | `{checked_at, components: {actions, api, git, webhooks}}`: the status of "Actions", "API Requests", "Git Operations" and "Webhooks" from githubstatus.com `components.json` |
| `health` | `{checked_at, updated, overall, checks: [{id, status, at?, summary?}]}` (at most 80 checks, red and amber first, then the core liveness and backup items, then the lane items; what does not fit is one `more-checks` entry saying how many) from the `loop-health:v1` block of issue #40, read with `GH_TOKEN` (retried once without it on 401, 403 or 404). Summary text only for `pump`, `slots`, `dispatches`, `history-*` and `sandbox-breaker`, with URLs removed; no links, no other fields. Needs `GH_TOKEN` to have **Issues: read** for a reliable read; until it does, the 403 falls back to an unauthenticated read of the public issue (which can be rate limited) |

A source that cannot be read becomes `{error: "unavailable", checked_at}` for that section only.

**Scan before writing.** The document is serialized once, the serialized text is scanned (and each string by path) for token, key, email and canary
patterns (a minimal copy of `ingest/redact.mjs`, `heartbeat/scan.mjs`) and for AI vendor and model names (the R-PUB-08 word list), and
that same text is what is written. On a hit the log names the rule and path, never the text, and the report falls back in steps: drop every
`health.checks[].summary` and rescan; if still dirty replace the `health` section with `{error: "unavailable"}` and rescan; only if still dirty write nothing.
The old file stays, so the page shows its age.

**Concurrent writers.** The read-append-write uses the object's etag (`onlyIf`): if another writer changed the file in between, this tick skips the write. An
existing file over 64 KB or that does not parse is treated as empty (and logged). The two fetches time out after 5 s. The report module is loaded
inside the report branch, so a load failure cannot stop the tick.

**To stop it:** set `REPORT_ENABLED = "false"` and redeploy (the tick is unaffected). To remove what is already public, delete
`v1/heartbeat.json` from the bucket. The first deploy with the report needs the bucket to exist and the `LIVE` binding in `wrangler.toml`
(already declared); do not enable it before the owner's go.
