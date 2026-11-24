import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeGithub, GithubError } from '../github.mjs';

const TOKEN = ['tok', 'en', '-for-tests-', 'only'].join('');

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const headers = new Headers(opts.headers);
    calls.push({ url: String(url), headers, redirect: opts.redirect });
    const handler = routes.shift();
    if (!handler) throw new Error(`unexpected request ${url}`);
    return handler(String(url), headers);
  };
  fn.calls = calls;
  return fn;
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noSleep = async () => {};

test('getRun sends the token and API headers; 404 means no run', async () => {
  const fetch = fakeFetch([
    () => json({ id: 5, status: 'completed' }),
    () => json({ message: 'Not Found' }, 404),
  ]);
  const gh = makeGithub({ token: TOKEN, fetch, sleep: noSleep });
  assert.deepEqual(await gh.getRun('isokron-ai/mcp-check', 5), { id: 5, status: 'completed' });
  assert.equal(await gh.getRun('isokron-ai/mcp-check', 6), null);
  const c = fetch.calls[0];
  assert.equal(c.url, 'https://api.github.com/repos/isokron-ai/mcp-check/actions/runs/5');
  assert.equal(c.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(c.headers.get('x-github-api-version'), '2022-11-28');
  assert.equal(c.headers.get('accept'), 'application/vnd.github+json');
});

test('refuses bad repo names and run ids before any request', async () => {
  const gh = makeGithub({ token: TOKEN, fetch: fakeFetch([]), sleep: noSleep });
  await assert.rejects(gh.getRun('../etc', 1), /repo/);
  await assert.rejects(gh.getRun('a/b', '1; rm'), /run id/);
  await assert.rejects(gh.downloadArtifact('a/b', 0), /artifact id/);
});

test('listRunArtifacts follows pages', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `a${i}` }));
  const fetch = fakeFetch([
    () => json({ total_count: 101, artifacts: page1 }),
    () => json({ total_count: 101, artifacts: [{ id: 999, name: 'result-att-1.tar.age' }] }),
  ]);
  const gh = makeGithub({ token: TOKEN, fetch, sleep: noSleep });
  const list = await gh.listRunArtifacts('isokron-ai/mcp-check', 5);
  assert.equal(list.length, 101);
  assert.equal(list[100].name, 'result-att-1.tar.age');
  assert.match(fetch.calls[0].url, /\/actions\/runs\/5\/artifacts\?per_page=100&page=1$/);
  assert.match(fetch.calls[1].url, /page=2$/);
});

test('download follows the redirect without the token and only to https', async () => {
  const blob = Buffer.from('age-encryption.org/v1\nbody');
  const fetch = fakeFetch([
    () => new Response(null, { status: 302, headers: { location: 'https://blob.example.net/x?sig=abc' } }),
    () => new Response(blob, { status: 200 }),
  ]);
  const gh = makeGithub({ token: TOKEN, fetch, sleep: noSleep });
  const got = await gh.downloadArtifact('isokron-ai/mcp-check', 77);
  assert.deepEqual(got, blob);
  assert.equal(fetch.calls[0].url, 'https://api.github.com/repos/isokron-ai/mcp-check/actions/artifacts/77/zip');
  assert.equal(fetch.calls[0].redirect, 'manual');
  assert.equal(fetch.calls[1].url, 'https://blob.example.net/x?sig=abc');
  assert.equal(fetch.calls[1].headers.get('authorization'), null);
  assert.equal(fetch.calls[1].redirect, 'manual');

  const insecure = makeGithub({
    token: TOKEN, sleep: noSleep,
    fetch: fakeFetch([() => new Response(null, { status: 302, headers: { location: 'http://blob.example.net/x' } })]),
  });
  await assert.rejects(insecure.downloadArtifact('isokron-ai/mcp-check', 77), /https/);
});

test('download: gone artifacts, size cap and a direct 200', async () => {
  const gone = makeGithub({ token: TOKEN, sleep: noSleep, fetch: fakeFetch([() => json({ message: 'Artifact has expired' }, 410)]) });
  await assert.rejects(gone.downloadArtifact('a/b', 1), (e) => e instanceof GithubError && e.status === 410 && !e.transient);

  const big = makeGithub({
    token: TOKEN, sleep: noSleep, maxDownloadBytes: 10,
    fetch: fakeFetch([() => new Response(null, { status: 302, headers: { location: 'https://blob.example.net/x' } }), () => new Response(Buffer.alloc(11))]),
  });
  await assert.rejects(big.downloadArtifact('a/b', 1), /larger than 10 bytes/);

  const direct = makeGithub({ token: TOKEN, sleep: noSleep, fetch: fakeFetch([() => new Response(Buffer.from('zz'))]) });
  assert.deepEqual(await direct.downloadArtifact('a/b', 1), Buffer.from('zz'));
});

test('retries 5xx, 429 and network errors with backoff, then gives up as transient', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const fetch = fakeFetch([
    () => json({}, 503),
    () => json({}, 429, { 'retry-after': '7' }),
    () => { throw new TypeError('fetch failed'); },
    () => json({ id: 1 }),
  ]);
  const gh = makeGithub({ token: TOKEN, fetch, sleep });
  assert.deepEqual(await gh.getRun('a/b', 1), { id: 1 });
  assert.deepEqual(sleeps, [1000, 7000, 4000]);

  const down = makeGithub({ token: TOKEN, sleep: noSleep, retries: 2, fetch: fakeFetch([() => json({}, 502), () => json({}, 502), () => json({}, 502)]) });
  await assert.rejects(down.getRun('a/b', 1), (e) => e instanceof GithubError && e.transient && e.status === 502);

  const limited = makeGithub({
    token: TOKEN, sleep: noSleep, retries: 0,
    fetch: fakeFetch([() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })]),
  });
  await assert.rejects(limited.getRun('a/b', 1), (e) => e.transient && e.status === 403);

  const denied = makeGithub({ token: TOKEN, sleep: noSleep, fetch: fakeFetch([() => json({ message: 'Resource not accessible' }, 403)]) });
  await assert.rejects(denied.getRun('a/b', 1), (e) => !e.transient && e.status === 403 && !e.message.includes(TOKEN));
});

test('findDispatchRun lists the workflow_dispatch runs of the worker workflow and matches the run name', async () => {
  const fetch = fakeFetch([
    () => json({ total_count: 2, workflow_runs: [{ id: 7, display_title: 'shard other' }, { id: 8, display_title: 'shard live-probe-abc', head_sha: '1'.repeat(40) }] }),
    () => json({ total_count: 0, workflow_runs: [] }),
  ]);
  const client = makeGithub({ token: TOKEN, fetch, sleep: noSleep });
  const run = await client.findDispatchRun('isokron-ai/mcp-check', '.github/workflows/live-probe.yml', 'shard live-probe-abc', { since: '2026-03-02T10:00:00.000Z' });
  assert.equal(run.id, 8);
  const u = new URL(fetch.calls[0].url);
  assert.equal(u.pathname, '/repos/isokron-ai/mcp-check/actions/workflows/live-probe.yml/runs');
  assert.equal(u.searchParams.get('event'), 'workflow_dispatch');
  assert.equal(u.searchParams.get('created'), '>=2026-03-02T10:00:00.000Z');
  assert.equal(await client.findDispatchRun('isokron-ai/mcp-check', 'live-probe.yml', 'shard nope'), null);
  await assert.rejects(client.findDispatchRun('isokron-ai/mcp-check', '../x.yml', 'shard a'), /workflow file/);
});

test('a budget refusal from the fetch layer is not retried as a network error', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    const err = new Error('actions: hourly budget of 400 calls is used');
    err.name = 'BudgetExceededError';
    throw err;
  };
  const sleeps = [];
  const client = makeGithub({ token: TOKEN, fetch, sleep: async (ms) => { sleeps.push(ms); } });
  await assert.rejects(client.getRun('isokron-ai/mcp-check', 5), (err) => err.name === 'BudgetExceededError');
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});


test('R-ING-17: no request is sent once the caller\'s deadline has passed, and a hanging one is cut off by it', async () => {
  // Already past: nothing is sent.
  const past = new AbortController();
  past.abort();
  const none = fakeFetch([]);
  const gh1 = makeGithub({ token: TOKEN, fetch: none, sleep: noSleep, deadlineSignal: () => past.signal });
  await assert.rejects(gh1.getRun('isokron-ai/mcp-check', 5), (err) => err instanceof GithubError && err.transient && err.code === 'deadline');
  assert.equal(none.calls.length, 0);

  // A request that would hang for its own 60 s ends when the deadline fires, with no retry.
  const dl = new AbortController();
  let sent = 0;
  const hang = async (url, opts) => {
    sent += 1;
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  };
  const gh2 = makeGithub({ token: TOKEN, fetch: hang, sleep: noSleep, deadlineSignal: () => dl.signal });
  setTimeout(() => dl.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(gh2.listRunArtifacts('isokron-ai/mcp-check', 5), (err) => err instanceof GithubError && err.transient);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(sent, 1, 'not retried after the deadline');

  // Downloads too.
  const gh3 = makeGithub({ token: TOKEN, fetch: fakeFetch([]), sleep: noSleep, deadlineSignal: () => past.signal });
  await assert.rejects(gh3.downloadArtifact('isokron-ai/mcp-check', 9), (err) => err.code === 'deadline');
});

test('R-ING-20: the wait before a retry ends at the deadline, even a retry-after of 60 s', async () => {
  const dl = new AbortController();
  const fetch = fakeFetch([() => json({ message: 'slow down' }, 429, { 'retry-after': '60' })]);
  let slept = 0;
  const forever = () => { slept += 1; return new Promise(() => {}); }; // a sleep that ignores the signal
  const gh = makeGithub({ token: TOKEN, fetch, sleep: forever, deadlineSignal: () => dl.signal });
  setTimeout(() => dl.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(gh.getRun('isokron-ai/mcp-check', 5), (err) => err instanceof GithubError && err.code === 'deadline');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(slept, 1);
  assert.equal(fetch.calls.length, 1, 'no second request after the deadline');

  // The default sleep clears its timer when the signal aborts.
  const { sleepUnless } = await import('../github.mjs');
  const c = new AbortController();
  const t1 = Date.now();
  setTimeout(() => c.abort(), 20);
  await sleepUnless(60_000, c.signal);
  assert.ok(Date.now() - t1 < 5000);
  await sleepUnless(60_000, c.signal); // already aborted: at once
});
