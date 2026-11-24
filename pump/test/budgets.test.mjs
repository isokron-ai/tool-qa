import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiBudget, BudgetExceededError, budgetedFetch, DEFAULT_FAMILIES, familyFor } from '../budgets.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const headers = (h) => new Headers(h);

test('default families cover dispatch, artifacts, contents, issues, graphql and search within 1,500/h', () => {
  for (const f of ['dispatch', 'actions', 'artifacts', 'contents', 'issues', 'graphql', 'search', 'auth']) assert.ok(DEFAULT_FAMILIES[f], f);
  const b = new ApiBudget();
  assert.equal(b.totalPerHour, 1500);
  assert.equal(DEFAULT_FAMILIES.dispatch.minIntervalMs, 1000);
  assert.equal(DEFAULT_FAMILIES.dispatch.jitterMs, 1000);
});

test('dispatch calls are paced 1 to 2 seconds apart', async () => {
  const c = fakeClock();
  let r = 0;
  const randoms = [0, 0.5, 0.999];
  const b = new ApiBudget({ now: c.now, sleep: c.sleep, random: () => randoms[r++ % randoms.length] });
  const at = [];
  for (let i = 0; i < 4; i++) {
    await b.take('dispatch');
    at.push(c.t);
  }
  for (let i = 1; i < at.length; i++) {
    const gap = at[i] - at[i - 1];
    assert.ok(gap >= 1000 && gap <= 2000, `gap ${gap}`);
  }
});

test('per-minute caps wait for the window; per-hour caps refuse', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep, families: { x: { perHour: 5, perMinute: 2 } }, totalPerHour: 100 });
  await b.take('x');
  await b.take('x');
  const before = c.t;
  await b.take('x'); // third in the minute waits
  assert.ok(c.t - before >= 59_000, `waited ${c.t - before}`);
  await b.take('x');
  await b.take('x');
  await assert.rejects(b.take('x'), BudgetExceededError);
});

test('the reserve is kept for essential calls', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep, families: { issues: { perHour: 3, reserve: 1 } }, totalPerHour: 100 });
  await b.take('issues');
  await b.take('issues');
  await assert.rejects(b.take('issues'), /reserve/);
  await b.take('issues', { essential: true });
  await assert.rejects(b.take('issues', { essential: true }), BudgetExceededError);
});

test('the total hourly budget spans families', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep, families: { a: { perHour: 10 }, b: { perHour: 10 } }, totalPerHour: 3 });
  await b.take('a');
  await b.take('b');
  await b.take('a');
  await assert.rejects(b.take('b'), /total/);
});

test('retry-after blocks every family until it passes', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep });
  b.observe('dispatch', { status: 403, headers: headers({ 'retry-after': '30' }) }, 'You have exceeded a secondary rate limit');
  assert.equal(b.snapshot().secondaryHits, 1);
  const before = c.t;
  await b.take('issues', { essential: true });
  assert.ok(c.t - before >= 30_000);
});

test('a long block refuses instead of sleeping past maxWaitMs', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep, maxWaitMs: 60_000 });
  b.observe('actions', { status: 429, headers: headers({ 'retry-after': '600' }) });
  await assert.rejects(b.take('actions'), /blocked/);
});

test('a secondary limit without retry-after blocks for at least a minute', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep });
  b.observe('dispatch', { status: 403, headers: headers({}) }, 'secondary rate limit');
  assert.ok(b.snapshot().blockedUntil >= c.t + 60_000);
});

test('primary limit: low remaining stops non-essential work; zero blocks until reset', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep, maxWaitMs: 120_000 });
  b.observe('actions', { status: 200, headers: headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '100', 'x-ratelimit-reset': String(Math.floor(c.t / 1000) + 600), 'x-ratelimit-resource': 'core' }) });
  assert.equal(b.healthy('core'), false);
  await assert.rejects(b.take('dispatch'), /unhealthy/);
  await b.take('issues', { essential: true });
  b.observe('actions', { status: 403, headers: headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(c.t / 1000) + 30), 'x-ratelimit-resource': 'core' }) });
  const before = c.t;
  await b.take('issues', { essential: true });
  assert.ok(c.t - before >= 29_000);
});

test('familyFor maps request paths to endpoint families', () => {
  assert.equal(familyFor('POST', '/repos/o/r/actions/workflows/x.yml/dispatches'), 'dispatch');
  assert.equal(familyFor('GET', '/repos/o/r/actions/artifacts'), 'artifacts');
  assert.equal(familyFor('GET', '/repos/o/r/actions/artifacts/5/zip'), 'artifacts');
  assert.equal(familyFor('GET', '/repos/o/r/actions/runs'), 'actions');
  assert.equal(familyFor('PATCH', '/repos/o/r/issues/3'), 'issues');
  assert.equal(familyFor('POST', '/graphql'), 'graphql');
  assert.equal(familyFor('GET', '/search/code'), 'search');
  assert.equal(familyFor('GET', '/repos/o/r/releases/tags/state'), 'contents');
  assert.equal(familyFor('POST', '/app/installations/1/access_tokens'), 'auth');
});

test('budgetedFetch counts API calls by family and lets other hosts through', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep });
  const api = fakeApi([
    ['GET', '/repos/o/r/actions/runs/5', () => ({ body: { id: 5 } })],
    ['GET', '/repos/o/r/actions/artifacts/9/zip', () => ({ status: 302, headers: { location: 'https://blob.example.test/a/9' } })],
    ['GET', '/a/9', () => ({ body: 'bytes' })],
  ]);
  const f = budgetedFetch(api.fetch, b, { apiUrl: API });
  assert.equal((await f(new URL('/repos/o/r/actions/runs/5', API))).status, 200);
  assert.equal((await f(`${API}/repos/o/r/actions/artifacts/9/zip`, { redirect: 'manual' })).status, 302);
  assert.equal((await f('https://blob.example.test/a/9')).status, 200);
  assert.deepEqual(b.snapshot().used, { actions: 1, artifacts: 1 });
  assert.equal(b.snapshot().totalUsed, 2);
  assert.equal(api.calls.length, 3);
});

test('budgetedFetch refuses before sending and learns from responses', async () => {
  const c = fakeClock();
  const b = new ApiBudget({ now: c.now, sleep: c.sleep, families: { actions: { perHour: 0, perMinute: 0 } } });
  const api = fakeApi([['GET', /.*/, () => ({ status: 429, headers: { 'retry-after': '600' }, body: { message: 'slow down' } })]]);
  const f = budgetedFetch(api.fetch, b, { apiUrl: API });
  await assert.rejects(f(`${API}/repos/o/r/actions/runs/5`), (err) => err instanceof BudgetExceededError && err.family === 'actions');
  assert.equal(api.calls.length, 0);
  assert.equal((await f(`${API}/repos/o/r/actions/artifacts/9/zip`)).status, 429);
  assert.equal(api.calls.length, 1);
  assert.ok(b.snapshot().blockedUntil >= c.t + 600_000);
  await assert.rejects(f(`${API}/repos/o/r/contents/x`), (err) => err instanceof BudgetExceededError && err.reason === 'blocked');
  assert.equal(api.calls.length, 1);
});

test('R-ING-11: a restored snapshot carries the hourly caps into a new budget', async () => {
  const c = fakeClock();
  const first = new ApiBudget({ now: c.now, sleep: c.sleep });
  for (let i = 0; i < 200; i++) {
    await first.take('artifacts');
    c.t += 1000; // under the per-minute cap
  }
  await assert.rejects(first.take('artifacts'), (err) => err instanceof BudgetExceededError && err.reason === 'hourly');
  const snap = JSON.parse(JSON.stringify(first.snapshot())); // as stored in kv

  // The next pump run: a fresh budget, seeded from the snapshot.
  c.t += 60_000;
  const next = new ApiBudget({ now: c.now, sleep: c.sleep }).restore(snap);
  assert.equal(next.snapshot().used.artifacts, 200);
  assert.equal(next.snapshot().totalUsed, 200);
  await assert.rejects(next.take('artifacts'), (err) => err instanceof BudgetExceededError && err.reason === 'hourly');

  // A rate-limit block still in force carries over too.
  first.block('core', c.t + 5 * 60_000);
  const blocked = new ApiBudget({ now: c.now, sleep: c.sleep }).restore(JSON.parse(JSON.stringify(first.snapshot())));
  assert.ok(blocked.blockedUntil('core') > c.t);

  // An hour after those calls, they no longer count.
  c.t += 60 * 60_000;
  await next.take('artifacts');

  // Without a snapshot, a fresh budget would have allowed them all again;
  // malformed snapshots are ignored.
  for (const bad of [undefined, null, 'x', { calls: { total: 'no', families: { artifacts: [Number.NaN, 'a'], nope: [c.t] } } }]) {
    const b = new ApiBudget({ now: c.now, sleep: c.sleep }).restore(bad);
    assert.equal(b.snapshot().totalUsed, 0);
  }
});
