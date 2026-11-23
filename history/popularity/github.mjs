// H3 stars: repo core (stars, forks) and latest release, with ETag / If-None-Match.
// A 304 answer does not count against the REST rate limit, so unchanged repos are free.
// Cached summaries live in the state file so a 304 still yields a row.
const API = 'https://api.github.com';

async function cond(http, url, entry, token) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (entry?.etag) headers['if-none-match'] = entry.etag;
  const res = await http.request(url, { headers });
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const info = { remaining: Number.isFinite(remaining) ? remaining : null, reset: res.headers.get('x-ratelimit-reset') };
  if (res.status === 304 && entry) return { ...info, status: 304, data: entry.data, etag: entry.etag };
  if (res.status === 404) return { ...info, status: 404, data: null, etag: null };
  if (res.status === 403 || res.status === 429) throw Object.assign(new Error(`HTTP ${res.status} (rate limited or forbidden)`), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { ...info, status: res.status, data: await res.json(), etag: res.headers.get('etag') };
}

// A repo that is gone (404) goes in `missing`, and a rate-limit stop in `warnings`. Neither is an
// error: the seed is drawn from a registry snapshot, so some repos disappear, and the first runs
// on a large seed outrun GITHUB_TOKEN's 1,000 requests per hour (the ETag cache fills over a few
// days, and 304s are free). Only a stop before any repo was read is an error, since that
// means the token or the API is broken, not the budget.
export async function githubPopularity(http, repos, { token, state = {}, now = Date.now(), minRemaining = 20 } = {}) {
  const rows = []; const errors = []; const missing = []; const warnings = []; const next = { ...state };
  const stats = { requests: 0, not_modified: 0, skipped_rate_limit: 0, rate_limited: false };
  let stop = false;
  for (const repo of repos) {
    if (stop) { stats.skipped_rate_limit++; continue; }
    try {
      const core = await cond(http, `${API}/repos/${repo}`, state[repo]?.core, token); stats.requests++;
      if (core.status === 404) { missing.push(`github:${repo}`); delete next[repo]; if (core.remaining != null && core.remaining < minRemaining) stop = true; continue; }
      const rel = await cond(http, `${API}/repos/${repo}/releases/latest`, state[repo]?.release, token); stats.requests++;
      if (core.status === 304) stats.not_modified++;
      if (rel.status === 304) stats.not_modified++;
      next[repo] = {
        core: { etag: core.etag, data: core.status === 304 ? core.data : { stars: core.data.stargazers_count, forks: core.data.forks_count, archived: !!core.data.archived, pushed_at: core.data.pushed_at ?? null } },
        release: { etag: rel.etag, data: rel.data && (rel.status === 304 ? rel.data : { tag: rel.data.tag_name, published_at: rel.data.published_at ?? null }) },
      };
      rows.push({ ecosystem: 'github', id: repo, observed_at: new Date(now).toISOString(), ...next[repo].core.data, latest_release: next[repo].release.data });
      if (rel.remaining != null && rel.remaining < minRemaining) stop = true;
    } catch (e) {
      if (e.rateLimited) { stop = true; stats.rate_limited = true; stats.skipped_rate_limit++; continue; }
      errors.push(`github:${repo}: ${e.message}`);
    }
  }
  if (stop) {
    stats.rate_limited = true;
    if (rows.length === 0 && repos.length > 0) errors.push('github: rate limited or forbidden before any repo was read (check the token)');
    else warnings.push(`github: stopped at the rate limit; ${stats.skipped_rate_limit} of ${repos.length} repos not read this run`);
  }
  return { rows, errors, missing, warnings, state: next, stats };
}
