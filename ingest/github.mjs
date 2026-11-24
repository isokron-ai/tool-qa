// The few GitHub REST calls ingest needs: a workflow run, its artifacts, an
// artifact's bytes, and (for the pump) the run a dispatch created, by run name.
//
// The token goes only to the API host. An artifact download answers with a
// redirect to blob storage; that hop is followed by hand, https only, without
// the Authorization header. Downloads are capped in size. 429, 5xx, rate-limit
// 403s and network errors are retried with backoff and then reported as
// transient (the caller records nothing and can run again). A
// BudgetExceededError thrown by the fetch it is given (the pump's API budget)
// passes straight through, unretried.

import { MAX_ARTIFACT_BYTES } from '../worker-kit/contract.mjs';

const API_VERSION = '2022-11-28';
/**
 * One artifact download, retries and redirects included, ends within this
 * time: about 0.5 MB/s for the largest artifact allowed, so a stalled storage
 * host cannot hold a pump tick past its end.
 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ID_RE = /^[1-9]\d{0,19}$/;
const WORKFLOW_FILE_RE = /^(?:\.github\/workflows\/)?([A-Za-z0-9_.-]{1,100}\.ya?ml)$/;

export class GithubError extends Error {
  constructor(message, { status = 0, transient = false, code = null } = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.transient = transient;
    this.code = code; // 'too_large' when a download passes the size cap
  }
}

function checkRepo(repo) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
    throw new GithubError(`invalid repo ${JSON.stringify(String(repo).slice(0, 120))}`);
  }
  return repo.split('/').map(encodeURIComponent).join('/');
}

function checkId(kind, id) {
  if (!ID_RE.test(String(id))) throw new GithubError(`invalid ${kind} ${JSON.stringify(String(id).slice(0, 40))}`);
  return String(id);
}

async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new GithubError(`artifact is larger than ${max} bytes`, { code: 'too_large' });
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > max) {
      await res.body.cancel?.().catch(() => {});
      throw new GithubError(`artifact is larger than ${max} bytes`, { code: 'too_large' });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

/**
 * @param {object} p
 * @param {string} p.token
 * @param {Function} [p.fetch]
 * @param {string} [p.apiUrl]
 * @param {(ms: number) => Promise<void>} [p.sleep]
 * @param {number} [p.retries]           extra attempts after the first (default 3)
 * @param {number} [p.maxDownloadBytes]  default MAX_ARTIFACT_BYTES (worker-kit/contract.mjs)
 * @param {number} [p.downloadTimeoutMs]  one artifact download, all of it (DOWNLOAD_TIMEOUT_MS)
 * @param {() => AbortSignal|null} [p.deadlineSignal]  the caller's hard deadline (R-ING-17): every
 *   request is aborted when it fires, and once it has fired nothing more is sent (no retry either);
 *   the call fails as a transient GithubError with code 'deadline'
 */
export function makeGithub({
  token, fetch = globalThis.fetch, apiUrl = 'https://api.github.com',
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 3, maxDownloadBytes = MAX_ARTIFACT_BYTES,
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS, deadlineSignal = () => null,
} = {}) {
  if (!token) throw new GithubError('a GitHub token is required');
  const api = new URL(apiUrl);
  if (api.protocol !== 'https:') throw new GithubError('apiUrl must be https');
  const apiHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'tool-qa-ingest',
  };

  // A request's own time limit, cut short by the caller's deadline.
  const limit = (ms) => {
    const d = deadlineSignal();
    return d ? AbortSignal.any([AbortSignal.timeout(ms), d]) : AbortSignal.timeout(ms);
  };
  const pastDeadline = (label) => {
    if (deadlineSignal()?.aborted) throw new GithubError(`${label}: past the deadline; not sent`, { transient: true, code: 'deadline' });
  };

  // One logical request with retries. `send` returns a Response.
  async function withRetries(label, send) {
    let delay = 1000;
    for (let attempt = 0; ; attempt++) {
      let wait = delay;
      let res;
      pastDeadline(label);
      try {
        res = await send();
      } catch (err) {
        if (err?.name === 'BudgetExceededError') throw err;
        if (attempt >= retries) throw new GithubError(`${label}: network error (${err.cause?.code ?? err.name})`, { transient: true });
      }
      if (res) {
        const rateLimited = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0';
        if (res.status !== 429 && res.status < 500 && !rateLimited) return res;
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra, 60) * 1000;
        await res.body?.cancel().catch(() => {});
        if (attempt >= retries) throw new GithubError(`${label}: HTTP ${res.status}`, { status: res.status, transient: true });
      }
      pastDeadline(label);
      await sleep(wait);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  async function apiGet(path) {
    const url = new URL(path, api);
    return withRetries(`GET ${url.pathname}`, () => fetch(url, { headers: apiHeaders, redirect: 'manual', signal: limit(60_000) }));
  }

  async function apiJson(path) {
    const res = await apiGet(path);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      // A 3xx here means a renamed or moved repository: not followed with the token.
      throw new GithubError(`GET ${path.split('?')[0]}: HTTP ${res.status}`, { status: res.status });
    }
    return res.json();
  }

  return {
    /** The workflow run, or null if it does not exist (or is not visible to the token). */
    async getRun(repo, runId) {
      const path = `/repos/${checkRepo(repo)}/actions/runs/${checkId('run id', runId)}`;
      try {
        return await apiJson(path);
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },

    /**
     * The workflow_dispatch run of `workflowFile` (a file name, or a path under
     * .github/workflows/) whose run name is `runName`, created at or after
     * `since` (ISO time), from the newest 100; null if there is none yet.
     */
    async findDispatchRun(repo, workflowFile, runName, { since } = {}) {
      const m = WORKFLOW_FILE_RE.exec(String(workflowFile));
      if (!m) throw new GithubError(`invalid workflow file ${JSON.stringify(String(workflowFile).slice(0, 120))}`);
      const query = new URLSearchParams({ event: 'workflow_dispatch', per_page: '100' });
      if (since) query.set('created', `>=${since}`);
      const body = await apiJson(`/repos/${checkRepo(repo)}/actions/workflows/${encodeURIComponent(m[1])}/runs?${query}`);
      const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
      return runs.find((r) => r && (r.display_title === runName || r.name === runName)) ?? null;
    },

    /** Every artifact of a run (all pages, up to 1000). */
    async listRunArtifacts(repo, runId) {
      const base = `/repos/${checkRepo(repo)}/actions/runs/${checkId('run id', runId)}/artifacts`;
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const body = await apiJson(`${base}?per_page=100&page=${page}`);
        const items = Array.isArray(body.artifacts) ? body.artifacts : [];
        out.push(...items);
        if (items.length < 100 || out.length >= Number(body.total_count ?? 0)) break;
      }
      return out;
    },

    /** The artifact's bytes (a zip, or the file itself for archive: false uploads). */
    async downloadArtifact(repo, artifactId) {
      const path = `/repos/${checkRepo(repo)}/actions/artifacts/${checkId('artifact id', artifactId)}/zip`;
      const signal = limit(downloadTimeoutMs); // the whole download, blob body included
      let res = await apiGet(path);
      for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location || hops >= 3) throw new GithubError(`GET ${path}: redirect without a usable location`);
        let next;
        try { next = new URL(location); } catch { throw new GithubError(`GET ${path}: redirect location is not a URL`); }
        if (next.protocol !== 'https:') throw new GithubError(`GET ${path}: redirect must be https`);
        // No Authorization header past the API host.
        res = await withRetries('GET artifact blob', () => fetch(next, {
          headers: { 'User-Agent': 'tool-qa-ingest' }, redirect: 'manual', signal,
        }));
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new GithubError(`GET ${path}: HTTP ${res.status}`, { status: res.status });
      }
      try {
        return await readCapped(res, maxDownloadBytes);
      } catch (err) {
        if (err instanceof GithubError) throw err;
        // The body stalled past the time limit, or the connection dropped.
        throw new GithubError(`GET ${path}: download failed (${err?.name ?? 'error'})`, { transient: true });
      }
    },
  };
}
