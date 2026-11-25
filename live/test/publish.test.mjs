import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liveEnabled, publishLive } from '../publish.mjs';

const NOW = Date.parse('2026-11-25T13:30:05Z');
const ENV = { LANE_LIVE_SNAPSHOT_ENABLED: 'true', LIVE_R2_ACCESS_KEY_ID: 'AKIA_SYN', LIVE_R2_SECRET_ACCESS_KEY: 'syn-secret-xyz', R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' };

function fakeDb() {
  const kv = new Map();
  return { kv, getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => { kv.set(k, structuredClone(v)); } };
}
const good = () => ({
  snapshot: { schema: 'isokron-loop-live/1', seq: 42, generated_at: '2026-11-25T13:30:00.000Z', recent: [{ seq: 41, type: 'result' }] },
  hourEvents: [{ seq: 41, type: 'result', occurred_at: '2026-11-25T13:29:00.000Z' }],
  problems: [],
});
const run = (over = {}) => {
  const db = over.db ?? fakeDb();
  const puts = [];
  const lines = [];
  const put = over.put ?? (async (key, body, o) => { puts.push({ key, body, o }); return { status: 200 }; });
  const args = { db, build: async () => good(), put, env: ENV, now: () => NOW, log: (l) => lines.push(l), deadlineMs: 2000, ...over };
  return publishLive(args).then((r) => ({ r, db, puts, lines }));
};

test('order: snapshot, then the hour file, then the pointer last', async () => {
  const { r, puts, db } = await run();
  assert.deepEqual(puts.map((p) => p.key), ['v1/snap/42.json', 'v1/events/2026-11-25/13.ndjson', 'v1/latest.json']);
  assert.equal(r.ok, true);
  const ptr = JSON.parse(puts[2].body);
  assert.deepEqual(ptr, { schema: 'isokron-loop-latest/1', seq: 42, generated_at: '2026-11-25T13:30:00.000Z', snap: 'v1/snap/42.json' });
  const hour = puts[1].body.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(hour[0].published_at, '2026-11-25T13:30:05.000Z', 'the uploader adds published_at');
  assert.equal(JSON.parse(puts[0].body).recent[0].published_at, '2026-11-25T13:30:05.000Z');
  const last = db.getKv('live.last_upload');
  assert.equal(last.ok, true);
  assert.equal(last.seq, 42);
  assert.equal(last.bytes, Buffer.byteLength(puts[0].body));
  assert.equal(last.at, '2026-11-25T13:30:05.000Z');
});

test('a failed body upload means no pointer (snapshot fails: nothing else; hour fails: no pointer)', async () => {
  for (const failing of ['v1/snap/42.json', 'v1/events/2026-11-25/13.ndjson']) {
    const keys = [];
    const put = async (key) => { keys.push(key); if (key === failing) throw Object.assign(new Error('HTTP 503'), { status: 503 }); return { status: 200 }; };
    const { r, db } = await run({ put });
    assert.equal(r.ok, false);
    assert.ok(!keys.includes('v1/latest.json'), `pointer written after ${failing} failed`);
    const last = db.getKv('live.last_upload');
    assert.equal(last.ok, false);
    assert.equal(last.error, 'put');
    assert.equal(last.key, failing);
    assert.equal(last.status, 503);
  }
});

test('a scan hit uploads nothing, logs rule and path only, and records the block', async () => {
  let putCalls = 0;
  const build = async () => ({ ...good(), problems: [{ rule: 'vendor-name', path: 'recent[3].subject', text: 'SECRET-TEXT-VALUE' }] });
  const { r, db, lines } = await run({ build, put: async () => { putCalls += 1; return { status: 200 }; } });
  assert.equal(putCalls, 0, 'scan-blocked snapshot must not be uploaded');
  assert.deepEqual(r, { ok: false, blocked: 'scan' });
  const last = db.getKv('live.last_upload');
  assert.equal(last.ok, false);
  assert.equal(last.blocked, 'scan');
  const log = lines.join('\n');
  assert.match(log, /vendor-name/);
  assert.match(log, /recent\[3\]\.subject/);
  assert.ok(!log.includes('SECRET-TEXT-VALUE'));
});

test('switch: anything but the exact value true, or a missing credential, makes no call at all', async () => {
  const variants = [
    { LANE_LIVE_SNAPSHOT_ENABLED: undefined }, { LANE_LIVE_SNAPSHOT_ENABLED: '' }, { LANE_LIVE_SNAPSHOT_ENABLED: 'TRUE' },
    { LANE_LIVE_SNAPSHOT_ENABLED: '1' }, { LANE_LIVE_SNAPSHOT_ENABLED: 'true ' }, { LANE_LIVE_SNAPSHOT_ENABLED: 'yes' },
    { LIVE_R2_ACCESS_KEY_ID: '' }, { LIVE_R2_SECRET_ACCESS_KEY: undefined }, { R2_ACCOUNT_ID: '' },
  ];
  for (const v of variants) {
    const env = { ...ENV, ...v };
    assert.equal(liveEnabled(env), false, JSON.stringify(v));
    let fetches = 0;
    let builds = 0;
    const fetch = async () => { fetches += 1; return new Response('', { status: 200 }); };
    const r = await publishLive({ db: fakeDb(), build: async () => { builds += 1; return good(); }, env, fetch, now: () => NOW, deadlineMs: 500 });
    assert.deepEqual(r, { ok: false, skipped: 'off' });
    assert.equal(fetches, 0, `fetch called with ${JSON.stringify(v)}`);
    assert.equal(builds, 0);
  }
  assert.equal(liveEnabled(ENV), true);
});

test('with the real R2 writer the same order goes over fetch', async () => {
  const urls = [];
  const fetch = async (url, init) => { urls.push(`${init.method} ${new URL(url).pathname}`); return new Response('', { status: 200 }); };
  const r = await publishLive({ db: fakeDb(), build: async () => good(), env: { ...ENV, LIVE_R2_BUCKET: 'isokron-loop-live' }, fetch, now: () => NOW, deadlineMs: 2000 });
  assert.equal(r.ok, true);
  assert.deepEqual(urls, ['PUT /isokron-loop-live/v1/snap/42.json', 'PUT /isokron-loop-live/v1/events/2026-11-25/13.ndjson', 'PUT /isokron-loop-live/v1/latest.json']);
});

test('never throws: a throwing builder, a throwing put and a broken database are all absorbed', async () => {
  let out = await run({ build: async () => { throw new Error('boom'); } });
  assert.equal(out.r.ok, false);
  assert.equal(out.db.getKv('live.last_upload').error, 'build');
  out = await run({ put: async () => { throw new TypeError('bad'); } });
  assert.equal(out.r.ok, false);
  const brokenDb = { getKv() { throw new Error('closed'); }, setKv() { throw new Error('closed'); } };
  out = await run({ db: brokenDb });
  assert.equal(out.r.ok, true, 'the upload itself still succeeded; recording it failed quietly');
  assert.ok(out.lines.some((l) => /could not record/.test(l)));
});

test('a hanging upload returns at the deadline, aborts, and never writes the pointer', async () => {
  const keys = [];
  let aborted = false;
  const put = (key, body, o) => { keys.push(key); return new Promise((_, reject) => { o.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); }); };
  const t0 = Date.now();
  const { r, db } = await run({ put, deadlineMs: 60 });
  assert.ok(Date.now() - t0 < 1500);
  assert.deepEqual(r, { ok: false, error: 'deadline' });
  assert.equal(aborted, true);
  assert.deepEqual(keys, ['v1/snap/42.json']);
  assert.equal(db.getKv('live.last_upload').error, 'deadline');
  // An upload that ignores the abort and finishes late still cannot go on to the pointer.
  const keys2 = [];
  const slow = (key) => { keys2.push(key); return new Promise((res) => setTimeout(() => res({ status: 200 }), 150)); };
  const out = await run({ put: slow, deadlineMs: 40 });
  assert.equal(out.r.error, 'deadline');
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!keys2.includes('v1/latest.json'));
});

test('last_ok_at survives a later failure so the watchdog can age the last good upload', async () => {
  const db = fakeDb();
  await run({ db });
  const later = Date.parse('2026-11-25T13:40:00Z');
  await run({ db, now: () => later, put: async () => { throw new Error('x'); } });
  const last = db.getKv('live.last_upload');
  assert.equal(last.ok, false);
  assert.equal(last.last_ok_at, '2026-11-25T13:30:05.000Z');
});
