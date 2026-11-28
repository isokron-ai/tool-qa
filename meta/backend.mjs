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

import { Worker } from 'node:worker_threads';

import { FetchProblem, forbiddenKind, readBytesCapped, readCapped } from './lib/http.mjs';
import { record, skipFor } from './lib/common.mjs';
import { SCAN_VERSION } from './lib/backend-scan.mjs';
import { loadMaps } from './lib/backend-maps.mjs';
import { scanArchive, scanFiles } from './lib/backend-archive.mjs';
import { parseRegistry } from '../ingest/registry.mjs';

export const LANE = 'meta-backend';
export const VERSION = '1.1.0';
export const FIELD = 'write_backend';

export const ALLOWED_HOSTS = Object.freeze(['codeload.github.com', 'raw.githubusercontent.com']);

export const LIMITS = Object.freeze({
  // The source archive is downloaded (at most maxCompressedBytes), then scanned in a worker thread: every file read is
  // scanned and let go of at once, so memory follows the archive's compressed bytes and the largest kept file.
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
  // One subject's scan, in its worker thread: past this it is stopped and the subject gets a reader_limit skip (R-WB-20).
  scanTimeoutMs: 60_000,
  scanMemoryMb: 1536,
});

/** Files read from raw.githubusercontent.com when the archive cannot be. */
export const ROOT_FILES = Object.freeze([
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml', '.env.example', '.env.sample', 'server.json', 'manifest.json', 'README.md',
]);

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

export { loadMaps };

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
 * Download the source archive. Returns { status: 'ok', buf } or { status: 'not_found' | 'gone' | 'redirected' |
 * 'too_large' | 'reader_limit' }; throws FetchProblem for a passing problem.
 */
export async function downloadArchive(http, repo, ref, { clock = () => Date.now(), limits = LIMITS.archive } = {}) {
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
  try {
    return { status: 'ok', buf: await readBytesCapped(res, limits.maxCompressedBytes, 'codeload.github.com') };
  } catch (err) {
    if (err instanceof FetchProblem && err.code === 'too_large') return { status: 'too_large' };
    // A body that stopped at our time limit is ours: read the root files instead.
    if (err instanceof FetchProblem && clock() - t0 >= LIMITS.downloadTimeoutMs * 0.9) return { status: 'reader_limit' };
    throw err;
  }
}

/** The scan stopped at its wall-clock limit, or its worker died: our limit, never the subject's. */
export class ScanLimit extends Error {
  constructor(why) {
    super(`meta-backend: the scan ${why}`);
    this.name = 'ScanLimit';
    this.why = why;
  }
}

/**
 * Run one scan job in a worker thread with a wall-clock limit (R-WB-20). job: { kind: 'archive', buf } or
 * { kind: 'files', files: [[name, text]] }, plus repo, pinnedCommit, mapsSource. With isolate false (unit tests that
 * hand over maps objects) it runs in this thread. Resolves to the scan's result; rejects with ScanLimit.
 */
export function runScan(job, { timeoutMs = LIMITS.scanTimeoutMs, isolate = true, maps = null } = {}) {
  if (!isolate) {
    const m = maps ?? loadMaps(job.mapsSource ?? undefined);
    const opts = { maps: m, repo: job.repo, mapVersions: { stand_ins: m.versions.stand_ins, spec_urls: m.versions.spec_urls } };
    return job.kind === 'archive'
      ? scanArchive(job.buf, { ...opts, limits: job.limits, fileLimits: job.fileLimits, pinnedCommit: job.pinnedCommit ?? null })
      : Promise.resolve(scanFiles(job.files, { ...opts, commit: job.pinnedCommit ?? null }));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lib/backend-scan-worker.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: LIMITS.scanMemoryMb }, env: {}, stdout: true, stderr: true });
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(v); };
    const timer = setTimeout(() => done(reject, new ScanLimit('ran past its time limit')), timeoutMs);
    worker.once('message', (m) => (m?.ok ? done(resolve, m.out) : done(reject, new ScanLimit(`failed (${m?.error ?? 'error'})`))));
    worker.once('error', () => done(reject, new ScanLimit('failed in its worker')));
    worker.once('exit', (code) => done(reject, new ScanLimit(`worker exited (${code})`)));
    let msg = job;
    const transfer = [];
    if (job.kind === 'archive') {
      // A fresh ArrayBuffer of exactly the archive's bytes, handed over without a copy.
      const ab = job.buf.buffer.slice(job.buf.byteOffset, job.buf.byteOffset + job.buf.byteLength);
      msg = { ...job, buf: ab };
      transfer.push(ab);
    }
    worker.postMessage(msg, transfer);
  });
}

/** The fallback: a few root files from raw.githubusercontent.com. Returns [[name, text], ...]. */
export async function readRootFiles(http, repo, ref, { overBudget = () => false } = {}) {
  const files = [];
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
    files.push([name, text]);
  }
  return files;
}

/**
 * Everything for one subject. Never throws for an upstream problem: those are
 * skips. `pins` maps a repository to the commit to read (the known-answer
 * control); otherwise the default branch (HEAD) is read and the archive's
 * commit is reported. The scan runs in a worker thread (runScan).
 */
export async function collectSubject(http, repo, { pins = {}, mapsSource = null, clock = () => Date.now(), archiveLimits = LIMITS.archive, scanTimeoutMs = LIMITS.scanTimeoutMs } = {}) {
  const t0 = clock();
  const overBudget = () => clock() - t0 > LIMITS.subjectBudgetMs;
  const ref = SHA_RE.test(pins?.[repo] ?? '') ? pins[repo] : 'HEAD';
  const pinnedCommit = ref !== 'HEAD' ? ref : null;
  const stages = {};
  const skips = [];
  const base = { repo, pinnedCommit, mapsSource, limits: archiveLimits, fileLimits: LIMITS };
  const scanLimited = (err) => {
    stages.scan = 'reader_limit';
    skips.push({ stage: 'scan', reason: 'reader_limit', fault: 'tool' });
    return { repo, stages, skips, value: null, why: `our scan of this repository ${err.why}`, sha: null };
  };
  let dl;
  try {
    dl = await downloadArchive(http, repo, ref, { clock, limits: archiveLimits });
  } catch (err) {
    if (!(err instanceof FetchProblem)) throw err;
    stages.archive = err.code;
    skips.push(skipFor('archive', err.code));
    return { repo, stages, skips, value: null, why: 'the source archive could not be read', sha: null };
  }
  stages.archive = dl.status;
  if (dl.status === 'not_found') return { repo, stages, skips, value: null, why: 'the repository was not found, or is empty', sha: null };
  if (dl.status === 'gone') {
    skips.push({ stage: 'archive', reason: 'upstream_unavailable', fault: 'subject' });
    return { repo, stages, skips, value: null, why: 'GitHub took the repository down', sha: null };
  }
  if (dl.status === 'redirected') {
    skips.push({ stage: 'archive', reason: 'upstream_unavailable', fault: 'tool', retryable: true });
    return { repo, stages, skips, value: null, why: 'codeload.github.com answered with a redirect we do not follow', sha: null };
  }
  let out = null;
  if (dl.status === 'ok') {
    try {
      out = await runScan({ ...base, kind: 'archive', buf: dl.buf }, { timeoutMs: scanTimeoutMs });
    } catch (err) {
      if (err instanceof ScanLimit) return scanLimited(err);
      throw err;
    }
    if (out.status === 'too_large') { stages.archive = 'too_large'; out = null; }
    else if (out.status === 'malformed') {
      skips.push({ stage: 'archive', reason: 'upstream_unavailable', fault: 'infra', retryable: true });
      return { repo, stages, skips, value: null, why: 'the source archive could not be read', sha: null };
    }
  }
  if (!out) {
    // Over our caps, or late: read again as root files, the result says one basis.
    let files;
    try {
      files = await readRootFiles(http, repo, ref, { overBudget });
    } catch (err) {
      if (!(err instanceof FetchProblem)) throw err;
      stages.root_files = err.code;
      skips.push(skipFor('root_files', err.code));
      return { repo, stages, skips, value: null, why: 'the root files could not be read', sha: null };
    }
    stages.root_files = files.length;
    if (files.length === 0) {
      skips.push({ stage: 'archive', reason: stages.archive === 'too_large' ? 'too_large' : 'reader_limit', fault: 'tool' });
      return { repo, stages, skips, value: null, why: 'the archive is over our caps and no root file could be read', sha: null };
    }
    try {
      out = await runScan({ ...base, kind: 'files', files }, { timeoutMs: scanTimeoutMs });
    } catch (err) {
      if (err instanceof ScanLimit) return scanLimited(err);
      throw err;
    }
  }
  const value = out.value;
  stages.class = value.class;
  stages.files = value.basis.files_read;
  return { repo, stages, skips, value, why: null, sha: out.commit ?? null };
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
