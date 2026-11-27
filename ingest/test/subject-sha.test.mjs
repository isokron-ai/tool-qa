// The commit read against the commit the run_key names (R-SHA-01). No network.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { openState, subjectShaFact } from '../../state/db.mjs';
import { ingestAttempt } from '../ingest.mjs';
import { normalizeAttempt } from '../ledger.mjs';
import { parseRegistry } from '../registry.mjs';
import { workflowProblems } from '../../pump/due.mjs';
import { workerInputs } from '../../pump/dispatch.mjs';
import { runTick } from '../../pump/tick.mjs';
import { laneShaModes, shaCheckMode } from '../../pump/pins.mjs';
import { defaultFiles, expectedRow, fakeDecrypt, fakeEncrypt, fakeGithub, fakeLedger, makeBundle, REGISTRY_TEXT, RUN_ID, WORKER_REPO } from '../testkit.mjs';

const registry = { ...parseRegistry(REGISTRY_TEXT), source: 'test' };
const INPUT = { repo: WORKER_REPO, runId: RUN_ID, attemptId: 'att-1' };
const NOW = () => new Date('2026-01-01T01:00:00Z');
const READ = 'c'.repeat(40); // what testkit's default meta says the worker read
const OTHER = 'e'.repeat(40);

async function judge({ sha, mode, meta = {}, lane = 'scan-static', files, row = {} }) {
  const bundle = makeBundle({ meta, ...(files ? { files } : {}) });
  const ledger = fakeLedger([expectedRow({ workflow: lane, ...(sha === undefined ? {} : { sha }), ...row })]);
  const r = await ingestAttempt(INPUT, {
    ledger, github: fakeGithub({ blob: fakeEncrypt(bundle.tar) }), decrypt: fakeDecrypt, registry, now: NOW,
    shaModes: { [lane]: mode },
  });
  return { r, ledger, report: r.report };
}

test('R-SHA-01: on an enforce lane a result whose worker read another commit than the run_key names is refused, never filed under it; the subject is not blamed', async () => {
  const bad = await judge({ sha: OTHER, mode: 'enforce' });
  assert.equal(bad.r.outcome, 'rejected');
  assert.equal(bad.r.reason, 'subject_sha_mismatch');
  assert.deepEqual(bad.ledger.records.map((x) => [x.accepted, x.reason, x.fault ?? null]), [[false, 'subject_sha_mismatch', null]]);
  assert.deepEqual(bad.report.subject_sha, { expected: OTHER, got: READ, match: false, mode: 'enforce' });
  assert.equal([...bad.r.outputs.keys()].some((k) => k.startsWith('accepted/')), false);
  // A worker that names no commit is refused the same way.
  const none = await judge({ sha: OTHER, mode: 'enforce', meta: { subject: { id: 'io.example/demo', repo: 'example/demo', sha: null } } });
  assert.equal(none.r.reason, 'subject_sha_mismatch');
  // The same commit is accepted.
  const good = await judge({ sha: READ, mode: 'enforce' });
  assert.equal(good.r.outcome, 'accepted');
  assert.equal(good.report.subject_sha.match, true);
});

test('R-SHA-02: label is the default: a mismatch is accepted and recorded in the report; a run_key with no sha is not checked', async () => {
  assert.equal(shaCheckMode({}), 'label');
  assert.equal(shaCheckMode({ sha_check: 'enforce' }), 'enforce');
  assert.deepEqual(laneShaModes({ a: {}, b: { sha_check: 'enforce' } }), { a: 'label', b: 'enforce' });
  assert.ok(workflowProblems({ x: { enabled: true, runs_untrusted: false, sha_check: 'strict' } }).some((p) => /sha_check/.test(p)));
  const label = await judge({ sha: OTHER, mode: 'label' });
  assert.equal(label.r.outcome, 'accepted');
  assert.deepEqual(label.report.subject_sha, { expected: OTHER, got: READ, match: false, mode: 'label' });
  const unknown = await judge({ sha: null, mode: 'enforce' });
  assert.equal(unknown.r.outcome, 'accepted');
  assert.equal(unknown.report.subject_sha, undefined);
});

test('R-SHA-03: the store hands ingest the sha each run_key was computed with, and the ledger keeps only a full sha', () => {
  const db = openState(':memory:');
  const fields = { subject_id: 'a/b', sha: OTHER, workflow: 'scan-static' };
  db.recordRunKey('rk1', { subject: 'a/b', workflow: 'scan-static', fields, now: 0 });
  db.recordRunKey('rk2', { subject: 'a/b', workflow: 'scan-static', fields: { ...fields, sha: null }, now: 0 });
  assert.equal(db.runKeySha('rk1'), OTHER);
  assert.equal(db.runKeySha('rk2'), null);
  assert.equal(db.runKeySha('missing'), null);
  const row = (sha) => normalizeAttempt(expectedRow({ sha })).items[0];
  assert.equal(row(OTHER).sha, OTHER);
  assert.equal(row('main').sha, undefined);
  assert.equal(row(null).sha, undefined);
  db.close();
});

test('R-SHA-04: a result that measured nothing (every skip retryable, retries used up) is not refused for the commit: nothing is filed under it, and its skips_only backoff stands', async () => {
  const files = defaultFiles();
  files['observations/check.ndjson'] = `${JSON.stringify({ field: 'tool_count', value: null, why: 'not read' })}\n`;
  const skip = { stage: 'start', reason: 'timeout_start', retryable: true, evidence: 'results/report.json' };
  const meta = { skips: [skip], subject: { id: 'io.example/demo', repo: 'example/demo', sha: null } };
  const nothing = await judge({ sha: OTHER, mode: 'enforce', meta, files, row: { retries: 3 } });
  assert.equal(nothing.r.outcome, 'accepted');
  assert.equal(nothing.ledger.records[0].resultOutcome, 'skips_only');
  assert.equal(nothing.report.subject_sha.match, false);
});

const MIN = 60_000;
/** One dispatched item of `lane`, the way the pump makes it. */
function dispatched(db, { attemptId = 'att-1', runKey = 'a'.repeat(64), now = 0, lane = 'scan-static' } = {}) {
  db.acquireSlot(attemptId, { budget: 5, ttlMs: 30 * MIN, now });
  const l = db.acquireLease(runKey, attemptId, { ttlMs: 30 * MIN, now });
  db.createDispatch({ attemptId, shardId: `shard-${attemptId}`, workflow: lane, repo: WORKER_REPO, workflowFile: 'qa.yml', ref: 'main', expires: now + 30 * MIN, items: [{ run_key: runKey, subject: 'a/b', fence: l.fence }], now });
  return l.fence;
}

test('R-SHA-05: the commit goes to a worker only on a lane that says send_sha; enforce needs send_sha', () => {
  const items = [{ subject: 'a/b', run_key: 'r'.repeat(64), fence: 1, sha: OTHER }, { subject: 'a/c', run_key: 's'.repeat(64), fence: 2, sha: null }];
  assert.deepEqual(JSON.parse(workerInputs({ shardId: 's', attemptId: 'a', items }).items), [{ subject: 'a/b', run_key: 'r'.repeat(64), fence: 1 }, { subject: 'a/c', run_key: 's'.repeat(64), fence: 2 }]);
  assert.deepEqual(JSON.parse(workerInputs({ shardId: 's', attemptId: 'a', items, sendSha: true }).items).map((x) => x.sha ?? null), [OTHER, null]);
  assert.deepEqual(JSON.parse(workerInputs({ shardId: 's', attemptId: 'a', items: [{ ...items[0], sha: 'main' }], sendSha: true }).items)[0].sha, undefined, 'only a full sha is sent');
  const lane = (over) => ({ x: { enabled: true, runs_untrusted: false, ...over } });
  assert.ok(workflowProblems(lane({ sha_check: 'enforce' })).some((p) => /needs send_sha true/.test(p)));
  assert.deepEqual(workflowProblems(lane({ sha_check: 'enforce', send_sha: true })), []);
  assert.ok(workflowProblems(lane({ send_sha: 'yes' })).some((p) => /send_sha must be/.test(p)));
  const shipped = JSON.parse(readFileSync(new URL('../../pump/workflows.json', import.meta.url), 'utf8')).workflows;
  assert.deepEqual(workflowProblems(shipped), []);
});

test('R-SHA-05: in a tick, only the lane with send_sha sends each item its run_key\'s commit', async () => {
  const tiers = JSON.parse(readFileSync(new URL('../../pump/tiers.json', import.meta.url), 'utf8'));
  const wf = (file, over = {}) => ({ enabled: true, runs_untrusted: false, repo: 'isokron-ai/mcp-check', file, ref: 'main', shard_size: 5, setup_minutes: 1, minutes_per_subject: 1, slots_max: 2, pin_check: 'label', versions: { tool: {}, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default', ...over });
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'a/b', kind: 'github', source: 'seed-v1', tier: 1, sha: OTHER, now: 0 });
  const calls = [];
  const dispatcher = { async dispatch(req) { calls.push(req); return { runId: calls.length, runUrl: null, correlatedBy: 'response' }; }, async resolveRef() { return 'f'.repeat(40); } };
  let n = 0;
  await runTick({ db, now: () => 1000, config: { tiers, workflows: { 'scan-static': wf('scan-static.yml', { send_sha: true }), 'live-probe': wf('live-probe.yml') } }, workerSlots: 4, dispatcher, newId: () => `att-${++n}` });
  const sent = Object.fromEntries(calls.map((c) => [c.workflowFile, JSON.parse(c.inputs.items)[0]]));
  assert.equal(sent['scan-static.yml'].sha, OTHER);
  assert.equal('sha' in sent['live-probe.yml'], false);
  db.close();
});

test('R-SHA-06: a result accepted on a label lane with the wrong commit says so in the state: the commit read is kept with its result_recorded event', async () => {
  const label = await judge({ sha: OTHER, mode: 'label' });
  assert.deepEqual(label.ledger.records[0].subjectSha, { expected: OTHER, got: READ });
  const db = openState(':memory:');
  const fence = dispatched(db);
  db.recordResult({ run_key: 'a'.repeat(64), attempt_id: 'att-1', fence, outcome: 'accepted', accepted: true, subjectSha: { expected: OTHER, got: READ }, now: 1000 });
  const ev = db.listEvents().find((e) => e.type === 'result_recorded');
  assert.deepEqual(ev.data.subject_sha, { expected: OTHER, got: READ, match: false });
  assert.equal(subjectShaFact({ expected: 'x', got: READ }), null);
  assert.deepEqual(subjectShaFact({ expected: OTHER, got: 'HEAD' }), { expected: OTHER, got: null, match: false });
  db.close();
});

test('R-SHA-07: subject_sha_mismatch never parks a run_key; it waits the retry backoff instead', () => {
  const db = openState(':memory:');
  const key = 'a'.repeat(64);
  for (let i = 0; i < 4; i++) {
    const fence = dispatched(db, { attemptId: `att-${i}`, now: i * 60 * MIN });
    db.recordResult({ run_key: key, attempt_id: `att-${i}`, fence, outcome: 'rejected', accepted: false, reason: 'subject_sha_mismatch', now: i * 60 * MIN + 1 });
  }
  assert.equal(db.rejectedRunKeys(3).some((r) => r.run_key === key), false, 'not parked');
  assert.ok(db.retryLaterWaiting({ now: 3 * 60 * MIN + 2, baseMs: 30 * MIN }).includes(key), 'in its backoff');
  assert.equal(db.retryLaterWaiting({ now: 3 * 60 * MIN + 2 + 9 * 60 * MIN, baseMs: 30 * MIN, maxMs: 6 * 60 * MIN }).includes(key), false, 'and due again after it');
  db.close();
});
