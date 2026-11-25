import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';

import { liveEnabled, publishLive } from '../publish.mjs';

const NOW = Date.parse('2026-11-25T13:30:05Z');
const ENV = { LANE_LIVE_SNAPSHOT_ENABLED: 'true', LIVE_R2_ACCESS_KEY_ID: 'AKIA_SYN', LIVE_R2_SECRET_ACCESS_KEY: 'syn-secret-xyz', R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' };

function fakeDb() {
  const kv = new Map();
  return { kv, getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => { kv.set(k, structuredClone(v)); } };
}
const snapKeyOf = (body) => `v1/snap/${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`;
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
  const snapKey = snapKeyOf(puts[0].body);
  assert.deepEqual(puts.map((p) => p.key), [snapKey, 'v1/events/2026-11-25/13.ndjson', 'v1/latest.json']);
  assert.match(snapKey, /^v1\/snap\/[0-9a-f]{16}\.json$/);
  assert.equal(r.ok, true);
  const ptr = JSON.parse(puts[2].body);
  assert.deepEqual(ptr, { schema: 'isokron-loop-latest/1', seq: 42, generated_at: '2026-11-25T13:30:00.000Z', snap: snapKey });
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
  for (const failing of ['snap', 'v1/events/2026-11-25/13.ndjson']) {
    const keys = [];
    const put = async (key) => { keys.push(key); if (key === failing || (failing === 'snap' && key.startsWith('v1/snap/'))) throw Object.assign(new Error('HTTP 503'), { status: 503 }); return { status: 200 }; };
    const { r, db } = await run({ put });
    assert.equal(r.ok, false);
    assert.ok(!keys.includes('v1/latest.json'), `pointer written after ${failing} failed`);
    const last = db.getKv('live.last_upload');
    assert.equal(last.ok, false);
    assert.equal(last.error, 'put');
    assert.equal(last.key, failing === 'snap' ? keys[0] : failing);
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
  assert.deepEqual(urls, [`PUT /isokron-loop-live/${snapKeyOf(JSON.stringify({ ...good().snapshot, recent: [{ seq: 41, type: 'result', published_at: '2026-11-25T13:30:05.000Z' }] }))}`, 'PUT /isokron-loop-live/v1/events/2026-11-25/13.ndjson', 'PUT /isokron-loop-live/v1/latest.json']);
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
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^v1\/snap\//);
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

test('the snapshot key is its content hash: same body, same key; a different body, a different key; an unchanged body is not sent again but the pointer is', async () => {
  const db = fakeDb();
  const first = await run({ db });
  const again = await run({ db });
  assert.deepEqual(again.puts.map((p) => p.key), ['v1/events/2026-11-25/13.ndjson', 'v1/latest.json'], 'no second snapshot PUT');
  assert.equal(JSON.parse(again.puts[1].body).snap, first.puts[0].key, 'the pointer still names the stored body');
  assert.equal(again.r.ok, true);
  // a changed generated_at is a changed body: new key, snapshot PUT again
  const changed = await run({ db, build: async () => { const g = good(); g.snapshot.generated_at = '2026-11-25T13:30:30.000Z'; return g; } });
  assert.equal(changed.puts.length, 3);
  assert.notEqual(changed.puts[0].key, first.puts[0].key);
  const ptr = JSON.parse(changed.puts[2].body);
  assert.equal(ptr.generated_at, '2026-11-25T13:30:30.000Z');
  assert.equal(ptr.snap, changed.puts[0].key);
  // the key never holds two bodies: same key implies same bytes
  const seen = new Map();
  for (const r of [first, changed]) { const k = r.puts[0].key; assert.ok(!seen.has(k) || seen.get(k) === r.puts[0].body); seen.set(k, r.puts[0].body); }
});

test('a snapshot whose upload failed is sent again next time (the skip needs a recorded good upload)', async () => {
  const db = fakeDb();
  await run({ db, put: async (key) => { if (key.startsWith('v1/events/')) throw new Error('x'); return { status: 200 }; } });
  const next = await run({ db });
  assert.equal(next.puts.length, 3);
});

test('hour rollover: the first upload in a new UTC hour also rewrites the previous hour once, immutable, before the pointer', async () => {
  const db = fakeDb();
  let t = Date.parse('2026-11-25T13:58:00Z');
  const builds = [];
  const build = async (_db, a) => {
    builds.push(a.now);
    const g = good();
    g.hourEvents = [{ seq: 1, type: 'result', occurred_at: new Date(a.now).toISOString() }];
    return g;
  };
  const cc = [];
  const put = async (key, body, o) => { cc.push(key); return { status: 200 }; };
  const go = async () => { cc.length = 0; await publishLive({ db, build, put, env: ENV, now: () => t, deadlineMs: 2000 }); return [...cc]; };
  assert.deepEqual((await go()).filter((k) => k.includes('events')), ['v1/events/2026-11-25/13.ndjson']);
  t = Date.parse('2026-11-25T13:59:30Z');
  assert.deepEqual((await go()).filter((k) => k.includes('events')), ['v1/events/2026-11-25/13.ndjson'], 'same hour: no rewrite');
  t = Date.parse('2026-11-25T14:00:20Z');
  const keys = await go();
  assert.deepEqual(keys.filter((k) => k.includes('events')), ['v1/events/2026-11-25/14.ndjson', 'v1/events/2026-11-25/13.ndjson']);
  assert.equal(keys.at(-1), 'v1/latest.json');
  assert.equal(builds.at(-1), Date.parse('2026-11-25T13:59:59.999Z'), 'asked as of the closed hour\'s last millisecond');
  t = Date.parse('2026-11-25T14:02:50Z');
  assert.deepEqual((await go()).filter((k) => k.includes('events')), ['v1/events/2026-11-25/14.ndjson'], 'only once');
});

test('hour rollover: the closing file is sent with immutable caching through the real writer; a scan hit or a build failure on it only skips it', async () => {
  const db = fakeDb();
  const sent = [];
  const fetch = async (url, init) => { sent.push({ path: new URL(url).pathname, cc: init.headers['cache-control'] }); return new Response('', { status: 200 }); };
  let t = Date.parse('2026-11-25T13:58:00Z');
  const go = (build) => publishLive({ db, build, env: ENV, fetch, now: () => t, deadlineMs: 2000, log: () => {} });
  await go(async () => good());
  t = Date.parse('2026-11-25T14:01:00Z');
  sent.length = 0;
  await go(async () => good());
  const closing = sent.find((s) => s.path.endsWith('/13.ndjson'));
  assert.equal(closing.cc, 'public, max-age=31536000, immutable');
  assert.equal(sent.find((s) => s.path.endsWith('/14.ndjson')).cc, 'public, max-age=60');
  // a builder that fails only for the closing hour: the upload still succeeds without it
  const db2 = fakeDb();
  t = Date.parse('2026-11-25T13:58:00Z');
  await publishLive({ db: db2, build: async () => good(), env: ENV, fetch, now: () => t, deadlineMs: 2000, log: () => {} });
  t = Date.parse('2026-11-25T14:01:00Z');
  sent.length = 0;
  let n = 0;
  const r = await publishLive({ db: db2, build: async () => { if (++n === 2) throw new Error('x'); return good(); }, env: ENV, fetch, now: () => t, deadlineMs: 2000, log: () => {} });
  assert.equal(r.ok, true);
  assert.ok(!sent.some((s) => s.path.endsWith('/13.ndjson')));
});
