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
function dispatch(db, { attemptId = 'att-1', items = [{ runKey: KEY_A, subject: 'repo:1' }], ttlMs = 30 * MIN, now = T0, file = 'qa-worker.yml', workflow = 'live-probe' } = {}) {
  db.acquireSlot(attemptId, { budget: 5, ttlMs, now });
  const leased = items.map((it) => {
    const l = db.acquireLease(it.runKey, attemptId, { ttlMs, now });
    assert.equal(l.acquired, true);
    return { run_key: it.runKey, subject: it.subject, fence: l.fence };
  });
  db.createDispatch({
    attemptId, shardId: `shard-${attemptId}`, workflow, repo: WORKER_REPO,
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
    index: 0, run_key: KEY_A, fence: item.fence, subject: 'repo:1', subject_name: null, repo_id: null, name: null,
    current_fence: item.fence, outcome: null, resolved: null, retries: 0, throttled: 0, throttled_since: null,
    pins: null, // no run_key fields recorded for this hand-made dispatch (R-PIN-01)
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

test('R-ING-16: retry_later frees the lease and slot, is not counted towards parking, and backs off before the work is due again', async () => {
  const { dueFromState, loadConfig } = await import('../pump/due.mjs');
  const { tiers } = loadConfig();
  const db = openState(':memory:');
  const record = (attemptId, at) => {
    const [item] = dispatch(db, { attemptId, now: at });
    return db.recordResult({ run_key: KEY_A, attempt_id: attemptId, fence: item.fence, outcome: 'rejected', accepted: false, reason: 'retry_later', now: at + MIN });
  };
  const r = record('att-1', T0);
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'retry_later');
  assert.equal(db.getLease(KEY_A).holder, null, 'the lease is free');
  assert.deepEqual(db.openSlots(), [], 'the slot is free');
  assert.equal(db.getDispatch('att-1').close_reason, 'results_in');
  assert.equal(db.rejectedCount(KEY_A), 0, 'a retry does not count towards parking');
  assert.equal(db.getAttempt('att-1').items[0].retries, 1);

  // Backoff: 30 minutes after the first retry, 60 after the second.
  const base = 30 * MIN;
  assert.deepEqual(db.retryLaterWaiting({ now: T0 + MIN + base - 1, baseMs: base }), [KEY_A]);
  assert.deepEqual(db.retryLaterWaiting({ now: T0 + MIN + base, baseMs: base }), []);
  record('att-2', T0 + 40 * MIN);
  assert.equal(db.retryLaterCount(KEY_A), 2);
  assert.deepEqual(db.retryLaterWaiting({ now: T0 + 41 * MIN + 2 * base - 1, baseMs: base }), [KEY_A]);
  assert.deepEqual(db.retryLaterWaiting({ now: T0 + 41 * MIN + 2 * base, baseMs: base }), []);

  db.close();
});

test('R-ING-16: the due list skips a run_key sent back as retry_later until its backoff ends', async () => {
  const { dueFromState, loadConfig } = await import('../pump/due.mjs');
  const { tiers } = loadConfig();
  assert.equal(tiers.retry_backoff_minutes, 30);
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'repo:1', kind: 'repo', source: 'test', tier: 1, sha: SHA, now: T0 });
  const wf = { 'live-probe': {
    enabled: true, repo: WORKER_REPO, file: 'qa-worker.yml', ref: 'main', shard_size: 1, setup_minutes: 1, minutes_per_subject: 1,
    slots_max: 1, versions: { tool: {}, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default',
  } };
  const due = (t) => dueFromState(db, { now: t, tiers, workflows: wf }).map((d) => d.run_key);
  const [key] = due(T0);
  assert.ok(key);
  db.recordRunKey(key, { subject: 'repo:1', workflow: 'live-probe', fields: {}, now: T0 });
  const [item] = dispatch(db, { items: [{ runKey: key, subject: 'repo:1' }] });
  db.recordResult({ run_key: key, attempt_id: 'att-1', fence: item.fence, outcome: 'rejected', accepted: false, reason: 'retry_later', now: T0 + MIN });
  assert.deepEqual(due(T0 + 2 * MIN), [], 'waiting out its backoff');
  assert.deepEqual(due(T0 + 31 * MIN), [key], 'due again after 30 minutes');
  db.close();
});

test('R-ING-18: run_sha_mismatch does not count towards parking the run_key', () => {
  const db = openState(':memory:');
  for (const [i, reason] of ['run_sha_mismatch', 'run_sha_mismatch', 'run_sha_mismatch', 'no_artifact'].entries()) {
    const attemptId = `att-${i}`;
    const [item] = dispatch(db, { attemptId, now: T0 + i * 60 * MIN });
    db.recordResult({ run_key: KEY_A, attempt_id: attemptId, fence: item.fence, outcome: 'rejected', accepted: false, reason, now: T0 + i * 60 * MIN + MIN });
  }
  assert.equal(db.rejectedCount(KEY_A), 1, 'only no_artifact counts');
  assert.deepEqual(db.rejectedRunKeys(1).map((r) => [r.run_key, r.n]), [[KEY_A, 1]]);
  assert.deepEqual(db.rejectedRunKeys(2), []);
  db.close();
});

test('R-COV-02: recordResult stores the fault side and coverage of an accepted result; a later skip keeps assessed_at', () => {
  const db = openState(':memory:');
  const [a] = dispatch(db, { attemptId: 'att-1' });
  db.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: a.fence, verdict: 'accepted', outcome: 'accepted', fault: null, coverage: 'assessed', now: T0 + MIN });
  let r = db.getResult(KEY_A);
  assert.deepEqual([r.fault, r.coverage, r.assessed_at], [null, 'assessed', new Date(T0 + MIN).toISOString()]);
  // Re-run of the same run_key (a subject with no SHA): our reader now fails on it.
  const [b] = dispatch(db, { attemptId: 'att-2', now: T0 + 2 * MIN });
  db.recordResult({ run_key: KEY_A, attempt_id: 'att-2', fence: b.fence, verdict: 'accepted', outcome: 'accepted', fault: 'tool', coverage: 'unassessed_tool', now: T0 + 3 * MIN });
  r = db.getResult(KEY_A);
  assert.deepEqual([r.fault, r.coverage, r.assessed_at], ['tool', 'unassessed_tool', new Date(T0 + MIN).toISOString()]);
  // Not given (an older caller): stored as NULL, never guessed.
  const [c] = dispatch(db, { attemptId: 'att-3', items: [{ runKey: KEY_B, subject: 'repo:2' }], now: T0 + 4 * MIN });
  db.recordResult({ run_key: KEY_B, attempt_id: 'att-3', fence: c.fence, verdict: 'accepted', outcome: 'accepted', now: T0 + 5 * MIN });
  r = db.getResult(KEY_B);
  assert.deepEqual([r.fault, r.coverage, r.assessed_at], [null, null, null]);
  // The store refuses a value outside the contract's states.
  const [d] = dispatch(db, { attemptId: 'att-4', items: [{ runKey: 'c'.repeat(64), subject: 'repo:3' }], now: T0 + 6 * MIN });
  assert.throws(() => db.recordResult({ run_key: 'c'.repeat(64), attempt_id: 'att-4', fence: d.fence, verdict: 'accepted', outcome: 'accepted', fault: 'server', coverage: 'excluded', now: T0 + 7 * MIN }), /CHECK constraint/);
  db.close();
});

test('R-COV-02: ingest over the real store records a tool-fault skip as unassessed_tool', async () => {
  const { makeBundle, fakeEncrypt, fakeDecrypt, REGISTRY_TEXT, RUN_ID } = await import('../ingest/testkit.mjs');
  const { parseRegistry } = await import('../ingest/registry.mjs');
  const db = openState(':memory:');
  const [item] = dispatch(db, { file: 'qa-worker.yml' });
  db.setDispatchRun('att-1', { runId: RUN_ID, workflowSha: SHA, now: T0 });
  const bundle = makeBundle({
    identity: { attempt_id: 'att-1', run_key: KEY_A, fence: item.fence },
    workflow: { sha: SHA },
    meta: { skips: [{ stage: 'static', reason: 'unsupported_layout', fault: 'tool' }] },
  });
  const github = fakeGithub({ blob: fakeEncrypt(bundle.tar), run: undefined });
  const r = await ingestAttempt({ repo: WORKER_REPO, runId: RUN_ID, attemptId: 'att-1' }, {
    ledger: dbLedger(db, { now: () => T0 + MIN }), github, decrypt: fakeDecrypt, registry: { ...parseRegistry(REGISTRY_TEXT), source: 'test' }, now: () => new Date(T0 + MIN),
  });
  assert.equal(r.outcome, 'accepted', JSON.stringify(r.report?.problems ?? r.reason));
  const row = db.getResult(KEY_A);
  assert.deepEqual([row.fault, row.coverage, row.assessed_at], ['tool', 'unassessed_tool', null]);
  db.close();
});

test('R-ORD-07: ingest over the real store keeps the oracle facts of a live-probe bundle and opens a disagreement with the reader\'s facts', async () => {
  const { makeBundle, defaultFiles, fakeEncrypt, fakeDecrypt, REGISTRY_TEXT, RUN_ID } = await import('../ingest/testkit.mjs');
  const { parseRegistry } = await import('../ingest/registry.mjs');
  const db = openState(':memory:');
  const H = 'd'.repeat(64);
  // The reader (scan-static) counted fewer tools than the live list will.
  db.noteOracle('repo:1', 'scan-static', 'f'.repeat(64), { lane: 'scan-static', tool_list_sha256: 'e'.repeat(64), tool_count: 2, complete: true }, { now: T0 });
  const [item] = dispatch(db);
  db.setDispatchRun('att-1', { runId: RUN_ID, workflowSha: SHA, now: T0 });
  const files = defaultFiles();
  files['observations/check.ndjson'] = [{ field: 'tool_count', value: 3 }, { field: 'tool_list_sha256', value: H }].map((r) => `${JSON.stringify(r)}\n`).join('');
  const bundle = makeBundle({ identity: { attempt_id: 'att-1', run_key: KEY_A, fence: item.fence }, workflow: { sha: SHA }, files });
  const registry = { ...parseRegistry(`${REGISTRY_TEXT}  - {id: tool_list_sha256, layer: surface, type: hash, unit: none, source: check, class: P, redaction: null, status: active}\n`), source: 'test' };
  const r = await ingestAttempt({ repo: WORKER_REPO, runId: RUN_ID, attemptId: 'att-1' }, {
    ledger: dbLedger(db, { now: () => T0 + MIN }), github: fakeGithub({ blob: fakeEncrypt(bundle.tar), run: undefined }), decrypt: fakeDecrypt, registry, now: () => new Date(T0 + MIN),
  });
  assert.equal(r.outcome, 'accepted', JSON.stringify(r.report?.problems ?? r.reason));
  const [row] = db.listOracleDisagreements();
  assert.deepEqual([row.subject, row.status, row.kinds.map((k) => k.kind)], ['repo:1', 'open', ['tool_count']]);
  assert.deepEqual([db.getResult(KEY_A).fault, db.getResult(KEY_A).coverage], [null, 'assessed']);
  db.close();
});

test('R-ORD-15: with the real store the lane is known to ingest, so a scan-static rate limit is throttled (retry_throttled), not one of the three retries; another lane is not', async () => {
  const { makeBundle, fakeEncrypt, fakeDecrypt, REGISTRY_TEXT, RUN_ID } = await import('../ingest/testkit.mjs');
  const { parseRegistry } = await import('../ingest/registry.mjs');
  const reasonFor = async (workflow, stage) => {
    const db = openState(':memory:');
    const [item] = dispatch(db, { workflow });
    db.setDispatchRun('att-1', { runId: RUN_ID, workflowSha: SHA, now: T0 });
    const bundle = makeBundle({
      identity: { attempt_id: 'att-1', run_key: KEY_A, fence: item.fence }, workflow: { sha: SHA },
      meta: { skips: [{ stage, reason: 'rate_limited', retryable: true }] },
    });
    const r = await ingestAttempt({ repo: WORKER_REPO, runId: RUN_ID, attemptId: 'att-1' }, {
      ledger: dbLedger(db, { now: () => T0 + MIN }), github: fakeGithub({ blob: fakeEncrypt(bundle.tar), run: undefined }), decrypt: fakeDecrypt,
      registry: { ...parseRegistry(REGISTRY_TEXT), source: 'test' }, now: () => new Date(T0 + MIN),
    });
    db.close();
    return r.reason;
  };
  assert.equal(await reasonFor('scan-static', 'static'), 'retry_throttled', 'the lane declares static:rate_limited in pump/workflows.json');
  assert.equal(await reasonFor('scan-static', 'meta'), 'retry_later', 'a stage the lane does not declare is an ordinary retry');
  assert.equal(await reasonFor('live-probe', 'static'), 'retry_later', 'a lane that declares nothing');
});

test('R-CHAOS-02: a result whose run completed before the lease ran out is on time, even recorded after it; a later one is not; a newer lease always wins', () => {
  const db = openState(':memory:');
  const ttlMs = 10 * MIN;
  const [a] = dispatch(db, { attemptId: 'att-on-time', items: [{ runKey: KEY_A, subject: 'repo:1' }], ttlMs });
  const [b] = dispatch(db, { attemptId: 'att-late', items: [{ runKey: KEY_B, subject: 'repo:2' }], ttlMs });
  const later = T0 + 15 * MIN; // both leases ran out at T0 + 10 minutes
  db.reapExpiredDispatches({ now: later });
  const onTime = db.recordResult({ run_key: KEY_A, attempt_id: 'att-on-time', fence: a.fence, accepted: true, outcome: 'accepted', completedAt: T0 + 8 * MIN, now: later });
  assert.deepEqual([onTime.accepted, onTime.reason], [true, null]);
  assert.equal(db.getResult(KEY_A).attempt_id, 'att-on-time');
  const late = db.recordResult({ run_key: KEY_B, attempt_id: 'att-late', fence: b.fence, accepted: true, outcome: 'accepted', completedAt: T0 + 12 * MIN, now: later });
  assert.deepEqual([late.accepted, late.reason], [false, 'lease_expired']);
  // Without completedAt (the manual re-ingest) the store judges by now, as before.
  const db2 = openState(':memory:');
  const [c] = dispatch(db2, { attemptId: 'att-x', ttlMs });
  assert.equal(db2.recordResult({ run_key: KEY_A, attempt_id: 'att-x', fence: c.fence, accepted: true, outcome: 'accepted', now: later }).reason, 'lease_expired');
  // A newer lease makes the old fence stale whatever the run's time.
  const db3 = openState(':memory:');
  const [d] = dispatch(db3, { attemptId: 'att-old', ttlMs });
  db3.reapExpiredDispatches({ now: later });
  dispatch(db3, { attemptId: 'att-new', ttlMs, now: later });
  assert.equal(db3.recordResult({ run_key: KEY_A, attempt_id: 'att-old', fence: d.fence, accepted: true, outcome: 'accepted', completedAt: T0 + MIN, now: later + MIN }).reason, 'stale_fence');
  // A completedAt in the future (clock skew) never moves the check later than now.
  const db4 = openState(':memory:');
  const [e] = dispatch(db4, { attemptId: 'att-skew', ttlMs });
  assert.equal(db4.recordResult({ run_key: KEY_A, attempt_id: 'att-skew', fence: e.fence, accepted: true, outcome: 'accepted', completedAt: later + 60 * MIN, now: later }).reason, 'lease_expired');
  for (const x of [db, db2, db3, db4]) x.close();
});


test('R-CHAOS-10: a result counts as in when both its run completed and its artifact was uploaded; an artifact dated after the lease makes it late', async () => {
  const { resultInAt } = await import('../ingest/ledger.mjs');
  assert.equal(resultInAt(T0, '2026-11-23T12:05:00Z'), Date.parse('2026-11-23T12:05:00Z'), 'the later of the two');
  assert.equal(resultInAt(T0 + 10 * MIN, '2026-11-23T12:05:00Z'), T0 + 10 * MIN);
  assert.equal(resultInAt(null, '2026-11-23T12:05:00Z'), null, 'no run completion: the store uses now');
  assert.equal(resultInAt(T0, 'not a time'), T0);
  const ttlMs = 10 * MIN;
  const later = T0 + 15 * MIN;
  for (const [created, ok] of [['2026-11-23T12:07:00Z', true], ['2026-11-23T12:12:00Z', false]]) {
    const db = openState(':memory:');
    const [a] = dispatch(db, { ttlMs });
    db.reapExpiredDispatches({ now: later });
    const ledger = dbLedger(db, { now: () => later, completedAt: T0 + 8 * MIN });
    const out = ledger.recordResult({ run_key: KEY_A, attempt_id: 'att-1', fence: a.fence, outcome: 'accepted', accepted: true, reason: null, artifactCreatedAt: created });
    assert.deepEqual([out.accepted, out.reason], ok ? [true, null] : [false, 'lease_expired'], created);
    db.close();
  }
});
