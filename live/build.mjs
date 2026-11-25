// The public live snapshot (isokron-loop-live/1) and the public events.
//
// Pure: reads the state database, never writes it, never touches the network
// or the clock (the caller passes `now`). This is the public-data boundary:
// everything that leaves the pump for live.isokron.ai is built here, field by
// field, from an allowlist. Nothing internal is copied through as is: every
// value is a count, a fixed word from a list in this file, a validated time,
// a lane id from pump/workflows.json, or a server's owner/name.
//
// What is public, what never is, and how to add a field: live/README.md.
// Design: PHASE-1-BUILD-PLAN.md section 3 (loop-viz, 25 Nov 2026).
//
// Tables read: events, results, dispatches, dispatch_items, slot_ledger,
// subjects, kv. Never attempts, leases, run_keys or any bundle, and never a
// digest column (live/test/build.test.mjs checks every statement).
//
// Decisions beyond the plan, each pinned by a test (REGRESSIONS.md R-LIVE-20..):
//   - Public seq numbers never expose internal event ids: a public event's seq
//     is its hour (UTC, by recorded_at) times 100000 plus its position among
//     that hour's public events, and the snapshot's seq is generated_at in
//     whole seconds. Internal ids have gaps where a result was not published
//     (rejected or quarantined), so publishing them would place it (R-LIVE-21).
//   - Rejections and quarantines pool (R-LIVE-25): no per-item public event
//     for either. Each batch ends with one batch_closed (or batch_expired)
//     event carrying `accepted` and `not_used` (every item without an accepted
//     result: rejected for any reason, quarantined or lost). The 24 h lane ring
//     is {accepted, not_used}; the class breakdown is ring_daily, for the
//     previous complete UTC day only, quarantines counted in integrity, each
//     class null below 5 (R-LIVE-20). Nothing public tells a quarantine from
//     any other rejection.
//   - now_checking lists the servers of every batch still out, including ones
//     whose result is already in: a server leaves only when its whole batch
//     closes, so no single server can be seen to drop out (R-LIVE-22).
//   - A server name that is not owner/name, or that the secret or vendor-name
//     scan would flag, is left out (the event or row stays, without it), so
//     one such repository cannot block every upload (R-LIVE-23).
//   - The retry call label comes from a fixed list; the pump's own labels are
//     "METHOD /path" and are mapped, never copied (R-LIVE-24).

import { CLASSES, dailyClassOf, isQuarantine, QUARANTINE_REASONS } from './classes.mjs';
import { scanPublic } from './scan.mjs';
import { hasVendorName } from './vendor-names.mjs';
import { scanText } from '../ingest/redact.mjs';

export const SCHEMA = 'isokron-loop-live/1';
export const TICK_S = 150;
export const MAX_SLOTS = 15;
export const RAMP = Object.freeze([2, 5, 8, 12, 15]);
export const RETRY_ATTEMPTS = 6;
/** The snapshot must stay under this many bytes (JSON, UTF-8). */
export const MAX_SNAPSHOT_BYTES = 20 * 1024;
export const MAX_NOW_CHECKING = 20;
export const MAX_RECENT = 20;
/** A daily class count below this is shown as null. */
export const DAILY_MIN = 5;
/** Lanes that exist in the config but have no worker yet: drawn as "not built". */
export const NOT_BUILT_LANES = Object.freeze(['scan-deep', 'build-probe']);
export const LANE_STATES = Object.freeze(['on', 'off', 'not_built', 'held']);
export const MODES = Object.freeze(['live', 'idle', 'paused', 'off', 'retrying']);
/** mode -> mode_reason, fixed words only. */
export const MODE_REASONS = Object.freeze({
  live: 'scanning live',
  idle: 'scanning paused by us',
  paused: 'loop paused by us',
  off: 'loop switched off by us',
  retrying: 'retrying a GitHub call',
});
export const SIDES = Object.freeze(['assessed', 'subject', 'tool', 'infra', 'policy', 'unknown']);
export const FAULT_SIDES = Object.freeze(['subject', 'tool', 'infra', 'policy', 'unknown']);
export const RING_KEYS = Object.freeze(['accepted', 'not_used']);
export const RING_DAILY_KEYS = CLASSES;
/** The fixed list a retry's call label comes from. */
export const RETRY_CALLS = Object.freeze(['github_api', 'state_asset', 'app_token']);
export const BATCH_LABELS = Object.freeze(['GitHub error', 'refused', 'withdrawn']);
/** Fixed lane notes; a lane shows one of these or none. */
export const LANE_NOTES = Object.freeze({
  not_built: 'not built yet',
  switching_on: 'built, switching on next',
  npm_pypi_only: 'most servers skipped: npm and PyPI only for now',
  re_sweep: 're-checking every server after a fix to our PyPI launcher',
});
export const HISTORY_KINDS = Object.freeze(['registry-delta', 'registry-full', 'packages', 'popularity']);
/** Public event types. */
export const PUBLIC_TYPES = Object.freeze([
  'batch_sent', 'batch_not_sent', 'batch_closed', 'batch_expired', 'result', 'pump_run',
  'history_triggered', 'sandbox_check', 'lane_paused', 'retry',
]);
/** Every key a public event may have, in output order. */
export const PUBLIC_EVENT_KEYS = Object.freeze([
  'seq', 'type', 'occurred_at', 'recorded_at', 'lane', 'n', 'accepted', 'not_used', 'subject', 'side', 'label', 'status', 'state', 'lanes',
]);

const QUARANTINE_SQL = QUARANTINE_REASONS.map((x) => `'${x}'`).join(', ');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LANE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TOOL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

// ---- small validators: everything public passes through one of these ----

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'string') return Date.parse(now);
  return Number(now);
}

/** A canonical ISO time, or null. Only UTC "Z" times are accepted. */
function isoOrNull(v) {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function count(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function intIn(v, lo, hi) {
  const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n >= lo && n <= hi ? n : null;
}

function parseData(data) {
  if (data && typeof data === 'object') return data;
  if (typeof data !== 'string') return {};
  try {
    const v = JSON.parse(data);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return null;
};

/** A server's owner/name if it may be shown, else null (R-LIVE-23). */
export function publicName(name) {
  if (typeof name !== 'string' || !REPO_NAME_RE.test(name)) return null;
  if (hasVendorName(name) || scanText(name).length > 0) return null;
  return name;
}

/** LOOP_SLOTS as the guard reads it (scripts/guard.mjs parseSlots): 0..15. */
function slotsOf(raw) {
  const t = String(raw ?? '').trim();
  if (!/^[+-]?\d+$/.test(t)) return 0;
  return Math.max(0, Math.min(MAX_SLOTS, Number(t)));
}

/** A per-lane switch: unset, empty or "true" leaves it on (as scripts/guard.mjs). */
function switchOn(v) {
  const t = String(v ?? '').trim();
  return t === '' || t === 'true';
}

/**
 * The fixed call label for a retry (R-LIVE-24): github_api, state_asset or
 * app_token (the labels pump/run.mjs passes). A label already on the list is
 * kept; a raw "METHOD /path" label is mapped by what it calls; anything else
 * is github_api. Paths are never copied.
 */
export function retryCallLabel(raw) {
  if (typeof raw !== 'string') return 'github_api';
  if (RETRY_CALLS.includes(raw)) return raw;
  const m = /^(GET|HEAD|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(raw.trim());
  if (!m) return 'github_api';
  const path = m[2];
  if (/\/releases(?:\/|$)/.test(path)) return 'state_asset';
  if (/^\/app\/installations\/[^/]+\/access_tokens$/.test(path)) return 'app_token';
  return 'github_api';
}

/** The public side of an accepted result: assessed, or its fault side. */
function sideOf(fault, coverage) {
  if (coverage === 'assessed') return 'assessed';
  if (FAULT_SIDES.includes(fault)) return fault;
  switch (coverage) {
    case 'unassessed_tool': return 'tool';
    case 'unassessed_infra': return 'infra';
    case 'subject': return 'subject';
    case 'excluded': return 'policy';
    default: return 'unknown';
  }
}

function verdictOf(d) {
  if (d.verdict === 'accepted' || d.accepted === true) return 'accepted';
  return 'rejected';
}

function batchLabel(type, d) {
  if (type === 'dispatch_failed' && d.withdrawn === true) return 'withdrawn';
  const status = intIn(pick(d, 'status', 'http_status', 'http'), 100, 599);
  if (status !== null && status >= 400 && status < 500 && status !== 429) return 'refused';
  return 'GitHub error';
}

/** Public seq of the ordinal-th public event of the hour holding recordedMs (R-LIVE-21). */
export function publicSeq(recordedMs, ordinal) {
  return Math.floor(recordedMs / HOUR) * 100_000 + ordinal;
}

/**
 * One internal event row ({id, type, occurred_at, recorded_at, lane, n,
 * subject, data}) as its public event, or null when nothing of it is public
 * (any result that was not accepted, an internal-only type, an unreadable row).
 *
 * @param {object} row
 * @param {{seq?: number|null, subjectName?: string|null, lanes?: Iterable<string>|null, accepted?: number|null}} [opts]
 *   seq: the public seq to give it (the builder numbers them; null otherwise);
 *   subjectName: the server's current owner/name, for an accepted result;
 *   lanes: the lane ids of the config (others are left out);
 *   accepted: for a closing batch (dispatch_closed, dispatch_expired), how
 *     many of its items had an accepted result; null when not known.
 */
export function toPublicEvent(row, { seq = null, subjectName = null, lanes = null, accepted = null } = {}) {
  if (!row || typeof row !== 'object') return null;
  const occurred = isoOrNull(row.occurred_at);
  const recorded = isoOrNull(row.recorded_at);
  if (occurred === null || recorded === null) return null;
  const known = lanes ? new Set(lanes) : null;
  const laneOk = (l) => typeof l === 'string' && LANE_RE.test(l) && (known === null || known.has(l));
  const lane = laneOk(row.lane) ? row.lane : null;
  const n = count(row.n ?? 1);
  const d = parseData(row.data);
  const ev = (type, extra = {}) => {
    const out = { seq: Number.isSafeInteger(seq) ? seq : null, type, occurred_at: occurred, recorded_at: recorded, lane, n: extra.n ?? n };
    for (const k of PUBLIC_EVENT_KEYS) if (extra[k] !== undefined && extra[k] !== null) out[k] = extra[k];
    return out;
  };
  switch (row.type) {
    case 'dispatch_sent':
      return ev('batch_sent');
    case 'dispatch_failed':
    case 'dispatch_unconfirmed':
      return ev('batch_not_sent', { label: batchLabel(row.type, d) });
    case 'dispatch_closed':
    case 'dispatch_expired': {
      // The batch's end: how many items had an accepted result, and how many
      // did not, whatever the reason (R-LIVE-25). Both keys are always there.
      const a = intIn(accepted, 0, n);
      const e = ev(row.type === 'dispatch_expired' ? 'batch_expired' : 'batch_closed');
      return { ...e, accepted: a, not_used: a === null ? null : n - a };
    }
    case 'result_recorded':
      // Only an accepted result is public; a rejection or a quarantine is only
      // a not_used count on its batch (R-LIVE-25).
      if (verdictOf(d) !== 'accepted' || isQuarantine({ reason: d.reason ?? null, outcome: d.outcome ?? null })) return null;
      return ev('result', { subject: publicName(subjectName), side: sideOf(d.fault, d.coverage) });
    case 'pump_run_started':
      return ev('pump_run', { label: 'started' });
    case 'pump_run_finished':
      return ev('pump_run', { label: 'finished' });
    case 'successor': {
      const ok = d.ok === true;
      return ev('pump_run', { label: 'successor', state: ok ? 'ok' : 'failed', status: ok ? null : intIn(pick(d, 'status', 'http_status'), 100, 599) });
    }
    case 'registry_delta': {
      const action = d.action;
      if (action !== 'dispatched' && action !== 'failed') return null;
      return ev('history_triggered', { state: action });
    }
    case 'breaker_changed': {
      const held = Array.isArray(pick(d, 'held', 'held_lanes')) ? pick(d, 'held', 'held_lanes') : [];
      const tripped = d.tripped === true;
      return ev('sandbox_check', { state: tripped ? 'held' : 'closed', lanes: tripped ? [...new Set(held.filter(laneOk))].sort() : [] });
    }
    case 'workflow_paused':
      return lane === null ? null : ev('lane_paused');
    case 'retry': {
      const gaveUp = pick(d, 'gave_up', 'gaveUp') === true;
      return ev('retry', {
        label: retryCallLabel(pick(d, 'label', 'call')),
        status: intIn(pick(d, 'status', 'http_status'), 100, 599),
        state: gaveUp ? 'gave_up' : 'retrying',
        n: intIn(pick(d, 'attempts', 'attempt'), 0, 1000) ?? n,
      });
    }
    default:
      return null;
  }
}

// ---- reading the state ----

const FORBIDDEN = /\b(?:attempts|leases|run_keys|digest|artifact_digest|fence|holder|holder_run|error|run_url|shard_id|repo_id|node_id)\b/i;

/** The raw connection, with every statement checked against the table allowlist. */
function reader(db) {
  const raw = db?.raw ?? db;
  if (!raw || typeof raw.prepare !== 'function') throw new TypeError('buildLiveSnapshot needs a StateDb or a node:sqlite database');
  return {
    all(sql, ...args) {
      if (FORBIDDEN.test(sql) || /select\s+\*/i.test(sql)) throw new Error('live snapshot: a statement reads outside the allowlist');
      return raw.prepare(sql).all(...args);
    },
    get(sql, ...args) {
      return this.all(sql, ...args)[0];
    },
  };
}

function kv(r, key) {
  const row = r.get('SELECT value, updated FROM kv WHERE key = ?', key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value), updated: row.updated };
  } catch {
    return { value: null, updated: row.updated };
  }
}

/**
 * For a dispatch_closed or dispatch_expired event, how many of its batch's
 * items had an accepted result before it closed; null for other rows or when
 * the batch cannot be found. Events carry no dispatch id, so the batch is the
 * dispatch of that lane closed at that exact time (the event is written in the
 * closing transaction, with the same clock); several closed together are
 * matched in id order to dispatches in attempt order, preferring the same item
 * count. Accepted results are counted from the events, so the number never
 * changes after the batch closed.
 */
function batchMatcher(r) {
  const groups = new Map();
  const acceptedOf = (d) => count(r.get(`
    SELECT COUNT(DISTINCT e.subject) AS n FROM events e
    WHERE e.type = 'result_recorded' AND e.lane = ? AND e.recorded_at >= ? AND e.recorded_at <= ? AND json_valid(e.data)
      AND (json_extract(e.data, '$.verdict') = 'accepted' OR json_extract(e.data, '$.accepted') = 1)
      AND COALESCE(json_extract(e.data, '$.outcome'), '') <> 'quarantined' AND COALESCE(json_extract(e.data, '$.reason'), '') NOT IN (${QUARANTINE_SQL})
      AND e.subject IN (SELECT i.subject FROM dispatch_items i WHERE i.attempt_id = ?)
  `, d.workflow, d.created, d.closed, d.attempt_id)?.n);
  return (row) => {
    if (row.type !== 'dispatch_closed' && row.type !== 'dispatch_expired') return null;
    const key = `${row.lane}\u0000${row.recorded_at}`;
    if (!groups.has(key)) {
      const evs = r.all(`
        SELECT id, n FROM events WHERE type IN ('dispatch_closed', 'dispatch_expired') AND lane IS ? AND recorded_at = ? ORDER BY id
      `, row.lane, row.recorded_at);
      const ds = r.all(`
        SELECT d.attempt_id AS attempt_id, d.workflow AS workflow, d.created AS created, d.closed AS closed,
          (SELECT COUNT(*) FROM dispatch_items i WHERE i.attempt_id = d.attempt_id) AS items
        FROM dispatches d WHERE d.workflow IS ? AND d.closed = ? AND d.status IN ('done', 'expired') ORDER BY d.attempt_id
      `, row.lane, row.recorded_at);
      const used = new Set();
      const map = new Map();
      for (const ev of evs) {
        const d = ds.find((x) => !used.has(x.attempt_id) && x.items === ev.n) ?? ds.find((x) => !used.has(x.attempt_id));
        if (!d) continue;
        used.add(d.attempt_id);
        map.set(ev.id, Math.min(acceptedOf(d), count(ev.n)));
      }
      groups.set(key, map);
    }
    return groups.get(key).get(row.id) ?? null;
  };
}

function hasEvents(r) {
  return r.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events'").n > 0;
}

/** Public events whose recorded_at falls in [fromMs, fromMs + 1 h), numbered. */
function hourEventsAt(r, fromMs, ctx) {
  const lo = new Date(fromMs).toISOString();
  const hi = new Date(fromMs + HOUR).toISOString();
  const rows = r.all(`
    SELECT id, type, occurred_at, recorded_at, lane, n, subject, data FROM events
    WHERE recorded_at >= ? AND recorded_at < ? AND recorded_at <= ? ORDER BY id
  `, lo, hi, ctx.nowIso);
  const out = [];
  for (const row of rows) {
    const e = toPublicEvent(row, { subjectName: ctx.name(row.subject), lanes: ctx.lanes, accepted: ctx.batchAccepted(row) });
    if (e === null) continue;
    // Bucketed by the row's own recorded_at, which isoOrNull has normalised.
    e.seq = publicSeq(fromMs, out.length + 1);
    out.push({ id: row.id, event: e });
  }
  return out;
}

/**
 * Build the public snapshot.
 *
 * @param {object} db  a StateDb (state/db.mjs) or its node:sqlite connection
 * @param {{now: number|string|Date, config: object, retry?: object|null, version?: string|null}} opts
 *   config: pump/workflows.json ({workflows}) plus `switches` (the values the
 *     run read: LOOP_ENABLED, LOOP_PAUSE_UNTIL, LOOP_SLOTS,
 *     RESULTS_PUBLISH_ENABLED, LANE_HISTORY_*_ENABLED) and optional `history`
 *     ([{kind, last_capture_at, versions, registry_size}]).
 *   retry: the pump's open retry, {call, status, attempt, of, next_at, since}
 *     (call may be the pump's own "METHOD /path" label), or null.
 *   version: a short label of the code that built it (a commit), or null.
 * @returns {{snapshot: object, hourEvents: object[], problems: {rule: string, path: string}[]}}
 *   problems non-empty means: upload nothing.
 */
export function buildLiveSnapshot(db, { now, config, retry = null, version = null } = {}) {
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('buildLiveSnapshot needs a valid now');
  const r = reader(db);
  const nowIso = new Date(nowMs).toISOString();
  const workflows = config?.workflows && typeof config.workflows === 'object' ? config.workflows : {};
  const switches = config?.switches && typeof config.switches === 'object' ? config.switches : {};
  const laneIds = Object.keys(workflows).filter((id) => LANE_RE.test(id));
  const laneSet = new Set(laneIds);
  const events = hasEvents(r);

  // Server names, current: subjects.name by subject key.
  const nameCache = new Map();
  const name = (key) => {
    if (typeof key !== 'string') return null;
    if (!nameCache.has(key)) nameCache.set(key, r.get('SELECT name FROM subjects WHERE id = ?', key)?.name ?? null);
    return nameCache.get(key);
  };
  const ctx = { name, lanes: laneIds, nowIso, batchAccepted: events ? batchMatcher(r) : () => null };

  const since1h = new Date(nowMs - HOUR).toISOString();
  const since24h = new Date(nowMs - DAY).toISOString();
  const since7d = new Date(nowMs - 7 * DAY).toISOString();
  const hourStartMs = Math.floor(nowMs / HOUR) * HOUR;
  const dayStartMs = Math.floor(nowMs / DAY) * DAY;

  // ---- per lane: accepted results, batch ends, daily rejection classes ----
  const laneStats = new Map(laneIds.map((id) => [id, {
    w1h: 0, w24h: 0, spark: new Array(24).fill(0), t0: 0,
    fault: Object.fromEntries(FAULT_SIDES.map((s) => [s, 0])),
    ring: Object.fromEntries(RING_KEYS.map((k) => [k, 0])),
    daily: Object.fromEntries(RING_DAILY_KEYS.map((k) => [k, 0])),
    sent: { w1h: 0, w24h: 0, w7d: 0 }, back: { w1h: 0, w24h: 0, w7d: 0 },
  }]));
  const historyTriggered = { w1h: 0, w24h: 0, w7d: 0 };
  if (events) {
    // Accepted results only: a rejection and a quarantine look the same here (nothing).
    const rows = r.all(`
      SELECT e.lane AS lane, substr(e.occurred_at, 1, 13) AS hr, e.occurred_at > ? AS in1h,
        json_extract(e.data, '$.fault') AS fault, json_extract(e.data, '$.coverage') AS coverage,
        COALESCE((SELECT s.tier FROM subjects s WHERE s.id = e.subject), 4) = 0 AS t0,
        SUM(e.n) AS n
      FROM events e
      WHERE e.type = 'result_recorded' AND e.occurred_at > ? AND e.occurred_at <= ? AND json_valid(e.data)
        AND (json_extract(e.data, '$.verdict') = 'accepted' OR json_extract(e.data, '$.accepted') = 1)
        AND COALESCE(json_extract(e.data, '$.outcome'), '') <> 'quarantined' AND COALESCE(json_extract(e.data, '$.reason'), '') NOT IN (${QUARANTINE_SQL})
      GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3, 4, 5, 6
    `, since1h, since24h, nowIso);
    const hourIndex = new Map();
    for (let i = 0; i < 24; i++) hourIndex.set(new Date(hourStartMs - (23 - i) * HOUR).toISOString().slice(0, 13), i);
    for (const row of rows) {
      const st = laneStats.get(row.lane);
      if (!st) continue;
      const n = count(row.n);
      st.w24h += n;
      if (row.in1h) st.w1h += n;
      if (hourIndex.has(row.hr)) st.spark[hourIndex.get(row.hr)] += n;
      if (row.t0) st.t0 += n;
      st.ring.accepted += n;
      const side = sideOf(row.fault, row.coverage);
      if (side !== 'assessed') st.fault[side] += n;
    }
    // Batch ends: every item of a closed or expired batch goes back to ingest;
    // those without an accepted result are not_used (R-LIVE-25).
    const ends = r.all(`
      SELECT id, type, lane, n, recorded_at, occurred_at > ? AS in1h, occurred_at > ? AS in24h FROM events
      WHERE type IN ('dispatch_closed', 'dispatch_expired') AND occurred_at > ? AND occurred_at <= ? ORDER BY id
    `, since1h, since24h, since7d, nowIso);
    for (const row of ends) {
      const st = laneStats.get(row.lane);
      if (!st) continue;
      const n = count(row.n);
      st.back.w7d += n;
      if (row.in24h) st.back.w24h += n;
      if (row.in1h) st.back.w1h += n;
      if (!row.in24h) continue;
      const accepted = ctx.batchAccepted(row);
      st.ring.not_used += accepted === null ? 0 : Math.max(0, n - Math.min(accepted, n));
    }
    // Rejection classes for the previous complete UTC day; a quarantine counts
    // as integrity, so no class tells it apart (R-LIVE-20, R-LIVE-25).
    const q = r.all(`
      SELECT lane, json_extract(data, '$.reason') AS reason, json_extract(data, '$.outcome') AS outcome, SUM(n) AS n
      FROM events WHERE type = 'result_recorded' AND occurred_at >= ? AND occurred_at < ? AND json_valid(data)
        AND NOT (json_extract(data, '$.verdict') IS 'accepted' OR json_extract(data, '$.accepted') IS 1)
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
    `, new Date(dayStartMs - DAY).toISOString(), new Date(dayStartMs).toISOString());
    for (const row of q) {
      const st = laneStats.get(row.lane);
      if (st) st.daily[dailyClassOf(row)] += count(row.n);
    }

    // Batches sent per lane, and registry deltas triggered.
    const sent = r.all(`
      SELECT type, lane, occurred_at > ? AS in1h, occurred_at > ? AS in24h,
        CASE WHEN type = 'registry_delta' AND json_valid(data) THEN json_extract(data, '$.action') END AS action,
        SUM(n) AS n, COUNT(*) AS c
      FROM events WHERE type IN ('dispatch_sent', 'registry_delta') AND occurred_at > ? AND occurred_at <= ?
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5
    `, since1h, since24h, since7d, nowIso);
    for (const row of sent) {
      const target = row.type === 'dispatch_sent' ? laneStats.get(row.lane)?.sent : (row.action === 'dispatched' ? historyTriggered : null);
      if (!target) continue;
      const n = row.type === 'dispatch_sent' ? count(row.n) : count(row.c);
      target.w7d += n;
      if (row.in24h) target.w24h += n;
      if (row.in1h) target.w1h += n;
    }
  }

  // ---- switches, mode ----
  const loopOn = String(switches.LOOP_ENABLED ?? '').trim() === 'true';
  const pauseUntil = Date.parse(String(switches.LOOP_PAUSE_UNTIL ?? '').trim());
  const pausedNow = String(switches.LOOP_PAUSE_UNTIL ?? '').trim() !== '' && !(Number.isFinite(pauseUntil) && pauseUntil <= nowMs);
  const budget = slotsOf(switches.LOOP_SLOTS);
  const retryBlock = publicRetry(retry);
  let mode = 'live';
  if (!loopOn) mode = 'off';
  else if (pausedNow) mode = 'paused';
  else if (retryBlock !== null) mode = 'retrying';
  else if (budget === 0) mode = 'idle';

  // ---- pump ----
  let runStartedAt = null;
  let runs24h = 0;
  let successor = null;
  if (events) {
    const started = r.get("SELECT occurred_at FROM events WHERE type = 'pump_run_started' AND occurred_at <= ? ORDER BY occurred_at DESC, id DESC LIMIT 1", nowIso);
    runStartedAt = isoOrNull(started?.occurred_at);
    runs24h = count(r.get("SELECT COUNT(*) AS n FROM events WHERE type = 'pump_run_started' AND occurred_at > ? AND occurred_at <= ?", since24h, nowIso).n);
    const s = r.get("SELECT occurred_at, json_extract(data, '$.ok') AS ok FROM events WHERE type = 'successor' AND occurred_at <= ? AND json_valid(data) ORDER BY occurred_at DESC, id DESC LIMIT 1", nowIso);
    if (s && isoOrNull(s.occurred_at)) successor = { state: s.ok === 1 ? 'ok' : 'failed', at: isoOrNull(s.occurred_at) };
  }
  if (successor === null) {
    const s = kv(r, 'pump.successor');
    const at = isoOrNull(s?.value?.at) ?? isoOrNull(s?.updated);
    if (s && at) successor = { state: s.value?.ok === true ? 'ok' : 'failed', at };
  }
  const lastTick = kv(r, 'pump.last_tick');
  const lastDelta = events ? isoOrNull(r.get(`
    SELECT occurred_at FROM events WHERE type = 'registry_delta' AND occurred_at <= ? AND json_valid(data)
      AND json_extract(data, '$.action') = 'dispatched' ORDER BY occurred_at DESC, id DESC LIMIT 1
  `, nowIso)?.occurred_at) : null;
  const open = count(r.get('SELECT COUNT(*) AS n FROM slot_ledger WHERE released IS NULL AND expires > ?', nowIso).n);

  // ---- breaker ----
  const br = kv(r, 'pump.breaker');
  let breaker = null;
  const heldLanes = new Set();
  if (br && br.value && typeof br.value === 'object') {
    const tripped = br.value.tripped === true;
    if (tripped) {
      // The lanes the pump holds: enabled lanes that run third-party code (pump/breaker.mjs allowedWorkflows).
      for (const id of laneIds) {
        const wf = workflows[id];
        if (wf?.enabled === true && wf?.runs_untrusted !== false && !NOT_BUILT_LANES.includes(id)) heldLanes.add(id);
      }
    }
    breaker = { state: tripped ? 'held' : 'closed', checked_at: isoOrNull(br.value.checked_at), lanes: [...heldLanes] };
  }

  // ---- lanes ----
  const lanes = laneIds.map((id) => {
    const wf = workflows[id] ?? {};
    const notBuilt = NOT_BUILT_LANES.includes(id);
    let state = 'on';
    if (notBuilt) state = 'not_built';
    else if (wf.enabled !== true) state = 'off';
    else if (heldLanes.has(id)) state = 'held';
    const [tool, pin] = Object.entries(wf.versions?.tool ?? {})[0] ?? [null, null];
    const lane = {
      id,
      state,
      tool: typeof tool === 'string' && TOOL_RE.test(tool) && !hasVendorName(tool) ? tool : null,
      pin: typeof pin === 'string' && PIN_RE.test(pin) && !hasVendorName(pin) ? pin : null,
      note: laneNote(id, state, config?.lane_notes),
    };
    if (notBuilt) return { ...lane, w1h: null, w24h: null, spark24: null, fault: null, ring: null, ring_daily: null, t0_w24h: null };
    const st = laneStats.get(id);
    const ringDaily = Object.fromEntries(RING_DAILY_KEYS.map((k) => [k, st.daily[k] >= DAILY_MIN ? st.daily[k] : null]));
    return { ...lane, w1h: st.w1h, w24h: st.w24h, spark24: st.spark, fault: st.fault, ring: st.ring, ring_daily: ringDaily, t0_w24h: st.t0 };
  });

  // ---- history ----
  const history = publicHistory(config?.history, switches, kv(r, 'pump.registry_delta'));

  // ---- edges ----
  const edges = [];
  for (const id of laneIds) {
    if (NOT_BUILT_LANES.includes(id)) continue;
    const st = laneStats.get(id);
    edges.push({ from: 'pump', to: id, ...st.sent });
    edges.push({ from: id, to: 'ingest', ...st.back });
  }
  edges.push({ from: 'pump', to: 'history', ...historyTriggered });

  // ---- counts ----
  const one = (sql, ...a) => count(r.get(sql, ...a)?.n);
  const counts = {
    subjects_in_seed: one("SELECT COUNT(*) AS n FROM subjects WHERE source LIKE 'seed-v%' AND retired_at IS NULL AND alias_of IS NULL"),
    checked: {
      w24h: events ? one("SELECT COUNT(DISTINCT subject) AS n FROM events WHERE type = 'result_recorded' AND occurred_at > ? AND occurred_at <= ? AND json_valid(data) AND (json_extract(data, '$.verdict') = 'accepted' OR json_extract(data, '$.accepted') = 1) AND subject IS NOT NULL", since24h, nowIso) : 0,
      w7d: events ? one("SELECT COUNT(DISTINCT subject) AS n FROM events WHERE type = 'result_recorded' AND occurred_at > ? AND occurred_at <= ? AND json_valid(data) AND (json_extract(data, '$.verdict') = 'accepted' OR json_extract(data, '$.accepted') = 1) AND subject IS NOT NULL", since7d, nowIso) : 0,
      all: one('SELECT COUNT(DISTINCT subject) AS n FROM results'),
    },
    assessed: {
      w24h: events ? one("SELECT COUNT(DISTINCT subject) AS n FROM events WHERE type = 'result_recorded' AND occurred_at > ? AND occurred_at <= ? AND json_valid(data) AND (json_extract(data, '$.verdict') = 'accepted' OR json_extract(data, '$.accepted') = 1) AND json_extract(data, '$.coverage') = 'assessed' AND subject IS NOT NULL", since24h, nowIso) : 0,
      all: one('SELECT COUNT(DISTINCT subject) AS n FROM results WHERE assessed_at IS NOT NULL'),
    },
  };

  // ---- now checking: every server of a batch still out (R-LIVE-22) ----
  const items = r.all(`
    SELECT i.subject AS subject, i.subject_name AS subject_name, i.workflow AS lane, d.created AS since
    FROM dispatch_items i JOIN dispatches d USING (attempt_id)
    WHERE d.status = 'dispatched' AND d.expires > ? AND d.created <= ?
    ORDER BY d.created DESC, i.subject_name, i.subject
  `, nowIso, nowIso);
  const nowChecking = [];
  for (const it of items) {
    if (nowChecking.length >= MAX_NOW_CHECKING) break;
    if (!laneSet.has(it.lane)) continue;
    const since = isoOrNull(it.since);
    if (since === null) continue;
    nowChecking.push({ subject: publicName(it.subject_name ?? name(it.subject)), lane: it.lane, since });
  }

  // ---- recent and this hour's public events ----
  const hourEvents = events ? hourEventsAt(r, hourStartMs, ctx).map((x) => x.event) : [];
  const recent = events ? recentEvents(r, ctx, nowMs) : [];

  const snapshot = {
    schema: SCHEMA,
    seq: Math.floor(nowMs / 1000),
    generated_at: nowIso,
    version: typeof version === 'string' && VERSION_RE.test(version) ? version : null,
    mode,
    mode_reason: MODE_REASONS[mode],
    pump: {
      run_started_at: runStartedAt,
      tick_at: isoOrNull(lastTick?.updated),
      tick_s: TICK_S,
      runs_24h: runs24h,
      successor,
      slots: { budget, open, max: MAX_SLOTS, ramp: [...RAMP] },
      registry_delta: { at: lastDelta, w24h: historyTriggered.w24h },
    },
    retry: retryBlock,
    breaker,
    lanes,
    history,
    edges,
    publish: { state: String(switches.RESULTS_PUBLISH_ENABLED ?? '').trim() === 'true' ? 'on' : 'off' },
    counts,
    now_checking: nowChecking,
    recent,
  };

  // ---- the scans, and the size ----
  const problems = [];
  for (const h of scanPublic(snapshot).hits) problems.push(h);
  for (const h of scanPublic(hourEvents).hits) problems.push({ rule: h.rule, path: h.path.replace(/^\$/, '$hour') });
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (bytes >= MAX_SNAPSHOT_BYTES) problems.push({ rule: 'size', path: '$' });
  return { snapshot, hourEvents, problems };
}

/** Up to MAX_RECENT newest public events, newest first, numbered within their hours. */
function recentEvents(r, ctx, nowMs) {
  const found = [];
  const floor = new Date(nowMs - 8 * DAY).toISOString();
  let before = Number.MAX_SAFE_INTEGER;
  // Newest rows first, in pages, until enough are public (quarantines and internal types are skipped).
  for (let page = 0; page < 50 && found.length < MAX_RECENT; page++) {
    const rows = r.all(`
      SELECT id, type, occurred_at, recorded_at, lane, n, subject, data FROM events
      WHERE id < ? AND recorded_at >= ? AND recorded_at <= ? ORDER BY id DESC LIMIT 500
    `, before, floor, new Date(nowMs).toISOString());
    if (rows.length === 0) break;
    for (const row of rows) {
      if (found.length >= MAX_RECENT) break;
      if (toPublicEvent(row, { subjectName: ctx.name(row.subject), lanes: ctx.lanes }) !== null) found.push(row);
    }
    before = rows[rows.length - 1].id;
  }
  // Number each one within its hour, the same way the hour files are numbered.
  const hours = new Map();
  const out = [];
  for (const row of found) {
    const h = Math.floor(Date.parse(isoOrNull(row.recorded_at)) / HOUR) * HOUR;
    if (!hours.has(h)) hours.set(h, new Map(hourEventsAt(r, h, ctx).map((x) => [x.id, x.event])));
    const e = hours.get(h).get(row.id);
    if (e) out.push(e);
  }
  return out;
}

/**
 * A lane's note, a fixed wording (LANE_NOTES) or null. config.lane_notes may
 * pick one per lane by key ({lane: key}, or null for none); a key not on the
 * list is ignored. Otherwise: not built, off ("switching on next"), and
 * writecheck's registry limit.
 */
function laneNote(id, state, chosen) {
  if (chosen && typeof chosen === 'object' && Object.hasOwn(chosen, id)) {
    const k = chosen[id];
    if (k === null) return null;
    if (typeof k === 'string' && Object.hasOwn(LANE_NOTES, k)) return LANE_NOTES[k];
  }
  if (state === 'not_built') return LANE_NOTES.not_built;
  if (state === 'off') return LANE_NOTES.switching_on;
  if (id === 'writecheck') return LANE_NOTES.npm_pypi_only;
  return null;
}

/** The open retry as its public block, or null. */
function publicRetry(retry) {
  if (!retry || typeof retry !== 'object') return null;
  if (retry.gave_up === true || retry.gaveUp === true) return null;
  const of = intIn(retry.of, 1, 20) ?? RETRY_ATTEMPTS;
  const attempt = intIn(retry.attempt, 1, of);
  if (attempt === null) return null;
  const toIso = (v) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : isoOrNull(v));
  return {
    call: retryCallLabel(pick(retry, 'call', 'label')),
    status: intIn(retry.status, 100, 599),
    attempt,
    of,
    next_at: toIso(retry.next_at ?? retry.nextAt ?? null),
    since: toIso(retry.since ?? null),
  };
}

/** The history capture kinds, each from the caller's list, validated. */
function publicHistory(list, switches, delta) {
  const given = new Map();
  if (Array.isArray(list)) for (const h of list) if (h && HISTORY_KINDS.includes(h.kind) && !given.has(h.kind)) given.set(h.kind, h);
  const sw = {
    'registry-delta': switches.LANE_HISTORY_REGISTRY_ENABLED,
    'registry-full': switches.LANE_HISTORY_REGISTRY_ENABLED,
    packages: switches.LANE_HISTORY_PACKAGES_ENABLED,
    popularity: switches.LANE_HISTORY_POPULARITY_ENABLED,
  };
  return HISTORY_KINDS.map((kind) => {
    const h = given.get(kind) ?? {};
    let last = isoOrNull(h.last_capture_at);
    if (last === null && kind === 'registry-delta') last = isoOrNull(delta?.value?.captureAt);
    const out = { kind, state: switchOn(sw[kind]) ? 'on' : 'off', last_capture_at: last };
    if (kind === 'registry-delta') out.versions = intIn(h.versions, 0, 10_000_000);
    if (kind === 'registry-full') {
      out.registry_size = intIn(h.registry_size, 0, 100_000_000);
      out.full_at = last;
    }
    return out;
  });
}
