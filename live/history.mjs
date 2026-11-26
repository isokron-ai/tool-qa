// The public daily history (isokron-loop-day/1): one file per complete UTC day.
//
// Pure, like live/build.mjs: reads the state database, never writes it, never
// touches the network or the clock (the caller passes `now`). Every value is
// a count, a fixed word, a validated time, a lane id from pump/workflows.json
// or a version label from it. Nothing names a server, a batch or an item; no
// reason code, id, fence, or count of held or security-class results.
//
// The same rules as the snapshot (live/README.md, "Why it is shaped this way"):
//   - Per lane, accepted results that day, how many were assessed, and the rest
//     by fault side (sideOf, as the snapshot's 24 h `fault`).
//   - not_used and classes follow ring_daily (dailyRing): not_used null below
//     5; classes null unless every class is 5 or more; a quarantine counts as
//     integrity. So a day file cannot tell a quarantine from a lease rejection
//     below the threshold (R-LIVE-30).
//   - No dispatched item counts (R-LIVE-28): items minus results would give
//     the day's non-use.
//
// Tables read: events, subjects (the seed count), through build.mjs's reader,
// which checks every statement against the never-read list.
//
// The uploader that writes these once a day is in live/publish.mjs
// (publishHistory).

import { CLASSES, dailyClassOf } from './classes.mjs';
import { ACCEPTED_SQL, dailyRing, FAULT_SIDES, lanePins, LANE_RE, laneStateOf, NOT_BUILT_LANES, reader, sideOf } from './build.mjs';
import { scanPublic } from './scan.mjs';

export const DAY_SCHEMA = 'isokron-loop-day/1';

const DAY = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'string') return Date.parse(now);
  return Number(now);
}

const count = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/** 'YYYY-MM-DD' of the UTC day holding ms. */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Start of a 'YYYY-MM-DD' UTC day in ms, or NaN when it is not one. */
export function dayStart(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return NaN;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && dayOf(ms) === day ? ms : NaN;
}

/** The occurred_at of the oldest event, in ms, or null (no events table or no rows). */
export function oldestEventMs(db) {
  const r = reader(db);
  if (r.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events'").n === 0) return null;
  const v = r.get('SELECT MIN(occurred_at) AS t FROM events')?.t;
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Build the day file of one complete UTC day.
 *
 * @param {object} db  a StateDb (state/db.mjs) or its node:sqlite connection
 * @param {{day: string, now: number|string|Date, config: object}} opts
 *   day: 'YYYY-MM-DD' (UTC), ended before `now`.
 *   config: pump/workflows.json ({workflows}), optionally `not_built_lanes`.
 * @returns {{day: object, problems: {rule: string, path: string}[]}}
 *   problems non-empty means: upload nothing.
 *
 * `pins` are the config's labels when the day is built within a day of its
 * end (the run right after midnight); for an older day (a backfill, or a pump
 * that was off) the labels in force then are not known, so pins is null.
 */
export function buildDay(db, { day, now, config } = {}) {
  const startMs = dayStart(day);
  if (!Number.isFinite(startMs)) throw new TypeError('buildDay needs day as YYYY-MM-DD');
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('buildDay needs a valid now');
  if (nowMs < startMs + DAY) throw new RangeError('buildDay: the day has not ended');
  const endMs = startMs + DAY;
  const from = new Date(startMs).toISOString();
  const to = new Date(endMs).toISOString();
  const r = reader(db);
  const workflows = config?.workflows && typeof config.workflows === 'object' ? config.workflows : {};
  const laneIds = Object.keys(workflows).filter((id) => LANE_RE.test(id));
  const notBuilt = new Set(Array.isArray(config?.not_built_lanes) ? config.not_built_lanes : NOT_BUILT_LANES);
  const freshPins = nowMs < endMs + DAY;
  const hasEvents = r.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events'").n > 0;

  const stats = new Map(laneIds.map((id) => [id, {
    results: 0, assessed: 0,
    sides: Object.fromEntries(FAULT_SIDES.map((s) => [s, 0])),
    daily: { not_used: 0, ...Object.fromEntries(CLASSES.map((k) => [k, 0])) },
  }]));
  let checked = 0;
  let assessedSubjects = 0;
  if (hasEvents) {
    const accepted = r.all(`
      SELECT lane, json_extract(data, '$.fault') AS fault, json_extract(data, '$.coverage') AS coverage, SUM(n) AS n
      FROM events WHERE type = 'result_recorded' AND occurred_at >= ? AND occurred_at < ? AND ${ACCEPTED_SQL}
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
    `, from, to);
    for (const row of accepted) {
      const st = stats.get(row.lane);
      if (!st) continue;
      const n = count(row.n);
      st.results += n;
      const side = sideOf(row.fault, row.coverage);
      if (side === 'assessed') st.assessed += n;
      else st.sides[side] += n;
    }
    // Results not used, by class; a quarantine counts as integrity (R-LIVE-25).
    const notUsed = r.all(`
      SELECT lane, json_extract(data, '$.reason') AS reason, json_extract(data, '$.outcome') AS outcome, SUM(n) AS n
      FROM events WHERE type = 'result_recorded' AND occurred_at >= ? AND occurred_at < ? AND json_valid(data)
        AND NOT (${ACCEPTED_SQL})
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
    `, from, to);
    for (const row of notUsed) {
      const st = stats.get(row.lane);
      if (!st) continue;
      st.daily[dailyClassOf(row)] += count(row.n);
      st.daily.not_used += count(row.n);
    }
    const distinct = (extra = '') => count(r.get(`
      SELECT COUNT(DISTINCT subject) AS n FROM events WHERE type = 'result_recorded' AND occurred_at >= ? AND occurred_at < ?
        AND subject IS NOT NULL AND ${ACCEPTED_SQL} ${extra}
    `, from, to)?.n);
    checked = distinct();
    assessedSubjects = distinct("AND json_extract(data, '$.coverage') = 'assessed'");
  }

  const lanes = laneIds.map((id) => {
    const wf = workflows[id] ?? {};
    const state = laneStateOf(id, wf, notBuilt);
    const pins = freshPins ? lanePins(wf) : null;
    if (state === 'not_built') return { id, state, pins, results: null, assessed: null, sides: null, not_used: null, classes: null };
    const st = stats.get(id);
    const ring = dailyRing(st.daily);
    return {
      id,
      state,
      pins,
      results: st.results,
      assessed: st.assessed,
      sides: st.sides,
      not_used: ring.not_used,
      classes: CLASSES.every((k) => ring[k] !== null) ? Object.fromEntries(CLASSES.map((k) => [k, ring[k]])) : null,
    };
  });

  const out = {
    schema: DAY_SCHEMA,
    day,
    generated_at: new Date(Math.floor(nowMs / 1000) * 1000).toISOString(),
    lanes,
    totals: {
      subjects_in_seed: count(r.get("SELECT COUNT(*) AS n FROM subjects WHERE source LIKE 'seed-v%' AND retired_at IS NULL AND alias_of IS NULL")?.n),
      servers_checked: checked,
      servers_assessed: assessedSubjects,
    },
    // Releases of our tools that day: none recorded yet (the ledger has no feed for them).
    tool_releases: [],
  };
  return { day: out, problems: scanPublic(out).hits };
}
