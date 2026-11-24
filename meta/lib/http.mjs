// HTTP for the metadata lanes: a User-Agent, time limits, bounded retries,
// per-host pacing, conditional requests (ETag / Last-Modified) and rate-limit
// accounting.
//
// Conditional requests: a successful answer is stored in the cache as the
// summary we extracted from it (never the body), with its ETag or
// Last-Modified. The next request for the same URL sends If-None-Match /
// If-Modified-Since; a 304 answer gives the stored summary back. On GitHub a
// 304 does not count against the rate limit. The cache is a JSON file that the
// workflow keeps between runs with actions/cache.
//
// Errors: a rate limit, a timeout, a network error or a 5xx that is still
// there after the retries throws FetchProblem with code `rate_limited` or
// `upstream_unavailable`; the caller records a retryable skip for that stage.
// Any other status is returned to the caller.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const USER_AGENT = 'isokron-tool-qa-meta/1 (+https://github.com/isokron-ai/tool-qa)';
export const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 50_000;

export class FetchProblem extends Error {
  /** @param {'rate_limited'|'upstream_unavailable'} code */
  constructor(code, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'FetchProblem';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** An in-memory cache, optionally loaded from and saved to a file. */
export function createCache({ path = null, now = () => Date.now() } = {}) {
  let entries = new Map();
  if (path) {
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      if (doc && doc.version === CACHE_VERSION && doc.entries && typeof doc.entries === 'object') {
        for (const [k, v] of Object.entries(doc.entries)) {
          if (v && typeof v === 'object' && (typeof v.etag === 'string' || typeof v.last_modified === 'string')) entries.set(k, v);
        }
      }
    } catch { /* no cache yet, or unreadable: start empty */ }
  }
  return {
    get: (key) => entries.get(key),
    set(key, v) {
      entries.delete(key);
      entries.set(key, { ...v, at: new Date(now()).toISOString() });
    },
    get size() { return entries.size; },
    save(to = path) {
      if (!to) return false;
      // Keep the newest entries (Map keeps insertion order; set() moves a key to the end).
      if (entries.size > MAX_CACHE_ENTRIES) entries = new Map([...entries].slice(entries.size - MAX_CACHE_ENTRIES));
      const tmp = `${to}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(entries) }));
      renameSync(tmp, to);
      return true;
    },
  };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * @param {object} o
 * @param {typeof fetch} [o.fetch]
 * @param {ReturnType<typeof createCache>} [o.cache]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 * @param {number} [o.timeoutMs]       per request
 * @param {number} [o.retries]         extra tries after a 5xx, 429 or network error
 * @param {number} [o.maxRetryWaitMs]  a Retry-After longer than this is not waited for
 * @param {Record<string, number>} [o.minIntervalMs]  host -> least time between requests
 */
export function createHttp({
  fetch: f = globalThis.fetch,
  cache = createCache(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  timeoutMs = 20_000,
  retries = 2,
  maxRetryWaitMs = 20_000,
  minIntervalMs = {},
} = {}) {
  const lastAt = new Map();
  const queue = new Map(); // host -> promise chain, so pacing holds under concurrency
  const stats = { requests: 0, not_modified: 0, retries: 0, by_host: {} };

  async function pace(host) {
    const gap = minIntervalMs[host];
    if (!gap) return;
    const prev = queue.get(host) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    queue.set(host, prev.then(() => mine));
    await prev;
    const wait = (lastAt.get(host) ?? -Infinity) + gap - now();
    if (wait > 0) await sleep(wait);
    lastAt.set(host, now());
    release();
  }

  /**
   * One request with retries. Returns { status, headers, text() , json() }.
   * Throws FetchProblem for a rate limit or an outage that outlasts the retries.
   */
  async function request(url, { method = 'GET', headers = {}, body, rateLimitCheck } = {}) {
    const host = hostOf(url);
    for (let attempt = 0; ; attempt++) {
      await pace(host);
      stats.requests++;
      stats.by_host[host] = (stats.by_host[host] ?? 0) + 1;
      let res;
      try {
        res = await f(url, {
          method,
          body,
          redirect: 'follow',
          headers: { 'user-agent': USER_AGENT, ...headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < retries) { stats.retries++; await sleep(1000 * 2 ** attempt); continue; }
        throw new FetchProblem('upstream_unavailable', `${host}: ${err?.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
      }
      const limited = res.status === 429 || (rateLimitCheck ? rateLimitCheck(res) : false);
      if (limited || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 1000 * 2 ** attempt;
        if (attempt < retries && waitMs <= maxRetryWaitMs) { stats.retries++; await sleep(waitMs); continue; }
        await res.body?.cancel?.().catch(() => {});
        throw new FetchProblem(limited ? 'rate_limited' : 'upstream_unavailable', `${host}: HTTP ${res.status}`, { status: res.status, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : null });
      }
      return res;
    }
  }

  /**
   * A GET whose answer is reduced to a summary by `extract(json, res)`, with a
   * conditional request when the cache has the URL. `version` names the
   * extractor: a cached summary from another version is not used.
   * @returns {Promise<{status: number, value: any, cached: boolean, res: Response|null}>}
   *   status 200 (or 304, with the cached value), or any other status with value null
   */
  async function getSummary(url, { extract, version, headers = {}, rateLimitCheck, parse = 'json', cacheKey = url } = {}) {
    const hit = cache.get(cacheKey);
    const usable = hit && hit.v === version;
    const h = { ...headers };
    if (usable && hit.etag) h['if-none-match'] = hit.etag;
    else if (usable && hit.last_modified) h['if-modified-since'] = hit.last_modified;
    const res = await request(url, { headers: h, rateLimitCheck });
    if (res.status === 304 && usable) {
      stats.not_modified++;
      cache.set(cacheKey, hit);
      return { status: 304, value: hit.value, cached: true, res };
    }
    if (res.status !== 200) {
      await res.body?.cancel?.().catch(() => {});
      return { status: res.status, value: null, cached: false, res };
    }
    let doc;
    try {
      doc = parse === 'text' ? await res.text() : await res.json();
    } catch {
      throw new FetchProblem('upstream_unavailable', `${hostOf(url)}: the answer is not ${parse === 'text' ? 'text' : 'JSON'}`, { status: 200 });
    }
    const value = await extract(doc, res);
    const etag = res.headers.get('etag');
    const lm = res.headers.get('last-modified');
    if (etag || lm) cache.set(cacheKey, { v: version, ...(etag ? { etag } : {}), ...(lm ? { last_modified: lm } : {}), value });
    return { status: 200, value, cached: false, res };
  }

  return { request, getSummary, stats, cache };
}

/** Run `fn` over `list` with at most `n` at a time, in order of start. */
export async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}
