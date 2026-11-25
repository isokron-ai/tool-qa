import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureRegistryDelta, registryLaneOn, MIN_DISPATCH_GAP_MS } from '../registry-delta.mjs';
import { runPump } from '../run.mjs';
import { createClient } from '../github.mjs';
import { openState } from '../../state/db.mjs';
import { parseYaml } from '../../scripts/lib/yaml-lite.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const REPO = 'isokron-ai/tool-qa';
const NOW = Date.parse('2026-11-25T18:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const MIN = 60_000;

function world({ artifacts = [], runs = [], dispatch = () => ({ status: 200, body: { workflow_run_id: 77 } }) } = {}) {
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/artifacts`, () => ({ body: { total_count: artifacts.length, artifacts } })],
    ['GET', `/repos/${REPO}/actions/workflows/history-registry.yml/runs`, () => ({ body: { workflow_runs: runs } })],
    ['POST', `/repos/${REPO}/actions/workflows/history-registry.yml/dispatches`, dispatch],
  ]);
  const c = fakeClock(NOW);
  const client = createClient({ token: 'ghs_synthetic_registry', fetch: api.fetch, apiUrl: API, sleep: c.sleep, now: c.now, random: () => 0.5 });
  const lines = [];
  const run = (extra = {}) => ensureRegistryDelta({ client, repo: REPO, now: NOW, log: (l) => lines.push(l), ...extra });
  const posts = () => api.calls.filter((r) => r.method === 'POST');
  return { api, c, run, lines, posts };
}
const delta = (min) => ({ name: 'registry-delta-20261125T1700', created_at: ago(min), expired: false });
const runOf = (id, title, status, min) => ({ id, display_title: title, name: 'history-registry', status, created_at: ago(min) });

test('R-HIST-03: a delta capture older than 15 minutes with none queued or running is dispatched in delta mode', async () => {
  const w = world({ artifacts: [delta(40), { name: 'ingest-1-1', created_at: ago(1) }], runs: [runOf(1, 'history-registry delta', 'completed', 40)] });
  const r = await w.run();
  assert.equal(r.action, 'dispatched');
  assert.equal(r.runId, 77);
  assert.deepEqual(w.posts().map((p) => p.json), [{ ref: 'main', inputs: { mode: 'delta' }, return_run_details: true }]);
});

test('R-HIST-03: nothing is dispatched while the newest capture is under 15 minutes old', async () => {
  const w = world({ artifacts: [delta(14)] });
  assert.equal((await w.run()).action, 'fresh');
  assert.equal(w.posts().length, 0);
  assert.equal(w.api.calls.length, 1, 'a fresh capture costs one read');
});

test('R-HIST-03: a delta run that is queued or running holds the dispatch off; a full run does not; a stuck old one does not', async () => {
  for (const status of ['queued', 'in_progress', 'pending']) {
    const w = world({ artifacts: [delta(60)], runs: [runOf(5, 'history-registry delta', status, 3)] });
    assert.equal((await w.run()).action, 'running', status);
    assert.equal(w.posts().length, 0);
  }
  const unknown = world({ artifacts: [delta(60)], runs: [runOf(5, 'history-registry', 'queued', 3)] });
  assert.equal((await unknown.run()).action, 'running', 'a run with no mode in its title counts as a delta');
  const full = world({ artifacts: [delta(60)], runs: [runOf(6, 'history-registry full', 'in_progress', 3)] });
  assert.equal((await full.run()).action, 'dispatched', 'the full capture has its own concurrency group');
  const stuck = world({ artifacts: [delta(300)], runs: [runOf(7, 'history-registry delta', 'queued', 120)] });
  assert.equal((await stuck.run()).action, 'dispatched', 'a run queued for two hours is not a capture in progress');
});

test('R-HIST-03: our own dispatches are at least 10 minutes apart even when the run list lags', async () => {
  const w = world({ artifacts: [delta(60)] });
  assert.equal((await w.run({ lastDispatchAt: NOW - 3 * MIN })).action, 'spaced');
  assert.equal(w.posts().length, 0);
  assert.equal((await w.run({ lastDispatchAt: NOW - MIN_DISPATCH_GAP_MS - 1 })).action, 'dispatched');
});

test('R-HIST-03: after a long stall the dispatch names the start of the gap, so no hole is left; a short stall uses the default window', async () => {
  const long = world({ artifacts: [delta(9 * 60)] });
  const r = await long.run();
  assert.equal(r.since, new Date(NOW - 9 * 60 * MIN - 10 * MIN).toISOString().replace(/\.\d+Z$/, 'Z'));
  assert.equal(long.posts()[0].json.inputs.since, r.since);
  const short = world({ artifacts: [delta(30)] });
  await short.run();
  assert.deepEqual(short.posts()[0].json.inputs, { mode: 'delta' });
  const none = world({ artifacts: [] });
  assert.equal((await none.run()).action, 'dispatched', 'no delta artifact found at all');
  assert.deepEqual(none.posts()[0].json.inputs, { mode: 'delta' });
});

test('R-HIST-03: a failed dispatch or read is reported, never thrown; a server error on the dispatch is retried', async () => {
  const bad = world({ artifacts: [delta(60)], dispatch: () => ({ status: 422, body: { message: 'no workflow_dispatch' } }) });
  const r = await bad.run();
  assert.equal(r.action, 'failed');
  assert.match(r.error, /422/);
  assert.equal(bad.posts().length, 1, 'a 422 is not retried');
  let n = 0;
  const flaky = world({ artifacts: [delta(60)], dispatch: () => (++n < 3 ? { status: 500, body: { message: 'x' } } : { status: 204 }) });
  assert.equal((await flaky.run()).action, 'dispatched');
  assert.equal(flaky.posts().length, 3);
  const down = world();
  down.api.fetch = async () => { throw new Error('socket hang up'); };
  const c2 = fakeClock(NOW);
  const client = createClient({ token: 'ghs_x', fetch: down.api.fetch, apiUrl: API, sleep: c2.sleep, now: c2.now, random: () => 0 });
  assert.equal((await ensureRegistryDelta({ client, repo: REPO, now: NOW })).action, 'failed');
});

test('R-HIST-03: the lane switch LANE_HISTORY_REGISTRY_ENABLED turns the pump dispatch off, like the workflow itself', () => {
  assert.equal(registryLaneOn({}), true);
  assert.equal(registryLaneOn({ LANE_HISTORY_REGISTRY_ENABLED: '' }), true);
  assert.equal(registryLaneOn({ LANE_HISTORY_REGISTRY_ENABLED: 'true' }), true);
  assert.equal(registryLaneOn({ LANE_HISTORY_REGISTRY_ENABLED: 'false' }), false);
});

// The pump run itself.
function pumpWorld(envExtra = {}, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pump-reg-'));
  const stateFile = join(dir, 'state.sqlite');
  const c = fakeClock(NOW);
  const lines = [];
  const registry = [];
  const run = () => runPump({
    env: { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'ghs_synthetic_state', LOOP_SLOTS: '0', ...envExtra },
    now: c.now, sleep: c.sleep, log: (l) => lines.push(l), stateFile, seedFile: null, config: { tiers: {}, workflows: {} },
    pull: async () => ({ status: 'pulled' }), push: async () => ({ status: 'pushed' }), ingest: null,
    readConformance: async () => ({ status: null }), registryDelta: async (a) => { registry.push(a); return { action: 'dispatched', at: new Date(a.now).toISOString() }; },
    ...opts,
  });
  return { dir, stateFile, c, lines, registry, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('R-HIST-04: each pump run checks the registry delta capture, records the answer, and passes the time of its last dispatch to the next run', async () => {
  const w = pumpWorld();
  await w.run();
  assert.equal(w.registry.length, 1);
  assert.equal(w.registry[0].lastDispatchAt, null);
  const db = openState(w.stateFile);
  const kv = db.getKv('pump.registry_delta');
  db.close();
  assert.equal(kv.action, 'dispatched');
  assert.equal(kv.dispatchedAt, new Date(NOW).toISOString());
  await w.run(); // the next run, on the same state
  assert.equal(w.registry[1].lastDispatchAt, NOW);
  w.cleanup();
});

test('R-HIST-04: a failing or throwing registry check never stops the pump, and a switched-off lane is not checked', async () => {
  const boom = pumpWorld({}, { registryDelta: async () => { throw new Error('registry check exploded'); } });
  const out = await boom.run();
  assert.equal(out.ok, true);
  assert.ok(boom.lines.some((l) => /registry delta check failed \(continuing\)/.test(l)));
  boom.cleanup();
  const off = pumpWorld({ LANE_HISTORY_REGISTRY_ENABLED: 'false' });
  await off.run();
  assert.equal(off.registry.length, 0);
  off.cleanup();
  const none = pumpWorld({}, { registryDelta: null });
  assert.equal((await none.run()).ok, true);
  none.cleanup();
});

test('R-HIST-04: the real check mints an actions-only token, dispatches the stale capture, and survives a dispatch that fails', async () => {
  const mints = [];
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/artifacts`, () => ({ body: { artifacts: [] } })],
    ['GET', `/repos/${REPO}/actions/workflows/history-registry.yml/runs`, () => ({ body: { workflow_runs: [] } })],
    ['POST', `/repos/${REPO}/actions/workflows/history-registry.yml/dispatches`, () => ({ status: 403, body: { message: 'Resource not accessible by integration' } })],
  ]);
  const w = pumpWorld({ GITHUB_API_URL: API }, {
    registryDelta: undefined,
    fetch: api.fetch,
    mintToken: async (a) => { mints.push(a); return { token: 'ghs_synthetic_actions', expiresAt: NOW + 3_600_000 }; },
  });
  const out = await w.run();
  assert.equal(out.ok, true, 'a refused dispatch does not fail the run');
  assert.deepEqual(mints[0], { repositories: ['tool-qa'], permissions: { actions: 'write' } });
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
  const db = openState(w.stateFile);
  assert.equal(db.getKv('pump.registry_delta').action, 'failed');
  db.close();
  w.cleanup();
});

test('R-HIST-05: history-registry.yml keeps its */15 cron as a fallback, takes mode and since as dispatch inputs, and names its runs with the mode', () => {
  const text = readFileSync(new URL('../../.github/workflows/history-registry.yml', import.meta.url), 'utf8');
  const wf = parseYaml(text);
  assert.ok(wf.on.schedule.some((s) => s.cron === '*/15 * * * *'), 'the cron stays');
  assert.deepEqual(wf.on.workflow_dispatch.inputs.mode.options, ['delta', 'full']);
  assert.equal(wf.on.workflow_dispatch.inputs.mode.default, 'delta');
  assert.ok(wf.on.workflow_dispatch.inputs.since);
  assert.match(wf['run-name'], /^history-registry \$\{\{ .*schedule.*full.*delta.*inputs\.mode \}\}$/);
  assert.ok([false, 'false'].includes(wf.concurrency['cancel-in-progress']));
  assert.match(wf.concurrency.group, /inputs\.mode/, 'one run per mode: a repeated dispatch queues, never doubles');
  const pump = readFileSync(new URL('../../.github/workflows/pump.yml', import.meta.url), 'utf8');
  assert.match(pump, /LANE_HISTORY_REGISTRY_ENABLED: \$\{\{ vars\.LANE_HISTORY_REGISTRY_ENABLED \}\}/, 'the pump step passes the lane switch');
});

function pagedWorld(artifacts) {
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/artifacts`, (req) => {
      const page = Number(req.query.get('page') ?? 1);
      return { body: { artifacts: artifacts.slice((page - 1) * 100, page * 100) } };
    }],
    ['GET', `/repos/${REPO}/actions/workflows/history-registry.yml/runs`, () => ({ body: { workflow_runs: [] } })],
    ['POST', `/repos/${REPO}/actions/workflows/history-registry.yml/dispatches`, () => ({ status: 204 })],
  ]);
  const c = fakeClock(NOW);
  const client = createClient({ token: 'ghs_synthetic_registry', fetch: api.fetch, apiUrl: API, sleep: c.sleep, now: c.now, random: () => 0.5 });
  return { api, client };
}
const filler = (n) => Array.from({ length: n }, (_, i) => ({ name: `ingest-${i}-1`, created_at: ago(1 + i / 10), expired: false }));

test('R-HIST-06: with more than 100 newer artifacts of other kinds the stall is still found by paging, and the gap is named in `since`', async () => {
  const w = pagedWorld([...filler(250), delta(5 * 60)]);
  const r = await ensureRegistryDelta({ client: w.client, repo: REPO, now: NOW });
  assert.equal(r.action, 'dispatched');
  assert.equal(r.since, new Date(NOW - 5 * 60 * MIN - 10 * MIN).toISOString().replace(/\.\d+Z$/, 'Z'), 'the delta artifact on page 3 was found');
  assert.equal(w.api.calls.filter((c) => c.path.endsWith('/artifacts')).length, 3);
});

test('R-HIST-06: past the pages read, the capture time kept from earlier runs still sets `since`; with nothing known there is none', async () => {
  const w = pagedWorld(filler(700));
  const known = NOW - 9 * 60 * MIN;
  const r = await ensureRegistryDelta({ client: w.client, repo: REPO, now: NOW, lastCaptureAt: known });
  assert.equal(r.action, 'dispatched');
  assert.equal(r.since, new Date(known - 10 * MIN).toISOString().replace(/\.\d+Z$/, 'Z'));
  assert.equal(r.captureAt, new Date(known).toISOString().replace(/\.\d+Z$/, 'Z'));
  assert.equal(w.api.calls.filter((c) => c.path.endsWith('/artifacts')).length, 5, 'at most 5 pages');
  const none = pagedWorld(filler(700));
  assert.equal((await ensureRegistryDelta({ client: none.client, repo: REPO, now: NOW })).since, undefined);
});

test('R-HIST-07: a registry outage cannot hold the tick past its 60 second window, and the rest of the run goes on', async () => {
  const api = fakeApi([['*', /.*/, () => ({ status: 503, headers: { 'retry-after': '30' }, body: { message: 'Unavailable' } })]]);
  const w = pumpWorld({ GITHUB_API_URL: API }, {
    registryDelta: undefined, fetch: api.fetch,
    mintToken: async () => ({ token: 'ghs_synthetic_actions', expiresAt: NOW + 3_600_000 }),
  });
  const out = await w.run();
  assert.equal(out.ok, true);
  assert.equal(out.ticks, 1, 'the tick ran');
  assert.ok(w.c.t - NOW <= 60_000 + 1000, `the check used ${(w.c.t - NOW) / 1000} s`);
  const db = openState(w.stateFile);
  assert.equal(db.getKv('pump.registry_delta').action, 'failed');
  assert.ok(db.getKv('pump.last_tick'), 'the tick finished and recorded itself');
  db.close();
  w.cleanup();
});
