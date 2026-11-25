import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { buildQuery, collect, createBudget, GRAPHQL_BATCH, graphFacts, lastPage, subjectOutput, tagTargets } from '../github.mjs';
import { createHttp } from '../lib/http.mjs';
import { sanitize, sha256Hex, stableJson } from '../lib/common.mjs';
import { fixtureFetch, forgeryControl } from '../controls.mjs';
import { laneOf } from '../lanes.mjs';
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
  assert.deepEqual(Object.keys(by).sort(), ['branch_rules_public', 'community_profile', 'contributors_counts', 'git_tag_map_sha256', 'git_tag_targets',
    'issues_prs_summary', 'owner_org_facts', 'releases_summary', 'repo_core', 'repo_owner_type', 'repo_popularity', 'scorecard_api_result', 'security_posture',
    'workflow_health']);
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
  assert.deepEqual(by.scorecard_api_result, { available: false, source: 'api.scorecard.dev' });
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
    assert.deepEqual(o.skips, [{ stage: 'graphql', reason: 'rate_limited', fault: 'infra', retryable: true }]);
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

test('R-DRIFT-01: meta-github records each tag\'s target (an annotated tag peeled once) and a hash of the tag map, in the same GraphQL batch', async () => {
  const f = githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode() } });
  const out = await collect({ http: httpFor(f), repos: ['isokron-ai/mcp-check'], token: 't', budget: createBudget() });
  assert.equal(f.calls.filter((c) => c.url === 'https://api.github.com/graphql').length, 1);
  assert.match(buildQuery(['a/b']).query, /tagRefs: refs\(refPrefix: "refs\/tags\/", first: 100, orderBy: \{field: TAG_COMMIT_DATE, direction: DESC\}\)/);
  const o = subjectOutput({ ...out.get('isokron-ai/mcp-check'), observedAt: '2026-11-24T00:00:00Z' });
  const by = Object.fromEntries(o.records.map((r) => [r.field, r.value]));
  const t = by.git_tag_targets;
  assert.deepEqual([t.basis, t.order, t.total, t.sample_size, t.truncated], ['graphql_refs_tags', 'tag_commit_date_desc', 2, 2, false]);
  assert.deepEqual(t.tags, [
    { tag: 'v1.3.1', commit: 'b'.repeat(40), tag_object: null, commit_date: '2026-11-22T19:40:00Z', tagged_at: null },
    { tag: 'v1.3.0', commit: 'c'.repeat(40), tag_object: 'd'.repeat(40), commit_date: '2026-11-21T08:58:00Z', tagged_at: '2026-11-21T09:00:00Z' },
  ]);
  const map = [['v1.3.0', 'c'.repeat(40), 'd'.repeat(40)], ['v1.3.1', 'b'.repeat(40), null]];
  assert.equal(by.git_tag_map_sha256, sha256Hex(stableJson(map)));
  assert.equal(t.map_sha256, by.git_tag_map_sha256);
  // A tag of a tag keeps no commit; an answer without tag refs is null with why.
  assert.equal(tagTargets({ totalCount: 1, nodes: [{ name: 'v2.0.0', target: { __typename: 'Tag', oid: 'e'.repeat(40), target: { __typename: 'Tag', oid: 'f'.repeat(40) } } }] }).tags[0].commit, null);
  const bare = subjectOutput({ graph: { status: 'ok', node: ghNode({ tagRefs: undefined }) }, rest: {}, observedAt: '2026-11-24T00:00:00Z' });
  assert.deepEqual(bare.records.filter((r) => r.field.startsWith('git_tag')).map((r) => [r.field, r.value, r.why]),
    [['git_tag_targets', null, 'the answer had no tag refs'], ['git_tag_map_sha256', null, 'the answer had no tag refs']]);
});

test('R-DRIFT-09: tag names and image answers are upstream text: the forgery controls plant identity text in them and stay contained', async () => {
  for (const lane of ['meta-github', 'meta-registry']) {
    const r = await forgeryControl(laneOf(lane), { marker: `FORGERYMARK${'0'.repeat(24)}` });
    assert.equal(r.control.observed, 'contained', lane);
    const answers = r.files['raw/control-forgery/answers.json'];
    assert.match(answers, lane === 'meta-github' ? /"tagRefs"/ : /"HEAD"/, `${lane}: the planted answers include the new reads`);
  }
  const outs = await laneOf('meta-github').collect({ http: createHttp({ fetch: fixtureFetch(JSON.parse(readFileSync(new URL('../fixtures/forgery-meta-github.json', import.meta.url), 'utf8').split('__MARKER__').join('M'.repeat(20))).routes), retries: 0, sleep: async () => {} }), repos: ['forgery-target/forgery-target'], token: null, budget: createBudget() });
  const tags = outs.get('forgery-target/forgery-target').records.find((x) => x.field === 'git_tag_targets').value.tags;
  assert.deepEqual(tags.map((t) => [t.tag, t.commit]), [['[removed: identity-like text]', 'c'.repeat(40)], ['v0.1.0', 'c'.repeat(40)]]);
  const regOuts = await laneOf('meta-registry').collect({ http: createHttp({ fetch: fixtureFetch(JSON.parse(readFileSync(new URL('../fixtures/forgery-meta-registry.json', import.meta.url), 'utf8').split('__MARKER__').join('M'.repeat(20))).routes), retries: 0, sleep: async () => {} }), repos: ['forgery-target/forgery-target'] });
  const oci = regOuts.get('forgery-target/forgery-target').records.find((x) => x.field === 'oci_tag_digests').value;
  assert.deepEqual(oci.map((x) => [x.reference, x.tag, x.status, x.digest]), [['ghcr.io/forgery-target/forgery-target', '1.0.0', 'ok', `sha256:${'e'.repeat(64)}`]]);
  assert.equal(sanitize(oci)[0].media_type, '[removed: identity-like text]');
});

test('R-DRIFT-23: meta-github replaces bidirectional control characters in tag names before keeping or hashing them', () => {
  const t = tagTargets({ totalCount: 1, nodes: [{ name: 'v1.0.0‮⁦', target: { __typename: 'Commit', oid: 'a'.repeat(40), committedDate: '2026-11-01T00:00:00Z' } }] });
  assert.equal(t.tags[0].tag, 'v1.0.0??');
  assert.equal(t.map_sha256, sha256Hex(stableJson([['v1.0.0??', 'a'.repeat(40), null]])));
});

test('R-DRIFT-21: a GraphQL error on the tag refs is a failed read (null with why, retryable skip), not "no tag refs"', async () => {
  const f = githubFetch({
    graphql: () => new Response(JSON.stringify({
      data: { rateLimit: { cost: 1, remaining: 900, resetAt: '2026-11-24T01:00:00Z' }, r0: ghNode({ tagRefs: null }) },
      errors: [{ type: 'SERVICE_UNAVAILABLE', path: ['r0', 'tagRefs'], message: 'timeout' }],
    }), { status: 200 }),
  });
  const out = await collect({ http: httpFor(f), repos: ['isokron-ai/mcp-check'], token: 't', budget: createBudget() });
  const o = subjectOutput({ ...out.get('isokron-ai/mcp-check'), observedAt: '2026-11-24T00:00:00Z' });
  assert.deepEqual(o.records.filter((r) => r.field.startsWith('git_tag')).map((r) => [r.field, r.value, r.why]), [
    ['git_tag_targets', null, 'GitHub GraphQL returned an error for the tag refs'],
    ['git_tag_map_sha256', null, 'GitHub GraphQL returned an error for the tag refs'],
  ]);
  assert.deepEqual(o.skips, [{ stage: 'tag_refs', reason: 'upstream_unavailable', fault: 'infra', retryable: true }]);
  assert.equal(o.stages.tag_refs, 'error');
  assert.equal(o.records.find((r) => r.field === 'repo_core').value.github_id, 1463720077, 'the rest of the repository is kept');
});

test('R-META-12: a GitHub 403 on a REST read is classified: secondary throttling (no rate-limit header) is a retryable infra rate_limited skip, a DMCA or disabled repository is the subject\'s settled skip, and a size refusal stays a note', async () => {
  const withContributors = (resp) => githubFetch({ repos: { 'a/b': ghNode({ nameWithOwner: 'a/b' }) }, rest: (url) => (url.includes('/contributors?') ? resp() : undefined) });
  const run = async (resp) => {
    const f = withContributors(resp);
    const out = await collect({ http: httpFor(f), repos: ['a/b'], token: 't', budget: createBudget() });
    return subjectOutput({ ...out.get('a/b'), observedAt: '2026-11-24T00:00:00Z' });
  };
  const status = (o) => o.skips.find((s) => s.stage === 'contributors');
  const field = (o) => o.records.find((r) => r.field === 'contributors_counts');
  const json = (obj, status, headers = {}) => () => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

  // Throttling: GitHub's secondary-limit answer carries no rate-limit header, only the message.
  for (const [label, resp] of [
    ['secondary limit message', json({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.', documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#secondary-rate-limits' }, 403)],
    ['abuse detection message', json({ message: 'You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.' }, 403)],
    ['primary limit message', json({ message: 'API rate limit exceeded for user ID 1.', documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting' }, 403, { 'x-ratelimit-remaining': '900' })],
  ]) {
    const o = await run(resp);
    assert.deepEqual(status(o), { stage: 'contributors', reason: 'rate_limited', fault: 'infra', retryable: true }, label);
    assert.equal(o.stages.contributors, 'rate_limited', label);
    assert.match(field(o).why, /not read: rate_limited/, label);
  }

  // A repository GitHub took down: the subject's, settled, never retried; recorded as state, not as "too large".
  for (const [resp, why] of [
    [json({ message: 'Repository access blocked', block: { reason: 'dmca', created_at: '2026-11-01T10:00:00Z', html_url: 'https://github.com/github/dmca/blob/master/2026/11/x.md' } }, 451), /DMCA/],
    [json({ message: 'Repository access blocked', block: { reason: 'dmca' } }, 403), /DMCA/],
    [json({ message: 'Access to this repository has been disabled by GitHub Staff due to a violation of GitHub\'s terms of service.' }, 403), /disabled/],
  ]) {
    const o = await run(resp);
    assert.deepEqual(status(o), { stage: 'contributors', reason: 'upstream_unavailable', fault: 'subject' });
    assert.equal(o.stages.contributors, 'repository_gone');
    assert.equal(field(o).value, null);
    assert.match(field(o).why, why);
    assert.doesNotMatch(field(o).why, /large/);
  }

  // The size refusal GitHub documents is neither: no skip, a note.
  const big = await run(json({ message: 'The history or contributor list is too large to list contributors for this repository via the API.', documentation_url: 'https://docs.github.com/rest/repos/repos#list-repository-contributors' }, 403, { 'x-ratelimit-remaining': '800' }));
  assert.deepEqual(big.skips, []);
  assert.match(field(big).why, /large/);

  // Release-note-like text that merely contains the words does not make the repository gone.
  const note = await run(json({ message: 'Forbidden', note: 'v2.3.0: access blocked for anonymous callers; the legacy endpoint has been disabled' }, 403));
  assert.deepEqual(note.skips, []);
  assert.notEqual(note.stages.contributors, 'repository_gone');

  // The other two REST reads classify the same way.
  const f = githubFetch({ repos: { 'a/b': ghNode({ nameWithOwner: 'a/b' }) }, rest: (url) => (url.includes('/private-vulnerability-reporting') ? json({ message: 'Repository access blocked', block: { reason: 'tos' } }, 403)() : url.includes('/rules/branches/') ? json({ message: 'You have exceeded a secondary rate limit.' }, 403)() : undefined) });
  const out = await collect({ http: httpFor(f), repos: ['a/b'], token: 't', budget: createBudget() });
  const o = subjectOutput({ ...out.get('a/b'), observedAt: '2026-11-24T00:00:00Z' });
  assert.deepEqual(o.skips.find((s) => s.stage === 'private_vulnerability_reporting'), { stage: 'private_vulnerability_reporting', reason: 'upstream_unavailable', fault: 'subject' });
  assert.deepEqual(o.skips.find((s) => s.stage === 'branch_rules'), { stage: 'branch_rules', reason: 'rate_limited', fault: 'infra', retryable: true });
});
