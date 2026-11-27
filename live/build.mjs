// The public live snapshot (isokron-loop-live/1) and the public hour files.
//
// Pure: reads the state database, never writes it, never touches the network
// or the clock (the caller passes `now`). This is the public-data boundary:
// everything that leaves the pump for live.isokron.ai is built here, field by
// field, from an allowlist. Nothing internal is copied through as is: every
// value is a count, a fixed word from a list in this file, a validated time,
// a lane id from pump/workflows.json, or a server's owner/name.
//
// What is public, what never is, and how to add a field: live/README.md.
// Design: PHASE-1-BUILD-PLAN.md section 3 as amended by the review of #75
// ("design B"), 26 Nov 2026.
//
// Tables read: events, results, dispatches, slot_ledger, subjects, kv. Never
// attempts, leases, run_keys or any bundle, and never a digest, fence, holder
// or error column (live/test/build.test.mjs checks every statement).
//
// The rules that keep a single server's non-use, and any class of rejection
// (a quarantine above all), from being derived (REGRESSIONS.md R-LIVE-20..):
//   - No server name is live. Which servers are in a batch is never public:
//     now_checking is per lane counts only (R-LIVE-22). A server is named
//     only for an accepted result, and only in the hour file of the hour
//     after the one it was recorded in, sorted by name, its times cut to the
//     hour (R-LIVE-26), and only when it is assessed or the server's own
//     condition (side subject); tool, infra, policy and unknown results are
//     lane counts only (R-LIVE-27). Dispatched work is public only as batch
//     counts, never item counts, so items minus accepted results is never
//     public (R-LIVE-28); accepted counts per lane are live.
//   - No rejection or quarantine is an event of its own. Rejection classes are
//     per lane and previous complete UTC day only (ring_daily): not_used in
//     total, null below 5, and the four classes, all null if any is below 5,
//     a quarantine counted in integrity (R-LIVE-20, R-LIVE-25).
//   - Public seq numbers are not event ids, whose gaps would place an
//     unpublished event (R-LIVE-21).
//   - A server name that is not a plain owner/name of at most 60 characters,
//     or that the secret or vendor-name scan would flag, is left out (R-LIVE-23).
//   - Retry call labels come from a fixed list (R-LIVE-24).

import { CLASSES, dailyClassOf, isQuarantine, QUARANTINE_REASONS } from './classes.mjs';
import { scanPublic } from './scan.mjs';
import { hasVendorName } from './vendor-names.mjs';
import { scanText } from '../ingest/redact.mjs';
import { computeCoverage, compactCoverage } from '../state/coverage.mjs';

export const SCHEMA = 'isokron-loop-live/1';
export const TICK_S = 150;
export const MAX_SLOTS = 15;
export const RAMP = Object.freeze([2, 5, 8, 12, 15]);
export const RETRY_ATTEMPTS = 6;
/** The snapshot must stay under this many bytes (JSON, UTF-8). */
export const MAX_SNAPSHOT_BYTES = 20 * 1024;
/** An hour file over this many bytes is replaced by its counts. */
export const MAX_HOUR_FILE_BYTES = 256 * 1024;
/** For this long after an hour starts, the previous hour file is rebuilt too. */
export const PREVIOUS_HOUR_MS = 2 * TICK_S * 1000;
export const MAX_RECENT = 20;
export const MAX_JUST_CHECKED = 20;
export const MAX_NAME_LENGTH = 60;
/** A daily count below this is shown as null. */
export const DAILY_MIN = 5;
/** Lanes drawn as "not built" unless config.not_built_lanes says otherwise. */
export const NOT_BUILT_LANES = Object.freeze(['scan-deep', 'build-probe']);
export const LANE_STATES = Object.freeze(['on', 'off', 'not_built', 'waiting_sandbox_check']);
export const BREAKER_STATES = Object.freeze(['closed', 'waiting_sandbox_check']);
export const MODES = Object.freeze(['live', 'idle', 'paused', 'off', 'retrying', 'waiting']);
/** mode_reason, fixed words only. */
export const MODE_REASONS = Object.freeze({
  live: 'scanning live',
  idle_slots: 'scanning paused by us',
  idle_lanes: 'every scanning lane is off',
  paused: 'loop paused by us',
  off: 'loop switched off by us',
  waiting: 'waiting for the sandbox self-test',
  retrying_github_api: 'retrying: a GitHub call',
  retrying_state_asset: 'retrying: saving the loop state',
  retrying_app_token: 'retrying: getting an access token',
});
/** Fixed lane notes; config.lane_notes picks one per lane by key. */
export const LANE_NOTES = Object.freeze({
  off: 'off',
  not_built: 'not built yet',
  switching_on: 'built, switching on next',
  npm_pypi_only: 'most servers skipped: npm and PyPI only for now',
  re_sweep: 're-checking every server after a fix to our PyPI launcher',
});
export const SIDES = Object.freeze(['assessed', 'subject', 'tool', 'infra', 'policy', 'unknown']);
/** The only sides a published result (with its server's name) may have. */
export const NAMED_SIDES = Object.freeze(['assessed', 'subject']);
export const FAULT_SIDES = Object.freeze(['subject', 'tool', 'infra', 'policy', 'unknown']);
export const RING_KEYS = Object.freeze(['accepted']);
export const RING_DAILY_KEYS = Object.freeze(['not_used', ...CLASSES]);
/** The fixed list a retry's call label comes from. */
export const RETRY_CALLS = Object.freeze(['github_api', 'state_asset', 'app_token']);
export const BATCH_LABELS = Object.freeze(['GitHub error', 'refused', 'withdrawn']);
export const HISTORY_KINDS = Object.freeze(['registry-delta', 'registry-full', 'packages', 'popularity']);
/** Public event types. */
export const PUBLIC_TYPES = Object.freeze([
  'batch_sent', 'batch_not_sent', 'batch_closed', 'batch_expired', 'result', 'pump_run',
  'history_triggered', 'sandbox_check', 'retry', 'hour_counts',
]);
/** Every key a public event may have, in output order. */
export const PUBLIC_EVENT_KEYS = Object.freeze([
  'seq', 'type', 'occurred_at', 'recorded_at', 'lane', 'n', 'subject', 'side', 'label', 'status', 'state', 'lanes', 'counts',
]);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const LANE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const NAME_PART_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const TOOL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const QUARANTINE_SQL = QUARANTINE_REASONS.map((x) => `'${x}'`).join(', ');
// IS, not =: a missing field is false here, never NULL (NOT NULL would drop the row from both sides).
export const ACCEPTED_SQL = `json_valid(data) AND (json_extract(data, '$.verdict') IS 'accepted' OR json_extract(data, '$.accepted') IS 1)
  AND COALESCE(json_extract(data, '$.outcome'), '') <> 'quarantined' AND COALESCE(json_extract(data, '$.reason'), '') NOT IN (${QUARANTINE_SQL})`;

// ---- small validators: everything public passes through one of these ----

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'string') return Date.parse(now);
  return Number(now);
}

const isoMs = (ms) => new Date(ms).toISOString();
const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR;

/** A canonical UTC time in whole seconds (".000Z"), or null. */
function isoOrNull(v) {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? isoMs(Math.floor(ms / 1000) * 1000) : null;
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

/**
 * A server's owner/name if it may be shown, else null (R-LIVE-23): ASCII
 * owner/name, at most 60 characters, no segment that starts with a dot, and
 * nothing the secret or vendor-name scan would flag.
 */
export function publicName(name) {
  if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) return null;
  const parts = name.split('/');
  if (parts.length !== 2 || !parts.every((p) => p.length > 0 && NAME_PART_RE.test(p))) return null;
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

const COVERAGE_SIDE = { assessed: 'assessed', unassessed_tool: 'tool', unassessed_infra: 'infra', unassessed_unknown: 'unknown', subject: 'subject', excluded: 'policy' };

/**
 * The public side of an accepted result. Coverage wins; a fault side that
 * disagrees with an unassessed coverage makes it unknown (our side, never the
 * server's). With no coverage, the fault side, else unknown.
 */
export function sideOf(fault, coverage) {
  const cov = Object.hasOwn(COVERAGE_SIDE, coverage) ? COVERAGE_SIDE[coverage] : null;
  const f = FAULT_SIDES.includes(fault) ? fault : null;
  if (cov === 'assessed') return 'assessed';
  if (cov !== null) return f !== null && f !== cov ? 'unknown' : cov;
  return f ?? 'unknown';
}

function acceptedRow(d) {
  return (d.verdict === 'accepted' || d.accepted === true) && !isQuarantine({ reason: d.reason ?? null, outcome: d.outcome ?? null });
}

function batchLabel(type, d) {
  if (type === 'dispatch_failed' && d.withdrawn === true) return 'withdrawn';
  const status = intIn(pick(d, 'status', 'http_status', 'http'), 100, 599);
  if (status !== null && status >= 400 && status < 500 && status !== 429) return 'refused';
  return 'GitHub error';
}

/** Public seq of the ordinal-th event of the hour file of the hour holding ms (R-LIVE-21). */
export function publicSeq(ms, ordinal) {
  return Math.floor(ms / HOUR) * 100_000 + ordinal;
}

/**
 * One internal event row ({id, type, occurred_at, recorded_at, lane, n,
 * subject, data}) as its public event, or null when nothing of it is public
 * (any result not accepted, an internal-only type, an unreadable row).
 * An accepted result's times are cut to the hour it was recorded in; the
 * builder publishes it only in the next hour's file (R-LIVE-26).
 *
 * @param {object} row
 * @param {{seq?: number|null, subjectName?: string|null, lanes?: Iterable<string>|null}} [opts]
 */
export function toPublicEvent(row, { seq = null, subjectName = null, lanes = null } = {}) {
  if (!row || typeof row !== 'object') return null;
  let occurred = isoOrNull(row.occurred_at);
  let recorded = isoOrNull(row.recorded_at);
  if (occurred === null || recorded === null) return null;
  const known = lanes ? new Set(lanes) : null;
  const laneOk = (l) => typeof l === 'string' && LANE_RE.test(l) && (known === null || known.has(l));
  const lane = laneOk(row.lane) ? row.lane : null;
  const n = count(row.n ?? 1);
  const d = parseData(row.data);
  const ev = (type, extra = {}) => {
    const out = { seq: Number.isSafeInteger(seq) ? seq : null, type, occurred_at: occurred, recorded_at: recorded, lane, n: extra.n ?? n };
    for (const k of PUBLIC_EVENT_KEYS) if (extra[k] !== undefined && extra[k] !== null && !(k in out)) out[k] = extra[k];
    return out;
  };
  switch (row.type) {
    // Batches are counted as batches (n = 1), never by their items (R-LIVE-28).
    case 'dispatch_sent':
      return ev('batch_sent', { n: 1 });
    case 'dispatch_failed':
    case 'dispatch_unconfirmed':
      return ev('batch_not_sent', { n: 1, label: batchLabel(row.type, d) });
    case 'dispatch_closed':
      return ev('batch_closed', { n: 1 });
    case 'dispatch_expired':
      return ev('batch_expired', { n: 1 });
    case 'result_recorded': {
      // Only an accepted result that is assessed or the server's own
      // condition names its server; any other side is a lane count only (R-LIVE-27).
      if (!acceptedRow(d)) return null;
      const side = sideOf(d.fault, d.coverage);
      if (!NAMED_SIDES.includes(side)) return null;
      recorded = isoMs(hourOf(Date.parse(recorded)));
      occurred = recorded;
      return ev('result', { n: 1, subject: publicName(subjectName), side });
    }
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
      const held = Array.isArray(d.held) ? d.held : [];
      const tripped = d.tripped === true;
      return ev('sandbox_check', { state: tripped ? 'waiting_sandbox_check' : 'closed', lanes: tripped ? [...new Set(held.filter(laneOk))].sort() : [] });
    }
    case 'retry': {
      const gaveUp = pick(d, 'gave_up', 'gaveUp') === true;
      return ev('retry', {
        label: retryCallLabel(pick(d, 'label', 'call')),
        status: intIn(pick(d, 'status', 'http_status'), 100, 599),
        state: gaveUp ? 'gave_up' : 'retrying',
        n: intIn(pick(d, 'attempts', 'attempt'), 0, 1000) ?? n,
      });
    }
    // workflow_paused comes from integrity incidents (run_sha_mismatch) and version-pin refusals (R-PIN-01): never public.
    default:
      return null;
  }
}

// ---- reading the state ----

const FORBIDDEN = /\b(?:attempts|leases|run_keys|dispatch_items|subject_name|digest|artifact_digest|fence|holder|holder_run|error|run_url|shard_id|repo_id|node_id)\b/i;

/** The raw connection, with every statement checked against the table allowlist. */
export function reader(db) {
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

function hasEvents(r) {
  return r.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events'").n > 0;
}

/**
 * The hour file of hour H: first the accepted results recorded in hour H-1,
 * sorted by server name (then lane and side), with their times cut to H-1;
 * then every other public event recorded in H (up to now), in the order it
 * was written. Each numbered by publicSeq(H, ordinal). Returns
 * {events, named} where named is the results block.
 */
function hourFile(r, ctx, hMs) {
  if (ctx.hours.has(hMs)) return ctx.hours.get(hMs);
  const named = r.all(`
    SELECT id, type, occurred_at, recorded_at, lane, n, subject, data FROM events
    WHERE type = 'result_recorded' AND recorded_at >= ? AND recorded_at < ? AND ${ACCEPTED_SQL} ORDER BY id
  `, isoMs(hMs - HOUR), isoMs(hMs))
    .map((row) => toPublicEvent(row, { subjectName: ctx.name(row.subject), lanes: ctx.lanes }))
    .filter((e) => e !== null)
    .sort((a, b) => cmp(a.subject ?? '￿', b.subject ?? '￿') || cmp(a.lane ?? '', b.lane ?? '') || cmp(a.side, b.side));
  const rest = r.all(`
    SELECT id, type, occurred_at, recorded_at, lane, n, subject, data FROM events
    WHERE type <> 'result_recorded' AND recorded_at >= ? AND recorded_at < ? AND recorded_at <= ? ORDER BY id
  `, isoMs(hMs), isoMs(hMs + HOUR), ctx.nowIso)
    .map((row) => toPublicEvent(row, { lanes: ctx.lanes }))
    .filter((e) => e !== null);
  let events = [...named, ...rest].map((e, i) => ({ ...e, seq: publicSeq(hMs, i + 1) }));
  if (Buffer.byteLength(JSON.stringify(events), 'utf8') > ctx.maxHourBytes) {
    // Too big to publish as a list: its counts only.
    const counts = {};
    for (const t of PUBLIC_TYPES) {
      const k = events.filter((e) => e.type === t).length;
      if (k > 0) counts[t] = k;
    }
    events = [{ seq: publicSeq(hMs, 1), type: 'hour_counts', occurred_at: isoMs(hMs), recorded_at: isoMs(hMs), lane: null, n: events.length, counts }];
  }
  const out = { events, named, rest };
  ctx.hours.set(hMs, out);
  return out;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the public snapshot and hour files.
 *
 * @param {object} db  a StateDb (state/db.mjs) or its node:sqlite connection
 * @param {{now: number|string|Date, config: object, retry?: object|null, version?: string|null}} opts
 *   config: pump/workflows.json ({workflows}) plus `switches` (the values the
 *     run read: LOOP_ENABLED, LOOP_PAUSE_UNTIL, LOOP_SLOTS,
 *     RESULTS_PUBLISH_ENABLED, LANE_HISTORY_*_ENABLED), and optional
 *     `history` ([{kind, last_capture_at, versions, registry_size}]),
 *     `lane_notes` ({lane: key of LANE_NOTES | null}) and `not_built_lanes`.
 *   retry: the pump's open retry, {call, status, attempt, of, next_at, since}, or null.
 *   version: a short label of the code that built it (a commit), or null.
 * @returns {{snapshot: object, hourEvents: object[], previousHourEvents: object[]|null,
 *   problems: {rule: string, path: string}[]}}
 *   hourEvents is the file of the current UTC hour; previousHourEvents the
 *   file of the hour before, while the current hour is under 300 s old (the
 *   caller writes it again then, so events of the last minutes land), else
 *   null. problems non-empty means: upload nothing.
 */
export function buildLiveSnapshot(db, { now, config, retry = null, version = null, maxHourBytes = MAX_HOUR_FILE_BYTES } = {}) {
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('buildLiveSnapshot needs a valid now');
  const r = reader(db);
  const nowIso = isoMs(nowMs);
  const workflows = config?.workflows && typeof config.workflows === 'object' ? config.workflows : {};
  const switches = config?.switches && typeof config.switches === 'object' ? config.switches : {};
  const laneIds = Object.keys(workflows).filter((id) => LANE_RE.test(id));
  const notBuiltSet = new Set(Array.isArray(config?.not_built_lanes) ? config.not_built_lanes : NOT_BUILT_LANES);
  const events = hasEvents(r);

  const nameCache = new Map();
  const name = (key) => {
    if (typeof key !== 'string') return null;
    if (!nameCache.has(key)) nameCache.set(key, r.get('SELECT name FROM subjects WHERE id = ?', key)?.name ?? null);
    return nameCache.get(key);
  };
  const ctx = { name, lanes: laneIds, nowIso, hours: new Map(), maxHourBytes };

  const since1h = isoMs(nowMs - HOUR);
  const since24h = isoMs(nowMs - DAY);
  const since7d = isoMs(nowMs - 7 * DAY);
  const hourStartMs = hourOf(nowMs);
  const dayStartMs = Math.floor(nowMs / DAY) * DAY;

  // ---- per lane ----
  const laneStats = new Map(laneIds.map((id) => [id, {
    w1h: 0, w24h: 0, spark: new Array(24).fill(0), t0: 0,
    fault: Object.fromEntries(FAULT_SIDES.map((s) => [s, 0])),
    daily: Object.fromEntries(RING_DAILY_KEYS.map((k) => [k, 0])),
    sent: { w1h: 0, w24h: 0, w7d: 0 }, back: { w1h: 0, w24h: 0, w7d: 0 },
  }]));
  const historyTriggered = { w1h: 0, w24h: 0, w7d: 0 };
  let lastDelta = null;
  if (events) {
    // Accepted results (a rejection and a quarantine count nowhere live).
    const rows = r.all(`
      SELECT e.lane AS lane, substr(e.occurred_at, 1, 13) AS hr, e.occurred_at > ? AS in1h, e.occurred_at > ? AS in24h,
        json_extract(e.data, '$.fault') AS fault, json_extract(e.data, '$.coverage') AS coverage,
        COALESCE((SELECT s.tier FROM subjects s WHERE s.id = e.subject), 4) = 0 AS t0,
        SUM(e.n) AS n
      FROM events e
      WHERE e.type = 'result_recorded' AND e.occurred_at > ? AND e.occurred_at <= ? AND ${ACCEPTED_SQL.replaceAll('data', 'e.data')}
      GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4, 5, 6, 7
    `, since1h, since24h, since7d, nowIso);
    const hourIndex = new Map();
    for (let i = 0; i < 24; i++) hourIndex.set(isoMs(hourStartMs - (23 - i) * HOUR).slice(0, 13), i);
    for (const row of rows) {
      const st = laneStats.get(row.lane);
      if (!st) continue;
      const n = count(row.n);
      // lane -> ingest: accepted results, never dispatched items (R-LIVE-28).
      st.back.w7d += n;
      if (!row.in24h) continue;
      st.back.w24h += n;
      if (row.in1h) st.back.w1h += n;
      st.w24h += n;
      if (row.in1h) st.w1h += n;
      if (hourIndex.has(row.hr)) st.spark[hourIndex.get(row.hr)] += n;
      if (row.t0) st.t0 += n;
      const side = sideOf(row.fault, row.coverage);
      if (side !== 'assessed') st.fault[side] += n;
    }
    // Batches sent (counted as batches, never items: R-LIVE-28), registry deltas.
    const flows = r.all(`
      SELECT type, lane, occurred_at > ? AS in1h, occurred_at > ? AS in24h,
        CASE WHEN type = 'registry_delta' AND json_valid(data) THEN json_extract(data, '$.action') END AS action,
        COUNT(*) AS c
      FROM events WHERE type IN ('dispatch_sent', 'registry_delta') AND occurred_at > ? AND occurred_at <= ?
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5
    `, since1h, since24h, since7d, nowIso);
    for (const row of flows) {
      let target = null;
      if (row.type === 'dispatch_sent') target = laneStats.get(row.lane)?.sent;
      else if (row.type === 'registry_delta') target = row.action === 'dispatched' ? historyTriggered : null;
      if (!target) continue;
      const n = count(row.c);
      target.w7d += n;
      if (row.in24h) target.w24h += n;
      if (row.in1h) target.w1h += n;
    }
    // Results not used, by class, for the previous complete UTC day; a
    // quarantine counts as integrity (R-LIVE-20, R-LIVE-25).
    const q = r.all(`
      SELECT lane, json_extract(data, '$.reason') AS reason, json_extract(data, '$.outcome') AS outcome, SUM(n) AS n
      FROM events WHERE type = 'result_recorded' AND occurred_at >= ? AND occurred_at < ? AND json_valid(data)
        AND NOT (${ACCEPTED_SQL})
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
    `, isoMs(dayStartMs - DAY), isoMs(dayStartMs));
    for (const row of q) {
      const st = laneStats.get(row.lane);
      if (!st) continue;
      st.daily[dailyClassOf(row)] += count(row.n);
      st.daily.not_used += count(row.n);
    }
    lastDelta = isoOrNull(r.get(`
      SELECT occurred_at FROM events WHERE type = 'registry_delta' AND occurred_at <= ? AND json_valid(data)
        AND json_extract(data, '$.action') = 'dispatched' ORDER BY occurred_at DESC, id DESC LIMIT 1
    `, nowIso)?.occurred_at);
  }

  // ---- breaker ----
  const br = kv(r, 'pump.breaker');
  let breaker = null;
  const waiting = new Set();
  if (br && br.value && typeof br.value === 'object') {
    const tripped = br.value.tripped === true;
    if (tripped) {
      // The lanes the pump holds back: enabled lanes that run third-party code (pump/breaker.mjs allowedWorkflows).
      for (const id of laneIds) {
        const wf = workflows[id];
        if (wf?.enabled === true && wf?.runs_untrusted !== false && !notBuiltSet.has(id)) waiting.add(id);
      }
    }
    breaker = { state: tripped ? 'waiting_sandbox_check' : 'closed', checked_at: isoOrNull(br.value.checked_at), lanes: [...waiting] };
  }

  // ---- lanes ----
  const lanes = laneIds.map((id) => {
    const wf = workflows[id] ?? {};
    const notBuilt = notBuiltSet.has(id);
    const state = laneStateOf(id, wf, notBuiltSet, waiting);
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
    return { ...lane, w1h: st.w1h, w24h: st.w24h, spark24: st.spark, fault: st.fault, ring: { accepted: st.w24h }, ring_daily: dailyRing(st.daily), t0_w24h: st.t0 };
  });

  // ---- switches, mode ----
  // The pump only runs when scripts/guard.mjs let it, so a LOOP_ENABLED the run was not
  // given means the loop is on (R-LIVE-29); only a value given and not "true" means off.
  const loopOn = switches.LOOP_ENABLED === undefined || String(switches.LOOP_ENABLED).trim() === 'true';
  const pauseText = String(switches.LOOP_PAUSE_UNTIL ?? '').trim();
  const pauseUntil = Date.parse(pauseText);
  const pausedNow = pauseText !== '' && !(Number.isFinite(pauseUntil) && pauseUntil <= nowMs);
  const budget = slotsOf(switches.LOOP_SLOTS);
  const retryBlock = publicRetry(retry);
  const enabled = lanes.filter((l) => l.state === 'on' || l.state === 'waiting_sandbox_check');
  let mode = 'live';
  let reason = 'live';
  if (!loopOn) [mode, reason] = ['off', 'off'];
  else if (pausedNow) [mode, reason] = ['paused', 'paused'];
  else if (retryBlock !== null) [mode, reason] = ['retrying', `retrying_${retryBlock.call}`];
  else if (budget === 0) [mode, reason] = ['idle', 'idle_slots'];
  else if (enabled.length === 0) [mode, reason] = ['idle', 'idle_lanes'];
  else if (enabled.every((l) => l.state === 'waiting_sandbox_check')) [mode, reason] = ['waiting', 'waiting'];

  // ---- pump ----
  let runStartedAt = null;
  let runs24h = 0;
  let successor = null;
  if (events) {
    runStartedAt = isoOrNull(r.get("SELECT occurred_at FROM events WHERE type = 'pump_run_started' AND occurred_at <= ? ORDER BY occurred_at DESC, id DESC LIMIT 1", nowIso)?.occurred_at);
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
  const open = count(r.get('SELECT COUNT(*) AS n FROM slot_ledger WHERE released IS NULL AND expires > ?', nowIso).n);

  // ---- history, edges, counts ----
  const history = publicHistory(config?.history, switches, kv(r, 'pump.registry_delta'));
  const edges = [];
  for (const id of laneIds) {
    if (notBuiltSet.has(id)) continue;
    const st = laneStats.get(id);
    edges.push({ from: 'pump', to: id, ...st.sent });
    edges.push({ from: id, to: 'ingest', ...st.back });
  }
  edges.push({ from: 'pump', to: 'history', ...historyTriggered });
  const one = (sql, ...a) => count(r.get(sql, ...a)?.n);
  const acceptedSubjects = (since, extra = '') => (events ? one(`SELECT COUNT(DISTINCT subject) AS n FROM events WHERE type = 'result_recorded' AND occurred_at > ? AND occurred_at <= ? AND subject IS NOT NULL AND ${ACCEPTED_SQL} ${extra}`, since, nowIso) : 0);
  const counts = {
    subjects_in_seed: one("SELECT COUNT(*) AS n FROM subjects WHERE source LIKE 'seed-v%' AND retired_at IS NULL AND alias_of IS NULL"),
    checked: { w24h: acceptedSubjects(since24h), w7d: acceptedSubjects(since7d), all: one('SELECT COUNT(DISTINCT subject) AS n FROM results') },
    assessed: {
      w24h: acceptedSubjects(since24h, "AND json_extract(data, '$.coverage') = 'assessed'"),
      all: one('SELECT COUNT(DISTINCT subject) AS n FROM results WHERE assessed_at IS NOT NULL'),
    },
  };

  // ---- now checking: counts per lane, no names (R-LIVE-22) ----
  const out = r.all(`
    SELECT workflow AS lane, COUNT(*) AS batches, MIN(created) AS since FROM dispatches
    WHERE status = 'dispatched' AND expires > ? AND created <= ? GROUP BY workflow ORDER BY workflow
  `, nowIso, nowIso);
  const nowChecking = [];
  for (const id of laneIds) {
    const o = out.find((x) => x.lane === id);
    if (!o) continue;
    nowChecking.push({ lane: id, batches_out: count(o.batches), since_oldest: isoOrNull(o.since) });
  }

  // ---- hour files, recent, just checked ----
  const current = events ? hourFile(r, ctx, hourStartMs) : { events: [], named: [] };
  const previousHourEvents = events && nowMs - hourStartMs < PREVIOUS_HOUR_MS ? hourFile(r, ctx, hourStartMs - HOUR).events : null;
  let recent = events ? recentEvents(r, ctx, hourStartMs, nowMs) : [];
  let justChecked = current.named.slice(0, MAX_JUST_CHECKED).map((e) => ({ subject: e.subject ?? null, lane: e.lane, side: e.side }));

  // Tool coverage (state/coverage.mjs, docs/METHODOLOGY.md): a new last key; every earlier key keeps its place.
  // null when the config has no tiers or the state cannot answer: the snapshot is never held back by it.
  let coverage = null;
  try {
    if (config?.tiers && typeof config.tiers === 'object') coverage = compactCoverage(computeCoverage(db, { tiers: config.tiers, workflows, skipLanes: [...notBuiltSet] }));
  } catch {
    coverage = null;
  }

  const snapshotOf = () => ({
    schema: SCHEMA,
    seq: Math.floor(nowMs / 1000),
    generated_at: nowIso,
    version: typeof version === 'string' && VERSION_RE.test(version) ? version : null,
    mode,
    mode_reason: MODE_REASONS[reason],
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
    just_checked: { hour: isoMs(hourStartMs - HOUR), results: justChecked },
    recent,
    coverage,
  });
  let snapshot = snapshotOf();
  const size = () => Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  // Over the size: shorten recent, then just_checked, before giving up.
  while (size() >= MAX_SNAPSHOT_BYTES && (recent.length > 0 || justChecked.length > 0)) {
    if (recent.length > 0) recent = recent.slice(0, Math.floor(recent.length / 2));
    else justChecked = justChecked.slice(0, Math.floor(justChecked.length / 2));
    snapshot = snapshotOf();
  }

  const problems = [];
  for (const h of scanPublic(snapshot).hits) problems.push(h);
  for (const h of scanPublic(current.events).hits) problems.push({ rule: h.rule, path: h.path.replace(/^\$/, '$hour') });
  if (previousHourEvents) for (const h of scanPublic(previousHourEvents).hits) problems.push({ rule: h.rule, path: h.path.replace(/^\$/, '$previous_hour') });
  if (size() >= MAX_SNAPSHOT_BYTES) problems.push({ rule: 'size', path: '$' });
  return { snapshot, hourEvents: current.events, previousHourEvents, problems };
}

/**
 * Up to MAX_RECENT newest public events that name no server, newest first,
 * with the seqs of their hour files.
 */
function recentEvents(r, ctx, hourStartMs, nowMs) {
  const out = [];
  for (let h = hourStartMs; h > nowMs - 8 * DAY && out.length < MAX_RECENT; h -= HOUR) {
    const f = hourFile(r, ctx, h);
    const list = f.events.length === 1 && f.events[0].type === 'hour_counts' ? [] : f.events.filter((e) => e.type !== 'result');
    for (let i = list.length - 1; i >= 0 && out.length < MAX_RECENT; i--) out.push(list[i]);
  }
  return out;
}

/** The daily ring: not_used null below 5; the classes all null if any is below 5. */
export function dailyRing(daily) {
  const classes = CLASSES.map((k) => daily[k]);
  const show = classes.every((n) => n >= DAILY_MIN);
  return {
    not_used: daily.not_used >= DAILY_MIN ? daily.not_used : null,
    ...Object.fromEntries(CLASSES.map((k) => [k, show ? daily[k] : null])),
  };
}

/** A lane's state from its config: not_built, off, waiting_sandbox_check (when in `waiting`) or on. */
export function laneStateOf(id, wf, notBuiltSet, waiting = new Set()) {
  if (notBuiltSet.has(id)) return 'not_built';
  if (wf?.enabled !== true) return 'off';
  if (waiting.has(id)) return 'waiting_sandbox_check';
  return 'on';
}

/**
 * A lane's tool and probe version labels ("<name> <version>"), in config
 * order, tools first. A name or version that is not a plain label, or that
 * names a vendor, is left out.
 */
export function lanePins(wf) {
  const out = [];
  for (const group of ['tool', 'probe']) {
    const entries = wf?.versions?.[group];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [name, ver] of Object.entries(entries)) {
      if (!TOOL_RE.test(name) || typeof ver !== 'string' || !PIN_RE.test(ver) || hasVendorName(name) || hasVendorName(ver)) continue;
      out.push(`${name} ${ver}`);
    }
  }
  return out;
}

/** A lane's note: a key config.lane_notes picks, else "not built yet" or "off", else null. */
function laneNote(id, state, chosen) {
  if (chosen && typeof chosen === 'object' && Object.hasOwn(chosen, id)) {
    const k = chosen[id];
    if (k === null) return null;
    if (typeof k === 'string' && Object.hasOwn(LANE_NOTES, k)) return LANE_NOTES[k];
  }
  if (state === 'not_built') return LANE_NOTES.not_built;
  if (state === 'off') return LANE_NOTES.off;
  return null;
}

/** The open retry as its public block, or null. */
function publicRetry(retry) {
  if (!retry || typeof retry !== 'object') return null;
  if (retry.gave_up === true || retry.gaveUp === true) return null;
  const of = intIn(retry.of, 1, 20) ?? RETRY_ATTEMPTS;
  const attempt = intIn(retry.attempt, 1, of);
  if (attempt === null) return null;
  const toIso = (v) => (typeof v === 'number' && Number.isFinite(v) ? isoOrNull(isoMs(v)) : isoOrNull(v));
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
