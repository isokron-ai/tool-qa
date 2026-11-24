import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openState } from '../../state/db.mjs';
import { runTick } from '../tick.mjs';
import { createDispatcher } from '../dispatch.mjs';
import { BudgetExceededError } from '../budgets.mjs';
import { GitHubError } from '../github.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));
const MIN = 60_000;

const wf = (over = {}) => ({
  enabled: true, repo: 'isokron-ai/mcp-check', file: 'live-probe.yml', ref: 'main',
  shard_size: 2, setup_minutes: 4, minutes_per_subject: 2, slots_max: 12,
  versions: { tool: { 'mcp-check': '1.0.0' }, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default', ...over,
});

function setup({ subjects = 5, workflows = { 'live-probe': wf() } } = {}) {
  const c = fakeClock();
  const db = openState(':memory:');
  for (let i = 0; i < subjects; i++) {
    db.setSubjectVersion({ id: `npm:pkg-${i}`, kind: 'package', source: 'npm', tier: 1, sha: String(i).repeat(40).slice(0, 40), now: c.t });
  }
  let n = 0;
  const newId = () => `att-${String(++n).padStart(3, '0')}`;
  return { c, db, config: { tiers, workflows }, newId };
}

/** A dispatcher double that records calls and returns run ids. */
function recorder(behaviour = () => ({})) {
  const calls = [];
  return {
    calls,
    async dispatch(req) {
      calls.push(req);
      const out = await behaviour(req, calls.length);
      return { runId: 1000 + calls.length, runUrl: `https://github.test/run/${1000 + calls.length}`, workflowSha: 'b'.repeat(40), correlatedBy: 'response', ...out };
    },
    // The commit the ref points to now: recorded with the dispatch (R-ING-12).
    async resolveRef() {
      return 'f'.repeat(40);
    },
  };
}

test('with no worker slots a tick only does housekeeping', async () => {
  const { c, db, config, newId } = setup();
  const d = recorder();
  const s = await runTick({ db, now: c.now, config, workerSlots: 0, dispatcher: d, newId });
  assert.equal(d.calls.length, 0);
  assert.equal(s.dispatched, 0);
  assert.equal(s.due, null, 'the due list is not even computed');
  db.close();
});

test('due work is cut into shards, leased, recorded, then dispatched', async () => {
  const { c, db, config, newId } = setup({ subjects: 5 });
  const d = recorder();
  const s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId });
  assert.equal(s.due, 5);
  assert.equal(s.dispatched, 2, 'two slots, so two shards of two');
  assert.equal(d.calls.length, 2);
  const first = d.calls[0];
  assert.equal(first.repo, 'isokron-ai/mcp-check');
  assert.equal(first.workflowFile, 'live-probe.yml');
  assert.equal(first.ref, 'main');
  assert.equal(first.inputs.attempt_id, 'att-001');
  assert.equal(first.inputs.shard_id, first.shardId);
  const items = JSON.parse(first.inputs.items);
  assert.equal(items.length, 2);
  const row = db.getDispatch('att-001');
  assert.equal(row.status, 'dispatched');
  assert.equal(row.run_id, '1001');
  assert.equal(row.workflow_sha, 'f'.repeat(40));
  assert.deepEqual(row.items.map((i) => [i.run_key, i.fence]).sort(), items.map((i) => [i.run_key, i.fence]).sort());
  for (const it of items) {
    const lease = db.getLease(it.run_key);
    assert.equal(lease.holder, 'att-001');
    assert.equal(lease.fence, it.fence);
    assert.ok(db.getRunKey(it.run_key), 'run_key fields are recorded');
  }
  const ttl = (1.5 * (4 + 2 * 2) + 10) * MIN;
  assert.equal(row.expires, new Date(c.t + ttl).toISOString());
  assert.equal(db.openSlots().length, 2);
  db.close();
});

test('a second tick does not send in-flight work again, and fills a freed slot', async () => {
  const { c, db, config, newId } = setup({ subjects: 5 });
  const d = recorder();
  await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId });
  c.t += 2 * MIN;
  let s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId });
  assert.equal(s.dispatched, 0, 'both slots busy');
  assert.equal(s.due, 1, 'only the fifth subject is due');
  // Results for the first shard arrive.
  for (const it of db.getDispatch('att-001').items) {
    db.recordResult({ run_key: it.run_key, attempt_id: 'att-001', fence: it.fence, verdict: 'accepted', outcome: 'pass', now: c.t });
  }
  s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId });
  assert.equal(s.dispatched, 1);
  assert.equal(JSON.parse(d.calls.at(-1).inputs.items).length, 1);
  db.close();
});

test('slots_max per workflow is respected, counting open dispatches', async () => {
  const { c, db, config, newId } = setup({
    subjects: 8,
    workflows: { 'live-probe': wf({ slots_max: 1 }), 'scan-static': wf({ file: 'scan-static.yml', slots_max: 2 }) },
  });
  const d = recorder();
  const s = await runTick({ db, now: c.now, config, workerSlots: 10, dispatcher: d, newId });
  const byWf = {};
  for (const call of d.calls) byWf[call.workflowFile] = (byWf[call.workflowFile] ?? 0) + 1;
  assert.deepEqual(byWf, { 'live-probe.yml': 1, 'scan-static.yml': 2 });
  assert.equal(s.dispatched, 3);
  c.t += MIN;
  const again = await runTick({ db, now: c.now, config, workerSlots: 10, dispatcher: d, newId });
  assert.equal(again.dispatched, 0);
  db.close();
});

test('a refused dispatch frees its leases and slot and skips that workflow for the tick', async () => {
  const { c, db, config, newId } = setup({
    subjects: 4,
    workflows: { 'live-probe': wf(), 'scan-static': wf({ file: 'scan-static.yml' }) },
  });
  const d = recorder((req) => {
    if (req.workflowFile === 'live-probe.yml') throw new GitHubError('POST dispatches returned 422: Unexpected inputs', { status: 422 });
    return {};
  });
  const s = await runTick({ db, now: c.now, config, workerSlots: 10, dispatcher: d, newId });
  assert.equal(d.calls.filter((r) => r.workflowFile === 'live-probe.yml').length, 1, 'tried once, then skipped');
  assert.equal(s.failed, 1);
  assert.equal(s.dispatched, 2);
  assert.equal(s.withdrawn, 1, 'the second live-probe shard was reserved but not sent');
  const failed = db.raw.prepare("SELECT * FROM dispatches WHERE status = 'failed' ORDER BY attempt_id").all();
  assert.equal(failed.length, 2);
  assert.match(failed[0].error, /422/);
  assert.match(failed[1].error, /^not sent: an earlier live-probe dispatch failed this tick$/);
  for (const f of failed) for (const it of db.getDispatch(f.attempt_id).items) assert.equal(db.getLease(it.run_key).holder, null);
  assert.equal(db.openSlots().length, 2);
  db.close();
});

test('a spent API budget ends the tick early', async () => {
  const { c, db, config, newId } = setup({ subjects: 6 });
  const d = recorder((req, n) => {
    if (n === 2) throw new BudgetExceededError('dispatch: hourly budget used', { family: 'dispatch', reason: 'hourly' });
    return {};
  });
  const s = await runTick({ db, now: c.now, config, workerSlots: 5, dispatcher: d, newId });
  assert.equal(d.calls.length, 2);
  assert.equal(s.dispatched, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.stopped, 'budget');
  db.close();
});

test('no new shard is started once the run deadline has passed', async () => {
  const { c, db, config, newId } = setup({ subjects: 6 });
  const d = recorder(() => {
    c.t += 90_000; // a slow dispatch
    return {};
  });
  const s = await runTick({ db, now: c.now, config, workerSlots: 5, dispatcher: d, newId, deadline: c.t + 60_000 });
  assert.equal(d.calls.length, 1);
  assert.equal(s.stopped, 'deadline');
  assert.equal(db.openSlots().length, 1, 'no slot is taken for the shards that were not sent');
  db.close();
});

test('an expired dispatch is reaped and its work is due again', async () => {
  const { c, db, config, newId } = setup({ subjects: 2 });
  const d = recorder();
  await runTick({ db, now: c.now, config, workerSlots: 1, dispatcher: d, newId });
  assert.equal(d.calls.length, 1);
  c.t += 60 * MIN; // past 1.5 x (4 + 2 x 2) + 10 = 22 minutes
  const s = await runTick({ db, now: c.now, config, workerSlots: 1, dispatcher: d, newId });
  assert.equal(s.reaped, 1);
  assert.equal(s.dispatched, 1);
  assert.equal(db.getDispatch('att-001').status, 'expired');
  db.close();
});

test('end to end with the real dispatcher against a fake API', async () => {
  const { c, db, config, newId } = setup({ subjects: 3 });
  let run = 700;
  const api = fakeApi([
    ['POST', '/repos/isokron-ai/mcp-check/actions/workflows/live-probe.yml/dispatches', () => ({ status: 200, body: { workflow_run_id: ++run, html_url: `https://github.test/r/${run}` } })],
    ['GET', '/repos/isokron-ai/mcp-check/branches/main', () => ({ body: { name: 'main', commit: { sha: 'e'.repeat(40) } } })],
  ]);
  const mints = [];
  const dispatcher = createDispatcher({
    mintToken: async (args) => {
      mints.push(args);
      return { token: 'ghs_synthetic', expiresAt: c.t + 3_600_000 };
    },
    fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep,
  });
  const s = await runTick({ db, now: c.now, config, workerSlots: 4, dispatcher, newId });
  assert.equal(s.dispatched, 2);
  assert.equal(mints.length, 1);
  const posts = api.calls.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(Object.keys(posts[0].json.inputs).sort(), ['attempt_id', 'items', 'shard_id']);
  assert.equal(posts[0].json.return_run_details, true);
  assert.equal(db.getDispatch('att-001').run_id, '701');
  assert.equal(db.getDispatch('att-002').workflow_sha, 'e'.repeat(40));
  assert.equal(api.calls.filter((r) => r.path.endsWith('/branches/main')).length, 1, 'the ref is resolved once per tick');
  db.close();
});

test('R-ING-12: the dispatch records the commit its ref points to before sending, not what the run reports', async () => {
  const { c, db, config, newId } = setup({ subjects: 2 });
  const d = recorder(() => ({ workflowSha: '9'.repeat(40) })); // whatever the dispatcher says about the run
  let pushedSha;
  await runTick({
    db, now: c.now, config, workerSlots: 1, dispatcher: d, newId,
    beforeSend: () => {
      pushedSha = db.getDispatch('att-001').workflow_sha;
      return true;
    },
  });
  assert.equal(pushedSha, 'f'.repeat(40), 'already in the state saved before sending');
  assert.equal(db.getDispatch('att-001').workflow_sha, 'f'.repeat(40));
  db.close();
});

test('R-ING-12: a ref that cannot be resolved is not dispatched this tick', async () => {
  const { c, db, config, newId } = setup({ subjects: 2 });
  const d = recorder();
  d.resolveRef = async () => {
    throw new Error('branch not found');
  };
  const lines = [];
  const s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId, log: (l) => lines.push(l) });
  assert.equal(d.calls.length, 0);
  assert.deepEqual(s.skippedWorkflows, ['live-probe']);
  assert.deepEqual(db.openSlots(), [], 'no slot is held');
  assert.ok(lines.some((l) => /cannot resolve isokron-ai\/mcp-check main/.test(l)));
  db.close();
});

test('R-ING-22: a paused workflow gets no dispatch, and the tick says it is paused', async () => {
  const { c, db, config, newId } = setup({ subjects: 4 });
  db.setKv('pump.paused:live-probe', { reason: 'run_sha_mismatch', count: 3, since: new Date(c.t).toISOString(), until: new Date(c.t + 60 * MIN).toISOString() }, { now: c.t });
  const d = recorder();
  const s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId });
  assert.equal(d.calls.length, 0);
  assert.deepEqual(s.paused, ['live-probe']);
  const idle = await runTick({ db, now: c.now, config, workerSlots: 0, dispatcher: null, newId });
  assert.deepEqual(idle.paused, ['live-probe'], 'housekeeping ticks say so too');
  c.t += 61 * MIN;
  const later = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId });
  assert.deepEqual(later.paused, []);
  assert.ok(d.calls.length > 0);
  db.close();
});
