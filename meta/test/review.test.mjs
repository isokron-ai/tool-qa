// Regressions from the review of the metadata lanes (REGRESSIONS.md, R-META-*).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCache, createHttp, FetchProblem, readCapped } from '../lib/http.mjs';
import { laneOf } from '../lanes.mjs';
import { createBudget, reserveFor } from '../github.mjs';
import { collectSubject, namespaceMatches, subjectOutput } from '../registry.mjs';
import { runShard } from '../run.mjs';
import { ghNode, githubFetch, judgeItem, registryFetch, registryRoutes, runKey } from './helpers.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'meta-review-'));
const envFor = (items, extra = {}) => ({ SHARD_ID: 'meta-shard-1', ATTEMPT_ID: 'att-42', ITEMS: JSON.stringify(items), ...extra });

/** A streamed body of `n` bytes, sent in 1 MiB chunks, with no Content-Length. */
function bigBody(n) {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= n) return c.close();
      const k = Math.min(1024 * 1024, n - sent);
      sent += k;
      c.enqueue(new Uint8Array(k).fill(0x20));
    },
  });
}

test('R-META-01: a body over the cap is not read past it and is a too_large problem', async () => {
  await assert.rejects(readCapped(new Response(bigBody(5 * 1024 * 1024)), 2 * 1024 * 1024, 'x'), (e) => e instanceof FetchProblem && e.code === 'too_large');
  await assert.rejects(readCapped(new Response('{}', { headers: { 'content-length': String(10 ** 9) } }), 1024, 'x'), (e) => e.code === 'too_large');
  assert.equal(await readCapped(new Response('{"a":1}'), 1024, 'x'), '{"a":1}');
});

test('R-META-01: an npm package over the cap is a skip that is not retried; the subject\'s other stages still run', async () => {
  const routes = registryRoutes();
  routes['https://registry.npmjs.org/@isokron%2Fmcp-check'] = () => new Response(bigBody(3 * 1024 * 1024), { status: 200 });
  const http = createHttp({ fetch: registryFetch(routes), sleep: async () => {}, maxBodyBytes: 1024 * 1024 });
  const o = subjectOutput(await collectSubject(http, 'isokron-ai/mcp-check'), '2026-11-24T00:00:00Z');
  assert.deepEqual(o.skips, [{ stage: 'npm', reason: 'policy_excluded' }]);
  assert.equal(o.records.find((r) => r.field === 'registry_entry_history').value.length, 1);
});

test('R-META-01: npm is read through the abbreviated document and the latest version, never the full document', async () => {
  const f = registryFetch();
  await collectSubject(createHttp({ fetch: f, sleep: async () => {} }), 'isokron-ai/mcp-check');
  const npm = f.calls.filter((c) => c.url.startsWith('https://registry.npmjs.org/'));
  assert.deepEqual(npm.map((c) => [c.url, c.headers.accept]), [
    ['https://registry.npmjs.org/@isokron%2Fmcp-check', 'application/vnd.npm.install-v1+json'],
    ['https://registry.npmjs.org/@isokron%2Fmcp-check/1.3.1', 'application/json'],
  ]);
});

async function oneHostileSubject(laneName) {
  {
    const dir = tmp();
    try {
      const base = laneName === 'meta-github'
        ? githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode(), 'bad/one': ghNode({ nameWithOwner: 'bad/one' }), 'good/two': ghNode({ nameWithOwner: 'good/two' }) } })
        : registryFetch();
      const f = async (url, init) => {
        // Any request for the hostile subject answers with something the lane cannot handle.
        if (url.includes('bad/one') || url.includes('bad%2Fone')) throw Object.assign(new Error('boom'), { name: 'Boom' });
        return base(url, init);
      };
      const items = [{ subject: 'bad/one', run_key: runKey(1), fence: 1 }, { subject: 'good/two', run_key: runKey(2), fence: 2 }];
      const out = join(dir, 'out');
      // A fetch that throws becomes a FetchProblem in http.request; make the lane itself throw instead.
      const r = await runShard({
        laneName, out, env: envFor(items, { GITHUB_TOKEN: 't' }), fetch: f, sleep: async () => {},
        ...(laneName === 'meta-registry' ? { seed: new Map([['bad/one', [{ registry: 'npm', identifier: 'x' }]]]) } : {}),
      }).catch((e) => e);
      assert.ok(!(r instanceof Error), `the shard failed: ${r?.message}`);
      assert.equal(r.outputs.length, 2);
      for (const o of r.outputs) assert.equal(judgeItem(join(out, String(o.index)), { attemptId: 'att-42', fence: o.fence, runKey: o.run_key }).outcome, 'accepted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

test("R-META-01: one subject whose data makes the lane throw is that subject's own skip, never a failed shard (meta-github)", () => oneHostileSubject('meta-github'));
test("R-META-01: one subject whose data makes the lane throw is that subject's own skip, never a failed shard (meta-registry)", () => oneHostileSubject('meta-registry'));

test('R-META-01: an error thrown while reading one subject is recorded as its non-retryable skip', async () => {
  const lane = laneOf('meta-registry');
  const http = createHttp({ fetch: registryFetch(), sleep: async () => {} });
  const real = http.getSummary;
  http.getSummary = (url, o) => (url.includes('bad%2Fone') ? Promise.reject(new TypeError('boom')) : real(url, o));
  const out = await lane.collect({ http, repos: ['bad/one', 'isokron-ai/mcp-check'] });
  assert.deepEqual(out.get('bad/one').skips, [{ stage: 'collect', reason: 'upstream_unavailable', retryable: false }]);
  assert.deepEqual(out.get('isokron-ai/mcp-check').skips, []);
  const gl = laneOf('meta-github');
  const h2 = createHttp({ fetch: githubFetch({ repos: { 'bad/one': ghNode({ nameWithOwner: 'bad/one' }), 'a/b': ghNode() } }), sleep: async () => {} });
  const r2 = h2.getSummary;
  h2.getSummary = (url, o) => (url.includes('/bad/one/') ? Promise.reject(new TypeError('boom')) : r2(url, o));
  const o2 = await gl.collect({ http: h2, repos: ['bad/one', 'a/b'], token: 't', budget: createBudget() });
  assert.deepEqual(o2.get('bad/one').skips, [{ stage: 'collect', reason: 'upstream_unavailable', retryable: false }]);
  assert.ok(o2.get('a/b').records.find((x) => x.field === 'repo_core').value);
});

test('R-META-02: a known-answer read stopped by an outage reads no subject; every item is a retryable skip with the forgery control', async () => {
  const dir = tmp();
  try {
    const f = registryFetch({}, { fallback: (url) => (url.startsWith('https://registry.modelcontextprotocol.io/') ? new Response('', { status: 503 }) : undefined) });
    const items = [{ subject: 'a/b', run_key: runKey(1), fence: 1 }, { subject: 'c/d', run_key: runKey(2), fence: 2 }];
    const out = join(dir, 'out');
    const r = await runShard({ laneName: 'meta-registry', out, env: envFor(items), fetch: f, sleep: async () => {} });
    assert.ok(f.calls.every((c) => !c.url.includes('a%2Fb') && !c.url.includes('c%2Fd')), 'no subject was read');
    for (const o of r.outputs) {
      assert.equal(o.outcome, 'known_answer_unavailable');
      const meta = JSON.parse(readFileSync(join(out, String(o.index), 'meta.json'), 'utf8'));
      assert.deepEqual(meta.skips, [{ stage: 'known_answer', reason: 'upstream_unavailable', retryable: true }]);
      assert.deepEqual(meta.controls.map((c) => [c.kind, c.observed]), [['forgery', 'contained']]);
      const v = judgeItem(join(out, String(o.index)), { attemptId: 'att-42', fence: o.fence, runKey: o.run_key });
      assert.equal(v.outcome, 'accepted');
      assert.equal(v.retryable, true, 'every skip is retryable: the state records retry_later, not counted toward parking');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-META-02: a real known-answer mismatch is still a hard failure', async () => {
  const f = githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode({ createdAt: '2020-01-01T00:00:00Z' }) } });
  await assert.rejects(runShard({ laneName: 'meta-github', out: join(tmpdir(), 'never-written'), env: envFor([{ subject: 'a/b', run_key: runKey(1), fence: 1 }], { GITHUB_TOKEN: 't' }), fetch: f, sleep: async () => {} }),
    /known-answer control gave mismatch/);
});

test('R-META-02: a GitHub rate limit on the known-answer read makes the control unavailable, not failed', async () => {
  const f = githubFetch({ graphql: async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) });
  const dir = tmp();
  try {
    const r = await runShard({ laneName: 'meta-github', out: join(dir, 'o'), env: envFor([{ subject: 'a/b', run_key: runKey(1), fence: 1 }], { GITHUB_TOKEN: 't' }), fetch: f, sleep: async () => {} });
    assert.equal(r.outputs[0].outcome, 'known_answer_unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-META-03: the reserve is a quarter of the reported limit, at least 300, and requests in flight count against it', async () => {
  assert.equal(reserveFor(5000), 1250);
  assert.equal(reserveFor(1000), 300);
  assert.equal(reserveFor(null), 300);
  const b = createBudget();
  b.noteRest(new Response('', { headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '1260' } }));
  assert.equal(b.restReserve, 1250);
  assert.equal(b.restAllowed(), null);
  b.rest.in_flight = 10;
  assert.match(b.restAllowed(), /below the reserve/);
  // In a lane run: 12 repositories, 4 at a time, starting 6 requests over the reserve. In-flight
  // requests are counted, so no more than 6 are sent before the reserve stops them.
  let remaining = 1256;
  const f = githubFetch({ repos: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o/r${i}`, ghNode({ nameWithOwner: `o/r${i}` })])) });
  const wrap = async (url, init) => {
    if (url.startsWith('https://api.github.com/repos/')) {
      await new Promise((r) => setTimeout(r, 2));
      remaining--;
      return new Response('[]', { headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining) } });
    }
    return f(url, init);
  };
  const budget = createBudget();
  budget.rest.limit = 5000;
  budget.rest.remaining = remaining;
  await laneOf('meta-github').collect({ http: createHttp({ fetch: wrap, sleep: async () => {} }), repos: Array.from({ length: 12 }, (_, i) => `o/r${i}`), token: 't', budget });
  assert.ok(remaining >= 1250, `the reserve held (${remaining} left)`);
});

test('R-META-04: the deadline is checked per subject: a batch that starts in time does not run past it', async () => {
  let clock = 0;
  const repos = Array.from({ length: 10 }, (_, i) => `o/r${i}`);
  const base = githubFetch({ repos: Object.fromEntries(repos.map((r) => [r, ghNode({ nameWithOwner: r })])) });
  const f = async (url, init) => { clock += 10_000; return base(url, init); };
  const out = await laneOf('meta-github').collect({
    http: createHttp({ fetch: f, sleep: async () => {} }), repos, token: 't', budget: createBudget(),
    deadline: () => clock > 60_000, concurrency: 1,
  });
  assert.ok(out.size > 0 && out.size < 10, `${out.size} of 10 subjects started`);
});

test('R-META-04: a full shard of 100 items is read and written well inside the job time (mocked APIs)', async () => {
  const dir = tmp();
  try {
    const repos = Array.from({ length: 100 }, (_, i) => `o/r${i}`);
    const f = githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode(), ...Object.fromEntries(repos.map((r) => [r, ghNode({ nameWithOwner: r })])) } });
    const t = performance.now();
    const r = await runShard({ laneName: 'meta-github', out: join(dir, 'o'), env: envFor(repos.map((s, i) => ({ subject: s, run_key: runKey(i + 1), fence: i + 1 })), { GITHUB_TOKEN: 't' }), fetch: f, sleep: async () => {} });
    assert.equal(r.outputs.length, 100);
    assert.ok(performance.now() - t < 60_000);
    // One GraphQL query for the known-answer subject and 10 for the 100 repositories.
    assert.equal(f.calls.filter((c) => c.url.endsWith('/graphql')).length, 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-META-05: a registry entry in someone else\'s io.github namespace is flagged', async () => {
  assert.equal(namespaceMatches('io.github.isokron-ai/mcp-check', 'Isokron-AI/mcp-check'), true);
  assert.equal(namespaceMatches('io.github.someone-else/mcp-check', 'isokron-ai/mcp-check'), false);
  assert.equal(namespaceMatches('com.example/server', 'isokron-ai/mcp-check'), null);
  const routes = registryRoutes();
  routes['https://registry.modelcontextprotocol.io/v0.1/servers?search=isokron-ai%2Fmcp-check&limit=100'].servers.push(
    { server: { name: 'io.github.impostor/mcp-check', repository: { url: 'https://github.com/isokron-ai/mcp-check' }, version: '0.0.1' }, _meta: {} },
  );
  const c = await collectSubject(createHttp({ fetch: registryFetch(routes), sleep: async () => {} }), 'isokron-ai/mcp-check');
  const h = subjectOutput(c, '2026-11-24T00:00:00Z').records.find((r) => r.field === 'registry_entry_history').value;
  assert.deepEqual(h.map((e) => [e.server_name, e.namespace_matches_subject]).sort(), [['io.github.impostor/mcp-check', false], ['io.github.isokron-ai/mcp-check', true]]);
});

test('R-META-06: the request cache holds no upstream free text (licence texts, summaries, crate descriptions)', async () => {
  const dir = tmp();
  try {
    const TEXT = 'UPSTREAMFREETEXT';
    const routes = {
      'https://pypi.org/pypi/demo-server/json': { info: { name: 'demo-server', version: '1.0.0', license: `${TEXT} licence\nline two`, summary: `${TEXT} summary`, project_urls: {} }, releases: { '1.0.0': [] }, urls: [] },
      'https://pypi.org/simple/demo-server/': { meta: { 'api-version': '1.4' }, files: [] },
      'https://crates.io/api/v1/crates/demo_crate': { crate: { name: 'demo_crate', description: `${TEXT} crate`, documentation: `${TEXT}`, newest_version: '0.1.0' }, versions: [{ num: '0.1.0', yank_message: TEXT }] },
      'https://crates.io/api/v1/crates/demo_crate/owners': { users: [] },
    };
    const withEtags = registryFetch(routes);
    const f = async (url, init) => {
      const res = await withEtags(url, init);
      const h = new Headers(res.headers);
      h.set('etag', `"${url.length}"`);
      return new Response(await res.text(), { status: res.status, headers: h });
    };
    const path = join(dir, 'cache.json');
    const cache = createCache({ path });
    const seed = new Map([['o/r', [{ registry: 'pypi', identifier: 'demo-server' }, { registry: 'cargo', identifier: 'demo_crate' }]]]);
    const c = await collectSubject(createHttp({ fetch: f, sleep: async () => {}, cache }), 'o/r', { seed });
    cache.save();
    assert.ok(!readFileSync(path, 'utf8').includes(TEXT), 'no free text in the cache');
    const o = subjectOutput(c, '2026-11-24T00:00:00Z');
    assert.equal(o.records.find((r) => r.field === 'pypi_info').value.licence_text.length, `${TEXT} licence\nline two`.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
