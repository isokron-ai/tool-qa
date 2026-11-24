import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../../state/db.mjs';
import { dueFromState, loadConfig, maxAgeDays } from '../due.mjs';
import { runPump } from '../run.mjs';
import { ALLOW_RETIRE_KV_KEY, MAPPING_VERSION, parseSeed, SEED_FILE, SEED_KV_KEY, syncSeedSubjects, tierFor } from '../subjects.mjs';
import { runTick } from '../tick.mjs';
import { fakeClock } from '../../test/lib/fake-api.mjs';

const DAY = 86_400_000;
const T = Date.parse('2026-11-24T00:00:00Z');
const REAL_SEED = JSON.parse(readFileSync(SEED_FILE, 'utf8'));

/** The shipped config with scan-static switched on, as PR #8 ships it. */
function scanStaticConfig() {
  const cfg = loadConfig();
  const workflows = {};
  for (const [name, w] of Object.entries(cfg.workflows)) workflows[name] = { ...w, enabled: false };
  workflows['scan-static'] = { ...cfg.workflows['scan-static'], enabled: true, versions: { tool: { 'mcp-check': 'ec3c801' }, oracle: {}, probe: {} } };
  return { tiers: cfg.tiers, workflows };
}

function tmpSeed(subjects, { version = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  const file = join(dir, 'seed.json');
  writeFileSync(file, JSON.stringify({ version, size: subjects.length, subjects }));
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const row = (id, tier = 'sample', star_bucket = '0-9') => ({ id, tier, star_bucket, population: tier === 'sample' ? 'history' : 'calibration' });

function recorder() {
  const calls = [];
  return {
    calls,
    async dispatch(req) {
      calls.push(req);
      return { runId: 1000 + calls.length, runUrl: null, workflowSha: 'b'.repeat(40), correlatedBy: 'response' };
    },
    async resolveRef() {
      return 'f'.repeat(40);
    },
  };
}

test('tierFor maps the seed populations: ours T0, calibration T1, sample T2 (100+ stars) or T3', () => {
  assert.equal(tierFor(row('a/b', 'T0')), 0);
  assert.equal(tierFor(row('a/b', 'gold14')), 1);
  assert.equal(tierFor(row('a/b', 'reference')), 1);
  assert.equal(tierFor(row('a/b', 'sample', '1000+')), 2);
  assert.equal(tierFor(row('a/b', 'sample', '100-999')), 2);
  assert.equal(tierFor(row('a/b', 'sample', '10-99')), 3);
  assert.equal(tierFor(row('a/b', 'sample', '0-9')), 3);
  assert.throws(() => tierFor(row('a/b', 'T9')), /unknown population tier/);
});

test('the real seed parses: 997 owner/name subjects, 5 T0, 15 T1, 48 T2, 929 T3', () => {
  const seed = parseSeed(readFileSync(SEED_FILE));
  assert.equal(seed.source, 'seed-v1');
  assert.equal(seed.subjects.length, 997);
  const count = {};
  for (const s of seed.subjects) count[s.tier] = (count[s.tier] ?? 0) + 1;
  assert.deepEqual(count, { 0: 5, 1: 15, 2: 48, 3: 929 });
  const t0 = seed.subjects.filter((s) => s.tier === 0).map((s) => s.id).sort();
  assert.deepEqual(t0, ['isokron-ai/kronicle-lite', 'isokron-ai/mcp-catalog-snap', 'isokron-ai/mcp-check', 'isokron-ai/sea-lite', 'isokron-ai/strapi-plugin-writesafe']);
  // The seed's own counts agree.
  assert.equal(REAL_SEED.summary.tier.T0, 5);
  assert.equal(REAL_SEED.summary.tier.gold14 + REAL_SEED.summary.tier.reference, 15);
});

test('a bad seed is refused whole: nothing is written and the error is returned', () => {
  const db = openState(':memory:');
  for (const [subjects, re] of [
    [[row('a/b'), row('A/B')], /listed twice/],
    [[row('github:a/b')], /not owner\/name/],
    [[row('a/b', 'nope')], /unknown population tier/],
  ]) {
    const s = tmpSeed(subjects);
    const out = syncSeedSubjects(db, { now: T, file: s.file });
    s.cleanup();
    assert.equal(out.loaded, false);
    assert.match(out.error, re);
  }
  const missing = syncSeedSubjects(db, { now: T, file: '/nonexistent/seed.json' });
  assert.match(missing.error, /ENOENT/);
  assert.deepEqual(db.listSubjects(), []);
  assert.equal(db.getKv(SEED_KV_KEY), undefined);
  db.close();
});

test('R-SUB-01: the real seed loads into an empty state: 997 github subjects, sha left null, all due for scan-static', () => {
  const db = openState(':memory:');
  const out = syncSeedSubjects(db, { now: T });
  assert.equal(out.loaded, true);
  assert.equal(out.subjects, 997);
  assert.deepEqual(out.tiers, { T0: 5, T1: 15, T2: 48, T3: 929 });
  const subjects = db.listSubjects();
  assert.equal(subjects.length, 997);
  assert.ok(subjects.every((s) => s.kind === 'github' && s.source === 'seed-v1' && s.sha === null && s.artifact_digest === null && s.retired_at === null));
  const kv = db.getKv(SEED_KV_KEY);
  assert.equal(kv.sha256, parseSeed(readFileSync(SEED_FILE)).sha256);
  assert.equal(kv.mapping, MAPPING_VERSION);

  const cfg = scanStaticConfig();
  const due = dueFromState(db, { now: T + 1000, tiers: cfg.tiers, workflows: cfg.workflows });
  assert.equal(due.length, 997, 'every seed subject is due at once');
  assert.ok(due.every((d) => d.workflow === 'scan-static' && d.reasons.join() === 'first_sight'));
  // First-sweep order: T0, then T1, then T2, then T3.
  const tiers = due.map((d) => d.tier);
  assert.deepEqual(tiers.slice(0, 5), [0, 0, 0, 0, 0]);
  for (let i = 1; i < tiers.length; i++) assert.ok(tiers[i - 1] <= tiers[i], `due list is in tier order at ${i}`);
  db.close();
});

test('R-SUB-01: with scan-static on and LOOP_SLOTS=3 the first tick sends three full 25-item shards, T0 and T1 first', async () => {
  const c = fakeClock();
  const db = openState(':memory:');
  syncSeedSubjects(db, { now: c.t });
  const d = recorder();
  let n = 0;
  const s = await runTick({ db, now: c.now, config: scanStaticConfig(), workerSlots: 3, dispatcher: d, newId: () => `att-${++n}` });
  assert.equal(s.due, 997);
  assert.equal(s.planned, 3, 'slots_max 3 for scan-static');
  assert.equal(s.dispatched, 3);
  assert.equal(d.calls.length, 3);
  const shards = d.calls.map((call) => JSON.parse(call.inputs.items));
  assert.deepEqual(shards.map((items) => items.length), [25, 25, 25]);
  assert.ok(d.calls.every((call) => call.repo === 'isokron-ai/mcp-check' && call.workflowFile === 'scan-static.yml'));
  const first = shards[0].map((i) => i.subject);
  assert.deepEqual(first.slice(0, 5).sort(), ['isokron-ai/kronicle-lite', 'isokron-ai/mcp-catalog-snap', 'isokron-ai/mcp-check', 'isokron-ai/sea-lite', 'isokron-ai/strapi-plugin-writesafe']);
  assert.ok(first.slice(5, 20).includes('modelcontextprotocol/servers'));
  assert.ok(first.slice(5, 20).includes('github/github-mcp-server'));

  // The next tick finds every slot taken: nothing more is sent until results come in.
  c.t += 150_000;
  const s2 = await runTick({ db, now: c.now, config: scanStaticConfig(), workerSlots: 3, dispatcher: d, newId: () => `att-${++n}` });
  assert.equal(s2.due, 997 - 75);
  assert.equal(s2.dispatched, 0);
  db.close();
});

test('R-SUB-01: the pump loads the seed at start-up, before the first tick, and only once per seed file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pump-seed-'));
  const stateFile = join(dir, 'state.sqlite');
  const c = fakeClock();
  const lines = [];
  const sent = [];
  const pushed = [];
  const opts = {
    env: { GITHUB_REPOSITORY: 'isokron-ai/tool-qa', GITHUB_TOKEN: 'ghs_synthetic', LOOP_SLOTS: '3' },
    now: c.now,
    sleep: c.sleep,
    log: (l) => lines.push(l),
    stateFile,
    config: scanStaticConfig(),
    pull: async () => ({ status: 'pulled' }),
    push: async () => {
      pushed.push(c.t);
      return { status: 'pushed' };
    },
    dispatcher: {
      async dispatch(req) {
        sent.push(req);
        return { runId: 10 + sent.length, runUrl: null, correlatedBy: 'response' };
      },
    },
    newId: (() => { let i = 0; return () => `att-${++i}`; })(),
    ingest: null,
  };
  try {
    const out = await runPump(opts);
    assert.equal(out.ok, true);
    assert.ok(lines.some((l) => /^pump: subjects: loaded 997 subjects from seed-v1 \(T0 5, T1 15, T2 48, T3 929\); 0 retired$/.test(l)), lines.join('\n'));
    assert.equal(sent.length, 3, 'three shards in the first tick; later ticks find the slots taken');
    assert.ok(sent.every((r) => JSON.parse(r.inputs.items).length === 25));

    // A second run with the same seed file writes nothing to the subjects.
    let db = openState(stateFile);
    const before = db.listSubjects();
    db.close();
    c.t += DAY;
    lines.length = 0;
    await runPump(opts);
    assert.ok(lines.some((l) => l === 'pump: subjects: seed-v1 already loaded (997 subjects)'), lines.join('\n'));
    db = openState(stateFile);
    assert.deepEqual(db.listSubjects(), before);
    db.close();

    // A seed that cannot be read fails the run, and the subjects already there stay.
    lines.length = 0;
    const bad = await runPump({ ...opts, seedFile: join(dir, 'missing.json') });
    assert.equal(bad.ok, false);
    assert.ok(lines.some((l) => /^pump: subjects: seed not loaded, subjects left as they were: ENOENT/.test(l)), lines.join('\n'));
    db = openState(stateFile);
    assert.equal(db.listSubjects().length, 997);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loading again is a no-op; a sha set by another writer is kept, not reset to null', () => {
  const db = openState(':memory:');
  const s = tmpSeed([row('o/a', 'T0'), row('o/b')]);
  try {
    assert.equal(syncSeedSubjects(db, { now: T, file: s.file }).loaded, true);
    db.setSubjectVersion({ id: 'o/b', kind: 'github', source: 'meta', tier: 3, sha: 'c'.repeat(40), now: T + 1000 });
    const before = db.listSubjects();
    assert.equal(syncSeedSubjects(db, { now: T + DAY, file: s.file }).loaded, false);
    assert.deepEqual(db.listSubjects(), before);
    // A new mapping version (or a changed file) loads again, keeping the sha and changed_at.
    db.setKv(SEED_KV_KEY, { ...db.getKv(SEED_KV_KEY), mapping: MAPPING_VERSION - 1 }, { now: T });
    assert.equal(syncSeedSubjects(db, { now: T + 2 * DAY, file: s.file }).loaded, true);
    const b = db.getSubject('o/b');
    assert.equal(b.sha, 'c'.repeat(40));
    assert.equal(b.changed_at, before.find((x) => x.id === 'o/b').changed_at);
    assert.equal(b.source, 'seed-v1', 'source is where it was first seen');
  } finally {
    s.cleanup();
    db.close();
  }
});

test('a subject that leaves the seed is retired, not deleted: no longer due, back when it returns', () => {
  const db = openState(':memory:');
  const cfg = scanStaticConfig();
  const a = tmpSeed([row('o/a'), row('o/b')]);
  const b = tmpSeed([row('o/a')], { version: 2 });
  try {
    syncSeedSubjects(db, { now: T, file: a.file });
    db.setSubjectVersion({ id: 'other/x', kind: 'github', source: 'discovery', tier: 3, now: T });
    // Half the seed leaving is over the 10% guard (R-SUB-03): allowed once by the override.
    db.setKv(ALLOW_RETIRE_KV_KEY, true, { now: T });
    const out = syncSeedSubjects(db, { now: T + DAY, file: b.file });
    assert.equal(db.getKv(ALLOW_RETIRE_KV_KEY), undefined, 'the override is used once');
    assert.equal(out.retired, 1);
    assert.equal(db.getSubject('o/b').retired_at, new Date(T + DAY).toISOString());
    assert.equal(db.getSubject('other/x').retired_at, null, 'subjects from other sources are not touched');
    const due = dueFromState(db, { now: T + DAY, tiers: cfg.tiers, workflows: cfg.workflows }).map((d) => d.subject).sort();
    assert.deepEqual(due, ['o/a', 'other/x']);
    // Back in a later seed: active again.
    syncSeedSubjects(db, { now: T + 2 * DAY, file: a.file });
    assert.equal(db.getSubject('o/b').retired_at, null);
    assert.equal(db.listSubjects().length, 3);
  } finally {
    a.cleanup();
    b.cleanup();
    db.close();
  }
});

test('R-SUB-02: a subject with no sha is refreshed on its tier cadence, even where the cell has no age limit', () => {
  const cfg = scanStaticConfig();
  const cell0 = cfg.tiers.tiers.T0['scan-static'];
  assert.equal(cell0.max_age_days, null, 'T0 scan-static has no age limit of its own (every push)');
  assert.equal(maxAgeDays(cell0, { sha: null, artifact_digest: null }, cfg.tiers, 'T0'), 1);
  assert.equal(maxAgeDays(cell0, { sha: 'a'.repeat(40), artifact_digest: null }, cfg.tiers, 'T0'), null, 'a known sha moves the run_key instead');
  assert.equal(maxAgeDays(cfg.tiers.tiers.T3['scan-static'], { sha: null }, cfg.tiers, 'T3'), 30);

  const db = openState(':memory:');
  const s = tmpSeed([row('isokron-ai/mcp-check', 'T0'), row('o/long-tail')]);
  try {
    syncSeedSubjects(db, { now: T, file: s.file });
    const first = dueFromState(db, { now: T, tiers: cfg.tiers, workflows: cfg.workflows });
    for (const d of first) {
      db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now: T });
      const lease = db.acquireLease(d.run_key, `att-${d.subject}`, { ttlMs: DAY, now: T });
      db.createDispatch({ attemptId: `att-${d.subject}`, shardId: 's', workflow: d.workflow, repo: 'isokron-ai/mcp-check', workflowFile: 'scan-static.yml', ref: 'main', expires: T + DAY, items: [{ run_key: d.run_key, subject: d.subject, fence: lease.fence }], now: T });
      db.recordResult({ run_key: d.run_key, attempt_id: `att-${d.subject}`, fence: lease.fence, verdict: 'accepted', outcome: 'correct', now: T + 1000 });
    }
    const at = (days) => dueFromState(db, { now: T + days * DAY, tiers: cfg.tiers, workflows: cfg.workflows }).map((d) => `${d.subject} ${d.reasons.join(',')}`);
    assert.deepEqual(at(0.5), []);
    assert.deepEqual(at(1.1), ['isokron-ai/mcp-check stale']);
    assert.deepEqual(at(29.9), ['isokron-ai/mcp-check stale']);
    assert.deepEqual(at(30.1), ['isokron-ai/mcp-check stale', 'o/long-tail stale']);
  } finally {
    s.cleanup();
    db.close();
  }
});

test('R-SUB-03: a seed with no size, or one that would retire over 10% of the active seed subjects, is refused', () => {
  const db = openState(':memory:');
  const noSize = tmpSeed([row('o/a')]);
  writeFileSync(noSize.file, JSON.stringify({ version: 1, subjects: [row('o/a')] }));
  try {
    assert.match(syncSeedSubjects(db, { now: T, file: noSize.file }).error, /size \(the number of subjects\) is required/);

    assert.equal(syncSeedSubjects(db, { now: T }).subjects, 997);
    const before = db.listSubjects();
    const kvBefore = db.getKv(SEED_KV_KEY);
    // The review's case: one valid subject would have retired 996.
    const tiny = tmpSeed([row('isokron-ai/mcp-check', 'T0')], { version: 2 });
    const out = syncSeedSubjects(db, { now: T + DAY, file: tiny.file });
    tiny.cleanup();
    assert.equal(out.loaded, false);
    assert.match(out.error, /would retire 996 of 997 active seed subjects \(over 10%\); set kv subjects\.seed\.allow_retire to true/);
    assert.deepEqual(db.listSubjects(), before, 'nothing written');
    assert.deepEqual(db.getKv(SEED_KV_KEY), kvBefore);

    // Up to 10% leaving is fine without the override.
    const ids = REAL_SEED.subjects.map((x) => x.id);
    const smaller = tmpSeed(REAL_SEED.subjects.slice(0, ids.length - 99));
    const ok = syncSeedSubjects(db, { now: T + 2 * DAY, file: smaller.file });
    smaller.cleanup();
    assert.equal(ok.loaded, true);
    assert.equal(ok.retired, 99);
  } finally {
    noSize.cleanup();
    db.close();
  }
});

test('R-SUB-05: a state error inside the load is returned as error, not thrown, and nothing is written', () => {
  const db = openState(':memory:');
  const s = tmpSeed([row('o/a'), row('o/b')]);
  const orig = db.setSubjectVersion.bind(db);
  let calls = 0;
  db.setSubjectVersion = (args) => {
    calls += 1;
    if (calls === 2) throw new Error('disk I/O error');
    return orig(args);
  };
  try {
    const out = syncSeedSubjects(db, { now: T, file: s.file });
    assert.equal(out.loaded, false);
    assert.match(out.error, /disk I\/O error/);
    assert.deepEqual(db.listSubjects(), [], 'the transaction rolled back');
    assert.equal(db.getKv(SEED_KV_KEY), undefined);
  } finally {
    s.cleanup();
    db.close();
  }
});

test('R-SUB-07: kv subjects.seed records the path actually loaded', () => {
  const db = openState(':memory:');
  const s = tmpSeed([row('o/a')]);
  try {
    syncSeedSubjects(db, { now: T, file: s.file });
    assert.equal(db.getKv(SEED_KV_KEY).file, s.file);
    const db2 = openState(':memory:');
    syncSeedSubjects(db2, { now: T });
    assert.equal(db2.getKv(SEED_KV_KEY).file, 'history/seed-v1.json');
    db2.close();
  } finally {
    s.cleanup();
    db.close();
  }
});

/** Dispatch one scan-static item for each due pair and return them. */
function dispatchAll(db, cfg, at) {
  const due = dueFromState(db, { now: at, tiers: cfg.tiers, workflows: cfg.workflows });
  return due.map((d, i) => {
    const attemptId = `att-${at}-${i}`;
    db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now: at });
    const lease = db.acquireLease(d.run_key, attemptId, { ttlMs: DAY, now: at });
    db.createDispatch({ attemptId, shardId: 's', workflow: d.workflow, repo: 'isokron-ai/mcp-check', workflowFile: 'scan-static.yml', ref: 'main', expires: at + DAY, items: [{ run_key: d.run_key, subject: d.subject, fence: lease.fence }], now: at });
    return { ...d, attemptId, fence: lease.fence };
  });
}

test('R-SUB-04: retry_throttled is not counted towards parking or MAX_RETRIES, and its backoff is capped', () => {
  const cfg = scanStaticConfig();
  assert.equal(cfg.tiers.retry_backoff_max_minutes, 360);
  const db = openState(':memory:');
  const s = tmpSeed([row('o/a')]);
  try {
    syncSeedSubjects(db, { now: T, file: s.file });
    let at = T;
    let key = null;
    for (let n = 1; n <= 12; n++) {
      const [d] = dispatchAll(db, cfg, at);
      assert.ok(d, `due again for throttled retry ${n}`);
      key = d.run_key;
      const r = db.recordResult({ run_key: d.run_key, attempt_id: d.attemptId, fence: d.fence, outcome: 'rejected', accepted: false, reason: 'retry_throttled', now: at + 60_000 });
      assert.equal(r.reason, 'retry_throttled');
      // Waits at most 6 hours, however many retries came before.
      const wait = Math.min(360, 30 * 2 ** (n - 1)) * 60_000;
      assert.deepEqual(dueFromState(db, { now: at + 60_000 + wait - 1000, tiers: cfg.tiers, workflows: cfg.workflows }), []);
      at += 60_000 + wait + 1000;
    }
    assert.equal(db.retryLaterCount(key), 0, 'not counted towards MAX_RETRIES');
    assert.equal(db.retryThrottled(key).throttled, 12);
    assert.equal(db.retryThrottled(key).throttled_since, new Date(T + 60_000).toISOString());
    assert.deepEqual(db.rejectedRunKeys(1), [], 'not counted towards parking');
  } finally {
    s.cleanup();
    db.close();
  }
});

test('R-SUB-06: an accepted result with only skips and no records is due again after a day, not the tier max age', () => {
  const cfg = scanStaticConfig();
  assert.equal(cfg.tiers.skips_only_max_age_days, 1);
  const db = openState(':memory:');
  const s = tmpSeed([row('o/skipped'), row('o/measured')]);
  try {
    syncSeedSubjects(db, { now: T, file: s.file });
    for (const d of dispatchAll(db, cfg, T)) {
      db.recordResult({ run_key: d.run_key, attempt_id: d.attemptId, fence: d.fence, outcome: 'accepted', accepted: true, resultOutcome: d.subject === 'o/skipped' ? 'skips_only' : null, now: T + 1000 });
    }
    assert.equal(db.listResults().find((r) => r.subject === 'o/skipped').outcome, 'skips_only');
    const at = (days) => dueFromState(db, { now: T + days * DAY, tiers: cfg.tiers, workflows: cfg.workflows }).map((d) => `${d.subject} ${d.reasons.join(',')}`);
    assert.deepEqual(at(0.9), []);
    assert.deepEqual(at(1.1), ['o/skipped skips_only']);
    assert.deepEqual(at(30.1), ['o/measured stale', 'o/skipped stale']);
  } finally {
    s.cleanup();
    db.close();
  }
});
