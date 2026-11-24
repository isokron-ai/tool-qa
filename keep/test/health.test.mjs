import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeGh } from '../../snapshot/test/fake-github.mjs';
import { keepCheck, readKeepStatus, sealCheck } from '../health.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const status = (over = {}) => ({ version: 1, at: iso(NOW - HOUR), status: 'ok', last_ok_at: iso(NOW - HOUR), copied: { artifacts: 2, bytes: 100 }, pending: { count: 0, oldest_at: null }, ...over });
const judge = (s, over = {}) => keepCheck({ now: NOW, status: s, ...over });

test('R-RET-17: the keep-forever copy is green while a good run is under 12 hours old, amber to 24, red after', () => {
  assert.equal(judge(status()).status, 'green');
  assert.equal(judge(status({ last_ok_at: iso(NOW - 13 * HOUR) })).status, 'amber');
  assert.equal(judge(status({ last_ok_at: iso(NOW - 25 * HOUR) })).status, 'red');
  assert.equal(judge(status({ last_ok_at: null, status: 'error', reason: 'x' })).status, 'amber', 'no good run yet');
});

test('R-RET-17: a run that failed shows amber even when the last good run is recent', () => {
  const j = judge(status({ status: 'error', reason: '1 item(s) could not be copied: month 2026-11: boom' }));
  assert.equal(j.status, 'amber');
  assert.match(j.summary, /the last run failed: 1 item/);
});

test('R-RET-17: a stalled copy shows: an artifact waiting over 30 days is amber, over 60 days red (GitHub deletes at 90), even with fresh good runs', () => {
  assert.equal(judge(status({ pending: { count: 2, oldest_at: iso(NOW - 10 * DAY) } })).status, 'green');
  const amber = judge(status({ pending: { count: 2, oldest_at: iso(NOW - 31 * DAY) } }));
  assert.equal(amber.status, 'amber');
  assert.match(amber.summary, /2 artifact\(s\) wait to be copied, the oldest for 31 days/);
  assert.equal(judge(status({ pending: { count: 1, oldest_at: iso(NOW - 61 * DAY) } })).status, 'red');
});

test('R-RET-17: not run yet, unreadable, switched off, or a status from the future is not green; nothing here throws', () => {
  assert.equal(judge(null, { missing: 'release' }).status, 'amber');
  assert.equal(judge(null, { missing: 'status' }).status, 'amber');
  assert.equal(judge(null, { error: 'HTTP 500' }).status, 'amber');
  assert.equal(judge(status(), { laneOn: false }).status, 'off');
  assert.equal(judge(status({ last_ok_at: iso(NOW + DAY) })).status, 'amber');
  assert.equal(keepCheck({ now: NOW, status: { pending: 5 }, get laneOn() { throw new Error('boom'); } }).status, 'amber');
});

test('R-RET-17: readKeepStatus reads the newest status revision from the release, and says what is missing', async () => {
  const f = fakeGh();
  assert.deepEqual(await readKeepStatus(f.gh), { missing: 'release' });
  await f.gh.createRelease({ tag: 'keep-forever' });
  assert.deepEqual(await readKeepStatus(f.gh), { missing: 'status' });
  f.addAsset('keep-forever', 'status.r0001.json', Buffer.from(JSON.stringify(status({ copied: { artifacts: 1, bytes: 1 } }))));
  f.addAsset('keep-forever', 'status.r0002.json', Buffer.from(JSON.stringify(status({ copied: { artifacts: 7, bytes: 1 } }))));
  assert.equal((await readKeepStatus(f.gh)).status.copied.artifacts, 7);
});

test('R-RET-18: the seal item is amber after one failed compression or keep-forever file, red after three in a row, green again once a seal is clean', () => {
  const seal = (over = {}) => ({ at: iso(NOW), sealed: 10, bytes_in: 1000, bytes_out: 100, failures: { compress: 0, keep: 0 }, streak: 0, last_failure: null, ...over });
  assert.equal(sealCheck(null).status, 'green');
  assert.equal(sealCheck(seal()).status, 'green');
  assert.match(sealCheck(seal()).summary, /compressed 10\.0 to 1/);
  const one = sealCheck(seal({ streak: 1, failures: { compress: 1, keep: 0 }, last_failure: { kind: 'compress', error: 'zstd exploded' } }));
  assert.equal(one.status, 'amber');
  assert.match(one.summary, /compress: zstd exploded/);
  assert.equal(sealCheck(seal({ streak: 2 })).status, 'amber');
  assert.equal(sealCheck(seal({ streak: 3, last_failure: { kind: 'keep', error: 'disk full' } })).status, 'red');
  assert.equal(sealCheck('garbage').status, 'green', 'a record that is not an object is no record');
  assert.equal(sealCheck({ get streak() { throw new Error('boom'); } }).status, 'amber');
});
