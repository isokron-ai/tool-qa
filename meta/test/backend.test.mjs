// meta-backend: the data maps, the reader and classifier on crafted
// repositories, and the lane end to end on mocked archives. No network:
// every fetch is mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTgz } from '../../test/archive-fixtures.mjs';
import { createCache, createHttp } from '../lib/http.mjs';
import { buildIndex, createAnalyzer, fileRole, manifestDeps, mapProblems, mergeMaps, normImage, toolWords, usableStandIn, writeLike, BASE_URL_ENV_RE } from '../lib/backend-scan.mjs';
import { allowedUrl, collectSubject, FIELD, LIMITS, loadMaps, MAPS_VERSION, PENDING_FIELD_YAML, TOOLS, VERSION, withPendingField } from '../backend.mjs';
import { laneOf } from '../lanes.mjs';
import { runShard } from '../run.mjs';
import { forgeryControl, knownAnswerControl, loadKnownAnswer } from '../controls.mjs';
import { judgeItem, pinnedRegistry, runKey } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const STAND_INS = JSON.parse(readFileSync(new URL('stand-ins.json', DATA), 'utf8'));
const SPEC_URLS = JSON.parse(readFileSync(new URL('spec-urls.json', DATA), 'utf8'));
const MAPS = loadMaps();
const SHA = 'a'.repeat(40);
const KRONICLE_PIN = '6d4b9646f8c517871a8f4f1275ee08ce25cd2a04';

/** Classify a crafted repository {path: text} with the shipped maps (or others). */
function classify(files, { maps = MAPS, commit = SHA, repo = 'acme/server', source = 'archive' } = {}) {
  const a = createAnalyzer(maps);
  for (const [p, t] of Object.entries(files)) a.addFile(p, t);
  return a.result({ repo, commit, source, mapVersions: { stand_ins: 1, spec_urls: 1 } });
}
const pkg = (deps = {}, dev = {}) => JSON.stringify({ name: 'x', dependencies: deps, devDependencies: dev });
const mutated = (fn) => { const s = structuredClone(STAND_INS); const u = structuredClone(SPEC_URLS); fn(s, u); return loadMaps({ standIns: s, specUrls: u }); };

// ---------------------------------------------------------------- the maps

test('R-WB-01: the two data maps are valid, every stand-in says its fidelity and whether it is cleared, every spec URL is a vendor https URL with no query', () => {
  assert.deepEqual(mapProblems(STAND_INS, SPEC_URLS), []);
  for (const [id, s] of Object.entries(SPEC_URLS.services)) {
    if (s.spec === null) { assert.match(s.note, /\d{4}-\d{2}-\d{2}/, `${id}: says when it was looked for`); continue; }
    const u = new URL(s.spec.url);
    assert.equal(u.protocol, 'https:', id);
    assert.equal(u.search, '', `${id}: the dispatch input contract has no query string`);
    assert.equal(s.spec.publisher, 'vendor', id);
  }
  // The research's verdicts are what the maps say (company-audit RESEARCH.md section 2).
  const b = STAND_INS.backends;
  assert.equal(b.github.stand_in.fidelity, 'not_faithful', 'Gitea is not a stand-in for the GitHub API');
  assert.equal(b.aws.stand_in.cleared, false, 'LocalStack needs an account and a token since 23 Mar 2026');
  assert.equal(b.s3.stand_in.id, 'minio');
  assert.equal(b.smtp.stand_in.id, 'mailpit');
  assert.equal(b.postgres.stand_in.fidelity, 'real');
  // A broken map is refused whole, and the lane does not load.
  assert.match(mapProblems({ ...STAND_INS, backends: { bad: { kind: 'sql', stand_in: { id: 'x', product: 'x', fidelity: 'maybe', cleared: 'yes' }, signals: {} } } }, SPEC_URLS).join('\n'), /fidelity[\s\S]*cleared/);
  assert.match(mapProblems(STAND_INS, { ...SPEC_URLS, services: { q: { name: 'q', spec: { url: 'https://x.example/spec?v=1', format: 'openapi3', publisher: 'vendor', checked: '2026-11-27' }, signals: {} } } }).join('\n'), /no port, user|https URL/);
  assert.match(mapProblems(STAND_INS, { ...SPEC_URLS, services: { q: { name: 'q', spec: { url: 'https://x.example/s.json', format: 'openapi3', publisher: 'apis.guru', checked: '2026-11-27' }, signals: {} } } }).join('\n'), /publisher must be vendor/);
  assert.throws(() => loadMaps({ standIns: { version: 1, backends: { bad: { kind: 'nope', stand_in: null, signals: {} } } }, specUrls: SPEC_URLS }), /data maps are not valid/);
});

test('R-WB-01: the lane and maps versions in pump/workflows.json are what the bundles report, so a map change moves every run_key', () => {
  const wf = JSON.parse(readFileSync(new URL('../../pump/workflows.json', import.meta.url), 'utf8')).workflows['meta-backend'];
  assert.deepEqual(wf.versions.tool, { 'meta-backend': VERSION, 'meta-backend-maps': MAPS_VERSION });
  assert.equal(MAPS_VERSION, `${STAND_INS.version}.${SPEC_URLS.version}`);
  assert.deepEqual(TOOLS.map((t) => t.name), ['tool-qa-meta-backend', 'tool-qa-meta-backend-maps']);
  assert.equal(wf.runs_untrusted, false);
  assert.equal(wf.enabled, false, 'off until ingest\'s registry pin holds write_backend');
});

test('R-WB-01: mergeMaps joins an id that is in both maps: the stand-in from one, the spec and signals from the other', () => {
  const t = mergeMaps(STAND_INS, SPEC_URLS);
  const gh = t.get('github');
  assert.equal(gh.stand_in.fidelity, 'not_faithful');
  assert.match(gh.spec.url, /github\/rest-api-description/);
  assert.ok(gh.signals.npm.includes('@octokit/rest'));
  assert.equal(usableStandIn(gh), false);
  assert.equal(usableStandIn(t.get('postgres')), true);
  assert.equal(usableStandIn(t.get('mssql')), false, 'not cleared');
});

// ---------------------------------------------------------------- reading files

test('R-WB-02: manifests: npm, pyproject (PEP 621, Poetry, groups), requirements, setup.py, go.mod, Cargo.toml, pom.xml, gradle, csproj', () => {
  assert.deepEqual(manifestDeps('npm', pkg({ pg: '1' }, { vitest: '1' })), [{ name: 'pg', dev: false }, { name: 'vitest', dev: true }]);
  assert.deepEqual(manifestDeps('npm', 'not json'), []);
  const py = '[project]\nname = "x"\ndependencies = [\n  "psycopg[binary]>=3",\n  "mcp>=1.2",\n]\n[project.optional-dependencies]\nredis = ["redis>=5"]\n[dependency-groups]\ndev = ["pytest"]\n[tool.poetry.dependencies]\npython = "^3.11"\nboto3 = "*"\n';
  assert.deepEqual(manifestDeps('pyproject', py).map((d) => `${d.name}${d.dev ? ':dev' : ''}`), ['psycopg', 'mcp', 'redis', 'pytest:dev', 'boto3']);
  assert.deepEqual(manifestDeps('requirements', 'pymongo==4\n# c\n-r base.txt\nmotor>=3\n').map((d) => d.name), ['pymongo', 'motor']);
  assert.deepEqual(manifestDeps('setup_py', 'setup(install_requires=["neo4j>=5", \'mcp\'])').map((d) => d.name), ['neo4j', 'mcp']);
  assert.deepEqual(manifestDeps('gomod', 'module x\nrequire (\n\tgithub.com/redis/go-redis/v9 v9.0.0\n\tgithub.com/x/y v1.0.0 // indirect\n)\nrequire github.com/lib/pq v1.10.0\n'),
    [{ name: 'github.com/redis/go-redis/v9', dev: false }, { name: 'github.com/x/y', dev: true }, { name: 'github.com/lib/pq', dev: false }]);
  assert.deepEqual(manifestDeps('cargo', '[dependencies]\nrusqlite = "0.31"\ntokio = { version = "1" }\n[dev-dependencies]\ntempfile = "3"\n[dependencies.redis]\nversion = "0.25"\n').map((d) => `${d.name}${d.dev ? ':dev' : ''}`), ['rusqlite', 'tokio', 'tempfile:dev', 'redis']);
  assert.deepEqual(manifestDeps('pom', '<dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency><dependency><groupId>junit</groupId><artifactId>junit</artifactId><scope>test</scope></dependency>'),
    [{ name: 'org.postgresql:postgresql', dev: false }, { name: 'junit:junit', dev: true }]);
  assert.deepEqual(manifestDeps('gradle', 'implementation("redis.clients:jedis:5.1.0")\ntestImplementation \'org.xerial:sqlite-jdbc:3\'\n'), [{ name: 'redis.clients:jedis', dev: false }, { name: 'org.xerial:sqlite-jdbc', dev: true }]);
  assert.deepEqual(manifestDeps('csproj', '<PackageReference Include="Npgsql" Version="8" />'), [{ name: 'Npgsql', dev: false }]);
});

test('R-WB-02: which files are read, and which never are (node_modules, vendor, build output, lock files)', () => {
  assert.equal(fileRole('package.json'), 'manifest');
  assert.equal(fileRole('packages/server/pyproject.toml'), 'manifest');
  assert.equal(fileRole('docker-compose.dev.yml'), 'compose');
  assert.equal(fileRole('.env.example'), 'env_example');
  assert.equal(fileRole('.env'), null, 'a real .env is never read');
  assert.equal(fileRole('src/index.ts'), 'code');
  assert.equal(fileRole('README.md'), 'readme');
  assert.equal(fileRole('a/b/c/d/README.md'), null, 'deep READMEs are documentation of something else');
  assert.equal(fileRole('node_modules/pg/package.json'), null);
  assert.equal(fileRole('dist/index.js'), null);
  assert.equal(fileRole('package-lock.json'), null);
  assert.equal(fileRole('api/openapi.yaml'), 'maybe_spec');
  assert.equal(normImage('docker.io/library/postgres:16-alpine'), 'postgres');
  assert.equal(normImage('ghcr.io/home-assistant/home-assistant:stable@sha256:abc'), 'ghcr.io/home-assistant/home-assistant');
});

test('R-WB-02: tool names: write-like by verb in any word of snake, kebab, dotted or camel case', () => {
  assert.deepEqual(toolWords('createIssue'), ['create', 'issue']);
  assert.ok(writeLike('create_issue') && writeLike('issues.update') && writeLike('run-query') && writeLike('sendMessage'));
  assert.ok(!writeLike('list_tables') && !writeLike('get_issue') && !writeLike('search'));
});

// ---------------------------------------------------------------- classification

test('R-WB-03: a Postgres server (driver, connection URL, compose image, write tool) is local_full with the Postgres stand-in, high confidence', () => {
  const v = classify({
    'package.json': pkg({ pg: '^8', '@modelcontextprotocol/sdk': '1' }),
    '.env.example': 'DATABASE_URL=postgresql://user:s3cretvalue@localhost:5432/app\nPORT=3000\n',
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
    'src/index.ts': "server.tool('insert_row', {}, async () => {});\nserver.tool('list_tables', {}, async () => {});\nconst url = process.env.DATABASE_URL;\n",
  });
  assert.equal(v.class, 'local_full');
  assert.equal(v.mode, 'full');
  assert.deepEqual(v.backend, { id: 'postgres', kind: 'sql' });
  assert.equal(v.stand_in.id, 'postgres');
  assert.equal(v.confidence, 'high');
  assert.equal(v.spec_url, null);
  assert.ok(v.evidence.some((e) => e.signal === 'dependency' && e.detail === 'pg'));
  assert.ok(v.evidence.some((e) => e.signal === 'compose_image' && e.detail === 'postgres'));
  assert.ok(v.evidence.some((e) => e.signal === 'url_scheme' && e.detail === 'postgresql://'));
  assert.deepEqual(v.write_tools, { names_seen: 2, write_like: 1, sample: ['insert_row', 'list_tables'] });
  assert.ok(!JSON.stringify(v).includes('s3cretvalue'), 'an env value is never kept');
  assert.deepEqual(v.env_names, ['DATABASE_URL', 'PORT']);
});

test('R-WB-03: hosted APIs with a published description are mock_min with the vendor\'s spec URL; GitHub too (Gitea is not faithful)', () => {
  const slack = classify({ 'package.json': pkg({ '@slack/web-api': '7' }), 'src/a.ts': "server.tool('send_message', {}, f);\nprocess.env.SLACK_BOT_TOKEN;\n" });
  assert.equal(slack.class, 'mock_min');
  assert.equal(slack.backend.id, 'slack');
  assert.equal(slack.spec_url, SPEC_URLS.services.slack.spec.url);
  assert.equal(slack.spec_format, 'swagger2');
  assert.equal(slack.stand_in, null);
  const gh = classify({ 'package.json': pkg({ '@octokit/rest': '20' }), 'src/a.ts': "server.tool('create_issue', {}, f);\nfetch('https://api.github.com/repos');\nprocess.env.GITHUB_PERSONAL_ACCESS_TOKEN;\n" });
  assert.equal(gh.class, 'mock_min');
  assert.equal(gh.backend.id, 'github');
  assert.equal(gh.confidence, 'high');
  const py = classify({ 'pyproject.toml': '[project]\ndependencies = ["notion-client>=2"]\n', 'server.py': '@mcp.tool()\nasync def create_page(title: str):\n    ...\n' });
  assert.equal(py.class, 'mock_min');
  assert.equal(py.backend.id, 'notion');
  assert.deepEqual(py.write_tools.sample, ['create_page']);
});

test('R-WB-03: none says why: a stand-in not cleared, no stand-in, not a store, no backend at all, no write tools', () => {
  const mssql = classify({ 'package.json': pkg({ mssql: '10' }), 'src/a.ts': "server.tool('execute_sql', {}, f);\n" });
  assert.deepEqual([mssql.class, mssql.reason, mssql.backend.id], ['none', 'stand_in_not_cleared', 'mssql']);
  const pinecone = classify({ 'package.json': pkg({ '@pinecone-database/pinecone': '3' }), 'src/a.ts': "server.tool('upsert_vectors', {}, f);\n" });
  assert.deepEqual([pinecone.class, pinecone.reason], ['none', 'no_stand_in']);
  const browser = classify({ 'package.json': pkg({ playwright: '1' }), 'src/a.ts': "server.tool('click', {}, f);\nserver.tool('fill_form', {}, f);\n" });
  assert.deepEqual([browser.class, browser.reason], ['none', 'not_a_store']);
  const telegram = classify({ 'package.json': pkg({ telegraf: '4' }), 'src/a.ts': "server.tool('send_message', {}, f);\n" });
  assert.deepEqual([telegram.class, telegram.reason, telegram.backend.id], ['none', 'hosted_without_spec', 'telegram']);
  const unknown = classify({ 'src/a.ts': "server.tool('create_order', {}, f);\nfetch('https://api.acme-shop.io/v1/orders');\nprocess.env.ACME_API_KEY;\n" });
  assert.deepEqual([unknown.class, unknown.reason, unknown.confidence], ['none', 'hosted_without_spec', 'low']);
  assert.ok(!JSON.stringify(unknown).includes('acme-shop'), 'an unknown host is counted, never kept');
  const llm = classify({ 'package.json': pkg({ openai: '4', zod: '3' }), 'src/a.ts': "server.tool('summarize', {}, f);\nprocess.env.OPENAI_API_KEY;\n" });
  assert.deepEqual([llm.class, llm.reason, llm.backend], ['none', 'no_backend_signal', null]);
  const ro = classify({ 'package.json': pkg({ pg: '8' }), 'src/a.ts': "server.tool('list_tables', {}, f);\nserver.tool('describe_table', {}, f);\nserver.tool('get_rows', {}, f);\n" });
  assert.deepEqual([ro.class, ro.reason], ['none', 'no_write_tools_seen']);
  assert.ok(ro.backends.some((b) => b.id === 'postgres'), 'the backend is still listed');
});

test('R-WB-03: a repository OpenAPI file makes mock_min when nothing else is found, pinned to the commit; the Swagger Petstore sample does not', () => {
  const v = classify({ 'spec/openapi.yaml': 'openapi: 3.0.1\ninfo:\n  title: Acme API\nservers:\n  - url: https://api.acme.example\npaths: {}\n', 'src/a.ts': "server.tool('create_widget', {}, f);\n" });
  assert.equal(v.class, 'mock_min');
  assert.deepEqual(v.backend, { id: 'repo-openapi', kind: 'hosted_api' });
  assert.equal(v.spec_url, `https://raw.githubusercontent.com/acme/server/${SHA}/spec/openapi.yaml`);
  assert.equal(v.spec_format, 'openapi3');
  const pet = classify({ 'examples-not/petstore.json': '{"openapi": "3.0.0", "info": {"title": "Swagger Petstore"}}', 'src/a.ts': "server.tool('create_pet', {}, f);\n" });
  assert.deepEqual([pet.class, pet.reason], ['none', 'no_backend_signal']);
  const noCommit = classify({ 'openapi.json': '{"openapi": "3.1.0", "paths": {}}', 'src/a.ts': "server.tool('create_widget', {}, f);\n" }, { commit: null });
  assert.equal(noCommit.class, 'none', 'no commit, no pinned URL: never a moving spec');
});

test('R-WB-03: Python decorators, Go and Rust registrations, Prisma providers and generic ORMs', () => {
  const py = classify({ 'requirements.txt': 'psycopg[binary]\nmcp\n', 'app/server.py': '@mcp.tool(name="insert_rows")\ndef ins(rows):\n    pass\n\n@server.tool()\nasync def list_tables():\n    pass\n' });
  assert.equal(py.backend.id, 'postgres');
  assert.deepEqual(py.write_tools, { names_seen: 2, write_like: 1, sample: ['insert_rows', 'list_tables'] });
  const go = classify({ 'go.mod': 'module x\nrequire github.com/redis/go-redis/v9 v9.5.0\n', 'main.go': 's.AddTool(mcp.NewTool("set_key"), h)\nos.Getenv("REDIS_URL")\n' });
  assert.deepEqual([go.class, go.backend.id, go.stand_in.id], ['local_full', 'redis', 'redis']);
  assert.deepEqual(go.base_url_env, ['REDIS_URL']);
  const rs = classify({ 'Cargo.toml': '[dependencies]\nrusqlite = "0.31"\n', 'src/main.rs': '#[tool(description = "x")]\npub async fn add_note(&self) {}\n' });
  assert.deepEqual([rs.backend.id, rs.write_tools.sample[0]], ['sqlite', 'add_note']);
  const prisma = classify({ 'package.json': pkg({ '@prisma/client': '5' }), 'prisma/schema.prisma': 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n', 'src/a.ts': "server.tool('create_user', {}, f);\n" });
  assert.equal(prisma.backend.id, 'mysql');
  assert.ok(!prisma.backends.some((b) => b.id === 'sql' && b.role !== 'candidate'), 'the generic entry stands aside for the engine');
  const orm = classify({ 'pyproject.toml': '[project]\ndependencies = ["sqlalchemy"]\n', 'srv.py': '@mcp.tool\ndef add_item():\n    pass\n' });
  assert.deepEqual([orm.class, orm.backend.id, orm.confidence], ['local_full', 'sql', 'medium']);
});

test('R-WB-03: the filesystem is a backend only with file writes AND a file-shaped write tool (FS_RULE)', () => {
  const fsv = classify({ 'src/a.ts': "import fs from 'node:fs';\nfs.writeFile(p, d);\nfs.mkdir(p);\nserver.tool('write_file', {}, f);\nserver.tool('read_file', {}, f);\n" });
  assert.deepEqual([fsv.class, fsv.backend.id, fsv.stand_in.id], ['local_full', 'filesystem', 'tmpdir']);
  const cache = classify({ 'src/a.ts': "fs.writeFileSync(cachePath, d);\nserver.tool('create_issue', {}, f);\n" });
  assert.equal(cache.class, 'none', 'a cache file is not a backend');
});

test('R-WB-03: weak signals alone find nothing: a dev dependency, a code token under test/, a README mention, an env prefix', () => {
  const v = classify({
    'package.json': pkg({}, { pg: '8' }),
    'test/db.test.ts': "import pg from 'pg'; const u = 'postgres://localhost/test';\n",
    'README.md': 'Set POSTGRES_URL to postgres://you@host/db\n',
    'src/a.ts': "server.tool('create_thing', {}, f);\nprocess.env.PG_SOMETHING;\n",
  });
  assert.equal(v.class, 'none');
  assert.ok(v.backends.every((b) => b.role === 'candidate'));
});

test('R-WB-03: two backends with the same score and different modes are low confidence; root files cap it at medium', () => {
  const tie = classify({ 'package.json': pkg({ pg: '8', '@slack/web-api': '7' }), 'src/a.ts': "server.tool('create_x', {}, f);\n" });
  assert.equal(tie.confidence, 'low');
  // Root files hold no tool registrations, so the write tools cannot be checked against the backend: low, never routed (R-WB-22).
  const root = classify({ 'package.json': pkg({ pg: '8' }), '.env.example': 'DATABASE_URL=postgres://h/d\n' }, { source: 'root_files' });
  assert.deepEqual([root.class, root.confidence, root.basis.source, root.routable], ['local_full', 'low', 'root_files', false]);
});

test('R-WB-04: env names only, never values: base-URL knobs first; README names only when they configure a backend', () => {
  const v = classify({
    '.env.example': 'API_TOKEN=abc123secretvalue\nACME_BASE_URL=https://api.acme.example\nLOG_LEVEL=debug\n',
    'server.json': JSON.stringify({ packages: [{ environmentVariables: [{ name: 'ACME_HOST', value: 'zzz-not-kept' }] }] }),
    'README.md': 'Export ACME_API_KEY and RANDOM_WORD and MAX_RETRIES\n',
    'src/a.py': 'os.environ.get("ACME_ENDPOINT")\nos.getenv("TIMEOUT_SECONDS")\n',
  });
  assert.deepEqual(v.base_url_env, ['ACME_BASE_URL', 'ACME_ENDPOINT', 'ACME_HOST']);
  assert.deepEqual(v.env_names.slice(0, 3), v.base_url_env);
  assert.ok(v.env_names.includes('ACME_API_KEY') && v.env_names.includes('API_TOKEN') && v.env_names.includes('TIMEOUT_SECONDS'));
  assert.ok(!v.env_names.includes('RANDOM_WORD') && !v.env_names.includes('MAX_RETRIES'), 'README words that are not configuration');
  const text = JSON.stringify(v);
  assert.ok(!text.includes('abc123secretvalue') && !text.includes('zzz-not-kept') && !text.includes('api.acme.example'));
  assert.ok(BASE_URL_ENV_RE.test('GITLAB_API_URL') && !BASE_URL_ENV_RE.test('GITLAB_TOKEN'));
});

// ---------------------------------------------------------------- mutation checks

test('R-WB-05: mutation check: each routing rule, switched in the map, changes the class the tests above pin', () => {
  const gh = { 'package.json': pkg({ '@octokit/rest': '20' }), 'src/a.ts': "server.tool('create_issue', {}, f);\n" };
  assert.equal(classify(gh).class, 'mock_min');
  // If Gitea were faithful for GitHub, GitHub servers would go to full mode: the shipped map says it is not.
  assert.equal(classify(gh, { maps: mutated((s) => { s.backends.github.stand_in.fidelity = 'real'; }) }).class, 'local_full');
  const ms = { 'package.json': pkg({ mssql: '10' }), 'src/a.ts': "server.tool('execute_sql', {}, f);\n" };
  assert.equal(classify(ms).class, 'none');
  // cleared is what keeps an uncleared licence out of full mode.
  assert.equal(classify(ms, { maps: mutated((s) => { s.backends.mssql.stand_in.cleared = true; }) }).class, 'local_full');
  // A spec removed (null, with the date it was looked for) sends a hosted API to none (hosted_without_spec), never to a failure.
  const sl = { 'package.json': pkg({ '@slack/web-api': '7' }), 'src/a.ts': "server.tool('send_message', {}, f);\n" };
  const noSpec = classify(sl, { maps: mutated((s, u) => { u.services.slack.spec = null; u.services.slack.note = 'none found on 2026-11-27'; }) });
  assert.deepEqual([noSpec.class, noSpec.reason], ['none', 'hosted_without_spec']);
});

// ---------------------------------------------------------------- the lane

const top = (sha) => `server-${sha}`;
/** A codeload tar.gz of {path: text} under the archive's top folder, with the commit in a pax global header. */
function archive(files, sha = SHA) {
  const entries = Object.entries(files).map(([p, d], i) => ({ name: `${top(sha)}/${p}`, data: d, ...(i === 0 ? { pax: { comment: sha }, paxType: 'g' } : {}) }));
  return makeTgz(entries);
}
function mockFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, redirect: init.redirect });
    const r = routes.find((x) => url.startsWith(x.prefix));
    if (!r) return new Response('404: Not Found', { status: 404 });
    if (typeof r.respond === 'function') return r.respond(url, init);
    return new Response(r.status && r.status >= 300 && r.status < 400 ? null : r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  f.calls = calls;
  return f;
}
const http = (fetch) => createHttp({ fetch, cache: createCache(), retries: 0, sleep: async () => {} });

const KRONICLE = {
  'package.json': pkg({ 'better-sqlite3': '^12.6.0', '@modelcontextprotocol/server': '^2.4.0', zod: '^4' }),
  // As kronicle-lite registers them: a bound registerTool with the name on the next line.
  'src/server.ts': "const registerTool = server.registerTool.bind(server);\nregisterTool(\n    'put_document',\n    {}, f);\nregisterTool(\n    'get_system_state', {}, f);\nprocess.env.KRONICLE_DB_PATH;\n",
};

test('R-WB-06: collectSubject reads the archive at HEAD (or the pin), reports its commit, and asks nothing of any other host', async () => {
  const f = mockFetch([{ prefix: 'https://codeload.github.com/acme/server/tar.gz/HEAD', body: archive({ ...KRONICLE, 'node_modules/pg/package.json': pkg({}) }) }]);
  const c = await collectSubject(http(f), 'acme/server');
  assert.equal(c.value.class, 'local_full');
  assert.equal(c.value.backend.id, 'sqlite');
  assert.equal(c.value.basis.commit, SHA);
  assert.equal(c.sha, SHA);
  assert.equal(c.value.basis.source, 'archive');
  assert.deepEqual(c.skips, []);
  assert.ok(f.calls.every((x) => x.redirect === 'manual'));
  const pinned = mockFetch([{ prefix: `https://codeload.github.com/acme/server/tar.gz/${KRONICLE_PIN}`, body: archive(KRONICLE, KRONICLE_PIN) }]);
  const p = await collectSubject(http(pinned), 'acme/server', { pins: { 'acme/server': KRONICLE_PIN } });
  assert.equal(p.sha, KRONICLE_PIN);
  assert.ok(!allowedUrl('https://evil.example/x') && !allowedUrl('http://codeload.github.com/x') && allowedUrl('https://raw.githubusercontent.com/a/b/HEAD/x'));
});

test('R-WB-06: a missing repository is data (null with why); throttling and outages are retryable infra skips; a redirect is ours, retried; a takedown is the subject\'s', async () => {
  const gone = await collectSubject(http(mockFetch([])), 'acme/none');
  assert.equal(gone.value, null);
  assert.match(gone.why, /not found/);
  assert.deepEqual(gone.skips, []);
  const limited = await collectSubject(http(mockFetch([{ prefix: 'https://codeload.github.com/', status: 429 }])), 'acme/x');
  assert.deepEqual(limited.skips, [{ stage: 'archive', reason: 'rate_limited', fault: 'infra', retryable: true }]);
  const down = await collectSubject(http(mockFetch([{ prefix: 'https://codeload.github.com/', status: 502 }])), 'acme/x');
  assert.deepEqual(down.skips, [{ stage: 'archive', reason: 'upstream_unavailable', fault: 'infra', retryable: true }]);
  const moved = await collectSubject(http(mockFetch([{ prefix: 'https://codeload.github.com/', status: 302, headers: { location: 'https://codeload.github.com/other/x/tar.gz/HEAD' } }])), 'acme/x');
  assert.deepEqual(moved.skips, [{ stage: 'archive', reason: 'upstream_unavailable', fault: 'tool', retryable: true }]);
  const dmca = await collectSubject(http(mockFetch([{ prefix: 'https://codeload.github.com/', status: 451, body: '{"message":"Repository access blocked","block":{"reason":"dmca"}}' }])), 'acme/x');
  assert.deepEqual(dmca.skips, [{ stage: 'archive', reason: 'upstream_unavailable', fault: 'subject' }]);
});

test('R-WB-06: an archive over our caps is read again as root files (basis root_files, at most medium); with none readable it is a too_large skip of ours', async () => {
  // Small caps for the test (the shipped ones are LIMITS.archive): an archive of incompressible bytes is over them.
  const caps = { ...LIMITS.archive, maxCompressedBytes: 4096 };
  const huge = archive({ 'package.json': pkg({ pg: '8' }), 'blob.bin': randomBytes(16384) });
  assert.ok(huge.length > caps.maxCompressedBytes);
  const f = mockFetch([
    { prefix: 'https://codeload.github.com/', body: huge },
    { prefix: 'https://raw.githubusercontent.com/acme/big/HEAD/package.json', body: pkg({ pg: '8' }) },
    { prefix: 'https://raw.githubusercontent.com/acme/big/HEAD/.env.example', body: 'DATABASE_URL=postgres://h/d\n' },
  ]);
  const c = await collectSubject(http(f), 'acme/big', { archiveLimits: caps });
  assert.equal(c.stages.archive, 'too_large');
  assert.equal(c.stages.root_files, 2);
  assert.deepEqual([c.value.class, c.value.basis.source, c.value.confidence, c.value.routable], ['local_full', 'root_files', 'low', false]);
  assert.deepEqual(c.skips, []);
  const none = await collectSubject(http(mockFetch([{ prefix: 'https://codeload.github.com/', body: huge }])), 'acme/big', { archiveLimits: caps });
  assert.equal(none.value, null);
  assert.deepEqual(none.skips, [{ stage: 'archive', reason: 'too_large', fault: 'tool' }]);
});

test('R-WB-07: the lane end to end: known answer, forgery contained, one write_backend record per item, judged as ingest would', async () => {
  const lane = laneOf('meta-backend');
  const items = [
    { subject: 'acme/pg-server', run_key: runKey(1), fence: 1 },
    { subject: 'acme/none', run_key: runKey(2), fence: 2 },
    { subject: 'gitlab.com/x/y', run_key: runKey(3), fence: 3 },
  ];
  const f = mockFetch([
    { prefix: `https://codeload.github.com/isokron-ai/kronicle-lite/tar.gz/${KRONICLE_PIN}`, body: archive(KRONICLE, KRONICLE_PIN) },
    { prefix: 'https://codeload.github.com/acme/pg-server/tar.gz/HEAD', body: archive({ 'package.json': pkg({ pg: '8' }), 'src/a.ts': "server.tool('insert_row', {}, f);\n" }) },
  ]);
  const out = mkdtempSync(join(tmpdir(), 'wb-'));
  const env = { SHARD_ID: 'meta-backend-1', ATTEMPT_ID: 'att-1', ITEMS: JSON.stringify(items), GITHUB_SHA: 'f'.repeat(40) };
  const { outputs } = await runShard({ laneName: 'meta-backend', out, env, fetch: f, sleep: async () => {} });
  assert.deepEqual(outputs.map((o) => o.outcome), ['read', 'read', 'not_a_github_repository']);
  const meta0 = JSON.parse(readFileSync(join(out, '0', 'meta.json'), 'utf8'));
  assert.deepEqual(meta0.tools, TOOLS.map((t) => ({ ...t })));
  assert.equal(meta0.subject.sha, SHA, 'the commit the archive was read at');
  assert.deepEqual(meta0.controls.map((c) => `${c.kind}=${c.observed}`), ['known_good=match', 'forgery=contained']);
  const recs = readFileSync(join(out, '0', 'bundle', 'observations', 'meta-backend.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((r) => r.field), [FIELD]);
  assert.equal(recs[0].value.class, 'local_full');
  const none = JSON.parse(readFileSync(join(out, '1', 'bundle', 'observations', 'meta-backend.ndjson'), 'utf8').trim());
  assert.equal(none.value, null);
  // Judged as ingest would: with the field the mcp-results declaration adds, every bundle is accepted ...
  const reg = withPendingField(pinnedRegistry());
  for (const [i, it] of items.entries()) {
    const v = judgeItem(join(out, String(i)), { attemptId: 'att-1', fence: it.fence, runKey: it.run_key, registry: reg });
    assert.equal(v.outcome, 'accepted', `item ${i}: ${JSON.stringify(v.problems?.slice(0, 3))}`);
  }
  // ... and against today's pin it is refused as an undeclared field: why the lane stays off until the pin moves.
  if (!pinnedRegistry().fields.has(FIELD)) {
    const v = judgeItem(join(out, '0'), { attemptId: 'att-1', fence: 1, runKey: runKey(1) });
    assert.notEqual(v.outcome, 'accepted');
  }
});

test('R-WB-07: the known-answer control matches our own kronicle-lite at its pin, and a different class is a mismatch', async () => {
  const lane = laneOf('meta-backend');
  const spec = loadKnownAnswer();
  assert.deepEqual(spec['meta-backend'].pins, { 'isokron-ai/kronicle-lite': KRONICLE_PIN });
  const good = mockFetch([{ prefix: `https://codeload.github.com/isokron-ai/kronicle-lite/tar.gz/${KRONICLE_PIN}`, body: archive(KRONICLE, KRONICLE_PIN) }]);
  const k = await knownAnswerControl(lane, { http: http(good), token: null, budget: null, spec });
  assert.equal(k.control.observed, 'match');
  const bad = mockFetch([{ prefix: 'https://codeload.github.com/isokron-ai/kronicle-lite/', body: archive({ 'package.json': pkg({ '@slack/web-api': '7' }), 'a.ts': "server.tool('send_x', {}, f);\n" }, KRONICLE_PIN) }]);
  assert.equal((await knownAnswerControl(lane, { http: http(bad), token: null, budget: null, spec })).control.observed, 'mismatch');
  const limited = mockFetch([{ prefix: 'https://codeload.github.com/', status: 429 }]);
  assert.equal((await knownAnswerControl(lane, { http: http(limited), token: null, budget: null, spec })).unavailable, 'rate_limited');
  const forgery = await forgeryControl(lane);
  assert.equal(forgery.control.observed, 'contained', forgery.files['controls/forgery.json']);
});

test('R-WB-08: the pending registry entry is the one mcp-results declares (P-s, R1, planned), and it is dropped once ingest\'s pin holds the field', () => {
  const reg = withPendingField(pinnedRegistry());
  const e = reg.fields.get(FIELD);
  assert.deepEqual([e.layer, e.type, e.unit, e.source, e.class, e.redaction, e.status], ['source_build', 'object', 'none', 'meta-backend', 'P-s', ['R1'], 'planned']);
  assert.match(PENDING_FIELD_YAML, /id: write_backend/);
  const held = { ...reg, pending: undefined };
  assert.equal(withPendingField(held), held, 'a registry that holds the field is used as it is');
});

test('R-WB-09: the dry run\'s frame is the seed, then discover candidates in the pump\'s walk order (class, then hash), with no repeat; its sample covers every class', async () => {
  const { frameSubjects, summarize } = await import('../dryrun-backend.mjs');
  const seed = { subjects: [{ id: 'a/one' }, { id: 'b/two' }] };
  const cands = [
    { name: 'z/late', class: 2, hash: '0'.repeat(64) },
    { name: 'B/Two', class: 0, hash: '1'.repeat(64) },
    { name: 'c/three', class: 0, hash: '2'.repeat(64) },
    { name: 'd/four', class: 1, hash: '0'.repeat(64) },
    { name: 'not a repo', class: 0, hash: '0'.repeat(64) },
  ];
  assert.deepEqual(frameSubjects(seed, cands, 2), ['a/one', 'b/two', 'c/three', 'd/four']);
  assert.deepEqual(frameSubjects(seed, cands, 0), ['a/one', 'b/two']);
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ subject: `l/${i}`, class: 'local_full', backend: 'postgres', confidence: 'high', evidence: [] })),
    ...Array.from({ length: 10 }, (_, i) => ({ subject: `m/${i}`, class: 'mock_min', backend: 'github', confidence: 'medium', evidence: [] })),
    ...Array.from({ length: 10 }, (_, i) => ({ subject: `n/${i}`, class: 'none', reason: 'no_backend_signal', backend: null, confidence: 'medium', evidence: [] })),
    { subject: 'x/unread', class: null, reason: 'the source archive could not be read', skips: [{ stage: 'archive' }], evidence: [] },
  ];
  const s = summarize(rows);
  assert.deepEqual(s.by.class, { local_full: 10, mock_min: 10, none: 10, unread: 1 });
  assert.deepEqual(s.by.reason, { no_backend_signal: 10, unread: 1 });
  assert.equal(s.sample.length, 20);
  assert.deepEqual(['local_full', 'mock_min', 'none'].map((c) => s.sample.filter((r) => r.class === c).length), [8, 6, 6]);
  assert.equal(s.skipped, 1);
});

test('R-WB-14: hostile configuration costs bounded time: blank-line compose and env files, unclosed pom dependencies, repeated setup.py lists, an open Prisma block', () => {
  const big = (unit, n) => unit.repeat(n);
  const cases = {
    'docker-compose.yml': big('\n', 2 * 1024 * 1024),
    '.env.example': big('\n \n', 700_000),
    'pom.xml': big('<dependency><groupId>x', 100_000),
    'setup.py': big('install_requires=[', 100_000),
    'schema.prisma': `${big('datasource db {', 50_000)}`,
    'README.md': big('A_B_C_D_E_F_G_', 80_000),
    // One long line each (no newline at all), and heads of newlines (Opus review of #126: 50 to 80 s each before).
    'pyproject.toml': `a${' '.repeat(250_000)}b`,
    'build.gradle': `implementation${' '.repeat(250_000)}x`,
    'compose.yaml': `${' '.repeat(250_000)}-${' '.repeat(5000)}`,
    'api/openapi.yaml': `${'\n'.repeat(4000)}openapi: 3.0.0`,
    'spec.json': `${'\n \t'.repeat(1500)}{`,
    'requirements-dev.txt': `x${' '.repeat(250_000)}#`,
  };
  for (const [p, t] of Object.entries(cases)) {
    const t0 = Date.now();
    classify({ [p]: t });
    assert.ok(Date.now() - t0 < 3000, `${p}: ${Date.now() - t0} ms`);
  }
  // Configuration is read in its first 256 KiB only: what comes after is not seen.
  const late = classify({ '.env.example': `${'#'.repeat(300 * 1024)}\nLATE_DB_URL=postgres://h/d\n`, '.env.sample': 'EARLY_DB_URL=x\n' });
  assert.ok(late.env_names.includes('EARLY_DB_URL') && !late.env_names.includes('LATE_DB_URL'));
});

test('R-WB-15: env names the runtime, the shell or the runner own are never kept or sent, whatever a repository reads', () => {
  const denied = ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'PYTHONPATH', 'RUNNER_TEMP', 'GITHUB_TOKEN', 'GITHUB_STATE', 'GITHUB_SERVER_URL', 'GITHUB_API_URL', 'GITHUB_GRAPHQL_URL',
    'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'DOCKER_HOST', 'DOCKER_CONFIG', 'GOFLAGS', 'GOPROXY', 'CGO_ENABLED', 'DOTNET_ROOT', 'NUGET_PACKAGES', 'COREPACK_HOME', 'BUN_INSTALL', 'DENO_DIR',
    'JAVA_TOOL_OPTIONS', 'MAVEN_OPTS', 'GRADLE_OPTS', 'EDITOR', 'VISUAL', 'PAGER', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'GIT_SSL_NO_VERIFY', 'GIT_HOOKS_PATH', 'PERL5OPT', 'RUBYOPT', 'GEM_HOME', 'BUNDLE_GEMFILE', 'AGENT_TOOLSDIRECTORY'];
  const code = `${[...denied, 'ACME_BASE_URL', 'GOOGLE_API_KEY', 'GITLAB_TOKEN', 'GIT_REPO_PATH'].map((n) => `process.env.${n};`).join('\n')}\nserver.tool('create_x', {}, f);\n`;
  const v = classify({ 'src/a.ts': code });
  assert.deepEqual(v.env_names, ['ACME_BASE_URL', 'GIT_REPO_PATH', 'GITLAB_TOKEN', 'GOOGLE_API_KEY'].sort((a, b) => (BASE_URL_ENV_RE.test(b) - BASE_URL_ENV_RE.test(a)) || (a < b ? -1 : 1)));
  for (const n of denied) assert.ok(!v.env_names.includes(n), n);
  // The maps cannot name one either.
  assert.match(mapProblems({ ...STAND_INS, backends: { ...STAND_INS.backends, bad: { kind: 'sql', stand_in: STAND_INS.backends.postgres.stand_in, signals: { env: ['LD_PRELOAD'] } } } }, SPEC_URLS).join(), /LD_PRELOAD is not an env var name we keep/);
});

test('R-WB-16: the filesystem is a fallback: a SQLite server that also writes files is SQLite\'s (kronicle-lite\'s shape); dev extras are dev; the repository spec is picked by path', () => {
  const v = classify({ 'package.json': pkg({ 'better-sqlite3': '12' }), 'src/a.ts': "fs.mkdirSync(dir);\nregisterTool(\n 'write_file', {}, f);\n" });
  assert.deepEqual([v.class, v.backend.id], ['local_full', 'sqlite']);
  assert.ok(v.backends.some((b) => b.id === 'filesystem' && b.role === 'secondary'));
  assert.deepEqual(manifestDeps('pyproject', '[project.optional-dependencies]\ndev = ["psycopg"]\nserver = ["redis"]\n').map((d) => `${d.name}${d.dev ? ':dev' : ''}`), ['psycopg:dev', 'redis']);
  const spec = '{"openapi": "3.0.0", "paths": {}}';
  const a = classify({ 'z/long/path/openapi.json': spec, 'api/openapi.json': spec, 'src/a.ts': "server.tool('create_x', {}, f);\n" });
  const b = classify({ 'api/openapi.json': spec, 'z/long/path/openapi.json': spec, 'src/a.ts': "server.tool('create_x', {}, f);\n" });
  assert.equal(a.spec_url, b.spec_url);
  assert.match(a.spec_url, /\/api\/openapi\.json$/);
});

test('R-WB-18: a backend the repository declares outranks one it only mentions: a secret guard\'s postgres:// pattern does not make a SQLite server a Postgres one (kronicle-lite, 28 Nov)', () => {
  const v = classify({
    'package.json': pkg({ 'better-sqlite3': '12' }),
    'src/secrets/guard.ts': "const PATTERNS = [/postgres:\\/\\/[^\\s]+/, 'postgres://user:password@localhost:5432/d'];\nconst k = process.env.PG_URL;\n",
    'src/server.ts': "registerTool(\n 'put_document', {}, f);\n",
  });
  assert.deepEqual([v.class, v.backend.id, v.stand_in.id], ['local_full', 'sqlite', 'sqlite']);
  assert.ok(v.backends.some((b) => b.id === 'postgres' && b.score > v.backends.find((x) => x.id === 'sqlite').score), 'postgres scored higher, and still ranks below');
});

test('R-WB-19: tool names in FastMCP decorators whose arguments span lines and nest parentheses (mysql-mcp-server, dry run 28 Nov)', () => {
  const v = classify({
    'pyproject.toml': '[project]\ndependencies = ["mysql-connector-python"]\n',
    'src/server.py': '@mcp.tool(\n    name="mysql_list_tables",\n    annotations=ToolAnnotations(title="List", readOnlyHint=True),\n)\ndef list_tables():\n    pass\n\n@mcp.tool(\n    name="mysql_insert_row",\n    annotations=ToolAnnotations(destructiveHint=False),\n)\nasync def insert_row():\n    pass\n',
  });
  assert.deepEqual(v.write_tools, { names_seen: 2, write_like: 1, sample: ['mysql_insert_row', 'mysql_list_tables'] });
  assert.deepEqual([v.class, v.backend.id], ['local_full', 'mysql']);
});

test('R-WB-20: one subject\'s scan runs in a worker thread with a wall-clock limit: past it the subject gets a reader_limit skip of ours, the shard goes on', async () => {
  const f = mockFetch([{ prefix: 'https://codeload.github.com/acme/slow/', body: archive(KRONICLE) }, { prefix: 'https://codeload.github.com/acme/fine/', body: archive(KRONICLE) }]);
  const slow = await collectSubject(http(f), 'acme/slow', { scanTimeoutMs: 1 });
  assert.equal(slow.value, null);
  assert.deepEqual(slow.skips, [{ stage: 'scan', reason: 'reader_limit', fault: 'tool' }]);
  assert.match(slow.why, /time limit/);
  const fine = await collectSubject(http(f), 'acme/fine');
  assert.equal(fine.value.class, 'local_full', 'the next subject is scanned as usual');  // The root-file fallback is scanned in the same way.
  const caps = { ...LIMITS.archive, maxCompressedBytes: 64 };
  const g = mockFetch([{ prefix: 'https://codeload.github.com/', body: archive({ 'blob.bin': randomBytes(4096) }) }, { prefix: 'https://raw.githubusercontent.com/acme/big/HEAD/package.json', body: pkg({ pg: '8' }) }]);
  const root = await collectSubject(http(g), 'acme/big', { archiveLimits: caps, scanTimeoutMs: 1 });
  assert.deepEqual([root.stages.archive, root.value, root.skips], ['too_large', null, [{ stage: 'scan', reason: 'reader_limit', fault: 'tool' }]]);
});

test('R-WB-21: precision rules: development requirements, a cache in compose next to a hosted API, a model SDK of a cloud vendor, and release or CI tooling are not the backend', () => {
  // requirements-dev.txt, requirements-test.in and dev.in are dev dependencies.
  const dev = classify({ 'requirements-dev.txt': 'psycopg\n', 'requirements_test.in': 'pymongo\n', 'dev.in': 'redis\n', 'requirements.txt': 'mcp\n', 'srv.py': '@mcp.tool\ndef add_item():\n    pass\n' });
  assert.equal(dev.class, 'none');
  // Redis as a cache in compose beside a Slack server: Slack's.
  const cache = classify({ 'package.json': pkg({ '@slack/web-api': '7', ioredis: '5' }), 'docker-compose.yml': 'services:\n  cache:\n    image: redis:7\n', '.env.example': 'REDIS_URL=redis://cache:6379\n', 'src/a.ts': "server.tool('send_message', {}, f);\n" });
  assert.equal(cache.backend.id, 'slack');
  // boto3 used only for Bedrock: not an AWS server.
  const llm = classify({ 'pyproject.toml': '[project]\ndependencies = ["boto3", "mcp"]\n', 'srv.py': "client = boto3.client('bedrock-runtime')\nclient.invoke_model(body=b)\n@mcp.tool\ndef write_summary():\n    pass\n" });
  assert.ok(!llm.backends.some((b) => b.id === 'aws'), JSON.stringify(llm.backends));
  // The GitHub API and its token in an update check and in CI scripts: not GitHub as the backend of a SQLite server.
  const tooling = classify({
    'package.json': pkg({ 'better-sqlite3': '12' }),
    'src/update-check.ts': "fetch('https://api.github.com/repos/acme/x/releases/latest');\n",
    'scripts/release.mjs': "fetch('https://api.github.com/repos/acme/x/releases', { headers: { authorization: process.env.GITHUB_TOKEN } });\n",
    '.github/scripts/notify.js': "new Octokit({ auth: process.env.GH_TOKEN });\n",
    'src/server.ts': "server.tool('add_note', {}, f);\n",
  });
  assert.deepEqual([tooling.class, tooling.backend.id], ['local_full', 'sqlite']);
  assert.ok(!tooling.backends.some((b) => b.id === 'github' && b.signals.includes('host_literal')), 'release, update-check and CI code weighs as tooling');
});

test('R-WB-22: the write tools must plausibly touch the backend, or the class stays at low confidence and is not routed', () => {
  const sqlite = classify({ 'package.json': pkg({ 'better-sqlite3': '12' }), 'src/a.ts': "server.tool('add_note', {}, f);\n" });
  assert.deepEqual([sqlite.confidence !== 'low', sqlite.routable], [true, true]);
  const elsewhere = classify({ 'package.json': pkg({ 'better-sqlite3': '12' }), 'src/a.ts': "server.tool('send_invite', {}, f);\nserver.tool('post_tweet', {}, f);\n" });
  assert.deepEqual([elsewhere.class, elsewhere.confidence, elsewhere.routable], ['local_full', 'low', false]);
  const gh = classify({ 'package.json': pkg({ '@octokit/rest': '20' }), 'src/a.ts': "server.tool('generate_report', {}, f);\n" });
  assert.deepEqual([gh.class, gh.confidence, gh.routable], ['mock_min', 'low', false]);
  const ghOk = classify({ 'package.json': pkg({ '@octokit/rest': '20' }), 'src/a.ts': "server.tool('create_issue', {}, f);\n" });
  assert.equal(ghOk.routable, true);
  const noTools = classify({ 'package.json': pkg({ pg: '8' }), 'src/a.ts': 'const x = 1;\n' });
  assert.deepEqual([noTools.class, noTools.confidence, noTools.routable], ['local_full', 'low', false]);
  assert.ok(noTools.evidence.some((e) => /not routed/.test(e.detail)));
});

test('R-WB-23: a spec URL is one API\'s description file: no repository page, no directory of APIs; a hosted backend without one is never paired with the repository\'s own OpenAPI file', () => {
  assert.equal(SPEC_URLS.services.aws.spec, null);
  assert.equal(SPEC_URLS.services['google-workspace'].spec, null);
  const svc = (url, extra = {}) => ({ ...SPEC_URLS, services: { q: { name: 'q', spec: { url, format: 'openapi3', publisher: 'vendor', checked: '2026-11-28', ...extra }, signals: {} } } });
  assert.match(mapProblems(STAND_INS, svc('https://github.com/acme/api-models')).join(), /a page or a directory/);
  assert.match(mapProblems(STAND_INS, svc('https://www.googleapis.com/discovery/v1/apis')).join(), /a page or a directory/);
  assert.match(mapProblems(STAND_INS, svc('https://api.acme.example/docs')).join(), /does not end in a description file/);
  assert.deepEqual(mapProblems(STAND_INS, svc('https://api.acme.example/docs', { endpoint: true })), []);
  const tg = classify({ 'package.json': pkg({ telegraf: '4' }), 'openapi.json': '{"openapi": "3.0.0", "paths": {}}', 'src/a.ts': "server.tool('send_message', {}, f);\n" });
  assert.deepEqual([tg.class, tg.reason, tg.spec_url], ['none', 'hosted_without_spec', null]);
});

test('R-WB-24: the gold set is well formed, precision counts class and backend, and the dry run\'s markdown keeps repository text on one line', async () => {
  const { backendGoldClass, goldPrecision, markdown, summarize, ROUTING_PRECISION } = await import('../dryrun-backend.mjs');
  const gold = JSON.parse(readFileSync(new URL('./fixtures/backend-gold.json', import.meta.url), 'utf8'));
  assert.ok(gold.rows.length >= 45);
  for (const g of gold.rows) {
    assert.match(g.subject, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
    assert.ok([true, false, 'unknown'].includes(g.has_write_tools), g.subject);
    assert.ok(g.backend === 'none' || g.backend === 'not_found' || g.backend.startsWith('other:') || MAPS.table.has(g.backend), `${g.subject}: ${g.backend}`);
    assert.equal(typeof g.note, 'string');
  }
  assert.equal(ROUTING_PRECISION, 0.9);
  const g = { rows: [
    { subject: 'a/pg', has_write_tools: true, backend: 'postgres' }, { subject: 'a/gh', has_write_tools: true, backend: 'github' },
    { subject: 'a/ro', has_write_tools: false, backend: 'none' }, { subject: 'a/x', has_write_tools: true, backend: 'other:acme' },
  ] };
  assert.deepEqual(g.rows.map((r) => backendGoldClass(r, MAPS)), ['local_full', 'mock_min', 'none', 'none']);
  const p = goldPrecision([
    { subject: 'a/pg', class: 'local_full', backend: 'postgres', routable: true }, { subject: 'a/gh', class: 'local_full', backend: 'sqlite', routable: true },
    { subject: 'a/ro', class: 'none', backend: null }, { subject: 'a/x', class: 'mock_min', backend: 'slack', routable: false }, { subject: 'not/gold', class: 'local_full', backend: 'x' },
  ], g, MAPS);
  assert.deepEqual([p.classes.local_full.predicted, p.classes.local_full.correct, p.classes.local_full.routed_precision], [2, 1, 0.5]);
  assert.deepEqual([p.classes.mock_min.predicted, p.classes.mock_min.routed], [1, 0]);
  assert.equal(p.gate, false);
  const s = summarize([{ subject: 'o/r', class: 'local_full', backend: 'postgres', confidence: 'high', routable: true, evidence: ['dependency:postgres pg (a\nb|c.json)'] }]);
  const md = markdown({ ...s, gold: p });
  assert.ok(md.split('\n').filter((l) => l.startsWith('| o/r')).every((l) => l.endsWith('|') && !l.includes('a\nb')));
  assert.match(md, /Gate: \*\*not met\*\*/);
});
