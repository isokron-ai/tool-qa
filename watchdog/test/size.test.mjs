// The state-size item of the loop health issue (watchdog/size.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SIZE_THRESHOLDS, humanBytes, sizeCheck } from '../size.mjs';
import { evaluate } from '../checks.mjs';

const MiB = 1024 ** 2;
const size = (bytes, extra = {}) => ({ at: '2026-11-24T05:00:00.000Z', bytes, rows: { attempts: 10, dispatch_items: 12, results: 30, run_keys: 20 }, asset_bytes: Math.round(bytes / 4), prune: { status: 'pruned', deleted: 40, staged: 0 }, ...extra });

test('green under 256 MiB, amber over it, red over 768 MiB, on the database or the asset, whichever is bigger', () => {
  assert.equal(sizeCheck({ size: size(4 * MiB) }).status, 'green');
  assert.equal(sizeCheck({ size: size(SIZE_THRESHOLDS.amberBytes + 1) }).status, 'amber');
  assert.equal(sizeCheck({ size: size(SIZE_THRESHOLDS.redBytes + 1) }).status, 'red');
  assert.equal(sizeCheck({ size: size(4 * MiB), asset: { bytes: SIZE_THRESHOLDS.amberBytes + 1 } }).status, 'amber');
  const item = sizeCheck({ size: size(4_100_000) });
  assert.equal(item.id, 'state-size');
  assert.match(item.summary, /database 4\.1 MB \(asset 1\.0 MB\)/);
  assert.match(item.summary, /attempts 10, dispatch_items 12, results 30, run_keys 20/);
  assert.match(item.summary, /last prune: pruned, deleted 40 rows/);
});

test('the snapshot release: amber over 2 GB, red over 6 GB', () => {
  const s = (total) => sizeCheck({ size: size(MiB), snapshots: { total_bytes: total, count: 40 } });
  assert.equal(s(1e9).status, 'green');
  assert.match(s(1e9).summary, /snapshots 1\.0 GB in 40 files/);
  assert.equal(s(2.1e9).status, 'amber');
  assert.equal(s(6.1e9).status, 'red');
});

test('a failed or given-up prune pass is amber; a pump run with no size recorded is amber; before any run it is green', () => {
  assert.equal(sizeCheck({ size: size(MiB, { prune: { status: 'error', error: 'HTTP 502' } }) }).status, 'amber');
  assert.match(sizeCheck({ size: size(MiB, { prune: { status: 'error', error: 'HTTP 502' } }) }).summary, /last prune pass failed: HTTP 502/);
  assert.equal(sizeCheck({ size: size(MiB, { prune: { status: 'abandoned' } }) }).status, 'amber');
  assert.equal(sizeCheck({ size: size(MiB, { prune: { status: 'waiting' } }) }).status, 'green');
  assert.equal(sizeCheck({ size: null, lastRun: { finished: 'x' } }).status, 'amber');
  assert.equal(sizeCheck({ size: null, lastRun: null }).status, 'green');
});

test('sizeCheck never throws', () => {
  const hostile = { get bytes() { throw new Error('boom'); } };
  assert.equal(sizeCheck({ size: hostile }).status, 'amber');
  assert.equal(humanBytes(NaN), '?');
  assert.equal(humanBytes(999), '999 B');
});

test('evaluate shows the state-size item with the snapshot release total when the state was read', () => {
  const state = { openSlots: [], openDispatches: [], kv: { 'state.size': size(MiB) }, asset: { bytes: 300_000 } };
  const { checks } = evaluate({ now: Date.parse('2026-11-24T05:10:00Z'), slots: 0, state, snapshot: { manifest: null, missing: 'manifest', total_bytes: 5e8, count: 12 } });
  const item = checks.find((c) => c.id === 'state-size');
  assert.equal(item.status, 'green');
  assert.match(item.summary, /asset 300 KB/);
  assert.match(item.summary, /snapshots 500\.0 MB in 12 files/);
  assert.equal(evaluate({ now: 0, slots: 0, state: null }).checks.some((c) => c.id === 'state-size'), false, 'not shown when the state could not be read');
});
