#!/usr/bin/env node
// Derive the drift signals (longitudinal/drift.mjs) from the loop's accepted
// results, subject by subject, in the order they were observed.
//
//   node longitudinal/derive.mjs --archive <dir> [--identity <file>] [--out <file>] [--since <iso>]
//   node longitudinal/derive.mjs --plain <dir> [--out <file>]
//
// --archive reads the archive the Mac's archive pull keeps (scripts/archive-pull.mjs):
// every sealed `<dir>/ingest/<day>/<artifact>/*.tar.age`, decrypted in memory with
// the ingest identity (default ~/.isokron/loop-age-identity.key; never printed,
// written only to ingest/age.mjs's 0600 temporary file for the age call). Only
// items ingest accepted (`accepted/<attempt>/<index>/`) are read. Nothing
// decrypted is written to disk. --plain reads the same layout unencrypted
// (`accepted/<attempt>/<index>/...` under <dir>), for tests and fixtures.
//
// Output: a summary on stdout (counts, events by kind and rank, tool-side
// findings); with --out, one line per derived field per subject:
// {subject, field, value, derived_at, source}. The fields are git_tag_moves,
// oci_tag_moves and catalog_drift_same_version from the mcp-results field
// registry; their values hold only public facts (tag names, commit ids, image
// digests, tool-list hashes and counts).
//
// Why a separate step and not ingest: ingest judges one bundle at a time and
// keeps no observation history in the state store (that would be a state
// schema change); the archive is the only complete history, and a tool list
// signal needs results from several lanes (scan-static, live-probe) side by
// side. This step only reads.
//
// --since <time> reports only events seen at or after it; everything observed
// before it is the baseline they are compared with. --out is written 0600 and
// never inside the folder being read.
//
// Exit codes: 0 done; 2 usage (or --out inside the input); 3 the archive or
// identity could not be read.

import { closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ageDecrypt } from '../ingest/age.mjs';
import { readTar } from '../worker-kit/tar.mjs';
import { catalogDrift, gitTagSeries, ociTagSeries } from './drift.mjs';

export const DEFAULT_IDENTITY = join(homedir(), '.isokron', 'loop-age-identity.key');
export const SOURCE = 'tool-qa longitudinal/derive.mjs';
export const DERIVED_FIELDS = Object.freeze(['git_tag_moves', 'oci_tag_moves', 'catalog_drift_same_version']);
const ITEM_RE = /^accepted\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(\d{1,6})\/(.+)$/;
const WANT_RE = /^(manifest\.json|observations\/[A-Za-z0-9._-]+\.ndjson|results\/(scan-static|live-probe)\.json)$/;

/**
 * Items from tar entries (or files) laid out as accepted/<attempt>/<index>/<path>.
 * Only the manifest, the observations and the scan-static or live-probe result
 * are kept. An item without a readable manifest is skipped and counted.
 */
export function itemsFromEntries(entries, stats = { unreadable: 0 }) {
  const groups = new Map();
  for (const e of entries) {
    const m = ITEM_RE.exec(e.path);
    if (!m || !WANT_RE.test(m[3])) continue;
    const k = `${m[1]}/${m[2]}`;
    if (!groups.has(k)) groups.set(k, { attempt: m[1], index: Number(m[2]), files: new Map() });
    groups.get(k).files.set(m[3], e.data);
  }
  const out = [];
  for (const g of groups.values()) {
    const item = toItem(g, stats);
    if (item) out.push(item);
  }
  return out;
}

function parseJson(buf) {
  try { return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)); } catch { return null; }
}

function toItem(g, stats) {
  const m = parseJson(g.files.get('manifest.json'));
  if (!m || typeof m.subject?.id !== 'string' || typeof m.finished_at !== 'string') { stats.unreadable++; return null; }
  const lane = basename(String(m.workflow?.file ?? '')).replace(/\.ya?ml$/, '') || null;
  const fields = new Map();
  for (const [path, data] of g.files) {
    if (!path.startsWith('observations/')) continue;
    for (const line of (Buffer.isBuffer(data) ? data.toString('utf8') : String(data)).split('\n')) {
      if (!line.trim()) continue;
      const r = parseJson(line);
      if (r && typeof r.field === 'string' && r.value !== null && r.value !== undefined && !fields.has(r.field)) fields.set(r.field, r.value);
    }
  }
  const res = parseJson(g.files.get('results/scan-static.json') ?? g.files.get('results/live-probe.json') ?? null);
  return {
    key: `${m.attempt_id ?? g.attempt}/${g.index}/${m.run_key ?? ''}`,
    subject: m.subject.id,
    lane,
    observed_at: m.finished_at,
    run_key: typeof m.run_key === 'string' ? m.run_key : null,
    tools: Array.isArray(m.tools) ? m.tools.map((t) => ({ name: t?.name ?? null, version: t?.version ?? null })) : [],
    subject_sha: typeof m.subject?.sha === 'string' ? m.subject.sha : null,
    fields,
    result: res && typeof res === 'object' ? res : null,
  };
}

/** The catalog observation (drift.mjs catalogDrift) of one item, or null when it has no tool list hash. */
export function catalogObservation(item) {
  const base = { lane: item.lane, observed_at: item.observed_at, run_key: item.run_key, tools: item.tools, subject_sha: item.subject_sha };
  const f = (k) => item.fields.get(k) ?? null;
  if (item.lane === 'scan-static') {
    const r = item.result;
    if (!r || r.status !== 'graded' || typeof r.catalog_hash !== 'string') return null;
    return { ...base, tool_list_sha256: r.catalog_hash, tool_count: Number.isSafeInteger(r.tool_count) ? r.tool_count : null, commit: r.commit?.sha ?? f('commit_sha'), package: null, oci_digest: null };
  }
  const hash = f('tool_list_sha256');
  if (typeof hash !== 'string') return null;
  const type = typeof f('registry_package_register_type') === 'string' ? f('registry_package_register_type').toLowerCase() : null;
  const resolved = f('install_phase_behaviour')?.resolved_version ?? null;
  const version = type === 'oci' ? f('registry_package_version') : resolved ?? f('registry_package_version');
  return {
    ...base,
    tool_list_sha256: hash,
    tool_count: f('tool_count'),
    commit: f('commit_sha'),
    package: type ? { type, identifier: f('registry_package_identifier'), version: typeof version === 'string' ? version : null } : null,
    oci_digest: typeof f('oci_digest') === 'string' ? f('oci_digest') : null,
  };
}

/** Release times from every registry_entry_history value seen: (server_name, version) -> published_at. */
function releaseIndex(histories) {
  const map = new Map();
  for (const history of histories) {
    for (const e of Array.isArray(history) ? history : []) {
      for (const v of Array.isArray(e?.versions) ? e.versions : []) {
        const k = `${e.server_name}\u0000${v?.version}`;
        if (!map.has(k) && v?.published_at) map.set(k, v.published_at);
      }
    }
  }
  return (server, version) => map.get(`${server}\u0000${version}`) ?? null;
}

const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const t = (iso) => { const v = Date.parse(iso); return Number.isFinite(v) ? v : -Infinity; };

/**
 * Derive one subject's records from its items (any lanes, any order).
 * Every observation is compared with the last-seen state before it, over the
 * whole history (R-DRIFT-11). With `since` (ms), only events seen at or after
 * it are reported; everything before it is the baseline (R-DRIFT-22).
 * Returns { records: [{field, value}], tool_side: [...], stats }.
 */
export function deriveSubject(items, { since = -Infinity } = {}) {
  const sorted = [...items].sort((a, b) => t(a.observed_at) - t(b.observed_at) || a.key.localeCompare(b.key));
  const byLane = new Map();
  for (const it of sorted) {
    if (!byLane.has(it.lane)) byLane.set(it.lane, []);
    byLane.get(it.lane).push(it);
  }
  const records = [];
  const toolSide = [];
  const stats = { git_pairs: 0, oci_pairs: 0, catalog_pairs: 0, floating_moved: 0, reannotated: 0, excluded: {} };
  const recent = (iso) => t(iso) >= since;

  // Force-pushed tags: every meta-github observation that read the tags.
  const gh = (byLane.get('meta-github') ?? []).filter((x) => x.fields.get('git_tag_targets'));
  if (gh.length >= 2 && recent(gh.at(-1).observed_at)) {
    const r = gitTagSeries(gh.map((x) => ({ at: x.observed_at, value: x.fields.get('git_tag_targets') })));
    stats.git_pairs = r.compared;
    stats.floating_moved += r.floating_moved;
    stats.reannotated += r.reannotated;
    records.push({ field: 'git_tag_moves', value: r.events.filter((e) => recent(e.seen_at)) });
  }

  // Moving image tags: every meta-registry observation of the declared tags.
  const reg = (byLane.get('meta-registry') ?? []).filter((x) => Array.isArray(x.fields.get('oci_tag_digests')));
  if (reg.length >= 2 && recent(reg.at(-1).observed_at)) {
    const releasedAt = releaseIndex(reg.map((x) => x.fields.get('registry_entry_history')));
    const r = ociTagSeries(reg.map((x) => ({ at: x.observed_at, value: x.fields.get('oci_tag_digests') })), { releasedAt });
    stats.oci_pairs = r.compared;
    stats.floating_moved += r.floating_moved;
    records.push({ field: 'oci_tag_moves', value: r.events.filter((e) => recent(e.seen_at)) });
  }

  // Tool lists that change without a release: successive observations within one lane.
  const events = [];
  const excluded = {};
  let pairs = 0;
  for (const lane of ['live-probe', 'scan-static']) {
    const obs = (byLane.get(lane) ?? []).map(catalogObservation).filter(Boolean);
    for (let i = 1; i < obs.length; i++) {
      if (!recent(obs[i].observed_at)) continue; // the last one before `since` is still the baseline
      pairs++;
      const r = catalogDrift(obs[i - 1], obs[i]);
      if (!r) continue;
      if (r.excluded) bump(excluded, r.excluded);
      if (r.tool_side) toolSide.push(r.tool_side);
      if (r.event) events.push(r.event);
    }
  }
  if (pairs > 0) records.push({ field: 'catalog_drift_same_version', value: { events, pairs, excluded } });
  stats.catalog_pairs = pairs;
  stats.excluded = excluded;
  return { records, tool_side: toolSide, stats };
}

/** Derive every subject. Items with the same key (one result archived twice) count once. */
export function derive(items, { since = -Infinity } = {}) {
  const seen = new Set();
  const bySubject = new Map();
  let duplicates = 0;
  for (const it of items) {
    if (seen.has(it.key)) { duplicates++; continue; }
    seen.add(it.key);
    if (!bySubject.has(it.subject)) bySubject.set(it.subject, []);
    bySubject.get(it.subject).push(it);
  }
  const subjects = new Map();
  const summary = {
    items: seen.size, duplicates, subjects: bySubject.size, items_by_lane: {},
    pairs: { git: 0, oci: 0, catalog: 0 }, events: {}, floating_moved: 0, reannotated: 0, catalog_excluded: {}, tool_side: [],
  };
  for (const list of bySubject.values()) for (const it of list) bump(summary.items_by_lane, it.lane ?? 'unknown');
  for (const [subject, list] of [...bySubject].sort((a, b) => a[0].localeCompare(b[0]))) {
    const d = deriveSubject(list, { since });
    subjects.set(subject, d);
    summary.pairs.git += d.stats.git_pairs;
    summary.pairs.oci += d.stats.oci_pairs;
    summary.pairs.catalog += d.stats.catalog_pairs;
    summary.floating_moved += d.stats.floating_moved;
    summary.reannotated += d.stats.reannotated;
    for (const [k, n] of Object.entries(d.stats.excluded)) bump(summary.catalog_excluded, k, n);
    for (const r of d.records) {
      const evs = Array.isArray(r.value) ? r.value : r.value?.events ?? [];
      for (const e of evs) bump(summary.events, `${e.kind}:${e.rank}`);
    }
    for (const t of d.tool_side) summary.tool_side.push({ subject, ...t });
  }
  return { subjects, summary };
}

/** Every sealed ingest file under <archive>/ingest/, sorted. */
export function sealedFiles(archiveDir) {
  const root = join(archiveDir, 'ingest');
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.tar.age')) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** Items from the archive: each sealed file decrypted in memory, untarred, accepted items only. */
export function readArchive(archiveDir, { identity, ageBin = process.env.AGE_BIN || 'age', log = () => {} } = {}) {
  const stats = { sealed: 0, failed: 0, unreadable: 0 };
  const items = [];
  for (const file of sealedFiles(archiveDir)) {
    stats.sealed++;
    let entries;
    try {
      entries = readTar(ageDecrypt({ ciphertext: readFileSync(file), identity, ageBin }));
    } catch (err) {
      stats.failed++;
      log(`could not read ${relative(archiveDir, file)} (${err?.code ?? err?.name ?? 'error'})`);
      continue;
    }
    items.push(...itemsFromEntries(entries, stats));
  }
  return { items, stats };
}

/** Items from a plain folder laid out as accepted/<attempt>/<index>/... */
export function readPlain(dir) {
  const entries = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) entries.push({ path: relative(dir, p).split(sep).join('/'), data: readFileSync(p) });
    }
  };
  walk(dir);
  const stats = { unreadable: 0 };
  return { items: itemsFromEntries(entries, stats), stats };
}

/** Derived records as ndjson lines: {subject, field, value, derived_at, source}. */
export function outputLines(subjects, derivedAt) {
  const lines = [];
  for (const [subject, d] of subjects) for (const r of d.records) lines.push(JSON.stringify({ subject, field: r.field, value: r.value, derived_at: derivedAt, source: SOURCE }));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** Is `file` (as it would be written) inside `dir`? Links are resolved where they exist. */
export function outInside(file, dir) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const d = real(dir);
  const target = join(real(dirname(resolve(file))), basename(file));
  const rel = relative(d, target);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

/**
 * Must `file` not be written for a run that reads `dir`? Yes when it would land
 * inside it, when it is itself a link (to anywhere: a link is how an output gets
 * pointed at an archive file), or when it is a second name (hard link) for an
 * existing file. A missing file is fine.
 */
export function outUnsafe(file, dir) {
  if (outInside(file, dir)) return true;
  let st;
  try { st = lstatSync(file); } catch { return false; }
  return st.isSymbolicLink() || (st.isFile() && st.nlink > 1);
}

/** Write `data` to `file`, 0600: never through a link (O_NOFOLLOW), and never into a file with other names. */
export function writeOut(file, data) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (fstatSync(fd).nlink > 1) throw Object.assign(new Error('output has other names'), { code: 'ELINKED' });
    ftruncateSync(fd, 0);
    fchmodSync(fd, 0o600);
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!['--archive', '--plain', '--identity', '--out', '--since'].includes(a) || i + 1 >= argv.length) return null;
    o[a.slice(2)] = argv[++i];
  }
  if (!o.archive === !o.plain) return null;
  if (o.since && !Number.isFinite(Date.parse(o.since))) return null;
  return o;
}

export async function main(argv = process.argv.slice(2), { write = (s) => process.stdout.write(s), now = () => new Date() } = {}) {
  const o = parseArgs(argv);
  if (!o) {
    write('usage: node longitudinal/derive.mjs (--archive <dir> [--identity <file>] | --plain <dir>) [--out <file>] [--since <iso time>]\n');
    return 2;
  }
  if (o.out && outUnsafe(o.out, o.archive ?? o.plain)) {
    write('--out must not be inside the folder being read, nor a link or a second name for a file in it (the archive is never written to)\n');
    return 2;
  }
  let read;
  try {
    if (o.archive) {
      const identity = readFileSync(o.identity ?? DEFAULT_IDENTITY, 'utf8');
      read = readArchive(o.archive, { identity, log: (l) => write(`${l}\n`) });
    } else {
      if (!statSync(o.plain).isDirectory()) throw new Error('not a folder');
      read = readPlain(o.plain);
    }
  } catch (err) {
    write(`could not read the input (${err?.code ?? err?.name ?? 'error'})\n`);
    return 3;
  }
  const { subjects, summary } = derive(read.items, { since: o.since ? Date.parse(o.since) : -Infinity });
  if (o.out) {
    // Created 0600; an existing file is set to 0600 too (R-DRIFT-24); never through a link.
    try { writeOut(o.out, outputLines(subjects, now().toISOString())); } catch (err) { write(`could not write the output (${err?.code ?? err?.name ?? 'error'})\n`); return 3; }
  }
  write(`${JSON.stringify({ read: read.stats, ...summary }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
