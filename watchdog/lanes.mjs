// Lane health checks of the loop health issue (R-WD-23..28; the design audit's A1, A3, G2, H7, H8).
//
// The checks before these ask whether the machinery runs (pump, history, slots, state).
// These ask whether the lanes produce. On 27 Nov the pump ran 24x7, health was green, and
// nothing had been dispatched for 7.5 hours (due=0 for 18 of 30 hours: change detection never
// sets sha or changed_at, so nothing came due; 370 live-probe results were our own failures).
// Nothing here is excused by "nothing is due".
//
//   lane-fresh:<lane>      newest accepted result of an enabled lane, whatever is due: green to 6
//                          hours, amber over, red over 24 hours. Never one: amber, red when the
//                          first dispatch for the lane is over 24 hours old.
//   pump-idle              the frame is incomplete (a subject with a null sha or changed_at, a
//                          subject with no result on an enabled lane, or a newest result older than
//                          its tier's cadence) and nothing has been dispatched for over 3 hours:
//                          amber; over 12 hours: red. Also amber when the pump's latest tick had
//                          subjects due, dispatched none and nothing is in flight. The summary
//                          counts: subjects with a null sha, never-assessed and stale subjects per lane.
//   coverage:<lane>        the share of the whole frame (every subject the lane covers) whose newest
//                          result is assessed: amber under 80%, red under 50%. A lane that skips most
//                          servers does not look covered.
//   tool-failures:<lane>   results that are our tool's fault (results.fault = tool): the absolute
//                          counts, last 24 hours and now, are always shown; amber from 50 now or 20%
//                          of the last 24 hours (at least 5), red from 50% of the last 24 hours.
//   oracle-disagreements   open oracle disagreements: the count; amber when the oldest has been open
//                          over 14 days.
//   ingest-rejects         ingest rejects in the last 24 hours for pin_mismatch, pin_unverified and
//                          schema reasons, by reason: amber when each of the two newest worker runs
//                          had one.
//   external-workflows     the workflows the lanes depend on outside this repository: the nightly
//                          conformance and each enabled lane's workflow file. disabled_inactivity is
//                          amber (the watchdog's token cannot enable them), not found is amber,
//                          disabled by hand is off.

import { NIGHTLY, runsUntrusted } from '../pump/breaker.mjs';
import { isEnabled, maxAgeDays } from '../pump/due.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const LANE_THRESHOLDS = Object.freeze({
  freshAmberMs: 6 * HOUR,
  freshRedMs: 24 * HOUR,
  tickFreshMs: 30 * MIN,
  idleAmberMs: 3 * HOUR,
  idleRedMs: 12 * HOUR,
  disagreementAgeMs: 14 * 24 * HOUR,
  toolWindowMs: 24 * HOUR,
  toolMin: 5,
  toolAmber: 0.2,
  toolAbsAmber: 50,
  toolRed: 0.5,
  coverageAmber: 0.8,
  coverageRed: 0.5,
});

const ago = (now, iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : Infinity;
};
const hours = (ms) => (Number.isFinite(ms) ? `${(ms / HOUR).toFixed(1)} hours` : 'unknown time');
const pct = (x) => `${Math.round(x * 100)}%`;
const iso = (ms) => new Date(ms).toISOString();

const DAY_MS = 86_400_000;
const REJECT_PIN = ['pin_mismatch', 'pin_unverified'];
const REJECT_SCHEMA = ['manifest_invalid', 'manifest_not_json', 'observation_format', 'undeclared_field', 'deprecated_field', 'field_type'];

/**
 * What the lane checks read from the state database, with the pump's own tier cadence
 * (pump/tiers.json) so "stale" means what the due list means by it. Never throws: null when it cannot.
 */
export function readLaneData(db, now, { cfg = {}, tiers = null } = {}) {
  try {
    const all = (sql, ...a) => db.raw.prepare(sql).all(...a).map((r) => ({ ...r }));
    const since = iso(now - LANE_THRESHOLDS.toolWindowMs);
    const subjects = all('SELECT id, tier, sha, artifact_digest, changed_at FROM subjects WHERE retired_at IS NULL AND gone_at IS NULL AND alias_of IS NULL');
    // the newest accepted result of every (subject, lane) pair
    const last = new Map();
    for (const r of all('SELECT subject, workflow, accepted_at, outcome, coverage, fault, accepted_at AS at FROM results ORDER BY accepted_at')) last.set(`${r.subject}\0${r.workflow}`, r);
    const lanes = {};
    for (const [lane, wf] of Object.entries(cfg)) {
      if (!isEnabled(wf)) continue;
      const l = { frame: 0, never: 0, stale: 0, assessed: 0, tool_now: 0 };
      for (const s of subjects) {
        const cell = tiers?.tiers?.[`T${s.tier}`]?.[lane];
        // the frame of a lane is the subjects it must keep current (mode always); a sampling lane is partial by design
        if (!cell || cell.mode !== 'always') continue;
        l.frame += 1;
        const r = last.get(`${s.id}\0${lane}`);
        if (!r) { l.never += 1; continue; }
        // a result from before coverage that was not skips_only counts as assessed, as the due list reads it
        if (r.coverage === 'assessed' || (r.coverage == null && r.outcome != null && r.outcome !== 'skips_only')) l.assessed += 1;
        if (r.fault === 'tool') l.tool_now += 1;
        const maxAge = maxAgeDays(cell, s, tiers, `T${s.tier}`);
        if (maxAge !== null && now - Date.parse(r.accepted_at) > maxAge * DAY_MS) l.stale += 1;
      }
      lanes[lane] = l;
    }
    const rejects = all("SELECT reason, COUNT(*) AS n FROM attempts WHERE accepted = 0 AND received >= ? GROUP BY reason", since).map((r) => ({ reason: r.reason, n: Number(r.n) }));
    const watched = [...REJECT_PIN, ...REJECT_SCHEMA];
    const runsNewest = all(`SELECT run_id, MAX(received) AS at, COALESCE(SUM(accepted = 0 AND reason IN (${watched.map(() => '?').join(',')})), 0) AS bad FROM attempts WHERE received >= ? AND run_id IS NOT NULL GROUP BY run_id ORDER BY MAX(received) DESC LIMIT 2`, ...watched, since);
    return {
      subjects: { total: subjects.length, null_sha: subjects.filter((s) => s.sha == null && s.artifact_digest == null).length, null_changed: subjects.filter((s) => s.changed_at == null).length },
      lanes,
      newest: Object.fromEntries(all('SELECT workflow, MAX(accepted_at) AS at, COUNT(*) AS n FROM results GROUP BY workflow').map((r) => [r.workflow, { at: r.at, n: Number(r.n) }])),
      oldestDispatch: Object.fromEntries(all('SELECT workflow, MIN(created) AS at FROM dispatches GROUP BY workflow').map((r) => [r.workflow, r.at])),
      window: Object.fromEntries(all("SELECT workflow, COUNT(*) AS total, COALESCE(SUM(fault = 'tool'), 0) AS tool FROM results WHERE accepted_at >= ? GROUP BY workflow", since).map((r) => [r.workflow, { total: Number(r.total), tool: Number(r.tool) }])),
      disagreements: all("SELECT COUNT(*) AS n, MIN(opened_at) AS oldest FROM oracle_disagreements WHERE status = 'open'").map((r) => ({ n: Number(r.n), oldest: r.oldest }))[0] ?? { n: 0, oldest: null },
      inFlight: Number(all("SELECT COUNT(*) AS n FROM dispatches WHERE status IN ('pending', 'dispatched')")[0]?.n ?? 0),
      newestDispatch: all('SELECT MAX(created) AS at FROM dispatches')[0]?.at ?? null,
      rejects: { by_reason: rejects.filter((r) => watched.includes(r.reason)), newest_runs: runsNewest.map((r) => ({ run_id: r.run_id, bad: Number(r.bad) })) },
    };
  } catch {
    return null;
  }
}

/** The lanes (workflows of pump/workflows.json) that are enabled and not held by the sandbox breaker. */
function activeLanes(cfg, breakerTripped) {
  return Object.entries(cfg ?? {}).filter(([, wf]) => isEnabled(wf) && !(breakerTripped && runsUntrusted(wf))).map(([name]) => name).sort();
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * @param {{ now: number, slots: number, pumpOn: boolean, cfg: object, data: object|null,
 *   tick: object|null, breakerTripped: boolean }} input
 * @returns {object[]} health items
 */
export function laneChecks({ now, slots, pumpOn, cfg, data, tick, breakerTripped = false }) {
  const items = [];
  if (!data) return [{ id: 'lane-health', status: 'amber', summary: 'could not read the lane results from the state, so the lane checks were skipped' }];
  const T = LANE_THRESHOLDS;
  const running = slots > 0 && pumpOn;
  const lanes = activeLanes(cfg, breakerTripped);
  const tickAge = tick && typeof tick === 'object' ? ago(now, tick.at) : Infinity;
  const due = Number.isFinite(Number(tick?.due)) ? Number(tick.due) : null;

  // newest result per lane (never excused by "nothing due")
  for (const lane of Object.keys(cfg ?? {}).sort()) {
    if (!isEnabled(cfg[lane])) continue;
    const id = `lane-fresh:${lane}`;
    if (!running) { items.push({ id, status: 'off', summary: 'the pump is off' }); continue; }
    if (!lanes.includes(lane)) { items.push({ id, status: 'off', summary: 'held by the open sandbox breaker' }); continue; }
    const n = data.newest?.[lane];
    const age = n ? ago(now, n.at) : Infinity;
    if (n && age <= T.freshAmberMs) items.push({ id, status: 'green', summary: `newest accepted result ${hours(age)} ago (${n.n} results)`, at: n.at });
    else if (!n) {
      const first = data.oldestDispatch?.[lane];
      const waited = first ? ago(now, first) : 0;
      items.push({ id, status: waited > T.freshRedMs ? 'red' : 'amber', summary: first ? `no accepted result yet; the first dispatch was ${hours(waited)} ago` : 'no accepted result yet and nothing dispatched' });
    } else {
      items.push({ id, status: age > T.freshRedMs ? 'red' : 'amber', summary: `no accepted result for ${hours(age)} (newest ${n.at}; due now: ${due ?? 'unknown'})`, at: n.at });
    }
  }

  // the frame, and a pump that sits idle on it
  const fl = lanes.map((l) => [l, data.lanes?.[l]]).filter(([, v]) => v);
  const nullSha = data.subjects?.null_sha ?? 0;
  const nullChanged = data.subjects?.null_changed ?? 0;
  const never = fl.filter(([, v]) => v.never > 0);
  const stale = fl.filter(([, v]) => v.stale > 0);
  const incomplete = nullSha > 0 || nullChanged > 0 || never.length > 0 || stale.length > 0;
  const counts = `${plural(nullSha, 'subject')} with no sha or digest, ${plural(nullChanged, 'subject')} with no changed_at; never assessed: ${fl.map(([l, v]) => `${l} ${v.never}`).join(', ') || 'none'}; stale: ${fl.map(([l, v]) => `${l} ${v.stale}`).join(', ') || 'none'}`;
  if (running) {
    const sinceDispatch = data.newestDispatch ? ago(now, data.newestDispatch) : Infinity;
    const last = data.newestDispatch ? `${hours(sinceDispatch)} ago` : 'never';
    const stuckDue = tickAge <= T.tickFreshMs && due > 0 && !(tick.dispatched > 0) && !tick.stopped && !tick.blocked && !tick.breaker?.tripped && !(tick.paused?.length > 0) && data.inFlight === 0;
    if (incomplete && sinceDispatch > T.idleAmberMs) {
      items.push({ id: 'pump-idle', status: sinceDispatch > T.idleRedMs ? 'red' : 'amber', summary: `nothing dispatched for ${hours(sinceDispatch)} (last ${last}) while the frame is incomplete: ${counts}; the pump's latest tick had ${due ?? 'unknown'} due`, at: data.newestDispatch ?? undefined });
    } else if (stuckDue) {
      items.push({ id: 'pump-idle', status: 'amber', summary: `the pump's latest tick had ${plural(due, 'subject')} due and dispatched none, with nothing in flight (last dispatch ${last}); ${counts}`, at: tick.at });
    } else {
      items.push({ id: 'pump-idle', status: 'green', summary: incomplete ? `last dispatch ${last}; the frame is incomplete but work is going out: ${counts}` : `last dispatch ${last}; the frame is complete` });
    }
  }

  // coverage over the whole frame, and our tool's own failures, per lane
  for (const [lane, v] of fl) {
    if (v.frame > 0) {
      const share = v.assessed / v.frame;
      items.push({ id: `coverage:${lane}`, status: share < T.coverageRed ? 'red' : share < T.coverageAmber ? 'amber' : 'green', summary: `${v.assessed} of ${v.frame} subjects (${pct(share)}) have an assessed result; ${v.never} never ran (amber under ${pct(T.coverageAmber)}, red under ${pct(T.coverageRed)})` });
    }
    const w = data.window?.[lane] ?? { total: 0, tool: 0 };
    const share = w.total >= T.toolMin ? w.tool / w.total : 0;
    const status = share >= T.toolRed ? 'red' : share >= T.toolAmber || v.tool_now >= T.toolAbsAmber ? 'amber' : 'green';
    if (v.tool_now > 0 || w.tool > 0) {
      items.push({ id: `tool-failures:${lane}`, status, summary: `${plural(v.tool_now, 'result')} now (${w.tool} of ${w.total} in the last 24 hours, ${pct(w.total ? w.tool / w.total : 0)}) are our tool's fault (amber from ${T.toolAbsAmber} results or ${pct(T.toolAmber)} of 24 hours, red from ${pct(T.toolRed)})` });
    }
  }

  // oracle disagreements
  const d = data.disagreements ?? { n: 0, oldest: null };
  const dAge = d.oldest ? ago(now, d.oldest) : 0;
  items.push(d.n > 0 && dAge > T.disagreementAgeMs
    ? { id: 'oracle-disagreements', status: 'amber', summary: `${plural(d.n, 'open oracle disagreement')}; the oldest has been open ${(dAge / (24 * HOUR)).toFixed(0)} days (opened ${d.oldest}) and is not settling` }
    : { id: 'oracle-disagreements', status: 'green', summary: `${plural(d.n, 'open oracle disagreement')}` });

  // ingest rejects that are the loop's own to fix
  const rj = data.rejects ?? { by_reason: [], newest_runs: [] };
  const total = rj.by_reason.reduce((a, r) => a + r.n, 0);
  const both = rj.newest_runs.length >= 2 && rj.newest_runs.every((r) => r.bad > 0);
  const listed = rj.by_reason.map((r) => `${r.reason} ${r.n}`).join(', ') || 'none';
  items.push({ id: 'ingest-rejects', status: both ? 'amber' : 'green', summary: `ingest rejects in 24 hours for pins and schema: ${listed}${both ? '; the two newest worker runs both had one' : ''}` });
  return items;
}

/** The workflows outside this repository the lanes depend on: the nightly and each enabled lane's file. */
export function externalWorkflows(cfg, extra = []) {
  const seen = new Set();
  const out = [];
  const add = (repo, file, why) => {
    if (typeof repo !== 'string' || typeof file !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w.-]+\.ya?ml$/.test(file)) return;
    const key = `${repo}/${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ repo, file, why });
  };
  add(NIGHTLY.repo, NIGHTLY.path.split('/').pop(), 'the nightly sandbox conformance');
  for (const e of extra) add(e.repo, String(e.path ?? '').split('/').pop(), e.why ?? 'expected');
  for (const [name, wf] of Object.entries(cfg ?? {})) if (isEnabled(wf)) add(wf.repo, wf.file, `the ${name} lane`);
  return out;
}

/** GET each workflow's state with `client`; never throws. */
export async function readExternalWorkflows(client, list) {
  const out = [];
  for (const w of list) {
    try {
      const res = await client.request('GET', `/repos/${w.repo}/actions/workflows/${w.file}`, { allow: [404] });
      out.push({ ...w, state: res.status === 404 ? 'not_found' : String(res.data?.state ?? 'unknown') });
    } catch (err) {
      out.push({ ...w, state: 'error', error: String(err?.message ?? err).slice(0, 120) });
    }
  }
  return out;
}

export function externalCheck(read) {
  const id = 'external-workflows';
  if (!read || read.length === 0) return { id, status: 'off', summary: 'no external workflow is expected' };
  const bad = read.filter((w) => w.state !== 'active');
  const name = (w) => `${w.repo}/${w.file}`;
  const amber = bad.filter((w) => w.state !== 'disabled_manually');
  if (amber.length) {
    return { id, status: 'amber', summary: `${amber.map((w) => `${name(w)} (${w.why}) is ${w.state === 'disabled_inactivity' ? 'disabled by GitHub for inactivity: enable it by hand, the watchdog token cannot' : w.state === 'not_found' ? 'not found' : w.state === 'error' ? `unreadable: ${w.error}` : w.state}`).join('; ')}` };
  }
  if (bad.length) return { id, status: 'off', summary: `${bad.map(name).join(', ')} disabled by hand` };
  return { id, status: 'green', summary: `${read.length} external workflow${read.length === 1 ? ' is' : 's are'} enabled (${read.map((w) => w.file).join(', ')})` };
}
