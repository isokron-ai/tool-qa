import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDispatcher, dispatchWorkflow, workerInputs } from '../dispatch.mjs';
import { createClient, GitHubError } from '../github.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const REPO = 'isokron-ai/scan-static';
const DISPATCH = '/repos/isokron-ai/scan-static/actions/workflows/scan.yml/dispatches';
const RUNS = '/repos/isokron-ai/scan-static/actions/workflows/scan.yml/runs';

function client(api, c) {
  return createClient({ token: 'ghs_synthetic', fetch: api.fetch, apiUrl: API, sleep: c.sleep, now: c.now, random: () => 0 });
}

test('worker inputs follow the dispatch contract', () => {
  const inputs = workerInputs({
    shardId: 's1',
    attemptId: 'a1',
    items: [{ subject: 'npm:x', run_key: 'k1', fence: 4, extra: 'dropped' }],
  });
  assert.deepEqual(inputs, { shard_id: 's1', attempt_id: 'a1', items: '[{"subject":"npm:x","run_key":"k1","fence":4}]' });
  const big = Array.from({ length: 2000 }, (_, i) => ({ subject: `npm:${'x'.repeat(40)}${i}`, run_key: 'k'.repeat(64), fence: i }));
  assert.throws(() => workerInputs({ shardId: 's', attemptId: 'a', items: big }), /too large/);
});

test('a dispatch that returns run details is correlated from the response', async () => {
  const c = fakeClock();
  const api = fakeApi([
    ['POST', DISPATCH, () => ({ status: 200, body: { workflow_run_id: 555, run_url: `${API}/repos/${REPO}/actions/runs/555`, html_url: 'https://github.test/run/555' } })],
  ]);
  const out = await dispatchWorkflow(client(api, c), {
    repo: REPO, workflowFile: 'scan.yml', ref: 'main', shardId: 's1', inputs: { shard_id: 's1' }, now: c.now, sleep: c.sleep,
  });
  assert.deepEqual(out, { runId: 555, runUrl: 'https://github.test/run/555', correlatedBy: 'response' });
  assert.equal(api.calls.length, 1, 'the run is not fetched: its own head_sha proves nothing');
  assert.deepEqual(api.calls[0].json, { ref: 'main', inputs: { shard_id: 's1' }, return_run_details: true });
});

test('a dispatch without run details is correlated by polling for the shard run name', async () => {
  const c = fakeClock();
  let polls = 0;
  const api = fakeApi([
    ['POST', DISPATCH, () => ({ status: 204 })],
    ['GET', RUNS, () => {
      polls += 1;
      const runs = [{ id: 1, display_title: 'shard s0', head_sha: 'b'.repeat(40), html_url: 'u1' }];
      if (polls >= 2) runs.push({ id: 2, display_title: 'shard s1', head_sha: 'c'.repeat(40), html_url: 'u2' });
      return { body: { workflow_runs: runs } };
    }],
  ]);
  const out = await dispatchWorkflow(client(api, c), {
    repo: REPO, workflowFile: 'scan.yml', ref: 'main', shardId: 's1', inputs: {}, now: c.now, sleep: c.sleep, pollIntervalMs: 3000,
  });
  assert.deepEqual(out, { runId: 2, runUrl: 'u2', correlatedBy: 'poll' });
  const q = api.calls[1].query;
  assert.equal(q.get('event'), 'workflow_dispatch');
  assert.match(q.get('created'), /^>=2026-03-02T09:59:00/);
});

test('an uncorrelated dispatch still counts as sent, with no run id', async () => {
  const c = fakeClock();
  const api = fakeApi([
    ['POST', DISPATCH, () => ({ status: 204 })],
    ['GET', RUNS, () => ({ body: { workflow_runs: [] } })],
  ]);
  const out = await dispatchWorkflow(client(api, c), {
    repo: REPO, workflowFile: 'scan.yml', ref: 'main', shardId: 's1', inputs: {}, now: c.now, sleep: c.sleep, pollAttempts: 3, pollIntervalMs: 1000,
  });
  assert.deepEqual(out, { runId: null, runUrl: null, correlatedBy: null });
  assert.equal(api.calls.length, 4);
});

test('a refused dispatch throws', async () => {
  const c = fakeClock();
  const api = fakeApi([['POST', DISPATCH, () => ({ status: 422, body: { message: 'Unexpected inputs provided' } })]]);
  await assert.rejects(
    dispatchWorkflow(client(api, c), { repo: REPO, workflowFile: 'scan.yml', ref: 'main', shardId: 's1', inputs: {}, now: c.now, sleep: c.sleep }),
    (err) => err instanceof GitHubError && err.status === 422,
  );
});

test('the dispatcher mints one narrowed token per repository and reuses it until near expiry', async () => {
  const c = fakeClock();
  const mints = [];
  const api = fakeApi([
    ['POST', /\/actions\/workflows\/scan\.yml\/dispatches$/, () => ({ status: 200, body: { workflow_run_id: 9, html_url: 'h' } })],
    ['GET', /\/actions\/runs\/9$/, () => ({ body: { id: 9, head_sha: 'd'.repeat(40) } })],
  ]);
  const d = createDispatcher({
    mintToken: async ({ repositories, permissions }) => {
      mints.push({ repositories, permissions });
      return { token: `ghs_synthetic_${mints.length}`, expiresAt: c.t + 60 * 60_000 };
    },
    fetch: api.fetch,
    apiUrl: API,
    now: c.now,
    sleep: c.sleep,
  });
  const req = { workflowFile: 'scan.yml', ref: 'main', shardId: 's', inputs: {} };
  await d.dispatch({ ...req, repo: 'isokron-ai/scan-static' });
  await d.dispatch({ ...req, repo: 'isokron-ai/scan-static' });
  await d.dispatch({ ...req, repo: 'isokron-ai/live-probe' });
  assert.deepEqual(mints, [
    { repositories: ['scan-static'], permissions: { actions: 'write' } },
    { repositories: ['live-probe'], permissions: { actions: 'write' } },
  ]);
  c.t += 56 * 60_000;
  await d.dispatch({ ...req, repo: 'isokron-ai/scan-static' });
  assert.equal(mints.length, 3);
  assert.equal(api.calls.filter((r) => r.method === 'POST').at(-1).headers.get('authorization'), 'Bearer ghs_synthetic_3');
});

test('R-ING-19: the branch is read with the actions-only dispatch token; a private worker repo fails closed with what to do', async () => {
  const c = fakeClock();
  const mints = [];
  const api = fakeApi([
    ['GET', '/repos/isokron-ai/mcp-check/branches/main', () => ({ body: { name: 'main', commit: { sha: 'a'.repeat(40) } } })],
    ['GET', '/repos/isokron-ai/private-worker/branches/main', () => ({ status: 404, body: { message: 'Not Found' } })],
  ]);
  const d = createDispatcher({
    mintToken: async (args) => {
      mints.push(args);
      return { token: `ghs_synthetic_${mints.length}`, expiresAt: c.t + 60 * 60_000 };
    },
    fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep,
  });
  assert.equal(await d.resolveRef({ repo: 'isokron-ai/mcp-check', ref: 'main' }), 'a'.repeat(40));
  assert.deepEqual(mints[0].permissions, { actions: 'write' }, 'no contents permission is asked for');
  await assert.rejects(
    d.resolveRef({ repo: 'isokron-ai/private-worker', ref: 'main' }),
    (err) => err.status === 404 && /cannot read branch main \(HTTP 404\).*Contents: read/.test(err.message),
  );
});
