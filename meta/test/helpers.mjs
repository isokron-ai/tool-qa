// Test helpers: mocked GitHub and registry APIs (no network), and judging a
// worker output with ingest's own checks against the pinned field registry.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildManifest, collectFiles, MANIFEST_NAME } from '../../worker-kit/contract.mjs';
import { writeTar } from '../../worker-kit/tar.mjs';
import { analyzeBundle } from '../../ingest/analyze.mjs';
import { parseRegistry, REGISTRY_SHA256 } from '../../ingest/registry.mjs';

export const REGISTRY_FILE = new URL('./fixtures/registry-pinned.yaml', import.meta.url);
export function pinnedRegistry() {
  const reg = parseRegistry(readFileSync(REGISTRY_FILE, 'utf8'));
  if (reg.sha256 !== REGISTRY_SHA256) throw new Error('the test copy of the field registry is not the one ingest pins');
  return { ...reg, source: 'test' };
}

const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });

/** A GraphQL repository node with sensible defaults. */
export function ghNode(over = {}) {
  return {
    databaseId: 1463720077, nameWithOwner: 'isokron-ai/mcp-check', isFork: false, isArchived: false, isDisabled: false,
    isTemplate: false, isMirror: false, isEmpty: false, isLocked: false, visibility: 'PUBLIC', parent: null,
    owner: { __typename: 'Organization', databaseId: 354617713, isVerified: true, createdAt: '2026-11-09T20:01:03Z' },
    createdAt: '2026-11-19T05:48:01Z', pushedAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z', diskUsage: 700,
    homepageUrl: 'https://isokron.ai/mcp-check', description: 'Grades a tool list.', primaryLanguage: { name: 'JavaScript' },
    licenseInfo: { spdxId: 'MIT', key: 'mit' },
    repositoryTopics: { totalCount: 2, nodes: [{ topic: { name: 'mcp' } }, { topic: { name: 'linter' } }] },
    stargazerCount: 5, forkCount: 1, watchers: { totalCount: 2 },
    hasIssuesEnabled: true, hasDiscussionsEnabled: false, hasWikiEnabled: true, hasProjectsEnabled: true,
    isSecurityPolicyEnabled: true, codeOfConduct: null, issueTemplates: [], pullRequestTemplates: [],
    defaultBranchRef: { name: 'main', target: { oid: 'a'.repeat(40) }, refUpdateRule: null },
    releases: {
      totalCount: 6,
      nodes: [
        { tagName: 'v1.3.1', publishedAt: '2026-11-22T19:51:07Z', createdAt: '2026-11-22T19:46:19Z', isPrerelease: false, isLatest: true, releaseAssets: { totalCount: 0 } },
        { tagName: 'v1.3.0', publishedAt: '2026-11-21T09:03:26Z', createdAt: '2026-11-21T09:03:26Z', isPrerelease: false, isLatest: false, releaseAssets: { totalCount: 0 } },
      ],
    },
    openIssues: { totalCount: 0 }, closedIssues: { totalCount: 1 }, openPRs: { totalCount: 1 }, mergedPRs: { totalCount: 20 }, closedPRs: { totalCount: 2 },
    rootTree: { entries: [{ name: 'README.md', type: 'blob' }, { name: 'LICENSE', type: 'blob' }, { name: 'SECURITY.md', type: 'blob' }, { name: 'CONTRIBUTING.md', type: 'blob' }] },
    githubTree: { entries: [{ name: 'dependabot.yml', type: 'blob' }, { name: 'workflows', type: 'tree' }, { name: 'CODEOWNERS', type: 'blob' }] },
    docsTree: null,
    workflowsTree: { entries: [{ name: 'ci.yml', type: 'blob' }, { name: 'release.yml', type: 'blob' }, { name: 'notes.md', type: 'blob' }] },
    ...over,
  };
}

/**
 * A fetch for the GitHub lane. `repos` maps owner/name -> GraphQL node (missing: NOT_FOUND).
 * `rest` overrides: (url) -> Response or undefined. Records every call in `calls`.
 */
export function githubFetch({ repos = {}, rest = () => undefined, graphql, remaining = 900, graphqlRemaining = 950 } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {} });
    if (url === 'https://api.github.com/graphql') {
      if (graphql) return graphql(init);
      const { variables } = JSON.parse(init.body);
      const data = { rateLimit: { cost: 1, remaining: graphqlRemaining, resetAt: '2026-11-24T01:00:00Z' } };
      const errors = [];
      for (let i = 0; variables[`o${i}`] !== undefined; i++) {
        const node = repos[`${variables[`o${i}`]}/${variables[`n${i}`]}`];
        if (node) data[`r${i}`] = node;
        else { data[`r${i}`] = null; errors.push({ type: 'NOT_FOUND', path: [`r${i}`], message: 'Could not resolve to a Repository' }); }
      }
      return json(errors.length ? { data, errors } : { data });
    }
    const over = rest(url, init);
    if (over) return over;
    const h = { 'x-ratelimit-remaining': String(remaining), etag: `"e-${url.length}"` };
    if (/\/contributors\?/.test(url)) return json([{ id: 1 }], { headers: { ...h, link: '<https://api.github.com/repositories/1/contributors?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/contributors?per_page=1&page=4>; rel="last"' } });
    if (/\/rules\/branches\//.test(url)) return json([{ type: 'pull_request', ruleset_source_type: 'Repository', ruleset_id: 7 }, { type: 'deletion', ruleset_source_type: 'Repository', ruleset_id: 7 }], { headers: h });
    if (/\/private-vulnerability-reporting$/.test(url)) return json({ enabled: true }, { headers: h });
    if (url.startsWith('https://api.scorecard.dev/')) return text('', { status: 404 });
    return text('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}

/** The registry answers for our own repository (the known-answer subject). */
export function registryRoutes() {
  return {
    'https://registry.modelcontextprotocol.io/v0.1/servers?search=isokron-ai%2Fmcp-check&limit=100': {
      servers: [
        { server: { $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', name: 'io.github.isokron-ai/mcp-check', repository: { url: 'https://github.com/isokron-ai/mcp-check', source: 'github' }, version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@isokron/mcp-check', version: '1.0.0', transport: { type: 'stdio' } }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-11-19T06:13:37.110314Z', updatedAt: '2026-11-19T06:13:37.110314Z', statusChangedAt: '2026-11-19T06:13:37.110314Z', isLatest: false } } },
        { server: { name: 'io.github.isokron-ai/mcp-check', repository: { url: 'https://github.com/isokron-ai/mcp-check' }, version: '1.3.1', packages: [{ registryType: 'npm', identifier: '@isokron/mcp-check', version: '1.3.1', transport: { type: 'stdio' } }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-11-22T19:50:40.853009Z', isLatest: true } } },
        { server: { name: 'io.github.someone/other', repository: { url: 'https://github.com/someone/other' }, version: '9.9.9' }, _meta: {} },
      ],
      metadata: { count: 3 },
    },
    // npm's abbreviated document (the lane asks for application/vnd.npm.install-v1+json).
    'https://registry.npmjs.org/@isokron%2Fmcp-check': {
      name: '@isokron/mcp-check',
      modified: '2026-11-22T19:50:22.127Z',
      'dist-tags': { latest: '1.3.1', placeholder: '0.0.0-placeholder.0' },
      versions: {
        '0.0.0-stage': { version: '0.0.0-stage', dist: {} },
        '0.0.0-placeholder.0': { version: '0.0.0-placeholder.0', deprecated: 'Placeholder, not a release.', dist: {} },
        '1.0.0': { version: '1.0.0', dist: { integrity: 'sha512-x', attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } },
        '1.3.1': { version: '1.3.1', bin: { 'mcp-check': 'bin/cli.mjs' }, engines: { node: '>=20' }, dist: { integrity: 'sha512-y', unpackedSize: 1000, fileCount: 12, signatures: [{ keyid: 'k', sig: 's' }], attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/y', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } },
      },
    },
    // The latest version's own document.
    'https://registry.npmjs.org/@isokron%2Fmcp-check/1.3.1': {
      name: '@isokron/mcp-check', version: '1.3.1', license: 'MIT', bin: { 'mcp-check': 'bin/cli.mjs' }, engines: { node: '>=20' }, scripts: { test: 'node --test' },
      gitHead: 'f'.repeat(40), mcpName: 'io.github.isokron-ai/mcp-check', repository: { type: 'git', url: 'git+https://github.com/isokron-ai/mcp-check.git' },
      maintainers: [{ name: 'someone', email: 'person@maintainer-mail.net' }], _npmUser: { name: 'someone', email: 'person@maintainer-mail.net' },
      dist: { integrity: 'sha512-y', unpackedSize: 1000, fileCount: 12, signatures: [{ keyid: 'k', sig: 's' }], attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/y', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } },
    },
    // deps.dev's version list: the publish dates.
    'https://api.deps.dev/v3/systems/NPM/packages/%40isokron%2Fmcp-check': {
      versions: [
        { versionKey: { version: '0.0.0-stage' }, publishedAt: '2026-11-19T05:55:56Z', isDefault: false },
        { versionKey: { version: '0.0.0-placeholder.0' }, publishedAt: '2026-11-19T05:57:12Z', isDefault: false, isDeprecated: true },
        { versionKey: { version: '1.0.0' }, publishedAt: '2026-11-19T06:13:23Z', isDefault: false },
        { versionKey: { version: '1.3.1' }, publishedAt: '2026-11-22T19:50:21Z', isDefault: true },
      ],
    },
  };
}

/**
 * A fetch for the registry lane: exact URLs from `routes` (JSON bodies, or
 * { status } / { text }), then defaults: no other registry entries, Go and
 * deps.dev not found.
 */
export function registryFetch(routes = registryRoutes(), { fallback } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    if (Object.hasOwn(routes, url)) {
      const r = routes[url];
      if (typeof r === 'function') return r(url, init);
      if (r && r.__status) return text(r.text ?? '', { status: r.__status, headers: r.headers ?? {} });
      if (r && typeof r.__text === 'string') return text(r.__text);
      return json(r, { headers: { etag: `"r-${url.length}"` } });
    }
    if (fallback) {
      const x = await fallback(url, init);
      if (x) return x;
    }
    if (url.startsWith('https://registry.modelcontextprotocol.io/')) return json({ servers: [], metadata: { count: 0 } });
    return text('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}

/** Judge one item written by runShard with ingest's checks (identity as given). */
export function judgeItem(dir, { attemptId, fence, runKey, registry = pinnedRegistry() }) {
  const files = collectFiles(join(dir, 'bundle'));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const workflow = { repo: 'isokron-ai/tool-qa', file: '.github/workflows/meta-github.yml', sha: '1'.repeat(40), run_id: 7, run_attempt: 1 };
  const manifest = buildManifest({ identity: { attempt_id: attemptId, fence, run_key: runKey }, workflow, meta, files });
  const tar = writeTar([{ path: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest)) }, ...files]);
  return analyzeBundle(tar, {
    exp: { attempt_id: attemptId, fence, run_key: runKey, repo: workflow.repo, workflow_file: workflow.file, workflow_sha: workflow.sha, run_id: workflow.run_id, run_attempt: 1 },
    registry,
  });
}

export const runKey = (n) => n.toString(16).padStart(64, '0');
