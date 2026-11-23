// A small GitHub REST client for the loop.
//
// - Every call takes from an ApiBudget first and shows it the response, so
//   endpoint caps, pacing and rate-limit back-off live in one place.
// - Server errors (5xx) and network failures are retried with exponential
//   back-off. A rate-limit refusal is retried after the budget's wait. Other
//   4xx responses throw GitHubError straight away.
// - The token never appears in an error message or a log line.

import { ApiBudget, familyFor } from './budgets.mjs';

export const API_VERSION = '2022-11-28';
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status = 0, method, path, documentationUrl = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.documentationUrl = documentationUrl;
  }
}

/** Replace every secret in `text` with ***. */
export function scrub(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

function buildUrl(apiUrl, path, query) {
  const url = new URL(path.startsWith('http') ? path : `${apiUrl.replace(/\/+$/, '')}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * @param {{ token: string, fetch?: typeof fetch, apiUrl?: string, budget?: ApiBudget,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, random?: () => number,
 *   maxAttempts?: number, userAgent?: string }} opts
 */
export function createClient({
  token,
  fetch = globalThis.fetch,
  apiUrl = DEFAULT_API,
  budget,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  random = Math.random,
  maxAttempts = 4,
  userAgent = 'isokron-tool-qa',
} = {}) {
  if (!token) throw new TypeError('createClient: a token is required');
  const bud = budget ?? new ApiBudget({ now, sleep });
  const secrets = [token];

  async function request(method, path, { query, body, family, essential = false, accept, allow = [], headers: extra = {}, redirect, retryUnsafe = false } = {}) {
    const m = String(method).toUpperCase();
    // A POST that failed on a server error or the network may still have been
    // carried out (a dispatch, a new issue), so only repeat it when told it is
    // harmless. A rate-limit refusal is always safe to repeat.
    const repeatable = retryUnsafe || IDEMPOTENT.has(m);
    const fam = family ?? familyFor(m, path);
    const url = buildUrl(apiUrl, path, query);
    const where = `${m} ${url.pathname}`;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await bud.take(fam, { essential });
      const headers = {
        accept: accept ?? 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
        'user-agent': userAgent,
        ...extra,
      };
      const init = { method: m, headers };
      if (body !== undefined) {
        init.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
        if (!headers['content-type']) headers['content-type'] = 'application/json';
      }
      if (redirect) init.redirect = redirect;
      let res;
      try {
        res = await fetch(url.href, init);
      } catch (err) {
        lastError = new GitHubError(scrub(`${where}: network error: ${err?.message ?? err}`, secrets), { status: 0, method: m, path: url.pathname });
        if (repeatable && attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        throw lastError;
      }
      const text = res.status === 204 || res.status === 304 ? '' : await res.text();
      bud.observe(fam, res, text);
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      const ok = (res.status >= 200 && res.status < 300) || (res.status >= 300 && res.status < 400 && redirect === 'manual');
      if (ok || allow.includes(res.status)) return { status: res.status, headers: res.headers, data };
      const message = typeof data === 'object' && data?.message ? data.message : String(text).slice(0, 200);
      lastError = new GitHubError(scrub(`${where} returned ${res.status}: ${message}`, secrets), {
        status: res.status,
        method: m,
        path: url.pathname,
        documentationUrl: typeof data === 'object' ? data?.documentation_url ?? null : null,
      });
      const rateLimited = ApiBudget.isRateLimited(res, text);
      const retryable = rateLimited || (repeatable && res.status >= 500);
      if (!retryable || attempt >= maxAttempts) throw lastError;
      if (!rateLimited) await sleep(backoff(attempt));
      // Rate limited: the budget now holds every call until the limit passes,
      // or throws BudgetExceededError on the next take() if that is too long.
    }
    throw lastError;
  }

  function backoff(attempt) {
    return 1000 * 2 ** (attempt - 1) + Math.floor(random() * 500);
  }

  /** GET every page of a list endpoint. `key` names the array in an object response. */
  async function paginate(path, { query = {}, key, perPage = 100, maxPages = 20, family, essential } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await request('GET', path, { query: { ...query, per_page: perPage, page }, family, essential });
      const items = key ? res.data?.[key] ?? [] : res.data ?? [];
      out.push(...items);
      if (items.length < perPage) break;
    }
    return out;
  }

  return { request, paginate, budget: bud, apiUrl, scrub: (t) => scrub(t, secrets) };
}
