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
//      and the state snapshot manifest (snapshot/health.mjs) with the job token;
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
//   ARCHIVE_LAST_OK     the Mac archive pull's heartbeat, `${{ vars.ARCHIVE_LAST_OK }}`
//                       (watchdog/archive.mjs)
//   LANE_LIVE_SNAPSHOT_ENABLED  the live loop snapshot switch; only "true" is on (watchdog `live-snapshot`)
//   LANE_OFFSITE_ENABLED  the off-site backup's lane switch (watchdog/offsite.mjs)

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
import { archiveCheck } from './archive.mjs';
import { offsiteCheck } from './offsite.mjs';
import { nightlyImage, readSelftestFailures, selftestLanes } from './selftest.mjs';
import { keepCheck, readKeepStatus } from '../keep/health.mjs';
import { createReleaseClient } from '../snapshot/github.mjs';
import { readSnapshotManifest } from '../snapshot/health.mjs';

const EXPECTED_FILE = new URL('./expected-workflows.json', import.meta.url);

/** Pages of runs read per history workflow, at most (R-WD-15): 500 runs, about 3 days of registry deltas. */
export const HISTORY_MAX_PAGES = 5;

/** History captures, by the workflow that makes them (R-WD-15). */
export const HISTORY_SOURCES = Object.freeze([
  { file: 'history-registry.yml', prefix: 'registry-full-', match: /^history-registry full$/ },
  { file: 'history-registry.yml', prefix: 'registry-delta-', match: /^history-registry delta$/ },
  { file: 'history-packages.yml', prefix: 'history-packages-' },
  { file: 'history-popularity.yml', prefix: 'history-popularity-' },
]);

/**
 * Artifacts of the newest successful runs of each history workflow whose
 * capture is not in `listed` (R-WD-15). At most 2 runs per capture and
 * HISTORY_MAX_PAGES runs pages per workflow; a failed lookup adds nothing (the check then reads
 * as before), it never fails the watchdog.
 */
export async function historyArtifacts(client, repo, listed) {
  const have = (prefix) => listed.some((x) => !x.expired && String(x.name).startsWith(prefix));
  const missing = HISTORY_SOURCES.filter((h) => !have(h.prefix));
  const runsByFile = new Map();
  const out = [];
  const seen = new Set(listed.map((x) => x.id).filter((id) => id !== undefined));
  for (const h of missing) {
    try {
      // Pages of successful runs, newest first. history-registry runs a delta
      // every 15 minutes, so its daily full run can sit several pages down:
      // page until two matching runs are found, at most HISTORY_MAX_PAGES.
      if (!runsByFile.has(h.file)) runsByFile.set(h.file, { runs: [], page: 0, done: false });
      const cache = runsByFile.get(h.file);
      const fits = (r) => !h.match || h.match.test(String(r.display_title ?? r.name ?? '').trim());
      while (!cache.done && cache.runs.filter(fits).length < 2 && cache.page < HISTORY_MAX_PAGES) {
        cache.page += 1;
        const res = await client.request('GET', `/repos/${repo}/actions/workflows/${h.file}/runs`, {
          allow: [404], query: { status: 'success', branch: 'main', per_page: 100, page: cache.page, exclude_pull_requests: true },
        });
        const got = res.status === 404 ? [] : res.data?.workflow_runs ?? [];
        cache.runs.push(...got);
        if (got.length < 100) cache.done = true;
      }
      const runs = cache.runs.filter(fits).slice(0, 2);
      for (const r of runs) {
        const res = await client.request('GET', `/repos/${repo}/actions/runs/${r.id}/artifacts`, { allow: [404], query: { per_page: 100 } });
        for (const a of res.status === 404 ? [] : res.data?.artifacts ?? []) {
          if (a.id !== undefined && seen.has(a.id)) continue;
          if (a.id !== undefined) seen.add(a.id);
          out.push(a);
        }
        if (out.some((a) => !a.expired && String(a.name).startsWith(h.prefix))) break;
      }
    } catch {
      // nothing added: the history check reads from the listed artifacts only
    }
  }
  return out;
}

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
      kv: {
        'pump.successor': db.getKv('pump.successor') ?? null,
        'pump.conformance': db.getKv('pump.conformance') ?? null,
        'pump.subjects': db.getKv('pump.subjects') ?? null,
        'pump.identity': db.getKv('pump.identity') ?? null,
        'pump.last_tick': db.getKv('pump.last_tick') ?? null,
        'pump.api_budget': db.getKv('pump.api_budget') ?? null,
        'pump.last_run': db.getKv('pump.last_run') ?? null,
        'state.size': db.getKv('state.size') ?? null,
        'live.last_upload': db.getKv('live.last_upload') ?? null,
        'retention.seal': db.getKv('retention.seal') ?? null,
      },
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
  loadWorkerConfig = () => loadConfig().workflows,
  readSnapshot,
  readKeep,
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
  const listed = await client.paginate(`/repos/${repo}/actions/artifacts`, { key: 'artifacts', maxPages: 3, essential: true });
  // R-WD-15: on a busy day the newest 300 artifacts are all lane results, and a
  // day-old history capture falls off the list: the check read "no artifact
  // found" (red) while the capture was fine. Each history capture missing from
  // the list is looked up through its own workflow's latest successful runs.
  const artifacts = [...listed, ...(await historyArtifacts(client, repo, listed))];

  const dir = stateDir ?? mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'watchdog-'));
  let state = null;
  let stateError = null;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.sqlite');
    const pulled = await pull({ repo, token: env.GITHUB_TOKEN || undefined, file, fetch, apiUrl, log: say, sleep, ...stateKeys });
    if (pulled?.status !== 'absent') {
      state = readState(file);
      state.asset = { bytes: Number.isSafeInteger(pulled?.bytes) ? pulled.bytes : null, compressed: pulled?.compressed ?? null };
    }
  } catch (err) {
    // Still report everything else; the state checks are skipped this time.
    stateError = scrub(err?.message ?? String(err), secrets);
    say(`watchdog: could not read the state asset: ${stateError}`);
  } finally {
    if (!stateDir) rmSync(dir, { recursive: true, force: true });
  }

  // The sandbox breaker, as the pump sees it.
  // A pump/workflows.json the pump cannot load is a red `config` check, not a
  // silent watchdog (R-WD-13).
  let wfs = {};
  let configError = null;
  try {
    wfs = workerWorkflows ?? loadWorkerConfig();
  } catch (err) {
    configError = scrub(String(err?.message ?? err), secrets).slice(0, 300);
  }
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
    verify: verifyConformanceRun ?? ((status, o) => verifyRun({ fetch, status, token: env.GITHUB_TOKEN || undefined, ...o })),
  });
  const { memory: _m, changed: _c, ...verdict } = judged;
  const breaker = {
    ...verdict,
    untrusted: untrustedWorkflows(wfs),
    enabled: untrustedWorkflows(wfs, { enabledOnly: true }),
    mismatch: verdict.tripped ? [] : pinMismatches(wfs, verdict.sandbox_sha),
  };

  // The state snapshots: the manifest on the public "state-snapshots" release,
  // read with the job token (contents: read).
  let snapshot;
  try {
    snapshot = await (readSnapshot ?? (() => readSnapshotManifest(createReleaseClient({ repo, token: env.GITHUB_TOKEN || undefined, fetch, apiUrl, sleep }))))();
  } catch (err) {
    snapshot = { error: scrub(String(err?.message ?? err), secrets).slice(0, 200) };
  }
  if (snapshot?.error) snapshot = { ...snapshot, error: scrub(String(snapshot.error), secrets).slice(0, 200) };

  // The lanes' own sandbox self tests (R-WD-17). The job's GITHUB_TOKEN is scoped to this
  // repository: for the lanes' repositories it is a public caller, which can list runs and jobs
  // but gets 403 on job logs (where the runner image is). So a second App installation token,
  // for those repositories and actions: read only, reads them; if it cannot be minted the
  // reads fall back to the job token and the item says so (amber). Same API budget throughout.
  let selftest;
  try {
    const owner = repo.split('/')[0];
    const laneRepos = [...new Set(selftestLanes(wfs).map((l) => l.repo).filter((r) => r.split('/')[0] === owner).map((r) => r.split('/')[1]))];
    let logToken = null;
    let tokenError = null;
    if (laneRepos.length) {
      try {
        ({ token: logToken } = await minter({ repositories: laneRepos, permissions: { actions: 'read' } }));
        secrets.push(logToken);
        if (env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${logToken}\n`);
      } catch (err) {
        tokenError = scrub(String(err?.message ?? err), secrets).slice(0, 160);
      }
    }
    const readToken = logToken ?? env.GITHUB_TOKEN;
    const reader = readToken ? createClient({ token: readToken, fetch, apiUrl, budget, sleep, now }) : client;
    selftest = { read: { ...(await readSelftestFailures({ client: reader, workflows: wfs, now })), tokenError }, passedImage: verdict.tripped ? null : nightlyImage(conformance?.status) };
  } catch (err) {
    selftest = { read: { error: scrub(String(err?.message ?? err), secrets).slice(0, 200) }, passedImage: null };
  }

  const { slots } = parseSlots(env.LOOP_SLOTS);
  const { checks, actions } = evaluate({ now: now(), slots, lanes: readLanes(env), liveSwitch: env.LANE_LIVE_SNAPSHOT_ENABLED, runs, artifacts, state, workflows, expected, breaker, snapshot, selftest });
  if (configError) checks.push({ id: 'config', status: 'red', summary: `the pump cannot load its config, so it dispatches nothing: ${configError}` });
  if (stateError) {
    const c = checks.find((x) => x.id === 'state');
    c.summary = `could not read the state asset: ${stateError.slice(0, 200)}`;
  }
  // The Mac archive pull's heartbeat, a repository variable passed in by the workflow.
  checks.push(archiveCheck({ now: now(), raw: env.ARCHIVE_LAST_OK }));
  checks.push(await offsiteCheck({ client, repo, now: now(), env, fetch, sleep })); // the off-site backup's heartbeat artifact (watchdog/offsite.mjs)
  // The keep-forever copy: the status on the "keep-forever" release (keep/health.mjs).
  {
    let keep;
    try {
      keep = await (readKeep ?? (() => readKeepStatus(createReleaseClient({ repo, token: env.GITHUB_TOKEN || undefined, fetch, apiUrl, sleep }))))();
    } catch (err) {
      keep = { error: scrub(String(err?.message ?? err), secrets).slice(0, 200) };
    }
    const lane = env[laneVariable('keep-forever')];
    checks.push(keepCheck({ now: now(), status: keep?.status ?? null, error: keep?.error ? scrub(String(keep.error), secrets) : null, missing: keep?.missing ?? null, laneOn: lane === undefined || lane === '' || lane === 'true' }));
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
