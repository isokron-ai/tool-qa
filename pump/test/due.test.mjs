import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalJson, runKey, runKeyFields, computeDue, dueFromState, loadConfig, NO_HOOKS, gapKind, coverageGapBoost, gapBoostCap } from '../due.mjs';
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
  // The coverage-gap boost needs the due list's context; without it, nothing.
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

  // Eight days later repo:1 is stale; repo:2's lease has expired so it is due
  // again, first: it has never been assessed (coverage-gap boost, R-COV-03).
  due = dueFromState(db, { ...config, now: T0 + 8 * DAY });
  assert.deepEqual(due.map((d) => [d.subject, d.reasons, d.gap]), [['repo:2', ['first_sight'], 'never_assessed'], ['repo:1', ['stale'], null]]);
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
  // Pins which lanes are switched on, so turning one on needs a reviewed test change.
  assert.deepEqual(Object.entries(c.workflows).filter(([, w]) => w.enabled === true).map(([k]) => k).sort(), ['scan-static']);
  assert.ok(Object.values(c.workflows).every((w) => typeof w.enabled === 'boolean'));
});

// ---- R-COV-03, R-COV-05..07: the coverage-gap boost ----

const MOVED = ['tool_version'];

test('R-COV-03: gapKind: never assessed, or last unassessed by our own limit once something moved; not the subject\'s side, policy or a result from before coverage', () => {
  assert.equal(gapKind(undefined), 'never_assessed');
  assert.equal(gapKind({ coverage: 'unassessed_tool', fault: 'tool' }, MOVED), 'our_limit');
  assert.equal(gapKind({ coverage: 'unassessed_unknown', fault: 'unknown' }, ['change_event']), 'our_limit');
  assert.equal(gapKind({ coverage: 'unassessed_infra', fault: 'infra', ever_assessed: false }), 'never_assessed');
  assert.equal(gapKind({ coverage: 'unassessed_infra', fault: 'infra', ever_assessed: true }), null);
  assert.equal(gapKind({ coverage: 'assessed', fault: null, ever_assessed: true }, MOVED), null);
  assert.equal(gapKind({ coverage: 'subject', fault: 'subject' }, MOVED), null);
  assert.equal(gapKind({ coverage: 'excluded', fault: 'policy' }, MOVED), null);
  assert.equal(gapKind({ coverage: null, fault: null }, MOVED), null, 'a result from before state schema 7 is not guessed');
});

test('R-COV-03: the boost is coverage_gap_share x the tier weight (capped below the tier above), so it follows tier (popularity)', () => {
  assert.equal(tiers.priority.coverage_gap_share, 0.5);
  const boosts = [0, 1, 2, 3, 4].map((t) => coverageGapBoost(subj('x', t), 'scan-static', { tier: `T${t}`, last: undefined, tiers }));
  // T2: 0.5 x 40 = 20 would tie the 60 - 40 gap to T1, so it is capped at 19 (R-COV-05).
  assert.deepEqual(boosts, [50, 30, 19, 10, 5]);
  assert.equal(coverageGapBoost(subj('x', 1), 'scan-static', { tier: 'T1', last: { coverage: 'assessed', ever_assessed: true }, tiers, reasons: MOVED }), 0);
  assert.equal(coverageGapBoost(subj('x', 1), 'scan-static', { tier: 'T1', last: undefined, tiers: { ...tiers, priority: { ...tiers.priority, coverage_gap_share: 0 } } }), 0);
});

/** A last result as dueFromState builds it, with a fault side and coverage. */
function lastWith(s, name, w, acceptedAt, coverage, fault, everAssessed = false) {
  return { ...resultFor(s, name, w, acceptedAt), coverage, fault, ever_assessed: everAssessed };
}

test('R-COV-03: within a tier, a never-assessed pair is boosted and a stale assessed one is not; the boost never makes a pair due', () => {
  const w = wf();
  const theirs = subj('theirs', 1);
  const fresh = subj('fresh', 1);
  const graded = subj('graded', 1);
  const recent = subj('recent', 1);
  const at = T0 - 10 * DAY;
  const last = new Map([
    ['theirs\u0000live-probe', lastWith(theirs, 'live-probe', w, at, 'subject', 'subject')],
    ['graded\u0000live-probe', lastWith(graded, 'live-probe', w, at, 'assessed', null, true)],
    ['recent\u0000live-probe', lastWith(recent, 'live-probe', w, T0 - DAY, 'unassessed_tool', 'tool')],
  ]);
  const due = computeDue(input({
    subjects: [graded, theirs, fresh, recent],
    lastResults: last,
    resultKeys: new Set([...last.values()].map((r) => r.run_key)),
  }));
  // T1: weight 60, stale 10, age 10 days; fresh: first_sight, no age, gap +30.
  assert.deepEqual(due.map((d) => [d.subject, d.reasons, d.gap, d.priority]), [
    ['fresh', ['first_sight'], 'never_assessed', 90],
    ['graded', ['stale'], null, 80],
    ['theirs', ['stale'], null, 80],
  ]);
  assert.ok(!due.some((d) => d.subject === 'recent'), 'a recent tool-fault skip is not due only because it is a gap');
});

test('R-COV-03: a new tool version makes every tool-fault skip due again (tool_version), boosted ahead of the rest of its tier', () => {
  const v1 = wf();
  const v2 = wf({ versions: { ...v1.versions, tool: { 'mcp-check': '1.1.0' } } });
  const ours = subj('ours', 2);
  const graded = subj('graded', 2);
  const theirs = subj('theirs', 2);
  const at = T0 - DAY;
  const last = new Map([
    ['ours\u0000live-probe', lastWith(ours, 'live-probe', v1, at, 'unassessed_tool', 'tool')],
    ['graded\u0000live-probe', lastWith(graded, 'live-probe', v1, at, 'assessed', null, true)],
    ['theirs\u0000live-probe', lastWith(theirs, 'live-probe', v1, at, 'subject', 'subject')],
  ]);
  const keys = new Set([...last.values()].map((r) => r.run_key));
  assert.deepEqual(computeDue(input({ subjects: [ours, graded, theirs], lastResults: last, resultKeys: keys })), [], 'same tool: nothing is due a day later');
  const due = computeDue(input({ subjects: [ours, graded, theirs], workflows: { 'live-probe': v2 }, lastResults: last, resultKeys: keys }));
  // T2: weight 40, tool_version 20, age 1 day; gap +19 (capped).
  assert.deepEqual(due.map((d) => [d.subject, d.reasons, d.gap, d.priority]), [
    ['ours', ['tool_version'], 'our_limit', 80],
    ['graded', ['tool_version'], null, 61],
    ['theirs', ['tool_version'], null, 61],
  ]);
});

test('R-COV-03: dueFromState reads fault and coverage from the store; an assessed result under an older run_key counts as assessed', () => {
  const db = openState(':memory:');
  const v = (t) => wf({ versions: { ...wf().versions, tool: { 'mcp-check': t } } });
  db.setSubjectVersion({ id: 'repo:a', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - 10 * DAY });
  db.setSubjectVersion({ id: 'repo:b', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - 10 * DAY });
  const record = (workflows, now, outcome) => {
    const due = dueFromState(db, { tiers, workflows, now });
    for (const d of due) {
      const att = `att-${d.subject}-${now}`;
      const lease = db.acquireLease(d.run_key, att, { ttlMs: DAY, now });
      db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now });
      db.createDispatch({ attemptId: att, shardId: 's', workflow: d.workflow, repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: now + DAY, items: [{ run_key: d.run_key, subject: d.subject, fence: lease.fence }], now });
      db.recordResult({ run_key: d.run_key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', ...outcome(d.subject), now: now + 1 });
    }
    return due;
  };
  // v1: both assessed. v2: repo:a hits a reader error (ours), repo:b an infra skip whose retries ran out.
  record({ 'live-probe': v('1') }, T0, () => ({ fault: null, coverage: 'assessed' }));
  record({ 'live-probe': v('2') }, T0 + 1000, (s) => (s === 'repo:a' ? { fault: 'tool', coverage: 'unassessed_tool' } : { fault: 'infra', coverage: 'unassessed_infra' }));
  // v3: both due again; only repo:a is a gap (repo:b was assessed under v1).
  const due = dueFromState(db, { tiers, workflows: { 'live-probe': v('3') }, now: T0 + 2000 });
  assert.deepEqual(due.map((d) => [d.subject, d.reasons, d.gap]), [['repo:a', ['tool_version'], 'our_limit'], ['repo:b', ['tool_version'], null]]);
  assert.equal(due[0].priority - due[1].priority, 30);
  db.close();
});

test('R-COV-05: with equal reasons and age, a boosted pair stays strictly below a bare pair of the tier above, for every adjacent tier and any share', () => {
  const names = Object.keys(tiers.weights).sort((a, b) => tiers.weights[b] - tiers.weights[a]);
  for (const share of [tiers.priority.coverage_gap_share, 0.5, 1, 5]) {
    const t = { ...tiers, priority: { ...tiers.priority, coverage_gap_share: share } };
    for (let i = 1; i < names.length; i++) {
      const boost = coverageGapBoost(subj('x', Number(names[i].slice(1))), 'live-probe', { tier: names[i], last: undefined, tiers: t });
      assert.ok(tiers.weights[names[i]] + boost < tiers.weights[names[i - 1]], `${names[i]} + ${boost} < ${names[i - 1]} at share ${share}`);
    }
  }
  assert.equal(gapBoostCap(tiers, 'T0'), Infinity);
  assert.equal(gapBoostCap(tiers, 'T2'), 19);
  assert.equal(gapBoostCap({ weights: { A: 10, B: 9.5 } }, 'B'), 0);
  // The review's case: a T2 tool-fault skip after a tool release no longer outranks a T1 assessed pair of the same age.
  const v1 = wf();
  const v2 = wf({ versions: { ...v1.versions, tool: { 'mcp-check': '1.1.0' } } });
  const ours = subj('t2-ours', 2);
  const graded = subj('t1-graded', 1);
  const at = T0 - DAY / 2;
  const last = new Map([
    ['t2-ours\u0000live-probe', lastWith(ours, 'live-probe', v1, at, 'unassessed_tool', 'tool')],
    ['t1-graded\u0000live-probe', lastWith(graded, 'live-probe', v1, at, 'assessed', null, true)],
  ]);
  const due = computeDue(input({ subjects: [ours, graded], workflows: { 'live-probe': v2 }, lastResults: last, resultKeys: new Set([...last.values()].map((r) => r.run_key)) }));
  assert.deepEqual(due.map((d) => [d.subject, d.priority]), [['t1-graded', 80.5], ['t2-ours', 79.5]]);
});

test('R-COV-06: a tool-limit skip is boosted only when something moved (tool_version, new_version, change_event), never when merely stale', () => {
  const w = wf();
  const at = T0 - 40 * DAY;
  const stale = subj('stale', 3);
  const changed = subj('changed', 3, { changed_at: new Date(T0 - DAY).toISOString() });
  const moved = subj('moved', 3, { sha: 'b'.repeat(40) });
  const last = new Map([
    ['stale\u0000live-probe', lastWith(stale, 'live-probe', w, at, 'unassessed_tool', 'tool')],
    ['changed\u0000live-probe', lastWith(changed, 'live-probe', w, at, 'unassessed_tool', 'tool')],
    ['moved\u0000live-probe', lastWith(subj('moved', 3), 'live-probe', w, at, 'unassessed_unknown', 'unknown')],
  ]);
  const due = computeDue(input({ subjects: [stale, changed, moved], lastResults: last, resultKeys: new Set([...last.values()].map((r) => r.run_key)) }));
  // T3: weight 20, age capped at 30; stale 10, change_event 30, new_version 30; gap +10 only where something moved.
  assert.deepEqual(due.map((d) => [d.subject, d.reasons, d.gap, d.priority]), [
    ['changed', ['change_event'], 'our_limit', 90],
    ['moved', ['new_version'], 'our_limit', 90],
    ['stale', ['stale'], null, 60],
  ]);
});

test('R-COV-07: a result from before state schema 7 that was not skips_only counts as assessed; a skips_only one does not', () => {
  const db = openState(':memory:');
  const v = (t) => wf({ versions: { ...wf().versions, tool: { 'mcp-check': t } } });
  for (const id of ['repo:graded', 'repo:skips']) db.setSubjectVersion({ id, kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
  const record = (workflows, now, extra) => {
    for (const d of dueFromState(db, { tiers, workflows, now })) {
      const att = `att-${d.subject}-${now}`;
      const lease = db.acquireLease(d.run_key, att, { ttlMs: DAY, now });
      db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now });
      db.createDispatch({ attemptId: att, shardId: 's', workflow: d.workflow, repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: now + DAY, items: [{ run_key: d.run_key, subject: d.subject, fence: lease.fence }], now });
      db.recordResult({ run_key: d.run_key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', ...extra(d.subject), now: now + 1 });
    }
  };
  // v1, as an older ingest recorded it: no fault, no coverage.
  record({ 'live-probe': v('1') }, T0, (s) => (s === 'repo:skips' ? { resultOutcome: 'skips_only' } : {}));
  // v2: both hit an outage whose retries ran out.
  record({ 'live-probe': v('2') }, T0 + 1000, () => ({ fault: 'infra', coverage: 'unassessed_infra' }));
  const due = dueFromState(db, { tiers, workflows: { 'live-probe': v('3') }, now: T0 + 2000 });
  assert.deepEqual(due.map((d) => [d.subject, d.gap]), [['repo:skips', 'never_assessed'], ['repo:graded', null]]);
  db.close();
});
