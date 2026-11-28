// Lead re-checks (leads/recheck.mjs): the due list re-dispatches an open lead's
// re-check pair, on its own runner label when the lane names one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { openState } from '../../state/db.mjs';
import { dueFromState, workflowProblems } from '../due.mjs';
import { workerInputs } from '../dispatch.mjs';
import { planShards } from '../tick.mjs';
import { leadRecheckHook, recheckPairs, RECHECK_MAX_DUE, RECHECK_TIMEOUT_MS } from '../../leads/recheck.mjs';

const T0 = Date.parse('2026-11-24T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));
const wf = (over = {}) => ({ enabled: true, runs_untrusted: false, repo: 'o/r', file: 'f.yml', ref: 'main', shard_size: 2, slots_max: 3, versions: { tool: { 'mcp-check': '1' } }, image_digest: null, settings_state: 'default', ...over });
const workflows = { 'scan-static': wf() };
const lead = (n, over = {}) => ({
  fingerprint: sha(`fp-${n}`).slice(0, 12), tool: 'mcp-check', lane: 'scan-static', component: 'static', oracle: 'scan-static', class: 'no_tools_found',
  idiom: 'none/repo:python', layout: 'unknown', signature: `class=no_tools_found;n=${n}`, partial: false, fault: 'tool', versions: ['mcp-check@1'], ...over,
});

/** An accepted scan-static result under the run_key the due list uses now, so the pair is not due for any other reason. */
function accept(db, subject, failures, { runId, now }) {
  const [d] = dueFromState(db, { now, tiers, workflows: { 'scan-static': workflows['scan-static'] } }).filter((x) => x.subject === subject);
  const key = d?.run_key ?? sha(`${subject}-${now}`);
  const att = `att-${subject}-${now}`;
  const lease = db.acquireLease(key, att, { ttlMs: DAY, now });
  db.recordRunKey(key, { subject, workflow: 'scan-static', fields: d?.fields ?? {}, now });
  db.createDispatch({ attemptId: att, shardId: 's', workflow: 'scan-static', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: now + DAY, items: [{ run_key: key, subject, fence: lease.fence }], now });
  db.setDispatchRun(att, { runId, runUrl: null, correlatedBy: 'test', now });
  return db.recordResult({ run_key: key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', fault: failures.length ? 'tool' : null,
    coverage: failures.length ? 'unassessed_tool' : 'assessed', failures, now: now + 1 });
}
const due = (db, now, hooks) => dueFromState(db, { now, tiers, workflows, hooks });

test('R-LEAD-16: an open lead not yet reproduced makes its re-check pair due (lead_reverify) until a newer result is in; a reproduced, infra or filed lead does not', () => {
  const db = openState(':memory:');
  for (const id of ['acme/a', 'acme/b', 'acme/c']) db.setSubjectVersion({ id, kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
  accept(db, 'acme/a', [lead(1)], { runId: 1, now: T0 });
  accept(db, 'acme/b', [lead(2, { fault: 'infra' })], { runId: 2, now: T0 });
  accept(db, 'acme/c', [], { runId: 3, now: T0 });
  const t = T0 + HOUR;
  assert.deepEqual(due(db, t).map((d) => d.subject), [], 'nothing is due without the hook');
  const hook = () => ({ leadReverify: leadRecheckHook(recheckPairs(db)) });
  const d1 = due(db, t, hook());
  assert.deepEqual(d1.map((d) => [d.subject, d.reasons]), [['acme/a', ['lead_reverify']]], 'only the tool lead is re-checked; the infra one waits its 3 days');
  assert.ok(Math.abs(d1[0].priority - (tiers.weights.T1 + tiers.priority.lead_reverify + (HOUR / DAY) * tiers.priority.age_per_day)) < 0.01, String(d1[0].priority));
  // The re-check comes back and reproduces it: no longer due.
  accept(db, 'acme/a', [lead(1)], { runId: 4, now: t });
  assert.ok(db.listLeads().find((l) => l.fingerprint === lead(1).fingerprint).reproduced_at);
  assert.deepEqual(due(db, t + HOUR, hook()), []);
  // A filed lead is not re-checked by the hook either.
  accept(db, 'acme/c', [lead(3)], { runId: 5, now: t + 2 * HOUR });
  db.raw.prepare("UPDATE leads SET status = 'filed', issue_number = 1 WHERE fingerprint = ?").run(lead(3).fingerprint);
  assert.deepEqual(due(db, t + 3 * HOUR, hook()), []);
  const rc = recheckPairs(db);
  assert.equal(rc.pairs.size, 0);
});

test('R-LEAD-16: at most RECHECK_MAX_DUE pairs are due at once, the leads most subjects carry first; the rest wait and are counted', () => {
  const db = openState(':memory:');
  const n = RECHECK_MAX_DUE + 5;
  for (let i = 0; i < n; i++) {
    db.setSubjectVersion({ id: `acme/s${i}`, kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
    accept(db, `acme/s${i}`, [lead(100 + i)], { runId: 10 + i, now: T0 + i });
  }
  // One lead carried by two subjects ranks first.
  db.setSubjectVersion({ id: 'acme/x', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
  accept(db, 'acme/x', [lead(100 + n - 1)], { runId: 999, now: T0 + n });
  const rc = recheckPairs(db);
  assert.equal(rc.pairs.size, RECHECK_MAX_DUE);
  assert.equal(rc.waiting, n);
  assert.ok(rc.pairs.has(`acme/s${n - 1}\u0000scan-static`), 'the lead two subjects carry is first');
  assert.equal(due(db, T0 + DAY, { leadReverify: leadRecheckHook(rc) }).length, RECHECK_MAX_DUE);
  assert.deepEqual(recheckPairs(openStateV10()).pairs.size, 0, 'a state before v11 has none');
});

function openStateV10() {
  const db = openState(':memory:');
  db.raw.exec('DROP TABLE lead_subjects; DROP TABLE leads; PRAGMA user_version = 10');
  return db;
}

test('R-LEAD-17: a lane with a recheck_runner sends its re-checks in shards of their own with that runner; slots_max holds over both; no runner otherwise', () => {
  const item = (subject, reasons, priority = 100) => ({ subject, workflow: 'scan-static', run_key: sha(subject), reasons, priority, fields: {} });
  const list = [item('a', ['stale'], 200), item('b', ['lead_reverify'], 150), item('c', ['stale'], 120), item('d', ['stale'], 110), item('e', ['stale'], 100), item('f', ['stale'], 90), item('g', ['stale'], 80)];
  const plain = planShards(list, { 'scan-static': wf() });
  assert.ok(plain.every((s) => !('runner' in s)));
  const arm = planShards(list, { 'scan-static': wf({ recheck_runner: 'ubuntu-24.04-arm' }) });
  assert.equal(arm.length, 3, 'slots_max 3 over both kinds');
  const rs = arm.filter((s) => s.runner === 'ubuntu-24.04-arm');
  assert.deepEqual(rs.map((s) => s.items.map((i) => i.subject)), [['b']]);
  assert.ok(arm.filter((s) => !s.runner).every((s) => s.items.every((i) => !i.reasons.includes('lead_reverify'))));
  assert.equal(planShards(list, { 'scan-static': wf({ recheck_runner: 'ubuntu-24.04-arm' }) }, { openByWorkflow: new Map([['scan-static', 2]]) }).length, 1, 'open dispatches count');

  assert.equal(workerInputs({ shardId: 's', attemptId: 'a', items: [] }).runner, undefined);
  assert.equal(workerInputs({ shardId: 's', attemptId: 'a', items: [], runner: 'ubuntu-24.04-arm' }).runner, 'ubuntu-24.04-arm');
  assert.throws(() => workerInputs({ shardId: 's', attemptId: 'a', items: [], runner: 'ubuntu; rm -rf' }), /runner label/);
  assert.deepEqual(workflowProblems({ x: wf({ recheck_runner: 'ubuntu-24.04-arm' }) }), []);
  assert.deepEqual(workflowProblems({ x: wf({ recheck_runner: null }) }), []);
  assert.match(workflowProblems({ x: wf({ recheck_runner: '${{ evil }}' }) }).join(), /recheck_runner/);
});

test('R-LEAD-19: a re-check that comes back unassessed is sent again, up to the attempts; a pair whose newer result was never folded (switch off) is not re-sent', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/a', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
  const L = lead(50);
  accept(db, 'acme/a', [L], { runId: 1, now: T0 });
  const hook = () => ({ leadReverify: leadRecheckHook(recheckPairs(db)) });
  const unassessed = (runId, now) => {
    const [d] = dueFromState(db, { now, tiers, workflows, hooks: hook() });
    const att = `att-u-${runId}`;
    const lease = db.acquireLease(d.run_key, att, { ttlMs: DAY, now });
    db.createDispatch({ attemptId: att, shardId: 's', workflow: 'scan-static', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: now + DAY, items: [{ run_key: d.run_key, subject: 'acme/a', fence: lease.fence }], now });
    db.setDispatchRun(att, { runId, runUrl: null, correlatedBy: 'test', now });
    db.recordResult({ run_key: d.run_key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', fault: 'infra', coverage: 'unassessed_infra', failures: [], now: now + 1 });
  };
  let t = T0 + HOUR;
  for (let i = 1; i <= 2; i++) {
    assert.equal(due(db, t, hook()).length, 1, `re-check ${i} is due`);
    unassessed(10 + i, t);
    t += HOUR;
  }
  assert.equal(due(db, t, hook()).length, 1, 'the third re-check is due');
  unassessed(13, t);
  const row = db.listLeads()[0];
  assert.deepEqual([row.recheck_attempts, row.recheck_subject, row.reproduced_at], [3, null, null]);
  assert.deepEqual(due(db, t + HOUR, hook()), [], 'after the attempts it stops');

  // A newer result that was not folded (the pipeline was off when it came in): the re-check counts as done.
  const db2 = openState(':memory:');
  db2.setSubjectVersion({ id: 'acme/a', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
  accept(db2, 'acme/a', [lead(51)], { runId: 1, now: T0 });
  const [d] = dueFromState(db2, { now: T0 + HOUR, tiers, workflows, hooks: { leadReverify: leadRecheckHook(recheckPairs(db2)) } });
  const lease = db2.acquireLease(d.run_key, 'att-off', { ttlMs: DAY, now: T0 + HOUR });
  db2.createDispatch({ attemptId: 'att-off', shardId: 's', workflow: 'scan-static', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: T0 + DAY, items: [{ run_key: d.run_key, subject: 'acme/a', fence: lease.fence }], now: T0 + HOUR });
  db2.recordResult({ run_key: d.run_key, attempt_id: 'att-off', fence: lease.fence, verdict: 'accepted', outcome: 'accepted', now: T0 + HOUR + 1 });
  assert.deepEqual(dueFromState(db2, { now: T0 + 2 * HOUR, tiers, workflows, hooks: { leadReverify: leadRecheckHook(recheckPairs(db2)) } }), []);
});

test('R-LEAD-22: re-check dispatches that never come back (lapsed, refused, rejected) count as attempts: after three the pair is no longer sent', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/a', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
  accept(db, 'acme/a', [lead(70)], { runId: 1, now: T0 });
  const hook = () => ({ leadReverify: leadRecheckHook(recheckPairs(db)) });
  let t = T0 + HOUR;
  for (let i = 1; i <= 3; i++) {
    const [d] = due(db, t, hook());
    assert.ok(d, `re-check ${i} is due`);
    // Sent, and its worker never answers: the lease lapses and the dispatch is reaped.
    const att = `att-lost-${i}`;
    const lease = db.acquireLease(d.run_key, att, { ttlMs: HOUR, now: t });
    db.createDispatch({ attemptId: att, shardId: 's', workflow: 'scan-static', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: t + HOUR, items: [{ run_key: d.run_key, subject: 'acme/a', fence: lease.fence }], now: t });
    db.failDispatch(att, { error: 'lost', now: t + 1 });
    t += 2 * HOUR;
  }
  assert.deepEqual(due(db, t, hook()), [], 'not sent a fourth time');
  const rc = recheckPairs(db);
  assert.deepEqual([rc.pairs.size, rc.waiting, rc.given_up], [0, 0, 1]);
});

test('R-LEAD-39: a re-check that carries the lead but has no worker run id is one attempt and is due again; a pair left waiting by an unfolded result is due again after a day', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/a', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
  const L = lead(80);
  accept(db, 'acme/a', [L], { runId: 1, now: T0 });
  const hook = () => ({ leadReverify: leadRecheckHook(recheckPairs(db)) });
  // The re-check comes back carrying it, from a run the store cannot name.
  const t = T0 + HOUR;
  const [d] = due(db, t, hook());
  const lease = db.acquireLease(d.run_key, 'att-norun', { ttlMs: DAY, now: t });
  db.createDispatch({ attemptId: 'att-norun', shardId: 's', workflow: 'scan-static', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: t + DAY, items: [{ run_key: d.run_key, subject: 'acme/a', fence: lease.fence }], now: t });
  db.recordResult({ run_key: d.run_key, attempt_id: 'att-norun', fence: lease.fence, verdict: 'accepted', outcome: 'accepted', fault: 'tool', coverage: 'unassessed_tool', failures: [L], now: t + 1 });
  const row = db.listLeads()[0];
  assert.deepEqual([row.reproduced_at, row.recheck_attempts, row.recheck_subject], [null, 1, 'acme/a']);
  assert.equal(due(db, t + HOUR, hook()).length, 1, 'due again, not stalled');

  // A newer result that was never folded: waiting, then due again once it is a day old.
  const db2 = openState(':memory:');
  db2.setSubjectVersion({ id: 'acme/a', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 - DAY });
  accept(db2, 'acme/a', [lead(81)], { runId: 1, now: T0 });
  const [d2] = dueFromState(db2, { now: T0 + HOUR, tiers, workflows, hooks: { leadReverify: leadRecheckHook(recheckPairs(db2)) } });
  const l2 = db2.acquireLease(d2.run_key, 'att-off2', { ttlMs: DAY, now: T0 + HOUR });
  db2.createDispatch({ attemptId: 'att-off2', shardId: 's', workflow: 'scan-static', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: T0 + DAY, items: [{ run_key: d2.run_key, subject: 'acme/a', fence: l2.fence }], now: T0 + HOUR });
  db2.recordResult({ run_key: d2.run_key, attempt_id: 'att-off2', fence: l2.fence, verdict: 'accepted', outcome: 'accepted', now: T0 + HOUR + 1 });
  const h2 = () => ({ leadReverify: leadRecheckHook(recheckPairs(db2)) });
  assert.deepEqual(dueFromState(db2, { now: T0 + 3 * HOUR, tiers, workflows, hooks: h2() }), []);
  assert.equal(dueFromState(db2, { now: T0 + HOUR + RECHECK_TIMEOUT_MS + HOUR, tiers, workflows, hooks: h2() }).length, 1);
});
