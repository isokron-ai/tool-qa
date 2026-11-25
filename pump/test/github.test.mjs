import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClient, GitHubError } from '../github.mjs';
import { ApiBudget, BudgetExceededError } from '../budgets.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const TOKEN = 'ghs_synthetic_token_for_tests_only';

test('request sends the token, API version and JSON body, and returns parsed data', async () => {
  const api = fakeApi([['POST', '/repos/o/r/issues', (req) => ({ status: 201, body: { number: 7, got: req.json } })]]);
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API });
  const res = await gh.request('POST', '/repos/o/r/issues', { body: { title: 't' } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data, { number: 7, got: { title: 't' } });
  const h = api.calls[0].headers;
  assert.equal(h.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(h.get('x-github-api-version'), '2022-11-28');
  assert.match(h.get('accept'), /application\/vnd\.github\+json/);
  assert.equal(h.get('content-type'), 'application/json');
});

test('query parameters are encoded', async () => {
  const api = fakeApi([['GET', '/repos/o/r/actions/runs', () => ({ body: { workflow_runs: [] } })]]);
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API });
  await gh.request('GET', '/repos/o/r/actions/runs', { query: { created: '>=2026-03-02T10:00:00Z', per_page: 30, skip: undefined } });
  assert.equal(api.calls[0].query.get('created'), '>=2026-03-02T10:00:00Z');
  assert.equal(api.calls[0].query.get('per_page'), '30');
  assert.equal(api.calls[0].query.has('skip'), false);
});

test('server errors are retried with backoff', async () => {
  const c = fakeClock();
  let n = 0;
  const api = fakeApi([['GET', '/x', () => (++n < 3 ? { status: 502, body: 'bad gateway' } : { body: { ok: true } })]]);
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API, sleep: c.sleep, random: () => 0.5 });
  const res = await gh.request('GET', '/x');
  assert.deepEqual(res.data, { ok: true });
  assert.equal(api.calls.length, 3);
  assert.deepEqual(c.sleeps, [1000, 2000]);
});

test('a POST is not repeated after a server error or network failure (it may have been done)', async () => {
  const c = fakeClock();
  const api = fakeApi([['POST', '/repos/o/r/actions/workflows/w.yml/dispatches', () => ({ status: 502, body: 'bad gateway' })]]);
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API, sleep: c.sleep, now: c.now });
  await assert.rejects(gh.request('POST', '/repos/o/r/actions/workflows/w.yml/dispatches', { body: {} }), (err) => err.status === 502);
  assert.equal(api.calls.length, 1);
  let n = 0;
  const flaky = createClient({
    token: TOKEN, apiUrl: API, sleep: c.sleep, now: c.now,
    fetch: async () => {
      n += 1;
      throw new Error('socket hang up');
    },
  });
  await assert.rejects(flaky.request('POST', '/repos/o/r/issues', { body: {} }), (err) => err.status === 0);
  assert.equal(n, 1);
  // Unless the caller says repeating is harmless.
  n = 0;
  await assert.rejects(flaky.request('POST', '/app/installations/1/access_tokens', { body: {}, retryUnsafe: true }));
  assert.equal(n, 6, 'six attempts');
});

test('a secondary rate limit waits for retry-after through the budget, then retries', async () => {
  const c = fakeClock();
  let n = 0;
  const api = fakeApi([
    ['POST', '/repos/o/r/actions/workflows/w.yml/dispatches', () =>
      ++n === 1
        ? { status: 403, headers: { 'retry-after': '20' }, body: { message: 'You have exceeded a secondary rate limit.' } }
        : { status: 204 }],
  ]);
  const budget = new ApiBudget({ now: c.now, sleep: c.sleep, random: () => 0 });
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API, sleep: c.sleep, budget, now: c.now });
  const start = c.t;
  const res = await gh.request('POST', '/repos/o/r/actions/workflows/w.yml/dispatches', { body: { ref: 'main' } });
  assert.equal(res.status, 204);
  assert.ok(c.t - start >= 20_000);
  assert.equal(budget.snapshot().secondaryHits, 1);
});

test('client errors throw GitHubError without retrying, and never contain the token', async () => {
  const api = fakeApi([['GET', '/repos/o/r', () => ({ status: 404, body: { message: `Not Found for ${TOKEN}` } })]]);
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API });
  await assert.rejects(gh.request('GET', '/repos/o/r'), (err) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.status, 404);
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.ok(!JSON.stringify(err).includes(TOKEN));
    return true;
  });
  assert.equal(api.calls.length, 1);
});

test('allowed statuses are returned instead of thrown', async () => {
  const api = fakeApi([['GET', '/repos/o/r/releases/tags/state', () => ({ status: 404, body: { message: 'Not Found' } })]]);
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API });
  const res = await gh.request('GET', '/repos/o/r/releases/tags/state', { allow: [404] });
  assert.equal(res.status, 404);
});

test('network failures are retried, then reported with the token scrubbed', async () => {
  const c = fakeClock();
  const gh = createClient({
    token: TOKEN,
    apiUrl: API,
    sleep: c.sleep,
    maxAttempts: 3,
    fetch: async () => {
      throw new Error(`connect ECONNRESET (auth ${TOKEN})`);
    },
  });
  await assert.rejects(gh.request('GET', '/x'), (err) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.status, 0);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
  assert.equal(c.sleeps.length, 2);
});

test('a spent budget is not retried', async () => {
  const c = fakeClock();
  const api = fakeApi([['GET', '/x', () => ({ body: {} })]]);
  const budget = new ApiBudget({ now: c.now, sleep: c.sleep, totalPerHour: 1 });
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API, sleep: c.sleep, budget });
  await gh.request('GET', '/x');
  await assert.rejects(gh.request('GET', '/x'), BudgetExceededError);
  assert.equal(api.calls.length, 1);
});

test('paginate follows pages until a short page', async () => {
  const api = fakeApi([
    ['GET', '/repos/o/r/actions/artifacts', (req) => {
      const page = Number(req.query.get('page'));
      const per = Number(req.query.get('per_page'));
      const all = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
      return { body: { total_count: 5, artifacts: all.slice((page - 1) * per, page * per) } };
    }],
  ]);
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API });
  const items = await gh.paginate('/repos/o/r/actions/artifacts', { key: 'artifacts', perPage: 2 });
  assert.deepEqual(items.map((a) => a.id), [1, 2, 3, 4, 5]);
  assert.equal(api.calls.length, 3);
});

test('a client needs a token', () => {
  assert.throws(() => createClient({ token: '' }), /token/);
});
