// Field registry: which observation fields a worker may report, and their types.
//
// The registry lives in the results repo (fields/registry.yaml). Ingest reads
// it at a pinned commit and checks the file's sha256, so a change there takes
// effect here only when the pin below is moved on purpose.
//
// Observation files (observations/**.ndjson in a result bundle) hold one JSON
// object per line:
//
//   {"field": "<registry id>", "value": <value>, "why"?: "<text>", "stage"?: "<stage>"}
//
// The field must be declared and not deprecated, and the value must match the
// declared type. A null value is allowed only with a `why`.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parseYaml } from '../scripts/lib/yaml-lite.mjs';
import { isDateTime } from '../worker-kit/contract.mjs';

export const REGISTRY_REPO = 'isokron-ai/mcp-results';
export const REGISTRY_COMMIT = '2f85a6d72ab19462eee8cac2617245534f5f476e';
export const REGISTRY_PATH = 'fields/registry.yaml';
export const REGISTRY_URL = `https://raw.githubusercontent.com/${REGISTRY_REPO}/${REGISTRY_COMMIT}/${REGISTRY_PATH}`;
/** sha256 of fields/registry.yaml at REGISTRY_COMMIT. Move both together. */
export const REGISTRY_SHA256 = '4e8f2a85c06c58ca426e833011eb1678045eac14d99f8376b539e0784f880e9d';

export const FIELD_TYPES = Object.freeze(['string', 'integer', 'number', 'boolean', 'enum', 'array', 'object', 'timestamp', 'hash']);
export const FIELD_STATUSES = Object.freeze(['planned', 'active', 'deprecated']);
export const OBSERVATION_KEYS = Object.freeze(['field', 'value', 'why', 'stage']);

const ENTRY_KEYS = ['id', 'layer', 'type', 'unit', 'source', 'class', 'redaction', 'status'];
const FIELD_ID_RE = /^[a-z][a-z0-9_]{0,127}$/;
const REDACTION_RE = /^R[1-4]$/;
const STAGE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ENUM_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_WHY = 1000;

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Parse and check registry YAML.
 * @returns {{version: number, sha256: string, fields: Map<string, object>}}
 */
export function parseRegistry(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new RegistryError(`registry: not readable YAML (${err.message})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new RegistryError('registry: top level must be a mapping');
  if (typeof doc.version !== 'string' || !/^(0|[1-9]\d{0,5})$/.test(doc.version)) {
    throw new RegistryError('registry: version must be a whole number');
  }
  if (!Array.isArray(doc.fields) || doc.fields.length === 0) throw new RegistryError('registry: fields must be a non-empty list');
  const fields = new Map();
  doc.fields.forEach((e, i) => {
    const where = `registry: fields[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new RegistryError(`${where} must be a mapping`);
    for (const k of ENTRY_KEYS) {
      if (e[k] === undefined) throw new RegistryError(`${where} has no ${k}`);
    }
    if (typeof e.id !== 'string' || !FIELD_ID_RE.test(e.id)) throw new RegistryError(`${where}: id must be snake_case`);
    if (!FIELD_TYPES.includes(e.type)) throw new RegistryError(`${where} (${e.id}): unknown type ${JSON.stringify(e.type)}`);
    if (!FIELD_STATUSES.includes(e.status)) throw new RegistryError(`${where} (${e.id}): unknown status ${JSON.stringify(e.status)}`);
    for (const k of ['layer', 'unit', 'source', 'class']) {
      if (typeof e[k] !== 'string' || e[k] === '') throw new RegistryError(`${where} (${e.id}): ${k} must be text`);
    }
    // yaml-lite returns scalars as strings, so a YAML null arrives as "null".
    let redaction;
    if (e.redaction === null || e.redaction === 'null') redaction = null;
    else if (Array.isArray(e.redaction) && e.redaction.length > 0 && e.redaction.every((r) => REDACTION_RE.test(r))) redaction = [...e.redaction];
    else throw new RegistryError(`${where} (${e.id}): redaction must be null or a list of R1..R4`);
    if (fields.has(e.id)) throw new RegistryError(`registry: duplicate field id ${e.id}`);
    fields.set(e.id, {
      id: e.id, layer: e.layer, type: e.type, unit: e.unit, source: e.source,
      class: e.class, redaction, status: e.status,
    });
  });
  return {
    version: Number(doc.version),
    sha256: createHash('sha256').update(text).digest('hex'),
    fields,
  };
}

/**
 * Load the registry from a local file (no digest pin) or from the pinned URL
 * (digest must match `expectSha256`, by default REGISTRY_SHA256).
 */
export async function loadRegistry({ path, url = REGISTRY_URL, expectSha256 = REGISTRY_SHA256, fetch = globalThis.fetch } = {}) {
  if (path) {
    const reg = parseRegistry(readFileSync(path, 'utf8'));
    return { ...reg, source: path };
  }
  if (!/^https:\/\//.test(url)) throw new RegistryError(`registry: URL must be https, got ${url}`);
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new RegistryError(`registry: GET ${url} failed with HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_REGISTRY_BYTES) throw new RegistryError(`registry: ${url} is larger than ${MAX_REGISTRY_BYTES} bytes`);
  const digest = createHash('sha256').update(buf).digest('hex');
  if (expectSha256 && digest !== expectSha256) {
    throw new RegistryError(`registry: sha256 ${digest} of ${url} does not match the pinned ${expectSha256}`);
  }
  const reg = parseRegistry(buf.toString('utf8'));
  return { ...reg, source: url };
}

/** True if `value` fits a registry type. */
export function checkValueType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && ENUM_RE.test(value);
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'timestamp': return isDateTime(value);
    case 'hash': return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
    default: throw new Error(`unknown field type ${JSON.stringify(type)}`);
  }
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Check every observations/ file of a bundle against the registry.
 * Errors name the file, line, reason and field, never the observed value.
 * Reasons: observation_format, undeclared_field, deprecated_field, field_type.
 * @param {Map<string, Buffer>|Iterable<[string, Buffer]>} files
 * measured counts the records with a value (not null): what was actually
 * measured (R-SUB-10).
 * @returns {{ok: boolean, errors: object[], records: number, measured: number, truncated?: true}}
 */
export function validateObservations(files, registry, { maxErrors = 50 } = {}) {
  const errors = [];
  let records = 0;
  let measured = 0;
  let truncated = false;
  const add = (e) => {
    if (errors.length < maxErrors) errors.push(e);
    else truncated = true;
  };
  for (const [path, data] of files) {
    if (!path.startsWith('observations/')) continue;
    if (!path.endsWith('.ndjson')) {
      add({ path, reason: 'observation_format', message: 'observation files must be .ndjson' });
      continue;
    }
    let text;
    try {
      text = strictUtf8.decode(data);
    } catch {
      add({ path, reason: 'observation_format', message: 'not valid UTF-8' });
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const at = { path, line: i + 1 };
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        add({ ...at, reason: 'observation_format', message: 'line is not JSON' });
        continue;
      }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        add({ ...at, reason: 'observation_format', message: 'line is not a JSON object' });
        continue;
      }
      const extra = Object.keys(rec).filter((k) => !OBSERVATION_KEYS.includes(k));
      if (extra.length > 0) {
        add({ ...at, reason: 'observation_format', message: `unexpected key(s); allowed: ${OBSERVATION_KEYS.join(', ')}` });
        continue;
      }
      if (typeof rec.field !== 'string' || !Object.hasOwn(rec, 'value')) {
        add({ ...at, reason: 'observation_format', message: 'needs "field" (text) and "value"' });
        continue;
      }
      if (rec.stage !== undefined && (typeof rec.stage !== 'string' || !STAGE_RE.test(rec.stage))) {
        add({ ...at, reason: 'observation_format', message: 'stage must match ^[a-z][a-z0-9_-]{0,63}$' });
        continue;
      }
      if (rec.why !== undefined && (typeof rec.why !== 'string' || rec.why.length === 0 || rec.why.length > MAX_WHY)) {
        add({ ...at, reason: 'observation_format', message: `why must be text of 1..${MAX_WHY} characters` });
        continue;
      }
      const safeField = FIELD_ID_RE.test(rec.field) ? rec.field : undefined;
      const def = registry.fields.get(rec.field);
      if (!def) {
        add({ ...at, reason: 'undeclared_field', field: safeField, message: 'field is not declared in the registry' });
        continue;
      }
      if (def.status === 'deprecated') {
        add({ ...at, reason: 'deprecated_field', field: def.id, message: 'field is deprecated in the registry' });
        continue;
      }
      if (rec.value === null) {
        if (rec.why === undefined) add({ ...at, reason: 'observation_format', field: def.id, message: 'a null value needs "why"' });
        else records++;
        continue;
      }
      if (!checkValueType(def.type, rec.value)) {
        add({ ...at, reason: 'field_type', field: def.id, message: `value is not of type ${def.type}` });
        continue;
      }
      records++;
      measured++;
    }
  }
  const out = { ok: errors.length === 0 && !truncated, errors, records, measured };
  if (truncated) out.truncated = true;
  return out;
}
