// Version pins: the tool and probe versions a lane names in pump/workflows.json
// (`versions.tool`, `versions.probe`) go into every run_key, so they are the
// label a result is filed under. This module makes that label true or refuses
// the result (R-PIN-01).
//
// Two halves:
//
//   The pump (tick.mjs). A worker workflow is dispatched on a branch (GitHub
//   takes no commit there), so the commit it runs is the branch head, not the
//   pin. On a lane whose `pin_check` is "enforce", the pump resolves the
//   worker repository's own pin (the `versions.tool` entry named after that
//   repository, such as "mcp-check" for isokron-ai/mcp-check) to its full
//   commit and sends it as the `tool_sha` input; the worker checks out and runs
//   that commit. A pin it cannot resolve is not dispatched.
//
//   Ingest (analyze.mjs). Every bundle's manifest lists the components it ran
//   in `tools`. Each pinned tool and probe component of the item's run_key must
//   be proven there: a commit pin by the full 40-character commit it starts,
//   any other pin by the same version string. A component reported at
//   something else contradicts the label: the result is refused as
//   `pin_mismatch` on every lane. One not reported, or reported only as a
//   version that says nothing about the commit (a package version for a commit
//   pin), is unverified: refused as `pin_unverified` on an "enforce" lane,
//   accepted with a note on a "label" lane (the rollout setting, for worker
//   repositories that do not report their commits yet). Both refusals are the
//   tool side's fault, never the subject's.
//
// pin_check: "label" | "enforce" per lane. A lane without one is "enforce"
// (fails closed); pump/test/pins.test.mjs makes every lane say which.

export const PIN_CHECK_MODES = Object.freeze(['label', 'enforce']);

/** A commit pin: 7 to 40 lower-case hex characters (an abbreviated or full commit SHA). */
export const COMMIT_PIN_RE = /^[0-9a-f]{7,40}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** The lane's pin_check mode; anything but an explicit "label" is "enforce". */
export function pinCheckMode(wf) {
  return wf?.pin_check === 'label' ? 'label' : 'enforce';
}

/** lane name -> pin_check mode, for every lane of a workflows map. */
export function lanePinModes(workflows) {
  return Object.fromEntries(Object.entries(workflows ?? {}).map(([name, wf]) => [name, pinCheckMode(wf)]));
}

/**
 * The worker repository's own commit pin: the `versions.tool` entry named
 * after the repository (isokron-ai/mcp-check -> "mcp-check"), when it is a
 * commit. null when the lane pins no commit of its own code (tool-qa's meta
 * lanes pin their lane VERSION instead).
 * @returns {{name: string, pin: string}|null}
 */
export function selfPin(wf) {
  const name = String(wf?.repo ?? '').split('/')[1];
  const pin = name ? wf?.versions?.tool?.[name] : undefined;
  return typeof pin === 'string' && COMMIT_PIN_RE.test(pin) ? { name, pin } : null;
}

const isText = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

/**
 * The pins a run_key's fields name, as stored with the run_key
 * ({tool_versions, probe_versions}) or as getAttempt hands them to ingest
 * ({tool, probe}). null when there is nothing usable (no fields recorded).
 * @returns {{tool: Record<string,string>, probe: Record<string,string>}|null}
 */
export function expectedPins(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const pick = (v) => {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    for (const [k, p] of Object.entries(v)) {
      if (!isText(k) || !isText(p)) return null;
      out[k] = p;
    }
    return out;
  };
  const tool = pick(fields.tool ?? fields.tool_versions);
  const probe = pick(fields.probe ?? fields.probe_versions);
  return tool && probe ? { tool, probe } : null;
}

/**
 * Whether a reported component is the pinned one: the same name, the name
 * under a scope or owner ("@isokron/mcp-check", "isokron-ai/mcp-surface-corpus"
 * for "mcp-check", "mcp-surface-corpus"), or tool-qa's own lane name
 * ("tool-qa-meta-github" for "meta-github").
 */
export function reportsComponent(reportedName, key) {
  if (typeof reportedName !== 'string') return false;
  return reportedName === key || reportedName.endsWith(`/${key}`) || reportedName === `tool-qa-${key}`;
}

/** What one reported version says about one pin: 'proof', 'contradiction' or 'silent'. */
export function pinEvidence(pin, version) {
  if (typeof version !== 'string') return 'silent';
  if (COMMIT_PIN_RE.test(pin)) {
    // A package version ("1.3.1") says nothing about which commit ran.
    if (!COMMIT_PIN_RE.test(version)) return 'silent';
    if (!(version.startsWith(pin) || pin.startsWith(version))) return 'contradiction';
    // Only the full commit proves it: a short one could be shorter than the pin.
    return FULL_SHA_RE.test(version) ? 'proof' : 'silent';
  }
  return version === pin ? 'proof' : 'contradiction';
}

/**
 * Check the pins of one item against the components its manifest reports.
 * @param {{tool: object, probe: object}} expected  expectedPins()
 * @param {{name: string, version: string}[]} tools  manifest.tools
 * @returns {{verified: object[], unverified: object[], mismatched: object[]}}
 *   each entry {kind: 'tool'|'probe', name, pin, got} (got: the reported
 *   version that decided it, or null)
 */
export function checkPins(expected, tools) {
  const out = { verified: [], unverified: [], mismatched: [] };
  const list = Array.isArray(tools) ? tools : [];
  for (const kind of ['tool', 'probe']) {
    for (const [name, pin] of Object.entries(expected?.[kind] ?? {})) {
      const seen = list.filter((c) => reportsComponent(c?.name, name)).map((c) => ({ version: c.version, says: pinEvidence(pin, c.version) }));
      const bad = seen.find((s) => s.says === 'contradiction');
      const good = seen.find((s) => s.says === 'proof');
      if (bad) out.mismatched.push({ kind, name, pin, got: String(bad.version) });
      else if (good) out.verified.push({ kind, name, pin, got: good.version });
      else out.unverified.push({ kind, name, pin, got: seen.length ? String(seen[0].version) : null });
    }
  }
  return out;
}

/**
 * The ingest decision for one bundle that would otherwise be accepted.
 * `expected` undefined: the ledger carries no pins (a hand-made ledger), not
 * checked. null: no label was recorded for the run_key, nothing to make true,
 * not checked either. false: pins were recorded but cannot be read; refused
 * as pin_unverified on an "enforce" lane (R-PIN-02). Otherwise a contradiction
 * is refused on every lane and an unproven pin on an "enforce" lane, with one
 * exception on a "label" lane (R-PIN-02): the lane's own commit pin (`self`,
 * the versions.tool entry named after the worker repository). Until its worker
 * takes tool_sha, a "label" worker runs its branch head and may report that
 * commit honestly; every merge there would otherwise pause the lane until a
 * pin bump. That one contradiction is listed as unverified with a note
 * (`self_pin_moved`) instead. Every other pin stays a hard pin_mismatch.
 * @param {{mode: string, expected: object|null|false|undefined, tools: object[], self?: string|null}} args
 * @returns {{reason: null|'pin_mismatch'|'pin_unverified', problems: object[], report: object}}
 */
export function pinDecision({ mode, expected, tools, self = null }) {
  const m = mode === 'label' ? 'label' : 'enforce';
  if (expected === undefined || expected === null) {
    return { reason: null, problems: [], report: { mode: m, checked: false, why: expected === null ? 'no_label' : 'not_in_ledger' } };
  }
  if (expected === false) {
    const report = { mode: m, checked: false, why: 'malformed_label' };
    if (m === 'label') return { reason: null, problems: [], report };
    report.fault = 'tool';
    return {
      reason: 'pin_unverified',
      problems: [{ reason: 'pin_unverified', fault: 'tool', key: 'run_key_fields', detail: 'the pins recorded for the run_key cannot be read, so nothing can be proven' }],
      report,
    };
  }
  const r = checkPins(expected, tools);
  if (m === 'label' && self) {
    // R-PIN-02: the lane's own commit pin moved on a label lane: a note, not a refusal.
    const own = (e) => e.kind === 'tool' && e.name === self && COMMIT_PIN_RE.test(e.pin);
    for (const e of r.mismatched.filter(own)) r.unverified.push({ ...e, note: `self_pin_moved: reported ${e.got}, pinned ${e.pin}` });
    r.mismatched = r.mismatched.filter((e) => !own(e));
  }
  const entry = (e) => ({ kind: e.kind, name: e.name, pin: e.pin, got: e.got, ...(e.note ? { note: e.note } : {}) });
  const report = {
    mode: m,
    checked: true,
    verified: r.verified.map(entry),
    unverified: r.unverified.map(entry),
    mismatched: r.mismatched.map(entry),
  };
  const problem = (reason, e, detail) => ({ reason, fault: 'tool', kind: e.kind, key: e.name, expected: e.pin, got: e.got ?? 'not reported', detail });
  if (r.mismatched.length > 0) {
    report.fault = 'tool';
    return {
      reason: 'pin_mismatch',
      problems: r.mismatched.map((e) => problem('pin_mismatch', e, 'the worker reports another version than the run_key is filed under')),
      report,
    };
  }
  if (r.unverified.length > 0 && m === 'enforce') {
    report.fault = 'tool';
    return {
      reason: 'pin_unverified',
      problems: r.unverified.map((e) => problem('pin_unverified', e, 'the worker does not prove the pinned version (a commit pin needs the full commit in manifest tools)')),
      report,
    };
  }
  return { reason: null, problems: [], report };
}
