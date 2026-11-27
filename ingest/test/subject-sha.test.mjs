// The commit read against the commit the run_key names (R-SHA-01). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openState } from '../../state/db.mjs';
import { ingestAttempt } from '../ingest.mjs';
import { normalizeAttempt } from '../ledger.mjs';
import { parseRegistry } from '../registry.mjs';
import { workflowProblems } from '../../pump/due.mjs';
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
