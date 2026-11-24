import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, runShard } from '../run.mjs';
import { ghNode, githubFetch, judgeItem, registryFetch, runKey } from './helpers.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'meta-run-'));
}

const envFor = (items, extra = {}) => ({ SHARD_ID: 'meta-shard-1', ATTEMPT_ID: 'att-42', ITEMS: JSON.stringify(items), ...extra });

test('meta-github: a bundle per item, each accepted by ingest; a non-repository subject reports policy_excluded', async () => {
  const dir = tmp();
  try {
    const items = [
      { subject: 'isokron-ai/mcp-check', run_key: runKey(1), fence: 11 },
      { subject: 'org/other', run_key: runKey(2), fence: 12 },
      { subject: 'gone/away', run_key: runKey(3), fence: 13 },
      { subject: 'npm:not-a-repo', run_key: runKey(4), fence: 14 },
    ];
    const f = githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode(), 'org/other': ghNode({ nameWithOwner: 'org/other', databaseId: 5 }) } });
    const out = join(dir, 'out');
    const r = await runShard({ laneName: 'meta-github', out, env: envFor(items, { GITHUB_TOKEN: 'test-token' }), fetch: f, sleep: async () => {} });
    assert.equal(r.outputs.length, 4);
    for (const o of r.outputs) {
      const v = judgeItem(join(out, String(o.index)), { attemptId: 'att-42', fence: o.fence, runKey: o.run_key });
      assert.equal(v.outcome, 'accepted', `item ${o.index}: ${v.reason} ${JSON.stringify(v.problems)}`);
    }
    const meta = (i) => JSON.parse(readFileSync(join(out, String(i), 'meta.json'), 'utf8'));
    assert.equal(meta(0).subject.sha, 'a'.repeat(40));
    assert.deepEqual(meta(0).controls.map((c) => [c.kind, c.observed]), [['known_good', 'match'], ['forgery', 'contained']]);
    assert.deepEqual(meta(3).skips, [{ stage: 'collect', reason: 'policy_excluded' }]);
    assert.notEqual(meta(0).controls[1].marker, meta(1).controls[1].marker, 'a fresh forgery marker per item');
    const obs2 = readFileSync(join(out, '2', 'bundle', 'observations', 'meta-github.ndjson'), 'utf8');
    assert.match(obs2, /"why":"GitHub has no public repository with this name"/);
    // The token never reaches a bundle.
    for (let i = 0; i < 4; i++) {
      for (const sub of ['observations/meta-github.ndjson', 'results/meta-github.json', 'logs/meta-github.log']) {
        assert.ok(!readFileSync(join(out, String(i), 'bundle', sub), 'utf8').includes('test-token'));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('meta-registry: a bundle per item, accepted by ingest, with no token sent anywhere', async () => {
  const dir = tmp();
  try {
    const items = [{ subject: 'isokron-ai/mcp-check', run_key: runKey(7), fence: 3 }, { subject: 'a/b', run_key: runKey(8), fence: 4 }];
    const f = registryFetch();
    const out = join(dir, 'out');
    const r = await runShard({ laneName: 'meta-registry', out, env: envFor(items, { GITHUB_TOKEN: 'test-token' }), fetch: f, sleep: async () => {} });
    for (const o of r.outputs) {
      const v = judgeItem(join(out, String(o.index)), { attemptId: 'att-42', fence: o.fence, runKey: o.run_key });
      assert.equal(v.outcome, 'accepted', `item ${o.index}: ${v.reason} ${JSON.stringify(v.problems)}`);
    }
    assert.ok(f.calls.every((c) => !JSON.stringify(c.headers).includes('test-token')));
    assert.ok(f.calls.every((c) => !c.url.startsWith('https://api.github.com/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed known-answer control writes nothing and exits 3', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'out');
    const lines = [];
    const f = githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode({ databaseId: 1 }) } });
    const code = await main(['meta-github', out], { ...envFor([{ subject: 'a/b', run_key: runKey(1), fence: 1 }]), GITHUB_TOKEN: 't', GITHUB_OUTPUT: join(dir, 'gho') }, {
      write: (s) => lines.push(s), runOptions: { fetch: f, sleep: async () => {} },
    });
    assert.equal(code, 3);
    assert.ok(!existsSync(out));
    assert.ok(!existsSync(join(dir, 'gho')), 'no step outputs, so no upload step runs');
    assert.match(lines.join(''), /known-answer control gave mismatch; nothing is uploaded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main: bad inputs exit 2; good ones write has_, fence_ and run_key_ step outputs for every item', async () => {
  const dir = tmp();
  try {
    const bad = await main(['meta-registry', join(dir, 'o')], envFor('not a list'), { write: () => {} });
    assert.equal(bad, 2);
    const gho = join(dir, 'gho');
    const items = [{ subject: 'isokron-ai/mcp-check', run_key: runKey(1), fence: 5 }, { subject: 'a/b', run_key: runKey(2), fence: 6 }];
    const code = await main(['meta-registry', join(dir, 'o')], { ...envFor(items), GITHUB_OUTPUT: gho }, { write: () => {}, runOptions: { fetch: registryFetch(), sleep: async () => {} } });
    assert.equal(code, 0);
    assert.equal(readFileSync(gho, 'utf8'), `has_0=true\nfence_0=5\nrun_key_0=${runKey(1)}\nhas_1=true\nfence_1=6\nrun_key_1=${runKey(2)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subjects not started before the deadline still get a bundle, with a retryable skip', async () => {
  const dir = tmp();
  try {
    let clock = 0;
    const base = registryFetch();
    const f = async (url, init) => { clock += 60_000; return base(url, init); };
    const items = Array.from({ length: 6 }, (_, i) => ({ subject: `o/r${i}`, run_key: runKey(i + 1), fence: i + 1 }));
    const out = join(dir, 'out');
    const r = await runShard({ laneName: 'meta-registry', out, env: envFor(items, { META_DEADLINE_MINUTES: '1' }), fetch: f, clock: () => clock, sleep: async () => {} });
    const late = r.outputs.filter((o) => o.outcome === 'shard_deadline');
    assert.ok(late.length > 0);
    for (const o of late) {
      const meta = JSON.parse(readFileSync(join(out, String(o.index), 'meta.json'), 'utf8'));
      assert.deepEqual(meta.skips, [{ stage: 'collect', reason: 'upstream_unavailable', retryable: true }]);
      assert.equal(judgeItem(join(out, String(o.index)), { attemptId: 'att-42', fence: o.fence, runKey: o.run_key }).outcome, 'accepted');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('meta-github refuses to run without a token', async () => {
  await assert.rejects(runShard({ laneName: 'meta-github', out: join(tmpdir(), 'x-never'), env: envFor([{ subject: 'a/b', run_key: runKey(1), fence: 1 }]), fetch: async () => { throw new Error('no call'); } }), /GITHUB_TOKEN is required/);
});

test('the conditional-request cache is saved and used by the next run (304s)', async () => {
  const dir = tmp();
  try {
    const cacheFile = join(dir, 'cache.json');
    const items = [{ subject: 'isokron-ai/mcp-check', run_key: runKey(1), fence: 1 }];
    const etags = new Map();
    const f = githubFetch({
      repos: { 'isokron-ai/mcp-check': ghNode() },
      rest: (url, init) => {
        if (!url.startsWith('https://api.github.com/repos/')) return undefined;
        if (init.headers['if-none-match'] && init.headers['if-none-match'] === etags.get(url)) return new Response(null, { status: 304, headers: { 'x-ratelimit-remaining': '900' } });
        return undefined;
      },
    });
    const wrap = async (url, init) => { const res = await f(url, init); const e = res.headers.get('etag'); if (e) etags.set(url, e); return res; };
    const env = envFor(items, { GITHUB_TOKEN: 't', META_CACHE_FILE: cacheFile });
    const a = await runShard({ laneName: 'meta-github', out: join(dir, 'a'), env, fetch: wrap, sleep: async () => {} });
    const b = await runShard({ laneName: 'meta-github', out: join(dir, 'b'), env, fetch: wrap, sleep: async () => {} });
    assert.ok(existsSync(cacheFile));
    assert.ok(b.summary.api.not_modified > a.summary.api.not_modified);
    assert.equal(b.summary.api.github_rest.counted, 0, 'every REST read of the second run was a 304');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
