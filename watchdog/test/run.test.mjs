import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchdog } from '../run.mjs';
import { parseBody } from '../health.mjs';
import { openState } from '../../state/db.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';
import { greenStatus } from '../../test/lib/conformance.mjs';

const REPO = 'isokron-ai/tool-qa';
const MIN = 60_000;

function world({ pumpAgeMin = 5, workflows = [], seed } = {}) {
  const c = fakeClock(Date.parse('2026-03-02T12:00:00Z'));
  const ago = (m) => new Date(c.t - m * MIN).toISOString();
  const issues = [];
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/workflows`, () => ({ body: { total_count: workflows.length, workflows } })],
    ['GET', /\/actions\/workflows\/[^/]+\/runs$/, (req) => {
      if (req.path.includes('/pump.yml/')) {
        return { body: { workflow_runs: [{ id: 1, event: 'schedule', status: 'completed', conclusion: 'success', created_at: ago(pumpAgeMin), run_started_at: ago(pumpAgeMin), html_url: 'u' }] } };
      }
      return { body: { workflow_runs: [] } };
    }],
    ['GET', `/repos/${REPO}/actions/artifacts`, () => ({
      body: {
        artifacts: [
          { name: 'registry-delta-x', created_at: ago(10), expired: false },
          { name: 'registry-full-x', created_at: ago(300), expired: false },
          { name: 'history-packages-1', created_at: ago(300), expired: false },
          { name: 'history-popularity-1', created_at: ago(300), expired: false },
        ],
      },
    })],
    ['POST', `/repos/${REPO}/actions/workflows/pump.yml/dispatches`, () => ({ status: 204 })],
    ['PUT', /\/actions\/workflows\/\d+\/enable$/, () => ({ status: 204 })],
    ['GET', `/repos/${REPO}/issues`, () => ({ body: issues })],
    ['POST', `/repos/${REPO}/issues`, (req) => {
      const issue = { number: 1, node_id: 'I_1', title: req.json.title, body: req.json.body, labels: [{ name: 'loop-health' }], state: 'open' };
      issues.push(issue);
      return { status: 201, body: issue };
    }],
    ['PATCH', /\/issues\/1$/, (req) => {
      Object.assign(issues[0], req.json);
      return { body: issues[0] };
    }],
    ['POST', /\/issues\/1\/comments$/, () => ({ status: 201, body: {} })],
    ['POST', '/graphql', () => ({ body: { data: { pinIssue: { issue: { number: 1 } } } } })],
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
  const mints = [];
  const opts = {
    env: { GITHUB_REPOSITORY: REPO, LOOP_SLOTS: '4', GITHUB_REF_NAME: 'main', GITHUB_TOKEN: 'ghs_synthetic_job_token' },
    now: c.now,
    sleep: c.sleep,
    fetch: api.fetch,
    apiUrl: API,
    log: () => {},
    stateDir: dir,
    readConformance: async () => ({ status: greenStatus(c.t - 3_600_000) }),
    mintToken: async (args) => {
      mints.push(args);
      return { token: 'ghs_synthetic_app_token', expiresAt: c.t + 3_600_000 };
    },
    pull: async ({ file }) => {
      if (!seed) return { status: 'absent' };
      const db = openState(file);
      seed(db, c);
      db.close();
      return { status: 'pulled' };
    },
  };
  return { c, api, issues, mints, opts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a healthy loop: one narrowed token, nothing dispatched, a green issue', async () => {
  const w = world({ seed: () => {} });
  const out = await runWatchdog(w.opts);
  assert.deepEqual(w.mints, [{ repositories: ['tool-qa'], permissions: { issues: 'write', actions: 'write' } }]);
  assert.equal(out.overall, 'green');
  assert.equal(w.api.calls.filter((r) => r.path.endsWith('/dispatches')).length, 0);
  assert.equal(parseBody(w.issues[0].body).overall, 'green');
  w.cleanup();
});

test('a stale pump is dispatched and an inactive workflow re-enabled', async () => {
  const w = world({
    pumpAgeMin: 30,
    seed: () => {},
    workflows: [{ id: 77, path: '.github/workflows/history-packages.yml', state: 'disabled_inactivity' }],
  });
  const out = await runWatchdog(w.opts);
  const dispatch = w.api.calls.find((r) => r.path.endsWith('/pump.yml/dispatches'));
  assert.deepEqual(dispatch.json, { ref: 'main' });
  assert.ok(w.api.calls.some((r) => r.method === 'PUT' && r.path.endsWith('/workflows/77/enable')));
  assert.equal(out.overall, 'amber');
  const state = parseBody(w.issues[0].body);
  assert.equal(state.checks.find((c) => c.id === 'pump').status, 'amber');
  w.cleanup();
});

test('stuck slots and a failed successor from the state asset are red', async () => {
  const w = world({
    seed: (db, c) => {
      db.acquireSlot('lost', { budget: 4, ttlMs: 10 * MIN, now: c.t - 60 * MIN });
      db.setKv('pump.successor', { ok: false, error: 'HTTP 502', at: new Date(c.t - 5 * MIN).toISOString() }, { now: c.t });
    },
  });
  const out = await runWatchdog(w.opts);
  assert.equal(out.overall, 'red');
  const ids = out.checks.filter((c) => c.status === 'red').map((c) => c.id).sort();
  assert.deepEqual(ids, ['pump-successor', 'slots']);
  w.cleanup();
});

test('no state asset yet is amber, not an error', async () => {
  const w = world();
  const out = await runWatchdog(w.opts);
  assert.equal(out.checks.find((c) => c.id === 'state').status, 'amber');
  w.cleanup();
});

test('a state asset that cannot be read is amber and the issue is still written', async () => {
  const w = world();
  w.opts.pull = async () => {
    throw new Error('asset state.sqlite checksum mismatch');
  };
  const out = await runWatchdog(w.opts);
  const c = out.checks.find((x) => x.id === 'state');
  assert.equal(c.status, 'amber');
  assert.match(c.summary, /could not read the state asset: .*checksum mismatch/);
  assert.equal(w.issues.length, 1);
  w.cleanup();
});

test('a pump lane switched off is reported as off and not dispatched', async () => {
  const w = world({ pumpAgeMin: 50, seed: () => {} });
  w.opts.env.LANE_PUMP_ENABLED = 'false';
  const out = await runWatchdog(w.opts);
  assert.equal(out.checks.find((c) => c.id === 'pump').status, 'off');
  assert.equal(w.api.calls.filter((r) => r.path.endsWith('/dispatches')).length, 0);
  w.cleanup();
});

test('a workflow that cannot be re-enabled is red', async () => {
  const w = world({
    seed: () => {},
    workflows: [{ id: 78, path: '.github/workflows/history-registry.yml', state: 'disabled_inactivity' }],
  });
  const orig = w.api.fetch;
  w.opts.fetch = async (url, init) => {
    if (String(url).endsWith('/workflows/78/enable')) return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
    return orig(url, init);
  };
  const out = await runWatchdog(w.opts);
  const c = out.checks.find((x) => x.id === 'workflow:history-registry.yml');
  assert.equal(c.status, 'red');
  assert.match(c.summary, /403/);
  assert.equal(out.overall, 'red');
  w.cleanup();
});

test('a failed pump dispatch is reported in the issue instead of failing the run', async () => {
  const w = world({ pumpAgeMin: 50, seed: () => {} });
  const routes = w.api;
  const orig = routes.fetch;
  w.opts.fetch = async (url, init) => {
    if (String(url).endsWith('/pump.yml/dispatches')) return new Response(JSON.stringify({ message: 'Workflow does not have workflow_dispatch trigger' }), { status: 422 });
    return orig(url, init);
  };
  const out = await runWatchdog(w.opts);
  const c = out.checks.find((x) => x.id === 'pump-dispatch');
  assert.equal(c.status, 'red');
  assert.match(c.summary, /422/);
  w.cleanup();
});

test('R-WD-01: the sandbox breaker is on the health issue: red while it holds an enabled lane, amber with none enabled, green when it passed', async () => {
  const lanes = (enabled) => ({
    'live-probe': { enabled, runs_untrusted: true },
    writecheck: { enabled: false, runs_untrusted: true },
    'scan-static': { enabled: true, runs_untrusted: false },
  });
  // Green.
  let w = world({ seed: () => {} });
  w.opts.workerWorkflows = lanes(true);
  let out = await runWatchdog(w.opts);
  let b = out.checks.find((c) => c.id === 'sandbox-breaker');
  assert.equal(b.status, 'green');
  assert.match(b.summary, /^closed: sandbox conformance passed 60 minutes ago on ubuntu24\/20261117\.1, gVisor 20261116\.0$/);
  assert.equal(b.link, 'https://github.com/isokron-ai/mcp-surface-corpus/actions/runs/1');
  w.cleanup();
  // Red: stale, with live-probe enabled.
  w = world({ seed: () => {} });
  w.opts.workerWorkflows = lanes(true);
  w.opts.readConformance = async () => ({ status: greenStatus(w.c.t - 40 * 3_600_000) });
  out = await runWatchdog(w.opts);
  b = out.checks.find((c) => c.id === 'sandbox-breaker');
  assert.equal(b.status, 'red');
  assert.match(b.summary, /^open \(stale\): the pump holds live-probe: the last sandbox conformance pass is from 40\.0 hours ago/);
  assert.equal(out.overall, 'red');
  assert.equal(parseBody(w.issues[0].body).checks.find((c) => c.id === 'sandbox-breaker').status, 'red');
  w.cleanup();
  // Amber: unreadable, nothing untrusted enabled.
  w = world({ seed: () => {} });
  w.opts.workerWorkflows = lanes(false);
  w.opts.readConformance = async () => { throw new Error('socket hang up'); };
  out = await runWatchdog(w.opts);
  b = out.checks.find((c) => c.id === 'sandbox-breaker');
  assert.equal(b.status, 'amber');
  assert.match(b.summary, /^open \(unreadable\): would hold live-probe, writecheck \(none enabled\): the conformance status cannot be read: socket hang up/);
  w.cleanup();
});

test('R-WD-01: the watchdog fetches the conformance status itself, with no token', async () => {
  const w = world({ seed: () => {} });
  delete w.opts.readConformance;
  w.opts.workerWorkflows = { 'live-probe': { enabled: true, runs_untrusted: true } };
  const seen = [];
  const inner = w.opts.fetch;
  w.opts.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'github.com') {
      seen.push({ url: url.href, auth: new Headers(init.headers ?? {}).get('authorization') });
      return new Response(JSON.stringify(greenStatus(w.c.t - 2 * 3_600_000)), { status: 200 });
    }
    return inner(input, init);
  };
  const out = await runWatchdog(w.opts);
  assert.deepEqual(seen, [{ url: 'https://github.com/isokron-ai/mcp-surface-corpus/releases/download/conformance/conformance-status.json', auth: null }]);
  assert.equal(out.checks.find((c) => c.id === 'sandbox-breaker').status, 'green');
  w.cleanup();
});
