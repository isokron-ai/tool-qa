import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEEP_DAYS, KEEP_RECENT, copyStateAsset, isUnchanged, parseSnapshotName, reconcile, runSnapshot, selectRetention,
  snapshotName, verifySnapshot,
} from '../snapshot.mjs';
import { createReleaseClient } from '../github.mjs';
import { cipher, fakeGh, sha } from './fake-github.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-24T12:41:00Z');

function entry(ms, i = 0) {
  const s = sha(Buffer.from(`state ${ms} ${i}`));
  const name = snapshotName(ms, s);
  return { name, asset_id: i + 1, created: parseSnapshotName(name).created, sha256: s, size: 10, source: null };
}

test('snapshot names carry the UTC time and the first 8 hex of the sha256, and parse back', () => {
  const s = sha(Buffer.from('x'));
  const name = snapshotName(Date.parse('2026-11-24T02:35:07.123Z'), s);
  assert.equal(name, `state-20261124T023507Z-${s.slice(0, 8)}.sqlite.age`);
  assert.deepEqual(parseSnapshotName(name), { created: '2026-11-24T02:35:07Z', sha8: s.slice(0, 8) });
  assert.equal(parseSnapshotName('state.sqlite'), null);
  assert.equal(parseSnapshotName('state-20261124T023507Z-ABCDEF12.sqlite.age'), null);
  assert.equal(parseSnapshotName('state-20261124T023507Z-abcdef12.sqlite.age\n'), null);
});

test('R-SNAP-01: retention keeps the 48 newest and the newest of each UTC day for 30 days, and prunes the rest', () => {
  // One snapshot an hour for 40 days.
  const entries = [];
  for (let h = 0; h < 40 * 24; h++) entries.push(entry(T0 - h * HOUR, h));
  const { keep, prune } = selectRetention(entries, { now: T0 });
  assert.equal(keep.length + prune.length, entries.length);
  const newest48 = new Set([...entries].sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, KEEP_RECENT).map((e) => e.name));
  const cutoff = T0 - KEEP_DAYS * DAY;
  const dailyNewest = new Map();
  for (const e of entries) {
    const t = Date.parse(e.created);
    if (t < cutoff) continue;
    const d = e.created.slice(0, 10);
    if (!dailyNewest.has(d) || dailyNewest.get(d).created < e.created) dailyNewest.set(d, e);
  }
  const want = new Set([...newest48, ...[...dailyNewest.values()].map((e) => e.name)]);
  assert.deepEqual(new Set(keep.map((e) => e.name)), want);
  for (const p of prune) assert.ok(!want.has(p.name));
  // 48 newest span today and yesterday; the 30-day window adds one per older day.
  assert.ok(dailyNewest.size >= 30 && dailyNewest.size <= 31);
  assert.ok(keep.length <= KEEP_RECENT + 31);
  // Nothing older than 30 days survives unless it is among the 48 newest.
  assert.ok(keep.every((e) => Date.parse(e.created) >= cutoff || newest48.has(e.name)));
  // Newest first.
  assert.deepEqual(keep.map((e) => e.created), [...keep.map((e) => e.created)].sort().reverse());
});

test('R-SNAP-01: an idle loop prunes nothing: retention counts snapshots, not hours', () => {
  // Ten snapshots, the oldest 90 days old: a loop that changed little. All are kept.
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push(entry(T0 - i * 9 * DAY, i));
  const { keep, prune } = selectRetention(entries, { now: T0 });
  assert.equal(keep.length, 10);
  assert.deepEqual(prune, []);
  // Sixty hourly snapshots: the 12 oldest are pruned, since the newest
  // snapshot of their day is already among the 48 newest.
  const many = [];
  for (let h = 0; h < 60; h++) many.push(entry(T0 - h * HOUR, h));
  const r = selectRetention(many, { now: T0 });
  assert.equal(r.prune.length, 60 - KEEP_RECENT);
  assert.ok(r.prune.every((p) => p.created < r.keep.at(-1).created));
});

test('R-SNAP-02: dedupe compares against the newest snapshot only', () => {
  const a = entry(T0 - 2 * HOUR, 1);
  const b = entry(T0 - HOUR, 2);
  assert.equal(isUnchanged([a, b], b.sha256), true);
  assert.equal(isUnchanged([a, b], a.sha256), false, 'a return to an older state is a new snapshot');
  assert.equal(isUnchanged([], a.sha256), false);
});

test('R-SNAP-02: an unchanged state uploads nothing but refreshes current_at', async () => {
  const f = fakeGh();
  const state = cipher('generation 1');
  f.pushState(state);
  let t = T0;
  const r1 = await runSnapshot({ gh: f.gh, now: () => t });
  assert.equal(r1.status, 'snapshotted');
  assert.equal(r1.sha256, sha(state));
  t += HOUR;
  const uploadsBefore = f.gh.calls.filter((c) => c[0] === 'upload' && c[1].startsWith('state-')).length;
  const r2 = await runSnapshot({ gh: f.gh, now: () => t });
  assert.equal(r2.status, 'unchanged');
  assert.equal(r2.snapshot, r1.snapshot);
  assert.equal(f.gh.calls.filter((c) => c[0] === 'upload' && c[1].startsWith('state-')).length, uploadsBefore, 'no snapshot uploaded');
  const m = f.manifestOf();
  assert.equal(m.snapshots.length, 1);
  assert.equal(m.current_at, new Date(t).toISOString());
  assert.equal(f.assetsOf('state-snapshots').filter((a) => a.name.startsWith('state-')).length, 1);
  assert.deepEqual(f.assetsOf('state-snapshots').filter((a) => a.name.startsWith('manifest')).map((a) => a.name), ['manifest.json']);
});

test('R-SNAP-02: a changed state is a new snapshot, and so is a return to an older state', async () => {
  const f = fakeGh();
  let t = T0;
  for (const g of ['A', 'B', 'A']) {
    f.pushState(cipher(g));
    t += HOUR;
    const r = await runSnapshot({ gh: f.gh, now: () => t });
    assert.equal(r.status, 'snapshotted', g);
  }
  const m = f.manifestOf();
  assert.equal(m.snapshots.length, 3);
  assert.deepEqual(m.snapshots.map((s) => s.sha256), [sha(cipher('A')), sha(cipher('B')), sha(cipher('A'))]);
  for (const s of m.snapshots) {
    assert.match(s.name, /^state-\d{8}T\d{6}Z-[0-9a-f]{8}\.sqlite\.age$/);
    assert.equal(s.size, cipher('A').length);
    assert.equal(typeof s.source.updated_at, 'string');
    assert.equal(s.source.name, 'state.sqlite');
  }
});

test('R-SNAP-03: verifySnapshot accepts the bytes the manifest describes and refuses a changed byte, a wrong size, a wrong name or plaintext', () => {
  const bytes = cipher('generation 7');
  const s = sha(bytes);
  const e = { name: snapshotName(T0, s), sha256: s, size: bytes.length };
  assert.deepEqual(verifySnapshot(bytes, e), { ok: true, sha256: s });
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 1] ^= 1;
  assert.match(verifySnapshot(flipped, e).reason, /sha256/);
  assert.match(verifySnapshot(Buffer.concat([bytes, Buffer.from('x')]), e).reason, /size/);
  const other = sha(Buffer.from('other'));
  assert.match(verifySnapshot(bytes, { ...e, name: snapshotName(T0, other) }).reason, /name/);
  const plain = Buffer.from('SQLite format 3\0 not encrypted');
  assert.match(verifySnapshot(plain, { name: snapshotName(T0, sha(plain)), sha256: sha(plain), size: plain.length }).reason, /age/);
  assert.match(verifySnapshot(bytes, { name: e.name }).reason, /no sha256/);
});

test('R-SNAP-03: an upload that does not read back intact is deleted and the run fails', async () => {
  const f = fakeGh();
  f.pushState(cipher('generation 1'));
  f.gh.hooks.afterDownload = (asset, out) => {
    const a = f.assetsOf('state-snapshots').find((x) => x.id === asset.id);
    if (a && a.name.startsWith('state-')) {
      out[out.length - 1] ^= 1;
    }
    return out;
  };
  await assert.rejects(runSnapshot({ gh: f.gh, now: () => T0 }), /did not read back intact/);
  assert.equal(f.assetsOf('state-snapshots').filter((a) => a.name.startsWith('state-')).length, 0);
  assert.equal(f.manifestOf(), null, 'no manifest names a bad snapshot');
});

test('R-SNAP-04: the pump pushing during the copy is detected and the copy is retried once', async () => {
  const f = fakeGh();
  const old = f.pushState(cipher('generation 1'));
  const next = cipher('generation 2');
  let pushed = false;
  f.gh.hooks.afterDownload = (asset, out) => {
    if (asset.id === old.id && !pushed) {
      pushed = true;
      f.pushState(next); // the pump replaced the asset while we were reading it
    }
    return out;
  };
  const logs = [];
  const r = await runSnapshot({ gh: f.gh, now: () => T0, log: (m) => logs.push(m) });
  assert.equal(r.status, 'snapshotted');
  assert.equal(r.copy_tries, 2);
  assert.equal(r.sha256, sha(next), 'the snapshot holds what the pump pushed, not a mix');
  assert.ok(logs.some((l) => /replaced while it was copied; trying again/.test(l)));
});

test('R-SNAP-04: bytes that do not match the label, twice, fail the run and upload nothing', async () => {
  const f = fakeGh();
  f.pushState(cipher('generation 1'), { label: `sha256:${sha(Buffer.from('something else'))}` });
  await assert.rejects(runSnapshot({ gh: f.gh, now: () => T0 }), /could not copy a stable state asset in 2 tries .*do not match the label/);
  assert.equal(f.gh.calls.filter((c) => c[0] === 'download').length, 2, 'one retry, no more');
  assert.equal(f.gh.calls.filter((c) => c[0] === 'upload').length, 0);
});

test('R-SNAP-04: an interrupted pump push (temporary name only) is copied like the pump would read it', async () => {
  const f = fakeGh();
  const data = cipher('generation 3');
  f.addAsset('state', 'state.sqlite.upload-20261124T010000Z', data, `sha256:${sha(data)}`);
  const c = await copyStateAsset({ gh: f.gh });
  assert.equal(c.status, 'copied');
  assert.equal(c.source.name, 'state.sqlite.upload-20261124T010000Z');
});

test('R-SNAP-04: a plaintext or unlabelled state asset is never copied', async () => {
  const f = fakeGh();
  const plain = Buffer.from('SQLite format 3\0 plaintext');
  f.pushState(plain);
  await assert.rejects(runSnapshot({ gh: f.gh, now: () => T0 }), /not age ciphertext/);
  f.pushState(cipher('x'), { label: '' });
  await assert.rejects(runSnapshot({ gh: f.gh, now: () => T0 }), /no sha256 label/);
  assert.equal(f.gh.calls.filter((c) => c[0] === 'upload').length, 0);
});

test('no state asset: nothing is copied and the snapshot release is left alone', async () => {
  const f = fakeGh();
  const r = await runSnapshot({ gh: f.gh, now: () => T0 });
  assert.deepEqual(r, { status: 'absent' });
  assert.equal(f.gh.calls.filter((c) => c[0] === 'createRelease').length, 0);
});

test('R-SNAP-05: a lost manifest is rebuilt from the snapshot assets, and a stale entry is dropped', async () => {
  const f = fakeGh();
  let t = T0;
  for (const g of ['A', 'B']) {
    f.pushState(cipher(g));
    t += HOUR;
    await runSnapshot({ gh: f.gh, now: () => t });
  }
  // Someone deletes the manifest and the older snapshot.
  const assets = f.assetsOf('state-snapshots');
  await f.gh.deleteAsset(assets.find((a) => a.name === 'manifest.json').id);
  const before = f.assetsOf('state-snapshots').filter((a) => a.name.startsWith('state-'));
  assert.equal(before.length, 2);
  t += HOUR;
  const logs = [];
  const r = await runSnapshot({ gh: f.gh, now: () => t, log: (m) => logs.push(m) });
  assert.equal(r.status, 'unchanged', 'the rebuilt manifest still dedupes on the label sha256');
  const m = f.manifestOf();
  assert.equal(m.snapshots.length, 2);
  assert.ok(logs.some((l) => /added 2 snapshot/.test(l)));
  for (const s of m.snapshots) assert.equal(s.sha256.length, 64);

  // A manifest entry whose asset is gone is dropped.
  const { entries, dropped } = reconcile(m, f.assetsOf('state-snapshots').filter((a) => a.name !== m.snapshots[1].name));
  assert.deepEqual(dropped, [m.snapshots[1].name]);
  assert.equal(entries.length, 1);
});

test('R-SNAP-05: pruned snapshots are deleted only after the manifest that drops them is written', async () => {
  const f = fakeGh();
  let t = T0 - 60 * HOUR;
  let last;
  for (let i = 0; i < KEEP_RECENT + 3; i++) {
    f.pushState(cipher(`g${i}`));
    t += HOUR;
    const start = f.gh.calls.length;
    const ids = new Map(f.assetsOf('state-snapshots').map((a) => [a.name, a.id]));
    const r = await runSnapshot({ gh: f.gh, now: () => t });
    last = { r, ids, calls: f.gh.calls.slice(start) };
  }
  assert.equal(last.r.pruned.length, 1);
  const renameAt = last.calls.findIndex((c) => c[0] === 'rename' && c[2] === 'manifest.json');
  assert.ok(renameAt > 0);
  for (const name of last.r.pruned) {
    const at = last.calls.findIndex((c) => c[0] === 'delete' && c[1] === last.ids.get(name));
    assert.ok(at > renameAt, `${name} deleted after the manifest was written`);
  }
  const m = f.manifestOf();
  const snaps = f.assetsOf('state-snapshots').filter((a) => a.name.startsWith('state-')).map((a) => a.name).sort();
  assert.deepEqual(snaps, m.snapshots.map((s) => s.name).sort(), 'every asset is in the manifest and every entry has an asset');
  assert.equal(m.snapshots.length, KEEP_RECENT);
});

test('the release client sends the token to the API only, never to the storage host', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization ?? null });
    if (url.includes('/releases/assets/')) return new Response(null, { status: 302, headers: { location: 'https://objects.example/blob' } });
    return new Response(Buffer.from('bytes'), { status: 200 });
  };
  const gh = createReleaseClient({ repo: 'o/r', token: 'tok123', fetch });
  const b = await gh.download({ id: 5 });
  assert.equal(b.toString(), 'bytes');
  assert.equal(seen[0].auth, 'Bearer tok123');
  assert.equal(seen[1].url, 'https://objects.example/blob');
  assert.equal(seen[1].auth, null);
  const failing = createReleaseClient({ repo: 'o/r', token: 'tok123', fetch: async () => new Response('bad tok123', { status: 403 }) });
  await assert.rejects(failing.getRelease('state'), (err) => !String(err.message).includes('tok123'));
});
