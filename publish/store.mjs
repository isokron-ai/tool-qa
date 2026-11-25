// The published layout, read and written as plain files.
//
//   data/manifest.json                    counts, coverage and the digest of every file below
//   data/results/<lane>/<YYYY-MM-DD>.jsonl one record per line, by the UTC day the result finished
//   data/corrections.jsonl                corrections and retractions, append-only
//
// A published record is never changed. A record whose id is already there is left as
// it is (an identical one is "unchanged"; a different one is a conflict and stops the
// run). A day file is rewritten when a late record joins it; the records in it stay
// sorted by (finished_at, record_id), so the same set of records is always the same
// bytes.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scanValue } from '../ingest/redact.mjs';
import { canonical, contentDigest, recordId, sha256 } from './canonical.mjs';
import { decideField } from './policy.mjs';

export const MANIFEST_SCHEMA = 'mcp-results/manifest/1';
export const CORRECTION_SCHEMA = 'mcp-results/correction/1';
export const LICENCE = 'CC-BY-4.0';
export const MANIFEST_PATH = 'manifest.json';
export const CORRECTIONS_PATH = 'corrections.jsonl';
const DAY_FILE_RE = /^results\/([a-z0-9][a-z0-9-]{0,63})\/(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const dayOf = (record) => String(record.measured.finished_at).slice(0, 10);
export const pathOf = (record) => `results/${record.lane}/${new Date(record.measured.finished_at).toISOString().slice(0, 10)}.jsonl`;

const order = (a, b) => (a.measured.finished_at < b.measured.finished_at ? -1 : a.measured.finished_at > b.measured.finished_at ? 1 : a.record_id < b.record_id ? -1 : 1);

function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else if (e.isFile()) out.push(p.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}

const lines = (text) => text.split('\n').filter((l) => l.trim() !== '');

/**
 * Read a data folder. Anything unexpected in it is a problem, not skipped.
 * @returns {{files: Map<string, object[]>, records: Map<string, {record: object, path: string}>, corrections: object[], manifest: object|null, manifestBytes: Buffer|null, problems: string[]}}
 */
export function loadStore(dataDir) {
  const files = new Map();
  const records = new Map();
  const problems = [];
  for (const rel of listFiles(dataDir)) {
    if (rel === MANIFEST_PATH || rel === CORRECTIONS_PATH) continue;
    if (!DAY_FILE_RE.test(rel)) { problems.push(`${rel}: not a file this layout has`); continue; }
    const recs = [];
    for (const [i, l] of lines(readFileSync(join(dataDir, rel), 'utf8')).entries()) {
      let r;
      try { r = JSON.parse(l); } catch { problems.push(`${rel}:${i + 1}: not JSON`); continue; }
      if (records.has(r.record_id)) problems.push(`${rel}:${i + 1}: duplicate record_id ${r.record_id}`);
      recs.push(r);
      records.set(r.record_id, { record: r, path: rel });
    }
    files.set(rel, recs);
  }
  let corrections = [];
  if (existsSync(join(dataDir, CORRECTIONS_PATH))) {
    corrections = lines(readFileSync(join(dataDir, CORRECTIONS_PATH), 'utf8')).map((l, i) => {
      try { return JSON.parse(l); } catch { problems.push(`${CORRECTIONS_PATH}:${i + 1}: not JSON`); return null; }
    }).filter(Boolean);
  }
  let manifest = null;
  let manifestBytes = null;
  if (existsSync(join(dataDir, MANIFEST_PATH))) {
    manifestBytes = readFileSync(join(dataDir, MANIFEST_PATH));
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { problems.push('manifest.json: not JSON'); }
  }
  return { files, records, corrections, manifest, manifestBytes, problems };
}

/** Record ids a correction takes out of circulation: retracted or purged. A re-run must not bring them back. */
export const removedIds = (corrections) => new Set(corrections.filter((c) => c.kind === 'retract' || c.kind === 'purge').map((c) => c.target));

/**
 * Merge new records into a loaded store (in memory).
 * @returns {{added: object[], unchanged: number, removed: number, conflicts: {record_id: string, path: string}[], touched: Set<string>}}
 */
export function merge(store, incoming, { windowStartMs = null } = {}) {
  const out = { added: [], unchanged: 0, removed: 0, conflicts: [], skipped_conflicts: 0, touched: new Set() };
  const gone = removedIds(store.corrections);
  for (const record of [...incoming].sort(order)) {
    if (gone.has(record.record_id)) { out.removed += 1; continue; }
    const have = store.records.get(record.record_id);
    if (have) {
      if (have.record.content_sha256 === record.content_sha256) out.unchanged += 1;
      // A registry or redaction change makes a result read again differ from what was published.
      // Within the window (results still being read again) it is skipped and counted privately;
      // older than that nothing should be read again, so it stops the run.
      else if (windowStartMs !== null && Date.parse(have.record.measured.finished_at) >= windowStartMs) out.skipped_conflicts += 1;
      else out.conflicts.push({ record_id: record.record_id, path: have.path });
      continue;
    }
    const path = pathOf(record);
    if (!store.files.has(path)) store.files.set(path, []);
    store.files.get(path).push(record);
    store.records.set(record.record_id, { record, path });
    out.added.push(record);
    out.touched.add(path);
  }
  for (const p of out.touched) store.files.get(p).sort(order);
  return out;
}

const serialize = (recs) => recs.map((r) => `${canonical(r)}\n`).join('');

/**
 * The manifest of a store: what each file holds, with digests, and the counts.
 * No clock in it: the same data is the same manifest. `prev_manifest_sha256` chains
 * it to the manifest it replaced (unchanged while the body stays the same).
 */
export function buildManifest(store, { registry, prev }) {
  const files = [];
  const lanes = {};
  const live = removedIds(store.corrections);
  for (const [path, recs] of [...store.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (recs.length === 0) continue;
    const body = serialize(recs);
    const m = DAY_FILE_RE.exec(path);
    files.push({ path, lane: m[1], day: m[2], records: recs.length, bytes: Buffer.byteLength(body), sha256: sha256(body) });
    const l = (lanes[m[1]] ??= { records: 0, subjects: new Set(), coverage: {}, fault_side: {}, first_finished_at: null, last_finished_at: null });
    for (const r of recs) {
      if (live.has(r.record_id)) continue;
      l.records += 1;
      l.subjects.add(r.subject.id);
      l.coverage[r.coverage.state] = (l.coverage[r.coverage.state] ?? 0) + 1;
      if (r.coverage.fault_side) l.fault_side[r.coverage.fault_side] = (l.fault_side[r.coverage.fault_side] ?? 0) + 1;
      const f = r.measured.finished_at;
      if (!l.first_finished_at || f < l.first_finished_at) l.first_finished_at = f;
      if (!l.last_finished_at || f > l.last_finished_at) l.last_finished_at = f;
    }
  }
  const byLane = {};
  const all = new Set();
  let total = 0;
  for (const name of Object.keys(lanes).sort()) {
    const l = lanes[name];
    for (const s of l.subjects) all.add(s);
    total += l.records;
    byLane[name] = {
      records: l.records,
      subjects: l.subjects.size,
      coverage: Object.fromEntries(Object.entries(l.coverage).sort()),
      fault_side: Object.fromEntries(Object.entries(l.fault_side).sort()),
      first_finished_at: l.first_finished_at,
      last_finished_at: l.last_finished_at,
    };
  }
  const body = {
    schema: MANIFEST_SCHEMA,
    licence: LICENCE,
    note: 'Separate measurements, never one score. A record says what was measured, by which tool version, and when. A skipped or unassessed record says whose limit it was; it is not a failed check.',
    registry: { version: registry.version, sha256: registry.sha256 },
    totals: { records: total, subjects: all.size, files: files.length, corrections: store.corrections.length },
    lanes: byLane,
    files,
    corrections: store.corrections.length ? { path: CORRECTIONS_PATH, entries: store.corrections.length } : null,
  };
  return { ...body, prev_manifest_sha256: prev ?? null };
}

/**
 * Bytes of the new manifest, keeping the old one byte for byte when only the chain would change.
 */
export function manifestBytes(store, { registry }) {
  const old = store.manifest;
  const prevHash = store.manifestBytes ? sha256(store.manifestBytes) : null;
  const strip = (m) => canonical({ ...m, prev_manifest_sha256: null });
  const candidate = buildManifest(store, { registry, prev: prevHash });
  if (old && strip(old) === strip(candidate)) return store.manifestBytes;
  return Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
}

/**
 * The files to write: every touched day file, the corrections file as it is, and the manifest.
 * @returns {Map<string, Buffer>} path (relative to data/) to bytes; only files whose bytes differ from `store`'s own
 */
export function filesToWrite(store, merged, { registry, dataDir }) {
  const out = new Map();
  for (const p of merged.touched) out.set(p, Buffer.from(serialize(store.files.get(p))));
  const mb = manifestBytes(store, { registry });
  if (!store.manifestBytes || !mb.equals(store.manifestBytes)) out.set(MANIFEST_PATH, mb);
  // Only what changes on disk.
  for (const [p, bytes] of [...out]) {
    const f = join(dataDir, p);
    if (existsSync(f) && readFileSync(f).equals(bytes)) out.delete(p);
  }
  return out;
}

export function writeFiles(dir, files) {
  for (const [p, bytes] of files) {
    const f = join(dir, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, bytes);
  }
}

/**
 * Checks on what is already published, against the registry as it is now: nothing
 * published may be a field that is no longer publishable, no record may hold a
 * secret-looking value, every record's id and digest must recompute, and each lives
 * in the file its lane and day name. A violation stops the publisher.
 * @returns {string[]} problems (record ids and field names only, never values)
 */
export function auditStore(store, registry) {
  const problems = [...store.problems];
  for (const [id, { record, path }] of store.records) {
    const where = `${path} ${id.slice(0, 12)}`;
    if (record.record_id !== recordId(record.provenance)) problems.push(`${where}: record_id does not match its provenance`);
    if (record.content_sha256 !== contentDigest(record)) problems.push(`${where}: content_sha256 does not match`);
    if (path !== pathOf(record)) problems.push(`${where}: in the wrong file (expected ${pathOf(record)})`);
    for (const o of record.observations ?? []) {
      const d = decideField(registry.fields, o.field);
      if (d.decision !== 'publish') problems.push(`${where}: field ${o.field} is not publishable now (${d.reason})`);
    }
    const hits = scanValue(record);
    if (hits.length) problems.push(`${where}: ${hits.length} redaction hit(s) (${[...new Set(hits.map((h) => h.rule))].join(', ')})`);
  }
  return problems;
}
