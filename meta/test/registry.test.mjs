import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectSubject, goEscape, goModFacts, packagesFor, registryEntries, subjectOutput } from '../registry.mjs';
import { createHttp } from '../lib/http.mjs';
import { sanitize } from '../lib/common.mjs';
import { registryFetch, registryRoutes } from './helpers.mjs';

const httpFor = (f) => createHttp({ fetch: f, sleep: async () => {}, retries: 0 });
const OBS = '2026-11-24T00:00:00Z';

test('registry entries: only entries whose repository is the subject, every version, oldest first', async () => {
  const r = await registryEntries(httpFor(registryFetch()), 'isokron-ai/mcp-check');
  assert.deepEqual([...r.servers.keys()], ['io.github.isokron-ai/mcp-check']);
  assert.deepEqual(r.servers.get('io.github.isokron-ai/mcp-check').map((v) => v.version), ['1.0.0', '1.3.1']);
  assert.equal(r.servers.get('io.github.isokron-ai/mcp-check')[0].schema, '2025-12-11');
});

test('registry entries: no match by owner/name falls back to a search by name, and follows at most three pages', async () => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const page = Number(u.searchParams.get('cursor') ?? 0);
    const servers = u.searchParams.get('search') === 'thing'
      ? [{ server: { name: `x.y/thing-${page}`, repository: { url: 'https://github.com/Owner/Thing' }, version: `1.${page}.0` }, _meta: {} }]
      : [];
    return new Response(JSON.stringify({ servers, metadata: { nextCursor: String(page + 1) } }), { status: 200 });
  };
  const r = await registryEntries(httpFor(f), 'owner/thing');
  assert.equal(calls.filter((c) => c.includes('search=thing&')).length, 3);
  assert.equal(r.servers.size, 3);
  assert.equal(r.truncated, true);
});

test('packagesFor: newest registry version packages plus the seed list, npm, PyPI and cargo only', () => {
  const servers = new Map([['s', [
    { version: '1', is_latest: false, packages: [{ registry_type: 'npm', identifier: 'old' }] },
    { version: '2', is_latest: true, packages: [{ registry_type: 'npm', identifier: 'new' }, { registry_type: 'oci', identifier: 'ghcr.io/x' }] },
  ]]]);
  assert.deepEqual(packagesFor(servers, [{ registry: 'pypi', identifier: 'p' }, { registry: 'cargo', identifier: 'c' }, { registry: 'nuget', identifier: 'n' }]),
    { npm: ['new'], pypi: ['p'], cargo: ['c'] });
});

test('npm: versions, publish dates, deprecations and provenance are kept; maintainer names and emails are not', async () => {
  const c = await collectSubject(httpFor(registryFetch()), 'isokron-ai/mcp-check');
  const o = subjectOutput(c, OBS);
  const by = (f) => o.records.filter((r) => r.field === f).map((r) => r.value);
  const [doc] = by('npm_version_doc');
  assert.equal(doc.package, '@isokron/mcp-check');
  assert.equal(doc.repository_matches_subject, true);
  assert.equal(doc.created_at, '2026-11-19T05:55:56Z');
  assert.equal(doc.dates_source, 'deps.dev');
  assert.equal(doc.deprecated_versions_count, 1);
  assert.equal(doc.latest.version, '1.3.1');
  assert.deepEqual(doc.latest.engines, [{ name: 'node', range: '>=20' }]);
  assert.deepEqual(by('npm_maintainer_count_and_change')[0], { package: '@isokron/mcp-check', count: 1, basis: 'latest_version_document' }, 'the count only: no change flag, no names');
  assert.equal(by('npm_attestations')[0].provenance_present, true);
  assert.equal(by('npm_attestations')[0].recent_with_provenance, 2);
  const text = JSON.stringify(sanitize(o.records));
  assert.ok(!text.includes('maintainer-mail') && !text.includes('someone'), 'no maintainer name or email');
  assert.equal(by('go_module_facts')[0].found, null, 'a 404 from the cached-only Go proxy is unknown, not absent (R-META-13)');
  assert.deepEqual(o.skips, []);
});

test('PyPI: project facts, status and provenance counts; roles counted, never named', async () => {
  const routes = {
    'https://pypi.org/pypi/demo-server/json': {
      info: { name: 'demo-server', version: '2.0.0', requires_python: '>=3.10', license_expression: 'MIT', license: null, summary: 'A server', project_urls: { Source: 'https://github.com/o/r' }, author_email: 'person@maintainer-mail.net', requires_dist: ['a', 'b'] },
      releases: { '1.0.0': [{ upload_time_iso_8601: '2025-01-01T00:00:00Z', yanked: true }], '2.0.0': [{ upload_time_iso_8601: '2026-01-01T00:00:00Z', yanked: false }] },
      urls: [{ filename: 'demo_server-2.0.0.tar.gz', packagetype: 'sdist', size: 10, upload_time_iso_8601: '2026-01-01T00:00:00Z', yanked: false }],
      ownership: { roles: [{ role: 'Owner', user: 'alice' }, { role: 'Maintainer', user: 'bob' }], organization: 'acme' },
      vulnerabilities: [],
    },
    'https://pypi.org/simple/demo-server/': { meta: { 'api-version': '1.4' }, 'project-status': { status: 'deprecated' }, files: [{ filename: 'demo_server-2.0.0.tar.gz', provenance: 'https://pypi.org/integrity/x' }] },
  };
  const seed = new Map([['o/r', [{ registry: 'pypi', identifier: 'demo-server' }]]]);
  const c = await collectSubject(httpFor(registryFetch(routes)), 'o/r', { seed });
  const o = subjectOutput(c, OBS);
  const v = (f) => o.records.find((r) => r.field === f).value;
  assert.equal(v('pypi_info').versions_count, 2);
  assert.equal(v('pypi_info').yanked_versions_count, 1);
  assert.equal(v('pypi_info').repository_matches_subject, true);
  assert.equal(v('pypi_info').roles_count, 2);
  assert.equal(v('pypi_info').organization_owned, true);
  assert.equal(v('pypi_project_status'), 'deprecated');
  assert.deepEqual([v('pypi_provenance').files, v('pypi_provenance').files_with_provenance], [1, 1]);
  const text = JSON.stringify(o.records);
  for (const s of ['alice', 'bob', 'acme', 'maintainer-mail']) assert.ok(!text.includes(s), s);
});

test('crates.io: facts and an owner count, and never more than one request a second', async () => {
  let clock = 0;
  const at = [];
  const routes = {
    'https://crates.io/api/v1/crates/demo_crate': { crate: { name: 'demo_crate', repository: 'https://github.com/o/r', newest_version: '0.2.0', max_version: '0.2.0', num_versions: 2, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', trustpub_only: true },
      versions: [{ num: '0.2.0', created_at: '2026-01-01T00:00:00Z', yanked: false, license: 'MIT', trustpub_data: { provider: 'github' }, published_by: { login: 'alice' } }, { num: '0.1.0', yanked: true, created_at: '2025-01-01T00:00:00Z' }] },
    'https://crates.io/api/v1/crates/demo_crate/owners': { users: [{ login: 'alice' }, { login: 'bob' }] },
  };
  const base = registryFetch(routes);
  const f = async (url, init) => { if (url.startsWith('https://crates.io/')) at.push(clock); return base(url, init); };
  const http = createHttp({ fetch: f, sleep: async (ms) => { clock += ms; }, now: () => clock, minIntervalMs: { 'crates.io': 1000 } });
  const c = await collectSubject(http, 'o/r', { seed: new Map([['o/r', [{ registry: 'cargo', identifier: 'demo_crate' }]]]) });
  const v = subjectOutput(c, OBS).records.find((r) => r.field === 'crates_crate_facts').value;
  assert.equal(v.owners_count, 2);
  assert.equal(v.yanked_versions_count, 1);
  assert.equal(v.newest.trusted_publishing, true);
  assert.ok(!JSON.stringify(v).includes('alice'));
  assert.deepEqual(at, [0, 1000]);
});

test('Go: case-encoded module path through cached-only; deprecation, retractions and a synthesized go.mod', async () => {
  assert.equal(goEscape('github.com/Owner/Repo'), 'github.com/!owner/!repo');
  assert.deepEqual(goModFacts('// Deprecated: use v2\nmodule github.com/o/r\n\ngo 1.22\n\nretract v1.0.1\nretract [v1.0.0, v1.0.2]\n'),
    { deprecated: true, retract_directives: 2, go_directive: '1.22', go_mod_synthesized: false });
  assert.deepEqual(goModFacts('module github.com/o/r\n'), { deprecated: false, retract_directives: 0, go_directive: null, go_mod_synthesized: true });
  const routes = {
    'https://proxy.golang.org/cached-only/github.com/!o/r/@latest': { Version: 'v1.2.0', Time: '2026-01-01T00:00:00Z', Origin: { VCS: 'git', URL: 'https://github.com/O/r' } },
    'https://proxy.golang.org/cached-only/github.com/!o/r/@v/list': { __text: 'v1.0.0\nv1.2.0\n' },
    'https://proxy.golang.org/cached-only/github.com/!o/r/@v/v1.2.0.mod': { __text: 'module github.com/O/r // Deprecated: moved\n\ngo 1.21\n' },
  };
  const c = await collectSubject(httpFor(registryFetch(routes)), 'O/r');
  const v = subjectOutput(c, OBS).records.find((r) => r.field === 'go_module_facts').value;
  assert.deepEqual([v.found, v.version, v.versions_count, v.deprecated, v.origin_matches], [true, 'v1.2.0', 2, true, true]);
});

test('an upstream outage is a retryable skip for that stage only', async () => {
  const routes = registryRoutes();
  routes['https://registry.npmjs.org/@isokron%2Fmcp-check'] = { __status: 503 };
  const c = await collectSubject(httpFor(registryFetch(routes)), 'isokron-ai/mcp-check');
  const o = subjectOutput(c, OBS);
  assert.deepEqual(o.skips, [{ stage: 'npm', reason: 'upstream_unavailable', fault: 'infra', retryable: true }]);
  assert.equal(o.records.find((r) => r.field === 'registry_entry_history').value.length, 1);
  const npm = o.records.find((r) => r.field === 'npm_version_doc');
  assert.equal(npm.value, null);
  assert.match(npm.why, /upstream_unavailable/);
});

test('the MCP registry rate-limiting us is a retryable rate_limited skip', async () => {
  const f = registryFetch({}, { fallback: (url) => (url.startsWith('https://registry.modelcontextprotocol.io/') ? new Response('', { status: 429 }) : undefined) });
  const c = await collectSubject(httpFor(f), 'a/b');
  const o = subjectOutput(c, OBS);
  assert.deepEqual(o.skips, [{ stage: 'mcp_registry', reason: 'rate_limited', fault: 'infra', retryable: true }]);
});

test('a subject with no registry entry reports an empty history', async () => {
  const c = await collectSubject(httpFor(registryFetch({})), 'a/b');
  const h = subjectOutput(c, OBS).records.find((r) => r.field === 'registry_entry_history');
  assert.deepEqual(h.value, []);
});

test('R-META-13: the Go proxy: a cached-only 404 is unknown (found null, stage not_cached), and a go.mod the proxy synthesized is no Go package of the subject (no deps.dev go lookup)', async () => {
  const base = 'https://proxy.golang.org/cached-only/github.com/!o/r';
  const missing = await collectSubject(httpFor(registryFetch()), 'O/r');
  const m = subjectOutput(missing, OBS);
  const mv = m.records.find((r) => r.field === 'go_module_facts').value;
  assert.deepEqual([mv.found, mv.basis], [null, 'proxy.golang.org/cached-only']);
  assert.match(mv.note, /unknown/);
  assert.equal(m.stages.go, 'not_cached');
  assert.deepEqual(m.skips, [], 'unknown is not a skip');

  const f = registryFetch({
    [`${base}/@latest`]: { Version: 'v0.0.0-20260101000000-abcdef123456', Time: '2026-01-01T00:00:00Z', Origin: { VCS: 'git', URL: 'https://github.com/O/r' } },
    [`${base}/@v/list`]: { __text: '' },
    [`${base}/@v/v0.0.0-20260101000000-abcdef123456.mod`]: { __text: 'module github.com/O/r\n' },
  });
  const synth = await collectSubject(httpFor(f), 'O/r');
  const so = subjectOutput(synth, OBS);
  const sv = so.records.find((r) => r.field === 'go_module_facts').value;
  assert.deepEqual([sv.found, sv.go_mod_synthesized, sv.declares_go_module], [true, true, false]);
  assert.equal(so.stages.go, 'synthesized_go_mod');
  assert.ok(!f.calls.some((c) => /deps\.dev\/.*\/systems\/go\//i.test(c.url)), 'deps.dev is not asked for a Go package the repository does not declare');

  const real = registryFetch({
    [`${base}/@latest`]: { Version: 'v1.0.0', Time: '2026-01-01T00:00:00Z', Origin: { VCS: 'git', URL: 'https://github.com/O/r' } },
    [`${base}/@v/list`]: { __text: 'v1.0.0\n' },
    [`${base}/@v/v1.0.0.mod`]: { __text: 'module github.com/O/r\n\ngo 1.22\n' },
  });
  const ro = subjectOutput(await collectSubject(httpFor(real), 'O/r'), OBS);
  assert.equal(ro.records.find((r) => r.field === 'go_module_facts').value.declares_go_module, true);
  assert.equal(ro.stages.go, 'ok');
});
