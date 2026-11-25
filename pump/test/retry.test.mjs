import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POLICY, backoffMs, classify, createRetrier, retryAfterMs } from '../retry.mjs';
import { createClient } from '../github.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const TOKEN = 'ghs_synthetic_retry_token';
const hdr = (o = {}) => new Headers(o);

test('R-CHAOS-13: only 500, 502, 503, 504, 429, network errors and rate-limited 403s are transient; other 4xx are final', () => {
  for (const status of [500, 502, 503, 504, 429, 0]) assert.equal(classify({ status, headers: hdr() }).retryable, true, String(status));
  for (const status of [400, 401, 404, 409, 410, 422, 501]) assert.equal(classify({ status, headers: hdr() }).retryable, false, String(status));
  assert.equal(classify({ status: 403, headers: hdr() }).retryable, false, 'a plain 403 is a refusal');
  assert.equal(classify({ status: 403, headers: hdr({ 'retry-after': '3' }) }).retryable, true);
  assert.equal(classify({ status: 403, headers: hdr(), text: 'You have exceeded a secondary rate limit' }).retryable, true);
  const now = 1_000_000;
  const near = classify({ status: 403, headers: hdr({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 10) }), now });
  assert.equal(near.retryable, true);
  const far = classify({ status: 403, headers: hdr({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 3600) }), now });
  assert.equal(far.retryable, false, 'an hour-long limit is not waited for');
});

test('R-CHAOS-13: the delay is exponential with full jitter: base 2 s, doubling, cap 120 s', () => {
  assert.equal(POLICY.attempts, 6);
  assert.equal(backoffMs(1, { random: () => 0.999999 }), 1999);
  assert.equal(backoffMs(2, { random: () => 0.999999 }), 3999);
  assert.equal(backoffMs(5, { random: () => 0.999999 }), 31999);
  assert.equal(backoffMs(9, { random: () => 0.999999 }), 119999, 'capped at 120 s');
  assert.equal(backoffMs(3, { random: () => 0 }), 0, 'full jitter reaches zero');
});

test('R-CHAOS-13: Retry-After is honoured and capped at 60 s; a longer one ends the retries', () => {
  assert.equal(retryAfterMs(hdr({ 'retry-after': '7' })), 7000);
  assert.equal(retryAfterMs(hdr({ 'retry-after': new Date(5000).toUTCString() }), 1000), 4000);
  assert.equal(classify({ status: 503, headers: hdr({ 'retry-after': '500' }) }).waitMs, 60_000, 'capped');
  assert.equal(classify({ status: 429, headers: hdr({ 'retry-after': '500' }) }).retryable, false);
});

test('R-CHAOS-13: the retrier stops at the attempt limit, the total-sleep limit and the deadline, and logs each retry', async () => {
  const mk = (extra = {}) => {
    const c = fakeClock(0);
    const lines = [];
    return { c, lines, r: createRetrier({ sleep: c.sleep, now: c.now, random: () => 0.999999, log: (l) => lines.push(l), ...extra }) };
  };
  const failing = () => Object.assign(new Error('HTTP 500'), { retryable: true, reason: 'HTTP 500' });
  let a = mk();
  let n = 0;
  await assert.rejects(a.r.run('POST /x', async () => { n += 1; throw failing(); }), /HTTP 500/);
  assert.equal(n, 6, 'six attempts');
  assert.deepEqual(a.c.sleeps, [1999, 3999, 7999, 15999, 31999], 'at most 62 s of sleeping per call');
  assert.equal(a.lines.length, 6, 'five retries and the give-up line');
  assert.match(a.lines[0], /POST \/x: HTTP 500; attempt 1\/6 failed, next in 2\.0s/);

  a = mk({ totalMs: 10_000 });
  n = 0;
  await assert.rejects(a.r.run('x', async () => { n += 1; throw failing(); }));
  assert.equal(n, 3, 'the total-sleep cap stops it before the attempt cap');
  assert.ok(a.c.sleeps.reduce((s, x) => s + x, 0) <= 10_000);

  a = mk({ until: 5000 });
  n = 0;
  await assert.rejects(a.r.run('x', async () => { n += 1; throw failing(); }));
  assert.equal(n, 2, 'never sleeps past the deadline');
  assert.ok(a.c.t <= 5000);

  a = mk();
  n = 0;
  await assert.rejects(a.r.run('x', async () => { n += 1; throw new Error('HTTP 404'); }));
  assert.equal(n, 1, 'an error that is not retryable is thrown at once');
  assert.deepEqual(a.c.sleeps, []);
});

test('R-CHAOS-16: the REST client retries a 500 on a repeatable call, never a 4xx, and never repeats an unsafe POST', async () => {
  const c = fakeClock();
  let n = 0;
  const api = fakeApi([
    ['GET', '/x', () => (++n < 4 ? { status: 500, body: { message: 'boom' } } : { body: { ok: true } })],
    ['GET', '/gone', () => ({ status: 404, body: { message: 'Not Found' } })],
    ['POST', '/dispatch', () => ({ status: 500, body: { message: 'boom' } })],
  ]);
  const lines = [];
  const gh = createClient({ token: TOKEN, fetch: api.fetch, apiUrl: API, sleep: c.sleep, now: c.now, random: () => 0.5, log: (l) => lines.push(l) });
  assert.deepEqual((await gh.request('GET', '/x')).data, { ok: true });
  assert.equal(api.calls.length, 4);
  assert.deepEqual(c.sleeps, [1000, 2000, 4000]);
  assert.ok(lines.every((l) => !l.includes(TOKEN)), 'no token in the log');
  await assert.rejects(gh.request('GET', '/gone'), (e) => e.status === 404);
  assert.equal(api.calls.filter((r) => r.path === '/gone').length, 1);
  // A shard dispatch is a plain POST: it may have started a run, so it is sent once.
  await assert.rejects(gh.request('POST', '/dispatch', { body: {} }), (e) => e.status === 500);
  assert.equal(api.calls.filter((r) => r.path === '/dispatch').length, 1);
});
