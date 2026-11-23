#!/usr/bin/env node
// The pump: one run of .github/workflows/pump.yml.
//
//   node pump/run.mjs [--state state/state.sqlite] [--successor-result <file>]
//                     [--max-minutes 11] [--tick-seconds 150]
//   node pump/run.mjs --plan [--state <file>]   print the due list from a local file
//
// A run pulls the state database from its Release asset, then ticks every
// 150 seconds for about 11 minutes (pump/tick.mjs), then pushes the state back.
// State is also pushed after every tick that dispatched, failed or reaped
// something, so a run that dies loses little. With LOOP_SLOTS=0 the run does one
// housekeeping tick (reap expired leases and slots, run ingest if present) and
// dispatches nothing.
//
// Environment:
//   LOOP_SLOTS          worker slots (the guard step's `slots` output)
//   GITHUB_REPOSITORY   this repository (holds the state asset)
//   GITHUB_TOKEN        job token with contents: write, for the state asset only
//   APP_ID, APP_INSTALLATION_ID, APP_PRIVATE_KEY
//                       the loop's GitHub App; dispatch tokens are minted per worker
//                       repository with actions: write only
//
// Ingest: if ingest/collect.mjs exists and exports collect(), the pump calls
// collect({ db, now, log, mintToken }) at the start of every tick. The pump is the
// state's only writer, so ingest runs inside it (docs/INTERFACES.md).

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openState } from '../state/db.mjs';
import { pullState, pushState } from '../scripts/state-asset.mjs';
import { appTokenMinter } from './app-token.mjs';
import { ApiBudget } from './budgets.mjs';
import { createDispatcher } from './dispatch.mjs';
import { dueFromState, loadConfig } from './due.mjs';
import { scrub } from './github.mjs';
import { computeBudget } from './slots.mjs';
import { planShards, runTick } from './tick.mjs';

const DEFAULT_STATE = 'state/state.sqlite';
const INGEST_PATH = new URL('../ingest/collect.mjs', import.meta.url);

/** Load ingest/collect.mjs's collect() if the file exists. */
export async function loadIngest(path = INGEST_PATH) {
  if (!existsSync(path)) return null;
  const mod = await import(path instanceof URL ? path.href : pathToFileURL(path).href);
  return typeof mod.collect === 'function' ? mod.collect : null;
}

/**
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
  successorFile,
  maxRunMs = 11 * 60_000,
  tickIntervalMs = 150_000,
  newId,
} = {}) {
  const start = now();
  const deadline = start + maxRunMs;
  const repo = env.GITHUB_REPOSITORY;
  const stateToken = env.GITHUB_TOKEN || undefined;
  const secrets = [stateToken, env.APP_PRIVATE_KEY];
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
  const collect = ingest === undefined ? await loadIngest() : ingest;

  await pull({ repo, token: stateToken, file: stateFile, fetch, log: say });
  const db = openState(stateFile);
  let ok = true;
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
      if (collect) {
        try {
          await collect({ db, now, log: say, mintToken: lazyMint });
        } catch (err) {
          say(`pump: ingest failed (continuing): ${err?.message ?? err}`);
        }
      }
      const summary = await runTick({
        db, now, config: cfg, workerSlots, dispatcher: workerSlots > 0 ? getDispatcher() : null, log: say, newId, deadline,
      });
      dispatched += summary.dispatched;
      failed += summary.failed;
      db.setKv('pump.last_tick', { ...summary, loopBudget, requested }, { now: now() });
      say(`pump: tick ${ticks}: due ${summary.due ?? '-'}, dispatched ${summary.dispatched}, failed ${summary.failed}, reaped ${summary.reaped}${summary.stopped ? `, stopped (${summary.stopped})` : ''}`);
      if (summary.dispatched || summary.failed || summary.reaped || summary.reapedSlots) await save(`tick ${ticks}`);
      if (workerSlots === 0 || summary.stopped === 'unauthorized') break;
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
  const opts = { stateFile: DEFAULT_STATE, successorFile: undefined, maxMinutes: 11, tickSeconds: 150, plan: false };
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
  try {
    const out = await runPump({
      env,
      stateFile: opts.stateFile,
      successorFile: opts.successorFile,
      maxRunMs: opts.maxMinutes * 60_000,
      tickIntervalMs: opts.tickSeconds * 1000,
    });
    return out.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`pump: ${scrub(err?.message ?? err, [env.GITHUB_TOKEN, env.APP_PRIVATE_KEY])}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
