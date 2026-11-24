// meta-github: public GitHub metadata for each subject repository.
//
// Per shard (up to 100 repositories):
//   GraphQL   one query per 10 repositories (about 1 point each): repository
//             facts, popularity, owner type, releases, issue and pull request
//             counts, security policy, the public view of branch protection,
//             community files, workflow files and dependency-update config,
//             read from the default branch's tree. GITHUB_TOKEN has 1,000
//             points an hour per repository.
//   REST      three calls per repository, all conditional (ETag; a 304 does
//             not count against the 1,000 requests an hour GITHUB_TOKEN has
//             per repository): contributor count, rules for the default
//             branch, private vulnerability reporting.
//   Scorecard one call per repository to api.scorecard.dev (most answer 404:
//             the public dataset covers few repositories).
//
// Budgets: no GraphQL query is sent when fewer than `graphqlReserve` points
// remain, and no REST call when fewer than `restReserve` requests remain or
// after `restCap` counted calls in this shard. The other workflows of this
// repository share the same hourly limit. What did not run is recorded as a
// retryable `rate_limited` skip for that stage, so ingest sends the item back
// for a later try (worker-kit README, "skips").

import { FetchProblem, mapLimit } from './lib/http.mjs';
import { bool, daysBetween, int, median, record, str, textDigest, time } from './lib/common.mjs';

export const LANE = 'meta-github';
export const VERSION = '1.0.0';
const API = 'https://api.github.com';
const SCORECARD = 'https://api.scorecard.dev/projects/github.com';
export const GRAPHQL_BATCH = 10;
const RELEASE_SAMPLE = 20;
const GH_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

/** Settings that go into the settings digest of every bundle. */
export const SETTINGS = Object.freeze({
  lane: LANE, version: VERSION, graphql_batch: GRAPHQL_BATCH, release_sample: RELEASE_SAMPLE,
  rest: ['contributors?anon=false', 'rules/branches/{default}', 'private-vulnerability-reporting'],
  scorecard: 'api.scorecard.dev',
});

export const REPO_FRAGMENT = `
fragment R on Repository {
  databaseId nameWithOwner isFork isArchived isDisabled isTemplate isMirror isEmpty isLocked visibility
  parent { nameWithOwner }
  owner { __typename ... on Organization { databaseId isVerified createdAt } ... on User { databaseId } }
  createdAt pushedAt updatedAt diskUsage homepageUrl description
  primaryLanguage { name }
  licenseInfo { spdxId key }
  repositoryTopics(first: 20) { totalCount nodes { topic { name } } }
  stargazerCount forkCount watchers { totalCount }
  hasIssuesEnabled hasDiscussionsEnabled hasWikiEnabled hasProjectsEnabled
  isSecurityPolicyEnabled
  codeOfConduct { key }
  issueTemplates { name }
  pullRequestTemplates { filename }
  defaultBranchRef { name target { oid } refUpdateRule { requiredApprovingReviewCount requiredStatusCheckContexts allowsForcePushes allowsDeletions requiresLinearHistory requiresSignatures requiresCodeOwnerReviews requiresConversationResolution } }
  releases(first: ${RELEASE_SAMPLE}, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { tagName publishedAt createdAt isPrerelease isLatest releaseAssets { totalCount } } }
  openIssues: issues(states: OPEN) { totalCount }
  closedIssues: issues(states: CLOSED) { totalCount }
  openPRs: pullRequests(states: OPEN) { totalCount }
  mergedPRs: pullRequests(states: MERGED) { totalCount }
  closedPRs: pullRequests(states: CLOSED) { totalCount }
  rootTree: object(expression: "HEAD:") { ... on Tree { entries { name type } } }
  githubTree: object(expression: "HEAD:.github") { ... on Tree { entries { name type } } }
  docsTree: object(expression: "HEAD:docs") { ... on Tree { entries { name type } } }
  workflowsTree: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name type } } }
}`;

/** One GraphQL query for up to GRAPHQL_BATCH repositories, with variables (never interpolated names). */
export function buildQuery(repos) {
  const vars = {};
  const decl = [];
  const body = [];
  repos.forEach((full, i) => {
    const [owner, name] = full.split('/');
    vars[`o${i}`] = owner;
    vars[`n${i}`] = name;
    decl.push(`$o${i}: String!`, `$n${i}: String!`);
    body.push(`  r${i}: repository(owner: $o${i}, name: $n${i}) { ...R }`);
  });
  const query = `query(${decl.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n${body.join('\n')}\n}\n${REPO_FRAGMENT}`;
  return { query, variables: vars };
}

/** A GitHub REST answer that is a rate limit (primary or secondary), from its headers. */
export function githubRateLimited(res) {
  if (res.status !== 403 && res.status !== 429) return false;
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null;
}

/** Shared accounting of GitHub's limits for one shard. */
export function createBudget({ restReserve = 200, restCap = 400, graphqlReserve = 50 } = {}) {
  return {
    restReserve, restCap, graphqlReserve,
    rest: { remaining: null, reset: null, counted: 0, not_modified: 0 },
    graphql: { remaining: null, reset: null, cost: 0, queries: 0 },
    noteRest(res) {
      const rem = Number(res.headers.get('x-ratelimit-remaining'));
      if (res.headers.get('x-ratelimit-remaining') !== null && Number.isFinite(rem)) this.rest.remaining = rem;
      const reset = res.headers.get('x-ratelimit-reset');
      if (reset) this.rest.reset = reset;
      if (res.status === 304) this.rest.not_modified++;
      else this.rest.counted++;
    },
    restAllowed() {
      if (this.rest.counted >= this.restCap) return 'the shard reached its REST cap';
      if (this.rest.remaining !== null && this.rest.remaining < this.restReserve) return 'GitHub REST requests left this hour are below the reserve';
      return null;
    },
    graphqlAllowed() {
      if (this.graphql.remaining !== null && this.graphql.remaining < this.graphqlReserve) return 'GitHub GraphQL points left this hour are below the reserve';
      return null;
    },
  };
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Send one GraphQL batch. Returns { byRepo: Map<repo, {status, node}> } where
 * status is 'ok' or 'not_found'. Throws FetchProblem for a rate limit or outage.
 */
export async function graphqlBatch(http, { repos, token, budget }) {
  const stop = budget.graphqlAllowed();
  if (stop) throw new FetchProblem('rate_limited', stop);
  const { query, variables } = buildQuery(repos);
  const res = await http.request(`${API}/graphql`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    rateLimitCheck: githubRateLimited,
  });
  budget.graphql.queries++;
  if (res.status !== 200) {
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 401) throw new Error('GitHub GraphQL refused the token (HTTP 401)');
    throw new FetchProblem(res.status === 403 ? 'rate_limited' : 'upstream_unavailable', `GraphQL HTTP ${res.status}`, { status: res.status });
  }
  let doc;
  try {
    doc = await res.json();
  } catch {
    throw new FetchProblem('upstream_unavailable', 'GraphQL answer is not JSON');
  }
  const errors = Array.isArray(doc?.errors) ? doc.errors : [];
  if (errors.some((e) => e?.type === 'RATE_LIMITED' || e?.type === 'RATE_LIMIT')) throw new FetchProblem('rate_limited', 'GraphQL rate limit');
  if (!doc?.data || typeof doc.data !== 'object') throw new FetchProblem('upstream_unavailable', 'GraphQL answered without data');
  const rl = doc.data.rateLimit;
  if (rl && Number.isFinite(rl.remaining)) budget.graphql.remaining = rl.remaining;
  if (rl && Number.isFinite(rl.cost)) budget.graphql.cost += rl.cost;
  if (rl?.resetAt) budget.graphql.reset = rl.resetAt;
  const notFound = new Set(errors.filter((e) => e?.type === 'NOT_FOUND').map((e) => (Array.isArray(e.path) ? e.path[0] : null)));
  const otherErr = new Set(errors.filter((e) => e?.type !== 'NOT_FOUND').map((e) => (Array.isArray(e.path) ? e.path[0] : null)));
  const byRepo = new Map();
  repos.forEach((repo, i) => {
    const node = doc.data[`r${i}`];
    if (node && typeof node === 'object') byRepo.set(repo, { status: 'ok', node });
    else if (notFound.has(`r${i}`)) byRepo.set(repo, { status: 'not_found', node: null });
    else if (otherErr.has(`r${i}`) || otherErr.has(null)) byRepo.set(repo, { status: 'error', node: null });
    else byRepo.set(repo, { status: 'not_found', node: null });
  });
  return { byRepo };
}

/** Number of pages from a Link header's rel="last", or null. */
export function lastPage(link) {
  if (typeof link !== 'string') return null;
  const m = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  return m ? Number(m[1]) : null;
}

async function rest(http, url, { token, budget, extract, version }) {
  const stop = budget.restAllowed();
  if (stop) throw new FetchProblem('rate_limited', stop);
  const out = await http.getSummary(url, {
    extract, version, headers: { ...GH_HEADERS, ...authHeaders(token) }, rateLimitCheck: githubRateLimited,
  });
  if (out.res) budget.noteRest(out.res);
  return out;
}

/** The three REST reads for one repository. Each is { status, value } or { problem }. */
export async function restReads(http, repo, defaultBranch, { token, budget }) {
  const out = {};
  const run = async (key, fn) => {
    try {
      out[key] = await fn();
    } catch (err) {
      if (err instanceof FetchProblem) out[key] = { problem: err.code, detail: err.message };
      else throw err;
    }
  };
  await run('contributors', () => rest(http, `${API}/repos/${repo}/contributors?per_page=1&anon=false`, {
    token, budget, version: 'contributors/1',
    extract: (doc, res) => {
      const n = Array.isArray(doc) ? doc.length : 0;
      const last = lastPage(res.headers.get('link'));
      return { accounts: last ?? n };
    },
  }));
  if (defaultBranch) {
    await run('rules', () => rest(http, `${API}/repos/${repo}/rules/branches/${encodeURIComponent(defaultBranch)}?per_page=100`, {
      token, budget, version: 'rules/1',
      extract: (doc) => {
        const list = Array.isArray(doc) ? doc : [];
        const types = [...new Set(list.map((r) => str(r?.type, 64)).filter(Boolean))].sort();
        const sources = [...new Set(list.map((r) => str(r?.ruleset_source_type, 32)).filter(Boolean))].sort();
        const rulesets = new Set(list.map((r) => r?.ruleset_id).filter((x) => Number.isSafeInteger(x)));
        return { rule_count: list.length, rule_types: types, ruleset_count: rulesets.size, source_types: sources };
      },
    }));
  }
  await run('pvr', () => rest(http, `${API}/repos/${repo}/private-vulnerability-reporting`, {
    token, budget, version: 'pvr/1',
    extract: (doc) => ({ enabled: bool(doc?.enabled) }),
  }));
  return out;
}

/** OpenSSF Scorecard result from the public API (most repositories are not in it). */
export async function scorecardRead(http, repo) {
  try {
    return await http.getSummary(`${SCORECARD}/${repo}`, {
      version: 'scorecard/1',
      headers: { accept: 'application/json' },
      extract: (doc) => ({
        score: typeof doc?.score === 'number' ? doc.score : null,
        date: time(doc?.date),
        scorecard_version: str(doc?.scorecard?.version, 40),
        repo_commit: typeof doc?.repo?.commit === 'string' && /^[0-9a-f]{40}$/.test(doc.repo.commit) ? doc.repo.commit : null,
        checks: (Array.isArray(doc?.checks) ? doc.checks : []).slice(0, 40)
          .map((c) => ({ name: str(c?.name, 64), score: typeof c?.score === 'number' ? c.score : null }))
          .filter((c) => c.name),
      }),
    });
  } catch (err) {
    if (err instanceof FetchProblem) return { problem: err.code, detail: err.message };
    throw err;
  }
}

const names = (tree) => (Array.isArray(tree?.entries) ? tree.entries : []);
const hasFile = (tree, re) => names(tree).some((e) => e?.type === 'blob' && typeof e.name === 'string' && re.test(e.name));

/** Pure mapping from the GraphQL node to the facts we keep. */
export function graphFacts(node, observedAt) {
  const root = node.rootTree;
  const gh = node.githubTree;
  const docs = node.docsTree;
  const wf = names(node.workflowsTree).filter((e) => e?.type === 'blob' && /\.ya?ml$/i.test(e?.name ?? ''));
  const rels = Array.isArray(node.releases?.nodes) ? node.releases.nodes : [];
  const relTimes = rels.map((r) => time(r?.publishedAt) ?? time(r?.createdAt)).filter(Boolean).sort();
  const gaps = relTimes.slice(1).map((t, i) => daysBetween(relTimes[i], t));
  const latest = rels.find((r) => r?.isLatest) ?? null;
  const ownerType = node.owner?.__typename === 'Organization' ? 'Organization' : node.owner?.__typename === 'User' ? 'User' : null;
  const rule = node.defaultBranchRef?.refUpdateRule;
  const securityFiles = [
    hasFile(root, /^security\.(md|markdown|txt|rst)$/i) ? 'SECURITY.md' : null,
    hasFile(gh, /^security\.(md|markdown|txt|rst)$/i) ? '.github/SECURITY.md' : null,
    hasFile(docs, /^security\.(md|markdown|txt|rst)$/i) ? 'docs/SECURITY.md' : null,
  ].filter(Boolean);
  const dependabot = hasFile(gh, /^dependabot\.ya?ml$/i);
  const renovate = hasFile(root, /^(renovate\.json5?|\.renovaterc(\.json5?)?)$/i) || hasFile(gh, /^renovate\.json5?$/i);
  return {
    head_sha: typeof node.defaultBranchRef?.target?.oid === 'string' && /^[0-9a-f]{40}$/.test(node.defaultBranchRef.target.oid) ? node.defaultBranchRef.target.oid : null,
    default_branch: str(node.defaultBranchRef?.name, 255),
    repo_core: {
      github_id: int(node.databaseId),
      full_name: str(node.nameWithOwner, 200),
      owner_id: int(node.owner?.databaseId),
      owner_type: ownerType,
      fork: bool(node.isFork),
      parent: str(node.parent?.nameWithOwner, 200),
      archived: bool(node.isArchived),
      disabled: bool(node.isDisabled),
      template: bool(node.isTemplate),
      mirror: bool(node.isMirror),
      empty: bool(node.isEmpty),
      locked: bool(node.isLocked),
      visibility: str(node.visibility, 20),
      default_branch: str(node.defaultBranchRef?.name, 255),
      created_at: time(node.createdAt),
      pushed_at: time(node.pushedAt),
      updated_at: time(node.updatedAt),
      disk_usage_kb: int(node.diskUsage),
      primary_language: str(node.primaryLanguage?.name, 64),
      licence: node.licenseInfo ? { spdx_id: str(node.licenseInfo.spdxId, 64), key: str(node.licenseInfo.key, 64) } : null,
      topics: (Array.isArray(node.repositoryTopics?.nodes) ? node.repositoryTopics.nodes : []).map((t) => str(t?.topic?.name, 50)).filter(Boolean),
      topics_total: int(node.repositoryTopics?.totalCount),
      homepage_url: str(node.homepageUrl, 500),
      description: textDigest(node.description),
      has_issues: bool(node.hasIssuesEnabled),
      has_discussions: bool(node.hasDiscussionsEnabled),
      has_wiki: bool(node.hasWikiEnabled),
      has_projects: bool(node.hasProjectsEnabled),
    },
    repo_owner_type: ownerType,
    repo_popularity: {
      stars: int(node.stargazerCount),
      forks: int(node.forkCount),
      watchers: int(node.watchers?.totalCount),
    },
    owner_org_facts: ownerType === 'Organization'
      ? { type: 'Organization', github_id: int(node.owner?.databaseId), verified: bool(node.owner?.isVerified), created_at: time(node.owner?.createdAt) }
      : ownerType === 'User' ? { type: 'User' } : null,
    releases_summary: {
      total: int(node.releases?.totalCount),
      latest: latest ? { tag: str(latest.tagName, 255), published_at: time(latest.publishedAt), prerelease: bool(latest.isPrerelease) } : null,
      days_since_latest: latest ? daysBetween(time(latest.publishedAt) ?? time(latest.createdAt), observedAt) : null,
      sample_size: rels.length,
      sample_prereleases: rels.filter((r) => r?.isPrerelease === true).length,
      sample_median_days_between: median(gaps),
      sample: rels.map((r) => ({
        tag: str(r?.tagName, 255),
        created_at: time(r?.createdAt),
        published_at: time(r?.publishedAt),
        prerelease: bool(r?.isPrerelease),
        assets: int(r?.releaseAssets?.totalCount),
      })),
      drafts_visible: false,
    },
    issues_prs_summary: {
      issues_open: int(node.openIssues?.totalCount),
      issues_closed: int(node.closedIssues?.totalCount),
      prs_open: int(node.openPRs?.totalCount),
      prs_merged: int(node.mergedPRs?.totalCount),
      prs_closed_unmerged: int(node.closedPRs?.totalCount),
    },
    security_posture: {
      security_policy_enabled: bool(node.isSecurityPolicyEnabled),
      security_policy_files: securityFiles,
      dependabot_config: dependabot,
      renovate_config: renovate,
      codeowners: hasFile(root, /^codeowners$/i) || hasFile(gh, /^codeowners$/i) || hasFile(docs, /^codeowners$/i),
      security_and_analysis: 'not_visible',
    },
    branch_rules_classic: rule
      ? {
        visible: true,
        required_approving_review_count: int(rule.requiredApprovingReviewCount),
        required_status_check_count: Array.isArray(rule.requiredStatusCheckContexts) ? rule.requiredStatusCheckContexts.length : null,
        allows_force_pushes: bool(rule.allowsForcePushes),
        allows_deletions: bool(rule.allowsDeletions),
        requires_linear_history: bool(rule.requiresLinearHistory),
        requires_signatures: bool(rule.requiresSignatures),
        requires_code_owner_reviews: bool(rule.requiresCodeOwnerReviews),
        requires_conversation_resolution: bool(rule.requiresConversationResolution),
      }
      : { visible: false },
    community_profile: {
      basis: 'default_branch_tree',
      readme: hasFile(root, /^readme(\.[a-z0-9]+)?$/i) || hasFile(gh, /^readme(\.[a-z0-9]+)?$/i) || hasFile(docs, /^readme(\.[a-z0-9]+)?$/i),
      licence_file: hasFile(root, /^(licen[cs]e|copying)(\.[a-z0-9]+)?$/i),
      contributing: hasFile(root, /^contributing(\.[a-z0-9]+)?$/i) || hasFile(gh, /^contributing(\.[a-z0-9]+)?$/i) || hasFile(docs, /^contributing(\.[a-z0-9]+)?$/i),
      code_of_conduct: str(node.codeOfConduct?.key, 64) ?? (hasFile(root, /^code_of_conduct(\.[a-z0-9]+)?$/i) || hasFile(gh, /^code_of_conduct(\.[a-z0-9]+)?$/i) ? 'file' : null),
      support: hasFile(root, /^support(\.[a-z0-9]+)?$/i) || hasFile(gh, /^support(\.[a-z0-9]+)?$/i),
      funding: hasFile(gh, /^funding\.ya?ml$/i),
      issue_templates: Array.isArray(node.issueTemplates) ? node.issueTemplates.length : null,
      pull_request_templates: Array.isArray(node.pullRequestTemplates) ? node.pullRequestTemplates.length : null,
    },
    workflow_health: {
      basis: 'default_branch_tree',
      workflow_files: wf.length,
      files: wf.slice(0, 100).map((e) => str(e.name, 100)).filter(Boolean).sort(),
      runs_read: false,
    },
  };
}

/** What one REST read gave, for the results file: ok, not_visible, or the problem. */
function stageOf(r) {
  if (!r) return 'not_run';
  if (r.problem) return r.problem;
  if (r.status === 200 || r.status === 304) return 'ok';
  if (r.status === 404 || r.status === 403) return 'not_visible';
  return `http_${r.status}`;
}

/**
 * Observation records, skips and a results summary for one subject.
 * @param {{graph: {status: string, node?: object, problem?: string}, rest?: object, scorecard?: object, observedAt: string}} p
 */
export function subjectOutput({ graph, rest = {}, scorecard, observedAt }) {
  const records = [];
  const skips = [];
  const stages = {};
  stages.graphql = graph.status === 'ok' ? 'ok' : graph.problem ?? graph.status;
  if (graph.status !== 'ok') {
    const why = graph.status === 'not_found' ? 'GitHub has no public repository with this name'
      : graph.problem ? `GitHub GraphQL did not answer for this shard (${graph.problem})` : 'GitHub GraphQL returned an error for this repository';
    for (const f of ['repo_core', 'repo_owner_type', 'repo_popularity', 'owner_org_facts', 'releases_summary', 'issues_prs_summary',
      'contributors_counts', 'security_posture', 'branch_rules_public', 'community_profile', 'workflow_health']) records.push(record(f, null, why));
    if (graph.problem) skips.push({ stage: 'graphql', reason: graph.problem, retryable: true });
    else if (graph.status === 'error') skips.push({ stage: 'graphql', reason: 'upstream_unavailable', retryable: true });
  } else {
    const g = graphFacts(graph.node, observedAt);
    records.push(record('repo_core', g.repo_core));
    records.push(record('repo_owner_type', g.repo_owner_type, 'the owner type was not in the answer'));
    records.push(record('repo_popularity', g.repo_popularity));
    records.push(record('owner_org_facts', g.owner_org_facts, 'the owner type was not in the answer'));
    records.push(record('releases_summary', g.releases_summary));
    records.push(record('issues_prs_summary', g.issues_prs_summary));
    records.push(record('community_profile', g.community_profile));
    records.push(record('workflow_health', g.workflow_health));

    const c = rest.contributors;
    stages.contributors = stageOf(c);
    if (c?.problem) {
      records.push(record('contributors_counts', null, `not read: ${c.problem}`));
      skips.push({ stage: 'contributors', reason: c.problem, retryable: true });
    } else if (c && (c.status === 200 || c.status === 304)) {
      records.push(record('contributors_counts', { accounts: c.value.accounts, anonymous_included: false, basis: 'rest_contributors_link_header' }));
    } else if (c?.status === 204) {
      records.push(record('contributors_counts', { accounts: 0, anonymous_included: false, basis: 'rest_contributors_link_header' }));
    } else {
      records.push(record('contributors_counts', null, c?.status === 403 ? 'GitHub does not list contributors for a repository this large' : `contributors not visible (${stageOf(c)})`));
    }

    const p = rest.pvr;
    stages.private_vulnerability_reporting = stageOf(p);
    if (p?.problem) skips.push({ stage: 'private_vulnerability_reporting', reason: p.problem, retryable: true });
    records.push(record('security_posture', {
      ...g.security_posture,
      private_vulnerability_reporting: p && (p.status === 200 || p.status === 304) ? p.value.enabled : null,
    }));

    const r = rest.rules;
    stages.branch_rules = stageOf(r);
    if (r?.problem) skips.push({ stage: 'branch_rules', reason: r.problem, retryable: true });
    records.push(record('branch_rules_public', {
      branch: g.default_branch,
      rulesets: r && (r.status === 200 || r.status === 304) ? r.value : null,
      classic: g.branch_rules_classic,
    }));
  }

  stages.scorecard = !scorecard ? 'not_run' : scorecard.status === 404 ? 'not_in_dataset' : stageOf(scorecard);
  if (scorecard?.problem) {
    records.push(record('scorecard_result', null, `not read: ${scorecard.problem}`));
    skips.push({ stage: 'scorecard', reason: scorecard.problem, retryable: true });
  } else if (scorecard && (scorecard.status === 200 || scorecard.status === 304)) {
    records.push(record('scorecard_result', { available: true, source: 'api.scorecard.dev', ...scorecard.value }));
  } else if (scorecard) {
    records.push(record('scorecard_result', { available: false, source: 'api.scorecard.dev' }));
  }
  const sha = graph.status === 'ok' ? graphFacts(graph.node, observedAt).head_sha : null;
  return { records, skips, stages, sha };
}

/**
 * Collect every subject of a shard. `repos` are owner/name strings (valid ones
 * only). Returns Map<repo, {graph, rest, scorecard}>. `deadline()` true means
 * start nothing new; what was not started is reported by the caller.
 */
export async function collect({ http, repos, token, budget, deadline = () => false, concurrency = 4, log = () => {} }) {
  const out = new Map();
  for (let i = 0; i < repos.length; i += GRAPHQL_BATCH) {
    const batch = repos.slice(i, i + GRAPHQL_BATCH);
    if (deadline()) break;
    let byRepo;
    try {
      ({ byRepo } = await graphqlBatch(http, { repos: batch, token, budget }));
    } catch (err) {
      if (!(err instanceof FetchProblem)) throw err;
      log(`graphql batch ${i / GRAPHQL_BATCH}: ${err.code}`);
      for (const repo of batch) out.set(repo, { graph: { status: 'problem', problem: err.code } });
      continue;
    }
    await mapLimit(batch, concurrency, async (repo) => {
      const graph = byRepo.get(repo);
      const entry = { graph };
      if (graph.status === 'ok') {
        entry.rest = await restReads(http, repo, graph.node.defaultBranchRef?.name ?? null, { token, budget });
      }
      entry.scorecard = await scorecardRead(http, repo);
      out.set(repo, entry);
    });
  }
  return out;
}
