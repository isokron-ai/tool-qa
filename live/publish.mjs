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

/** A deadline: an abort controller, a timer, and a promise that settles when it passes. */
function deadlineOf(ms) {
  const ctl = new AbortController();
  let timer;
  const passed = new Promise((resolve) => {
    timer = setTimeout(() => { ctl.abort(); resolve('deadline'); }, Math.max(1, ms));
    timer.unref?.();
  });
  return { ctl, passed, clear: () => clearTimeout(timer) };
}

/**
 * @returns {Promise<{ ok: boolean, skipped?: string, blocked?: 'scan', error?: string, seq?: number, bytes?: number }>}
 */
export async function publishLive({
  db, build, buildModule = './build.mjs', put, env = process.env, fetch = globalThis.fetch, now = Date.now,
  config, retry = null, version, deadlineMs = DEFAULT_DEADLINE_MS, log = () => {}, putOptions = {},
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
    return { ok: true, seq: snap.seq, bytes: Buffer.byteLength(snapBody) };
  })().catch((err) => fail('unexpected', { detail: String(err?.name ?? 'Error').slice(0, 40) }));

  try {
    const out = await Promise.race([work, dl.passed]);
    return out === 'deadline' ? fail('deadline') : out;
  } finally {
    finished = true;
    dl.clear();
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
