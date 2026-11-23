// Worker result contract, schema version 1.
//
// A worker writes its result files into a bundle directory with this layout:
//
//   observations/**.ndjson  field records, one JSON object per line:
//                           {"field": "<registry id>", "value": <any>, "why"?: "...", "stage"?: "..."}
//                           Every field must be declared in the field registry.
//   results/**              our tools' own reports
//   controls/**             what the pipeline produced for this shard's control target(s)
//   raw/**                  captured target bytes; data only, never interpreted as a result
//   logs/**                 our tools' logs
//
// buildManifest() adds manifest.json (see manifest.schema.json) with the
// attempt identity, the workflow that ran, tool and oracle versions, timings,
// sha256 and size of every file, recorded skips and control outcomes. The
// bundle (manifest.json plus files) is then packed as a tar (tar.mjs) and
// age-encrypted to the ingest public key.
//
// This file uses only Node's standard library and runs on Node 20 or newer, so
// the composite action can use the runner's own Node.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_NAME = 'manifest.json';

// Size caps (R-ING-03 in REGRESSIONS.md). Ingest judges every bundle in a pump
// tick on one CPU, so a bundle must be small enough to download, decrypt and
// scan in seconds:
//
//   MAX_FILE_BYTES      8 MiB per file, manifest.json included. Reports, logs
//                       and observations are kilobytes; captured target output
//                       (raw/) is truncated by the worker to fit.
//   MAX_BUNDLE_BYTES    64 MiB for the whole tar (headers included), before
//                       encryption. Scanning that much crafted text takes a
//                       few seconds, far inside the judge's 60 s limit.
//   MAX_ARTIFACT_BYTES  the uploaded ciphertext: the tar plus age's overhead
//                       (about 0.03 %), with room to spare.
//
// build-bundle refuses to build past them; ingest rejects a bundle past them
// (file_too_large, bundle_too_large, artifact_too_large).
export const MAX_FILE_BYTES = 8 * 1024 ** 2;
export const MAX_BUNDLE_BYTES = 64 * 1024 ** 2;
export const MAX_ARTIFACT_BYTES = MAX_BUNDLE_BYTES + 1024 ** 2;
export const BUNDLE_DIRS = Object.freeze(['observations', 'results', 'controls', 'raw', 'logs']);

/** Why a stage did not run. Skips are recorded, never silent. */
export const SKIP_REASONS = Object.freeze([
  'remote_only', 'no_runnable_artifact', 'unsupported_transport',
  'build_failed_upstream', 'install_failed_registry',
  'start_requires_credentials', 'no_local_backend', 'heavy_backend',
  'timeout_start', 'cluster_member', 'quarantined', 'lane_disabled',
  'policy_excluded', 'trace_unavailable', 'bridge_required',
]);

/** Control targets carried by a shard. */
export const CONTROL_KINDS = Object.freeze(['known_good', 'known_bad', 'malicious', 'protocol_variant', 'forgery']);

/** JSON Schema keywords the built-in validator understands. Anything else throws. */
export const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', '$comment', 'title', 'description',
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'format',
]);

const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

let cachedSchema;
/** The manifest JSON Schema (parsed once). */
export function loadSchema() {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(readFileSync(new URL('./manifest.schema.json', import.meta.url), 'utf8'));
  }
  return cachedSchema;
}

const BUNDLE_PATH_RE = new RegExp(loadSchema().$defs.bundle_path.pattern);
const BUNDLE_PATH_MAX = loadSchema().$defs.bundle_path.maxLength;

/** True if `p` is an allowed relative path for a file inside a bundle. */
export function isBundlePath(p) {
  return typeof p === 'string' && p.length <= BUNDLE_PATH_MAX && BUNDLE_PATH_RE.test(p);
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Highest item index a bundle name may carry (a shard holds far fewer items). */
export const MAX_ITEM_INDEX = 9999;

function checkAttemptId(attemptId) {
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_RE.test(attemptId)) {
    throw new Error(`invalid attempt id ${JSON.stringify(attemptId)}`);
  }
}

/**
 * Name of the uploaded artifact (and of the encrypted file) for one item of an
 * attempt. A dispatch carries a list of items; the worker uploads one bundle
 * per item, named by the item's position (0-based) in that list.
 */
export function artifactName(attemptId, index) {
  checkAttemptId(attemptId);
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ITEM_INDEX) {
    throw new Error(`invalid item index ${JSON.stringify(index)} (a whole number from 0 to ${MAX_ITEM_INDEX})`);
  }
  return `result-${attemptId}-${index}.tar.age`;
}

/**
 * The older one-bundle-per-attempt name. Ingest still accepts it for a
 * dispatch that carries exactly one item.
 */
export function legacyArtifactName(attemptId) {
  checkAttemptId(attemptId);
  return `result-${attemptId}.tar.age`;
}

export function isDateTime(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_TIME_RE.exec(s);
  if (!m) return false;
  const [, y, mo, d, h, mi, sec, , , oh, om] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > new Date(Date.UTC(Number(y), month, 0)).getUTCDate()) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return false;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return false;
  return Number.isFinite(Date.parse(s));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, v) {
  const got = typeOf(v);
  if (want === 'number') return got === 'number' || got === 'integer';
  return want === got;
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`schema: only local $ref is supported, got ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`schema: $ref ${ref} does not resolve`);
  }
  return node;
}

/**
 * Validate a value against a schema that uses only SUPPORTED_KEYWORDS.
 * @returns {{path: string, message: string}[]} empty when valid
 */
export function validateAgainstSchema(schema, value, root = schema, path = '$', errors = []) {
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(k)) throw new Error(`schema: unsupported keyword ${k} at ${path}`);
  }
  if (schema.$ref !== undefined) {
    return validateAgainstSchema(resolveRef(root, schema.$ref), value, root, path, errors);
  }
  const err = (message) => errors.push({ path, message });
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      err(`must be ${types.join(' or ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) err(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) err(`must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) err(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) err(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) err(`does not match ${schema.pattern}`);
    if (schema.format !== undefined) {
      if (schema.format !== 'date-time') throw new Error(`schema: unsupported format ${schema.format}`);
      if (!isDateTime(value)) err('must be an RFC 3339 date-time with a zone');
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`must have at most ${schema.maxItems} items`);
    if (schema.items !== undefined) {
      value.forEach((item, i) => validateAgainstSchema(schema.items, item, root, `${path}[${i}]`, errors));
    }
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, message: 'is required' });
    }
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) {
        validateAgainstSchema(props[key], v, root, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: 'is not allowed' });
      }
    }
  }
  return errors;
}

/**
 * Validate a manifest: the JSON Schema plus rules a schema can't express
 * (unique paths, timing order, control and skip references).
 * @returns {{ok: boolean, errors: {path: string, message: string}[]}}
 */
export function validateManifest(manifest) {
  const errors = validateAgainstSchema(loadSchema(), manifest);
  if (errors.length > 0 || typeOf(manifest) !== 'object') return { ok: false, errors };

  const listed = new Set();
  manifest.files.forEach((f, i) => {
    if (listed.has(f.path)) errors.push({ path: `$.files[${i}].path`, message: `duplicate path ${f.path}` });
    listed.add(f.path);
  });
  if (Date.parse(manifest.finished_at) < Date.parse(manifest.started_at)) {
    errors.push({ path: '$.finished_at', message: 'is before started_at' });
  }
  manifest.controls.forEach((c, i) => {
    if (c.output !== undefined && !listed.has(c.output)) {
      errors.push({ path: `$.controls[${i}].output`, message: `${c.output} is not listed in files` });
    }
    if (c.kind === 'forgery' && c.output === undefined) {
      errors.push({ path: `$.controls[${i}].output`, message: 'is required for a forgery control' });
    }
  });
  manifest.skips.forEach((s, i) => {
    if (s.evidence !== undefined && !listed.has(s.evidence)) {
      errors.push({ path: `$.skips[${i}].evidence`, message: `${s.evidence} is not listed in files` });
    }
  });
  return { ok: errors.length === 0, errors };
}

/** Workflow identity from the runner's own variables (set by GitHub, not by the job). */
export function workflowFromEnv(env = process.env) {
  const need = ['GITHUB_REPOSITORY', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
  for (const k of need) {
    if (!env[k]) throw new Error(`${k} is not set (run this inside a GitHub Actions job)`);
  }
  const repo = env.GITHUB_REPOSITORY;
  const ref = env.GITHUB_WORKFLOW_REF;
  const at = ref.lastIndexOf('@');
  const full = at > 0 ? ref.slice(0, at) : ref;
  if (!full.startsWith(`${repo}/`)) {
    throw new Error(`GITHUB_WORKFLOW_REF ${ref} points to another repository; the result workflow must live in ${repo}`);
  }
  const toInt = (k) => {
    if (!/^[1-9]\d*$/.test(env[k])) throw new Error(`${k} is not a positive whole number`);
    return Number(env[k]);
  };
  return {
    repo,
    file: full.slice(repo.length + 1),
    sha: env.GITHUB_WORKFLOW_SHA,
    run_id: toInt('GITHUB_RUN_ID'),
    run_attempt: toInt('GITHUB_RUN_ATTEMPT'),
  };
}

/**
 * Read every regular file under `dir` as bundle files, sorted by path.
 * Refuses symlinks, special files, a manifest.json of its own, paths outside
 * the bundle layout, a file over MAX_FILE_BYTES and files over
 * MAX_BUNDLE_BYTES in total.
 * @returns {{path: string, data: Buffer}[]}
 */
export function collectFiles(dir) {
  const out = [];
  let total = 0;
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) throw new Error(`bundle: ${childRel} is a symlink; only regular files are allowed`);
      if (st.isDirectory()) { walk(childAbs, childRel); continue; }
      if (!st.isFile()) throw new Error(`bundle: ${childRel} is not a regular file`);
      if (childRel === MANIFEST_NAME) throw new Error('bundle: the directory already has a manifest.json; the action writes it');
      if (!isBundlePath(childRel)) {
        throw new Error(`bundle: ${childRel} is outside the layout (${BUNDLE_DIRS.join('/, ')}/; names use A-Z a-z 0-9 . _ -)`);
      }
      if (st.size > MAX_FILE_BYTES) {
        throw new Error(`bundle: ${childRel} is ${st.size} bytes, more than the ${MAX_FILE_BYTES} a file may hold (truncate captured output first)`);
      }
      total += st.size;
      if (total > MAX_BUNDLE_BYTES) throw new Error(`bundle: the files hold more than the ${MAX_BUNDLE_BYTES} bytes a bundle may hold`);
      out.push({ path: childRel, data: readFileSync(childAbs) });
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const META_KEYS = ['subject', 'tools', 'oracles', 'settings_manifest_digest', 'started_at', 'finished_at', 'skips', 'controls'];

/**
 * Build and validate a manifest.
 * @param {object} p
 * @param {{attempt_id: string, fence: number, run_key: string}} p.identity  from the dispatch
 * @param {object} p.workflow  from workflowFromEnv()
 * @param {object} p.meta      subject, tools, oracles, settings_manifest_digest, started_at,
 *                             finished_at (optional, default now), skips, controls
 * @param {{path: string, data: Buffer}[]} p.files
 */
export function buildManifest({ identity, workflow, meta, files, now = () => new Date() }) {
  for (const k of Object.keys(meta ?? {})) {
    if (!META_KEYS.includes(k)) throw new Error(`meta: ${k} is not allowed here (allowed: ${META_KEYS.join(', ')})`);
  }
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    attempt_id: identity.attempt_id,
    fence: identity.fence,
    run_key: identity.run_key,
    subject: meta.subject,
    workflow,
    tools: meta.tools,
    oracles: meta.oracles ?? [],
    settings_manifest_digest: meta.settings_manifest_digest,
    started_at: meta.started_at,
    finished_at: meta.finished_at ?? now().toISOString(),
    files: [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({ path: f.path, sha256: sha256Hex(f.data), bytes: f.data.length })),
    skips: meta.skips ?? [],
    controls: meta.controls ?? [],
  };
  const r = validateManifest(manifest);
  if (!r.ok) {
    throw new Error(`manifest is invalid:\n${r.errors.map((e) => `  ${e.path} ${e.message}`).join('\n')}`);
  }
  return manifest;
}
