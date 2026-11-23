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
//   1. ingest   judge the results of worker runs that finished and record them
//               (ingest/collect.mjs). Only until two minutes before the end, so
//               the last results are in the state before the final push.
//   2. tick     reap expired leases and slots, then dispatch due work into free
//               slots (pump/tick.mjs).
//   3. push     the state, if the tick recorded, dispatched, failed or reaped
//               anything, so a run that dies loses little.
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
//   AGE_IDENTITY        the ingest age identity (decrypts results); removed from
//                       the process environment once read
//   AGE_BIN, AGE_KEYGEN_BIN, GITHUB_API_URL, RUNNER_TEMP   optional
//
// Ingest outputs are sealed to worker-kit/ingest.pub and written to --ingest-out
// (default $RUNNER_TEMP/ingest-out); pump.yml uploads that directory.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createCollector, IngestSetupError } from '../ingest/collect.mjs';
import { openState } from '../state/db.mjs';
import { pullState, pushState } from '../scripts/state-asset.mjs';
import { appTokenMinter } from './app-token.mjs';
import { ApiBudget, budgetedFetch } from './budgets.mjs';
import { createDispatcher } from './dispatch.mjs';
import { dueFromState, loadConfig } from './due.mjs';
import { scrub } from './github.mjs';
import { computeBudget } from './slots.mjs';
import { planShards, runTick } from './tick.mjs';

const DEFAULT_STATE = 'state/state.sqlite';

const isSetupError = (err) => err instanceof IngestSetupError || err?.name === 'IngestSetupError';

/**
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
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetch = globalThis.fetch,
  log = (line) => process.stderr.write(`${line}\n`),
  stateFile = DEFAULT_STATE,
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
} = {}) {
  const start = now();
  const deadline = start + maxRunMs;
  const ingestDeadline = deadline - ingestStopMs;
  const repo = env.GITHUB_REPOSITORY;
  const stateToken = env.GITHUB_TOKEN || undefined;
  const secrets = [stateToken, env.APP_PRIVATE_KEY, env.AGE_IDENTITY];
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
  const enabled = Object.values(cfg.workflows ?? {}).some((w) => w?.enabled === true);
  if (workerSlots > 0 && enabled && typeof collector?.check === 'function') {
    // Only local checks (keys): no API calls.
    try {
      await collector.check();
    } catch (err) {
      if (!isSetupError(err)) throw err;
      block(err);
    }
  }

  await pull({ repo, token: stateToken, file: stateFile, fetch, log: say });
  const db = openState(stateFile);
  let ticks = 0;
  let dispatched = 0;
  let failed = 0;
  const save = async (why) => {
    try {
      await push({ repo, token: stateToken, file: stateFile, fetch, log: say, now: now() });
    } catch (err) {
      ok = false;
      say(`pump: state push (${why}) failed: ${err?.message ?? err}`);
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
    for (;;) {
      const tickStart = now();
      ticks += 1;
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
      const slots = blocked ? 0 : workerSlots;
      const summary = await runTick({
        db, now, config: cfg, workerSlots: slots, dispatcher: slots > 0 ? getDispatcher() : null, log: say, newId, deadline,
      });
      dispatched += summary.dispatched;
      failed += summary.failed;
      const ingestNote = ingested
        ? { checked: ingested.checked, judged: ingested.judged, recorded: ingested.recorded, outcomes: ingested.outcomes, errors: ingested.errors, stopped: ingested.stopped }
        : null;
      db.setKv('pump.last_tick', { ...summary, loopBudget, requested, ingest: ingestNote, blocked }, { now: now() });
      say(`pump: tick ${ticks}: due ${summary.due ?? '-'}, dispatched ${summary.dispatched}, failed ${summary.failed}, reaped ${summary.reaped}${summary.stopped ? `, stopped (${summary.stopped})` : ''}`);
      if (summary.dispatched || summary.failed || summary.reaped || summary.reapedSlots || ingested?.changed) await save(`tick ${ticks}`);
      if (slots === 0 || summary.stopped === 'unauthorized') break;
      const next = tickStart + tickIntervalMs;
      if (next >= deadline) break;
      await sleep(Math.max(0, next - now()));
    }
    db.setKv('pump.last_run', { started: new Date(start).toISOString(), finished: new Date(now()).toISOString(), ticks, dispatched, failed, workerSlots, loopBudget }, { now: now() });
  } finally {
    db.close();
  }
  await save('end of run');
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
