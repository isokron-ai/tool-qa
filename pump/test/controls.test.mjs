import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openState } from '../../state/db.mjs';
import { applyControlSwitches, controlLaneStatus, controlProblems, controlTarget, recordControlLanes, syncControlSubjects } from '../controls.mjs';
import { dueFromState, loadConfig, workflowProblems } from '../due.mjs';
import { workerInputs } from '../dispatch.mjs';
import { runTick } from '../tick.mjs';
import { syncSeedSubjects, SEED_FILE } from '../subjects.mjs';
import { fakeClock } from '../../test/lib/fake-api.mjs';

const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));
const DAY = 86_400_000;

const lane = (over = {}) => ({
  enabled: true, switch: 'LANE_T0_DEFECTS_ENABLED', runs_untrusted: false, pin_check: 'label', repo: 'isokron-ai/mcp-write-safety', file: 'defect-matrix.yml', ref: 'main',
  dispatch_style: 't0', shard_size: 1, setup_minutes: 5, minutes_per_subject: 20, slots_max: 1,
  control_subjects: { 'isokron-ai/mcp-write-safety.defect-matrix': { inputs: { defects: 'all' } } },
  versions: { tool: { 'tool-qa-t0-defects': '1' }, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default', ...over,
});
const scan = () => ({
  enabled: true, runs_untrusted: false, repo: 'isokron-ai/mcp-check', file: 'scan-static.yml', ref: 'main',
  shard_size: 5, setup_minutes: 1, minutes_per_subject: 1, slots_max: 3, versions: { tool: {}, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default',
});
const cfg = (workflows) => ({ tiers, workflows });
const recorder = () => {
  const calls = [];
  return { calls, async dispatch(req) { calls.push(req); return { runId: 900 + calls.length, runUrl: null, correlatedBy: 'response' }; }, async resolveRef() { return 'a'.repeat(40); } };
};

function world(workflows) {
  const c = fakeClock();
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'isokron-ai/kronicle-lite', kind: 'github', source: 'seed-v1', tier: 0, now: c.t });
  syncControlSubjects(db, workflows, { now: c.t });
  return { c, db };
}

test('R-CTL-01: a control lane is due only for its own control subjects, and a control subject only for the lane that lists it', () => {
  const workflows = { 'scan-static': scan(), 't0-defects': lane() };
  const { c, db } = world(workflows);
  const due = dueFromState(db, { tiers, workflows, now: c.t });
  const pairs = due.map((d) => `${d.subject} ${d.workflow}`).sort();
  assert.deepEqual(pairs, ['isokron-ai/kronicle-lite scan-static', 'isokron-ai/mcp-write-safety.defect-matrix t0-defects']);
  db.close();
});

test('R-CTL-02: a control lane is dispatched with the T0 inputs and its subject\'s own file and fixed inputs', async () => {
  const workflows = {
    't0-self': lane({
      switch: 'LANE_T0_SELF_ENABLED', repo: 'isokron-ai/mcp-writecheck-action', file: 'selftest.yml',
      control_subjects: {
        'isokron-ai/mcp-writecheck-action.selftest': { file: 'selftest.yml' },
        'isokron-ai/mcp-writecheck-action.dogfood-writesafe': { file: 'dogfood-writesafe.yml', inputs: { 'cli-ref': '' } },
      },
    }),
  };
  const { c, db } = world(workflows);
  const d = recorder();
  const s = await runTick({ db, now: c.now, config: cfg(workflows), workerSlots: 3, dispatcher: d, newId: (() => { let n = 0; return () => `att-${++n}`; })() });
  assert.equal(s.dispatched, 1, 'slots_max 1: one worker at a time');
  const [call] = d.calls;
  assert.equal(call.repo, 'isokron-ai/mcp-writecheck-action');
  assert.match(call.workflowFile, /^(selftest|dogfood-writesafe)\.yml$/);
  assert.deepEqual(Object.keys(call.inputs).sort(), call.workflowFile === 'selftest.yml' ? ['attempt_id', 'fence', 'run_key', 'shard_id'] : ['attempt_id', 'cli-ref', 'fence', 'run_key', 'shard_id']);
  assert.match(call.inputs.run_key, /^[0-9a-f]{64}$/);
  assert.match(call.inputs.fence, /^\d+$/);
  assert.equal(call.inputs.items, undefined, 'a T0 worker takes no items list');
  const row = db.getDispatch('att-1');
  assert.equal(row.workflow_file, call.workflowFile, 'ingest checks the run against the file dispatched');
  db.close();
});

test('R-CTL-02: a lane\'s fixed inputs never override shard_id, attempt_id, fence or run_key; more than one item is refused', () => {
  const inputs = workerInputs({ shardId: 's1', attemptId: 'a1', items: [{ subject: 'x/y.z', run_key: 'k'.repeat(64), fence: 7 }], style: 't0', extra: { fence: 'evil', run_key: 'evil', defects: 'all' } });
  assert.deepEqual(inputs, { defects: 'all', shard_id: 's1', attempt_id: 'a1', fence: '7', run_key: 'k'.repeat(64) });
  assert.throws(() => workerInputs({ shardId: 's', attemptId: 'a', items: [{ run_key: 'a', fence: 1 }, { run_key: 'b', fence: 2 }], style: 't0' }), /exactly one item/);
});

test('R-CTL-03: a control lane is off unless its repository variable is exactly "true"', () => {
  const w = { 't0-defects': lane(), 'scan-static': scan() };
  for (const env of [{}, { LANE_T0_DEFECTS_ENABLED: '' }, { LANE_T0_DEFECTS_ENABLED: 'TRUE' }, { LANE_T0_DEFECTS_ENABLED: '1' }, { LANE_T0_DEFECTS_ENABLED: 'true ' }, { LANE_T0_SELF_ENABLED: 'true' }]) {
    assert.equal(applyControlSwitches(w, env)['t0-defects'].enabled, false, JSON.stringify(env));
  }
  assert.equal(applyControlSwitches(w, { LANE_T0_DEFECTS_ENABLED: 'true' })['t0-defects'].enabled, true);
  assert.equal(applyControlSwitches(w, {})['scan-static'].enabled, true, 'other lanes are not touched');
  assert.equal(w['t0-defects'].enabled, true, 'the input is not changed');
});

test('R-CTL-03: a switched-off control lane dispatches nothing', async () => {
  const w = { 't0-defects': lane() };
  const { c, db } = world(w);
  const d = recorder();
  const s = await runTick({ db, now: c.now, config: cfg(applyControlSwitches(w, {})), workerSlots: 3, dispatcher: d });
  assert.equal(s.dispatched, 0);
  assert.equal(d.calls.length, 0);
  db.close();
});

test('R-CTL-04: control lane settings are checked: one item, T0 style, a switch, our own code, safe inputs', () => {
  assert.deepEqual(controlProblems({ 't0-defects': lane() }), []);
  const bad = (over) => controlProblems({ x: lane(over) }).join(' | ');
  assert.match(bad({ shard_size: 2 }), /shard_size 1/);
  assert.match(bad({ dispatch_style: undefined }), /dispatch_style/);
  assert.match(bad({ switch: undefined }), /switch/);
  assert.match(bad({ switch: 'lane_x' }), /switch/);
  assert.match(bad({ runs_untrusted: 'no' }), /runs_untrusted true or false/);
  assert.match(bad({ runs_untrusted: true }), /must pin sandbox_sha/, 'a lane that runs third-party code pins the sandbox');
  assert.deepEqual(controlProblems({ x: lane({ runs_untrusted: true, sandbox_sha: 'a'.repeat(40) }) }), [], 'untrusted with a sandbox pin is allowed');
  assert.match(bad({ control_subjects: {} }), /non-empty/);
  assert.match(bad({ control_subjects: { 'not a repo': {} } }), /not owner\/name/);
  assert.match(bad({ control_subjects: { 'a/b.c': { file: '../x.yml' } } }), /workflow file name/);
  assert.match(bad({ control_subjects: { 'a/b.c': { inputs: { fence: '1' } } } }), /not allowed/);
  assert.match(bad({ control_subjects: { 'a/b.c': { inputs: { ok: 1 } } } }), /must be a string/);
  assert.match(controlProblems({ s: scan(), y: { ...scan(), dispatch_style: 't0' } }).join(' | '), /dispatch_style is only for/);
  const twice = controlProblems({ a: lane(), b: lane() }).join(' | ');
  assert.match(twice, /also listed/);
  assert.match(workflowProblems({ x: lane({ shard_size: 3 }) }).join(' | '), /shard_size 1/, 'loadConfig refuses it through workflowProblems');
});

test('R-CTL-04: the shipped lanes are well formed, off in every tier but T0, and daily in T0', () => {
  const c = loadConfig();
  for (const name of ['t0-defects', 't0-self', 't0-dogfood']) {
    assert.ok(c.workflows[name], name);
    assert.equal(c.workflows[name].dispatch_style, 't0');
    for (const tier of ['T1', 'T2', 'T3', 'T4']) assert.equal(c.tiers.tiers[tier][name].mode, 'never', `${name} ${tier}`);
    assert.deepEqual(c.tiers.tiers.T0[name], { mode: 'always', max_age_days: 1 });
  }
  assert.deepEqual(Object.keys(c.workflows['t0-defects'].control_subjects), ['isokron-ai/mcp-write-safety.defect-matrix']);
  assert.deepEqual(Object.keys(c.workflows['t0-self'].control_subjects), ['isokron-ai/mcp-writecheck-action.selftest', 'isokron-ai/mcp-writecheck-action.dogfood-tiny-tracker']);
  assert.deepEqual(Object.keys(c.workflows['t0-dogfood'].control_subjects).map((x) => x.split('.').pop()).sort(), ['dogfood-grafana', 'dogfood-kronicle-lite', 'dogfood-kubernetes', 'dogfood-payload', 'dogfood-sea-lite', 'dogfood-writesafe']);
  assert.equal(controlTarget(c.workflows['t0-dogfood'], 'isokron-ai/mcp-writecheck-action.dogfood-grafana').file, 'dogfood-grafana.yml');
  assert.equal(controlTarget(c.workflows['t0-self'], 'isokron-ai/kronicle-lite'), null);
});

test('R-CTL-11: the workers that run third-party code are in the untrusted lane, which the sandbox breaker gates; only our own code is trusted', () => {
  const c = loadConfig();
  assert.equal(c.workflows['t0-dogfood'].runs_untrusted, true);
  assert.match(c.workflows['t0-dogfood'].sandbox_sha, /^[0-9a-f]{40}$/);
  assert.equal(c.workflows['t0-self'].runs_untrusted, false);
  assert.equal(c.workflows['t0-defects'].runs_untrusted, false);
  // kronicle-lite and sea-lite install npm trees, writesafe starts Strapi, grafana, kubernetes and payload build upstream code.
  for (const n of ['kronicle-lite', 'sea-lite', 'writesafe', 'grafana', 'kubernetes', 'payload']) assert.ok(c.workflows['t0-dogfood'].control_subjects[`isokron-ai/mcp-writecheck-action.dogfood-${n}`], n);
  for (const n of ['kronicle-lite', 'sea-lite', 'writesafe', 'grafana', 'kubernetes', 'payload']) assert.equal(c.workflows['t0-self'].control_subjects[`isokron-ai/mcp-writecheck-action.dogfood-${n}`], undefined, `${n} is not in the trusted lane`);
});

test('R-CTL-05: control subjects are kept apart from the seed: synced once, retired when unlisted, never retired or looked up as repositories', () => {
  const w = { 't0-defects': lane() };
  const c = fakeClock();
  const db = openState(':memory:');
  assert.deepEqual(syncControlSubjects(db, w, { now: c.t }), { added: 1, retired: 0, subjects: 1 });
  assert.deepEqual(syncControlSubjects(db, w, { now: c.t }), { added: 0, retired: 0, subjects: 1 }, 'idempotent');
  const s = db.getSubject('isokron-ai/mcp-write-safety.defect-matrix');
  assert.equal(s.kind, 'control');
  assert.equal(s.tier, 0);
  const cand = db.identityCandidates({ now: c.t, retryMs: {}, limit: 100 });
  assert.deepEqual([...cand.byName, ...cand.byId].filter((x) => x.id === s.id), [], 'no GitHub lookup for a pseudo repository');
  const seeded = syncSeedSubjects(db, { now: c.t, file: SEED_FILE });
  assert.equal(seeded.error, undefined);
  assert.equal(db.getSubject(s.id).retired_at, null, 'a seed load does not retire it');
  assert.deepEqual(syncControlSubjects(db, { 't0-defects': lane({ control_subjects: { 'isokron-ai/mcp-write-safety.other': {} } }) }, { now: c.t }), { added: 1, retired: 1, subjects: 1 });
  assert.notEqual(db.getSubject(s.id).retired_at, null);
  db.close();
});

/** Record one dispatched control item and its decision. */
function decide(db, c, lane0, subject, { accepted, reason = null, at }) {
  const fields = { subject_id: subject, n: Math.random() };
  const runKey = [...Array(64)].map(() => 'abcdef0123456789'[Math.floor(Math.random() * 16)]).join('');
  db.recordRunKey(runKey, { subject, workflow: lane0, fields, now: at });
  const attempt = `att-${runKey.slice(0, 6)}`;
  const l = db.acquireLease(runKey, attempt, { ttlMs: DAY, now: at });
  db.createDispatch({ attemptId: attempt, shardId: `s-${attempt}`, workflow: lane0, repo: 'isokron-ai/mcp-write-safety', workflowFile: 'defect-matrix.yml', ref: 'main', expires: at + DAY, items: [{ run_key: runKey, subject, fence: l.fence }], workflowSha: null, now: at });
  db.recordResult({ run_key: runKey, attempt_id: attempt, fence: l.fence, outcome: accepted ? 'accepted' : 'rejected', accepted, reason, now: at });
  return attempt;
}

test('R-CTL-06: a subject is failed only while a control_failed rejection is newer than its last accepted result', () => {
  const w = { 't0-defects': lane() };
  const sub = 'isokron-ai/mcp-write-safety.defect-matrix';
  const { c, db } = world(w);
  const t0 = c.t;
  const status = (now) => controlLaneStatus(db, { workflows: w, enabled: w, now })['t0-defects'];
  assert.equal(status(t0).failed, false, 'nothing yet');
  assert.equal(status(t0).subjects[sub].last_result_at, null);
  decide(db, c, 't0-defects', sub, { accepted: true, at: t0 + 1000 });
  assert.equal(status(t0 + 2000).failed, false);
  const miss = decide(db, c, 't0-defects', sub, { accepted: false, reason: 'control_failed', at: t0 + DAY });
  const s2 = status(t0 + DAY + 1);
  assert.equal(s2.failed, true, 'a missed defect is red');
  assert.equal(s2.subjects[sub].failed_attempt, miss);
  decide(db, c, 't0-defects', sub, { accepted: false, reason: 'no_artifact', at: t0 + DAY + 5000 });
  assert.equal(status(t0 + DAY + 6000).failed, true, 'another reason does not clear it');
  decide(db, c, 't0-defects', sub, { accepted: true, at: t0 + 2 * DAY });
  assert.equal(status(t0 + 2 * DAY + 1).failed, false, 'a later accepted result clears it');
  db.close();
});

test('R-CTL-12: one subject\'s success never covers another subject\'s miss, and a miss stays while its run_key is parked', () => {
  const a = 'isokron-ai/mcp-writecheck-action.selftest';
  const b = 'isokron-ai/mcp-writecheck-action.dogfood-tiny-tracker';
  const w = { 't0-self': lane({ switch: 'LANE_T0_SELF_ENABLED', repo: 'isokron-ai/mcp-writecheck-action', file: 'selftest.yml', control_subjects: { [a]: {}, [b]: {} } }) };
  const { c, db } = world(w);
  const t0 = c.t;
  decide(db, c, 't0-self', a, { accepted: true, at: t0 + 1000 });
  decide(db, c, 't0-self', b, { accepted: false, reason: 'control_failed', at: t0 + 2000 });
  decide(db, c, 't0-self', a, { accepted: true, at: t0 + 3000 }); // a newer success of the OTHER subject
  const st = controlLaneStatus(db, { workflows: w, enabled: w, now: t0 + 4000 })['t0-self'];
  assert.equal(st.subjects[a].failed, false);
  assert.equal(st.subjects[b].failed, true, 'b is still red although the lane produced a newer accepted result');
  assert.equal(st.failed, true);
  // three counted rejections park b's run_key: no new dispatch, and it is still red
  for (let i = 0; i < 2; i++) decide(db, c, 't0-self', b, { accepted: false, reason: 'control_failed', at: t0 + 5000 + i * 1000 });
  assert.equal(controlLaneStatus(db, { workflows: w, enabled: w, now: t0 + 9000 })['t0-self'].subjects[b].failed, true);
  db.close();
});

test('R-CTL-06: other rejections (no artifact, stale fence) are not a missed defect', () => {
  const w = { 't0-defects': lane() };
  const { c, db } = world(w);
  decide(db, c, 't0-defects', 'isokron-ai/mcp-write-safety.defect-matrix', { accepted: false, reason: 'no_artifact', at: c.t + 1000 });
  assert.equal(controlLaneStatus(db, { workflows: w, enabled: w, now: c.t + 2000 })['t0-defects'].failed, false);
  db.close();
});

test('R-CTL-06: the pump records on_since once, and records the lane off when its switch is off', () => {
  const w = { 't0-defects': lane() };
  const { c, db } = world(w);
  recordControlLanes(db, { workflows: w, enabled: w, now: c.t });
  const first = db.getKv('t0.lanes').lanes['t0-defects'];
  assert.equal(first.on, true);
  recordControlLanes(db, { workflows: w, enabled: w, now: c.t + 3600_000 });
  assert.equal(db.getKv('t0.lanes').lanes['t0-defects'].on_since, first.on_since, 'on_since is kept');
  recordControlLanes(db, { workflows: w, enabled: applyControlSwitches(w, {}), now: c.t + 7200_000 });
  const off = db.getKv('t0.lanes').lanes['t0-defects'];
  assert.equal(off.on, false);
  assert.equal(off.on_since, null);
  db.close();
});

test('R-CTL-15: a skips_only result (infrastructure skipped, nothing measured) is not a result of the control: last_result_at ignores it, and the status says infra_only_since', () => {
  const w = { 't0-defects': lane() };
  const sub = 'isokron-ai/mcp-write-safety.defect-matrix';
  const { c, db } = world(w);
  const t0 = c.t;
  const st = (now) => controlLaneStatus(db, { workflows: w, enabled: w, now })['t0-defects'].subjects[sub];
  decide(db, c, 't0-defects', sub, { accepted: true, at: t0 + 1000 });
  const good = st(t0 + 2000).last_result_at;
  assert.ok(good);
  const skipsOnly = (at) => {
    const runKey = [...Array(64)].map(() => 'abcdef0123456789'[Math.floor(Math.random() * 16)]).join('');
    db.recordRunKey(runKey, { subject: sub, workflow: 't0-defects', fields: { n: Math.random() }, now: at });
    const attempt = `att-${runKey.slice(0, 6)}`;
    const l = db.acquireLease(runKey, attempt, { ttlMs: DAY, now: at });
    db.createDispatch({ attemptId: attempt, shardId: `s-${attempt}`, workflow: 't0-defects', repo: 'isokron-ai/mcp-write-safety', workflowFile: 'defect-matrix.yml', ref: 'main', expires: at + DAY, items: [{ run_key: runKey, subject: sub, fence: l.fence }], workflowSha: null, now: at });
    db.recordResult({ run_key: runKey, attempt_id: attempt, fence: l.fence, outcome: 'accepted', accepted: true, resultOutcome: 'skips_only', now: at });
  };
  skipsOnly(t0 + 2 * DAY);
  const after = st(t0 + 2 * DAY + 1);
  assert.equal(after.last_result_at, good, 'the skips_only result did not move last_result_at');
  assert.ok(after.infra_only_since, 'but it is said');
  db.close();
});
