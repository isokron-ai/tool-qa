// The watchdog's `leads` item: the lead pipeline itself (leads/step.mjs writes
// kv leads.last once per pump run; leads/recheck.mjs writes kv leads.recheck on
// every tick that re-checks).
//
//   off    LANE_LEADS_ENABLED is not dry-run, recheck or true
//   amber  the lead step has written nothing for LEADS_STALE_MS (the pump runs
//          every few minutes, so it stopped producing output), or its last run
//          had errors (a token, a repository, GitHub), or the queue grows
//          without bound: more than QUEUE_AMBER open leads waiting for an
//          issue, the open count rose on every sample of the last
//          GROWTH_WINDOW_MS by GROWTH_AMBER or more, more than RECHECK_AMBER
//          leads waiting for a re-check, or more than GIVEN_UP_AMBER re-checks
//          given up because their worker never answered
//   green  otherwise, with the counts
// Never red: a lead is about our tools; the loop itself is still working.

const MIN = 60_000;
const HOUR = 60 * MIN;
export const LEADS_THRESHOLDS = Object.freeze({
  staleMs: 2 * HOUR,
  queueAmber: 500,
  growthWindowMs: 24 * HOUR,
  growthAmber: 100,
  recheckAmber: 200,
  givenUpAmber: 50,
});

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ago = (ms) => (ms < 2 * HOUR ? `${Math.round(ms / MIN)} minutes ago` : `${(ms / HOUR).toFixed(1)} hours ago`);

/**
 * @param {{now: number, mode: string, last: object|null, recheck?: object|null, t?: typeof LEADS_THRESHOLDS}} input
 *   mode: state/leads.mjs leadsMode(env) of the watchdog's own environment
 */
export function leadsCheck({ now, mode, last, recheck = null, t = LEADS_THRESHOLDS }) {
  const id = 'leads';
  if (mode === 'off') return { id, status: 'off', summary: 'the lead pipeline is switched off (LANE_LEADS_ENABLED is not dry-run, recheck or true)' };
  if (last && typeof last === 'object' && last.off === true) {
    return { id, status: 'amber', summary: `the lead pipeline is on (${mode}) here, but the pump's lead step ran as off: is LANE_LEADS_ENABLED passed to the pump step (pump.yml)?`, at: last.at };
  }
  const rec = last && typeof last === 'object' ? last : null;
  const at = rec ? Date.parse(rec.at) : NaN;
  if (!Number.isFinite(at)) return { id, status: 'amber', summary: `the lead pipeline is on (${mode}) but the pump's lead step has written nothing yet` };
  const age = now - at;
  const counts = `${n(rec.open)} open, ${n(rec.filed_total)} filed, ${n(rec.closed_total)} closed; last run filed ${n(rec.filed)}, closed ${n(rec.closed)}, reopened ${n(rec.reopened)}`;
  if (age > t.staleMs) return { id, status: 'amber', summary: `the pump's lead step has written nothing for ${ago(age).replace(' ago', '')} (${mode}): it stopped producing output (${counts})`, at: rec.at };
  const problems = [];
  if (n(rec.errors) > 0) problems.push(`its last run had ${n(rec.errors)} error${n(rec.errors) === 1 ? '' : 's'} (see the pump log, "leads:")`);
  if (n(rec.open) > t.queueAmber) problems.push(`${n(rec.open)} open leads wait for an issue (more than ${t.queueAmber})`);
  const hist = (Array.isArray(rec.history) ? rec.history : []).filter((h) => Array.isArray(h) && now - Date.parse(h[0]) <= t.growthWindowMs);
  if (hist.length >= 3) {
    const rising = hist.every((h, i) => i === 0 || n(h[1]) > n(hist[i - 1][1]));
    const grew = n(hist.at(-1)[1]) - n(hist[0][1]);
    if (rising && grew >= t.growthAmber) problems.push(`the open queue rose on every sample of the last ${Math.round(t.growthWindowMs / HOUR)} hours, by ${grew}`);
  }
  const rc = recheck && typeof recheck === 'object' ? recheck : null;
  if (rc && n(rc.waiting) > t.recheckAmber) problems.push(`${n(rc.waiting)} leads wait for a re-check (more than ${t.recheckAmber})`);
  if (rc && n(rc.given_up) > t.givenUpAmber) problems.push(`${n(rc.given_up)} re-checks were given up because their worker never answered`);
  if (problems.length) return { id, status: 'amber', summary: `${problems.join('; ')} (${mode}; ${counts})`, at: rec.at };
  return { id, status: 'green', summary: `lead step ran ${ago(age)} (${mode}): ${counts}${rc ? `; re-checks due ${n(rc.due)}, waiting ${n(rc.waiting)}` : ''}`, at: rec.at };
}
