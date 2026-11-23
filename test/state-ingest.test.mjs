// The state store as ingest's attempts ledger: getAttempt(), recordResult() and
// the calls the pump's in-process ingest makes. Real SQLite databases only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../state/db.mjs';
import { ingestAttempt } from '../ingest/ingest.mjs';
import { dbLedger, normalizeAttempt, openLedger } from '../ingest/ledger.mjs';
import { fakeGithub, WORKER_REPO } from '../ingest/testkit.mjs';

const T0 = Date.parse('2026-11-23T12:00:00Z');
const MIN = 60_000;
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const SHA = '1'.repeat(40);

/** A dispatch the way the pump makes it: a slot, a lease per run_key, then the ledger row. */
function dispatch(db, { attemptId = 'att-1', items = [{ runKey: KEY_A, subject: 'repo:1' }], ttlMs = 30 * MIN, now = T0, file = 'qa-worker.yml' } = {}) {
  db.acquireSlot(attemptId, { budget: 5, ttlMs, now });
  const leased = items.map((it) => {
    const l = db.acquireLease(it.runKey, attemptId, { ttlMs, now });
    assert.equal(l.acquired, true);
    return { run_key: it.runKey, subject: it.subject, fence: l.fence };
  });
  db.createDispatch({
    attemptId, shardId: `shard-${attemptId}`, workflow: 'live-probe', repo: WORKER_REPO,
    workflowFile: file, ref: 'main', expires: now + ttlMs, items: leased, now,
  });
  return leased;
}

function withFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'state-ingest-'));
  return Promise.resolve(fn(join(dir, 'state.sqlite'))).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('getAttempt describes a dispatch in the shape ingest reads', () => {
  const db = openState(':memory:');
  const [item] = dispatch(db);
  assert.equal(db.getAttempt('nope'), undefined);
  const before = db.getAttempt('att-1');
  assert.equal(before.attempt_id, 'att-1');
  assert.equal(before.workflow, 'live-probe');
  assert.equal(before.repo, WORKER_REPO);
  assert.equal(before.workflow_file, '.github/workflows/qa-worker.yml', 'a bare file name gets the workflows directory');
  assert.equal(before.run_id, null);
  assert.equal(before.workflow_sha, null);
  assert.deepEqual(before.canaries, []);
  assert.equal(before.status, 'pending');
  assert.deepEqual(before.items, [{
    index: 0, run_key: KEY_A, fence: item.fence, subject: 'repo:1', current_fence: item.fence, outcome: null, resolved: null,
  }]);

  db.markDispatched('att-1', { runId: 4242, workflowSha: SHA, correlatedBy: 'response' });
  const after = db.getAttempt('att-1');
  assert.equal(after.run_id, 4242, 'run ids are stored as text and come back as numbers');
  assert.equal(after.workflow_sha, SHA);
  assert.equal(after.status, 'dispatched');
  // It passes ingest's own validation unchanged.
  const n = normalizeAttempt(after);
  assert.equal(n.workflow_file, '.github/workflows/qa-worker.yml');
  assert.equal(n.run_id, 4242);
  assert.deepEqual(n.items.map((i) => [i.index, i.run_key, i.fence]), [[0, KEY_A, item.fence]]);

  db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, outcome: 'accepted', accepted: true, now: T0 + MIN });
  assert.equal(db.getAttempt('att-1').items[0].outcome, 'accepted', 'a recorded item carries its outcome');
  db.close();
});

test('getAttempt keeps a workflow path that already names the directory', () => {
  const db = openState(':memory:');
  dispatch(db, { file: '.github/workflows/qa-worker.yml' });
  assert.equal(db.getAttempt('att-1').workflow_file, '.github/workflows/qa-worker.yml');
  db.close();
});

test('getAttempt lists every item of a multi-item dispatch in dispatch order, each with its own outcome', () => {
  const db = openState(':memory:');
  const c = 'c'.repeat(64);
  const leased = dispatch(db, { items: [{ runKey: KEY_B, subject: 's2' }, { runKey: KEY_A, subject: 's1' }, { runKey: c, subject: 's3' }] });
  db.markDispatched('att-1', { runId: 4242, workflowSha: SHA });
  const a = db.getAttempt('att-1');
  assert.deepEqual(a.items.map((i) => [i.index, i.run_key, i.subject, i.fence]), leased.map((l, i) => [i, l.run_key, l.subject, l.fence]));
  assert.ok(a.items.every((i) => i.outcome === null && i.current_fence === i.fence));

  db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: leased[1].fence, outcome: 'rejected', accepted: false, reason: 'no_artifact', now: T0 + MIN });
  const b = db.getAttempt('att-1');
  assert.deepEqual(b.items.map((i) => i.outcome), [null, 'rejected', null]);
  assert.equal(db.getLease(KEY_A).holder, null, 'the decided item gave its lease back');
  assert.equal(b.items[1].current_fence, leased[1].fence, 'a released lease keeps its fence, so the item is not stale');
  assert.equal(b.status, 'dispatched', 'still open while other items wait');
  const n = normalizeAttempt(b);
  assert.deepEqual(n.items.map((i) => i.index), [0, 1, 2]);
  db.close();
});

test('recordResult is idempotent: a repeated report returns the first answer and writes nothing', () => {
  const db = openState(':memory:');
  const [item] = dispatch(db);
  const args = { run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, outcome: 'accepted', accepted: true, now: T0 + MIN };
  const first = db.recordResult(args);
  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, undefined);
  const again = db.recordResult({ ...args, now: T0 + 2 * MIN });
  assert.deepEqual(again, { accepted: true, reason: null, id: first.id, duplicate: true });
  // Even a different verdict for the same attempt and fence does not overwrite.
  const flip = db.recordResult({ ...args, outcome: 'rejected', accepted: false, reason: 'no_artifact', now: T0 + 3 * MIN });
  assert.deepEqual(flip, { accepted: true, reason: null, id: first.id, duplicate: true });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1);
  assert.equal(db.getResult(KEY_A).attempt_id, 'att-1');
  assert.equal(db.rejectedCount(KEY_A), 0);

  // A rejection is idempotent too.
  const [b] = dispatch(db, { attemptId: 'att-2', items: [{ runKey: KEY_B, subject: 'repo:2' }] });
  const no = db.recordResult({ run_key: KEY_B, attempt_id: 'att-2', fence: b.fence, outcome: 'rejected', accepted: false, reason: 'no_artifact', now: T0 + MIN });
  assert.equal(no.accepted, false);
  assert.equal(no.reason, 'no_artifact');
  assert.deepEqual(db.recordResult({ run_key: KEY_B, attempt_id: 'att-2', fence: b.fence, outcome: 'rejected', accepted: false, reason: 'no_artifact', now: T0 + 2 * MIN }), {
    accepted: false, reason: 'no_artifact', id: no.id, duplicate: true,
  });
  assert.equal(db.rejectedCount(KEY_B), 1, 'the repeat is not counted twice');
  db.close();
});

test('recordResult: a holder whose lease was taken over is refused as stale_fence and stored as rejected', () => {
  const db = openState(':memory:');
  const [old] = dispatch(db, { attemptId: 'att-old', ttlMs: 5 * MIN });
  db.reapExpiredDispatches({ now: T0 + 6 * MIN });
  const [cur] = dispatch(db, { attemptId: 'att-new', now: T0 + 7 * MIN });
  assert.ok(cur.fence > old.fence);
  const r = db.recordResult({ run_key: KEY_A, attempt_id: 'att-old', fence: old.fence, outcome: 'accepted', accepted: true, now: T0 + 8 * MIN });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'stale_fence');
  const row = db.raw.prepare('SELECT * FROM attempts WHERE id = ?').get(r.id);
  assert.equal(row.accepted, 0);
  assert.equal(row.outcome, 'rejected', 'the stored outcome follows the store, not the request');
  assert.equal(db.getResult(KEY_A), undefined, 'nothing was accepted');
  assert.equal(db.getLease(KEY_A).holder, 'att-new', 'the newer lease is untouched');
  assert.equal(db.getDispatch('att-new').status, 'pending');
  assert.equal(db.rejectedCount(KEY_A), 0, 'a fencing failure does not count against the run_key');
  assert.equal(db.getAttempt('att-old').items[0].outcome, 'rejected');
  assert.equal(db.getAttempt('att-old').items[0].current_fence, cur.fence);
  db.close();
});

test('recordResult: an unknown attempt is stored as rejected and changes nothing else', () => {
  const db = openState(':memory:');
  const [item] = dispatch(db);
  const r = db.recordResult({ run_key: KEY_A, attempt_id: 'forged', fence: item.fence, outcome: 'accepted', accepted: true, now: T0 + MIN });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'unknown_attempt');
  assert.equal(db.getAttempt('forged'), undefined);
  assert.equal(db.getLease(KEY_A).holder, 'att-1');
  assert.equal(db.getDispatch('att-1').items[0].resolved, null);
  assert.equal(db.rejectedCount(KEY_A), 0);
  db.close();
});

test('ingest over the real store: stale fence is recorded without judging; unknown attempts are refused', async () => {
  const db = openState(':memory:');
  const [old] = dispatch(db, { attemptId: 'att-old', ttlMs: 5 * MIN });
  db.markDispatched('att-old', { runId: 4242 });
  db.reapExpiredDispatches({ now: T0 + 6 * MIN });
  const [cur] = dispatch(db, { attemptId: 'att-new', now: T0 + 7 * MIN });
  const ledger = dbLedger(db, { now: () => T0 + 8 * MIN });
  const github = fakeGithub();

  const stale = await ingestAttempt({ repo: WORKER_REPO, runId: 4242, attemptId: 'att-old' }, {
    ledger, github, decrypt: () => { throw new Error('not reached'); }, registry: null,
  });
  assert.equal(stale.outcome, 'rejected');
  assert.equal(stale.reason, 'stale_fence');
  assert.equal(stale.recorded, true);
  assert.deepEqual(github.calls, [], 'a stale attempt is not fetched');
  const rows = db.raw.prepare("SELECT accepted, reason, fence FROM attempts WHERE attempt_id = 'att-old'").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ accepted: 0, reason: 'stale_fence', fence: old.fence }]);
  assert.equal(db.getLease(KEY_A).fence, cur.fence);

  // A second ingest of the same attempt is a no-op.
  const again = await ingestAttempt({ repo: WORKER_REPO, runId: 4242, attemptId: 'att-old' }, {
    ledger, github, decrypt: () => { throw new Error('not reached'); }, registry: null,
  });
  assert.equal(again.outcome, 'already_recorded');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM attempts WHERE attempt_id = 'att-old'").get().n, 1);

  const unknown = await ingestAttempt({ repo: WORKER_REPO, runId: 4242, attemptId: 'forged' }, {
    ledger, github, decrypt: () => { throw new Error('not reached'); }, registry: null,
  });
  assert.equal(unknown.outcome, 'rejected');
  assert.equal(unknown.reason, 'unknown_attempt');
  assert.equal(unknown.recorded, false);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM attempts WHERE attempt_id = 'forged'").get().n, 0);
  db.close();
});

test('the CLI ledger (--state FILE) opens the real store and sees the same fences', async () => {
  await withFile(async (file) => {
    const db = openState(file);
    const [old] = dispatch(db, { attemptId: 'att-old', ttlMs: 5 * MIN });
    db.markDispatched('att-old', { runId: 4242 });
    db.reapExpiredDispatches({ now: T0 + 6 * MIN });
    dispatch(db, { attemptId: 'att-new', now: T0 + 7 * MIN });
    db.close();

    const ledger = await openLedger({ statePath: file });
    try {
      assert.equal(ledger.kind, 'state');
      const row = ledger.getAttempt('att-old');
      assert.equal(row.items[0].fence, old.fence);
      assert.notEqual(row.items[0].current_fence, old.fence);
      assert.equal(ledger.getAttempt('forged'), null);
      const r = await ingestAttempt({ repo: WORKER_REPO, runId: 4242, attemptId: 'att-old' }, {
        ledger, github: fakeGithub(), decrypt: () => { throw new Error('not reached'); }, registry: null,
      });
      assert.equal(r.reason, 'stale_fence');
      assert.deepEqual(ledger.recordResult({ run_key: KEY_A, attempt_id: 'att-old', fence: old.fence, outcome: 'rejected', accepted: false, reason: 'stale_fence' }), {
        accepted: false, reason: 'stale_fence',
      });
    } finally {
      ledger.close();
    }
    const check = openState(file);
    assert.equal(check.raw.prepare("SELECT COUNT(*) AS n FROM attempts WHERE attempt_id = 'att-old'").get().n, 1);
    check.close();
  });
});

test('setDispatchRun fills in a run found later, once', () => {
  const db = openState(':memory:');
  dispatch(db);
  db.markDispatched('att-1', { runId: null });
  assert.equal(db.setDispatchRun('att-1', { runId: 77, runUrl: 'https://example.test/run/77', workflowSha: SHA, correlatedBy: 'run-name' }), true);
  const d = db.getDispatch('att-1');
  assert.equal(d.run_id, '77');
  assert.equal(d.correlated_by, 'run-name');
  assert.equal(d.status, 'dispatched');
  assert.equal(db.setDispatchRun('att-1', { runId: 78 }), false, 'a known run id is never replaced');
  assert.equal(db.getDispatch('att-1').run_id, '77');

  dispatch(db, { attemptId: 'att-2', items: [{ runKey: KEY_B, subject: 'repo:2' }] });
  assert.equal(db.setDispatchRun('att-2', { runId: 79, correlatedBy: 'run-name' }), true);
  assert.equal(db.getDispatch('att-2').status, 'dispatched', 'a pending dispatch whose run turned up counts as sent');
  db.closeDispatch('att-2', { reason: 'test', now: T0 + MIN });
  assert.equal(db.setDispatchRun('att-2', { runId: 80 }), false);
  db.close();
});

test('txAsync commits on success and rolls back everything on failure', async () => {
  const db = openState(':memory:');
  const [item] = dispatch(db);
  await assert.rejects(db.txAsync(async () => {
    db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, outcome: 'accepted', accepted: true, now: T0 + MIN });
    await new Promise((r) => setTimeout(r, 1));
    throw new Error('sealing failed');
  }), /sealing failed/);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0);
  assert.equal(db.getLease(KEY_A).holder, 'att-1');
  assert.equal(db.inTx, false);
  const out = await db.txAsync(async () => {
    await new Promise((r) => setTimeout(r, 1));
    return db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: item.fence, outcome: 'accepted', accepted: true, now: T0 + MIN });
  });
  assert.equal(out.accepted, true);
  assert.equal(db.getResult(KEY_A).attempt_id, 'att-1');
  db.close();
});

test('dispatchesAwaitingResults lists open dispatches and recently expired ones without a result', () => {
  const db = openState(':memory:');
  dispatch(db, { attemptId: 'open', items: [{ runKey: KEY_A, subject: 's1' }], ttlMs: 60 * MIN });
  dispatch(db, { attemptId: 'late', items: [{ runKey: KEY_B, subject: 's2' }], ttlMs: 5 * MIN, now: T0 + 1000 });
  db.markDispatched('late', { runId: 9 });
  const c = 'c'.repeat(64);
  dispatch(db, { attemptId: 'late-no-run', items: [{ runKey: c, subject: 's3' }], ttlMs: 5 * MIN, now: T0 + 2000 });
  db.reapExpiredDispatches({ now: T0 + 6 * MIN });
  const ids = (now, lateMs) => db.dispatchesAwaitingResults({ now, lateMs }).map((d) => d.attempt_id);
  assert.deepEqual(ids(T0 + 7 * MIN, 60 * MIN), ['open', 'late'], 'a late dispatch needs a known run id');
  assert.deepEqual(ids(T0 + 2 * 60 * MIN, 60 * MIN), ['open'], 'past the late window');
  // Once something is recorded for the late attempt it is no longer listed.
  db.recordResult({ run_key: KEY_B, attempt_id: 'late', fence: db.getDispatch('late').items[0].fence, outcome: 'accepted', accepted: true, now: T0 + 7 * MIN });
  assert.deepEqual(ids(T0 + 7 * MIN, 60 * MIN), ['open']);
  db.close();
});

test('dispatchesAwaitingResults keeps a late multi-item dispatch listed until every item has something recorded', () => {
  const db = openState(':memory:');
  const items = dispatch(db, { attemptId: 'late', items: [{ runKey: KEY_A, subject: 's1' }, { runKey: KEY_B, subject: 's2' }], ttlMs: 5 * MIN });
  db.markDispatched('late', { runId: 9 });
  db.reapExpiredDispatches({ now: T0 + 6 * MIN });
  const ids = () => db.dispatchesAwaitingResults({ now: T0 + 7 * MIN, lateMs: 60 * MIN }).map((d) => d.attempt_id);
  assert.deepEqual(ids(), ['late']);
  db.recordResult({ run_key: KEY_A, attempt_id: 'late', fence: items[0].fence, outcome: 'accepted', accepted: true, now: T0 + 7 * MIN });
  assert.deepEqual(ids(), ['late'], 'one item is still undecided');
  db.recordResult({ run_key: KEY_B, attempt_id: 'late', fence: items[1].fence, outcome: 'accepted', accepted: true, now: T0 + 7 * MIN });
  assert.deepEqual(ids(), []);
  db.close();
});
