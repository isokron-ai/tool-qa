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
//                  skips_only_max_age_days (R-SUB-06), sooner than the
//                  tier's max age.
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
// Retired subjects (no longer in their source list, pump/subjects.mjs), pairs
// whose tier says `never`, pairs already in flight, pairs on a disabled
// workflow, run_keys parked after too many rejections, and run_keys sent back
// as retry_later or retry_throttled that are still in their backoff
// (retry_backoff_minutes in pump/tiers.json, doubled for each retry, at most
// retry_backoff_max_minutes) are skipped. A tier
// cell in `sample` mode is due only through a sampling hook.
//
// computeDue() is pure. dueFromState() reads its inputs from the state store.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DAY_MS = 86_400_000;
const SEP = '\u0000';

/** Hooks that pick nothing. Each takes (subject, workflowName, ctx). */
export const NO_HOOKS = Object.freeze({
  leadReverify: () => false,
  determinism: () => false,
  rawSample: () => false,
  coverageGap: () => 0,
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
 * @param {{id:string, tier:number, sha?:string, artifact_digest?:string, changed_at?:string, retired_at?:string}[]} input.subjects
 * @param {Record<string, object>} input.workflows  name -> workflow config (pump/workflows.json)
 * @param {object} input.tiers  parsed pump/tiers.json
 * @param {Map<string, {run_key:string, accepted_at:string, outcome?:string, fields:object}>} input.lastResults
 *        "<subject>\0<workflow>" -> newest accepted result for the pair
 * @param {Set<string>} input.resultKeys  run_keys that have an accepted result
 * @param {Set<string>} input.inFlight    "<subject>\0<workflow>" pairs with a live dispatch
 * @param {Set<string>} input.parked      run_keys not to dispatch again
 * @param {object} [input.hooks]
 * @returns {{subject:string, workflow:string, tier:number, run_key:string, fields:object,
 *            reasons:string[], priority:number}[]}
 */
export function computeDue({ now, subjects, workflows, tiers, lastResults, resultKeys, inFlight, parked, hooks = NO_HOOKS }) {
  const h = { ...NO_HOOKS, ...hooks };
  const weights = tiers.weights || {};
  const prio = tiers.priority || {};
  const out = [];
  const names = Object.keys(workflows).sort();
  for (const s of subjects) {
    if (s.retired_at != null) continue;
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
      const ctx = { now, tier: tierName, cell, last };
      const reasons = [];

      if (cell.mode === 'always') {
        if (!resultKeys.has(key)) reasons.push(whyNoResult(fields, last));
        else if (last && s.changed_at && toMs(s.changed_at) > toMs(last.accepted_at)) reasons.push('change_event');
        const maxAge = maxAgeDays(cell, s, tiers, tierName);
        if (reasons.length === 0 && last && maxAge !== null && now - toMs(last.accepted_at) > maxAge * DAY_MS) {
          reasons.push('stale');
        }
        const skipsDays = Number(tiers.skips_only_max_age_days);
        if (reasons.length === 0 && last?.outcome === 'skips_only' && Number.isFinite(skipsDays) && now - toMs(last.accepted_at) > skipsDays * DAY_MS) {
          reasons.push('skips_only');
        }
      }
      if (h.leadReverify(s, name, ctx)) reasons.push('lead_reverify');
      if (h.determinism(s, name, ctx)) reasons.push('determinism_sample');
      if (h.rawSample(s, name, ctx)) reasons.push('raw_sample');
      if (reasons.length === 0) continue;

      const ageDays = last ? Math.max(0, (now - toMs(last.accepted_at)) / DAY_MS) : 0;
      let priority = Number(weights[tierName] || 0);
      for (const r of reasons) priority += Number(prio[r] || 0);
      priority += Math.min(Number(prio.age_max ?? 30), ageDays * Number(prio.age_per_day ?? 1));
      priority += Number(h.coverageGap(s, name, ctx) || 0);
      out.push({ subject: s.id, workflow: name, tier: s.tier, run_key: key, fields, reasons, priority });
    }
  }
  out.sort((a, b) => b.priority - a.priority || a.tier - b.tier
    || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0)
    || (a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0));
  return out;
}

/** Read computeDue() inputs from the state store. */
export function loadDueInputs(db, { now, tiers, workflows, hooks }) {
  const subjects = db.listSubjects().filter((s) => s.retired_at == null).map((s) => ({
    id: s.id, tier: s.tier, sha: s.sha, artifact_digest: s.artifact_digest, changed_at: s.changed_at,
  }));
  const lastResults = new Map();
  const resultKeys = new Set();
  for (const r of db.listResults()) {
    resultKeys.add(r.run_key);
    const pk = pairKey(r.subject, r.workflow);
    const prev = lastResults.get(pk);
    if (prev && prev.accepted_at >= r.accepted_at) continue;
    const rk = db.getRunKey(r.run_key);
    lastResults.set(pk, { run_key: r.run_key, accepted_at: r.accepted_at, outcome: r.outcome ?? null, fields: rk ? JSON.parse(rk.fields) : {} });
  }
  const inFlight = new Set(db.inFlight({ now }).map((p) => pairKey(p.subject, p.workflow)));
  const maxRejections = Number.isInteger(tiers.max_rejections) && tiers.max_rejections > 0 ? tiers.max_rejections : 3;
  const parked = new Set(db.rejectedRunKeys(maxRejections).map((r) => r.run_key));
  const backoff = Number(tiers.retry_backoff_minutes);
  const baseMs = (Number.isFinite(backoff) && backoff >= 0 ? backoff : 30) * 60_000;
  const cap = Number(tiers.retry_backoff_max_minutes);
  const maxMs = Number.isFinite(cap) && cap > 0 ? cap * 60_000 : Infinity;
  if (typeof db.retryLaterWaiting === 'function') for (const k of db.retryLaterWaiting({ now, baseMs, maxMs })) parked.add(k);
  return { now, subjects, workflows, tiers, lastResults, resultKeys, inFlight, parked, hooks };
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
