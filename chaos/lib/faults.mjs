// Seeded random fault schedules for the chaos soak (chaos/soak.mjs) and the
// small randomized test in the PR suite. A schedule is a list of timed
// faults drawn from a seed; applying it to a Sim installs each one at its
// time. The same seed always gives the same schedule, so a failure is
// reproduced with `node chaos/soak.mjs --seed <n>`.

import { HOUR, MIN, TOOLQA, WORKER, pubOf, sealTo } from './sim.mjs';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

/** Request matchers, by the call they hit. */
export const CALLS = {
  workerDispatch: (r) => r.method === 'POST' && r.path.startsWith(`/repos/${WORKER}/actions/workflows/`),
  successorDispatch: (r) => r.method === 'POST' && r.path === `/repos/${TOOLQA}/actions/workflows/pump.yml/dispatches`,
  stateRelease: (r) => r.method === 'GET' && r.path === `/repos/${TOOLQA}/releases/tags/state`,
  stateUpload: (r) => r.method === 'POST' && r.host === UPLOADS,
  stateRename: (r) => r.method === 'PATCH' && r.path.startsWith(`/repos/${TOOLQA}/releases/assets/`),
  stateDelete: (r) => r.method === 'DELETE' && r.path.startsWith(`/repos/${TOOLQA}/releases/assets/`),
  stateDownload: (r) => r.method === 'GET' && r.path.startsWith(`/repos/${TOOLQA}/releases/assets/`),
  workerRun: (r) => r.method === 'GET' && new RegExp(`^/repos/${WORKER}/actions/runs/\\d+$`).test(r.path),
  workerRuns: (r) => r.method === 'GET' && r.path.startsWith(`/repos/${WORKER}/actions/workflows/`),
  workerArtifacts: (r) => r.method === 'GET' && /\/actions\/runs\/\d+\/artifacts$/.test(r.path),
  artifactZip: (r) => r.method === 'GET' && /\/actions\/artifacts\/\d+\/zip$/.test(r.path),
  branch: (r) => r.method === 'GET' && r.path.startsWith(`/repos/${WORKER}/branches/`),
  issues: (r) => r.path.startsWith(`/repos/${TOOLQA}/issues`),
  anyApi: (r) => r.host === API,
};

const KILL_POINTS = ['workerDispatch', 'stateRename', 'stateUpload', 'stateRelease', 'workerRun', 'workerArtifacts', 'successorDispatch', 'stateDelete'];
const ERROR_POINTS = ['workerDispatch', 'successorDispatch', 'stateRelease', 'stateUpload', 'stateRename', 'stateDelete', 'stateDownload', 'workerRun', 'workerRuns', 'workerArtifacts', 'artifactZip', 'branch', 'issues'];
const LIE_POINTS = ['workerDispatch', 'stateUpload', 'stateRename', 'stateDelete', 'successorDispatch'];

const pick = (r, list) => list[Math.floor(r() * list.length)];
const between = (r, a, b) => a + Math.floor(r() * (b - a + 1));

/**
 * Draw a fault schedule. `faults` faults spread over `spanMs` after `fromMs`
 * (relative times). Kinds that end in a state a person must fix (corruption)
 * are paired with an operator restore.
 */
export function drawSchedule(r, { faults = 12, spanMs = 4 * HOUR, kinds } = {}) {
  const menu = kinds ?? [
    'kill', 'kill', 'kill', 'error', 'error', 'error', 'lie', 'ratelimit', 'ratelimit', 'duplicate', 'dropSuccessor',
    'workerSlow', 'workerSlow', 'workerHold', 'workerFail', 'workerPartial', 'killSwitch', 'pause', 'concurrentPump', 'corruptRestore',
  ];
  const out = [];
  for (let i = 0; i < faults; i++) {
    const kind = pick(r, menu);
    const at = between(r, 0, spanMs);
    const f = { at, kind };
    if (kind === 'kill') f.point = pick(r, KILL_POINTS);
    if (kind === 'error') Object.assign(f, { point: pick(r, ERROR_POINTS), status: pick(r, [500, 502, 503, 504]), times: between(r, 1, 6) });
    if (kind === 'lie') f.point = pick(r, LIE_POINTS);
    if (kind === 'ratelimit') Object.assign(f, { point: pick(r, ERROR_POINTS), primary: r() < 0.5, resetMs: pick(r, [30_000, 90_000, 5 * MIN, 30 * MIN]), times: between(r, 1, 3) });
    if (kind === 'workerSlow') f.durationMs = between(r, 10, 45) * MIN;
    if (kind === 'workerHold') f.releaseAfterMs = between(r, 5, 90) * MIN;
    if (kind === 'killSwitch' || kind === 'pause') f.forMs = between(r, 5, 50) * MIN;
    if (kind === 'corruptRestore') Object.assign(f, { how: pick(r, ['truncate', 'garbage', 'wrongRecipient', 'delete']), fixAfterMs: between(r, 20, 60) * MIN });
    out.push(f);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Install a schedule on a sim, relative to now. Returns a summary list for the log. */
export function applySchedule(sim, schedule) {
  const t0 = sim.t;
  const workerFaults = [];
  sim.worker = (ctx) => {
    const f = workerFaults.find((w) => !w.used && ctx.run.created_at >= w.from);
    if (!f) return {};
    f.used = true;
    if (f.kind === 'workerSlow') return { durationMs: f.durationMs };
    if (f.kind === 'workerFail') return { conclusion: 'failure', item: () => ({ upload: false }) };
    if (f.kind === 'workerPartial') return { item: (it, i) => ({ upload: i % 2 === 0 }) };
    if (f.kind === 'workerHold') {
      sim.after(f.releaseAfterMs, () => sim.releaseWorker(ctx.run), 'release held worker');
      return { hold: true };
    }
    return {};
  };
  for (const f of schedule) {
    sim.at(t0 + f.at, () => install(sim, f, workerFaults), `fault ${f.kind}`);
  }
  return schedule.map((f) => `${new Date(t0 + f.at).toISOString().slice(11, 19)} ${describe(f)}`);
}

export function describe(f) {
  const extra = Object.entries(f).filter(([k]) => !['at', 'kind'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${f.kind}${extra ? ` ${extra}` : ''}`;
}

function install(sim, f, workerFaults) {
  sim.log('chaos', `fault: ${describe(f)}`);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  switch (f.kind) {
    case 'kill':
      sim.killWhen({ name: `kill after ${f.point}`, when: (c) => CALLS[f.point]({ method: c.method, path: c.path, host: c.url.origin, query: c.url.searchParams }) });
      break;
    case 'error':
      sim.gh.addFault({ name: `${f.status} on ${f.point}`, times: f.times, match: CALLS[f.point], respond: () => ({ status: f.status, body: { message: 'Server Error' } }) });
      break;
    case 'lie':
      sim.gh.addFault({ name: `lie on ${f.point}`, mode: 'lie', times: 1, match: CALLS[f.point], respond: () => ({ status: 502, body: { message: 'Bad Gateway' } }) });
      break;
    case 'ratelimit': {
      const reset = String(Math.ceil((sim.t + f.resetMs) / 1000));
      const respond = f.primary
        ? () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, body: { message: 'API rate limit exceeded' } })
        : () => ({ status: 429, headers: { 'retry-after': String(Math.ceil(f.resetMs / 1000)) }, body: { message: 'You have exceeded a secondary rate limit' } });
      sim.gh.addFault({ name: `rate limit on ${f.point}`, times: f.times, match: CALLS[f.point], respond });
      break;
    }
    case 'duplicate':
      sim.gh.addFault({ name: 'duplicate dispatch', mode: 'duplicate', times: 1, match: CALLS.workerDispatch });
      break;
    case 'dropSuccessor':
      sim.gh.addFault({ name: 'dropped successor', mode: 'swallow', times: 1, match: CALLS.successorDispatch, respond: () => ({ status: 204 }) });
      break;
    case 'workerSlow': case 'workerHold': case 'workerFail': case 'workerPartial':
      workerFaults.push({ ...f, from: iso(sim.t) });
      break;
    case 'killSwitch':
      // Not while a person is restoring: they hold the switch.
      if (sim.operatorBusy) break;
      sim.setVar('LOOP_ENABLED', 'false');
      sim.after(f.forMs, () => {
        if (!sim.operatorBusy) sim.setVar('LOOP_ENABLED', 'true');
      }, 'kill switch back on');
      break;
    case 'pause':
      sim.setVar('LOOP_PAUSE_UNTIL', new Date(sim.t + f.forMs).toISOString());
      break;
    case 'concurrentPump': {
      const run = sim.gh.createRun(TOOLQA, 'pump.yml', { event: 'workflow_dispatch' });
      sim.pumpRuns.push(run);
      sim.startPumpUngrouped(run);
      break;
    }
    case 'corruptRestore':
      // Only once a snapshot exists to restore from: without one the state
      // is lost for good, which no loop can recover from.
      if (!hasSnapshot(sim) || sim.operatorBusy) {
        sim.log('chaos', 'no snapshot yet, or a restore under way; not corrupting the state');
        break;
      }
      corrupt(sim, f.how);
      sim.after(f.fixAfterMs, () => operatorRestore(sim), 'operator restore');
      break;
    default:
      throw new Error(`unknown fault ${f.kind}`);
  }
}

export function hasSnapshot(sim) {
  return (sim.gh.release(TOOLQA, 'state-snapshots')?.assets ?? []).some((a) => /^state-\d{8}T\d{6}Z-[0-9a-f]{8}\.sqlite\.age$/.test(a.name));
}

/** Damage the live state asset in one of the ways a person must fix. */
export function corrupt(sim, how) {
  const live = sim.liveAsset();
  if (!live) return;
  const bytes = sim.gh.assetBytes(live.id);
  if (how === 'truncate') sim.replaceState(bytes.subarray(0, Math.floor(bytes.length / 2)), { label: live.label });
  else if (how === 'garbage') sim.replaceState(Buffer.from('not a state database '.repeat(64)));
  else if (how === 'wrongRecipient') sim.replaceState(sealTo([pubOf('a-key-the-loop-does-not-hold')], bytes.subarray(60)));
  else if (how === 'delete') sim.deleteState();
  sim.corrupted = how;
}

/**
 * What OPERATIONS.md says a person does: stop the loop, wait for the pump to
 * end, restore a snapshot that reads back (the newest first, then older ones:
 * the hourly copy may have caught the damage), start the loop again. Retries
 * while the drill refuses because a pump run is still going.
 */
export function operatorRestore(sim, { tries = 12 } = {}) {
  sim.operatorBusy = true;
  sim.setVar('LOOP_ENABLED', 'false');
  const done = () => {
    sim.operatorBusy = false;
    sim.setVar('LOOP_ENABLED', 'true');
  };
  const attempt = (n) => {
    const names = snapshotNames(sim);
    const tryEach = (i) => {
      if (i >= names.length) {
        sim.log('operator', 'no snapshot could be restored');
        done();
        return;
      }
      sim.restore({ name: names[i] }).then((r) => {
        if (!r.error) {
          sim.log('operator', `restored ${r.report.snapshot} (applied ${r.report.applied})`);
          sim.corrupted = null;
          done();
          return;
        }
        sim.log('operator', `restore of ${names[i]} refused: ${r.error.message}`);
        if (/refusing --apply|HTTP (403|429|5\d\d)|network|failed: fetch/.test(r.error.message)) {
          if (n < tries) sim.after(5 * MIN, () => attempt(n + 1), 'operator retries the restore');
          else done();
          return;
        }
        tryEach(i + 1); // this snapshot does not read back: an older one
      });
    };
    tryEach(0);
  };
  sim.after(MIN, () => attempt(1), 'operator restore');
}

/** Snapshot names on the release, newest first. */
export function snapshotNames(sim) {
  return (sim.gh.release(TOOLQA, 'state-snapshots')?.assets ?? [])
    .map((a) => a.name)
    .filter((n) => /^state-\d{8}T\d{6}Z-[0-9a-f]{8}\.sqlite\.age$/.test(n))
    .sort()
    .reverse();
}
