// Leads (DESIGN-v3 section 7, "Leads -> issues on our repos"): the rules, as
// pure functions. The state store (state/db.mjs noteLeads) keeps the leads and
// where they were seen; the pump's lead step (later parts of this work)
// re-checks, files and closes them; the dry run (leads/dry-run.mjs) replays the
// archive through the same code.
//
//   - a lead is filed only after a re-run on another runner (another worker run
//     of the same subject and lane) showed it again;
//   - one issue per lead (fingerprint), with no third-party names or code;
//   - at most 5 new issues per repository per day and 30 open per repository;
//   - an infra failure (a passing condition) is filed only once it has lasted
//     3 days; a flaky lead (it went away and came back on the same subject) only
//     at a rate of 10% or more over 14 days;
//   - 3 clean re-checks, with no subject carrying it any more, close it; it is
//     reopened if it comes back.
//
// A clean re-check is an accepted result of a (subject, lane) that carried the
// lead, from another worker run, that was assessed (no skip at all: worker-kit
// contract coverage "assessed") and does not carry it. A result that skipped a
// stage says nothing about what that stage would have shown, so it is never
// counted as clean.

import { readFileSync } from 'node:fs';

export const CLEAN_RECHECKS_TO_CLOSE = 3;
export const FLAKE_MIN_RATE = 0.10;
export const FLAKE_WINDOW_DAYS = 14;
export const INFRA_MIN_DAYS = 3;
/** An infra lead must still be happening: seen within this long. */
export const INFRA_RECENT_DAYS = 1;
export const CAP_NEW_PER_REPO_PER_DAY = 5;
export const CAP_OPEN_PER_REPO = 30;
/** A pair's log keeps at most this many results (the flake window's). */
export const LOG_MAX = 32;
export const VERSIONS_MAX = 10;
/** A pair not checked for this long no longer holds a lead open. */
export const STALE_PAIR_DAYS = 30;
/** Re-checks of a lead that came back clean before the pump stops re-dispatching it. */
export const RECHECK_MAX_ATTEMPTS = 3;

const DAY = 86_400_000;

/**
 * The columns of a lead that may go into a public issue or job summary: the
 * fingerprint's shape, our tool and repository, counts and times. Everything
 * else in the leads tables (recheck_subject, lead_subjects) can name a subject
 * and stays in the state.
 */
export const SHAPE_COLUMNS = Object.freeze(['fingerprint', 'repo', 'tool', 'lane', 'component', 'oracle', 'class', 'idiom', 'layout', 'signature', 'partial', 'fault',
  'versions', 'status', 'sightings', 'first_seen', 'last_seen', 'reproduced_at', 'clean_rechecks', 'issue_number', 'issue_state', 'filed_at', 'reopened', 'closed_at', 'close_reason']);
/** A lead reduced to SHAPE_COLUMNS. */
export const shapeOf = (lead) => Object.fromEntries(SHAPE_COLUMNS.filter((k) => k in lead).map((k) => [k, lead[k]]));

/**
 * The lead pipeline's switch, LANE_LEADS_ENABLED. Off unless set to one of:
 *   dry-run   fingerprints are kept in the state; the filing plan goes to the job
 *             summary; nothing is re-dispatched, no issue is touched
 *   recheck   dry-run, and the pump re-dispatches leads to re-check them
 *   true      all of it: re-checks, and issues filed, closed and reopened
 * @returns {'off'|'dry-run'|'recheck'|'on'}
 */
export function leadsMode(env = process.env) {
  const v = env?.LANE_LEADS_ENABLED;
  if (v === 'true') return 'on';
  if (v === 'dry-run' || v === 'recheck') return v;
  return 'off';
}
export const recordsLeads = (mode) => mode !== 'off';
export const rechecksLeads = (mode) => mode === 'recheck' || mode === 'on';
export const filesLeads = (mode) => mode === 'on';

let routingCache = null;
/** leads/routing.json (read once). */
export function loadRouting(file = new URL('../leads/routing.json', import.meta.url)) {
  if (file instanceof URL && String(file) === String(new URL('../leads/routing.json', import.meta.url)) && routingCache) return routingCache;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(r.repos) || typeof r.default !== 'string' || !r.repos.includes(r.default)) throw new Error('leads/routing.json: repos must list the default');
  if (file instanceof URL) routingCache = r;
  return r;
}

/** Our repository a lead's issue goes to: by lane and component, else by lane, else the default. Always one of routing.repos. */
export function repoFor({ lane, component }, routing = loadRouting()) {
  const pick = routing.components?.[lane]?.[component] ?? routing.lanes?.[lane] ?? routing.default;
  return routing.repos.includes(pick) ? pick : routing.default;
}

/** A pair's log with one more result, trimmed to the window and LOG_MAX. */
export function pushLog(log, at, hit, { now = at } = {}) {
  const since = Date.parse(now) - FLAKE_WINDOW_DAYS * DAY;
  const next = [...(Array.isArray(log) ? log : []), [at, hit ? 1 : 0]].filter((e) => Date.parse(e[0]) >= since);
  return next.slice(-LOG_MAX);
}

/** Versions seen, newest last, without repeats, at most VERSIONS_MAX. */
export function mergeVersions(old, add) {
  const out = (Array.isArray(old) ? old : []).filter((v) => !add.includes(v));
  return [...out, ...add].slice(-VERSIONS_MAX);
}

/**
 * The flake numbers of a lead from its pairs' logs over the window: the rate
 * is results that carried it over all results of the pairs that ever did.
 * flaky: some pair went clean and then carried it again.
 */
export function flakeStats(pairs, now) {
  const since = Date.parse(now) - FLAKE_WINDOW_DAYS * DAY;
  let hits = 0;
  let total = 0;
  let flaky = false;
  for (const p of pairs) {
    const log = (typeof p.log === 'string' ? JSON.parse(p.log) : p.log ?? []).filter((e) => Date.parse(e[0]) >= since)
      .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
    let cleanSeen = false;
    for (const [, hit] of log) {
      total += 1;
      if (hit) { hits += 1; if (cleanSeen) flaky = true; } else cleanSeen = true;
    }
  }
  return { hits, total, rate: total ? hits / total : 0, flaky };
}

/**
 * Whether a lead may be filed now, before the caps (the filing step applies
 * those). null for a lead that is not open or has an issue.
 * @returns {{file: boolean, reason: string}|null}
 */
export function filingDecision(lead, { pairs = [], now }) {
  if (lead.status !== 'open' || lead.issue_number != null) return null;
  const t = Date.parse(now);
  if (lead.fault === 'infra') {
    if (t - Date.parse(lead.first_seen) < INFRA_MIN_DAYS * DAY) return { file: false, reason: 'infra_under_3_days' };
    if (t - Date.parse(lead.last_seen) > INFRA_RECENT_DAYS * DAY) return { file: false, reason: 'infra_not_recent' };
    if (!(lead.sightings >= 2)) return { file: false, reason: 'infra_seen_once' };
    return { file: true, reason: 'infra_3_days' };
  }
  const flake = flakeStats(pairs, now);
  if (flake.flaky) return flake.rate >= FLAKE_MIN_RATE ? { file: true, reason: 'flake_rate' } : { file: false, reason: 'flake_under_10pct' };
  if (lead.reproduced_at) return { file: true, reason: 'reproduced' };
  if (lead.recheck_subject == null && lead.recheck_attempts >= RECHECK_MAX_ATTEMPTS) return { file: false, reason: 'not_reproduced' };
  return { file: false, reason: 'recheck_pending' };
}

/** Whether the issue's state on GitHub must change to follow the lead's status. */
export function needsSync({ status, issue_number: n, issue_state: s }) {
  if (n == null) return false;
  return status === 'filed' ? s !== 'open' : status === 'closed' ? s === 'open' : false;
}
