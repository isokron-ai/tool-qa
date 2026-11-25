// One retry policy for every GitHub call the loop makes that can pass on a
// second try: the pump's REST client (pump/github.mjs), the state asset
// (scripts/state-asset.mjs) and the snapshot release client
// (snapshot/github.mjs).
//
//   - Retried: HTTP 500, 502, 503, 504, 429, a network error or timeout, and
//     a 403 that carries a rate-limit signal (a Retry-After header, an
//     exhausted x-ratelimit-remaining whose reset is near, or the secondary
//     rate limit message). Every other 4xx is final at once.
//   - Delay: exponential with full jitter, random() x min(cap, base x 2^(n-1)),
//     base 2 s, cap 120 s. A Retry-After the server sends is used instead, up
//     to retryAfterCapMs (60 s); a longer one is not waited for.
//   - Bounded three ways: attempts per call (6), the total time slept by one
//     retrier (totalMs) and an absolute `until`, so a caller can never run past
//     its job's timeout-minutes or hold a lease past its expiry.
//   - Every retry is logged: label, attempt n/N, reason, delay. Messages carry
//     no token (the clients scrub error text before it gets here).
//
// Whether a call may be repeated at all is the caller's decision: a POST that
// failed on a server error or the network may have been carried out (R-CHAOS-13).

export const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
export const POLICY = Object.freeze({ attempts: 6, baseMs: 2000, capMs: 120_000, retryAfterCapMs: 60_000 });

const header = (headers, name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]) ?? null;

/** Full jitter: a random delay between 0 and min(cap, base x 2^(attempt-1)). */
export function backoffMs(attempt, { random = Math.random, baseMs = POLICY.baseMs, capMs = POLICY.capMs } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** The wait a Retry-After header asks for (seconds or an HTTP date), in ms, or null. */
export function retryAfterMs(headers, now = Date.now()) {
  const raw = header(headers, 'retry-after');
  if (raw === null || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs >= 0 ? Math.round(secs * 1000) : null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * Is this response one that may pass by itself, and how long does the server
 * say to wait?  `status` 0 is a network error or timeout.
 * @returns {{ retryable: boolean, waitMs: number|null }}
 */
export function classify({ status, headers, text = '', now = Date.now(), retryAfterCapMs = POLICY.retryAfterCapMs }) {
  if (status === 0 || [500, 502, 503, 504].includes(status)) {
    return { retryable: true, waitMs: status === 0 ? null : capWait(retryAfterMs(headers, now), retryAfterCapMs) };
  }
  if (status === 429) {
    const ask = retryAfterMs(headers, now);
    return ask !== null && ask > retryAfterCapMs ? { retryable: false, waitMs: null } : { retryable: true, waitMs: ask };
  }
  if (status === 403) {
    const ask = retryAfterMs(headers, now);
    if (ask !== null) return ask > retryAfterCapMs ? { retryable: false, waitMs: null } : { retryable: true, waitMs: ask };
    if (header(headers, 'x-ratelimit-remaining') === '0') {
      const reset = Number(header(headers, 'x-ratelimit-reset'));
      const wait = Number.isFinite(reset) ? Math.max(0, reset * 1000 - now) + 1000 : null;
      return wait !== null && wait <= retryAfterCapMs ? { retryable: true, waitMs: wait } : { retryable: false, waitMs: null };
    }
    if (/secondary rate limit|abuse detection/i.test(String(text))) return { retryable: true, waitMs: null };
  }
  return { retryable: false, waitMs: null };
}

function capWait(ms, cap) {
  return ms === null ? null : Math.min(ms, cap);
}

/** The HTTP status behind a retryable error: its `status`, else the one in its reason, else 0 (network). */
export function statusOf(err) {
  if (Number.isInteger(err?.status)) return err.status;
  const m = /HTTP (\d{3})/.exec(String(err?.reason ?? ''));
  return m ? Number(m[1]) : 0;
}

/**
 * A retrier shared by the calls of one client. `run(label, attemptFn)` calls
 * attemptFn(n) until it returns. attemptFn signals a failure that may pass by
 * throwing an error with `retryable: true` (and `waitMs`, if the server said
 * how long); any other throw is final.
 *
 * `totalMs` caps all the sleeping this retrier does; `until` (an absolute time
 * in ms, or a function returning one) stops retries that could not finish
 * before it. Both keep the caller inside its own deadline.
 *
 * `onRetry` (optional) is called as onRetry({ label, attempt, status, delayMs,
 * gaveUp }) where the retry is logged: once per attempt that will be repeated
 * and once when the retrier gives up (gaveUp: true). `status` is 0 for a
 * network error or timeout.
 */
export function createRetrier({
  attempts = POLICY.attempts,
  baseMs = POLICY.baseMs,
  capMs = POLICY.capMs,
  totalMs = 180_000,
  until = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  now = Date.now,
  log = () => {},
  onRetry = null,
} = {}) {
  let waited = 0;
  // onRetry({ label, attempt, status, delayMs, gaveUp }): told about every
  // failed attempt that is retried and about the one that gives up. A hook
  // that throws never changes the retry (it is a view of the retry, nothing more).
  const tell = (info) => {
    if (typeof onRetry !== 'function') return;
    try { onRetry(info); } catch { /* observers cannot break the policy */ }
  };
  return {
    get waitedMs() { return waited; },
    async run(label, attemptFn) {
      for (let n = 1; ; n++) {
        try {
          return await attemptFn(n);
        } catch (err) {
          if (!err?.retryable) throw err;
          const lastAttempt = n >= attempts;
          const delay = lastAttempt ? 0 : err.waitMs ?? backoffMs(n, { random, baseMs, capMs });
          const limit = typeof until === 'function' ? until() : until;
          const outOfTime = waited + delay > totalMs || (limit !== null && limit !== undefined && now() + delay > limit);
          if (lastAttempt || outOfTime) {
            tell({ label, attempt: n, status: statusOf(err), delayMs: 0, gaveUp: true });
            log(`retry: ${label}: ${err.reason ?? 'failed'}; giving up after ${n} attempt${n === 1 ? '' : 's'} (${lastAttempt ? 'attempt limit' : 'time limit'}, waited ${Math.round(waited / 1000)}s)`);
            throw err;
          }
          waited += delay;
          tell({ label, attempt: n, status: statusOf(err), delayMs: delay, gaveUp: false });
          log(`retry: ${label}: ${err.reason ?? 'failed'}; attempt ${n}/${attempts} failed, next in ${(delay / 1000).toFixed(1)}s`);
          if (delay > 0) await sleep(delay);
        }
      }
    },
  };
}

/**
 * Mark a failed response's error for the retrier: `transient` (it may pass
 * by itself, what callers like the pump's cannot-start path read) and, when
 * the call may be repeated, `retryable` with the server's wait.
 */
export function markRetry(err, { status, headers, text = '', now = Date.now(), repeatable }) {
  const v = classify({ status, headers, text, now });
  if (v.retryable || RETRY_STATUS.has(status)) err.transient = true;
  if (v.retryable && repeatable) {
    err.retryable = true;
    if (v.waitMs !== null) err.waitMs = v.waitMs;
  }
  err.reason = status ? `HTTP ${status}` : 'network error';
  return err;
}
