import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState, StateDb, StaleFenceError, SCHEMA_VERSION } from '../state/db.mjs';

const T0 = Date.parse('2026-11-23T12:00:00Z');
const MIN = 60_000;

function fresh() {
  return openState(':memory:');
}

test('open creates the schema and records its version', () => {
  const db = fresh();
  assert.equal(db.schemaVersion(), SCHEMA_VERSION);
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of ['attempts', 'counters', 'leases', 'runs', 'slot_ledger', 'subjects']) assert.ok(tables.includes(t), t);
  db.close();
});

test('migrate is idempotent and state survives reopening a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  const file = join(dir, 'state.sqlite');
  const a = openState(file);
  const lease = a.acquireLease('s1', 'run-1', { ttlMs: 10 * MIN, now: T0 });
  a.close();
  const b = openState(file);
  b.migrate();
  assert.equal(b.schemaVersion(), SCHEMA_VERSION);
  assert.equal(b.getLease('s1').fence, lease.fence);
  b.close();
});

test('acquireLease gives a fence token and blocks a second holder', () => {
  const db = fresh();
  const a = db.acquireLease('subj', 'run-a', { ttlMs: 10 * MIN, now: T0 });
  assert.equal(a.acquired, true);
  assert.equal(a.fence, 1);
  assert.equal(a.expires, new Date(T0 + 10 * MIN).toISOString());
  const b = db.acquireLease('subj', 'run-b', { ttlMs: 10 * MIN, now: T0 + MIN });
  assert.equal(b.acquired, false);
  assert.equal(b.holder, 'run-a');
  assert.equal(b.fence, 1);
  db.close();
});

test('the same holder cannot take a second fence while its lease is live', () => {
  const db = fresh();
  db.acquireLease('subj', 'run-a', { ttlMs: 10 * MIN, now: T0 });
  assert.equal(db.acquireLease('subj', 'run-a', { ttlMs: 10 * MIN, now: T0 }).acquired, false);
  db.close();
});

test('fence tokens increase monotonically across expiry, release and subjects', () => {
  const db = fresh();
  const seen = [];
  seen.push(db.acquireLease('x', 'r1', { ttlMs: MIN, now: T0 }).fence);
  // Expired: a new holder takes over with a higher fence.
  seen.push(db.acquireLease('x', 'r2', { ttlMs: MIN, now: T0 + 2 * MIN }).fence);
  // Released: next acquire is higher again.
  assert.equal(db.releaseLease('x', 'r2', seen[1], { now: T0 + 2 * MIN }).released, true);
  seen.push(db.acquireLease('x', 'r3', { ttlMs: MIN, now: T0 + 2 * MIN }).fence);
  // Other subjects draw from the same counter.
  seen.push(db.acquireLease('y', 'r4', { ttlMs: MIN, now: T0 + 2 * MIN }).fence);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `fences ${seen}`);
  db.close();
});

test('renew extends a live lease for the current holder and fence', () => {
  const db = fresh();
  const { fence } = db.acquireLease('s', 'r1', { ttlMs: 10 * MIN, now: T0 });
  const r = db.renewLease('s', 'r1', fence, { ttlMs: 20 * MIN, now: T0 + 5 * MIN });
  assert.equal(r.renewed, true);
  assert.equal(r.expires, new Date(T0 + 25 * MIN).toISOString());
  assert.equal(db.getLease('s').expires, r.expires);
  db.close();
});

test('renew is refused for a wrong holder, a stale fence or an expired lease', () => {
  const db = fresh();
  const { fence } = db.acquireLease('s', 'r1', { ttlMs: 10 * MIN, now: T0 });
  assert.deepEqual(db.renewLease('s', 'r2', fence, { ttlMs: MIN, now: T0 }), { renewed: false, reason: 'holder_mismatch' });
  assert.deepEqual(db.renewLease('s', 'r1', fence + 1, { ttlMs: MIN, now: T0 }), { renewed: false, reason: 'unknown_fence' });
  assert.deepEqual(db.renewLease('s', 'r1', fence, { ttlMs: MIN, now: T0 + 10 * MIN }), { renewed: false, reason: 'lease_expired' });
  assert.deepEqual(db.renewLease('nope', 'r1', 1, { ttlMs: MIN, now: T0 }), { renewed: false, reason: 'no_lease' });
  db.close();
});

test('release frees the subject; a second release is refused', () => {
  const db = fresh();
  const { fence } = db.acquireLease('s', 'r1', { ttlMs: 10 * MIN, now: T0 });
  assert.deepEqual(db.releaseLease('s', 'r2', fence, { now: T0 }), { released: false, reason: 'holder_mismatch' });
  assert.deepEqual(db.releaseLease('s', 'r1', fence, { now: T0 }), { released: true });
  assert.deepEqual(db.releaseLease('s', 'r1', fence, { now: T0 }), { released: false, reason: 'lease_released' });
  assert.equal(db.getLease('s').holder, null);
  assert.equal(db.acquireLease('s', 'r2', { ttlMs: MIN, now: T0 }).acquired, true);
  db.close();
});

test('a stale holder cannot write after a newer lease is granted', () => {
  const db = fresh();
  const old = db.acquireLease('subj', 'run-old', { ttlMs: 10 * MIN, now: T0 });
  // run-old stalls past expiry; run-new takes the subject.
  const neu = db.acquireLease('subj', 'run-new', { ttlMs: 10 * MIN, now: T0 + 11 * MIN });
  assert.equal(neu.acquired, true);
  assert.ok(neu.fence > old.fence);

  // The late result from run-old is rejected and stored as a rejected attempt.
  const late = db.recordAttempt({ subject: 'subj', holder: 'run-old', fence: old.fence, runId: '111', digest: 'sha256:aa', now: T0 + 12 * MIN });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'stale_fence');

  // withFence refuses to run the write at all.
  let wrote = false;
  assert.throws(
    () => db.withFence('subj', old.fence, () => { wrote = true; }, { now: T0 + 12 * MIN }),
    (err) => err instanceof StaleFenceError && err.reason === 'stale_fence',
  );
  assert.equal(wrote, false);

  // The current holder's result is accepted.
  const ok = db.recordAttempt({ subject: 'subj', holder: 'run-new', fence: neu.fence, runId: '222', digest: 'sha256:bb', now: T0 + 13 * MIN });
  assert.equal(ok.accepted, true);
  assert.equal(ok.reason, null);

  // Every attempt is kept, accepted or not.
  const rows = db.listAttempts('subj');
  assert.deepEqual(rows.map((r) => [r.holder, r.fence, r.accepted, r.reason]), [
    ['run-old', old.fence, 0, 'stale_fence'],
    ['run-new', neu.fence, 1, null],
  ]);
  db.close();
});

test('a stale holder cannot renew or release the newer lease', () => {
  const db = fresh();
  const old = db.acquireLease('subj', 'run-old', { ttlMs: MIN, now: T0 });
  const neu = db.acquireLease('subj', 'run-new', { ttlMs: 10 * MIN, now: T0 + 2 * MIN });
  assert.equal(db.renewLease('subj', 'run-old', old.fence, { ttlMs: MIN, now: T0 + 3 * MIN }).reason, 'stale_fence');
  assert.equal(db.releaseLease('subj', 'run-old', old.fence, { now: T0 + 3 * MIN }).reason, 'stale_fence');
  assert.equal(db.getLease('subj').holder, 'run-new');
  assert.equal(db.getLease('subj').fence, neu.fence);
  db.close();
});

test('writes on an expired or released lease are rejected even with the latest fence', () => {
  const db = fresh();
  const a = db.acquireLease('e', 'r1', { ttlMs: MIN, now: T0 });
  assert.equal(db.recordAttempt({ subject: 'e', holder: 'r1', fence: a.fence, now: T0 + MIN }).reason, 'lease_expired');
  const b = db.acquireLease('f', 'r1', { ttlMs: MIN, now: T0 });
  db.releaseLease('f', 'r1', b.fence, { now: T0 });
  assert.equal(db.recordAttempt({ subject: 'f', holder: 'r1', fence: b.fence, now: T0 }).reason, 'lease_released');
  assert.equal(db.recordAttempt({ subject: 'g', holder: 'r1', fence: 1, now: T0 }).reason, 'no_lease');
  db.close();
});

test('withFence runs the write inside a transaction and rolls back on error', () => {
  const db = fresh();
  const { fence } = db.acquireLease('s', 'r1', { ttlMs: 10 * MIN, now: T0 });
  const v = db.withFence('s', fence, (raw) => {
    raw.prepare("INSERT INTO subjects (id, kind, source, first_seen, last_seen) VALUES ('s', 'repo', 'test', 'a', 'a')").run();
    return 42;
  }, { now: T0 });
  assert.equal(v, 42);
  assert.throws(() => db.withFence('s', fence, (raw) => {
    raw.prepare("INSERT INTO subjects (id, kind, source, first_seen, last_seen) VALUES ('t', 'repo', 'test', 'a', 'a')").run();
    throw new Error('boom');
  }, { now: T0 }), /boom/);
  const ids = db.raw.prepare('SELECT id FROM subjects ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, ['s']);
  db.close();
});

test('lease ttl must be a positive whole number of milliseconds', () => {
  const db = fresh();
  for (const ttlMs of [0, -1, 1.5, NaN, undefined]) {
    assert.throws(() => db.acquireLease('s', 'r', { ttlMs, now: T0 }), /ttlMs/);
  }
  db.close();
});

test('upsertSubject keeps first_seen and moves last_seen', () => {
  const db = fresh();
  db.upsertSubject({ id: 'gh:1', kind: 'repo', source: 'registry', now: T0 });
  db.upsertSubject({ id: 'gh:1', kind: 'repo', source: 'npm', now: T0 + MIN });
  const row = db.getSubject('gh:1');
  assert.equal(row.first_seen, new Date(T0).toISOString());
  assert.equal(row.last_seen, new Date(T0 + MIN).toISOString());
  assert.equal(row.source, 'registry');
  db.close();
});

test('recordRun inserts then updates a run', () => {
  const db = fresh();
  db.recordRun({ id: '9001', workflow: 'pump.yml', attempt: 1, started: T0 });
  db.recordRun({ id: '9001', workflow: 'pump.yml', attempt: 1, finished: T0 + MIN, conclusion: 'success' });
  const row = db.getRun('9001');
  assert.equal(row.started, new Date(T0).toISOString());
  assert.equal(row.finished, new Date(T0 + MIN).toISOString());
  assert.equal(row.conclusion, 'success');
  db.close();
});

test('slot ledger hands out at most the budget and reuses released slots', () => {
  const db = fresh();
  assert.equal(db.acquireSlot('run-1', { budget: 2, ttlMs: MIN * 60, now: T0 }), 0);
  assert.equal(db.acquireSlot('run-2', { budget: 2, ttlMs: MIN * 60, now: T0 }), 1);
  assert.equal(db.acquireSlot('run-3', { budget: 2, ttlMs: MIN * 60, now: T0 }), null);
  assert.equal(db.releaseSlot(0, 'run-2', { now: T0 }), false);
  assert.equal(db.releaseSlot(0, 'run-1', { now: T0 }), true);
  assert.equal(db.acquireSlot('run-3', { budget: 2, ttlMs: MIN * 60, now: T0 }), 0);
  assert.equal(db.openSlots().length, 2);
  // Budget is clamped to 15.
  const big = fresh();
  for (let i = 0; i < 15; i++) assert.equal(big.acquireSlot(`r${i}`, { budget: 40, ttlMs: MIN * 60, now: T0 }), i);
  assert.equal(big.acquireSlot('r15', { budget: 40, ttlMs: MIN * 60, now: T0 }), null);
  assert.equal(big.acquireSlot('r', { budget: 0, ttlMs: MIN * 60, now: T0 }), null);
  db.close();
  big.close();
});

test('slot ledger: acquire needs a positive ttl', () => {
  const db = fresh();
  assert.throws(() => db.acquireSlot('r', { budget: 1, now: T0 }), /ttlMs/);
  db.close();
});

test('slot ledger: an expired slot is reaped on acquire and can be taken again', () => {
  const db = fresh();
  assert.equal(db.acquireSlot('crashed', { budget: 1, ttlMs: 10 * MIN, now: T0 }), 0);
  // Still held just before expiry.
  assert.equal(db.acquireSlot('next', { budget: 1, ttlMs: 10 * MIN, now: T0 + 10 * MIN - 1 }), null);
  assert.equal(db.acquireSlot('next', { budget: 1, ttlMs: 10 * MIN, now: T0 + 10 * MIN }), 0);
  const open = db.openSlots();
  assert.equal(open.length, 1);
  assert.equal(open[0].holder_run, 'next');
  // The crashed run can no longer release the slot it lost.
  assert.equal(db.releaseSlot(0, 'crashed', { now: T0 + 11 * MIN }), false);
  db.close();
});

test('reapExpired closes only expired rows and returns the count', () => {
  const db = fresh();
  db.acquireSlot('a', { budget: 3, ttlMs: MIN, now: T0 });
  db.acquireSlot('b', { budget: 3, ttlMs: 5 * MIN, now: T0 });
  db.acquireSlot('c', { budget: 3, ttlMs: MIN, now: T0 });
  assert.equal(db.reapExpired({ now: T0 + 2 * MIN }), 2);
  assert.deepEqual(db.openSlots().map((r) => r.holder_run), ['b']);
  assert.equal(db.reapExpired({ now: T0 + 2 * MIN }), 0);
  db.close();
});

test('migration from schema version 1 gives old open slots an expiry that reaps them', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../state/schema.sql', import.meta.url), 'utf8'));
  raw.exec("INSERT INTO counters (name, value) VALUES ('fence', 0); PRAGMA user_version = 1");
  raw.prepare('INSERT INTO slot_ledger (slot, holder_run, acquired) VALUES (0, ?, ?)').run('old', new Date(T0).toISOString());
  const db = new StateDb(':memory:');
  db.raw = raw;
  assert.equal(db.migrate(), SCHEMA_VERSION);
  assert.equal(db.acquireSlot('new', { budget: 1, ttlMs: MIN, now: T0 + MIN }), 0);
  db.close();
});
