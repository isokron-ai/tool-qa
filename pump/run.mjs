#!/usr/bin/env node
// The pump: one run of .github/workflows/pump.yml.
//
//   node pump/run.mjs [--state state/state.sqlite] [--successor-result <file>]
//                     [--max-minutes 11] [--tick-seconds 150] [--ingest-out <dir>]
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
//   GITHUB_TOKEN        job token with contents: write, for the state asset only
//   APP_ID, APP_INSTALLATION_ID, APP_PRIVATE_KEY
//                       the loop's GitHub App; tokens are minted per worker
//                       repository: actions: write to dispatch, actions: read
//                       for ingest
//   AGE_IDENTITY        the ingest age identity (decrypts results, and the state
//                       asset); removed from the process environment once read
//   AGE_BIN, AGE_KEYGEN_BIN, GITHUB_API_URL, RUNNER_TEMP   optional
//
// Ingest outputs are sealed to worker-kit/ingest.pub and written to --ingest-out
// (default $RUNNER_TEMP/ingest-out); pump.yml uploads that directory.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createCollector, IngestSetupError } from '../ingest/collect.mjs';
import { sleepUnless } from '../ingest/github.mjs';
import { openState } from '../state/db.mjs';
import { pullState, pushState } from '../scripts/state-asset.mjs';
import { appTokenMinter } from './app-token.mjs';
import { ApiBudget, budgetedFetch } from './budgets.mjs';
import { allowedWorkflows, judgeConformance, pinMismatches, readConformance as readConformanceStatus, untrustedWorkflows, verifyRun } from './breaker.mjs';
import { createDispatcher } from './dispatch.mjs';
import { dueFromState, isEnabled, loadConfig } from './due.mjs';
import { scrub } from './github.mjs';
import { computeBudget, reapExpired } from './slots.mjs';
import { SEED_FILE, syncSeedSubjects } from './subjects.mjs';
import { planShards, runTick } from './tick.mjs';

const DEFAULT_STATE = 'state/state.sqlite';
export const BUDGET_KEY = 'pump.api_budget';
export const BREAKER_KEY = 'pump.breaker';
export const CONFORMANCE_KEY = 'pump.conformance';

const isSetupError = (err) => err instanceof IngestSetupError || err?.name === 'IngestSetupError';

/**
 * seedFile: the seed list loaded into the subjects table at start-up
 * (pump/subjects.mjs); null loads nothing.
 * ingest: undefined for the pump's own collector (ingest/collect.mjs, built
 * with `ingestOptions`), null for none, a function (called as collect()), or an
 * object with collect() and optionally check().
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
} = {}) {
  const start = now();
  const deadline = start + maxRunMs;
  const ingestDeadline = deadline - ingestStopMs;
  const repo = env.GITHUB_REPOSITORY;
  const stateToken = env.GITHUB_TOKEN || undefined;
  const secrets = [stateToken, env.APP_PRIVATE_KEY, env.AGE_IDENTITY];
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
  const mask = (token) => {
    secrets.push(token);
    if (env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${token}\n`);
  };
  let minter = mintToken;
  const lazyMint = async (args) => {
    minter = minter ?? appTokenMinter({ env, fetch, now, sleep, budget: bud });
    const out = await minter(args);
    mask(out.token);
    return out;
  };
  let disp = dispatcher;
  const getDispatcher = () => {
    disp = disp ?? createDispatcher({ mintToken: lazyMint, fetch, budget: bud, now, sleep, pollAttempts: 4, pollIntervalMs: 4000 });
    return disp;
  };
  const apiUrl = env.GITHUB_API_URL || 'https://api.github.com';
  let collector;
  if (ingest === undefined) {
    collector = createCollector({ env, fetch: budgetedFetch(fetch, bud, { apiUrl }), apiUrl, sleep, ...ingestOptions });
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

  await pull({ repo, token: stateToken, file: stateFile, fetch, log: say, ...stateKeys });
  const db = openState(stateFile);
  // The hourly API caps hold across runs (R-ING-11): this run starts with the
  // calls earlier runs made in the last hour, and leaves its own for the next.
  if (typeof bud.restore === 'function') bud.restore(db.getKv(BUDGET_KEY));
  const keepBudget = () => {
    if (typeof bud.snapshot === 'function') db.setKv(BUDGET_KEY, bud.snapshot(), { now: now() });
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
      await push({ repo, token: stateToken, file: stateFile, fetch, log: say, now: now(), ...stateKeys });
      return true;
    } catch (err) {
      ok = false;
      pushFailed = true;
      say(`pump: state push (${why}) failed: ${err?.message ?? err}; nothing more is dispatched this run`);
      return false;
    }
  };
  try {
    if (successorFile && existsSync(successorFile)) {
      try {
        db.setKv('pump.successor', JSON.parse(readFileSync(successorFile, 'utf8')), { now: now() });
      } catch (err) {
        say(`pump: could not read the successor result: ${err.message}`);
      }
    }
    // The seed subjects (pump/subjects.mjs); written only when the seed file changed.
    const seeded = seedFile ? syncSeedSubjects(db, { now: now(), file: seedFile }) : { summary: 'no seed file given' };
    say(`pump: subjects: ${seeded.summary}`);
    if (seeded.error) ok = false;
    for (;;) {
      const tickStart = now();
      ticks += 1;
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
        db.setKv(BREAKER_KEY, { ...breaker, at: new Date(now()).toISOString() }, { now: now() });
        lastBreaker = breaker;
      }
      const tickConfig = breaker?.tripped ? { ...cfg, workflows: allowedWorkflows(cfg.workflows, breaker) } : cfg;
      const summary = await runTick({
        db, now, config: tickConfig, workerSlots: slots, dispatcher: slots > 0 ? getDispatcher() : null, log: say, newId, deadline,
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
          say(`pump: ${p.workflow} is paused until ${p.until}: ${p.count} dispatches in a row ran at another commit than the one recorded at dispatch (run_sha_mismatch). Check that its worker branch is not moving and that no one else dispatches its workflow; the pause ends on its own`);
        }
      }
      const ingestNote = ingested
        ? { checked: ingested.checked, judged: ingested.judged, recorded: ingested.recorded, outcomes: ingested.outcomes, errors: ingested.errors, stopped: ingested.stopped }
        : null;
      db.setKv('pump.last_tick', { ...summary, loopBudget, requested, ingest: ingestNote, blocked, breaker: breaker ? { tripped: breaker.tripped, reason: breaker.reason, held: breaker.held } : null }, { now: now() });
      say(`pump: tick ${ticks}: due ${summary.due ?? '-'}, dispatched ${summary.dispatched}, failed ${summary.failed}, reaped ${summary.reaped}${summary.stopped ? `, stopped (${summary.stopped})` : ''}`);
      if (summary.dispatched || summary.failed || summary.withdrawn || summary.reaped || summary.reapedSlots || ingested?.changed) await save(`tick ${ticks}`);
      if (slots === 0 || summary.stopped === 'unauthorized') break;
      // A failed push: one housekeeping tick (ingest, reap, no dispatch), then stop.
      const next = tickStart + tickIntervalMs;
      if (next >= deadline) break;
      await sleep(Math.max(0, next - now()));
    }
    keepBudget();
    db.setKv('pump.last_run', { started: new Date(start).toISOString(), finished: new Date(now()).toISOString(), ticks, dispatched, failed, workerSlots, loopBudget }, { now: now() });
  } finally {
    db.close();
  }
  await save('end of run', { open: false });
  return { ok, ticks, dispatched, failed, workerSlots, loopBudget };
}

/** Print the due list and shard plan from a local state file. Read-only. */
export function plan({ stateFile = DEFAULT_STATE, now = Date.now(), config = loadConfig(), out = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const db = openState(stateFile);
  try {
    const due = dueFromState(db, { now, tiers: config.tiers, workflows: config.workflows });
    out(`${due.length} due`);
    for (const d of due.slice(0, 50)) out(`  ${d.priority.toFixed(1).padStart(6)}  T${d.tier}  ${d.workflow.padEnd(14)} ${d.subject}  (${d.reasons.join(', ')})`);
    const shards = planShards(due, config.workflows);
    out(`${shards.length} shard(s) if every slot were free`);
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const opts = { stateFile: DEFAULT_STATE, successorFile: undefined, maxMinutes: 11, tickSeconds: 150, ingestOut: undefined, plan: false };
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
  const secrets = [env.GITHUB_TOKEN, env.APP_PRIVATE_KEY, env.AGE_IDENTITY];
  try {
    const out = await runPump({
      env,
      stateFile: opts.stateFile,
      successorFile: opts.successorFile,
      maxRunMs: opts.maxMinutes * 60_000,
      tickIntervalMs: opts.tickSeconds * 1000,
      ingestOptions: opts.ingestOut ? { outDir: opts.ingestOut } : {},
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
