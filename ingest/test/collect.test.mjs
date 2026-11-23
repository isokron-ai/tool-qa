// Ingest inside the pump (ingest/collect.mjs): real SQLite state, a fake GitHub
// API, fake crypto (plus one test with the real age binary when it is there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../../state/db.mjs';
import { ApiBudget, budgetedFetch } from '../../pump/budgets.mjs';
import { API, fakeApi } from '../../test/lib/fake-api.mjs';
import { readTar } from '../../worker-kit/tar.mjs';
import { ageDecrypt, ageEncrypt } from '../age.mjs';
import { createCollector, IngestSetupError } from '../collect.mjs';
import { parseRegistry } from '../registry.mjs';
import {
  artifactEntry, defaultRun, fakeDecrypt, fakeEncrypt, makeBundle, REGISTRY_TEXT, RUN_ID, RUN_KEY, WORKER_REPO, WORKFLOW_SHA,
} from '../testkit.mjs';

const T0 = Date.parse('2026-11-23T12:00:00Z');
const MIN = 60_000;
const KEY_B = 'b'.repeat(64);
// Built at run time so the file holds no key-shaped literal.
const PUBKEY = `age1${'q'.repeat(58)}`;
const OTHER_PUBKEY = `age1${'p'.repeat(58)}`;

/** One dispatch the way the pump makes it: a slot, a lease per run_key, the ledger row, the run id. */
function setup({ runKeys = [RUN_KEY], ttlMs = 30 * MIN, runId = RUN_ID, now = T0, attemptId = 'att-1' } = {}) {
  const db = openState(':memory:');
  db.acquireSlot(attemptId, { budget: 5, ttlMs, now });
  const items = runKeys.map((runKey, i) => {
    const l = db.acquireLease(runKey, attemptId, { ttlMs, now });
    assert.equal(l.acquired, true);
    return { run_key: runKey, subject: `repo:${i + 1}`, fence: l.fence };
  });
  db.createDispatch({
    attemptId, shardId: 's1', workflow: 'qa', repo: WORKER_REPO, workflowFile: 'qa-worker.yml', ref: 'main',
    expires: now + ttlMs, items, now,
  });
  db.markDispatched(attemptId, runId === null ? {} : { runId, workflowSha: WORKFLOW_SHA, correlatedBy: 'response' });
  return { db, fence: items[0].fence, items };
}

/** The worker repository's side of the API. `run` may be a function (called per request) or null (404). */
function worker({ bundle, blob, run = defaultRun(), artifacts = [artifactEntry()], runs = [] } = {}) {
  const body = blob ?? (bundle ? fakeEncrypt(bundle.tar) : Buffer.alloc(0));
  return fakeApi([
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}`, () => {
      const r = typeof run === 'function' ? run() : run;
      return r ? { body: r } : { status: 404, body: { message: 'Not Found' } };
    }],
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}/artifacts`, () => ({ body: { total_count: artifacts.length, artifacts } })],
    ['GET', `/repos/${WORKER_REPO}/actions/artifacts/901/zip`, () => ({ status: 302, headers: { location: 'https://blob.example.test/a/901' } })],
    ['GET', '/a/901', () => ({ body })],
    ['GET', `/repos/${WORKER_REPO}/actions/workflows/qa-worker.yml/runs`, () => ({ body: { total_count: runs.length, workflow_runs: runs } })],
  ]);
}

function harness({ api, pub = PUBKEY, sealTo, ...over } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'collect-test-'));
  const pubFile = join(dir, 'ingest.pub');
  writeFileSync(pubFile, `# test recipient\n${pub}\n`);
  const outDir = join(dir, 'out');
  const minted = [];
  const clock = { t: T0 + 5 * MIN };
  const mintToken = async (args) => {
    minted.push(args);
    return { token: `tok-${minted.length}`, expiresAt: clock.t + 60 * MIN };
  };
  const collector = createCollector({
    env: {},
    identity: 'test-identity',
    fetch: api.fetch,
    apiUrl: API,
    sleep: async () => {},
    outDir,
    sealTo: sealTo ?? pubFile,
    registry: { ...parseRegistry(REGISTRY_TEXT), source: 'test' },
    crypto: { decrypt: fakeDecrypt, encrypt: (plaintext) => fakeEncrypt(plaintext), publicKey: () => PUBKEY },
    ...over,
  });
  const lines = [];
  const collect = (db, more = {}) => collector.collect({ db, now: () => clock.t, log: (l) => lines.push(l), mintToken, ...more });
  const sealed = (attemptId = 'att-1') => join(outDir, `ingest-${attemptId}.tar.age`);
  const opened = (attemptId = 'att-1') => new Map(readTar(fakeDecrypt(readFileSync(sealed(attemptId)))).map((e) => [e.path, e.data]));
  return { collector, collect, minted, lines, outDir, clock, sealed, opened, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a finished run is judged, recorded, sealed and its dispatch closed', async () => {
  const { db, fence } = setup();
  const api = worker({ bundle: makeBundle({ identity: { fence } }) });
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.equal(s.checked, 1);
    assert.equal(s.judged, 1);
    assert.equal(s.recorded, 1);
    assert.equal(s.errors, 0);
    assert.equal(s.stopped, null);
    assert.equal(s.changed, true);
    assert.deepEqual(s.outcomes, { accepted: 1 });

    const result = db.getResult(RUN_KEY);
    assert.equal(result.attempt_id, 'att-1');
    assert.equal(result.outcome, 'accepted');
    assert.equal(db.getAttempt('att-1').outcome, 'accepted');
    const d = db.getDispatch('att-1');
    assert.equal(d.status, 'done');
    assert.equal(d.close_reason, 'results_in');
    assert.deepEqual(db.openSlots(), [], 'the slot is free');
    assert.equal(db.getLease(RUN_KEY).holder, null, 'the lease is released');

    assert.deepEqual(h.minted, [{ repositories: ['mcp-check'], permissions: { actions: 'read' } }]);
    const blob = api.calls.find((c) => c.url.startsWith('https://blob.example.test/'));
    assert.equal(blob.headers.get('authorization'), null, 'no token past the API host');
    for (const c of api.calls.filter((x) => x.url.startsWith(API))) assert.equal(c.headers.get('authorization'), 'Bearer tok-1');

    assert.equal(statSync(h.sealed()).mode & 0o777, 0o600);
    assert.equal(statSync(h.outDir).mode & 0o777, 0o700);
    const files = h.opened();
    assert.ok(files.has('accepted/att-1/manifest.json'));
    assert.ok(files.has('accepted/att-1/observations/check.ndjson'));
    const report = JSON.parse(files.get('accepted/att-1/ingest.json'));
    assert.equal(report.outcome, 'accepted');
    assert.deepEqual(report.recorded, { accepted: true, reason: null });
    assert.deepEqual(readdirSync(h.outDir), ['ingest-att-1.tar.age'], 'no temporary files left behind');
    assert.ok(h.lines.some((l) => /^ingest: qa shard s1 \(att-1\): accepted, recorded, outputs sealed$/.test(l)), h.lines.join('\n'));

    const calls = api.calls.length;
    const again = await h.collect(db);
    assert.equal(again.checked, 0, 'nothing is left to look at');
    assert.equal(again.changed, false);
    assert.equal(api.calls.length, calls);
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a run still in progress waits; a later tick judges it; tokens are reused until they near expiry', async () => {
  const { db, fence } = setup({ ttlMs: 120 * MIN });
  let status = 'in_progress';
  const api = worker({ bundle: makeBundle({ identity: { fence } }), run: () => defaultRun({ status, conclusion: null }) });
  const h = harness({ api });
  try {
    const first = await h.collect(db);
    assert.equal(first.waiting, 1);
    assert.equal(first.judged, 0);
    assert.equal(first.changed, false);
    assert.equal(db.getDispatch('att-1').status, 'dispatched');
    assert.equal(api.calls.filter((c) => c.path.endsWith('/artifacts')).length, 0);

    h.clock.t += 10 * MIN;
    assert.equal((await h.collect(db)).waiting, 1);
    assert.equal(h.minted.length, 1, 'the token is reused');

    h.clock.t += 50 * MIN;
    status = 'completed';
    const last = await h.collect(db);
    assert.equal(h.minted.length, 2, 'a token five minutes from expiry is replaced');
    assert.equal(last.judged, 1);
    assert.deepEqual(last.outcomes, { accepted: 1 });
    assert.equal(db.getResult(RUN_KEY).attempt_id, 'att-1');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a run without its result artifact is recorded as rejected and frees the lease and slot', async () => {
  const { db } = setup();
  const api = worker({ artifacts: [] });
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.deepEqual(s.outcomes, { rejected: 1 });
    assert.equal(s.recorded, 1);
    assert.equal(db.getResult(RUN_KEY), undefined);
    assert.equal(db.getAttempt('att-1').outcome, 'rejected');
    assert.equal(db.rejectedCount(RUN_KEY), 1, 'it counts towards parking the run_key');
    assert.equal(db.getDispatch('att-1').status, 'done');
    assert.equal(db.getLease(RUN_KEY).holder, null);
    assert.deepEqual(db.openSlots(), []);
    const report = JSON.parse(h.opened().get('rejected/att-1/ingest.json'));
    assert.equal(report.reason, 'no_artifact');
    assert.ok(h.lines.some((l) => l.includes('rejected (no_artifact), recorded')));
  } finally {
    h.cleanup();
    db.close();
  }
});

test('when the outputs cannot be sealed nothing is recorded, and the next tick judges it again', async () => {
  const { db, fence } = setup();
  const api = worker({ bundle: makeBundle({ identity: { fence } }) });
  let fail = true;
  const encrypt = (plaintext) => {
    if (fail) throw new Error('disk full');
    return fakeEncrypt(plaintext);
  };
  const h = harness({ api, crypto: { decrypt: fakeDecrypt, encrypt, publicKey: () => PUBKEY } });
  try {
    const s = await h.collect(db);
    assert.equal(s.errors, 1);
    assert.equal(s.recorded, 0);
    assert.equal(s.changed, false);
    assert.equal(db.getAttempt('att-1').outcome, null, 'the recorded result was rolled back');
    assert.equal(db.getResult(RUN_KEY), undefined);
    assert.equal(db.listAttempts('repo:1').length, 0);
    assert.equal(db.getDispatch('att-1').status, 'dispatched');
    assert.equal(db.getLease(RUN_KEY).holder, 'att-1');
    assert.equal(existsSync(h.sealed()), false);
    assert.ok(h.lines.some((l) => /att-1.*disk full.*try again/.test(l)), h.lines.join('\n'));

    fail = false;
    const again = await h.collect(db);
    assert.deepEqual(again.outcomes, { accepted: 1 });
    assert.equal(db.getResult(RUN_KEY).attempt_id, 'att-1');
    assert.ok(existsSync(h.sealed()));
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a dispatch sent without a run id is matched to its run by run name', async () => {
  const { db, fence } = setup({ runId: null });
  const runs = [
    { id: 77, name: 'shard other', display_title: 'shard other', head_sha: WORKFLOW_SHA },
    { id: RUN_ID, name: 'qa', display_title: 'shard s1', head_sha: WORKFLOW_SHA, html_url: 'https://github.test/runs/4242' },
  ];
  const api = worker({ bundle: makeBundle({ identity: { fence } }), runs });
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.equal(s.correlated, 1);
    assert.deepEqual(s.outcomes, { accepted: 1 });
    const d = db.getDispatch('att-1');
    assert.equal(d.run_id, String(RUN_ID));
    assert.equal(d.correlated_by, 'run-name');
    const list = api.calls.find((c) => c.path.endsWith('/qa-worker.yml/runs'));
    assert.equal(list.query.get('event'), 'workflow_dispatch');
    assert.equal(list.query.get('created'), '>=2026-11-23T11:58:00Z');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('no run with that name yet, or a run id GitHub does not know: the dispatch waits for its lease', async () => {
  const unnamed = setup({ runId: null });
  const missing = setup();
  const h1 = harness({ api: worker({ runs: [] }) });
  const api2 = worker({ run: null });
  const h2 = harness({ api: api2 });
  try {
    const s1 = await h1.collect(unnamed.db);
    assert.equal(s1.waiting, 1);
    assert.equal(s1.changed, false);
    assert.equal(unnamed.db.getDispatch('att-1').run_id, null);

    const s2 = await h2.collect(missing.db);
    assert.equal(s2.waiting, 1);
    assert.equal(s2.changed, false);
    assert.equal(missing.db.getDispatch('att-1').status, 'dispatched');
    assert.equal(api2.calls.filter((c) => c.path.endsWith('/artifacts')).length, 0);
    assert.ok(h2.lines.some((l) => /run 4242 was not found/.test(l)), h2.lines.join('\n'));
  } finally {
    h1.cleanup();
    h2.cleanup();
    unnamed.db.close();
    missing.db.close();
  }
});

test('a dispatch with several run_keys cannot be judged: it is closed as unsupported_shard', async () => {
  const { db } = setup({ runKeys: [RUN_KEY, KEY_B] });
  const api = worker();
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.equal(s.unsupported, 1);
    assert.equal(s.closed, 1);
    assert.equal(s.changed, true);
    const d = db.getDispatch('att-1');
    assert.equal(d.status, 'done');
    assert.equal(d.close_reason, 'unsupported_shard');
    assert.equal(db.getLease(RUN_KEY).holder, null);
    assert.equal(db.getLease(KEY_B).holder, null);
    assert.deepEqual(db.openSlots(), []);
    assert.equal(api.calls.length, 0);
    assert.equal(h.minted.length, 0);
    assert.ok(h.lines.some((l) => /carries 2 run_keys.*shard_size 1/.test(l)), h.lines.join('\n'));
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a result that arrives after its lease expired is judged once and kept as rejected', async () => {
  const { db, fence } = setup();
  db.reapExpiredDispatches({ now: T0 + 31 * MIN });
  assert.equal(db.getDispatch('att-1').status, 'expired');
  const api = worker({ bundle: makeBundle({ identity: { fence } }) });
  const h = harness({ api });
  h.clock.t = T0 + 40 * MIN;
  try {
    const s = await h.collect(db);
    assert.equal(s.recorded, 1);
    assert.deepEqual(s.outcomes, { rejected: 1 });
    assert.equal(db.getResult(RUN_KEY), undefined);
    assert.equal(db.getAttempt('att-1').outcome, 'rejected');
    assert.equal(db.listAttempts('repo:1')[0].reason, 'lease_expired');
    const report = JSON.parse(h.opened().get('rejected/att-1/ingest.json'));
    assert.equal(report.reason, 'lease_expired');

    h.clock.t += 20 * MIN;
    const calls = api.calls.length;
    assert.equal((await h.collect(db)).checked, 0, 'judged once');
    assert.equal(api.calls.length, calls);
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a late result whose run_key was leased again is recorded as stale_fence without a download', async () => {
  const { db } = setup();
  db.reapExpiredDispatches({ now: T0 + 31 * MIN });
  const next = db.acquireLease(RUN_KEY, 'att-2', { ttlMs: 30 * MIN, now: T0 + 32 * MIN });
  assert.equal(next.acquired, true);
  const api = worker();
  const h = harness({ api });
  h.clock.t = T0 + 40 * MIN;
  try {
    const s = await h.collect(db);
    assert.equal(s.recorded, 1);
    assert.deepEqual(s.outcomes, { rejected: 1 });
    assert.equal(db.listAttempts('repo:1')[0].reason, 'stale_fence');
    assert.equal(db.rejectedCount(RUN_KEY), 0, 'a fencing failure does not count against the run_key');
    assert.equal(db.getLease(RUN_KEY).holder, 'att-2', 'the newer lease is untouched');
    assert.equal(api.calls.filter((c) => c.path.endsWith('/artifacts') || c.path.endsWith('/zip')).length, 0);
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a late run that is still going is looked at again only every few minutes', async () => {
  const { db } = setup();
  db.reapExpiredDispatches({ now: T0 + 31 * MIN });
  const api = worker({ run: defaultRun({ status: 'in_progress', conclusion: null }) });
  const h = harness({ api });
  h.clock.t = T0 + 40 * MIN;
  try {
    assert.equal((await h.collect(db)).waiting, 1);
    h.clock.t += 2 * MIN;
    assert.equal((await h.collect(db)).checked, 0);
    h.clock.t += 9 * MIN;
    assert.equal((await h.collect(db)).waiting, 1);
    assert.equal(api.calls.length, 2);
  } finally {
    h.cleanup();
    db.close();
  }
});

test('no new judgement starts after the deadline', async () => {
  const { db, fence } = setup();
  const api = worker({ bundle: makeBundle({ identity: { fence } }) });
  const h = harness({ api });
  try {
    const s = await h.collect(db, { deadline: h.clock.t });
    assert.equal(s.stopped, 'deadline');
    assert.equal(s.judged, 0);
    assert.equal(api.calls.length, 0);
    assert.equal(db.getDispatch('att-1').status, 'dispatched');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a refused API budget ends ingest for the tick without recording anything', async () => {
  const { db, fence } = setup();
  const api = worker({ bundle: makeBundle({ identity: { fence } }) });
  const budget = new ApiBudget({ now: () => T0, sleep: async () => {}, families: { actions: { perHour: 0, perMinute: 0 } } });
  const h = harness({ api, fetch: budgetedFetch(api.fetch, budget, { apiUrl: API }) });
  try {
    const s = await h.collect(db);
    assert.equal(s.stopped, 'budget');
    assert.equal(s.errors, 0);
    assert.equal(s.changed, false);
    assert.equal(api.calls.length, 0);
    assert.equal(db.getDispatch('att-1').status, 'dispatched');
    assert.ok(h.lines.some((l) => /API budget/.test(l)), h.lines.join('\n'));
  } finally {
    h.cleanup();
    db.close();
  }
});

test('setup problems stop ingest before any API call, with an error that says what to fix', async () => {
  const cases = [
    [{ sealTo: undefined, useDefaultSealTo: true }, /worker-kit\/ingest\.pub has no age public key yet \(it is still the placeholder\).*dispatches no work/],
    [{ identity: '' }, /AGE_IDENTITY is not set/],
    [{ crypto: { decrypt: fakeDecrypt, encrypt: fakeEncrypt, publicKey: () => OTHER_PUBKEY } }, /AGE_IDENTITY does not belong to any key in .*ingest\.pub/],
    [{ crypto: { decrypt: fakeDecrypt, encrypt: fakeEncrypt, publicKey: () => { throw new Error('age-keygen -y failed'); } } }, /AGE_IDENTITY is not a usable age identity \(age-keygen -y failed\)/],
  ];
  for (const [over, message] of cases) {
    const { db } = setup();
    const api = worker();
    const { useDefaultSealTo, ...rest } = over;
    const h = harness({ api, ...rest });
    const c = useDefaultSealTo
      ? createCollector({ env: {}, identity: 'test-identity', fetch: api.fetch, apiUrl: API, outDir: h.outDir, crypto: { publicKey: () => PUBKEY } })
      : h.collector;
    try {
      await assert.rejects(
        c.collect({ db, now: () => T0, log: () => {}, mintToken: async () => assert.fail('no token is minted') }),
        (err) => err instanceof IngestSetupError && message.test(err.message),
        String(message),
      );
      assert.equal(api.calls.length, 0);
      assert.equal(db.getDispatch('att-1').status, 'dispatched');
    } finally {
      h.cleanup();
      db.close();
    }
  }
});

test('check() also refuses enabled workflows whose shards carry more than one run_key', async () => {
  const h = harness({ api: worker() });
  try {
    await assert.rejects(
      h.collector.check({ workflows: { qa: { enabled: true, shard_size: 10 }, off: { enabled: false, shard_size: 25 } } }),
      (err) => err instanceof IngestSetupError && /workflow "qa" has shard_size 10/.test(err.message) && /shard_size 1/.test(err.message),
    );
    await h.collector.check({ workflows: { qa: { enabled: true, shard_size: 1 }, off: { enabled: false, shard_size: 25 } } });
    await h.collector.check();
  } finally {
    h.cleanup();
  }
});

test('with nothing waiting, collect() makes no calls and needs no keys', async () => {
  const db = openState(':memory:');
  const api = worker();
  const c = createCollector({ env: {}, fetch: api.fetch, apiUrl: API });
  try {
    const s = await c.collect({ db, now: () => T0, log: () => {}, mintToken: async () => assert.fail('no token is minted') });
    assert.equal(s.checked, 0);
    assert.equal(s.changed, false);
    assert.equal(api.calls.length, 0);
  } finally {
    db.close();
  }
});

const AGE = process.env.AGE_BIN || 'age';
const KEYGEN = process.env.AGE_KEYGEN_BIN || 'age-keygen';
const haveAge = spawnSync(AGE, ['--version']).status === 0 && spawnSync(KEYGEN, ['--version']).status === 0;

test('with the real age binary: the bundle is decrypted and the outputs sealed to ingest.pub', {
  skip: haveAge ? false : 'age and age-keygen are not on PATH (set AGE_BIN / AGE_KEYGEN_BIN to run this test)',
}, async () => {
  const identity = spawnSync(KEYGEN, [], { encoding: 'utf8' }).stdout;
  const recipient = spawnSync(KEYGEN, ['-y'], { input: identity, encoding: 'utf8' }).stdout.trim();
  const { db, fence } = setup();
  const bundle = makeBundle({ identity: { fence } });
  const api = worker({ blob: ageEncrypt({ plaintext: bundle.tar, recipients: [recipient], ageBin: AGE }) });
  const h = harness({ api, pub: recipient, identity, crypto: {}, env: { AGE_BIN: AGE, AGE_KEYGEN_BIN: KEYGEN } });
  try {
    const s = await h.collect(db);
    assert.deepEqual(s.outcomes, { accepted: 1 });
    const tar = ageDecrypt({ ciphertext: readFileSync(h.sealed()), identity, ageBin: AGE });
    const paths = readTar(tar).map((e) => e.path);
    assert.ok(paths.includes('accepted/att-1/ingest.json'));
    assert.ok(paths.includes('accepted/att-1/manifest.json'));
    for (const l of h.lines) assert.ok(!l.includes('AGE-SECRET-KEY'), l);
  } finally {
    h.cleanup();
    db.close();
  }
});
