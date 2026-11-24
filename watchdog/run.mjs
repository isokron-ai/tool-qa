#!/usr/bin/env node
// The watchdog: one run of .github/workflows/watchdog.yml.
//
//   node watchdog/run.mjs
//
// It reads, it does not write state. Each run:
//   1. mints one GitHub App token for this repository only, with issues: write
//      and actions: write;
//   2. lists the repository's workflows, the latest runs of the loop workflows
//      and the newest artifacts;
//   3. downloads a copy of the state asset with the job token (read-only) and
//      reads open slots, waiting dispatches and the pump's successor result;
//   4. evaluates the checks (watchdog/checks.mjs);
//      It also reads the public nightly sandbox conformance status (no token;
//      pump/breaker.mjs), the same file the pump reads for its breaker;
//   5. dispatches pump.yml if no pump run started for 20 minutes, and
//      re-enables loop workflows GitHub disabled for inactivity;
//   6. rewrites the "Loop health" issue (watchdog/health.mjs).
// A failed dispatch or re-enable is reported in the issue; the run still
// succeeds. The run fails only if it cannot read GitHub or write the issue.
//
// Environment:
//   GITHUB_REPOSITORY   this repository
//   GITHUB_TOKEN        job token (contents: read), for the state asset only
//   GITHUB_REF_NAME     branch to dispatch the pump on (default main)
//   LOOP_SLOTS          as for the guard; 0 means the pump is expected to be idle
//   LANE_<JOB>_ENABLED  lane switches; a lane that is off is reported as off
//   APP_ID, APP_INSTALLATION_ID, APP_PRIVATE_KEY   the loop's GitHub App
//   AGE_IDENTITY        decrypts the state asset (age ciphertext, R-ING-15);
//                       removed from the process environment once read
//   AGE_BIN, AGE_KEYGEN_BIN   optional paths of age and age-keygen

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { laneVariable, parseSlots } from '../scripts/guard.mjs';
import { pullState } from '../scripts/state-asset.mjs';
import { openState } from '../state/db.mjs';
import { appTokenMinter } from '../pump/app-token.mjs';
import { ApiBudget } from '../pump/budgets.mjs';
import { createClient, scrub } from '../pump/github.mjs';
import { judgeConformance, pinMismatches, readConformance as readConformanceStatus, untrustedWorkflows, verifyRun } from '../pump/breaker.mjs';
import { loadConfig } from '../pump/due.mjs';
import { LOOP_WORKFLOWS, evaluate } from './checks.mjs';
import { applyHealth } from './health.mjs';

const EXPECTED_FILE = new URL('./expected-workflows.json', import.meta.url);

export function loadExpected(file = EXPECTED_FILE) {
  return JSON.parse(readFileSync(file, 'utf8')).workflows;
}

/** Lane switches as the guard reads them: unset, empty or "true" is on. */
export function readLanes(env) {
  const lanes = {};
  for (const { lane } of LOOP_WORKFLOWS) {
    const raw = env[laneVariable(lane)];
    lanes[lane] = raw === undefined || raw === '' || raw === 'true';
  }
  return lanes;
}

/** Read what the checks need from a pulled copy of the state database. */
export function readState(file) {
  const db = openState(file);
  try {
    return {
      openSlots: db.openSlots(),
      // now: 0 returns every dispatch still waiting, expired or not; the checks
      // decide which are stuck.
      openDispatches: db.openDispatches({ now: 0 }),
      kv: { 'pump.successor': db.getKv('pump.successor') ?? null, 'pump.conformance': db.getKv('pump.conformance') ?? null },
    };
  } finally {
    db.close();
  }
}

/**
 * @returns {Promise<{ overall: string, checks: object[], actions: object, health: object }>}
 */
export async function runWatchdog({
  env = process.env,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetch = globalThis.fetch,
  apiUrl,
  log = (line) => process.stderr.write(`${line}\n`),
  mintToken,
  pull = pullState,
  stateDir,
  expected = loadExpected(),
  readConformance,
  verifyConformanceRun,
  workerWorkflows,
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) throw new Error('GITHUB_REPOSITORY is required (owner/name)');
  const secrets = [env.GITHUB_TOKEN, env.APP_PRIVATE_KEY, env.AGE_IDENTITY];
  const say = (line) => log(scrub(line, secrets));
  const stateKeys = {
    identity: env.AGE_IDENTITY || undefined,
    ageBin: env.AGE_BIN || undefined,
    keygenBin: env.AGE_KEYGEN_BIN || undefined,
    tmpDir: env.RUNNER_TEMP || undefined,
  };
  if (env === process.env) delete process.env.AGE_IDENTITY;
  const budget = new ApiBudget({ now, sleep });

  const minter = mintToken ?? appTokenMinter({ env, fetch, apiUrl, now, sleep, budget });
  const { token } = await minter({ repositories: [repo.split('/')[1]], permissions: { issues: 'write', actions: 'write' } });
  secrets.push(token);
  if (env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${token}\n`);
  const client = createClient({ token, fetch, apiUrl, budget, sleep, now });

  const workflows = await client.paginate(`/repos/${repo}/actions/workflows`, { key: 'workflows', essential: true });
  const runs = {};
  for (const { file } of LOOP_WORKFLOWS) {
    const res = await client.request('GET', `/repos/${repo}/actions/workflows/${file}/runs`, {
      essential: true, allow: [404], query: { per_page: 10, exclude_pull_requests: true },
    });
    runs[file] = res.status === 404 ? [] : res.data?.workflow_runs ?? [];
  }
  const artifacts = await client.paginate(`/repos/${repo}/actions/artifacts`, { key: 'artifacts', maxPages: 3, essential: true });

  const dir = stateDir ?? mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'watchdog-'));
  let state = null;
  let stateError = null;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.sqlite');
    const pulled = await pull({ repo, token: env.GITHUB_TOKEN || undefined, file, fetch, apiUrl, log: say, sleep, ...stateKeys });
    if (pulled?.status !== 'absent') state = readState(file);
  } catch (err) {
    // Still report everything else; the state checks are skipped this time.
    stateError = scrub(err?.message ?? String(err), secrets);
    say(`watchdog: could not read the state asset: ${stateError}`);
  } finally {
    if (!stateDir) rmSync(dir, { recursive: true, force: true });
  }

  // The sandbox breaker, as the pump sees it.
  const wfs = workerWorkflows ?? loadConfig().workflows;
  let conformance;
  try {
    conformance = await (readConformance ?? (() => readConformanceStatus({ fetch, sleep })))();
  } catch (err) {
    conformance = { error: scrub(String(err?.message ?? err), secrets).slice(0, 200) };
  }
  // The same judgement as the pump's, with what the pump remembered (newest
  // status seen, run verified); the watchdog itself writes no state.
  const judged = await judgeConformance({
    read: conformance,
    now: now(),
    memory: state?.kv?.['pump.conformance'] ?? null,
    verify: verifyConformanceRun ?? ((status) => verifyRun({ fetch, status })),
  });
  const { memory: _m, changed: _c, ...verdict } = judged;
  const breaker = {
    ...verdict,
    untrusted: untrustedWorkflows(wfs),
    enabled: untrustedWorkflows(wfs, { enabledOnly: true }),
    mismatch: verdict.tripped ? [] : pinMismatches(wfs, verdict.sandbox_sha),
  };

  const { slots } = parseSlots(env.LOOP_SLOTS);
  const { checks, actions } = evaluate({ now: now(), slots, lanes: readLanes(env), runs, artifacts, state, workflows, expected, breaker });
  if (stateError) {
    const c = checks.find((x) => x.id === 'state');
    c.summary = `could not read the state asset: ${stateError.slice(0, 200)}`;
  }

  if (actions.dispatchPump) {
    const ref = env.GITHUB_REF_NAME || 'main';
    try {
      await client.request('POST', `/repos/${repo}/actions/workflows/pump.yml/dispatches`, { essential: true, body: { ref } });
      say(`watchdog: dispatched pump.yml on ${ref}`);
    } catch (err) {
      const message = scrub(err?.message ?? String(err), secrets);
      checks.push({ id: 'pump-dispatch', status: 'red', summary: `could not dispatch pump.yml: ${message.slice(0, 200)}` });
      say(`watchdog: ${message}`);
    }
  }
  for (const wf of actions.enableWorkflows) {
    const name = wf.path.split('/').pop();
    try {
      await client.request('PUT', `/repos/${repo}/actions/workflows/${wf.id}/enable`, { essential: true });
      say(`watchdog: re-enabled ${name}`);
    } catch (err) {
      const message = scrub(err?.message ?? String(err), secrets);
      const check = checks.find((c) => c.id === `workflow:${name}`);
      check.status = 'red';
      check.summary = `${name} was disabled by GitHub for inactivity and could not be re-enabled: ${message.slice(0, 200)}`;
      say(`watchdog: ${message}`);
    }
  }

  for (const c of checks) say(`watchdog: ${c.status.padEnd(5)} ${c.id}: ${c.summary}`);
  const health = await applyHealth({ client, repo, checks, mode: 'replace', now: now() });
  say(`watchdog: overall ${health.overall} (issue #${health.number}${health.created ? ', created' : health.updated ? ', updated' : ', unchanged'})`);
  return { overall: health.overall, checks, actions, health };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length) {
    process.stderr.write(`watchdog: unknown argument ${JSON.stringify(argv[0])}\n`);
    return 2;
  }
  try {
    await runWatchdog({ env });
    return 0;
  } catch (err) {
    process.stderr.write(`watchdog: ${scrub(err?.message ?? String(err), [env.GITHUB_TOKEN, env.APP_PRIVATE_KEY])}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
