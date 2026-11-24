import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQuery, collect, createBudget, GRAPHQL_BATCH, graphFacts, lastPage, subjectOutput } from '../github.mjs';
import { createHttp } from '../lib/http.mjs';
import { ghNode, githubFetch } from './helpers.mjs';

const httpFor = (f) => createHttp({ fetch: f, sleep: async () => {} });

test('buildQuery passes owners and names as variables, never inside the query text', () => {
  const { query, variables } = buildQuery(['evil") { x }/name', 'a/b']);
  assert.ok(!query.includes('evil'));
  assert.equal(variables.o0, 'evil") { x }');
  assert.match(query, /r1: repository\(owner: \$o1, name: \$n1\)/);
});

test('lastPage reads rel="last" from a Link header', () => {
  assert.equal(lastPage('<https://api.github.com/x?per_page=1&page=2>; rel="next", <https://api.github.com/x?per_page=1&page=57>; rel="last"'), 57);
  assert.equal(lastPage(null), null);
});

test('collect: one GraphQL query per 10 repositories, three conditional REST reads and Scorecard per found repository', async () => {
  const repos = Array.from({ length: 12 }, (_, i) => `org/r${i}`);
  const nodes = Object.fromEntries(repos.slice(0, 11).map((r) => [r, ghNode({ nameWithOwner: r })]));
  const f = githubFetch({ repos: nodes });
  const out = await collect({ http: httpFor(f), repos, token: 't', budget: createBudget() });
  assert.equal(f.calls.filter((c) => c.url.endsWith('/graphql')).length, Math.ceil(12 / GRAPHQL_BATCH));
  assert.equal(f.calls.filter((c) => c.url.includes('/contributors?')).length, 11);
  assert.equal(f.calls.filter((c) => c.url.startsWith('https://api.scorecard.dev/')).length, 12);
  assert.equal(out.get('org/r11').graph.status, 'not_found');
  assert.ok(f.calls.every((c) => !c.url.includes('api.github.com') || c.headers.authorization === 'Bearer t'));
});

test('subjectOutput: the facts land in registry fields with their types; no skips on a clean read', async () => {
  const f = githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode() } });
  const out = await collect({ http: httpFor(f), repos: ['isokron-ai/mcp-check'], token: 't', budget: createBudget() });
  const o = subjectOutput({ ...out.get('isokron-ai/mcp-check'), observedAt: '2026-11-24T00:00:00Z' });
  const by = Object.fromEntries(o.records.map((r) => [r.field, r.value]));
  assert.deepEqual(Object.keys(by).sort(), ['branch_rules_public', 'community_profile', 'contributors_counts', 'issues_prs_summary', 'owner_org_facts',
    'releases_summary', 'repo_core', 'repo_owner_type', 'repo_popularity', 'scorecard_result', 'security_posture', 'workflow_health']);
  assert.equal(by.repo_core.github_id, 1463720077);
  assert.equal(by.repo_core.description.length, 'Grades a tool list.'.length);
  assert.equal(by.repo_owner_type, 'Organization');
  assert.equal(by.contributors_counts.accounts, 4);
  assert.deepEqual(by.security_posture.security_policy_files, ['SECURITY.md']);
  assert.equal(by.security_posture.dependabot_config, true);
  assert.equal(by.security_posture.codeowners, true);
  assert.equal(by.security_posture.private_vulnerability_reporting, true);
  assert.deepEqual(by.branch_rules_public.rulesets.rule_types, ['deletion', 'pull_request']);
  assert.deepEqual(by.workflow_health.files, ['ci.yml', 'release.yml']);
  assert.equal(by.releases_summary.total, 6);
  assert.equal(by.releases_summary.latest.tag, 'v1.3.1');
  assert.deepEqual(by.scorecard_result, { available: false, source: 'api.scorecard.dev' });
  assert.equal(o.sha, 'a'.repeat(40));
  assert.deepEqual(o.skips, []);
});

test('a user-owned repository keeps the owner type only', () => {
  const g = graphFacts(ghNode({ owner: { __typename: 'User', databaseId: 9 } }), '2026-11-24T00:00:00Z');
  assert.deepEqual(g.owner_org_facts, { type: 'User' });
});

test('REST below the reserve is not called: those stages are retryable rate_limited skips, GraphQL facts still kept', async () => {
  const f = githubFetch({ repos: { 'a/b': ghNode({ nameWithOwner: 'a/b' }) }, remaining: 10 });
  const budget = createBudget({ restReserve: 50 });
  const out = await collect({ http: httpFor(f), repos: ['a/b'], token: 't', budget });
  const o = subjectOutput({ ...out.get('a/b'), observedAt: '2026-11-24T00:00:00Z' });
  // The first REST answer showed 10 left, under the reserve of 50: the next two were never sent.
  assert.equal(f.calls.filter((c) => c.url.startsWith('https://api.github.com/repos/')).length, 1);
  assert.deepEqual(o.skips.map((s) => [s.stage, s.reason, s.retryable]), [
    ['private_vulnerability_reporting', 'rate_limited', true], ['branch_rules', 'rate_limited', true],
  ]);
  assert.ok(o.records.find((r) => r.field === 'repo_core').value);
});

test('the REST cap per shard holds', async () => {
  const repos = ['a/1', 'a/2'];
  const f = githubFetch({ repos: Object.fromEntries(repos.map((r) => [r, ghNode({ nameWithOwner: r })])) });
  const budget = createBudget({ restCap: 4 });
  await collect({ http: httpFor(f), repos, token: 't', budget, concurrency: 1 });
  assert.equal(f.calls.filter((c) => c.url.startsWith('https://api.github.com/repos/')).length, 4);
  assert.equal(budget.rest.counted, 4);
});

test('a GitHub rate limit on GraphQL makes every repository of the batch a retryable skip', async () => {
  const f = githubFetch({ graphql: async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) });
  const http = createHttp({ fetch: f, sleep: async () => {}, retries: 0 });
  const out = await collect({ http, repos: ['a/b', 'c/d'], token: 't', budget: createBudget() });
  for (const r of ['a/b', 'c/d']) {
    const o = subjectOutput({ ...out.get(r), observedAt: '2026-11-24T00:00:00Z' });
    assert.deepEqual(o.skips, [{ stage: 'graphql', reason: 'rate_limited', retryable: true }]);
    assert.ok(o.records.every((x) => x.value === null && x.why));
  }
});

test('GraphQL points below the reserve: no query is sent', async () => {
  const f = githubFetch({ repos: { 'a/b': ghNode() }, graphqlRemaining: 10 });
  const budget = createBudget({ graphqlReserve: 50 });
  const http = httpFor(f);
  const repos = Array.from({ length: 11 }, (_, i) => (i === 0 ? 'a/b' : `x/${i}`));
  const out = await collect({ http, repos, token: 't', budget });
  assert.equal(f.calls.filter((c) => c.url.endsWith('/graphql')).length, 1, 'the second batch is not sent');
  assert.equal(out.get('x/10').graph.problem, 'rate_limited');
});

test('a repository too large for the contributors API is recorded as null with why, not as a skip', async () => {
  const f = githubFetch({
    repos: { 'a/b': ghNode() },
    rest: (url) => (url.includes('/contributors?') ? new Response('{"message":"too large"}', { status: 403, headers: { 'x-ratelimit-remaining': '800' } }) : undefined),
  });
  const out = await collect({ http: httpFor(f), repos: ['a/b'], token: 't', budget: createBudget() });
  const o = subjectOutput({ ...out.get('a/b'), observedAt: '2026-11-24T00:00:00Z' });
  const c = o.records.find((r) => r.field === 'contributors_counts');
  assert.equal(c.value, null);
  assert.match(c.why, /large|not visible/);
  assert.deepEqual(o.skips, []);
});
