// The coverage block of the live snapshot (live/build.mjs, state/coverage.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildLiveSnapshot, MAX_SNAPSHOT_BYTES } from '../build.mjs';
import { addResult, addSubject, config, emptyState } from './seed.mjs';
import { recordTruth } from '../../state/coverage.mjs';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const tiers = JSON.parse(readFileSync(new URL('../../pump/tiers.json', import.meta.url), 'utf8'));
const cfg = () => ({ ...config(), tiers });

function state() {
  const db = emptyState();
  for (let i = 0; i < 6; i++) addSubject(db, { id: `s${i}`, tier: i < 2 ? 0 : 2, at: NOW - 86_400_000 });
  addResult(db, { subject: 's0', workflow: 'live-probe', at: NOW - 3_600_000, runKey: 'a'.repeat(63) + '1' });
  addResult(db, { subject: 's1', workflow: 'live-probe', at: NOW - 3_600_000, runKey: 'a'.repeat(63) + '2', coverage: 'unassessed_tool' });
  addResult(db, { subject: 's2', workflow: 'live-probe', at: NOW - 3_600_000, runKey: 'a'.repeat(63) + '3' });
  return db;
}

test('R-COV-40: the live snapshot carries the coverage block as its last key, and every earlier key is where it was', () => {
  const { snapshot, problems } = buildLiveSnapshot(state(), { now: NOW, config: cfg() });
  const keys = Object.keys(snapshot);
  assert.equal(keys.at(-1), 'coverage');
  assert.deepEqual(keys.slice(0, -1), ['schema', 'seq', 'generated_at', 'version', 'mode', 'mode_reason', 'pump', 'retry', 'breaker', 'lanes', 'history', 'edges', 'publish', 'counts', 'now_checking', 'just_checked', 'recent']);
  assert.equal(snapshot.schema, 'isokron-loop-live/1', 'the schema name is unchanged: the change is additive');
  assert.deepEqual(problems, []);
  const L = snapshot.coverage.lanes.find((l) => l.id === 'live-probe');
  assert.equal(L.frame, 6);
  assert.equal(L.assessed, 2);
  assert.equal(L.assessment, 0.3333);
  assert.equal(snapshot.coverage.frame.size, 6);
  assert.match(snapshot.coverage.frame.version, /^derived-[0-9a-f]{8}$/);
});

test('R-COV-41: the snapshot says not yet measurable with null, never 100%, until a judgment exists, then reports it', () => {
  const db = state();
  let L = buildLiveSnapshot(db, { now: NOW, config: cfg() }).snapshot.coverage.lanes.find((l) => l.id === 'live-probe');
  assert.deepEqual([L.conditional, L.frame_coverage, L.gross, L.judged], [null, null, null, 0]);
  recordTruth(db, [{ run_key: 'a'.repeat(63) + '1', state: 'correct', source: 'qa_gate' }, { run_key: 'a'.repeat(63) + '3', state: 'incorrect', source: 'qa_gate' }], { now: NOW });
  L = buildLiveSnapshot(db, { now: NOW, config: cfg() }).snapshot.coverage.lanes.find((l) => l.id === 'live-probe');
  assert.deepEqual([L.judged, L.correct, L.incorrect, L.conditional, L.frame_coverage, L.gross], [2, 1, 1, 0.5, 0.1667, 0.1667]);
});

test('R-COV-42: a snapshot built without tiers, or from a state the coverage cannot read, still builds, with coverage null', () => {
  const db = state();
  assert.equal(buildLiveSnapshot(db, { now: NOW, config: config() }).snapshot.coverage, null);
  const broken = { ...config(), tiers: { get tiers() { throw new Error('unreadable'); } } };
  const out = buildLiveSnapshot(db, { now: NOW, config: broken });
  assert.equal(out.snapshot.coverage, null);
  assert.equal(out.snapshot.lanes.length > 0, true, 'the rest of the snapshot is built');
});

test('R-COV-43: the coverage block passes the public scan and leaves room under the snapshot size limit even with 1000 subjects', () => {
  const db = emptyState();
  for (let i = 0; i < 1000; i++) addSubject(db, { id: `s${i}`, tier: i < 5 ? 0 : i < 20 ? 1 : i < 70 ? 2 : 3, at: NOW - 86_400_000 });
  for (let i = 0; i < 400; i++) addResult(db, { subject: `s${i}`, workflow: 'scan-static', at: NOW - 3_600_000, runKey: String(i).padStart(64, 'b') });
  const out = buildLiveSnapshot(db, { now: NOW, config: cfg() });
  assert.deepEqual(out.problems, []);
  assert.ok(Buffer.byteLength(JSON.stringify(out.snapshot.coverage)) < 2500);
  assert.ok(Buffer.byteLength(JSON.stringify(out.snapshot)) < MAX_SNAPSHOT_BYTES);
});
