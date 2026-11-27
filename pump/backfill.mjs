// The backfill filler (design audit A1): free worker capacity is never left
// idle while the frame has work a run can refresh.
//
// The due list (pump/due.mjs) says what MUST run: first sight, a new version
// or change event, a tier's max age passed, and the rest. On most ticks of the
// 27 Nov audit it was empty (`due 0`) while slots stood free for hours,
// because every result was younger than its tier's max age (T3: 30 days).
// The filler takes those free slots: when a tick's due list leaves room, it
// adds the frame's next slice, the pairs whose newest accepted result is the
// oldest, by tier.
//
// A pair is a backfill candidate when all hold:
//   - its subject is active (not retired, gone or merged) and its workflow is
//     enabled, not paused and not held by the breaker (the tick's config);
//   - its tier cell is `always` (a `sample` or `never` cell is not the frame);
//   - it has an accepted result (a pair without one is due as first_sight) and
//     that result is at least tiers.json backfill_min_age_hours[tier] old, so
//     a pair is never refreshed faster than that floor (T0 6 h, T1 12 h, T2
//     24 h, T3 48 h, T4 96 h);
//   - its last result is not skips_only inside its skips_only wait (R-SUB-06),
//     and its run_key is not parked, in a retry backoff, held for a late
//     judgment or already in flight;
//   - it is not on the tick's due list already.
//
// Reason `backfill`. Priority: the tier weight plus the age of the last
// result in days (at most priority.age_max), minus BACKFILL_BAND (1000), so a
// backfill pair always ranks below every due pair, in any lane: it only ever
// takes a slot no due work could use.
//
// How much: backfillFor() is given the room the tick has, in shards: the free
// worker slots, the lanes' slots_max, less what the due list will take. It
// fills the last partial due shard of a lane first (no extra slot), then
// opens new shards, best candidate first, until the free slots are used.
//
// Switch: LANE_BACKFILL_ENABLED. Only the exact value "true" turns it on.

import { isEnabled, maxAgeDays, runKey, runKeyFields, skipsOnlyWaitDays } from './due.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SEP = '\u0000';

export const BACKFILL_BAND = 1000;
/** Used when tiers.json has no backfill_min_age_hours for a tier. */
export const DEFAULT_MIN_AGE_HOURS = Object.freeze({ T0: 6, T1: 12, T2: 24, T3: 48, T4: 96 });

/** Whether the filler may run: LANE_BACKFILL_ENABLED is exactly "true". */
export function backfillEnabled(env = {}) {
  return env.LANE_BACKFILL_ENABLED === 'true';
}

/** The floor (hours) under which a tier's pair is not refreshed by backfill. */
export function minAgeHours(tiers, tierName) {
  const h = Number(tiers?.backfill_min_age_hours?.[tierName]);
  if (Number.isFinite(h) && h >= 0) return h;
  return DEFAULT_MIN_AGE_HOURS[tierName] ?? 48;
}

const pairKey = (subject, workflow) => `${subject}${SEP}${workflow}`;
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

/**
 * Every backfill candidate, best first. Pure.
 * @param {object} input  what loadDueInputs() returns (subjects, workflows, tiers, lastResults, inFlight, parked, now)
 * @param {{ exclude?: Set<string>, holdRunKeys?: Set<string>|null }} opts
 *   exclude: "<subject>\0<workflow>" pairs already on the due list
 */
export function backfillCandidates(input, { exclude = new Set(), holdRunKeys = null } = {}) {
  const { now, subjects, workflows, tiers, lastResults, inFlight, parked } = input;
  const weights = tiers.weights || {};
  const prio = tiers.priority || {};
  const out = [];
  const names = Object.keys(workflows).sort();
  for (const s of subjects) {
    if (s.retired_at != null || s.gone_at != null || s.alias_of != null) continue;
    const tierName = `T${s.tier}`;
    const cells = tiers.tiers?.[tierName];
    if (!cells) continue;
    const floorMs = minAgeHours(tiers, tierName) * HOUR;
    for (const name of names) {
      const wf = workflows[name];
      if (!isEnabled(wf)) continue;
      const cell = cells[name];
      if (!cell || cell.mode !== 'always') continue;
      const pk = pairKey(s.id, name);
      if (exclude.has(pk) || inFlight.has(pk)) continue;
      const last = lastResults.get(pk);
      if (!last) continue;
      const age = now - toMs(last.accepted_at);
      if (!(age >= floorMs)) continue;
      const skipsDays = skipsOnlyWaitDays(last, tiers, maxAgeDays(cell, s, tiers, tierName));
      if (skipsDays !== null && age <= skipsDays * DAY) continue;
      const fields = runKeyFields(s, name, wf);
      const key = runKey(fields);
      if (parked.has(key) || holdRunKeys?.has(key)) continue;
      const ageDays = age / DAY;
      const priority = Number(weights[tierName] || 0) + Math.min(Number(prio.age_max ?? 30), ageDays * Number(prio.age_per_day ?? 1)) - BACKFILL_BAND;
      out.push({ subject: s.id, name: s.name ?? s.id, repo_id: s.repo_id ?? null, workflow: name, tier: s.tier, run_key: key, fields, reasons: ['backfill'], priority, gap: null });
    }
  }
  out.sort((a, b) => b.priority - a.priority || a.tier - b.tier
    || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0)
    || (a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0));
  return out;
}

/**
 * The backfill items for one tick: as many candidates as the free room takes.
 *   freeSlots      worker slots free now (workerSlots minus live slot rows)
 *   openByWorkflow open dispatches per workflow (counted against slots_max)
 *   due            the tick's due list (after its filters)
 * A lane takes items to fill its last partial due shard first, then whole new
 * shards while a free slot is left that the due list does not need. Returns
 * the items, best first (never more than the room). Pure.
 */
export function backfillFor({ candidates, due, workflows, freeSlots, openByWorkflow = new Map() }) {
  const dueBy = new Map();
  for (const d of due) dueBy.set(d.workflow, (dueBy.get(d.workflow) ?? 0) + 1);
  const lane = new Map(); // workflow -> {size, cap (shards it may still open), shards (due shards), partial (item room in its last due shard)}
  let usedByDue = 0;
  for (const [name, wf] of Object.entries(workflows)) {
    const size = Math.max(1, Math.trunc(Number(wf.shard_size)) || 1);
    const max = Number.isFinite(Number(wf.slots_max)) ? Number(wf.slots_max) : Infinity;
    const cap = Math.max(0, max - (openByWorkflow.get(name) ?? 0));
    const n = dueBy.get(name) ?? 0;
    const shards = Math.min(cap, Math.ceil(n / size));
    usedByDue += shards;
    lane.set(name, { size, cap, shards, partial: shards > 0 && n < shards * size ? shards * size - n : 0 });
  }
  let spare = Math.max(0, Math.trunc(Number(freeSlots) || 0) - usedByDue);
  const out = [];
  for (const c of candidates) {
    const l = lane.get(c.workflow);
    if (!l) continue;
    if (l.partial > 0) {
      l.partial -= 1;
      out.push(c);
      continue;
    }
    if (spare > 0 && l.shards < l.cap) {
      spare -= 1;
      l.shards += 1;
      l.partial = l.size - 1;
      out.push(c);
    }
  }
  return out;
}
