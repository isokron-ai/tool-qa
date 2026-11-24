import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSnapshotManifest, snapshotCheck } from '../health.mjs';
import { runSnapshot } from '../snapshot.mjs';
import { cipher, fakeGh } from './fake-github.mjs';

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-11-24T12:41:00Z');
const manifest = (currentAt) => ({
  version: 1,
  current_at: new Date(currentAt).toISOString(),
  snapshots: [{ name: 'state-20261124T010000Z-0123abcd.sqlite.age', created: '2026-11-24T01:00:00Z', sha256: 'a'.repeat(64), size: 1 }],
});

test('R-SNAP-08: the snapshot health item is green to 3 hours, amber to 6, red after', () => {
  const at = (h) => snapshotCheck({ now: T0, manifest: manifest(T0 - h * HOUR) }).status;
  assert.equal(at(0.5), 'green');
  assert.equal(at(3), 'green');
  assert.equal(at(3.1), 'amber');
  assert.equal(at(6), 'amber');
  assert.equal(at(6.1), 'red');
  assert.equal(at(48), 'red');
  const item = snapshotCheck({ now: T0, manifest: manifest(T0 - 4 * HOUR) });
  assert.equal(item.id, 'state-snapshot');
  assert.match(item.summary, /state-20261124T010000Z-0123abcd\.sqlite\.age.*4\.0 hours ago/);
});

test('R-SNAP-08: age is measured from current_at, so an idle loop with running snapshots stays green', () => {
  // The newest snapshot file is 30 hours old, but a run confirmed it an hour ago.
  assert.equal(snapshotCheck({ now: T0, manifest: manifest(T0 - HOUR) }).status, 'green');
  // A manifest without current_at falls back to the newest snapshot's time.
  const m = manifest(T0);
  delete m.current_at;
  assert.equal(snapshotCheck({ now: T0, manifest: m }).status, 'red');
});

test('R-SNAP-08: no snapshot yet or an unreadable manifest is amber; a lane switched off is off', () => {
  assert.equal(snapshotCheck({ now: T0, manifest: null }).status, 'amber');
  assert.equal(snapshotCheck({ now: T0, manifest: { version: 1, snapshots: [] } }).status, 'amber');
  assert.equal(snapshotCheck({ now: T0, manifest: null, error: 'HTTP 500' }).status, 'amber');
  assert.equal(snapshotCheck({ now: T0, manifest: manifest(T0 - 48 * HOUR), laneOn: false }).status, 'off');
});

test('readSnapshotManifest reads what a snapshot run wrote', async () => {
  const f = fakeGh();
  assert.deepEqual(await readSnapshotManifest(f.gh), { manifest: null });
  f.pushState(cipher('g1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  const { manifest: m } = await readSnapshotManifest(f.gh);
  assert.equal(m.snapshots.length, 1);
  assert.equal(snapshotCheck({ now: T0 + HOUR, manifest: m }).status, 'green');
});
