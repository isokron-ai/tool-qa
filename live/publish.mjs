// publishLive(): build the public live snapshot and put it in R2.
//
//   build -> scan problems? -> PUT v1/snap/<16 hex of sha256(body)>.json
//                              PUT v1/events/<YYYY-MM-DD>/<HH>.ndjson
//                              (once, after the UTC hour changed: the hour of
//                               the last good upload again, now final/immutable)
//                              PUT v1/latest.json            (LAST)
//
// The snapshot key is its content hash, so "immutable" is true: the same key
// never holds two bodies. A body equal to the last uploaded one is not sent
// again, but the pointer is still rewritten (its generated_at shows liveness).
//
// The pointer is written only after both bodies are stored, so it never names a
// missing object. Any scan hit (problems from live/build.mjs) uploads nothing:
// the log names the rule and the path, never the text, and kv
// `live.last_upload` records the block (the watchdog's `live-snapshot` item
// goes red on it).
//
// It never throws and is bounded by `deadlineMs` (the upload is aborted and the
// call returns when it passes, with no pointer written). It makes no network
// call, and does not even build, unless LANE_LIVE_SNAPSHOT_ENABLED is exactly
// `true` and the three credentials exist.
//
// The builder is injected (`build`, from live/build.mjs): build(db, { now,
// config, retry, version }) -> { snapshot, hourEvents, problems }. `now` is
// epoch milliseconds. `put` is injected too (live/r2.mjs by default).

import { createHash } from 'node:crypto';

import { createR2Putter } from './r2.mjs';

export const LAST_UPLOAD_KEY = 'live.last_upload';
export const SWITCH = 'LANE_LIVE_SNAPSHOT_ENABLED';
export const LATEST_SCHEMA = 'isokron-loop-latest/1';
export const DEFAULT_DEADLINE_MS = 20_000;
export const DEFAULT_BUCKET = 'isokron-loop-live';

/** Only the exact value `true` turns it on, and only with all three credentials. */
export function liveEnabled(env = process.env) {
  return env?.[SWITCH] === 'true'
    && Boolean(env.LIVE_R2_ACCESS_KEY_ID) && Boolean(env.LIVE_R2_SECRET_ACCESS_KEY) && Boolean(env.R2_ACCOUNT_ID);
}

/** `v1/events/<YYYY-MM-DD>/<HH>.ndjson` for the UTC hour of `ms`. */
export function hourKey(ms) {
  const iso = new Date(ms).toISOString();
  return `v1/events/${iso.slice(0, 10)}/${iso.slice(11, 13)}.ndjson`;
}

const safeToken = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.:/[\]-]/g, '?').slice(0, 120);

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

/**
 * @returns {Promise<{ ok: boolean, skipped?: 'off', blocked?: 'scan', error?: string, seq?: number, bytes?: number }>}
 */
export async function publishLive({
  db, build, put, env = process.env, fetch = globalThis.fetch, now = Date.now,
  config, retry = null, version, deadlineMs = DEFAULT_DEADLINE_MS, log = () => {}, putOptions = {},
} = {}) {
  if (!liveEnabled(env)) return { ok: false, skipped: 'off' };
  const started = now();
  const iso = () => new Date(now()).toISOString();
  const ctl = new AbortController();
  let finished = false;
  let recorded = false;
  const record = (value) => {
    if (finished || recorded) return;
    recorded = true;
    try {
      const prior = db.getKv(LAST_UPLOAD_KEY);
      const lastOk = value.ok ? iso() : prior?.last_ok_at ?? (prior?.ok ? prior.at : null);
      const lastSnap = value.ok ? value.snap : prior?.last_snap ?? (prior?.ok ? prior.snap : null);
      db.setKv(LAST_UPLOAD_KEY, { ...value, at: iso(), last_ok_at: lastOk, last_snap: lastSnap }, { now: now() });
    } catch (err) {
      log(`live: could not record the upload result: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };
  const fail = (error, extra = {}) => {
    log(`live: upload failed (${error})`);
    record({ ok: false, error, ...extra });
    return { ok: false, error };
  };

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { ctl.abort(); resolve('deadline'); }, Math.max(1, deadlineMs));
    timer.unref?.();
  });

  const work = (async () => {
    let built;
    try {
      built = await build(db, { now: started, config, retry, version });
    } catch (err) {
      return fail('build', { detail: String(err?.name ?? 'Error').slice(0, 40) });
    }
    const { snapshot, hourEvents, problems } = built ?? {};
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
    const putter = put ?? createR2Putter({
      accountId: env.R2_ACCOUNT_ID, bucket: env.LIVE_R2_BUCKET || DEFAULT_BUCKET,
      accessKeyId: env.LIVE_R2_ACCESS_KEY_ID, secretAccessKey: env.LIVE_R2_SECRET_ACCESS_KEY,
      fetch, now, until: () => started + deadlineMs, ...putOptions,
    });
    // Order is the contract: both bodies, then the pointer.
    let prior = null;
    try { prior = db.getKv(LAST_UPLOAD_KEY); } catch { /* none */ }
    const steps = [];
    if (prior?.last_snap !== snapKey) steps.push([snapKey, snapBody]);
    steps.push([hourKey(started), ndjson(hourEvents, publishedAt)]);
    // The UTC hour changed since the last good upload: that hour's file was
    // last written mid-hour; write it once more from the events table (the
    // builder, asked as of the hour's last millisecond), now past, so immutable.
    const lastOkMs = Date.parse(prior?.last_ok_at ?? '');
    if (Number.isFinite(lastOkMs) && hourKey(lastOkMs) !== hourKey(started)) {
      const closing = hourKey(lastOkMs);
      const hourEndMs = Math.floor(lastOkMs / 3_600_000) * 3_600_000 + 3_599_999;
      try {
        const old = await build(db, { now: hourEndMs, config, retry: null, version });
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
        await putter(key, body, { signal: ctl.signal });
      } catch (err) {
        if (ctl.signal.aborted) return fail('deadline');
        return fail('put', { key, status: Number.isInteger(err?.status) ? err.status : 0 });
      }
    }
    if (ctl.signal.aborted) return fail('deadline');
    record({ ok: true, seq: snap.seq, bytes: Buffer.byteLength(snapBody), snap: snapKey });
    return { ok: true, seq: snap.seq, bytes: Buffer.byteLength(snapBody) };
  })().catch((err) => fail('unexpected', { detail: String(err?.name ?? 'Error').slice(0, 40) }));

  try {
    const out = await Promise.race([work, deadline]);
    if (out === 'deadline') {
      return fail('deadline');
    }
    return out;
  } finally {
    finished = true;
    clearTimeout(timer);
  }
}
