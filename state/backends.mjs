// The write_backend facts the state keeps per subject (schema v13,
// state/schema-v13.sql): read from an accepted meta-backend bundle by ingest,
// stored by StateDb.noteWriteBackend() in the same transaction as the result,
// read by the pump's writecheck mode routing (pump/modes.mjs) and by coverage
// (state/coverage.mjs). Pure helpers; no state access here.

export const BACKEND_LANE = 'meta-backend';
export const BACKEND_FIELD = 'write_backend';
export const CLASSES = Object.freeze(['local_full', 'mock_min', 'none']);
export const MODE_OF_CLASS = Object.freeze({ local_full: 'full', mock_min: 'min', none: 'none' });
/** How many env names go into the state and a dispatch (docs/INTERFACES.md: at most 20 per item). */
export const MAX_ENV_NAMES = 20;

const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const KIND_RE = /^[a-z_]{1,32}$/;
const SPEC_URL_RE = /^https:\/\/[a-z0-9.-]+\/[^\s?#@]*$/i;
const FORMAT_RE = /^[a-z0-9_]{1,40}$/;

/**
 * The facts kept from one write_backend value, checked field by field: anything
 * not of the contract's shape is dropped (null), so a malformed bundle cannot
 * put a value into a dispatch input. null when the value has no valid class.
 */
export function backendFacts(value) {
  if (!value || typeof value !== 'object' || !CLASSES.includes(value.class)) return null;
  const id = (x) => (typeof x === 'string' && ID_RE.test(x) ? x : null);
  const envIn = [...(Array.isArray(value.base_url_env) ? value.base_url_env : []), ...(Array.isArray(value.env_names) ? value.env_names : [])];
  const env = [...new Set(envIn.filter((n) => typeof n === 'string' && ENV_RE.test(n)))].slice(0, MAX_ENV_NAMES);
  const spec = typeof value.spec_url === 'string' && value.spec_url.length <= 512 && SPEC_URL_RE.test(value.spec_url) ? value.spec_url : null;
  return {
    class: value.class,
    mode: MODE_OF_CLASS[value.class],
    reason: value.class === 'none' && typeof value.reason === 'string' && /^[a-z_]{1,40}$/.test(value.reason) ? value.reason : null,
    backend: id(value.backend?.id),
    backend_kind: typeof value.backend?.kind === 'string' && KIND_RE.test(value.backend.kind) ? value.backend.kind : null,
    stand_in: value.class === 'local_full' ? id(value.stand_in?.id) : null,
    spec_url: value.class === 'mock_min' ? spec : null,
    spec_format: value.class === 'mock_min' && typeof value.spec_format === 'string' && FORMAT_RE.test(value.spec_format) ? value.spec_format : null,
    confidence: ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : null,
    env_names: env,
  };
}

/** The facts in an accepted bundle's files (Map path -> Buffer), or null: not the lane, no record, no value. */
export function backendFactsFromFiles(lane, files) {
  try {
    if (lane !== BACKEND_LANE) return null;
    const raw = files.get(`observations/${BACKEND_LANE}.ndjson`);
    if (!raw) return null;
    for (const line of raw.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r?.field === BACKEND_FIELD) return backendFacts(r.value);
    }
    return null;
  } catch {
    return null;
  }
}
