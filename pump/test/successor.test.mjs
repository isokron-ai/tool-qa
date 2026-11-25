import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchSuccessor, main } from '../successor.mjs';
import { parseBody } from '../../watchdog/health.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const REPO = 'isokron-ai/tool-qa';
const ENV = { GITHUB_REPOSITORY: REPO, GITHUB_REF_NAME: 'main' };

function world(dispatchReplies) {
  const c = fakeClock(Date.parse('2026-03-02T12:00:00Z'));
  const issues = [];
  const replies = [...dispatchReplies];
  const api = fakeApi([
    ['POST', `/repos/${REPO}/actions/workflows/pump.yml/dispatches`, () => replies.shift() ?? { status: 500, body: { message: 'no more replies' } }],
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
  const mints = [];
  const opts = {
    env: { ...ENV },
    now: c.now,
    sleep: c.sleep,
    fetch: api.fetch,
    apiUrl: API,
    random: () => 0,
    log: () => {},
    mintToken: async (args) => {
      mints.push(args);
      return { token: `ghs_synthetic_${mints.length}`, expiresAt: c.t + 3_600_000 };
    },
  };
  return { c, api, issues, mints, opts };
}

const dispatches = (api) => api.calls.filter((r) => r.path.endsWith('/pump.yml/dispatches'));

test('dispatches pump.yml on the current branch with an actions-only token', async () => {
  const w = world([{ status: 200, body: { workflow_run_id: 4242, html_url: 'https://github.com/x/runs/4242' } }]);
  const out = await dispatchSuccessor(w.opts);
  assert.deepEqual(w.mints, [{ repositories: ['tool-qa'], permissions: { actions: 'write' } }]);
  assert.deepEqual(dispatches(w.api).map((r) => r.json), [{ ref: 'main', return_run_details: true }]);
  assert.equal(out.ok, true);
  assert.equal(out.runId, 4242);
  assert.equal(out.at, '2026-03-02T12:00:00.000Z');
  assert.equal(w.issues.length, 0, 'success does not touch the health issue');
});

test('a server error is retried: a duplicate pending pump run is harmless', async () => {
  const w = world([{ status: 502, body: { message: 'Bad gateway' } }, { status: 204 }]);
  const out = await dispatchSuccessor(w.opts);
  assert.equal(out.ok, true);
  assert.equal(out.runId, undefined);
  assert.equal(dispatches(w.api).length, 2);
});

test('a refusal is recorded and raised on the health issue, without throwing', async () => {
  const w = world([{ status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger" } }]);
  const out = await dispatchSuccessor(w.opts);
  assert.equal(out.ok, false);
  assert.match(out.error, /422/);
  assert.equal(dispatches(w.api).length, 1, 'a 4xx is not retried');
  assert.deepEqual(w.mints[1], { repositories: ['tool-qa'], permissions: { issues: 'write' } });
  const state = parseBody(w.issues[0].body);
  const item = state.checks.find((c) => c.id === 'pump-successor');
  assert.equal(item.status, 'red');
  assert.equal(item.keep, true);
  assert.equal(item.at, out.at);
});

test('a broken App setup still yields a result and no throw', async () => {
  const w = world([]);
  w.opts.mintToken = async () => {
    throw new Error('GitHub App settings missing: APP_ID');
  };
  const out = await dispatchSuccessor(w.opts);
  assert.equal(out.ok, false);
  assert.match(out.error, /APP_ID/);
  assert.equal(w.api.calls.length, 0);
});

test('the CLI writes the result file and exits 0 even when the dispatch failed', async () => {
  const w = world([{ status: 403, body: { message: 'Resource not accessible by integration' } }]);
  const dir = mkdtempSync(join(tmpdir(), 'successor-'));
  const file = join(dir, 'sub', 'successor.json');
  const lines = [];
  const code = await main(['--out', file], w.opts.env, { ...w.opts, out: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.ok(existsSync(file));
  const result = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(result.ok, false);
  assert.match(result.error, /403/);
  assert.ok(lines.some((l) => l.startsWith('::warning::')));
  rmSync(dir, { recursive: true, force: true });
});

test('the CLI needs --out and the repository', async () => {
  assert.equal(await main([], ENV, {}), 2);
  assert.equal(await main(['--out', 'x.json'], {}, {}), 2);
});

test('R-CHAOS-15: the successor dispatch survives five server errors in a row, within 90 seconds of waiting', async () => {
  const w = world([
    ...Array.from({ length: 5 }, () => ({ status: 500, body: { message: 'Server Error' } })),
    { status: 204 },
  ]);
  w.opts.random = () => 0.999999;
  const lines = [];
  w.opts.log = (l) => lines.push(l);
  const out = await dispatchSuccessor(w.opts);
  assert.equal(out.ok, true);
  assert.equal(dispatches(w.api).length, 6);
  assert.ok(w.c.sleeps.reduce((s, x) => s + x, 0) <= 90_000);
  assert.ok(lines.some((l) => /attempt 5\/6 failed/.test(l)), 'each retry is logged');
  assert.ok(lines.every((l) => !l.includes('ghs_synthetic')), 'no token in the log');
  assert.equal(w.issues.length, 0, 'a dispatch that got through leaves the health issue alone');
});

test('R-CHAOS-15: when GitHub stays down the successor fails closed after six tries inside its window, reports it, and does not throw', async () => {
  const w = world(Array.from({ length: 40 }, () => ({ status: 500, body: { message: 'Server Error' } })));
  w.opts.random = () => 0.999999;
  const t0 = w.c.t;
  const out = await dispatchSuccessor(w.opts);
  assert.equal(out.ok, false);
  assert.match(out.error, /500/);
  assert.equal(dispatches(w.api).length, 6, 'six attempts, no more');
  assert.ok(w.c.t - t0 <= 90_000 + 1000, 'bounded by the 90 s window');
});
