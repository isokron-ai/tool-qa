import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeGh } from '../../snapshot/test/fake-github.mjs';
import { keepCheck, markerCheck, MARKER_GRACE_MS, readKeepStatus, sealCheck } from '../health.mjs';

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

test('R-WD-14: every failed keep-forever file has its gap marker artifact: a lost marker is red, one that cannot be matched amber, a matched or recent one green', () => {
  const gap = (attempt, run, agoMs) => ({ attempt, run, at: iso(NOW - agoMs) });
  const seal = (...keep_gaps) => ({ at: iso(NOW), sealed: 9, failures: { compress: 0, keep: keep_gaps.length }, streak: 0, keep_gaps });
  const art = (name, agoMs = 10 * HOUR) => ({ name, created_at: iso(NOW - agoMs), expired: false });
  const reach = art('ingest-1-1', 20 * HOUR); // the list reaches back 20 hours
  const judge2 = (s, artifacts) => markerCheck({ now: NOW, seal: s, artifacts });
  assert.equal(judge2(null, []).status, 'green', 'no record: nothing failed');
  assert.equal(judge2(seal(), [reach]).status, 'green');
  // Matched: the marker artifact of the run is there.
  assert.equal(judge2(seal(gap('att-1-0', '77-1', 5 * HOUR)), [reach, art('ingest-keepgap-77-1', 5 * HOUR)]).status, 'green');
  // Lost: an hour on, and the list reaches back past the seal: red, and it names the item.
  const lost = judge2(seal(gap('att-1-0', '77-1', 5 * HOUR)), [reach]);
  assert.equal(lost.status, 'red');
  assert.match(lost.summary, /att-1-0 \(run 77-1\)/);
  // An expired marker artifact is no marker.
  assert.equal(judge2(seal(gap('att-1-0', '77-1', 5 * HOUR)), [reach, { ...art('ingest-keepgap-77-1'), expired: true }]).status, 'red');
  // A marker of another run does not count.
  assert.equal(judge2(seal(gap('att-1-0', '77-1', 5 * HOUR)), [reach, art('ingest-keepgap-77-2')]).status, 'red');
  // The pump run is still going (the marker uploads when it ends): waiting, not red.
  assert.equal(judge2(seal(gap('att-1-0', '77-1', MARKER_GRACE_MS - 60_000)), [reach]).status, 'green');
  assert.equal(judge2(seal(gap('att-1-0', '77-1', MARKER_GRACE_MS + 60_000)), [reach]).status, 'red');
  // No run id recorded: cannot be matched, amber. A seal older than the list reaches: amber.
  assert.equal(judge2(seal(gap('att-1-0', null, 5 * HOUR)), [reach]).status, 'amber');
  assert.equal(judge2(seal(gap('att-1-0', '77-1', 30 * HOUR)), [reach]).status, 'amber');
  // ... unless the list holds the same run's other uploads, which shows the upload steps ran and the marker is missing.
  assert.equal(judge2(seal(gap('att-1-0', '77-1', 30 * HOUR)), [art('ingest-77-1', 29 * HOUR)]).status, 'red');
  assert.equal(judge2(seal(gap('att-1-0', '77-1', 5 * HOUR)), [art('ingest-keep-77-1', 4 * HOUR)]).status, 'red');
  assert.equal(judge2(seal(gap('att-1-0', '77-1', 5 * HOUR)), []).status, 'amber', 'an empty artifact list proves nothing');
  // Red beats amber when both are there; old failures (over 2 days) are no longer judged; a broken record is amber, never a throw.
  assert.equal(judge2(seal(gap('a', null, 5 * HOUR), gap('b', '77-1', 5 * HOUR)), [reach]).status, 'red');
  assert.equal(judge2(seal(gap('a', '77-1', 3 * DAY)), [reach]).status, 'green');
  assert.equal(markerCheck({ now: NOW, seal: { get keep_gaps() { throw new Error('boom'); } }, artifacts: [] }).status, 'amber');
});
