import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openState } from '../../state/db.mjs';
import { acquireDispatchSlot, computeBudget, leaseTtlMs, occupancy, reapExpired, releaseOnResult } from '../slots.mjs';

const T0 = Date.parse('2026-03-02T10:00:00Z');
const MIN = 60_000;

test('LOOP_SLOTS counts worker slots; the pump takes one more and the loop stays within 15', () => {
  assert.deepEqual(computeBudget({ loopSlots: 0 }), { requested: 0, loopBudget: 0, workerSlots: 0 });
  assert.deepEqual(computeBudget({ loopSlots: 5 }), { requested: 5, loopBudget: 15, workerSlots: 5 });
  assert.deepEqual(computeBudget({ loopSlots: 15 }), { requested: 15, loopBudget: 15, workerSlots: 14 });
  assert.deepEqual(computeBudget({ loopSlots: 40 }), { requested: 15, loopBudget: 15, workerSlots: 14 });
  assert.deepEqual(computeBudget({ loopSlots: -3 }), { requested: 0, loopBudget: 0, workerSlots: 0 });
  assert.deepEqual(computeBudget({ loopSlots: 'abc' }), { requested: 0, loopBudget: 0, workerSlots: 0 });
});

test('other running jobs shrink the loop budget: max(1, min(15, 20 - others - 2))', () => {
  assert.deepEqual(computeBudget({ loopSlots: 15, nonLoopRunning: 10 }), { requested: 15, loopBudget: 8, workerSlots: 7 });
  assert.deepEqual(computeBudget({ loopSlots: 3, nonLoopRunning: 10 }), { requested: 3, loopBudget: 8, workerSlots: 3 });
  // Everything busy: the pump keeps its own place but dispatches nothing.
  assert.deepEqual(computeBudget({ loopSlots: 15, nonLoopRunning: 19 }), { requested: 15, loopBudget: 1, workerSlots: 0 });
});

test('the lease TTL is 1.5 times the expected shard time plus 10 minutes', () => {
  const wf = { setup_minutes: 3, shard_size: 10, minutes_per_subject: 2 };
  assert.equal(leaseTtlMs(wf), Math.round((1.5 * 23 + 10) * MIN));
  assert.equal(leaseTtlMs(wf, 2), Math.round((1.5 * 7 + 10) * MIN), 'a short shard gets a shorter lease');
});

test('slots are handed out up to the worker budget only', () => {
  const db = openState(':memory:');
  assert.equal(acquireDispatchSlot(db, { attemptId: 'a1', workerSlots: 2, ttlMs: 30 * MIN, now: T0 }), 0);
  assert.equal(acquireDispatchSlot(db, { attemptId: 'a2', workerSlots: 2, ttlMs: 30 * MIN, now: T0 }), 1);
  assert.equal(acquireDispatchSlot(db, { attemptId: 'a3', workerSlots: 2, ttlMs: 30 * MIN, now: T0 }), null);
  assert.equal(acquireDispatchSlot(db, { attemptId: 'a4', workerSlots: 0, ttlMs: 30 * MIN, now: T0 }), null);
  assert.equal(occupancy(db, { now: T0 }).slots, 2);
  db.close();
});

function openDispatch(db, attemptId, ttlMs, now = T0) {
  const slot = acquireDispatchSlot(db, { attemptId, workerSlots: 3, ttlMs, now });
  const lease = db.acquireLease(`key-${attemptId}`, attemptId, { ttlMs, now });
  db.createDispatch({
    attemptId, shardId: `s-${attemptId}`, workflow: 'scan-static', repo: 'isokron-ai/scan-static', workflowFile: 'scan.yml',
    ref: 'main', expires: now + ttlMs, items: [{ run_key: `key-${attemptId}`, subject: `npm:${attemptId}`, fence: lease.fence }], now,
  });
  db.markDispatched(attemptId, { runId: 1 });
  return slot;
}

test('a crashed worker never reports: its slot and dispatch are reaped at expiry', () => {
  const db = openState(':memory:');
  openDispatch(db, 'crash', 20 * MIN);
  openDispatch(db, 'live', 60 * MIN);
  let r = reapExpired(db, { now: T0 + 19 * MIN });
  assert.deepEqual(r, { dispatches: [], slots: 0 });
  r = reapExpired(db, { now: T0 + 21 * MIN });
  assert.deepEqual(r.dispatches.map((d) => d.attempt_id), ['crash']);
  assert.equal(db.getDispatch('crash').status, 'expired');
  const occ = occupancy(db, { now: T0 + 21 * MIN });
  assert.equal(occ.slots, 1);
  assert.deepEqual(occ.dispatches.map((d) => d.attempt_id), ['live']);
  // The freed slot is handed out again.
  assert.equal(acquireDispatchSlot(db, { attemptId: 'next', workerSlots: 2, ttlMs: 20 * MIN, now: T0 + 21 * MIN }), 0);
  db.close();
});

test('a pump that crashed before recording a dispatch leaves only a slot row, which expires', () => {
  const db = openState(':memory:');
  acquireDispatchSlot(db, { attemptId: 'orphan', workerSlots: 1, ttlMs: 10 * MIN, now: T0 });
  assert.equal(acquireDispatchSlot(db, { attemptId: 'x', workerSlots: 1, ttlMs: 10 * MIN, now: T0 + 5 * MIN }), null);
  const r = reapExpired(db, { now: T0 + 11 * MIN });
  assert.equal(r.slots, 1);
  assert.equal(acquireDispatchSlot(db, { attemptId: 'x', workerSlots: 1, ttlMs: 10 * MIN, now: T0 + 11 * MIN }), 0);
  db.close();
});

test('releaseOnResult frees the slot as soon as the run is over', () => {
  const db = openState(':memory:');
  openDispatch(db, 'a1', 60 * MIN);
  assert.equal(releaseOnResult(db, 'a1', { reason: 'run_failed', now: T0 + 5 * MIN }), true);
  assert.equal(occupancy(db, { now: T0 + 5 * MIN }).slots, 0);
  assert.equal(db.getDispatch('a1').close_reason, 'run_failed');
  assert.equal(releaseOnResult(db, 'a1', { now: T0 + 6 * MIN }), false);
  db.close();
});
