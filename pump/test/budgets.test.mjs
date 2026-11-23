import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiBudget, BudgetExceededError, DEFAULT_FAMILIES, familyFor } from '../budgets.mjs';
import { fakeClock } from '../../test/lib/fake-api.mjs';

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
