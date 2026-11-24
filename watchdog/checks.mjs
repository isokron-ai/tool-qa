// Watchdog checks. evaluate() is pure: it takes what the watchdog read from the
// API and the state asset and returns one item per check, plus what to do.
//
// Statuses: green (fine), amber (late or degraded), red (needs a person),
// off (switched off on purpose: LOOP_SLOTS=0, a lane switch, or a workflow
// disabled by hand).
//
//   pump                 a pump run is going, or one started in the last 20 minutes
//                        (amber after 20 and the watchdog dispatches one; red
//                        after 40). Off when LOOP_SLOTS is 0 or the pump lane is off.
//   history-*            newest artifact age: registry-delta green to 45 minutes,
//                        red after 90; registry-full, history-packages and
//                        history-popularity green to 26 hours, red after 50.
//   slots, dispatches    open rows past their expiry by more than 15 minutes are
//                        red (the pump is not reaping).
//   state                no state asset yet is amber.
//   run:<workflow>       the newest finished scheduled or dispatched run of a loop
//                        workflow failed (cancelled and skipped runs are passed over).
//   pump-successor       the pump could not dispatch the next pump run.
//   subjects             the pump could not load the seed subjects at its last
//                        start (pump/subjects.mjs): red, with why. It keeps
//                        dispatching the subjects it already has (R-SUB-11).
//   workflow:<file>      an expected workflow GitHub disabled for inactivity
//                        (amber; the watchdog re-enables it) or one disabled by
//                        hand (off).
//   sandbox-breaker      the nightly sandbox conformance status (pump/breaker.mjs):
//                        green while it passed within 36 hours; red while it is
//                        red, stale or unreadable and a lane that runs third-party
//                        code is enabled (the pump holds those lanes); amber when
//                        it would hold lanes but none is enabled, or when it is
//                        closed but an enabled lane pins another sandbox commit
//                        than the one the nightly tested.

const MIN = 60_000;
const HOUR = 60 * MIN;

export const THRESHOLDS = Object.freeze({
  pumpAmberMs: 20 * MIN,
  pumpRedMs: 40 * MIN,
  stuckGraceMs: 15 * MIN,
  history: Object.freeze([
    { id: 'history-registry-delta', lane: 'history-registry', prefix: 'registry-delta-', label: 'registry-delta', greenMs: 45 * MIN, redMs: 90 * MIN },
    { id: 'history-registry-full', lane: 'history-registry', prefix: 'registry-full-', label: 'registry-full', greenMs: 26 * HOUR, redMs: 50 * HOUR },
    { id: 'history-packages', lane: 'history-packages', prefix: 'history-packages-', label: 'history-packages', greenMs: 26 * HOUR, redMs: 50 * HOUR },
    { id: 'history-popularity', lane: 'history-popularity', prefix: 'history-popularity-', label: 'history-popularity', greenMs: 26 * HOUR, redMs: 50 * HOUR },
  ]),
});

/** Loop workflows the watchdog looks at, with the lane (guard job name) that switches each. */
export const LOOP_WORKFLOWS = Object.freeze([
  { file: 'pump.yml', lane: 'pump' },
  { file: 'watchdog.yml', lane: 'watchdog' },
  { file: 'history-registry.yml', lane: 'history-registry' },
  { file: 'history-packages.yml', lane: 'history-packages' },
  { file: 'history-popularity.yml', lane: 'history-popularity' },
]);

const RANK = { off: 0, green: 1, amber: 2, red: 3 };
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const PASSED_OVER = new Set(['cancelled', 'skipped', 'neutral', 'stale']);
const LOOP_EVENTS = new Set(['schedule', 'workflow_dispatch']);

export function overallStatus(checks) {
  let best = 'off';
  for (const c of checks) if ((RANK[c.status] ?? 0) > RANK[best]) best = c.status;
  return best;
}

function age(now, iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : Infinity;
}

function minutes(ms) {
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 2 * HOUR) return `${Math.round(ms / MIN)} minutes ago`;
  return `${(ms / HOUR).toFixed(1)} hours ago`;
}

const laneOn = (lanes, lane) => lanes?.[lane] !== false;
const baseName = (path) => String(path).split('/').pop();

/**
 * @param {{ now: number, slots: number, lanes?: Record<string, boolean>,
 *   runs?: Record<string, object[]>, artifacts?: object[], state: object|null,
 *   workflows?: object[], expected?: string[] }} input
 * @returns {{ checks: {id: string, status: string, summary: string, link?: string, at?: string}[],
 *   actions: { dispatchPump: boolean, enableWorkflows: {id: number, path: string}[] } }}
 */
export function evaluate({ now, slots, lanes = {}, runs = {}, artifacts = [], state, workflows = [], expected = [], breaker }) {
  const checks = [];
  const actions = { dispatchPump: false, enableWorkflows: [] };

  // pump liveness
  if (!(slots > 0)) {
    checks.push({ id: 'pump', status: 'off', summary: 'LOOP_SLOTS is 0: the pump only does housekeeping on its schedule' });
  } else if (!laneOn(lanes, 'pump')) {
    checks.push({ id: 'pump', status: 'off', summary: 'the pump lane is switched off (LANE_PUMP_ENABLED)' });
  } else {
    const pumpRuns = runs['pump.yml'] ?? [];
    const going = pumpRuns.find((r) => r.status === 'in_progress');
    const started = pumpRuns.filter((r) => r.status === 'in_progress' || r.status === 'completed')
      .map((r) => r.run_started_at ?? r.created_at)
      .sort()
      .at(-1);
    const a = age(now, started);
    if (going) checks.push({ id: 'pump', status: 'green', summary: `a pump run is in progress (started ${minutes(age(now, going.run_started_at ?? going.created_at))})`, link: going.html_url });
    else if (a <= THRESHOLDS.pumpAmberMs) checks.push({ id: 'pump', status: 'green', summary: `last pump run started ${minutes(a)}` });
    else {
      actions.dispatchPump = true;
      const status = a > THRESHOLDS.pumpRedMs ? 'red' : 'amber';
      checks.push({ id: 'pump', status, summary: `no pump run started for ${Number.isFinite(a) ? minutes(a).replace(' ago', '') : 'a long time (none found)'}; dispatching one` });
    }
  }

  // history freshness
  for (const h of THRESHOLDS.history) {
    if (!laneOn(lanes, h.lane)) {
      checks.push({ id: h.id, status: 'off', summary: `the ${h.lane} lane is switched off` });
      continue;
    }
    const newest = artifacts
      .filter((x) => !x.expired && String(x.name).startsWith(h.prefix))
      .map((x) => x.created_at)
      .sort()
      .at(-1);
    if (!newest) {
      checks.push({ id: h.id, status: 'red', summary: `no ${h.label} artifact found` });
      continue;
    }
    const a = age(now, newest);
    const status = a <= h.greenMs ? 'green' : a <= h.redMs ? 'amber' : 'red';
    checks.push({ id: h.id, status, summary: `newest ${h.label} artifact is from ${minutes(a)}` });
  }

  // state, slots, dispatches, successor
  if (!state) {
    checks.push({ id: 'state', status: 'amber', summary: 'no state asset yet (the pump has not saved state)' });
  } else {
    const grace = now - THRESHOLDS.stuckGraceMs;
    const stuckSlots = (state.openSlots ?? []).filter((s) => Date.parse(s.expires) < grace);
    const live = (state.openSlots ?? []).length - stuckSlots.length;
    checks.push(stuckSlots.length
      ? { id: 'slots', status: 'red', summary: `${stuckSlots.length} slot${stuckSlots.length === 1 ? '' : 's'} past expiry by more than 15 minutes: the pump is not reaping` }
      : { id: 'slots', status: 'green', summary: `${live} of ${Math.max(0, slots)} worker slots in use` });
    const stuckD = (state.openDispatches ?? []).filter((d) => Date.parse(d.expires) < grace);
    checks.push(stuckD.length
      ? { id: 'dispatches', status: 'red', summary: `${stuckD.length} dispatch${stuckD.length === 1 ? '' : 'es'} past expiry by more than 15 minutes (${stuckD.slice(0, 3).map((d) => d.shard_id).join(', ')})` }
      : { id: 'dispatches', status: 'green', summary: `${(state.openDispatches ?? []).length} dispatches waiting for results` });
    const succ = state.kv?.['pump.successor'];
    if (succ && typeof succ === 'object') {
      checks.push(succ.ok
        ? { id: 'pump-successor', status: 'green', summary: 'the pump dispatched its successor', at: succ.at }
        : { id: 'pump-successor', status: 'red', summary: `the pump could not dispatch its successor: ${String(succ.error ?? 'unknown error').slice(0, 200)}`, at: succ.at });
    }
    const subj = state.kv?.['pump.subjects'];
    if (subj && typeof subj === 'object') {
      checks.push(subj.ok
        ? { id: 'subjects', status: 'green', summary: String(subj.summary ?? 'seed subjects loaded').slice(0, 200), at: subj.at }
        : { id: 'subjects', status: 'red', summary: `the pump could not load the seed subjects (it keeps dispatching the ones it has): ${String(subj.summary ?? 'unknown error').slice(0, 200)}`, at: subj.at });
    }
  }

  // latest loop run per workflow
  for (const w of LOOP_WORKFLOWS) {
    const list = (runs[w.file] ?? []).filter((r) => r.status === 'completed' && LOOP_EVENTS.has(r.event) && !PASSED_OVER.has(r.conclusion));
    if (list.length === 0) continue;
    const id = `run:${w.file.replace(/\.yml$/, '')}`;
    if (!laneOn(lanes, w.lane)) {
      checks.push({ id, status: 'off', summary: `the ${w.lane} lane is switched off` });
      continue;
    }
    const last = list[0];
    checks.push(FAILED.has(last.conclusion)
      ? { id, status: 'red', summary: `latest ${w.file} run ended in ${last.conclusion}`, link: last.html_url }
      : { id, status: 'green', summary: `latest ${w.file} run succeeded`, link: last.html_url });
  }

  // workflows GitHub disabled
  const want = new Set(expected.map(String));
  for (const wf of workflows) {
    if (!want.has(wf.path)) continue;
    const id = `workflow:${baseName(wf.path)}`;
    if (wf.state === 'disabled_inactivity') {
      actions.enableWorkflows.push({ id: wf.id, path: wf.path });
      checks.push({ id, status: 'amber', summary: `${baseName(wf.path)} was disabled by GitHub for inactivity; re-enabling it` });
    } else if (wf.state === 'disabled_manually') {
      checks.push({ id, status: 'off', summary: `${baseName(wf.path)} is disabled by hand` });
    }
  }

  // the sandbox breaker
  if (breaker) checks.push(breakerCheck(breaker));

  return { checks, actions };
}

/**
 * The health item for the sandbox breaker. `breaker` is pump/breaker.mjs
 * breakerFrom() plus `untrusted` (every lane that runs third-party code) and
 * `enabled` (those of them that are enabled).
 */
export function breakerCheck({ tripped, reason, summary, run_url: link, untrusted = [], enabled = [], mismatch = [] }) {
  const item = { id: 'sandbox-breaker', status: 'green', summary: `closed: ${summary}` };
  if (link) item.link = link;
  if (!tripped && mismatch.length) {
    const short = (v) => (v ? String(v).slice(0, 12) : 'none');
    item.status = 'amber';
    item.summary = `closed, but the nightly tested sandbox ${short(mismatch[0].tested)} and ${mismatch.map((m) => `${m.lane} pins ${short(m.pins)}`).join(', ')}: ${summary}`;
  }
  if (!tripped) return item;
  if (enabled.length) {
    item.status = 'red';
    item.summary = `open (${reason}): the pump holds ${enabled.join(', ')}: ${summary}`;
  } else {
    item.status = 'amber';
    item.summary = `open (${reason}): would hold ${untrusted.join(', ') || 'nothing'} (none enabled): ${summary}`;
  }
  return item;
}
