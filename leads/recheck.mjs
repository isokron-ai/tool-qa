// Re-check dispatch for leads (DESIGN-v3 section 7: "filed after a re-run on a
// different runner").
//
// A lead that is open and not reproduced yet names one (subject, lane) to
// re-check (state table leads: recheck_subject, recheck_lane, recheck_after;
// StateDb.noteLeads moves it to another pair when a re-check comes back clean,
// and stops after RECHECK_MAX_ATTEMPTS). While LANE_LEADS_ENABLED is "recheck"
// or "true", the pump's due list (pump/due.mjs, the leadReverify hook) makes
// that pair due again with the reason `lead_reverify` (weight
// priority.lead_reverify in pump/tiers.json) until a result newer than
// recheck_after is in. The re-check is a new workflow_dispatch: a new worker
// run on a fresh GitHub-hosted runner, which is a different runner instance by
// construction; the worker run id is recorded and noteLeads counts the
// re-check only from another run than the sighting. A lane whose workflows.json
// entry names `recheck_runner` (a runner label its worker workflow accepts as
// the `runner` input, for example ubuntu-24.04-arm) gets its re-checks in
// shards of their own, sent with that input (pump/tick.mjs planShards), so the
// re-run is on another architecture too.
//
// Infra leads get no re-check (they wait for 3 days of sightings instead), and
// at most RECHECK_MAX_DUE pairs are due at once, the leads that most subjects
// carry first, so the re-checks never crowd out the frame.

import { RECHECK_MAX_ATTEMPTS } from '../state/leads.mjs';

export const RECHECK_MAX_DUE = 20;
const SEP = '\u0000';

/**
 * The pairs to re-check now: `${subject}\0${lane}` -> recheck_after (ISO), how
 * many leads wait for one in all (`waiting`, for the watchdog), and how many
 * stopped because their re-check dispatches never came back (`given_up`).
 * @returns {{pairs: Map<string, string>, waiting: number, given_up: number}}
 */
export function recheckPairs(db, { max = RECHECK_MAX_DUE } = {}) {
  if (db.schemaVersion() < 11) return { pairs: new Map(), waiting: 0, given_up: 0 };
  // `sent`: dispatches of the pair since the sighting asked for the re-check. Any result folded in moves the lead on
  // (reproduced, moved, or an attempt counted), so dispatches that are still open, failed, lapsed or were rejected
  // are what this counts: a re-check whose worker never answers is not sent again after RECHECK_MAX_ATTEMPTS of them.
  const rows = db.raw.prepare(`
    SELECT l.fingerprint, l.recheck_subject AS subject, l.recheck_lane AS lane, l.recheck_after AS after, l.recheck_attempts AS attempts,
      (SELECT COUNT(*) FROM lead_subjects s WHERE s.fingerprint = l.fingerprint AND s.current = 1) AS carried,
      (SELECT COUNT(*) FROM dispatch_items i JOIN dispatches d ON d.attempt_id = i.attempt_id
        WHERE i.subject = l.recheck_subject AND i.workflow = l.recheck_lane AND d.created > l.recheck_after) AS sent
    FROM leads l
    WHERE l.status = 'open' AND l.issue_number IS NULL AND l.reproduced_at IS NULL AND l.fault != 'infra'
      AND l.recheck_subject IS NOT NULL AND l.recheck_lane IS NOT NULL AND l.recheck_after IS NOT NULL AND l.recheck_attempts < ?
    ORDER BY carried DESC, l.first_seen, l.fingerprint
  `).all(RECHECK_MAX_ATTEMPTS);
  const live = rows.filter((r) => r.attempts + r.sent < RECHECK_MAX_ATTEMPTS);
  const pairs = new Map();
  for (const r of live) {
    if (pairs.size >= max) break;
    const k = `${r.subject}${SEP}${r.lane}`;
    const prev = pairs.get(k);
    if (prev === undefined || r.after < prev) pairs.set(k, r.after);
  }
  return { pairs, waiting: live.length, given_up: rows.length - live.length };
}

/**
 * The due list's leadReverify hook over recheckPairs(): a pair is due while
 * its last accepted result is not newer than the sighting that asked for the
 * re-check. A pair with no result at all is due for its own reasons already.
 */
export function leadRecheckHook({ pairs }) {
  return (subject, workflowName, ctx) => {
    const after = pairs.get(`${subject.id}${SEP}${workflowName}`);
    if (after === undefined || !ctx?.last) return false;
    const last = Date.parse(ctx.last.accepted_at);
    const want = Date.parse(after);
    return Number.isFinite(last) && Number.isFinite(want) && last <= want;
  };
}

/** A runner label a worker workflow may be sent as `runner`: GitHub's label alphabet. */
export const RUNNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
