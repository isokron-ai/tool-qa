import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InputError, githubRepoOf, parseInputs, sanitize, textDigest } from '../lib/common.mjs';
import { createCache, createHttp, FetchProblem, mapLimit } from '../lib/http.mjs';
import { runKey } from './helpers.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const items = (list) => JSON.stringify(list);

test('parseInputs: a good shard is read in order, and a subject that is not owner/name is kept without a repo', () => {
  const r = parseInputs({ shardId: 'meta-github-1', attemptId: 'att-1', items: items([
    { subject: 'isokron-ai/mcp-check', run_key: runKey(1), fence: 3 },
    { subject: 'npm:some-package', run_key: runKey(2), fence: 4 },
  ]) });
  assert.deepEqual(r.items.map((x) => [x.index, x.repo, x.fence]), [[0, 'isokron-ai/mcp-check', 3], [1, null, 4]]);
});

test('parseInputs: refuses bad ids, bad JSON, extra keys, repeated run_keys, bad fences, whitespace and too many items', () => {
  const ok = { subject: 'a/b', run_key: runKey(1), fence: 1 };
  const bad = [
    { shardId: 'x\ny', attemptId: 'a', items: items([ok]) },
    { shardId: 's', attemptId: '', items: items([ok]) },
    { shardId: 's', attemptId: 'a', items: '[' },
    { shardId: 's', attemptId: 'a', items: items([]) },
    { shardId: 's', attemptId: 'a', items: items([{ ...ok, extra: 1 }]) },
    { shardId: 's', attemptId: 'a', items: items([ok, ok]) },
    { shardId: 's', attemptId: 'a', items: items([{ ...ok, fence: 0 }]) },
    { shardId: 's', attemptId: 'a', items: items([{ ...ok, run_key: 'A'.repeat(64) }]) },
    { shardId: 's', attemptId: 'a', items: items([{ ...ok, subject: 'a/b c' }]) },
    { shardId: 's', attemptId: 'a', items: items([{ ...ok, subject: 'a/b ' }]) },
    { shardId: 's', attemptId: 'a', items: items(Array.from({ length: 101 }, (_, i) => ({ subject: 'a/b', run_key: runKey(i + 1), fence: 1 }))) },
  ];
  for (const b of bad) assert.throws(() => parseInputs(b), InputError, JSON.stringify(b).slice(0, 80));
});

test('sanitize: secrets, emails and identity-shaped text become placeholders; identity-shaped keys throw', () => {
  const out = sanitize({ a: 'mail me at person@maintainer-mail.net', b: ['attempt_id=att-9', 'v1.2.0'], c: 'ghp_' + 'A'.repeat(36), d: 3 });
  assert.equal(out.a, '[removed: email]');
  assert.deepEqual(out.b, ['[removed: identity-like text]', 'v1.2.0']);
  assert.equal(out.c, '[removed: github-token]');
  assert.equal(out.d, 3);
  for (const k of ['attempt_id', 'run_key', 'fence', 'runKey', 'schema_version']) assert.throws(() => sanitize({ x: { [k]: 1 } }), /looks like a result identity/);
});

test('textDigest keeps only a sha256 and a length', () => {
  assert.deepEqual(Object.keys(textDigest('some upstream text')), ['sha256', 'length']);
  assert.equal(textDigest(''), null);
});

test('githubRepoOf reads the usual repository URL forms', () => {
  for (const u of ['git+https://github.com/Owner/Repo.git', 'https://github.com/owner/repo', 'git@github.com:owner/repo.git', 'github.com/owner/repo/tree/main', 'git://github.com/owner/repo']) {
    assert.equal(githubRepoOf(u), 'owner/repo', u);
  }
  assert.equal(githubRepoOf('https://gitlab.com/owner/repo'), null);
  assert.equal(githubRepoOf(undefined), null);
});

test('http: a cached ETag is sent, and a 304 gives the cached summary back without parsing a body', async () => {
  const seen = [];
  let n = 0;
  const f = async (url, init) => {
    seen.push(init.headers['if-none-match'] ?? null);
    n++;
    if (n === 1) return new Response(JSON.stringify({ count: 5 }), { status: 200, headers: { etag: '"abc"' } });
    return new Response(null, { status: 304 });
  };
  // Two runs sharing one cache (within a run, the same read is sent once).
  const cache = createCache();
  const a = await createHttp({ fetch: f, sleep: async () => {}, cache }).getSummary('https://x.test/a', { version: 'v1', extract: (d) => ({ c: d.count }) });
  const http = createHttp({ fetch: f, sleep: async () => {}, cache });
  const b = await http.getSummary('https://x.test/a', { version: 'v1', extract: () => { throw new Error('not parsed on 304'); } });
  assert.deepEqual([a.status, a.value, b.status, b.value, b.cached], [200, { c: 5 }, 304, { c: 5 }, true]);
  assert.deepEqual(seen, [null, '"abc"']);
  assert.equal(http.stats.not_modified, 1);
});

test('http: a cached summary from another extractor version is not used', async () => {
  const seen = [];
  const f = async (url, init) => { seen.push(init.headers['if-none-match'] ?? null); return new Response('{"x":1}', { status: 200, headers: { etag: '"e"' } }); };
  const cache = createCache();
  await createHttp({ fetch: f, sleep: async () => {}, cache }).getSummary('https://x.test/a', { version: 'v1', extract: (d) => d });
  await createHttp({ fetch: f, sleep: async () => {}, cache }).getSummary('https://x.test/a', { version: 'v2', extract: (d) => d });
  assert.deepEqual(seen, [null, null]);
});

test('http: 5xx is retried, then reported as upstream_unavailable; 429 as rate_limited; a long Retry-After is not waited for', async () => {
  const waits = [];
  const mk = (status, headers = {}) => async () => new Response('x', { status, headers });
  const h1 = createHttp({ fetch: mk(503), sleep: async (ms) => { waits.push(ms); }, retries: 2 });
  await assert.rejects(h1.request('https://x.test/'), (e) => e instanceof FetchProblem && e.code === 'upstream_unavailable');
  assert.equal(waits.length, 2);
  const h2 = createHttp({ fetch: mk(429, { 'retry-after': '3600' }), sleep: async (ms) => { waits.push(ms); } });
  await assert.rejects(h2.request('https://x.test/'), (e) => e.code === 'rate_limited' && e.retryAfterMs === 3_600_000);
  assert.equal(waits.length, 2, 'an hour-long Retry-After is not slept on');
  const h3 = createHttp({ fetch: async () => { throw new TypeError('fetch failed'); }, sleep: async () => {}, retries: 1 });
  await assert.rejects(h3.request('https://x.test/'), (e) => e.code === 'upstream_unavailable');
});

test('http: requests to a paced host keep their interval, even when started together', async () => {
  let clock = 0;
  const at = [];
  const http = createHttp({
    fetch: async () => { at.push(clock); return new Response('{}', { status: 200 }); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    minIntervalMs: { 'crates.io': 1000 },
  });
  await mapLimit([1, 2, 3], 3, () => http.request('https://crates.io/api/v1/crates/x'));
  assert.deepEqual(at, [0, 1000, 2000]);
});

test('cache: saved and loaded as a file, newest entries kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-cache-'));
  try {
    const path = join(dir, 'c.json');
    const c = createCache({ path });
    c.set('u1', { v: 'x', etag: '"1"', value: { n: 1 } });
    c.save();
    const d = createCache({ path });
    assert.deepEqual(d.get('u1').value, { n: 1 });
    assert.equal(createCache({ path: join(dir, 'missing.json') }).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
