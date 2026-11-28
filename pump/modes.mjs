// Writecheck modes: route a lane's subjects by their write_backend class
// (docs/INTERFACES.md, "Writecheck modes"; state/backends.mjs).
//
// A lane opts in with `modes` in pump/workflows.json:
//
//   "modes": {
//     "fact": "write_backend",
//     "unmatched": "default",           // or "skip"
//     "list": {
//       "full": { "class": "local_full", "switch": "LANE_WRITECHECK_FULL_ENABLED" },
//       "min":  { "class": "mock_min",   "switch": "LANE_WRITECHECK_MIN_ENABLED" }
//     }
//   }
//
// A mode is on only while its repository variable is exactly "true" (off by
// default, like every lane switch). While at least one mode is on, a subject
// whose latest accepted write_backend has that mode's class, with the routing
// facts the mode needs (a stand-in for full, a spec URL for min), is
// dispatched in that mode; every other subject is dispatched as before
// (unmatched "default") or not at all ("skip"). With every mode off nothing
// changes: no new input is sent and no run_key moves.
//
// A pair in a mode files its results under its own run_key: settings_state
// becomes `<settings_state>+mode=<mode>+backend=<id>`, so a class change makes
// the pair due again and a mode result is never read as a default one. Shards
// are homogeneous (one mode, one backend, one stand-in or spec URL), and the
// worker gets the mode inputs of INTERFACES.md: mode, backend, backend_kind,
// stand_in, spec_url, spec_format, env_names (aligned with items).

export const MODE_NAMES = Object.freeze(['full', 'min']);
export const MODE_CLASS = Object.freeze({ full: 'local_full', min: 'mock_min' });
const SWITCH_RE = /^LANE_[A-Z0-9_]+_ENABLED$/;
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SPEC_URL_RE = /^https:\/\/[a-z0-9.-]+\/[^\s?#@]*$/i;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_ENV_PER_ITEM = 20;

/** Problems with the `modes` of every lane (empty when fine). */
export function modeProblems(workflows) {
  const p = [];
  for (const [name, wf] of Object.entries(workflows ?? {})) {
    const m = wf?.modes;
    if (m === undefined) continue;
    if (!m || typeof m !== 'object' || Array.isArray(m)) { p.push(`${name}: modes must be an object`); continue; }
    if (m.fact !== 'write_backend') p.push(`${name}: modes.fact must be "write_backend"`);
    if (m.unmatched !== 'default' && m.unmatched !== 'skip') p.push(`${name}: modes.unmatched must be "default" or "skip"`);
    if (wf.dispatch_style === 't0' || wf.control_subjects) p.push(`${name}: a control lane takes no modes`);
    const list = m.list;
    if (!list || typeof list !== 'object' || Array.isArray(list) || Object.keys(list).length === 0) { p.push(`${name}: modes.list must name at least one mode`); continue; }
    const switches = new Set();
    for (const [mode, def] of Object.entries(list)) {
      if (!MODE_NAMES.includes(mode)) p.push(`${name}: mode ${mode} is not one of ${MODE_NAMES.join(', ')}`);
      else if (def?.class !== MODE_CLASS[mode]) p.push(`${name}: mode ${mode} takes class ${MODE_CLASS[mode]}`);
      if (typeof def?.switch !== 'string' || !SWITCH_RE.test(def.switch)) p.push(`${name}: mode ${mode} needs switch, a repository variable name like LANE_WRITECHECK_FULL_ENABLED`);
      else if (switches.has(def.switch)) p.push(`${name}: two modes share the switch ${def.switch}`);
      else switches.add(def.switch);
    }
  }
  return p;
}

/**
 * The workflows as the pump runs them: a lane with modes gets `active_modes`,
 * the modes whose switch is exactly "true" ({} when none). Never mutates its input.
 */
export function applyModeSwitches(workflows, env = {}) {
  const out = {};
  for (const [name, wf] of Object.entries(workflows ?? {})) {
    if (!wf?.modes?.list) { out[name] = wf; continue; }
    const active = {};
    for (const [mode, def] of Object.entries(wf.modes.list)) if (env?.[def.switch] === 'true') active[mode] = def;
    out[name] = { ...wf, active_modes: active };
  }
  return out;
}

/** Whether any mode of a lane is on. */
export const modesOn = (wf) => Boolean(wf?.active_modes && Object.keys(wf.active_modes).length > 0);

/**
 * The mode a subject goes in on this lane: { mode, backend, backend_kind, stand_in, spec_url, spec_format, env_names }
 * or null (no mode on, no facts, a class no active mode takes, or facts the mode cannot run with).
 */
export function modeFor(wf, facts) {
  if (!modesOn(wf) || !facts) return null;
  for (const [mode, def] of Object.entries(wf.active_modes)) {
    if (facts.class !== def.class) continue;
    if (typeof facts.backend !== 'string' || !ID_RE.test(facts.backend)) return null;
    if (mode === 'full' && !(typeof facts.stand_in === 'string' && ID_RE.test(facts.stand_in))) return null;
    if (mode === 'min' && !(typeof facts.spec_url === 'string' && facts.spec_url.length <= 512 && SPEC_URL_RE.test(facts.spec_url))) return null;
    return {
      mode,
      backend: facts.backend,
      backend_kind: typeof facts.backend_kind === 'string' ? facts.backend_kind : '',
      stand_in: mode === 'full' ? facts.stand_in : '',
      spec_url: mode === 'min' ? facts.spec_url : '',
      spec_format: mode === 'min' && typeof facts.spec_format === 'string' ? facts.spec_format : '',
      env_names: (Array.isArray(facts.env_names) ? facts.env_names : []).filter((n) => typeof n === 'string' && ENV_RE.test(n)).slice(0, MAX_ENV_PER_ITEM),
    };
  }
  return null;
}

/** Whether a subject with no mode is dispatched on this lane at all. */
export const unmatchedSkipped = (wf) => modesOn(wf) && wf.modes?.unmatched === 'skip';

/** The settings_state a mode files its run_keys under. */
export function modeSettings(wf, m) {
  return m ? `${wf?.settings_state ?? 'default'}+mode=${m.mode}+backend=${m.backend}` : wf?.settings_state;
}

/** The key that keeps a shard homogeneous: mode, backend, and the stand-in or spec URL. */
export const shardKey = (m) => (m ? `${m.mode}\u0000${m.backend}\u0000${m.stand_in || m.spec_url}` : '');

/**
 * The mode inputs of one shard (docs/INTERFACES.md): the shard's mode facts, and env_names aligned with `items`
 * (each item's own names). `items` carry their mode as `mode` (what the due list attached).
 */
export function modeInputs(items) {
  const first = items.find((it) => it.mode)?.mode;
  if (!first) return null;
  for (const it of items) if (shardKey(it.mode) !== shardKey(first)) throw new Error('a mode shard must be homogeneous');
  return {
    mode: first.mode,
    backend: first.backend,
    backend_kind: first.backend_kind,
    stand_in: first.stand_in,
    spec_url: first.spec_url,
    spec_format: first.spec_format,
    env_names: JSON.stringify(items.map((it) => it.mode.env_names)),
  };
}
