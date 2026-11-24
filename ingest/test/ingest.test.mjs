import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

import { ingestAttempt, openAttempt } from '../ingest.mjs';
import { parseRegistry } from '../registry.mjs';
import { GithubError } from '../github.mjs';
import { writeTar } from '../../worker-kit/tar.mjs';
import {
  makeBundle, defaultFiles, defaultRun, artifactEntry, expectedRow, multiItemRow, fakeGithub, fakeLedger,
  fakeEncrypt, fakeDecrypt, REGISTRY_TEXT, RUN_ID, WORKER_REPO, MARKER,
} from '../testkit.mjs';

const registry = { ...parseRegistry(REGISTRY_TEXT), source: 'test' };
const INPUT = { repo: WORKER_REPO, runId: RUN_ID, attemptId: 'att-1' };
const NOW = () => new Date('2026-01-01T01:00:00Z');

async function run({ bundle = makeBundle(), blob, github, ledger = fakeLedger(), input = INPUT, ...rest } = {}) {
  const api = github ?? fakeGithub({ blob: blob ?? fakeEncrypt(bundle.tar) });
  const r = await ingestAttempt(input, { ledger, github: api, decrypt: fakeDecrypt, registry, now: NOW, ...rest });
  return { r, api, ledger };
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
    'accepted/att-1/0/controls/forgery.json',
    'accepted/att-1/0/ingest.json',
    'accepted/att-1/0/logs/run.log',
    'accepted/att-1/0/manifest.json',
    'accepted/att-1/0/observations/check.ndjson',
    'accepted/att-1/0/raw/forgery-target.ndjson',
    'accepted/att-1/0/results/report.json',
  ]);
  assert.deepEqual(json(r.outputs.get('accepted/att-1/0/manifest.json')), bundle.manifest);
  const report = json(r.outputs.get('accepted/att-1/0/ingest.json'));
  assert.equal(report.outcome, 'accepted');
  assert.equal(report.run.head_sha, '1'.repeat(40));
  assert.equal(report.artifact.container, 'raw');
  assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.bundle.files, 5);
  assert.equal(report.registry.sha256, registry.sha256);
  assert.deepEqual(report.recorded, { accepted: true, reason: null });
  assert.equal(report.ingested_at, '2026-01-01T01:00:00.000Z');
  assert.equal(report.item_index, 0);
  assert.equal(report.artifact.name, 'result-att-1-0.tar.age');
  assert.equal(report.ledger.items, 1);
  assert.equal(report.ledger.run_key, 'a'.repeat(64));
  assert.deepEqual(r.items.map((it) => [it.index, it.run_key, it.outcome]), [[0, 'a'.repeat(64), 'accepted']]);
  assert.deepEqual(r.report, report);
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
    assert.deepEqual([...r.outputs.keys()].sort(), ['rejected/att-1/0/ingest.json', 'rejected/att-1/0/result.tar.age'], name);
    assert.deepEqual(r.outputs.get('rejected/att-1/0/result.tar.age'), fakeEncrypt(bundle.tar), name);
    const report = json(r.outputs.get('rejected/att-1/0/ingest.json'));
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
  assert.deepEqual([...r.outputs.keys()].sort(), ['quarantine/att-1/0/ingest.json', 'quarantine/att-1/0/result.tar.age']);
  const reportText = r.outputs.get('quarantine/att-1/0/ingest.json').toString('utf8');
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
  const text = r.outputs.get('rejected/att-1/0/ingest.json').toString('utf8');
  assert.ok(!text.includes(token) && !text.includes(canary), 'no secret or canary in the report');
  assert.deepEqual(JSON.parse(text).problems.map((p) => p.path).sort(), ['results/[CANARY].json', 'results/[REDACTED:github-token].json']);

  const files = defaultFiles();
  files['logs/run.log'] = `token ${token}\n`;
  const q = await run({ bundle: makeBundle({ files }) });
  const allowed = new Set(['path', 'rule', 'class', 'line', 'json_path', 'in_key', 'start', 'length']);
  const hits = json(q.r.outputs.get('quarantine/att-1/0/ingest.json')).secret_scan.hits;
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
  const report = json(a.r.outputs.get('accepted/att-1/0/ingest.json'));
  assert.deepEqual(report.secret_scan.raw_hits_by_rule, { canary: 1, email: 1 });
});

test('the ledger decides staleness: stale before download, refused at record time', async () => {
  const stale = await run({ ledger: fakeLedger([expectedRow({ current_fence: 8 })]) });
  assert.equal(stale.r.outcome, 'rejected');
  assert.equal(stale.r.reason, 'stale_fence');
  assert.equal(stale.r.recorded, true);
  assert.ok(!stale.api.calls.some((c) => c[0] === 'downloadArtifact'), 'no download for a stale attempt');

  const refused = await run({ ledger: fakeLedger([expectedRow()], { answer: () => ({ accepted: false, reason: 'stale_fence' }) }) });
  assert.equal(refused.r.outcome, 'rejected');
  assert.equal(refused.r.reason, 'stale_fence');
  assert.equal(refused.r.accepted, false);
  assert.ok([...refused.r.outputs.keys()].every((p) => p.startsWith('rejected/att-1/0/')));
  assert.ok(refused.r.outputs.has('rejected/att-1/0/result.tar.age'));
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
  const { r, ledger, api } = await run({ github: fakeGithub({ run: defaultRun({ status: 'in_progress', conclusion: null }) }) });
  assert.equal(r.outcome, 'pending');
  assert.equal(r.recorded, false);
  assert.equal(r.outputs.size, 0);
  assert.equal(ledger.records.length, 0);
  assert.deepEqual(api.calls.map((c) => c[0]), ['getRun']);
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
    [{ artifacts: [artifactEntry(), artifactEntry({ id: 902, name: 'result-att-1-0' })] }, 'duplicate_artifact'],
    [{ artifacts: [artifactEntry(), artifactEntry({ id: 902, name: 'result-att-1.tar.age' })] }, 'duplicate_artifact'],
    [{ artifacts: [artifactEntry({ name: 'result-att-1-1.tar.age' })] }, 'no_artifact'],
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
    const api = fakeGithub({ blob: fakeEncrypt(tar), ...opts });
    const { r, ledger } = await run({ github: api });
    assert.equal(r.outcome, 'rejected', reason);
    assert.equal(r.reason, reason);
    assert.equal(r.recorded, true, reason);
    assert.equal(ledger.records[0].reason, reason);
  }
});

test('an artifact uploaded as a zip is unwrapped', async () => {
  const { r } = await run({ blob: zipOne('result-att-1-0.tar.age', fakeEncrypt(makeBundle().tar)) });
  assert.equal(r.outcome, 'accepted');
  assert.equal(json(r.outputs.get('accepted/att-1/0/ingest.json')).artifact.container, 'zip');
});

test('transient GitHub errors abort without recording anything', async () => {
  const api = fakeGithub({ blob: new GithubError('GET x: HTTP 502', { status: 502, transient: true }) });
  const ledger = fakeLedger();
  await assert.rejects(run({ github: api, ledger }), (e) => e.transient === true);
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

test('a one-item attempt still accepts the older artifact name', async () => {
  const tar = makeBundle().tar;
  const raw = await run({ github: fakeGithub({ artifacts: [artifactEntry({ name: 'result-att-1.tar.age' })], blob: fakeEncrypt(tar) }) });
  assert.equal(raw.r.outcome, 'accepted');
  assert.equal(json(raw.r.outputs.get('accepted/att-1/0/ingest.json')).artifact.name, 'result-att-1.tar.age');
  const zipped = await run({
    github: fakeGithub({ artifacts: [artifactEntry({ name: 'result-att-1' })], blob: zipOne('result-att-1.tar.age', fakeEncrypt(tar)) }),
  });
  assert.equal(zipped.r.outcome, 'accepted');
  // The file inside a zip is named like the artifact itself.
  const wrongInner = await run({
    github: fakeGithub({ artifacts: [artifactEntry({ name: 'result-att-1-0' })], blob: zipOne('result-att-1.tar.age', fakeEncrypt(tar)) }),
  });
  assert.equal(wrongInner.r.reason, 'bad_container');
});

// ---- shards of several items ----

const KEYS = ['d', 'e', 'f'].map((ch) => ch.repeat(64));

/** Item i's bundle: its own run_key and fence (7 + i), unless `identity` forges them. */
function itemBundle(i, identity = {}) {
  return makeBundle({ identity: { run_key: KEYS[i], fence: 7 + i, ...identity } });
}

const itemArtifact = (i, over = {}) => artifactEntry({ id: 900 + i, name: `result-att-1-${i}.tar.age`, ...over });

/** A fake API whose artifact 900 + i holds bundles[i]. */
function itemsApi(bundles, { artifacts = bundles.map((_, i) => itemArtifact(i)), run: runObj = defaultRun() } = {}) {
  return fakeGithub({
    artifacts,
    run: runObj,
    blob: (id) => (bundles[id - 900] ? fakeEncrypt(bundles[id - 900].tar) : new Error(`no artifact ${id}`)),
  });
}

const shardLedger = () => fakeLedger([multiItemRow(KEYS)]);
const shardDeps = (ledger, github) => ({ ledger, github, decrypt: fakeDecrypt, registry, now: NOW });

test('a shard of several items: each item has its own bundle, judged and recorded on its own', async () => {
  const bundles = [0, 1, 2].map((i) => itemBundle(i));
  const api = itemsApi(bundles);
  const ledger = shardLedger();
  const r = await ingestAttempt(INPUT, shardDeps(ledger, api));
  assert.equal(r.outcome, 'accepted');
  assert.equal(r.reason, null);
  assert.equal(r.accepted, true);
  assert.equal(r.recorded, true);
  assert.equal(r.report, null, 'no single report for several items');
  assert.deepEqual(r.items.map((it) => [it.index, it.run_key, it.outcome]), KEYS.map((k, i) => [i, k, 'accepted']));
  assert.deepEqual(ledger.records.map((x) => [x.attempt_id, x.run_key, x.fence, x.outcome]), KEYS.map((k, i) => ['att-1', k, 7 + i, 'accepted']));
  // The run is checked and its artifacts listed once; one download per item.
  assert.deepEqual(api.calls.map((c) => (c[0] === 'downloadArtifact' ? `download ${c[2]}` : c[0])), [
    'getRun', 'listRunArtifacts', 'download 900', 'download 901', 'download 902',
  ]);
  for (const i of [0, 1, 2]) {
    const report = json(r.outputs.get(`accepted/att-1/${i}/ingest.json`));
    assert.equal(report.item_index, i);
    assert.equal(report.ledger.run_key, KEYS[i]);
    assert.equal(report.ledger.fence, 7 + i);
    assert.equal(report.ledger.items, 3);
    assert.equal(report.artifact.name, `result-att-1-${i}.tar.age`);
    assert.deepEqual(json(r.outputs.get(`accepted/att-1/${i}/manifest.json`)), bundles[i].manifest);
  }
});

test('a shard with one bundle missing: that item is rejected as no_artifact, the others are accepted', async () => {
  const api = itemsApi([0, 1, 2].map((i) => itemBundle(i)), { artifacts: [itemArtifact(0), itemArtifact(2)] });
  const ledger = shardLedger();
  const r = await ingestAttempt(INPUT, shardDeps(ledger, api));
  assert.equal(r.outcome, 'mixed');
  assert.equal(r.reason, null);
  assert.equal(r.accepted, false);
  assert.equal(r.recorded, true);
  assert.deepEqual(r.items.map((it) => [it.index, it.outcome, it.reason]), [[0, 'accepted', null], [1, 'rejected', 'no_artifact'], [2, 'accepted', null]]);
  assert.deepEqual(ledger.records.map((x) => [x.run_key, x.outcome, x.reason]), [
    [KEYS[0], 'accepted', null], [KEYS[1], 'rejected', 'no_artifact'], [KEYS[2], 'accepted', null],
  ]);
  assert.deepEqual(json(r.outputs.get('rejected/att-1/1/ingest.json')).problems, [{ reason: 'no_artifact', expected: 'result-att-1-1.tar.age' }]);
  assert.ok(!r.outputs.has('rejected/att-1/1/result.tar.age'));
});

test('a bundle filed under another item\'s index is rejected for that item only', async () => {
  // Item 1's bundle names item 2's run_key (with item 1's fence).
  const swapped = await ingestAttempt(INPUT, shardDeps(shardLedger(), itemsApi([itemBundle(0), itemBundle(1, { run_key: KEYS[2] }), itemBundle(2)])));
  assert.deepEqual(swapped.items.map((it) => [it.outcome, it.reason]), [['accepted', null], ['rejected', 'run_key_mismatch'], ['accepted', null]]);
  // Item 2's whole bundle uploaded again as item 1.
  const copied = await ingestAttempt(INPUT, shardDeps(shardLedger(), itemsApi([itemBundle(0), itemBundle(2), itemBundle(2)])));
  assert.equal(copied.items[1].outcome, 'rejected');
  const reasons = json(copied.outputs.get('rejected/att-1/1/ingest.json')).problems.map((p) => p.reason);
  assert.ok(reasons.includes('run_key_mismatch') && reasons.includes('fence_mismatch'), reasons.join(','));
  assert.deepEqual([copied.items[0].outcome, copied.items[2].outcome], ['accepted', 'accepted']);
});

test('two artifacts for one index reject that item as duplicate_artifact', async () => {
  const artifacts = [itemArtifact(0), itemArtifact(1), itemArtifact(2), artifactEntry({ id: 911, name: 'result-att-1-1' })];
  const api = itemsApi([0, 1, 2].map((i) => itemBundle(i)), { artifacts });
  const r = await ingestAttempt(INPUT, shardDeps(shardLedger(), api));
  assert.deepEqual(r.items.map((it) => it.reason), [null, 'duplicate_artifact', null]);
  assert.deepEqual(json(r.outputs.get('rejected/att-1/1/ingest.json')).problems, [
    { reason: 'duplicate_artifact', expected: 'result-att-1-1.tar.age', got: 2 },
  ]);
  assert.deepEqual(api.calls.filter((c) => c[0] === 'downloadArtifact').map((c) => c[2]), [900, 902]);
});

test('only a one-item attempt accepts the older artifact name', async () => {
  const artifacts = [artifactEntry({ id: 900, name: 'result-att-1.tar.age' }), itemArtifact(1), itemArtifact(2)];
  const r = await ingestAttempt(INPUT, shardDeps(shardLedger(), itemsApi([0, 1, 2].map((i) => itemBundle(i)), { artifacts })));
  assert.deepEqual(r.items.map((it) => it.reason), ['no_artifact', null, null]);
});

test('items with a result are skipped; a stale item is recorded without a download', async () => {
  const bundles = [0, 1, 2].map((i) => itemBundle(i));
  const row = multiItemRow(KEYS);
  row.items[0].outcome = 'accepted';
  row.items[1].current_fence = 20;
  const api = itemsApi(bundles);
  const ledger = fakeLedger([row]);
  const r = await ingestAttempt(INPUT, shardDeps(ledger, api));
  assert.deepEqual(r.items.map((it) => [it.index, it.outcome, it.reason]), [[1, 'rejected', 'stale_fence'], [2, 'accepted', null]]);
  assert.deepEqual(ledger.records.map((x) => [x.run_key, x.reason]), [[KEYS[1], 'stale_fence'], [KEYS[2], null]]);
  assert.deepEqual(api.calls.filter((c) => c[0] === 'downloadArtifact').map((c) => c[2]), [902]);
  assert.deepEqual(json(r.outputs.get('rejected/att-1/1/ingest.json')).problems, [{ reason: 'stale_fence', expected: 20, got: 8 }]);

  // Every open item stale: recorded without a single API call.
  const allStale = multiItemRow(KEYS);
  for (const it of allStale.items) it.current_fence = 20;
  const quiet = itemsApi(bundles);
  const s = await ingestAttempt(INPUT, shardDeps(fakeLedger([allStale]), quiet));
  assert.equal(s.outcome, 'rejected');
  assert.equal(s.reason, 'stale_fence');
  assert.equal(s.items.length, 3);
  assert.deepEqual(quiet.calls, []);

  // Every item has a result: already_recorded, nothing written.
  const allDone = multiItemRow(KEYS);
  for (const it of allDone.items) it.outcome = 'rejected';
  const d = await ingestAttempt(INPUT, shardDeps(fakeLedger([allDone]), itemsApi(bundles)));
  assert.equal(d.outcome, 'already_recorded');
  assert.equal(d.outputs.size, 0);
  assert.deepEqual(d.items, []);
});

test('a run-level failure is recorded for every item, without listing artifacts', async () => {
  const api = itemsApi([0, 1, 2].map((i) => itemBundle(i)), { run: defaultRun({ event: 'push' }) });
  const ledger = shardLedger();
  const r = await ingestAttempt(INPUT, shardDeps(ledger, api));
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.reason, 'run_event_mismatch');
  assert.deepEqual(ledger.records.map((x) => [x.run_key, x.reason]), KEYS.map((k) => [k, 'run_event_mismatch']));
  assert.deepEqual(api.calls.map((c) => c[0]), ['getRun']);
  assert.deepEqual([...r.outputs.keys()].sort(), ['rejected/att-1/0/ingest.json', 'rejected/att-1/1/ingest.json', 'rejected/att-1/2/ingest.json']);
});

test('openAttempt checks the attempt once and lets the caller judge one item at a time', async () => {
  const api = itemsApi([0, 1, 2].map((i) => itemBundle(i)));
  const ledger = shardLedger();
  const opened = await openAttempt(INPUT, shardDeps(ledger, api));
  assert.equal(opened.done, null);
  assert.equal(opened.attempt.attempt_id, 'att-1');
  assert.deepEqual(opened.items.map((it) => it.index), [0, 1, 2]);
  assert.deepEqual(api.calls.map((c) => c[0]), ['getRun', 'listRunArtifacts']);
  assert.equal(ledger.records.length, 0, 'opening records nothing');
  const one = await opened.judge(opened.items[1]);
  assert.equal(one.index, 1);
  assert.equal(one.outcome, 'accepted');
  assert.ok([...one.outputs.keys()].every((p) => p.startsWith('accepted/att-1/1/')));
  assert.deepEqual(ledger.records.map((x) => x.run_key), [KEYS[1]]);
  await assert.rejects(opened.judge(opened.items[1]), /judged already/);
  await assert.rejects(opened.judge({ index: 7 }), /one of the items/);

  const unknown = await openAttempt(INPUT, shardDeps(fakeLedger([]), api));
  assert.equal(unknown.done.outcome, 'rejected');
  assert.equal(unknown.done.reason, 'unknown_attempt');
  assert.deepEqual(unknown.items, []);
  assert.deepEqual([...unknown.done.outputs.keys()], ['rejected/att-1/ingest.json']);
});

test('an error part-way through a shard says which items were recorded', async () => {
  const bundles = [0, 1, 2].map((i) => itemBundle(i));
  const api = fakeGithub({
    artifacts: [0, 1, 2].map((i) => itemArtifact(i)),
    blob: (id) => (id === 901 ? new GithubError('GET x: HTTP 502', { status: 502, transient: true }) : fakeEncrypt(bundles[id - 900].tar)),
  });
  const ledger = shardLedger();
  await assert.rejects(
    ingestAttempt(INPUT, shardDeps(ledger, api)),
    (e) => e.transient === true && e.partial?.recorded === true && e.partial.items.map((it) => it.index).join() === '0',
  );
  assert.deepEqual(ledger.records.map((x) => x.run_key), [KEYS[0]]);
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

// ---- R-ING-04: judging runs in a worker thread with a time limit ----

test('R-ING-04: a judge that hangs is stopped at its time limit and the item is recorded as ingest_timeout', async () => {
  const { runAnalysis } = await import('../analyze.mjs');
  const hang = new URL('data:text/javascript,for (;;) {}');
  const analyze = (plaintext, ctx, opts) => runAnalysis(plaintext, ctx, { ...opts, workerUrl: hang });
  const t0 = performance.now();
  const { r, ledger } = await run({ analyze, judgeTimeoutMs: 300 });
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.reason, 'ingest_timeout');
  assert.equal(r.recorded, true);
  assert.deepEqual(ledger.records.map((x) => x.reason), ['ingest_timeout']);
  const report = json(r.outputs.get('rejected/att-1/0/ingest.json'));
  assert.match(report.problems[0].detail, /longer than 0.3 s and was stopped/);
  assert.ok(r.outputs.has('rejected/att-1/0/result.tar.age'), 'the ciphertext is kept');
});

test('R-ING-04: a judge that throws, or dies, records ingest_error instead of failing the tick', async () => {
  const { runAnalysis } = await import('../analyze.mjs');
  // analyzeBundle throws (no registry to check against): the thread reports the error.
  const broken = await run({ registry: null });
  assert.equal(broken.r.outcome, 'rejected');
  assert.equal(broken.r.reason, 'ingest_error');
  assert.match(json(broken.r.outputs.get('rejected/att-1/0/ingest.json')).problems[0].detail, /^judging failed: TypeError/);

  // The thread itself fails to load.
  const dies = new URL('data:text/javascript,throw new Error("boom")');
  const died = await run({ analyze: (p, c, o) => runAnalysis(p, c, { ...o, workerUrl: dies }) });
  assert.equal(died.r.reason, 'ingest_error');
  assert.match(json(died.r.outputs.get('rejected/att-1/0/ingest.json')).problems[0].detail, /boom/);

  // The thread runs out of memory.
  const hog = new URL('data:text/javascript,const a = []; for (;;) a.push(new Array(1e6).fill(1));');
  const oom = await run({ analyze: (p, c, o) => runAnalysis(p, c, { ...o, workerUrl: hog, maxMemoryMb: 32 }) });
  assert.equal(oom.r.reason, 'ingest_error');
  assert.match(json(oom.r.outputs.get('rejected/att-1/0/ingest.json')).problems[0].detail, /ERR_WORKER_OUT_OF_MEMORY/);
});

test('R-ING-04: the judge thread gets no environment', async () => {
  const { runAnalysis } = await import('../analyze.mjs');
  const peek = new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.postMessage({ error: JSON.stringify(Object.keys(process.env)) });');
  const out = await runAnalysis(Buffer.alloc(0), {}, { workerUrl: peek });
  assert.equal(out.error, '[]');
});

// ---- R-ING-03: size caps ----

test('R-ING-03: a file over the per-file cap is rejected as file_too_large; the caps are the contract\'s', async () => {
  const { MAX_FILE_BYTES, MAX_BUNDLE_BYTES, MAX_ARTIFACT_BYTES } = await import('../../worker-kit/contract.mjs');
  const ingestCaps = await import('../ingest.mjs');
  assert.equal(MAX_FILE_BYTES, 8 * 1024 ** 2);
  assert.equal(MAX_BUNDLE_BYTES, 64 * 1024 ** 2);
  assert.equal(MAX_ARTIFACT_BYTES, 65 * 1024 ** 2);
  assert.equal(ingestCaps.MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES);
  assert.equal(ingestCaps.MAX_BUNDLE_BYTES, MAX_BUNDLE_BYTES);

  const big = makeBundle({ extraTarEntries: [['raw/capture.bin', Buffer.alloc(MAX_FILE_BYTES + 1, 0x61)]] });
  const { r, ledger } = await run({ bundle: big });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.reason, 'file_too_large');
  assert.deepEqual(ledger.records.map((x) => x.reason), ['file_too_large']);
  const report = json(r.outputs.get('rejected/att-1/0/ingest.json'));
  assert.deepEqual(report.problems, [{ reason: 'file_too_large', path: 'raw/capture.bin', expected: `<= ${MAX_FILE_BYTES}`, got: MAX_FILE_BYTES + 1 }]);

  // At the cap is fine as far as size goes (this one is then unlisted).
  const at = await run({ bundle: makeBundle({ extraTarEntries: [['raw/capture.bin', Buffer.alloc(MAX_FILE_BYTES, 0x61)]] }) });
  assert.equal(at.r.reason, 'unlisted_file');
});

test('R-ING-03: an artifact over 65 MiB is rejected without a download', async () => {
  const { MAX_ARTIFACT_BYTES } = await import('../../worker-kit/contract.mjs');
  const api = fakeGithub({ artifacts: [artifactEntry({ size_in_bytes: MAX_ARTIFACT_BYTES + 1 })], blob: Buffer.alloc(0) });
  const { r } = await run({ github: api });
  assert.equal(r.reason, 'artifact_too_large');
  assert.ok(!api.calls.some((c) => c[0] === 'downloadArtifact'));
});

test('R-ING-03: a full-size bundle of crafted text is judged well inside the time limit', async () => {
  const { MAX_FILE_BYTES } = await import('../../worker-kit/contract.mjs');
  // Two files at the cap, each built against one of the old quadratic scans.
  const files = {
    ...defaultFiles(),
    'results/dots.txt': 'a.'.repeat(MAX_FILE_BYTES / 2),
    'results/claims.txt': `attempt_id=att-1\n`.repeat(Math.floor(MAX_FILE_BYTES / 17)),
  };
  const bundle = makeBundle({ files });
  const t0 = performance.now();
  const { r } = await run({ bundle });
  const ms = performance.now() - t0;
  assert.equal(r.outcome, 'accepted', r.reason);
  assert.ok(ms < 20_000, `took ${ms.toFixed(0)} ms`);
});

// ---- R-ING-16: retryable skips ----

const retryMeta = (skips) => ({ skips });
const RATE_LIMITED = { stage: 'fetch', reason: 'rate_limited', retryable: true };
const UPSTREAM = { stage: 'install', reason: 'upstream_unavailable', retryable: true };
// A retryable skip that is not throttling: bounded by MAX_RETRIES (since R-SUB-04,
// rate limits and upstream outages have their own time window).
const START_TIMEOUT = { stage: 'start', reason: 'timeout_start', retryable: true };

test('R-ING-16: a bundle whose every skip is retryable is sent back as retry_later; the retries are bounded', async () => {
  const bundle = makeBundle({ meta: retryMeta([START_TIMEOUT, RATE_LIMITED]) });
  const first = await run({ bundle });
  assert.equal(first.r.outcome, 'rejected');
  assert.equal(first.r.reason, 'retry_later');
  assert.deepEqual(first.ledger.records.map((x) => [x.outcome, x.reason]), [['rejected', 'retry_later']]);
  const report = json(first.r.outputs.get('rejected/att-1/0/ingest.json'));
  assert.equal(report.bundle.retryable_skips, 2);
  assert.deepEqual(report.retries, { before: 0, max: 3 });
  assert.match(report.problems[0].detail, /retry 1 of 3/);

  const third = await run({ bundle, ledger: fakeLedger([expectedRow({ retries: 2 })]) });
  assert.equal(third.r.reason, 'retry_later');
  assert.match(json(third.r.outputs.get('rejected/att-1/0/ingest.json')).problems[0].detail, /retry 3 of 3/);

  // After three retries it is kept as it is: accepted, with its skips.
  const kept = await run({ bundle, ledger: fakeLedger([expectedRow({ retries: 3 })]) });
  assert.equal(kept.r.outcome, 'accepted');
  assert.deepEqual(json(kept.r.outputs.get('accepted/att-1/0/ingest.json')).retries, { before: 3, max: 3, exhausted: true });
});

test('R-ING-16: one skip that is not retryable, or no skips at all, is accepted as before', async () => {
  const mixed = await run({ bundle: makeBundle({ meta: retryMeta([RATE_LIMITED, { stage: 'start', reason: 'timeout_start' }]) }) });
  assert.equal(mixed.r.outcome, 'accepted');
  const none = await run({ bundle: makeBundle({ meta: retryMeta([]) }) });
  assert.equal(none.r.outcome, 'accepted');
  // A retryable skip never outranks a real problem.
  const bad = await run({ bundle: makeBundle({ meta: retryMeta([RATE_LIMITED]), identity: { fence: 6 } }) });
  assert.equal(bad.r.reason, 'fence_mismatch');
});

test('R-SUB-04: a throttled bundle is sent back as retry_throttled, not counted towards MAX_RETRIES, for up to the retry window', async () => {
  const bundle = makeBundle({ meta: retryMeta([RATE_LIMITED, UPSTREAM]) });
  const first = await run({ bundle });
  assert.equal(first.r.outcome, 'rejected');
  assert.equal(first.r.reason, 'retry_throttled');
  assert.deepEqual(first.ledger.records.map((x) => [x.outcome, x.reason]), [['rejected', 'retry_throttled']]);
  assert.deepEqual(json(first.r.outputs.get('rejected/att-1/0/ingest.json')).retries, { throttled_before: 0, throttled_since: null, window_ms: 7 * 86_400_000 });

  // Earlier retry_later decisions and many throttled ones do not end it while the window is open.
  const sixDays = new Date(NOW().getTime() - 6 * 86_400_000).toISOString();
  const later = await run({ bundle, ledger: fakeLedger([expectedRow({ retries: 5, throttled: 20, throttled_since: sixDays })]) });
  assert.equal(later.r.reason, 'retry_throttled');
  assert.match(json(later.r.outputs.get('rejected/att-1/0/ingest.json')).problems[0].detail, /throttled retry 21/);

  // Seven days after the first throttled retry it is kept as it is: accepted, with its skips.
  const eightDays = new Date(NOW().getTime() - 8 * 86_400_000).toISOString();
  const kept = await run({ bundle, ledger: fakeLedger([expectedRow({ retries: 0, throttled: 30, throttled_since: eightDays })]) });
  assert.equal(kept.r.outcome, 'accepted');
  assert.equal(json(kept.r.outputs.get('accepted/att-1/0/ingest.json')).retries.exhausted, true);

  // A retryable skip that is not throttling still goes through the count cap.
  const capped = await run({ bundle: makeBundle({ meta: retryMeta([START_TIMEOUT]) }), ledger: fakeLedger([expectedRow({ retries: 3, throttled: 9, throttled_since: sixDays })]) });
  assert.equal(capped.r.outcome, 'accepted');
});

test('R-SUB-06: an accepted bundle whose every skip is retryable and no records is recorded as skips_only; any permanent skip is not', async () => {
  const files = defaultFiles();
  delete files['observations/check.ndjson'];
  // Retries ran out: retryable skips, nothing measured.
  const exhausted = await run({ bundle: makeBundle({ meta: retryMeta([START_TIMEOUT]), files }), ledger: fakeLedger([expectedRow({ retries: 3 })]) });
  assert.equal(exhausted.r.outcome, 'accepted');
  assert.equal(exhausted.ledger.records[0].resultOutcome, 'skips_only');
  const throttled = await run({ bundle: makeBundle({ meta: retryMeta([RATE_LIMITED]), files }), ledger: fakeLedger([expectedRow({ throttled: 40, throttled_since: new Date(NOW().getTime() - 8 * 86_400_000).toISOString() })]) });
  assert.equal(throttled.r.outcome, 'accepted');
  assert.equal(throttled.ledger.records[0].resultOutcome, 'skips_only');
  // Any permanent skip makes it an ordinary result, even beside a retryable one.
  const mixed = await run({ bundle: makeBundle({ meta: retryMeta([RATE_LIMITED, { stage: 'start', reason: 'remote_only' }]), files }) });
  assert.equal(mixed.r.outcome, 'accepted');
  assert.equal(mixed.ledger.records[0].resultOutcome, undefined);
  // Only permanent skips: an ordinary result, kept for the tier max age.
  for (const reason of ['remote_only', 'no_runnable_artifact', 'policy_excluded']) {
    const permanent = await run({ bundle: makeBundle({ meta: retryMeta([{ stage: 'scan', reason }]), files }) });
    assert.equal(permanent.r.outcome, 'accepted', reason);
    assert.equal(permanent.ledger.records[0].resultOutcome, undefined, reason);
  }
  // Records, or no skips at all, are an ordinary result.
  const measured = await run({ bundle: makeBundle({ meta: retryMeta([START_TIMEOUT]) }), ledger: fakeLedger([expectedRow({ retries: 3 })]) });
  assert.equal(measured.ledger.records[0].resultOutcome, undefined);
  const empty = await run({ bundle: makeBundle({ files }) });
  assert.equal(empty.ledger.records[0].resultOutcome, undefined);
});
