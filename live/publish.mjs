// publishLive(): build the public live snapshot and put it in R2.
//
//   build -> scan problems? -> PUT v1/snap/<16 hex of sha256(body)>.json
//                              PUT v1/events/<YYYY-MM-DD>/<HH>.ndjson
//                              (once, after the UTC hour changed: the hour of
//                               the last good upload again, now final/immutable)
//                              PUT v1/latest.json            (LAST)
//
// The snapshot key is its content hash, so "immutable" is true: the same key
// never holds two bodies. A body equal to the one the last good upload sent
// (and sent less than 24 h ago; the bucket expires snapshots after 3 days) is
// not sent again, but the pointer is still rewritten (its generated_at shows
// liveness). The pointer goes only after both bodies are stored.
//
// Any scan hit (problems from live/build.mjs) uploads nothing: the log names
// the rule and the path, never the text, and kv `live.last_upload` records the
// block; `blocked_at` is carried until a good upload, so the watchdog stays red.
//
// It never throws, never runs while the state is inside a transaction, and is
// bounded by `deadlineMs` (the upload is aborted and the call returns when it
// passes, with no pointer written). It makes no network call, and does not
// even build, unless LANE_LIVE_SNAPSHOT_ENABLED is exactly `true` and the three
// credentials exist (with the switch on and a credential missing it records
// {ok:false, error:'credentials'} and still makes no call).
//
// After a good upload, once per UTC day, publishHistory() writes the daily
// history (v1/history/days/<day>.json, then recent.json, then index.json; see
// live/history.mjs), in what is left of the same deadline. It never changes
// the snapshot's result and never throws.
//
// publishRetry() is the other, tiny upload: v1/retry.json, from memory only
// (it never reads the state), for the moments a GitHub retry is open.
//
// The builder is `build` (or live/build.mjs, loaded here so that a failed
// import is recorded as error 'build'): build(db, { now, config, retry,
// version }) -> { snapshot, hourEvents, problems }. `now` is epoch
// milliseconds, and hourEvents covers the UTC hour of `now`. `put` is injected
// too (live/r2.mjs by default).

import { createHash } from 'node:crypto';

import { cacheControlFor, createR2Putter } from './r2.mjs';

export const LAST_UPLOAD_KEY = 'live.last_upload';
export const SWITCH = 'LANE_LIVE_SNAPSHOT_ENABLED';
export const LATEST_SCHEMA = 'isokron-loop-latest/1';
export const RETRY_SCHEMA = 'isokron-loop-retry/1';
export const RETRY_KEY = 'v1/retry.json';
export const DEFAULT_DEADLINE_MS = 20_000;
export const DEFAULT_BUCKET = 'isokron-loop-live';
/** A snapshot key last sent longer ago than this is sent again (the bucket expires snapshots after 3 days). */
export const SNAP_RESEND_MS = 24 * 3_600_000;
export const RETRY_CALLS = Object.freeze(['github_api', 'state_asset', 'app_token']);
// The daily history (live/history.mjs; publishHistory below).
export const HISTORY_LAST_DAY_KEY = 'live.history.last_day';
export const HISTORY_DAYS_KEY = 'live.history.days';
export const HISTORY_RECENT_KEY = 'live.history.recent';
export const HISTORY_BLOCKED_KEY = 'live.history.blocked';
export const HISTORY_RECENT_FILE = 'v1/history/recent.json';
export const HISTORY_INDEX_FILE = 'v1/history/index.json';
export const HISTORY_RECENT_SCHEMA = 'isokron-loop-history-recent/1';
export const HISTORY_INDEX_SCHEMA = 'isokron-loop-history-index/1';
export const HISTORY_RECENT_DAYS = 120;
export const HISTORY_BACKFILL_DAYS = 7;
export const HISTORY_EVENTS_KEPT_MS = 8 * 86_400_000;

/** The switch is exactly `true`. */
export const switchOn = (env = process.env) => env?.[SWITCH] === 'true';

/** The switch is on and all three credentials exist. */
export function liveEnabled(env = process.env) {
  return switchOn(env) && Boolean(env.LIVE_R2_ACCESS_KEY_ID) && Boolean(env.LIVE_R2_SECRET_ACCESS_KEY) && Boolean(env.R2_ACCOUNT_ID);
}

/** `v1/events/<YYYY-MM-DD>/<HH>.ndjson` for the UTC hour of `ms`. */
export function hourKey(ms) {
  const iso = new Date(ms).toISOString();
  return `v1/events/${iso.slice(0, 10)}/${iso.slice(11, 13)}.ndjson`;
}

/** Start of the UTC hour a `hourKey` names, in ms (NaN if it is not one). */
export function hourKeyStart(key) {
  const m = /^v1\/events\/(\d{4}-\d{2}-\d{2})\/(\d{2})\.ndjson$/.exec(String(key));
  return m ? Date.parse(`${m[1]}T${m[2]}:00:00Z`) : NaN;
}

const safeToken = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.:/[\]$-]/g, '?').slice(0, 120);

/** A scan hit as a log line: the rule and the path, never the value. */
export function describeProblems(problems, { max = 10 } = {}) {
  const lines = problems.slice(0, max).map((p) => `rule ${safeToken(p?.rule)} at ${safeToken(p?.path)}`);
  if (problems.length > max) lines.push(`and ${problems.length - max} more`);
  return lines;
}

function ndjson(events, publishedAt) {
  if (typeof events === 'string') return events;
  return (events ?? []).map((e) => JSON.stringify({ ...e, published_at: e.published_at ?? publishedAt })).join('\n') + (events?.length ? '\n' : '');
}

function makePutter({ put, env, fetch, now, until, putOptions }) {
  return put ?? createR2Putter({
    accountId: env.R2_ACCOUNT_ID, bucket: env.LIVE_R2_BUCKET || DEFAULT_BUCKET,
    accessKeyId: env.LIVE_R2_ACCESS_KEY_ID, secretAccessKey: env.LIVE_R2_SECRET_ACCESS_KEY,
    fetch, now, until, ...putOptions,
  });
}

/**
 * A deadline: an abort controller, a timer, and a promise that settles when it
 * passes. The timer is deliberately not unref'd: it is what keeps the event
 * loop alive while an upload hangs, and it is always cleared when the call ends.
 */
function deadlineOf(ms) {
  const ctl = new AbortController();
  let timer;
  const passed = new Promise((resolve) => {
    timer = setTimeout(() => { ctl.abort(); resolve('deadline'); }, Math.max(1, ms));
  });
  return { ctl, passed, clear: () => clearTimeout(timer) };
}

/**
 * @returns {Promise<{ ok: boolean, skipped?: string, blocked?: 'scan', error?: string, seq?: number, bytes?: number }>}
 */
export async function publishLive({
  db, build, buildModule = './build.mjs', put, env = process.env, fetch = globalThis.fetch, now = Date.now,
  config, retry = null, version, deadlineMs = DEFAULT_DEADLINE_MS, log = () => {}, putOptions = {},
  history = true, buildDay, oldestEventMs, historyModule = './history.mjs',
} = {}) {
  if (!switchOn(env)) return { ok: false, skipped: 'off' };
  if (!(deadlineMs > 0)) return { ok: false, skipped: 'no_time' };
  // Never alongside a state transaction (the build reads the state).
  if (db?.inTx) return { ok: false, skipped: 'in_tx' };
  const started = now();
  const iso = () => new Date(now()).toISOString();
  let finished = false;
  let recorded = false;
  const record = (value) => {
    if (finished || recorded) return;
    recorded = true;
    try {
      const prior = db.getKv(LAST_UPLOAD_KEY) ?? {};
      const at = iso();
      const ok = value.ok === true;
      const { snapPutAt, ...shown } = value;
      db.setKv(LAST_UPLOAD_KEY, {
        // carried: what the last good upload left, until the next good one
        last_ok_at: ok ? at : prior.last_ok_at ?? (prior.ok ? prior.at : null),
        last_ok_hour: ok ? hourKey(started) : prior.last_ok_hour ?? null,
        last_snap: ok ? value.snap : prior.last_snap ?? null,
        last_snap_put_at: ok ? snapPutAt : prior.last_snap_put_at ?? null,
        blocked_at: ok ? null : value.blocked ? prior.blocked_at ?? at : prior.blocked_at ?? null,
        first_at: prior.first_at ?? at,
        ...shown,
        at,
      }, { now: now() });
    } catch (err) {
      log(`live: could not record the upload result: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };
  const fail = (error, extra = {}) => {
    if (!finished && !recorded) log(`live: upload failed (${error})`);
    record({ ok: false, error, ...extra });
    return { ok: false, error };
  };

  if (!liveEnabled(env)) return fail('credentials');

  const dl = deadlineOf(deadlineMs);
  const { ctl } = dl;
  const builder = async () => build ?? (await import(buildModule)).buildLiveSnapshot;

  // Set once the snapshot is stored: a deadline during the history step after it is not the snapshot's failure.
  let snapshotDone = null;
  const work = (async () => {
    let built;
    try {
      const fn = await builder();
      if (typeof fn !== 'function') throw new TypeError('no builder');
      built = await fn(db, { now: started, config, retry, version });
    } catch (err) {
      return fail('build', { detail: String(err?.code ?? err?.name ?? 'Error').slice(0, 40) });
    }
    const { snapshot, hourEvents, problems, previousHourEvents } = built ?? {};
    if (Array.isArray(problems) && problems.length) {
      for (const line of describeProblems(problems)) log(`live: upload blocked by the scan: ${line}`);
      record({ ok: false, blocked: 'scan' });
      return { ok: false, blocked: 'scan' };
    }
    if (!snapshot || !Number.isSafeInteger(snapshot.seq)) return fail('build', { detail: 'no snapshot' });

    const publishedAt = new Date(started).toISOString();
    const snap = { ...snapshot, ...(Array.isArray(snapshot.recent) ? { recent: snapshot.recent.map((e) => ({ ...e, published_at: e.published_at ?? publishedAt })) } : {}) };
    const snapBody = JSON.stringify(snap);
    const snapKey = `v1/snap/${createHash('sha256').update(snapBody).digest('hex').slice(0, 16)}.json`;
    const pointer = JSON.stringify({ schema: LATEST_SCHEMA, seq: snap.seq, generated_at: snap.generated_at ?? publishedAt, snap: snapKey });
    const putter = makePutter({ put, env, fetch, now, until: () => started + deadlineMs, putOptions });
    // Order is the contract: both bodies, then the pointer.
    let prior = null;
    try { prior = db.getKv(LAST_UPLOAD_KEY); } catch { /* none */ }
    const steps = [];
    const putAt = Date.parse(prior?.last_snap_put_at ?? '');
    const snapFresh = prior?.last_snap === snapKey && Number.isFinite(putAt) && started - putAt < SNAP_RESEND_MS;
    const snapPutAt = snapFresh ? prior.last_snap_put_at : publishedAt;
    if (!snapFresh) steps.push([snapKey, snapBody]);
    steps.push([hourKey(started), ndjson(hourEvents, publishedAt)]);
    const closing = prior?.last_ok_hour;
    if (previousHourEvents !== undefined) {
      // The builder says what the previous hour held (non-null only in the first
      // minutes of an hour): write it to that hour's key, now past, so immutable.
      if (Array.isArray(previousHourEvents) || typeof previousHourEvents === 'string') {
        steps.push([hourKey(Math.floor(started / 3_600_000) * 3_600_000 - 1), ndjson(previousHourEvents, publishedAt)]);
      }
    } else if (closing && closing !== hourKey(started) && Number.isFinite(hourKeyStart(closing))) {
      // An older builder without previousHourEvents: the UTC hour changed since
      // the last good upload, so ask it again as of that hour's last millisecond.
      if (ctl.signal.aborted) return fail('deadline');
      if (db?.inTx) return fail('in_tx');
      try {
        const old = await (await builder())(db, { now: hourKeyStart(closing) + 3_599_999, config, retry: null, version });
        if (Array.isArray(old?.problems) && old.problems.length) {
          for (const line of describeProblems(old.problems)) log(`live: closing hour file skipped, scan: ${line}`);
        } else if (old?.hourEvents) {
          steps.push([closing, ndjson(old.hourEvents, publishedAt)]);
        }
      } catch {
        log('live: closing hour file skipped (build failed)');
      }
    }
    steps.push(['v1/latest.json', pointer]);
    for (const [key, body] of steps) {
      if (ctl.signal.aborted) return fail('deadline');
      try {
        await putter(key, body, { signal: ctl.signal, cacheControl: cacheControlFor(key, { now: started }) });
      } catch (err) {
        if (ctl.signal.aborted) return fail('deadline');
        return fail('put', { key, status: Number.isInteger(err?.status) ? err.status : 0 });
      }
    }
    if (ctl.signal.aborted) return fail('deadline');
    record({ ok: true, seq: snap.seq, bytes: Buffer.byteLength(snapBody), snap: snapKey, snapPutAt });
    const done = { ok: true, seq: snap.seq, bytes: Buffer.byteLength(snapBody) };
    snapshotDone = done;
    // The daily history, once per UTC day, in what is left of the same deadline.
    // Its outcome never changes the snapshot's (and it never throws).
    if (history === false || ctl.signal.aborted) return done;
    const h = await publishHistory({ db, buildDay, oldestEventMs, buildModule: historyModule, putter, now: started, config, signal: ctl.signal, log });
    return { ...done, history: h };
  })().catch((err) => fail('unexpected', { detail: String(err?.name ?? 'Error').slice(0, 40) }));

  try {
    const out = await Promise.race([work, dl.passed]);
    if (out === 'deadline' && snapshotDone) {
      log('live: history step cut at the deadline; retrying next publish');
      return { ...snapshotDone, history: { ok: false, error: 'deadline' } };
    }
    return out === 'deadline' ? fail('deadline') : out;
  } finally {
    finished = true;
    dl.clear();
  }
}

/** `v1/history/days/<YYYY-MM-DD>.json` */
export const historyDayKey = (day) => `v1/history/days/${day}.json`;

const DAY_MS = 86_400_000;
const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && dayOfMs(Date.parse(`${d}T00:00:00Z`)) === d;

/**
 * The daily history rollover (live/history.mjs builds the files). Called by
 * publishLive after a good snapshot upload, with its putter and its deadline's
 * signal; never throws.
 *
 * When kv `live.history.last_day` is not the previous UTC day: build each day
 * still missing, oldest first (the previous day always; on the first run, or
 * after the pump was off, also the up to 7 days before it that the events
 * table still covers, and none already in kv `live.history.days`), scan it,
 * and upload `v1/history/days/<day>.json` (immutable). A stored day goes into
 * kv `live.history.recent` (the day objects, last 120) and `live.history.days`
 * (every day with a file) at once, so a retry never rebuilds it: an
 * immutable key never gets a second body. Then `v1/history/recent.json` and
 * `v1/history/index.json` (max-age=300), from kv. `last_day` is recorded only
 * after all of them are stored; any failure leaves it, and the next publish
 * tries again. A day the scan blocks is not uploaded and not retried (it is
 * logged by rule and path, and kept in kv `live.history.blocked`).
 *
 * @returns {Promise<{ok: boolean, skipped?: string, error?: string, written?: string[], blocked?: string[]}>}
 */
export async function publishHistory({ db, buildDay, oldestEventMs, buildModule = './history.mjs', putter, now, config, signal, log = () => {} } = {}) {
  try {
    const nowMs = typeof now === 'function' ? now() : Number(now);
    const today = dayOfMs(nowMs);
    const previous = dayOfMs(Date.parse(`${today}T00:00:00Z`) - 1);
    const last = db.getKv(HISTORY_LAST_DAY_KEY);
    if (last === previous || (isDay(last) && last > previous)) return { ok: true, skipped: 'done' };
    if (db?.inTx) return { ok: false, skipped: 'in_tx' };
    const mod = buildDay && oldestEventMs ? {} : await import(buildModule);
    const build = buildDay ?? mod.buildDay;
    const oldestOf = oldestEventMs ?? mod.oldestEventMs;
    if (typeof build !== 'function' || typeof oldestOf !== 'function') throw new TypeError('no day builder');
    const stored = db.getKv(HISTORY_DAYS_KEY);
    const have = new Set(Array.isArray(stored) ? stored.filter(isDay) : []);
    const kept = db.getKv(HISTORY_RECENT_KEY);
    let recent = Array.isArray(kept) ? kept.filter((d) => d && typeof d === 'object' && isDay(d.day)) : [];

    // The days to build: after last_day (or the 7 before the previous day on a first run), up to the previous day.
    const prevStart = Date.parse(`${previous}T00:00:00Z`);
    let firstStart = prevStart - HISTORY_BACKFILL_DAYS * DAY_MS;
    if (isDay(last)) firstStart = Math.max(firstStart, Date.parse(`${last}T00:00:00Z`) + DAY_MS);
    let oldest = null;
    try { oldest = oldestOf(db); } catch { oldest = null; }
    const todo = [];
    for (let t = firstStart; t <= prevStart; t += DAY_MS) {
      const d = dayOfMs(t);
      if (have.has(d)) continue;
      // An older day only while the events table still holds all of it, and once the loop had started.
      const covered = t === prevStart || (t >= nowMs - HISTORY_EVENTS_KEPT_MS && oldest !== null && oldest < t + DAY_MS);
      if (covered) todo.push(d);
    }

    const written = [];
    const blocked = [];
    const put = async (key, body) => {
      if (signal?.aborted) throw Object.assign(new Error('deadline'), { deadline: true });
      await putter(key, body, { signal, cacheControl: cacheControlFor(key, { now: nowMs }) });
    };
    const failed = (err, key) => {
      const error = err?.deadline || signal?.aborted ? 'deadline' : 'put';
      log(`live: history upload failed (${error}${key ? ` at ${safeToken(key)}` : ''}); retrying next publish`);
      return { ok: false, error, written, blocked };
    };
    for (const d of todo) {
      if (signal?.aborted) return failed({ deadline: true });
      if (db?.inTx) return { ok: false, skipped: 'in_tx', written, blocked };
      const { day, problems } = await build(db, { day: d, now: nowMs, config });
      if (Array.isArray(problems) && problems.length) {
        for (const line of describeProblems(problems)) log(`live: history day ${d} blocked by the scan: ${line}`);
        blocked.push(d);
        const prior = db.getKv(HISTORY_BLOCKED_KEY);
        db.setKv(HISTORY_BLOCKED_KEY, [...(Array.isArray(prior) ? prior : []), { day: d, at: new Date(nowMs).toISOString(), rules: [...new Set(problems.map((p) => safeToken(p?.rule)))] }].slice(-30), { now: nowMs });
        continue;
      }
      const key = historyDayKey(d);
      try { await put(key, JSON.stringify(day)); } catch (err) { return failed(err, key); }
      have.add(d);
      recent = [...recent.filter((x) => x.day !== d), day].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-HISTORY_RECENT_DAYS);
      db.setKv(HISTORY_DAYS_KEY, [...have].sort(), { now: nowMs });
      db.setKv(HISTORY_RECENT_KEY, recent, { now: nowMs });
      written.push(d);
    }
    const recentText = JSON.stringify({ schema: HISTORY_RECENT_SCHEMA, days: recent });
    const indexText = JSON.stringify({ schema: HISTORY_INDEX_SCHEMA, days: [...have].sort() });
    for (const [key, body] of [[HISTORY_RECENT_FILE, recentText], [HISTORY_INDEX_FILE, indexText]]) {
      try { await put(key, body); } catch (err) { return failed(err, key); }
    }
    db.setKv(HISTORY_LAST_DAY_KEY, previous, { now: nowMs });
    return { ok: true, written, blocked };
  } catch (err) {
    log(`live: history not built (${String(err?.name ?? 'Error').slice(0, 40)}); retrying next publish`);
    return { ok: false, error: 'build' };
  }
}

/** The open retry as the page may see it: fixed call labels and numbers only. */
export function retryBody(retry, at) {
  if (retry === null || retry === undefined) return { schema: RETRY_SCHEMA, at, retry: null };
  const call = RETRY_CALLS.includes(retry.call) ? retry.call : 'github_api';
  const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const time = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
  return { schema: RETRY_SCHEMA, at, retry: { call, status: int(retry.status), attempt: int(retry.attempt), of: int(retry.of), next_at: time(retry.next_at), since: time(retry.since) } };
}

/**
 * Upload v1/retry.json, built from the in-memory open retry (`retry`, or null
 * when it cleared). Never reads the state, never throws, same switch, scan
 * and deadline rules. `scan(value)` -> { ok, hits } (live/scan.mjs
 * scanPublic); when it cannot be loaded nothing is uploaded.
 */
export async function publishRetry({
  retry, put, env = process.env, fetch = globalThis.fetch, now = Date.now, scan, scanModule = './scan.mjs',
  deadlineMs = DEFAULT_DEADLINE_MS, log = () => {}, putOptions = {},
} = {}) {
  if (!liveEnabled(env)) return { ok: false, skipped: 'off' };
  if (!(deadlineMs > 0)) return { ok: false, skipped: 'no_time' };
  const started = now();
  const dl = deadlineOf(deadlineMs);
  try {
    const work = (async () => {
      const body = retryBody(retry, new Date(started).toISOString());
      let verdict;
      try {
        const scanner = scan ?? (await import(scanModule)).scanPublic;
        verdict = scanner(body);
      } catch {
        log('live: retry.json not uploaded (the scan is unavailable)');
        return { ok: false, error: 'scan_unavailable' };
      }
      if (!verdict || verdict.ok !== true || (verdict.hits ?? []).length) {
        for (const line of describeProblems(verdict?.hits ?? [])) log(`live: retry.json blocked by the scan: ${line}`);
        return { ok: false, blocked: 'scan' };
      }
      const putter = makePutter({ put, env, fetch, now, until: () => started + deadlineMs, putOptions });
      try {
        await putter(RETRY_KEY, JSON.stringify(body), { signal: dl.ctl.signal, cacheControl: cacheControlFor(RETRY_KEY) });
        return { ok: true };
      } catch {
        return { ok: false, error: dl.ctl.signal.aborted ? 'deadline' : 'put' };
      }
    })().catch(() => ({ ok: false, error: 'unexpected' }));
    return await Promise.race([work, dl.passed.then(() => ({ ok: false, error: 'deadline' }))]);
  } finally {
    dl.clear();
  }
}
