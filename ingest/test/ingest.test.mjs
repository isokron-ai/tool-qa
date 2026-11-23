import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

import { ingestAttempt } from '../ingest.mjs';
import { parseRegistry } from '../registry.mjs';
import { GithubError } from '../github.mjs';
import { writeTar } from '../../worker-kit/tar.mjs';
import {
  makeBundle, defaultFiles, defaultRun, artifactEntry, expectedRow, fakeGithub, fakeLedger,
  fakeEncrypt, fakeDecrypt, REGISTRY_TEXT, RUN_ID, WORKER_REPO, MARKER,
} from '../testkit.mjs';

const registry = { ...parseRegistry(REGISTRY_TEXT), source: 'test' };
const INPUT = { repo: WORKER_REPO, runId: RUN_ID, attemptId: 'att-1' };
const NOW = () => new Date('2026-01-01T01:00:00Z');

async function run({ bundle = makeBundle(), blob, github, ledger = fakeLedger(), input = INPUT, ...rest } = {}) {
  const gh = github ?? fakeGithub({ blob: blob ?? fakeEncrypt(bundle.tar) });
  const r = await ingestAttempt(input, { ledger, github: gh, decrypt: fakeDecrypt, registry, now: NOW, ...rest });
  return { r, gh, ledger };
}

const json = (buf) => JSON.parse(buf.toString('utf8'));

test('a clean bundle is accepted and recorded; outputs hold the bundle and a report', async () => {
  const bundle = makeBundle();
  const { r, ledger } = await run({ bundle });
  assert.equal(r.outcome, 'accepted');
  assert.equal(r.reason, null);
  assert.equal(r.recorded, true);
  assert.equal(r.accepted, true);
  assert.deepEqual(ledger.records, [{
    run_key: 'a'.repeat(64), attempt_id: 'att-1', fence: 7, outcome: 'accepted', accepted: true, reason: null,
  }]);
  const paths = [...r.outputs.keys()].sort();
  assert.deepEqual(paths, [
    'accepted/att-1/controls/forgery.json',
    'accepted/att-1/ingest.json',
    'accepted/att-1/logs/run.log',
    'accepted/att-1/manifest.json',
    'accepted/att-1/observations/check.ndjson',
    'accepted/att-1/raw/forgery-target.ndjson',
    'accepted/att-1/results/report.json',
  ]);
  assert.deepEqual(json(r.outputs.get('accepted/att-1/manifest.json')), bundle.manifest);
  const report = json(r.outputs.get('accepted/att-1/ingest.json'));
  assert.equal(report.outcome, 'accepted');
  assert.equal(report.run.head_sha, '1'.repeat(40));
  assert.equal(report.artifact.container, 'raw');
  assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.bundle.files, 5);
  assert.equal(report.registry.sha256, registry.sha256);
  assert.deepEqual(report.recorded, { accepted: true, reason: null });
  assert.equal(report.ingested_at, '2026-01-01T01:00:00.000Z');
});

test('forged bundles are rejected, recorded, and kept only as ciphertext', async () => {
  const injected = defaultFiles();
  injected['controls/forgery.json'] = JSON.stringify({ verdict: 'contained', result: { attempt_id: 'att-999' } });
  const foreign = defaultFiles();
  foreign['results/report.json'] = JSON.stringify({ run_key: 'b'.repeat(64) });
  const cases = [
    ['another attempt in the manifest', makeBundle({ identity: { attempt_id: 'att-2' } }), 'attempt_mismatch'],
    ['an older fence', makeBundle({ identity: { fence: 6 } }), 'fence_mismatch'],
    ['another run_key', makeBundle({ identity: { run_key: 'c'.repeat(64) } }), 'run_key_mismatch'],
    ['another workflow SHA', makeBundle({ workflow: { sha: '2'.repeat(40) } }), 'workflow_sha_mismatch'],
    ['another run', makeBundle({ workflow: { run_id: 1 } }), 'run_id_mismatch'],
    ['an unlisted file', makeBundle({ extraTarEntries: [['results/sneaky.json', '{}']] }), 'unlisted_file'],
    ['a changed file', makeBundle({ mutateManifest: (m) => { m.files[0].sha256 = 'e'.repeat(64); } }), 'digest_mismatch'],
    ['a foreign identity in a report', makeBundle({ files: foreign }), 'foreign_identity_claim'],
    ['an injected forgery control', makeBundle({ files: injected }), 'forgery_control_injected'],
  ];
  for (const [name, bundle, reason] of cases) {
    const { r, ledger } = await run({ bundle });
    assert.equal(r.outcome, 'rejected', name);
    assert.equal(r.reason, reason, name);
    assert.equal(r.recorded, true, name);
    assert.deepEqual(ledger.records.map((x) => [x.outcome, x.accepted, x.reason]), [['rejected', false, reason]], name);
    assert.deepEqual([...r.outputs.keys()].sort(), ['rejected/att-1/ingest.json', 'rejected/att-1/result.tar.age'], name);
    assert.deepEqual(r.outputs.get('rejected/att-1/result.tar.age'), fakeEncrypt(bundle.tar), name);
    const report = json(r.outputs.get('rejected/att-1/ingest.json'));
    assert.equal(report.problems[0].reason, reason, name);
  }
});

test('observations must use declared fields of the right type', async () => {
  const files = defaultFiles();
  files['observations/check.ndjson'] += `${JSON.stringify({ field: 'invented_field', value: 1 })}\n`;
  const { r } = await run({ bundle: makeBundle({ files }) });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.reason, 'undeclared_field');

  const typed = defaultFiles();
  typed['observations/check.ndjson'] = `${JSON.stringify({ field: 'tool_count', value: 'many' })}\n`;
  const t = await run({ bundle: makeBundle({ files: typed }) });
  assert.equal(t.r.reason, 'field_type');
});

test('a secret outside raw/ quarantines the bundle; the report names the rule, not the text', async () => {
  const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
  const files = defaultFiles();
  files['logs/run.log'] = `started\nusing ${token}\n`;
  const { r, ledger } = await run({ bundle: makeBundle({ files }) });
  assert.equal(r.outcome, 'quarantined');
  assert.equal(r.reason, 'secret_scan');
  assert.deepEqual(ledger.records.map((x) => [x.outcome, x.accepted, x.reason]), [['quarantined', false, 'secret_scan']]);
  assert.deepEqual([...r.outputs.keys()].sort(), ['quarantine/att-1/ingest.json', 'quarantine/att-1/result.tar.age']);
  const reportText = r.outputs.get('quarantine/att-1/ingest.json').toString('utf8');
  assert.ok(!reportText.includes(token));
  const report = JSON.parse(reportText);
  assert.deepEqual(report.secret_scan.hits.map((h) => [h.path, h.rule, h.line]), [['logs/run.log', 'github-token', undefined]]);
  assert.ok(report.secret_scan.hits.every((h) => Number.isInteger(h.start) && Number.isInteger(h.length)));
});

test('names that reach the report are scrubbed of secrets and canaries', async () => {
  const token = ['gh', 'p_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
  const canary = 'cn-9876543210';
  const bundle = makeBundle({ extraTarEntries: [[`results/${token}.json`, '{}'], [`results/${canary}.json`, '{}']] });
  const { r } = await run({ bundle, ledger: fakeLedger([expectedRow({ canaries: [canary] })]) });
  assert.equal(r.reason, 'unlisted_file');
  const text = r.outputs.get('rejected/att-1/ingest.json').toString('utf8');
  assert.ok(!text.includes(token) && !text.includes(canary), 'no secret or canary in the report');
  assert.deepEqual(JSON.parse(text).problems.map((p) => p.path).sort(), ['results/[CANARY].json', 'results/[REDACTED:github-token].json']);

  const files = defaultFiles();
  files['logs/run.log'] = `token ${token}\n`;
  const q = await run({ bundle: makeBundle({ files }) });
  const allowed = new Set(['path', 'rule', 'class', 'line', 'json_path', 'in_key', 'start', 'length']);
  const hits = json(q.r.outputs.get('quarantine/att-1/ingest.json')).secret_scan.hits;
  assert.ok(hits.length > 0 && hits.every((h) => Object.keys(h).every((k) => allowed.has(k))), 'hits carry locations only');
});

test('canaries from the ledger are searched for; raw/ hits are counted but do not quarantine', async () => {
  const canary = 'cn-0123456789';
  const files = defaultFiles();
  files['results/report.json'] = JSON.stringify({ echoed: canary });
  const q = await run({ bundle: makeBundle({ files }), ledger: fakeLedger([expectedRow({ canaries: [canary] })]) });
  assert.equal(q.r.outcome, 'quarantined');

  const rawOnly = defaultFiles();
  rawOnly['raw/target-stderr.txt'] = `leaked ${canary} and admin@corp-mail.io\n`;
  const a = await run({ bundle: makeBundle({ files: rawOnly }), ledger: fakeLedger([expectedRow({ canaries: [canary] })]) });
  assert.equal(a.r.outcome, 'accepted');
  const report = json(a.r.outputs.get('accepted/att-1/ingest.json'));
  assert.deepEqual(report.secret_scan.raw_hits_by_rule, { canary: 1, email: 1 });
});

test('the ledger decides staleness: stale before download, refused at record time', async () => {
  const stale = await run({ ledger: fakeLedger([expectedRow({ current_fence: 8 })]) });
  assert.equal(stale.r.outcome, 'rejected');
  assert.equal(stale.r.reason, 'stale_fence');
  assert.equal(stale.r.recorded, true);
  assert.ok(!stale.gh.calls.some((c) => c[0] === 'downloadArtifact'), 'no download for a stale attempt');

  const refused = await run({ ledger: fakeLedger([expectedRow()], { answer: () => ({ accepted: false, reason: 'stale_fence' }) }) });
  assert.equal(refused.r.outcome, 'rejected');
  assert.equal(refused.r.reason, 'stale_fence');
  assert.equal(refused.r.accepted, false);
  assert.ok([...refused.r.outputs.keys()].every((p) => p.startsWith('rejected/att-1/')));
  assert.ok(refused.r.outputs.has('rejected/att-1/result.tar.age'));
});

test('inputs that do not match the ledger are refused without recording', async () => {
  const cases = [
    [{ ledger: fakeLedger([]) }, 'unknown_attempt'],
    [{ input: { ...INPUT, repo: 'someone/else' } }, 'ledger_repo_mismatch'],
    [{ input: { ...INPUT, runId: 999 } }, 'ledger_run_mismatch'],
    [{ github: fakeGithub({ run: null }) }, 'run_not_found'],
  ];
  for (const [opts, reason] of cases) {
    const { r, ledger } = await run(opts);
    assert.equal(r.outcome, 'rejected', reason);
    assert.equal(r.reason, reason);
    assert.equal(r.recorded, false, reason);
    assert.equal(ledger.records.length, 0, reason);
    assert.deepEqual([...r.outputs.keys()], ['rejected/att-1/ingest.json'], reason);
  }
  const done = await run({ ledger: fakeLedger([expectedRow({ outcome: 'accepted' })]) });
  assert.equal(done.r.outcome, 'already_recorded');
  assert.equal(done.r.outputs.size, 0);
  assert.equal(done.ledger.records.length, 0);
});

test('a run that is still going is pending: nothing recorded, nothing written', async () => {
  const { r, ledger, gh } = await run({ github: fakeGithub({ run: defaultRun({ status: 'in_progress', conclusion: null }) }) });
  assert.equal(r.outcome, 'pending');
  assert.equal(r.recorded, false);
  assert.equal(r.outputs.size, 0);
  assert.equal(ledger.records.length, 0);
  assert.deepEqual(gh.calls.map((c) => c[0]), ['getRun']);
});

test('the run must be the dispatched workflow in the worker repo', async () => {
  const cases = [
    [defaultRun({ path: '.github/workflows/other.yml' }), 'run_workflow_mismatch'],
    [defaultRun({ event: 'push' }), 'run_event_mismatch'],
    [defaultRun({ repository: { full_name: 'fork/mcp-check' } }), 'run_repo_mismatch'],
    [defaultRun({ head_sha: '3'.repeat(40) }), 'run_sha_mismatch'],
  ];
  for (const [runObj, reason] of cases) {
    const ledger = fakeLedger([expectedRow({ workflow_sha: '1'.repeat(40) })]);
    const { r } = await run({ github: fakeGithub({ run: runObj, blob: fakeEncrypt(makeBundle().tar) }), ledger });
    assert.equal(r.outcome, 'rejected', reason);
    assert.equal(r.reason, reason);
    assert.equal(r.recorded, true, reason);
  }
  // The worker's own conclusion never decides: a failed run with a good bundle is accepted.
  const failed = await run({ github: fakeGithub({ run: defaultRun({ conclusion: 'failure' }), blob: fakeEncrypt(makeBundle().tar) }) });
  assert.equal(failed.r.outcome, 'accepted');
  // A run path with a ref suffix still names the same file.
  const withRef = await run({ github: fakeGithub({ run: defaultRun({ path: '.github/workflows/qa-worker.yml@refs/heads/main' }), blob: fakeEncrypt(makeBundle().tar) }) });
  assert.equal(withRef.r.outcome, 'accepted');
});

test('artifact problems are recorded rejections', async () => {
  const tar = makeBundle().tar;
  const cases = [
    [{ artifacts: [] }, 'no_artifact'],
    [{ artifacts: [artifactEntry(), artifactEntry({ id: 902, name: 'result-att-1' })] }, 'duplicate_artifact'],
    [{ artifacts: [artifactEntry({ expired: true })] }, 'artifact_expired'],
    [{ artifacts: [artifactEntry({ size_in_bytes: 10 ** 12 })] }, 'artifact_too_large'],
    [{ artifacts: [artifactEntry({ workflow_run: { id: 1 } })] }, 'artifact_run_mismatch'],
    [{ blob: new GithubError('GET x: HTTP 410', { status: 410 }) }, 'artifact_expired'],
    [{ blob: Buffer.from('plain text, not age') }, 'bad_container'],
    [{ blob: Buffer.concat([Buffer.from('age-encryption.org/v1\n-> other\n'), tar]) }, 'decrypt_failed'],
    [{ blob: fakeEncrypt(Buffer.from('not a tar archive at all')) }, 'bad_bundle'],
    [{ blob: fakeEncrypt(writeTar([{ path: 'results/a.json', data: Buffer.from('{}') }])) }, 'no_manifest'],
    [{ blob: fakeEncrypt(writeTar([{ path: 'manifest.json', data: Buffer.from('{oops') }])) }, 'manifest_not_json'],
    [{ blob: fakeEncrypt(writeTar([{ path: 'manifest.json', data: Buffer.from('{"schema_version": 2}') }])) }, 'manifest_invalid'],
  ];
  for (const [opts, reason] of cases) {
    const gh = fakeGithub({ blob: fakeEncrypt(tar), ...opts });
    const { r, ledger } = await run({ github: gh });
    assert.equal(r.outcome, 'rejected', reason);
    assert.equal(r.reason, reason);
    assert.equal(r.recorded, true, reason);
    assert.equal(ledger.records[0].reason, reason);
  }
});

test('an artifact uploaded as a zip is unwrapped', async () => {
  const { r } = await run({ blob: zipOne('result-att-1.tar.age', fakeEncrypt(makeBundle().tar)) });
  assert.equal(r.outcome, 'accepted');
  assert.equal(json(r.outputs.get('accepted/att-1/ingest.json')).artifact.container, 'zip');
});

test('transient GitHub errors abort without recording anything', async () => {
  const gh = fakeGithub({ blob: new GithubError('GET x: HTTP 502', { status: 502, transient: true }) });
  const ledger = fakeLedger();
  await assert.rejects(run({ github: gh, ledger }), (e) => e.transient === true);
  assert.equal(ledger.records.length, 0);
});

test('bad inputs throw before anything happens', async () => {
  for (const input of [{ ...INPUT, attemptId: '../x' }, { ...INPUT, runId: 'x' }, { ...INPUT, repo: 'nope' }]) {
    await assert.rejects(run({ input }), /invalid/);
  }
});

test('the forgery marker never needs to leave raw/', async () => {
  // Sanity check on the fixture: the clean bundle carries the marker only in raw/.
  const b = makeBundle();
  for (const [p, d] of b.files) assert.equal(d.includes(MARKER), p.startsWith('raw/'), p);
});

// One stored zip entry, enough for the container test.
function zipOne(name, data) {
  const n = Buffer.from(name);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc32(data), 14);
  lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc32(data), 16);
  ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28);
  const cd = Buffer.concat([ch, n]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([lh, n, data, cd, eocd]);
}
