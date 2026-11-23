// API budgets for the loop's GitHub calls.
//
// Every call the pump and the watchdog make goes through ApiBudget.take() first,
// and every response is shown to ApiBudget.observe() (ingest's calls inside the
// pump do this through budgetedFetch()). The budget:
//
//   - keeps each endpoint family under its own hourly and per-minute cap, and all
//     families together under totalPerHour (1,500 calls an hour by default);
//   - holds back a reserve in some families for essential calls (the health
//     issue must still be updatable when everything else is spent);
//   - spaces workflow dispatches 1 to 2 seconds apart, with jitter;
//   - honours retry-after, backs off at least a minute on a secondary rate limit
//     (longer on repeats), and waits for the reset when the primary limit is
//     spent;
//   - refuses non-essential calls when a primary limit is nearly spent.
//
// A cap that would need a long wait throws BudgetExceededError instead of
// sleeping, so a pump tick ends early and the next tick tries again.

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Caps per endpoint family. `resource` is GitHub's x-ratelimit-resource. */
export const DEFAULT_FAMILIES = Object.freeze({
  dispatch: Object.freeze({ perHour: 300, perMinute: 30, minIntervalMs: 1000, jitterMs: 1000 }),
  actions: Object.freeze({ perHour: 400, perMinute: 60 }),
  artifacts: Object.freeze({ perHour: 200, perMinute: 40 }),
  contents: Object.freeze({ perHour: 150, perMinute: 30 }),
  issues: Object.freeze({ perHour: 60, perMinute: 10, reserve: 10, minIntervalMs: 1000 }),
  graphql: Object.freeze({ perHour: 30, perMinute: 5, resource: 'graphql' }),
  search: Object.freeze({ perHour: 120, perMinute: 6, resource: 'search' }),
  auth: Object.freeze({ perHour: 60, perMinute: 10 }),
});

export class BudgetExceededError extends Error {
  constructor(message, { family, reason, retryAt = null } = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    this.family = family;
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

/** The family an API request belongs to. */
export function familyFor(method, path) {
  const m = String(method).toUpperCase();
  const p = String(path).split('?')[0];
  if (/^\/app(\/|$)/.test(p)) return 'auth';
  if (p === '/graphql') return 'graphql';
  if (p.startsWith('/search/')) return 'search';
  if (m === 'POST' && /\/actions\/workflows\/[^/]+\/dispatches$/.test(p)) return 'dispatch';
  if (/\/actions\/artifacts(\/|$)/.test(p) || /\/actions\/runs\/\d+\/artifacts$/.test(p)) return 'artifacts';
  if (/\/actions(\/|$)/.test(p)) return 'actions';
  if (/\/issues(\/|$)/.test(p)) return 'issues';
  return 'contents';
}

function header(res, name) {
  const h = res?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  return h[name] ?? h[name.toLowerCase()] ?? null;
}

const SECONDARY_RE = /secondary rate limit|abuse detection/i;

export class ApiBudget {
  constructor({
    families = {},
    totalPerHour = 1500,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
    maxWaitMs = 120_000,
    unhealthyBelow = 0.1,
  } = {}) {
    this.families = { ...DEFAULT_FAMILIES, ...families };
    this.totalPerHour = totalPerHour;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.maxWaitMs = maxWaitMs;
    this.unhealthyBelow = unhealthyBelow;
    this.state = new Map(); // family -> { hour: number[], minute: number[], nextAt }
    this.total = [];
    this.blocked = new Map(); // resource or '*' -> until (ms)
    this.resources = new Map(); // resource -> { limit, remaining, reset }
    this.secondaryHits = 0;
  }

  spec(family) {
    const s = this.families[family];
    if (!s) throw new TypeError(`unknown API family "${family}"`);
    return s;
  }

  resourceOf(family) {
    return this.spec(family).resource ?? 'core';
  }

  fam(family) {
    let s = this.state.get(family);
    if (!s) {
      s = { hour: [], minute: [], nextAt: 0 };
      this.state.set(family, s);
    }
    return s;
  }

  blockedUntil(resource) {
    return Math.max(this.blocked.get('*') ?? 0, resource ? this.blocked.get(resource) ?? 0 : 0);
  }

  /** False when a primary limit's remaining calls are below the healthy share. */
  healthy(resource = 'core') {
    const r = this.resources.get(resource);
    if (!r || !(r.limit > 0)) return true;
    if (this.now() >= r.reset) return true;
    return r.remaining >= r.limit * this.unhealthyBelow;
  }

  async waitOrThrow(family, until, reason, what) {
    const wait = until - this.now();
    if (wait > this.maxWaitMs) {
      throw new BudgetExceededError(`${family}: ${what}; ${Math.ceil(wait / 1000)} s is longer than the ${Math.round(this.maxWaitMs / 1000)} s we wait`, {
        family,
        reason,
        retryAt: until,
      });
    }
    await this.sleep(wait);
  }

  /** Wait until a call in `family` is allowed, then count it. */
  async take(family, { essential = false } = {}) {
    const spec = this.spec(family);
    const s = this.fam(family);
    const resource = this.resourceOf(family);
    for (;;) {
      const now = this.now();
      const until = this.blockedUntil(resource);
      if (until > now) {
        await this.waitOrThrow(family, until, 'blocked', 'API calls are blocked by a rate limit');
        continue;
      }
      if (!essential && !this.healthy(resource)) {
        const r = this.resources.get(resource);
        throw new BudgetExceededError(`${family}: the ${resource} rate limit is unhealthy (${r.remaining} of ${r.limit} left); only essential calls until it resets`, {
          family,
          reason: 'unhealthy',
          retryAt: r.reset,
        });
      }
      s.hour = s.hour.filter((t) => t > now - HOUR);
      s.minute = s.minute.filter((t) => t > now - MINUTE);
      this.total = this.total.filter((t) => t > now - HOUR);
      const reserve = essential ? 0 : spec.reserve ?? 0;
      if (s.hour.length >= spec.perHour) {
        throw new BudgetExceededError(`${family}: hourly budget of ${spec.perHour} calls is used`, { family, reason: 'hourly', retryAt: s.hour[0] + HOUR });
      }
      if (s.hour.length >= spec.perHour - reserve) {
        throw new BudgetExceededError(`${family}: only the reserve of ${reserve} calls is left, kept for essential calls`, { family, reason: 'reserve', retryAt: s.hour[0] + HOUR });
      }
      if (this.total.length >= this.totalPerHour) {
        throw new BudgetExceededError(`${family}: total hourly budget of ${this.totalPerHour} calls is used`, { family, reason: 'total', retryAt: this.total[0] + HOUR });
      }
      if (spec.perMinute && s.minute.length >= spec.perMinute) {
        await this.waitOrThrow(family, s.minute[0] + MINUTE, 'minute', `per-minute cap of ${spec.perMinute} reached`);
        continue;
      }
      if (s.nextAt > now) {
        await this.sleep(s.nextAt - now);
        continue;
      }
      s.hour.push(now);
      s.minute.push(now);
      this.total.push(now);
      if (spec.minIntervalMs) s.nextAt = now + spec.minIntervalMs + Math.floor(this.random() * (spec.jitterMs ?? 0));
      return;
    }
  }

  /** Learn from a response: rate-limit headers, retry-after and secondary limits. */
  observe(family, res, bodyText = '') {
    if (!res) return;
    const now = this.now();
    const status = Number(res.status);
    const resource = header(res, 'x-ratelimit-resource') || this.resourceOf(family);
    const limit = Number(header(res, 'x-ratelimit-limit'));
    const remaining = Number(header(res, 'x-ratelimit-remaining'));
    const resetSec = Number(header(res, 'x-ratelimit-reset'));
    const hasPrimary = header(res, 'x-ratelimit-remaining') !== null && Number.isFinite(remaining);
    if (hasPrimary) {
      const reset = Number.isFinite(resetSec) && resetSec > 0 ? resetSec * 1000 : now + HOUR;
      this.resources.set(resource, { limit: Number.isFinite(limit) ? limit : 0, remaining, reset });
      if (remaining <= 0) this.block(resource, reset + 1000);
    }
    const limited = status === 429 || status === 403;
    const retryAfter = header(res, 'retry-after');
    if (limited && retryAfter !== null) {
      const secs = Number(retryAfter);
      const until = Number.isFinite(secs) ? now + Math.max(1, secs) * 1000 : Date.parse(retryAfter);
      if (Number.isFinite(until)) this.block('*', until);
    }
    const secondary = limited && (SECONDARY_RE.test(String(bodyText ?? '')) || (status === 429 && !(hasPrimary && remaining <= 0)));
    if (secondary) {
      this.secondaryHits += 1;
      if (retryAfter === null) {
        const backoff = Math.min(15 * MINUTE, MINUTE * 2 ** Math.min(4, this.secondaryHits - 1));
        this.block('*', now + backoff);
      }
    }
  }

  block(resource, until) {
    this.blocked.set(resource, Math.max(this.blocked.get(resource) ?? 0, until));
  }

  /** Was the last response a rate-limit refusal (so the call may be retried after waiting)? */
  static isRateLimited(res, bodyText = '') {
    const status = Number(res?.status);
    if (status === 429) return true;
    if (status !== 403) return false;
    return header(res, 'retry-after') !== null || header(res, 'x-ratelimit-remaining') === '0' || SECONDARY_RE.test(String(bodyText ?? ''));
  }

  snapshot() {
    const now = this.now();
    const used = {};
    for (const [f, s] of this.state) used[f] = s.hour.filter((t) => t > now - HOUR).length;
    let blockedUntil = 0;
    for (const v of this.blocked.values()) blockedUntil = Math.max(blockedUntil, v);
    return {
      totalPerHour: this.totalPerHour,
      totalUsed: this.total.filter((t) => t > now - HOUR).length,
      used,
      blockedUntil,
      secondaryHits: this.secondaryHits,
      resources: Object.fromEntries(this.resources),
    };
  }
}

/**
 * A fetch that puts every call to the API host through `budget`: take() before
 * it is sent, observe() on the response. Other hosts (the blob storage an
 * artifact download redirects to) pass straight through. Code that takes a
 * plain fetch (ingest/github.mjs) is budgeted this way.
 */
export function budgetedFetch(fetch, budget, { apiUrl = 'https://api.github.com' } = {}) {
  const api = new URL(apiUrl);
  const base = api.pathname.replace(/\/+$/, '');
  return async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    if (url.origin !== api.origin) return fetch(input, init);
    const path = base && url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : url.pathname;
    const family = familyFor(init.method ?? input?.method ?? 'GET', path);
    await budget.take(family);
    const res = await fetch(input, init);
    const limited = res?.status === 403 || res?.status === 429;
    const bodyText = limited && typeof res.clone === 'function' ? await res.clone().text().catch(() => '') : '';
    budget.observe(family, res, bodyText);
    return res;
  };
}
