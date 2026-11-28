// meta-backend: what does a server's write tools write to?
//
// For one subject (a GitHub owner/name), the lane reads the repository's
// source archive at its default branch (or a pinned commit, for the
// known-answer control) from codeload.github.com, as data, with our own tar
// reader (scripts/lib/untar.mjs), in memory: package manifests, compose
// files, env examples, server.json and MCP bundle manifests, READMEs, OpenAPI
// files and code text. lib/backend-scan.mjs turns what it finds into one
// observation, `write_backend`: local_full, mock_min or none, with the
// backend, its stand-in or its public API description, env var names,
// confidence and evidence. The two data maps (data/stand-ins.json,
// data/spec-urls.json) say which backends have a stand-in that runs in a
// GitHub Actions job and which hosted APIs publish a description; they grow
// without a code change.
//
// An archive over our caps, or one that does not arrive within our time
// limit, is read again as a handful of root files from
// raw.githubusercontent.com (basis root_files, confidence at most medium).
//
// Hard rules: nothing from the subject is installed, imported, built or run,
// and nothing is written to disk. Every request goes over HTTPS to
// ALLOWED_HOSTS, and no redirect is followed. Env var values are never read
// into what we keep: only names. A classification is never a finding about
// the server: `none` means "not testable here".

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { FetchProblem, forbiddenKind, readCapped } from './lib/http.mjs';
import { looksText } from './lib/indicators.mjs';
import { record, skipFor } from './lib/common.mjs';
import { buildIndex, createAnalyzer, fileRole, mapProblems, mergeMaps, SCAN_VERSION } from './lib/backend-scan.mjs';
import { ArchiveError, ArchiveLimit, readTarGz } from '../scripts/lib/untar.mjs';
import { parseRegistry } from '../ingest/registry.mjs';

export const LANE = 'meta-backend';
export const VERSION = '1.0.0';
export const FIELD = 'write_backend';

export const ALLOWED_HOSTS = Object.freeze(['codeload.github.com', 'raw.githubusercontent.com']);

export const LIMITS = Object.freeze({
  // The source archive is streamed; every file we read is scanned and let go of at once, so memory follows the largest
  // kept file, not the archive. The caps bound time and work.
  archive: { maxCompressedBytes: 96 * 1024 ** 2, maxInflatedBytes: 768 * 1024 ** 2, maxEntries: 150_000, maxKeptEntryBytes: 4 * 1024 ** 2, maxKeptTotalBytes: 64 * 1024 ** 2, maxMetaBytes: 1024 ** 2 },
  downloadTimeoutMs: 90_000,
  // No network call starts once a subject has used this much time.
  subjectBudgetMs: 150_000,
  // Code read per subject, and per file; a spec or JSON/YAML file, and any other file.
  codeBytes: 48 * 1024 ** 2,
  codeFileBytes: 1024 ** 2,
  specFileBytes: 4 * 1024 ** 2,
  otherFileBytes: 2 * 1024 ** 2,
  rootFileBytes: 1024 ** 2,
});

/** Files read from raw.githubusercontent.com when the archive cannot be. */
export const ROOT_FILES = Object.freeze([
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml', '.env.example', '.env.sample', 'server.json', 'manifest.json', 'README.md',
]);

const DATA = new URL('./data/', import.meta.url);

/**
 * The field's entry, exactly as isokron-ai/mcp-results declares it (fields/write-backend, R-RES-16). Until ingest's
 * registry pin (ingest/registry.mjs) moves to a commit that holds it, ingest refuses this lane's bundles as
 * undeclared_field: the lane stays off (pump/workflows.json enabled false), and only the fixture run and the tests
 * judge with this entry added (withPendingField). Once the pin holds the entry, this is unused (a test fails if the
 * two ever differ).
 */
export const PENDING_FIELD_YAML = '  - {id: write_backend, layer: source_build, type: object, unit: none, source: meta-backend, class: P-s, redaction: [R1], status: planned}';

/** The registry with write_backend added when it does not hold it yet. */
export function withPendingField(registry) {
  if (registry.fields.has(FIELD)) return registry;
  const entry = parseRegistry(`version: 0\nfields:\n${PENDING_FIELD_YAML}\n`).fields.get(FIELD);
  return { ...registry, fields: new Map([...registry.fields, [FIELD, entry]]), pending: [FIELD] };
}

/** The two data maps, checked, merged and indexed. Throws on a bad map: a broken map is our bug and stops the lane. */
export function loadMaps({ standIns, specUrls } = {}) {
  const sText = standIns ?? readFileSync(new URL('stand-ins.json', DATA), 'utf8');
  const uText = specUrls ?? readFileSync(new URL('spec-urls.json', DATA), 'utf8');
  const s = typeof sText === 'string' ? JSON.parse(sText) : sText;
  const u = typeof uText === 'string' ? JSON.parse(uText) : uText;
  const problems = mapProblems(s, u);
  if (problems.length) throw new Error(`meta-backend: the data maps are not valid: ${problems.slice(0, 5).join('; ')}`);
  const table = mergeMaps(s, u);
  const sha = (t) => createHash('sha256').update(typeof t === 'string' ? t : JSON.stringify(t)).digest('hex');
  return {
    table,
    index: buildIndex(table),
    versions: { stand_ins: s.version, spec_urls: u.version, stand_ins_sha256: sha(sText), spec_urls_sha256: sha(uText) },
  };
}

const MAPS = loadMaps();

/** The maps' version as one string, the `meta-backend-maps` pin in pump/workflows.json. */
export const MAPS_VERSION = `${MAPS.versions.stand_ins}.${MAPS.versions.spec_urls}`;

export const SETTINGS = Object.freeze({
  lane: LANE, version: VERSION, scan: SCAN_VERSION, limits: LIMITS, hosts: ALLOWED_HOSTS, maps: MAPS.versions,
  sources: ['github-codeload', 'github-raw'],
});

/** What the manifest reports as run (R-PIN-01): the lane and the maps' version. */
export const TOOLS = Object.freeze([
  Object.freeze({ name: `tool-qa-${LANE}`, version: VERSION }),
  Object.freeze({ name: `tool-qa-${LANE}-maps`, version: MAPS_VERSION }),
]);

export function allowedUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname) && u.port === '' && !u.username && !u.password;
}

/** Our own refusal to go somewhere: a lane bug, never data. */
export class HostRefused extends Error {
  constructor() {
    super('meta-backend: a request to a host outside ALLOWED_HOSTS was refused');
    this.name = 'HostRefused';
  }
}

const SHA_RE = /^[0-9a-f]{40}$/;
const stripTop = (p) => { const i = p.indexOf('/'); return i < 0 ? null : p.slice(i + 1); };

/**
 * Read the source archive into an analyzer. Returns { status: 'ok', commit, truncated, bytes } or
 * { status: 'not_found' | 'gone' | 'redirected' }; throws FetchProblem (passing), ArchiveLimit (our cap), or
 * SourceTimeLimit.
 */
export async function readArchive(http, repo, ref, analyzer, { clock = () => Date.now(), limits = LIMITS.archive } = {}) {
  const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`;
  if (!allowedUrl(url)) throw new HostRefused();
  const t0 = clock();
  const res = await http.request(url, { redirect: 'manual', timeoutMs: LIMITS.downloadTimeoutMs, retries: 1 });
  if (res.status !== 200) {
    if (res.status === 403 || res.status === 451) {
      const k = await forbiddenKind(res);
      if (k.kind === 'gone') return { status: 'gone' };
      throw new FetchProblem('rate_limited', `codeload.github.com: HTTP ${res.status}`, { status: res.status });
    }
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 404 || res.status === 422) return { status: 'not_found' };
    if (res.status >= 300 && res.status < 400) return { status: 'redirected' };
    if (res.status === 429) throw new FetchProblem('rate_limited', `codeload.github.com: HTTP ${res.status}`, { status: res.status });
    throw new FetchProblem('upstream_unavailable', `codeload.github.com: HTTP ${res.status}`);
  }
  let codeBytes = 0;
  let truncated = false;
  const keep = ({ path, size }) => {
    const rel = stripTop(path);
    if (!rel) return false;
    const role = fileRole(rel);
    if (!role) return false;
    if (role === 'code') {
      if (size > LIMITS.codeFileBytes || codeBytes + size > LIMITS.codeBytes) { truncated = true; return false; }
      codeBytes += size;
      return true;
    }
    const cap = role === 'maybe_spec' ? LIMITS.specFileBytes : LIMITS.otherFileBytes;
    if (size > cap) { if (role !== 'maybe_spec') truncated = true; return false; }
    return true;
  };
  let t;
  try {
    t = await readTarGz(res.body, {
      limits,
      keep,
      onFile: (f) => {
        if (!f.data) return;
        const rel = stripTop(f.path);
        if (rel && looksText(f.data)) analyzer.addFile(rel, f.data.toString('utf8'));
        f.data = null;
      },
    });
  } catch (err) {
    if (err instanceof ArchiveLimit) throw err;
    if (err instanceof ArchiveError) {
      if (clock() - t0 >= LIMITS.downloadTimeoutMs * 0.9) throw new SourceTimeLimit();
      throw new FetchProblem('upstream_unavailable', 'codeload.github.com: the source archive could not be read');
    }
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new SourceTimeLimit();
    throw err;
  }
  return { status: 'ok', commit: t.global_comment && SHA_RE.test(t.global_comment) ? t.global_comment : null, truncated, bytes: t.compressed_bytes ?? null };
}

/** A source archive that did not arrive within our time limit: our limit, read from root files instead. */
export class SourceTimeLimit extends Error {
  constructor() {
    super('meta-backend: the source archive did not arrive within the time limit');
    this.name = 'SourceTimeLimit';
  }
}

/** The fallback: a few root files from raw.githubusercontent.com. Returns how many were read. */
export async function readRootFiles(http, repo, ref, analyzer, { overBudget = () => false } = {}) {
  let read = 0;
  for (const name of ROOT_FILES) {
    if (overBudget()) break;
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${name}`;
    if (!allowedUrl(url)) throw new HostRefused();
    const res = await http.request(url, { redirect: 'manual', timeoutMs: 20_000 });
    if (res.status === 404) { await res.body?.cancel?.().catch(() => {}); continue; }
    if (res.status === 429 || res.status === 403) { await res.body?.cancel?.().catch(() => {}); throw new FetchProblem('rate_limited', `raw.githubusercontent.com: HTTP ${res.status}`, { status: res.status }); }
    if (res.status !== 200) { await res.body?.cancel?.().catch(() => {}); throw new FetchProblem('upstream_unavailable', `raw.githubusercontent.com: HTTP ${res.status}`); }
    let text;
    try { text = await readCapped(res, LIMITS.rootFileBytes, 'raw.githubusercontent.com'); } catch (err) { if (err?.code === 'too_large') continue; throw err; }
    analyzer.addFile(name, text);
    read++;
  }
  return read;
}

/**
 * Everything for one subject. Never throws for an upstream problem: those are
 * skips. `pins` maps a repository to the commit to read (the known-answer
 * control); otherwise the default branch (HEAD) is read and the archive's
 * commit is reported.
 */
export async function collectSubject(http, repo, { pins = {}, maps = MAPS, clock = () => Date.now(), archiveLimits = LIMITS.archive } = {}) {
  const t0 = clock();
  const overBudget = () => clock() - t0 > LIMITS.subjectBudgetMs;
  const ref = SHA_RE.test(pins?.[repo] ?? '') ? pins[repo] : 'HEAD';
  const stages = {};
  const skips = [];
  let analyzer = createAnalyzer(maps);
  let read = null;
  let source = 'archive';
  try {
    read = await readArchive(http, repo, ref, analyzer, { clock, limits: archiveLimits });
    stages.archive = read.status;
  } catch (err) {
    if (err instanceof ArchiveLimit || err instanceof SourceTimeLimit) {
      stages.archive = err instanceof ArchiveLimit ? 'too_large' : 'reader_limit';
      // Start again from root files: what the archive gave before the cap is dropped, so the result says one basis.
      analyzer = createAnalyzer(maps);
      source = 'root_files';
    } else if (err instanceof FetchProblem) {
      stages.archive = err.code;
      skips.push(skipFor('archive', err.code));
      return { repo, stages, skips, value: null, why: 'the source archive could not be read', sha: null };
    } else throw err;
  }
  if (read?.status === 'not_found') return { repo, stages, skips, value: null, why: 'the repository was not found, or is empty', sha: null };
  if (read?.status === 'gone') {
    skips.push({ stage: 'archive', reason: 'upstream_unavailable', fault: 'subject' });
    return { repo, stages, skips, value: null, why: 'GitHub took the repository down', sha: null };
  }
  if (read?.status === 'redirected') {
    skips.push({ stage: 'archive', reason: 'upstream_unavailable', fault: 'tool', retryable: true });
    return { repo, stages, skips, value: null, why: 'codeload.github.com answered with a redirect we do not follow', sha: null };
  }
  if (source === 'root_files') {
    try {
      const n = await readRootFiles(http, repo, ref, analyzer, { overBudget });
      stages.root_files = n;
      if (n === 0) {
        skips.push({ stage: 'archive', reason: stages.archive === 'too_large' ? 'too_large' : 'reader_limit', fault: 'tool' });
        return { repo, stages, skips, value: null, why: 'the archive is over our caps and no root file could be read', sha: null };
      }
    } catch (err) {
      if (!(err instanceof FetchProblem)) throw err;
      stages.root_files = err.code;
      skips.push(skipFor('root_files', err.code));
      return { repo, stages, skips, value: null, why: 'the root files could not be read', sha: null };
    }
  }
  const commit = read?.commit ?? (ref !== 'HEAD' ? ref : null);
  const value = analyzer.result({ repo, commit, source, truncated: read?.truncated ?? true, mapVersions: { stand_ins: maps.versions.stand_ins, spec_urls: maps.versions.spec_urls } });
  stages.class = value.class;
  stages.files = value.basis.files_read;
  return { repo, stages, skips, value, why: null, sha: commit };
}

/** Observation records for one subject. */
export function subjectOutput(c) {
  return { records: [record(FIELD, c.value, c.why ?? undefined)], skips: c.skips, stages: c.stages, sha: c.sha ?? null };
}

/** A subject whose data made the lane throw: our own failure (tool_error), not retried here. */
export function subjectErrorOutput() {
  return {
    records: [record(FIELD, null, 'this subject could not be read: the lane failed on it')],
    skips: [{ stage: 'collect', reason: 'tool_error', fault: 'tool' }],
    stages: { collect: 'subject_error' },
    sha: null,
  };
}
