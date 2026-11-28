// Regressions found in review of #37 (release-diff). Each test fails on the
// code at 5f88ddd. No network: every fetch is mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { makeTgz, makeZip } from '../../test/archive-fixtures.mjs';
import { createCache, createHttp, forbiddenKind } from '../lib/http.mjs';
import { movedTo, readGitRefs } from '../lib/gitrefs.mjs';
import { compareArtifact, ComputeBudget, indexByBase, MAX_HELD, onlyVersionLines } from '../lib/diff.mjs';
import { createSourceIndex } from '../lib/indicators.mjs';
import { collectSubject, LIMITS, pep440Key, readArtifact, resolveTag, settleTreeChecks, treesIdentical } from '../release-diff.mjs';
import { pinnedRegistry } from './helpers.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sha512i = (b) => `sha512-${createHash('sha512').update(b).digest('base64')}`;
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

function mockFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, redirect: init.redirect });
    const r = routes.find((x) => (x.method ?? 'GET') === method && url.startsWith(x.prefix));
    if (!r) return new Response('not found', { status: 404 });
    const body = Buffer.isBuffer(r.body) ? r.body : typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response([301, 302].includes(r.status) ? null : body, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  f.calls = calls;
  return f;
}
const pkt = (lines) => Buffer.from(lines.map((l) => (Buffer.byteLength(`${l}\n`) + 4).toString(16).padStart(4, '0') + `${l}\n`).join('') + '0000');
const http = (fetch, o = {}) => createHttp({ fetch, cache: createCache(), retries: 0, sleep: async () => {}, ...o });
const tgzOf = (top, files) => makeTgz(Object.entries(files).map(([p, d]) => ({ name: `${top}/${p}`, data: d, mode: p.endsWith('.sh') ? 0o755 : 0o644 })));

const PKG_JSON = JSON.stringify({ name: 'acme-tool', version: '1.0.0', main: 'lib/index.js', repository: { url: 'git+https://github.com/acme/tool.git' } }, null, 2);
const SRC_JSON = PKG_JSON;
const NPM_SEED = new Map([['acme/tool', [{ registry: 'npm', identifier: 'acme-tool' }]]]);

/** An npm subject acme/tool at commit C; `extra` routes come first, `tarball` and `doc` may be overridden. */
function npmWorld({ pkg, src, tags = [`${D} refs/tags/v1.0.0 peeled:${C}`], doc = {}, extra = [], tarball = tgzOf('package', pkg) }) {
  const source = tgzOf(`tool-${C}`, src);
  const f = mockFetch([
    ...extra,
    { prefix: 'https://registry.npmjs.org/acme-tool/latest', body: { name: 'acme-tool', version: '1.0.0', gitHead: C, repository: { url: 'git+https://github.com/acme/tool.git' }, dist: { tarball: 'https://registry.npmjs.org/acme-tool/-/acme-tool-1.0.0.tgz', integrity: sha512i(tarball) }, ...doc } },
    { prefix: 'https://registry.npmjs.org/acme-tool/-/', body: tarball },
    { method: 'POST', prefix: 'https://github.com/acme/tool.git/git-upload-pack', body: pkt([`${C} HEAD symref-target:refs/heads/main`, ...tags]) },
    { prefix: `https://codeload.github.com/acme/tool/tar.gz/${C}`, body: source },
  ]);
  f.tarball = tarball;
  return f;
}

/** compareArtifact on {path: text} maps. */
function cmp({ ecosystem = 'npm', kind = 'npm_tarball', version = '1.0.0', pkg, src, expired }) {
  const fm = (o) => new Map(Object.entries(o).map(([p, d]) => {
    const data = Buffer.isBuffer(d) ? d : Buffer.from(d);
    return [p, { path: p, size: data.length, mode: 0o644, sha256: sha256(data), data }];
  }));
  const files = fm(src);
  const index = createSourceIndex();
  for (const f of files.values()) index.add(f.data.toString('utf8'));
  return compareArtifact({ ecosystem, kind, version, files: fm(pkg), archive: { links: [], refused: [], duplicates: [], others: [] } }, { files, byBase: indexByBase([...files.keys()]), index }, { expired });
}

// ---------------------------------------------------------------- 1: build output and version stamps

test('R-RD-06: a republished file that the source tracks and that differs is content_differs, even under lib/ or dist/', () => {
  const r = cmp({
    pkg: { 'package.json': PKG_JSON, 'lib/index.js': 'require("https").get("https://evil.example/x");\n', 'lib/other.js': 'ok\n', 'dist/gen.js': 'built' },
    src: { 'package.json': SRC_JSON, 'lib/index.js': 'module.exports = 1;\n', 'lib/other.js': 'ok\n', 'src/gen.ts': 'source' },
  });
  const differs = r.findings.filter((f) => f.kind === 'content_differs');
  assert.deepEqual(differs.map((f) => f.path), ['lib/index.js']);
  assert.equal(r.summary.unexplained_differs, 1);
  assert.ok(!r.summary.explained.some((e) => e.reason === 'build_output_stale'));
  // A build folder file the source does not have at all is still build output.
  assert.deepEqual(r.summary.explained, [{ reason: 'build_output', count: 1 }]);
});

test('R-RD-06: a version stamp is a line whose only difference is the version, not any line that says "version" or holds a number', () => {
  assert.equal(onlyVersionLines('export const VERSION = "1.4.0";\n', 'export const VERSION = "0.0.0";\n', '1.4.0'), true);
  assert.equal(onlyVersionLines('__version__ = "1.4.0"\n', '__version__ = "0.0.0-dev"\n', '1.4.0'), true);
  // The line carries the version but changes more than it.
  assert.equal(onlyVersionLines('fetch("https://evil.example/v1.4.0/x")\n', 'fetch("https://good.example/v0.0.0/x")\n', '1.4.0'), false);
  // A line that mentions "version" or a number, without the artifact's version, is not a stamp.
  assert.equal(onlyVersionLines('const version = fetchRemote("evil")\n', 'const version = "0.0.0"\n', '1.4.0'), false);
  assert.equal(onlyVersionLines('dep = "evil>=9.9.9"\n', 'dep = "good>=0.0.1"\n', '1.4.0'), false);
  assert.equal(onlyVersionLines('a\nversion 1.4.0 evil()\n', 'a\nversion 0.0.0\n', '1.4.0'), false);
  assert.equal(onlyVersionLines('x\n', 'y\n', ''), false);
});

// ---------------------------------------------------------------- 2: renamed repositories, throttling

test('R-RD-07: a renamed repository is read at its new github.com name; one that moved elsewhere, a 403 and a 429 are skips with a fault side', async () => {
  assert.equal(movedTo('https://github.com/new/name.git/git-upload-pack', 'old/name'), 'new/name');
  assert.equal(movedTo('/new/name/git-upload-pack', 'old/name'), 'new/name');
  assert.equal(movedTo('https://evil.example/new/name.git/git-upload-pack', 'old/name'), null);
  assert.equal(movedTo('https://github.com:8443/new/name.git/git-upload-pack', 'old/name'), null);
  assert.equal(movedTo('https://github.com/new/name.git/other', 'old/name'), null);

  // Followed: the source comes from the new name, and the subject is compared with no skip.
  const refs = pkt([`${C} HEAD symref-target:refs/heads/main`, `${D} refs/tags/v1.0.0 peeled:${C}`]);
  let f = npmWorld({
    pkg: { 'package.json': PKG_JSON, 'lib/index.js': 'x' }, src: { 'package.json': SRC_JSON, 'lib/index.js': 'x' },
    extra: [
      { method: 'POST', prefix: 'https://github.com/acme/tool.git', status: 301, body: '', headers: { location: 'https://github.com/new/tool.git/git-upload-pack' } },
      { method: 'POST', prefix: 'https://github.com/new/tool.git', body: refs },
      { prefix: `https://codeload.github.com/new/tool/tar.gz/${C}`, body: tgzOf(`tool-${C}`, { 'package.json': SRC_JSON, 'lib/index.js': 'x' }) },
      { prefix: `https://codeload.github.com/acme/tool/tar.gz/${C}`, status: 302, body: '', headers: { location: `https://codeload.github.com/new/tool/tar.gz/${C}` } },
    ],
  });
  let c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'compared');
  assert.deepEqual(c.skips, []);
  assert.ok(f.calls.some((x) => x.url === `https://codeload.github.com/new/tool/tar.gz/${C}`));
  assert.ok(!f.calls.some((x) => x.url.startsWith('https://codeload.github.com/acme/')), 'the old name is not asked for the source');
  const r = await readGitRefs(http(f), 'acme/tool');
  assert.deepEqual([r.status, r.moved_to], ['ok', 'new/tool']);

  // Moved off github.com: not followed, a retryable skip that says the tool could not follow it.
  f = npmWorld({
    pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON },
    extra: [{ method: 'POST', prefix: 'https://github.com/acme/tool.git', status: 301, body: '', headers: { location: 'https://evil.example/acme/tool.git/git-upload-pack' } }],
  });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'source_repository_moved');
  assert.deepEqual(c.skips, [{ stage: 'git_refs', reason: 'upstream_unavailable', fault: 'tool', retryable: true }]);
  assert.ok(!f.calls.some((x) => x.url.includes('evil.example')));

  // Throttled (403, 429): infra, retryable, and the subject is not blamed for a missing repository.
  for (const status of [403, 429]) {
    f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, extra: [{ method: 'POST', prefix: 'https://github.com/acme/tool.git', status, body: '' }] });
    c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
    assert.deepEqual(c.skips, [{ stage: 'git_refs', reason: 'rate_limited', fault: 'infra', retryable: true }], String(status));
    assert.notEqual(c.artifacts[0].outcome, 'source_repository_not_found');
  }
  // A real 404 is the subject's, and is data.
  f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, extra: [{ method: 'POST', prefix: 'https://github.com/acme/tool.git', status: 404, body: '' }] });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'source_repository_not_found');
  assert.deepEqual(c.skips, []);

  // The source archive: a redirect we do not follow is a tool skip, a 403 is infra.
  f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, extra: [{ prefix: 'https://codeload.github.com/', status: 302, body: '', headers: { location: 'https://codeload.github.com/x' } }] });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'source_redirected');
  assert.deepEqual(c.skips, [{ stage: 'source', reason: 'upstream_unavailable', fault: 'tool', retryable: true }]);
  f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, extra: [{ prefix: 'https://codeload.github.com/', status: 403, body: '' }] });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(c.skips, [{ stage: 'source', reason: 'rate_limited', fault: 'infra', retryable: true }]);
  assert.equal(c.artifacts[0].outcome, 'source_rate_limited');
});

// ---------------------------------------------------------------- 3: tree lookups and the compute budget

test('R-RD-08: native, source and doc lookups are indexed (a large tree with many absent .so files compares in well under a second)', () => {
  const src = {};
  for (let i = 0; i < 60_000; i++) src[`pkg${i % 400}/mod${i}/file${i}.txt`] = `x${i}`;
  src['ext/src/kernel.c'] = 'int x;';
  src['README.md'] = '# r';
  const pkg = { 'package.json': '{}', 'README.MD': '# r' };
  for (let i = 0; i < 4000; i++) pkg[`ext/native${i}.so`] = `bin${i}`;
  const t0 = Date.now();
  const r = cmp({ ecosystem: 'pypi', kind: 'wheel', pkg, src });
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `took ${ms} ms`);
  // The answers are the same as a scan would give: the .so files sit under a folder with C source, the README is the repository's.
  assert.deepEqual(r.summary.explained.map((e) => [e.reason, e.count]), [['compiled_extension', 4000], ['copied_from_repo', 1]]);
  const other = cmp({ ecosystem: 'pypi', kind: 'wheel', pkg: { 'native.so': 'bin', 'mod.py': 'x' }, src: { 'sub/a/kernel.c': 'int x;', 'sub/b/mod.py': 'x' } });
  assert.deepEqual(other.findings.map((f) => f.path), ['native.so'], 'native source in another folder does not explain it');
});

test('R-RD-08: the compute deadline ends the comparison (ComputeBudget) and the subject with a tool-fault skip, not a job timeout', async () => {
  assert.throws(() => cmp({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, expired: () => true }), ComputeBudget);
  const many = {};
  for (let i = 0; i < 300; i++) many[`f${i}.js`] = `a${i}`;
  let calls = 0;
  assert.throws(() => cmp({ pkg: { ...many, 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, expired: () => ++calls > 2 }), ComputeBudget, 'it is checked while the files are walked');

  // End to end: the clock runs 100 s per reading once the source tree has arrived.
  let now = 0;
  let served = false;
  const base = npmWorld({ pkg: { 'package.json': PKG_JSON, 'lib/index.js': 'x' }, src: { 'package.json': SRC_JSON, 'lib/index.js': 'x' } });
  const f = async (url, init) => { const r = await base(url, init); if (url.startsWith('https://codeload')) served = true; return r; };
  f.calls = base.calls;
  const clock = () => (served ? (now += 100_000) : now);
  const c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED, clock });
  assert.equal(c.artifacts[0].outcome, 'compute_budget');
  assert.deepEqual(c.skips, [{ stage: 'compute_budget', reason: 'reader_limit', fault: 'tool' }]);
  assert.deepEqual(c.summaries, []);
});

// ---------------------------------------------------------------- 4: registry JSON never leaves the allowlist

test('R-RD-09: registry JSON reads do not follow redirects: one off the allowed hosts is refused, one to an allowed host is followed once checked', async () => {
  // Off the list: nothing is requested from the other host.
  let f = npmWorld({
    pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON },
    extra: [{ prefix: 'https://registry.npmjs.org/acme-tool/latest', status: 302, body: '', headers: { location: 'https://evil.example/acme-tool.json' } }],
  });
  let c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.ok(!f.calls.some((x) => x.url.includes('evil.example')));
  assert.deepEqual(c.skips, [{ stage: 'npm', reason: 'upstream_unavailable', fault: 'tool', retryable: true }]);
  assert.equal(c.artifacts[0].outcome, 'not_read');
  assert.ok(f.calls.filter((x) => /registry\.npmjs\.org\/acme-tool\/latest|api\.deps\.dev|modelcontextprotocol/.test(x.url)).every((x) => x.redirect === 'manual'), 'registry reads ask for manual redirects');

  // To another allowed address: followed, and its URL is checked again.
  const pkg = { 'package.json': PKG_JSON };
  const tarball = tgzOf('package', pkg);
  const doc = { name: 'acme-tool', version: '1.0.0', gitHead: C, repository: { url: 'git+https://github.com/acme/tool.git' }, dist: { tarball: 'https://registry.npmjs.org/acme-tool/-/acme-tool-1.0.0.tgz', integrity: sha512i(tarball) } };
  f = npmWorld({
    pkg, src: { 'package.json': SRC_JSON }, tarball,
    extra: [
      { prefix: 'https://registry.npmjs.org/acme-tool/latest', status: 302, body: '', headers: { location: 'https://registry.npmjs.org/acme-tool/1.0.0' } },
      { prefix: 'https://registry.npmjs.org/acme-tool/1.0.0', body: doc },
    ],
  });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(c.skips, []);
  assert.equal(c.artifacts[0].outcome, 'compared');
  // A loop of redirects ends.
  f = npmWorld({
    pkg, src: {}, tarball,
    extra: [{ prefix: 'https://registry.npmjs.org/acme-tool/', status: 302, body: '', headers: { location: 'https://registry.npmjs.org/acme-tool/latest' } }],
  });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(c.skips, [{ stage: 'npm', reason: 'upstream_unavailable', fault: 'tool', retryable: true }]);
});

// ---------------------------------------------------------------- 5: downloads and the subject budget

test('R-RD-10: a download is tried once (no retries on a 120 s read), and the subject budget applies before every network call', async () => {
  const f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, extra: [{ prefix: 'https://registry.npmjs.org/acme-tool/-/', status: 503, body: '' }] });
  const c = await collectSubject(http(f, { retries: 2 }), 'acme/tool', { seed: NPM_SEED });
  assert.equal(f.calls.filter((x) => x.url.includes('/-/')).length, 1, 'one try');
  assert.deepEqual(c.skips, [{ stage: 'npm', reason: 'upstream_unavailable', fault: 'infra', retryable: true }]);

  // The budget runs out after the first call: nothing else is asked for, and the subject says so once.
  let now = 0;
  const base = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON } });
  const late = async (url, init) => { now += 400_000; return base(url, init); };
  const d = await collectSubject(http(late), 'acme/tool', { seed: NPM_SEED, clock: () => now });
  assert.equal(base.calls.length, 1, `only the first call was made: ${base.calls.map((x) => x.url).join(' ')}`);
  assert.deepEqual(d.skips, [{ stage: 'collect', reason: 'reader_limit', fault: 'tool' }]);
  assert.equal(d.artifacts[0].outcome, 'subject_time_budget');
});

// ---------------------------------------------------------------- 6: reader limits are not findings

/** A one-wheel PyPI subject acme/kit whose wheel bytes are `wheel`. */
function wheelWorld(wheel) {
  return mockFetch([
    { prefix: 'https://pypi.org/pypi/kit/json', body: { info: { name: 'kit', version: '1.0.0', project_urls: { Source: 'https://github.com/acme/kit' } }, urls: [
      { filename: 'kit-1.0.0-py3-none-any.whl', packagetype: 'bdist_wheel', size: wheel.length, digests: { sha256: sha256(wheel) }, url: 'https://files.pythonhosted.org/packages/cc/kit-1.0.0-py3-none-any.whl' },
    ] } },
    { prefix: 'https://files.pythonhosted.org/packages/cc/', body: wheel },
    { method: 'POST', prefix: 'https://github.com/acme/kit.git/git-upload-pack', body: pkt([`${C} refs/tags/v1.0.0`]) },
    { prefix: `https://codeload.github.com/acme/kit/tar.gz/${C}`, body: tgzOf(`kit-${C}`, { 'kit/__init__.py': 'x = 1\n' }) },
  ]);
}
const KIT_SEED = new Map([['acme/kit', [{ registry: 'pypi', identifier: 'kit' }]]]);

test('R-RD-11: an archive our readers cannot read (unsupported zip method, zip64, a huge tar number) is a tool-fault skip, not a finding; real damage still is', async () => {
  const zip = makeZip([{ name: 'kit/__init__.py', data: 'x = 1\n' }, { name: 'kit-1.0.0.dist-info/METADATA', data: 'm' }]);
  const method99 = Buffer.from(zip);
  method99.writeUInt16LE(99, method99.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  const zip64 = Buffer.from(zip);
  zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
  for (const wheel of [method99, zip64]) {
    const c = await collectSubject(http(wheelWorld(wheel)), 'acme/kit', { seed: KIT_SEED });
    assert.deepEqual(c.findings, []);
    assert.deepEqual(c.skips, [{ stage: 'pypi', reason: 'reader_limit', fault: 'tool' }]);
    assert.equal(c.artifacts[0].outcome, 'reader_limit');
  }
  // A zip cut short is damage: a finding about the package (its level is capped here: linked by project URLs only).
  const cut = zip.subarray(0, zip.length - 30);
  const d = await collectSubject(http(wheelWorld(cut)), 'acme/kit', { seed: KIT_SEED });
  assert.deepEqual(d.findings.map((x) => x.kind), ['artifact_unreadable']);
  assert.deepEqual(d.skips, []);
  // A tar number our parser cannot hold.
  const big = makeTgz([{ name: 'package/x', declaredSize: 2 ** 60, data: '' }], { end: false });
  const f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, tarball: big });
  const e = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.ok(e.skips.every((s) => s.fault === 'tool' && ['reader_limit', 'too_large'].includes(s.reason)), JSON.stringify(e.skips));
  assert.ok(!e.findings.some((x) => x.kind === 'artifact_unreadable'));
});

// ---------------------------------------------------------------- 7: smaller findings

test('R-RD-12: the held list is capped like the findings, with a last entry that counts what it left out, and held files stay out of public counts', async () => {
  const pkg = { 'package.json': PKG_JSON };
  for (let i = 0; i < MAX_HELD + 100; i++) pkg[`d${i}/.env`] = 'TOKEN=x';
  const r = cmp({ pkg, src: { 'package.json': SRC_JSON } });
  assert.equal(r.held.length, MAX_HELD);
  assert.equal(r.held_truncated, 100);
  assert.equal(r.summary.files, 1);
  const c = await collectSubject(http(npmWorld({ pkg, src: { 'package.json': SRC_JSON } })), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.held.length, MAX_HELD + 1);
  assert.deepEqual(c.held.at(-1), { kind: 'held_truncated', truncated: 100 });
  assert.ok(!JSON.stringify(c.findings).includes('.env'));
});

test('R-RD-13: tag_commit_differs_from_git_head is low (an attention item), not medium', async () => {
  const c = await collectSubject(http(npmWorld({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, doc: { gitHead: 'e'.repeat(40) } })), 'acme/tool', { seed: NPM_SEED });
  const f = c.findings.find((x) => x.kind === 'tag_commit_differs_from_git_head');
  assert.equal(f.level, 'low');
});

test('R-RD-14: findings of a package linked only by its own repository field or project URLs are capped at low; provenance and attested deps.dev links keep their level', async () => {
  const pkg = { 'package.json': PKG_JSON, 'run.sh': '#!/bin/sh\necho hi\n' };
  const src = { 'package.json': SRC_JSON };
  let c = await collectSubject(http(npmWorld({ pkg, src })), 'acme/tool', { seed: NPM_SEED });
  let f = c.findings.find((x) => x.kind === 'unexpected_file');
  assert.deepEqual([c.artifacts[0].linked_by, f.level, f.level_capped_from, f.linked_by], ['repository_field', 'low', 'high', 'repository_field']);
  assert.ok(c.findings.every((x) => x.level === 'low' || x.level === 'info'), 'nothing medium or high in public');

  // Linked by an attested deps.dev link (the package's own field names another repository).
  const deps = { prefix: 'https://api.deps.dev/v3alpha/projects/github.com%2Facme%2Ftool:packageversions', body: { versions: [{ versionKey: { system: 'NPM', name: 'acme-tool' }, relationProvenance: 'SLSA_ATTESTATION' }] } };
  c = await collectSubject(http(npmWorld({ pkg, src, doc: { repository: { url: 'https://github.com/other/place' } }, extra: [deps] })), 'acme/tool', {});
  f = c.findings.find((x) => x.kind === 'unexpected_file');
  assert.equal(c.artifacts[0].linked_by, 'depsdev_attestation');
  assert.deepEqual([f.level, f.level_capped_from], ['high', undefined]);
});

test('R-RD-15: a PyPI version matches its tag by PEP 440 normalisation (1.0 and v1.0.0, 1.0.0rc1 and v1.0.0-rc.1); npm versions are not normalised', () => {
  const tag = (names) => new Map(names.map((n) => [n, { object: D, commit: C, annotated: false }]));
  assert.equal(pep440Key('1.0'), pep440Key('v1.0.0'));
  assert.equal(pep440Key('1.0.0rc1'), pep440Key('1.0.0-rc.1'));
  assert.notEqual(pep440Key('1.0.0'), pep440Key('1.0.1'));
  assert.notEqual(pep440Key('1.0.0rc1'), pep440Key('1.0.0'));
  assert.equal(pep440Key('not a version'), null);
  assert.deepEqual([resolveTag(tag(['v1.0.0']), { name: 'kit', version: '1.0', ecosystem: 'pypi' })?.name, resolveTag(tag(['v1.0.0']), { name: 'kit', version: '1.0', ecosystem: 'pypi' })?.match], ['v1.0.0', 'exact']);
  assert.equal(resolveTag(tag(['kit-v2.0.0-rc.1']), { name: 'kit', version: '2.0.0rc1', ecosystem: 'pypi' }).match, 'name_prefixed');
  assert.equal(resolveTag(tag(['py-v1.0.0']), { name: 'kit', version: '1.0', ecosystem: 'pypi' }).match, 'ecosystem_prefixed');
  assert.equal(resolveTag(tag(['v1.0.1']), { name: 'kit', version: '1.0', ecosystem: 'pypi' }), null);
  assert.equal(resolveTag(tag(['v1.0.0']), { name: 'kit', version: '1.0', ecosystem: 'npm' }), null);
});

test('R-RD-16: release_artifacts holds upstream text (tag names, provenance refs, file names) and is redacted R1 like the other author-text fields in the pinned registry', () => {
  const reg = pinnedRegistry();
  assert.deepEqual(reg.fields.get('release_artifacts').redaction, ['R1']);
  assert.deepEqual(reg.fields.get('release_diff_summary').redaction, ['R1']);
});

// ---------------------------------------------------------------- 8: re-review of #37 (gate A)

test('R-RD-17: a changed executable file keeps medium when the only link is the package\'s own repository field; other findings still drop to low', async () => {
  // No provenance (most npm packages): the repository field is the only link.
  const pkg = { 'package.json': PKG_JSON, 'lib/index.js': 'require("https").get("https://evil.example/x");\n', 'bin/run.sh': '#!/bin/sh\necho hi\n', 'docs.md': 'changed\n' };
  const src = { 'package.json': SRC_JSON, 'lib/index.js': 'module.exports = 1;\n', 'docs.md': 'hello\n' };
  const c = await collectSubject(http(npmWorld({ pkg, src })), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].linked_by, 'repository_field');
  const differs = c.findings.filter((f) => f.kind === 'content_differs');
  const js = differs.find((f) => f.path === 'lib/index.js');
  assert.deepEqual([js.executable, js.code_extension, js.level, js.level_capped_from, js.linked_by], [false, true, 'medium', 'high', 'repository_field']);
  // A differing text file that is not executable is capped to low as before; so is an unexpected executable file.
  assert.equal(differs.find((f) => f.path === 'docs.md').level, 'low');
  assert.equal(c.findings.find((f) => f.kind === 'unexpected_file' && f.path === 'bin/run.sh').level, 'low');
  assert.ok(!c.findings.some((f) => f.level === 'high'), 'nothing high in public for a self-declared link');
});

test('R-RD-18: a 403 for a DMCA-blocked or disabled repository is a settled skip (upstream_unavailable, fault subject, not retryable); throttling stays a retryable infra skip', async () => {
  const world = (extra) => npmWorld({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, extra });
  const refs = (status, body, headers = {}) => [{ method: 'POST', prefix: 'https://github.com/acme/tool.git', status, body, headers }];
  const gone = { stage: 'git_refs', reason: 'upstream_unavailable', fault: 'subject' };
  const throttled = { stage: 'git_refs', reason: 'rate_limited', fault: 'infra', retryable: true };

  for (const [body, why] of [
    ['remote: Repository access blocked\nremote: This repository has been disabled due to a DMCA takedown notice.', 'dmca'],
    ['Access to this repository has been disabled by GitHub Staff due to excessive use.', 'disabled'],
  ]) {
    const f = world(refs(403, body));
    const c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
    assert.deepEqual(c.skips, [gone], why);
    assert.equal(c.artifacts[0].outcome, 'source_repository_gone');
    assert.ok(!f.calls.some((x) => x.url.startsWith('https://codeload.github.com/')), 'no source read for a gone repository');
    assert.equal((await readGitRefs(http(f), 'acme/tool')).why, why);
  }
  // 451 (unavailable for legal reasons) is gone by its status.
  let c = await collectSubject(http(world(refs(451, ''))), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(c.skips, [gone]);

  // Throttling: rate-limit headers, a secondary-limit message, or a 403 that says nothing. Headers and message win over a body that also says "disabled".
  for (const [body, headers] of [
    ['', { 'x-ratelimit-remaining': '0' }],
    ['', { 'retry-after': '60' }],
    ['You have exceeded a secondary rate limit.', {}],
    ['You have triggered an abuse detection mechanism; repository access blocked for a while.', {}],
    ['Rate limit exceeded: API access has been disabled for this token.', {}],
    ['', {}],
  ]) {
    c = await collectSubject(http(world(refs(403, body, headers))), 'acme/tool', { seed: NPM_SEED });
    assert.deepEqual(c.skips, [throttled], JSON.stringify([body, headers]));
    assert.notEqual(c.artifacts[0].outcome, 'source_repository_gone');
  }

  // The source archive (codeload) says the same things.
  const code = (status, body, headers = {}) => [{ prefix: 'https://codeload.github.com/', status, body, headers }];
  c = await collectSubject(http(world(code(403, 'Repository access blocked: DMCA takedown'))), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(c.skips, [{ stage: 'source', reason: 'upstream_unavailable', fault: 'subject' }]);
  assert.equal(c.artifacts[0].outcome, 'source_gone');
  c = await collectSubject(http(world(code(403, '', { 'x-ratelimit-remaining': '0' }))), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(c.skips, [{ stage: 'source', reason: 'rate_limited', fault: 'infra', retryable: true }]);
  assert.equal(c.artifacts[0].outcome, 'source_rate_limited');
});

test('R-RD-19: an artifact whose bytes do not match the registry\'s digest is a held finding (not a retryable infra skip), and the public record does not say so', async () => {
  const pkg = { 'package.json': PKG_JSON, 'lib/index.js': 'x' };
  const f = npmWorld({ pkg, src: { 'package.json': SRC_JSON, 'lib/index.js': 'x' }, doc: { dist: { tarball: 'https://registry.npmjs.org/acme-tool/-/acme-tool-1.0.0.tgz', integrity: sha512i(Buffer.from('another file')) } } });
  const c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(c.skips, [], 'no skip: the result is settled, not retried');
  assert.equal(c.held.length, 1);
  assert.deepEqual(
    [c.held[0].package, c.held[0].version, c.held[0].ecosystem, c.held[0].artifact, c.held[0].indicators, c.held[0].sha256, c.held[0].size],
    ['acme-tool', '1.0.0', 'npm', 'npm_tarball', ['integrity_mismatch'], sha256(f.tarball), f.tarball.length],
  );
  // The public record is exactly what an artifact the registry answers 404 for gives: same outcome, no skip, no finding.
  const gone = await collectSubject(http(npmWorld({ pkg, src: { 'package.json': SRC_JSON, 'lib/index.js': 'x' }, extra: [{ prefix: 'https://registry.npmjs.org/acme-tool/-/', status: 404, body: '' }] })), 'acme/tool', { seed: NPM_SEED });
  assert.equal(gone.artifacts[0].outcome, 'artifact_not_found');
  assert.deepEqual(gone.held, []);
  assert.deepEqual(c.artifacts, gone.artifacts, 'the public artifact records are identical');
  assert.deepEqual([c.skips, c.findings, c.summaries, c.stages], [gone.skips, gone.findings, gone.summaries, gone.stages]);
  // Nothing public names it: not the findings, the summaries, the artifacts, nor the held count in the stages.
  const pub = JSON.stringify([c.findings, c.summaries, c.artifacts, c.stages, c.skips]);
  assert.ok(!/integrity|mismatch|held/i.test(pub), pub);
  assert.equal(c.findings.length, 0);
});

test('R-RD-20: forbiddenKind reads only GitHub\'s own repository-level messages (start of a line or of the JSON message) as a repository taken down; the same words inside other text are not', async () => {
  const res = (status, body, headers = {}) => new Response(body, { status, headers });
  const kind = async (status, body, headers) => forbiddenKind(res(status, body, headers));

  // GitHub's real shapes: REST JSON (451 and 403), git over HTTP, the staff notice.
  const dmcaJson = JSON.stringify({ message: 'Repository access blocked', block: { reason: 'dmca', created_at: '2026-11-01T10:00:00Z', html_url: 'https://github.com/github/dmca/blob/master/2026/11/2026-11-01-example.md' }, documentation_url: 'https://docs.github.com/rest' });
  assert.deepEqual([(await kind(451, dmcaJson)).kind, (await kind(451, dmcaJson)).why], ['gone', 'dmca']);
  assert.equal((await kind(403, dmcaJson)).why, 'dmca');
  const tosJson = JSON.stringify({ message: 'Repository access blocked', block: { reason: 'tos', created_at: '2026-11-01T10:00:00Z' } });
  assert.deepEqual([(await kind(403, tosJson)).kind, (await kind(403, tosJson)).why], ['gone', 'disabled']);
  assert.equal((await kind(403, JSON.stringify({ message: 'Access to this repository has been disabled by GitHub Staff due to a violation of GitHub\'s terms of service.' }))).why, 'disabled');
  assert.equal((await kind(403, 'remote: This repository has been disabled.\nfatal: unable to access')).kind, 'gone');
  assert.equal((await kind(403, 'remote: Repository access blocked\nremote: This repository has been disabled due to a DMCA takedown notice.')).why, 'dmca');
  assert.equal((await kind(403, 'Repository access blocked: DMCA takedown')).kind, 'gone');

  // The same words in the middle of other text: a release note, a package text, an error that is not about the repository. Not gone.
  for (const body of [
    JSON.stringify({ message: 'Resource not accessible by integration', note: 'v2.3.0: access blocked for anonymous callers; the legacy endpoint has been disabled' }),
    'Release v1.4.2\n- fix: the proxy has been disabled by default; repository access blocked errors are now retried',
    JSON.stringify({ message: 'Forbidden', documentation_url: 'https://docs.github.com/rest', detail: 'Do not say "This repository has been disabled" unless GitHub does' }),
    '<html>Repository access blocked pages are documented under Settings</html>',
    'Contributor list: alice, bob. Access to this repository has been disabled by GitHub is what the DMCA bot would say',
  ]) {
    assert.equal((await kind(403, body)).kind, 'throttled', body);
    assert.equal((await forbiddenKind(res(403, body), { unknown: 'unknown' })).kind, 'unknown', body);
  }
  // Throttling still wins over a body that also names the repository.
  assert.equal((await kind(403, dmcaJson, { 'x-ratelimit-remaining': '0' })).kind, 'throttled');
  assert.equal((await kind(403, 'You have exceeded a secondary rate limit. Repository access blocked.')).kind, 'throttled');
});

test('R-RD-22: a tag that names another commit than the provenance, with the same source tree (a rebase), drops to low with tree_identical true; a different tree keeps its level; what we could not check says null', async () => {
  const E = 'e'.repeat(40);
  const same = { 'package.json': PKG_JSON, 'src/a.ts': 'export const a = 1;\n', 'run.sh': '#!/bin/sh\n' };
  const f = mockFetch([
    { prefix: `https://codeload.github.com/acme/tool/tar.gz/${C}`, body: tgzOf(`tool-${C}`, same) },
    { prefix: `https://codeload.github.com/acme/tool/tar.gz/${D}`, body: tgzOf(`tool-${D}`, same) },
    { prefix: `https://codeload.github.com/acme/tool/tar.gz/${E}`, body: tgzOf(`tool-${E}`, { ...same, 'src/a.ts': 'export const a = 2;\n' }) },
  ]);
  assert.deepEqual(await treesIdentical(http(f), 'acme/tool', C, D), { identical: true, why: null });
  assert.deepEqual(await treesIdentical(http(f), 'acme/tool', C, E), { identical: false, why: null });
  // Not a commit the host has: unknown, never "differs".
  assert.deepEqual(await treesIdentical(http(f), 'acme/tool', C, 'f'.repeat(40)), { identical: null, why: 'source_not_found' });

  const mk = (level = 'high') => ({ kind: 'tag_commit_differs_from_provenance', provenance_ref: 'this_tag', level });
  const rebased = mk(); const moved = mk(); const missing = mk(); const capped = mk('medium');
  await settleTreeChecks(http(f), 'acme/tool', [
    { finding: rebased, tag: D, provenance: C },
    { finding: capped, tag: D, provenance: C },
    { finding: moved, tag: E, provenance: C },
    { finding: missing, tag: 'f'.repeat(40), provenance: C },
  ], { overBudget: () => false });
  assert.deepEqual([rebased.level, rebased.tree_identical, rebased.level_before_tree_check], ['low', true, 'high']);
  assert.deepEqual([capped.level, capped.tree_identical, capped.level_before_tree_check], ['low', true, 'medium']);
  assert.deepEqual([moved.level, moved.tree_identical], ['high', false]);
  // The per-subject cap: the third pair is not read, so it keeps its level (it is not blamed, not cleared either).
  assert.deepEqual([missing.level, missing.tree_identical], ['high', null]);

  const late = mk();
  await settleTreeChecks(http(f), 'acme/tool', [{ finding: late, tag: D, provenance: C }], { overBudget: () => true });
  assert.deepEqual([late.level, late.tree_identical], ['high', null], 'past the subject budget nothing is read');
});

test('R-RD-23: the archive caps hold large real packages (more than the old 20,000 entries is read) and stay bounded (memory ceiling of an artifact at most 1 GiB, one entry kept at most 16 MiB, an entry count past the cap is still a too_large limit of ours)', async () => {
  const a = LIMITS.artifact;
  assert.ok(a.maxCompressedBytes + a.maxInflatedBytes <= 1024 ** 3, 'an artifact is held in memory whole: compressed + inflated stays under 1 GiB');
  assert.ok(a.maxKeptTotalBytes <= a.maxInflatedBytes && a.maxKeptEntryBytes <= 16 * 1024 ** 2);
  assert.ok(LIMITS.source.maxKeptTotalBytes <= 256 * 1024 ** 2 && LIMITS.source.maxKeptEntryBytes <= 2 * 1024 ** 2, 'the source stream keeps little');
  assert.ok(a.maxEntries >= 50_000 && LIMITS.source.maxEntries >= 300_000);
  const many = (n) => makeTgz(Array.from({ length: n }, (_, i) => ({ name: `package/f/${i}.txt`, data: 'x', mode: 0o644 })));
  const ok = await readArtifact(many(25_000), 'npm_tarball');
  assert.equal(ok.files.size, 25_000, 'more than the old 20,000-entry cap');
  await assert.rejects(readArtifact(many(a.maxEntries + 1), 'npm_tarball'), (e) => e.name === 'ArchiveLimit');
});
