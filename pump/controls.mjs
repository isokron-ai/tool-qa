// Control lanes: T0 workers the pump drives on our own fixtures and servers.
//
// A control lane (pump/workflows.json: `control_subjects`) is not a scan of a
// population. Each of its subjects is a pseudo-subject standing for one T0
// worker (a workflow file with fixed inputs) that tests OUR tools against our
// own servers and seeded defects:
//
//   t0-defects  isokron-ai/mcp-write-safety defect-matrix.yml: the tiny-tracker
//               defect matrix (every seeded defect build must be caught).
//   t0-self     isokron-ai/mcp-writecheck-action dogfood-*.yml and selftest.yml:
//               the action and CLI against our own servers.
//
// A miss or a failure there is a lead against OUR tool, never a subject fault:
// the worker declares one control in its bundle (known_good, or known_bad for
// "every seeded defect caught"), and ingest rejects the bundle as
// control_failed when it did not hold. The watchdog item
// (watchdog/t0-lanes.mjs) reads what this module writes to kv `t0.lanes`.
//
// What makes a lane a control lane:
//   - `control_subjects`: { "<owner/name.target>": { file?, inputs? } }. The
//     subject key is a pseudo repository name (it is never looked up on GitHub:
//     its kind is `control`). `file` overrides the lane's workflow file;
//     `inputs` are extra workflow_dispatch inputs (strings).
//   - `dispatch_style: "t0"`: the worker takes the T0 inputs shard_id,
//     attempt_id, fence and run_key (one item), not the `items` list.
//   - `shard_size: 1`.
//   - `switch`: the name of the repository variable that turns the lane on.
//     The lane is dispatched only while that variable is exactly "true"
//     (default off), whatever `enabled` says.
// A control subject is due only for the lane that lists it, and a control lane
// is due only for its own subjects (pump/due.mjs).

export const CONTROL_KIND = 'control';
export const CONTROL_SOURCE = 'control-v1';
export const CONTROL_KV_KEY = 't0.lanes';

const ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const SWITCH_RE = /^LANE_[A-Z0-9_]+_ENABLED$/;
const INPUT_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** Inputs the pump sets itself; a lane may not set them. */
export const RESERVED_INPUTS = Object.freeze(['shard_id', 'attempt_id', 'fence', 'run_key', 'items', 'tool_sha']);
const DAY = 86_400_000;
export const NO_RESULT_AMBER_MS = 36 * 3_600_000;

/** Whether a lane is a control lane. */
export const isControlLane = (wf) => wf?.control_subjects !== undefined && wf?.control_subjects !== null;

/** The worker a control subject stands for: {file, inputs}; null when the subject is not the lane's. */
export function controlTarget(wf, subject) {
  const t = isControlLane(wf) && Object.hasOwn(wf.control_subjects, subject) ? wf.control_subjects[subject] : null;
  if (!t) return null;
  return { file: typeof t.file === 'string' ? t.file : wf.file, inputs: { ...(t.inputs ?? {}) } };
}

/** Problems with the control settings of pump/workflows.json's workflows; [] when sound. */
export function controlProblems(workflows) {
  const p = [];
  const owner = new Map();
  for (const [name, wf] of Object.entries(workflows ?? {})) {
    if (!wf || typeof wf !== 'object') continue;
    const control = isControlLane(wf);
    if (!control) {
      if (wf.dispatch_style !== undefined) p.push(`${name}: dispatch_style is only for a lane with control_subjects`);
      if (wf.switch !== undefined) p.push(`${name}: switch is only for a lane with control_subjects`);
      continue;
    }
    const cs = wf.control_subjects;
    if (typeof cs !== 'object' || Array.isArray(cs) || Object.keys(cs).length === 0) { p.push(`${name}: control_subjects must be a non-empty object`); continue; }
    if (wf.dispatch_style !== 't0') p.push(`${name}: a control lane needs dispatch_style "t0"`);
    if (wf.shard_size !== 1) p.push(`${name}: a control lane needs shard_size 1 (one worker per dispatch)`);
    if (typeof wf.switch !== 'string' || !SWITCH_RE.test(wf.switch)) p.push(`${name}: a control lane needs switch, a repository variable name like LANE_T0_DEFECTS_ENABLED`);
    // A lane that runs third-party code (a server's install scripts, an upstream build) must say so: runs_untrusted true with the
    // sandbox commit it pins, so the sandbox breaker gates it. Only a lane that runs our own code with --ignore-scripts may say false.
    if (typeof wf.runs_untrusted !== 'boolean') p.push(`${name}: a control lane must say runs_untrusted true or false`);
    if (wf.runs_untrusted === true && !/^[0-9a-f]{40}$/.test(String(wf.sandbox_sha))) p.push(`${name}: a control lane that runs third-party code must pin sandbox_sha (a full commit)`);
    for (const [id, t] of Object.entries(cs)) {
      if (!ID_RE.test(id)) p.push(`${name}: control subject ${JSON.stringify(id)} is not owner/name`);
      if (owner.has(id.toLowerCase())) p.push(`${name}: control subject ${id} is also listed by ${owner.get(id.toLowerCase())}`);
      owner.set(id.toLowerCase(), name);
      if (!t || typeof t !== 'object' || Array.isArray(t)) { p.push(`${name}: control subject ${id} must be an object`); continue; }
      if (t.file !== undefined && !(typeof t.file === 'string' && FILE_RE.test(t.file))) p.push(`${name}: control subject ${id}: file must be a workflow file name`);
      if (t.inputs !== undefined) {
        if (!t.inputs || typeof t.inputs !== 'object' || Array.isArray(t.inputs)) { p.push(`${name}: control subject ${id}: inputs must be an object`); continue; }
        for (const [k, v] of Object.entries(t.inputs)) {
          if (!INPUT_NAME_RE.test(k) || RESERVED_INPUTS.includes(k)) p.push(`${name}: control subject ${id}: input ${JSON.stringify(k)} is not allowed`);
          if (typeof v !== 'string') p.push(`${name}: control subject ${id}: input ${k} must be a string`);
        }
      }
    }
  }
  return p;
}

/**
 * The workflows as the pump runs them: a control lane is enabled only while
 * its switch variable is exactly "true" (and `enabled` is true). Other lanes
 * are returned as they are. Never mutates its input.
 */
export function applyControlSwitches(workflows, env = {}) {
  const out = {};
  for (const [name, wf] of Object.entries(workflows ?? {})) {
    out[name] = isControlLane(wf) && wf.enabled === true && env?.[wf.switch] !== 'true' ? { ...wf, enabled: false } : wf;
  }
  return out;
}

/**
 * Put the control subjects in the subjects table (kind `control`, tier 0) and
 * retire the ones no lane lists any more. Idempotent; a subject that is
 * already current is not touched.
 * @returns {{added: number, retired: number, subjects: number}}
 */
export function syncControlSubjects(db, workflows, { now = Date.now() } = {}) {
  const want = new Set();
  for (const wf of Object.values(workflows ?? {})) if (isControlLane(wf)) for (const id of Object.keys(wf.control_subjects)) want.add(id);
  const have = new Map(db.listSubjects().filter((s) => s.kind === CONTROL_KIND).map((s) => [s.id, s]));
  let added = 0;
  db.tx(() => {
    for (const id of want) {
      const cur = have.get(id);
      if (cur && cur.retired_at == null && cur.tier === 0) continue;
      db.setSubjectVersion({ id, kind: CONTROL_KIND, source: CONTROL_SOURCE, tier: 0, name: id, now });
      added += 1;
    }
  });
  const retired = db.retireSubjects({ sourcePrefix: 'control-v', keep: [...want], now });
  return { added, retired, subjects: want.size };
}

const isoOf = (ms) => new Date(ms).toISOString();

/**
 * What the watchdog needs about every control lane, judged per subject (one subject's success never covers another's miss):
 *   on               the lane is dispatched (its switch is "true")
 *   on_since         first time the pump saw the lane on (grace for a new lane)
 *   subjects         { <subject>: { last_result_at, failed_at, failed_attempt, failed } }
 *     last_result_at newest accepted result of that subject that measured something (a skips_only result, infrastructure only, does not count)
 *     infra_only_since  the newest skips_only result, when it is newer than last_result_at
 *     failed_at      newest rejection of that subject with reason control_failed (a seeded defect missed, a failing
 *                    known-good control: a lead against OUR tool)
 *     failed         that rejection is newer than the subject's last accepted result. It stays true while the run_key is
 *                    parked (no new dispatch), until an accepted result comes in.
 *   failed           any subject failed
 * Written to kv `t0.lanes` by the pump after every tick.
 */
export function controlLaneStatus(db, { workflows, enabled = workflows, now = Date.now(), previous = null }) {
  const out = {};
  const results = db.listResults();
  for (const [lane, wf] of Object.entries(workflows ?? {})) {
    if (!isControlLane(wf)) continue;
    const on = enabled?.[lane]?.enabled === true;
    const ids = Object.keys(wf.control_subjects);
    const subjects = {};
    for (const id of ids) {
      let lastResult = null;
      let lastSkipsOnly = null;
      for (const r of results) {
        if (r.workflow !== lane || r.subject !== id) continue;
        // A skips_only result (every skip retryable: infrastructure) did not measure anything: it is not a result of the control.
        if (r.outcome === 'skips_only') { if (lastSkipsOnly === null || r.accepted_at > lastSkipsOnly) lastSkipsOnly = r.accepted_at; continue; }
        if (lastResult === null || r.accepted_at > lastResult) lastResult = r.accepted_at;
      }
      const row = db.raw.prepare(`
        SELECT received, attempt_id FROM attempts WHERE accepted = 0 AND reason = 'control_failed' AND subject = ? ORDER BY received DESC LIMIT 1
      `).get(id);
      const failedAt = row?.received ?? null;
      subjects[id] = {
        last_result_at: lastResult,
        infra_only_since: lastSkipsOnly !== null && (lastResult === null || lastSkipsOnly > lastResult) ? lastSkipsOnly : null,
        failed_at: failedAt,
        failed_attempt: row?.attempt_id ?? null,
        failed: failedAt !== null && (lastResult === null || failedAt > lastResult),
      };
    }
    const prev = previous?.[lane] ?? null;
    out[lane] = {
      on,
      on_since: on ? (prev?.on && prev.on_since ? prev.on_since : isoOf(now)) : null,
      subjects,
      failed: Object.values(subjects).some((x) => x.failed),
      targets: ids.length,
    };
  }
  return out;
}

/** Write kv t0.lanes (only when there is a control lane or a record to clear). */
export function recordControlLanes(db, { workflows, enabled, now = Date.now() }) {
  const previous = db.getKv(CONTROL_KV_KEY)?.lanes ?? null;
  const lanes = controlLaneStatus(db, { workflows, enabled, now, previous });
  if (Object.keys(lanes).length === 0 && previous === null) return lanes;
  db.setKv(CONTROL_KV_KEY, { at: isoOf(now), lanes }, { now });
  return lanes;
}

export { DAY as CONTROL_DAY_MS };
