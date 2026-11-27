// The due list: which (subject, workflow) pairs need a run now.
//
// Nothing is queued. Each pump tick recomputes the list from state, so a missed
// tick or a lost worker catches up on its own. A pair is due when any of:
//
//   first_sight / new_version / tool_version
//                  no accepted result exists for its current run_key. The reason
//                  says what moved compared with the last result for the pair:
//                  nothing yet, the subject's SHA or digest, or our tool, oracle,
//                  probe, image or settings versions.
//   skips_only     the last result was accepted but held no records and only
//                  retryable skips whose retries ran out, and is older than
//                  skips_only_max_age_days x 2^(n-1) for the n-th such result
//                  in a row, at most the tier's max age (R-SUB-06, R-SUB-08).
//   change_event   a change event (release, new SHA, advisory) arrived after the
//                  pair's last result.
//   stale          the last result is older than the tier's max age for the
//                  workflow (pump/tiers.json). A subject whose version is not
//                  known (no sha and no artifact digest, as the seed's GitHub
//                  subjects are) has a run_key that never moves, so where the
//                  cell has no age limit, unversioned_max_age_days for its tier
//                  applies instead; otherwise it would never run again.
//   lead_reverify, determinism_sample, raw_sample
//                  picked by a hook. The hooks return nothing for now.
//
// Priority: the tier weight, plus each reason's weight, plus the age of the
// last result (age_per_day, at most age_max), plus the coverage-gap boost
// (R-COV-03, R-COV-05..07). A due pair is a coverage gap a run can close
// (gapKind) when:
//   never_assessed  it has no accepted result yet, or none of its results was
//                   ever assessed and the last is a passing condition
//                   (unassessed_infra);
//   our_limit       its last result is unassessed by our own limit (coverage
//                   unassessed_tool or unassessed_unknown, or a fault of tool
//                   or unknown) and something moved since: the reasons
//                   include tool_version, new_version or change_event. The
//                   same tool on the same version cannot change a tool-limit
//                   skip, so a merely stale one is not boosted (R-COV-06).
// The boost is priority.coverage_gap_share x the tier weight, capped strictly
// below the gap to the next tier up (by weight, from tiers.json, minus one
// point): so it follows the tier (which follows popularity), and with equal
// reasons and age a boosted pair never reaches a bare pair of the tier above
// (R-COV-05). It orders due pairs; it never makes a pair due. A result from
// before state schema 7 has no coverage: it gets no our_limit boost, and one
// that was not skips_only counts as assessed (R-COV-07), since the state does
// not say whether it held a permanent skip. A new tool version moves every
// run_key, so a release makes every tool-fault skip due again
// (tool_version), boosted ahead of the rest of its tier with equal age.
// A first-sight pair has no reason weight and no age, so its boost puts it
// above a stale pair of its tier only while the boost beats stale's weight
// plus the stale result's age: with the shipped tiers.json, always in T0,
// in T1 while the stale result is under 20 days old, never in T2 to T4.
//
// Oracle disagreement (loop upgrade #7, state/oracle.mjs): a subject where
// our reader, the live tool list and the official SDK clients or conformance
// suite disagree (state oracle_disagreements, status open) is where our tools
// are weakest. Its pairs of an oracle lane (priority.oracle_lanes: scan-static
// and live-probe) get two things:
//   oracle_recheck  a due reason (weight priority.oracle_recheck, charged to
//                   the same cap as the boosts, see below) once the last
//                   result is older than priority.oracle_recheck_days, which
//                   is shorter than the tier's max age. Each check cycle (a
//                   result from every lane with current facts) counts towards
//                   the settle rule: the same disagreement ORACLE_MAX_UNCHANGED
//                   (5) cycles in a row is settled and the boost and re-checks
//                   stop until it changes; agreement clears it. A rolling
//                   budget of ORACLE_BUDGET_MAX (6) cycles per 30 days settles
//                   a server that keeps flapping (R-ORD-13).
//   a priority boost  priority.oracle_disagreement_share x the tier weight,
//                   added AFTER the coverage-gap boost and limited to what is
//                   left of the same cap: coverage-gap boost + oracle_recheck
//                   reason + oracle boost never exceed gapBoostCap() of the
//                   tier, so with equal other reasons and age a boosted pair
//                   still never reaches a bare pair of the tier above
//                   (R-COV-05, R-ORD-02, R-ORD-14). The coverage gap has the
//                   first claim, then the reason (cut to what is left), then
//                   the boost.
// A disagreement is evidence about our tool, never the subject's: it changes
// no result's fault or coverage (R-ORD-04).
//
// Subjects are keyed by their frozen subject key (subjects.id, which run_keys
// name); each due pair also carries the subject's current owner/name (`name`,
// what the worker is sent) and its repository id when known (state schema v8,
// pump/identity.mjs). Subjects whose repository cannot be found (gone_at: it
// was deleted or turned private, a subject-fault skip) and subjects merged
// into another (alias_of) are left out.
//
// Retired subjects (no longer in their source list, pump/subjects.mjs), pairs
// whose tier says `never`, pairs already in flight, pairs on a disabled
// workflow, run_keys parked after too many rejections, and run_keys sent back
// as retry_later or retry_throttled that are still in their backoff
// (retry_backoff_minutes in pump/tiers.json, doubled for each retry, at most
// retry_backoff_max_minutes) are skipped. A tier
// cell in `sample` mode is due only through the cellSample hook
// (pump/sampling.mjs: a stable hash of subject, workflow and week under a
// rate set by SAMPLE_RATE_T<n>; rate 0 picks nothing).
//
// computeDue() is pure. dueFromState() reads its inputs from the state store.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DAY_MS = 86_400_000;
const SEP = '\u0000';

/** Coverage states that are our own limit (worker-kit/contract.mjs COVERAGE_STATES). */
const OUR_LIMIT = new Set(['unassessed_tool', 'unassessed_unknown']);
const OUR_FAULTS = new Set(['tool', 'unknown']);

/** Due reasons that say something moved since the last result: our tool, the subject, or a change event. */
export const MOVED_REASONS = Object.freeze(['tool_version', 'new_version', 'change_event']);

/**
 * What coverage gap a due pair leaves that this run can close (R-COV-03, R-COV-06):
 *   never_assessed  no accepted result yet, or none of its results was ever
 *                   assessed and the last is unassessed_infra
 *   our_limit       the last result is unassessed by our own limit (tool or
 *                   unknown fault), and `reasons` include one of MOVED_REASONS
 * null otherwise: assessed, the subject's side, excluded by policy, a result
 * recorded before coverage was (state schema < 7), or our limit with nothing
 * moved since.
 * @param {{coverage?: string|null, fault?: string|null, ever_assessed?: boolean}|undefined} last
 * @param {string[]} [reasons]  the pair's due reasons
 */
export function gapKind(last, reasons = []) {
  if (!last) return 'never_assessed';
  if (OUR_LIMIT.has(last.coverage) || OUR_FAULTS.has(last.fault)) {
    return reasons.some((r) => MOVED_REASONS.includes(r)) ? 'our_limit' : null;
  }
  if (last.coverage === 'unassessed_infra' && last.ever_assessed !== true) return 'never_assessed';
  return null;
}

/**
 * The largest coverage-gap boost a tier may get: one point under the gap to
 * the next tier up by weight, so with equal reasons and age a boosted pair
 * stays strictly below a bare pair of that tier (R-COV-05). Infinity for the
 * top tier; 0 when the gap is one point or less.
 */
export function gapBoostCap(tiers, tierName) {
  const weights = tiers?.weights ?? {};
  const w = Number(weights[tierName]);
  const above = Object.values(weights).map(Number).filter((x) => Number.isFinite(x) && x > w);
  if (above.length === 0) return Infinity;
  return Math.max(0, Math.min(...above) - w - 1);
}

/**
 * The coverage-gap boost of a due pair: priority.coverage_gap_share x the
 * subject's tier weight, at most gapBoostCap(), when gapKind() names a gap,
 * else 0. ctx is what computeDue() passes to every hook ({tier, last, tiers,
 * reasons, ...}).
 */
export function coverageGapBoost(subject, workflowName, ctx) {
  if (!ctx?.tiers || gapKind(ctx.last, ctx.reasons ?? []) === null) return 0;
  const share = Number(ctx.tiers.priority?.coverage_gap_share);
  const weight = Number(ctx.tiers.weights?.[ctx.tier]);
  if (!Number.isFinite(share) || share <= 0 || !Number.isFinite(weight) || weight <= 0) return 0;
  return Math.min(share * weight, gapBoostCap(ctx.tiers, ctx.tier));
}

/**
 * The oracle-disagreement boost of a due pair: priority.oracle_disagreement_share
 * x the tier weight for a pair of an oracle lane whose subject has an open
 * disagreement (ctx.oracle), limited to what is left of gapBoostCap() after the
 * coverage-gap boost (ctx.gapBoost). So the two boosts together stay under the
 * gap to the next tier (R-ORD-02).
 */
export function oracleBoost(subject, workflowName, ctx) {
  if (!ctx?.tiers || ctx.oracle?.status !== 'open' || !isOracleLane(ctx.tiers, workflowName)) return 0;
  const share = Number(ctx.tiers.priority?.oracle_disagreement_share);
  const weight = Number(ctx.tiers.weights?.[ctx.tier]);
  if (!Number.isFinite(share) || share <= 0 || !Number.isFinite(weight) || weight <= 0) return 0;
  const room = gapBoostCap(ctx.tiers, ctx.tier) - Number(ctx.gapBoost || 0) - Number(ctx.recheckPts || 0);
  return Math.max(0, Math.min(share * weight, room));
}

/** Whether a workflow is one of the oracle lanes (priority.oracle_lanes). */
export function isOracleLane(tiers, workflowName) {
  const lanes = tiers?.priority?.oracle_lanes;
  return Array.isArray(lanes) && lanes.includes(workflowName);
}

/**
 * The default hooks. Each takes (subject, workflowName, ctx). The sampling
 * hooks pick nothing by default (cellSample is pump/sampling.mjs when the pump
 * passes it); coverageGap is the coverage-gap boost.
 */
export const NO_HOOKS = Object.freeze({
  leadReverify: () => false,
  determinism: () => false,
  rawSample: () => false,
  cellSample: () => false,
  coverageGap: coverageGapBoost,
  oracleDisagreement: oracleBoost,
});

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === undefined) throw new TypeError('canonicalJson: undefined is not allowed; use null');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

const orNull = (v) => (v === undefined ? null : v);

/**
 * The fields a run_key is computed from: subject, commit SHA, artifact digest,
 * workflow, our tool versions, oracle versions, probe-battery and version-list
 * versions, sandbox image digest and settings state.
 */
export function runKeyFields(subject, workflowName, wf) {
  const v = wf?.versions || {};
  return {
    subject_id: subject.id,
    sha: orNull(subject.sha),
    artifact_digest: orNull(subject.artifact_digest),
    workflow: workflowName,
    tool_versions: orNull(v.tool) ?? {},
    oracle_versions: orNull(v.oracle) ?? {},
    probe_versions: orNull(v.probe) ?? {},
    image_digest: orNull(wf?.image_digest),
    settings_state: orNull(wf?.settings_state),
  };
}

/** sha256 (hex) of the canonical JSON of the run_key fields. */
export function runKey(fields) {
  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}

const pairKey = (subject, workflow) => `${subject}${SEP}${workflow}`;
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

/**
 * The max age (days) of a tier cell for a subject: the cell's own, or, when the
 * cell has none and the subject's version is unknown, the tier's
 * unversioned_max_age_days. null = no age limit.
 */
export function maxAgeDays(cell, subject, tiers, tierName) {
  if (Number.isFinite(cell?.max_age_days)) return cell.max_age_days;
  if (subject.sha == null && subject.artifact_digest == null) {
    const d = tiers?.unversioned_max_age_days?.[tierName];
    if (Number.isFinite(d)) return d;
  }
  return null;
}

/**
 * How long a skips_only result waits before it is due again (R-SUB-06,
 * R-SUB-08): skips_only_max_age_days x 2^(n-1) for the n-th skips_only result
 * in a row, at most the cell's max age. null when the result is not skips_only.
 */
export function skipsOnlyWaitDays(last, tiers, maxAge) {
  const base = Number(tiers?.skips_only_max_age_days);
  if (last?.outcome !== 'skips_only' || !Number.isFinite(base)) return null;
  const n = Math.max(1, Math.trunc(Number(last.skips_streak)) || 1);
  const days = base * 2 ** Math.min(20, n - 1);
  return maxAge === null ? days : Math.min(days, maxAge);
}

function whyNoResult(fields, last) {
  if (!last) return 'first_sight';
  const prev = last.fields || {};
  if (prev.sha !== fields.sha || prev.artifact_digest !== fields.artifact_digest) return 'new_version';
  return 'tool_version';
}

/**
 * Compute the due list.
 * @param {object} input
 * @param {number} input.now  ms since epoch
 * @param {{id:string, name?:string, repo_id?:number|null, tier:number, sha?:string, artifact_digest?:string,
 *        changed_at?:string, retired_at?:string, gone_at?:string, alias_of?:string}[]} input.subjects
 * @param {Record<string, object>} input.workflows  name -> workflow config (pump/workflows.json)
 * @param {object} input.tiers  parsed pump/tiers.json
 * @param {Map<string, {run_key:string, accepted_at:string, outcome?:string, fields:object,
 *        fault?:string|null, coverage?:string|null, ever_assessed?:boolean}>} input.lastResults
 *        "<subject>\0<workflow>" -> newest accepted result for the pair; ever_assessed:
 *        any of the pair's results (any run_key) was assessed
 * @param {Set<string>} input.resultKeys  run_keys that have an accepted result
 * @param {Set<string>} input.inFlight    "<subject>\0<workflow>" pairs with a live dispatch
 * @param {Set<string>} input.parked      run_keys not to dispatch again
 * @param {Map<string, {status:string, kinds:object[]}>} [input.oracle]  subject key -> its oracle disagreement row (status open boosts)
 * @param {object} [input.hooks]
 * @returns {{subject:string, name:string, repo_id:number|null, workflow:string, tier:number, run_key:string,
 *            fields:object, reasons:string[], priority:number, gap:string|null}[]}
 *          subject: the subject key (run_keys name it); name: the owner/name to send
 *          gap: gapKind() of the pair's last result (R-COV-03)
 */
export function computeDue({ now, subjects, workflows, tiers, lastResults, resultKeys, inFlight, parked, oracle: oracleOf = new Map(), hooks = NO_HOOKS }) {
  const h = { ...NO_HOOKS, ...hooks };
  const weights = tiers.weights || {};
  const prio = tiers.priority || {};
  const out = [];
  const names = Object.keys(workflows).sort();
  for (const s of subjects) {
    if (s.retired_at != null || s.gone_at != null || s.alias_of != null) continue;
    const tierName = `T${s.tier}`;
    const cells = tiers.tiers?.[tierName];
    if (!cells) continue;
    for (const name of names) {
      const wf = workflows[name];
      if (!isEnabled(wf)) continue;
      const cell = cells[name];
      if (!cell || cell.mode === 'never') continue;
      const pk = pairKey(s.id, name);
      if (inFlight.has(pk)) continue;
      const fields = runKeyFields(s, name, wf);
      const key = runKey(fields);
      if (parked.has(key)) continue;
      const last = lastResults.get(pk);
      const oracle = oracleOf.get(s.id) ?? null;
      const ctx = { now, tier: tierName, cell, last, tiers, oracle };
      const reasons = [];

      if (cell.mode === 'always') {
        if (!resultKeys.has(key)) reasons.push(whyNoResult(fields, last));
        else if (last && s.changed_at && toMs(s.changed_at) > toMs(last.accepted_at)) reasons.push('change_event');
        const maxAge = maxAgeDays(cell, s, tiers, tierName);
        if (reasons.length === 0 && last && maxAge !== null && now - toMs(last.accepted_at) > maxAge * DAY_MS) {
          reasons.push('stale');
        }
        const skipsDays = skipsOnlyWaitDays(last, tiers, maxAge);
        if (reasons.length === 0 && skipsDays !== null && now - toMs(last.accepted_at) > skipsDays * DAY_MS) {
          reasons.push('skips_only');
        }
        // An open oracle disagreement is looked at again sooner than the tier's max age.
        const recheckDays = Number(prio.oracle_recheck_days);
        if (reasons.length === 0 && oracle?.status === 'open' && isOracleLane(tiers, name) && last && Number.isFinite(recheckDays)
          && now - toMs(last.accepted_at) > recheckDays * DAY_MS) {
          reasons.push('oracle_recheck');
        }
      }
      if (h.leadReverify(s, name, ctx)) reasons.push('lead_reverify');
      if (h.determinism(s, name, ctx)) reasons.push('determinism_sample');
      if (h.rawSample(s, name, ctx)) reasons.push('raw_sample');
      if (cell.mode === 'sample' && h.cellSample(s, name, ctx)) reasons.push('cell_sample');
      if (reasons.length === 0) continue;

      const ageDays = last ? Math.max(0, (now - toMs(last.accepted_at)) / DAY_MS) : 0;
      let priority = Number(weights[tierName] || 0);
      for (const r of reasons) if (r !== 'oracle_recheck') priority += Number(prio[r] || 0);
      priority += Math.min(Number(prio.age_max ?? 30), ageDays * Number(prio.age_per_day ?? 1));
      const gapBoost = Number(h.coverageGap(s, name, { ...ctx, reasons }) || 0);
      priority += gapBoost;
      // The oracle_recheck reason's weight is charged to the same cap (R-ORD-14).
      const recheckPts = reasons.includes('oracle_recheck') ? Math.max(0, Math.min(Number(prio.oracle_recheck || 0), gapBoostCap(tiers, tierName) - gapBoost)) : 0;
      priority += recheckPts;
      priority += Number(h.oracleDisagreement(s, name, { ...ctx, reasons, gapBoost, recheckPts }) || 0);
      out.push({
        subject: s.id, name: s.name ?? s.id, repo_id: s.repo_id ?? null, workflow: name, tier: s.tier, run_key: key, fields, reasons, priority, gap: gapKind(last, reasons),
        ...(oracle?.status === 'open' ? { oracle: oracle.kinds.map((k) => k.kind) } : {}),
      });
    }
  }
  out.sort((a, b) => b.priority - a.priority || a.tier - b.tier
    || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0)
    || (a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0));
  return out;
}

/** Read computeDue() inputs from the state store. */
export function loadDueInputs(db, { now, tiers, workflows, hooks }) {
  const subjects = db.listSubjects().filter((s) => s.retired_at == null && s.gone_at == null && s.alias_of == null).map((s) => ({
    id: s.id, name: s.name ?? s.id, repo_id: s.repo_id ?? null, tier: s.tier, sha: s.sha, artifact_digest: s.artifact_digest, changed_at: s.changed_at,
  }));
  const lastResults = new Map();
  const resultKeys = new Set();
  // Pairs with an assessed result under any run_key (R-COV-03). A result from
  // before state schema 7 (no coverage) that was not skips_only counts as
  // assessed: the state does not say whether it held a permanent skip, and
  // erring this way never boosts a pair that was graded (R-COV-07).
  const everAssessed = new Set();
  for (const r of db.listResults()) {
    resultKeys.add(r.run_key);
    const pk = pairKey(r.subject, r.workflow);
    const preCoverage = r.coverage == null && r.outcome != null && r.outcome !== 'skips_only';
    if (r.coverage === 'assessed' || r.assessed_at != null || preCoverage) everAssessed.add(pk);
    const prev = lastResults.get(pk);
    if (prev && prev.accepted_at >= r.accepted_at) continue;
    const rk = db.getRunKey(r.run_key);
    lastResults.set(pk, {
      run_key: r.run_key, accepted_at: r.accepted_at, outcome: r.outcome ?? null, skips_streak: r.skips_streak ?? 0,
      fault: r.fault ?? null, coverage: r.coverage ?? null, fields: rk ? JSON.parse(rk.fields) : {},
    });
  }
  for (const [pk, last] of lastResults) last.ever_assessed = everAssessed.has(pk);
  const inFlight = new Set(db.inFlight({ now }).map((p) => pairKey(p.subject, p.workflow)));
  const maxRejections = Number.isInteger(tiers.max_rejections) && tiers.max_rejections > 0 ? tiers.max_rejections : 3;
  const parked = new Set(db.rejectedRunKeys(maxRejections).map((r) => r.run_key));
  const backoff = Number(tiers.retry_backoff_minutes);
  const baseMs = (Number.isFinite(backoff) && backoff >= 0 ? backoff : 30) * 60_000;
  const cap = Number(tiers.retry_backoff_max_minutes);
  const maxMs = Number.isFinite(cap) && cap > 0 ? cap * 60_000 : Infinity;
  if (typeof db.retryLaterWaiting === 'function') for (const k of db.retryLaterWaiting({ now, baseMs, maxMs })) parked.add(k);
  // A state from before schema 9 has no oracle tables: nothing to boost (R-ORD-08).
  const oracle = new Map(db.schemaVersion() >= 9 ? db.listOracleDisagreements({ status: 'open' }).map((r) => [r.subject, r]) : []);
  return { now, subjects, workflows, tiers, lastResults, resultKeys, inFlight, parked, oracle, hooks };
}

/** The due list for the current state. */
export function dueFromState(db, { now, tiers, workflows, hooks = NO_HOOKS }) {
  return computeDue(loadDueInputs(db, { now, tiers, workflows, hooks }));
}

/** Read pump/tiers.json and pump/workflows.json (or the given paths). */
/**
 * Whether a worker workflow may be dispatched: only when `enabled` is exactly
 * true. The one test of it, used by the due list, the ingest key check, the
 * sandbox breaker and the watchdog, so they can never disagree (R-WD-02).
 */
export const isEnabled = (wf) => wf?.enabled === true;

/**
 * Problems with pump/workflows.json's workflows: `enabled` and
 * `runs_untrusted` must be real booleans, and a workflow that runs untrusted
 * code names the sandbox commit it pins (`sandbox_sha`: a full SHA, or null
 * until it pins one).
 */
export function workflowProblems(workflows) {
  const p = [];
  if (!workflows || typeof workflows !== 'object' || Array.isArray(workflows)) return ['workflows is not an object'];
  for (const [name, wf] of Object.entries(workflows)) {
    if (!wf || typeof wf !== 'object') { p.push(`${name}: not an object`); continue; }
    if (typeof wf.enabled !== 'boolean') p.push(`${name}: enabled must be true or false`);
    if (typeof wf.runs_untrusted !== 'boolean') p.push(`${name}: runs_untrusted must be true or false`);
    if (wf.runs_untrusted !== false && !(wf.sandbox_sha === null || /^[0-9a-f]{40}$/.test(String(wf.sandbox_sha)))) p.push(`${name}: sandbox_sha must be a full commit SHA or null`);
  }
  return p;
}

export function loadConfig({ tiersPath, workflowsPath } = {}) {
  const read = (p, def) => JSON.parse(readFileSync(p || new URL(def, import.meta.url), 'utf8'));
  const tiers = read(tiersPath, './tiers.json');
  const wf = read(workflowsPath, './workflows.json');
  const workflows = wf.workflows || {};
  const bad = workflowProblems(workflows);
  if (bad.length) throw new Error(`pump/workflows.json: ${bad.join('; ')}`);
  return { tiers, workflows };
}
