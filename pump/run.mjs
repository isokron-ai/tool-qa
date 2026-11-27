#!/usr/bin/env node
// The pump: one run of .github/workflows/pump.yml.
//
//   node pump/run.mjs [--state state/state.sqlite] [--successor-result <file>]
//                     [--max-minutes 11] [--tick-seconds 150] [--ingest-out <dir>] [--keep-out <dir>]
//                     [--state-archive-out <dir>]
//   node pump/run.mjs --plan [--state <file>]   print the due list from a local file
//
// A run pulls the state database from its Release asset, then ticks every
// 150 seconds for about 11 minutes, then pushes the state back. Each tick:
//
//   1. reap     close dispatches whose lease expired and free their slots,
//               before ingest looks at anything, so a dispatch that cannot be
//               judged stops being an open one when its lease ends (it is then
//               only looked at as a late result, at most every ten minutes for
//               six hours; R-ING-06).
//   2. ingest   judge the results of worker runs that finished and record them
//               (ingest/collect.mjs). Only until two minutes before the end, so
//               the last results are in the state before the final push.
//   3. tick     reap again (a no-op unless ingest took long), then dispatch due
//               work into free slots (pump/tick.mjs).
//   4. push     the state, if the tick recorded, dispatched, failed or reaped
//               anything, so a run that dies loses little.
//
// At the end of the run, before the last push, it prunes closed history out of
// the state (pump/prune.mjs, state/prune.mjs): it deletes the rows a sealed
// archive staged by an earlier run holds, once that archive's artifact reads
// back, and stages the next archive into --state-archive-out, which pump.yml
// uploads. Then it records the state's size (kv state.size) for the watchdog.
//
// Dispatches are saved before they are sent: the tick records them as
// pending, the pump pushes the state, and only then are they sent (R-ING-10).
// A run killed after sending leaves pending dispatches that hold their slots
// until their leases expire, never worker runs the state does not know. The
// cost is one more push in a tick that dispatches. After any failed push the
// run dispatches nothing more and ends after one housekeeping tick (R-ING-09).
//
// The sandbox circuit breaker (pump/breaker.mjs): when an enabled workflow runs
// third-party code, every tick that may dispatch reads the public nightly
// sandbox conformance status. While that status is red, older than 36 hours,
// unreadable, older than one already seen, or (when green) not backed by a
// successful nightly run on main, no such workflow is dispatched (they are
// left out of the tick's due list); source-only workflows
// (`"runs_untrusted": false`) still are. What the run saw is kept as
// `pump.breaker` in the state and in `pump.last_tick`; the newest status seen
// and the run verified are kept as `pump.conformance`.
// Work already dispatched is not recalled: it runs the sandbox self test on its
// own runner before any target.
//
// The pump is the state's only writer: ingest runs inside it, never as a
// separate job. Before it dispatches anything, the run checks that ingest can
// judge the results (worker-kit/ingest.pub holds the real key and AGE_IDENTITY
// matches it). If not, it says why, dispatches nothing, does one housekeeping
// tick and fails. With LOOP_SLOTS=0 the run does one housekeeping tick
// (ingest, reap) and dispatches nothing.
//
// Environment:
//   LOOP_SLOTS          worker slots (the guard step's `slots` output)
//   GITHUB_REPOSITORY   this repository (holds the state asset)
//   GITHUB_TOKEN        job token with contents: write, for the state asset, and
//                       the subject id lookups (GraphQL reads of public
//                       repositories, pump/identity.mjs)
//   APP_ID, APP_INSTALLATION_ID, APP_PRIVATE_KEY
//                       the loop's GitHub App; tokens are minted per worker
//                       repository: actions: write to dispatch, actions: read
//                       for ingest
//   AGE_IDENTITY        the ingest age identity (decrypts results, and the state
//                       asset); removed from the process environment once read
//   AGE_BIN, AGE_KEYGEN_BIN, GITHUB_API_URL, RUNNER_TEMP   optional
//   GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT   name the state archive this run stages
//   LANE_STATE_PRUNE_ENABLED   anything but unset, empty or "true" stops pruning
//   LANE_SUBJECT_IDS_ENABLED   anything but unset, empty or "true" stops the
//                      subject id lookups (pump/identity.mjs)
//   LANE_HEADS_ENABLED   only the exact value "true" runs the head poll
//                      (pump/heads.mjs): new default-branch heads and releases
//                      move subjects' sha and changed_at
//   LANE_LIVE_SNAPSHOT_ENABLED   only the exact value "true" publishes the live
//                      loop snapshot to R2 (live/publish.mjs); with
//                      LIVE_R2_ACCESS_KEY_ID, LIVE_R2_SECRET_ACCESS_KEY,
//                      R2_ACCOUNT_ID (and LIVE_R2_BUCKET, default isokron-loop-live)
//
// Ingest outputs are sealed to worker-kit/ingest.pub and written to --ingest-out
// (default $RUNNER_TEMP/ingest-out); pump.yml uploads that directory. The keep-forever
// part of each (loop upgrade 20) goes to --keep-out (default keep-out beside it).

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createCollector, IngestSetupError, LATE_MS } from '../ingest/collect.mjs';
import { artifactFetcher, pruneStep, recordStateSize } from './prune.mjs';
import { sleepUnless } from '../ingest/github.mjs';
import { openState } from '../state/db.mjs';
import { pullState, pushState, stateCrypto } from '../scripts/state-asset.mjs';
import { appTokenMinter } from './app-token.mjs';
import { ApiBudget, budgetedFetch } from './budgets.mjs';
import { allowedWorkflows, judgeConformance, pinMismatches, readConformance as readConformanceStatus, untrustedWorkflows, verifyRun } from './breaker.mjs';
import { createDispatcher } from './dispatch.mjs';
import { dueFromState, isEnabled, loadConfig, NO_HOOKS } from './due.mjs';
import { samplingHooks, activeSubjects } from './sampling.mjs';
import { lanePinModes } from './pins.mjs';
import { createClient, scrub } from './github.mjs';
import { POLICY } from './retry.mjs';
import { createReleaseClient } from '../snapshot/github.mjs';
import { NAME_RE as SNAPSHOT_NAME_RE, SNAPSHOT_TAG } from '../snapshot/snapshot.mjs';
import { computeBudget, reapExpired } from './slots.mjs';
import { SEED_FILE, syncSeedSubjects } from './subjects.mjs';
import { IDENTITY_KV_KEY, identityEnabled, refreshIdentities } from './identity.mjs';
import { HEADS_KV_KEY, headsEnabled, refreshHeads } from './heads.mjs';
import { planShards, runTick } from './tick.mjs';
import { ensureRegistryDelta, registryLaneOn } from './registry-delta.mjs';
import { liveEnabled, publishLive, publishRetry } from '../live/publish.mjs';
import { NOT_BUILT_LANES } from '../live/build.mjs';
import { computeCoverage, recordCoverageDay } from '../state/coverage.mjs';
import { HISTORY_TIMES_KEY, HISTORY_TIMES_REFRESH_MS, historyList, historyTimesDue, refreshHistoryTimes } from './history-times.mjs';

const DEFAULT_STATE = 'state/state.sqlite';
// How long the first pull may keep retrying, and how long past its deadline the
// last push may. The job's timeout-minutes (pump.yml) leaves room for both.
export const PULL_RETRY_MS = 120_000;
export const FINAL_PUSH_GRACE_MS = 90_000;
export const FINAL_REQUEST_TIMEOUT_MS = 30_000;
// The registry delta capture is checked at most this often within a run.
export const REGISTRY_DELTA_CHECK_MS = 5 * 60_000;
export const REGISTRY_DELTA_WINDOW_MS = 60_000;
export const REGISTRY_DELTA_KEY = 'pump.registry_delta';
export const BUDGET_KEY = 'pump.api_budget';
export const BREAKER_KEY = 'pump.breaker';
export const CONFORMANCE_KEY = 'pump.conformance';
// While a retry is open the live snapshot is uploaded at once, at most this often.
export const LIVE_RETRY_UPLOAD_MS = 20_000;
export const LIVE_DEADLINE_MS = 20_000;
export const LIVE_FINAL_DEADLINE_MS = 5_000;
// Between ticks the snapshot is published about this often (live.publishEveryMs in tests; 0 turns it off).
export const LIVE_PUBLISH_MS = 60_000;
// The history time lookup (pump/history-times.mjs) gets this long within a tick.
export const HISTORY_TIMES_WINDOW_MS = 15_000;
export const LANE_NOTES_FILE = fileURLToPath(new URL('../live/lane-notes.json', import.meta.url));
// The values the run read that the snapshot builder shows (build plan section 3).
export const LIVE_SWITCH_VARS = ['LOOP_ENABLED', 'LOOP_PAUSE_UNTIL', 'LOOP_SLOTS', 'RESULTS_PUBLISH_ENABLED', 'LANE_HISTORY_REGISTRY_ENABLED', 'LANE_HISTORY_PACKAGES_ENABLED', 'LANE_HISTORY_POPULARITY_ENABLED'];
// What the secrets scrub list covers beyond the GitHub ones (also used by tests).
export const secretValues = (env) => [env.GITHUB_TOKEN, env.APP_PRIVATE_KEY, env.AGE_IDENTITY, env.LIVE_R2_ACCESS_KEY_ID, env.LIVE_R2_SECRET_ACCESS_KEY, env.R2_ACCOUNT_ID];

const isSetupError = (err) => err instanceof IngestSetupError || err?.name === 'IngestSetupError';

/**
 * seedFile: the seed list loaded into the subjects table at start-up
 * (pump/subjects.mjs); null loads nothing.
 * identity: the subject id lookups at start-up (pump/identity.mjs): undefined
 * for the defaults, null for none, or options for refreshIdentities()
 * (batch, maxQueries, retryMs). They use GITHUB_TOKEN through the run's API
 * budget and never hold the run.
 * heads: the head poll at start-up (pump/heads.mjs): undefined for the
 * defaults, null for none, or options for refreshHeads() (batch, maxQueries,
 * reserve). Only with LANE_HEADS_ENABLED exactly "true"; GITHUB_TOKEN through
 * the run's API budget; never holds the run.
 * ingest: undefined for the pump's own collector (ingest/collect.mjs, built
 * with `ingestOptions`), null for none, a function (called as collect()), or an
 * object with collect() and optionally check().
 *
 * live: the live snapshot step (live/publish.mjs), for tests: `build` (default
 * live/build.mjs, loaded by publishLive), `put` (default R2), `publish`,
 * `publishRetry`, `scan`, `deadlineMs`, `finalDeadlineMs`.
 *
 * @returns {Promise<{ ok: boolean, ticks: number, dispatched: number, failed: number,
 *   workerSlots: number, loopBudget: number }>}
 */
export async function runPump({
  env = process.env,
  now = Date.now,
  sleep = sleepUnless,
  fetch = globalThis.fetch,
  log = (line) => process.stderr.write(`${line}\n`),
  stateFile = DEFAULT_STATE,
  seedFile = SEED_FILE,
  identity,
  heads,
  config,
  pull = pullState,
  push = pushState,
  mintToken,
  dispatcher,
  budget,
  ingest,
  ingestOptions = {},
  ingestStopMs = 2 * 60_000,
  successorFile,
  maxRunMs = 11 * 60_000,
  tickIntervalMs = 150_000,
  newId,
  readConformance,
  verifyConformanceRun,
  countSnapshots,
  archiveDir,
  prune = {},
  crypto,
  fetchArchive,
  registryDelta,
  live = {},
} = {}) {
  const start = now();
  const deadline = start + maxRunMs;
  const ingestDeadline = deadline - ingestStopMs;
  const repo = env.GITHUB_REPOSITORY;
  const stateToken = env.GITHUB_TOKEN || undefined;
  const secrets = secretValues(env).map((v) => (v === env.GITHUB_TOKEN ? stateToken : v));
  // The state asset is age ciphertext (R-ING-15): pulled and pushed with the
  // same identity ingest uses, which must be a recipient in state/state.pub.
  const stateKeys = {
    identity: env.AGE_IDENTITY || undefined,
    ageBin: env.AGE_BIN || undefined,
    keygenBin: env.AGE_KEYGEN_BIN || undefined,
    tmpDir: env.RUNNER_TEMP || undefined,
  };
  const safe = (text) => scrub(text, secrets);
  const say = (line) => log(safe(line));
  const cfg = config ?? loadConfig();
  const { requested, loopBudget, workerSlots } = computeBudget({ loopSlots: env.LOOP_SLOTS });
  say(`pump: LOOP_SLOTS=${requested}, loop budget ${loopBudget}, worker slots ${workerSlots}`);

  const bud = budget ?? new ApiBudget({ now, sleep });

  // Retries (pump/retry.mjs) are counted per tick for the `retry` event, and the
  // open one goes into the live snapshot. `source` is a fixed label, never a URL.
  const tickRetries = new Map(); // source -> { label, status, attempts, gave_up }
  let openRetry = null; // { call, status, attempt, of, next_at, since }
  let liveHook = () => {}; // set once the state is open (below)
  const retryHook = (source) => (info) => {
    const t = tickRetries.get(source) ?? { label: source, status: 0, attempts: 0, gave_up: false };
    t.attempts += 1;
    t.status = info.status;
    t.gave_up = t.gave_up || info.gaveUp === true;
    tickRetries.set(source, t);
    if (!info.gaveUp) {
      openRetry = { call: source, status: info.status, attempt: info.attempt, of: info.of ?? POLICY.attempts, next_at: new Date(now() + (info.delayMs ?? 0)).toISOString(), since: openRetry?.since ?? new Date(now()).toISOString() };
    }
    liveHook();
  };
  const mask = (token) => {
    secrets.push(token);
    if (env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${token}\n`);
  };
  let minter = mintToken;
  const lazyMint = async (args) => {
    minter = minter ?? appTokenMinter({ env, fetch, now, sleep, budget: bud, retryUntil: () => deadline, onRetry: retryHook('app_token') });
    const out = await minter(args);
    mask(out.token);
    return out;
  };
  let disp = dispatcher;
  const getDispatcher = () => {
    disp = disp ?? createDispatcher({ mintToken: lazyMint, fetch, budget: bud, now, sleep, pollAttempts: 4, pollIntervalMs: 4000, log: say, retryUntil: () => deadline, onRetry: retryHook('github_api') });
    return disp;
  };
  const apiUrl = env.GITHUB_API_URL || 'https://api.github.com';
  let collector;
  if (ingest === undefined) {
    // Ingest holds each lane to the pin_check of the config the pump dispatched with (R-PIN-01).
    collector = createCollector({
      env, fetch: budgetedFetch(fetch, bud, { apiUrl }), apiUrl, sleep, ...ingestOptions,
      judge: { pinModes: lanePinModes(cfg.workflows), ...(ingestOptions.judge ?? {}) },
    });
  } else if (typeof ingest === 'function') {
    collector = { collect: ingest };
  } else {
    collector = ingest || null;
  }
  // The collector has its copy; nothing the pump starts needs it.
  if (env === process.env) delete process.env.AGE_IDENTITY;

  let ok = true;
  let blocked = null; // why nothing may be dispatched (or judged) this run
  const block = (err) => {
    ok = false;
    blocked = err?.message ?? String(err);
    say(`pump: ingest is not ready, so nothing is dispatched this run: ${blocked}`);
  };
  const enabled = Object.values(cfg.workflows ?? {}).some(isEnabled);
  if (workerSlots > 0 && enabled && typeof collector?.check === 'function') {
    // Only local checks (keys): no API calls.
    try {
      await collector.check();
    } catch (err) {
      if (!isSetupError(err)) throw err;
      block(err);
    }
  }

  // The breaker: the status is read on every tick that may dispatch an
  // untrusted workflow (one GET), and its run looked up once (R-WD-01, R-WD-05).
  const untrusted = untrustedWorkflows(cfg.workflows, { enabledOnly: true });
  let lastBreaker = null;
  const breakerNow = async (db) => {
    let read;
    try {
      read = await (readConformance ?? (() => readConformanceStatus({ fetch, sleep })))();
    } catch (err) {
      read = { error: String(err?.message ?? err).slice(0, 200) };
    }
    const verify = verifyConformanceRun ?? ((status, o) => verifyRun({ fetch, status, token: stateToken, ...o }));
    const j = await judgeConformance({ read, now: now(), memory: db.getKv(CONFORMANCE_KEY) ?? null, verify });
    if (j.changed) db.setKv(CONFORMANCE_KEY, j.memory, { now: now() });
    const { memory: _m, changed: _c, ...b } = j;
    return { ...b, held: b.tripped ? untrusted : [], mismatch: b.tripped ? [] : pinMismatches(cfg.workflows, b.sandbox_sha) };
  };

  // The run cannot start without its state. When the state itself is wrong
  // (not a passing GitHub error), it also takes back the successor it
  // dispatched (R-CHAOS-03): otherwise every run fails at this point and
  // starts the next one at once, a failing run a minute until a person steps
  // in. The schedule and the watchdog still try every 30 minutes.
  let db;
  // Sampling for `mode: sample` tier cells: SAMPLE_RATE_T<n> / SAMPLE_CAP_T<n>; unset is rate 0 (nothing picked).
  const sampleHooks = samplingHooks({ env, population: () => activeSubjects(db) });
  let pulled;
  try {
    pulled = await pull({ repo, token: stateToken, file: stateFile, fetch, log: say, clock: now, retryUntil: start + PULL_RETRY_MS, onRetry: retryHook('state_asset'), ...stateKeys });
    // No state asset, but snapshots of one: the state was lost, not never
    // made. Starting from empty would silently throw away every result and
    // the fence counter (R-CHAOS-01); a person restores a snapshot instead.
    if (pulled?.status === 'absent') {
      const n = await (countSnapshots ?? (() => snapshotCount({ repo, token: stateToken, fetch, apiUrl, sleep })))();
      if (n > 0) {
        throw new Error(`the state asset is missing, but ${n} snapshot(s) of it are on the "${SNAPSHOT_TAG}" release: refusing to start from an empty state. Restore a snapshot (snapshot/restore.mjs drill --apply; docs/OPERATIONS.md, "State snapshots")`);
      }
    }
    db = openState(stateFile);
    db.log = say; // a failed event insert is one line here; its fact is kept
  } catch (err) {
    say(`pump: cannot start: ${err?.message ?? err}`);
    // A GitHub outage or rate limit may pass by the next run: the chain goes on.
    if (err?.transient !== true) await cancelSuccessor({ successorFile, repo, mint: lazyMint, fetch, apiUrl, budget: bud, now, sleep, say, retryUntil: () => deadline });
    throw err;
  }
  // Coverage history (state/coverage.mjs): one compact entry per UTC day, so a score is kept against the frame of its day.
  try {
    recordCoverageDay(db, computeCoverage(db, { tiers: cfg.tiers, workflows: cfg.workflows, skipLanes: [...NOT_BUILT_LANES] }), { now: now() });
  } catch (err) {
    say(`pump: coverage history not recorded: ${String(err?.message ?? err).slice(0, 120)}`);
  }
  // The hourly API caps hold across runs (R-ING-11): this run starts with the
  // calls earlier runs made in the last hour, and leaves its own for the next.
  if (typeof bud.restore === 'function') bud.restore(db.getKv(BUDGET_KEY));
  const keepBudget = () => {
    if (typeof bud.snapshot === 'function') db.setKv(BUDGET_KEY, bud.snapshot(), { now: now() });
  };
  // The live loop snapshot (live/publish.mjs). Off unless LANE_LIVE_SNAPSHOT_ENABLED
  // is exactly "true" and the credentials exist; never throws, never holds the
  // run past its deadline.
  //
  // Two uploads, kept apart on purpose:
  //   - the snapshot (reads the state): only at a tick boundary and once at the
  //     end of the run, awaited right there, so it never overlaps ingest, the
  //     identity step or a transaction (publishLive also refuses inside one);
  //   - v1/retry.json (the open retry, from memory, never touches the state):
  //     while a retry is open, at most once per 20 s, and once when it clears.
  //     Not awaited by the run.
  const liveCap = () => Math.max(0, Math.min(live.deadlineMs ?? LIVE_DEADLINE_MS, deadline - now()));
  const liveCommon = () => ({
    ...(live.put ? { put: live.put } : {}), env, fetch: live.fetch ?? fetch, now, log: say,
  });
  // Short notes the builder may show per lane ({lane: noteKey|null}), from a
  // committed file read at publish time; missing or invalid means none.
  const laneNotes = () => {
    try {
      const v = JSON.parse(readFileSync(live.laneNotesFile ?? LANE_NOTES_FILE, 'utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => x !== null && typeof x !== 'string')) throw new TypeError('not a {lane: key|null} object');
      return v;
    } catch (err) {
      say(`pump: live lane notes unavailable (${String(err?.code ?? err?.name ?? 'error').slice(0, 40)}); publishing without them`);
      return {};
    }
  };
  const liveSwitches = () => Object.fromEntries(LIVE_SWITCH_VARS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  let retryChain = Promise.resolve();
  let lastRetryUpload = -Infinity;
  let retryShown = false;
  const uploadRetry = (value) => {
    const body = value ? { ...value } : null;
    retryChain = retryChain.then(async () => {
      try {
        await (live.publishRetry ?? publishRetry)({ retry: body, ...liveCommon(), ...(live.scan ? { scan: live.scan } : {}), deadlineMs: liveCap() });
      } catch (err) {
        say(`pump: live retry upload failed (continuing): ${scrub(err?.message ?? String(err), secrets)}`);
      }
    });
  };
  liveHook = () => {
    if (!openRetry || !liveEnabled(env) || now() - lastRetryUpload < LIVE_RETRY_UPLOAD_MS) return;
    lastRetryUpload = now();
    retryShown = true;
    uploadRetry(openRetry);
  };
  // End of a tick: the tick's retries become `retry` events, the open one closes.
  const flushRetries = () => {
    const rows = [...tickRetries.values()];
    tickRetries.clear();
    openRetry = null;
    if (retryShown) {
      retryShown = false;
      uploadRetry(null);
    }
    if (!rows.length) return;
    try {
      db.tx(() => {
        for (const r of rows) db.recordEvent({ type: 'retry', data: { label: r.label, status: r.status, attempts: r.attempts, gave_up: r.gave_up } }, now());
      });
    } catch (err) {
      say(`pump: could not record retry events (continuing): ${err?.message ?? err}`);
    }
  };
  // config.history for the snapshot: when registry-full, packages and popularity
  // last succeeded, from kv `pump.history_times`, refreshed at most every 30
  // minutes (never at the end-of-run upload). Nothing at all unless the live
  // switch is on. Never throws; a failed read keeps the cached values.
  let historyClient = null;
  let historyUntil = deadline;
  let lastHistoryTry = -Infinity;
  const historyStep = async ({ final = false } = {}) => {
    if (!liveEnabled(env)) return [];
    let cached = null;
    try {
      cached = db.getKv(HISTORY_TIMES_KEY) ?? null;
      if (!final && repo && now() - lastHistoryTry >= HISTORY_TIMES_REFRESH_MS && historyTimesDue(cached, now())) {
        lastHistoryTry = now();
        const until = Math.min(deadline, now() + HISTORY_TIMES_WINDOW_MS);
        if (until > now()) {
          if (!historyClient) {
            const { token } = await lazyMint({ repositories: [repo.split('/')[1]], permissions: { actions: 'read' } });
            historyClient = createClient({ token, fetch, apiUrl, budget: bud, now, sleep, log: say, retryTotalMs: HISTORY_TIMES_WINDOW_MS, requestTimeoutMs: 10_000, retryUntil: () => historyUntil, onRetry: retryHook('github_api') });
          }
          historyUntil = until;
          const r = await refreshHistoryTimes({ client: historyClient, repo, now: now(), cached, until, clock: now, log: say });
          if (r.refreshed) {
            cached = r.record;
            db.setKv(HISTORY_TIMES_KEY, r.record, { now: now() });
          }
        }
      }
    } catch (err) {
      say(`pump: history times unavailable (continuing): ${scrub(err?.message ?? String(err), secrets)}`);
    }
    return historyList(cached);
  };
  // The snapshot at a tick boundary, or the last one of the run (capped at 5 s).
  const liveStep = async (reason, { final = false } = {}) => {
    try {
      const deadlineMs = final ? Math.min(live.finalDeadlineMs ?? LIVE_FINAL_DEADLINE_MS, live.deadlineMs ?? LIVE_DEADLINE_MS) : liveCap();
      await (live.publish ?? publishLive)({
        db, ...(live.build ? { build: live.build } : {}), ...liveCommon(), config: { ...cfg, switches: liveSwitches(), history: await historyStep({ final }), lane_notes: laneNotes() }, retry: openRetry,
        version: env.GITHUB_SHA ? String(env.GITHUB_SHA).slice(0, 7) : undefined, deadlineMs,
      });
    } catch (err) {
      say(`pump: live snapshot (${reason}) failed (continuing): ${scrub(err?.message ?? String(err), secrets)}`);
    }
  };
  // The wait between ticks, with the same snapshot publish as at a tick boundary
  // about every LIVE_PUBLISH_MS (never more often: an unchanged body is not
  // uploaded again anyway, and the history lookup keeps its own 30 minute
  // cache). A publish is skipped when the live switch is not exactly "true",
  // inside a state transaction, when it could run past the deadline, or when
  // the next tick is due before its cap would end, so it never delays a tick.
  const sleepToNextTick = async (next, from) => {
    const every = live.publishEveryMs ?? LIVE_PUBLISH_MS;
    let last = from;
    while (every > 0 && liveEnabled(env)) {
      const at = Math.max(now(), last + every);
      const cap = Math.min(live.deadlineMs ?? LIVE_DEADLINE_MS, LIVE_DEADLINE_MS);
      if (at + cap > next || at + cap > deadline) break;
      await sleep(Math.max(0, at - now()));
      last = at;
      if (db.inTx) continue;
      await liveStep('between ticks');
    }
    await sleep(Math.max(0, next - now()));
  };
  let ticks = 0;
  let dispatched = 0;
  let failed = 0;
  // After any failed push nothing more is dispatched: work sent now could be
  // missing from the saved state. The run ends after one housekeeping tick.
  let pushFailed = false;
  const warnedPaused = new Set();
  const save = async (why, { open = true } = {}) => {
    if (open) keepBudget();
    try {
      // Retries (pump/retry.mjs) stop at the run's deadline, so a tick's push
      // cannot hold the run past it; the push at the end of the run may go on a
      // little longer, still inside the job's timeout (R-CHAOS-13).
      await push({ repo, token: stateToken, file: stateFile, fetch, log: say, now: now(), clock: now, retryUntil: open ? deadline : Math.max(deadline, now()) + FINAL_PUSH_GRACE_MS, onRetry: retryHook('state_asset'), ...(open ? {} : { requestTimeoutMs: FINAL_REQUEST_TIMEOUT_MS }), ...stateKeys });
      return true;
    } catch (err) {
      ok = false;
      pushFailed = true;
      say(`pump: state push (${why}) failed: ${err?.message ?? err}; nothing more is dispatched this run`);
      return false;
    }
  };
  try {
    db.notePumpRun('started', { occurredAt: start }, { now: now() });
    if (successorFile && existsSync(successorFile)) {
      let result;
      try {
        result = JSON.parse(readFileSync(successorFile, 'utf8'));
      } catch (err) {
        say(`pump: could not read the successor result: ${err.message}`);
      }
      if (result !== undefined) {
        try {
          db.noteSuccessor(result, { now: now() });
        } catch (err) {
          say(`pump: could not record the successor result in the state: ${err?.message ?? err}`);
        }
      }
    }
    // The seed subjects (pump/subjects.mjs); written only when the seed file changed.
    const seeded = seedFile ? syncSeedSubjects(db, { now: now(), file: seedFile }) : { summary: 'no seed file given' };
    say(`pump: subjects: ${seeded.summary}`);
    if (seeded.error) ok = false;
    // For the watchdog's `subjects` check (R-SUB-11).
    db.setKv('pump.subjects', { ok: !seeded.error, at: new Date(now()).toISOString(), summary: String(seeded.summary).slice(0, 300) }, { now: now() });
    // Subject ids (pump/identity.mjs): backfill and daily re-check, a few
    // GraphQL queries at most; never fails or holds the run (loop upgrade #15).
    if (identity !== null && identityEnabled(env)) {
      const client = stateToken ? createClient({ token: stateToken, fetch, apiUrl, budget: bud, now, sleep, log: say, retryUntil: () => deadline, onRetry: retryHook('github_api') }) : null;
      const ids = await refreshIdentities(db, { client, now, log: say, ...(identity ?? {}) });
      say(`pump: subject ids: ${ids.summary}`);
    } else if (identity !== null) {
      say('pump: subject ids: lookups are off (LANE_SUBJECT_IDS_ENABLED); ids already found are still used');
      // The watchdog shows the item off, not the last pass's colour (R-SUBJ-18).
      db.setKv(IDENTITY_KV_KEY, { ...(db.getKv(IDENTITY_KV_KEY) ?? {}), off: true, at: new Date(now()).toISOString() }, { now: now() });
    }
    // Change detection (pump/heads.mjs): default-branch heads and latest
    // releases of bound subjects, so a change makes them due. A few GraphQL
    // queries at most, after the id pass; never fails or holds the run (A3).
    if (heads !== null && headsEnabled(env)) {
      const client = stateToken ? createClient({ token: stateToken, fetch, apiUrl, budget: bud, now, sleep, log: say, retryUntil: () => deadline, onRetry: retryHook('github_api') }) : null;
      const h = await refreshHeads(db, { client, tiers: cfg.tiers, now, log: say, ...(heads ?? {}) });
      say(`pump: subject heads: ${h.summary}`);
    } else if (heads !== null) {
      // The watchdog shows the item off, not the last pass's colour.
      db.setKv(HEADS_KV_KEY, { ...(db.getKv(HEADS_KV_KEY) ?? {}), off: true, at: new Date(now()).toISOString() }, { now: now() });
    }
    // Registry delta capture (pump/registry-delta.mjs): GitHub's */15 cron for it
    // fires hours late, so the pump dispatches it when the newest capture is
    // stale. registryDelta: undefined for the real check, null for none, or a
    // function called as ({ now, lastDispatchAt }).
    let registryClient = null;
    let registryUntil = deadline;
    let lastRegistryCheck = -Infinity;
    const registryStep = async () => {
      if (registryDelta === null || !repo || !registryLaneOn(env) || now() - lastRegistryCheck < REGISTRY_DELTA_CHECK_MS) return;
      lastRegistryCheck = now();
      try {
        const prior = db.getKv(REGISTRY_DELTA_KEY);
        const lastDispatchAt = prior?.dispatchedAt ? Date.parse(prior.dispatchedAt) : null;
        let r;
        if (typeof registryDelta === 'function') {
          r = await registryDelta({ now: now(), lastDispatchAt: Number.isFinite(lastDispatchAt) ? lastDispatchAt : null });
        } else {
          // Its own short window (REGISTRY_DELTA_WINDOW_MS, never past the run's
          // deadline): a registry outage must not starve the rest of the tick.
          const until = Math.min(deadline, now() + REGISTRY_DELTA_WINDOW_MS);
          if (!registryClient) {
            const { token } = await lazyMint({ repositories: [repo.split('/')[1]], permissions: { actions: 'write' } });
            registryClient = createClient({ token, fetch, apiUrl, budget: bud, now, sleep, log: say, retryTotalMs: REGISTRY_DELTA_WINDOW_MS, requestTimeoutMs: 20_000, retryUntil: () => registryUntil, onRetry: retryHook('github_api') });
          }
          registryUntil = until;
          r = await ensureRegistryDelta({ client: registryClient, repo, ref: env.GITHUB_REF_NAME || 'main', now: now(), lastDispatchAt: Number.isFinite(lastDispatchAt) ? lastDispatchAt : null, lastCaptureAt: Number.isFinite(Date.parse(prior?.captureAt)) ? Date.parse(prior.captureAt) : null, log: say });
        }
        db.noteRegistryDelta(REGISTRY_DELTA_KEY, { ...r, dispatchedAt: r.action === 'dispatched' ? r.at : prior?.dispatchedAt ?? null, captureAt: r.captureAt ?? prior?.captureAt ?? null }, { now: now() });
      } catch (err) {
        // Never blocks the pump.
        say(`pump: registry delta check failed (continuing): ${scrub(err?.message ?? String(err), secrets)}`);
      }
    };
    for (;;) {
      const tickStart = now();
      ticks += 1;
      await registryStep();
      const early = reapExpired(db, { now: tickStart });
      for (const d of early.dispatches) say(`lease expired: closed ${d.workflow} shard ${d.shard_id} (${d.attempt_id})`);
      let ingested = null;
      if (collector && !blocked && tickStart < ingestDeadline) {
        try {
          ingested = (await collector.collect({ db, now, log: say, mintToken: lazyMint, deadline: ingestDeadline })) ?? null;
        } catch (err) {
          if (isSetupError(err)) block(err);
          else say(`pump: ingest failed (continuing): ${err?.message ?? err}`);
        }
        if (ingested?.checked) {
          const outcomes = Object.entries(ingested.outcomes ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
          say(`pump: ingest: checked ${ingested.checked}, judged ${ingested.judged}${outcomes ? ` (${outcomes})` : ''}, waiting ${ingested.waiting}, errors ${ingested.errors}${ingested.stopped ? `, stopped (${ingested.stopped})` : ''}`);
        }
      }
      const slots = blocked || pushFailed ? 0 : workerSlots;
      const breaker = slots > 0 && untrusted.length ? await breakerNow(db) : null;
      if (breaker && (lastBreaker === null || breaker.tripped !== lastBreaker.tripped || breaker.reason !== lastBreaker.reason || breaker.mismatch.length !== lastBreaker.mismatch.length)) {
        say(breaker.tripped
          ? `pump: sandbox breaker open (${breaker.reason}): not dispatching ${breaker.held.join(', ')}: ${breaker.summary}`
          : `pump: sandbox breaker closed: ${breaker.summary}${breaker.mismatch.length ? `; pinned at another sandbox commit than the one tested: ${breaker.mismatch.map((m) => m.lane).join(', ')}` : ''}`);
        db.noteBreaker(BREAKER_KEY, { ...breaker, at: new Date(now()).toISOString() }, { now: now() });
        lastBreaker = breaker;
      }
      const tickConfig = breaker?.tripped ? { ...cfg, workflows: allowedWorkflows(cfg.workflows, breaker) } : cfg;
      // When ingest did not look at everything this tick (the run's last
      // minutes, the API budget), work whose expired dispatch may hold a
      // result that came in on time is not sent again yet: a later tick
      // judges it first (R-CHAOS-02).
      const holdRunKeys = slots > 0 && collector && !(ingested && !ingested.stopped) ? unjudgedLateRunKeys(db, { now: now() }) : null;
      const summary = await runTick({
        db, now, config: tickConfig, hooks: sampleHooks, workerSlots: slots, dispatcher: slots > 0 ? getDispatcher() : null, log: say, newId, deadline, holdRunKeys,
        // The pending dispatches are saved before any is sent (R-ING-10).
        beforeSend: () => save(`tick ${ticks}, before dispatching`),
      });
      summary.reaped += early.dispatches.length;
      summary.reapedSlots += early.slots;
      dispatched += summary.dispatched;
      failed += summary.failed;
      // R-ING-22: a paused workflow fails the run, so the health issue shows it.
      if (summary.paused?.length) {
        ok = false;
        for (const p of db.pausedWorkflows({ now: now() })) {
          if (warnedPaused.has(p.workflow)) continue;
          warnedPaused.add(p.workflow);
          if (p.reason === 'pin_mismatch' || p.reason === 'pin_unverified') {
            say(`pump: ${p.workflow} is paused until ${p.until}: a result was refused for its version pins (${p.reason}; R-PIN-01): the worker ran${p.reason === 'pin_unverified' ? ', or did not prove it ran,' : ''} other code than the versions in pump/workflows.json. Bump the pin to what the worker runs, or make the worker run and report the pin; the pause ends on its own`);
          } else {
            say(`pump: ${p.workflow} is paused until ${p.until}: ${p.count} dispatches in a row ran at another commit than the one recorded at dispatch (run_sha_mismatch). Check that its worker branch is not moving and that no one else dispatches its workflow; the pause ends on its own`);
          }
        }
      }
      const ingestNote = ingested
        ? { checked: ingested.checked, judged: ingested.judged, recorded: ingested.recorded, outcomes: ingested.outcomes, errors: ingested.errors, stopped: ingested.stopped }
        : null;
      db.setKv('pump.last_tick', { ...summary, loopBudget, requested, ingest: ingestNote, blocked, breaker: breaker ? { tripped: breaker.tripped, reason: breaker.reason, held: breaker.held } : null }, { now: now() });
      say(`pump: tick ${ticks}: due ${summary.due ?? '-'}, dispatched ${summary.dispatched}, failed ${summary.failed}, reaped ${summary.reaped}${summary.stopped ? `, stopped (${summary.stopped})` : ''}`);
      flushRetries();
      await liveStep(`tick ${ticks}`);
      if (summary.dispatched || summary.failed || summary.withdrawn || summary.reaped || summary.reapedSlots || ingested?.changed) await save(`tick ${ticks}`);
      if (slots === 0 || summary.stopped === 'unauthorized') break;
      // A failed push: one housekeeping tick (ingest, reap, no dispatch), then stop.
      const next = tickStart + tickIntervalMs;
      if (next >= deadline) break;
      await sleepToNextTick(next, tickStart);
    }
    // Prune closed history and record the state's size (pump/prune.mjs). Not
    // after a failed push: this run's state may not be the one on the release.
    let pruned = null;
    if (!pushFailed) {
      pruned = await pruneStep({
        db, now, env, repo, archiveDir, lateMs: ingestOptions.lateMs ?? LATE_MS, log: say, ...prune,
        crypto: crypto ?? stateCrypto(stateKeys),
        fetchArchive: fetchArchive ?? artifactFetcher({ repo, mintToken: lazyMint, fetch, apiUrl, budget: bud, now, sleep }),
      });
    }
    try {
      recordStateSize(db, { now: now(), assetBytes: Number.isSafeInteger(pulled?.bytes) ? pulled.bytes : null, prune: pruned });
    } catch (err) {
      say(`pump: could not record the state size: ${err?.message ?? err}`);
    }
    keepBudget();
    db.notePumpRun('finished', { ticks, dispatched, lastRun: { started: new Date(start).toISOString(), finished: new Date(now()).toISOString(), ticks, dispatched, failed, workerSlots, loopBudget } }, { now: now() });
    flushRetries();
    await liveStep('end of run', { final: true });
  } finally {
    liveHook = () => {};
    db.close();
  }
  await save('end of run', { open: false });
  return { ok, ticks, dispatched, failed, workerSlots, loopBudget };
}

/**
 * run_keys of items that wait for a late judgment: in a dispatch whose lease
 * expired, that has a run, and for which nothing is recorded yet.
 */
export function unjudgedLateRunKeys(db, { now }) {
  const keys = new Set();
  for (const d of db.dispatchesAwaitingResults({ now, lateMs: LATE_MS })) {
    if (d.status !== 'expired') continue;
    for (const it of db.getAttempt(d.attempt_id)?.items ?? []) if (it.outcome === null) keys.add(it.run_key);
  }
  return keys;
}

/** How many state snapshots the "state-snapshots" release holds (0 if there is no such release). */
export async function snapshotCount({ repo, token, fetch, apiUrl, sleep }) {
  const gh = createReleaseClient({ repo, token, fetch, apiUrl, sleep });
  const release = await gh.getRelease(SNAPSHOT_TAG);
  if (!release) return 0;
  return (await gh.listAssets(release)).filter((a) => SNAPSHOT_NAME_RE.test(String(a.name))).length;
}

/**
 * Cancel the pump run this run dispatched as its successor (pump/successor.mjs
 * wrote its id to `successorFile`). Best effort: it is logged and never throws.
 */
export async function cancelSuccessor({ successorFile, repo, mint, fetch, apiUrl, budget, now, sleep, say, retryUntil }) {
  if (!successorFile || !existsSync(successorFile)) return false;
  let s;
  try {
    s = JSON.parse(readFileSync(successorFile, 'utf8'));
  } catch {
    return false;
  }
  if (!s?.ok) return false;
  const runId = Number(s.runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    say('pump: the successor run has no known id, so it cannot be cancelled; it will fail the same way');
    return false;
  }
  try {
    const { token } = await mint({ repositories: [String(repo).split('/')[1]], permissions: { actions: 'write' } });
    const client = createClient({ token, fetch, apiUrl, budget, now, sleep, retryUntil });
    const res = await client.request('POST', `/repos/${repo}/actions/runs/${runId}/cancel`, { essential: true, allow: [409] });
    if (res.status === 409) {
      say(`pump: the successor run ${runId} could not be cancelled (HTTP 409: it already finished or cannot be cancelled now)`);
      return false;
    }
    say(`pump: cancelled the successor run ${runId}; the schedule and the watchdog start the pump again`);
    return true;
  } catch (err) {
    say(`pump: could not cancel the successor run ${runId}: ${err?.message ?? err}`);
    return false;
  }
}

/** Print the due list and shard plan from a local state file. Read-only. */
export function plan({ stateFile = DEFAULT_STATE, now = Date.now(), config = loadConfig(), out = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const db = openState(stateFile);
  try {
    const due = dueFromState(db, { now, tiers: config.tiers, workflows: config.workflows, hooks: { ...NO_HOOKS, ...samplingHooks({ env: process.env, population: () => activeSubjects(db) }) } });
    out(`${due.length} due`);
    for (const d of due.slice(0, 50)) out(`  ${d.priority.toFixed(1).padStart(6)}  T${d.tier}  ${d.workflow.padEnd(14)} ${d.subject}${d.name && d.name !== d.subject ? ` (now ${d.name})` : ''}  (${d.reasons.join(', ')})`);
    const shards = planShards(due, config.workflows);
    out(`${shards.length} shard(s) if every slot were free`);
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const opts = { stateFile: DEFAULT_STATE, successorFile: undefined, maxMinutes: 11, tickSeconds: 150, ingestOut: undefined, keepOut: undefined, archiveOut: undefined, plan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--state') opts.stateFile = val();
    else if (a === '--successor-result') opts.successorFile = val();
    else if (a === '--max-minutes') opts.maxMinutes = Number(val());
    else if (a === '--tick-seconds') opts.tickSeconds = Number(val());
    else if (a === '--ingest-out') opts.ingestOut = val();
    else if (a === '--keep-out') opts.keepOut = val();
    else if (a === '--state-archive-out') opts.archiveOut = val();
    else if (a === '--plan') opts.plan = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!(opts.maxMinutes > 0 && opts.maxMinutes <= 13)) throw new Error('--max-minutes must be between 0 and 13');
  if (!(opts.tickSeconds >= 30)) throw new Error('--tick-seconds must be at least 30');
  return opts;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`pump: ${err.message}\n`);
    return 2;
  }
  if (opts.plan) {
    plan({ stateFile: opts.stateFile });
    return 0;
  }
  if (!env.GITHUB_REPOSITORY) {
    process.stderr.write('pump: GITHUB_REPOSITORY is required\n');
    return 2;
  }
  const secrets = secretValues(env);
  try {
    const out = await runPump({
      env,
      stateFile: opts.stateFile,
      successorFile: opts.successorFile,
      maxRunMs: opts.maxMinutes * 60_000,
      tickIntervalMs: opts.tickSeconds * 1000,
      ingestOptions: { ...(opts.ingestOut ? { outDir: opts.ingestOut } : {}), ...(opts.keepOut ? { keepDir: opts.keepOut } : {}) },
      archiveDir: opts.archiveOut,
    });
    return out.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`pump: ${scrub(err?.message ?? err, secrets)}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
