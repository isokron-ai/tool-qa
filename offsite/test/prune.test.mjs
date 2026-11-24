import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, planPrune, pruneLimits, runPrune } from '../prune.mjs';
import { fakeS3 } from './fake-s3.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00Z');
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const obj = (key, size, daysAgo) => ({ key, size, lastModified: at(daysAgo) });

test('R-OFF-10: the prune plan deletes only past the 30-day lock, oldest first, never the keep-forever set, the newest snapshots or the run manifests', () => {
  const objects = [
    obj('history/2026-04-01/h1/h1.zip', 100, 61), // keep-forever: never
    obj('keep/2026-04-02/ingest-keep-1-1/ingest-keep-1-1.zip', 100, 60), // keep-forever: never
    obj('ingest/2026-04-02/ingest-1-1/ingest-1-1.zip', 100, 60),
    obj('ingest/2026-04-25/ingest-2-1/ingest-2-1.zip', 100, 37),
    obj('ingest/2026-05-20/ingest-3-1/ingest-3-1.zip', 100, 12), // locked
    obj('keep/2026-04-25/ingest-keep-2-1/ingest-keep-2-1.zip', 100, 37),
    obj('keep/2026-05-20/ingest-keep-3-1/ingest-keep-3-1.zip', 100, 12),
    obj('manifest/2026-04-01/x.ndjson', 100, 61),
    obj('snapshots/2026-04-01/state-20260401T000000Z-aaaaaaaa.sqlite.age', 100, 61),
    obj('snapshots/2026-04-02/state-20260402T000000Z-bbbbbbbb.sqlite.age', 100, 60),
  ];
  // Under the threshold, full bundles past their window still expire (they have their keep-forever copy).
  const expiry = planPrune(objects, { now: NOW, at: 10_000, to: 5000 });
  assert.deepEqual(expiry.delete.map((o) => o.key), ['ingest/2026-04-02/ingest-1-1/ingest-1-1.zip', 'ingest/2026-04-25/ingest-2-1/ingest-2-1.zip']);
  assert.equal(expiry.expired, 2);
  assert.equal(expiry.reachesTarget, true);
  // Over the threshold the cap pass goes on, oldest first: the old snapshot, never the newest one.
  const p = planPrune(objects, { now: NOW, at: 750, to: 700, keepSnapshots: 1 });
  assert.deepEqual(p.delete.map((o) => o.key), ['ingest/2026-04-02/ingest-1-1/ingest-1-1.zip', 'ingest/2026-04-25/ingest-2-1/ingest-2-1.zip', 'snapshots/2026-04-01/state-20260401T000000Z-aaaaaaaa.sqlite.age']);
  assert.equal(p.reachesTarget, true);
  // Down to nothing: nothing of the keep-forever set, the locked bundle, the manifest or the newest snapshot goes.
  const all = planPrune(objects, { now: NOW, at: 1, to: 1, keepSnapshots: 1 });
  const gone = new Set(all.delete.map((o) => o.key));
  for (const key of ['history/2026-04-01/h1/h1.zip', 'keep/2026-04-02/ingest-keep-1-1/ingest-keep-1-1.zip', 'keep/2026-04-25/ingest-keep-2-1/ingest-keep-2-1.zip']) assert.ok(!gone.has(key), `${key} is keep-forever`);
  assert.ok(!gone.has('ingest/2026-05-20/ingest-3-1/ingest-3-1.zip'), 'still under the lock');
  assert.ok(!gone.has('manifest/2026-04-01/x.ndjson'), 'run manifests are kept');
  assert.ok(!gone.has('snapshots/2026-04-02/state-20260402T000000Z-bbbbbbbb.sqlite.age'), 'the newest snapshot is kept');
  assert.equal(all.reachesTarget, false);
  // An object 30 days and a few hours old is still inside the day of margin.
  assert.equal(planPrune([obj('ingest/2026-05-01/ingest-4-1/ingest-4-1.zip', 10, 30.5), obj('keep/2026-05-01/ingest-keep-4-1/k.zip', 1, 30.5)], { now: NOW, at: 1, to: 1 }).delete.length, 0);
  // Default thresholds follow the cap.
  assert.deepEqual(pruneLimits({}, 8e9), { at: 6.8e9, to: 5.6e9, keepSnapshots: 48, legacy: false });
});

test('R-OFF-10: a dry run deletes nothing; apply deletes the plan; the workflow keeps prune off unless OFFSITE_PRUNE_ENABLED is true', async () => {
  const s3 = fakeS3({ now: () => NOW });
  s3.seed('ingest/2026-04-20/ingest-1-1/ingest-1-1.zip', Buffer.alloc(600), { lastModified: at(40) });
  s3.seed('keep/2026-04-20/ingest-keep-1-1/k.zip', Buffer.alloc(10), { lastModified: at(40) });
  s3.seed('ingest/new/new.zip', Buffer.alloc(300), { lastModified: at(2) });
  s3.seed('_state/cursor/20260530T000000Z-1-1.json', Buffer.from('{}'), { lastModified: at(2) });
  s3.seed('manifest/2026-05-30/x.ndjson', Buffer.from('{}'), { lastModified: at(2) });
  const dry = await runPrune({ store: s3, mode: 'dry-run', limits: { at: 800, to: 500 }, now: () => NOW });
  assert.deepEqual(dry.plan.delete.map((o) => o.key), ['ingest/2026-04-20/ingest-1-1/ingest-1-1.zip']);
  assert.equal(s3.ops('delete').length, 0);
  const applied = await runPrune({ store: s3, mode: 'apply', limits: { at: 800, to: 500 }, now: () => NOW });
  assert.deepEqual(applied.deleted, ['ingest/2026-04-20/ingest-1-1/ingest-1-1.zip']);
  assert.ok(!s3.objects.has('ingest/2026-04-20/ingest-1-1/ingest-1-1.zip'));
  assert.ok(s3.objects.has('keep/2026-04-20/ingest-keep-1-1/k.zip'), 'the keep-forever copy stays');
  assert.ok(s3.objects.has('ingest/new/new.zip'));
  const yml = readFileSync(new URL('../../.github/workflows/offsite-backup.yml', import.meta.url), 'utf8');
  const job = yml.slice(yml.indexOf('\n  prune:\n'));
  assert.match(job, /vars\.OFFSITE_PRUNE_ENABLED == 'true' && \(github\.event_name == 'schedule' \|\| inputs\.prune == 'apply'\)/);
  assert.match(job, /github\.event_name == 'workflow_dispatch' && inputs\.prune == 'dry-run'/);
  assert.match(job, /MODE: \$\{\{ \(vars\.OFFSITE_PRUNE_ENABLED == 'true' && inputs\.prune != 'dry-run'\) && 'apply' \|\| 'dry-run' \}\}/);
  assert.match(yml, /default: 'off'/);
});

test('R-OFF-13: apply refuses a listing that looks cut short, and the step summary never shows the credentials', async () => {
  const make = () => {
    const s3 = fakeS3({ now: () => NOW });
    s3.seed('_state/cursor/20260530T000000Z-1-1.json', Buffer.from('{}'), { lastModified: at(2) });
    s3.seed('ingest/2026-04-20/ingest-1-1/ingest-1-1.zip', Buffer.alloc(600), { lastModified: at(40) });
    s3.seed('keep/2026-04-20/ingest-keep-1-1/k.zip', Buffer.alloc(10), { lastModified: at(40) });
    s3.seed('manifest/2026-05-30/x.ndjson', Buffer.from('{}'), { lastModified: at(2) });
    return s3;
  };
  const limits = { at: 500, to: 100 };
  const ok = make();
  const r = await runPrune({ store: ok, mode: 'apply', limits, now: () => NOW });
  assert.deepEqual(r.deleted, ['ingest/2026-04-20/ingest-1-1/ingest-1-1.zip']);
  // Cut short after two keys: the newest manifest is missing, so nothing is deleted.
  const cut = make();
  cut.faults.truncateAt = 2;
  await assert.rejects(runPrune({ store: cut, mode: 'apply', limits, now: () => NOW }), /cut short/);
  assert.equal(cut.ops('delete').length, 0);
  // A listing that ends cleanly but lacks the tail (no token, not marked): caught by the newest keys.
  const quiet = make();
  const list = quiet.list.bind(quiet);
  quiet.list = async (o) => (o?.prefix ? list(o) : { items: (await list(o)).items.slice(0, 3), next: null, truncated: false });
  const rq = await runPrune({ store: quiet, mode: 'apply', limits, now: () => NOW });
  assert.match(rq.refused, /lacks the newest manifest\/ key/);
  assert.equal(quiet.ops('delete').length, 0);
  // No cursor at all: the backup never ran; apply refuses.
  const none = fakeS3({ now: () => NOW });
  none.seed('ingest/2026-04-20/ingest-1-1/ingest-1-1.zip', Buffer.alloc(600), { lastModified: at(40) });
  none.seed('keep/2026-04-20/ingest-keep-1-1/k.zip', Buffer.alloc(10), { lastModified: at(40) });
  assert.match((await runPrune({ store: none, mode: 'apply', limits, now: () => NOW })).refused, /no _state\/cursor\/ object/);
  // The dry run still plans.
  assert.equal((await runPrune({ store: cut, mode: 'dry-run', limits, now: () => NOW }).catch((e) => e)).message, 'the bucket listing was cut short (truncated, no continuation token)');

  // The summary is scrubbed: a delete refusal that names the key ID.
  const dir = mkdtempSync(join(tmpdir(), 'prune-'));
  try {
    const s3 = make();
    s3.delete = async () => { throw Object.assign(new Error('R2 DELETE failed: AccessDenied for AKIA_SYNTHETIC_PRUNE'), { status: 403 }); };
    const summary = join(dir, 'summary.md');
    const code = await main(['--mode', 'apply'], {
      R2_ACCOUNT_ID: 'c'.repeat(32), R2_BUCKET: 'isokron-loop-backup', R2_ACCESS_KEY_ID: 'AKIA_SYNTHETIC_PRUNE', R2_SECRET_ACCESS_KEY: 'synthetic-prune-secret',
      OFFSITE_PRUNE_AT_BYTES: '500', OFFSITE_PRUNE_TO_BYTES: '100', GITHUB_STEP_SUMMARY: summary,
    }, { store: s3, now: () => NOW });
    assert.equal(code, 1);
    const text = readFileSync(summary, 'utf8');
    assert.match(text, /FAILED ingest\/2026-04-20\/ingest-1-1\/ingest-1-1\.zip/);
    assert.ok(!text.includes('AKIA_SYNTHETIC_PRUNE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- loop upgrade 20: tiers, holds ----

import { parseHolds, isHeld } from '../holds.mjs';
import { readConfig } from '../backup.mjs';

const FULL = (n, daysAgo, size = 100) => obj(`ingest/2026-04-01/ingest-${n}-1/ingest-${n}-1.zip`, size, daysAgo);
const KEEP = (n, daysAgo) => obj(`keep/2026-04-01/ingest-keep-${n}-1/ingest-keep-${n}-1.zip`, 10, daysAgo);

test('R-RET-07: full bundles expire after 30 days whatever the bucket size, and only when their keep-forever copy is in the bucket', () => {
  const objects = [FULL(1, 40), KEEP(1, 40), FULL(2, 40), FULL(3, 5), KEEP(3, 5)];
  const p = planPrune(objects, { now: NOW, at: 1e9, to: 1e9 });
  assert.deepEqual(p.delete.map((o) => o.key), [FULL(1, 40).key], 'only the old one with a copy; #2 has no copy, #3 is young');
  assert.equal(p.expired, 1);
  assert.equal(p.kept.unpaired, 1);
  // A bucket far under the threshold still expires; nothing else is touched.
  assert.equal(p.reachesTarget, true);
  // With the knob, a bundle from before the upgrade goes too.
  const legacy = planPrune(objects, { now: NOW, at: 1e9, to: 1e9, legacy: true });
  assert.deepEqual(legacy.delete.map((o) => o.key).sort(), [FULL(1, 40).key, FULL(2, 40).key].sort());
});

test('R-RET-07: the cap pass takes the oldest full data first and never the keep-forever set, even when that leaves the bucket over its target', () => {
  const objects = [FULL(1, 20, 500), KEEP(1, 20), FULL(2, 35, 500), KEEP(2, 35), obj('history/2026-03-01/h/h.zip', 900, 90), obj('keep/2026-03-01/ingest-keep-9-1/k.zip', 900, 90),
    obj('snapshots/2026-03-01/state-20260301T000000Z-aaaaaaaa.sqlite.age', 100, 90), obj('snapshots/2026-03-02/state-20260302T000000Z-bbbbbbbb.sqlite.age', 100, 80)];
  const p = planPrune(objects, { now: NOW, at: 1000, to: 1000, keepSnapshots: 1 });
  const gone = p.delete.map((o) => o.key);
  assert.deepEqual(gone, [FULL(2, 35).key, 'snapshots/2026-03-01/state-20260301T000000Z-aaaaaaaa.sqlite.age'], 'full data first, oldest first; the young bundle (20 days) is under the lock');
  assert.ok(!gone.some((k) => k.startsWith('keep/') || k.startsWith('history/')));
  assert.equal(p.reachesTarget, false, 'the keep-forever set alone is over the target: red, not deleted');
});

test('R-RET-08: the hold list keeps an artifact past 30 days for 90 days (dispute, disclosure) or 548 (raw), and not a day longer', () => {
  const { holds, problems } = parseHolds(JSON.stringify({ holds: [
    { artifact: 'ingest-1-1', for: 'dispute', from: '2026-03-01' },
    { artifact: 'ingest-2-1', for: 'raw', from: '2026-03-01' },
    { artifact: 'ingest-3-1', for: 'disclosure', from: '2026-01-01' },
  ] }));
  assert.deepEqual(problems, []);
  const objects = [FULL(1, 70), KEEP(1, 70), FULL(2, 70), KEEP(2, 70), FULL(3, 70), KEEP(3, 70)];
  // 2026-06-01 is 92 days after 2026-03-01: the dispute hold (90 days) is over, the raw hold (548) is not; the disclosure one began 151 days ago.
  assert.equal(isHeld(FULL(1, 70).key, holds, NOW), false);
  assert.equal(isHeld(FULL(2, 70).key, holds, NOW), true);
  const p = planPrune(objects, { now: NOW, at: 1e9, to: 1e9, holds });
  assert.deepEqual(p.delete.map((o) => o.key).sort(), [FULL(1, 70).key, FULL(3, 70).key].sort());
  assert.equal(p.kept.held, 1);
  // The same hold is honoured by the cap pass, and the day before it ends it still holds.
  const early = planPrune(objects, { now: Date.parse('2026-05-29T00:00:00Z'), at: 1, to: 1, holds });
  assert.ok(!early.delete.some((o) => o.key === FULL(1, 70).key), 'a hold on day 89 still holds');
  assert.ok(!early.delete.some((o) => o.key === FULL(2, 70).key));
});

test('R-RET-08: a hold list that is not valid is refused, never read as "nothing held"; an unreadable file stops the prune', async () => {
  for (const bad of ['{', '{}', JSON.stringify({ holds: [{ artifact: '../x', for: 'raw', from: '2026-01-01' }] }), JSON.stringify({ holds: [{ artifact: 'a', for: 'whim', from: '2026-01-01' }] }), JSON.stringify({ holds: [{ artifact: 'a', for: 'raw', from: 'soon' }] })]) {
    assert.ok(parseHolds(bad).problems.length > 0, bad);
  }
  assert.deepEqual(parseHolds('{ "holds": [] }'), { holds: [], problems: [] });
  const s3 = fakeS3({ now: () => NOW });
  s3.seed('_state/cursor/20260530T000000Z-1-1.json', Buffer.from('{}'), { lastModified: at(2) });
  s3.seed('manifest/2026-05-30/x.ndjson', Buffer.from('{}'), { lastModified: at(2) });
  const code = await main(['--mode', 'apply'], {
    R2_ACCOUNT_ID: 'c'.repeat(32), R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', OFFSITE_HOLDS_FILE: '/nonexistent/holds.json',
  }, { store: s3, now: () => NOW });
  assert.equal(code, 1);
  assert.equal(s3.ops('delete').length, 0);
});

test('R-RET-09: the checked-in hold list is valid, and the backup does not send x-amz-checksum-sha256 unless asked (R2 refuses it with Content-MD5)', () => {
  const { problems } = parseHolds(readFileSync(new URL('../holds.json', import.meta.url), 'utf8'));
  assert.deepEqual(problems, []);
  const env = { R2_ACCOUNT_ID: 'c'.repeat(32), R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' };
  assert.equal(readConfig(env).sendSha256, false);
  assert.equal(readConfig({ ...env, OFFSITE_SHA256_HEADER: 'on' }).sendSha256, true);
  assert.equal(readConfig({ ...env, OFFSITE_SHA256_HEADER: 'off' }).sendSha256, false);
});
