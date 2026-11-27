// Schema v3: dispatch ledger, run keys, results and recordResult (the ingest
// interface). See docs/INTERFACES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import { openState, StateDb, SCHEMA_VERSION } from '../state/db.mjs';

const T0 = Date.parse('2026-11-23T12:00:00Z');
const MIN = 60_000;
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function fresh() {
  return openState(':memory:');
}

/** Open a dispatch with one lease and one slot per item, the way the pump does. */
function dispatch(db, { attemptId = 'att-1', items = [{ runKey: KEY_A, subject: 'repo:1' }], ttlMs = 30 * MIN, now = T0, budget = 5 } = {}) {
  const slot = db.acquireSlot(attemptId, { budget, ttlMs, now });
  assert.notEqual(slot, null);
  const leased = items.map((it) => {
    const l = db.acquireLease(it.runKey, attemptId, { ttlMs, now });
    assert.equal(l.acquired, true);
    return { run_key: it.runKey, subject: it.subject, fence: l.fence };
  });
  db.createDispatch({
    attemptId, shardId: `shard-${attemptId}`, workflow: 'live-probe', repo: 'isokron-ai/mcp-check',
    workflowFile: 'live-probe.yml', ref: 'main', expires: new Date(now + ttlMs).toISOString(), items: leased, now,
  });
  return leased;
}

test('schema v3 adds the dispatch ledger tables and columns', () => {
  const db = fresh();
  assert.equal(SCHEMA_VERSION, 11);
  assert.equal(db.schemaVersion(), 11);
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['dispatches', 'dispatch_items', 'results', 'run_keys', 'kv']) assert.ok(tables.includes(t), t);
  const cols = (t) => db.raw.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  for (const c of ['tier', 'sha', 'artifact_digest', 'changed_at']) assert.ok(cols('subjects').includes(c), c);
  for (const c of ['attempt_id', 'outcome']) assert.ok(cols('attempts').includes(c), c);
  assert.ok(cols('slot_ledger').includes('release_reason'));
  db.close();
});

test('migration from version 2 keeps existing rows', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../state/schema.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../state/schema-v2.sql', import.meta.url), 'utf8'));
  raw.exec("INSERT INTO counters (name, value) VALUES ('fence', 7); PRAGMA user_version = 2");
  raw.prepare("INSERT INTO subjects VALUES ('s', 'repo', 'test', 'x', 'x')").run();
  const db = new StateDb(':memory:');
  db.raw = raw;
  assert.equal(db.migrate(), SCHEMA_VERSION);
  const s = db.getSubject('s');
  assert.equal(s.tier, 4);
  assert.equal(s.sha, null);
  assert.equal(db.nextFence(), 8);
  db.close();
});

test('schema v4 gives each dispatch item its position in the dispatched list', () => {
  const db = fresh();
  const cols = db.raw.prepare('PRAGMA table_info(dispatch_items)').all();
  const col = cols.find((c) => c.name === 'item_index');
  assert.ok(col, 'dispatch_items.item_index');
  assert.equal(col.notnull, 1);
  // Items keep the order they were dispatched in, not run_key order.
  dispatch(db, { items: [{ runKey: KEY_B, subject: 's2' }, { runKey: KEY_A, subject: 's1' }] });
  const d = db.getDispatch('att-1');
  assert.deepEqual(d.items.map((i) => [i.item_index, i.run_key]), [[0, KEY_B], [1, KEY_A]]);
  assert.throws(
    () => db.raw.prepare("INSERT INTO dispatch_items (attempt_id, run_key, subject, workflow, fence, item_index) VALUES ('att-1', ?, 's3', 'live-probe', 9, 1)").run('c'.repeat(64)),
    /UNIQUE/, 'one item per position',
  );
  db.close();
});

test('migration from version 3 numbers existing items in the order they were stored', () => {
  const raw = new DatabaseSync(':memory:');
  for (const f of ['schema.sql', 'schema-v2.sql', 'schema-v3.sql']) raw.exec(readFileSync(new URL(`../state/${f}`, import.meta.url), 'utf8'));
  raw.exec("INSERT INTO counters (name, value) VALUES ('fence', 3); PRAGMA user_version = 3");
  const t = new Date(T0).toISOString();
  for (const id of ['old-1', 'old-2']) {
    raw.prepare(`INSERT INTO dispatches (attempt_id, shard_id, workflow, repo, workflow_file, ref, created, expires, status)
      VALUES (?, ?, 'live-probe', 'isokron-ai/mcp-check', 'live-probe.yml', 'main', ?, ?, 'dispatched')`).run(id, `shard-${id}`, t, t);
  }
  const ins = raw.prepare("INSERT INTO dispatch_items (attempt_id, run_key, subject, workflow, fence) VALUES (?, ?, ?, 'live-probe', ?)");
  ins.run('old-1', KEY_A, 's1', 1);
  ins.run('old-2', KEY_B, 's2', 2);
  ins.run('old-2', KEY_A, 's1', 3);
  const db = new StateDb(':memory:');
  db.raw = raw;
  assert.equal(db.migrate(), SCHEMA_VERSION);
  assert.deepEqual(db.getDispatch('old-1').items.map((i) => [i.item_index, i.run_key]), [[0, KEY_A]]);
  assert.deepEqual(db.getDispatch('old-2').items.map((i) => [i.item_index, i.run_key]), [[0, KEY_B], [1, KEY_A]]);
  assert.equal(db.nextFence(), 4);
  db.close();
});

test('setSubjectVersion records sha, digest, tier and a change time', () => {
  const db = fresh();
  db.setSubjectVersion({ id: 'repo:1', kind: 'repo', source: 'test', tier: 1, sha: 'abc', artifactDigest: 'sha256:1', now: T0 });
  let s = db.getSubject('repo:1');
  assert.equal(s.tier, 1);
  assert.equal(s.sha, 'abc');
  assert.equal(s.changed_at, new Date(T0).toISOString());
  // Same version again: no new change time.
  db.setSubjectVersion({ id: 'repo:1', kind: 'repo', source: 'test', tier: 1, sha: 'abc', artifactDigest: 'sha256:1', now: T0 + MIN });
  assert.equal(db.getSubject('repo:1').changed_at, new Date(T0).toISOString());
  // A new SHA moves it.
  db.setSubjectVersion({ id: 'repo:1', kind: 'repo', source: 'test', tier: 1, sha: 'def', now: T0 + 2 * MIN });
  s = db.getSubject('repo:1');
  assert.equal(s.sha, 'def');
  assert.equal(s.changed_at, new Date(T0 + 2 * MIN).toISOString());
  // An explicit change event (an advisory) moves it without a new SHA.
  db.noteChange('repo:1', { reason: 'advisory', now: T0 + 3 * MIN });
  assert.equal(db.getSubject('repo:1').changed_at, new Date(T0 + 3 * MIN).toISOString());
  assert.throws(() => db.setSubjectVersion({ id: 'x', kind: 'repo', source: 't', tier: 9, now: T0 }), /tier/);
  db.close();
});

test('createDispatch and markDispatched record the run identity', () => {
  const db = fresh();
  dispatch(db);
  let d = db.getDispatch('att-1');
  assert.equal(d.status, 'pending');
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].fence, 1);
  db.markDispatched('att-1', { runId: 4242, runUrl: 'https://api.github.test/x', workflowSha: 'f'.repeat(40), correlatedBy: 'response', now: T0 });
  d = db.getDispatch('att-1');
  assert.equal(d.status, 'dispatched');
  assert.equal(d.run_id, '4242');
  assert.equal(d.workflow_sha, 'f'.repeat(40));
  assert.equal(d.correlated_by, 'response');
  assert.equal(db.getDispatch('nope'), undefined);
  db.close();
});

test('recordResult accepts the current fence, stores the result and frees lease and slot', () => {
  const db = fresh();
  const [item] = dispatch(db);
  db.markDispatched('att-1', { runId: 1, now: T0 });
  const r = db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, outcome: 'correct', verdict: 'accepted', digest: 'sha256:bundle', now: T0 + 5 * MIN });
  assert.equal(r.accepted, true);
  assert.equal(r.reason, null);
  const res = db.getResult(KEY_A);
  assert.equal(res.attempt_id, 'att-1');
  assert.equal(res.outcome, 'correct');
  assert.equal(res.subject, 'repo:1');
  assert.equal(res.workflow, 'live-probe');
  assert.equal(db.getLease(KEY_A).holder, null, 'lease released');
  assert.equal(db.openSlots().length, 0, 'slot released');
  const slotRow = db.raw.prepare('SELECT * FROM slot_ledger').get();
  assert.equal(slotRow.release_reason, 'result');
  const d = db.getDispatch('att-1');
  assert.equal(d.status, 'done');
  assert.equal(d.close_reason, 'results_in');
  const attempts = db.listAttempts('repo:1');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].accepted, 1);
  assert.equal(attempts[0].attempt_id, 'att-1');
  assert.equal(attempts[0].run_id, '1');
  db.close();
});

test('recordResult takes the boolean alias `accepted` as well as `verdict`', () => {
  const db = fresh();
  const [item] = dispatch(db);
  const r = db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, outcome: 'correct', accepted: true, now: T0 + MIN });
  assert.equal(r.accepted, true);
  assert.throws(() => db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence }), /verdict/);
  db.close();
});

test('an ingest rejection is stored, frees the slot and makes the run_key due again', () => {
  const db = fresh();
  const [item] = dispatch(db);
  const r = db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, verdict: 'rejected', reason: 'schema_invalid', now: T0 + MIN });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'schema_invalid');
  assert.equal(db.getResult(KEY_A), undefined);
  assert.equal(db.getLease(KEY_A).holder, null);
  assert.equal(db.openSlots().length, 0);
  assert.equal(db.rejectedCount(KEY_A), 1);
  db.close();
});

test('a shard with two run_keys keeps its slot until both are in', () => {
  const db = fresh();
  const [a, b] = dispatch(db, { items: [{ runKey: KEY_A, subject: 's1' }, { runKey: KEY_B, subject: 's2' }] });
  db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: a.fence, verdict: 'accepted', outcome: 'correct', now: T0 + MIN });
  assert.equal(db.openSlots().length, 1);
  assert.equal(db.getDispatch('att-1').status, 'pending');
  db.recordResult({ run_key: KEY_B, attempt_id: 'att-1', fence: b.fence, verdict: 'rejected', reason: 'timeout', now: T0 + 2 * MIN });
  assert.equal(db.openSlots().length, 0);
  assert.equal(db.getDispatch('att-1').status, 'done');
  db.close();
});

test('a late result after expiry and re-dispatch is stored as rejected and never overwrites', () => {
  const db = fresh();
  const [old] = dispatch(db, { attemptId: 'att-old', ttlMs: 10 * MIN });
  // The old worker stalls; its lease and slot expire and the pump reaps them.
  const reaped = db.reapExpiredDispatches({ now: T0 + 11 * MIN });
  assert.deepEqual(reaped.map((d) => d.attempt_id), ['att-old']);
  assert.equal(db.getDispatch('att-old').status, 'expired');
  // Re-dispatched with a newer fence; the new worker reports first.
  const [cur] = dispatch(db, { attemptId: 'att-new', now: T0 + 12 * MIN });
  assert.ok(cur.fence > old.fence);
  const good = db.recordResult({ run_key: KEY_A, attempt_id: 'att-new', fence: cur.fence, verdict: 'accepted', outcome: 'correct', digest: 'new', now: T0 + 15 * MIN });
  assert.equal(good.accepted, true);
  // The stalled worker finally reports, even claiming ingest accepted it.
  const late = db.recordResult({ run_key: KEY_A, attempt_id: 'att-old', fence: old.fence, verdict: 'accepted', outcome: 'incorrect', digest: 'old', now: T0 + 16 * MIN });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'stale_fence');
  assert.equal(db.getResult(KEY_A).digest, 'new', 'late result did not overwrite');
  assert.equal(db.getResult(KEY_A).attempt_id, 'att-new');
  const attempts = db.listAttempts('repo:1');
  assert.equal(attempts.length, 2, 'every attempt is retained');
  assert.deepEqual(attempts.map((a) => [a.attempt_id, a.accepted, a.reason]), [['att-new', 1, null], ['att-old', 0, 'stale_fence']]);
  db.close();
});

test('a result after expiry but before re-dispatch is rejected as lease_expired', () => {
  const db = fresh();
  const [item] = dispatch(db, { ttlMs: 10 * MIN });
  const r = db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, verdict: 'accepted', now: T0 + 10 * MIN });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'lease_expired');
  db.close();
});

test('unknown attempts, wrong run_keys and wrong fences are rejected; a repeat is a no-op', () => {
  const db = fresh();
  const [item] = dispatch(db);
  const t = T0 + MIN;
  assert.equal(db.recordResult({ run_key: KEY_A, attempt_id: 'forged', fence: item.fence, verdict: 'accepted', now: t }).reason, 'unknown_attempt');
  assert.equal(db.recordResult({ run_key: KEY_B, attempt_id: 'att-1', fence: item.fence, verdict: 'accepted', now: t }).reason, 'unknown_run_key');
  assert.equal(db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence + 1, verdict: 'accepted', now: t }).reason, 'fence_mismatch');
  const first = db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, verdict: 'accepted', now: t });
  assert.equal(first.accepted, true);
  // The same report again returns the first answer and stores nothing new.
  assert.deepEqual(db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, verdict: 'accepted', now: t }), {
    accepted: true, reason: null, id: first.id, duplicate: true,
  });
  // Four attempts are kept, one accepted; the result is the accepted one.
  const all = db.raw.prepare('SELECT accepted, reason FROM attempts ORDER BY id').all();
  assert.equal(all.length, 4);
  assert.equal(all.filter((a) => a.accepted === 1).length, 1);
  db.close();
});

test('reapExpiredDispatches releases the slot with reason expired and leaves live ones', () => {
  const db = fresh();
  dispatch(db, { attemptId: 'short', items: [{ runKey: KEY_A, subject: 's1' }], ttlMs: 5 * MIN });
  dispatch(db, { attemptId: 'long', items: [{ runKey: KEY_B, subject: 's2' }], ttlMs: 50 * MIN });
  const reaped = db.reapExpiredDispatches({ now: T0 + 6 * MIN });
  assert.deepEqual(reaped.map((d) => d.attempt_id), ['short']);
  const open = db.openSlots();
  assert.deepEqual(open.map((s) => s.holder_run), ['long']);
  const row = db.raw.prepare("SELECT release_reason FROM slot_ledger WHERE holder_run = 'short'").get();
  assert.equal(row.release_reason, 'expired');
  assert.deepEqual(db.openDispatches({ now: T0 + 6 * MIN }).map((d) => d.attempt_id), ['long']);
  db.close();
});

test('failDispatch releases leases and slot so the work is due again', () => {
  const db = fresh();
  dispatch(db);
  db.failDispatch('att-1', { error: 'HTTP 422', now: T0 + 1000 });
  const d = db.getDispatch('att-1');
  assert.equal(d.status, 'failed');
  assert.equal(d.error, 'HTTP 422');
  assert.equal(db.getLease(KEY_A).holder, null);
  assert.equal(db.openSlots().length, 0);
  db.close();
});

test('closeDispatch ends a run that finished without every result and frees what it held', () => {
  const db = fresh();
  dispatch(db, { items: [{ runKey: KEY_A, subject: 's1' }, { runKey: KEY_B, subject: 's2' }] });
  db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: db.getDispatch('att-1').items[0].fence, verdict: 'accepted', now: T0 + MIN });
  assert.equal(db.closeDispatch('att-1', { reason: 'run_failed', now: T0 + 2 * MIN }), true);
  const d = db.getDispatch('att-1');
  assert.equal(d.status, 'done');
  assert.equal(d.close_reason, 'run_failed');
  assert.equal(db.getLease(KEY_B).holder, null);
  assert.equal(db.openSlots().length, 0);
  const slot = db.raw.prepare("SELECT release_reason FROM slot_ledger WHERE holder_run = 'att-1'").get();
  assert.equal(slot.release_reason, 'run_failed');
  assert.deepEqual(db.inFlight({ now: T0 + 2 * MIN }), []);
  assert.ok(db.getResult(KEY_A), 'the result that came in is kept');
  // A result arriving after the close is stored as rejected.
  const late = db.recordResult({ run_key: KEY_B, attempt_id: 'att-1', fence: d.items[1].fence, verdict: 'accepted', now: T0 + 3 * MIN });
  assert.equal(late.accepted, false);
  assert.equal(db.closeDispatch('att-1', { reason: 'again', now: T0 + 4 * MIN }), false, 'closing twice does nothing');
  assert.equal(db.closeDispatch('nope', { reason: 'x', now: T0 }), false);
  db.close();
});

test('acquireSlot never admits more open slots than the budget, even after the budget shrinks', () => {
  const db = fresh();
  for (let i = 0; i < 8; i++) assert.equal(db.acquireSlot(`r${i}`, { budget: 8, ttlMs: 60 * MIN, now: T0 }), i);
  // LOOP_SLOTS dropped: 8 outstanding, budget now 5. Slots 0..4 are taken anyway,
  // and even if they were released the other three still count.
  db.releaseSlot(0, 'r0', { now: T0 });
  db.releaseSlot(1, 'r1', { now: T0 });
  db.releaseSlot(2, 'r2', { now: T0 });
  assert.equal(db.acquireSlot('x', { budget: 5, ttlMs: 60 * MIN, now: T0 }), null, '5 still open');
  db.releaseSlot(3, 'r3', { now: T0 });
  assert.equal(db.acquireSlot('x', { budget: 5, ttlMs: 60 * MIN, now: T0 }), 0);
  db.close();
});

test('kv stores small loop metadata', () => {
  const db = fresh();
  assert.equal(db.getKv('pump.last_tick'), undefined);
  db.setKv('pump.last_tick', { at: 'x', n: 1 }, { now: T0 });
  assert.deepEqual(db.getKv('pump.last_tick'), { at: 'x', n: 1 });
  db.close();
});

test('R-COV-02: migration from version 6 keeps results and adds fault, coverage and assessed_at as NULL', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../state/schema.sql', import.meta.url), 'utf8'));
  raw.exec("INSERT INTO counters (name, value) VALUES ('fence', 3)");
  for (const v of [2, 3, 4, 5, 6]) raw.exec(readFileSync(new URL(`../state/schema-v${v}.sql`, import.meta.url), 'utf8'));
  raw.exec('PRAGMA user_version = 6');
  raw.prepare("INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, digest, accepted_at) VALUES (?, 's', 'scan-static', 'a', 1, 'accepted', NULL, '2026-11-23T00:00:00.000Z')").run('e'.repeat(64));
  const db = new StateDb(':memory:');
  db.raw = raw;
  assert.equal(db.migrate(), SCHEMA_VERSION);
  const r = db.getResult('e'.repeat(64));
  assert.deepEqual([r.outcome, r.fault, r.coverage, r.assessed_at], ['accepted', null, null, null]);
  db.close();
});
