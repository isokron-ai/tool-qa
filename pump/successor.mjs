#!/usr/bin/env node
// Dispatch the next pump run.
//
//   node pump/successor.mjs --out <file>
//
// The pump workflow calls this first. The new run waits behind the current one
// (the workflow's concurrency group, cancel-in-progress false) and starts when
// it ends, so the pump runs back to back while LOOP_SLOTS is above 0. The cron
// every 30 minutes restarts the chain if it breaks; the watchdog dispatches one
// if no pump run started for 20 minutes.
//
// The token is minted for this repository only, with actions: write. A server
// error or lost connection is retried with backoff and jitter (pump/retry.mjs,
// up to 6 tries within 90 s): a duplicate dispatch only replaces the pending
// pump run.
//
// The result is written to --out as JSON { ok, at, ref, runId?, runUrl?, error? }.
// The pump run stores it in the state (kv pump.successor), where the watchdog
// reads it. On failure this also marks `pump-successor` red on the "Loop
// health" issue straight away, and prints a warning. It always exits 0: the
// pump run itself should still go ahead.
//
// Environment: GITHUB_REPOSITORY, GITHUB_REF_NAME (default main),
// APP_ID, APP_INSTALLATION_ID, APP_PRIVATE_KEY.

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHealth } from '../watchdog/health.mjs';
import { appTokenMinter } from './app-token.mjs';
import { ApiBudget } from './budgets.mjs';
import { createClient, scrub } from './github.mjs';

export const PUMP_WORKFLOW = 'pump.yml';
// All the retrying the successor does (minting its token and the dispatch) ends
// within this long, so a GitHub outage cannot eat the pump job's time: the
// pump job has 20 minutes, the pump itself stops at 11 (R-CHAOS-13).
export const SUCCESSOR_RETRY_MS = 90_000;

/**
 * @returns {Promise<{ ok: boolean, at: string, ref: string, runId?: number,
 *   runUrl?: string, error?: string, reported?: boolean }>}
 */
export async function dispatchSuccessor({
  env = process.env,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetch = globalThis.fetch,
  apiUrl,
  random,
  log = (line) => process.stderr.write(`${line}\n`),
  mintToken,
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const name = String(repo ?? '').split('/')[1];
  const ref = env.GITHUB_REF_NAME || 'main';
  const at = new Date(now()).toISOString();
  const secrets = [env.APP_PRIVATE_KEY, env.GITHUB_TOKEN];
  const budget = new ApiBudget({ now, sleep });
  // Each phase (dispatch, then the health report) gets its own window.
  const window = () => ({ random, retryUntil: now() + SUCCESSOR_RETRY_MS, retryTotalMs: SUCCESSOR_RETRY_MS, requestTimeoutMs: 30_000, log });
  const mint = async (permissions, retry) => {
    const minter = mintToken ?? appTokenMinter({ env, fetch, apiUrl, now, sleep, budget, ...retry });
    const { token } = await minter({ repositories: [name], permissions });
    secrets.push(token);
    if (env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${token}\n`);
    return createClient({ token, fetch, apiUrl, budget, sleep, now, ...retry });
  };

  let result;
  try {
    const client = await mint({ actions: 'write' }, window());
    const res = await client.request('POST', `/repos/${repo}/actions/workflows/${PUMP_WORKFLOW}/dispatches`, {
      family: 'dispatch',
      essential: true,
      retryUnsafe: true,
      body: { ref, return_run_details: true },
    });
    result = { ok: true, at, ref };
    if (res.status === 200 && res.data?.workflow_run_id) {
      result.runId = Number(res.data.workflow_run_id);
      result.runUrl = res.data.html_url ?? null;
    }
    log(`successor: dispatched ${PUMP_WORKFLOW} on ${ref}${result.runId ? ` (run ${result.runId})` : ''}`);
    return result;
  } catch (err) {
    result = { ok: false, at, ref, error: scrub(err?.message ?? String(err), secrets).slice(0, 300) };
    log(`successor: could not dispatch ${PUMP_WORKFLOW}: ${result.error}`);
  }

  try {
    const client = await mint({ issues: 'write' }, window());
    await applyHealth({
      client,
      repo,
      mode: 'merge',
      now: now(),
      checks: [{ id: 'pump-successor', status: 'red', summary: `the pump could not dispatch its successor: ${result.error}`, at, keep: true }],
    });
    result.reported = true;
  } catch (err) {
    result.reported = false;
    log(`successor: could not update the health issue: ${scrub(err?.message ?? String(err), secrets)}`);
  }
  return result;
}

function parseArgs(argv) {
  const opts = { out: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1] !== undefined) opts.out = argv[++i];
    else throw new Error(`unknown or incomplete argument ${JSON.stringify(argv[i])}`);
  }
  if (!opts.out) throw new Error('--out <file> is required');
  return opts;
}

/** `deps` lets tests replace fetch, the clock and the minter; `deps.out` receives stdout lines. */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`successor: ${err.message}\n`);
    return 2;
  }
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_REPOSITORY.includes('/')) {
    process.stderr.write('successor: GITHUB_REPOSITORY is required (owner/name)\n');
    return 2;
  }
  const result = await dispatchSuccessor({ ...deps, env });
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(result)}\n`);
  if (!result.ok) out(`::warning::The pump could not dispatch its successor; the next scheduled run or the watchdog will start one. ${result.error.replace(/[\r\n%]/g, ' ')}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
