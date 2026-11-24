// Ingest inside the pump (ingest/collect.mjs): real SQLite state, a fake GitHub
// API, fake crypto (plus one test with the real age binary when it is there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../../state/db.mjs';
import { ApiBudget, BudgetExceededError, budgetedFetch } from '../../pump/budgets.mjs';
import { API, fakeApi } from '../../test/lib/fake-api.mjs';
import { readTar } from '../../worker-kit/tar.mjs';
import { AgeError, ageDecrypt, ageEncrypt } from '../age.mjs';
import { createCollector, IngestSetupError } from '../collect.mjs';
import { parseRegistry } from '../registry.mjs';
import {
  artifactEntry, defaultRun, fakeDecrypt, fakeEncrypt, makeBundle, REGISTRY_TEXT, RUN_ID, RUN_KEY, WORKER_REPO, WORKFLOW_SHA,
} from '../testkit.mjs';

const T0 = Date.parse('2026-11-23T12:00:00Z');
const MIN = 60_000;
// Built at run time so the file holds no key-shaped literal.
const PUBKEY = `age1${'q'.repeat(58)}`;
const OTHER_PUBKEY = `age1${'p'.repeat(58)}`;

/** One dispatch the way the pump makes it: a slot, a lease per run_key, the ledger row, the run id. */
function setup({ runKeys = [RUN_KEY], ttlMs = 30 * MIN, runId = RUN_ID, now = T0, attemptId = 'att-1', expectedSha = null } = {}) {
  const db = openState(':memory:');
  db.acquireSlot(attemptId, { budget: 5, ttlMs, now });
  const items = runKeys.map((runKey, i) => {
    const l = db.acquireLease(runKey, attemptId, { ttlMs, now });
    assert.equal(l.acquired, true);
    return { run_key: runKey, subject: `repo:${i + 1}`, fence: l.fence };
  });
  db.createDispatch({
    attemptId, shardId: 's1', workflow: 'qa', repo: WORKER_REPO, workflowFile: 'qa-worker.yml', ref: 'main',
    expires: now + ttlMs, items, workflowSha: expectedSha, now,
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
  const sealed = (attemptId = 'att-1', index = 0) => join(outDir, `ingest-${attemptId}-${index}.tar.age`);
  const opened = (attemptId = 'att-1', index = 0) => new Map(readTar(fakeDecrypt(readFileSync(sealed(attemptId, index)))).map((e) => [e.path, e.data]));
  return { collector, collect, minted, lines, dir, outDir, clock, sealed, opened, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    assert.equal(db.getAttempt('att-1').items[0].outcome, 'accepted');
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
    assert.ok(files.has('accepted/att-1/0/manifest.json'));
    assert.ok(files.has('accepted/att-1/0/observations/check.ndjson'));
    const report = JSON.parse(files.get('accepted/att-1/0/ingest.json'));
    assert.equal(report.outcome, 'accepted');
    assert.deepEqual(report.recorded, { accepted: true, reason: null });
    assert.deepEqual(readdirSync(h.outDir), ['ingest-att-1-0.tar.age'], 'no temporary files left behind');
    assert.ok(h.lines.some((l) => /^ingest: qa shard s1 \(att-1\) item 0: accepted, recorded, outputs sealed$/.test(l)), h.lines.join('\n'));

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
    assert.equal(db.getAttempt('att-1').items[0].outcome, 'rejected');
    assert.equal(db.rejectedCount(RUN_KEY), 1, 'it counts towards parking the run_key');
    assert.equal(db.getDispatch('att-1').status, 'done');
    assert.equal(db.getLease(RUN_KEY).holder, null);
    assert.deepEqual(db.openSlots(), []);
    const report = JSON.parse(h.opened().get('rejected/att-1/0/ingest.json'));
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
    assert.equal(s.changed, true, 'the failure is counted in the state');
    assert.equal(db.ingestFailures('att-1', 0).count, 1);
    assert.equal(db.getAttempt('att-1').items[0].outcome, null, 'the recorded result was rolled back');
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
    assert.equal(db.ingestFailures('att-1', 0).count, 0, 'the count goes with the decision');
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

// ---- shards of several items ----

/** n distinct run_keys. */
const shardKeys = (n) => Array.from({ length: n }, (_, i) => `${'e'.repeat(60)}${String(i).padStart(4, '0')}`);

/** Item i's encrypted bundle: its own run_key and fence, unless `identity` forges them. */
const itemBlob = (items, i, identity = {}) => fakeEncrypt(makeBundle({ identity: { run_key: items[i].run_key, fence: items[i].fence, ...identity } }).tar);

/** For each index: artifact 900 + i, named result-att-1-<i>.tar.age, holding item i's bundle. */
function shardArtifacts(items, indexes = items.map((_, i) => i)) {
  return {
    artifacts: indexes.map((i) => artifactEntry({ id: 900 + i, name: `result-att-1-${i}.tar.age` })),
    blobs: Object.fromEntries(indexes.map((i) => [900 + i, itemBlob(items, i)])),
  };
}

/** The worker repository's side of the API for a shard; `blobs` maps artifact ids to downloads. */
function shardWorker({ artifacts, blobs, run = defaultRun() }) {
  return fakeApi([
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}`, () => ({ body: run })],
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}/artifacts`, () => ({ body: { total_count: artifacts.length, artifacts } })],
    ['GET', /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/\d+\/zip$/, (req) => ({
      status: 302, headers: { location: `https://blob.example.test/a/${req.path.split('/').at(-2)}` },
    })],
    ['GET', /^\/a\/\d+$/, (req) => ({ body: blobs[req.path.split('/').at(-1)] })],
  ]);
}

const downloads = (api) => api.calls.filter((c) => c.path.endsWith('/zip')).map((c) => Number(c.path.split('/').at(-2)));

test('a shard of several items: each bundle is judged, recorded and sealed on its own; the dispatch closes once all are in', async () => {
  const keys = shardKeys(3);
  const { db, items } = setup({ runKeys: keys });
  const api = shardWorker(shardArtifacts(items));
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.equal(s.checked, 1);
    assert.equal(s.judged, 3);
    assert.equal(s.recorded, 3);
    assert.equal(s.errors, 0);
    assert.deepEqual(s.outcomes, { accepted: 3 });
    for (const k of keys) assert.equal(db.getResult(k).attempt_id, 'att-1');
    assert.deepEqual(db.getAttempt('att-1').items.map((it) => it.outcome), ['accepted', 'accepted', 'accepted']);
    const d = db.getDispatch('att-1');
    assert.equal(d.status, 'done');
    assert.equal(d.close_reason, 'results_in');
    assert.deepEqual(db.openSlots(), []);
    assert.deepEqual(readdirSync(h.outDir).sort(), ['ingest-att-1-0.tar.age', 'ingest-att-1-1.tar.age', 'ingest-att-1-2.tar.age']);
    for (const i of [0, 1, 2]) {
      const files = h.opened('att-1', i);
      assert.ok([...files.keys()].every((p) => p.startsWith(`accepted/att-1/${i}/`)), [...files.keys()].join(','));
      const report = JSON.parse(files.get(`accepted/att-1/${i}/ingest.json`));
      assert.equal(report.item_index, i);
      assert.equal(report.ledger.run_key, keys[i]);
    }
    assert.equal(api.calls.filter((c) => c.path.endsWith('/artifacts')).length, 1, 'the artifacts are listed once');
    assert.deepEqual(downloads(api), [900, 901, 902]);
    assert.ok(h.lines.some((l) => /^ingest: qa shard s1 \(att-1\) item 2: accepted, recorded, outputs sealed$/.test(l)), h.lines.join('\n'));
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a shard with one bundle missing: that item is rejected as no_artifact and frees its lease; the others are accepted', async () => {
  const keys = shardKeys(3);
  const { db, items } = setup({ runKeys: keys });
  const api = shardWorker(shardArtifacts(items, [0, 2]));
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.deepEqual(s.outcomes, { accepted: 2, rejected: 1 });
    assert.equal(s.recorded, 3);
    assert.equal(db.getResult(keys[0]).attempt_id, 'att-1');
    assert.equal(db.getResult(keys[1]), undefined);
    assert.equal(db.getResult(keys[2]).attempt_id, 'att-1');
    assert.equal(db.listAttempts('repo:2')[0].reason, 'no_artifact');
    assert.equal(db.rejectedCount(keys[1]), 1, 'it counts towards parking that run_key only');
    for (const k of keys) assert.equal(db.getLease(k).holder, null);
    assert.equal(db.getDispatch('att-1').status, 'done');
    assert.deepEqual(db.openSlots(), [], 'the slot is free');
    const report = JSON.parse(h.opened('att-1', 1).get('rejected/att-1/1/ingest.json'));
    assert.deepEqual(report.problems, [{ reason: 'no_artifact', expected: 'result-att-1-1.tar.age' }]);
    assert.ok(h.lines.some((l) => l.includes('item 1: rejected (no_artifact), recorded')), h.lines.join('\n'));
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a bundle uploaded under another item\'s index is rejected for that item; the real item is still accepted', async () => {
  const keys = shardKeys(3);
  const { db, items } = setup({ runKeys: keys });
  const shard = shardArtifacts(items);
  shard.blobs[901] = itemBlob(items, 2); // item 2's bundle (run_key and fence) uploaded as item 1
  const h = harness({ api: shardWorker(shard) });
  try {
    const s = await h.collect(db);
    assert.deepEqual(s.outcomes, { accepted: 2, rejected: 1 });
    assert.equal(db.listAttempts('repo:2')[0].reason, 'fence_mismatch');
    assert.equal(db.getResult(keys[1]), undefined);
    assert.equal(db.getResult(keys[2]).attempt_id, 'att-1');
    const reasons = JSON.parse(h.opened('att-1', 1).get('rejected/att-1/1/ingest.json')).problems.map((p) => p.reason);
    assert.ok(reasons.includes('run_key_mismatch') && reasons.includes('fence_mismatch'), reasons.join(','));
  } finally {
    h.cleanup();
    db.close();
  }
});

test('two artifacts for one index reject that item as duplicate_artifact without downloading either', async () => {
  const keys = shardKeys(3);
  const { db, items } = setup({ runKeys: keys });
  const shard = shardArtifacts(items);
  shard.artifacts.push(artifactEntry({ id: 911, name: 'result-att-1-1' }));
  shard.blobs[911] = itemBlob(items, 1);
  const api = shardWorker(shard);
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.deepEqual(s.outcomes, { accepted: 2, rejected: 1 });
    assert.equal(db.listAttempts('repo:2')[0].reason, 'duplicate_artifact');
    assert.deepEqual(downloads(api), [900, 902]);
    assert.equal(db.getDispatch('att-1').status, 'done');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a 25-item shard takes one run lookup and one artifact listing', async () => {
  const keys = shardKeys(25);
  const { db, items } = setup({ runKeys: keys });
  const api = shardWorker(shardArtifacts(items));
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.equal(s.judged, 25);
    assert.deepEqual(s.outcomes, { accepted: 25 });
    assert.equal(api.calls.filter((c) => c.path === `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}`).length, 1);
    assert.equal(api.calls.filter((c) => c.path.endsWith('/artifacts')).length, 1);
    assert.equal(downloads(api).length, 25);
    assert.equal(db.getDispatch('att-1').status, 'done');
    assert.equal(readdirSync(h.outDir).length, 25);
  } finally {
    h.cleanup();
    db.close();
  }
});

test('a deadline part-way through a shard stops between items; the next tick judges the rest, none twice', async () => {
  const keys = shardKeys(25);
  const { db, items } = setup({ runKeys: keys, ttlMs: 120 * MIN });
  const api = shardWorker(shardArtifacts(items));
  let clock = null;
  // Every decryption takes a minute of the clock.
  const decrypt = (c) => {
    clock.t += MIN;
    return fakeDecrypt(c);
  };
  const h = harness({ api, crypto: { decrypt, encrypt: (plaintext) => fakeEncrypt(plaintext), publicKey: () => PUBKEY } });
  clock = h.clock;
  try {
    const first = await h.collect(db, { deadline: h.clock.t + 10 * MIN });
    assert.equal(first.stopped, 'deadline');
    assert.equal(first.judged, 10);
    assert.equal(first.changed, true);
    assert.equal(db.getDispatch('att-1').status, 'dispatched', 'still open while items wait');
    assert.deepEqual(db.getAttempt('att-1').items.map((it) => it.outcome !== null), keys.map((_, i) => i < 10));
    assert.equal(db.getLease(keys[10]).holder, 'att-1', 'undecided items keep their leases');

    const second = await h.collect(db);
    assert.equal(second.stopped, null);
    assert.equal(second.judged, 15);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 25, 'every item recorded exactly once');
    assert.deepEqual(downloads(api), items.map((_, i) => 900 + i), 'no bundle downloaded twice');
    assert.equal(api.calls.filter((c) => c.path.endsWith('/artifacts')).length, 2, 'one listing per tick');
    for (const k of keys) assert.equal(db.getResult(k).attempt_id, 'att-1');
    assert.equal(db.getDispatch('att-1').status, 'done');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('when one item\'s outputs cannot be sealed, only that item waits for the next tick', async () => {
  const keys = shardKeys(3);
  const { db, items } = setup({ runKeys: keys });
  const api = shardWorker(shardArtifacts(items));
  let calls = 0;
  const encrypt = (plaintext) => {
    calls += 1;
    if (calls === 2) throw new Error('disk full');
    return fakeEncrypt(plaintext);
  };
  const h = harness({ api, crypto: { decrypt: fakeDecrypt, encrypt, publicKey: () => PUBKEY } });
  try {
    const s = await h.collect(db);
    assert.equal(s.errors, 1);
    assert.equal(s.recorded, 2);
    assert.deepEqual(db.getAttempt('att-1').items.map((it) => it.outcome), ['accepted', null, 'accepted']);
    assert.equal(db.getResult(keys[1]), undefined, 'its recorded result was rolled back');
    assert.equal(db.getLease(keys[1]).holder, 'att-1');
    assert.equal(db.getDispatch('att-1').status, 'dispatched');
    assert.equal(existsSync(h.sealed('att-1', 1)), false);
    assert.ok(h.lines.some((l) => /^ingest: qa shard s1 \(att-1\) item 1: disk full \(failure 1 of 3; nothing recorded; will try again\)$/.test(l)), h.lines.join('\n'));

    const again = await h.collect(db);
    assert.equal(again.judged, 1);
    assert.deepEqual(again.outcomes, { accepted: 1 });
    assert.equal(db.getResult(keys[1]).attempt_id, 'att-1');
    assert.equal(db.getDispatch('att-1').status, 'done');
    assert.ok(existsSync(h.sealed('att-1', 1)));
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
    assert.equal(db.getAttempt('att-1').items[0].outcome, 'rejected');
    assert.equal(db.listAttempts('repo:1')[0].reason, 'lease_expired');
    const report = JSON.parse(h.opened().get('rejected/att-1/0/ingest.json'));
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
    [{ placeholderPub: true }, /placeholder\.pub has no age public key yet \(it is still the placeholder\).*dispatches no work/],
    [{ identity: '' }, /AGE_IDENTITY is not set/],
    [{ crypto: { decrypt: fakeDecrypt, encrypt: fakeEncrypt, publicKey: () => OTHER_PUBKEY } }, /AGE_IDENTITY does not belong to any key in .*ingest\.pub/],
    [{ crypto: { decrypt: fakeDecrypt, encrypt: fakeEncrypt, publicKey: () => { throw new Error('age-keygen -y failed'); } } }, /AGE_IDENTITY is not a usable age identity \(age-keygen -y failed\)/],
  ];
  for (const [over, message] of cases) {
    const { db } = setup();
    const api = worker();
    const { placeholderPub, ...rest } = over;
    const h = harness({ api, ...rest });
    let c = h.collector;
    if (placeholderPub) {
      // Comments only, the way the committed ingest.pub looked before it got a key.
      const file = join(h.dir, 'placeholder.pub');
      writeFileSync(file, '# age recipient (public key) for tool-qa result bundles.\n#\n# PLACEHOLDER: no key has been set yet.\n');
      c = createCollector({ env: {}, identity: 'test-identity', fetch: api.fetch, apiUrl: API, outDir: h.outDir, sealTo: file, crypto: { publicKey: () => PUBKEY } });
    }
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

test('check() needs only the keys: any shard size can be judged', async () => {
  const h = harness({ api: worker() });
  try {
    assert.deepEqual(await h.collector.check({ workflows: { qa: { enabled: true, shard_size: 25 } } }), { recipients: [PUBKEY] });
    assert.deepEqual(await h.collector.check(), { recipients: [PUBKEY] });
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
    assert.ok(paths.includes('accepted/att-1/0/ingest.json'));
    assert.ok(paths.includes('accepted/att-1/0/manifest.json'));
    for (const l of h.lines) assert.ok(!l.includes('AGE-SECRET-KEY'), l);
  } finally {
    h.cleanup();
    db.close();
  }
});

// ---- R-ING-05, R-ING-06: no item is retried forever or holds up the others ----

test('R-ING-05: an item that keeps failing is counted in the state and recorded as ingest_error on the third failure', async () => {
  const { db, fence } = setup({ ttlMs: 120 * MIN });
  const api = worker({ bundle: makeBundle({ identity: { fence } }) });
  const decrypt = () => {
    throw new AgeError('could not run age (age): ENOENT', 'spawn');
  };
  const h = harness({ api, crypto: { decrypt, encrypt: (p) => fakeEncrypt(p), publicKey: () => PUBKEY } });
  try {
    for (const n of [1, 2]) {
      const s = await h.collect(db);
      assert.equal(s.errors, 1);
      assert.equal(s.recorded, 0);
      assert.equal(s.changed, true, 'the count must reach the pushed state');
      assert.equal(db.ingestFailures('att-1', 0).count, n);
      assert.equal(db.getAttempt('att-1').items[0].outcome, null);
      assert.ok(h.lines.some((l) => l.includes(`ENOENT (failure ${n} of 3; nothing recorded; will try again)`)), h.lines.join('\n'));
      h.clock.t += 3 * MIN;
    }
    const third = await h.collect(db);
    assert.equal(third.recorded, 1);
    assert.deepEqual(third.outcomes, { rejected: 1 });
    assert.equal(db.getAttempt('att-1').items[0].outcome, 'rejected');
    assert.equal(db.listAttempts('repo:1')[0].reason, 'ingest_error');
    assert.equal(db.getDispatch('att-1').status, 'done', 'the dispatch is closed and its slot freed');
    assert.deepEqual(db.openSlots(), []);
    assert.equal(db.ingestFailures('att-1', 0).count, 0);
    const report = JSON.parse(h.opened().get('rejected/att-1/0/ingest.json'));
    assert.equal(report.reason, 'ingest_error');
    assert.match(report.problems[0].detail, /failed to judge this item 3 times; last error: could not run age/);
    assert.ok(h.lines.some((l) => l.includes('(failure 3 of 3; recorded as ingest_error)')), h.lines.join('\n'));

    const calls = api.calls.length;
    assert.equal((await h.collect(db)).checked, 0, 'nothing is left to retry');
    assert.equal(api.calls.length, calls);
  } finally {
    h.cleanup();
    db.close();
  }
});

test('R-ING-05: a count left by an earlier run is honoured: the item is recorded as ingest_error without a download', async () => {
  const { db } = setup();
  for (let i = 0; i < 3; i++) db.noteIngestFailure('att-1', 0, { error: 'seal failed', now: T0 });
  const api = worker({ bundle: makeBundle() });
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.deepEqual(s.outcomes, { rejected: 1 });
    assert.equal(db.listAttempts('repo:1')[0].reason, 'ingest_error');
    assert.equal(api.calls.filter((c) => c.path.endsWith('/zip')).length, 0);
  } finally {
    h.cleanup();
    db.close();
  }
});

test('R-ING-08: transient download errors are retried and never counted', async () => {
  const { db } = setup({ ttlMs: 120 * MIN });
  const api = fakeApi([
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}`, () => ({ body: defaultRun() })],
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}/artifacts`, () => ({ body: { total_count: 1, artifacts: [artifactEntry()] } })],
    ['GET', `/repos/${WORKER_REPO}/actions/artifacts/901/zip`, () => ({ status: 502, body: { message: 'bad gateway' } })],
  ]);
  const h = harness({ api });
  try {
    for (let i = 0; i < 5; i++) {
      const s = await h.collect(db);
      assert.equal(s.errors, 1);
      assert.equal(s.recorded, 0);
      h.clock.t += 3 * MIN;
    }
    assert.equal(db.ingestFailures('att-1', 0).count, 0);
    assert.equal(db.getAttempt('att-1').items[0].outcome, null);
    assert.ok(h.lines.some((l) => /HTTP 502 \(transient; nothing recorded; will try again\)/.test(l)), h.lines.join('\n'));
  } finally {
    h.cleanup();
    db.close();
  }
});

test('R-ING-06: a poison item is decided in its own tick and the items after it are still judged', async () => {
  const { runAnalysis } = await import('../analyze.mjs');
  const keys = shardKeys(3);
  const { db, items } = setup({ runKeys: keys });
  const api = shardWorker(shardArtifacts(items));
  const hang = new URL('data:text/javascript,for (;;) {}');
  // Item 0's bundle makes the judge spin forever.
  const analyze = (plaintext, ctx, opts) => runAnalysis(plaintext, ctx, ctx.exp.run_key === keys[0] ? { ...opts, workerUrl: hang } : opts);
  const h = harness({ api, judge: { analyze, judgeTimeoutMs: 300 } });
  try {
    const t0 = performance.now();
    const s = await h.collect(db);
    assert.ok(performance.now() - t0 < 10_000);
    assert.deepEqual(s.outcomes, { rejected: 1, accepted: 2 });
    assert.deepEqual(db.getAttempt('att-1').items.map((it) => it.outcome), ['rejected', 'accepted', 'accepted']);
    assert.equal(db.listAttempts('repo:1')[0].reason, 'ingest_timeout');
    assert.equal(db.getDispatch('att-1').status, 'done');

    const next = await h.collect(db);
    assert.equal(next.checked, 0, 'the next tick has nothing left from it');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('R-ING-12: a run found by its name is checked against the commit recorded at dispatch, not its own', async () => {
  const forged = '2'.repeat(40);
  const { db, fence } = setup({ runId: null, expectedSha: WORKFLOW_SHA });
  // Someone with write access to the worker repo dispatched the same workflow,
  // with the same run name, from another commit.
  const runs = [{ id: RUN_ID, name: 'qa', display_title: 'shard s1', head_sha: forged, html_url: 'https://github.test/runs/4242' }];
  const bundle = makeBundle({ identity: { fence }, workflow: { sha: forged } });
  const api = worker({ bundle, runs, run: defaultRun({ head_sha: forged }) });
  const h = harness({ api });
  try {
    const s = await h.collect(db);
    assert.equal(s.correlated, 1);
    assert.deepEqual(s.outcomes, { rejected: 1 });
    const d = db.getDispatch('att-1');
    assert.equal(d.run_id, String(RUN_ID));
    assert.equal(d.workflow_sha, WORKFLOW_SHA, 'the expected commit is kept');
    assert.equal(db.listAttempts('repo:1')[0].reason, 'run_sha_mismatch');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('R-ING-12: setDispatchRun never sets the expected commit, and markDispatched never replaces it', () => {
  const db = openState(':memory:');
  db.acquireSlot('a', { budget: 5, ttlMs: 30 * MIN, now: T0 });
  const l = db.acquireLease(RUN_KEY, 'a', { ttlMs: 30 * MIN, now: T0 });
  db.createDispatch({
    attemptId: 'a', shardId: 's', workflow: 'qa', repo: WORKER_REPO, workflowFile: 'qa-worker.yml', ref: 'main',
    expires: T0 + 30 * MIN, items: [{ run_key: RUN_KEY, subject: 'repo:1', fence: l.fence }], workflowSha: WORKFLOW_SHA, now: T0,
  });
  db.markDispatched('a', { runId: null, workflowSha: '3'.repeat(40) });
  assert.equal(db.getDispatch('a').workflow_sha, WORKFLOW_SHA);
  db.setDispatchRun('a', { runId: 5, workflowSha: '4'.repeat(40) });
  assert.equal(db.getDispatch('a').workflow_sha, WORKFLOW_SHA);
  db.close();
});

test('R-ING-08: a bundle that makes the judge throw is a recorded rejection, never downloaded again', async () => {
  const { db, fence } = setup();
  const api = worker({ bundle: makeBundle({ identity: { fence } }) });
  // A registry the judge cannot read stands in for any bug the bundle hits.
  const h = harness({ api, registry: { ...parseRegistry(REGISTRY_TEXT), fields: null, source: 'test' } });
  try {
    const s = await h.collect(db);
    assert.equal(s.errors, 0, 'not an error to retry');
    assert.deepEqual(s.outcomes, { rejected: 1 });
    assert.equal(db.listAttempts('repo:1')[0].reason, 'ingest_error');
    assert.equal(db.getDispatch('att-1').status, 'done');
    const downloads = api.calls.filter((c) => c.path.endsWith('/zip')).length;
    assert.equal((await h.collect(db)).checked, 0);
    assert.equal(api.calls.filter((c) => c.path.endsWith('/zip')).length, downloads, 'no second download');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('R-ING-17: a GitHub call that hangs is cut off at collect()\'s deadline plus its grace', async () => {
  const { db } = setup();
  // Like a stalled connection: nothing settles until the signal aborts. The
  // timer stands in for the open socket that keeps a real process alive.
  const hanging = async (input, init = {}) => new Promise((_, reject) => {
    const socket = setTimeout(() => {}, 30_000);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(socket);
      reject(init.signal.reason);
    });
  });
  const h = harness({ api: { fetch: hanging, calls: [] }, callGraceMs: 0 });
  try {
    const t0 = performance.now();
    const s = await h.collect(db, { deadline: h.clock.t + 200 });
    assert.ok(performance.now() - t0 < 5000, 'not the 60 s per-request limit, four times over');
    assert.equal(s.errors, 1);
    assert.equal(s.recorded, 0);
    assert.equal(db.ingestFailures('att-1', 0).count, 0, 'a cut-off call is transient, not counted');
  } finally {
    h.cleanup();
    db.close();
  }
});

test('R-ING-21: a deadline further off than a timer can wait is no deadline, not one that fires at once', async () => {
  const { db, fence } = setup();
  const api = worker({ bundle: makeBundle({ identity: { fence } }) });
  const h = harness({ api });
  try {
    const s = await h.collect(db, { deadline: h.clock.t + 2 ** 32 });
    assert.deepEqual(s.outcomes, { accepted: 1 }, 'the GitHub calls were not cut off');
    assert.equal(s.errors, 0);
  } finally {
    h.cleanup();
    db.close();
  }
});

test('R-ING-22: three dispatches in a row at the wrong commit pause the workflow; a run that passes resets the count', async () => {
  const db = openState(':memory:');
  const run = async (attemptId, headSha, at, recorded = WORKFLOW_SHA) => {
    db.acquireSlot(attemptId, { budget: 5, ttlMs: 30 * MIN, now: at });
    const l = db.acquireLease(RUN_KEY, attemptId, { ttlMs: 30 * MIN, now: at });
    db.createDispatch({
      attemptId, shardId: 's1', workflow: 'qa', repo: WORKER_REPO, workflowFile: 'qa-worker.yml', ref: 'main',
      expires: at + 30 * MIN, items: [{ run_key: RUN_KEY, subject: 'repo:1', fence: l.fence }], workflowSha: recorded, now: at,
    });
    db.markDispatched(attemptId, { runId: RUN_ID });
    const art = artifactEntry({ name: `result-${attemptId}-0.tar.age` });
    const api = worker({ bundle: makeBundle({ identity: { attempt_id: attemptId, fence: l.fence } }), run: defaultRun({ head_sha: headSha }), artifacts: [art] });
    const h = harness({ api });
    h.clock.t = at + MIN;
    try {
      return await h.collect(db);
    } finally {
      h.cleanup();
    }
  };
  // Each dispatch recorded at another commit (a branch that keeps moving), each run at yet another.
  const wrong = '2'.repeat(40);
  await run('a1', wrong, T0, '3'.repeat(40));
  await run('a2', wrong, T0 + 60 * MIN, '4'.repeat(40));
  await run('a3', WORKFLOW_SHA, T0 + 120 * MIN); // passed: the count starts again
  assert.equal(db.getKv('pump.sha_mismatch:qa'), undefined);
  await run('a4', wrong, T0 + 180 * MIN, '5'.repeat(40));
  await run('a5', wrong, T0 + 240 * MIN, '6'.repeat(40));
  assert.deepEqual(db.pausedWorkflows({ now: T0 + 241 * MIN }), []);
  await run('a6', wrong, T0 + 300 * MIN, '7'.repeat(40));
  const [p] = db.pausedWorkflows({ now: T0 + 302 * MIN });
  assert.equal(p.workflow, 'qa');
  assert.equal(p.reason, 'run_sha_mismatch');
  assert.equal(p.count, 3);
  assert.equal(p.until, new Date(T0 + 301 * MIN + 6 * 60 * MIN).toISOString());
  assert.deepEqual(db.pausedWorkflows({ now: T0 + 301 * MIN + 6 * 60 * MIN }), [], 'the pause ends on its own');
  db.close();
});

test('R-ING-24: the shards a merge overtook (all recorded at the old commit) count once and do not pause the workflow', async () => {
  const db = openState(':memory:');
  const run = async (attemptId, headSha, at, recorded) => {
    db.acquireSlot(attemptId, { budget: 5, ttlMs: 30 * MIN, now: at });
    const l = db.acquireLease(RUN_KEY, attemptId, { ttlMs: 30 * MIN, now: at });
    db.createDispatch({
      attemptId, shardId: 's1', workflow: 'qa', repo: WORKER_REPO, workflowFile: 'qa-worker.yml', ref: 'main',
      expires: at + 30 * MIN, items: [{ run_key: RUN_KEY, subject: 'repo:1', fence: l.fence }], workflowSha: recorded, now: at,
    });
    db.markDispatched(attemptId, { runId: RUN_ID });
    const art = artifactEntry({ name: `result-${attemptId}-0.tar.age` });
    const api = worker({ bundle: makeBundle({ identity: { attempt_id: attemptId, fence: l.fence } }), run: defaultRun({ head_sha: headSha }), artifacts: [art] });
    const h = harness({ api });
    h.clock.t = at + MIN;
    try {
      return await h.collect(db);
    } finally {
      h.cleanup();
    }
  };
  const OLD = '3'.repeat(40);
  const NEW = '2'.repeat(40);
  // One tick reserves its shards in one loop: created seconds apart.
  for (const [i, a] of ['m1', 'm2', 'm3'].entries()) {
    const s = await run(a, NEW, T0 + i * 2_000, OLD);
    assert.deepEqual(s.outcomes, { rejected: 1 });
  }
  assert.deepEqual(db.pausedWorkflows({ now: T0 + 10 * MIN }), [], 'a normal merge pauses nothing');
  assert.deepEqual([db.getKv('pump.sha_mismatch:qa').count, db.getKv('pump.sha_mismatch:qa').last_sha], [1, OLD]);
  db.close();
});

test('R-ING-25: the same recorded commit in separate ticks keeps counting, and pauses at three', () => {
  const db = openState(':memory:');
  const SHA = '3'.repeat(40);
  // A cause that persists at a fixed commit: every run lands elsewhere, one dispatch per tick.
  for (const [i, at] of [T0, T0 + 10 * MIN, T0 + 20 * MIN].entries()) {
    const r = db.noteShaMismatch('qa', { sha: SHA, created: at, now: at + 5 * MIN });
    assert.equal(r.count, i + 1);
  }
  const [p] = db.pausedWorkflows({ now: T0 + 26 * MIN });
  assert.equal(p?.workflow, 'qa', 'paused');
  // One burst (dispatches made within one tick) still counts once.
  db.deleteKv('pump.paused:qa');
  for (const at of [T0 + 100 * MIN, T0 + 100 * MIN + 2_000, T0 + 100 * MIN + 4_000]) db.noteShaMismatch('qa', { sha: SHA, created: at, now: at + 5 * MIN });
  assert.equal(db.getKv('pump.sha_mismatch:qa').count, 1);
  assert.deepEqual(db.pausedWorkflows({ now: T0 + 106 * MIN }), []);
  db.close();
});

test('R-ING-26: same-commit mismatches from separate ticks only ~130 s apart still count, and pause at three', async () => {
  const { SHA_BURST_MS } = await import('../../state/db.mjs');
  const db = openState(':memory:');
  const SHA = '3'.repeat(40);
  // Ticks start 150 s apart; a long ingest in one and a short one in the next puts their dispatches ~130 s apart.
  const created = [T0, T0 + 130_000, T0 + 260_000];
  created.forEach((at, i) => assert.equal(db.noteShaMismatch('qa', { sha: SHA, created: at, now: at + MIN }).count, i + 1));
  assert.equal(db.pausedWorkflows({ now: T0 + 6 * MIN })[0]?.workflow, 'qa');
  // A burst's start never moves: repeats 20 s apart do not chain past it.
  db.deleteKv('pump.paused:qa');
  const chain = [T0 + 60 * MIN, T0 + 60 * MIN + 20_000, T0 + 60 * MIN + 40_000, T0 + 60 * MIN + 60_000];
  const counts = chain.map((at) => db.noteShaMismatch('qa', { sha: SHA, created: at, now: at + MIN }).count);
  assert.deepEqual(counts, [1, 1, 2, 2], 'the third is 40 s after the burst began: a new one');
  assert.ok(SHA_BURST_MS < 150_000);
  db.close();
});

test('R-CHAOS-07: a late dispatch whose look the API budget stopped is looked at on the next tick, not ten minutes later; an earlier look keeps counting', async () => {
  for (const seenBefore of [false, true]) {
    const { db } = setup();
    db.reapExpiredDispatches({ now: T0 + 31 * MIN });
    const api = worker({ run: defaultRun({ status: 'in_progress', conclusion: null }) });
    const gate = { budget: false };
    const fetch = async (url, init) => {
      if (gate.budget) throw new BudgetExceededError('actions: API calls are blocked by a rate limit', { family: 'actions', reason: 'blocked' });
      return api.fetch(url, init);
    };
    const h = harness({ api, fetch });
    try {
      h.clock.t = T0 + 40 * MIN;
      if (seenBefore) {
        assert.equal((await h.collect(db)).waiting, 1, 'looked at once');
        h.clock.t += 11 * MIN; // due for its next look
      }
      gate.budget = true;
      assert.equal((await h.collect(db)).stopped, 'budget');
      gate.budget = false;
      h.clock.t += MIN;
      const s = await h.collect(db);
      assert.equal(s.checked, 1, `looked at a minute after the stopped look (seen before: ${seenBefore})`);
      assert.equal(s.waiting, 1);
      // A look that did happen still throttles the next one.
      h.clock.t += MIN;
      assert.equal((await h.collect(db)).checked, 0);
    } finally {
      h.cleanup();
      db.close();
    }
  }
});

test('R-CHAOS-10: ingest passes the artifact upload time: a run that completed inside its lease but whose bundle was uploaded after it is lease_expired', async () => {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Lease 30 minutes from T0. The run says it completed at T0 + 20 minutes.
  for (const [createdAt, want] of [[T0 + 25 * MIN, 'accepted'], [T0 + 33 * MIN, 'lease_expired']]) {
    const { db, fence } = setup();
    db.reapExpiredDispatches({ now: T0 + 31 * MIN });
    const api = worker({
      bundle: makeBundle({ identity: { fence } }),
      run: defaultRun({ updated_at: iso(T0 + 20 * MIN) }),
      artifacts: [artifactEntry({ created_at: iso(createdAt) })],
    });
    const h = harness({ api });
    h.clock.t = T0 + 40 * MIN;
    try {
      const s = await h.collect(db);
      assert.equal(s.recorded, 1);
      const att = db.raw.prepare('SELECT accepted, reason FROM attempts WHERE attempt_id = ?').get('att-1');
      if (want === 'accepted') assert.deepEqual({ ...att }, { accepted: 1, reason: null }, 'uploaded inside the lease: on time');
      else assert.deepEqual({ ...att }, { accepted: 0, reason: 'lease_expired' }, 'uploaded after the lease: late, whatever the run says');
    } finally {
      h.cleanup();
      db.close();
    }
  }
});
