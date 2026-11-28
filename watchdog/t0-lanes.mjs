// Health items for the T0 control lanes (pump/controls.mjs): t0-defects, t0-self, t0-dogfood (and t0-fuzz). One item per
// lane, id `t0:<lane>`, from kv `t0.lanes` that the pump writes after every tick, judged PER SUBJECT: one subject's success
// never covers another subject's miss.
//
//   off     the lane's repository variable is not "true": nothing dispatched
//   red     some subject has a control_failed rejection newer than its last accepted result: a seeded defect was MISSED,
//           or a known-good control failed. Either is a lead against OUR tools (writecheck, the matrix, the workers),
//           never a fault of a subject. It stays red while the run_key is parked, until an accepted result.
//   amber   some subject has had no accepted result for 36 hours (36 hours since the lane was first seen on, if it never had one).
//           A skips_only result (infrastructure skipped, nothing measured) is not a result: it never keeps a subject green.
//   green   otherwise
// Red wins over amber: a miss is the thing to read first.

import { NO_RESULT_AMBER_MS } from '../pump/controls.mjs';

const HOUR = 3_600_000;
const short = (id) => String(id).split('/').pop();
const hoursAgo = (now, iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${((now - t) / HOUR).toFixed(1)} hours ago` : 'never';
};
const list = (ids) => `${ids.slice(0, 4).map(short).join(', ')}${ids.length > 4 ? ` and ${ids.length - 4} more` : ''}`;

/** One lane's item from its kv record. */
export function t0LaneCheck({ now, lane, rec }) {
  const id = `t0:${lane}`;
  if (!rec || typeof rec !== 'object') return { id, status: 'amber', summary: `the pump has not recorded the ${lane} lane yet` };
  if (!rec.on) return { id, status: 'off', summary: `the ${lane} lane is switched off (its LANE_*_ENABLED repository variable is not "true")` };
  const subjects = rec.subjects && typeof rec.subjects === 'object' ? rec.subjects : {};
  const names = Object.keys(subjects).sort();
  const failed = names.filter((n) => subjects[n]?.failed);
  if (failed.length) {
    const first = subjects[failed[0]];
    return {
      id, status: 'red', at: first.failed_at ?? undefined,
      summary: `${lane}: a control failed for ${list(failed)} (${hoursAgo(now, first.failed_at)}, attempt ${String(first.failed_attempt ?? '?').slice(0, 40)}): a seeded defect was missed or the known-good build failed. That is a lead against our own tool, not the subject; the sealed ingest report names the cell`,
    };
  }
  const since = Date.parse(rec.on_since ?? '');
  const stale = [];
  const never = [];
  for (const n of names) {
    const last = Date.parse(subjects[n]?.last_result_at ?? '');
    const ref = Number.isFinite(last) ? last : since;
    if (!Number.isFinite(ref)) { never.push(n); continue; }
    if (now - ref > NO_RESULT_AMBER_MS) (Number.isFinite(last) ? stale : never).push(n);
  }
  if (!names.length) return { id, status: 'amber', summary: `${lane}: the record lists no subject` };
  if (stale.length || never.length) {
    const bits = [];
    const infra = (arr) => arr.filter((n) => subjects[n]?.infra_only_since);
    if (stale.length) bits.push(`no accepted result for 36 hours: ${list(stale)}${infra(stale).length ? ` (${list(infra(stale))}: only results that skipped on infrastructure since)` : ''}`);
    if (never.length) bits.push(`no result since the lane was switched on: ${list(never)}${infra(never).length ? ` (${list(infra(never))}: only results that skipped on infrastructure)` : ''}`);
    return { id, status: 'amber', summary: `${lane}: ${bits.join('; ')}` };
  }
  const newest = names.map((n) => subjects[n]?.last_result_at).filter(Boolean).sort().at(-1);
  return { id, status: 'green', summary: newest ? `${lane}: every subject has an accepted result in the last 36 hours (newest ${hoursAgo(now, newest)}), every control held` : `${lane}: switched on ${hoursAgo(now, rec.on_since)}, waiting for the first results`, at: newest ?? rec.on_since ?? undefined };
}

/** Items for every control lane in kv t0.lanes ({at, lanes: {<lane>: rec}}); none without one. Never throws. */
export function t0LaneChecks({ now, kv }) {
  try {
    const lanes = kv && typeof kv === 'object' && kv.lanes && typeof kv.lanes === 'object' ? kv.lanes : null;
    if (!lanes) return [];
    return Object.keys(lanes).sort().map((lane) => t0LaneCheck({ now, lane, rec: lanes[lane] }));
  } catch (err) {
    return [{ id: 't0-lanes', status: 'amber', summary: `could not judge the T0 control lanes: ${String(err?.message ?? err).slice(0, 200)}` }];
  }
}
