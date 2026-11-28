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
//   api-budget           amber while a rate-limit block the pump saved
//                        (pump.api_budget) is in force, or its latest tick
//                        (within 30 minutes) stopped dispatching or ingest
//                        early on the GitHub API budget or a rate limit
//                        (pump.last_tick); not shown otherwise.
//   subjects             the pump could not load the seed subjects at its last
//                        start (pump/subjects.mjs): red, with why. It keeps
//                        dispatching the subjects it already has (R-SUB-11).
//   subject-ids          the pump's subject id lookups (watchdog/identity.mjs):
//                        red on a mass of NOT_FOUND or of gone subjects,
//                        amber on any id conflict.
//   subject-heads        the pump's head poll (watchdog/heads.mjs): amber when
//                        nothing was written for 6 hours, red after 24.
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
//   sandbox-selftest     per-lane sandbox self tests (watchdog/selftest.mjs): amber when
//                        2 or more `sandbox-selftest` jobs of the enabled third-party-code
//                        lanes failed in 6 hours, or one failed on a runner image the
//                        nightly has not passed on, or the lookup failed; never red.
//   lane-fresh:<lane>, pump-idle, coverage:<lane>, tool-failures:<lane>, oracle-disagreements,
//   ingest-rejects, external-workflows
//                        whether the lanes produce, not only whether the machinery runs
//                        (watchdog/lanes.mjs, the design audit's H7 and H8).
//   state-snapshot       the hourly state snapshots (snapshot/health.mjs): amber
//                        when no snapshot run has confirmed the live state is
//                        captured for 3 hours (or there is no snapshot yet, the
//                        release or manifest is missing or unreadable, or its
//                        time is in the future), red after 6. Off when the
//                        state-snapshot lane is off.
//   keep-markers         every seal whose keep-forever file failed (kv retention.seal
//                        keep_gaps) has its ingest-keepgap-<run>-<attempt> artifact
//                        (keep/health.mjs markerCheck): red when the marker is missing
//                        an hour after the seal, amber when it cannot be matched.
//   t0:<lane>            the T0 control lanes t0-defects and t0-self (watchdog/t0-lanes.mjs):
//                        amber when no result for 36 hours, red when a seeded defect was missed.
//   state-size           the state database's size, rows and last prune pass
//                        as the pump recorded them (kv state.size), the asset
//                        it was pulled from, and the snapshot release's total
//                        (watchdog/size.mjs): amber over 256 MiB or 2 GB of
//                        snapshots or a failed prune pass, red over 768 MiB or
//                        6 GB of snapshots.

import { snapshotCheck } from '../snapshot/health.mjs';
import { sizeCheck } from './size.mjs';
import { markerCheck, sealCheck } from '../keep/health.mjs';
import { identityCheck } from './identity.mjs';
import { headsCheck } from './heads.mjs';
import { selftestCheck } from './selftest.mjs';
import { externalCheck, laneChecks } from './lanes.mjs';
import { t0LaneChecks } from './t0-lanes.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;

export const THRESHOLDS = Object.freeze({
  pumpAmberMs: 20 * MIN,
  pumpRedMs: 40 * MIN,
  stuckGraceMs: 15 * MIN,
  budgetHeldMs: 30 * MIN,
  liveAmberMs: 20 * MIN,
  liveRedMs: 40 * MIN,
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
  { file: 'state-snapshot.yml', lane: 'state-snapshot' },
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

/**
 * The live loop view snapshot (live/publish.mjs, kv live.last_upload). Off
 * while the switch is not exactly "true"; red when the last upload was blocked
 * by the scan or the last good one is over 40 minutes old; amber over 20.
 */
export function liveSnapshotCheck({ now, on, last }) {
  const id = 'live-snapshot';
  if (!on) return { id, status: 'off', summary: 'the live snapshot is switched off (LANE_LIVE_SNAPSHOT_ENABLED is not "true")' };
  const rec = last && typeof last === 'object' ? last : null;
  // A scan block stays red until a good upload (blocked_at is carried until then).
  if (rec && !rec.ok && (rec.blocked === 'scan' || rec.blocked_at)) {
    return { id, status: 'red', summary: 'a live snapshot was held back by the pre-upload scan and none has passed since: nothing is published until it does (see the pump log for the rule and path)', at: rec.blocked_at ?? rec.at };
  }
  // No builder (live/build.mjs missing or failing): nothing can be published.
  if (rec && !rec.ok && rec.error === 'build') {
    return { id, status: 'red', summary: 'the live snapshot builder could not run (live/build.mjs missing or failing): nothing is published', at: rec.at };
  }
  const okAt = rec ? (rec.ok ? rec.at : rec.last_ok_at) : null;
  const why = rec && !rec.ok ? `; the latest attempt failed (${String(rec.error ?? 'unknown').slice(0, 40)})` : '';
  if (!okAt || !Number.isFinite(Date.parse(okAt))) {
    // Never a good upload: red 40 minutes after the first attempt (a missing credential included).
    const a0 = age(now, rec?.first_at);
    if (!Number.isFinite(a0)) return { id, status: 'amber', summary: 'no live snapshot has been uploaded yet' };
    return { id, status: a0 > THRESHOLDS.liveRedMs ? 'red' : 'amber', summary: `no live snapshot has ever been uploaded (first attempt ${minutes(a0)})${why}`, at: rec.first_at };
  }
  const a = age(now, okAt);
  if (a > THRESHOLDS.liveRedMs) return { id, status: 'red', summary: `last good live snapshot upload ${minutes(a)}${why}`, at: okAt };
  if (a > THRESHOLDS.liveAmberMs) return { id, status: 'amber', summary: `last good live snapshot upload ${minutes(a)}${why}`, at: okAt };
  return { id, status: 'green', summary: `last live snapshot upload ${minutes(a)}${why}`, at: okAt };
}

const laneOn = (lanes, lane) => lanes?.[lane] !== false;
const baseName = (path) => String(path).split('/').pop();

/**
 * @param {{ now: number, slots: number, lanes?: Record<string, boolean>,
 *   runs?: Record<string, object[]>, artifacts?: object[], state: object|null,
 *   workflows?: object[], expected?: string[], breaker?: object,
 *   snapshot?: { manifest?: object|null, error?: string|null, missing?: string|null } }} input
 * @returns {{ checks: {id: string, status: string, summary: string, link?: string, at?: string}[],
 *   actions: { dispatchPump: boolean, enableWorkflows: {id: number, path: string}[] } }}
 */
export function evaluate({ now, slots, lanes = {}, liveSwitch, runs = {}, artifacts = [], state, workflows = [], expected = [], breaker, snapshot, selftest, laneHealth }) {
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
    // The pump held by GitHub's rate limit or its own API budget (R-CHAOS-04):
    // results wait and leases may run out, so it is not green. Shown only
    // while it holds: a rate-limit block the pump saved (pump.api_budget) is
    // still in force, or the pump's latest tick (within 30 minutes) stopped
    // dispatching or ingest early for it.
    const tick = state.kv?.['pump.last_tick'];
    const tickAge = tick && typeof tick === 'object' ? age(now, tick.at) : Infinity;
    const stopped = [tick?.stopped === 'budget' || tick?.stopped === 'rate_limited' ? `dispatching (${tick.stopped})` : null, tick?.ingest?.stopped === 'budget' ? 'ingest' : null].filter(Boolean);
    const blocks = Object.values(state.kv?.['pump.api_budget']?.blocked ?? {}).map(Number).filter(Number.isFinite);
    const blockedUntil = blocks.length ? Math.max(...blocks) : 0;
    if (blockedUntil > now) {
      checks.push({ id: 'api-budget', status: 'amber', summary: `GitHub rate-limited the pump: its API calls are held until ${new Date(blockedUntil).toISOString()}; results and dispatches wait until then` });
    } else if (stopped.length && tickAge <= THRESHOLDS.budgetHeldMs) {
      checks.push({ id: 'api-budget', status: 'amber', summary: `the pump's latest tick (${minutes(tickAge)}) stopped ${stopped.join(' and ')} early on the GitHub API budget or a rate limit; work waits until it passes`, at: tick.at });
    }
    // The state's size (loop upgrade #14), fenced like the snapshot item.
    let size;
    try {
      size = sizeCheck({ size: state.kv?.['state.size'] ?? null, lastRun: state.kv?.['pump.last_run'] ?? null, asset: state.asset ?? null, snapshots: snapshot?.total_bytes !== undefined ? snapshot : null });
    } catch (err) {
      size = { id: 'state-size', status: 'amber', summary: `could not judge the state size: ${String(err?.message ?? err).slice(0, 200)}` };
    }
    checks.push(size);
    checks.push(sealCheck(state.kv?.['retention.seal'] ?? null)); // compression and keep-forever files at seal time (keep/health.mjs)
    checks.push(markerCheck({ now, seal: state.kv?.['retention.seal'] ?? null, artifacts })); // every failed keep-forever file has its gap marker (R-WD-14)
    const subj = state.kv?.['pump.subjects'];
    if (subj && typeof subj === 'object') {
      checks.push(subj.ok
        ? { id: 'subjects', status: 'green', summary: String(subj.summary ?? 'seed subjects loaded').slice(0, 200), at: subj.at }
        : { id: 'subjects', status: 'red', summary: `the pump could not load the seed subjects (it keeps dispatching the ones it has): ${String(subj.summary ?? 'unknown error').slice(0, 200)}`, at: subj.at });
    }
    checks.push(liveSnapshotCheck({ now, on: liveSwitch === 'true', last: state.kv?.['live.last_upload'] ?? null }));
    const ids = identityCheck(state.kv?.['pump.identity']); if (ids) checks.push(ids); // subject ids (watchdog/identity.mjs)
    const hd = headsCheck({ now, heads: state.kv?.['pump.heads'] }); if (hd) checks.push(hd); // head poll (watchdog/heads.mjs)
    checks.push(...t0LaneChecks({ now, kv: state.kv?.['t0.lanes'] ?? null })); // T0 control lanes (watchdog/t0-lanes.mjs)
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

  // the lanes' own sandbox self tests (watchdog/selftest.mjs, R-WD-17); fenced like the snapshot item
  if (selftest) {
    let item;
    try {
      item = selftestCheck(selftest);
    } catch (err) {
      item = { id: 'sandbox-selftest', status: 'amber', summary: `could not judge the lanes' sandbox self tests: ${String(err?.message ?? err).slice(0, 200)}` };
    }
    checks.push(item);
  }

  // do the lanes produce: freshness, idle pump, coverage, our tool's failures, disagreements, rejects,
  // and the workflows they depend on (watchdog/lanes.mjs, R-WD-23..28); fenced like the snapshot item
  if (laneHealth) {
    try {
      checks.push(...laneChecks({ now, slots, pumpOn: laneOn(lanes, 'pump'), cfg: laneHealth.cfg, data: laneHealth.data ?? null, tick: state?.kv?.['pump.last_tick'] ?? null, breakerTripped: breaker?.tripped === true, coverage: laneHealth.coverage ?? null }));
      if (laneHealth.external) checks.push(externalCheck(laneHealth.external));
    } catch (err) {
      checks.push({ id: 'lane-health', status: 'amber', summary: `could not judge the lanes: ${String(err?.message ?? err).slice(0, 200)}` });
    }
  }

  // the hourly state snapshots
  // snapshotCheck does not throw, but a bad manifest must never take the
  // whole watchdog run down, so it is fenced here too (R-SNAP-17).
  if (snapshot) {
    let item;
    try {
      item = snapshotCheck({ now, manifest: snapshot.manifest ?? null, error: snapshot.error ?? null, missing: snapshot.missing ?? null, laneOn: laneOn(lanes, 'state-snapshot') });
    } catch (err) {
      item = { id: 'state-snapshot', status: 'amber', summary: `could not judge the snapshot manifest: ${String(err?.message ?? err).slice(0, 200)}` };
    }
    checks.push(item);
  }

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
