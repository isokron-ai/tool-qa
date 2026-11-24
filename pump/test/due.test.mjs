import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalJson, runKey, runKeyFields, computeDue, dueFromState, loadConfig, NO_HOOKS } from '../due.mjs';
import { openState } from '../../state/db.mjs';

const T0 = Date.parse('2026-11-23T12:00:00Z');
const DAY = 86_400_000;
const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));

const wf = (over = {}) => ({
  enabled: true, repo: 'isokron-ai/mcp-check', file: 'live-probe.yml', ref: 'main',
  shard_size: 10, setup_minutes: 4, minutes_per_subject: 2, slots_max: 12,
  versions: { tool: { 'mcp-check': '1.0.0' }, oracle: { inspector: '0.9.0' }, probe: { battery: '3', version_list: '2025-11-25' } },
  image_digest: 'sha256:' + '1'.repeat(64), settings_state: 'default', ...over,
});
const subj = (id, tier, over = {}) => ({ id, tier, sha: 'a'.repeat(40), artifact_digest: null, changed_at: null, ...over });

function input(over = {}) {
  return {
    now: T0,
    subjects: [],
    workflows: { 'live-probe': wf() },
    tiers,
    lastResults: new Map(),
    resultKeys: new Set(),
    inFlight: new Set(),
    parked: new Set(),
    hooks: NO_HOOKS,
    ...over,
  };
}

/** A last result for (subject, workflow) computed from given fields. */
function resultFor(s, name, w, acceptedAt) {
  const fields = runKeyFields(s, name, w);
  return { run_key: runKey(fields), accepted_at: new Date(acceptedAt).toISOString(), fields };
}

test('canonicalJson sorts keys at every level and has no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => canonicalJson({ a: Infinity }), /finite/);
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
});

test('runKeyFields carries every run_key field from the design', () => {
  const f = runKeyFields(subj('repo:1', 1), 'live-probe', wf());
  assert.deepEqual(Object.keys(f).sort(), [
    'artifact_digest', 'image_digest', 'oracle_versions', 'probe_versions', 'settings_state', 'sha', 'subject_id', 'tool_versions', 'workflow',
  ]);
  assert.equal(f.subject_id, 'repo:1');
  assert.equal(f.workflow, 'live-probe');
});

test('run_key is sha256 of the canonical JSON and changes with any field', () => {
  const f = runKeyFields(subj('repo:1', 1), 'live-probe', wf());
  const k = runKey(f);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, createHash('sha256').update(canonicalJson(f)).digest('hex'));
  // Key order does not matter.
  const shuffled = Object.fromEntries(Object.entries(f).reverse());
  assert.equal(runKey(shuffled), k);
  const variants = [
    runKeyFields(subj('repo:2', 1), 'live-probe', wf()),
    runKeyFields(subj('repo:1', 1, { sha: 'b'.repeat(40) }), 'live-probe', wf()),
    runKeyFields(subj('repo:1', 1, { artifact_digest: 'sha256:x' }), 'live-probe', wf()),
    runKeyFields(subj('repo:1', 1), 'scan-static', wf()),
    runKeyFields(subj('repo:1', 1), 'live-probe', wf({ versions: { ...wf().versions, tool: { 'mcp-check': '1.0.1' } } })),
    runKeyFields(subj('repo:1', 1), 'live-probe', wf({ versions: { ...wf().versions, oracle: { inspector: '0.9.1' } } })),
    runKeyFields(subj('repo:1', 1), 'live-probe', wf({ versions: { ...wf().versions, probe: { battery: '4', version_list: '2025-11-25' } } })),
    runKeyFields(subj('repo:1', 1), 'live-probe', wf({ image_digest: 'sha256:' + '2'.repeat(64) })),
    runKeyFields(subj('repo:1', 1), 'live-probe', wf({ settings_state: 'all-set' })),
  ];
  const keys = new Set([k, ...variants.map(runKey)]);
  assert.equal(keys.size, variants.length + 1);
  // The tier is not part of the run_key: re-tiering does not re-run.
  assert.equal(runKey(runKeyFields(subj('repo:1', 3), 'live-probe', wf())), k);
});

test('a subject with no result is due as first_sight', () => {
  const due = computeDue(input({ subjects: [subj('repo:1', 2)] }));
  assert.equal(due.length, 1);
  assert.equal(due[0].subject, 'repo:1');
  assert.equal(due[0].workflow, 'live-probe');
  assert.deepEqual(due[0].reasons, ['first_sight']);
  assert.equal(due[0].run_key, runKey(runKeyFields(subj('repo:1', 2), 'live-probe', wf())));
  assert.equal(due[0].tier, 2);
});

test('a fresh result for the current run_key means not due', () => {
  const s = subj('repo:1', 1);
  const last = resultFor(s, 'live-probe', wf(), T0 - DAY);
  const due = computeDue(input({
    subjects: [s],
    lastResults: new Map([['repo:1\u0000live-probe', last]]),
    resultKeys: new Set([last.run_key]),
  }));
  assert.deepEqual(due, []);
});

test('a new SHA is new_version; a tool, oracle or probe bump is tool_version', () => {
  const s = subj('repo:1', 1);
  const last = resultFor(s, 'live-probe', wf(), T0 - DAY);
  const base = { lastResults: new Map([['repo:1\u0000live-probe', last]]), resultKeys: new Set([last.run_key]) };
  const moved = computeDue(input({ ...base, subjects: [{ ...s, sha: 'c'.repeat(40) }] }));
  assert.deepEqual(moved[0].reasons, ['new_version']);
  const bumped = computeDue(input({
    ...base, subjects: [s],
    workflows: { 'live-probe': wf({ versions: { ...wf().versions, probe: { battery: '4', version_list: '2025-11-25' } } }) },
  }));
  assert.deepEqual(bumped[0].reasons, ['tool_version']);
});

test('a change event after the last result makes it due', () => {
  const s = subj('repo:1', 1, { changed_at: new Date(T0 - 1000).toISOString() });
  const last = resultFor(s, 'live-probe', wf(), T0 - DAY);
  const due = computeDue(input({ subjects: [s], lastResults: new Map([['repo:1\u0000live-probe', last]]), resultKeys: new Set([last.run_key]) }));
  assert.deepEqual(due[0].reasons, ['change_event']);
  // A change before the last result does not.
  const old = { ...s, changed_at: new Date(T0 - 2 * DAY).toISOString() };
  assert.deepEqual(computeDue(input({ subjects: [old], lastResults: new Map([['repo:1\u0000live-probe', last]]), resultKeys: new Set([last.run_key]) })), []);
});

test('staleness follows the tier table per workflow', () => {
  const cases = [
    // tier, workflow, age in days, due?
    [1, 'live-probe', 6.9, false],
    [1, 'live-probe', 7.1, true],
    [2, 'live-probe', 13, false],
    [2, 'live-probe', 15, true],
    [3, 'live-probe', 31, true],
    [4, 'live-probe', 89, false],
    [4, 'live-probe', 91, true],
    [0, 'live-probe', 400, false], // T0 runs on push and release, no age limit
    [0, 'meta-github', 1.1, true],
    [1, 'meta-github', 6, false],
    [3, 'meta-github', 31, true],
  ];
  for (const [tier, name, days, expected] of cases) {
    const s = subj('repo:1', tier);
    const w = wf();
    const last = resultFor(s, name, w, T0 - days * DAY);
    const due = computeDue(input({
      subjects: [s], workflows: { [name]: w },
      lastResults: new Map([[`repo:1\u0000${name}`, last]]), resultKeys: new Set([last.run_key]),
    }));
    assert.equal(due.length === 1, expected, `T${tier} ${name} ${days}d`);
    if (expected) assert.deepEqual(due[0].reasons, ['stale']);
  }
});

test('mode never skips the pair; mode sample waits for a sampling hook', () => {
  const t4 = subj('repo:4', 4);
  const t3 = subj('repo:3', 3);
  const w = { 'scan-deep': wf({ file: 'scan-deep.yml' }) };
  assert.deepEqual(computeDue(input({ subjects: [t4, t3], workflows: w })), []);
  const hooks = { ...NO_HOOKS, rawSample: (s) => s.id === 'repo:3', determinism: (s) => s.id === 'repo:4' };
  const due = computeDue(input({ subjects: [t4, t3], workflows: w, hooks }));
  assert.deepEqual(due.map((d) => [d.subject, d.reasons]), [['repo:3', ['raw_sample']]]);
});

test('the default hooks pick nothing', () => {
  const s = subj('repo:1', 1);
  assert.equal(NO_HOOKS.determinism(s, 'live-probe'), false);
  assert.equal(NO_HOOKS.rawSample(s, 'live-probe'), false);
  assert.equal(NO_HOOKS.leadReverify(s, 'live-probe'), false);
  assert.equal(NO_HOOKS.coverageGap(s, 'live-probe'), 0);
});

test('in-flight, parked and disabled pairs are not due', () => {
  const a = subj('repo:a', 1);
  const b = subj('repo:b', 1);
  const c = subj('repo:c', 1);
  const parkedKey = runKey(runKeyFields(b, 'live-probe', wf()));
  const due = computeDue(input({
    subjects: [a, b, c],
    workflows: { 'live-probe': wf(), 'scan-static': wf({ enabled: false }) },
    inFlight: new Set(['repo:a\u0000live-probe']),
    parked: new Set([parkedKey]),
  }));
  assert.deepEqual(due.map((d) => `${d.subject} ${d.workflow}`), ['repo:c live-probe']);
});

test('priority: lower tier first, then change events, then age; ties by subject', () => {
  const t0 = subj('t0', 0);
  const t2new = subj('t2-new', 2);
  const t1old = subj('t1-old', 1);
  const t1chg = subj('t1-chg', 1, { changed_at: new Date(T0 - 1000).toISOString() });
  const lastOld = resultFor(t1old, 'live-probe', wf(), T0 - 20 * DAY);
  const lastChg = resultFor(t1chg, 'live-probe', wf(), T0 - DAY);
  const due = computeDue(input({
    subjects: [t2new, t1old, t1chg, t0],
    lastResults: new Map([['t1-old\u0000live-probe', lastOld], ['t1-chg\u0000live-probe', lastChg]]),
    resultKeys: new Set([lastOld.run_key, lastChg.run_key]),
  }));
  assert.deepEqual(due.map((d) => d.subject), ['t0', 't1-chg', 't1-old', 't2-new']);
  for (let i = 1; i < due.length; i++) assert.ok(due[i - 1].priority >= due[i].priority);
});

test('computeDue is pure: same input, same output, input untouched', () => {
  const inp = input({ subjects: [subj('x', 1), subj('y', 2)] });
  const snapshot = JSON.stringify({ ...inp, lastResults: [...inp.lastResults], resultKeys: [...inp.resultKeys] });
  const a = computeDue(inp);
  const b = computeDue(inp);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify({ ...inp, lastResults: [...inp.lastResults], resultKeys: [...inp.resultKeys] }), snapshot);
});

test('dueFromState reads subjects, results, in-flight work and rejections from the state store', () => {
  const db = openState(':memory:');
  const config = { tiers, workflows: { 'live-probe': wf() } };
  db.setSubjectVersion({ id: 'repo:1', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - 10 * DAY });
  db.setSubjectVersion({ id: 'repo:2', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - 10 * DAY });
  let due = dueFromState(db, { ...config, now: T0 });
  assert.deepEqual(due.map((d) => d.subject), ['repo:1', 'repo:2']);

  // repo:1 gets a result through the normal path; repo:2 is in flight.
  for (const d of due) {
    const lease = db.acquireLease(d.run_key, `att-${d.subject}`, { ttlMs: DAY, now: T0 });
    db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now: T0 });
    db.createDispatch({ attemptId: `att-${d.subject}`, shardId: 's', workflow: d.workflow, repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: T0 + DAY, items: [{ run_key: d.run_key, subject: d.subject, fence: lease.fence }], now: T0 });
  }
  db.recordResult({ run_key: due[0].run_key, attempt_id: 'att-repo:1', fence: 1, verdict: 'accepted', outcome: 'correct', now: T0 + 1000 });
  due = dueFromState(db, { ...config, now: T0 + 2000 });
  assert.deepEqual(due, []);

  // Eight days later repo:1 is stale; repo:2's lease has expired so it is due again.
  due = dueFromState(db, { ...config, now: T0 + 8 * DAY });
  assert.deepEqual(due.map((d) => [d.subject, d.reasons]), [['repo:1', ['stale']], ['repo:2', ['first_sight']]]);
  db.close();
});

test('dueFromState parks a run_key after max_rejections rejections', () => {
  const db = openState(':memory:');
  const config = { tiers: { ...tiers, max_rejections: 2 }, workflows: { 'live-probe': wf() } };
  db.setSubjectVersion({ id: 'repo:1', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 });
  for (let i = 0; i < 2; i++) {
    const [d] = dueFromState(db, { ...config, now: T0 + i });
    assert.ok(d, `due on round ${i}`);
    const lease = db.acquireLease(d.run_key, `att-${i}`, { ttlMs: DAY, now: T0 + i });
    db.createDispatch({ attemptId: `att-${i}`, shardId: 's', workflow: d.workflow, repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: T0 + DAY, items: [{ run_key: d.run_key, subject: d.subject, fence: lease.fence }], now: T0 + i });
    db.recordResult({ run_key: d.run_key, attempt_id: `att-${i}`, fence: lease.fence, verdict: 'rejected', reason: 'schema_invalid', now: T0 + i });
  }
  assert.deepEqual(dueFromState(db, { ...config, now: T0 + 10 }), []);
  db.close();
});

test('loadConfig reads the shipped tiers and workflows files', () => {
  const c = loadConfig();
  assert.equal(c.tiers.version, 1);
  for (const t of ['T0', 'T1', 'T2', 'T3', 'T4']) assert.ok(c.tiers.tiers[t], t);
  assert.ok(c.workflows['live-probe']);
  // Nothing is dispatched until a worker workflow is switched on.
  assert.ok(Object.values(c.workflows).every((w) => w.enabled === false));
});
