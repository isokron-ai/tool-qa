// discover/extract.mjs and discover/run.mjs: feed rows to candidate subjects. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { buildCandidates, candidatesProblems, cleanSubfolder, feedNames, fromCrates, fromGo, fromRegistry, parseGithubUrl, purlFor, repoFromNpm, repoFromPypi } from '../extract.mjs';
import { lookupPackages, runDiscover } from '../run.mjs';

const reg = (name, repository, packages = [], meta = {}) => ({
  server: { name, ...(repository ? { repository } : {}), ...(packages.length ? { packages } : {}) },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, ...meta } },
});

test('R-DISC-01: registry, crates and Go rows map to one candidate per GitHub repository, with subfolder and purl keys, by class then a stable hash', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/Acme/Server.git'), { repo: 'Acme/Server', subfolder: '' });
  assert.deepEqual(parseGithubUrl('git+https://github.com/a/b'), { repo: 'a/b', subfolder: '' });
  assert.deepEqual(parseGithubUrl('git@github.com:a/b.git'), { repo: 'a/b', subfolder: '' });
  assert.deepEqual(parseGithubUrl('github:a/b'), { repo: 'a/b', subfolder: '' });
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/tree/main/src/srv'), { repo: 'a/b', subfolder: 'src/srv' });
  assert.equal(parseGithubUrl('https://gitlab.com/a/b'), null);
  assert.equal(parseGithubUrl('https://github.com/a'), null);
  assert.equal(cleanSubfolder('/x/../y'), '');
  assert.equal(purlFor('npm', '@scope/pkg'), 'pkg:npm/%40scope/pkg');
  assert.equal(purlFor('pypi', 'My_Pkg.x'), 'pkg:pypi/my-pkg-x');
  assert.equal(purlFor('mcpb', 'https://x'), null);
  const rows = [
    reg('io.a/one', { url: 'https://github.com/mono/repo', subfolder: 'servers/one' }, [{ registryType: 'npm', identifier: '@mono/one' }]),
    reg('io.a/two', { url: 'https://github.com/Mono/Repo', subfolder: 'servers/two' }, [{ registryType: 'pypi', identifier: 'mono-two' }]),
    reg('io.a/remote', { url: 'https://github.com/r/remote-only' }),
    reg('io.a/old', { url: 'https://github.com/o/old' }, [{ registryType: 'npm', identifier: 'old' }], { isLatest: false }),
    reg('io.a/del', { url: 'https://github.com/o/deleted' }, [{ registryType: 'npm', identifier: 'del' }], { status: 'deleted' }),
    reg('io.a/nogh', { url: 'https://gitlab.com/x/y' }, [{ registryType: 'npm', identifier: 'y' }]),
  ];
  const r = fromRegistry(rows);
  assert.deepEqual(r.map((o) => o.repo), ['mono/repo', 'Mono/Repo', 'r/remote-only'], 'only the latest active versions on GitHub');
  const c = fromCrates([{ id: 'rmcp-x', repository: 'https://github.com/c/crate' }, { id: 'nope', repository: '' }]);
  const g = fromGo([{ path: 'github.com/g/mod/cmd/server/v2' }, { path: 'gitlab.com/x/y' }]);
  assert.deepEqual(g.map((o) => [o.repo, o.subfolder]), [['g/mod', 'cmd/server']]);
  const cands = buildCandidates([...r, ...c, ...g]);
  assert.deepEqual(cands.map((x) => [x.name, x.class]).sort(), [['c/crate', 1], ['g/mod', 1], ['mono/repo', 0], ['r/remote-only', 2]]);
  assert.deepEqual(cands.map((x) => x.class), [0, 1, 1, 2], 'class order');
  const mono = cands.find((x) => x.name === 'mono/repo');
  assert.deepEqual(mono.keys.map((k) => [k.subfolder, k.purl]), [['servers/one', 'pkg:npm/%40mono/one'], ['servers/two', 'pkg:pypi/mono-two']], 'a monorepo is one candidate with both servers as keys');
  const ones = cands.filter((x) => x.class === 1);
  assert.ok(ones[0].hash < ones[1].hash);
  assert.deepEqual(buildCandidates([...g, ...c, ...r]).map((x) => x.name), cands.map((x) => x.name), 'the order does not depend on the input order');
  assert.deepEqual(candidatesProblems({ version: 1, frame: 'discover-v1', candidates: cands }), []);
});

test('R-DISC-02: npm and PyPI names are looked up only when the registry does not already name them, at most --lookups, and a failed lookup is counted, never fatal', async () => {
  assert.deepEqual(feedNames([{ id: 'a' }, { id: 'b', deleted: true }, { id: 'a' }], 'npm'), ['a']);
  assert.deepEqual(feedNames([{ id: 'X', action: 'new release' }, { id: 'y', action: 'remove file z' }], 'pypi'), ['x']);
  assert.deepEqual(repoFromNpm({ repository: { url: 'git+https://github.com/n/p.git', directory: 'packages/p' } }), { repo: 'n/p', subfolder: 'packages/p' });
  assert.deepEqual(repoFromNpm({ repository: 'github:n/q' }), { repo: 'n/q', subfolder: '' });
  assert.deepEqual(repoFromPypi({ info: { project_urls: { Homepage: 'https://github.com/h/home', Source: 'https://github.com/s/src' } } }), { repo: 's/src', subfolder: '' });
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (url.includes('/gone/')) return new Response('', { status: 404 });
    if (url.includes('/broken/')) return new Response('', { status: 400 });
    if (url.includes('registry.npmjs.org')) return Response.json({ repository: { url: 'https://github.com/n/found' } });
    return Response.json({ info: { project_urls: {} } });
  };
  const l = await lookupPackages({ npm: ['found', 'gone', 'broken'], pypi: ['norepo', 'extra'], limit: 4, fetch, sleep: async () => {}, gapMs: 0 });
  assert.equal(asked.length, 4);
  assert.deepEqual(l.stats, { npm: 3, pypi: 1, found: 1, not_found: 1, no_repo: 1, errors: 1, left: 1 });
  assert.deepEqual(l.observations.map((o) => [o.feed, o.repo, o.purls[0]]), [['npm', 'n/found', 'pkg:npm/found']]);
  // End to end on files: an npm name the registry lists is not looked up.
  const dir = mkdtempSync(join(tmpdir(), 'discover-'));
  try {
    const nd = (rows) => gzipSync(Buffer.from(rows.map((x) => JSON.stringify(x)).join('\n')));
    writeFileSync(join(dir, 'registry-full-x.ndjson.gz'), nd([reg('io.a/one', { url: 'https://github.com/a/one' }, [{ registryType: 'npm', identifier: 'listed' }])]));
    writeFileSync(join(dir, 'npm-2026-11-27.ndjson.gz'), nd([{ id: 'listed' }, { id: 'found' }]));
    writeFileSync(join(dir, 'pypi-2026-11-27.ndjson.gz'), nd([]));
    writeFileSync(join(dir, 'crates-2026-11-27.ndjson.gz'), nd([]));
    writeFileSync(join(dir, 'go-2026-11-27.ndjson.gz'), nd([]));
    asked.length = 0;
    const m = await runDiscover({ registry: join(dir, 'registry-full-x.ndjson.gz'), packages: dir, out: join(dir, 'out'), fetch, sleep: async () => {} });
    assert.deepEqual(asked.map((u) => new URL(u).pathname), ['/found/latest']);
    assert.equal(m.counts.candidates, 2);
    const doc = JSON.parse(gunzipSync(readFileSync(join(dir, 'out', 'candidates.json.gz'))));
    assert.deepEqual(doc.candidates.map((x) => x.name).sort(), ['a/one', 'n/found']);
    assert.match(JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'))).inputs.registry.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the candidates check refuses a wrong version, frame or a malformed row', () => {
  const good = { name: 'a/b', class: 0, hash: 'a'.repeat(64), keys: [] };
  assert.ok(candidatesProblems({ version: 2, frame: 'discover-v1', candidates: [] }).length);
  assert.ok(candidatesProblems({ version: 1, frame: 'x', candidates: [] }).length);
  assert.ok(candidatesProblems({ version: 1, frame: 'discover-v1', candidates: [{ ...good, name: 'a/b/c' }] }).length);
  assert.ok(candidatesProblems({ version: 1, frame: 'discover-v1', candidates: [{ ...good, class: 3 }] }).length);
  assert.deepEqual(candidatesProblems({ version: 1, frame: 'discover-v1', candidates: [good] }), []);
});
