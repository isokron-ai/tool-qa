import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { planPrune, pruneLimits, runPrune } from '../prune.mjs';
import { fakeS3 } from './fake-s3.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00Z');
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const obj = (key, size, daysAgo) => ({ key, size, lastModified: at(daysAgo) });

test('R-OFF-10: the prune plan deletes only past the 30-day lock, history first and oldest first, never the newest snapshots or the run manifests', () => {
  const objects = [
    obj('history/2026-04-01/h1/h1.zip', 100, 61),
    obj('history/2026-04-20/h2/h2.zip', 100, 42),
    obj('history/2026-05-20/h3/h3.zip', 100, 12), // locked
    obj('ingest/2026-04-02/i1/i1.zip', 100, 60),
    obj('ingest/2026-04-25/i2/i2.zip', 100, 37),
    obj('manifest/2026-04-01/x.ndjson', 100, 61),
    obj('snapshots/2026-04-01/state-20260401T000000Z-aaaaaaaa.sqlite.age', 100, 61),
    obj('snapshots/2026-04-02/state-20260402T000000Z-bbbbbbbb.sqlite.age', 100, 60),
  ];
  const nothing = planPrune(objects, { now: NOW, at: 1000, to: 500 });
  assert.equal(nothing.needed, false);
  assert.deepEqual(nothing.delete, []);
  // 800 bytes, prune above 700 down to 450: history first (oldest first), then ingest.
  const p = planPrune(objects, { now: NOW, at: 700, to: 450, keepSnapshots: 1 });
  assert.deepEqual(p.delete.map((o) => o.key), ['history/2026-04-01/h1/h1.zip', 'history/2026-04-20/h2/h2.zip', 'ingest/2026-04-02/i1/i1.zip', 'ingest/2026-04-25/i2/i2.zip']);
  assert.equal(p.after, 400);
  assert.equal(p.reachesTarget, true);
  // Down to nothing: the locked object, the manifest and the newest snapshot stay.
  const all = planPrune(objects, { now: NOW, at: 1, to: 1, keepSnapshots: 1 });
  const gone = new Set(all.delete.map((o) => o.key));
  assert.ok(!gone.has('history/2026-05-20/h3/h3.zip'), 'still under the lock');
  assert.ok(!gone.has('manifest/2026-04-01/x.ndjson'), 'run manifests are kept');
  assert.ok(!gone.has('snapshots/2026-04-02/state-20260402T000000Z-bbbbbbbb.sqlite.age'), 'the newest snapshot is kept');
  assert.ok(gone.has('snapshots/2026-04-01/state-20260401T000000Z-aaaaaaaa.sqlite.age'));
  assert.equal(all.reachesTarget, false);
  // An object 30 days and a few hours old is still inside the day of margin.
  assert.equal(planPrune([obj('history/a', 10, 30.5)], { now: NOW, at: 1, to: 1 }).delete.length, 0);
  // Default thresholds follow the cap.
  assert.deepEqual(pruneLimits({}, 8e9), { at: 6.8e9, to: 5.6e9, keepSnapshots: 48 });
});

test('R-OFF-10: a dry run deletes nothing; apply deletes the plan; the workflow keeps prune off unless OFFSITE_PRUNE_ENABLED is true', async () => {
  const s3 = fakeS3({ now: () => NOW });
  s3.seed('history/old/old.zip', Buffer.alloc(600), { lastModified: at(40) });
  s3.seed('ingest/new/new.zip', Buffer.alloc(300), { lastModified: at(2) });
  const dry = await runPrune({ store: s3, mode: 'dry-run', limits: { at: 800, to: 500 }, now: () => NOW });
  assert.deepEqual(dry.plan.delete.map((o) => o.key), ['history/old/old.zip']);
  assert.equal(s3.ops('delete').length, 0);
  const applied = await runPrune({ store: s3, mode: 'apply', limits: { at: 800, to: 500 }, now: () => NOW });
  assert.deepEqual(applied.deleted, ['history/old/old.zip']);
  assert.ok(!s3.objects.has('history/old/old.zip'));
  assert.ok(s3.objects.has('ingest/new/new.zip'));
  const yml = readFileSync(new URL('../../.github/workflows/offsite-backup.yml', import.meta.url), 'utf8');
  const job = yml.slice(yml.indexOf('\n  prune:\n'));
  assert.match(job, /vars\.OFFSITE_PRUNE_ENABLED == 'true' && \(github\.event_name == 'schedule' \|\| inputs\.prune == 'apply'\)/);
  assert.match(job, /github\.event_name == 'workflow_dispatch' && inputs\.prune == 'dry-run'/);
  assert.match(job, /MODE: \$\{\{ \(vars\.OFFSITE_PRUNE_ENABLED == 'true' && inputs\.prune != 'dry-run'\) && 'apply' \|\| 'dry-run' \}\}/);
  assert.match(yml, /default: 'off'/);
});
